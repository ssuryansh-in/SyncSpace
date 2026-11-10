import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import {
  cleanTables,
  testDb,
  testSqlClient,
  validateTestDatabaseUrl,
} from "./setup.js";
import {
  PostgresListenerService,
  type MembershipChangeNotification,
} from "../../src/services/listener.js";
import {
  emitMembershipNotification,
} from "../../src/services/membership-events.js";
import { MembershipService } from "../../src/services/membership.js";
import { WorkspaceService } from "../../src/services/workspace.js";
import { users, workspaces, workspaceMembers } from "../../src/db/schema/index.js";
import { AppError } from "../../src/errors/index.js";

function createBarrier<T>(timeoutMs = 10000): {
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

/**
 * Helper to observe in PostgreSQL whether an application request is actively
 * blocked on a row lock held by a specific barrier backend connection.
 */
async function waitForBlockedByBarrier(
  monitorSql: postgres.Sql,
  barrierPid: number,
  expectedTable: string,
  timeoutMs = 10000
): Promise<{ pid: number; query: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await monitorSql`
      SELECT a.pid, a.query, a.wait_event_type, a.wait_event
      FROM pg_stat_activity a
      WHERE ${barrierPid} = ANY(pg_blocking_pids(a.pid))
        AND a.wait_event_type = 'Lock'
        AND a.datname = current_database()
    `;
    if (rows.length > 0) {
      const candidate = rows.find(
        (r: any) => r.query && r.query.includes(expectedTable)
      );
      if (candidate) {
        return { pid: candidate.pid, query: candidate.query };
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for process blocked by barrier PID ${barrierPid} on table ${expectedTable}`
  );
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("Transactional Membership Notification Producers (Integration - M8.2.1)", () => {
  let testUrl: string;
  let activeClients: postgres.Sql[] = [];
  let activeListeners: PostgresListenerService[] = [];

  beforeEach(async () => {
    testUrl = validateTestDatabaseUrl();
    await cleanTables();
  });

  afterEach(async () => {
    for (const listener of activeListeners) {
      await listener.stop().catch(() => {});
    }
    activeListeners = [];

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
      logger: silentLogger,
    });
    activeListeners.push(listener);
    return { listener, client };
  }

  async function createTestUser(params: {
    email: string;
    displayName: string;
    emailVerified?: boolean;
  }) {
    const [user] = await testDb
      .insert(users)
      .values({
        email: params.email,
        displayName: params.displayName,
        emailVerified: params.emailVerified ?? true,
      })
      .returning();
    return user!;
  }

  async function createTestWorkspace(ownerId: string, name = "Test Workspace") {
    const result = await WorkspaceService.createWorkspace(testDb, { name, ownerId });
    return result.workspace;
  }

  // ==========================================================================
  // 1. Transactional Rollback Isolation (Sentinel Pattern)
  // ==========================================================================

  it("discards notifications from rolled-back transactions without delivery", async () => {
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

    const rolledBackWorkspaceId = crypto.randomUUID();
    const rolledBackUserId = crypto.randomUUID();

    // 1. Execute notification in a transaction forced to roll back
    await expect(
      testDb.transaction(async (tx) => {
        await emitMembershipNotification(tx, {
          workspaceId: rolledBackWorkspaceId,
          affectedUsers: [
            {
              userId: rolledBackUserId,
              action: "removed",
            },
          ],
        });
        throw new Error("Deliberate transaction abort");
      })
    ).rejects.toThrow("Deliberate transaction abort");

    // 2. Commit a separate sentinel notification on the same channel
    await testDb.transaction(async (tx) => {
      await emitMembershipNotification(tx, {
        workspaceId: sentinelWorkspaceId,
        affectedUsers: [
          {
            userId: sentinelUserId,
            action: "added",
          },
        ],
      });
    });

    // 3. Await receipt of the sentinel
    const sentinel = await sentinelBarrier.promise;
    expect(sentinel.workspaceId).toBe(sentinelWorkspaceId);

    // 4. Verify that the rolled-back notification was NEVER delivered
    expect(
      receivedPayloads.some((p) => p.workspaceId === rolledBackWorkspaceId)
    ).toBe(false);
    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0].workspaceId).toBe(sentinelWorkspaceId);
  });

  it("verifies a 7,999-byte serialized UTF-8 payload executes and commits successfully against real PostgreSQL", async () => {
    const ws = "00000000-0000-0000-0000-000000000000";
    // Construct exact 7,999 byte payload: 4 added, 111 removed = 115 users (< 500)
    const users: { userId: string; action: "added" | "removed" | "role_updated" }[] = [];
    let idCounter = 1;
    const makeUuid = (id: number) =>
      `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`;

    for (let i = 0; i < 4; i++) {
      users.push({ userId: makeUuid(idCounter++), action: "added" });
    }
    for (let i = 0; i < 111; i++) {
      users.push({ userId: makeUuid(idCounter++), action: "removed" });
    }

    const payload: MembershipChangeNotification = {
      workspaceId: ws,
      affectedUsers: users,
    };
    const serialized = JSON.stringify(payload);
    const byteLength = Buffer.byteLength(serialized, "utf8");

    // Exact byte length assertion
    expect(byteLength).toBe(7999);
    expect(payload.affectedUsers.length).toBeLessThanOrEqual(500);

    const { listener } = createTestListener();
    await listener.start();

    const barrier = createBarrier<MembershipChangeNotification>();
    listener.onMembershipChange((received) => {
      if (received.workspaceId === ws) {
        barrier.resolve(received);
      }
    });

    // Execute in real PostgreSQL transaction and verify successful commit
    await testDb.transaction(async (tx) => {
      await emitMembershipNotification(tx, payload);
    });

    // Await delivery via listener to confirm PostgreSQL accepted, committed, and delivered it
    const received = await barrier.promise;
    expect(received.workspaceId).toBe(ws);
    expect(received.affectedUsers).toHaveLength(115);
  });

  // ==========================================================================
  // 2. Public Mutation Notification Emissions
  // ==========================================================================

  describe("Public Mutation Notification Emissions", () => {
    it("emits 'added' notification on successful member addition", async () => {
      const owner = await createTestUser({ email: "owner@test.com", displayName: "Owner" });
      const target = await createTestUser({ email: "member@test.com", displayName: "Member" });
      const workspace = await createTestWorkspace(owner.id);

      const { listener } = createTestListener();
      await listener.start();

      const barrier = createBarrier<MembershipChangeNotification>();
      listener.onMembershipChange((payload) => {
        if (payload.workspaceId === workspace.id) {
          barrier.resolve(payload);
        }
      });

      const res = await MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: target.email,
        role: "member",
      });

      expect(res.status).toBe(true);

      const received = await barrier.promise;
      expect(received.workspaceId).toBe(workspace.id);
      expect(received.affectedUsers).toEqual([
        { userId: target.id, action: "added" },
      ]);
    });

    it("suppresses notifications and returns generic response for nonexistent, unverified, or duplicate accounts", async () => {
      const owner = await createTestUser({ email: "owner2@test.com", displayName: "Owner 2" });
      const unverified = await createTestUser({
        email: "unverified@test.com",
        displayName: "Unverified",
        emailVerified: false,
      });
      const existing = await createTestUser({ email: "existing@test.com", displayName: "Existing" });
      const workspace = await createTestWorkspace(owner.id);

      // Add existing member first
      await MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: existing.email,
        role: "member",
      });

      const { listener } = createTestListener();
      await listener.start();

      const receivedPayloads: MembershipChangeNotification[] = [];
      const sentinelWorkspaceId = crypto.randomUUID();
      const sentinelBarrier = createBarrier<MembershipChangeNotification>();

      listener.onMembershipChange((payload) => {
        receivedPayloads.push(payload);
        if (payload.workspaceId === sentinelWorkspaceId) {
          sentinelBarrier.resolve(payload);
        }
      });

      // 1. Non-existent email
      const res1 = await MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: "doesnotexist@test.com",
      });
      expect(res1.status).toBe(true);

      // 2. Unverified email
      const res2 = await MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: unverified.email,
      });
      expect(res2.status).toBe(true);

      // 3. Duplicate addition
      const res3 = await MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: existing.email,
      });
      expect(res3.status).toBe(true);

      // 4. Commit sentinel
      await testDb.transaction(async (tx) => {
        await emitMembershipNotification(tx, {
          workspaceId: sentinelWorkspaceId,
          affectedUsers: [{ userId: owner.id, action: "added" }],
        });
      });

      await sentinelBarrier.promise;

      // Verify ZERO notifications emitted for the 3 suppressed operations
      expect(
        receivedPayloads.some((p) => p.workspaceId === workspace.id)
      ).toBe(false);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0].workspaceId).toBe(sentinelWorkspaceId);
    });

    it("emits 'removed' notification upon genuine member removal", async () => {
      const owner = await createTestUser({ email: "owner3@test.com", displayName: "Owner 3" });
      const target = await createTestUser({ email: "target3@test.com", displayName: "Target 3" });
      const workspace = await createTestWorkspace(owner.id);

      await MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: target.email,
      });

      const { listener } = createTestListener();
      await listener.start();

      const barrier = createBarrier<MembershipChangeNotification>();
      listener.onMembershipChange((payload) => {
        if (payload.workspaceId === workspace.id) {
          barrier.resolve(payload);
        }
      });

      const res = await MembershipService.removeMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        targetUserId: target.id,
      });

      expect(res.status).toBe(true);

      const received = await barrier.promise;
      expect(received.workspaceId).toBe(workspace.id);
      expect(received.affectedUsers).toEqual([
        { userId: target.id, action: "removed" },
      ]);
    });

    it("emits 'role_updated' notification on genuine role update and suppresses no-op updates", async () => {
      const owner = await createTestUser({ email: "owner4@test.com", displayName: "Owner 4" });
      const target = await createTestUser({ email: "target4@test.com", displayName: "Target 4" });
      const workspace = await createTestWorkspace(owner.id);

      await MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: target.email,
        role: "member",
      });

      const { listener } = createTestListener();
      await listener.start();

      const receivedPayloads: MembershipChangeNotification[] = [];
      const roleUpdateBarrier = createBarrier<MembershipChangeNotification>();
      const sentinelWorkspaceId = crypto.randomUUID();
      const sentinelBarrier = createBarrier<MembershipChangeNotification>();

      listener.onMembershipChange((payload) => {
        receivedPayloads.push(payload);
        if (payload.workspaceId === workspace.id) {
          roleUpdateBarrier.resolve(payload);
        }
        if (payload.workspaceId === sentinelWorkspaceId) {
          sentinelBarrier.resolve(payload);
        }
      });

      // 1. Genuine role update (member -> admin)
      await MembershipService.updateMemberRole(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        targetUserId: target.id,
        newRole: "admin",
      });

      const received = await roleUpdateBarrier.promise;
      expect(received.affectedUsers).toEqual([
        { userId: target.id, action: "role_updated" },
      ]);

      // 2. No-op role update (admin -> admin)
      await MembershipService.updateMemberRole(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        targetUserId: target.id,
        newRole: "admin",
      });

      // Commit sentinel
      await testDb.transaction(async (tx) => {
        await emitMembershipNotification(tx, {
          workspaceId: sentinelWorkspaceId,
          affectedUsers: [{ userId: owner.id, action: "added" }],
        });
      });

      await sentinelBarrier.promise;

      // Verify only 1 notification for workspace.id was emitted (the genuine one)
      const workspacePayloads = receivedPayloads.filter(
        (p) => p.workspaceId === workspace.id
      );
      expect(workspacePayloads).toHaveLength(1);
      expect(workspacePayloads[0].affectedUsers[0].action).toBe("role_updated");
    });

    it("emits single notification containing both affected users on ownership transfer", async () => {
      const owner = await createTestUser({ email: "owner5@test.com", displayName: "Owner 5" });
      const successor = await createTestUser({ email: "successor@test.com", displayName: "Successor" });
      const workspace = await createTestWorkspace(owner.id);

      await MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: successor.email,
        role: "admin",
      });

      const { listener } = createTestListener();
      await listener.start();

      const barrier = createBarrier<MembershipChangeNotification>();
      listener.onMembershipChange((payload) => {
        if (payload.workspaceId === workspace.id) {
          barrier.resolve(payload);
        }
      });

      await WorkspaceService.transferOwnership(testDb, {
        workspaceId: workspace.id,
        currentOwnerId: owner.id,
        newOwnerId: successor.id,
      });

      const received = await barrier.promise;
      expect(received.workspaceId).toBe(workspace.id);
      expect(received.affectedUsers).toEqual([
        { userId: owner.id, action: "role_updated" },
        { userId: successor.id, action: "role_updated" },
      ]);
    });
  });

  // ==========================================================================
  // 3. Concurrency & Lock Acquisition Ordering Tests
  // ==========================================================================

  describe("Deterministic Concurrency Tests", () => {
    it("Admin Demotion vs Member Addition — Case A: Addition acquires lock first", async () => {
      const owner = await createTestUser({ email: "owner6a@test.com", displayName: "Owner 6A" });
      const admin = await createTestUser({ email: "admin6a@test.com", displayName: "Admin 6A" });
      const newMember = await createTestUser({ email: "new6a@test.com", displayName: "New 6A" });
      const workspace = await createTestWorkspace(owner.id);

      await MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: admin.email,
        role: "admin",
      });

      const { listener } = createTestListener();
      await listener.start();

      const receivedNotifications: MembershipChangeNotification[] = [];
      const bothDoneBarrier = createBarrier<void>();

      listener.onMembershipChange((payload) => {
        if (payload.workspaceId === workspace.id) {
          receivedNotifications.push(payload);
          if (receivedNotifications.length === 2) {
            bothDoneBarrier.resolve();
          }
        }
      });

      // Barriers to force deterministic ordering: Tx1 (addition) locks workspace first
      const additionHasLock = createBarrier<number>();
      const releaseAddition = createBarrier<void>();

      // Controlled addition transaction
      const additionPromise = testDb.transaction(async (tx) => {
        const [row] = (await (tx as any).execute(sql`SELECT pg_backend_pid() as pid`)) as any;
        const barrierPid = Number(row.pid);

        // 1. Lock workspace row
        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspace.id))
          .for("update");

        // Signal that Tx1 holds the lock along with its PID
        additionHasLock.resolve(barrierPid);

        // Wait until Tx2 is actively queued and blocked in PostgreSQL
        await releaseAddition.promise;

        // Perform member addition
        return await MembershipService.addMember(tx as any, {
          workspaceId: workspace.id,
          callerId: admin.id,
          email: newMember.email,
        });
      });

      // Wait until Tx1 holds the workspace lock
      const barrierPid = await additionHasLock.promise;

      // Start Tx2 (demotion of admin by owner). It will reach PostgreSQL and block on the workspace row lock
      const demotionPromise = MembershipService.updateMemberRole(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        targetUserId: admin.id,
        newRole: "member",
      });

      // Deterministically verify through PostgreSQL that Tx2 is actively blocked on barrierPid
      await waitForBlockedByBarrier(testSqlClient, barrierPid, "workspaces");

      // Now release Tx1 to complete its addition and commit
      releaseAddition.resolve();

      await Promise.all([additionPromise, demotionPromise]);
      await bothDoneBarrier.promise;

      // Both operations succeed
      expect(receivedNotifications).toHaveLength(2);
      expect(receivedNotifications[0].affectedUsers).toEqual([
        { userId: newMember.id, action: "added" },
      ]);
      expect(receivedNotifications[1].affectedUsers).toEqual([
        { userId: admin.id, action: "role_updated" },
      ]);
    });

    it("Admin Demotion vs Member Addition — Case B: Demotion acquires lock first", async () => {
      const owner = await createTestUser({ email: "owner6b@test.com", displayName: "Owner 6B" });
      const admin = await createTestUser({ email: "admin6b@test.com", displayName: "Admin 6B" });
      const newMember = await createTestUser({ email: "new6b@test.com", displayName: "New 6B" });
      const workspace = await createTestWorkspace(owner.id);

      await MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: admin.email,
        role: "admin",
      });

      const { listener } = createTestListener();
      await listener.start();

      const receivedNotifications: MembershipChangeNotification[] = [];
      const sentinelWorkspaceId = crypto.randomUUID();
      const sentinelBarrier = createBarrier<MembershipChangeNotification>();

      listener.onMembershipChange((payload) => {
        receivedNotifications.push(payload);
        if (payload.workspaceId === sentinelWorkspaceId) {
          sentinelBarrier.resolve(payload);
        }
      });

      // Barriers to force deterministic ordering: Tx1 (demotion) locks workspace first
      const demotionHasLock = createBarrier<number>();
      const releaseDemotion = createBarrier<void>();

      // Controlled demotion transaction
      const demotionPromise = testDb.transaction(async (tx) => {
        const [row] = (await (tx as any).execute(sql`SELECT pg_backend_pid() as pid`)) as any;
        const barrierPid = Number(row.pid);

        // 1. Lock workspace row
        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspace.id))
          .for("update");

        // Signal that demotion holds the lock
        demotionHasLock.resolve(barrierPid);

        // Wait until addition has queued and blocked in PostgreSQL
        await releaseDemotion.promise;

        // Apply demotion
        return await MembershipService.updateMemberRole(tx as any, {
          workspaceId: workspace.id,
          callerId: owner.id,
          targetUserId: admin.id,
          newRole: "member",
        });
      });

      // Wait until demotion holds workspace lock
      const barrierPid = await demotionHasLock.promise;

      // Start addition attempt by admin (will reach PostgreSQL and block on workspace lock)
      let additionError: unknown;
      const additionPromise = (async () => {
        try {
          await MembershipService.addMember(testDb, {
            workspaceId: workspace.id,
            callerId: admin.id,
            email: newMember.email,
          });
        } catch (err) {
          additionError = err;
        }
      })();

      // Deterministically verify through PostgreSQL that addition is actively blocked on barrierPid
      await waitForBlockedByBarrier(testSqlClient, barrierPid, "workspaces");

      // Release demotion to commit and update admin's role to member
      releaseDemotion.resolve();

      await Promise.all([demotionPromise, additionPromise]);

      // Addition must be rejected with 403 Forbidden because caller was demoted to member
      expect(additionError).toBeInstanceOf(AppError);
      expect((additionError as AppError).statusCode).toBe(403);

      // Commit sentinel to ensure all notifications are delivered
      await testDb.transaction(async (tx) => {
        await emitMembershipNotification(tx, {
          workspaceId: sentinelWorkspaceId,
          affectedUsers: [{ userId: owner.id, action: "added" }],
        });
      });

      await sentinelBarrier.promise;

      // Verify: demotion notification emitted, ZERO 'added' notifications emitted
      const workspacePayloads = receivedNotifications.filter(
        (p) => p.workspaceId === workspace.id
      );
      expect(workspacePayloads).toHaveLength(1);
      expect(workspacePayloads[0].affectedUsers).toEqual([
        { userId: admin.id, action: "role_updated" },
      ]);
    });

    it("Concurrent Add and Remove — Case 1: Add acquires lock first", async () => {
      const owner = await createTestUser({ email: "owner7a@test.com", displayName: "Owner 7A" });
      const target = await createTestUser({ email: "target7a@test.com", displayName: "Target 7A" });
      const workspace = await createTestWorkspace(owner.id);

      const { listener } = createTestListener();
      await listener.start();

      const receivedNotifications: MembershipChangeNotification[] = [];
      const bothDoneBarrier = createBarrier<void>();

      listener.onMembershipChange((payload) => {
        if (payload.workspaceId === workspace.id) {
          receivedNotifications.push(payload);
          if (receivedNotifications.length === 2) {
            bothDoneBarrier.resolve();
          }
        }
      });

      const addHasLock = createBarrier<number>();
      const releaseAdd = createBarrier<void>();

      const addPromise = testDb.transaction(async (tx) => {
        const [row] = (await (tx as any).execute(sql`SELECT pg_backend_pid() as pid`)) as any;
        const barrierPid = Number(row.pid);

        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspace.id))
          .for("update");

        addHasLock.resolve(barrierPid);
        await releaseAdd.promise;

        return await MembershipService.addMember(tx as any, {
          workspaceId: workspace.id,
          callerId: owner.id,
          email: target.email,
        });
      });

      const barrierPid = await addHasLock.promise;

      const removePromise = MembershipService.removeMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        targetUserId: target.id,
      });

      // Deterministically verify through PostgreSQL that removal is actively blocked on barrierPid
      await waitForBlockedByBarrier(testSqlClient, barrierPid, "workspaces");

      releaseAdd.resolve();

      await Promise.all([addPromise, removePromise]);
      await bothDoneBarrier.promise;

      // Notification sequence: 'added' then 'removed'
      expect(receivedNotifications).toHaveLength(2);
      expect(receivedNotifications[0].affectedUsers).toEqual([
        { userId: target.id, action: "added" },
      ]);
      expect(receivedNotifications[1].affectedUsers).toEqual([
        { userId: target.id, action: "removed" },
      ]);

      // Final membership state: target is NOT a member
      const [finalMember] = await testDb
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspace.id),
            eq(workspaceMembers.userId, target.id)
          )
        );
      expect(finalMember).toBeUndefined();
    });

    it("Concurrent Add and Remove — Case 2: Remove acquires lock first", async () => {
      const owner = await createTestUser({ email: "owner7b@test.com", displayName: "Owner 7B" });
      const target = await createTestUser({ email: "target7b@test.com", displayName: "Target 7B" });
      const workspace = await createTestWorkspace(owner.id);

      // Initially target IS a member
      await MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: target.email,
      });

      const { listener } = createTestListener();
      await listener.start();

      const receivedNotifications: MembershipChangeNotification[] = [];
      const bothDoneBarrier = createBarrier<void>();

      listener.onMembershipChange((payload) => {
        if (payload.workspaceId === workspace.id) {
          receivedNotifications.push(payload);
          if (receivedNotifications.length === 2) {
            bothDoneBarrier.resolve();
          }
        }
      });

      const removeHasLock = createBarrier<number>();
      const releaseRemove = createBarrier<void>();

      const removePromise = testDb.transaction(async (tx) => {
        const [row] = (await (tx as any).execute(sql`SELECT pg_backend_pid() as pid`)) as any;
        const barrierPid = Number(row.pid);

        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspace.id))
          .for("update");

        removeHasLock.resolve(barrierPid);
        await releaseRemove.promise;

        return await MembershipService.removeMember(tx as any, {
          workspaceId: workspace.id,
          callerId: owner.id,
          targetUserId: target.id,
        });
      });

      const barrierPid = await removeHasLock.promise;

      const addPromise = MembershipService.addMember(testDb, {
        workspaceId: workspace.id,
        callerId: owner.id,
        email: target.email,
      });

      // Deterministically verify through PostgreSQL that addition is actively blocked on barrierPid
      await waitForBlockedByBarrier(testSqlClient, barrierPid, "workspaces");

      releaseRemove.resolve();

      await Promise.all([removePromise, addPromise]);
      await bothDoneBarrier.promise;

      // Notification sequence: 'removed' then 'added'
      expect(receivedNotifications).toHaveLength(2);
      expect(receivedNotifications[0].affectedUsers).toEqual([
        { userId: target.id, action: "removed" },
      ]);
      expect(receivedNotifications[1].affectedUsers).toEqual([
        { userId: target.id, action: "added" },
      ]);

      // Final membership state: target IS a member
      const [finalMember] = await testDb
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspace.id),
            eq(workspaceMembers.userId, target.id)
          )
        );
      expect(finalMember).toBeDefined();
    });
  });
});
