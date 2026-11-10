import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { workspaceMembers } from "../db/schema/index.js";
import type { Logger, PostgresListenerService } from "./listener.js";
import type {
  MembershipAffectedUser,
  MembershipChangeNotification,
} from "../schemas/membership-notification.js";

// ============================================================================
// Types
// ============================================================================

export type WorkspaceRole = "owner" | "admin" | "member";

export type ReconciledMembershipEvent =
  | {
      type: "revoked";
      workspaceId: string;
      userId: string;
    }
  | {
      type: "role_updated";
      workspaceId: string;
      userId: string;
      role: WorkspaceRole;
    }
  | {
      type: "added";
      workspaceId: string;
      userId: string;
      role: WorkspaceRole;
    };

export type MembershipReconciliationCallback = (
  event: ReconciledMembershipEvent
) => void | Promise<void>;

export interface MembershipConsumerOptions {
  db: Database;
  listener: PostgresListenerService;
  logger?: Logger;
}

// ============================================================================
// MembershipConsumerService Implementation
// ============================================================================

/**
 * Domain consumer service managing point-in-time state reconciliation for
 * workspace membership change notifications.
 *
 * Requirements (M8.2.2):
 * 1. Consumes 'membership_changes' notifications from PostgresListenerService.
 * 2. Treats notifications as edge triggers, not state authority.
 * 3. Authoritatively queries PostgreSQL workspace_members before dispatching.
 * 4. Stale removal protection: suppresses revocation if DB shows active member.
 * 5. Stale role update handling: dispatches revocation if DB shows non-member.
 * 6. Stale addition handling: ignores addition if DB shows non-member.
 * 7. Transient DB error safety: skips dispatch without accidental revocation.
 * 8. Per-user FIFO serialization: guarantees sequential processing per user.
 * 9. Parallel inter-user processing: concurrent users process independently.
 */
export class MembershipConsumerService {
  private readonly db: Database;
  private readonly listener: PostgresListenerService;
  private readonly logger: Logger;

  private readonly callbacks = new Set<MembershipReconciliationCallback>();
  private readonly userChains = new Map<string, Promise<void>>();
  private unsubscribeListener: (() => void) | null = null;

  constructor(options: MembershipConsumerOptions) {
    this.db = options.db;
    this.listener = options.listener;
    this.logger = options.logger ?? {
      info: (obj, msg) => console.info("[MembershipConsumer]", msg ?? obj),
      warn: (obj, msg) => console.warn("[MembershipConsumer]", msg ?? obj),
      error: (obj, msg) => console.error("[MembershipConsumer]", msg ?? obj),
    };
  }

  /**
   * Starts consumer by registering its notification handler with the listener.
   * Idempotent: safe to call multiple times.
   */
  public start(): void {
    if (this.unsubscribeListener !== null) {
      return;
    }

    this.unsubscribeListener = this.listener.onMembershipChange(
      (payload) => this.handleNotification(payload)
    );

    this.logger.info("MembershipConsumerService started and subscribed to listener");
  }

  /**
   * Stops consumer by unregistering from the listener and awaiting draining of
   * any active user reconciliation chains.
   * Idempotent: safe to call multiple times.
   */
  public async stop(): Promise<void> {
    if (this.unsubscribeListener) {
      this.unsubscribeListener();
      this.unsubscribeListener = null;
    }

    const activeChains = Array.from(this.userChains.values());
    if (activeChains.length > 0) {
      await Promise.allSettled(activeChains);
    }

    this.logger.info("MembershipConsumerService stopped and user chains drained");
  }

