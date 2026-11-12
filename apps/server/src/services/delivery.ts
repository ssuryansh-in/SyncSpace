import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import {
  projectEvents,
  projects,
  workspaceMembers,
  type ProjectEvent,
} from "../db/schema/index.js";
import { AppError } from "../errors/index.js";
import type {
  Logger,
  PostgresListenerService,
  ProjectEventNotification,
} from "./listener.js";
import type {
  MembershipConsumerService,
  ReconciledMembershipEvent,
} from "./membership-consumer.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface ProjectSubscriber {
  id: string;
  userId: string;
  workspaceId: string;
  send: (event: ProjectEvent) => void | Promise<void>;
  close: () => void;
}

export interface SubscribeProjectOptions {
  fromSeq?: number;
}

export interface SubscribeProjectResult {
  currentSeq: number;
}

export interface ProjectDeliveryState {
  projectId: string;
  workspaceId: string;
  localLastDeliveredSeq: number;
  subscribers: Map<string, ProjectSubscriber>;
  activeDrain: Promise<void> | null;
  pendingDrain: boolean;
}

export interface DeliveryEngineOptions {
  db: Database;
  listener: PostgresListenerService;
  membershipConsumer?: MembershipConsumerService | undefined;
  pollingIntervalMs?: number | undefined; // default: 1000ms
  subscriberSendTimeoutMs?: number | undefined; // default: 5000ms
  shutdownTimeoutMs?: number | undefined; // default: 5000ms
  batchSize?: number | undefined; // default: 100
  logger?: Logger | undefined;
}

// ============================================================================
// DeliveryEngine Implementation
// ============================================================================

/**
 * Transport-agnostic delivery engine managing real-time project event delivery,
 * per-project cursor tracking, fresh pre-dispatch membership authorization,
 * single-flight polling fallback, and membership revocation eviction.
 *
 * Conforms to M8.3 Final Implementation Plan (Revision 4).
 */
export class DeliveryEngine {
  private readonly db: Database;
  private readonly listener: PostgresListenerService;
  private readonly membershipConsumer?: MembershipConsumerService | undefined;
  private readonly pollingIntervalMs: number;
  private readonly subscriberSendTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly batchSize: number;
  private readonly logger: Logger;

  private readonly activeProjects = new Map<string, ProjectDeliveryState>();
  private isShuttingDown = false;
  private isPolling = false;
  private pollingTimer: NodeJS.Timeout | null = null;
  private unsubscribeListener: (() => void) | null = null;
  private unsubscribeMembership: (() => void) | null = null;

  constructor(options: DeliveryEngineOptions) {
    this.db = options.db;
    this.listener = options.listener;
    this.membershipConsumer = options.membershipConsumer;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 1000;
    this.subscriberSendTimeoutMs = options.subscriberSendTimeoutMs ?? 5000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
    this.batchSize = options.batchSize ?? 100;
    this.logger = options.logger ?? {
      info: (obj, msg) => console.info("[DeliveryEngine]", msg ?? obj),
      warn: (obj, msg) => console.warn("[DeliveryEngine]", msg ?? obj),
      error: (obj, msg) => console.error("[DeliveryEngine]", msg ?? obj),
      debug: (obj, msg) => console.debug?.("[DeliveryEngine]", msg ?? obj),
    };
  }

  // ==========================================================================
  // Lifecycle (Start & Graceful Stop)
  // ==========================================================================

  /**
   * Starts the delivery engine by attaching to notification channels and starting polling.
   */
  public start(): void {
    if (this.isShuttingDown) {
      throw new Error("Cannot start DeliveryEngine when shutting down");
    }

    if (this.unsubscribeListener !== null) {
      return; // Already started
    }

    this.unsubscribeListener = this.listener.onProjectEvent((payload) => {
      this.handleProjectNotification(payload);
    });

    if (this.membershipConsumer) {
      this.unsubscribeMembership = this.membershipConsumer.onEvent((event) => {
        this.handleMembershipEvent(event);
      });
    }

    this.startPolling();
    this.logger.info("DeliveryEngine started and attached to listener");
  }

