import type postgres from "postgres";
import { z } from "zod";
import { getSqlClient } from "../db/index.js";

// ============================================================================
// Schemas & Types
// ============================================================================

export const projectEventNotificationSchema = z
  .object({
    projectId: z.string().uuid(),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type ProjectEventNotification = z.infer<typeof projectEventNotificationSchema>;

export const membershipActionSchema = z.enum(["removed", "role_updated", "added"]);
export type MembershipAction = z.infer<typeof membershipActionSchema>;

export const membershipAffectedUserSchema = z
  .object({
    userId: z.string().uuid(),
    action: membershipActionSchema,
  })
  .strict();

export type MembershipAffectedUser = z.infer<typeof membershipAffectedUserSchema>;

export const membershipChangeNotificationSchema = z
  .object({
    workspaceId: z.string().uuid(),
    affectedUsers: z.array(membershipAffectedUserSchema).min(1).max(500),
  })
  .strict();

export type MembershipChangeNotification = z.infer<typeof membershipChangeNotificationSchema>;

export type ListenerStatus = "stopped" | "starting" | "ready";

export interface ReconnectInfo {
  reconnectCount: number;
}

export type ProjectEventCallback = (
  payload: ProjectEventNotification
) => void | Promise<void>;

export type MembershipChangeCallback = (
  payload: MembershipChangeNotification
) => void | Promise<void>;

export type ReconnectCallback = (info: ReconnectInfo) => void | Promise<void>;

export interface Logger {
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
  debug?: (obj: Record<string, unknown> | string, msg?: string) => void;
}

export interface PostgresListenerOptions {
  sqlClient?: postgres.Sql;
  logger?: Logger;
}

export type ListenerSubscriptionHandle = {
  unlisten: () => Promise<void>;
  state?: { pid: number };
};

// ============================================================================
// PostgresListenerService Implementation
// ============================================================================

/**
 * Manages dedicated PostgreSQL LISTEN subscriptions for real-time signaling.
 *
 * Subscribes to:
 * - 'project_events'
 * - 'membership_changes'
 *
 * Utilizes the built-in dedicated listener connection and automatic reconnection
 * provided by Postgres.js (postgres@3.4.9).
 */
export class PostgresListenerService {
  private readonly sqlClient: postgres.Sql;
  private readonly logger: Logger;

  private _status: ListenerStatus = "stopped";
  private _reconnectCount = 0;
  private _initialBackendPid: number | null = null;

  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private cancelRestartPromise: Promise<void> | null = null;
  private stopRequested = false;

  private projectEventsHandle: ListenerSubscriptionHandle | null = null;
  private membershipChangesHandle: ListenerSubscriptionHandle | null = null;

  // Track channels that have confirmed reconnection on the current session
  private readonly reconnectedChannels = new Set<string>();

  // Consumer callback registries
  private readonly projectEventCallbacks = new Set<ProjectEventCallback>();
  private readonly membershipChangeCallbacks = new Set<MembershipChangeCallback>();
  private readonly reconnectCallbacks = new Set<ReconnectCallback>();

  constructor(options: PostgresListenerOptions = {}) {
    this.sqlClient = options.sqlClient ?? getSqlClient();
    this.logger = options.logger ?? {
      info: (obj, msg) => console.info("[PostgresListener]", msg ?? obj),
      warn: (obj, msg) => console.warn("[PostgresListener]", msg ?? obj),
      error: (obj, msg) => console.error("[PostgresListener]", msg ?? obj),
    };
  }

  /**
   * Current lifecycle status: 'stopped' | 'starting' | 'ready'.
   */
  public get status(): ListenerStatus {
    return this._status;
  }

  /**
   * Number of successful automatic reconnections after initial ready state.
   */
  public get reconnectCount(): number {
    return this._reconnectCount;
  }

  /**
   * The backend process ID obtained during initial subscription confirmation.
   *
   * Note: This PID represents the initial physical connection; after transparent
   * reconnection, PostgreSQL assigns a new backend PID.
   */
  public getInitialBackendPid(): number | null {
    return this._initialBackendPid;
  }

  /**
   * Starts the listener service and subscribes to project_events and membership_changes.
   *
   * Idempotent: concurrent calls share the same start promise.
   * Resolves only after both channel subscriptions are confirmed by PostgreSQL.
   */
  public async start(): Promise<void> {
    if (this._status === "ready") {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this._status = "starting";
    this.stopRequested = false;

    this.startPromise = (async () => {
      const earlyHandles: {
        handle1: ListenerSubscriptionHandle | null;
        handle2: ListenerSubscriptionHandle | null;
      } = {
        handle1: null,
        handle2: null,
      };

      try {
        // If an earlier cancellation operation is finalizing, serialize by awaiting its completion
        if (this.cancelRestartPromise) {
          try {
            await this.cancelRestartPromise;
          } catch {
            // Ignore cancellation errors
          }
          // Yield microtask to allow any stop() continuation attached to cancelRestartPromise to settle
          await Promise.resolve();
        }

        // If a stop operation is currently in-progress, serialize by awaiting its completion
        if (this.stopPromise) {
          try {
            await this.stopPromise;
          } catch {
            // Ignore errors from previous stop
          }
        }

        // If stop was requested while waiting for the previous stop or cancellation to complete, abort
        if (this.stopRequested) {
          this._status = "stopped";
          return;
        }

        this._status = "starting";

        // Register project_events and retain handle immediately upon resolution
        const p1 = this.sqlClient
          .listen(
            "project_events",
            (raw) => this.handleRawProjectEvent(raw),
            () => this.handleOnListen("project_events")
          )
          .then((h) => {
            earlyHandles.handle1 = h as unknown as ListenerSubscriptionHandle;
            return earlyHandles.handle1;
          });

        // Register membership_changes and retain handle immediately upon resolution
        const p2 = this.sqlClient
          .listen(
            "membership_changes",
            (raw) => this.handleRawMembershipChange(raw),
            () => this.handleOnListen("membership_changes")
          )
          .then((h) => {
            earlyHandles.handle2 = h as unknown as ListenerSubscriptionHandle;
            return earlyHandles.handle2;
          });

        // Await confirmation of both channel subscriptions until both settle
        const [res1, res2] = await Promise.allSettled([p1, p2]);

        // If either subscription failed, clean up any successfully established handles exactly once
        if (res1.status === "rejected" || res2.status === "rejected") {
          const unlistenPromises: Array<Promise<void>> = [];

          if (earlyHandles.handle1) {
            const h = earlyHandles.handle1;
            earlyHandles.handle1 = null;
            unlistenPromises.push(h.unlisten().catch(() => {}));
          }

          if (earlyHandles.handle2) {
            const h = earlyHandles.handle2;
            earlyHandles.handle2 = null;
            unlistenPromises.push(h.unlisten().catch(() => {}));
          }

          await Promise.allSettled(unlistenPromises);

          this.projectEventsHandle = null;
          this.membershipChangesHandle = null;
          this._status = "stopped";

          const primaryError =
            res1.status === "rejected" ? res1.reason : (res2 as PromiseRejectedResult).reason;
          this.logger.error(
            { err: primaryError },
            "Failed to start PostgresListenerService (partial or full subscription failure)"
          );
          throw primaryError;
        }

        const resolvedHandle1 = res1.value;
        const resolvedHandle2 = res2.value;

        earlyHandles.handle1 = null;
        earlyHandles.handle2 = null;

        this.projectEventsHandle = resolvedHandle1;
        this.membershipChangesHandle = resolvedHandle2;

        const initialPid = resolvedHandle1?.state?.pid;
        if (typeof initialPid === "number") {
          this._initialBackendPid = initialPid;
        }

        // If stop was requested while start was in-flight, clean up immediately
        if (this.stopRequested) {
          await this.cleanupHandles();
          this._status = "stopped";
          return;
        }

        this._status = "ready";
        this.logger.info(
          { pid: this._initialBackendPid },
          "PostgresListenerService is ready and subscribed to channels"
        );
      } catch (err) {
        // If an unexpected synchronous or unhandled error occurred before settled cleanup:
        if (earlyHandles.handle1) {
          const h = earlyHandles.handle1;
          earlyHandles.handle1 = null;
          await h.unlisten().catch(() => {});
        }
        if (earlyHandles.handle2) {
          const h = earlyHandles.handle2;
          earlyHandles.handle2 = null;
          await h.unlisten().catch(() => {});
        }
        this.projectEventsHandle = null;
        this.membershipChangesHandle = null;
        this._status = "stopped";
        this.logger.error({ err }, "Failed to start PostgresListenerService");
        throw err;
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  /**
   * Stops the listener service and unlistens from both channels.
   *
   * Idempotent: safe to call multiple times concurrently or sequentially.
   * Does NOT close the underlying sqlClient, which is owned by the database module.
   */
  public async stop(): Promise<void> {
    if (this._status === "stopped" && !this.stopPromise && !this.startPromise && !this.cancelRestartPromise) {
      return;
    }

    // If a start operation is in-flight or waiting for an earlier stop, request its cancellation
    if (this.startPromise) {
      this.stopRequested = true;
    }

    if (this.cancelRestartPromise) {
      if (this.startPromise) {
        try {
          await this.cancelRestartPromise;
        } catch {
          // Ignore cancellation errors
        }
        try {
          await this.startPromise;
        } catch {
          // Ignore startup cancellation errors
        }
        this._status = "stopped";
        return;
      }
      return this.cancelRestartPromise;
    }

    if (this.stopPromise) {
      // If a restart was waiting for this stop operation to complete, awaiting this.stopPromise
      // alone is not sufficient because startPromise would resume after this.stopPromise
      // resolves. We must also ensure startPromise observes the cancellation and settles.
      if (this.startPromise) {
        if (!this.cancelRestartPromise) {
          const prevStop = this.stopPromise;
          const startP = this.startPromise;
          this.cancelRestartPromise = (async () => {
            try {
              await prevStop;
            } catch {
              // Ignore previous stop errors
            }
            try {
              await startP;
            } catch {
              // Ignore startup cancellation errors
            }
            // Only update status to 'stopped' if no newer startup operation has superseded this one
            if (this.startPromise === null || this.startPromise === startP) {
              this._status = "stopped";
            }
          })().finally(() => {
            this.cancelRestartPromise = null;
          });
        }
        return this.cancelRestartPromise;
      }

      return this.stopPromise;
    }

    this.stopPromise = (async () => {
      if (this._status === "starting" || this.startPromise) {
        this.stopRequested = true;
        try {
          await this.startPromise;
        } catch {
          // Ignore startup error during shutdown
        }
      }

      this._status = "stopped";
      this.reconnectedChannels.clear();
      await this.cleanupHandles();
      this.logger.info("PostgresListenerService stopped and channels unlistened");
    })().finally(() => {
      this.stopPromise = null;
    });

    return this.stopPromise;
  }

  /**
   * Subscribes a consumer callback for project_events notifications.
   * Returns an unsubscribe function.
   */
  public onProjectEvent(callback: ProjectEventCallback): () => void {
    this.projectEventCallbacks.add(callback);
    return () => {
      this.projectEventCallbacks.delete(callback);
    };
  }

  /**
   * Subscribes a consumer callback for membership_changes notifications.
   * Returns an unsubscribe function.
   */
  public onMembershipChange(callback: MembershipChangeCallback): () => void {
    this.membershipChangeCallbacks.add(callback);
    return () => {
      this.membershipChangeCallbacks.delete(callback);
    };
  }

  /**
   * Subscribes a consumer callback for successful listener reconnection events.
   * Returns an unsubscribe function.
   */
  public onReconnect(callback: ReconnectCallback): () => void {
    this.reconnectCallbacks.add(callback);
    return () => {
      this.reconnectCallbacks.delete(callback);
    };
  }

  // ==========================================================================
  // Internal Event & Reconnect Handling
  // ==========================================================================

  private handleOnListen(channel: string): void {
    if (this._status !== "ready") {
      // Still during initial startup; start() promise handles readiness transition
      return;
    }

    // This is an automatic reconnection event triggered by Postgres.js onclose handler
    this.reconnectedChannels.add(channel);

    // Both channels multiplex over the same connection; wait until both confirm re-listening
    if (
      this.reconnectedChannels.has("project_events") &&
      this.reconnectedChannels.has("membership_changes")
    ) {
      this.reconnectedChannels.clear();
      this._reconnectCount++;

      this.logger.info(
        { reconnectCount: this._reconnectCount },
        "Listener connection restored and subscriptions confirmed"
      );

      this.dispatchReconnect({ reconnectCount: this._reconnectCount });
    }
  }

  private handleRawProjectEvent(raw: string): void {
    if (this._status !== "ready") {
      return;
    }

    // Guard against oversized payload (PostgreSQL NOTIFY max payload is 8000 bytes)
    if (typeof raw !== "string" || raw.length > 8000) {
      this.logger.warn(
        { length: typeof raw === "string" ? raw.length : 0 },
        "Oversized or non-string payload rejected on project_events channel"
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(
        { length: raw.length },
        "Malformed JSON on project_events channel"
      );
      return;
    }

    const result = projectEventNotificationSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(
        { length: raw.length, issueCount: result.error.issues.length },
        "Invalid payload structure on project_events channel"
      );
      return;
    }

    this.dispatchProjectEvent(result.data);
  }

  private handleRawMembershipChange(raw: string): void {
    if (this._status !== "ready") {
      return;
    }

    // Guard against oversized payload (PostgreSQL NOTIFY max payload is 8000 bytes)
    if (typeof raw !== "string" || raw.length > 8000) {
      this.logger.warn(
        { length: typeof raw === "string" ? raw.length : 0 },
        "Oversized or non-string payload rejected on membership_changes channel"
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(
        { length: raw.length },
        "Malformed JSON on membership_changes channel"
      );
      return;
    }

    const result = membershipChangeNotificationSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(
        { length: raw.length, issueCount: result.error.issues.length },
        "Invalid payload structure on membership_changes channel"
      );
      return;
    }

    this.dispatchMembershipChange(result.data);
  }

  // ==========================================================================
  // Consumer Dispatch with Fault Isolation & Lifecycle Guards
  // ==========================================================================

  private dispatchProjectEvent(payload: ProjectEventNotification): void {
    if (this._status !== "ready") {
      return;
    }
    const callbacks = Array.from(this.projectEventCallbacks);
    for (const callback of callbacks) {
      if (this._status !== "ready") {
        return;
      }
      try {
        const res = callback(payload);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch((err) => {
            this.logger.error({ err }, "Async error in project_events callback");
          });
        }
      } catch (err) {
        this.logger.error({ err }, "Sync error in project_events callback");
      }
    }
  }

  private dispatchMembershipChange(payload: MembershipChangeNotification): void {
    if (this._status !== "ready") {
      return;
    }
    const callbacks = Array.from(this.membershipChangeCallbacks);
    for (const callback of callbacks) {
      if (this._status !== "ready") {
        return;
      }
      try {
        const res = callback(payload);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch((err) => {
            this.logger.error({ err }, "Async error in membership_changes callback");
          });
        }
      } catch (err) {
        this.logger.error({ err }, "Sync error in membership_changes callback");
      }
    }
  }

  private dispatchReconnect(info: ReconnectInfo): void {
    if (this._status !== "ready") {
      return;
    }
    const callbacks = Array.from(this.reconnectCallbacks);
    for (const callback of callbacks) {
      if (this._status !== "ready") {
        return;
      }
      try {
        const res = callback(info);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch((err) => {
            this.logger.error({ err }, "Async error in reconnect callback");
          });
        }
      } catch (err) {
        this.logger.error({ err }, "Sync error in reconnect callback");
      }
    }
  }

  private async cleanupHandles(): Promise<void> {
    const h1 = this.projectEventsHandle;
    const h2 = this.membershipChangesHandle;

    this.projectEventsHandle = null;
    this.membershipChangesHandle = null;

    await Promise.allSettled([
      h1?.unlisten(),
      h2?.unlisten(),
    ]);
  }
}
