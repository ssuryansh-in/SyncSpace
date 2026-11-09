import { beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
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
  EventService,
  appendProjectEvents,
  type AppendProjectEventInput,
} from "../../src/services/event.js";

describe("Project Activity History API (Integration - Milestone 7.5)", () => {
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
    ownerName = "History Owner",
    ownerEmail = "history-owner@example.com"
  ) {
    const owner = await createAndLoginUser(ownerName, ownerEmail);

    const wsRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: owner.cookie,
      },
      body: JSON.stringify({ name: "History Test Workspace" }),
    });
    const { workspace } = await wsRes.json();

    const projRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: owner.cookie,
      },
      body: JSON.stringify({ name: "History Test Project" }),
    });
    const { project } = await projRes.json();

    const cols = await testDb
      .select()
      .from(projectColumns)
      .where(eq(projectColumns.projectId, project.id));

    return { owner, workspace, project, columns: cols };
  }

  /**
   * Helper to seed N project events for testing pagination and ordering
   */
  async function seedEvents(
    projectId: string,
    actorId: string,
    columnId: string,
    count: number
  ) {
    const [task] = await testDb
      .insert(tasks)
      .values({
        projectId,
        columnId,
        title: "Seed Task",
        createdBy: actorId,
        rankKey: "0|h00000:",
        version: 1,
      })
      .returning();

    const inputs: AppendProjectEventInput[] = [];
    for (let i = 1; i <= count; i++) {
      if (i === 1) {
        inputs.push({
          projectId,
          actorId,
          eventType: "task.created",
          entityType: "task",
          entityId: task!.id,
          payload: {
            task: {
              id: task!.id,
              projectId,
              columnId,
              title: "Seed Task v1",
              description: "Initial description",
              createdBy: actorId,
              assigneeId: null,
              rankKey: "0|h00000:",
              version: 1,
              dueDate: null,
              createdAt: task!.createdAt.toISOString(),
              updatedAt: task!.updatedAt.toISOString(),
              archivedAt: null,
            },
            changes: { title: { to: "Seed Task v1" } },
          },
        });
      } else {
        inputs.push({
          projectId,
          actorId,
          eventType: "task.updated",
          entityType: "task",
          entityId: task!.id,
          payload: {
            task: {
              id: task!.id,
              projectId,
              columnId,
              title: `Seed Task v${i}`,
              description: `Description ${i}`,
              createdBy: actorId,
              assigneeId: null,
              rankKey: "0|h00000:",
              version: i,
              dueDate: null,
              createdAt: task!.createdAt.toISOString(),
              updatedAt: new Date().toISOString(),
              archivedAt: null,
            },
            changes: {
              title: {
                from: `Seed Task v${i - 1}`,
                to: `Seed Task v${i}`,
              },
            },
          },
        });
      }
    }

    await testDb.transaction(async (tx) => {
      await appendProjectEvents(tx, inputs);
    });

    return task!;
  }

  // =========================================================================
  // Scenario 1: Initial Page Without Cursor
  // =========================================================================
  describe("Scenario 1: Initial page without cursor (before omitted)", () => {
    it("returns latest events with default limit 20 and descending sequence order", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      await seedEvents(project.id, owner.user.id, columns[0].id, 25);

      const res = await app.request(`/api/projects/${project.id}/events`, {
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data).toHaveProperty("events");
      expect(data).toHaveProperty("nextCursor");
      expect(data).toHaveProperty("hasMore");
      expect(data).toHaveProperty("currentSeq");

      expect(data.currentSeq).toBe(25);
      expect(data.events).toHaveLength(20);
      expect(data.hasMore).toBe(true);
      expect(data.events[0].seq).toBe(25);
      expect(data.events[19].seq).toBe(6);
      expect(data.nextCursor).toBe(6);
    });
  });

  // =========================================================================
  // Scenario 2: Descending Sequence Order Strictly Verified
  // =========================================================================
  describe("Scenario 2: Descending sequence order (seq DESC)", () => {
    it("ensures every returned event sequence is strictly less than the previous event", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      await seedEvents(project.id, owner.user.id, columns[0].id, 10);

      const res = await app.request(`/api/projects/${project.id}/events?limit=10`, {
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.events).toHaveLength(10);

      for (let i = 1; i < data.events.length; i++) {
        expect(data.events[i].seq).toBeLessThan(data.events[i - 1].seq);
      }

      const seqs = data.events.map((e: any) => e.seq);
      expect(seqs).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    });
  });

  // =========================================================================
  // Scenario 3: Exclusive Cursor Behavior (seq < before)
  // =========================================================================
  describe("Scenario 3: Exclusive cursor behavior (seq < before)", () => {
    it("excludes the event matching seq == before and returns subsequent older events", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      await seedEvents(project.id, owner.user.id, columns[0].id, 25);

      const res = await app.request(
        `/api/projects/${project.id}/events?before=20&limit=5`,
        { headers: { Cookie: owner.cookie } }
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.events).toHaveLength(5);

      const seqs = data.events.map((e: any) => e.seq);
      expect(seqs).toEqual([19, 18, 17, 16, 15]);
      expect(seqs.includes(20)).toBe(false);
      expect(data.nextCursor).toBe(15);
      expect(data.hasMore).toBe(true);
      expect(data.currentSeq).toBe(25);
    });
  });

  // =========================================================================
  // Scenario 4: Multi-Page Backward Traversal Without Gaps or Duplicates
  // =========================================================================
  describe("Scenario 4: Multi-page backward traversal without duplicates or omissions", () => {
    it("traverses entire event history page by page using nextCursor until beginning", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      await seedEvents(project.id, owner.user.id, columns[0].id, 15);

      const collectedSeqs: number[] = [];
      let currentBefore: number | null = null;
      let hasMore = true;
      let pageCount = 0;

      while (hasMore) {
        pageCount++;
        const url = currentBefore
          ? `/api/projects/${project.id}/events?before=${currentBefore}&limit=4`
          : `/api/projects/${project.id}/events?limit=4`;

        const res = await app.request(url, {
          headers: { Cookie: owner.cookie },
        });

        expect(res.status).toBe(200);
        const data = await res.json();

        for (const ev of data.events) {
          collectedSeqs.push(ev.seq);
        }

        hasMore = data.hasMore;
        currentBefore = data.nextCursor;

        if (hasMore) {
          expect(currentBefore).not.toBeNull();
        } else {
          expect(currentBefore).toBeNull();
        }
      }

      expect(pageCount).toBe(4);
      expect(collectedSeqs).toHaveLength(15);
      expect(new Set(collectedSeqs).size).toBe(15);
      expect(collectedSeqs).toEqual([
        15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
      ]);
    });
  });

  // =========================================================================
  // Scenario 5: Boundary Cursor Values (before = 1, before > currentSeq)
  // =========================================================================
  describe("Scenario 5: Boundary cursor values", () => {
    it("returns empty list with nextCursor null when before = 1", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      await seedEvents(project.id, owner.user.id, columns[0].id, 10);

      const res = await app.request(
        `/api/projects/${project.id}/events?before=1`,
        { headers: { Cookie: owner.cookie } }
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.events).toEqual([]);
      expect(data.nextCursor).toBeNull();
      expect(data.hasMore).toBe(false);
      expect(data.currentSeq).toBe(10);
    });

    it("accepts before > currentSeq gracefully without CURSOR_RESET and returns latest events", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      await seedEvents(project.id, owner.user.id, columns[0].id, 5);

      const res = await app.request(
        `/api/projects/${project.id}/events?before=100&limit=10`,
        { headers: { Cookie: owner.cookie } }
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.events).toHaveLength(5);
      expect(data.currentSeq).toBe(5);
      expect(data.events.map((e: any) => e.seq)).toEqual([5, 4, 3, 2, 1]);
      expect(data.hasMore).toBe(false);
      expect(data.nextCursor).toBeNull();
    });
  });

  // =========================================================================
  // Scenario 6: Empty History Baseline
  // =========================================================================
  describe("Scenario 6: Empty history baseline", () => {
    it("returns empty events array, nextCursor null, and currentSeq 0 for project with no events", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const res = await app.request(`/api/projects/${project.id}/events`, {
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.events).toEqual([]);
      expect(data.nextCursor).toBeNull();
      expect(data.hasMore).toBe(false);
      expect(data.currentSeq).toBe(0);
    });
  });

  // =========================================================================
  // Scenario 7: Limit Parameter Boundaries
  // =========================================================================
  describe("Scenario 7: Limit parameter boundaries", () => {
    it("honors custom limit <= 50 and rejects limit > 50 with 400 VALIDATION_ERROR", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      await seedEvents(project.id, owner.user.id, columns[0].id, 10);

      // Custom limit 5
      const res5 = await app.request(
        `/api/projects/${project.id}/events?limit=5`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(res5.status).toBe(200);
      const data5 = await res5.json();
      expect(data5.events).toHaveLength(5);
      expect(data5.hasMore).toBe(true);

      // Limit 51 exceeds maximum of 50
      const res51 = await app.request(
        `/api/projects/${project.id}/events?limit=51`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(res51.status).toBe(400);
      const err51 = await res51.json();
      expect(err51.error.code).toBe("VALIDATION_ERROR");
      expect(err51.error.message).toContain("limit must be between 1 and 50");

      // Limit 0 is rejected
      const res0 = await app.request(
        `/api/projects/${project.id}/events?limit=0`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(res0.status).toBe(400);
      const err0 = await res0.json();
      expect(err0.error.code).toBe("VALIDATION_ERROR");
    });

    it("accepts maximum limit 50 and returns up to 50 events", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      await seedEvents(project.id, owner.user.id, columns[0].id, 55);

      const res50 = await app.request(
        `/api/projects/${project.id}/events?limit=50`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(res50.status).toBe(200);
      const data50 = await res50.json();
      expect(data50.events).toHaveLength(50);
      expect(data50.hasMore).toBe(true);
      expect(data50.nextCursor).toBe(6);
      expect(data50.currentSeq).toBe(55);
    });
  });

  // =========================================================================
  // Scenario 8: Invalid Query Parameter Rejection
  // =========================================================================
  describe("Scenario 8: Invalid query parameter rejection", () => {
    it("rejects non-positive, non-integer, unsafe integer cursor and invalid project IDs", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      // before = 0
      const resBefore0 = await app.request(
        `/api/projects/${project.id}/events?before=0`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resBefore0.status).toBe(400);
      const errBefore0 = await resBefore0.json();
      expect(errBefore0.error.code).toBe("VALIDATION_ERROR");

      // before = -1
      const resBeforeNeg = await app.request(
        `/api/projects/${project.id}/events?before=-1`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resBeforeNeg.status).toBe(400);
      const errBeforeNeg = await resBeforeNeg.json();
      expect(errBeforeNeg.error.code).toBe("VALIDATION_ERROR");

      // before = 1.5 (fractional)
      const resBeforeFrac = await app.request(
        `/api/projects/${project.id}/events?before=1.5`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resBeforeFrac.status).toBe(400);
      const errBeforeFrac = await resBeforeFrac.json();
      expect(errBeforeFrac.error.code).toBe("VALIDATION_ERROR");

      // before = abc (non-numeric)
      const resBeforeStr = await app.request(
        `/api/projects/${project.id}/events?before=abc`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resBeforeStr.status).toBe(400);
      const errBeforeStr = await resBeforeStr.json();
      expect(errBeforeStr.error.code).toBe("VALIDATION_ERROR");

      // before = unsafe integer
      const resBeforeUnsafe = await app.request(
        `/api/projects/${project.id}/events?before=99999999999999999999999999999`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resBeforeUnsafe.status).toBe(400);
      const errBeforeUnsafe = await resBeforeUnsafe.json();
      expect(errBeforeUnsafe.error.code).toBe("VALIDATION_ERROR");

      // limit = -5
      const resLimitNeg = await app.request(
        `/api/projects/${project.id}/events?limit=-5`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resLimitNeg.status).toBe(400);
      const errLimitNeg = await resLimitNeg.json();
      expect(errLimitNeg.error.code).toBe("VALIDATION_ERROR");

      // limit = 1.5 (fractional)
      const resLimitFrac = await app.request(
        `/api/projects/${project.id}/events?limit=1.5`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resLimitFrac.status).toBe(400);
      const errLimitFrac = await resLimitFrac.json();
      expect(errLimitFrac.error.code).toBe("VALIDATION_ERROR");

      // limit = abc
      const resLimitStr = await app.request(
        `/api/projects/${project.id}/events?limit=abc`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resLimitStr.status).toBe(400);
      const errLimitStr = await resLimitStr.json();
      expect(errLimitStr.error.code).toBe("VALIDATION_ERROR");

      // before = empty string (?before=)
      const resBeforeEmpty = await app.request(
        `/api/projects/${project.id}/events?before=`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resBeforeEmpty.status).toBe(400);
      const errBeforeEmpty = await resBeforeEmpty.json();
      expect(errBeforeEmpty.error.code).toBe("VALIDATION_ERROR");

      // limit = empty string (?limit=)
      const resLimitEmpty = await app.request(
        `/api/projects/${project.id}/events?limit=`,
        { headers: { Cookie: owner.cookie } }
      );
      expect(resLimitEmpty.status).toBe(400);
      const errLimitEmpty = await resLimitEmpty.json();
      expect(errLimitEmpty.error.code).toBe("VALIDATION_ERROR");

      // Invalid project ID (non-UUID)
      const resInvalidId = await app.request(
        "/api/projects/not-a-uuid/events",
        { headers: { Cookie: owner.cookie } }
      );
      expect(resInvalidId.status).toBe(400);
      const errInvalidId = await resInvalidId.json();
      expect(errInvalidId.error.code).toBe("VALIDATION_ERROR");
      expect(errInvalidId.error.message).toBe("Invalid project ID");
    });
  });

  // =========================================================================
  // Scenario 9: Unauthenticated Access Rejection
  // =========================================================================
  describe("Scenario 9: Unauthenticated access rejection", () => {
    it("rejects unauthenticated requests with 401 UNAUTHENTICATED", async () => {
      const { project } = await setupWorkspaceAndProject();

      const res = await app.request(`/api/projects/${project.id}/events`);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe("UNAUTHENTICATED");
    });
  });

  // =========================================================================
  // Scenario 10: Cross-Workspace Tenant Isolation and 404 Concealment
  // =========================================================================
  describe("Scenario 10: Cross-workspace tenant isolation and 404 concealment", () => {
    it("returns identical 404 NOT_FOUND for unauthorized workspace members and nonexistent projects", async () => {
      const wsA = await setupWorkspaceAndProject("Owner A", "owner-a@example.com");
      const wsB = await setupWorkspaceAndProject("Owner B", "owner-b@example.com");

      // Owner B attempts to access Workspace A's project events
      const crossRes = await app.request(`/api/projects/${wsA.project.id}/events`, {
        headers: { Cookie: wsB.owner.cookie },
      });
      expect(crossRes.status).toBe(404);
      const crossData = await crossRes.json();
      expect(crossData.error.code).toBe("NOT_FOUND");
      expect(crossData.error.message).toBe("Project not found");

      // Nonexistent project UUID
      const nonExistentId = "a0000000-0000-0000-0000-000000000000";
      const nonExistentRes = await app.request(`/api/projects/${nonExistentId}/events`, {
        headers: { Cookie: wsB.owner.cookie },
      });
      expect(nonExistentRes.status).toBe(404);
      const nonExistentData = await nonExistentRes.json();
      expect(nonExistentData.error.code).toBe("NOT_FOUND");
      expect(nonExistentData.error.message).toBe("Project not found");

      // Responses are identical, concealing existence
      expect(crossData).toEqual(nonExistentData);
    });
  });

  // =========================================================================
  // Scenario 11: Immediate Member Revocation
  // =========================================================================
  describe("Scenario 11: Immediate member revocation", () => {
    it("immediately conceals events with 404 NOT_FOUND upon workspace membership revocation", async () => {
      const { owner, workspace, project, columns } = await setupWorkspaceAndProject();
      await seedEvents(project.id, owner.user.id, columns[0].id, 3);

      // Add a regular member to the workspace
      const member = await createAndLoginUser("Member User", "member-user@example.com");

      const addRes = await app.request(`/api/workspaces/${workspace.id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ email: "member-user@example.com", role: "member" }),
      });
      expect(addRes.status).toBe(200);

      // Member can view history
      const memberResBefore = await app.request(`/api/projects/${project.id}/events`, {
        headers: { Cookie: member.cookie },
      });
      expect(memberResBefore.status).toBe(200);
      const dataBefore = await memberResBefore.json();
      expect(dataBefore.events).toHaveLength(3);

      // Remove member from workspace
      const removeRes = await app.request(
        `/api/workspaces/${workspace.id}/members/${member.user.id}`,
        {
          method: "DELETE",
          headers: { Cookie: owner.cookie },
        }
      );
      expect(removeRes.status).toBe(200);

      // Subsequent request by removed member immediately receives 404 NOT_FOUND
      const memberResAfter = await app.request(`/api/projects/${project.id}/events`, {
        headers: { Cookie: member.cookie },
      });
      expect(memberResAfter.status).toBe(404);
      const dataAfter = await memberResAfter.json();
      expect(dataAfter.error.code).toBe("NOT_FOUND");
      expect(dataAfter.error.message).toBe("Project not found");
    });
  });

  // =========================================================================
  // Scenario 12: Archived Project Read-Only Inspection Access Preserved
  // =========================================================================
  describe("Scenario 12: Archived project read-only inspection access preserved", () => {
    it("allows active workspace members to read event history for archived projects", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      await seedEvents(project.id, owner.user.id, columns[0].id, 4);

      // Archive project
      const archiveRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes.status).toBe(200);

      // Read activity history for archived project
      const res = await app.request(`/api/projects/${project.id}/events`, {
        headers: { Cookie: owner.cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      // 4 seeded task events + 1 project.archived event = 5 total events
      expect(data.events).toHaveLength(5);
      expect(data.currentSeq).toBe(5);
      expect(data.events[0].eventType).toBe("project.archived");
      expect(data.events[0].seq).toBe(5);
    });
  });

  // =========================================================================
  // Scenario 13: MVCC Snapshot Isolation Under Concurrent Writes (Transaction Barrier)
  // =========================================================================
  describe("Scenario 13: MVCC snapshot isolation under concurrent writes", () => {
    it("guarantees consistent snapshot isolation between projects.last_seq and project_events via REPEATABLE READ", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Seed 2 initial events (seq = 1, 2)
      await seedEvents(project.id, owner.user.id, columns[0].id, 2);

      const [projBefore] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(projBefore!.lastSeq).toBe(2);

      // Transaction A opens with REPEATABLE READ, READ ONLY isolation
      await testDb.transaction(
        async (txA) => {
          // Transaction A reads projects.lastSeq at its snapshot start
          const [projectSnapshotA] = await txA
            .select({ id: projects.id, lastSeq: projects.lastSeq })
            .from(projects)
            .where(eq(projects.id, project.id));
          expect(projectSnapshotA!.lastSeq).toBe(2);

          // Concurrent Transaction B commits event 3 (advancing lastSeq to 3)
          await testDb.transaction(async (txB) => {
            const [extraTask] = await txB
              .insert(tasks)
              .values({
                projectId: project.id,
                columnId: columns[0].id,
                title: "Concurrent Task",
                createdBy: owner.user.id,
                rankKey: "0|i00000:",
                version: 1,
              })
              .returning();

            await EventService.appendProjectEvent(txB, {
              projectId: project.id,
              actorId: owner.user.id,
              eventType: "task.created",
              entityType: "task",
              entityId: extraTask!.id,
              payload: {
                task: {
                  id: extraTask!.id,
                  projectId: project.id,
                  columnId: columns[0].id,
                  title: "Concurrent Task",
                  description: "",
                  createdBy: owner.user.id,
                  assigneeId: null,
                  rankKey: "0|i00000:",
                  version: 1,
                  dueDate: null,
                  createdAt: extraTask!.createdAt.toISOString(),
                  updatedAt: extraTask!.updatedAt.toISOString(),
                  archivedAt: null,
                },
                changes: { title: { to: "Concurrent Task" } },
              },
            });
          });

          // Verify outside database world now has lastSeq = 3
          const [projAfterB] = await testDb
            .select()
            .from(projects)
            .where(eq(projects.id, project.id));
          expect(projAfterB!.lastSeq).toBe(3);

          // Inside Transaction A, read projectEvents in REPEATABLE READ
          const rowsInTxA = await txA
            .select()
            .from(projectEvents)
            .where(eq(projectEvents.projectId, project.id))
            .orderBy(desc(projectEvents.seq));

          // Transaction A must NOT see event 3! Only events 2 and 1
          expect(rowsInTxA).toHaveLength(2);
          expect(rowsInTxA.map((r) => r.seq)).toEqual([2, 1]);
          expect(rowsInTxA[0]!.seq).toBe(projectSnapshotA!.lastSeq);
        },
        {
          isolationLevel: "repeatable read",
          accessMode: "read only",
        }
      );

      // Fresh call to EventService.getProjectEvents sees all 3 events consistently
      const freshEvents = await EventService.getProjectEvents(testDb, {
        projectId: project.id,
        callerId: owner.user.id,
      });

      expect(freshEvents.currentSeq).toBe(3);
      expect(freshEvents.events).toHaveLength(3);
      expect(freshEvents.events.map((e) => e.seq)).toEqual([3, 2, 1]);
      expect(freshEvents.hasMore).toBe(false);
      expect(freshEvents.nextCursor).toBeNull();
    });
  });
});