  /**
   * Graceful shutdown:
   * 1. Marks isShuttingDown = true (no new subscriber sends initiated).
   * 2. Clears polling timer.
   * 3. Unregisters from listener and membership consumer.
   * 4. Awaits active drains up to shutdownTimeoutMs.
   * 5. Closes remaining subscribers and cleans up state.
   */
  public async stop(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    this.stopPolling();

    if (this.unsubscribeListener) {
      this.unsubscribeListener();
      this.unsubscribeListener = null;
    }

    if (this.unsubscribeMembership) {
      this.unsubscribeMembership();
      this.unsubscribeMembership = null;
    }

    const activeDrains = Array.from(this.activeProjects.values())
      .map((s) => s.activeDrain)
      .filter((p): p is Promise<void> => p !== null);

    if (activeDrains.length > 0) {
      let timeoutHandle: NodeJS.Timeout | null = null;
      try {
        const timeoutPromise = new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(resolve, this.shutdownTimeoutMs);
        });

        await Promise.race([
          Promise.allSettled(activeDrains),
          timeoutPromise,
        ]);
      } finally {
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      }
    }

    // Close and evict all remaining subscribers
    for (const state of this.activeProjects.values()) {
      for (const sub of state.subscribers.values()) {
        try {
          sub.close();
        } catch (err) {
          this.logger.error({ err, subId: sub.id }, "Error closing subscriber on shutdown");
        }
      }
    }

    this.activeProjects.clear();
    this.logger.info("DeliveryEngine stopped and state cleared");
  }

  // ==========================================================================
  // Polling Lifecycle
  // ==========================================================================

  public startPolling(): void {
    if (this.pollingTimer !== null || this.isShuttingDown) {
      return;
    }

    this.pollingTimer = setInterval(() => {
      void this.pollActiveProjects();
    }, this.pollingIntervalMs);

    if (typeof this.pollingTimer.unref === "function") {
      this.pollingTimer.unref();
    }
  }

  public stopPolling(): void {
    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  private async pollActiveProjects(): Promise<void> {
    // Single-flight polling protection: skip overlapping execution
    if (this.isShuttingDown || this.isPolling) {
      return;
    }

    this.isPolling = true;
    try {
      for (const [projectId, state] of this.activeProjects.entries()) {
        if (this.isShuttingDown) break;
        if (state.subscribers.size > 0) {
          this.triggerDrain(projectId);
        }
      }
    } catch (err) {
      this.logger.error({ err }, "Unhandled error during polling iteration");
    } finally {
      this.isPolling = false;
    }
  }

  // ==========================================================================
  // Subscriber Management (Protocol C Handoff)
  // ==========================================================================

  /**
   * Registers a local subscriber for a project following Protocol C.
   * Authoritatively validates project existence, workspace ownership, and active membership.
   */
  public async subscribeProject(
    projectId: string,
    subscriber: ProjectSubscriber,
    _options: SubscribeProjectOptions = {}
  ): Promise<SubscribeProjectResult> {
    if (this.isShuttingDown) {
      throw new Error("Cannot subscribe: DeliveryEngine is shutting down");
    }

    let state = this.activeProjects.get(projectId);

    if (!state) {
      // First subscriber on this instance: authoritatively query PostgreSQL
      const [projectRow] = await this.db
        .select({
          id: projects.id,
          workspaceId: projects.workspaceId,
          lastSeq: projects.lastSeq,
        })
        .from(projects)
        .where(eq(projects.id, projectId));

      if (!projectRow) {
        throw AppError.notFound("Project not found");
      }

      if (projectRow.workspaceId !== subscriber.workspaceId) {
        throw AppError.notFound("Project not found"); // Tenant concealment
      }

      // Verify subscriber workspace membership
      const [memberRow] = await this.db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, projectRow.workspaceId),
            eq(workspaceMembers.userId, subscriber.userId)
          )
        );

      if (!memberRow) {
        throw AppError.notFound("Project not found"); // Tenant concealment
      }

      // Re-check map in case of concurrent registration while awaiting DB
      state = this.activeProjects.get(projectId);
      if (!state) {
        state = {
          projectId,
          workspaceId: projectRow.workspaceId,
          localLastDeliveredSeq: projectRow.lastSeq,
          subscribers: new Map<string, ProjectSubscriber>(),
          activeDrain: null,
          pendingDrain: false,
        };
        this.activeProjects.set(projectId, state);
      }

      state.subscribers.set(subscriber.id, subscriber);

      // Trigger immediate drain to catch any mutations committed during registration
      this.triggerDrain(projectId);

      return { currentSeq: projectRow.lastSeq };
    }

    // Subsequent subscriber on an already active project
    if (state.workspaceId !== subscriber.workspaceId) {
      throw AppError.notFound("Project not found");
    }

    const [memberRow] = await this.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, state.workspaceId),
          eq(workspaceMembers.userId, subscriber.userId)
        )
      );

    if (!memberRow) {
      throw AppError.notFound("Project not found");
    }

    // Capture current DB last_seq for Protocol C response
    const [projectRow] = await this.db
      .select({ lastSeq: projects.lastSeq })
      .from(projects)
      .where(eq(projects.id, projectId));

    const currentSeq = projectRow?.lastSeq ?? state.localLastDeliveredSeq;
    state.subscribers.set(subscriber.id, subscriber);

    return { currentSeq };
  }

  /**
   * Unregisters a subscriber from a project and closes it.
   */
  public unsubscribeProject(projectId: string, subscriberId: string): void {
    const state = this.activeProjects.get(projectId);
    if (!state) return;

    const sub = state.subscribers.get(subscriberId);
    if (sub) {
      state.subscribers.delete(subscriberId);
      try {
        sub.close();
      } catch (err) {
        this.logger.error({ err, subscriberId }, "Error closing subscriber during unsubscription");
      }
    }

    // Clean up project state from memory if no subscribers remain and no drain is active
    if (state.subscribers.size === 0 && state.activeDrain === null) {
      this.activeProjects.delete(projectId);
    }
  }

  /**
   * Evicts a subscriber immediately (idempotent).
   */
  public evictSubscriber(projectId: string, subscriberId: string): void {
    this.unsubscribeProject(projectId, subscriberId);
  }

  // ==========================================================================
  // Signaling Integration
  // ==========================================================================

  private handleProjectNotification(payload: ProjectEventNotification): void {
    if (this.activeProjects.has(payload.projectId)) {
      this.triggerDrain(payload.projectId);
    }
  }

  private handleMembershipEvent(event: ReconciledMembershipEvent): void {
    if (event.type === "revoked") {
      // Evict matching subscriber(s) across all active projects in that workspace
      for (const state of this.activeProjects.values()) {
        if (state.workspaceId === event.workspaceId) {
          for (const [subId, sub] of Array.from(state.subscribers.entries())) {
            if (sub.userId === event.userId) {
              this.evictSubscriber(state.projectId, subId);
            }
          }
        }
      }
    }
  }

  // ==========================================================================
  // Core Drain Engine (Single Drain per Project & Coalescing)
  // ==========================================================================

  /**
   * Triggers a drain iteration for a project.
   * Guarantees strictly one active drain per project at any moment.
   */
  public triggerDrain(projectId: string): void {
    if (this.isShuttingDown) return;

    const state = this.activeProjects.get(projectId);
    if (!state || state.subscribers.size === 0) return;

    if (state.activeDrain !== null) {
      state.pendingDrain = true;
      return;
    }

    state.activeDrain = this.executeDrain(state).finally(() => {
      state.activeDrain = null;

      if (state.subscribers.size === 0) {
        this.activeProjects.delete(projectId);
        return;
      }

      if (state.pendingDrain && !this.isShuttingDown) {
        state.pendingDrain = false;
        this.triggerDrain(projectId);
      }
    });
  }

  private async executeDrain(state: ProjectDeliveryState): Promise<void> {
    while (!this.isShuttingDown) {
      // Boundary check 1: are there subscribers?
      if (state.subscribers.size === 0) {
        break;
      }

      // Fetch event batch ordered strictly ascending by seq
      let events: ProjectEvent[];
      try {
        events = await this.db
          .select()
          .from(projectEvents)
          .where(
            and(
              eq(projectEvents.projectId, state.projectId),
              gt(projectEvents.seq, state.localLastDeliveredSeq)
            )
          )
          .orderBy(asc(projectEvents.seq))
          .limit(this.batchSize);
      } catch (err) {
        this.logger.error(
          { err, projectId: state.projectId },
          "Failed to query project events during drain; freezing cursor"
        );
        break; // Cursor unchanged; retry next drain
      }

      if (events.length === 0) {
        break;
      }

      let allEventsProcessedInBatch = true;
      for (const event of events) {
        // Boundary check 2: check isShuttingDown before processing each event
        if (this.isShuttingDown) {
          allEventsProcessedInBatch = false;
          break;
        }

        const success = await this.dispatchSingleEvent(state, event);
        if (!success) {
          allEventsProcessedInBatch = false;
          break; // Stop advancing on authorization failure or shutdown
        }
      }

      if (
        !allEventsProcessedInBatch ||
        this.isShuttingDown ||
        events.length < this.batchSize
      ) {
        break;
      }

      // Cooperative yielding to event loop without releasing activeDrain lock
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private async dispatchSingleEvent(
    state: ProjectDeliveryState,
    event: ProjectEvent
  ): Promise<boolean> {
    // Boundary check 3: check isShuttingDown before initiating fan-out
    if (this.isShuttingDown) {
      return false;
    }

    const currentSubscribers = Array.from(state.subscribers.values());
    if (currentSubscribers.length === 0) {
      state.localLastDeliveredSeq = event.seq;
      return true;
    }

    // 1. Fresh Pre-Dispatch PostgreSQL Authorization Check
    const distinctUserIds = Array.from(
      new Set(currentSubscribers.map((s) => s.userId))
    );

    let activeRows: { userId: string; role: string }[];
    try {
      activeRows = await this.db
        .select({
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, state.workspaceId),
            inArray(workspaceMembers.userId, distinctUserIds)
          )
        );
    } catch (err) {
      this.logger.error(
        { err, projectId: state.projectId, workspaceId: state.workspaceId },
        "Failed to verify workspace membership prior to event dispatch; freezing cursor"
      );
      // Fail closed on DB error: do not dispatch, do not advance cursor, do not evict
      return false;
    }

    const activeUserSet = new Set(activeRows.map((r) => r.userId));
    const eligibleSubscribers: ProjectSubscriber[] = [];

    for (const sub of currentSubscribers) {
      if (activeUserSet.has(sub.userId)) {
        eligibleSubscribers.push(sub);
      } else {
        // Confirmed absent: evict and close
        this.logger.info(
          { subId: sub.id, userId: sub.userId, projectId: state.projectId },
          "Evicting subscriber with confirmed non-membership"
        );
        this.evictSubscriber(state.projectId, sub.id);
      }
    }

    // Boundary check before fan-out
    if (this.isShuttingDown) {
      return false;
    }

    if (eligibleSubscribers.length === 0) {
      state.localLastDeliveredSeq = event.seq;
      return true;
    }

    // 2. Concurrent Fan-Out using Promise.allSettled with synchronous & asynchronous isolation
    const sendPromises = eligibleSubscribers.map(async (sub) => {
      // Check isShuttingDown immediately before invoking each individual subscriber's send
      if (this.isShuttingDown) {
        return {
          sub,
          outcome: { success: false, timedOut: false, skippedDueToShutdown: true },
        };
      }

      try {
        const outcome = await this.sendWithTimeout(
          sub,
          event,
          this.subscriberSendTimeoutMs
        );
        return { sub, outcome };
      } catch (syncErr) {
        return {
          sub,
          outcome: { success: false, timedOut: false, err: syncErr },
        };
      }
    });

    const settledResults = await Promise.allSettled(sendPromises);

    // Evict subscribers whose sends failed or timed out
    for (const result of settledResults) {
      if (result.status === "fulfilled") {
        const { sub, outcome } = result.value;
        if (outcome.skippedDueToShutdown) {
          // A subscriber skipped because shutdown has started must not be treated as a send failure
          // or unnecessarily evicted.
          continue;
        }

        if (!outcome.success) {
          this.logger.warn(
            {
              subId: sub.id,
              userId: sub.userId,
              timedOut: outcome.timedOut,
              err: outcome.err,
            },
            "Subscriber delivery failed or timed out; evicting"
          );
          this.evictSubscriber(state.projectId, sub.id);
        }
      } else {
        this.logger.error(
          { reason: result.reason },
          "Unexpected failure in subscriber dispatch harness"
        );
      }
    }

    // Boundary check 4: check isShuttingDown before advancing cursor
    if (!this.isShuttingDown) {
      state.localLastDeliveredSeq = event.seq;
      return true;
    }

    return false;
  }

  /**
   * Bounded subscriber send wrapper (Option A: 5-second timeout).
   * Guards against unhandled rejections and late completions/rejections.
   */
  private async sendWithTimeout(
    sub: ProjectSubscriber,
    event: ProjectEvent,
    timeoutMs: number
  ): Promise<{
    success: boolean;
    timedOut: boolean;
    skippedDueToShutdown?: boolean;
    err?: unknown;
  }> {
    if (this.isShuttingDown) {
      return { success: false, timedOut: false, skippedDueToShutdown: true };
    }

    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    try {
      const sendPromise = Promise.resolve(sub.send(event));

      const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve({ timedOut: true });
          }
        }, timeoutMs);
      });

      // Guard late rejection of sendPromise to prevent unhandled promise rejection
      sendPromise.catch((err) => {
        if (settled) {
          this.logger.debug?.(
            { err, subId: sub.id },
            "Late rejection from timed-out subscriber ignored safely"
          );
        }
      });

      const outcome = await Promise.race([
        sendPromise.then(() => ({ timedOut: false })),
        timeoutPromise,
      ]);

      settled = true;
      if (timer) clearTimeout(timer);

      if (outcome.timedOut) {
        return { success: false, timedOut: true };
      }
      return { success: true, timedOut: false };
    } catch (err) {
      settled = true;
      if (timer) clearTimeout(timer);
      return { success: false, timedOut: false, err };
    }
  }

  // ==========================================================================
  // Observability & Test Helpers
  // ==========================================================================

  public getProjectState(projectId: string): {
    localLastDeliveredSeq: number;
    subscriberCount: number;
    isDraining: boolean;
  } | null {
    const state = this.activeProjects.get(projectId);
    if (!state) return null;
    return {
      localLastDeliveredSeq: state.localLastDeliveredSeq,
      subscriberCount: state.subscribers.size,
      isDraining: state.activeDrain !== null,
    };
  }

  public getActiveProjectsCount(): number {
    return this.activeProjects.size;
  }

  public isRunning(): boolean {
    return !this.isShuttingDown && this.unsubscribeListener !== null;
  }
}
