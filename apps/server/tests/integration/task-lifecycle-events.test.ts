import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth/index.js";
import { createEmailService, clearSentEmailsForTest } from "../../src/services/email.js";
import { loadEnv } from "../../src/config/env.js";
import {
  users,
  workspaces,
  workspaceMembers,
  projects,
  projectColumns,
  tasks,
  projectEvents,
} from "../../src/db/schema/index.js";
import { cleanTables, testDb, testSqlClient } from "./setup.js";
import {
  taskCreatedPayloadSchema,
  columnRebalancedPayloadSchema,
} from "../../src/services/event.js";

describe("Task Lifecycle & Column Rebalancing Events (Integration - Milestone 7.2B-1)", () => {
  const testEnv = loadEnv({
    NODE_ENV: "test",
    PORT: "4000",
    DATABASE_URL:
      process.env["TEST_DATABASE_URL"] ||
      "postgres://syncspace:syncspace_dev_password@127.0.0.1:5432/syncspace_test",
    BETTER_AUTH_SECRET: "integration_test_secret_32_characters_minimum!",
    BETTER_AUTH_URL: "http://127.0.0.1:4000",
    ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:4000",
  });

  const testEmailService = createEmailService(testEnv);
  let testAuth: ReturnType<typeof createAuth>;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await cleanTables(testSqlClient);
    clearSentEmailsForTest();

    testAuth = createAuth({
      db: testDb,
      env: testEnv,
      emailService: testEmailService,
      rateLimit: { enabled: false },
    });

    app = createApp({
      config: testEnv,
      auth: testAuth,
      db: testDb,
      rateLimit: { enabled: false },
    });
  });

  /**
   * Helper to register a verified user and return their session cookie
   */
  async function createAndLoginUser(
    name: string,
    email: string,
    password = "Password123!"
  ) {
    await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({ name, email, password }),
    });

    const [dbUser] = await testDb
      .select()
      .from(users)
      .where(eq(users.email, email));

    await testDb
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, dbUser.id));

    const loginRes = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({ email, password }),
    });

    const cookie = loginRes.headers.get("set-cookie")!;
    return { user: dbUser, cookie };
  }

  /**
   * Helper to set up a workspace with an owner and a project with default columns
   */
  async function setupWorkspaceAndProject(
    ownerName = "Owner User",
    ownerEmail = "owner@example.com"
  ) {
    const owner = await createAndLoginUser(ownerName, ownerEmail);

    const wsRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Event Test Workspace" }),
    });
    const { workspace } = await wsRes.json();

    const projRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Event Test Project" }),
    });
    const { project, columns } = await projRes.json();

    return { owner, workspace, project, columns };
  }

  describe("A. Normal Task Creation (task.created)", () => {
    it("emits exactly one task.created event with canonical 13-field snapshot and creation diff", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `create-event-1-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "New Feature Task",
          columnId: colId,
        }),
      });

      expect(res.status).toBe(201);
      const { task } = await res.json();

      // Query project events table
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));

      expect(events).toHaveLength(1);
      const event = events[0]!;

      // 1. Event envelope checks
      expect(event.projectId).toBe(project.id);
      expect(event.seq).toBe(1);
      expect(event.actorId).toBe(owner.user.id);
      expect(event.eventType).toBe("task.created");
      expect(event.entityType).toBe("task");
      expect(event.entityId).toBe(task.id);

      // 2. Project sequence check
      const [dbProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProject!.lastSeq).toBe(1);

      // 3. Payload validation against official Zod schema
      expect(() => taskCreatedPayloadSchema.parse(event.payload)).not.toThrow();
      const payload = event.payload as any;

      // 4. Snapshot check (all 13 canonical fields)
      expect(payload.task).toEqual({
        id: task.id,
        projectId: project.id,
        columnId: colId,
        title: "New Feature Task",
        description: "",
        createdBy: owner.user.id,
        assigneeId: null,
        rankKey: task.rankKey,
        version: 1,
        dueDate: null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        archivedAt: null,
      });

      // 5. Creation changes check (uses { to }, omits 'from')
      expect(payload.changes).toEqual({
        title: { to: "New Feature Task" },
        columnId: { to: colId },
        rankKey: { to: task.rankKey },
      });
      expect(JSON.stringify(payload.changes)).not.toContain('"from"');
    });

    it("includes populated optional assigneeId and dueDate in snapshot and creation changes", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Add a member to the workspace
      const member = await createAndLoginUser("Member User", "member@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `create-event-opt-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Assigned Task with Due Date",
          columnId: colId,
          assigneeId: member.user.id,
          dueDate: "2026-12-31",
        }),
      });

      expect(res.status).toBe(201);
      const { task } = await res.json();

      const [event] = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));

      expect(event).toBeDefined();
      const payload = event!.payload as any;

      expect(payload.task.assigneeId).toBe(member.user.id);
      expect(payload.task.dueDate).toBe("2026-12-31");

      expect(payload.changes.assigneeId).toEqual({ to: member.user.id });
      expect(payload.changes.dueDate).toEqual({ to: "2026-12-31" });
    });

    it("strictly preserves description privacy in task.created: diff is { description: { changed: true } } without raw text", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;
      const secretDescription = "Top Secret Strategy Document - Confidential";

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `create-event-priv-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Sensitive Task",
          columnId: colId,
          description: secretDescription,
        }),
      });

      expect(res.status).toBe(201);
      const { task } = await res.json();

      const [event] = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));

      const payload = event!.payload as any;

      // The snapshot carries the description (for client board hydration)
      expect(payload.task.description).toBe(secretDescription);

      // The changes diff MUST strictly use { description: { changed: true } }
      expect(payload.changes.description).toEqual({ changed: true });

      // Verifies description text NEVER appears in changes
      const serializedChanges = JSON.stringify(payload.changes);
      expect(serializedChanges).not.toContain(secretDescription);
      expect(serializedChanges).not.toContain('"from"');
    });

    it("does NOT emit an event on idempotency replay", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;
      const idempKey = `replay-test-${crypto.randomUUID()}`;

      // First call (genuine creation)
      const res1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": idempKey,
        },
        body: JSON.stringify({
          title: "Idempotent Task",
          columnId: colId,
        }),
      });

      expect(res1.status).toBe(201);
      const { task: task1 } = await res1.json();

      // Exactly 1 event in database
      const events1 = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events1).toHaveLength(1);
      expect(events1[0]!.seq).toBe(1);

      // Second call (replay with same key and payload)
      const res2 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": idempKey,
        },
        body: JSON.stringify({
          title: "Idempotent Task",
          columnId: colId,
        }),
      });

      expect(res2.status).toBe(201);
      const { task: task2 } = await res2.json();
      expect(task2.id).toBe(task1.id);

      // Verify NO additional event was created
      const events2 = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events2).toHaveLength(1);

      // Project sequence remains at 1
      const [dbProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProject!.lastSeq).toBe(1);
    });
  });

  describe("B. Creation-Triggered Column Rebalancing (column.rebalanced)", () => {
    it("emits column.rebalanced before task.created with consecutive sequence numbers when threshold (32) is exceeded", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Seed tasks:
      // - t1: active task with rankKey "a0"
      // - t2: active task with 32-char rankKey "z".repeat(32). Appending after it generates 33 chars (> 32)
      // - tArch: archived task with rankKey "m999" (must be excluded from rebalance)
      const [t1] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "Active Task 1",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        })
        .returning();

      const longKey = "z".repeat(32);
      expect(longKey.length).toBe(32);

      const [t2] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "Long Key Active Task 2",
          createdBy: owner.user.id,
          rankKey: longKey,
          version: 2,
        })
        .returning();

      const [tArch] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "Archived Task",
          createdBy: owner.user.id,
          rankKey: "m999",
          version: 1,
          archivedAt: new Date(),
        })
        .returning();

      // Create a new task in this column, triggering rebalance during insertion
      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `rebal-create-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Triggering Create Task",
          columnId: colId,
        }),
      });

      expect(res.status).toBe(201);
      const { task: newTask } = await res.json();

      // Query all project events in order
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .orderBy(asc(projectEvents.seq));

      // Must have exactly 2 events: column.rebalanced (seq 1), then task.created (seq 2)
      expect(events).toHaveLength(2);

      const [rebalEvent, createEvent] = events;

      // Event 1: column.rebalanced
      expect(rebalEvent!.seq).toBe(1);
      expect(rebalEvent!.eventType).toBe("column.rebalanced");
      expect(rebalEvent!.entityType).toBe("column");
      expect(rebalEvent!.entityId).toBe(colId);
      expect(() => columnRebalancedPayloadSchema.parse(rebalEvent!.payload)).not.toThrow();

      const rebalPayload = rebalEvent!.payload as any;
      expect(rebalPayload.columnId).toBe(colId);

      // Verify rankKeyMap contains all active tasks rebalanced in the column
      expect(rebalPayload.rankKeyMap[t1.id]).toBe("a0");
      expect(rebalPayload.rankKeyMap[t2.id]).toBe("a1");

      // Verify archived tasks are strictly EXCLUDED from rankKeyMap
      expect(rebalPayload.rankKeyMap[tArch.id]).toBeUndefined();

      // Verify the newly created task is NOT in rankKeyMap (it is created after rebalance)
      expect(rebalPayload.rankKeyMap[newTask.id]).toBeUndefined();

      // Event 2: task.created
      expect(createEvent!.seq).toBe(2);
      expect(createEvent!.eventType).toBe("task.created");
      expect(createEvent!.entityType).toBe("task");
      expect(createEvent!.entityId).toBe(newTask.id);
      expect(() => taskCreatedPayloadSchema.parse(createEvent!.payload)).not.toThrow();

      const createPayload = createEvent!.payload as any;
      // New task receives clean rankKey appended after the rebalanced tasks ("a2")
      expect(createPayload.task.rankKey).toBe("a2");
      expect(createPayload.changes.rankKey).toEqual({ to: "a2" });

      // Project sequence must be updated to 2
      const [dbProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProject!.lastSeq).toBe(2);
    });

    it("emits ONLY task.created when rank key length does not exceed 32", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Seed a normal task with rankKey "a0"
      await testDb.insert(tasks).values({
        projectId: project.id,
        columnId: colId,
        title: "Seed Task",
        createdBy: owner.user.id,
        rankKey: "a0",
        version: 1,
      });

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `no-rebal-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Standard Task",
          columnId: colId,
        }),
      });

      expect(res.status).toBe(201);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));

      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("task.created");
      expect(events[0]!.seq).toBe(1);
    });
  });

  describe("C. Transaction Rollback & Atomicity", () => {
    it("rolls back task insertion, event row, and sequence counter when transaction aborts before commit", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Listener using synchronization barrier to verify notification rollback
      const listenerClient = testSqlClient;
      const receivedNotifications: Array<{ projectId: string; seq: number }> = [];

      type NotificationEvent = { channel: string; payload: { projectId: string; seq: number } };
      let waiter: {
        expectedSeq: number;
        resolve: (event: NotificationEvent) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
      } | null = null;

      function waitForNotification(expectedSeq: number, timeoutMs = 5000): Promise<NotificationEvent> {
        return new Promise<NotificationEvent>((resolve, reject) => {
          const existing = receivedNotifications.find((n) => n.seq === expectedSeq);
          if (existing) {
            return resolve({ channel: "project_events", payload: existing });
          }

          const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for notification seq=${expectedSeq}`));
          }, timeoutMs);

          waiter = { expectedSeq, resolve, reject, timer };
        });
      }

      const subscription = await listenerClient.listen("project_events", (payloadStr) => {
        try {
          const parsed = JSON.parse(payloadStr) as { projectId: string; seq: number };
          receivedNotifications.push(parsed);

          if (waiter && waiter.expectedSeq === parsed.seq) {
            clearTimeout(waiter.timer);
            waiter.resolve({ channel: "project_events", payload: parsed });
            waiter = null;
          }
        } catch (err: any) {
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.reject(err);
            waiter = null;
          }
        }
      });

      try {
        // 1. Aborted transaction: insert task and append event, then fail before commit
        let aborted = false;
        try {
          await testDb.transaction(async (tx) => {
            // Lock project row
            await (tx
              .select()
              .from(projects)
              .where(eq(projects.id, project.id)) as any).for("update");

            // Insert task row
            const [t] = await tx
              .insert(tasks)
              .values({
                projectId: project.id,
                columnId: colId,
                title: "Task That Will Abort",
                createdBy: owner.user.id,
                rankKey: "a0",
                version: 1,
              })
              .returning();

            // Append task.created event
            const { EventService } = await import("../../src/services/event.js");
            const { buildTaskSnapshot, buildTaskCreatedChanges } = await import(
              "../../src/services/task.js"
            );
            const snapshot = buildTaskSnapshot(t!);
            const changes = buildTaskCreatedChanges(t!);

            await EventService.appendProjectEvent(tx, {
              projectId: project.id,
              actorId: owner.user.id,
              eventType: "task.created",
              entityType: "task",
              entityId: t!.id,
              payload: { task: snapshot, changes },
            });

            // Force failure after event append
            throw new Error("Deliberate downstream failure after event append");
          });
        } catch (err: any) {
          if (err.message === "Deliberate downstream failure after event append") {
            aborted = true;
          }
        }

        expect(aborted).toBe(true);

        // Verify domain mutation was rolled back: task does NOT exist
        const dbTasks = await testDb
          .select()
          .from(tasks)
          .where(eq(tasks.projectId, project.id));
        expect(dbTasks).toHaveLength(0);

        // Verify event was rolled back: 0 rows in project_events
        const dbEvents = await testDb
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id));
        expect(dbEvents).toHaveLength(0);

        // Verify project last_seq was NOT incremented: remains 0
        const [dbProj] = await testDb
          .select()
          .from(projects)
          .where(eq(projects.id, project.id));
        expect(dbProj!.lastSeq).toBe(0);

        // 2. Synchronization Barrier: commit a successful task creation transaction
        const barrierPromise = waitForNotification(1);
        const barrierRes = await app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": `barrier-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            title: "Barrier Committed Task",
            columnId: colId,
          }),
        });
        expect(barrierRes.status).toBe(201);

        const barrierNotification = await barrierPromise;
        expect(barrierNotification.payload).toEqual({
          projectId: project.id,
          seq: 1,
        });

        // Exactly one notification was received overall (proves aborted transaction emitted no notification)
        expect(receivedNotifications).toHaveLength(1);
        expect(receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 1,
        });
      } finally {
        if (waiter) clearTimeout((waiter as any).timer);
        await subscription.unlisten();
      }
    });
  });
});

