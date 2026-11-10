import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../src/db/index.js";
import type { PostgresListenerService } from "../../src/services/listener.js";
import {
  MembershipConsumerService,
  type ReconciledMembershipEvent,
} from "../../src/services/membership-consumer.js";
import type { MembershipChangeNotification } from "../../src/schemas/membership-notification.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockListener() {
  let membershipHandler:
    | ((payload: MembershipChangeNotification) => Promise<void> | void)
    | null = null;

  const unsubscribe = vi.fn(() => {
    membershipHandler = null;
  });

  const listener = {
    onMembershipChange: vi.fn((cb) => {
      membershipHandler = cb;
      return unsubscribe;
    }),
    status: "ready",
  } as unknown as PostgresListenerService;

  const emit = async (payload: MembershipChangeNotification) => {
    if (membershipHandler) {
      await membershipHandler(payload);
    }
  };

  return { listener, emit, unsubscribe };
}

function createMockDb(
  lookupFn: (
    workspaceId: string,
    userId: string
  ) => Promise<Array<{ role: string }>>
): Database {
  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation((condition: unknown) => {
          // Extract workspaceId and userId if needed or route to lookupFn
          return lookupFn("", "");
        }),
      })),
    })),
  } as unknown as Database;
}

function createCustomMockDb(
  lookupFn: (
    workspaceId: string,
    userId: string
  ) => Promise<Array<{ role: string }>>
): Database {
  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(async (expr: any) => {
          // Drizzle expressions have queries with workspaceId and userId in query chunks
          // Instead of parsing SQL AST, we track the query by passing params to lookupFn
          return lookupFn(expr?.workspaceId ?? "", expr?.userId ?? "");
        }),
      })),
    })),
  } as unknown as Database;
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("MembershipConsumerService (Unit - M8.2.2)", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const userId = "22222222-2222-4222-8222-222222222222";
  const userId2 = "33333333-3333-4333-8333-333333333333";

  describe("Reconciliation Table Branch Verification", () => {
    it("removed + DB not a member: dispatches revoked event", async () => {
      const { listener, emit } = createMockListener();
      const mockDb = createMockDb(async () => []); // row not found
      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
      });
      consumer.start();

      await emit({
        workspaceId,
        affectedUsers: [{ userId, action: "removed" }],
      });

      expect(events).toEqual([
        {
          type: "revoked",
          workspaceId,
          userId,
        },
      ]);
    });

    it("removed + DB is member: suppresses revocation (stale removed signal)", async () => {
      const { listener, emit } = createMockListener();
      const mockDb = createMockDb(async () => [{ role: "member" }]); // active member
      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
      });
      consumer.start();

      await emit({
        workspaceId,
        affectedUsers: [{ userId, action: "removed" }],
      });

      expect(events).toHaveLength(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, userId }),
        expect.stringContaining("Suppressed stale membership removal")
      );
    });

    it("role_updated + DB is member: dispatches role_updated with verified role", async () => {
      const { listener, emit } = createMockListener();
      const mockDb = createMockDb(async () => [{ role: "admin" }]); // updated to admin
      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
      });
      consumer.start();

      await emit({
        workspaceId,
        affectedUsers: [{ userId, action: "role_updated" }],
      });

      expect(events).toEqual([
        {
          type: "role_updated",
          workspaceId,
          userId,
          role: "admin",
        },
      ]);
    });

    it("role_updated + DB not a member: dispatches revoked event (stale role update)", async () => {
      const { listener, emit } = createMockListener();
      const mockDb = createMockDb(async () => []); // removed before role update processed
      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
      });
      consumer.start();

      await emit({
        workspaceId,
        affectedUsers: [{ userId, action: "role_updated" }],
      });

      expect(events).toEqual([
        {
          type: "revoked",
          workspaceId,
          userId,
        },
      ]);
    });

    it("added + DB is member: dispatches added event with verified role", async () => {
      const { listener, emit } = createMockListener();
      const mockDb = createMockDb(async () => [{ role: "member" }]);
      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
      });
      consumer.start();

      await emit({
        workspaceId,
        affectedUsers: [{ userId, action: "added" }],
      });

      expect(events).toEqual([
        {
          type: "added",
          workspaceId,
          userId,
          role: "member",
        },
      ]);
    });

    it("added + DB not a member: suppresses addition (stale added signal)", async () => {
      const { listener, emit } = createMockListener();
      const mockDb = createMockDb(async () => []); // removed before add processed
      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
      });
      consumer.start();

      await emit({
        workspaceId,
        affectedUsers: [{ userId, action: "added" }],
      });

      expect(events).toHaveLength(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, userId }),
        expect.stringContaining("Suppressed stale membership addition")
      );
    });

    it("transient database error: logs error and does NOT dispatch revocation", async () => {
      const { listener, emit } = createMockListener();
      const mockDb = createMockDb(async () => {
        throw new Error("Connection pool timeout");
      });
      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
      });
      consumer.start();

      await emit({
        workspaceId,
        affectedUsers: [{ userId, action: "removed" }],
      });

      // Crucial security invariant: DB failure must NEVER cause false revocation
      expect(events).toHaveLength(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          userId,
          action: "removed",
        }),
        expect.stringContaining("Failed to verify workspace membership during reconciliation")
      );
    });
  });

  describe("Deterministic Concurrency & Per-User FIFO Serialization", () => {
    it("serializes concurrent notifications for the same user in strict FIFO order using barriers", async () => {
      const { listener, emit } = createMockListener();

      const barrier1 = createDeferred<void>();
      const barrier2 = createDeferred<void>();
      const n2LookupStarted = createDeferred<void>();
      let callCount = 0;

      // Mock database lookup with deterministic control
      const lookupMock = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call (N1: role_updated): wait on barrier1
          await barrier1.promise;
          return [{ role: "admin" }];
        } else {
          // Second call (N2: removed): signal start, then wait on barrier2
          n2LookupStarted.resolve();
          await barrier2.promise;
          return []; // non-member
        }
      });

      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: lookupMock,
          })),
        })),
      } as unknown as Database;

      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      const dispatchedEvents: ReconciledMembershipEvent[] = [];
      const n1Dispatched = createDeferred<void>();
      const n2Dispatched = createDeferred<void>();

      consumer.onEvent((ev) => {
        dispatchedEvents.push(ev);
        if (dispatchedEvents.length === 1) {
          n1Dispatched.resolve();
        } else if (dispatchedEvents.length === 2) {
          n2Dispatched.resolve();
        }
      });
      consumer.start();

      // Launch N1 (role_updated) - will block at barrier1 inside DB lookup
      const n1Promise = emit({
        workspaceId,
        affectedUsers: [{ userId, action: "role_updated" }],
      });

      // Allow microtasks to execute so N1 enters DB lookup
      await Promise.resolve();
      expect(lookupMock).toHaveBeenCalledTimes(1);

      // Launch N2 (removed) for the SAME user while N1 is blocked
      const n2Promise = emit({
        workspaceId,
        affectedUsers: [{ userId, action: "removed" }],
      });

      await Promise.resolve();
      // Because N2 is queued behind N1 in userChains, lookupMock must STILL be called only once
      expect(lookupMock).toHaveBeenCalledTimes(1);
      expect(dispatchedEvents).toHaveLength(0);

      // Release barrier1 so N1 can complete
      barrier1.resolve();
      await n1Dispatched.promise;

      // Now N1 has finished and dispatched role_updated; N2 begins its lookup
      await n2LookupStarted.promise;
      expect(lookupMock).toHaveBeenCalledTimes(2);
      expect(dispatchedEvents).toEqual([
        {
          type: "role_updated",
          workspaceId,
          userId,
          role: "admin",
        },
      ]);

      // Release barrier2 so N2 can complete
      barrier2.resolve();
      await n2Dispatched.promise;
      await Promise.all([n1Promise, n2Promise]);

      // Final event order is strictly FIFO: role_updated followed by revoked
      expect(dispatchedEvents).toEqual([
        {
          type: "role_updated",
          workspaceId,
          userId,
          role: "admin",
        },
        {
          type: "revoked",
          workspaceId,
          userId,
        },
      ]);
    });

    it("processes notifications for different users concurrently without cross-user blocking", async () => {
      const { listener, emit } = createMockListener();

      const userABarrier = createDeferred<void>();
      const userBDispatched = createDeferred<void>();

      let userALookupStarted = false;
      let userBLookupCompleted = false;

      const selectiveDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(async () => {
              if (!userALookupStarted) {
                userALookupStarted = true;
                await userABarrier.promise;
                return [{ role: "owner" }];
              } else {
                userBLookupCompleted = true;
                return [{ role: "member" }];
              }
            }),
          })),
        })),
      } as unknown as Database;

      const consumer = new MembershipConsumerService({
        db: selectiveDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
        if (ev.userId === userId2) {
          userBDispatched.resolve();
        }
      });
      consumer.start();

      // Start User A (will block on userABarrier)
      const userAPromise = emit({
        workspaceId,
        affectedUsers: [{ userId, action: "role_updated" }],
      });

      await Promise.resolve();
      expect(userALookupStarted).toBe(true);

      // Start User B while User A is blocked
      const userBPromise = emit({
        workspaceId,
        affectedUsers: [{ userId: userId2, action: "added" }],
      });

      // User B must complete and dispatch immediately without waiting for User A's barrier
      await userBDispatched.promise;
      expect(userBLookupCompleted).toBe(true);
      expect(events).toEqual([
        {
          type: "added",
          workspaceId,
          userId: userId2,
          role: "member",
        },
      ]);

      // Finally unblock User A
      userABarrier.resolve();
      await Promise.all([userAPromise, userBPromise]);

      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({
        type: "role_updated",
        workspaceId,
        userId,
        role: "owner",
      });
    });

    it("processes duplicate notifications sequentially and idempotently", async () => {
      const { listener, emit } = createMockListener();
      let queryCount = 0;

      const mockDb = createMockDb(async () => {
        queryCount++;
        return [{ role: "admin" }];
      });

      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
      });
      consumer.start();

      const payload: MembershipChangeNotification = {
        workspaceId,
        affectedUsers: [{ userId, action: "role_updated" }],
      };

      // Dispatch twice
      await Promise.all([emit(payload), emit(payload)]);

      // Both executed sequentially through the chain
      expect(queryCount).toBe(2);
      expect(events).toEqual([
        {
          type: "role_updated",
          workspaceId,
          userId,
          role: "admin",
        },
        {
          type: "role_updated",
          workspaceId,
          userId,
          role: "admin",
        },
      ]);
    });
  });

  describe("Multi-User Payloads & Batch Fault Isolation", () => {
    it("processes ownership transfer containing two affected users concurrently", async () => {
      const { listener, emit } = createMockListener();

      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(async () => {
              // Return roles
              return [{ role: "admin" }];
            }),
          })),
        })),
      } as unknown as Database;

      let call = 0;
      const transferDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(async () => {
              call++;
              if (call === 1) {
                return [{ role: "admin" }]; // previous owner demoted to admin
              } else {
                return [{ role: "owner" }]; // new owner promoted to owner
              }
            }),
          })),
        })),
      } as unknown as Database;

      const consumer = new MembershipConsumerService({
        db: transferDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
      });
      consumer.start();

      await emit({
        workspaceId,
        affectedUsers: [
          { userId, action: "role_updated" },
          { userId: userId2, action: "role_updated" },
        ],
      });

      expect(events).toHaveLength(2);
      expect(events).toContainEqual({
        type: "role_updated",
        workspaceId,
        userId,
        role: "admin",
      });
      expect(events).toContainEqual({
        type: "role_updated",
        workspaceId,
        userId: userId2,
        role: "owner",
      });
    });

    it("isolates database failure for User 1 without preventing User 2 dispatch in the same payload", async () => {
      const { listener, emit } = createMockListener();

      let call = 0;
      const partialFailDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(async () => {
              call++;
              if (call === 1) {
                throw new Error("Disk read error for User 1");
              } else {
                return [{ role: "member" }];
              }
            }),
          })),
        })),
      } as unknown as Database;

      const consumer = new MembershipConsumerService({
        db: partialFailDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
      });
      consumer.start();

      await emit({
        workspaceId,
        affectedUsers: [
          { userId, action: "removed" },
          { userId: userId2, action: "added" },
        ],
      });

      // User 1 failed DB lookup, so dispatch is skipped and logged
      expect(mockLogger.error).toHaveBeenCalled();
      // User 2 succeeded and dispatched
      expect(events).toEqual([
        {
          type: "added",
          workspaceId,
          userId: userId2,
          role: "member",
        },
      ]);
    });

    it("isolates synchronous and asynchronous errors in consumer callbacks", async () => {
      const { listener, emit } = createMockListener();
      const mockDb = createMockDb(async () => [{ role: "member" }]);

      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      let healthyCallbackFired = false;

      // 1. Throwing callback (synchronous)
      consumer.onEvent(() => {
        throw new Error("Sync callback failure");
      });

      // 2. Rejecting callback (asynchronous)
      consumer.onEvent(async () => {
        throw new Error("Async callback failure");
      });

      // 3. Healthy callback
      consumer.onEvent(() => {
        healthyCallbackFired = true;
      });

      consumer.start();

      await emit({
        workspaceId,
        affectedUsers: [{ userId, action: "added" }],
      });

      expect(healthyCallbackFired).toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining("Sync error in membership reconciliation callback")
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining("Async error in membership reconciliation callback")
      );
    });
  });

  describe("Lifecycle & Cleanliness", () => {
    it("unsubscribes from listener and drains active chains on stop", async () => {
      const { listener, emit, unsubscribe } = createMockListener();

      const lookupStarted = createDeferred<void>();
      const lookupBarrier = createDeferred<void>();

      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(async () => {
              lookupStarted.resolve();
              await lookupBarrier.promise;
              return [{ role: "member" }];
            }),
          })),
        })),
      } as unknown as Database;

      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      const events: ReconciledMembershipEvent[] = [];
      consumer.onEvent((ev) => {
        events.push(ev);
      });

      consumer.start();
      expect(listener.onMembershipChange).toHaveBeenCalledTimes(1);

      // 1. Emit a notification to initiate an active user reconciliation chain
      const emitPromise = emit({
        workspaceId,
        affectedUsers: [{ userId, action: "added" }],
      });

      // 2. Wait until the database lookup has actually started and is blocked at lookupBarrier
      await lookupStarted.promise;

      // 3. Initiate stop() while the chain is active and blocked
      let stopResolved = false;
      const stopPromise = consumer.stop().then(() => {
        stopResolved = true;
      });

      // 4. Verify that listener unsubscription happened immediately
      expect(unsubscribe).toHaveBeenCalledTimes(1);

      // 5. Verify that the stop promise has NOT resolved because the chain is still active
      await Promise.resolve();
      expect(stopResolved).toBe(false);

      // 6. Release the blocked database lookup
      lookupBarrier.resolve();

      // 7. Await stop and emit promises; verify stop completes and chain has drained
      await stopPromise;
      await emitPromise;
      expect(stopResolved).toBe(true);
      expect(events).toEqual([
        {
          type: "added",
          workspaceId,
          userId,
          role: "member",
        },
      ]);

      // 8. Confirm repeated stop remains idempotent
      await expect(consumer.stop()).resolves.toBeUndefined();
    });

    it("unsubscribe function returned by onEvent removes the callback cleanly", async () => {
      const { listener, emit } = createMockListener();
      const mockDb = createMockDb(async () => [{ role: "member" }]);

      const consumer = new MembershipConsumerService({
        db: mockDb,
        listener,
        logger: mockLogger,
      });

      let count = 0;
      const unsubscribe = consumer.onEvent(() => {
        count++;
      });
      consumer.start();

      await emit({
        workspaceId,
        affectedUsers: [{ userId, action: "added" }],
      });
      expect(count).toBe(1);

      unsubscribe();

      await emit({
        workspaceId,
        affectedUsers: [{ userId, action: "added" }],
      });
      expect(count).toBe(1); // not incremented
    });
  });
});
