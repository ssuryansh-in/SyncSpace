import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, or } from "drizzle-orm";
import postgres from "postgres";
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
  idempotencyRecords,
} from "../../src/db/schema/index.js";
import { cleanTables, testDb, testSqlClient } from "./setup.js";

describe("Task Comments Management & Idempotency (Integration - Milestone 6.3)", () => {
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
   * Helper to set up a workspace, a project, and a task
   */
  async function setupWorkspaceProjectAndTask(ownerName = "Owner User", ownerEmail = "owner-comm@example.com") {
    const owner = await createAndLoginUser(ownerName, ownerEmail);

    const wsRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Comment Workspace" }),
    });
    const { workspace } = await wsRes.json();

    const projRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Comment Project" }),
    });
    const { project, columns } = await projRes.json();

    const taskRes = await app.request(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ title: "Target Task", columnId: columns[0].id }),
    });
    const { task } = await taskRes.json();

    return { owner, workspace, project, columns, task };
  }

  /**
   * Helper to observe in PostgreSQL whether an application request is actively
   * blocked on a row lock held by a specific barrier backend connection.
   */
  async function waitForBlockedByBarrier(
    monitorSql: postgres.Sql,
    barrierPid: number,
    expectedTable: string,
    timeoutMs = 4000
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
        const candidate = rows.find((r: any) => r.query && r.query.includes(expectedTable));
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

  describe("POST /api/tasks/:taskId/comments - Comment Creation", () => {
    it("creates a comment with valid body and returns 201 with comment and author metadata", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "create-comm-1",
        },
        body: JSON.stringify({ body: "This is a great comment." }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.comment).toBeDefined();
      expect(data.comment.id).toBeDefined();
      expect(data.comment.taskId).toBe(task.id);
      expect(data.comment.authorId).toBe(owner.user.id);
      expect(data.comment.author).toEqual({
        id: owner.user.id,
        name: owner.user.displayName,
      });
      expect(data.comment.body).toBe("This is a great comment.");
      expect(data.comment.createdAt).toBeDefined();
      expect(data.comment.deletedAt).toBeNull();

      // Verify DB row
      const [dbComment] = await testDb
        .select()
        .from(comments)
        .where(eq(comments.id, data.comment.id));
      expect(dbComment).toBeDefined();
      expect(dbComment.body).toBe("This is a great comment.");
      expect(dbComment.deletedAt).toBeNull();
    });

    it("trims leading and trailing whitespace from comment body", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "create-comm-trim",
        },
        body: JSON.stringify({ body: "   Leading and trailing whitespace trimmed   " }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.comment.body).toBe("Leading and trailing whitespace trimmed");
    });

    it("rejects empty body with 400 VALIDATION_ERROR", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "create-comm-empty",
        },
        body: JSON.stringify({ body: "" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects whitespace-only body with 400 VALIDATION_ERROR", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "create-comm-whitespace",
        },
        body: JSON.stringify({ body: "    " }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects body exceeding 10,000 characters with 400 VALIDATION_ERROR", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();
      const longBody = "a".repeat(10001);

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "create-comm-long",
        },
        body: JSON.stringify({ body: longBody }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects request missing Idempotency-Key header with 400 VALIDATION_ERROR", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ body: "Valid comment text" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Idempotency-Key");
    });

    it("rejects empty or overlong Idempotency-Key header (>128 chars) with 400 VALIDATION_ERROR", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      // Empty key
      const resEmpty = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "   ",
        },
        body: JSON.stringify({ body: "Valid comment text" }),
      });
      expect(resEmpty.status).toBe(400);

      // Overlong key (>128 chars)
      const resLong = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "k".repeat(129),
        },
        body: JSON.stringify({ body: "Valid comment text" }),
      });
      expect(resLong.status).toBe(400);
    });

    it("rejects unauthenticated creation with 401 UNAUTHENTICATED", async () => {
      const { task } = await setupWorkspaceProjectAndTask();

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "create-unauth",
        },
        body: JSON.stringify({ body: "Unauthenticated attempt" }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHENTICATED");
    });

    it("returns 404 NOT_FOUND for non-member creating comment (tenant concealment)", async () => {
      const { task } = await setupWorkspaceProjectAndTask();
      const outsider = await createAndLoginUser("Outsider User", "outsider-comm@example.com");

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: outsider.cookie,
          "Idempotency-Key": "create-outsider",
        },
        body: JSON.stringify({ body: "Attempting access across workspace" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("returns 404 NOT_FOUND for nonexistent task", async () => {
      const { owner } = await setupWorkspaceProjectAndTask();
      const fakeTaskId = "00000000-0000-0000-0000-000000000001";

      const res = await app.request(`/api/tasks/${fakeTaskId}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "create-fake-task",
        },
        body: JSON.stringify({ body: "Nonexistent task" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("rejects invalid task UUID format with 400 VALIDATION_ERROR", async () => {
      const { owner } = await setupWorkspaceProjectAndTask();

      const res = await app.request("/api/tasks/not-a-valid-uuid/comments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "create-invalid-uuid",
        },
        body: JSON.stringify({ body: "Invalid UUID test" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects creating comment on an archived task with 409 TASK_ARCHIVED", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      // Soft delete task
      await testDb
        .update(tasks)
        .set({ archivedAt: new Date() })
        .where(eq(tasks.id, task.id));

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "create-archived-task",
        },
        body: JSON.stringify({ body: "Comment on archived task" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("TASK_ARCHIVED");
    });

    it("rejects creating comment in an archived project with 409 PROJECT_ARCHIVED", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      // Archive project
      const archiveRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes.status).toBe(200);

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "create-archived-proj",
        },
        body: JSON.stringify({ body: "Comment in archived project" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("PROJECT_ARCHIVED");
    });

    it("allows all three workspace roles (Owner, Admin, Member) to create comments", async () => {
      const { owner, workspace, task } = await setupWorkspaceProjectAndTask();

      const adminUser = await createAndLoginUser("Admin User", "admin-comm@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: adminUser.user.id,
        role: "admin",
      });

      const memberUser = await createAndLoginUser("Member User", "member-comm@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: memberUser.user.id,
        role: "member",
      });

      // Admin creates comment
      const adminRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminUser.cookie,
          "Idempotency-Key": "create-admin",
        },
        body: JSON.stringify({ body: "Admin comment" }),
      });
      expect(adminRes.status).toBe(201);
      const adminData = await adminRes.json();
      expect(adminData.comment.authorId).toBe(adminUser.user.id);

      // Member creates comment
      const memberRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: memberUser.cookie,
          "Idempotency-Key": "create-member",
        },
        body: JSON.stringify({ body: "Member comment" }),
      });
      expect(memberRes.status).toBe(201);
      const memberData = await memberRes.json();
      expect(memberData.comment.authorId).toBe(memberUser.user.id);
    });

    it("derives author identity exclusively from session (client cannot spoof authorId)", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();
      const fakeAuthorId = "00000000-0000-0000-0000-000000000999";

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "create-spoof",
        },
        body: JSON.stringify({
          body: "Trying to spoof author",
          authorId: fakeAuthorId,
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.comment.authorId).toBe(owner.user.id);
      expect(data.comment.authorId).not.toBe(fakeAuthorId);
    });
  });

  describe("GET /api/tasks/:taskId/comments - Comment Listing", () => {
    it("lists comments for requested task ordered chronologically by created_at ASC, id ASC", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      // Post 3 comments sequentially
      await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "list-comm-1",
        },
        body: JSON.stringify({ body: "Comment 1" }),
      });

      await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "list-comm-2",
        },
        body: JSON.stringify({ body: "Comment 2" }),
      });

      await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "list-comm-3",
        },
        body: JSON.stringify({ body: "Comment 3" }),
      });

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.comments).toHaveLength(3);
      expect(data.comments[0].body).toBe("Comment 1");
      expect(data.comments[1].body).toBe("Comment 2");
      expect(data.comments[2].body).toBe("Comment 3");
      expect(data.comments[0].author).toEqual({
        id: owner.user.id,
        name: owner.user.displayName,
      });
    });

    it("excludes soft-deleted comments from listing", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const c1Res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "del-list-1",
        },
        body: JSON.stringify({ body: "Visible Comment" }),
      });
      const { comment: c1 } = await c1Res.json();

      const c2Res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "del-list-2",
        },
        body: JSON.stringify({ body: "To be soft-deleted" }),
      });
      const { comment: c2 } = await c2Res.json();

      // Soft delete c2
      await app.request(`/api/comments/${c2.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });

      const listRes = await app.request(`/api/tasks/${task.id}/comments`, {
        headers: { Cookie: owner.cookie },
      });

      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.comments).toHaveLength(1);
      expect(listData.comments[0].id).toBe(c1.id);
      expect(listData.comments.some((c: any) => c.id === c2.id)).toBe(false);
    });

    it("returns an empty array when task has no comments", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.comments).toEqual([]);
    });

    it("allows reading comments on archived tasks (read-only history inspection)", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "arch-read-comm",
        },
        body: JSON.stringify({ body: "Historical note" }),
      });

      // Archive task
      await testDb
        .update(tasks)
        .set({ archivedAt: new Date() })
        .where(eq(tasks.id, task.id));

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.comments).toHaveLength(1);
      expect(data.comments[0].body).toBe("Historical note");
    });

    it("allows reading comments belonging to tasks in archived projects", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "arch-proj-comm",
        },
        body: JSON.stringify({ body: "Project history note" }),
      });

      // Archive project
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.comments).toHaveLength(1);
      expect(data.comments[0].body).toBe("Project history note");
    });

    it("rejects unauthenticated listing with 401 UNAUTHENTICATED", async () => {
      const { task } = await setupWorkspaceProjectAndTask();

      const res = await app.request(`/api/tasks/${task.id}/comments`);
      expect(res.status).toBe(401);
    });

    it("returns 404 NOT_FOUND for non-member listing comments (tenant concealment)", async () => {
      const { task } = await setupWorkspaceProjectAndTask();
      const outsider = await createAndLoginUser("Outsider Get", "outsider-get-c@example.com");

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        headers: { Cookie: outsider.cookie },
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 NOT_FOUND for nonexistent task", async () => {
      const { owner } = await setupWorkspaceProjectAndTask();
      const fakeId = "00000000-0000-0000-0000-000000000001";

      const res = await app.request(`/api/tasks/${fakeId}/comments`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(404);
    });

    it("rejects invalid task UUID with 400 VALIDATION_ERROR", async () => {
      const { owner } = await setupWorkspaceProjectAndTask();

      const res = await app.request("/api/tasks/not-a-uuid/comments", {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(400);
    });

    it("never returns comments belonging to another task", async () => {
      const { owner, project, columns, task } = await setupWorkspaceProjectAndTask();

      // Create a second task
      const task2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Task 2", columnId: columns[0].id }),
      });
      const { task: task2 } = await task2Res.json();

      // Comment on task 1
      await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "task1-comm",
        },
        body: JSON.stringify({ body: "Task 1 specific comment" }),
      });

      // Comment on task 2
      await app.request(`/api/tasks/${task2.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "task2-comm",
        },
        body: JSON.stringify({ body: "Task 2 specific comment" }),
      });

      // Retrieve task 1 comments
      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        headers: { Cookie: owner.cookie },
      });
      const data = await res.json();
      expect(data.comments).toHaveLength(1);
      expect(data.comments[0].body).toBe("Task 1 specific comment");
    });
  });

  describe("DELETE /api/comments/:commentId - Comment Soft Deletion", () => {
    it("allows author to delete their own comment (sets deletedAt)", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const postRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "author-del-key",
        },
        body: JSON.stringify({ body: "To delete" }),
      });
      const { comment } = await postRes.json();

      const delRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });

      expect(delRes.status).toBe(200);
      const delData = await delRes.json();
      expect(delData.status).toBe(true);

      // Verify row is soft deleted in DB (not physically removed)
      const [dbComment] = await testDb
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id));
      expect(dbComment).toBeDefined();
      expect(dbComment.deletedAt).not.toBeNull();
    });

    it("allows workspace Owner to delete another member's comment", async () => {
      const { owner, workspace, task } = await setupWorkspaceProjectAndTask();

      const member = await createAndLoginUser("Regular Member", "reg-del-1@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const postRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: member.cookie,
          "Idempotency-Key": "member-post-key",
        },
        body: JSON.stringify({ body: "Member wrote this" }),
      });
      const { comment } = await postRes.json();

      // Owner deletes member's comment
      const delRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });

      expect(delRes.status).toBe(200);
      const [dbComment] = await testDb
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id));
      expect(dbComment.deletedAt).not.toBeNull();
    });

    it("allows workspace Admin to delete another member's comment", async () => {
      const { workspace, task } = await setupWorkspaceProjectAndTask();

      const admin = await createAndLoginUser("Admin User", "admin-del-1@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: admin.user.id,
        role: "admin",
      });

      const member = await createAndLoginUser("Regular Member 2", "reg-del-2@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const postRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: member.cookie,
          "Idempotency-Key": "member-post-key-2",
        },
        body: JSON.stringify({ body: "Member wrote this too" }),
      });
      const { comment } = await postRes.json();

      // Admin deletes member's comment
      const delRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: admin.cookie },
      });

      expect(delRes.status).toBe(200);
      const [dbComment] = await testDb
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id));
      expect(dbComment.deletedAt).not.toBeNull();
    });

    it("rejects regular Member attempting to delete another member's comment with 403 FORBIDDEN", async () => {
      const { workspace, task } = await setupWorkspaceProjectAndTask();

      const member1 = await createAndLoginUser("Member One", "m1-del@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member1.user.id,
        role: "member",
      });

      const member2 = await createAndLoginUser("Member Two", "m2-del@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member2.user.id,
        role: "member",
      });

      const postRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: member1.cookie,
          "Idempotency-Key": "m1-post-key",
        },
        body: JSON.stringify({ body: "Written by Member 1" }),
      });
      const { comment } = await postRes.json();

      // Member 2 attempts to delete Member 1's comment
      const delRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: member2.cookie },
      });

      expect(delRes.status).toBe(403);
      const body = await delRes.json();
      expect(body.error.code).toBe("FORBIDDEN");

      // Verify comment remains active in DB
      const [dbComment] = await testDb
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id));
      expect(dbComment.deletedAt).toBeNull();
    });

    it("is an idempotent no-op when deleting an already deleted comment (preserves original deletedAt)", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const postRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "double-del-key",
        },
        body: JSON.stringify({ body: "Double delete me" }),
      });
      const { comment } = await postRes.json();

      // First delete
      const del1Res = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });
      expect(del1Res.status).toBe(200);

      const [db1] = await testDb.select().from(comments).where(eq(comments.id, comment.id));
      const firstDeletedAt = db1.deletedAt;

      // Second delete
      const del2Res = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });
      expect(del2Res.status).toBe(200);

      const [db2] = await testDb.select().from(comments).where(eq(comments.id, comment.id));
      expect(db2.deletedAt?.getTime()).toBe(firstDeletedAt?.getTime());
    });

    it("rejects deleting comment on an archived task with 409 TASK_ARCHIVED", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const postRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "del-arch-task-key",
        },
        body: JSON.stringify({ body: "Before task archival" }),
      });
      const { comment } = await postRes.json();

      // Archive task
      await testDb
        .update(tasks)
        .set({ archivedAt: new Date() })
        .where(eq(tasks.id, task.id));

      const delRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });

      expect(delRes.status).toBe(409);
      const body = await delRes.json();
      expect(body.error.code).toBe("TASK_ARCHIVED");
    });

    it("rejects deleting comment in an archived project with 409 PROJECT_ARCHIVED", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      const postRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "del-arch-proj-key",
        },
        body: JSON.stringify({ body: "Before project archival" }),
      });
      const { comment } = await postRes.json();

      // Archive project
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      const delRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });

      expect(delRes.status).toBe(409);
      const body = await delRes.json();
      expect(body.error.code).toBe("PROJECT_ARCHIVED");
    });

    it("rejects unauthenticated deletion with 401 UNAUTHENTICATED", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const postRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "unauth-del-key",
        },
        body: JSON.stringify({ body: "Will try unauth delete" }),
      });
      const { comment } = await postRes.json();

      const delRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(401);
    });

    it("returns 404 NOT_FOUND for non-member deleting comment (tenant concealment)", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();
      const outsider = await createAndLoginUser("Outsider Del", "outsider-del-c@example.com");

      const postRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "outsider-del-key",
        },
        body: JSON.stringify({ body: "Secret comment" }),
      });
      const { comment } = await postRes.json();

      const delRes = await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: outsider.cookie },
      });
      expect(delRes.status).toBe(404);
    });

    it("returns 404 NOT_FOUND for nonexistent comment", async () => {
      const { owner } = await setupWorkspaceProjectAndTask();
      const fakeCommentId = "00000000-0000-0000-0000-000000000001";

      const delRes = await app.request(`/api/comments/${fakeCommentId}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });
      expect(delRes.status).toBe(404);
    });

    it("rejects invalid comment UUID with 400 VALIDATION_ERROR", async () => {
      const { owner } = await setupWorkspaceProjectAndTask();

      const delRes = await app.request("/api/comments/not-a-valid-uuid", {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });
      expect(delRes.status).toBe(400);
    });
  });

  describe("Comment Deletion Lifecycle Synchronization (Real PostgreSQL Locks)", () => {
    it("synchronizes with concurrent task archival: blocks on tasks row lock and returns 409 TASK_ARCHIVED when archival commits first", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const postRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "det-task-race-1",
        },
        body: JSON.stringify({ body: "Task race test comment" }),
      });
      const { comment } = await postRes.json();

      // Establish barrier connection
      const barrier = postgres(testEnv.DATABASE_URL, { max: 1 });
      try {
        const [{ pid: barrierPid }] = await barrier`SELECT pg_backend_pid() as pid`;

        await barrier`BEGIN`;
        await barrier`SELECT id FROM tasks WHERE id = ${task.id} FOR UPDATE`;
        await barrier`UPDATE tasks SET archived_at = NOW(), version = version + 1 WHERE id = ${task.id}`;

        // Launch deleteComment HTTP request; it must reach PostgreSQL and block on the tasks row lock
        const deletePromise = app.request(`/api/comments/${comment.id}`, {
          method: "DELETE",
          headers: { Cookie: owner.cookie },
        });

        // Verify through pg_stat_activity and pg_locks that the deletion query is specifically waiting on this barrier PID on tasks
        const blockedProcess = await waitForBlockedByBarrier(testSqlClient, Number(barrierPid), "tasks");
        expect(blockedProcess.pid).toBeDefined();

        // Commit task archival, releasing the lock with archived_at populated
        await barrier`COMMIT`;

        // The deletion request unblocks, re-reads the task row, and rejects with 409 TASK_ARCHIVED
        const delRes = await deletePromise;
        expect(delRes.status).toBe(409);
        const delBody = await delRes.json();
        expect(delBody.error.code).toBe("TASK_ARCHIVED");

        // Verify database state: comment is NOT deleted, task IS archived
        const [dbComment] = await testDb.select().from(comments).where(eq(comments.id, comment.id));
        expect(dbComment.deletedAt).toBeNull();

        const [dbTask] = await testDb.select().from(tasks).where(eq(tasks.id, task.id));
        expect(dbTask.archivedAt).not.toBeNull();
      } finally {
        await barrier`ROLLBACK`.catch(() => {});
        await barrier.end({ timeout: 2 }).catch(() => {});
      }
    });

    it("synchronizes with concurrent project archival: blocks on projects row lock and returns 409 PROJECT_ARCHIVED when archival commits first", async () => {
      const { owner, project, task } = await setupWorkspaceProjectAndTask();

      const postRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "det-proj-race-1",
        },
        body: JSON.stringify({ body: "Project race test comment" }),
      });
      const { comment } = await postRes.json();

      // Establish barrier connection
      const barrier = postgres(testEnv.DATABASE_URL, { max: 1 });
      try {
        const [{ pid: barrierPid }] = await barrier`SELECT pg_backend_pid() as pid`;

        await barrier`BEGIN`;
        await barrier`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`;
        await barrier`UPDATE projects SET archived_at = NOW(), updated_at = NOW() WHERE id = ${project.id}`;

        // Launch deleteComment HTTP request; it must reach PostgreSQL and block on the projects row lock
        const deletePromise = app.request(`/api/comments/${comment.id}`, {
          method: "DELETE",
          headers: { Cookie: owner.cookie },
        });

        // Verify through pg_stat_activity and pg_locks that the deletion query is specifically waiting on this barrier PID on projects
        const blockedProcess = await waitForBlockedByBarrier(testSqlClient, Number(barrierPid), "projects");
        expect(blockedProcess.pid).toBeDefined();

        // Commit project archival, releasing the lock with archived_at populated
        await barrier`COMMIT`;

        // The deletion request unblocks, re-reads the project row, and rejects with 409 PROJECT_ARCHIVED
        const delRes = await deletePromise;
        expect(delRes.status).toBe(409);
        const delBody = await delRes.json();
        expect(delBody.error.code).toBe("PROJECT_ARCHIVED");

        // Verify database state: comment is NOT deleted, project IS archived
        const [dbComment] = await testDb.select().from(comments).where(eq(comments.id, comment.id));
        expect(dbComment.deletedAt).toBeNull();

        const [dbProject] = await testDb.select().from(projects).where(eq(projects.id, project.id));
        expect(dbProject.archivedAt).not.toBeNull();
      } finally {
        await barrier`ROLLBACK`.catch(() => {});
        await barrier.end({ timeout: 2 }).catch(() => {});
      }
    });
  });

  describe("Task Comments Idempotency & Concurrency (Real PostgreSQL)", () => {
    it("creates exactly one comment when first request with a new key is processed", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "first-key-unique",
        },
        body: JSON.stringify({ body: "Single comment creation" }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.comment).toBeDefined();

      // Verify DB has exactly 1 idempotency record
      const records = await testDb
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.actorId, owner.user.id),
            eq(idempotencyRecords.idempotencyKey, "first-key-unique")
          )
        );
      expect(records).toHaveLength(1);
      expect(records[0].endpointKey).toBe("comments:create");
      expect(records[0].responseStatus).toBe(201);
    });

    it("replays original result without creating duplicate comment when repeated with same key and payload", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const res1 = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "replay-key-1",
        },
        body: JSON.stringify({ body: "Replayed comment content" }),
      });
      expect(res1.status).toBe(201);
      const data1 = await res1.json();

      // Repeated request with same key and payload
      const res2 = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "replay-key-1",
        },
        body: JSON.stringify({ body: "Replayed comment content" }),
      });

      expect(res2.status).toBe(201);
      const data2 = await res2.json();
      expect(data2.comment.id).toBe(data1.comment.id);
      expect(data2.comment.createdAt).toBe(data1.comment.createdAt);

      // Verify DB comment count is still 1
      const dbComments = await testDb
        .select()
        .from(comments)
        .where(eq(comments.taskId, task.id));
      expect(dbComments).toHaveLength(1);
    });

    it("rejects reused key with different payload with 409 IDEMPOTENCY_KEY_REUSED", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      // First call
      const res1 = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "conflict-key-1",
        },
        body: JSON.stringify({ body: "Original payload" }),
      });
      expect(res1.status).toBe(201);

      // Second call with same key but different body
      const res2 = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "conflict-key-1",
        },
        body: JSON.stringify({ body: "Tampered or modified payload" }),
      });

      expect(res2.status).toBe(409);
      const body = await res2.json();
      expect(body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

      // Verify no second comment was created
      const dbComments = await testDb.select().from(comments).where(eq(comments.taskId, task.id));
      expect(dbComments).toHaveLength(1);
    });

    it("allows different actors to use independent idempotency scopes with the same key name", async () => {
      const { owner, workspace, task } = await setupWorkspaceProjectAndTask();

      const member = await createAndLoginUser("Other Member", "other-actor@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      // Owner uses key "shared-key"
      const resOwner = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "shared-key",
        },
        body: JSON.stringify({ body: "Owner comment with shared-key" }),
      });
      expect(resOwner.status).toBe(201);

      // Member uses the exact same key "shared-key"
      const resMember = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: member.cookie,
          "Idempotency-Key": "shared-key",
        },
        body: JSON.stringify({ body: "Member comment with shared-key" }),
      });
      expect(resMember.status).toBe(201);

      // Both comments created independently
      const dbComments = await testDb.select().from(comments).where(eq(comments.taskId, task.id));
      expect(dbComments).toHaveLength(2);
    });

    it("scopes idempotency keys by endpoint/path so reusing key on different task yields 409 IDEMPOTENCY_KEY_REUSED", async () => {
      const { owner, project, columns, task: task1 } = await setupWorkspaceProjectAndTask();

      const task2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Task 2", columnId: columns[0].id }),
      });
      const { task: task2 } = await task2Res.json();

      // Post on Task 1 with key "cross-task-key"
      const res1 = await app.request(`/api/tasks/${task1.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "cross-task-key",
        },
        body: JSON.stringify({ body: "Comment on task 1" }),
      });
      expect(res1.status).toBe(201);

      // Post on Task 2 with same key "cross-task-key"
      const res2 = await app.request(`/api/tasks/${task2.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "cross-task-key",
        },
        body: JSON.stringify({ body: "Comment on task 1" }),
      });

      expect(res2.status).toBe(409);
      const body = await res2.json();
      expect(body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("handles two genuinely concurrent HTTP requests with same key and payload (creates exactly 1 comment, replays original response)", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      // Launch two parallel requests via Promise.all
      const [res1, res2] = await Promise.all([
        app.request(`/api/tasks/${task.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": "concurrent-dup-key",
          },
          body: JSON.stringify({ body: "Concurrent duplicate comment" }),
        }),
        app.request(`/api/tasks/${task.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": "concurrent-dup-key",
          },
          body: JSON.stringify({ body: "Concurrent duplicate comment" }),
        }),
      ]);

      // Both should return 201 Created
      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);

      const data1 = await res1.json();
      const data2 = await res2.json();
      expect(data1.comment.id).toBe(data2.comment.id);

      // In DB, exactly one comment must exist
      const dbComments = await testDb
        .select()
        .from(comments)
        .where(eq(comments.taskId, task.id));
      expect(dbComments).toHaveLength(1);

      // In DB, exactly one idempotency record must exist
      const records = await testDb
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.actorId, owner.user.id),
            eq(idempotencyRecords.idempotencyKey, "concurrent-dup-key")
          )
        );
      expect(records).toHaveLength(1);
    });

    it("handles concurrent same-key requests with different payloads (one succeeds, other gets 409 IDEMPOTENCY_KEY_REUSED)", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      const [res1, res2] = await Promise.all([
        app.request(`/api/tasks/${task.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": "concurrent-diff-key",
          },
          body: JSON.stringify({ body: "Payload A" }),
        }),
        app.request(`/api/tasks/${task.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": "concurrent-diff-key",
          },
          body: JSON.stringify({ body: "Payload B" }),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);

      const conflictRes = res1.status === 409 ? res1 : res2;
      const conflictBody = await conflictRes.json();
      expect(conflictBody.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

      // Exactly 1 comment in DB
      const dbComments = await testDb
        .select()
        .from(comments)
        .where(eq(comments.taskId, task.id));
      expect(dbComments).toHaveLength(1);
    });

    it("does not leave a persisted idempotency record or partial comment after a failed transaction", async () => {
      const { owner, task } = await setupWorkspaceProjectAndTask();

      // Archive task to cause a transaction failure
      await testDb
        .update(tasks)
        .set({ archivedAt: new Date() })
        .where(eq(tasks.id, task.id));

      const res = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "fail-key-1",
        },
        body: JSON.stringify({ body: "Failed attempt" }),
      });
      expect(res.status).toBe(409);

      // Verify no comment was created
      const dbComments = await testDb.select().from(comments).where(eq(comments.taskId, task.id));
      expect(dbComments).toHaveLength(0);

      // Verify no idempotency record was created
      const records = await testDb
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.actorId, owner.user.id),
            eq(idempotencyRecords.idempotencyKey, "fail-key-1")
          )
        );
      expect(records).toHaveLength(0);
    });

    it("handles concurrent same-key requests targeting different tasks (externally observable concurrency test)", async () => {
      const { owner, project, columns, task: task1 } = await setupWorkspaceProjectAndTask();

      // Create a second task in the same project
      const task2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Task 2 for cross-task collision", columnId: columns[0].id }),
      });
      const { task: task2 } = await task2Res.json();

      const sharedKey = "cross-task-concurrent-key";

      // Concurrently submit comment creation requests using the same actor and idempotency key,
      // but different task IDs and request paths.
      // Note: This is an externally observable concurrency test; we do not claim it deterministically
      // exercises the internal 23505 catch branch without intrusive production instrumentation.
      const [res1, res2] = await Promise.all([
        app.request(`/api/tasks/${task1.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": sharedKey,
          },
          body: JSON.stringify({ body: "Comment on task 1" }),
        }),
        app.request(`/api/tasks/${task2.id}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": sharedKey,
          },
          body: JSON.stringify({ body: "Comment on task 2" }),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);

      const conflictRes = res1.status === 409 ? res1 : res2;
      const conflictBody = await conflictRes.json();
      expect(conflictBody.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

      // Verify that across both tasks, exactly one comment was persisted
      const dbComments = await testDb
        .select()
        .from(comments)
        .where(or(eq(comments.taskId, task1.id), eq(comments.taskId, task2.id)));
      expect(dbComments).toHaveLength(1);

      // Verify that no partial comment row remains for the losing task
      const winningTaskId = dbComments[0].taskId;
      const losingTaskId = winningTaskId === task1.id ? task2.id : task1.id;
      const losingComments = await testDb
        .select()
        .from(comments)
        .where(eq(comments.taskId, losingTaskId));
      expect(losingComments).toHaveLength(0);

      // Verify exactly one idempotency record was persisted
      const records = await testDb
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.actorId, owner.user.id),
            eq(idempotencyRecords.idempotencyKey, sharedKey)
          )
        );
      expect(records).toHaveLength(1);
    });
  });
});

