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
  comments,
  projectEvents,
} from "../../src/db/schema/index.js";
import { cleanTables, testDb, testSqlClient } from "./setup.js";
import {
  commentCreatedPayloadSchema,
  commentDeletedPayloadSchema,
} from "../../src/services/event.js";

describe("Comment Lifecycle Events (Integration - Milestone 7.3-2)", () => {
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
   * Helper to set up a workspace, project, and an active task
   */
  async function setupWorkspaceProjectAndTask(
    ownerName = "Owner User",
    ownerEmail = "owner@example.com"
  ) {
    const owner = await createAndLoginUser(ownerName, ownerEmail);

    const wsRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Comment Event Workspace" }),
    });
    const { workspace } = await wsRes.json();

    const projRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Comment Event Project" }),
    });
    const { project, columns } = await projRes.json();
    const colId = columns[0].id;

    // Create an initial task (seq = 1)
    const taskRes = await app.request(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: owner.cookie,
        "Idempotency-Key": `task-setup-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        title: "Comment Target Task",
        columnId: colId,
      }),
    });
    const { task } = await taskRes.json();

    return { owner, workspace, project, columns, task };
  }

  type NotificationEvent = { channel: string; payload: { projectId: string; seq: number } };

  interface NotificationSubscription {
    receivedNotifications: Array<{ projectId: string; seq: number }>;
    waitForNotification: (
      expectedSeq: number,
      expectedProjectId?: string,
      timeoutMs?: number
    ) => Promise<NotificationEvent>;
    cleanup: () => Promise<void>;
  }

  /**
   * Subscribes to project_events channel and provides a bounded promise for the expected notification.
   * Guarantees that asynchronous NOTIFY dispatch from PostgreSQL is cleanly awaited before assertions.
   */
  async function createNotificationListener(
    channel = "project_events"
  ): Promise<NotificationSubscription> {
    const listenerClient = testSqlClient;
    const receivedNotifications: Array<{ projectId: string; seq: number }> = [];

    let waiter: {
      expectedSeq: number;
      expectedProjectId?: string;
      resolve: (event: NotificationEvent) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    } | null = null;

    function waitForNotification(
      expectedSeq: number,
      expectedProjectId?: string,
      timeoutMs = 5000
    ): Promise<NotificationEvent> {
      return new Promise<NotificationEvent>((resolve, reject) => {
        if (waiter) {
          return reject(
            new Error(
              `Concurrent waitForNotification calls are not supported; a waiter for seq=${waiter.expectedSeq} is already active.`
            )
          );
        }

        const existing = receivedNotifications.find(
          (n) =>
            n.seq === expectedSeq &&
            (!expectedProjectId || n.projectId === expectedProjectId)
        );
        if (existing) {
          return resolve({ channel, payload: existing });
        }

        const timer = setTimeout(() => {
          if (waiter && waiter.timer === timer) {
            waiter = null;
          }
          reject(
            new Error(
              `Timed out waiting for notification seq=${expectedSeq}${
                expectedProjectId ? ` projectId=${expectedProjectId}` : ""
              } on ${channel}`
            )
          );
        }, timeoutMs);

        waiter = { expectedSeq, expectedProjectId, resolve, reject, timer };
      });
    }

    const subscription = await listenerClient.listen(channel, (payloadStr) => {
      try {
        const parsed = JSON.parse(payloadStr) as { projectId: string; seq: number };
        receivedNotifications.push(parsed);

        if (
          waiter &&
          waiter.expectedSeq === parsed.seq &&
          (!waiter.expectedProjectId || waiter.expectedProjectId === parsed.projectId)
        ) {
          const activeWaiter = waiter;
          waiter = null;
          clearTimeout(activeWaiter.timer);
          activeWaiter.resolve({ channel, payload: parsed });
        }
      } catch (err: any) {
        if (waiter) {
          const activeWaiter = waiter;
          waiter = null;
          clearTimeout(activeWaiter.timer);
          activeWaiter.reject(err);
        }
      }
    });

    return {
      receivedNotifications,
      waitForNotification,
      cleanup: async () => {
        if (waiter) {
          const activeWaiter = waiter;
          waiter = null;
          clearTimeout(activeWaiter.timer);
          activeWaiter.reject(
            new Error("Notification listener was cleaned up while a waiter was still pending")
          );
        }
        await subscription.unlisten();
      },
    };
  }

  // ============================================================================
  // Scenario A: Comment Creation Event (comment.created)
  // ============================================================================
  describe("Scenario A: Comment Creation Event (comment.created)", () => {
    it("emits exactly one comment.created event with exact 4 fields, no body, correct sequence, and NOTIFY", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      const listener = await createNotificationListener();

      try {
        const notificationPromise = listener.waitForNotification(2, project.id);

        const commentRes = await app.request(`/api/tasks/${task.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": "comment-event-create-1",
          },
          body: JSON.stringify({ body: "Super confidential comment body text!" }),
        });

        expect(commentRes.status).toBe(201);
        const { comment } = await commentRes.json();
        expect(comment.id).toBeDefined();

        // Await deterministic NOTIFY barrier before inspecting notification state
        const notification = await notificationPromise;
        expect(notification.payload).toEqual({
          projectId: project.id,
          seq: 2,
        });

        // Exactly one notification received
        expect(listener.receivedNotifications).toHaveLength(1);
        expect(listener.receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 2,
        });

        // Project sequence must have advanced from 1 (task creation) to 2
        const [persistedProject] = await testDb
          .select()
          .from(projects)
          .where(eq(projects.id, project.id));
        expect(persistedProject!.lastSeq).toBe(2);

        // Fetch events for project
        const events = await testDb
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id))
          .orderBy(asc(projectEvents.seq));

        expect(events).toHaveLength(2);
        const commentEvent = events[1]!;

        // 1. Envelope assertions
        expect(commentEvent.projectId).toBe(project.id);
        expect(commentEvent.seq).toBe(2);
        expect(commentEvent.eventType).toBe("comment.created");
        expect(commentEvent.entityType).toBe("comment");
        expect(commentEvent.entityId).toBe(comment.id);
        expect(commentEvent.actorId).toBe(owner.user.id);

        // 2. Validate payload against Zod schema
        expect(() => commentCreatedPayloadSchema.parse(commentEvent.payload)).not.toThrow();
        const payload = commentEvent.payload as any;

        // 3. Exact 4 fields in payload
        expect(payload).toEqual({
          commentId: comment.id,
          taskId: task.id,
          authorId: owner.user.id,
          createdAt: comment.createdAt,
        });

        // 4. Privacy invariant: comment body must NEVER appear in event payload
        expect(payload).not.toHaveProperty("body");
        expect(JSON.stringify(payload)).not.toContain("Super confidential");
        expect(JSON.stringify(commentEvent)).not.toContain("Super confidential");

        // 5. Sequence equality invariant
        expect(commentEvent.seq).toBe(persistedProject!.lastSeq);
      } finally {
        await listener.cleanup();
      }
    });
  });

  // ============================================================================
  // Scenario B: Idempotency Replay
  // ============================================================================
  describe("Scenario B: Idempotency Replay", () => {
    it("returns cached response without inserting duplicate comment or emitting duplicate event", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();
      const idempotencyKey = "comment-idemp-replay-key";

      // 1. First genuine comment creation
      const firstRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ body: "Idempotent comment body" }),
      });
      expect(firstRes.status).toBe(201);
      const { comment: firstComment } = await firstRes.json();

      const eventsAfterFirst = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(eventsAfterFirst).toHaveLength(2); // seq 1: task, seq 2: comment

      const [projAfterFirst] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(projAfterFirst!.lastSeq).toBe(2);

      // Set up listener to verify no notifications are emitted on replay
      const listener = await createNotificationListener();

      try {
        // 2. Replay request with exact same Idempotency-Key and body
        const replayRes = await app.request(`/api/tasks/${task.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ body: "Idempotent comment body" }),
        });

        expect(replayRes.status).toBe(201);
        const { comment: replayedComment } = await replayRes.json();
        expect(replayedComment.id).toBe(firstComment.id);

        // Verify no second comment in comments table
        const dbComments = await testDb
          .select()
          .from(comments)
          .where(eq(comments.taskId, task.id));
        expect(dbComments).toHaveLength(1);

        // Verify events count is still exactly 2 (zero additional events)
        const eventsAfterReplay = await testDb
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id));
        expect(eventsAfterReplay).toHaveLength(2);

        // Verify project last_seq is untouched (remains 2)
        const [projAfterReplay] = await testDb
          .select()
          .from(projects)
          .where(eq(projects.id, project.id));
        expect(projAfterReplay!.lastSeq).toBe(2);

        // 3. Synchronization barrier: execute a subsequent genuine mutation allocating seq 3
        const barrierPromise = listener.waitForNotification(3, project.id);
        const barrierRes = await app.request(`/api/tasks/${task.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": "barrier-after-replay",
          },
          body: JSON.stringify({ body: "Barrier comment after replay" }),
        });
        expect(barrierRes.status).toBe(201);

        const barrierNotification = await barrierPromise;
        expect(barrierNotification.payload).toEqual({
          projectId: project.id,
          seq: 3,
        });

        // Exactly one notification received by listener during this test block (seq: 3).
        // Since PostgreSQL NOTIFY messages are delivered in strict FIFO order on the connection,
        // this deterministically proves that the replayed comment request (step 2) emitted zero notifications.
        expect(listener.receivedNotifications).toHaveLength(1);
        expect(listener.receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 3,
        });
      } finally {
        await listener.cleanup();
      }
    });

    it("rejects idempotency key reuse with conflicting request body with 409 and emits zero events", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();
      const idempotencyKey = "conflict-idemp-key";

      // 1. Initial creation
      await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ body: "Original body" }),
      });

      const eventsBefore = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(eventsBefore).toHaveLength(2);

      const listener = await createNotificationListener();

      try {
        // 2. Conflicting reuse
        const conflictRes = await app.request(`/api/tasks/${task.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ body: "Conflicting modified body" }),
        });

        expect(conflictRes.status).toBe(409);
        const conflictData = await conflictRes.json();
        expect(conflictData.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

        // Zero events emitted in database
        const eventsAfter = await testDb
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id));
        expect(eventsAfter).toHaveLength(2);

        // 3. Synchronization barrier: create valid comment with new key (allocates seq 3)
        const barrierPromise = listener.waitForNotification(3, project.id);
        const barrierRes = await app.request(`/api/tasks/${task.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": "barrier-after-conflict",
          },
          body: JSON.stringify({ body: "Barrier comment after conflict" }),
        });
        expect(barrierRes.status).toBe(201);

        const barrierNotification = await barrierPromise;
        expect(barrierNotification.payload).toEqual({
          projectId: project.id,
          seq: 3,
        });

        // Exactly one notification received (seq: 3), proving 409 conflict emitted 0 notifications
        expect(listener.receivedNotifications).toHaveLength(1);
        expect(listener.receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 3,
        });
      } finally {
        await listener.cleanup();
      }
    });
  });

  // ============================================================================
  // Scenario C: Comment Deletion by Author (comment.deleted)
  // ============================================================================
  describe("Scenario C: Comment Deletion by Author (comment.deleted)", () => {
    it("emits exactly one comment.deleted event with exact 4 fields, deletedAt timestamp, and NOTIFY", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      // Create comment (seq = 2)
      const commentRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "comment-del-auth-1",
        },
        body: JSON.stringify({ body: "Author comment to be deleted" }),
      });
      const { comment } = await commentRes.json();

      const listener = await createNotificationListener();

      try {
        const notificationPromise = listener.waitForNotification(3, project.id);

        const deleteRes = await app.request(`/api/comments/${comment.id}`, {
          method: "DELETE",
          headers: { Cookie: owner.cookie },
        });

        expect(deleteRes.status).toBe(200);
        const deleteData = await deleteRes.json();
        expect(deleteData.status).toBe(true);

        // Await deterministic NOTIFY barrier before inspecting notification state
        const notification = await notificationPromise;
        expect(notification.payload).toEqual({
          projectId: project.id,
          seq: 3,
        });

        // Exactly one notification received
        expect(listener.receivedNotifications).toHaveLength(1);
        expect(listener.receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 3,
        });

        // Fetch persisted comment
        const [dbComment] = await testDb
          .select()
          .from(comments)
          .where(eq(comments.id, comment.id));
        expect(dbComment!.deletedAt).not.toBeNull();

        // Project sequence must have advanced to 3
        const [persistedProject] = await testDb
          .select()
          .from(projects)
          .where(eq(projects.id, project.id));
        expect(persistedProject!.lastSeq).toBe(3);

        const events = await testDb
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id))
          .orderBy(asc(projectEvents.seq));

        expect(events).toHaveLength(3);
        const delEvent = events[2]!;

        // 1. Envelope assertions
        expect(delEvent.projectId).toBe(project.id);
        expect(delEvent.seq).toBe(3);
        expect(delEvent.eventType).toBe("comment.deleted");
        expect(delEvent.entityType).toBe("comment");
        expect(delEvent.entityId).toBe(comment.id);
        expect(delEvent.actorId).toBe(owner.user.id);

        // 2. Payload validation
        expect(() => commentDeletedPayloadSchema.parse(delEvent.payload)).not.toThrow();
        const payload = delEvent.payload as any;

        // 3. Exact 4 fields
        expect(payload).toEqual({
          commentId: comment.id,
          taskId: task.id,
          authorId: owner.user.id,
          deletedAt: dbComment!.deletedAt!.toISOString(),
        });

        // 4. Privacy invariant
        expect(payload).not.toHaveProperty("body");
        expect(JSON.stringify(payload)).not.toContain("Author comment");
      } finally {
        await listener.cleanup();
      }
    });
  });

  // ============================================================================
  // Scenario D: Comment Deletion by Admin/Owner
  // ============================================================================
  describe("Scenario D: Comment Deletion by Admin/Owner", () => {
    it("distinguishes actorId (admin) from authorId (member) in comment.deleted event", async () => {
      const { owner, workspace, project, task } = await setupWorkspaceProjectAndTask();

      // Add a regular member who authors the comment
      const member = await createAndLoginUser("Member Commenter", "member-comm@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      // Member creates comment (seq = 2)
      const commentRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: member.cookie,
          "Idempotency-Key": "member-comment-1",
        },
        body: JSON.stringify({ body: "Member wrote this comment" }),
      });
      const { comment } = await commentRes.json();
      expect(comment.authorId).toBe(member.user.id);

      // Add an admin user who will delete the comment
      const admin = await createAndLoginUser("Admin Moderator", "admin-mod@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: admin.user.id,
        role: "admin",
      });

      // Admin deletes member's comment (seq = 3)
      const deleteRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: admin.cookie },
      });
      expect(deleteRes.status).toBe(200);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .orderBy(asc(projectEvents.seq));

      expect(events).toHaveLength(3);
      const delEvent = events[2]!;

      // Envelope actorId must be Admin (the deleter)
      expect(delEvent.actorId).toBe(admin.user.id);
      expect(delEvent.seq).toBe(3);
      expect(delEvent.eventType).toBe("comment.deleted");

      // Payload authorId must be Member (the original author)
      const payload = delEvent.payload as any;
      expect(payload.authorId).toBe(member.user.id);
      expect(payload.authorId).not.toBe(delEvent.actorId);
      expect(payload.commentId).toBe(comment.id);
      expect(payload.taskId).toBe(task.id);
      expect(payload).not.toHaveProperty("body");
    });
  });

  // ============================================================================
  // Scenario E: Repeated Deletion (No-op)
  // ============================================================================
  describe("Scenario E: Repeated Deletion (No-op)", () => {
    it("suppresses event emission, preserves sequence, and preserves deletedAt on repeated delete", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      // Create comment
      const commentRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "comm-del-noop-1",
        },
        body: JSON.stringify({ body: "Comment to delete twice" }),
      });
      const { comment } = await commentRes.json();

      // 1. First genuine deletion
      const firstDelRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });
      expect(firstDelRes.status).toBe(200);

      const [afterFirstProj] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(afterFirstProj!.lastSeq).toBe(3);

      const [firstDbComment] = await testDb
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id));
      const firstDeletedAtIso = firstDbComment!.deletedAt!.toISOString();

      const eventsAfterFirst = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(eventsAfterFirst).toHaveLength(3);

      // Set up listener to verify no notification on repeat deletion
      const listener = await createNotificationListener();

      try {
        // 2. Second deletion (idempotent no-op)
        const secondDelRes = await app.request(`/api/comments/${comment.id}`, {
          method: "DELETE",
          headers: { Cookie: owner.cookie },
        });
        expect(secondDelRes.status).toBe(200);

        // Events count remains 3 (zero events emitted)
        const eventsAfterSecond = await testDb
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id));
        expect(eventsAfterSecond).toHaveLength(3);

        // Project lastSeq remains 3
        const [afterSecondProj] = await testDb
          .select()
          .from(projects)
          .where(eq(projects.id, project.id));
        expect(afterSecondProj!.lastSeq).toBe(3);

        // deletedAt timestamp is untouched
        const [secondDbComment] = await testDb
          .select()
          .from(comments)
          .where(eq(comments.id, comment.id));
        expect(secondDbComment!.deletedAt!.toISOString()).toBe(firstDeletedAtIso);

        // 3. Synchronization barrier: commit a subsequent valid mutation allocating seq 4
        const barrierPromise = listener.waitForNotification(4, project.id);
        const barrierRes = await app.request(`/api/tasks/${task.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": "barrier-after-noop-del",
          },
          body: JSON.stringify({ body: "Barrier comment after no-op deletion" }),
        });
        expect(barrierRes.status).toBe(201);

        const barrierNotification = await barrierPromise;
        expect(barrierNotification.payload).toEqual({
          projectId: project.id,
          seq: 4,
        });

        // Exactly one notification was received by the listener during this test block (seq: 4).
        // Since PostgreSQL NOTIFY messages are delivered in strict FIFO order on the connection,
        // this deterministically proves that the repeated deletion (step 2) emitted zero notifications.
        expect(listener.receivedNotifications).toHaveLength(1);
        expect(listener.receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 4,
        });
      } finally {
        await listener.cleanup();
      }
    });
  });

  // ============================================================================
  // Scenario F: Authorization & Invalid-State Non-Emission
  // ============================================================================
  describe("Scenario F: Authorization & Invalid-State Non-Emission", () => {
    it("rejects regular Member attempt to delete another user's comment with 403 and emits zero events", async () => {
      const { owner, workspace, project, task } = await setupWorkspaceProjectAndTask();

      // Owner creates comment
      const commentRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "owner-comm-403",
        },
        body: JSON.stringify({ body: "Owner comment" }),
      });
      const { comment } = await commentRes.json();

      // Add a regular member
      const member = await createAndLoginUser("Other Member", "other-member@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      // Member attempts to delete owner's comment -> 403
      const delRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: member.cookie },
      });
      expect(delRes.status).toBe(403);

      // Only task (1) and comment (2) events exist
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.eventType)).not.toContain("comment.deleted");
    });

    it("conceals non-member access with 404 NOT_FOUND and emits zero events", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      const commentRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "conceal-comm-1",
        },
        body: JSON.stringify({ body: "Comment to conceal" }),
      });
      const { comment } = await commentRes.json();

      const outsider = await createAndLoginUser("Outsider User", "outsider-comm@example.com");

      // Outsider create attempt -> 404
      const createRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: outsider.cookie,
          "Idempotency-Key": "outsider-create-comm",
        },
        body: JSON.stringify({ body: "Outsider comment attempt" }),
      });
      expect(createRes.status).toBe(404);

      // Outsider delete attempt -> 404
      const deleteRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: outsider.cookie },
      });
      expect(deleteRes.status).toBe(404);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(2); // Only task.created and initial comment.created
    });

    it("rejects comment creation and deletion on archived tasks with 409 TASK_ARCHIVED and emits zero events", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      // Create comment while active
      const commentRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "arch-task-comm-1",
        },
        body: JSON.stringify({ body: "Comment before task archival" }),
      });
      const { comment } = await commentRes.json();

      // Archive task
      await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ expectedVersion: 1 }),
      });

      const eventsBefore = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(eventsBefore).toHaveLength(3); // task.created, comment.created, task.archived

      // Attempt to add comment on archived task -> 409
      const addRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "comment-on-archived-task",
        },
        body: JSON.stringify({ body: "Should fail on archived task" }),
      });
      expect(addRes.status).toBe(409);
      expect((await addRes.json()).error.code).toBe("TASK_ARCHIVED");

      // Attempt to delete comment on archived task -> 409
      const delRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });
      expect(delRes.status).toBe(409);
      expect((await delRes.json()).error.code).toBe("TASK_ARCHIVED");

      // Non-mutating listComments succeeds on archived task (read-only audit / history inspection)
      const listRes = await app.request(`/api/tasks/${task.id}/comments`, {
        headers: { Cookie: owner.cookie },
      });
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.comments).toHaveLength(1);
      expect(listData.comments[0].id).toBe(comment.id);

      // Zero additional events
      const eventsAfter = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(eventsAfter).toHaveLength(3);
    });

    it("rejects comment creation and deletion in archived projects with 409 PROJECT_ARCHIVED and emits zero events", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      const commentRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "arch-proj-comm-1",
        },
        body: JSON.stringify({ body: "Comment before project archival" }),
      });
      const { comment } = await commentRes.json();

      // Archive project
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      const eventsBefore = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(eventsBefore).toHaveLength(3); // task.created, comment.created, project.archived

      // Attempt create in archived project -> 409
      const createRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "comment-on-archived-proj",
        },
        body: JSON.stringify({ body: "Should fail in archived project" }),
      });
      expect(createRes.status).toBe(409);
      expect((await createRes.json()).error.code).toBe("PROJECT_ARCHIVED");

      // Attempt delete in archived project -> 409
      const delRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });
      expect(delRes.status).toBe(409);
      expect((await delRes.json()).error.code).toBe("PROJECT_ARCHIVED");

      // Non-mutating listComments succeeds in archived project (read-only audit / history inspection)
      const listRes = await app.request(`/api/tasks/${task.id}/comments`, {
        headers: { Cookie: owner.cookie },
      });
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.comments).toHaveLength(1);
      expect(listData.comments[0].id).toBe(comment.id);

      const eventsAfter = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(eventsAfter).toHaveLength(3);
    });

    it("rejects invalid comment creation payloads with 400 VALIDATION_ERROR and emits zero events", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      // Empty body
      const emptyRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "empty-body-key",
        },
        body: JSON.stringify({ body: "" }),
      });
      expect(emptyRes.status).toBe(400);

      // Missing body
      const missingRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "missing-body-key",
        },
        body: JSON.stringify({}),
      });
      expect(missingRes.status).toBe(400);

      // Missing Idempotency-Key
      const noIdempRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ body: "Valid body text" }),
      });
      expect(noIdempRes.status).toBe(400);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(1); // Only initial task.created
    });
  });

  // ============================================================================
  // Scenario G: Rollback & Notification Atomicity
  // ============================================================================
  describe("Scenario G: Rollback & Notification Atomicity", () => {
    it("atomically rolls back comment mutation, event row, and sequence counter without leaking NOTIFY", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      const listener = await createNotificationListener();

      try {
        // 1. Aborted transaction: insert comment and append event, then fail before commit
        let aborted = false;
        try {
          await testDb.transaction(async (tx) => {
            // Lock project row
            await (tx
              .select()
              .from(projects)
              .where(eq(projects.id, project.id)) as any).for("update");

            // Lock task row
            await (tx
              .select()
              .from(tasks)
              .where(eq(tasks.id, task.id)) as any).for("update");

            // Insert comment
            const [newComm] = await tx
              .insert(comments)
              .values({
                taskId: task.id,
                authorId: owner.user.id,
                body: "Comment in transaction that will abort",
              })
              .returning();

            // Append comment.created event
            const { EventService } = await import("../../src/services/event.js");
            const { buildCommentCreatedPayload } = await import(
              "../../src/services/comment.js"
            );
            const payload = buildCommentCreatedPayload(newComm!);

            await EventService.appendProjectEvent(tx, {
              projectId: project.id,
              actorId: owner.user.id,
              eventType: "comment.created",
              entityType: "comment",
              entityId: newComm!.id,
              payload,
            });

            // Force deliberate failure after event append
            throw new Error("Deliberate downstream failure after comment event append");
          });
        } catch (err: any) {
          if (err.message === "Deliberate downstream failure after comment event append") {
            aborted = true;
          }
        }

        expect(aborted).toBe(true);

        // Verify comment rolled back: 0 comments in DB
        const dbComments = await testDb
          .select()
          .from(comments)
          .where(eq(comments.taskId, task.id));
        expect(dbComments).toHaveLength(0);

        // Verify event rolled back: 1 event row (initial task creation only)
        const dbEvents = await testDb
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id));
        expect(dbEvents).toHaveLength(1);

        // Verify project last_seq remains 1
        const [dbProj] = await testDb
          .select()
          .from(projects)
          .where(eq(projects.id, project.id));
        expect(dbProj!.lastSeq).toBe(1);

        // 2. Synchronization Barrier: commit a successful comment creation mutation
        const barrierPromise = listener.waitForNotification(2, project.id);
        const barrierRes = await app.request(`/api/tasks/${task.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": "barrier-committed-comment-1",
          },
          body: JSON.stringify({ body: "Barrier Committed Comment" }),
        });
        expect(barrierRes.status).toBe(201);

        const barrierNotification = await barrierPromise;
        expect(barrierNotification.payload).toEqual({
          projectId: project.id,
          seq: 2,
        });

        // Exactly one notification received overall during this test block (seq: 2)
        expect(listener.receivedNotifications).toHaveLength(1);
        expect(listener.receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 2,
        });
      } finally {
        await listener.cleanup();
      }
    });
  });

  // ============================================================================
  // Scenario H: Interleaved Project Sequencing
  // ============================================================================
  describe("Scenario H: Interleaved Project Sequencing", () => {
    it("maintains strictly contiguous sequences across mixed task, project, and comment mutations", async () => {
      const { owner, project, columns, task } = await setupWorkspaceProjectAndTask();
      // Initial task creation was seq 1 (task.created)

      // 1. Task update -> seq 2 (task.updated)
      const updateTaskRes = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({
          title: "Interleaved Task Renamed",
          expectedVersion: 1,
        }),
      });
      expect(updateTaskRes.status).toBe(200);

      // 2. Create comment -> seq 3 (comment.created)
      const createCommRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "interleave-comm-1",
        },
        body: JSON.stringify({ body: "Interleaved comment" }),
      });
      expect(createCommRes.status).toBe(201);
      const { comment: comm } = await createCommRes.json();

      // 3. Task move -> seq 4 (task.moved)
      const targetColId = columns[1].id;
      const moveRes = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({
          columnId: targetColId,
          expectedVersion: 2,
        }),
      });
      expect(moveRes.status).toBe(200);

      // 4. Delete comment -> seq 5 (comment.deleted)
      const deleteCommRes = await app.request(`/api/comments/${comm.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });
      expect(deleteCommRes.status).toBe(200);

      // 5. Archive task -> seq 6 (task.archived)
      const archiveTaskRes = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ expectedVersion: 3 }),
      });
      expect(archiveTaskRes.status).toBe(200);

      // 6. Project rename -> seq 7 (project.updated)
      const renameProjRes = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ name: "Interleaved Project Renamed" }),
      });
      expect(renameProjRes.status).toBe(200);

      // 7. Project archive -> seq 8 (project.archived)
      const archiveProjRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveProjRes.status).toBe(200);

      // 8. Project restore -> seq 9 (project.restored)
      const restoreProjRes = await app.request(`/api/projects/${project.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(restoreProjRes.status).toBe(200);

      // Query all project events in order
      const allEvents = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .orderBy(asc(projectEvents.seq));

      expect(allEvents).toHaveLength(9);

      const expectedTypes = [
        "task.created",
        "task.updated",
        "comment.created",
        "task.moved",
        "comment.deleted",
        "task.archived",
        "project.updated",
        "project.archived",
        "project.restored",
      ];

      for (let i = 0; i < 9; i++) {
        expect(allEvents[i]!.seq).toBe(i + 1);
        expect(allEvents[i]!.eventType).toBe(expectedTypes[i]);
      }

      // Check project row lastSeq matches 9
      const [finalProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(finalProject!.lastSeq).toBe(9);
    });
  });

  // ============================================================================
  // Scenario I: Notification Listener Helper Robustness
  // ============================================================================
  describe("Scenario I: Notification Listener Helper Robustness", () => {
    it("rejects concurrent waitForNotification calls on the same listener", async () => {
      const listener = await createNotificationListener();

      try {
        const p1 = listener.waitForNotification(999, undefined, 2000);
        const p1Expectation = expect(p1).rejects.toThrow(
          "Notification listener was cleaned up while a waiter was still pending"
        );

        // Attempt concurrent second wait call before p1 completes
        await expect(listener.waitForNotification(1000)).rejects.toThrow(
          "Concurrent waitForNotification calls are not supported; a waiter for seq=999 is already active."
        );

        // Cleanup listener rejects active p1 safely
        await listener.cleanup();
        await p1Expectation;
      } finally {
        await listener.cleanup();
      }
    });

    it("clears waiter state on timeout without leaving stale references", async () => {
      const listener = await createNotificationListener();

      try {
        await expect(listener.waitForNotification(9999, undefined, 50)).rejects.toThrow(
          "Timed out waiting for notification seq=9999"
        );

        // After timeout has elapsed and waiter is cleared, a subsequent sequential wait can be registered without collision
        const p2 = listener.waitForNotification(9998, undefined, 50);
        await expect(p2).rejects.toThrow("Timed out waiting for notification seq=9998");
      } finally {
        await listener.cleanup();
      }
    });
  });
});

