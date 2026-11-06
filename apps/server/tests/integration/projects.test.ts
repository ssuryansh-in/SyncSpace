import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth/index.js";
import { createEmailService, clearSentEmailsForTest } from "../../src/services/email.js";
import { loadEnv } from "../../src/config/env.js";
import { ProjectService } from "../../src/services/project.js";
import { WorkspaceService } from "../../src/services/workspace.js";
import {
  users,
  workspaces,
  workspaceMembers,
  projects,
  projectColumns,
} from "../../src/db/schema/index.js";
import { cleanTables, testDb, testSqlClient } from "./setup.js";

describe("Project Management & Board Initialization (Integration - Milestone 5.1)", () => {
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
    // 1. Sign up
    await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({ name, email, password }),
    });

    // 2. Mark verified
    const [dbUser] = await testDb
      .select()
      .from(users)
      .where(eq(users.email, email));

    await testDb
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, dbUser.id));

    // 3. Sign in to obtain session cookie
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

  describe("Authentication & Session Guards", () => {
    it("rejects unauthenticated requests with 401 UNAUTHENTICATED", async () => {
      const endpoints = [
        {
          method: "POST",
          path: "/api/workspaces/00000000-0000-0000-0000-000000000001/projects",
          body: { name: "Test Project" },
        },
        {
          method: "GET",
          path: "/api/workspaces/00000000-0000-0000-0000-000000000001/projects",
        },
        {
          method: "GET",
          path: "/api/projects/00000000-0000-0000-0000-000000000001",
        },
        {
          method: "GET",
          path: "/api/projects/00000000-0000-0000-0000-000000000001/board",
        },
        {
          method: "PATCH",
          path: "/api/projects/00000000-0000-0000-0000-000000000001",
          body: { name: "Renamed Project" },
        },
        {
          method: "POST",
          path: "/api/projects/00000000-0000-0000-0000-000000000001/archive",
        },
        {
          method: "POST",
          path: "/api/projects/00000000-0000-0000-0000-000000000001/restore",
        },
      ];

      for (const ep of endpoints) {
        const res = await app.request(ep.path, {
          method: ep.method,
          headers: { "Content-Type": "application/json" },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        });

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error.code).toBe("UNAUTHENTICATED");
      }
    });
  });

  describe("Project Creation & Atomic Column Seeding", () => {
    it("atomically creates a project and seeds the 4 default columns", async () => {
      const { user, cookie } = await createAndLoginUser(
        "Marie Curie",
        "marie@example.com"
      );

      // Create workspace
      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Radium Lab" }),
      });
      const { workspace } = await wsRes.json();

      // Create project
      const projRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({ name: "Isotope Isolation" }),
        }
      );

      expect(projRes.status).toBe(201);
      const data = await projRes.json();
      expect(data.project.name).toBe("Isotope Isolation");
      expect(data.project.workspaceId).toBe(workspace.id);
      expect(data.project.createdBy).toBe(user.id);
      expect(data.project.lastSeq).toBe(0);
      expect(data.project.archivedAt).toBeNull();

      // Verify the 4 default columns in response
      expect(data.columns).toHaveLength(4);
      expect(data.columns).toEqual([
        expect.objectContaining({ name: "Backlog", position: 0 }),
        expect.objectContaining({ name: "Todo", position: 1 }),
        expect.objectContaining({ name: "In Progress", position: 2 }),
        expect.objectContaining({ name: "Done", position: 3 }),
      ]);

      // Verify PostgreSQL persisted state
      const [dbProj] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, data.project.id));
      expect(dbProj).toBeDefined();
      expect(dbProj.name).toBe("Isotope Isolation");

      const dbCols = await testDb
        .select()
        .from(projectColumns)
        .where(eq(projectColumns.projectId, data.project.id));
      expect(dbCols).toHaveLength(4);
    });

    it("rejects invalid project names with 400 VALIDATION_ERROR", async () => {
      const { cookie } = await createAndLoginUser(
        "Isaac Newton",
        "isaac@example.com"
      );

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Principia Space" }),
      });
      const { workspace } = await wsRes.json();

      // Empty name
      const res1 = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "" }),
      });
      expect(res1.status).toBe(400);
      const body1 = await res1.json();
      expect(body1.error.code).toBe("VALIDATION_ERROR");

      // Whitespace only
      const res2 = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "    " }),
      });
      expect(res2.status).toBe(400);

      // Exceeds 100 characters
      const res3 = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "P".repeat(101) }),
      });
      expect(res3.status).toBe(400);
    });

    it("rejects invalid UUID parameters with 400 VALIDATION_ERROR", async () => {
      const { cookie } = await createAndLoginUser("User", "user-uuid@example.com");

      // Non-UUID workspace ID
      const res1 = await app.request("/api/workspaces/not-a-uuid/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Project" }),
      });
      expect(res1.status).toBe(400);

      const res2 = await app.request("/api/workspaces/not-a-uuid/projects", {
        headers: { Cookie: cookie },
      });
      expect(res2.status).toBe(400);

      // Non-UUID project ID
      const res3 = await app.request("/api/projects/not-a-uuid", {
        headers: { Cookie: cookie },
      });
      expect(res3.status).toBe(400);

      const res4 = await app.request("/api/projects/not-a-uuid/board", {
        headers: { Cookie: cookie },
      });
      expect(res4.status).toBe(400);

      const res5 = await app.request("/api/projects/not-a-uuid", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "New Name" }),
      });
      expect(res5.status).toBe(400);

      const res6 = await app.request("/api/projects/not-a-uuid/archive", {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(res6.status).toBe(400);

      const res7 = await app.request("/api/projects/not-a-uuid/restore", {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(res7.status).toBe(400);
    });

    it("rolls back project creation if an error occurs before transaction commit", async () => {
      const { user, cookie } = await createAndLoginUser(
        "Rollback Tester",
        "rollback-tester@example.com"
      );

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Rollback Workspace" }),
      });
      const { workspace } = await wsRes.json();

      // Wrap testDb.transaction to throw an error before transaction commits
      const failingDb = {
        ...testDb,
        transaction: async (cb: any) => {
          return await testDb.transaction(async (tx) => {
            await cb(tx);
            throw new Error("Simulated transactional failure before commit");
          });
        },
      } as any;

      await expect(
        ProjectService.createProject(failingDb, {
          workspaceId: workspace.id,
          callerId: user.id,
          name: "Doomed Project",
        })
      ).rejects.toThrow("Simulated transactional failure before commit");

      // Verify PostgreSQL state: neither project nor columns were committed
      const dbProjects = await testDb
        .select()
        .from(projects)
        .where(eq(projects.name, "Doomed Project"));
      expect(dbProjects).toHaveLength(0);

      const dbCols = await testDb
        .select()
        .from(projectColumns);
      expect(dbCols).toHaveLength(0);
    });
  });

  describe("Role Permission Matrix (Owner, Admin, Member)", () => {
    it("allows Owner, Admin, and regular Member to create and list projects", async () => {
      const owner = await createAndLoginUser("Owner", "owner-proj@example.com");
      const admin = await createAndLoginUser("Admin", "admin-proj@example.com");
      const member = await createAndLoginUser("Member", "member-proj@example.com");

      // 1. Owner creates workspace
      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Permission Workspace" }),
      });
      const { workspace } = await wsRes.json();

      // Add admin and member to workspace
      await testDb.insert(workspaceMembers).values([
        { workspaceId: workspace.id, userId: admin.user.id, role: "admin" },
        { workspaceId: workspace.id, userId: member.user.id, role: "member" },
      ]);

      // 2. Owner creates Project A
      const resOwner = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name: "Owner Project" }),
        }
      );
      expect(resOwner.status).toBe(201);

      // 3. Admin creates Project B
      const resAdmin = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: admin.cookie },
          body: JSON.stringify({ name: "Admin Project" }),
        }
      );
      expect(resAdmin.status).toBe(201);

      // 4. Regular Member creates Project C (Specification Section 4.2: Member=Yes)
      const resMember = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: member.cookie },
          body: JSON.stringify({ name: "Member Project" }),
        }
      );
      expect(resMember.status).toBe(201);

      // 5. Member can list all 3 projects
      const listRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          headers: { Cookie: member.cookie },
        }
      );
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.projects).toHaveLength(3);
      expect(listData.projects.map((p: any) => p.name)).toEqual([
        "Owner Project",
        "Admin Project",
        "Member Project",
      ]);
    });
  });

  describe("Project Listing, Details & Board Columns Retrieval", () => {
    it("retrieves project details and board columns ordered by position", async () => {
      const owner = await createAndLoginUser("Owner", "details-owner@example.com");

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Board WS" }),
      });
      const { workspace } = await wsRes.json();

      const projRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name: "Kanban Board Project" }),
        }
      );
      const { project } = await projRes.json();

      // 1. GET /api/projects/:projectId
      const getRes = await app.request(`/api/projects/${project.id}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.project.id).toBe(project.id);
      expect(getData.project.name).toBe("Kanban Board Project");
      expect(getData.project.workspaceId).toBe(workspace.id);

      // 2. GET /api/projects/:projectId/board
      const boardRes = await app.request(`/api/projects/${project.id}/board`, {
        headers: { Cookie: owner.cookie },
      });
      expect(boardRes.status).toBe(200);
      const boardData = await boardRes.json();
      expect(boardData.project.id).toBe(project.id);
      expect(boardData.columns).toHaveLength(4);
      expect(boardData.columns.map((c: any) => c.name)).toEqual([
        "Backlog",
        "Todo",
        "In Progress",
        "Done",
      ]);
      expect(boardData.columns.map((c: any) => c.position)).toEqual([
        0, 1, 2, 3,
      ]);
    });
  });

  describe("Cross-Workspace Tenant Isolation (404 Concealment)", () => {
    it("returns 404 NOT_FOUND when a non-member attempts to create, list, or view projects", async () => {
      const ownerA = await createAndLoginUser("Owner A", "ownera-iso@example.com");
      const userB = await createAndLoginUser("User B", "userb-iso@example.com");

      // Owner A creates Workspace A and Project A
      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ownerA.cookie },
        body: JSON.stringify({ name: "Workspace A" }),
      });
      const { workspace: wsA } = await wsRes.json();

      const projRes = await app.request(
        `/api/workspaces/${wsA.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: ownerA.cookie },
          body: JSON.stringify({ name: "Project Alpha" }),
        }
      );
      const { project: projA } = await projRes.json();

      // 1. User B attempts to create project in Workspace A -> 404 NOT_FOUND
      const nonMemberCreate = await app.request(
        `/api/workspaces/${wsA.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userB.cookie },
          body: JSON.stringify({ name: "Infiltrator Project" }),
        }
      );
      expect(nonMemberCreate.status).toBe(404);
      const createBody = await nonMemberCreate.json();
      expect(createBody.error.code).toBe("NOT_FOUND");

      // 2. User B attempts to list projects in Workspace A -> 404 NOT_FOUND
      const nonMemberList = await app.request(
        `/api/workspaces/${wsA.id}/projects`,
        {
          headers: { Cookie: userB.cookie },
        }
      );
      expect(nonMemberList.status).toBe(404);
      const listBody = await nonMemberList.json();
      expect(listBody.error.code).toBe("NOT_FOUND");

      // 3. User B attempts to view Project A details -> 404 NOT_FOUND
      const nonMemberGet = await app.request(`/api/projects/${projA.id}`, {
        headers: { Cookie: userB.cookie },
      });
      expect(nonMemberGet.status).toBe(404);
      const getBody = await nonMemberGet.json();
      expect(getBody.error.code).toBe("NOT_FOUND");

      // 4. User B attempts to view Project A board columns -> 404 NOT_FOUND
      const nonMemberBoard = await app.request(
        `/api/projects/${projA.id}/board`,
        {
          headers: { Cookie: userB.cookie },
        }
      );
      expect(nonMemberBoard.status).toBe(404);
      const boardBody = await nonMemberBoard.json();
      expect(boardBody.error.code).toBe("NOT_FOUND");

      // 5. Querying non-existent project UUID -> 404 NOT_FOUND
      const nonExistentGet = await app.request(
        "/api/projects/00000000-0000-0000-0000-999999999999",
        {
          headers: { Cookie: userB.cookie },
        }
      );
      expect(nonExistentGet.status).toBe(404);

      // 6. User B attempts to rename Project A -> 404 NOT_FOUND
      const nonMemberPatch = await app.request(`/api/projects/${projA.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: userB.cookie },
        body: JSON.stringify({ name: "Hijacked Project" }),
      });
      expect(nonMemberPatch.status).toBe(404);
      const patchBody = await nonMemberPatch.json();
      expect(patchBody.error.code).toBe("NOT_FOUND");

      // 7. User B attempts to archive Project A -> 404 NOT_FOUND
      const nonMemberArchive = await app.request(
        `/api/projects/${projA.id}/archive`,
        {
          method: "POST",
          headers: { Cookie: userB.cookie },
        }
      );
      expect(nonMemberArchive.status).toBe(404);
      const archiveBody = await nonMemberArchive.json();
      expect(archiveBody.error.code).toBe("NOT_FOUND");

      // 8. User B attempts to restore Project A -> 404 NOT_FOUND
      const nonMemberRestore = await app.request(
        `/api/projects/${projA.id}/restore`,
        {
          method: "POST",
          headers: { Cookie: userB.cookie },
        }
      );
      expect(nonMemberRestore.status).toBe(404);
      const restoreBody = await nonMemberRestore.json();
      expect(restoreBody.error.code).toBe("NOT_FOUND");
    });
  });

  describe("Project Rename (Milestone 5.2)", () => {
    it("allows Owner and Admin to rename an active project with trimmed name", async () => {
      const owner = await createAndLoginUser("Owner", "rename-owner@example.com");
      const admin = await createAndLoginUser("Admin", "rename-admin@example.com");

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Rename Workspace" }),
      });
      const { workspace } = await wsRes.json();

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: admin.user.id,
        role: "admin",
      });

      const projRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name: "Original Name" }),
        }
      );
      const { project } = await projRes.json();
      const initialUpdatedAt = new Date(project.updatedAt).getTime();

      // Ensure timestamp distinction if clock resolution requires it
      await new Promise((r) => setTimeout(r, 10));

      // 1. Owner renames project with whitespace to verify trimming
      const renameRes1 = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "  Owner Renamed Project  " }),
      });
      expect(renameRes1.status).toBe(200);
      const data1 = await renameRes1.json();
      expect(data1.project.name).toBe("Owner Renamed Project");
      expect(new Date(data1.project.updatedAt).getTime()).toBeGreaterThanOrEqual(
        initialUpdatedAt
      );

      // Verify in DB
      const [dbProj1] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProj1.name).toBe("Owner Renamed Project");

      await new Promise((r) => setTimeout(r, 10));

      // 2. Admin renames project
      const renameRes2 = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: admin.cookie },
        body: JSON.stringify({ name: "Admin Renamed Project" }),
      });
      expect(renameRes2.status).toBe(200);
      const data2 = await renameRes2.json();
      expect(data2.project.name).toBe("Admin Renamed Project");
    });

    it("rejects regular Member attempts to rename with 403 FORBIDDEN", async () => {
      const owner = await createAndLoginUser("Owner", "rename-forbid-owner@example.com");
      const member = await createAndLoginUser("Member", "rename-forbid-member@example.com");

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Member Forbidden WS" }),
      });
      const { workspace } = await wsRes.json();

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const projRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name: "Untouchable Project" }),
        }
      );
      const { project } = await projRes.json();

      const patchRes = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: member.cookie },
        body: JSON.stringify({ name: "Member Hack Attempt" }),
      });
      expect(patchRes.status).toBe(403);
      const body = await patchRes.json();
      expect(body.error.code).toBe("FORBIDDEN");

      // Verify DB unchanged
      const [dbProj] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProj.name).toBe("Untouchable Project");
    });

    it("rejects invalid rename payloads with 400 VALIDATION_ERROR", async () => {
      const owner = await createAndLoginUser("Owner", "rename-val-owner@example.com");

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Validation WS" }),
      });
      const { workspace } = await wsRes.json();

      const projRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name: "Valid Project" }),
        }
      );
      const { project } = await projRes.json();

      // Empty string
      const res1 = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "" }),
      });
      expect(res1.status).toBe(400);

      // Whitespace only
      const res2 = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "    " }),
      });
      expect(res2.status).toBe(400);

      // Exceeds 100 characters
      const res3 = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "P".repeat(101) }),
      });
      expect(res3.status).toBe(400);

      // Missing name field
      const res4 = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({}),
      });
      expect(res4.status).toBe(400);
    });

    it("rejects rename of an archived project with 409 PROJECT_ARCHIVED", async () => {
      const owner = await createAndLoginUser("Owner", "rename-arch-owner@example.com");

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Archived Rename WS" }),
      });
      const { workspace } = await wsRes.json();

      const projRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name: "To Be Archived" }),
        }
      );
      const { project } = await projRes.json();

      // Archive project first
      const archiveRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes.status).toBe(200);

      // Attempt rename on archived project
      const patchRes = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "New Name Should Fail" }),
      });
      expect(patchRes.status).toBe(409);
      const body = await patchRes.json();
      expect(body.error.code).toBe("PROJECT_ARCHIVED");
    });
  });

  describe("Project Archival & Restoration Lifecycle (Milestone 5.2)", () => {
    it("archives a project, excludes it from default listings, and preserves member read access", async () => {
      const owner = await createAndLoginUser("Owner", "arch-lifecycle-owner@example.com");
      const member = await createAndLoginUser("Member", "arch-lifecycle-member@example.com");

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Lifecycle WS" }),
      });
      const { workspace } = await wsRes.json();

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const projRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name: "Project Lifecycle" }),
        }
      );
      const { project } = await projRes.json();

      // 1. Initial listing shows the project
      const listRes1 = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          headers: { Cookie: member.cookie },
        }
      );
      const listData1 = await listRes1.json();
      expect(listData1.projects).toHaveLength(1);

      // 2. Archive the project
      const archiveRes1 = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes1.status).toBe(200);
      const archivedData1 = await archiveRes1.json();
      expect(archivedData1.project.archivedAt).not.toBeNull();
      const firstArchivedAt = archivedData1.project.archivedAt;
      const firstUpdatedAt = archivedData1.project.updatedAt;

      // 3. Project is excluded from default workspace projects listing
      const listRes2 = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          headers: { Cookie: member.cookie },
        }
      );
      const listData2 = await listRes2.json();
      expect(listData2.projects).toHaveLength(0);

      // 4. Workspace members retain read access to project details and board
      const getRes = await app.request(`/api/projects/${project.id}`, {
        headers: { Cookie: member.cookie },
      });
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.project.archivedAt).toBe(firstArchivedAt);

      const boardRes = await app.request(`/api/projects/${project.id}/board`, {
        headers: { Cookie: member.cookie },
      });
      expect(boardRes.status).toBe(200);
      const boardData = await boardRes.json();
      expect(boardData.columns).toHaveLength(4);

      // 5. Repeated archive call is idempotent and returns 200 without changing updatedAt
      await new Promise((r) => setTimeout(r, 10));
      const archiveRes2 = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes2.status).toBe(200);
      const archivedData2 = await archiveRes2.json();
      expect(archivedData2.project.archivedAt).toBe(firstArchivedAt);
      expect(archivedData2.project.updatedAt).toBe(firstUpdatedAt);

      // 6. Restore the project
      await new Promise((r) => setTimeout(r, 10));
      const restoreRes1 = await app.request(`/api/projects/${project.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(restoreRes1.status).toBe(200);
      const restoredData1 = await restoreRes1.json();
      expect(restoredData1.project.archivedAt).toBeNull();
      const restoredUpdatedAt = restoredData1.project.updatedAt;

      // 7. Restored project reappears in default listing
      const listRes3 = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          headers: { Cookie: member.cookie },
        }
      );
      const listData3 = await listRes3.json();
      expect(listData3.projects).toHaveLength(1);
      expect(listData3.projects[0].id).toBe(project.id);

      // 8. Repeated restore call on active project is idempotent without changing updatedAt
      await new Promise((r) => setTimeout(r, 10));
      const restoreRes2 = await app.request(`/api/projects/${project.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(restoreRes2.status).toBe(200);
      const restoredData2 = await restoreRes2.json();
      expect(restoredData2.project.archivedAt).toBeNull();
      expect(restoredData2.project.updatedAt).toBe(restoredUpdatedAt);

      // 9. Columns and data remain intact
      const dbCols = await testDb
        .select()
        .from(projectColumns)
        .where(eq(projectColumns.projectId, project.id));
      expect(dbCols).toHaveLength(4);
    });

    it("rejects regular Member attempts to archive and restore with 403 FORBIDDEN", async () => {
      const owner = await createAndLoginUser("Owner", "arch-forbid-owner@example.com");
      const member = await createAndLoginUser("Member", "arch-forbid-member@example.com");

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Member Archive Forbid WS" }),
      });
      const { workspace } = await wsRes.json();

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const projRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name: "Protected Project" }),
        }
      );
      const { project } = await projRes.json();

      // Member attempts archive -> 403
      const archiveRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });
      expect(archiveRes.status).toBe(403);

      // Owner archives project
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      // Member attempts restore -> 403
      const restoreRes = await app.request(`/api/projects/${project.id}/restore`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });
      expect(restoreRes.status).toBe(403);
    });
  });

  describe("Project Lifecycle Concurrency & Races (Milestone 5.2)", () => {
    it("handles concurrent archive requests cleanly and idempotently", async () => {
      const owner = await createAndLoginUser("Owner", "concur-arch-owner@example.com");

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Concur Arch WS" }),
      });
      const { workspace } = await wsRes.json();

      const projRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name: "Concurrent Arch Project" }),
        }
      );
      const { project } = await projRes.json();

      // Concurrent archive calls
      const [res1, res2] = await Promise.all([
        app.request(`/api/projects/${project.id}/archive`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        }),
        app.request(`/api/projects/${project.id}/archive`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const [dbProj] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProj.archivedAt).not.toBeNull();
    });

    it("handles concurrent restore requests cleanly and idempotently", async () => {
      const owner = await createAndLoginUser("Owner", "concur-res-owner@example.com");

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Concur Res WS" }),
      });
      const { workspace } = await wsRes.json();

      const projRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name: "Concurrent Res Project" }),
        }
      );
      const { project } = await projRes.json();

      // Archive first
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      // Concurrent restore calls
      const [res1, res2] = await Promise.all([
        app.request(`/api/projects/${project.id}/restore`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        }),
        app.request(`/api/projects/${project.id}/restore`, {
          method: "POST",
          headers: { Cookie: owner.cookie },
        }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const [dbProj] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProj.archivedAt).toBeNull();
    });

    it("rejects rename when project is archived concurrently right before rename update", async () => {
      const owner = await createAndLoginUser("Owner", "concur-race-owner@example.com");

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Race WS" }),
      });
      const { workspace } = await wsRes.json();

      const projRes = await app.request(
        `/api/workspaces/${workspace.id}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name: "Race Project" }),
        }
      );
      const { project } = await projRes.json();

      // Simulate a concurrent archive that lands right as a rename is attempted
      // Archive the project
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      // Attempt rename
      const renameRes = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Late Rename" }),
      });

      expect(renameRes.status).toBe(409);
      const body = await renameRes.json();
      expect(body.error.code).toBe("PROJECT_ARCHIVED");

      // Verify DB name was not changed
      const [dbProj] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(dbProj.name).toBe("Race Project");
    });
  });

  describe("Tenant Isolation, Dynamic Revocation & Concurrency (Milestone 5.3)", () => {
    it("immediately revokes project and board access with 404 NOT_FOUND upon member removal", async () => {
      const owner = await createAndLoginUser("Owner", "revoc-owner@example.com");
      const member = await createAndLoginUser("Member", "revoc-member@example.com");

      // 1. Owner creates workspace and project
      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Revocation WS" }),
      });
      const { workspace } = await wsRes.json();

      const projRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Revocation Project" }),
      });
      const { project } = await projRes.json();

      // 2. Add member to workspace
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      // 3. Verify member can access project details and board
      const preCheckProj = await app.request(`/api/projects/${project.id}`, {
        headers: { Cookie: member.cookie },
      });
      expect(preCheckProj.status).toBe(200);

      const preCheckBoard = await app.request(`/api/projects/${project.id}/board`, {
        headers: { Cookie: member.cookie },
      });
      expect(preCheckBoard.status).toBe(200);

      // 4. Remove user from workspace via DELETE /api/workspaces/:workspaceId/members/:memberId
      const removeRes = await app.request(
        `/api/workspaces/${workspace.id}/members/${member.user.id}`,
        {
          method: "DELETE",
          headers: { Cookie: owner.cookie },
        }
      );
      expect(removeRes.status).toBe(200);

      // 5. Without logging out, verify all project endpoints return 404 NOT_FOUND
      // a. Listing projects
      const postList = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        headers: { Cookie: member.cookie },
      });
      expect(postList.status).toBe(404);
      expect((await postList.json()).error.code).toBe("NOT_FOUND");

      // b. Project details
      const postGet = await app.request(`/api/projects/${project.id}`, {
        headers: { Cookie: member.cookie },
      });
      expect(postGet.status).toBe(404);
      expect((await postGet.json()).error.code).toBe("NOT_FOUND");

      // c. Board columns
      const postBoard = await app.request(`/api/projects/${project.id}/board`, {
        headers: { Cookie: member.cookie },
      });
      expect(postBoard.status).toBe(404);
      expect((await postBoard.json()).error.code).toBe("NOT_FOUND");

      // d. Project rename
      const postRename = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: member.cookie },
        body: JSON.stringify({ name: "Attempted Post-Removal Rename" }),
      });
      expect(postRename.status).toBe(404);
      expect((await postRename.json()).error.code).toBe("NOT_FOUND");

      // e. Project archive
      const postArchive = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });
      expect(postArchive.status).toBe(404);
      expect((await postArchive.json()).error.code).toBe("NOT_FOUND");

      // f. Project restore
      const postRestore = await app.request(`/api/projects/${project.id}/restore`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });
      expect(postRestore.status).toBe(404);
      expect((await postRestore.json()).error.code).toBe("NOT_FOUND");
    });

    it("enforces independent roles and tenant isolation across multiple workspaces for the same user", async () => {
      const ownerA = await createAndLoginUser("Owner A", "multi-owner-a@example.com");
      const ownerB = await createAndLoginUser("Owner B", "multi-owner-b@example.com");
      const multiUser = await createAndLoginUser("Multi User", "multi-user@example.com");

      // Workspace A (multiUser will be Admin)
      const wsResA = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ownerA.cookie },
        body: JSON.stringify({ name: "Workspace Alpha" }),
      });
      const { workspace: wsA } = await wsResA.json();

      // Workspace B (multiUser will be Member)
      const wsResB = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ownerB.cookie },
        body: JSON.stringify({ name: "Workspace Beta" }),
      });
      const { workspace: wsB } = await wsResB.json();

      // Add multiUser to WS A as Admin, and WS B as Member
      await testDb.insert(workspaceMembers).values([
        { workspaceId: wsA.id, userId: multiUser.user.id, role: "admin" },
        { workspaceId: wsB.id, userId: multiUser.user.id, role: "member" },
      ]);

      // Create Project Alpha in WS A and Project Beta in WS B
      const projResA = await app.request(`/api/workspaces/${wsA.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ownerA.cookie },
        body: JSON.stringify({ name: "Project Alpha" }),
      });
      const { project: projA } = await projResA.json();

      const projResB = await app.request(`/api/workspaces/${wsB.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ownerB.cookie },
        body: JSON.stringify({ name: "Project Beta" }),
      });
      const { project: projB } = await projResB.json();

      // 1. Listing WS A projects returns only Project Alpha
      const listResA = await app.request(`/api/workspaces/${wsA.id}/projects`, {
        headers: { Cookie: multiUser.cookie },
      });
      expect(listResA.status).toBe(200);
      const listDataA = await listResA.json();
      expect(listDataA.projects.map((p: any) => p.id)).toEqual([projA.id]);

      // 2. Listing WS B projects returns only Project Beta
      const listResB = await app.request(`/api/workspaces/${wsB.id}/projects`, {
        headers: { Cookie: multiUser.cookie },
      });
      expect(listResB.status).toBe(200);
      const listDataB = await listResB.json();
      expect(listDataB.projects.map((p: any) => p.id)).toEqual([projB.id]);

      // 3. User can rename Project Alpha (Admin in WS A)
      const renameA = await app.request(`/api/projects/${projA.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: multiUser.cookie },
        body: JSON.stringify({ name: "Project Alpha Renamed" }),
      });
      expect(renameA.status).toBe(200);

      // 4. User cannot rename Project Beta (Member in WS B) -> 403 FORBIDDEN
      const renameB = await app.request(`/api/projects/${projB.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: multiUser.cookie },
        body: JSON.stringify({ name: "Project Beta Hack" }),
      });
      expect(renameB.status).toBe(403);
      expect((await renameB.json()).error.code).toBe("FORBIDDEN");

      // 5. User cannot archive or restore Project Beta (Member in WS B) -> 403 FORBIDDEN
      const archiveB = await app.request(`/api/projects/${projB.id}/archive`, {
        method: "POST",
        headers: { Cookie: multiUser.cookie },
      });
      expect(archiveB.status).toBe(403);
      expect((await archiveB.json()).error.code).toBe("FORBIDDEN");

      const restoreB = await app.request(`/api/projects/${projB.id}/restore`, {
        method: "POST",
        headers: { Cookie: multiUser.cookie },
      });
      expect(restoreB.status).toBe(403);
      expect((await restoreB.json()).error.code).toBe("FORBIDDEN");

      // 6. User can still view Project Beta details and board as Member in WS B
      const getB = await app.request(`/api/projects/${projB.id}`, {
        headers: { Cookie: multiUser.cookie },
      });
      expect(getB.status).toBe(200);

      const boardB = await app.request(`/api/projects/${projB.id}/board`, {
        headers: { Cookie: multiUser.cookie },
      });
      expect(boardB.status).toBe(200);
    });

    it("immediately rejects project lifecycle mutations with 403 FORBIDDEN after an Admin is demoted to Member", async () => {
      const owner = await createAndLoginUser("Owner", "demote-owner@example.com");
      const user = await createAndLoginUser("Admin To Demote", "demote-user@example.com");

      // 1. Owner creates workspace and project
      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Demotion WS" }),
      });
      const { workspace } = await wsRes.json();

      const projRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Demotion Project" }),
      });
      const { project } = await projRes.json();

      // 2. Add user as Admin
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: user.user.id,
        role: "admin",
      });

      // 3. User can rename project while Admin
      const preRename = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: user.cookie },
        body: JSON.stringify({ name: "Admin Renamed Successfully" }),
      });
      expect(preRename.status).toBe(200);

      // 4. Owner demotes user to Member via PATCH /api/workspaces/:workspaceId/members/:memberId
      const demoteRes = await app.request(
        `/api/workspaces/${workspace.id}/members/${user.user.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ role: "member" }),
        }
      );
      expect(demoteRes.status).toBe(200);

      // 5. Without logging out or obtaining a new session, attempt lifecycle operations -> 403 FORBIDDEN
      // a. Rename
      const postRename = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: user.cookie },
        body: JSON.stringify({ name: "Member Attempted Rename" }),
      });
      expect(postRename.status).toBe(403);
      expect((await postRename.json()).error.code).toBe("FORBIDDEN");

      // b. Archive
      const postArchive = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: user.cookie },
      });
      expect(postArchive.status).toBe(403);
      expect((await postArchive.json()).error.code).toBe("FORBIDDEN");

      // c. Restore
      const postRestore = await app.request(`/api/projects/${project.id}/restore`, {
        method: "POST",
        headers: { Cookie: user.cookie },
      });
      expect(postRestore.status).toBe(403);
      expect((await postRestore.json()).error.code).toBe("FORBIDDEN");

      // 6. Verify user can still view project and board as Member
      const postGet = await app.request(`/api/projects/${project.id}`, {
        headers: { Cookie: user.cookie },
      });
      expect(postGet.status).toBe(200);

      const postBoard = await app.request(`/api/projects/${project.id}/board`, {
        headers: { Cookie: user.cookie },
      });
      expect(postBoard.status).toBe(200);
    });

    it("handles concurrent project creation in the same workspace cleanly without column collision or corruption", async () => {
      const owner = await createAndLoginUser("Owner", "concur-create-owner@example.com");

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Concurrent Creation WS" }),
      });
      const { workspace } = await wsRes.json();

      // Concurrently issue 4 project creation requests
      const projectNames = [
        "Concurrent Project 1",
        "Concurrent Project 2",
        "Concurrent Project 3",
        "Concurrent Project 4",
      ];

      const creationRequests = projectNames.map((name) =>
        app.request(`/api/workspaces/${workspace.id}/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ name }),
        })
      );

      const responses = await Promise.all(creationRequests);

      // Verify all 4 succeed with 201 Created
      const createdProjects: any[] = [];
      for (const res of responses) {
        expect(res.status).toBe(201);
        const data = await res.json();
        createdProjects.push(data.project);

        // Verify each project response returned 4 default columns with positions 0..3
        expect(data.columns).toHaveLength(4);
        expect(data.columns.map((c: any) => c.name)).toEqual([
          "Backlog",
          "Todo",
          "In Progress",
          "Done",
        ]);
        expect(data.columns.map((c: any) => c.position)).toEqual([
          0, 1, 2, 3,
        ]);
      }

      // Verify all 4 projects exist in DB and each has exactly 4 columns
      for (const proj of createdProjects) {
        const dbCols = await testDb
          .select()
          .from(projectColumns)
          .where(eq(projectColumns.projectId, proj.id));
        expect(dbCols).toHaveLength(4);
        expect(dbCols.every((c) => c.projectId === proj.id)).toBe(true);

        const positions = dbCols.map((c) => c.position).sort();
        expect(positions).toEqual([0, 1, 2, 3]);

        const colNames = dbCols.map((c) => c.name).sort();
        expect(colNames).toEqual(["Backlog", "Done", "In Progress", "Todo"]);
      }

      // Verify workspace listing returns all 4 projects
      const listRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
        headers: { Cookie: owner.cookie },
      });
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.projects).toHaveLength(4);
    });
  });
});

