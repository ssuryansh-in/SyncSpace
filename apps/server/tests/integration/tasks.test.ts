import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth/index.js";
import { createEmailService, clearSentEmailsForTest } from "../../src/services/email.js";
import { loadEnv } from "../../src/config/env.js";
import { IdempotencyService } from "../../src/services/idempotency.js";
import { TaskService } from "../../src/services/task.js";
import { REBALANCE_THRESHOLD_LENGTH } from "../../src/utils/fractional-indexing.js";
import {
  users,
  workspaces,
  workspaceMembers,
  projects,
  projectColumns,
  tasks,
  idempotencyRecords,
} from "../../src/db/schema/index.js";
import { cleanTables, testDb, testSqlClient } from "./setup.js";

describe("Tasks Management, Editing, Movement & Lifecycle (Integration - Milestone 6)", () => {
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
  async function setupWorkspaceAndProject(ownerName = "Owner User", ownerEmail = "owner@example.com") {
    const owner = await createAndLoginUser(ownerName, ownerEmail);

    const wsRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Test Workspace" }),
    });
    const { workspace } = await wsRes.json();

    const projRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Test Project" }),
    });
    const { project, columns } = await projRes.json();

    return { owner, workspace, project, columns };
  }

  describe("Task Creation (POST /api/projects/:projectId/tasks)", () => {
    it("creates a task with required fields and applies defaults", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const backlogCol = columns.find((c: any) => c.name === "Backlog");

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Initial Task",
          columnId: backlogCol.id,
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.task).toBeDefined();
      expect(data.task.title).toBe("Initial Task");
      expect(data.task.description).toBe("");
      expect(data.task.projectId).toBe(project.id);
      expect(data.task.columnId).toBe(backlogCol.id);
      expect(data.task.createdBy).toBe(owner.user.id);
      expect(data.task.assigneeId).toBeNull();
      expect(data.task.dueDate).toBeNull();
      expect(data.task.version).toBe(1);
      expect(data.task.rankKey).toBe("a0");
      expect(data.task.archivedAt).toBeNull();

      // Verify in DB
      const [dbTask] = await testDb
        .select()
        .from(tasks)
        .where(eq(tasks.id, data.task.id));
      expect(dbTask).toBeDefined();
      expect(dbTask.title).toBe("Initial Task");
    });

    it("creates a task with all optional fields and trims title/description", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const member = await createAndLoginUser("Member User", "member-opt@example.com");

      // Add member to workspace
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const todoCol = columns.find((c: any) => c.name === "Todo");

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "  Task with Details  ",
          description: "  A thorough description  ",
          columnId: todoCol.id,
          assigneeId: member.user.id,
          dueDate: "2026-12-31",
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.task.title).toBe("Task with Details");
      expect(data.task.description).toBe("A thorough description");
      expect(data.task.assigneeId).toBe(member.user.id);
      expect(data.task.dueDate).toBe("2026-12-31");
    });

    it("rejects empty or whitespace-only title with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "   ",
          columnId: columns[0].id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects invalid project UUID or column UUID with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Invalid project ID
      const res1 = await app.request("/api/projects/not-a-uuid/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Test",
          columnId: columns[0].id,
        }),
      });
      expect(res1.status).toBe(400);
      expect((await res1.json()).error.code).toBe("VALIDATION_ERROR");

      // Invalid column ID
      const res2 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Test",
          columnId: "invalid-uuid",
        }),
      });
      expect(res2.status).toBe(400);
      expect((await res2.json()).error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects nonexistent column with 400 VALIDATION_ERROR", async () => {
      const { owner, project } = await setupWorkspaceAndProject();
      const nonexistentColId = "00000000-0000-0000-0000-000000000099";

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Test Task",
          columnId: nonexistentColId,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects cross-project column reference with 400 VALIDATION_ERROR", async () => {
      const { owner, workspace, project: projectA } = await setupWorkspaceAndProject();

      // Create a second project in the same workspace
      const projBRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Project B" }),
      });
      const { columns: columnsB } = await projBRes.json();

      // Attempt to create a task in Project A using Column from Project B
      const res = await app.request(`/api/projects/${projectA.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Infiltrator Task",
          columnId: columnsB[0].id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Column does not belong to this project");
    });

    it("rejects task creation in an archived project with 409 PROJECT_ARCHIVED", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Archive the project
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Post-Archive Task",
          columnId: columns[0].id,
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("PROJECT_ARCHIVED");
    });

    it("returns 401 UNAUTHENTICATED when unauthenticated", async () => {
      const { project, columns } = await setupWorkspaceAndProject();

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Unauth Task",
          columnId: columns[0].id,
        }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHENTICATED");
    });

    it("returns 404 NOT_FOUND for non-member (tenant concealment)", async () => {
      const { project, columns } = await setupWorkspaceAndProject();
      const outsider = await createAndLoginUser("Outsider", "outsider-create@example.com");

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: outsider.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Outsider Task",
          columnId: columns[0].id,
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("allows Owner, Admin, and Member roles to create tasks", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();

      const admin = await createAndLoginUser("Admin", "admin-role@example.com");
      const member = await createAndLoginUser("Member", "member-role@example.com");

      await testDb.insert(workspaceMembers).values([
        { workspaceId: workspace.id, userId: admin.user.id, role: "admin" },
        { workspaceId: workspace.id, userId: member.user.id, role: "member" },
      ]);

      // 1. Admin creates task
      const adminRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: admin.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Admin Task", columnId: columns[0].id }),
      });
      expect(adminRes.status).toBe(201);

      // 2. Member creates task
      const memberRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: member.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Member Task", columnId: columns[1].id }),
      });
      expect(memberRes.status).toBe(201);
    });

    it("generates sequential strictly increasing fractional rank keys ('a0', 'a1', 'a2') when appending to the same column", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const columnId = columns[0].id;

      // Create 3 tasks sequentially
      const res1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `rank-seq-1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Task One", columnId }),
      });
      expect(res1.status).toBe(201);
      const data1 = await res1.json();
      expect(data1.task.rankKey).toBe("a0");

      const res2 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `rank-seq-2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Task Two", columnId }),
      });
      expect(res2.status).toBe(201);
      const data2 = await res2.json();
      expect(data2.task.rankKey).toBe("a1");

      const res3 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `rank-seq-3-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Task Three", columnId }),
      });
      expect(res3.status).toBe(201);
      const data3 = await res3.json();
      expect(data3.task.rankKey).toBe("a2");

      // Verify lexicographical order
      expect(data1.task.rankKey < data2.task.rankKey).toBe(true);
      expect(data2.task.rankKey < data3.task.rankKey).toBe(true);

      // Verify persisted rank keys in DB
      const dbTasks = await testDb
        .select({ id: tasks.id, rankKey: tasks.rankKey })
        .from(tasks)
        .where(eq(tasks.projectId, project.id))
        .orderBy(asc(tasks.rankKey));

      expect(dbTasks.map((t) => t.rankKey)).toEqual(["a0", "a1", "a2"]);
    });

    it("appends after the last active task when archived tasks exist in the column", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const columnId = columns[0].id;

      // Create Task 1 ('a0')
      const res1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `rank-arch-1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Task 1", columnId }),
      });
      expect(res1.status).toBe(201);
      const { task: task1 } = await res1.json();
      expect(task1.rankKey).toBe("a0");

      // Create Task 2 ('a1')
      const res2 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `rank-arch-2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Task 2", columnId }),
      });
      expect(res2.status).toBe(201);
      const { task: task2 } = await res2.json();
      expect(task2.rankKey).toBe("a1");

      // Archive Task 2
      const archRes = await app.request(`/api/tasks/${task2.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archRes.status).toBe(200);

      // Create Task 3 in same column; last active task is Task 1 ('a0'), so Task 3 should get 'a1'
      const res3 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `rank-arch-3-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Task 3", columnId }),
      });
      expect(res3.status).toBe(201);
      const { task: task3 } = await res3.json();
      expect(task3.rankKey).toBe("a1");

      // Verify active tasks in column
      const activeTasks = await testDb
        .select({ id: tasks.id, rankKey: tasks.rankKey, archivedAt: tasks.archivedAt })
        .from(tasks)
        .where(and(eq(tasks.projectId, project.id), eq(tasks.columnId, columnId), isNull(tasks.archivedAt)))
        .orderBy(asc(tasks.rankKey), asc(tasks.id));

      expect(activeTasks).toHaveLength(2);
      expect(activeTasks[0].id).toBe(task1.id);
      expect(activeTasks[0].rankKey).toBe("a0");
      expect(activeTasks[1].id).toBe(task3.id);
      expect(activeTasks[1].rankKey).toBe("a1");
    });

    it("generates independent rank sequences starting at 'a0' across different columns in the same project", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0Id = columns[0].id;
      const col1Id = columns[1].id;

      // Col 0 - Task 1 -> 'a0'
      const resCol0Task1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `indep-c0-1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Col 0 Task 1", columnId: col0Id }),
      });
      expect(resCol0Task1.status).toBe(201);
      expect((await resCol0Task1.json()).task.rankKey).toBe("a0");

      // Col 1 - Task 1 -> 'a0' (independent column start)
      const resCol1Task1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `indep-c1-1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Col 1 Task 1", columnId: col1Id }),
      });
      expect(resCol1Task1.status).toBe(201);
      expect((await resCol1Task1.json()).task.rankKey).toBe("a0");

      // Col 0 - Task 2 -> 'a1'
      const resCol0Task2 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `indep-c0-2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Col 0 Task 2", columnId: col0Id }),
      });
      expect(resCol0Task2.status).toBe(201);
      expect((await resCol0Task2.json()).task.rankKey).toBe("a1");

      // Col 1 - Task 2 -> 'a1'
      const resCol1Task2 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `indep-c1-2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Col 1 Task 2", columnId: col1Id }),
      });
      expect(resCol1Task2.status).toBe(201);
      expect((await resCol1Task2.json()).task.rankKey).toBe("a1");
    });
  });

  describe("Assignee Validation", () => {
    it("accepts valid active workspace member as assignee", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const member = await createAndLoginUser("Member", "member-assign@example.com");

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Assigned Task",
          columnId: columns[0].id,
          assigneeId: member.user.id,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.task.assigneeId).toBe(member.user.id);
    });

    it("rejects nonexistent user as assignee with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const fakeUserId = "00000000-0000-0000-0000-000000000088";

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Bad Assignee Task",
          columnId: columns[0].id,
          assigneeId: fakeUserId,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Assignee must be an active member of the workspace");
    });

    it("rejects user from another workspace as assignee with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const foreignUser = await createAndLoginUser("Foreign", "foreign-assign@example.com");

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Foreign Assignee Task",
          columnId: columns[0].id,
          assigneeId: foreignUser.user.id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Assignee must be an active member of the workspace");
    });

    it("rejects removed workspace member as assignee with 400 VALIDATION_ERROR", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const member = await createAndLoginUser("Removed Member", "removed-member@example.com");

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      // Remove member
      await app.request(`/api/workspaces/${workspace.id}/members/${member.user.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Task with Ex-Member",
          columnId: columns[0].id,
          assigneeId: member.user.id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Task Listing (GET /api/projects/:projectId/tasks)", () => {
    it("returns active tasks scoped strictly to the project and excludes archived tasks", async () => {
      const { owner, workspace, project: projA, columns: colsA } = await setupWorkspaceAndProject();

      // Create Project B
      const projBRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Project B" }),
      });
      const { project: projB, columns: colsB } = await projBRes.json();

      // Create 2 tasks in Project A
      await app.request(`/api/projects/${projA.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Task A1", columnId: colsA[0].id }),
      });
      const resA2 = await app.request(`/api/projects/${projA.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Task A2", columnId: colsA[1].id }),
      });
      const { task: taskA2 } = await resA2.json();

      // Create 1 task in Project B
      await app.request(`/api/projects/${projB.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Task B1", columnId: colsB[0].id }),
      });

      // Archive task A2 directly in DB to verify archived exclusion
      await testDb
        .update(tasks)
        .set({ archivedAt: new Date() })
        .where(eq(tasks.id, taskA2.id));

      // Fetch tasks for Project A
      const listResA = await app.request(`/api/projects/${projA.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      expect(listResA.status).toBe(200);
      const dataA = await listResA.json();
      expect(dataA.tasks).toHaveLength(1);
      expect(dataA.tasks[0].title).toBe("Task A1");
      expect(dataA.tasks[0].projectId).toBe(projA.id);

      // Fetch tasks for Project B
      const listResB = await app.request(`/api/projects/${projB.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      expect(listResB.status).toBe(200);
      const dataB = await listResB.json();
      expect(dataB.tasks).toHaveLength(1);
      expect(dataB.tasks[0].title).toBe("Task B1");
      expect(dataB.tasks[0].projectId).toBe(projB.id);
    });

    it("filters tasks by columnId", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const backlogCol = columns[0];
      const todoCol = columns[1];

      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Backlog 1", columnId: backlogCol.id }),
      });
      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Todo 1", columnId: todoCol.id }),
      });

      const res = await app.request(`/api/projects/${project.id}/tasks?columnId=${backlogCol.id}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0].title).toBe("Backlog 1");
      expect(data.tasks[0].columnId).toBe(backlogCol.id);
    });

    it("filters tasks by assigneeId", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const member = await createAndLoginUser("Assignee User", "assignee-filter@example.com");

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Assigned Task", columnId: columns[0].id, assigneeId: member.user.id }),
      });
      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Unassigned Task", columnId: columns[0].id }),
      });

      const res = await app.request(`/api/projects/${project.id}/tasks?assigneeId=${member.user.id}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0].title).toBe("Assigned Task");
      expect(data.tasks[0].assigneeId).toBe(member.user.id);
    });

    it("rejects invalid filter UUID with 400 VALIDATION_ERROR", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const res = await app.request(`/api/projects/${project.id}/tasks?columnId=invalid-uuid`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects column filter belonging to another project with 400 VALIDATION_ERROR", async () => {
      const { owner, workspace, project: projA } = await setupWorkspaceAndProject();

      const projBRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Project B" }),
      });
      const { columns: colsB } = await projBRes.json();

      const res = await app.request(`/api/projects/${projA.id}/tasks?columnId=${colsB[0].id}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Column does not belong to this project");
    });

    it("returns empty list for project with no tasks", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tasks).toEqual([]);
    });

    it("returns 404 NOT_FOUND for non-member listing tasks", async () => {
      const { project } = await setupWorkspaceAndProject();
      const outsider = await createAndLoginUser("Outsider", "outsider-list@example.com");

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: outsider.cookie },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("allows members to list tasks in an archived project (read-only history inspection)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Pre-Archive Task", columnId: columns[0].id }),
      });

      // Archive project
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      // List tasks in archived project
      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0].title).toBe("Pre-Archive Task");
    });

    it("returns tasks ordered deterministically by rankKey ASC, id ASC even when creation order differs", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Insert tasks with specific rank keys directly to verify rankKey-based ordering over createdAt
      const now = new Date();
      // Insert Task Middle ('a1') created first
      const [middleTask] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "Middle Task (Created First)",
          rankKey: "a1",
          createdBy: owner.user.id,
          createdAt: new Date(now.getTime() - 2000),
          updatedAt: new Date(now.getTime() - 2000),
        })
        .returning();

      // Insert Task First ('a0') created second
      const [firstTask] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "First Task (Created Second)",
          rankKey: "a0",
          createdBy: owner.user.id,
          createdAt: new Date(now.getTime() - 1000),
          updatedAt: new Date(now.getTime() - 1000),
        })
        .returning();

      // Insert Task Between ('a0V') created last (lexicographically: 'a0' < 'a0V' < 'a1')
      const [betweenTask] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: colId,
          title: "Between Task (Created Last)",
          rankKey: "a0V",
          createdBy: owner.user.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tasks).toHaveLength(3);

      // Verify ordering is strictly by rankKey ASC ('a0' < 'a0V' < 'a1'), not by createdAt
      expect(data.tasks[0].id).toBe(firstTask.id);
      expect(data.tasks[0].rankKey).toBe("a0");

      expect(data.tasks[1].id).toBe(betweenTask.id);
      expect(data.tasks[1].rankKey).toBe("a0V");

      expect(data.tasks[2].id).toBe(middleTask.id);
      expect(data.tasks[2].rankKey).toBe("a1");
    });

    it("preserves deterministic rankKey ASC, id ASC ordering when filtering by columnId", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const targetCol = columns[0];
      const otherCol = columns[1];

      // Add tasks to target column in non-lexical creation order
      const [targetB] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: targetCol.id,
          title: "Target B",
          rankKey: "a1",
          createdBy: owner.user.id,
        })
        .returning();

      const [targetA] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: targetCol.id,
          title: "Target A",
          rankKey: "a0",
          createdBy: owner.user.id,
        })
        .returning();

      // Add task to other column
      await testDb.insert(tasks).values({
        projectId: project.id,
        columnId: otherCol.id,
        title: "Other Col Task",
        rankKey: "a0",
        createdBy: owner.user.id,
      });

      const res = await app.request(`/api/projects/${project.id}/tasks?columnId=${targetCol.id}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tasks).toHaveLength(2);
      expect(data.tasks[0].id).toBe(targetA.id);
      expect(data.tasks[0].rankKey).toBe("a0");
      expect(data.tasks[1].id).toBe(targetB.id);
      expect(data.tasks[1].rankKey).toBe("a1");
    });
  });

  describe("Task Details (GET /api/tasks/:taskId)", () => {
    it("retrieves task details for an active task", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Detailed Task",
          description: "Task description",
          columnId: columns[0].id,
        }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.id).toBe(task.id);
      expect(data.task.title).toBe("Detailed Task");
      expect(data.task.description).toBe("Task description");
    });

    it("rejects invalid task UUID with 400 VALIDATION_ERROR", async () => {
      const { owner } = await setupWorkspaceAndProject();

      const res = await app.request("/api/tasks/not-a-valid-uuid", {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 404 NOT_FOUND for nonexistent task", async () => {
      const { owner } = await setupWorkspaceAndProject();
      const fakeTaskId = "00000000-0000-0000-0000-000000000001";

      const res = await app.request(`/api/tasks/${fakeTaskId}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("returns 404 NOT_FOUND for non-member retrieving task (tenant concealment)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const outsider = await createAndLoginUser("Outsider", "outsider-get@example.com");

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Secret Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        headers: { Cookie: outsider.cookie },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("allows members to view details of an archived task (read-only history inspection)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Archived History Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      // Archive task in DB
      await testDb
        .update(tasks)
        .set({ archivedAt: new Date() })
        .where(eq(tasks.id, task.id));

      const res = await app.request(`/api/tasks/${task.id}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.id).toBe(task.id);
      expect(data.task.archivedAt).not.toBeNull();
    });
  });

  describe("Task Editing (PATCH /api/tasks/:taskId)", () => {
    it("updates a single field (title) and increments version", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Initial Title", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();
      expect(task.version).toBe(1);

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Updated Title", expectedVersion: 1 }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.id).toBe(task.id);
      expect(data.task.title).toBe("Updated Title");
      expect(data.task.version).toBe(2);
      expect(new Date(data.task.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(task.updatedAt).getTime()
      );

      // Verify in DB
      const [dbTask] = await testDb
        .select()
        .from(tasks)
        .where(eq(tasks.id, task.id));
      expect(dbTask.title).toBe("Updated Title");
      expect(dbTask.version).toBe(2);
    });

    it("updates multiple fields (title, description, assigneeId, dueDate)", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const member = await createAndLoginUser("Assignee User", "assignee-multi@example.com");

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Task Before Update", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          title: "Comprehensive Update",
          description: "Updated detailed description",
          assigneeId: member.user.id,
          dueDate: "2026-12-31",
          expectedVersion: 1,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.title).toBe("Comprehensive Update");
      expect(data.task.description).toBe("Updated detailed description");
      expect(data.task.assigneeId).toBe(member.user.id);
      expect(data.task.dueDate).toBe("2026-12-31");
      expect(data.task.version).toBe(2);
    });

    it("leaves omitted fields unchanged during partial edit", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Partial Edit Original",
          description: "Keep this description intact",
          dueDate: "2026-11-20",
          columnId: columns[0].id,
        }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          title: "Only Title Modified",
          expectedVersion: 1,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.title).toBe("Only Title Modified");
      expect(data.task.description).toBe("Keep this description intact");
      expect(data.task.dueDate).toBe("2026-11-20");
      expect(data.task.version).toBe(2);
    });

    it("unassigns assignee when assigneeId is explicitly null", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const member = await createAndLoginUser("Assigned", "assigned-clear@example.com");

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Assigned Task",
          columnId: columns[0].id,
          assigneeId: member.user.id,
        }),
      });
      const { task } = await createRes.json();
      expect(task.assigneeId).toBe(member.user.id);

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          assigneeId: null,
          expectedVersion: 1,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.assigneeId).toBeNull();
      expect(data.task.version).toBe(2);
    });

    it("clears dueDate when dueDate is explicitly null", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Due Date Task",
          columnId: columns[0].id,
          dueDate: "2026-12-25",
        }),
      });
      const { task } = await createRes.json();
      expect(task.dueDate).toBe("2026-12-25");

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          dueDate: null,
          expectedVersion: 1,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.dueDate).toBeNull();
      expect(data.task.version).toBe(2);
    });

    it("rejects empty title with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Valid Title", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "", expectedVersion: 1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects whitespace-only title with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Valid Title", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "     ", expectedVersion: 1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects invalid date format with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Valid Title", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ dueDate: "not-a-date", expectedVersion: 1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects non-member assignee with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const outsider = await createAndLoginUser("Non Member", "non-member-assignee@example.com");

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Valid Title", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ assigneeId: outsider.user.id, expectedVersion: 1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("active member");
    });

    it("rejects removed member assignee with 400 VALIDATION_ERROR", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const member = await createAndLoginUser("Former Member", "former-member-patch@example.com");

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Valid Title", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      // Remove member from workspace
      await testDb
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspace.id),
            eq(workspaceMembers.userId, member.user.id)
          )
        );

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ assigneeId: member.user.id, expectedVersion: 1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("active member");
    });

    it("rejects request missing expectedVersion with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Valid Title", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "No Version Provided" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects mismatched expectedVersion with 409 VERSION_CONFLICT returning currentVersion", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Valid Title", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Stale Edit", expectedVersion: 99 }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("VERSION_CONFLICT");
      expect(body.error.details.currentVersion).toBe(1);
    });

    it("rejects editing an archived task with 409 TASK_ARCHIVED", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Archived Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      // Soft delete task
      await testDb
        .update(tasks)
        .set({ archivedAt: new Date() })
        .where(eq(tasks.id, task.id));

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Trying to edit archived", expectedVersion: 1 }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("TASK_ARCHIVED");
    });

    it("rejects editing a task in an archived project with 409 PROJECT_ARCHIVED", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Project Inactive Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      // Archive parent project
      const archiveProjectRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveProjectRes.status).toBe(200);

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Edit in Archived Project", expectedVersion: 1 }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("PROJECT_ARCHIVED");
    });

    it("is an idempotent no-op when fields are identical (preserves version and updatedAt)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({
          title: "Identical Title",
          description: "Identical Description",
          columnId: columns[0].id,
        }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          title: "Identical Title",
          description: "Identical Description",
          expectedVersion: 1,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.version).toBe(1);
      expect(data.task.updatedAt).toBe(task.updatedAt);
    });

    it("returns 404 NOT_FOUND for non-member editing task (tenant concealment)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const outsider = await createAndLoginUser("Outsider", "outsider-patch@example.com");

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Secret Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: outsider.cookie },
        body: JSON.stringify({ title: "Hacked Title", expectedVersion: 1 }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("rejects invalid task UUID format with 400 VALIDATION_ERROR", async () => {
      const { owner } = await setupWorkspaceAndProject();

      const res = await app.request("/api/tasks/not-a-valid-uuid", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Any Title", expectedVersion: 1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("handles concurrent edits on the same version (one succeeds, one gets 409 VERSION_CONFLICT)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Race Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const [res1, res2] = await Promise.all([
        app.request(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ title: "Concurrent Update 1", expectedVersion: 1 }),
        }),
        app.request(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ title: "Concurrent Update 2", expectedVersion: 1 }),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);

      const conflictRes = res1.status === 409 ? res1 : res2;
      const conflictBody = await conflictRes.json();
      expect(conflictBody.error.code).toBe("VERSION_CONFLICT");

      // Verify task ends at version 2 in DB
      const [dbTask] = await testDb
        .select()
        .from(tasks)
        .where(eq(tasks.id, task.id));
      expect(dbTask.version).toBe(2);
    });

    it("handles concurrent update and move operations without deadlocks following project-first lock order", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `task-seed-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Concurrent Move/Update Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      // Launch concurrent updateTask and moveTask against the same task and project
      const [updateRes, moveRes] = await Promise.all([
        app.request(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ title: "Updated in Race", expectedVersion: 1 }),
        }),
        app.request(`/api/tasks/${task.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ columnId: columns[1].id, expectedVersion: 1 }),
        }),
      ]);

      // Both operations must finish without deadlock (neither should fail with a 500 error)
      const statuses = [updateRes.status, moveRes.status].sort();
      // One wins on expectedVersion 1 (200), the second gets VERSION_CONFLICT (409)
      expect(statuses).toEqual([200, 409]);

      const [dbTask] = await testDb
        .select()
        .from(tasks)
        .where(eq(tasks.id, task.id));
      expect(dbTask.version).toBe(2);
    });
  });

  describe("Task Movement (POST /api/tasks/:taskId/move)", () => {
    it("moves a task across columns, updates rankKey, increments version, and updates updatedAt", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Move Me", columnId: col0.id }),
      });
      const { task } = await createRes.json();
      expect(task.columnId).toBe(col0.id);
      expect(task.version).toBe(1);

      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ columnId: col1.id, expectedVersion: 1 }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.id).toBe(task.id);
      expect(data.task.columnId).toBe(col1.id);
      expect(data.task.rankKey).toBe("a0");
      expect(data.task.version).toBe(2);
      expect(new Date(data.task.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(task.updatedAt).getTime()
      );

      // Verify in DB
      const [dbTask] = await testDb
        .select()
        .from(tasks)
        .where(eq(tasks.id, task.id));
      expect(dbTask.columnId).toBe(col1.id);
      expect(dbTask.version).toBe(2);
    });

    it("appends deterministic rankKey when destination column already has tasks", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      // Create 2 existing tasks in col1
      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Existing 1", columnId: col1.id }),
      });
      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Existing 2", columnId: col1.id }),
      });

      // Create task in col0
      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Task to Move", columnId: col0.id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ columnId: col1.id, expectedVersion: 1 }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.columnId).toBe(col1.id);
      expect(data.task.rankKey).toBe("a2");
      expect(data.task.version).toBe(2);
    });

    it("is an idempotent no-op when moving to the same column (preserves version and updatedAt)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Stay in Column", columnId: col0.id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ columnId: col0.id, expectedVersion: 1 }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.columnId).toBe(col0.id);
      expect(data.task.version).toBe(1);
      expect(data.task.updatedAt).toBe(task.updatedAt);
    });

    it("rejects same-column move with stale expectedVersion with 409 VERSION_CONFLICT", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Stay in Column", columnId: col0.id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ columnId: col0.id, expectedVersion: 99 }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("VERSION_CONFLICT");
      expect(body.error.details.currentVersion).toBe(1);
    });

    it("rejects move missing expectedVersion with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Move Missing Version", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ columnId: columns[1].id }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects invalid destination column UUID format with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Move Invalid Col Format", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ columnId: "not-a-valid-uuid", expectedVersion: 1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects moving task to column belonging to another project with 400 VALIDATION_ERROR", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();

      // Create a second project in the workspace
      const proj2Res = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Second Project" }),
      });
      const { columns: proj2Cols } = await proj2Res.json();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Cross-Project Move Attempt", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ columnId: proj2Cols[0].id, expectedVersion: 1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Column does not belong to this project");
    });

    it("rejects moving task to nonexistent column with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const nonExistentCol = "00000000-0000-0000-0000-000000000000";

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Move to Nowhere", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ columnId: nonExistentCol, expectedVersion: 1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects moving an archived task with 409 TASK_ARCHIVED", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Archived Move Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      await testDb
        .update(tasks)
        .set({ archivedAt: new Date() })
        .where(eq(tasks.id, task.id));

      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ columnId: columns[1].id, expectedVersion: 1 }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("TASK_ARCHIVED");
    });

    it("rejects moving task in an archived project with 409 PROJECT_ARCHIVED", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Archived Project Move", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const archiveProjectRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveProjectRes.status).toBe(200);

      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ columnId: columns[1].id, expectedVersion: 1 }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("PROJECT_ARCHIVED");
    });

    it("returns 404 NOT_FOUND for non-member moving task (tenant concealment)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const outsider = await createAndLoginUser("Outsider Move", "outsider-move@example.com");

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Concealed Move Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: outsider.cookie },
        body: JSON.stringify({ columnId: columns[1].id, expectedVersion: 1 }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("handles concurrent moves on the same version (one succeeds, one gets 409 VERSION_CONFLICT)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Concurrent Move Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const [res1, res2] = await Promise.all([
        app.request(`/api/tasks/${task.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ columnId: columns[1].id, expectedVersion: 1 }),
        }),
        app.request(`/api/tasks/${task.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ columnId: columns[2].id, expectedVersion: 1 }),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);

      const conflictRes = res1.status === 409 ? res1 : res2;
      const conflictBody = await conflictRes.json();
      expect(conflictBody.error.code).toBe("VERSION_CONFLICT");

      const [dbTask] = await testDb
        .select()
        .from(tasks)
        .where(eq(tasks.id, task.id));
      expect(dbTask.version).toBe(2);
    });

    // ==========================================
    // Anchor-Based Movement & Reordering (6.5B Commit 3)
    // ==========================================

    it("moves a task to the beginning of a column using nextTaskId", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      // Create two tasks in col1
      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Col1 Task 1", columnId: col1.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Col1 Task 2", columnId: col1.id }),
      });
      const { task: t2 } = await c2Res.json();

      // Create task in col0 to move
      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move to Beginning", columnId: col0.id }),
      });
      const { task: toMove } = await mRes.json();

      const moveRes = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col1.id,
          expectedVersion: 1,
          nextTaskId: t1.id,
        }),
      });

      expect(moveRes.status).toBe(200);
      const moveData = await moveRes.json();
      expect(moveData.task.columnId).toBe(col1.id);
      expect(moveData.task.version).toBe(2);
      expect(moveData.task.rankKey < t1.rankKey).toBe(true);

      // Verify col1 list order
      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col1Tasks = listData.tasks.filter((t: any) => t.columnId === col1.id);
      expect(col1Tasks.map((t: any) => t.id)).toEqual([toMove.id, t1.id, t2.id]);
    });

    it("moves a task to the end of a column using prevTaskId", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Col1 Task 1", columnId: col1.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Col1 Task 2", columnId: col1.id }),
      });
      const { task: t2 } = await c2Res.json();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move to End", columnId: col0.id }),
      });
      const { task: toMove } = await mRes.json();

      const moveRes = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col1.id,
          expectedVersion: 1,
          prevTaskId: t2.id,
        }),
      });

      expect(moveRes.status).toBe(200);
      const moveData = await moveRes.json();
      expect(moveData.task.columnId).toBe(col1.id);
      expect(moveData.task.version).toBe(2);
      expect(moveData.task.rankKey > t2.rankKey).toBe(true);

      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col1Tasks = listData.tasks.filter((t: any) => t.columnId === col1.id);
      expect(col1Tasks.map((t: any) => t.id)).toEqual([t1.id, t2.id, toMove.id]);
    });

    it("inserts a task between two adjacent anchor tasks", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Col1 Task 1", columnId: col1.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Col1 Task 2", columnId: col1.id }),
      });
      const { task: t2 } = await c2Res.json();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Insert Between", columnId: col0.id }),
      });
      const { task: toMove } = await mRes.json();

      const moveRes = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col1.id,
          expectedVersion: 1,
          prevTaskId: t1.id,
          nextTaskId: t2.id,
        }),
      });

      expect(moveRes.status).toBe(200);
      const moveData = await moveRes.json();
      expect(moveData.task.columnId).toBe(col1.id);
      expect(moveData.task.version).toBe(2);
      expect(moveData.task.rankKey > t1.rankKey).toBe(true);
      expect(moveData.task.rankKey < t2.rankKey).toBe(true);

      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col1Tasks = listData.tasks.filter((t: any) => t.columnId === col1.id);
      expect(col1Tasks.map((t: any) => t.id)).toEqual([t1.id, toMove.id, t2.id]);
    });

    it("infers nextTaskId when only prevTaskId is provided (not last task)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col1.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col1.id }),
      });
      const { task: t2 } = await c2Res.json();

      const c3Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c3-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T3", columnId: col1.id }),
      });
      const { task: t3 } = await c3Res.json();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move", columnId: col0.id }),
      });
      const { task: toMove } = await mRes.json();

      // Only prevTaskId: t1.id (t2 is immediate next)
      const moveRes = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col1.id,
          expectedVersion: 1,
          prevTaskId: t1.id,
        }),
      });

      expect(moveRes.status).toBe(200);
      const moveData = await moveRes.json();
      expect(moveData.task.rankKey > t1.rankKey).toBe(true);
      expect(moveData.task.rankKey < t2.rankKey).toBe(true);

      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col1Tasks = listData.tasks.filter((t: any) => t.columnId === col1.id);
      expect(col1Tasks.map((t: any) => t.id)).toEqual([t1.id, toMove.id, t2.id, t3.id]);
    });

    it("infers prevTaskId when only nextTaskId is provided (not first task)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col1.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col1.id }),
      });
      const { task: t2 } = await c2Res.json();

      const c3Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c3-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T3", columnId: col1.id }),
      });
      const { task: t3 } = await c3Res.json();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move", columnId: col0.id }),
      });
      const { task: toMove } = await mRes.json();

      // Only nextTaskId: t2.id (t1 is immediate prev)
      const moveRes = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col1.id,
          expectedVersion: 1,
          nextTaskId: t2.id,
        }),
      });

      expect(moveRes.status).toBe(200);
      const moveData = await moveRes.json();
      expect(moveData.task.rankKey > t1.rankKey).toBe(true);
      expect(moveData.task.rankKey < t2.rankKey).toBe(true);

      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col1Tasks = listData.tasks.filter((t: any) => t.columnId === col1.id);
      expect(col1Tasks.map((t: any) => t.id)).toEqual([t1.id, toMove.id, t2.id, t3.id]);
    });

    it("reorders a task within the same column to the end", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col0.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col0.id }),
      });
      const { task: t2 } = await c2Res.json();

      const c3Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c3-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T3", columnId: col0.id }),
      });
      const { task: t3 } = await c3Res.json();

      // Move t1 to end after t3
      const moveRes = await app.request(`/api/tasks/${t1.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col0.id,
          expectedVersion: 1,
          prevTaskId: t3.id,
        }),
      });

      expect(moveRes.status).toBe(200);
      const moveData = await moveRes.json();
      expect(moveData.task.version).toBe(2);
      expect(moveData.task.rankKey > t3.rankKey).toBe(true);

      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col0Tasks = listData.tasks.filter((t: any) => t.columnId === col0.id);
      expect(col0Tasks.map((t: any) => t.id)).toEqual([t2.id, t3.id, t1.id]);
    });

    it("reorders a task within the same column to the beginning", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col0.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col0.id }),
      });
      const { task: t2 } = await c2Res.json();

      const c3Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c3-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T3", columnId: col0.id }),
      });
      const { task: t3 } = await c3Res.json();

      // Move t3 to beginning before t1
      const moveRes = await app.request(`/api/tasks/${t3.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col0.id,
          expectedVersion: 1,
          nextTaskId: t1.id,
        }),
      });

      expect(moveRes.status).toBe(200);
      const moveData = await moveRes.json();
      expect(moveData.task.version).toBe(2);
      expect(moveData.task.rankKey < t1.rankKey).toBe(true);

      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col0Tasks = listData.tasks.filter((t: any) => t.columnId === col0.id);
      expect(col0Tasks.map((t: any) => t.id)).toEqual([t3.id, t1.id, t2.id]);
    });

    it("reorders a task within the same column between two other tasks", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col0.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col0.id }),
      });
      const { task: t2 } = await c2Res.json();

      const c3Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c3-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T3", columnId: col0.id }),
      });
      const { task: t3 } = await c3Res.json();

      // Move t3 between t1 and t2
      const moveRes = await app.request(`/api/tasks/${t3.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col0.id,
          expectedVersion: 1,
          prevTaskId: t1.id,
          nextTaskId: t2.id,
        }),
      });

      expect(moveRes.status).toBe(200);
      const moveData = await moveRes.json();
      expect(moveData.task.version).toBe(2);
      expect(moveData.task.rankKey > t1.rankKey).toBe(true);
      expect(moveData.task.rankKey < t2.rankKey).toBe(true);

      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col0Tasks = listData.tasks.filter((t: any) => t.columnId === col0.id);
      expect(col0Tasks.map((t: any) => t.id)).toEqual([t1.id, t3.id, t2.id]);
    });

    // ==========================================
    // Anchor Validation & Error Cases
    // ==========================================

    it("rejects non-adjacent anchors with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col1.id }),
      });
      const { task: t1 } = await c1Res.json();

      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col1.id }),
      });

      const c3Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c3-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T3", columnId: col1.id }),
      });
      const { task: t3 } = await c3Res.json();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move", columnId: col0.id }),
      });
      const { task: toMove } = await mRes.json();

      // Pass t1 and t3 as anchors (t2 is between them)
      const res = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col1.id,
          expectedVersion: 1,
          prevTaskId: t1.id,
          nextTaskId: t3.id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Anchor tasks are not adjacent");
    });

    it("rejects reversed anchors with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col1.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col1.id }),
      });
      const { task: t2 } = await c2Res.json();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move", columnId: col0.id }),
      });
      const { task: toMove } = await mRes.json();

      // Reversed: prevTaskId is t2, nextTaskId is t1
      const res = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col1.id,
          expectedVersion: 1,
          prevTaskId: t2.id,
          nextTaskId: t1.id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Anchor tasks are not adjacent");
    });

    it("rejects using moving task as its own prevTaskId with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Self Prev", columnId: columns[0].id }),
      });
      const { task: toMove } = await mRes.json();

      const res = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: columns[1].id,
          expectedVersion: 1,
          prevTaskId: toMove.id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Moving task cannot be used as its own anchor");
    });

    it("rejects using moving task as its own nextTaskId with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Self Next", columnId: columns[0].id }),
      });
      const { task: toMove } = await mRes.json();

      const res = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: columns[1].id,
          expectedVersion: 1,
          nextTaskId: toMove.id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Moving task cannot be used as its own anchor");
    });

    it("rejects identical prevTaskId and nextTaskId with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col1 = columns[1];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col1.id }),
      });
      const { task: t1 } = await c1Res.json();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move", columnId: columns[0].id }),
      });
      const { task: toMove } = await mRes.json();

      const res = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col1.id,
          expectedVersion: 1,
          prevTaskId: t1.id,
          nextTaskId: t1.id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Anchors must be distinct");
    });

    it("rejects nonexistent anchor UUID with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move", columnId: columns[0].id }),
      });
      const { task: toMove } = await mRes.json();

      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: columns[1].id,
          expectedVersion: 1,
          prevTaskId: fakeId,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Previous anchor task not found in destination column");
    });

    it("rejects anchor from another column with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      const c0Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c0-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T0 in Col 0", columnId: col0.id }),
      });
      const { task: t0 } = await c0Res.json();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move to Col 1", columnId: col0.id }),
      });
      const { task: toMove } = await mRes.json();

      const res = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col1.id,
          expectedVersion: 1,
          prevTaskId: t0.id, // t0 is in col0, not col1
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Previous anchor task not found in destination column");
    });

    it("rejects anchor from another project with 400 VALIDATION_ERROR", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();

      // Create a second project in the workspace with a task
      const p2Res = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Project 2" }),
      });
      const { project: p2, columns: p2Cols } = await p2Res.json();

      const p2TaskRes = await app.request(`/api/projects/${p2.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-p2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "P2 Task", columnId: p2Cols[0].id }),
      });
      const { task: p2Task } = await p2TaskRes.json();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move", columnId: columns[0].id }),
      });
      const { task: toMove } = await mRes.json();

      const res = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: columns[1].id,
          expectedVersion: 1,
          nextTaskId: p2Task.id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Next anchor task not found in destination column");
    });

    it("rejects archived anchor task with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col1 = columns[1];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col1.id }),
      });
      const { task: t1 } = await c1Res.json();

      // Archive t1
      await testDb
        .update(tasks)
        .set({ archivedAt: new Date() })
        .where(eq(tasks.id, t1.id));

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move", columnId: columns[0].id }),
      });
      const { task: toMove } = await mRes.json();

      const res = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col1.id,
          expectedVersion: 1,
          prevTaskId: t1.id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Previous anchor task not found in destination column");
    });

    it("rejects invalid UUID format for anchor tasks with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move", columnId: columns[0].id }),
      });
      const { task: toMove } = await mRes.json();

      const res = await app.request(`/api/tasks/${toMove.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: columns[1].id,
          expectedVersion: 1,
          prevTaskId: "not-a-valid-uuid",
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    // ==========================================
    // Versioning & No-Op Semantics
    // ==========================================

    it("is an idempotent no-op when re-specifying exact current position with both anchors", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col0.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col0.id }),
      });
      const { task: t2 } = await c2Res.json();

      const c3Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c3-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T3", columnId: col0.id }),
      });
      const { task: t3 } = await c3Res.json();

      // Move t2 between t1 and t3 (where it already is)
      const res = await app.request(`/api/tasks/${t2.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col0.id,
          expectedVersion: 1,
          prevTaskId: t1.id,
          nextTaskId: t3.id,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.id).toBe(t2.id);
      expect(data.task.version).toBe(1);
      expect(data.task.rankKey).toBe(t2.rankKey);
      expect(data.task.updatedAt).toBe(t2.updatedAt);
    });

    it("is an idempotent no-op when moving to end with explicit prevTaskId when already last", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col0.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col0.id }),
      });
      const { task: t2 } = await c2Res.json();

      // Move t2 after t1 (it's already last, right after t1)
      const res = await app.request(`/api/tasks/${t2.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col0.id,
          expectedVersion: 1,
          prevTaskId: t1.id,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.version).toBe(1);
      expect(data.task.rankKey).toBe(t2.rankKey);
      expect(data.task.updatedAt).toBe(t2.updatedAt);
    });

    it("is an idempotent no-op when moving to start with explicit nextTaskId when already first", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col0.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col0.id }),
      });
      const { task: t2 } = await c2Res.json();

      // Move t1 before t2 (it's already first, right before t2)
      const res = await app.request(`/api/tasks/${t1.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col0.id,
          expectedVersion: 1,
          nextTaskId: t2.id,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.version).toBe(1);
      expect(data.task.rankKey).toBe(t1.rankKey);
      expect(data.task.updatedAt).toBe(t1.updatedAt);
    });

    // ==========================================
    // Concurrency & Serialization
    // ==========================================

    it("serializes concurrent moves targeting the same anchor pair (one succeeds, other fails with non-adjacent 400)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      // Destination column has tA and tB
      const caRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-ca-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Anchor A", columnId: col1.id }),
      });
      const { task: tA } = await caRes.json();

      const cbRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-cb-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Anchor B", columnId: col1.id }),
      });
      const { task: tB } = await cbRes.json();

      // Two candidate tasks in col0
      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Contender 1", columnId: col0.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Contender 2", columnId: col0.id }),
      });
      const { task: t2 } = await c2Res.json();

      // Launch both concurrently targeting the exact same anchor pair (tA, tB)
      const [res1, res2] = await Promise.all([
        app.request(`/api/tasks/${t1.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({
            columnId: col1.id,
            expectedVersion: 1,
            prevTaskId: tA.id,
            nextTaskId: tB.id,
          }),
        }),
        app.request(`/api/tasks/${t2.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({
            columnId: col1.id,
            expectedVersion: 1,
            prevTaskId: tA.id,
            nextTaskId: tB.id,
          }),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 400]);

      const errRes = res1.status === 400 ? res1 : res2;
      const errBody = await errRes.json();
      expect(errBody.error.code).toBe("VALIDATION_ERROR");
      expect(errBody.error.message).toContain("Anchor tasks are not adjacent");

      // Verify col1 has exactly 3 tasks: tA, winner, tB
      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col1Tasks = listData.tasks.filter((t: any) => t.columnId === col1.id);
      expect(col1Tasks.length).toBe(3);
      expect(col1Tasks[0].id).toBe(tA.id);
      expect(col1Tasks[2].id).toBe(tB.id);
    });

    it("serializes concurrent task creation and task move in the same project without deadlock", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      const cRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Move Candidate", columnId: col0.id }),
      });
      const { task: toMove } = await cRes.json();

      // Concurrently create a task in col0 and move toMove to col1
      const [createRes, moveRes] = await Promise.all([
        app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": `concurrent-create-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ title: "New Created Task", columnId: col0.id }),
        }),
        app.request(`/api/tasks/${toMove.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({
            columnId: col1.id,
            expectedVersion: 1,
          }),
        }),
      ]);

      expect(createRes.status).toBe(201);
      expect(moveRes.status).toBe(200);

      const moveData = await moveRes.json();
      expect(moveData.task.columnId).toBe(col1.id);
      expect(moveData.task.version).toBe(2);

      // Verify DB state
      const [movedDbTask] = await testDb
        .select()
        .from(tasks)
        .where(eq(tasks.id, toMove.id));
      expect(movedDbTask.columnId).toBe(col1.id);
      expect(movedDbTask.version).toBe(2);
    });
  });

  describe("Task Lifecycle (POST /api/tasks/:taskId/archive & /restore)", () => {
    it("archives an active task, increments version, updates updatedAt, and hides from project list", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Task to Archive", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();
      expect(task.archivedAt).toBeNull();
      expect(task.version).toBe(1);

      const res = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.id).toBe(task.id);
      expect(data.task.archivedAt).not.toBeNull();
      expect(data.task.version).toBe(2);
      expect(new Date(data.task.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(task.updatedAt).getTime()
      );

      // Verify excluded from default project task listing
      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      expect(listData.tasks.some((t: any) => t.id === task.id)).toBe(false);

      // Verify still retrievable via GET /api/tasks/:taskId for history inspection
      const getRes = await app.request(`/api/tasks/${task.id}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.task.archivedAt).not.toBeNull();
    });

    it("is an idempotent no-op when archiving an already archived task (preserves version and updatedAt)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Double Archive Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res1 = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      const data1 = await res1.json();
      expect(data1.task.version).toBe(2);

      const res2 = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.task.version).toBe(2);
      expect(data2.task.archivedAt).toBe(data1.task.archivedAt);
      expect(data2.task.updatedAt).toBe(data1.task.updatedAt);
    });

    it("restores an archived task, increments version, updates updatedAt, and reappears in project list", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Task to Restore", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      // Archive task first
      const archiveRes = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      const { task: archivedTask } = await archiveRes.json();
      expect(archivedTask.version).toBe(2);

      // Restore task
      const restoreRes = await app.request(`/api/tasks/${task.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(restoreRes.status).toBe(200);
      const data = await restoreRes.json();
      expect(data.task.id).toBe(task.id);
      expect(data.task.archivedAt).toBeNull();
      expect(data.task.version).toBe(3);
      expect(new Date(data.task.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(archivedTask.updatedAt).getTime()
      );

      // Verify reappears in project task listing
      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      expect(listData.tasks.some((t: any) => t.id === task.id)).toBe(true);
    });

    it("is an idempotent no-op when restoring an already active task (preserves version and updatedAt)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Already Active Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();
      expect(task.version).toBe(1);

      const res = await app.request(`/api/tasks/${task.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.version).toBe(1);
      expect(data.task.archivedAt).toBeNull();
      expect(data.task.updatedAt).toBe(task.updatedAt);
    });

    it("rejects archiving a task in an archived project with 409 PROJECT_ARCHIVED", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Archive in Inactive Project", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const archiveProjectRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveProjectRes.status).toBe(200);

      const res = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("PROJECT_ARCHIVED");
    });

    it("rejects restoring a task in an archived project with 409 PROJECT_ARCHIVED", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Restore in Inactive Project", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      // Archive task while project is still active
      const archiveTaskRes = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveTaskRes.status).toBe(200);

      // Now archive project
      const archiveProjectRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveProjectRes.status).toBe(200);

      const res = await app.request(`/api/tasks/${task.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("PROJECT_ARCHIVED");
    });

    it("returns 404 NOT_FOUND for non-member archiving task (tenant concealment)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const outsider = await createAndLoginUser("Outsider Archive", "outsider-archive@example.com");

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Concealed Archive Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        headers: { Cookie: outsider.cookie },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("returns 404 NOT_FOUND for non-member restoring task (tenant concealment)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const outsider = await createAndLoginUser("Outsider Restore", "outsider-restore@example.com");

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie , "Idempotency-Key": `task-seed-${crypto.randomUUID()}`},
        body: JSON.stringify({ title: "Concealed Restore Task", columnId: columns[0].id }),
      });
      const { task } = await createRes.json();

      const res = await app.request(`/api/tasks/${task.id}/restore`, {
        method: "POST",
        headers: { Cookie: outsider.cookie },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("rejects invalid task UUID format for archive and restore with 400 VALIDATION_ERROR", async () => {
      const { owner } = await setupWorkspaceAndProject();

      const archiveRes = await app.request("/api/tasks/not-a-valid-uuid/archive", {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes.status).toBe(400);
      const archiveBody = await archiveRes.json();
      expect(archiveBody.error.code).toBe("VALIDATION_ERROR");

      const restoreRes = await app.request("/api/tasks/not-a-valid-uuid/restore", {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(restoreRes.status).toBe(400);
      const restoreBody = await restoreRes.json();
      expect(restoreBody.error.code).toBe("VALIDATION_ERROR");
    });

    // ==========================================
    // Collision-Safe Restoration & Concurrency (Milestone 6.5B)
    // ==========================================

    it("restores without collision preserving original rank key", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      // Create two tasks in col0
      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Task 1", columnId: col0.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Task 2", columnId: col0.id }),
      });
      const { task: t2 } = await c2Res.json();

      // Archive task 1
      await app.request(`/api/tasks/${t1.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      // Restore task 1 (t2 has a1, no active task has a0)
      const res = await app.request(`/api/tasks/${t1.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.id).toBe(t1.id);
      expect(data.task.archivedAt).toBeNull();
      expect(data.task.rankKey).toBe(t1.rankKey); // Preserved without change!
      expect(data.task.version).toBe(3);

      // Verify col0 active tasks have distinct rank keys
      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col0Tasks = listData.tasks.filter((t: any) => t.columnId === col0.id);
      const rankKeys = col0Tasks.map((t: any) => t.rankKey);
      expect(new Set(rankKeys).size).toBe(rankKeys.length);
      expect(col0Tasks.map((t: any) => t.id)).toEqual([t1.id, t2.id]);
    });

    it("restores into an otherwise empty active column preserving original rank key", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      const cRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Sole Task", columnId: col0.id }),
      });
      const { task: t } = await cRes.json();

      await app.request(`/api/tasks/${t.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      const res = await app.request(`/api/tasks/${t.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.task.rankKey).toBe(t.rankKey);
      expect(data.task.archivedAt).toBeNull();
    });

    it("restores with collision by appending after the last active task with a new rank key", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      // Create task 1 ("a0")
      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Task 1", columnId: col0.id }),
      });
      const { task: t1 } = await c1Res.json();
      expect(t1.rankKey).toBe("a0");

      // Archive task 1
      await app.request(`/api/tasks/${t1.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      // Create task 2 in col0 (since task 1 is archived, task 2 also gets "a0")
      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Task 2 (takes a0)", columnId: col0.id }),
      });
      const { task: t2 } = await c2Res.json();
      expect(t2.rankKey).toBe("a0");

      // Now restore task 1: its old rankKey ("a0") collides with active task 2 ("a0")
      const restoreRes = await app.request(`/api/tasks/${t1.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(restoreRes.status).toBe(200);
      const data = await restoreRes.json();
      expect(data.task.id).toBe(t1.id);
      expect(data.task.archivedAt).toBeNull();
      // Appended after t2 ("a0"), so receives "a1"
      expect(data.task.rankKey).toBe("a1");
      expect(data.task.rankKey > t2.rankKey).toBe(true);

      // Verify active tasks in col0 have strictly unique rank keys
      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col0Tasks = listData.tasks.filter((t: any) => t.columnId === col0.id);
      const rankKeys = col0Tasks.map((t: any) => t.rankKey);
      expect(new Set(rankKeys).size).toBe(rankKeys.length);
      expect(col0Tasks.map((t: any) => t.id)).toEqual([t2.id, t1.id]);
    });

    it("handles move followed by restore: move occupies archived task's rank, restore appends after collision", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      // Create task in col0
      const c0Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c0-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Mover", columnId: col0.id }),
      });
      const { task: mover } = await c0Res.json();

      // Create task in col1 ("a0")
      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Col1 Native", columnId: col1.id }),
      });
      const { task: col1Native } = await c1Res.json();
      expect(col1Native.rankKey).toBe("a0");

      // Archive col1Native (leaving col1 empty of active tasks)
      await app.request(`/api/tasks/${col1Native.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      // Move mover into col1 (gets "a0" since col1 has 0 active tasks)
      const moveRes = await app.request(`/api/tasks/${mover.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ columnId: col1.id, expectedVersion: 1 }),
      });
      expect(moveRes.status).toBe(200);
      const moveData = await moveRes.json();
      expect(moveData.task.rankKey).toBe("a0");

      // Now restore col1Native: its old rankKey ("a0") collides with mover's "a0"
      const restoreRes = await app.request(`/api/tasks/${col1Native.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(restoreRes.status).toBe(200);
      const restoreData = await restoreRes.json();
      expect(restoreData.task.rankKey).toBe("a1");
      expect(restoreData.task.rankKey > moveData.task.rankKey).toBe(true);

      // Verify col1 active tasks have distinct rank keys
      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col1Tasks = listData.tasks.filter((t: any) => t.columnId === col1.id);
      const rankKeys = col1Tasks.map((t: any) => t.rankKey);
      expect(new Set(rankKeys).size).toBe(rankKeys.length);
      expect(col1Tasks.map((t: any) => t.id)).toEqual([mover.id, col1Native.id]);
    });

    it("handles restore followed by move: movement observes restored active task and preserves valid ordering", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      // Col1 has t1 ("a0") and t2 ("a1")
      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col1.id }),
      });
      const { task: t1 } = await c1Res.json();

      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col1.id }),
      });
      const { task: t2 } = await c2Res.json();

      // Archive t2
      await app.request(`/api/tasks/${t2.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      // Restore t2 (restores at "a1" without collision)
      const restoreRes = await app.request(`/api/tasks/${t2.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(restoreRes.status).toBe(200);

      // Col0 has task to move
      const mRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-m-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Mover", columnId: col0.id }),
      });
      const { task: mover } = await mRes.json();

      // Move mover into col1 after restored t2
      const moveRes = await app.request(`/api/tasks/${mover.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          columnId: col1.id,
          expectedVersion: 1,
          prevTaskId: t2.id,
        }),
      });
      expect(moveRes.status).toBe(200);
      const moveData = await moveRes.json();
      expect(moveData.task.rankKey > t2.rankKey).toBe(true);

      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col1Tasks = listData.tasks.filter((t: any) => t.columnId === col1.id);
      const rankKeys = col1Tasks.map((t: any) => t.rankKey);
      expect(new Set(rankKeys).size).toBe(rankKeys.length);
      expect(col1Tasks.map((t: any) => t.id)).toEqual([t1.id, t2.id, mover.id]);
    });

    it("handles creation followed by restore: creation occupies archived task's rank, restore appends after collision", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];

      const c1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c1-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T1", columnId: col0.id }),
      });
      const { task: t1 } = await c1Res.json();

      await app.request(`/api/tasks/${t1.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      // Creation occupies "a0"
      const c2Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-c2-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "T2", columnId: col0.id }),
      });
      const { task: t2 } = await c2Res.json();
      expect(t2.rankKey).toBe("a0");

      // Restore t1
      const restoreRes = await app.request(`/api/tasks/${t1.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(restoreRes.status).toBe(200);
      const restoreData = await restoreRes.json();
      expect(restoreData.task.rankKey).toBe("a1");

      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col0Tasks = listData.tasks.filter((t: any) => t.columnId === col0.id);
      const rankKeys = col0Tasks.map((t: any) => t.rankKey);
      expect(new Set(rankKeys).size).toBe(rankKeys.length);
      expect(col0Tasks.map((t: any) => t.id)).toEqual([t2.id, t1.id]);
    });

    it("serializes concurrent archive and move safely without creating duplicate active rank keys", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      // Col1 has tA ("a0") and tB ("a1")
      const caRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-ca-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Anchor A", columnId: col1.id }),
      });
      const { task: tA } = await caRes.json();

      const cbRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-cb-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Anchor B", columnId: col1.id }),
      });
      const { task: tB } = await cbRes.json();

      // Col0 has task to move
      const cmRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-cm-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Mover", columnId: col0.id }),
      });
      const { task: mover } = await cmRes.json();

      // Concurrently archive Anchor A and move mover between Anchor A and Anchor B
      const [archiveRes, moveRes] = await Promise.all([
        app.request(`/api/tasks/${tA.id}/archive`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        }),
        app.request(`/api/tasks/${mover.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({
            columnId: col1.id,
            expectedVersion: 1,
            prevTaskId: tA.id,
            nextTaskId: tB.id,
          }),
        }),
      ]);

      // Because both acquire project lock FOR UPDATE, they serialize:
      // Archive succeeds (200). Move either succeeds (200, if it acquired lock first) or
      // fails with 400 (if archive committed first and tA is no longer an active task in col1).
      expect(archiveRes.status).toBe(200);
      expect([200, 400]).toContain(moveRes.status);

      // Verify col1 active tasks have strictly unique rank keys
      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col1Tasks = listData.tasks.filter((t: any) => t.columnId === col1.id);
      const rankKeys = col1Tasks.map((t: any) => t.rankKey);
      expect(new Set(rankKeys).size).toBe(rankKeys.length);
    });

    it("serializes concurrent restore and move safely without creating duplicate active rank keys", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const col0 = columns[0];
      const col1 = columns[1];

      // Col1 has tA ("a0") and tB ("a2")
      const caRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-ca-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Anchor A", columnId: col1.id }),
      });
      const { task: tA } = await caRes.json();

      // Create tX ("a1") between tA and tB
      const cxRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-cx-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Task X", columnId: col1.id }),
      });
      const { task: tX } = await cxRes.json();

      const cbRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-cb-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Anchor B", columnId: col1.id }),
      });
      const { task: tB } = await cbRes.json();

      // Archive tX (leaving tA "a0" and tB "a2" active)
      await app.request(`/api/tasks/${tX.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      // Col0 has task to move
      const cmRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": `seed-cm-${crypto.randomUUID()}` },
        body: JSON.stringify({ title: "Mover", columnId: col0.id }),
      });
      const { task: mover } = await cmRes.json();

      // Concurrently restore tX and move mover between tA and tB
      const [restoreRes, moveRes] = await Promise.all([
        app.request(`/api/tasks/${tX.id}/restore`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        }),
        app.request(`/api/tasks/${mover.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({
            columnId: col1.id,
            expectedVersion: 1,
            prevTaskId: tA.id,
            nextTaskId: tB.id,
          }),
        }),
      ]);

      // Both serialize on project lock FOR UPDATE.
      // If restore runs first: tX is restored at "a1". When move runs, tA and tB are not adjacent (tX is between them), so move gets 400.
      // If move runs first: move succeeds placing mover between tA and tB. When restore runs, tX detects collision with mover's key, appends after tB!
      expect([200]).toContain(restoreRes.status);
      expect([200, 400]).toContain(moveRes.status);

      // In ALL cases, verify col1 active tasks have strictly UNIQUE rank keys
      const listRes = await app.request(`/api/projects/${project.id}/tasks`, {
        headers: { Cookie: owner.cookie },
      });
      const listData = await listRes.json();
      const col1Tasks = listData.tasks.filter((t: any) => t.columnId === col1.id);
      const rankKeys = col1Tasks.map((t: any) => t.rankKey);
      expect(new Set(rankKeys).size).toBe(rankKeys.length);
    });
  });

  describe("Task Creation Idempotency & Concurrency (POST /api/projects/:projectId/tasks - Milestone 6.4)", () => {
    // 1. Header Validation
    it("rejects request missing Idempotency-Key header with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Valid Task Title", columnId: columns[0].id }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Idempotency-Key");
    });

    it("rejects empty or whitespace-only Idempotency-Key header with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Empty key
      const resEmpty = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "" },
        body: JSON.stringify({ title: "Valid Task Title", columnId: columns[0].id }),
      });
      expect(resEmpty.status).toBe(400);
      expect((await resEmpty.json()).error.code).toBe("VALIDATION_ERROR");

      // Whitespace-only key
      const resSpace = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "    " },
        body: JSON.stringify({ title: "Valid Task Title", columnId: columns[0].id }),
      });
      expect(resSpace.status).toBe(400);
      expect((await resSpace.json()).error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects Idempotency-Key header exceeding 128 characters with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const resLong = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "k".repeat(129) },
        body: JSON.stringify({ title: "Valid Task Title", columnId: columns[0].id }),
      });

      expect(resLong.status).toBe(400);
      const body = await resLong.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("accepts boundary keys of 1 character and 128 characters", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // 1 char boundary
      const res1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "x" },
        body: JSON.stringify({ title: "Boundary 1 Char", columnId: columns[0].id }),
      });
      expect(res1.status).toBe(201);
      const data1 = await res1.json();
      expect(data1.task).toBeDefined();

      // 128 chars boundary
      const res128 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "z".repeat(128) },
        body: JSON.stringify({ title: "Boundary 128 Chars", columnId: columns[0].id }),
      });
      expect(res128.status).toBe(201);
      const data128 = await res128.json();
      expect(data128.task).toBeDefined();
    });

    // 2. Replay & Conflict
    it("creates exactly one task when first request with a new key is processed", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "single-create-key" },
        body: JSON.stringify({ title: "Single Create Task", columnId: columns[0].id }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.task).toBeDefined();

      // Verify in idempotency_records
      const records = await testDb
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.actorId, owner.user.id),
            eq(idempotencyRecords.idempotencyKey, "single-create-key")
          )
        );
      expect(records).toHaveLength(1);
      expect(records[0].endpointKey).toBe("tasks:create");
      expect(records[0].responseStatus).toBe(201);
    });

    it("replays original result without creating duplicate task when repeated with same key and payload", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const payload = { title: "Replayed Task", columnId: columns[0].id, description: "Detailed text" };

      // First request
      const res1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "task-replay-key" },
        body: JSON.stringify(payload),
      });
      expect(res1.status).toBe(201);
      const data1 = await res1.json();

      // Repeated request
      const res2 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "task-replay-key" },
        body: JSON.stringify(payload),
      });
      expect(res2.status).toBe(201);
      const data2 = await res2.json();
      expect(data2.task.id).toBe(data1.task.id);
      expect(data2.task.createdAt).toBe(data1.task.createdAt);

      // Verify DB has only 1 task
      const dbTasks = await testDb.select().from(tasks).where(eq(tasks.projectId, project.id));
      expect(dbTasks).toHaveLength(1);
    });

    it("rejects reused key with different title with 409 IDEMPOTENCY_KEY_REUSED", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const res1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "diff-title-key" },
        body: JSON.stringify({ title: "Original Title", columnId: columns[0].id }),
      });
      expect(res1.status).toBe(201);

      const res2 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "diff-title-key" },
        body: JSON.stringify({ title: "Altered Title", columnId: columns[0].id }),
      });
      expect(res2.status).toBe(409);
      const body = await res2.json();
      expect(body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

      // Verify DB still only has 1 task
      const dbTasks = await testDb.select().from(tasks).where(eq(tasks.projectId, project.id));
      expect(dbTasks).toHaveLength(1);
    });

    it("rejects reused key with different columnId with 409 IDEMPOTENCY_KEY_REUSED", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const res1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "diff-col-key" },
        body: JSON.stringify({ title: "Task for Column 0", columnId: columns[0].id }),
      });
      expect(res1.status).toBe(201);

      const res2 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "diff-col-key" },
        body: JSON.stringify({ title: "Task for Column 0", columnId: columns[1].id }),
      });
      expect(res2.status).toBe(409);
      expect((await res2.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("rejects reused key with different assigneeId with 409 IDEMPOTENCY_KEY_REUSED", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const member = await createAndLoginUser("Assignee Member", "ass-idemp@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const res1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "diff-ass-key" },
        body: JSON.stringify({ title: "Task Unassigned", columnId: columns[0].id }),
      });
      expect(res1.status).toBe(201);

      const res2 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "diff-ass-key" },
        body: JSON.stringify({ title: "Task Unassigned", columnId: columns[0].id, assigneeId: member.user.id }),
      });
      expect(res2.status).toBe(409);
      expect((await res2.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    // 3. Scope
    it("allows different actors to use independent idempotency scopes with the same key name", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const member = await createAndLoginUser("Other Member", "other-actor-task@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      // Owner creates task with key "actor-shared-key"
      const resOwner = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "actor-shared-key" },
        body: JSON.stringify({ title: "Owner Task with Shared Key", columnId: columns[0].id }),
      });
      expect(resOwner.status).toBe(201);

      // Member creates task with same key "actor-shared-key"
      const resMember = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: member.cookie, "Idempotency-Key": "actor-shared-key" },
        body: JSON.stringify({ title: "Member Task with Shared Key", columnId: columns[0].id }),
      });
      expect(resMember.status).toBe(201);

      // Both tasks created in DB
      const dbTasks = await testDb.select().from(tasks).where(eq(tasks.projectId, project.id));
      expect(dbTasks).toHaveLength(2);
    });

    it("scopes idempotency keys by project/path so reusing key on different project yields 409 IDEMPOTENCY_KEY_REUSED", async () => {
      const { owner, workspace, project: proj1, columns: cols1 } = await setupWorkspaceAndProject();
      const proj2Res = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Second Project" }),
      });
      const { project: proj2, columns: cols2 } = await proj2Res.json();

      // Create task on Project 1
      const res1 = await app.request(`/api/projects/${proj1.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "cross-proj-key" },
        body: JSON.stringify({ title: "Task 1", columnId: cols1[0].id }),
      });
      expect(res1.status).toBe(201);

      // Attempt to reuse same key on Project 2
      const res2 = await app.request(`/api/projects/${proj2.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "cross-proj-key" },
        body: JSON.stringify({ title: "Task 1", columnId: cols2[0].id }),
      });
      expect(res2.status).toBe(409);
      expect((await res2.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    // 4. Atomicity
    it("does not leave a persisted idempotency record or task after a failed transaction", async () => {
      const { owner, project } = await setupWorkspaceAndProject();
      const fakeColId = "00000000-0000-0000-0000-000000000099";

      // Attempt creation with invalid column (fails validation in transaction)
      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "atomic-fail-key" },
        body: JSON.stringify({ title: "Failed Task", columnId: fakeColId }),
      });
      expect(res.status).toBe(400);

      // Verify no task exists
      const dbTasks = await testDb.select().from(tasks).where(eq(tasks.projectId, project.id));
      expect(dbTasks).toHaveLength(0);

      // Verify no idempotency record exists
      const dbRecords = await testDb
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.actorId, owner.user.id),
            eq(idempotencyRecords.idempotencyKey, "atomic-fail-key")
          )
        );
      expect(dbRecords).toHaveLength(0);
    });

    // 5. Lifecycle & Authorization (The Refined Scenario!)
    it("replays original task response when retried after project archival (same key and identical payload)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const payload = { title: "Archival Replay Task", columnId: columns[0].id };

      // 1. Initial successful creation
      const res1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "arch-replay-key" },
        body: JSON.stringify(payload),
      });
      expect(res1.status).toBe(201);
      const data1 = await res1.json();
      expect(data1.task).toBeDefined();

      // 2. Archive the project
      const archiveRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes.status).toBe(200);

      // 3. Retry the creation request with the same key and identical payload
      const resRetry = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "arch-replay-key" },
        body: JSON.stringify(payload),
      });
      expect(resRetry.status).toBe(201);
      const dataRetry = await resRetry.json();
      expect(dataRetry.task.id).toBe(data1.task.id);
      expect(dataRetry.task.title).toBe(data1.task.title);

      // 4. Verify no duplicate task exists in DB
      const dbTasks = await testDb.select().from(tasks).where(eq(tasks.projectId, project.id));
      expect(dbTasks).toHaveLength(1);
    });

    it("rejects fresh task creation on an archived project with 409 PROJECT_ARCHIVED", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Archive project
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      // Attempt fresh task creation with new key
      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "fresh-arch-key" },
        body: JSON.stringify({ title: "Fresh Task on Archived Project", columnId: columns[0].id }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("PROJECT_ARCHIVED");

      // Verify 0 tasks exist
      const dbTasks = await testDb.select().from(tasks).where(eq(tasks.projectId, project.id));
      expect(dbTasks).toHaveLength(0);
    });

    it("returns 404 NOT_FOUND when an expelled/non-member attempts to replay a cached task creation", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      const member = await createAndLoginUser("Temporary Member", "temp-member@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const payload = { title: "Member Seed Task", columnId: columns[0].id };

      // Member creates task
      const res1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: member.cookie, "Idempotency-Key": "member-expel-key" },
        body: JSON.stringify(payload),
      });
      expect(res1.status).toBe(201);

      // Expel member from workspace
      await app.request(`/api/workspaces/${workspace.id}/members/${member.user.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });

      // Expelled user retries with the same key and payload
      const resRetry = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: member.cookie, "Idempotency-Key": "member-expel-key" },
        body: JSON.stringify(payload),
      });
      expect(resRetry.status).toBe(404);
      expect((await resRetry.json()).error.code).toBe("NOT_FOUND");
    });

    // 6. Concurrency
    it("handles two genuinely concurrent HTTP requests with same key and payload (creates exactly 1 task, replays original response)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const payload = { title: "Concurrent Unique Task", columnId: columns[0].id };

      // Launch 2 parallel requests
      const [res1, res2] = await Promise.all([
        app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "conc-task-dup-key" },
          body: JSON.stringify(payload),
        }),
        app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "conc-task-dup-key" },
          body: JSON.stringify(payload),
        }),
      ]);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);

      const data1 = await res1.json();
      const data2 = await res2.json();
      expect(data1.task.id).toBe(data2.task.id);

      // Exactly 1 task in DB
      const dbTasks = await testDb.select().from(tasks).where(eq(tasks.projectId, project.id));
      expect(dbTasks).toHaveLength(1);

      // Exactly 1 idempotency record in DB
      const records = await testDb
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.actorId, owner.user.id),
            eq(idempotencyRecords.idempotencyKey, "conc-task-dup-key")
          )
        );
      expect(records).toHaveLength(1);
    });

    it("handles concurrent same-key requests with conflicting payloads (one succeeds, other gets 409 IDEMPOTENCY_KEY_REUSED)", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const [resA, resB] = await Promise.all([
        app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "conc-task-race-conflict" },
          body: JSON.stringify({ title: "Payload A", columnId: columns[0].id }),
        }),
        app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie, "Idempotency-Key": "conc-task-race-conflict" },
          body: JSON.stringify({ title: "Payload B (Different)", columnId: columns[0].id }),
        }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const conflictRes = resA.status === 409 ? resA : resB;
      const conflictBody = await conflictRes.json();
      expect(conflictBody.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

      // Exactly 1 task created in DB
      const dbTasks = await testDb.select().from(tasks).where(eq(tasks.projectId, project.id));
      expect(dbTasks).toHaveLength(1);
    });

    it("handles concurrent task creation across two different projects with the same idempotency key, recovering from 23505 unique collision", async () => {
      const { owner, workspace, project: proj1, columns: cols1 } = await setupWorkspaceAndProject();
      const proj2Res = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Second Concurrent Project" }),
      });
      const { project: proj2, columns: cols2 } = await proj2Res.json();

      const sharedKey = `cross-proj-23505-${crypto.randomUUID()}`;
      const payload1 = { title: "Task on Project 1", columnId: cols1[0].id };
      const payload2 = { title: "Task on Project 2", columnId: cols2[0].id };

      let resolveFirstSave: () => void;
      const firstSaveEntered = new Promise<void>((r) => {
        resolveFirstSave = r;
      });
      let resumeFirstTx: () => void;
      const allowFirstTxCommit = new Promise<void>((r) => {
        resumeFirstTx = r;
      });

      let recoveryCheckCalledWithTopLevelDb = false;

      const origSave = IdempotencyService.save;
      const origCheck = IdempotencyService.check;

      let saveCount = 0;
      IdempotencyService.save = async (tx, params) => {
        if (params.idempotencyKey === sharedKey) {
          saveCount++;
          if (saveCount === 1) {
            // Request 1 inserts the uncommitted idempotency record into its transaction
            await origSave.call(IdempotencyService, tx, params);
            // Signal that uncommitted record has been inserted
            resolveFirstSave();
            // Hold Request 1 transaction open until Request 2 hits the unique constraint
            await allowFirstTxCommit;
            return;
          }
        }
        return origSave.call(IdempotencyService, tx, params);
      };

      IdempotencyService.check = async (dbOrTx, params) => {
        if (params.idempotencyKey === sharedKey && dbOrTx === testDb) {
          recoveryCheckCalledWithTopLevelDb = true;
        }
        return origCheck.call(IdempotencyService, dbOrTx, params);
      };

      try {
        // 1. Launch Request 1 on Project 1
        const req1Promise = app.request(`/api/projects/${proj1.id}/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": sharedKey,
          },
          body: JSON.stringify(payload1),
        });

        // 2. Wait until Request 1 has executed IdempotencyService.save(tx, ...)
        await firstSaveEntered;

        // 3. Launch Request 2 on Project 2 (different project row lock)
        const req2Promise = app.request(`/api/projects/${proj2.id}/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": sharedKey,
          },
          body: JSON.stringify(payload2),
        });

        // 4. Verify through pg_stat_activity that Request 2 is actively blocked on Request 1's uncommitted unique key
        const startWait = Date.now();
        let blockedOnUniqueLock = false;
        while (Date.now() - startWait < 4000) {
          const rows = await testSqlClient`
            SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid) as blocking
            FROM pg_stat_activity
            WHERE wait_event_type = 'Lock'
              AND datname = current_database()
              AND cardinality(pg_blocking_pids(pid)) > 0
          `;
          if (rows.length > 0) {
            blockedOnUniqueLock = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }

        // 5. Release Request 1 to commit
        resumeFirstTx!();

        // 6. Await both responses
        const [res1, res2] = await Promise.all([req1Promise, req2Promise]);

        // Verify that Request 2 was observed waiting on Request 1 in PostgreSQL
        expect(blockedOnUniqueLock).toBe(true);

        // Verify that the 23505 catch block executed and called IdempotencyService.check using top-level testDb
        expect(recoveryCheckCalledWithTopLevelDb).toBe(true);

        // Verify HTTP status codes
        expect(res1.status).toBe(201);
        expect(res2.status).toBe(409);

        const data1 = await res1.json();
        const body2 = await res2.json();

        expect(data1.task).toBeDefined();
        expect(data1.task.projectId).toBe(proj1.id);
        expect(data1.task.title).toBe("Task on Project 1");

        expect(body2.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
        expect(body2.error.message).toContain("different request payload");

        // Verify database: Project 1 has exactly 1 task
        const dbTasksProj1 = await testDb.select().from(tasks).where(eq(tasks.projectId, proj1.id));
        expect(dbTasksProj1).toHaveLength(1);
        expect(dbTasksProj1[0].id).toBe(data1.task.id);

        // Verify database: Project 2 has 0 tasks (rolled back completely)
        const dbTasksProj2 = await testDb.select().from(tasks).where(eq(tasks.projectId, proj2.id));
        expect(dbTasksProj2).toHaveLength(0);

        // Verify database: exactly 1 idempotency record exists for this actor and key
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
        expect(records[0].endpointKey).toBe("tasks:create");
        expect(records[0].responseStatus).toBe(201);
      } finally {
        resumeFirstTx?.();
        IdempotencyService.save = origSave;
        IdempotencyService.check = origCheck;
      }
    });

    it("handles concurrent task creation in the same column producing distinct sequential rank keys and deterministic order", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // Two concurrent creations in the same column with different idempotency keys
      const [res1, res2] = await Promise.all([
        app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": `conc-diff-1-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ title: "Concurrent Task Alpha", columnId: colId }),
        }),
        app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": `conc-diff-2-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ title: "Concurrent Task Beta", columnId: colId }),
        }),
      ]);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);

      const data1 = await res1.json();
      const data2 = await res2.json();

      const keys = [data1.task.rankKey, data2.task.rankKey].sort();
      expect(keys).toEqual(["a0", "a1"]);

      // Verify list endpoint returns them in exact rankKey order
      const listRes = await app.request(`/api/projects/${project.id}/tasks?columnId=${colId}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.tasks).toHaveLength(2);
      expect(listData.tasks[0].rankKey).toBe("a0");
      expect(listData.tasks[1].rankKey).toBe("a1");
    });

    it("replaying an idempotent task creation returns the original rank key and does not alter column ordering", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;
      const idempotencyKey = `idemp-rank-replay-${crypto.randomUUID()}`;
      const payload = { title: "Idempotent Ordered Task", columnId: colId };

      // Initial creation
      const res1 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      expect(res1.status).toBe(201);
      const data1 = await res1.json();
      expect(data1.task.rankKey).toBe("a0");

      // Create a second task
      const res2 = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `second-task-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ title: "Second Task", columnId: colId }),
      });
      expect(res2.status).toBe(201);
      const data2 = await res2.json();
      expect(data2.task.rankKey).toBe("a1");

      // Replay first creation
      const resReplay = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      expect(resReplay.status).toBe(201);
      const dataReplay = await resReplay.json();
      expect(dataReplay.task.id).toBe(data1.task.id);
      expect(dataReplay.task.rankKey).toBe("a0");

      // Verify listing still has exactly 2 tasks in correct rank order
      const listRes = await app.request(`/api/projects/${project.id}/tasks?columnId=${colId}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.tasks).toHaveLength(2);
      expect(listData.tasks[0].id).toBe(data1.task.id);
      expect(listData.tasks[0].rankKey).toBe("a0");
      expect(listData.tasks[1].id).toBe(data2.task.id);
      expect(listData.tasks[1].rankKey).toBe("a1");
    });
  });

  describe("Rank-Key Column Rebalancing (Integration - Milestone 6.5C)", () => {
    describe("Column Rebalancing Helper Behavior", () => {
      it("rebalances active column tasks to compact fractional keys preserving order, versions, and timestamps", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        // Seed 3 active tasks with long/irregular rank keys and distinct versions
        const [t1] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task 1",
          createdBy: owner.user.id,
          rankKey: "a0" + "z".repeat(20),
          version: 3,
        }).returning();

        const [t2] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task 2",
          createdBy: owner.user.id,
          rankKey: "a0" + "z".repeat(20) + "V",
          version: 2,
        }).returning();

        const [t3] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task 3",
          createdBy: owner.user.id,
          rankKey: "b0" + "x".repeat(15),
          version: 5,
        }).returning();

        // Run rebalancer directly within a locked project transaction
        const rebalancedMap = await testDb.transaction(async (tx) => {
          await (tx.select().from(projects).where(eq(projects.id, project.id)) as any).for("update");
          return await (TaskService as any).rebalanceColumnActiveTasks(tx, {
            projectId: project.id,
            columnId: colId,
          });
        });

        expect(rebalancedMap.get(t1.id)).toBe("a0");
        expect(rebalancedMap.get(t2.id)).toBe("a1");
        expect(rebalancedMap.get(t3.id)).toBe("a2");

        // Verify persisted state in PostgreSQL
        const [db1] = await testDb.select().from(tasks).where(eq(tasks.id, t1.id));
        const [db2] = await testDb.select().from(tasks).where(eq(tasks.id, t2.id));
        const [db3] = await testDb.select().from(tasks).where(eq(tasks.id, t3.id));

        expect(db1.rankKey).toBe("a0");
        expect(db1.version).toBe(3);
        expect(db1.updatedAt.getTime()).toBe(t1.updatedAt.getTime());

        expect(db2.rankKey).toBe("a1");
        expect(db2.version).toBe(2);
        expect(db2.updatedAt.getTime()).toBe(t2.updatedAt.getTime());

        expect(db3.rankKey).toBe("a2");
        expect(db3.version).toBe(5);
        expect(db3.updatedAt.getTime()).toBe(t3.updatedAt.getTime());
      });

      it("excludes archived tasks, leaving their rank keys, versions, and timestamps untouched", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        const [tActive1] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Active 1",
          createdBy: owner.user.id,
          rankKey: "z".repeat(30),
          version: 1,
        }).returning();

        const [tArchived] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Archived Task",
          createdBy: owner.user.id,
          rankKey: "y999",
          version: 4,
          archivedAt: new Date(),
        }).returning();

        const [tActive2] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Active 2",
          createdBy: owner.user.id,
          rankKey: "z".repeat(30) + "V",
          version: 2,
        }).returning();

        await testDb.transaction(async (tx) => {
          await (tx.select().from(projects).where(eq(projects.id, project.id)) as any).for("update");
          await (TaskService as any).rebalanceColumnActiveTasks(tx, {
            projectId: project.id,
            columnId: colId,
          });
        });

        const [dbArch] = await testDb.select().from(tasks).where(eq(tasks.id, tArchived.id));
        expect(dbArch.rankKey).toBe("y999");
        expect(dbArch.version).toBe(4);
        expect(dbArch.archivedAt?.getTime()).toBe(tArchived.archivedAt?.getTime());
        expect(dbArch.updatedAt.getTime()).toBe(tArchived.updatedAt.getTime());

        const [dbAct1] = await testDb.select().from(tasks).where(eq(tasks.id, tActive1.id));
        const [dbAct2] = await testDb.select().from(tasks).where(eq(tasks.id, tActive2.id));
        expect(dbAct1.rankKey).toBe("a0");
        expect(dbAct2.rankKey).toBe("a1");
      });

      it("handles empty and single-task columns cleanly without error", async () => {
        const { project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        // Empty column
        const emptyMap = await testDb.transaction(async (tx) => {
          await (tx.select().from(projects).where(eq(projects.id, project.id)) as any).for("update");
          return await (TaskService as any).rebalanceColumnActiveTasks(tx, {
            projectId: project.id,
            columnId: colId,
          });
        });
        expect(emptyMap.size).toBe(0);

        // Single task column
        const { owner } = await setupWorkspaceAndProject("Single User", "single-col@example.com");
        const [tSingle] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Solo Task",
          createdBy: owner.user.id,
          rankKey: "m500",
          version: 1,
        }).returning();

        const singleMap = await testDb.transaction(async (tx) => {
          await (tx.select().from(projects).where(eq(projects.id, project.id)) as any).for("update");
          return await (TaskService as any).rebalanceColumnActiveTasks(tx, {
            projectId: project.id,
            columnId: colId,
          });
        });
        expect(singleMap.get(tSingle.id)).toBe("a0");

        const [dbSingle] = await testDb.select().from(tasks).where(eq(tasks.id, tSingle.id));
        expect(dbSingle.rankKey).toBe("a0");
        expect(dbSingle.version).toBe(1);
      });

      it("skips redundant database updates when task rank keys already match the compact sequence", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        // Seed tasks that already have keys 'a0' and 'a1'
        const [t1] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Already Compact 1",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        }).returning();

        const [t2] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Already Compact 2",
          createdBy: owner.user.id,
          rankKey: "a1",
          version: 1,
        }).returning();

        const rebalancedMap = await testDb.transaction(async (tx) => {
          await (tx.select().from(projects).where(eq(projects.id, project.id)) as any).for("update");
          return await (TaskService as any).rebalanceColumnActiveTasks(tx, {
            projectId: project.id,
            columnId: colId,
          });
        });

        expect(rebalancedMap.get(t1.id)).toBe("a0");
        expect(rebalancedMap.get(t2.id)).toBe("a1");

        const [db1] = await testDb.select().from(tasks).where(eq(tasks.id, t1.id));
        const [db2] = await testDb.select().from(tasks).where(eq(tasks.id, t2.id));
        expect(db1.rankKey).toBe("a0");
        expect(db2.rankKey).toBe("a1");
      });
    });

    describe("Creation-Triggered Rebalancing & Threshold Boundaries", () => {
      it("does not trigger rebalancing when generated append candidate key length is exactly 32 (threshold boundary)", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        // 'z'.repeat(31) produces an append key of 'z'.repeat(31) + 'V', which has length EXACTLY 32
        const seedKey = "z".repeat(31);
        expect(seedKey.length).toBe(31);

        const [seedTask] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Boundary Task 31",
          createdBy: owner.user.id,
          rankKey: seedKey,
          version: 1,
        }).returning();

        const res = await app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": `bound-32-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ title: "New Boundary Task 32", columnId: colId }),
        });

        expect(res.status).toBe(201);
        const data = await res.json();
        expect(data.task.rankKey.length).toBe(32);
        expect(data.task.rankKey).toBe(seedKey + "V");
        expect(data.task.version).toBe(1);

        // Verify existing task was NOT rebalanced
        const [dbSeed] = await testDb.select().from(tasks).where(eq(tasks.id, seedTask.id));
        expect(dbSeed.rankKey).toBe(seedKey);
        expect(dbSeed.version).toBe(1);
      });

      it("triggers column rebalancing when generated append candidate key length exceeds 32 (length 33)", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        // 'z'.repeat(32) produces an append key of 'z'.repeat(32) + 'V', which has length EXACTLY 33 (> 32)
        const longKey = "z".repeat(32);
        expect(longKey.length).toBe(32);

        const [t1] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Initial Active Task",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 2,
        }).returning();

        const [t2] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Long Key Task",
          createdBy: owner.user.id,
          rankKey: longKey,
          version: 3,
        }).returning();

        const [tArch] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Archived Unaffected Task",
          createdBy: owner.user.id,
          rankKey: "m999",
          version: 1,
          archivedAt: new Date(),
        }).returning();

        const idempKey = `create-rebal-${crypto.randomUUID()}`;
        const res = await app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": idempKey,
          },
          body: JSON.stringify({ title: "Triggering Task", columnId: colId }),
        });

        expect(res.status).toBe(201);
        const data = await res.json();

        // New task appended after rebalanced tasks
        expect(data.task.rankKey).toBe("a2");
        expect(data.task.version).toBe(1);

        // Verify existing active tasks received compact keys with versions and timestamps preserved
        const [db1] = await testDb.select().from(tasks).where(eq(tasks.id, t1.id));
        const [db2] = await testDb.select().from(tasks).where(eq(tasks.id, t2.id));
        const [dbArch] = await testDb.select().from(tasks).where(eq(tasks.id, tArch.id));

        expect(db1.rankKey).toBe("a0");
        expect(db1.version).toBe(2);
        expect(db1.updatedAt.getTime()).toBe(t1.updatedAt.getTime());

        expect(db2.rankKey).toBe("a1");
        expect(db2.version).toBe(3);
        expect(db2.updatedAt.getTime()).toBe(t2.updatedAt.getTime());

        expect(dbArch.rankKey).toBe("m999");
        expect(dbArch.version).toBe(1);
        expect(dbArch.archivedAt?.getTime()).toBe(tArch.archivedAt?.getTime());

        // Verify list ordering
        const listRes = await app.request(`/api/projects/${project.id}/tasks?columnId=${colId}`, {
          headers: { Cookie: owner.cookie },
        });
        const listData = await listRes.json();
        expect(listData.tasks.map((t: any) => t.id)).toEqual([t1.id, t2.id, data.task.id]);
        expect(listData.tasks.map((t: any) => t.rankKey)).toEqual(["a0", "a1", "a2"]);

        // Idempotency replay returns exact task without re-rebalancing
        const replayRes = await app.request(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
            "Idempotency-Key": idempKey,
          },
          body: JSON.stringify({ title: "Triggering Task", columnId: colId }),
        });
        expect(replayRes.status).toBe(201);
        const replayData = await replayRes.json();
        expect(replayData.task.id).toBe(data.task.id);
        expect(replayData.task.rankKey).toBe("a2");
      });
    });

    describe("Movement-Triggered Rebalancing & Threshold Boundaries", () => {
      it("does not trigger rebalancing when between-neighbor candidate key is exactly 32 characters", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const col0 = columns[0];
        const col1 = columns[1];

        // Between 'a0' + 'z'.repeat(29) (length 31) and 'a1': midpoint is length EXACTLY 32 ('a0' + 'z'.repeat(29) + 'V')
        const prevKey = "a0" + "z".repeat(29);
        expect(prevKey.length).toBe(31);

        const [tPrev] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col1.id,
          title: "Anchor Prev",
          createdBy: owner.user.id,
          rankKey: prevKey,
          version: 1,
        }).returning();

        const [tNext] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col1.id,
          title: "Anchor Next",
          createdBy: owner.user.id,
          rankKey: "a1",
          version: 1,
        }).returning();

        const [tMover] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col0.id,
          title: "Mover Task",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        }).returning();

        const res = await app.request(`/api/tasks/${tMover.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({
            columnId: col1.id,
            expectedVersion: 1,
            prevTaskId: tPrev.id,
            nextTaskId: tNext.id,
          }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.task.rankKey.length).toBe(32);
        expect(data.task.rankKey).toBe(prevKey + "V");
        expect(data.task.version).toBe(2);

        // Anchors retain their keys and versions
        const [dbPrev] = await testDb.select().from(tasks).where(eq(tasks.id, tPrev.id));
        const [dbNext] = await testDb.select().from(tasks).where(eq(tasks.id, tNext.id));
        expect(dbPrev.rankKey).toBe(prevKey);
        expect(dbPrev.version).toBe(1);
        expect(dbNext.rankKey).toBe("a1");
        expect(dbNext.version).toBe(1);
      });

      it("triggers rebalancing on same-column movement between two anchors when candidate key exceeds 32 characters", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        // Between 'a0' + 'z'.repeat(30) (length 32) and 'a1': midpoint is length 33 (> 32)
        const prevKey = "a0" + "z".repeat(30);
        expect(prevKey.length).toBe(32);

        const [tA] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task A",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        }).returning();

        const [tB] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task B",
          createdBy: owner.user.id,
          rankKey: prevKey,
          version: 2,
        }).returning();

        const [tC] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task C",
          createdBy: owner.user.id,
          rankKey: "a1",
          version: 1,
        }).returning();

        const [tMover] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task Mover",
          createdBy: owner.user.id,
          rankKey: "a2",
          version: 1,
        }).returning();

        // Move tMover between tB and tC
        const res = await app.request(`/api/tasks/${tMover.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({
            columnId: colId,
            expectedVersion: 1,
            prevTaskId: tB.id,
            nextTaskId: tC.id,
          }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();

        // tMover should increment version to 2
        expect(data.task.version).toBe(2);

        // In DB: tMover excluded from destination column rebalance, so tA, tB, tC become a0, a1, a2
        // Then tMover is placed between tB (now a1) and tC (now a2) -> 'a1V'
        const [dbA] = await testDb.select().from(tasks).where(eq(tasks.id, tA.id));
        const [dbB] = await testDb.select().from(tasks).where(eq(tasks.id, tB.id));
        const [dbC] = await testDb.select().from(tasks).where(eq(tasks.id, tC.id));
        const [dbMover] = await testDb.select().from(tasks).where(eq(tasks.id, tMover.id));

        expect(dbA.rankKey).toBe("a0");
        expect(dbA.version).toBe(1);
        expect(dbA.updatedAt.getTime()).toBe(tA.updatedAt.getTime());

        expect(dbB.rankKey).toBe("a1");
        expect(dbB.version).toBe(2);
        expect(dbB.updatedAt.getTime()).toBe(tB.updatedAt.getTime());

        expect(dbC.rankKey).toBe("a2");
        expect(dbC.version).toBe(1);
        expect(dbC.updatedAt.getTime()).toBe(tC.updatedAt.getTime());

        expect(dbMover.rankKey).toBe("a1V");
        expect(dbMover.version).toBe(2);

        // Logical ordering verification
        const listRes = await app.request(`/api/projects/${project.id}/tasks?columnId=${colId}`, {
          headers: { Cookie: owner.cookie },
        });
        const listData = await listRes.json();
        expect(listData.tasks.map((t: any) => t.id)).toEqual([tA.id, tB.id, tMover.id, tC.id]);
        expect(listData.tasks.map((t: any) => t.rankKey)).toEqual(["a0", "a1", "a1V", "a2"]);
      });

      it("triggers rebalancing on prepending when candidate key exceeds 32 characters", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const col0 = columns[0];
        const col1 = columns[1];

        // Seed task in col1 with a key that makes prepending exceed 32 chars:
        // 'A' + '0'.repeat(31) + 'V' has length 33
        const firstKey = "A" + "0".repeat(31) + "V";
        expect(firstKey.length).toBe(33);

        const [tFirst] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col1.id,
          title: "First Task with Long Key",
          createdBy: owner.user.id,
          rankKey: firstKey,
          version: 1,
        }).returning();

        const [tMover] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col0.id,
          title: "Prepending Mover",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        }).returning();

        const res = await app.request(`/api/tasks/${tMover.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({
            columnId: col1.id,
            expectedVersion: 1,
            nextTaskId: tFirst.id,
          }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.task.version).toBe(2);

        // Rebalanced tFirst -> a0. Prepend before a0 gives Zz
        const [dbFirst] = await testDb.select().from(tasks).where(eq(tasks.id, tFirst.id));
        const [dbMover] = await testDb.select().from(tasks).where(eq(tasks.id, tMover.id));

        expect(dbFirst.rankKey).toBe("a0");
        expect(dbFirst.version).toBe(1);
        expect(dbMover.rankKey).toBe("Zz");
        expect(dbMover.rankKey < dbFirst.rankKey).toBe(true);

        const listRes = await app.request(`/api/projects/${project.id}/tasks?columnId=${col1.id}`, {
          headers: { Cookie: owner.cookie },
        });
        const listData = await listRes.json();
        expect(listData.tasks.map((t: any) => t.id)).toEqual([tMover.id, tFirst.id]);
      });

      it("rebalances destination column only on cross-column movement, leaving source column intact", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const col0 = columns[0];
        const col1 = columns[1];

        const [sourceTask] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col0.id,
          title: "Source Stable Task",
          createdBy: owner.user.id,
          rankKey: "z".repeat(30),
          version: 4,
        }).returning();

        const [tMover] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col0.id,
          title: "Cross Column Mover",
          createdBy: owner.user.id,
          rankKey: "z".repeat(30) + "V",
          version: 1,
        }).returning();

        const [destTask] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col1.id,
          title: "Dest Task Triggering Rebalance",
          createdBy: owner.user.id,
          rankKey: "z".repeat(32),
          version: 2,
        }).returning();

        // Move tMover to col1 (append)
        const res = await app.request(`/api/tasks/${tMover.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({
            columnId: col1.id,
            expectedVersion: 1,
          }),
        });

        expect(res.status).toBe(200);

        // Destination column rebalanced
        const [dbDest] = await testDb.select().from(tasks).where(eq(tasks.id, destTask.id));
        const [dbMover] = await testDb.select().from(tasks).where(eq(tasks.id, tMover.id));
        expect(dbDest.rankKey).toBe("a0");
        expect(dbDest.version).toBe(2);
        expect(dbMover.rankKey).toBe("a1");
        expect(dbMover.version).toBe(2);

        // Source column unchanged
        const [dbSource] = await testDb.select().from(tasks).where(eq(tasks.id, sourceTask.id));
        expect(dbSource.rankKey).toBe("z".repeat(30));
        expect(dbSource.version).toBe(4);
        expect(dbSource.updatedAt.getTime()).toBe(sourceTask.updatedAt.getTime());
      });

      it("same-column no-op move does not trigger rebalancing even if candidate would exceed 32 characters", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        const [tA] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task A",
          createdBy: owner.user.id,
          rankKey: "a0" + "z".repeat(30),
          version: 1,
        }).returning();

        const [tMover] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task Middle",
          createdBy: owner.user.id,
          rankKey: "a0" + "z".repeat(30) + "V",
          version: 1,
        }).returning();

        const [tB] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task B",
          createdBy: owner.user.id,
          rankKey: "a1",
          version: 1,
        }).returning();

        // Move tMover to its exact same position between tA and tB
        const res = await app.request(`/api/tasks/${tMover.id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({
            columnId: colId,
            expectedVersion: 1,
            prevTaskId: tA.id,
            nextTaskId: tB.id,
          }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.task.id).toBe(tMover.id);
        expect(data.task.version).toBe(1);
        expect(data.task.rankKey).toBe(tMover.rankKey);

        // Zero tasks were rebalanced
        const [dbA] = await testDb.select().from(tasks).where(eq(tasks.id, tA.id));
        const [dbMover] = await testDb.select().from(tasks).where(eq(tasks.id, tMover.id));
        const [dbB] = await testDb.select().from(tasks).where(eq(tasks.id, tB.id));
        expect(dbA.rankKey).toBe(tA.rankKey);
        expect(dbMover.rankKey).toBe(tMover.rankKey);
        expect(dbB.rankKey).toBe(tB.rankKey);
      });
    });

    describe("Restoration-Triggered Rebalancing", () => {
      it("restores task preserving original rank key when no collision exists (no rebalance)", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        const [t1] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task 1",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        }).returning();

        const [tArchived] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Archived Task",
          createdBy: owner.user.id,
          rankKey: "a1",
          version: 1,
          archivedAt: new Date(),
        }).returning();

        const [t3] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task 3",
          createdBy: owner.user.id,
          rankKey: "a2",
          version: 1,
        }).returning();

        const res = await app.request(`/api/tasks/${tArchived.id}/restore`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.task.rankKey).toBe("a1");
        expect(data.task.archivedAt).toBeNull();
        expect(data.task.version).toBe(2);

        // Verify ordering in column
        const listRes = await app.request(`/api/projects/${project.id}/tasks?columnId=${colId}`, {
          headers: { Cookie: owner.cookie },
        });
        const listData = await listRes.json();
        expect(listData.tasks.map((t: any) => t.id)).toEqual([t1.id, tArchived.id, t3.id]);
        expect(listData.tasks.map((t: any) => t.rankKey)).toEqual(["a0", "a1", "a2"]);
      });

      it("appends on collision without rebalance when append candidate length is <= 32", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        const [tActive] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Active Task",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        }).returning();

        const [tArchived] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Colliding Archived Task",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
          archivedAt: new Date(),
        }).returning();

        const res = await app.request(`/api/tasks/${tArchived.id}/restore`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.task.rankKey).toBe("a1");
        expect(data.task.version).toBe(2);

        const [dbActive] = await testDb.select().from(tasks).where(eq(tasks.id, tActive.id));
        expect(dbActive.rankKey).toBe("a0");
        expect(dbActive.version).toBe(1);
      });

      it("triggers column rebalancing on collision when append candidate length exceeds 32", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        const [tActive1] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Active Task 1",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 2,
        }).returning();

        const [tActive2] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Active Task Long",
          createdBy: owner.user.id,
          rankKey: "z".repeat(32),
          version: 3,
        }).returning();

        const [tArchived] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Archived Colliding Task",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
          archivedAt: new Date(),
        }).returning();

        const res = await app.request(`/api/tasks/${tArchived.id}/restore`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.task.version).toBe(2);
        expect(data.task.archivedAt).toBeNull();
        expect(data.task.rankKey).toBe("a2");

        // Existing tasks preserved
        const [db1] = await testDb.select().from(tasks).where(eq(tasks.id, tActive1.id));
        const [db2] = await testDb.select().from(tasks).where(eq(tasks.id, tActive2.id));
        expect(db1.rankKey).toBe("a0");
        expect(db1.version).toBe(2);
        expect(db1.updatedAt.getTime()).toBe(tActive1.updatedAt.getTime());

        expect(db2.rankKey).toBe("a1");
        expect(db2.version).toBe(3);
        expect(db2.updatedAt.getTime()).toBe(tActive2.updatedAt.getTime());

        // Repeated restore is idempotent no-op
        const repeatRes = await app.request(`/api/tasks/${tArchived.id}/restore`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        });
        expect(repeatRes.status).toBe(200);
        const repeatData = await repeatRes.json();
        expect(repeatData.task.version).toBe(2);
        expect(repeatData.task.rankKey).toBe("a2");
      });
    });

    describe("Rollback & Transaction Atomicity", () => {
      it("rolls back all rebalanced keys, task mutations, and version changes if transaction fails before commit", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        const [t1] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task Stable A",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 2,
        }).returning();

        const [t2] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Task Long B",
          createdBy: owner.user.id,
          rankKey: "z".repeat(32),
          version: 3,
        }).returning();

        // Wrap testDb.transaction to trigger rebalance and then throw before commit
        const failingDb = {
          ...testDb,
          transaction: async (cb: any) => {
            return await testDb.transaction(async (tx) => {
              await cb(tx);
              throw new Error("Simulated transactional rollback after rebalance");
            });
          },
        } as any;

        await expect(
          TaskService.createTask(failingDb, {
            projectId: project.id,
            callerId: owner.user.id,
            title: "Doomed Task",
            columnId: colId,
            idempotencyKey: `fail-rebal-${crypto.randomUUID()}`,
            requestPath: `/api/projects/${project.id}/tasks`,
          })
        ).rejects.toThrow("Simulated transactional rollback after rebalance");

        // Verify PostgreSQL state: everything rolled back completely
        const [db1] = await testDb.select().from(tasks).where(eq(tasks.id, t1.id));
        const [db2] = await testDb.select().from(tasks).where(eq(tasks.id, t2.id));

        expect(db1.rankKey).toBe("a0");
        expect(db1.version).toBe(2);

        expect(db2.rankKey).toBe("z".repeat(32));
        expect(db2.version).toBe(3);

        const allTasks = await testDb.select().from(tasks).where(eq(tasks.projectId, project.id));
        expect(allTasks).toHaveLength(2);
      });
    });

    describe("Concurrency and Rebalancing Serialization", () => {
      it("handles concurrent task creation with rebalancing producing strictly distinct sequential rank keys and deterministic order", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const colId = columns[0].id;

        // Column has task with long key that will trigger rebalance on append
        await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: colId,
          title: "Existing Long Task",
          createdBy: owner.user.id,
          rankKey: "z".repeat(32),
          version: 1,
        });

        // Two concurrent creation requests
        const [res1, res2] = await Promise.all([
          app.request(`/api/projects/${project.id}/tasks`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: owner.cookie,
              "Idempotency-Key": `conc-rebal-1-${crypto.randomUUID()}`,
            },
            body: JSON.stringify({ title: "Concurrent Rebal 1", columnId: colId }),
          }),
          app.request(`/api/projects/${project.id}/tasks`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: owner.cookie,
              "Idempotency-Key": `conc-rebal-2-${crypto.randomUUID()}`,
            },
            body: JSON.stringify({ title: "Concurrent Rebal 2", columnId: colId }),
          }),
        ]);

        expect(res1.status).toBe(201);
        expect(res2.status).toBe(201);

        const listRes = await app.request(`/api/projects/${project.id}/tasks?columnId=${colId}`, {
          headers: { Cookie: owner.cookie },
        });
        const listData = await listRes.json();
        expect(listData.tasks).toHaveLength(3);

        const rankKeys = listData.tasks.map((t: any) => t.rankKey);
        expect(new Set(rankKeys).size).toBe(3);
        expect(rankKeys).toEqual(["a0", "a1", "a2"]);
      });

      it("handles concurrent movement into a column requiring rebalance", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const col0 = columns[0];
        const col1 = columns[1];

        // Seed destination column with task that triggers rebalance on append
        await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col1.id,
          title: "Dest Long Task",
          createdBy: owner.user.id,
          rankKey: "z".repeat(32),
          version: 1,
        });

        // Seed two mover tasks in col0
        const [mover1] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col0.id,
          title: "Mover 1",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        }).returning();

        const [mover2] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col0.id,
          title: "Mover 2",
          createdBy: owner.user.id,
          rankKey: "a1",
          version: 1,
        }).returning();

        // Concurrently move both into col1 (appended)
        const [moveRes1, moveRes2] = await Promise.all([
          app.request(`/api/tasks/${mover1.id}/move`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: owner.cookie },
            body: JSON.stringify({ columnId: col1.id, expectedVersion: 1 }),
          }),
          app.request(`/api/tasks/${mover2.id}/move`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: owner.cookie },
            body: JSON.stringify({ columnId: col1.id, expectedVersion: 1 }),
          }),
        ]);

        expect(moveRes1.status).toBe(200);
        expect(moveRes2.status).toBe(200);

        const listRes = await app.request(`/api/projects/${project.id}/tasks?columnId=${col1.id}`, {
          headers: { Cookie: owner.cookie },
        });
        const listData = await listRes.json();
        expect(listData.tasks).toHaveLength(3);

        const rankKeys = listData.tasks.map((t: any) => t.rankKey);
        expect(new Set(rankKeys).size).toBe(3);
        expect(rankKeys).toEqual(["a0", "a1", "a2"]);
      });

      it("handles concurrent restoration and move where restoration triggers rebalance", async () => {
        const { owner, project, columns } = await setupWorkspaceAndProject();
        const col0 = columns[0];
        const col1 = columns[1];

        // Destination column col1 has an active task and an active task with long key
        await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col1.id,
          title: "Dest Task 1",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        });

        await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col1.id,
          title: "Dest Long Task",
          createdBy: owner.user.id,
          rankKey: "z".repeat(32),
          version: 1,
        });

        // Archived task in col1 with rankKey 'a0' (will collide with Dest Task 1)
        const [tArchived] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col1.id,
          title: "Archived Colliding",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
          archivedAt: new Date(),
        }).returning();

        // Mover in col0
        const [mover] = await testDb.insert(tasks).values({
          projectId: project.id,
          columnId: col0.id,
          title: "Col0 Mover",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        }).returning();

        // Concurrently restore tArchived (triggers rebalance) and move mover to col1
        const [restoreRes, moveRes] = await Promise.all([
          app.request(`/api/tasks/${tArchived.id}/restore`, {
            method: "POST",
            headers: { Cookie: owner.cookie },
          }),
          app.request(`/api/tasks/${mover.id}/move`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: owner.cookie },
            body: JSON.stringify({ columnId: col1.id, expectedVersion: 1 }),
          }),
        ]);

        expect(restoreRes.status).toBe(200);
        expect(moveRes.status).toBe(200);

        const listRes = await app.request(`/api/projects/${project.id}/tasks?columnId=${col1.id}`, {
          headers: { Cookie: owner.cookie },
        });
        const listData = await listRes.json();
        expect(listData.tasks).toHaveLength(4);

        const rankKeys = listData.tasks.map((t: any) => t.rankKey);
        expect(new Set(rankKeys).size).toBe(4);
      });
    });
  });
});

