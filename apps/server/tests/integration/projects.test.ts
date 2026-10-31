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
    });
  });
});

