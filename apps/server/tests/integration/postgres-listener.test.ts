import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  testDb,
  testSqlClient,
  validateTestDatabaseUrl,
} from "./setup.js";
import {
  PostgresListenerService,
  type ProjectEventNotification,
  type MembershipChangeNotification,
  type ReconnectInfo,
} from "../../src/services/listener.js";

function createBarrier<T>(timeoutMs = 8000): {
  promise: Promise<T>;
  resolve: (val: T) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (val: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => {
    reject(new Error(`Barrier timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    promise: promise.finally(() => clearTimeout(timer)),
    resolve,
    reject,
  };
}

describe("PostgresListenerService (Integration - Milestone 8.1)", () => {
  let testUrl: string;
  let activeClients: postgres.Sql[] = [];
  let activeListeners: PostgresListenerService[] = [];

  beforeEach(() => {
    testUrl = validateTestDatabaseUrl();
  });

  afterEach(async () => {
    // 1. Stop all active listeners
    for (const listener of activeListeners) {
      await listener.stop().catch(() => {});
    }
    activeListeners = [];

    // 2. Terminate any dedicated client connections
    for (const client of activeClients) {
      await client.end({ timeout: 2 }).catch(() => {});
    }
    activeClients = [];
  });

  function createTestListener(): {
    listener: PostgresListenerService;
    client: postgres.Sql;
  } {
    const client = postgres(testUrl, { max: 1 });
    activeClients.push(client);
    const listener = new PostgresListenerService({
      sqlClient: client,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    activeListeners.push(listener);
    return { listener, client };
  }

  // ==========================================================================
  // Section A: Project Events Channel
  // ==========================================================================

  it("receives committed notifications on project_events with exact parsed payload", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const testProjectId = crypto.randomUUID();
    const barrier = createBarrier<ProjectEventNotification>();

    listener.onProjectEvent((payload) => {
      if (payload.projectId === testProjectId) {
        barrier.resolve(payload);
      }
    });

    // Emit notification inside a committed database transaction
    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_notify('project_events', ${JSON.stringify({
          projectId: testProjectId,
          seq: 42,
        })})`
      );
    });

    const received = await barrier.promise;
    expect(received).toEqual({
      projectId: testProjectId,
      seq: 42,
    });
  });

  it("discards notifications from aborted transactions without delivering before sentinel", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const rolledBackProjectId = crypto.randomUUID();
    const sentinelProjectId = crypto.randomUUID();

    const receivedEvents: ProjectEventNotification[] = [];
    const sentinelBarrier = createBarrier<ProjectEventNotification>();

    listener.onProjectEvent((event) => {
      receivedEvents.push(event);
      if (event.projectId === sentinelProjectId) {
        sentinelBarrier.resolve(event);
      }
    });

    // 1. Transaction that notifies but rolls back
    try {
      await testDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_notify('project_events', ${JSON.stringify({
            projectId: rolledBackProjectId,
            seq: 999,
          })})`
        );
        throw new Error("Deliberate transaction failure");
      });
    } catch (err: any) {
      expect(err.message).toBe("Deliberate transaction failure");
    }

    // 2. Commit sentinel notification on the exact same channel
    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_notify('project_events', ${JSON.stringify({
          projectId: sentinelProjectId,
          seq: 1000,
        })})`
      );
    });

    // 3. Await sentinel arrival
    const sentinel = await sentinelBarrier.promise;
    expect(sentinel.projectId).toBe(sentinelProjectId);
    expect(sentinel.seq).toBe(1000);

    // 4. Assert rolled-back notification was NEVER received before or with sentinel
    const rolledBackReceived = receivedEvents.find(
      (e) => e.projectId === rolledBackProjectId
    );
    expect(rolledBackReceived).toBeUndefined();
    expect(receivedEvents).toHaveLength(1);
  });

  it("delivers the same broadcast notification to two independent listener services", async () => {
    const { listener: listenerA } = createTestListener();
    const { listener: listenerB } = createTestListener();

    await Promise.all([listenerA.start(), listenerB.start()]);

    const testProjectId = crypto.randomUUID();
    const barrierA = createBarrier<ProjectEventNotification>();
    const barrierB = createBarrier<ProjectEventNotification>();

    listenerA.onProjectEvent((payload) => {
      if (payload.projectId === testProjectId) barrierA.resolve(payload);
    });
    listenerB.onProjectEvent((payload) => {
      if (payload.projectId === testProjectId) barrierB.resolve(payload);
    });

    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_notify('project_events', ${JSON.stringify({
          projectId: testProjectId,
          seq: 77,
        })})`
      );
    });

    const [resA, resB] = await Promise.all([barrierA.promise, barrierB.promise]);
    expect(resA).toEqual({ projectId: testProjectId, seq: 77 });
    expect(resB).toEqual({ projectId: testProjectId, seq: 77 });
  });

  // ==========================================================================
  // Section B: Membership Changes Channel & Contract Verification
  // ==========================================================================

  it("receives membership_changes with one affected user and 'removed' action", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const testWorkspaceId = crypto.randomUUID();
    const testUserId = crypto.randomUUID();
    const barrier = createBarrier<MembershipChangeNotification>();

    listener.onMembershipChange((payload) => {
      if (payload.workspaceId === testWorkspaceId) {
        barrier.resolve(payload);
      }
    });

    const payloadData = {
      workspaceId: testWorkspaceId,
      affectedUsers: [{ userId: testUserId, action: "removed" as const }],
    };

    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_notify('membership_changes', ${JSON.stringify(payloadData)})`
      );
    });

    const received = await barrier.promise;
    expect(received.workspaceId).toBe(testWorkspaceId);
    expect(received.affectedUsers).toEqual([
      { userId: testUserId, action: "removed" },
    ]);
  });

  it("receives membership_changes with multiple affected users across all 3 actions in one payload", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const testWorkspaceId = crypto.randomUUID();
    const user1 = crypto.randomUUID();
    const user2 = crypto.randomUUID();
    const user3 = crypto.randomUUID();
    const barrier = createBarrier<MembershipChangeNotification>();

    listener.onMembershipChange((payload) => {
      if (payload.workspaceId === testWorkspaceId) {
        barrier.resolve(payload);
      }
    });

    const payloadData = {
      workspaceId: testWorkspaceId,
      affectedUsers: [
        { userId: user1, action: "removed" as const },
        { userId: user2, action: "role_updated" as const },
        { userId: user3, action: "added" as const },
      ],
    };

    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_notify('membership_changes', ${JSON.stringify(payloadData)})`
      );
    });

    const received = await barrier.promise;
    expect(received.workspaceId).toBe(testWorkspaceId);
    expect(received.affectedUsers).toHaveLength(3);
    expect(received.affectedUsers).toEqual([
      { userId: user1, action: "removed" },
      { userId: user2, action: "role_updated" },
      { userId: user3, action: "added" },
    ]);
  });

  it("supports each of the three actions individually ('removed', 'role_updated', 'added')", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const actions = ["removed", "role_updated", "added"] as const;

    for (const action of actions) {
      const testWorkspaceId = crypto.randomUUID();
      const testUserId = crypto.randomUUID();
      const barrier = createBarrier<MembershipChangeNotification>();

      const unsubscribe = listener.onMembershipChange((payload) => {
        if (payload.workspaceId === testWorkspaceId) {
          barrier.resolve(payload);
        }
      });

      await testDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_notify('membership_changes', ${JSON.stringify({
            workspaceId: testWorkspaceId,
            affectedUsers: [{ userId: testUserId, action }],
          })})`
        );
      });

      const received = await barrier.promise;
      expect(received.workspaceId).toBe(testWorkspaceId);
      expect(received.affectedUsers[0]!.action).toBe(action);
      unsubscribe();
    }
  });

  it("safely rejects invalid membership payloads without delivering to consumer callbacks", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const receivedPayloads: MembershipChangeNotification[] = [];
    const sentinelWorkspaceId = crypto.randomUUID();
    const sentinelUserId = crypto.randomUUID();
    const sentinelBarrier = createBarrier<MembershipChangeNotification>();

    listener.onMembershipChange((payload) => {
      receivedPayloads.push(payload);
      if (payload.workspaceId === sentinelWorkspaceId) {
        sentinelBarrier.resolve(payload);
      }
    });

    const validUserId = crypto.randomUUID();
    const validWorkspaceId = crypto.randomUUID();

    // 1. Invalid UUID for workspaceId
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: "not-a-valid-uuid",
        affectedUsers: [{ userId: validUserId, action: "removed" }],
      })}')`
    );

    // 2. Invalid UUID for userId
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: validWorkspaceId,
        affectedUsers: [{ userId: "not-a-valid-uuid", action: "removed" }],
      })}')`
    );

    // 3. Invalid action string ("deleted", "promoted", numeric)
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: validWorkspaceId,
        affectedUsers: [{ userId: validUserId, action: "deleted" }],
      })}')`
    );
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: validWorkspaceId,
        affectedUsers: [{ userId: validUserId, action: "promoted" }],
      })}')`
    );

    // 4. Missing affectedUsers
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: validWorkspaceId,
      })}')`
    );

    // 5. Malformed affectedUsers (null, empty array, non-array, empty object)
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: validWorkspaceId,
        affectedUsers: null,
      })}')`
    );
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: validWorkspaceId,
        affectedUsers: [],
      })}')`
    );
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: validWorkspaceId,
        affectedUsers: "not-an-array",
      })}')`
    );
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: validWorkspaceId,
        affectedUsers: [{}],
      })}')`
    );

    // 6. Forbidden extra properties rejected by .strict() (emails, roles, timestamps)
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: validWorkspaceId,
        affectedUsers: [{ userId: validUserId, action: "removed", email: "user@example.com" }],
      })}')`
    );
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: validWorkspaceId,
        affectedUsers: [{ userId: validUserId, action: "removed" }],
        timestamp: Date.now(),
      })}')`
    );

    // 7. Malformed unparseable JSON string on membership_changes
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '{"workspaceId": unclosed_json_string')`
    );

    // 8. Emit valid sentinel notification
    await testSqlClient.unsafe(
      `SELECT pg_notify('membership_changes', '${JSON.stringify({
        workspaceId: sentinelWorkspaceId,
        affectedUsers: [{ userId: sentinelUserId, action: "added" }],
      })}')`
    );

    // Await sentinel arrival
    const sentinel = await sentinelBarrier.promise;
    expect(sentinel.workspaceId).toBe(sentinelWorkspaceId);

    // Assert that NONE of the 10 invalid payloads reached the callback
    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0]!.workspaceId).toBe(sentinelWorkspaceId);
    expect(receivedPayloads[0]!.affectedUsers).toEqual([
      { userId: sentinelUserId, action: "added" },
    ]);
  });

  // ==========================================================================
  // Section C: Reconnect & Subscription Recovery
  // ==========================================================================

  it("does not trigger reconnect callback during initial subscription startup", async () => {
    const { listener } = createTestListener();

    let reconnectFired = false;
    listener.onReconnect(() => {
      reconnectFired = true;
    });

    await listener.start();
    expect(listener.status).toBe("ready");
    expect(listener.reconnectCount).toBe(0);
    expect(reconnectFired).toBe(false);
  });

  it("reconnects automatically after PostgreSQL terminates the listener backend", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const initialPid = listener.getInitialBackendPid();
    expect(initialPid).toBeTypeOf("number");
    expect(initialPid!).toBeGreaterThan(0);

    const reconnectBarrier = createBarrier<ReconnectInfo>();
    listener.onReconnect((info) => {
      reconnectBarrier.resolve(info);
    });

    // Terminate only the dedicated listener backend
    await testSqlClient.unsafe(`SELECT pg_terminate_backend(${initialPid})`);

    const info = await reconnectBarrier.promise;
    expect(info.reconnectCount).toBe(1);
    expect(listener.reconnectCount).toBe(1);
    expect(listener.status).toBe("ready");
  });

  it("restores subscriptions on both channels and receives notifications after reconnect", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const initialPid = listener.getInitialBackendPid();
    const reconnectBarrier = createBarrier<ReconnectInfo>();
    listener.onReconnect((info) => {
      reconnectBarrier.resolve(info);
    });

    // Terminate backend to force reconnect
    await testSqlClient.unsafe(`SELECT pg_terminate_backend(${initialPid})`);
    await reconnectBarrier.promise;

    // Verify both channels work after reconnect
    const testProjectId = crypto.randomUUID();
    const testWorkspaceId = crypto.randomUUID();

    const peBarrier = createBarrier<ProjectEventNotification>();
    const mcBarrier = createBarrier<MembershipChangeNotification>();

    listener.onProjectEvent((e) => {
      if (e.projectId === testProjectId) peBarrier.resolve(e);
    });
    listener.onMembershipChange((e) => {
      if (e.workspaceId === testWorkspaceId) mcBarrier.resolve(e);
    });

    // Emit on project_events
    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_notify('project_events', ${JSON.stringify({
          projectId: testProjectId,
          seq: 101,
        })})`
      );
    });

    // Emit on membership_changes
    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_notify('membership_changes', ${JSON.stringify({
          workspaceId: testWorkspaceId,
          affectedUsers: [{ userId: crypto.randomUUID(), action: "role_updated" }],
        })})`
      );
    });

    const [pe, mc] = await Promise.all([peBarrier.promise, mcBarrier.promise]);
    expect(pe.seq).toBe(101);
    expect(mc.workspaceId).toBe(testWorkspaceId);
    expect(mc.affectedUsers[0]!.action).toBe("role_updated");
  });

  it("produces exactly one reconnect callback per disconnect epoch across multiple consumers", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const initialPid = listener.getInitialBackendPid();
    let callbackCountA = 0;
    let callbackCountB = 0;
    const barrierA = createBarrier<number>();
    const barrierB = createBarrier<number>();

    listener.onReconnect(() => {
      callbackCountA++;
      barrierA.resolve(callbackCountA);
    });
    listener.onReconnect(() => {
      callbackCountB++;
      barrierB.resolve(callbackCountB);
    });

    // Terminate backend
    await testSqlClient.unsafe(`SELECT pg_terminate_backend(${initialPid})`);

    await Promise.all([barrierA.promise, barrierB.promise]);
    expect(callbackCountA).toBe(1);
    expect(callbackCountB).toBe(1);
    expect(listener.reconnectCount).toBe(1);
  });

  it("recovers successfully across repeated backend terminations", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const firstPid = listener.getInitialBackendPid();
    const firstReconnect = createBarrier<ReconnectInfo>();
    const secondReconnect = createBarrier<ReconnectInfo>();

    listener.onReconnect((info) => {
      if (info.reconnectCount === 1) firstReconnect.resolve(info);
      if (info.reconnectCount === 2) secondReconnect.resolve(info);
    });

    // First termination
    await testSqlClient.unsafe(`SELECT pg_terminate_backend(${firstPid})`);
    await firstReconnect.promise;
    expect(listener.reconnectCount).toBe(1);

    // Locate the new listener connection PID in pg_stat_activity
    const [row] = await testSqlClient<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND query ILIKE 'listen %'
      LIMIT 1;
    `;
    expect(row).toBeDefined();

    // Second termination
    await testSqlClient.unsafe(`SELECT pg_terminate_backend(${row!.pid})`);
    await secondReconnect.promise;
    expect(listener.reconnectCount).toBe(2);

    // Verify delivery works after second reconnect
    const testProjectId = crypto.randomUUID();
    const peBarrier = createBarrier<ProjectEventNotification>();
    listener.onProjectEvent((e) => {
      if (e.projectId === testProjectId) peBarrier.resolve(e);
    });

    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_notify('project_events', ${JSON.stringify({
          projectId: testProjectId,
          seq: 202,
        })})`
      );
    });

    const pe = await peBarrier.promise;
    expect(pe.seq).toBe(202);
  });

  it("does not dispatch reconnect callbacks or notifications after being stopped during reconnection", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const initialPid = listener.getInitialBackendPid();
    let callbackFiredAfterStop = false;

    listener.onReconnect(() => {
      if (listener.status === "stopped") {
        callbackFiredAfterStop = true;
      }
    });

    listener.onProjectEvent(() => {
      if (listener.status === "stopped") {
        callbackFiredAfterStop = true;
      }
    });

    // Terminate backend and immediately stop the listener service
    await testSqlClient.unsafe(`SELECT pg_terminate_backend(${initialPid})`);
    await listener.stop();
    expect(listener.status).toBe("stopped");

    // Use a separate active sentinel listener to confirm that PostgreSQL notifications are still delivering
    const { listener: sentinelListener } = createTestListener();
    await sentinelListener.start();

    const sentinelProjectId = crypto.randomUUID();
    const sentinelBarrier = createBarrier<ProjectEventNotification>();

    sentinelListener.onProjectEvent((e) => {
      if (e.projectId === sentinelProjectId) {
        sentinelBarrier.resolve(e);
      }
    });

    // Commit a notification and await its confirmed arrival on the sentinel listener
    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_notify('project_events', ${JSON.stringify({
          projectId: sentinelProjectId,
          seq: 9999,
        })})`
      );
    });

    await sentinelBarrier.promise;

    // Assert that the stopped listener did not dispatch callbacks after stopping
    expect(callbackFiredAfterStop).toBe(false);
  });

  // ==========================================================================
  // Section D: Lifecycle Race & Shutdown Handling
  // ==========================================================================

  it("stops cleanly and stops delivering notifications after unlisten", async () => {
    const { listener } = createTestListener();
    await listener.start();
    expect(listener.status).toBe("ready");

    let receivedAfterStop = 0;
    listener.onProjectEvent(() => {
      receivedAfterStop++;
    });

    await listener.stop();
    expect(listener.status).toBe("stopped");

    // Create a separate sentinel listener to prove PostgreSQL NOTIFY is active
    const { listener: sentinelListener } = createTestListener();
    await sentinelListener.start();

    const sentinelProjectId = crypto.randomUUID();
    const sentinelBarrier = createBarrier<ProjectEventNotification>();

    sentinelListener.onProjectEvent((e) => {
      if (e.projectId === sentinelProjectId) sentinelBarrier.resolve(e);
    });

    // Emit notification
    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_notify('project_events', ${JSON.stringify({
          projectId: sentinelProjectId,
          seq: 303,
        })})`
      );
    });

    await sentinelBarrier.promise;
    expect(receivedAfterStop).toBe(0);
  });

  it("handles concurrent start calls and repeated stop calls safely and idempotently", async () => {
    const { listener } = createTestListener();

    // Concurrent starts
    await Promise.all([listener.start(), listener.start(), listener.start()]);
    expect(listener.status).toBe("ready");

    // Redundant start when already ready
    await listener.start();
    expect(listener.status).toBe("ready");

    // Concurrent and repeated stops
    await Promise.all([listener.stop(), listener.stop(), listener.stop()]);
    expect(listener.status).toBe("stopped");

    // Redundant stop when already stopped
    await listener.stop();
    expect(listener.status).toBe("stopped");
  });

  it("handles stop requested while start is pending without leaking subscriptions or remaining ready", async () => {
    const { listener } = createTestListener();

    // Initiate start and immediately trigger stop before subscriptions confirm
    const startPromise = listener.start();
    const stopPromise = listener.stop();

    await Promise.all([startPromise, stopPromise]);
    expect(listener.status).toBe("stopped");

    // Verifying it can be safely restarted
    await listener.start();
    expect(listener.status).toBe("ready");
    await listener.stop();
    expect(listener.status).toBe("stopped");
  });

  it("cleans up late-resolving subscriptions when one subscription rejects (partial failure: project_events rejects)", async () => {
    let unlistenCallCount = 0;
    let resolvePendingChannel!: (handle: any) => void;
    const pendingChannelPromise = new Promise<any>((resolve) => {
      resolvePendingChannel = resolve;
    });

    const mockSqlClient = {
      listen: (channel: string) => {
        if (channel === "project_events") {
          // Immediately reject project_events
          return Promise.reject(new Error("Simulated subscription failure on project_events"));
        }
        if (channel === "membership_changes") {
          // Keep membership_changes pending
          return pendingChannelPromise;
        }
        return Promise.reject(new Error(`Unexpected channel: ${channel}`));
      },
    } as unknown as postgres.Sql;

    const listener = new PostgresListenerService({
      sqlClient: mockSqlClient,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    // 1. Start listener
    const startPromise = listener.start();

    // 2. While Channel 2 is still pending, listener must remain in "starting" state
    expect(listener.status).toBe("starting");

    // 3. Now let Channel 2 resolve successfully with a mock handle
    const mockHandle = {
      unlisten: async () => {
        unlistenCallCount++;
      },
      state: { pid: 99999 },
    };
    resolvePendingChannel(mockHandle);

    // 4. Await startPromise rejection
    await expect(startPromise).rejects.toThrow("Simulated subscription failure on project_events");

    // 5. Assert cleanup: unlisten was invoked exactly once on the late-resolving subscription
    expect(unlistenCallCount).toBe(1);

    // 6. Assert listener finished in consistent "stopped" state
    expect(listener.status).toBe("stopped");
    expect(listener.getInitialBackendPid()).toBeNull();
  });

  it("cleans up late-resolving subscriptions when one subscription rejects (partial failure: membership_changes rejects)", async () => {
    let unlistenCallCount = 0;
    let resolvePendingChannel!: (handle: any) => void;
    const pendingChannelPromise = new Promise<any>((resolve) => {
      resolvePendingChannel = resolve;
    });

    const mockSqlClient = {
      listen: (channel: string) => {
        if (channel === "membership_changes") {
          return Promise.reject(new Error("Simulated subscription failure on membership_changes"));
        }
        if (channel === "project_events") {
          return pendingChannelPromise;
        }
        return Promise.reject(new Error(`Unexpected channel: ${channel}`));
      },
    } as unknown as postgres.Sql;

    const listener = new PostgresListenerService({
      sqlClient: mockSqlClient,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    const startPromise = listener.start();
    expect(listener.status).toBe("starting");

    const mockHandle = {
      unlisten: async () => {
        unlistenCallCount++;
      },
      state: { pid: 88888 },
    };
    resolvePendingChannel(mockHandle);

    await expect(startPromise).rejects.toThrow("Simulated subscription failure on membership_changes");
    expect(unlistenCallCount).toBe(1);
    expect(listener.status).toBe("stopped");
    expect(listener.getInitialBackendPid()).toBeNull();
  });

  // ==========================================================================
  // Section E: Fault Isolation & Consumer Robustness
  // ==========================================================================

  it("isolates sync and async callback errors and supports dynamic unsubscription", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const validPayload1 = { projectId: crypto.randomUUID(), seq: 1 };
    const validSentinel = { projectId: crypto.randomUUID(), seq: 2 };

    const validReceived: ProjectEventNotification[] = [];
    const barrier1 = createBarrier<ProjectEventNotification>();
    const barrierSentinel = createBarrier<ProjectEventNotification>();

    // Callback 1: throws synchronously
    listener.onProjectEvent(() => {
      throw new Error("Deliberate synchronous callback error");
    });

    // Callback 2: rejects asynchronously
    listener.onProjectEvent(() => {
      return Promise.reject(new Error("Deliberate asynchronous callback rejection"));
    });

    // Callback 3: healthy consumer
    const unsubscribeHealthy = listener.onProjectEvent((payload) => {
      validReceived.push(payload);
      if (payload.projectId === validPayload1.projectId) barrier1.resolve(payload);
      if (payload.projectId === validSentinel.projectId) barrierSentinel.resolve(payload);
    });

    // 1. Emit valid payload 1
    await testSqlClient.unsafe(
      `SELECT pg_notify('project_events', '${JSON.stringify(validPayload1)}')`
    );
    await barrier1.promise;

    // 2. Emit valid sentinel payload 2
    await testSqlClient.unsafe(
      `SELECT pg_notify('project_events', '${JSON.stringify(validSentinel)}')`
    );
    await barrierSentinel.promise;

    // Verify healthy callback received both valid payloads despite other callbacks failing
    expect(validReceived).toHaveLength(2);
    expect(validReceived[0]!.projectId).toBe(validPayload1.projectId);
    expect(validReceived[1]!.projectId).toBe(validSentinel.projectId);

    // Verify unsubscribe works cleanly
    unsubscribeHealthy();
    const postUnsubProjectId = crypto.randomUUID();
    const postSentinelBarrier = createBarrier<ProjectEventNotification>();

    const { listener: verifySentinelListener } = createTestListener();
    await verifySentinelListener.start();
    verifySentinelListener.onProjectEvent((e) => {
      if (e.projectId === postUnsubProjectId) postSentinelBarrier.resolve(e);
    });

    await testSqlClient.unsafe(
      `SELECT pg_notify('project_events', '${JSON.stringify({ projectId: postUnsubProjectId, seq: 3 })}')`
    );
    await postSentinelBarrier.promise;

    // Healthy callback was unsubscribed, so its array should not have grown
    expect(validReceived).toHaveLength(2);
  });
});
