import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../src/db/index.js";
import {
  cleanTables,
  testDb,
  validateTestDatabaseUrl,
} from "./setup.js";
import { PostgresListenerService } from "../../src/services/listener.js";
import {
  MembershipConsumerService,
  type ReconciledMembershipEvent,
} from "../../src/services/membership-consumer.js";
import { emitMembershipNotification } from "../../src/services/membership-events.js";
import { MembershipService } from "../../src/services/membership.js";
import { WorkspaceService } from "../../src/services/workspace.js";
import { users, workspaceMembers, workspaces } from "../../src/db/schema/index.js";

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

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("MembershipConsumerService (Integration - M8.2.2)", () => {
  let testUrl: string;
  let activeClients: postgres.Sql[] = [];
  let activeListeners: PostgresListenerService[] = [];
  let activeConsumers: MembershipConsumerService[] = [];

  beforeEach(async () => {
    testUrl = validateTestDatabaseUrl();
    await cleanTables();
  });

  afterEach(async () => {
    for (const consumer of activeConsumers) {
      await consumer.stop().catch(() => {});
    }
    activeConsumers = [];

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

  function createTestConsumer(
    listener: PostgresListenerService,
    db: Database = testDb,
    logger?: typeof silentLogger
  ): MembershipConsumerService {
    const consumer = new MembershipConsumerService({
      db,
      listener,
      logger: logger ?? silentLogger,
    });
    activeConsumers.push(consumer);
    return consumer;
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

  it("E2E Member Removal: reconciles member deletion and dispatches revoked event", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const consumer = createTestConsumer(listener);
    const eventBarrier = createBarrier<ReconciledMembershipEvent>();

    consumer.onEvent((ev) => {
      if (ev.type === "revoked") {
        eventBarrier.resolve(ev);
      }
    });
    consumer.start();

    const owner = await createTestUser({ email: "owner@example.com", displayName: "Owner" });
    const member = await createTestUser({ email: "member@example.com", displayName: "Member" });
    const workspace = await createTestWorkspace(owner.id);

    // Add member to workspace
    await MembershipService.addMember(testDb, {
      workspaceId: workspace.id,
      callerId: owner.id,
      email: member.email,
      role: "member",
    });

    // Remove member
    await MembershipService.removeMember(testDb, {
      workspaceId: workspace.id,
      callerId: owner.id,
      targetUserId: member.id,
    });

    // Consumer receives notification, queries DB, confirms absence, and dispatches revoked
    const event = await eventBarrier.promise;
    expect(event).toEqual({
      type: "revoked",
      workspaceId: workspace.id,
      userId: member.id,
    });

    // Verify DB state directly
    const [row] = await testDb
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, member.id)
        )
      );
    expect(row).toBeUndefined();
  });

  it("E2E Delayed Removal Simulation: suppresses revocation when member remains active in DB", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const suppressionLoggedBarrier = createBarrier<void>();
    const testLogger = {
      info: (obj: unknown, msg?: string) => {
        const text = msg ?? (typeof obj === "string" ? obj : "");
        if (
          text.includes("Suppressed stale membership removal notification for active member")
        ) {
          suppressionLoggedBarrier.resolve();
        }
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    const consumer = createTestConsumer(listener, testDb, testLogger);
    const events: ReconciledMembershipEvent[] = [];

    consumer.onEvent((ev) => {
      events.push(ev);
    });
    consumer.start();

    const owner = await createTestUser({ email: "owner@example.com", displayName: "Owner" });
    const activeMember = await createTestUser({ email: "active@example.com", displayName: "Active Member" });
    const workspace = await createTestWorkspace(owner.id);

    // Add activeMember to workspace
    await MembershipService.addMember(testDb, {
      workspaceId: workspace.id,
      callerId: owner.id,
      email: activeMember.email,
      role: "member",
    });

    // Simulate arrival of a delayed 'removed' notification for activeMember (who is currently in DB)
    await testDb.transaction(async (tx) => {
      await emitMembershipNotification(tx, {
        workspaceId: workspace.id,
        affectedUsers: [{ userId: activeMember.id, action: "removed" }],
      });
    });

    // Deterministically await the suppression log message emitted by reconcileUser
    await suppressionLoggedBarrier.promise;

    // activeMember must NEVER have received a revoked event because DB holds active membership
    const revokedEvents = events.filter(
      (ev) => ev.type === "revoked" && ev.userId === activeMember.id
    );
    expect(revokedEvents).toHaveLength(0);

    // Confirm activeMember is still in database
    const [memberRow] = await testDb
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, activeMember.id)
        )
      );
    expect(memberRow).toBeDefined();
    expect(memberRow?.role).toBe("member");
  });

  it("E2E Role Update: reconciles role change and dispatches updated role", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const consumer = createTestConsumer(listener);
    const eventBarrier = createBarrier<ReconciledMembershipEvent>();

    consumer.onEvent((ev) => {
      if (ev.type === "role_updated") {
        eventBarrier.resolve(ev);
      }
    });
    consumer.start();

    const owner = await createTestUser({ email: "owner@example.com", displayName: "Owner" });
    const member = await createTestUser({ email: "member@example.com", displayName: "Member" });
    const workspace = await createTestWorkspace(owner.id);

    await MembershipService.addMember(testDb, {
      workspaceId: workspace.id,
      callerId: owner.id,
      email: member.email,
      role: "member",
    });

    // Update role to admin
    await MembershipService.updateMemberRole(testDb, {
      workspaceId: workspace.id,
      callerId: owner.id,
      targetUserId: member.id,
      newRole: "admin",
    });

    const event = await eventBarrier.promise;
    expect(event).toEqual({
      type: "role_updated",
      workspaceId: workspace.id,
      userId: member.id,
      role: "admin",
    });

    // Confirm DB
    const [row] = await testDb
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, member.id)
        )
      );
    expect(row?.role).toBe("admin");
  });

  it("E2E Ownership Transfer: reconciles batch notification and dispatches both updated roles", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const consumer = createTestConsumer(listener);
    consumer.start();

    const owner = await createTestUser({ email: "owner@example.com", displayName: "Owner" });
    const admin = await createTestUser({ email: "admin@example.com", displayName: "Admin" });
    const workspace = await createTestWorkspace(owner.id);

    // Add admin and deterministically await its 'added' notification before starting transfer
    const addBarrier = createBarrier<void>();
    const unsubAdd = consumer.onEvent((ev) => {
      if (ev.type === "added" && ev.userId === admin.id) {
        addBarrier.resolve();
      }
    });

    await MembershipService.addMember(testDb, {
      workspaceId: workspace.id,
      callerId: owner.id,
      email: admin.email,
      role: "admin",
    });

    await addBarrier.promise;
    unsubAdd();

    // Now listen strictly for transferOwnership events
    const transferEvents: ReconciledMembershipEvent[] = [];
    const transferBarrier = createBarrier<void>();

    consumer.onEvent((ev) => {
      transferEvents.push(ev);
      if (transferEvents.length === 2) {
        transferBarrier.resolve();
      }
    });

    // Transfer ownership
    await WorkspaceService.transferOwnership(testDb, {
      workspaceId: workspace.id,
      currentOwnerId: owner.id,
      newOwnerId: admin.id,
    });

    await transferBarrier.promise;

    expect(transferEvents).toHaveLength(2);
    expect(transferEvents).toContainEqual({
      type: "role_updated",
      workspaceId: workspace.id,
      userId: owner.id,
      role: "admin", // previous owner demoted to admin
    });
    expect(transferEvents).toContainEqual({
      type: "role_updated",
      workspaceId: workspace.id,
      userId: admin.id,
      role: "owner", // new owner promoted to owner
    });
  });

  it("E2E Member Addition: reconciles member insertion and dispatches added event", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const consumer = createTestConsumer(listener);
    const eventBarrier = createBarrier<ReconciledMembershipEvent>();

    consumer.onEvent((ev) => {
      if (ev.type === "added") {
        eventBarrier.resolve(ev);
      }
    });
    consumer.start();

    const owner = await createTestUser({ email: "owner@example.com", displayName: "Owner" });
    const newMember = await createTestUser({ email: "newmember@example.com", displayName: "New Member" });
    const workspace = await createTestWorkspace(owner.id);

    await MembershipService.addMember(testDb, {
      workspaceId: workspace.id,
      callerId: owner.id,
      email: newMember.email,
      role: "member",
    });

    const event = await eventBarrier.promise;
    expect(event).toEqual({
      type: "added",
      workspaceId: workspace.id,
      userId: newMember.id,
      role: "member",
    });
  });

  it("E2E Transient Failure Resilience: skips dispatch and prevents false revocation on DB query error", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const lookupFailureLoggedBarrier = createBarrier<void>();
    let loggedErrorObj: unknown = null;

    const testLogger = {
      info: () => {},
      warn: () => {},
      error: (obj: unknown, msg?: string) => {
        const text = msg ?? (typeof obj === "string" ? obj : "");
        if (
          text.includes("Failed to verify workspace membership during reconciliation")
        ) {
          loggedErrorObj = obj;
          lookupFailureLoggedBarrier.resolve();
        }
      },
      debug: () => {},
    };

    // Create a database client mock that fails on select queries
    const failingDb = {
      select: () => {
        throw new Error("Simulated connection failure during integration test");
      },
    } as unknown as Database;

    const consumer = createTestConsumer(listener, failingDb, testLogger);
    const dispatchedEvents: ReconciledMembershipEvent[] = [];

    consumer.onEvent((ev) => {
      dispatchedEvents.push(ev);
    });
    consumer.start();

    const owner = await createTestUser({ email: "owner@example.com", displayName: "Owner" });
    const workspace = await createTestWorkspace(owner.id);

    // Emit a removed notification through real PostgreSQL
    await testDb.transaction(async (tx) => {
      await emitMembershipNotification(tx, {
        workspaceId: workspace.id,
        affectedUsers: [{ userId: owner.id, action: "removed" }],
      });
    });

    // Deterministically await confirmation that the notification was received by the listener,
    // reached the consumer, and the database lookup actually failed
    await lookupFailureLoggedBarrier.promise;

    // Drain and stop consumer
    await consumer.stop();

    // Invariant: error was logged and no false revocation was dispatched
    expect(loggedErrorObj).toBeDefined();
    expect(dispatchedEvents).toHaveLength(0);
  });
});
