import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
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
  EventService,
  appendProjectEvent,
  appendProjectEvents,
  type AppendProjectEventInput,
} from "../../src/services/event.js";

describe("Project Event Catch-Up API (Integration - Milestone 7.4-1)", () => {
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
      .where(eq(users.id, dbUser!.id));

    const loginRes = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({ email, password }),
    });

    const cookie = loginRes.headers.get("set-cookie")!;
    return { user: dbUser!, cookie };
  }

  /**
   * Helper to create workspace and project
   */
  async function setupWorkspaceAndProject(
    ownerName = "Owner Catchup",
    ownerEmail = "owner-catchup@example.com"
  ) {
    const owner = await createAndLoginUser(ownerName, ownerEmail);

    const wsRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Catchup WS" }),
    });
    const { workspace } = await wsRes.json();

    const projRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Catchup Project" }),
    });
    const { project, columns } = await projRes.json();

    return { owner, workspace, project, columns };
  }

  // ============================================================================
  // Scenario 1 & 2: Initial Retrieval with after=0 & Ascending Sequence Order
  // ============================================================================
  describe("Scenario 1 & 2: Initial Retrieval with after=0 & Ascending Sequence Order", () => {
    it("returns all events in strictly ascending sequence order with canonical currentSeq and nextCursor", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // 1. Create a task (seq = 1: task.created)
      const taskRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "task-catchup-1",
        },
        body: JSON.stringify({
          title: "Initial Task",
          columnId: columns[0].id,
          description: "Task description for catchup",
        }),
      });
      const { task } = await taskRes.json();

      // 2. Update the task (seq = 2: task.updated)
      await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({
          title: "Renamed Task",
          expectedVersion: 1,
        }),
      });

      // 3. Add a comment (seq = 3: comment.created)
      await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "comment-catchup-1",
        },
        body: JSON.stringify({ body: "Confidential comment body" }),
      });

      // Query changes endpoint with after=0
      const changesRes = await app.request(
        `/api/projects/${project.id}/changes?after=0`,
        {
          headers: { Cookie: owner.cookie },
        }
      );

      expect(changesRes.status).toBe(200);
      const data = await changesRes.json();

      // Contract checks
      expect(data).toHaveProperty("events");
      expect(data).toHaveProperty("nextCursor");
      expect(data).toHaveProperty("hasMore");
      expect(data).toHaveProperty("currentSeq");
      expect(data).not.toHaveProperty("currentProjectSeq"); // Sole canonical property

      expect(data.currentSeq).toBe(3);
      expect(data.hasMore).toBe(false);
      expect(data.nextCursor).toBe(3);
      expect(data.events).toHaveLength(3);

      // Verify strictly ascending ordering
      expect(data.events[0].seq).toBe(1);
      expect(data.events[0].eventType).toBe("task.created");
      expect(data.events[1].seq).toBe(2);
      expect(data.events[1].eventType).toBe("task.updated");
      expect(data.events[2].seq).toBe(3);
      expect(data.events[2].eventType).toBe("comment.created");
    });
  });

  // ============================================================================
  // Scenario 3 & 4: Multiple Pages, hasMore, and nextCursor Progression
  // ============================================================================
  describe("Scenario 3 & 4: Multiple Pages, hasMore, and nextCursor Progression", () => {
    it("pages through events using limit and advances nextCursor monotonically until hasMore is false", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Create 5 distinct events sequentially
      // seq 1: task.created
      const tRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "page-task-1",
        },
        body: JSON.stringify({ title: "Page Task", columnId: columns[0].id }),
      });
      const { task } = await tRes.json();

      // seq 2: task.updated
      await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ title: "Page Task v2", expectedVersion: 1 }),
      });

      // seq 3: comment.created
      const cRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "page-comm-1",
        },
        body: JSON.stringify({ body: "Page comment" }),
      });
      const { comment } = await cRes.json();

      // seq 4: comment.deleted
      await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });

      // seq 5: project.updated
      await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ name: "Renamed Catchup Project" }),
      });

      // Page 1: after=0, limit=2
      const page1Res = await app.request(
        `/api/projects/${project.id}/changes?after=0&limit=2`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(page1Res.status).toBe(200);
      const page1 = await page1Res.json();
      expect(page1.events).toHaveLength(2);
      expect(page1.events.map((e: any) => e.seq)).toEqual([1, 2]);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBe(2);
      expect(page1.currentSeq).toBe(5);

      // Page 2: after=2, limit=2
      const page2Res = await app.request(
        `/api/projects/${project.id}/changes?after=${page1.nextCursor}&limit=2`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(page2Res.status).toBe(200);
      const page2 = await page2Res.json();
      expect(page2.events).toHaveLength(2);
      expect(page2.events.map((e: any) => e.seq)).toEqual([3, 4]);
      expect(page2.hasMore).toBe(true);
      expect(page2.nextCursor).toBe(4);
      expect(page2.currentSeq).toBe(5);

      // Page 3: after=4, limit=2 (only 1 event remaining)
      const page3Res = await app.request(
        `/api/projects/${project.id}/changes?after=${page2.nextCursor}&limit=2`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(page3Res.status).toBe(200);
      const page3 = await page3Res.json();
      expect(page3.events).toHaveLength(1);
      expect(page3.events.map((e: any) => e.seq)).toEqual([5]);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBe(5);
      expect(page3.currentSeq).toBe(5);

      // Concatenating pages covers all 5 events with zero duplicates or gaps
      const allEvents = [...page1.events, ...page2.events, ...page3.events];
      expect(allEvents.map((e: any) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  // ============================================================================
  // Scenario 5, 6 & 7: Limit Defaults, Maximum (100), and Rejection (>100)
  // ============================================================================
  describe("Scenario 5, 6 & 7: Limit Defaults, Maximum (100), and Rejection (>100)", () => {
    it("applies default limit of 50 when limit parameter is omitted", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Seed 60 events transactionally
      const [t] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: columns[0].id,
          title: "Batch Task",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        })
        .returning();

      await testDb.transaction(async (tx) => {
        for (let i = 1; i <= 60; i++) {
          await EventService.appendProjectEvent(tx, {
            projectId: project.id,
            actorId: owner.user.id,
            eventType: "task.updated",
            entityType: "task",
            entityId: t!.id,
            payload: {
              task: {
                id: t!.id,
                projectId: project.id,
                columnId: columns[0].id,
                title: `Batch Task ${i}`,
                description: "",
                createdBy: owner.user.id,
                assigneeId: null,
                rankKey: "a0",
                version: i,
                dueDate: null,
                createdAt: t!.createdAt.toISOString(),
                updatedAt: new Date().toISOString(),
                archivedAt: null,
              },
              changes: {
                title: { from: `Batch Task ${i - 1}`, to: `Batch Task ${i}` },
              },
            },
          });
        }
      });

      // Query without limit parameter
      const res = await app.request(
        `/api/projects/${project.id}/changes?after=0`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.events).toHaveLength(50); // Default 50
      expect(data.hasMore).toBe(true);
      expect(data.nextCursor).toBe(50);
      expect(data.currentSeq).toBe(60);
    });

    it("accepts maximum limit of 100 and returns 100 events", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      const [t] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: columns[0].id,
          title: "Max Limit Task",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        })
        .returning();

      await testDb.transaction(async (tx) => {
        for (let i = 1; i <= 105; i++) {
          await EventService.appendProjectEvent(tx, {
            projectId: project.id,
            actorId: owner.user.id,
            eventType: "task.updated",
            entityType: "task",
            entityId: t!.id,
            payload: {
              task: {
                id: t!.id,
                projectId: project.id,
                columnId: columns[0].id,
                title: `Task ${i}`,
                description: "",
                createdBy: owner.user.id,
                assigneeId: null,
                rankKey: "a0",
                version: i,
                dueDate: null,
                createdAt: t!.createdAt.toISOString(),
                updatedAt: new Date().toISOString(),
                archivedAt: null,
              },
              changes: {
                title: { from: `Task ${i - 1}`, to: `Task ${i}` },
              },
            },
          });
        }
      });

      const res = await app.request(
        `/api/projects/${project.id}/changes?after=0&limit=100`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.events).toHaveLength(100);
      expect(data.hasMore).toBe(true);
      expect(data.nextCursor).toBe(100);
      expect(data.currentSeq).toBe(105);
    });

    it("rejects limit greater than 100 with 400 VALIDATION_ERROR without silently capping", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const res101 = await app.request(
        `/api/projects/${project.id}/changes?after=0&limit=101`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(res101.status).toBe(400);
      const data101 = await res101.json();
      expect(data101.error.code).toBe("VALIDATION_ERROR");

      const res500 = await app.request(
        `/api/projects/${project.id}/changes?after=0&limit=500`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(res500.status).toBe(400);
      const data500 = await res500.json();
      expect(data500.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ============================================================================
  // Scenario 8: Empty Result When after === currentSeq
  // ============================================================================
  describe("Scenario 8: Empty Result When after === currentSeq", () => {
    it("returns HTTP 200 with empty events array and hasMore: false when client is already fully caught up", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Create 1 task (seq = 1)
      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "caught-up-task-1",
        },
        body: JSON.stringify({ title: "Task 1", columnId: columns[0].id }),
      });

      // after === currentSeq (1)
      const res = await app.request(
        `/api/projects/${project.id}/changes?after=1`,
        { headers: { Cookie: owner.cookie } }
      );

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
      expect(data.nextCursor).toBe(1); // Remains equal to after
      expect(data.currentSeq).toBe(1);
    });

    it("returns HTTP 200 with empty events array when project has 0 events and after=0", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      // Fresh project has lastSeq = 0
      const res = await app.request(
        `/api/projects/${project.id}/changes?after=0`,
        { headers: { Cookie: owner.cookie } }
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
      expect(data.nextCursor).toBe(0);
      expect(data.currentSeq).toBe(0);
    });
  });

  // ============================================================================
  // Scenario 9: HTTP 410 CURSOR_RESET When after > currentSeq
  // ============================================================================
  describe("Scenario 9: HTTP 410 CURSOR_RESET When after > currentSeq", () => {
    it("returns HTTP 410 with code CURSOR_RESET and details when cursor is ahead of database sequence", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Create 1 task (currentSeq becomes 1)
      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "cursor-reset-task-1",
        },
        body: JSON.stringify({ title: "Task 1", columnId: columns[0].id }),
      });

      // Request with future cursor after=2
      const resAfter2 = await app.request(
        `/api/projects/${project.id}/changes?after=2`,
        { headers: { Cookie: owner.cookie } }
      );

      expect(resAfter2.status).toBe(410);
      const body2 = await resAfter2.json();
      expect(body2.error.code).toBe("CURSOR_RESET");
      expect(body2.error.message).toContain("cursor is ahead");
      expect(body2.error.details).toEqual({
        requestedSeq: 2,
        currentSeq: 1,
      });

      // Request with far future cursor after=999
      const resAfter999 = await app.request(
        `/api/projects/${project.id}/changes?after=999`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resAfter999.status).toBe(410);
      const body999 = await resAfter999.json();
      expect(body999.error.code).toBe("CURSOR_RESET");
      expect(body999.error.details).toEqual({
        requestedSeq: 999,
        currentSeq: 1,
      });
    });
  });

  // ============================================================================
  // Scenario 10: Negative, Fractional, Missing, and Invalid Query Parameters
  // ============================================================================
  describe("Scenario 10: Negative, Fractional, Missing, and Invalid Query Parameters", () => {
    it("rejects missing, empty, negative, fractional, or non-numeric after parameter with 400 VALIDATION_ERROR", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      // Missing after parameter
      const resMissing = await app.request(
        `/api/projects/${project.id}/changes`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resMissing.status).toBe(400);
      expect((await resMissing.json()).error.code).toBe("VALIDATION_ERROR");

      // Empty string after
      const resEmpty = await app.request(
        `/api/projects/${project.id}/changes?after=`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resEmpty.status).toBe(400);
      expect((await resEmpty.json()).error.code).toBe("VALIDATION_ERROR");

      // Negative after
      const resNeg = await app.request(
        `/api/projects/${project.id}/changes?after=-1`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resNeg.status).toBe(400);
      expect((await resNeg.json()).error.code).toBe("VALIDATION_ERROR");

      // Fractional after
      const resFrac = await app.request(
        `/api/projects/${project.id}/changes?after=1.5`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resFrac.status).toBe(400);
      expect((await resFrac.json()).error.code).toBe("VALIDATION_ERROR");

      // Non-numeric after
      const resNaN = await app.request(
        `/api/projects/${project.id}/changes?after=abc`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resNaN.status).toBe(400);
      expect((await resNaN.json()).error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects unsafe integer after values (after=9007199254740992) with 400 VALIDATION_ERROR and does not cause HTTP 500", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const resUnsafe = await app.request(
        `/api/projects/${project.id}/changes?after=9007199254740992`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resUnsafe.status).toBe(400);
      const body = await resUnsafe.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("safe integer");
    });

    it("accepts maximum safe integer (after=9007199254740991), passing validation and returning 410 CURSOR_RESET without HTTP 500", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const resMaxSafe = await app.request(
        `/api/projects/${project.id}/changes?after=9007199254740991`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resMaxSafe.status).toBe(410);
      const body = await resMaxSafe.json();
      expect(body.error.code).toBe("CURSOR_RESET");
      expect(body.error.details).toEqual({
        requestedSeq: 9007199254740991,
        currentSeq: 0,
      });
    });

    it("rejects negative, zero, fractional, or non-numeric limit parameter with 400 VALIDATION_ERROR", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      // Zero limit
      const resZero = await app.request(
        `/api/projects/${project.id}/changes?after=0&limit=0`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resZero.status).toBe(400);
      expect((await resZero.json()).error.code).toBe("VALIDATION_ERROR");

      // Negative limit
      const resNeg = await app.request(
        `/api/projects/${project.id}/changes?after=0&limit=-5`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resNeg.status).toBe(400);
      expect((await resNeg.json()).error.code).toBe("VALIDATION_ERROR");

      // Fractional limit
      const resFrac = await app.request(
        `/api/projects/${project.id}/changes?after=0&limit=2.5`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resFrac.status).toBe(400);
      expect((await resFrac.json()).error.code).toBe("VALIDATION_ERROR");

      // Non-numeric limit
      const resNaN = await app.request(
        `/api/projects/${project.id}/changes?after=0&limit=xyz`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resNaN.status).toBe(400);
      expect((await resNaN.json()).error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects invalid project UUID parameter with 400 VALIDATION_ERROR", async () => {
      const { owner } = await setupWorkspaceAndProject();

      const res = await app.request(
        `/api/projects/not-a-valid-uuid/changes?after=0`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ============================================================================
  // Scenario 11, 12 & 13: Authorization & Cross-Workspace Tenant Concealment
  // ============================================================================
  describe("Scenario 11, 12 & 13: Authorization & Cross-Workspace Tenant Concealment", () => {
    it("returns 404 NOT_FOUND for nonexistent project", async () => {
      const { owner } = await setupWorkspaceAndProject();
      const fakeProjectId = "00000000-0000-0000-0000-000000000001";

      const res = await app.request(
        `/api/projects/${fakeProjectId}/changes?after=0`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
    });

    it("conceals private projects from non-members with 404 NOT_FOUND", async () => {
      const { project } = await setupWorkspaceAndProject("Owner A", "owner-a@example.com");
      const outsider = await createAndLoginUser("Outsider User", "outsider@example.com");

      const res = await app.request(
        `/api/projects/${project.id}/changes?after=0`,
        { headers: { Cookie: outsider.cookie } }
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
    });

    it("returns 401 UNAUTHENTICATED when unauthenticated", async () => {
      const { project } = await setupWorkspaceAndProject();

      const res = await app.request(
        `/api/projects/${project.id}/changes?after=0`
      );
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
    });

    it("immediately conceals project changes with 404 NOT_FOUND upon workspace member removal", async () => {
      const { owner, workspace, project } = await setupWorkspaceAndProject();

      // Add a member
      const member = await createAndLoginUser("Soon Removed", "removed-user@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      // Member can access changes initially
      const preRes = await app.request(
        `/api/projects/${project.id}/changes?after=0`,
        { headers: { Cookie: member.cookie } }
      );
      expect(preRes.status).toBe(200);

      // Remove member from workspace
      const removeRes = await app.request(
        `/api/workspaces/${workspace.id}/members/${member.user.id}`,
        {
          method: "DELETE",
          headers: { Cookie: owner.cookie },
        }
      );
      expect(removeRes.status).toBe(200);

      // Subsequent access by removed member is concealed with 404
      const postRes = await app.request(
        `/api/projects/${project.id}/changes?after=0`,
        { headers: { Cookie: member.cookie } }
      );
      expect(postRes.status).toBe(404);
      expect((await postRes.json()).error.code).toBe("NOT_FOUND");
    });
  });

  // ============================================================================
  // Scenario 14: Event Payloads Preserved Without Alteration (Privacy Invariant)
  // ============================================================================
  describe("Scenario 14: Event Payloads Preserved Without Alteration (Privacy Invariant)", () => {
    it("preserves exact event payload structure and privacy rules across catch-up", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // 1. Task created with description
      const taskRes = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "priv-task-1",
        },
        body: JSON.stringify({
          title: "Privacy Task",
          description: "Top secret initial task description",
          columnId: columns[0].id,
        }),
      });
      const { task } = await taskRes.json();

      // 2. Task description updated (privacy invariant: changes contains { description: { changed: true } })
      await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({
          description: "Updated confidential description text",
          expectedVersion: 1,
        }),
      });

      // 3. Comment created (privacy invariant: body excluded from event payload)
      const commRes = await app.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": "priv-comm-1",
        },
        body: JSON.stringify({ body: "Ultra confidential comment body text!" }),
      });
      const { comment } = await commRes.json();

      // 4. Comment deleted
      await app.request(`/api/comments/${comment.id}`, {
        method: "DELETE",
        headers: { Cookie: owner.cookie },
      });

      // Fetch catch-up changes
      const res = await app.request(
        `/api/projects/${project.id}/changes?after=0`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.events).toHaveLength(4);

      // Event 1: task.created carries snapshot with description
      const ev1 = data.events[0];
      expect(ev1.eventType).toBe("task.created");
      expect(ev1.payload.task.title).toBe("Privacy Task");
      expect(ev1.payload.task.description).toBe("Top secret initial task description");

      // Event 2: task.updated privacy rule
      const ev2 = data.events[1];
      expect(ev2.eventType).toBe("task.updated");
      expect(ev2.payload.changes.description).toEqual({ changed: true });
      expect(ev2.payload.changes.description).not.toHaveProperty("from");
      expect(ev2.payload.changes.description).not.toHaveProperty("to");

      // Event 3: comment.created privacy rule (exact 4 fields, body strictly absent)
      const ev3 = data.events[2];
      expect(ev3.eventType).toBe("comment.created");
      expect(ev3.payload).toEqual({
        commentId: comment.id,
        taskId: task.id,
        authorId: owner.user.id,
        createdAt: comment.createdAt,
      });
      expect(ev3.payload).not.toHaveProperty("body");
      expect(JSON.stringify(ev3.payload)).not.toContain("Ultra confidential");

      // Event 4: comment.deleted privacy rule (exact 4 fields, body strictly absent)
      const ev4 = data.events[3];
      expect(ev4.eventType).toBe("comment.deleted");
      expect(ev4.payload).toHaveProperty("commentId", comment.id);
      expect(ev4.payload).toHaveProperty("taskId", task.id);
      expect(ev4.payload).toHaveProperty("authorId", owner.user.id);
      expect(ev4.payload).toHaveProperty("deletedAt");
      expect(ev4.payload).not.toHaveProperty("body");
      expect(JSON.stringify(ev4.payload)).not.toContain("Ultra confidential");
    });
  });

  // ============================================================================
  // Scenario 15: Consistent Relationship Between events and currentSeq Under Concurrent Commits
  // ============================================================================
  describe("Scenario 15: Consistent Relationship Between events and currentSeq Under Concurrent Commits", () => {
    it("guarantees consistent snapshot isolation between projects.last_seq and project_events via REPEATABLE READ", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Seed 2 initial events (seq = 1, 2)
      const [t] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: columns[0].id,
          title: "Isolation Task",
          createdBy: owner.user.id,
          rankKey: "a0",
          version: 1,
        })
        .returning();

      await testDb.transaction(async (tx) => {
        await EventService.appendProjectEvent(tx, {
          projectId: project.id,
          actorId: owner.user.id,
          eventType: "task.created",
          entityType: "task",
          entityId: t!.id,
          payload: {
            task: {
              id: t!.id,
              projectId: project.id,
              columnId: columns[0].id,
              title: "Isolation Task",
              description: "",
              createdBy: owner.user.id,
              assigneeId: null,
              rankKey: "a0",
              version: 1,
              dueDate: null,
              createdAt: t!.createdAt.toISOString(),
              updatedAt: t!.updatedAt.toISOString(),
              archivedAt: null,
            },
            changes: { title: { to: "Isolation Task" } },
          },
        });

        await EventService.appendProjectEvent(tx, {
          projectId: project.id,
          actorId: owner.user.id,
          eventType: "task.updated",
          entityType: "task",
          entityId: t!.id,
          payload: {
            task: {
              id: t!.id,
              projectId: project.id,
              columnId: columns[0].id,
              title: "Isolation Task v2",
              description: "",
              createdBy: owner.user.id,
              assigneeId: null,
              rankKey: "a0",
              version: 2,
              dueDate: null,
              createdAt: t!.createdAt.toISOString(),
              updatedAt: new Date().toISOString(),
              archivedAt: null,
            },
            changes: { title: { from: "Isolation Task", to: "Isolation Task v2" } },
          },
        });
      });

      // Verify baseline sequence is 2
      const [projBefore] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(projBefore!.lastSeq).toBe(2);

      // Now, test snapshot isolation using deterministic database transactions:
      // Transaction A opens with REPEATABLE READ, READ ONLY isolation
      await testDb.transaction(
        async (txA) => {
          // Transaction A reads projects.lastSeq at its snapshot start
          const [projectSnapshotA] = await txA
            .select({ id: projects.id, lastSeq: projects.lastSeq })
            .from(projects)
            .where(eq(projects.id, project.id));
          expect(projectSnapshotA!.lastSeq).toBe(2);

          // Concurrent Transaction B runs on outside connection and commits event 3 (advancing lastSeq to 3)
          await testDb.transaction(async (txB) => {
            await EventService.appendProjectEvent(txB, {
              projectId: project.id,
              actorId: owner.user.id,
              eventType: "task.updated",
              entityType: "task",
              entityId: t!.id,
              payload: {
                task: {
                  id: t!.id,
                  projectId: project.id,
                  columnId: columns[0].id,
                  title: "Isolation Task v3 (Concurrent)",
                  description: "",
                  createdBy: owner.user.id,
                  assigneeId: null,
                  rankKey: "a0",
                  version: 3,
                  dueDate: null,
                  createdAt: t!.createdAt.toISOString(),
                  updatedAt: new Date().toISOString(),
                  archivedAt: null,
                },
                changes: {
                  title: { from: "Isolation Task v2", to: "Isolation Task v3 (Concurrent)" },
                },
              },
            });
          });

          // Verify outside world now has lastSeq = 3
          const [projAfterB] = await testDb
            .select()
            .from(projects)
            .where(eq(projects.id, project.id));
          expect(projAfterB!.lastSeq).toBe(3);

          // Now Transaction A queries project_events
          // Because Transaction A is in REPEATABLE READ, its MVCC snapshot cannot observe Transaction B's commit!
          const rowsInTxA = await txA
            .select()
            .from(projectEvents)
            .where(
              and(
                eq(projectEvents.projectId, project.id),
                eq(projectEvents.seq, 3)
              )
            );

          // Transaction A must NOT see event 3!
          expect(rowsInTxA).toHaveLength(0);

          // Transaction A reading all events > 0 sees exactly events 1 and 2
          const allRowsInTxA = await txA
            .select()
            .from(projectEvents)
            .where(eq(projectEvents.projectId, project.id))
            .orderBy(asc(projectEvents.seq));

          expect(allRowsInTxA).toHaveLength(2);
          expect(allRowsInTxA.map((r) => r.seq)).toEqual([1, 2]);

          // Both project.lastSeq (2) and events (1, 2) in Transaction A are 100% consistent!
          expect(allRowsInTxA[allRowsInTxA.length - 1]!.seq).toBe(projectSnapshotA!.lastSeq);
        },
        {
          isolationLevel: "repeatable read",
          accessMode: "read only",
        }
      );

      // Now query via the catch-up service method:
      // It starts a fresh REPEATABLE READ transaction and sees all 3 events consistently
      const freshChanges = await EventService.getProjectChanges(testDb, {
        projectId: project.id,
        callerId: owner.user.id,
        after: 0,
      });

      expect(freshChanges.currentSeq).toBe(3);
      expect(freshChanges.events).toHaveLength(3);
      expect(freshChanges.nextCursor).toBe(3);
      expect(freshChanges.hasMore).toBe(false);
    });
  });
});

