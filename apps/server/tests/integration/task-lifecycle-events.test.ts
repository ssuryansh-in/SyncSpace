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
  taskUpdatedPayloadSchema,
  taskArchivedPayloadSchema,
  taskRestoredPayloadSchema,
  columnRebalancedPayloadSchema,
} from "../../src/services/event.js";

describe("Task Lifecycle & Column Rebalancing Events (Integration - Milestone 7.2B)", () => {
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

  describe("D. Task Updates (task.updated)", () => {
    it("emits exactly one task.updated event with canonical 13-field snapshot and {from, to} field changes", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Add a member
      const member = await createAndLoginUser("Member User", "member-update@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      // Create a task
      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `task-upd-init-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Initial Title",
          columnId: colId,
        }),
      });
      const { task } = await createRes.json();

      // Update the task: change title, assignee, and due date
      const patchRes = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({
          title: "Updated Title",
          assigneeId: member.user.id,
          dueDate: "2026-12-15",
          expectedVersion: 1,
        }),
      });

      expect(patchRes.status).toBe(200);
      const { task: updatedTask } = await patchRes.json();
      expect(updatedTask.version).toBe(2);

      // Verify events in project_events
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .orderBy(asc(projectEvents.seq));

      // Exactly 2 events: task.created (seq 1) and task.updated (seq 2)
      expect(events).toHaveLength(2);
      const updateEvent = events[1]!;

      expect(updateEvent.seq).toBe(2);
      expect(updateEvent.eventType).toBe("task.updated");
      expect(updateEvent.entityType).toBe("task");
      expect(updateEvent.entityId).toBe(task.id);
      expect(updateEvent.actorId).toBe(owner.user.id);
      expect(() => taskUpdatedPayloadSchema.parse(updateEvent.payload)).not.toThrow();

      const payload = updateEvent.payload as any;

      // 1. Snapshot has all 13 canonical fields reflecting version 2
      expect(payload.task).toEqual({
        id: task.id,
        projectId: project.id,
        columnId: colId,
        title: "Updated Title",
        description: "",
        createdBy: owner.user.id,
        assigneeId: member.user.id,
        rankKey: task.rankKey,
        version: 2,
        dueDate: "2026-12-15",
        createdAt: task.createdAt,
        updatedAt: updatedTask.updatedAt,
        archivedAt: null,
      });

      // 2. Changes object has exact { from, to } diffs
      expect(payload.changes).toEqual({
        title: { from: "Initial Title", to: "Updated Title" },
        assigneeId: { from: null, to: member.user.id },
        dueDate: { from: null, to: "2026-12-15" },
      });

      // 3. Project sequence is 2
      const [dbProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProject!.lastSeq).toBe(2);
    });

    it("strictly preserves description privacy in task.updated: diff is { description: { changed: true } } without leaking old or new description", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;
      const initialSecret = "Initial Private Blueprint";
      const updatedSecret = "Classified Updated Strategy";

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `task-upd-desc-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Sensitive Task",
          columnId: colId,
          description: initialSecret,
        }),
      });
      const { task } = await createRes.json();

      const patchRes = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({
          description: updatedSecret,
          expectedVersion: 1,
        }),
      });

      expect(patchRes.status).toBe(200);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .orderBy(asc(projectEvents.seq));

      expect(events).toHaveLength(2);
      const updateEvent = events[1]!;
      const payload = updateEvent.payload as any;

      // The snapshot carries the updated description for board state hydration
      expect(payload.task.description).toBe(updatedSecret);

      // The changes diff MUST strictly be { description: { changed: true } }
      expect(payload.changes.description).toEqual({ changed: true });

      // Invariant: neither initial nor updated description text appears in serialized changes
      const serializedChanges = JSON.stringify(payload.changes);
      expect(serializedChanges).not.toContain(initialSecret);
      expect(serializedChanges).not.toContain(updatedSecret);
      expect(serializedChanges).not.toContain('"from"');
      expect(serializedChanges).not.toContain('"to"');
    });

    it("suppresses event emission and preserves version on no-op task updates", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `task-upd-noop-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Static Task",
          columnId: colId,
          description: "Static description",
        }),
      });
      const { task } = await createRes.json();

      // Submit identical values in PATCH
      const patchRes = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({
          title: "Static Task",
          description: "Static description",
          expectedVersion: 1,
        }),
      });

      expect(patchRes.status).toBe(200);
      const { task: returnedTask } = await patchRes.json();

      // Version must NOT be incremented
      expect(returnedTask.version).toBe(1);

      // Project events count must remain strictly 1 (task.created only)
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("task.created");

      // Project sequence must remain 1
      const [dbProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProject!.lastSeq).toBe(1);
    });

    it("enforces optimistic concurrency: rejects stale expectedVersion with 409 and emits zero events", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `task-upd-conflict-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Versioned Task",
          columnId: colId,
        }),
      });
      const { task } = await createRes.json();

      // Submit with stale expectedVersion (expectedVersion: 99 instead of 1)
      const conflictRes = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({
          title: "Stale Edit",
          expectedVersion: 99,
        }),
      });

      expect(conflictRes.status).toBe(409);
      const conflictBody = await conflictRes.json();
      expect(conflictBody.error.code).toBe("VERSION_CONFLICT");

      // No task.updated event was emitted
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("task.created");
    });

    it("rolls back task update, event row, and sequence counter when transaction aborts before commit", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `task-upd-rb-init-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Task Before Update Rollback",
          columnId: colId,
        }),
      });
      const { task } = await createRes.json();

      // Listener with synchronization barrier
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
        // Aborted update transaction
        let aborted = false;
        try {
          await testDb.transaction(async (tx) => {
            await (tx.select().from(projects).where(eq(projects.id, project.id)) as any).for("update");
            const [lockedTask] = await (tx.select().from(tasks).where(eq(tasks.id, task.id)) as any).for("update");

            const [updatedTask] = await tx
              .update(tasks)
              .set({
                title: "Failed Update",
                version: lockedTask!.version + 1,
                updatedAt: new Date(),
              })
              .where(eq(tasks.id, task.id))
              .returning();

            const { EventService } = await import("../../src/services/event.js");
            const { buildTaskSnapshot, buildTaskChanges } = await import("../../src/services/task.js");

            await EventService.appendProjectEvent(tx, {
              projectId: project.id,
              actorId: owner.user.id,
              eventType: "task.updated",
              entityType: "task",
              entityId: updatedTask!.id,
              payload: {
                task: buildTaskSnapshot(updatedTask!),
                changes: buildTaskChanges(lockedTask!, updatedTask!),
              },
            });

            throw new Error("Deliberate abort after update event append");
          });
        } catch (err: any) {
          if (err.message === "Deliberate abort after update event append") {
            aborted = true;
          }
        }

        expect(aborted).toBe(true);

        // Verify task row rolled back: title is still "Task Before Update Rollback", version is still 1
        const [dbTask] = await testDb.select().from(tasks).where(eq(tasks.id, task.id));
        expect(dbTask!.title).toBe("Task Before Update Rollback");
        expect(dbTask!.version).toBe(1);

        // Verify sequence remains 1
        const [dbProject] = await testDb.select().from(projects).where(eq(projects.id, project.id));
        expect(dbProject!.lastSeq).toBe(1);

        // Verify project_events has only seq 1
        const events = await testDb.select().from(projectEvents).where(eq(projectEvents.projectId, project.id));
        expect(events).toHaveLength(1);

        // Synchronization barrier: perform successful task update via API (allocating seq 2)
        const barrierPromise = waitForNotification(2);
        const barrierRes = await app.request(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
          },
          body: JSON.stringify({
            title: "Barrier Successful Update",
            expectedVersion: 1,
          }),
        });
        expect(barrierRes.status).toBe(200);

        const barrierNotification = await barrierPromise;
        expect(barrierNotification.payload).toEqual({
          projectId: project.id,
          seq: 2,
        });

        // Exactly one notification was received by listener during this test block (for seq 2)
        expect(receivedNotifications).toHaveLength(1);
        expect(receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 2,
        });
      } finally {
        if (waiter) clearTimeout((waiter as any).timer);
        await subscription.unlisten();
      }
    });
  });

  describe("E. Task Archival (task.archived)", () => {
    it("emits exactly one task.archived event with snapshot reflecting archived state and archivedAt transition", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `task-arch-init-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Task To Archive",
          columnId: colId,
        }),
      });
      const { task } = await createRes.json();

      // Archive the task
      const archiveRes = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
      });

      expect(archiveRes.status).toBe(200);
      const { task: archivedTask } = await archiveRes.json();
      expect(archivedTask.archivedAt).not.toBeNull();
      expect(archivedTask.version).toBe(2);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .orderBy(asc(projectEvents.seq));

      // Exactly 2 events: task.created (seq 1) and task.archived (seq 2)
      expect(events).toHaveLength(2);
      const archEvent = events[1]!;

      expect(archEvent.seq).toBe(2);
      expect(archEvent.eventType).toBe("task.archived");
      expect(archEvent.entityType).toBe("task");
      expect(archEvent.entityId).toBe(task.id);
      expect(archEvent.actorId).toBe(owner.user.id);
      expect(() => taskArchivedPayloadSchema.parse(archEvent.payload)).not.toThrow();

      const payload = archEvent.payload as any;

      // 1. Snapshot reflects archived state with archivedAt ISO string
      expect(payload.task.archivedAt).toBe(archivedTask.archivedAt);
      expect(payload.task.version).toBe(2);

      // 2. Changes object reflects transition from null to ISO timestamp
      expect(payload.changes).toEqual({
        archivedAt: { from: null, to: archivedTask.archivedAt },
      });

      // 3. Project sequence is 2
      const [dbProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProject!.lastSeq).toBe(2);
    });

    it("suppresses event emission and preserves version on repeated archive calls (idempotent no-op)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `task-arch-repeat-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Idempotent Archive Task",
          columnId: colId,
        }),
      });
      const { task } = await createRes.json();

      // First archive call
      const archiveRes1 = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes1.status).toBe(200);
      const { task: archived1 } = await archiveRes1.json();
      expect(archived1.version).toBe(2);

      const eventsCount1 = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(eventsCount1).toHaveLength(2);

      // Second archive call (idempotent no-op on already archived task)
      const archiveRes2 = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes2.status).toBe(200);
      const { task: archived2 } = await archiveRes2.json();

      // Version, timestamps, and rankKey are strictly preserved
      expect(archived2.version).toBe(2);
      expect(archived2.archivedAt).toBe(archived1.archivedAt);

      // Events count in project_events remains strictly 2 (no duplicate event emitted)
      const eventsCount2 = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(eventsCount2).toHaveLength(2);

      // Project sequence remains 2
      const [dbProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProject!.lastSeq).toBe(2);
    });

    it("rolls back task archival, event row, and sequence counter when transaction aborts before commit", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `task-arch-rb-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Task Before Archive Rollback",
          columnId: colId,
        }),
      });
      const { task } = await createRes.json();

      // Listener with synchronization barrier
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
        // Aborted archive transaction
        let aborted = false;
        try {
          await testDb.transaction(async (tx) => {
            await (tx.select().from(projects).where(eq(projects.id, project.id)) as any).for("update");
            const [lockedTask] = await (tx.select().from(tasks).where(eq(tasks.id, task.id)) as any).for("update");

            const [archivedTask] = await tx
              .update(tasks)
              .set({
                archivedAt: new Date(),
                version: lockedTask!.version + 1,
                updatedAt: new Date(),
              })
              .where(eq(tasks.id, task.id))
              .returning();

            const { EventService } = await import("../../src/services/event.js");
            const { buildTaskSnapshot, buildTaskChanges } = await import("../../src/services/task.js");

            await EventService.appendProjectEvent(tx, {
              projectId: project.id,
              actorId: owner.user.id,
              eventType: "task.archived",
              entityType: "task",
              entityId: archivedTask!.id,
              payload: {
                task: buildTaskSnapshot(archivedTask!),
                changes: buildTaskChanges(lockedTask!, archivedTask!),
              },
            });

            throw new Error("Deliberate abort after archive event append");
          });
        } catch (err: any) {
          if (err.message === "Deliberate abort after archive event append") {
            aborted = true;
          }
        }

        expect(aborted).toBe(true);

        // Verify task row rolled back: archivedAt is still null, version is still 1
        const [dbTask] = await testDb.select().from(tasks).where(eq(tasks.id, task.id));
        expect(dbTask!.archivedAt).toBeNull();
        expect(dbTask!.version).toBe(1);

        // Verify sequence remains 1
        const [dbProject] = await testDb.select().from(projects).where(eq(projects.id, project.id));
        expect(dbProject!.lastSeq).toBe(1);

        // Verify project_events has only seq 1
        const events = await testDb.select().from(projectEvents).where(eq(projectEvents.projectId, project.id));
        expect(events).toHaveLength(1);

        // Synchronization barrier: perform successful task archive via API (allocating seq 2)
        const barrierPromise = waitForNotification(2);
        const barrierRes = await app.request(`/api/tasks/${task.id}/archive`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        });
        expect(barrierRes.status).toBe(200);

        const barrierNotification = await barrierPromise;
        expect(barrierNotification.payload).toEqual({
          projectId: project.id,
          seq: 2,
        });

        // Exactly one notification was received by listener during this test block (for seq 2)
        expect(receivedNotifications).toHaveLength(1);
        expect(receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 2,
        });
      } finally {
        if (waiter) clearTimeout((waiter as any).timer);
        await subscription.unlisten();
      }
    });
  });

  describe("F. Task Restoration (task.restored)", () => {
    it("emits exactly one task.restored event with canonical 13-field snapshot and archivedAt diff on standard restoration", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Create a task
      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `task-res-std-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Standard Restore Task",
          columnId: colId,
        }),
      });
      const { task } = await createRes.json();

      // Archive the task
      const archiveRes = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes.status).toBe(200);
      const { task: archivedTask } = await archiveRes.json();
      expect(archivedTask.archivedAt).not.toBeNull();
      expect(archivedTask.version).toBe(2);

      // Restore the task
      const restoreRes = await app.request(`/api/tasks/${task.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(restoreRes.status).toBe(200);
      const { task: restoredTask } = await restoreRes.json();
      expect(restoredTask.archivedAt).toBeNull();
      expect(restoredTask.version).toBe(3);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .orderBy(asc(projectEvents.seq));

      // Exactly 3 events: task.created (seq 1), task.archived (seq 2), task.restored (seq 3)
      expect(events).toHaveLength(3);
      const restoreEvent = events[2]!;

      expect(restoreEvent.seq).toBe(3);
      expect(restoreEvent.eventType).toBe("task.restored");
      expect(restoreEvent.entityType).toBe("task");
      expect(restoreEvent.entityId).toBe(task.id);
      expect(restoreEvent.actorId).toBe(owner.user.id);
      expect(() => taskRestoredPayloadSchema.parse(restoreEvent.payload)).not.toThrow();

      const payload = restoreEvent.payload as any;

      // 1. Snapshot has all 13 canonical fields with archivedAt = null and version = 3
      expect(payload.task).toEqual({
        id: task.id,
        projectId: project.id,
        columnId: colId,
        title: "Standard Restore Task",
        description: "",
        createdBy: owner.user.id,
        assigneeId: null,
        rankKey: task.rankKey,
        version: 3,
        dueDate: null,
        createdAt: task.createdAt,
        updatedAt: restoredTask.updatedAt,
        archivedAt: null,
      });

      // 2. Changes object reflects transition of archivedAt from original ISO to null
      expect(payload.changes).toEqual({
        archivedAt: { from: archivedTask.archivedAt, to: null },
      });

      // 3. rankKey was unchanged, so it is strictly absent from changes
      expect(payload.changes.rankKey).toBeUndefined();

      // 4. Description was unchanged, so it is strictly absent from changes
      expect(payload.changes.description).toBeUndefined();

      // 5. Project sequence is 3
      const [dbProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProject!.lastSeq).toBe(3);
    });

    it("emits task.restored with rankKey diff on collision repair without rebalancing", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Seed active task t1 with rankKey "a0"
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

      // Seed archived task t2 with identical rankKey "a0" (simulating collision on restore)
      const originalArchivedAt = new Date("2026-11-01T12:00:00.000Z");
      const [t2] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "Archived Colliding Task",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
          archivedAt: originalArchivedAt,
        })
        .returning();

      // Restore t2
      const restoreRes = await app.request(`/api/tasks/${t2.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(restoreRes.status).toBe(200);
      const { task: restoredTask } = await restoreRes.json();

      // t2 collides on "a0", so it is repaired by appending after t1: "a0" -> "a1"
      expect(restoredTask.rankKey).toBe("a1");
      expect(restoredTask.archivedAt).toBeNull();
      expect(restoredTask.version).toBe(2);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));

      // Exactly 1 event emitted: task.restored (zero column.rebalanced events because candidate key "a1" length <= 32)
      expect(events).toHaveLength(1);
      const restoreEvent = events[0]!;

      expect(restoreEvent.eventType).toBe("task.restored");
      expect(restoreEvent.seq).toBe(1);
      expect(() => taskRestoredPayloadSchema.parse(restoreEvent.payload)).not.toThrow();

      const payload = restoreEvent.payload as any;

      // Changes diff must include both archivedAt and rankKey
      expect(payload.changes).toEqual({
        archivedAt: { from: originalArchivedAt.toISOString(), to: null },
        rankKey: { from: "a0", to: "a1" },
      });

      expect(payload.task.rankKey).toBe("a1");
      expect(payload.task.archivedAt).toBeNull();
    });

    it("emits column.rebalanced before task.restored with consecutive sequence numbers when collision repair triggers rebalancing", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Seed:
      // - tActive1: active task with rankKey "a0"
      // - tActive2: active task with 32-character rankKey "z".repeat(32). Appending after it creates length 33 (> 32)
      // - tArchOther: another archived task with rankKey "m999" (must be excluded from rebalance)
      // - tRestoring: colliding archived task with rankKey "a0"
      const [tActive1] = await testDb
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

      const [tActive2] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "Active Task 2 Long Key",
          createdBy: owner.user.id,
          rankKey: longKey,
          version: 2,
        })
        .returning();

      const [tArchOther] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "Other Archived Task",
          createdBy: owner.user.id,
          rankKey: "m999",
          version: 1,
          archivedAt: new Date("2026-11-02T10:00:00.000Z"),
        })
        .returning();

      const originalArchivedAt = new Date("2026-11-03T10:00:00.000Z");
      const [tRestoring] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "Restoring Colliding Task",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
          archivedAt: originalArchivedAt,
        })
        .returning();

      // Restore tRestoring
      const restoreRes = await app.request(`/api/tasks/${tRestoring.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(restoreRes.status).toBe(200);
      const { task: restoredTask } = await restoreRes.json();

      // Query all project events in order
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .orderBy(asc(projectEvents.seq));

      // Must have exactly 2 events: column.rebalanced (seq 1), then task.restored (seq 2)
      expect(events).toHaveLength(2);

      const [rebalEvent, restoreEvent] = events;

      // Event 1: column.rebalanced
      expect(rebalEvent!.seq).toBe(1);
      expect(rebalEvent!.eventType).toBe("column.rebalanced");
      expect(rebalEvent!.entityType).toBe("column");
      expect(rebalEvent!.entityId).toBe(colId);
      expect(() => columnRebalancedPayloadSchema.parse(rebalEvent!.payload)).not.toThrow();

      const rebalPayload = rebalEvent!.payload as any;
      expect(rebalPayload.columnId).toBe(colId);

      // Verify rankKeyMap contains all active tasks rebalanced in the column
      expect(rebalPayload.rankKeyMap[tActive1.id]).toBe("a0");
      expect(rebalPayload.rankKeyMap[tActive2.id]).toBe("a1");

      // Verify other archived task is strictly EXCLUDED from rankKeyMap
      expect(rebalPayload.rankKeyMap[tArchOther.id]).toBeUndefined();

      // Verify the restoring task was NOT in rankKeyMap during active-task rebalance
      expect(rebalPayload.rankKeyMap[tRestoring.id]).toBeUndefined();

      // Event 2: task.restored
      expect(restoreEvent!.seq).toBe(2);
      expect(restoreEvent!.eventType).toBe("task.restored");
      expect(restoreEvent!.entityType).toBe("task");
      expect(restoreEvent!.entityId).toBe(tRestoring.id);
      expect(() => taskRestoredPayloadSchema.parse(restoreEvent!.payload)).not.toThrow();

      const restorePayload = restoreEvent!.payload as any;

      // Snapshot carries the final clean rank key ("a2") appended after the rebalanced column tasks
      expect(restorePayload.task.rankKey).toBe("a2");
      expect(restorePayload.task.archivedAt).toBeNull();
      expect(restorePayload.task.version).toBe(2);

      // Changes diff carries both archivedAt transition and rankKey transition
      expect(restorePayload.changes).toEqual({
        archivedAt: { from: originalArchivedAt.toISOString(), to: null },
        rankKey: { from: "a0", to: "a2" },
      });

      // Project sequence must be updated to 2
      const [dbProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProject!.lastSeq).toBe(2);
    });

    it("suppresses event emission and preserves version on repeated restore calls (idempotent no-op)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Seed an already active task
      const [activeTask] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "Already Active Task",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
          archivedAt: null,
        })
        .returning();

      // Call /restore on the active task
      const restoreRes = await app.request(`/api/tasks/${activeTask.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(restoreRes.status).toBe(200);
      const { task: returnedTask } = await restoreRes.json();

      // Version, timestamps, and rankKey are strictly preserved
      expect(returnedTask.version).toBe(1);
      expect(returnedTask.rankKey).toBe("a0");
      expect(returnedTask.archivedAt).toBeNull();

      // Zero events emitted
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(0);

      // Project sequence remains 0
      const [dbProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProject!.lastSeq).toBe(0);
    });

    it("rolls back task restoration, event row, and sequence counter when transaction aborts before commit", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Seed archived task
      const originalArchivedAt = new Date("2026-11-05T10:00:00.000Z");
      const [task] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "Task Before Restore Rollback",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
          archivedAt: originalArchivedAt,
        })
        .returning();

      // Listener with synchronization barrier
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
        // Aborted restore transaction
        let aborted = false;
        try {
          await testDb.transaction(async (tx) => {
            await (tx.select().from(projects).where(eq(projects.id, project.id)) as any).for("update");
            const [lockedTask] = await (tx.select().from(tasks).where(eq(tasks.id, task.id)) as any).for("update");

            const [restoredTask] = await tx
              .update(tasks)
              .set({
                archivedAt: null,
                version: lockedTask!.version + 1,
                updatedAt: new Date(),
              })
              .where(eq(tasks.id, task.id))
              .returning();

            const { EventService } = await import("../../src/services/event.js");
            const { buildTaskSnapshot, buildTaskChanges } = await import("../../src/services/task.js");

            await EventService.appendProjectEvent(tx, {
              projectId: project.id,
              actorId: owner.user.id,
              eventType: "task.restored",
              entityType: "task",
              entityId: restoredTask!.id,
              payload: {
                task: buildTaskSnapshot(restoredTask!),
                changes: buildTaskChanges(lockedTask!, restoredTask!),
              },
            });

            throw new Error("Deliberate abort after restore event append");
          });
        } catch (err: any) {
          if (err.message === "Deliberate abort after restore event append") {
            aborted = true;
          }
        }

        expect(aborted).toBe(true);

        // Verify task row rolled back: archivedAt is still set, version is still 1
        const [dbTask] = await testDb.select().from(tasks).where(eq(tasks.id, task.id));
        expect(dbTask!.archivedAt).not.toBeNull();
        expect(dbTask!.archivedAt!.toISOString()).toBe(originalArchivedAt.toISOString());
        expect(dbTask!.version).toBe(1);

        // Verify sequence remains 0
        const [dbProject] = await testDb.select().from(projects).where(eq(projects.id, project.id));
        expect(dbProject!.lastSeq).toBe(0);

        // Verify project_events has 0 rows
        const events = await testDb.select().from(projectEvents).where(eq(projectEvents.projectId, project.id));
        expect(events).toHaveLength(0);

        // Synchronization barrier: perform successful task restoration via API (allocating seq 1)
        const barrierPromise = waitForNotification(1);
        const barrierRes = await app.request(`/api/tasks/${task.id}/restore`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        });
        expect(barrierRes.status).toBe(200);

        const barrierNotification = await barrierPromise;
        expect(barrierNotification.payload).toEqual({
          projectId: project.id,
          seq: 1,
        });

        // Exactly one notification was received by listener during this test block (for seq 1)
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

