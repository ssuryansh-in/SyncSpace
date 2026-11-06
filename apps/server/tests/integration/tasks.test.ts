import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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
} from "../../src/db/schema/index.js";
import { cleanTables, testDb, testSqlClient } from "./setup.js";

describe("Tasks Management & Relational Validation (Integration - Milestone 6.1)", () => {
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
      expect(data.task.rankKey).toBe("a00000");
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json", Cookie: outsider.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: admin.cookie },
        body: JSON.stringify({ title: "Admin Task", columnId: columns[0].id }),
      });
      expect(adminRes.status).toBe(201);

      // 2. Member creates task
      const memberRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: member.cookie },
        body: JSON.stringify({ title: "Member Task", columnId: columns[1].id }),
      });
      expect(memberRes.status).toBe(201);
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Task A1", columnId: colsA[0].id }),
      });
      const resA2 = await app.request(`/api/projects/${projA.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Task A2", columnId: colsA[1].id }),
      });
      const { task: taskA2 } = await resA2.json();

      // Create 1 task in Project B
      await app.request(`/api/projects/${projB.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Backlog 1", columnId: backlogCol.id }),
      });
      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Assigned Task", columnId: columns[0].id, assigneeId: member.user.id }),
      });
      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
  });

  describe("Task Details (GET /api/tasks/:taskId)", () => {
    it("retrieves task details for an active task", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const createRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
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
});

