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
import { ProjectService } from "../../src/services/project.js";
import { EventService } from "../../src/services/event.js";

describe("Consistent Board Snapshot API (Integration - Milestone 7.4-2)", () => {
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
    ownerName = "Board Owner",
    ownerEmail = "board-owner@example.com"
  ) {
    const owner = await createAndLoginUser(ownerName, ownerEmail);

    const wsRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Board WS" }),
    });
    const { workspace } = await wsRes.json();

    const projRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Board Project" }),
    });
    const { project, columns } = await projRes.json();

    return { owner, workspace, project, columns };
  }

  // =========================================================================
  // Scenario 1: Complete response contract
  // =========================================================================
  describe("Scenario 1: Complete Response Contract", () => {
    it("returns HTTP 200 with exactly project, columns, tasks, and snapshotSeq top-level keys", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Seed a task
      await testDb.insert(tasks).values({
        projectId: project.id,
        columnId: columns[0].id,
        title: "Contract Task",
        description: "Task description",
        createdBy: owner.user.id,
        rankKey: "0|hzzzzz:",
        version: 1,
      });

      const res = await app.request(`/api/projects/${project.id}/board`, {
        method: "GET",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      // Exact top-level contract keys
      const keys = Object.keys(data).sort();
      expect(keys).toEqual(["columns", "project", "snapshotSeq", "tasks"].sort());

      // Validate project structure
      expect(data.project.id).toBe(project.id);
      expect(data.project.workspaceId).toBe(project.workspaceId);
      expect(data.project.name).toBe(project.name);
      expect(typeof data.project.lastSeq).toBe("number");

      // Validate columns structure and ordering
      expect(Array.isArray(data.columns)).toBe(true);
      expect(data.columns.length).toBe(4);
      for (let i = 0; i < data.columns.length; i++) {
        expect(data.columns[i].position).toBe(i);
        expect(data.columns[i].projectId).toBe(project.id);
      }

      // Validate tasks structure
      expect(Array.isArray(data.tasks)).toBe(true);
      expect(data.tasks.length).toBe(1);
      expect(data.tasks[0].title).toBe("Contract Task");
      expect(data.tasks[0].projectId).toBe(project.id);
      expect(data.tasks[0].columnId).toBe(columns[0].id);

      // Validate snapshotSeq
      expect(typeof data.snapshotSeq).toBe("number");
      expect(data.snapshotSeq).toBe(data.project.lastSeq);
    });
  });

  // =========================================================================
  // Scenario 2: Deterministic task ordering
  // =========================================================================
  describe("Scenario 2: Deterministic Task Ordering (rankKey ASC, id ASC)", () => {
    it("orders tasks strictly ascending by rankKey, breaking ties with id ASC", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Insert tasks with specific rankKeys in unsorted order
      const taskEntries = [
        {
          id: "00000000-0000-0000-0000-000000000003",
          projectId: project.id,
          columnId: columns[0].id,
          title: "Task Middle",
          createdBy: owner.user.id,
          rankKey: "0|i00000:",
          version: 1,
        },
        {
          id: "00000000-0000-0000-0000-000000000001",
          projectId: project.id,
          columnId: columns[0].id,
          title: "Task First",
          createdBy: owner.user.id,
          rankKey: "0|hzzzzz:",
          version: 1,
        },
        {
          id: "00000000-0000-0000-0000-000000000004",
          projectId: project.id,
          columnId: columns[0].id,
          title: "Task Last",
          createdBy: owner.user.id,
          rankKey: "0|i00008:",
          version: 1,
        },
        {
          // Tie on rankKey with 00000000-0000-0000-0000-000000000003
          id: "00000000-0000-0000-0000-000000000002",
          projectId: project.id,
          columnId: columns[0].id,
          title: "Task Tie Breaker",
          createdBy: owner.user.id,
          rankKey: "0|i00000:",
          version: 1,
        },
      ];

      for (const t of taskEntries) {
        await testDb.insert(tasks).values(t);
      }

      const res = await app.request(`/api/projects/${project.id}/board`, {
        method: "GET",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tasks.length).toBe(4);

      // Expected order:
      // 1. "0|hzzzzz:" (id ...0001)
      // 2. "0|i00000:" tie broken by id: ...0002 before ...0003
      // 3. "0|i00000:" id ...0003
      // 4. "0|i00008:" id ...0004
      expect(data.tasks[0].id).toBe("00000000-0000-0000-0000-000000000001");
      expect(data.tasks[1].id).toBe("00000000-0000-0000-0000-000000000002");
      expect(data.tasks[2].id).toBe("00000000-0000-0000-0000-000000000003");
      expect(data.tasks[3].id).toBe("00000000-0000-0000-0000-000000000004");
    });
  });

  // =========================================================================
  // Scenario 3: Archived task exclusion
  // =========================================================================
  describe("Scenario 3: Archived Task Exclusion", () => {
    it("excludes archived tasks (archivedAt IS NOT NULL) from the active board snapshot", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Create 2 active tasks and 1 archived task
      await testDb.insert(tasks).values([
        {
          projectId: project.id,
          columnId: columns[0].id,
          title: "Active Task 1",
          createdBy: owner.user.id,
          rankKey: "0|hzzzzz:",
          version: 1,
          archivedAt: null,
        },
        {
          projectId: project.id,
          columnId: columns[0].id,
          title: "Archived Task",
          createdBy: owner.user.id,
          rankKey: "0|i00000:",
          version: 1,
          archivedAt: new Date(),
        },
        {
          projectId: project.id,
          columnId: columns[0].id,
          title: "Active Task 2",
          createdBy: owner.user.id,
          rankKey: "0|i00008:",
          version: 1,
          archivedAt: null,
        },
      ]);

      const res = await app.request(`/api/projects/${project.id}/board`, {
        method: "GET",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.tasks.length).toBe(2);
      expect(data.tasks.map((t: any) => t.title)).toEqual([
        "Active Task 1",
        "Active Task 2",
      ]);
      expect(data.tasks.some((t: any) => t.title === "Archived Task")).toBe(false);
    });
  });

  // =========================================================================
  // Scenario 4: Empty project and empty task list
  // =========================================================================
  describe("Scenario 4: Empty Project and Empty Task List", () => {
    it("returns tasks: [] and snapshotSeq: 0 for a project with no tasks or events", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const res = await app.request(`/api/projects/${project.id}/board`, {
        method: "GET",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.tasks).toEqual([]);
      expect(data.snapshotSeq).toBe(0);
      expect(data.project.lastSeq).toBe(0);
      expect(data.columns.length).toBe(4);
    });
  });

  // =========================================================================
  // Scenario 5: Tasks distributed across multiple columns
  // =========================================================================
  describe("Scenario 5: Tasks Distributed Across Multiple Columns", () => {
    it("returns active tasks across all columns with accurate columnId references", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Distribute tasks across Backlog (col 0), Todo (col 1), In Progress (col 2), Done (col 3)
      await testDb.insert(tasks).values([
        {
          projectId: project.id,
          columnId: columns[0].id,
          title: "Backlog Task",
          createdBy: owner.user.id,
          rankKey: "0|hzzzzz:",
          version: 1,
        },
        {
          projectId: project.id,
          columnId: columns[1].id,
          title: "Todo Task",
          createdBy: owner.user.id,
          rankKey: "0|i00000:",
          version: 1,
        },
        {
          projectId: project.id,
          columnId: columns[2].id,
          title: "In Progress Task",
          createdBy: owner.user.id,
          rankKey: "0|i00008:",
          version: 1,
        },
        {
          projectId: project.id,
          columnId: columns[3].id,
          title: "Done Task",
          createdBy: owner.user.id,
          rankKey: "0|i0000g:",
          version: 1,
        },
      ]);

      const res = await app.request(`/api/projects/${project.id}/board`, {
        method: "GET",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.tasks.length).toBe(4);
      expect(data.tasks.find((t: any) => t.title === "Backlog Task").columnId).toBe(columns[0].id);
      expect(data.tasks.find((t: any) => t.title === "Todo Task").columnId).toBe(columns[1].id);
      expect(data.tasks.find((t: any) => t.title === "In Progress Task").columnId).toBe(columns[2].id);
      expect(data.tasks.find((t: any) => t.title === "Done Task").columnId).toBe(columns[3].id);
    });
  });

  // =========================================================================
  // Scenario 6: Archived project read-only access
  // =========================================================================
  describe("Scenario 6: Archived Project Read-Only Access", () => {
    it("allows active workspace members read-only inspection of archived project board and tasks", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Seed a task
      await testDb.insert(tasks).values({
        projectId: project.id,
        columnId: columns[0].id,
        title: "Historical Task",
        createdBy: owner.user.id,
        rankKey: "0|hzzzzz:",
        version: 1,
      });

      // Archive the project
      const archiveRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes.status).toBe(200);

      // Verify board endpoint still succeeds with 200 OK
      const boardRes = await app.request(`/api/projects/${project.id}/board`, {
        method: "GET",
        headers: { Cookie: owner.cookie },
      });

      expect(boardRes.status).toBe(200);
      const data = await boardRes.json();

      expect(data.project.archivedAt).not.toBeNull();
      expect(data.columns.length).toBe(4);
      expect(data.tasks.length).toBe(1);
      expect(data.tasks[0].title).toBe("Historical Task");
      expect(typeof data.snapshotSeq).toBe("number");
    });
  });

  // =========================================================================
  // Scenario 7: Unauthenticated access
  // =========================================================================
  describe("Scenario 7: Unauthenticated Access Guard", () => {
    it("rejects unauthenticated requests with HTTP 401 UNAUTHENTICATED", async () => {
      const { project } = await setupWorkspaceAndProject();

      const res = await app.request(`/api/projects/${project.id}/board`, {
        method: "GET",
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe("UNAUTHENTICATED");
    });
  });

  // =========================================================================
  // Scenario 8: Non-member and nonexistent-project concealment
  // =========================================================================
  describe("Scenario 8: Non-Member and Nonexistent-Project Concealment (404 NOT_FOUND)", () => {
    it("conceals project existence by returning identical 404 NOT_FOUND envelopes for non-existent and non-member requests", async () => {
      const { project } = await setupWorkspaceAndProject();
      const outsider = await createAndLoginUser("Outsider", "outsider-board@example.com");

      // 1. Non-existent project UUID
      const nonExistentRes = await app.request(
        "/api/projects/00000000-0000-0000-0000-000000000099/board",
        {
          method: "GET",
          headers: { Cookie: outsider.cookie },
        }
      );
      expect(nonExistentRes.status).toBe(404);
      const nonExistentData = await nonExistentRes.json();
      expect(nonExistentData).toEqual({
        error: {
          code: "NOT_FOUND",
          message: "Project not found",
        },
      });

      // 2. Existing project accessed by non-member
      const nonMemberRes = await app.request(`/api/projects/${project.id}/board`, {
        method: "GET",
        headers: { Cookie: outsider.cookie },
      });
      expect(nonMemberRes.status).toBe(404);
      const nonMemberData = await nonMemberRes.json();
      expect(nonMemberData).toEqual({
        error: {
          code: "NOT_FOUND",
          message: "Project not found",
        },
      });

      // Confirm both responses are completely identical to prevent information leakage
      expect(nonExistentData).toEqual(nonMemberData);
    });
  });

  // =========================================================================
  // Scenario 9: Immediate access revocation upon member removal
  // =========================================================================
  describe("Scenario 9: Immediate Access Revocation After Workspace Member Removal", () => {
    it("immediately returns 404 NOT_FOUND when a removed member attempts to access the board", async () => {
      const { owner, workspace, project } = await setupWorkspaceAndProject();
      const member = await createAndLoginUser("Soon Removed", "soon-removed@example.com");

      // Add member to workspace
      const addRes = await app.request(`/api/workspaces/${workspace.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: JSON.stringify({ email: member.user.email, role: "member" }),
      });
      expect(addRes.status).toBe(200);

      // Verify member can access board
      const preCheck = await app.request(`/api/projects/${project.id}/board`, {
        method: "GET",
        headers: { Cookie: member.cookie },
      });
      expect(preCheck.status).toBe(200);

      // Remove member from workspace
      const delRes = await app.request(
        `/api/workspaces/${workspace.id}/members/${member.user.id}`,
        {
          method: "DELETE",
          headers: { Cookie: owner.cookie },
        }
      );
      expect(delRes.status).toBe(200);

      // Verify member's immediate subsequent request returns 404 NOT_FOUND
      const postCheck = await app.request(`/api/projects/${project.id}/board`, {
        method: "GET",
        headers: { Cookie: member.cookie },
      });
      expect(postCheck.status).toBe(404);
      const postData = await postCheck.json();
      expect(postData.error.code).toBe("NOT_FOUND");
    });
  });

  // =========================================================================
  // Scenario 10: PostgreSQL MVCC snapshot consistency under concurrent committed mutation
  // =========================================================================
  describe("Scenario 10: PostgreSQL MVCC Snapshot Consistency Under Concurrent Committed Mutation", () => {
    it("guarantees an established REPEATABLE READ snapshot cannot observe concurrent committed tasks or sequence increments", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Seed 1 initial task and commit event seq = 1
      const [initialTask] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: columns[0].id,
          title: "Initial Task",
          createdBy: owner.user.id,
          rankKey: "0|hzzzzz:",
          version: 1,
        })
        .returning();

      await testDb.transaction(async (tx) => {
        await EventService.appendProjectEvent(tx, {
          projectId: project.id,
          actorId: owner.user.id,
          eventType: "task.created",
          entityType: "task",
          entityId: initialTask!.id,
          payload: {
            task: {
              id: initialTask!.id,
              projectId: project.id,
              columnId: columns[0].id,
              title: "Initial Task",
              description: "",
              createdBy: owner.user.id,
              assigneeId: null,
              rankKey: "0|hzzzzz:",
              version: 1,
              dueDate: null,
              createdAt: initialTask!.createdAt.toISOString(),
              updatedAt: initialTask!.updatedAt.toISOString(),
              archivedAt: null,
            },
            changes: { title: { to: "Initial Task" } },
          },
        });
      });

      // Verify baseline sequence is 1
      const [projBefore] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(projBefore!.lastSeq).toBe(1);

      // Transaction A opens with REPEATABLE READ, READ ONLY isolation
      await testDb.transaction(
        async (txA) => {
          // 1. Transaction A establishes its snapshot boundary by reading project metadata
          const [projectSnapshotA] = await txA
            .select()
            .from(projects)
            .where(eq(projects.id, project.id));
          expect(projectSnapshotA!.lastSeq).toBe(1);

          // 2. Transaction A reads initial tasks in its snapshot
          const tasksInA1 = await txA
            .select()
            .from(tasks)
            .where(and(eq(tasks.projectId, project.id), isNull(tasks.archivedAt)));
          expect(tasksInA1.length).toBe(1);
          expect(tasksInA1[0].title).toBe("Initial Task");

          // 3. Concurrent Transaction B runs on outside connection and commits:
          //    - a new task (Concurrent Task 2)
          //    - an event incrementing lastSeq from 1 to 2
          await testDb.transaction(async (txB) => {
            const [concurrentTask] = await txB
              .insert(tasks)
              .values({
                projectId: project.id,
                columnId: columns[0].id,
                title: "Concurrent Task 2",
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
              entityId: concurrentTask!.id,
              payload: {
                task: {
                  id: concurrentTask!.id,
                  projectId: project.id,
                  columnId: columns[0].id,
                  title: "Concurrent Task 2",
                  description: "",
                  createdBy: owner.user.id,
                  assigneeId: null,
                  rankKey: "0|i00000:",
                  version: 1,
                  dueDate: null,
                  createdAt: concurrentTask!.createdAt.toISOString(),
                  updatedAt: concurrentTask!.updatedAt.toISOString(),
                  archivedAt: null,
                },
                changes: { title: { to: "Concurrent Task 2" } },
              },
            });
          });

          // 4. Verify outside database world now has lastSeq = 2 and 2 tasks
          const [outsideProj] = await testDb
            .select()
            .from(projects)
            .where(eq(projects.id, project.id));
          expect(outsideProj!.lastSeq).toBe(2);

          const outsideTasks = await testDb
            .select()
            .from(tasks)
            .where(and(eq(tasks.projectId, project.id), isNull(tasks.archivedAt)));
          expect(outsideTasks.length).toBe(2);

          // 5. In Transaction A (REPEATABLE READ), re-read project and tasks:
          //    The MVCC snapshot MUST NOT observe Transaction B's changes!
          const [projectSnapshotA2] = await txA
            .select()
            .from(projects)
            .where(eq(projects.id, project.id));
          expect(projectSnapshotA2!.lastSeq).toBe(1);

          const tasksInA2 = await txA
            .select()
            .from(tasks)
            .where(and(eq(tasks.projectId, project.id), isNull(tasks.archivedAt)))
            .orderBy(asc(tasks.rankKey), asc(tasks.id));
          expect(tasksInA2.length).toBe(1);
          expect(tasksInA2[0].title).toBe("Initial Task");
          expect(tasksInA2.some((t) => t.title === "Concurrent Task 2")).toBe(false);

          // Events in Transaction A must also not see event 2
          const eventsInA = await txA
            .select()
            .from(projectEvents)
            .where(and(eq(projectEvents.projectId, project.id), eq(projectEvents.seq, 2)));
          expect(eventsInA).toHaveLength(0);
        },
        {
          isolationLevel: "repeatable read",
          accessMode: "read only",
        }
      );

      // 6. After Transaction A completes, a fresh call to ProjectService.getBoard sees the full committed state
      const freshBoard = await ProjectService.getBoard(testDb, {
        projectId: project.id,
        callerId: owner.user.id,
      });
      expect(freshBoard).not.toBeNull();
      expect(freshBoard!.snapshotSeq).toBe(2);
      expect(freshBoard!.tasks.length).toBe(2);
    });
  });

  // =========================================================================
  // Scenario 11: Direct ProjectService.getBoard response verification
  // =========================================================================
  describe("Scenario 11: Direct ProjectService.getBoard Verification Against Committed State", () => {
    it("matches the exact committed database entities, types, and values", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();

      // Seed 2 tasks across columns
      const [t1] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: columns[0].id,
          title: "Service Verification Task 1",
          description: "Desc 1",
          createdBy: owner.user.id,
          rankKey: "0|hzzzzz:",
          version: 1,
        })
        .returning();

      const [t2] = await testDb
        .insert(tasks)
        .values({
          projectId: project.id,
          columnId: columns[1].id,
          title: "Service Verification Task 2",
          description: "Desc 2",
          createdBy: owner.user.id,
          rankKey: "0|i00000:",
          version: 1,
        })
        .returning();

      const boardResult = await ProjectService.getBoard(testDb, {
        projectId: project.id,
        callerId: owner.user.id,
      });

      expect(boardResult).not.toBeNull();
      expect(boardResult!.project.id).toBe(project.id);
      expect(boardResult!.project.workspaceId).toBe(project.workspaceId);
      expect(boardResult!.project.lastSeq).toBe(0);
      expect(boardResult!.snapshotSeq).toBe(0);

      // Columns match exactly
      expect(boardResult!.columns.length).toBe(4);
      expect(boardResult!.columns[0].name).toBe("Backlog");
      expect(boardResult!.columns[1].name).toBe("Todo");
      expect(boardResult!.columns[2].name).toBe("In Progress");
      expect(boardResult!.columns[3].name).toBe("Done");

      // Tasks match exactly
      expect(boardResult!.tasks.length).toBe(2);
      expect(boardResult!.tasks[0].id).toBe(t1!.id);
      expect(boardResult!.tasks[0].title).toBe("Service Verification Task 1");
      expect(boardResult!.tasks[0].columnId).toBe(columns[0].id);

      expect(boardResult!.tasks[1].id).toBe(t2!.id);
      expect(boardResult!.tasks[1].title).toBe("Service Verification Task 2");
      expect(boardResult!.tasks[1].columnId).toBe(columns[1].id);
    });
  });
});