  /**
   * Subscribes a consumer callback for reconciled membership events.
   * Returns an unsubscribe function.
   */
  public onEvent(callback: MembershipReconciliationCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  // ==========================================================================
  // Internal Notification & User Reconciliation
  // ==========================================================================

  private async handleNotification(
    payload: MembershipChangeNotification
  ): Promise<void> {
    const promises = payload.affectedUsers.map((affectedUser) =>
      this.enqueueUserReconciliation(payload.workspaceId, affectedUser)
    );

    await Promise.allSettled(promises);
  }

  private enqueueUserReconciliation(
    workspaceId: string,
    affectedUser: MembershipAffectedUser
  ): Promise<void> {
    const userKey = `${workspaceId}:${affectedUser.userId}`;
    const prevChain = this.userChains.get(userKey) ?? Promise.resolve();

    const nextChain = prevChain
      .then(async () => {
        await this.reconcileUser(workspaceId, affectedUser);
      })
      .catch((err) => {
        this.logger.error(
          { err, workspaceId, userId: affectedUser.userId },
          "Unhandled error in user reconciliation chain"
        );
      })
      .finally(() => {
        if (this.userChains.get(userKey) === nextChain) {
          this.userChains.delete(userKey);
        }
      });

    this.userChains.set(userKey, nextChain);
    return nextChain;
  }

  private async reconcileUser(
    workspaceId: string,
    affectedUser: MembershipAffectedUser
  ): Promise<void> {
    let lookupResult: { isMember: boolean; role: WorkspaceRole | null };

    try {
      lookupResult = await this.lookupMembership(workspaceId, affectedUser.userId);
    } catch (err) {
      this.logger.error(
        { err, workspaceId, userId: affectedUser.userId, action: affectedUser.action },
        "Failed to verify workspace membership during reconciliation; skipping dispatch"
      );
      // Under no circumstances treat a DB error as absence of membership
      return;
    }

    let eventToDispatch: ReconciledMembershipEvent | null = null;

    if (lookupResult.isMember && lookupResult.role) {
      if (affectedUser.action === "role_updated") {
        eventToDispatch = {
          type: "role_updated",
          workspaceId,
          userId: affectedUser.userId,
          role: lookupResult.role,
        };
      } else if (affectedUser.action === "added") {
        eventToDispatch = {
          type: "added",
          workspaceId,
          userId: affectedUser.userId,
          role: lookupResult.role,
        };
      } else if (affectedUser.action === "removed") {
        // Stale removal: user is currently an active member in DB. Suppress revocation.
        this.logger.info(
          { workspaceId, userId: affectedUser.userId },
          "Suppressed stale membership removal notification for active member"
        );
      }
    } else {
      // User is not a member in DB
      if (affectedUser.action === "removed" || affectedUser.action === "role_updated") {
        eventToDispatch = {
          type: "revoked",
          workspaceId,
          userId: affectedUser.userId,
        };
      } else if (affectedUser.action === "added") {
        // Stale addition: user was removed before add was processed. Suppress.
        this.logger.info(
          { workspaceId, userId: affectedUser.userId },
          "Suppressed stale membership addition notification for non-member"
        );
      }
    }

    if (eventToDispatch) {
      await this.dispatchEvent(eventToDispatch);
    }
  }

  private async dispatchEvent(event: ReconciledMembershipEvent): Promise<void> {
    const callbacks = Array.from(this.callbacks);
    for (const callback of callbacks) {
      try {
        const res = callback(event);
        if (res && typeof (res as Promise<void>).catch === "function") {
          await (res as Promise<void>).catch((err) => {
            this.logger.error(
              { err, event },
              "Async error in membership reconciliation callback"
            );
          });
        }
      } catch (err) {
        this.logger.error(
          { err, event },
          "Sync error in membership reconciliation callback"
        );
      }
    }
  }

  private async lookupMembership(
    workspaceId: string,
    userId: string
  ): Promise<{ isMember: boolean; role: WorkspaceRole | null }> {
    const [row] = await this.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId)
        )
      );

    if (!row) {
      return { isMember: false, role: null };
    }

    return {
      isMember: true,
      role: row.role as WorkspaceRole,
    };
  }
}
