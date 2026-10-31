import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth/index.js";
import { createEmailService, clearSentEmailsForTest } from "../../src/services/email.js";
import { loadEnv } from "../../src/config/env.js";
import { WorkspaceService } from "../../src/services/workspace.js";
import {
  users,
  workspaces,
  workspaceMembers,
} from "../../src/db/schema/index.js";
import { cleanTables, testDb, testSqlClient } from "./setup.js";

describe("Workspace and Membership Management (Integration)", () => {
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
        { method: "POST", path: "/api/workspaces", body: { name: "Test" } },
        { method: "GET", path: "/api/workspaces" },
        {
          method: "GET",
          path: "/api/workspaces/00000000-0000-0000-0000-000000000001",
        },
        {
          method: "PATCH",
          path: "/api/workspaces/00000000-0000-0000-0000-000000000001",
          body: { name: "Renamed" },
        },
        {
          method: "POST",
          path: "/api/workspaces/00000000-0000-0000-0000-000000000001/members",
          body: { email: "test@example.com" },
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

  describe("Workspace Creation & Atomicity", () => {
    it("atomically creates a workspace and sets creator as initial owner", async () => {
      const { user, cookie } = await createAndLoginUser(
        "Ada Lovelace",
        "ada@example.com"
      );

      const res = await app.request("/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ name: "Analytical Engine" }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.workspace.name).toBe("Analytical Engine");
      expect(data.workspace.ownerId).toBe(user.id);
      expect(data.role).toBe("owner");

      // Verify PostgreSQL state
      const [dbWorkspace] = await testDb
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, data.workspace.id));
      expect(dbWorkspace).toBeDefined();
      expect(dbWorkspace.ownerId).toBe(user.id);

      const [dbMember] = await testDb
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, data.workspace.id),
            eq(workspaceMembers.userId, user.id)
          )
        );
      expect(dbMember).toBeDefined();
      expect(dbMember.role).toBe("owner");
    });

    it("rejects invalid workspace names with 400 VALIDATION_ERROR", async () => {
      const { cookie } = await createAndLoginUser(
        "Charles Babbage",
        "charles@example.com"
      );

      // Empty name
      const res1 = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "" }),
      });
      expect(res1.status).toBe(400);
      const body1 = await res1.json();
      expect(body1.error.code).toBe("VALIDATION_ERROR");

      // Whitespace only
      const res2 = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "   " }),
      });
      expect(res2.status).toBe(400);

      // Exceeds 100 characters
      const res3 = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "a".repeat(101) }),
      });
      expect(res3.status).toBe(400);
    });

    it("rolls back workspace creation if an error occurs within the transaction", async () => {
      const { user } = await createAndLoginUser(
        "Rollback User",
        "rollback@example.com"
      );

      // Attempt creating workspace with an injected transactional failure
      const failingDb = {
        ...testDb,
        transaction: async (cb: any) => {
          return await testDb.transaction(async (tx) => {
            await cb(tx);
            throw new Error("Simulated transactional failure");
          });
        },
      } as any;

      await expect(
        WorkspaceService.createWorkspace(failingDb, {
          name: "Doomed Workspace",
          ownerId: user.id,
        })
      ).rejects.toThrow("Simulated transactional failure");

      // Verify nothing was committed in PostgreSQL
      const wsList = await testDb
        .select()
        .from(workspaces)
        .where(eq(workspaces.name, "Doomed Workspace"));
      expect(wsList.length).toBe(0);

      const memberList = await testDb
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, user.id));
      expect(memberList.length).toBe(0);
    });
  });

  describe("Workspace Listing & Retrieval", () => {
    it("lists only workspaces where the user has active membership", async () => {
      const user1 = await createAndLoginUser("User One", "user1@example.com");
      const user2 = await createAndLoginUser("User Two", "user2@example.com");

      // User 1 creates 2 workspaces
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: user1.cookie },
        body: JSON.stringify({ name: "User1 WS A" }),
      });
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: user1.cookie },
        body: JSON.stringify({ name: "User1 WS B" }),
      });

      // User 2 creates 1 workspace
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: user2.cookie },
        body: JSON.stringify({ name: "User2 WS" }),
      });

      // Query User 1 list
      const res1 = await app.request("/api/workspaces", {
        headers: { Cookie: user1.cookie },
      });
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1.workspaces.length).toBe(2);
      expect(data1.workspaces.map((w: any) => w.name)).toEqual([
        "User1 WS A",
        "User1 WS B",
      ]);
      expect(data1.workspaces[0].role).toBe("owner");

      // Query User 2 list
      const res2 = await app.request("/api/workspaces", {
        headers: { Cookie: user2.cookie },
      });
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.workspaces.length).toBe(1);
      expect(data2.workspaces[0].name).toBe("User2 WS");
    });

    it("retrieves workspace details, caller role, and member list", async () => {
      const owner = await createAndLoginUser("Grace Hopper", "grace@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Compiler Systems" }),
      });
      const { workspace } = await createRes.json();

      const getRes = await app.request(`/api/workspaces/${workspace.id}`, {
        headers: { Cookie: owner.cookie },
      });
      expect(getRes.status).toBe(200);
      const details = await getRes.json();
      expect(details.workspace.id).toBe(workspace.id);
      expect(details.role).toBe("owner");
      expect(details.members.length).toBe(1);
      expect(details.members[0]).toMatchObject({
        userId: owner.user.id,
        displayName: "Grace Hopper",
        email: "grace@example.com",
        role: "owner",
      });
    });
  });

  describe("Cross-Workspace Tenant Isolation (404 Concealment)", () => {
    it("returns 404 NOT_FOUND when a non-member accesses another workspace", async () => {
      const ownerA = await createAndLoginUser("Owner A", "ownera@example.com");
      const userB = await createAndLoginUser("User B", "userb@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ownerA.cookie },
        body: JSON.stringify({ name: "Workspace A" }),
      });
      const { workspace: wsA } = await createRes.json();

      // User B attempts to read Workspace A
      const getRes = await app.request(`/api/workspaces/${wsA.id}`, {
        headers: { Cookie: userB.cookie },
      });
      expect(getRes.status).toBe(404);
      const getBody = await getRes.json();
      expect(getBody.error.code).toBe("NOT_FOUND");

      // User B attempts to rename Workspace A
      const patchRes = await app.request(`/api/workspaces/${wsA.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: userB.cookie },
        body: JSON.stringify({ name: "Hacked Name" }),
      });
      expect(patchRes.status).toBe(404);

      // User B attempts to add members to Workspace A
      const addRes = await app.request(`/api/workspaces/${wsA.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userB.cookie },
        body: JSON.stringify({ email: "new@example.com" }),
      });
      expect(addRes.status).toBe(404);

      // User B attempts to remove members from Workspace A
      const deleteRes = await app.request(
        `/api/workspaces/${wsA.id}/members/${ownerA.user.id}`,
        {
          method: "DELETE",
          headers: { Cookie: userB.cookie },
        }
      );
      expect(deleteRes.status).toBe(404);
    });
  });

  describe("Workspace Settings & Permission Enforcement", () => {
    it("allows owner and admin to update workspace name, but rejects member with 403 FORBIDDEN", async () => {
      const owner = await createAndLoginUser("Owner", "ws-owner@example.com");
      const admin = await createAndLoginUser("Admin", "ws-admin@example.com");
      const member = await createAndLoginUser("Member", "ws-member@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Original Name" }),
      });
      const { workspace } = await createRes.json();

      // Add admin and member
      await testDb.insert(workspaceMembers).values([
        { workspaceId: workspace.id, userId: admin.user.id, role: "admin" },
        { workspaceId: workspace.id, userId: member.user.id, role: "member" },
      ]);

      // 1. Admin renames workspace -> 200 OK
      const adminRename = await app.request(`/api/workspaces/${workspace.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: admin.cookie },
        body: JSON.stringify({ name: "Admin Renamed" }),
      });
      expect(adminRename.status).toBe(200);
      const adminData = await adminRename.json();
      expect(adminData.workspace.name).toBe("Admin Renamed");

      // 2. Owner renames workspace -> 200 OK
      const ownerRename = await app.request(`/api/workspaces/${workspace.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Owner Renamed" }),
      });
      expect(ownerRename.status).toBe(200);
      const ownerData = await ownerRename.json();
      expect(ownerData.workspace.name).toBe("Owner Renamed");

      // 3. Member attempts to rename workspace -> 403 FORBIDDEN
      const memberRename = await app.request(`/api/workspaces/${workspace.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: member.cookie },
        body: JSON.stringify({ name: "Member Renamed" }),
      });
      expect(memberRename.status).toBe(403);
      const memberBody = await memberRename.json();
      expect(memberBody.error.code).toBe("FORBIDDEN");
    });
  });

  describe("Member Addition & Enumeration Defense", () => {
    it("adds an existing registered user to the workspace", async () => {
      const owner = await createAndLoginUser("Alan Turing", "alan@example.com");
      const teammate = await createAndLoginUser(
        "Joan Clarke",
        "joan@example.com"
      );

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Bletchley Park" }),
      });
      const { workspace } = await createRes.json();

      const addRes = await app.request(`/api/workspaces/${workspace.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ email: "joan@example.com", role: "member" }),
      });

      expect(addRes.status).toBe(200);
      const body = await addRes.json();
      expect(body.status).toBe(true);
      expect(body.message).toContain("If the user is registered");

      // Verify DB row
      const [member] = await testDb
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspace.id),
            eq(workspaceMembers.userId, teammate.user.id)
          )
        );
      expect(member).toBeDefined();
      expect(member.role).toBe("member");
    });

    it("returns identical generic response when adding non-existent or unverified email", async () => {
      const owner = await createAndLoginUser("Owner", "add-owner@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Secure Space" }),
      });
      const { workspace } = await createRes.json();

      // Unknown email
      const resUnknown = await app.request(
        `/api/workspaces/${workspace.id}/members`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ email: "doesnotexist@example.com" }),
        }
      );
      expect(resUnknown.status).toBe(200);
      const bodyUnknown = await resUnknown.json();
      expect(bodyUnknown.status).toBe(true);

      // Verify no member added in DB
      const allMembers = await testDb
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspace.id));
      expect(allMembers.length).toBe(1); // Only owner
    });

    it("rejects member addition by regular member with 403 FORBIDDEN", async () => {
      const owner = await createAndLoginUser("Owner", "perm-owner@example.com");
      const member = await createAndLoginUser("Member", "perm-member@example.com");
      const outsider = await createAndLoginUser("Outsider", "outsider@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Restricted Space" }),
      });
      const { workspace } = await createRes.json();

      // Add regular member
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      // Regular member attempts to add outsider
      const addRes = await app.request(`/api/workspaces/${workspace.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: member.cookie },
        body: JSON.stringify({ email: "outsider@example.com" }),
      });

      expect(addRes.status).toBe(403);
      const body = await addRes.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("enforces rate limiting on rapid member addition attempts when enabled", async () => {
      const rateLimitedApp = createApp({
        config: testEnv,
        auth: testAuth,
        db: testDb,
        rateLimit: { enabled: true, windowMs: 60_000, max: 3 },
      });

      const owner = await createAndLoginUser(
        "RateLimit Owner",
        "rl-owner@example.com"
      );

      const createRes = await rateLimitedApp.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Rate Limited Workspace" }),
      });
      const { workspace } = await createRes.json();

      const attempts = [];
      for (let i = 0; i < 5; i++) {
        attempts.push(
          rateLimitedApp.request(`/api/workspaces/${workspace.id}/members`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: owner.cookie,
            },
            body: JSON.stringify({ email: `user${i}@example.com` }),
          })
        );
      }

      const responses = await Promise.all(attempts);
      const statuses = responses.map((r) => r.status);
      expect(statuses).toContain(429);
    });

    it("safely handles concurrent duplicate member additions without 500 error", async () => {
      const owner = await createAndLoginUser("Owner", "concurrent-add-owner@example.com");
      const teammate = await createAndLoginUser("Teammate", "teammate-race@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Race Test Workspace" }),
      });
      const { workspace } = await createRes.json();

      // Dispatch 5 concurrent member addition requests with the same email
      const requests = Array.from({ length: 5 }, () =>
        app.request(`/api/workspaces/${workspace.id}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ email: "teammate-race@example.com" }),
        })
      );

      const responses = await Promise.all(requests);

      // All responses should succeed with 200 and enumeration-resistant generic message
      for (const res of responses) {
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe(true);
        expect(data.message).toContain("If the user is registered");
      }

      // Verify that exactly one member record exists in PostgreSQL
      const members = await testDb
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspace.id),
            eq(workspaceMembers.userId, teammate.user.id)
          )
        );
      expect(members.length).toBe(1);
    });
  });

  describe("Member Role Updates & Owner Protection", () => {
    it("allows admin to promote member to admin, and owner to demote admin to member", async () => {
      const owner = await createAndLoginUser("Owner", "role-owner@example.com");
      const admin = await createAndLoginUser("Admin", "role-admin@example.com");
      const member = await createAndLoginUser("Member", "role-member@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Role Test Workspace" }),
      });
      const { workspace } = await createRes.json();

      await testDb.insert(workspaceMembers).values([
        { workspaceId: workspace.id, userId: admin.user.id, role: "admin" },
        { workspaceId: workspace.id, userId: member.user.id, role: "member" },
      ]);

      // 1. Admin promotes member to admin
      const promoteRes = await app.request(
        `/api/workspaces/${workspace.id}/members/${member.user.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: admin.cookie },
          body: JSON.stringify({ role: "admin" }),
        }
      );
      expect(promoteRes.status).toBe(200);
      const promoteData = await promoteRes.json();
      expect(promoteData.member.role).toBe("admin");

      // 2. Owner demotes user back to member
      const demoteRes = await app.request(
        `/api/workspaces/${workspace.id}/members/${member.user.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ role: "member" }),
        }
      );
      expect(demoteRes.status).toBe(200);
      const demoteData = await demoteRes.json();
      expect(demoteData.member.role).toBe("member");
    });

    it("strictly prevents anyone from modifying the owner role via PATCH", async () => {
      const owner = await createAndLoginUser("Owner", "prot-owner@example.com");
      const admin = await createAndLoginUser("Admin", "prot-admin@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Owner Protection Workspace" }),
      });
      const { workspace } = await createRes.json();

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: admin.user.id,
        role: "admin",
      });

      // Admin attempts to demote owner -> 403 FORBIDDEN
      const demoteRes = await app.request(
        `/api/workspaces/${workspace.id}/members/${owner.user.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: admin.cookie },
          body: JSON.stringify({ role: "member" }),
        }
      );
      expect(demoteRes.status).toBe(403);
      const demoteBody = await demoteRes.json();
      expect(demoteBody.error.code).toBe("FORBIDDEN");

      // Attempting to assign 'owner' via PATCH is rejected
      const promoteToOwner = await app.request(
        `/api/workspaces/${workspace.id}/members/${admin.user.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ role: "owner" }),
        }
      );
      expect(promoteToOwner.status).toBe(400);
    });
  });

  describe("Member Removal & Immediate Revocation", () => {
    it("allows admin to remove a member and immediately revokes their workspace access", async () => {
      const owner = await createAndLoginUser("Owner", "rem-owner@example.com");
      const admin = await createAndLoginUser("Admin", "rem-admin@example.com");
      const member = await createAndLoginUser("Member", "rem-member@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Removal Workspace" }),
      });
      const { workspace } = await createRes.json();

      await testDb.insert(workspaceMembers).values([
        { workspaceId: workspace.id, userId: admin.user.id, role: "admin" },
        { workspaceId: workspace.id, userId: member.user.id, role: "member" },
      ]);

      // 1. Member can view workspace
      const preCheck = await app.request(`/api/workspaces/${workspace.id}`, {
        headers: { Cookie: member.cookie },
      });
      expect(preCheck.status).toBe(200);

      // 2. Admin removes member
      const removeRes = await app.request(
        `/api/workspaces/${workspace.id}/members/${member.user.id}`,
        {
          method: "DELETE",
          headers: { Cookie: admin.cookie },
        }
      );
      expect(removeRes.status).toBe(200);

      // 3. Removed member immediately receives 404 NOT_FOUND
      const postCheck = await app.request(`/api/workspaces/${workspace.id}`, {
        headers: { Cookie: member.cookie },
      });
      expect(postCheck.status).toBe(404);
    });

    it("allows regular member to leave workspace voluntarily", async () => {
      const owner = await createAndLoginUser("Owner", "leave-owner@example.com");
      const member = await createAndLoginUser("Member", "leave-member@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Leave Workspace" }),
      });
      const { workspace } = await createRes.json();

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      // Member deletes their own membership
      const leaveRes = await app.request(
        `/api/workspaces/${workspace.id}/members/${member.user.id}`,
        {
          method: "DELETE",
          headers: { Cookie: member.cookie },
        }
      );
      expect(leaveRes.status).toBe(200);
      const leaveBody = await leaveRes.json();
      expect(leaveBody.message).toContain("left the workspace");

      // Verify removed
      const postCheck = await app.request(`/api/workspaces/${workspace.id}`, {
        headers: { Cookie: member.cookie },
      });
      expect(postCheck.status).toBe(404);
    });

    it("strictly prevents removing the workspace owner or owner leaving", async () => {
      const owner = await createAndLoginUser("Owner", "noleave-owner@example.com");
      const admin = await createAndLoginUser("Admin", "noleave-admin@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Owner Invariant Workspace" }),
      });
      const { workspace } = await createRes.json();

      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: admin.user.id,
        role: "admin",
      });

      // Admin attempts to remove owner -> 403
      const adminTryRemove = await app.request(
        `/api/workspaces/${workspace.id}/members/${owner.user.id}`,
        {
          method: "DELETE",
          headers: { Cookie: admin.cookie },
        }
      );
      expect(adminTryRemove.status).toBe(403);

      // Owner attempts to leave without transferring ownership -> 403
      const ownerTryLeave = await app.request(
        `/api/workspaces/${workspace.id}/members/${owner.user.id}`,
        {
          method: "DELETE",
          headers: { Cookie: owner.cookie },
        }
      );
      expect(ownerTryLeave.status).toBe(403);
    });
  });

  describe("Atomic Ownership Transfer", () => {
    it("atomically transfers workspace ownership and demotes former owner to admin", async () => {
      const owner = await createAndLoginUser("Old Owner", "oldowner@example.com");
      const newOwner = await createAndLoginUser("New Owner", "newowner@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Ownership Transfer WS" }),
      });
      const { workspace } = await createRes.json();

      // Add target user as member first
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: newOwner.user.id,
        role: "member",
      });

      // Owner transfers ownership to newOwner
      const transferRes = await app.request(
        `/api/workspaces/${workspace.id}/transfer-ownership`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ newOwnerId: newOwner.user.id }),
        }
      );

      expect(transferRes.status).toBe(200);
      const transferData = await transferRes.json();
      expect(transferData.workspace.ownerId).toBe(newOwner.user.id);
      expect(transferData.previousOwnerId).toBe(owner.user.id);
      expect(transferData.newOwnerId).toBe(newOwner.user.id);

      // Verify PostgreSQL state
      const [updatedWs] = await testDb
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspace.id));
      expect(updatedWs.ownerId).toBe(newOwner.user.id);

      // Former owner is now 'admin'
      const [formerMember] = await testDb
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspace.id),
            eq(workspaceMembers.userId, owner.user.id)
          )
        );
      expect(formerMember.role).toBe("admin");

      // New owner is now 'owner'
      const [newMember] = await testDb
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspace.id),
            eq(workspaceMembers.userId, newOwner.user.id)
          )
        );
      expect(newMember.role).toBe("owner");
    });

    it("rejects non-owner attempts to transfer ownership with 403 FORBIDDEN", async () => {
      const owner = await createAndLoginUser("Real Owner", "realowner@example.com");
      const admin = await createAndLoginUser("Admin User", "adminuser@example.com");
      const member = await createAndLoginUser("Member User", "memberuser@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Protected Transfer WS" }),
      });
      const { workspace } = await createRes.json();

      await testDb.insert(workspaceMembers).values([
        { workspaceId: workspace.id, userId: admin.user.id, role: "admin" },
        { workspaceId: workspace.id, userId: member.user.id, role: "member" },
      ]);

      // Admin attempts transfer
      const adminTry = await app.request(
        `/api/workspaces/${workspace.id}/transfer-ownership`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: admin.cookie },
          body: JSON.stringify({ newOwnerId: admin.user.id }),
        }
      );
      expect(adminTry.status).toBe(403);
    });

    it("rejects ownership transfer to non-members or to self with 400 VALIDATION_ERROR", async () => {
      const owner = await createAndLoginUser("Solo Owner", "soloowner@example.com");
      const outsider = await createAndLoginUser("Non Member", "nonmember@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Validation Transfer WS" }),
      });
      const { workspace } = await createRes.json();

      // Transfer to self -> 400
      const selfTry = await app.request(
        `/api/workspaces/${workspace.id}/transfer-ownership`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ newOwnerId: owner.user.id }),
        }
      );
      expect(selfTry.status).toBe(400);

      // Transfer to outsider (not a member) -> 400
      const outsiderTry = await app.request(
        `/api/workspaces/${workspace.id}/transfer-ownership`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: owner.cookie },
          body: JSON.stringify({ newOwnerId: outsider.user.id }),
        }
      );
      expect(outsiderTry.status).toBe(400);
    });

    it("protects workspace ownership against race conditions between member removal and ownership transfer", async () => {
      const owner = await createAndLoginUser("Current Owner", "owner-race@example.com");
      const candidate = await createAndLoginUser("Candidate", "candidate-race@example.com");

      const createRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Ownership Race Workspace" }),
      });
      const { workspace } = await createRes.json();

      // Add candidate as member first
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: candidate.user.id,
        role: "member",
      });

      // Concurrently execute transferOwnership and member removal
      const [transferResult, removeResult] = await Promise.allSettled([
        WorkspaceService.transferOwnership(testDb, {
          workspaceId: workspace.id,
          currentOwnerId: owner.user.id,
          newOwnerId: candidate.user.id,
        }),
        app.request(
          `/api/workspaces/${workspace.id}/members/${candidate.user.id}`,
          {
            method: "DELETE",
            headers: { Cookie: owner.cookie },
          }
        ),
      ]);

      // Query database state: the workspace must have an active, valid owner
      const [finalWs] = await testDb
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspace.id));
      expect(finalWs).toBeDefined();

      const [ownerMember] = await testDb
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspace.id),
            eq(workspaceMembers.userId, finalWs.ownerId)
          )
        );

      // Invariant: The workspace owner MUST have an active member record with role 'owner'
      expect(ownerMember).toBeDefined();
      expect(ownerMember.role).toBe("owner");

      // Verify serialization: either transfer succeeded or removal succeeded
      if (transferResult.status === "fulfilled") {
        expect(finalWs.ownerId).toBe(candidate.user.id);
        if (removeResult.status === "fulfilled") {
          // If removal ran after transfer committed, candidate was already owner -> 403 Forbidden
          expect(removeResult.value.status).toBe(403);
        }
      } else {
        expect(finalWs.ownerId).toBe(owner.user.id);
      }
    });
  });
});
