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
import {
  projectSnapshotSchema,
  projectUpdatedPayloadSchema,
  projectArchivedPayloadSchema,
  projectRestoredPayloadSchema,
  taskCreatedPayloadSchema,
  taskUpdatedPayloadSchema,
  taskMovedPayloadSchema,
  taskArchivedPayloadSchema,
  taskRestoredPayloadSchema,
} from "../../src/services/event.js";

describe("Project Lifecycle Events (Integration - Milestone 7.3)", () => {
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
  async function setupWorkspaceAndProject(
    ownerName = "Owner User",
    ownerEmail = "owner@example.com"
  ) {
    const owner = await createAndLoginUser(ownerName, ownerEmail);

    const wsRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Lifecycle Event Workspace" }),
    });
    const { workspace } = await wsRes.json();

    const projRes = await app.request(`/api/workspaces/${workspace.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ name: "Lifecycle Event Project" }),
    });
    const { project, columns } = await projRes.json();

    return { owner, workspace, project, columns };
  }

  // ============================================================================
  // Scenario A: Project Rename Event (project.updated)
  // ============================================================================
  describe("Scenario A: Project Rename Event (project.updated)", () => {
    it("emits exactly one project.updated event with canonical snapshot, rename diff, and equal timestamps", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      // Set up notification listener
      const listenerClient = testSqlClient;
      const receivedNotifications: Array<{ projectId: string; seq: number }> = [];
      const subscription = await listenerClient.listen("project_events", (payloadStr) => {
        receivedNotifications.push(JSON.parse(payloadStr));
      });

      try {
        const renameRes = await app.request(`/api/projects/${project.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
          },
          body: JSON.stringify({ name: "Renamed Project Alpha" }),
        });

        expect(renameRes.status).toBe(200);
        const { project: updatedApiProject } = await renameRes.json();
        expect(updatedApiProject.name).toBe("Renamed Project Alpha");
        expect(updatedApiProject.lastSeq).toBe(1);

        // Fetch persisted project
        const [persistedProject] = await testDb
          .select()
          .from(projects)
          .where(eq(projects.id, project.id));
        expect(persistedProject).toBeDefined();
        expect(persistedProject!.name).toBe("Renamed Project Alpha");
        expect(persistedProject!.lastSeq).toBe(1);

        // Query events table
        const events = await testDb
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id));

        expect(events).toHaveLength(1);
        const event = events[0]!;

        // 1. Envelope assertions
        expect(event.projectId).toBe(project.id);
        expect(event.seq).toBe(1);
        expect(event.eventType).toBe("project.updated");
        expect(event.entityType).toBe("project");
        expect(event.entityId).toBe(project.id);
        expect(event.actorId).toBe(owner.user.id);

        // 2. Validate payload against Zod schema
        expect(() => projectUpdatedPayloadSchema.parse(event.payload)).not.toThrow();
        const payload = event.payload as any;

        // 3. Snapshot verification (all canonical fields)
        expect(payload.project).toEqual({
          id: project.id,
          workspaceId: project.workspaceId,
          name: "Renamed Project Alpha",
          archivedAt: null,
          lastSeq: 1,
          createdBy: owner.user.id,
          createdAt: persistedProject!.createdAt.toISOString(),
          updatedAt: persistedProject!.updatedAt.toISOString(),
        });

        // 4. Changes diff verification
        expect(payload.changes).toEqual({
          name: {
            from: "Lifecycle Event Project",
            to: "Renamed Project Alpha",
          },
        });

        // 5. Sequence & timestamp equality invariants
        expect(payload.project.lastSeq).toBe(event.seq);
        expect(payload.project.updatedAt).toBe(persistedProject!.updatedAt.toISOString());
        expect(updatedApiProject.updatedAt).toBe(persistedProject!.updatedAt.toISOString());

        // 6. Notification delivery
        expect(receivedNotifications).toHaveLength(1);
        expect(receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 1,
        });
      } finally {
        await subscription.unlisten();
      }
    });

    it("allows Admin to rename project and emits project.updated with admin actorId", async () => {
      const { owner, workspace, project } = await setupWorkspaceAndProject();

      const admin = await createAndLoginUser("Admin User", "admin@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: admin.user.id,
        role: "admin",
      });

      const renameRes = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: admin.cookie,
        },
        body: JSON.stringify({ name: "Admin Renamed Project" }),
      });

      expect(renameRes.status).toBe(200);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));

      expect(events).toHaveLength(1);
      expect(events[0]!.actorId).toBe(admin.user.id);
      expect(events[0]!.eventType).toBe("project.updated");
      expect(events[0]!.seq).toBe(1);
    });
  });

  // ============================================================================
  // Scenario B: Project Rename No-op
  // ============================================================================
  describe("Scenario B: Project Rename No-op", () => {
    it("suppresses event emission, preserves sequence, and preserves updatedAt when name is identical", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const [beforeProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));

      const res = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ name: "Lifecycle Event Project" }),
      });

      expect(res.status).toBe(200);
      const { project: returnedProject } = await res.json();
      expect(returnedProject.name).toBe("Lifecycle Event Project");

      // Verify no events were created
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(0);

      // Verify DB row remains completely untouched
      const [afterProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(afterProject!.lastSeq).toBe(0);
      expect(afterProject!.updatedAt.toISOString()).toBe(beforeProject!.updatedAt.toISOString());
    });

    it("suppresses event emission when name differs only by surrounding whitespace", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const [beforeProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));

      const res = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ name: "   Lifecycle Event Project   " }),
      });

      expect(res.status).toBe(200);

      // Verify no events were created
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(0);

      const [afterProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(afterProject!.lastSeq).toBe(0);
      expect(afterProject!.updatedAt.toISOString()).toBe(beforeProject!.updatedAt.toISOString());
    });
  });

  // ============================================================================
  // Scenario C: Project Archive Event (project.archived)
  // ============================================================================
  describe("Scenario C: Project Archive Event (project.archived)", () => {
    it("emits exactly one project.archived event with non-null archivedAt snapshot, diff, and equal timestamps", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const listenerClient = testSqlClient;
      const receivedNotifications: Array<{ projectId: string; seq: number }> = [];
      const subscription = await listenerClient.listen("project_events", (payloadStr) => {
        receivedNotifications.push(JSON.parse(payloadStr));
      });

      try {
        const archiveRes = await app.request(`/api/projects/${project.id}/archive`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
          },
        });

        expect(archiveRes.status).toBe(200);
        const { project: archivedApiProject } = await archiveRes.json();
        expect(archivedApiProject.archivedAt).not.toBeNull();
        expect(archivedApiProject.lastSeq).toBe(1);

        const [persistedProject] = await testDb
          .select()
          .from(projects)
          .where(eq(projects.id, project.id));
        expect(persistedProject).toBeDefined();
        expect(persistedProject!.archivedAt).not.toBeNull();
        expect(persistedProject!.lastSeq).toBe(1);

        const events = await testDb
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id));

        expect(events).toHaveLength(1);
        const event = events[0]!;

        // Envelope
        expect(event.projectId).toBe(project.id);
        expect(event.seq).toBe(1);
        expect(event.eventType).toBe("project.archived");
        expect(event.entityType).toBe("project");
        expect(event.entityId).toBe(project.id);
        expect(event.actorId).toBe(owner.user.id);

        // Payload validation
        expect(() => projectArchivedPayloadSchema.parse(event.payload)).not.toThrow();
        const payload = event.payload as any;

        // Snapshot
        expect(payload.project).toEqual({
          id: project.id,
          workspaceId: project.workspaceId,
          name: "Lifecycle Event Project",
          archivedAt: persistedProject!.archivedAt!.toISOString(),
          lastSeq: 1,
          createdBy: owner.user.id,
          createdAt: persistedProject!.createdAt.toISOString(),
          updatedAt: persistedProject!.updatedAt.toISOString(),
        });

        // Changes
        expect(payload.changes).toEqual({
          archivedAt: {
            from: null,
            to: persistedProject!.archivedAt!.toISOString(),
          },
        });

        // Equality invariants
        expect(payload.project.lastSeq).toBe(event.seq);
        expect(payload.project.updatedAt).toBe(persistedProject!.updatedAt.toISOString());
        expect(archivedApiProject.updatedAt).toBe(persistedProject!.updatedAt.toISOString());

        // Notification
        expect(receivedNotifications).toHaveLength(1);
        expect(receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 1,
        });
      } finally {
        await subscription.unlisten();
      }
    });

    it("allows Admin to archive project and emits project.archived with admin actorId", async () => {
      const { owner, workspace, project } = await setupWorkspaceAndProject();

      const admin = await createAndLoginUser("Admin User", "admin-archive@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: admin.user.id,
        role: "admin",
      });

      const archiveRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: admin.cookie,
        },
      });

      expect(archiveRes.status).toBe(200);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));

      expect(events).toHaveLength(1);
      expect(events[0]!.actorId).toBe(admin.user.id);
      expect(events[0]!.eventType).toBe("project.archived");
    });
  });

  // ============================================================================
  // Scenario D: Project Archive No-op
  // ============================================================================
  describe("Scenario D: Project Archive No-op", () => {
    it("suppresses event emission, preserves sequence, and preserves updatedAt on already archived project", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      // Initial archive
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      const [archivedState] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(archivedState!.lastSeq).toBe(1);

      const initialEvents = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(initialEvents).toHaveLength(1);

      // Second archive call (no-op)
      const secondRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(secondRes.status).toBe(200);
      const { project: secondProject } = await secondRes.json();
      expect(secondProject.archivedAt).not.toBeNull();

      // Events table count must still be exactly 1
      const afterEvents = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(afterEvents).toHaveLength(1);

      // Project record must not have changed lastSeq or updatedAt
      const [finalState] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(finalState!.lastSeq).toBe(1);
      expect(finalState!.updatedAt.toISOString()).toBe(archivedState!.updatedAt.toISOString());
      expect(finalState!.archivedAt!.toISOString()).toBe(archivedState!.archivedAt!.toISOString());
    });
  });

  // ============================================================================
  // Scenario E: Project Restore Event (project.restored)
  // ============================================================================
  describe("Scenario E: Project Restore Event (project.restored)", () => {
    it("emits exactly one project.restored event with archivedAt: null snapshot, diff, and equal timestamps", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      // First archive the project
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      const [archivedProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      const previousArchivedAtIso = archivedProject!.archivedAt!.toISOString();

      const listenerClient = testSqlClient;
      const receivedNotifications: Array<{ projectId: string; seq: number }> = [];
      const subscription = await listenerClient.listen("project_events", (payloadStr) => {
        receivedNotifications.push(JSON.parse(payloadStr));
      });

      try {
        const restoreRes = await app.request(`/api/projects/${project.id}/restore`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
          },
        });

        expect(restoreRes.status).toBe(200);
        const { project: restoredApiProject } = await restoreRes.json();
        expect(restoredApiProject.archivedAt).toBeNull();
        expect(restoredApiProject.lastSeq).toBe(2);

        const [persistedProject] = await testDb
          .select()
          .from(projects)
          .where(eq(projects.id, project.id));
        expect(persistedProject!.archivedAt).toBeNull();
        expect(persistedProject!.lastSeq).toBe(2);

        const events = await testDb
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id))
          .orderBy(asc(projectEvents.seq));

        expect(events).toHaveLength(2);
        const restoreEvent = events[1]!;

        // Envelope
        expect(restoreEvent.projectId).toBe(project.id);
        expect(restoreEvent.seq).toBe(2);
        expect(restoreEvent.eventType).toBe("project.restored");
        expect(restoreEvent.entityType).toBe("project");
        expect(restoreEvent.entityId).toBe(project.id);
        expect(restoreEvent.actorId).toBe(owner.user.id);

        // Payload validation
        expect(() => projectRestoredPayloadSchema.parse(restoreEvent.payload)).not.toThrow();
        const payload = restoreEvent.payload as any;

        // Snapshot
        expect(payload.project).toEqual({
          id: project.id,
          workspaceId: project.workspaceId,
          name: "Lifecycle Event Project",
          archivedAt: null,
          lastSeq: 2,
          createdBy: owner.user.id,
          createdAt: persistedProject!.createdAt.toISOString(),
          updatedAt: persistedProject!.updatedAt.toISOString(),
        });

        // Changes
        expect(payload.changes).toEqual({
          archivedAt: {
            from: previousArchivedAtIso,
            to: null,
          },
        });

        // Equality invariants
        expect(payload.project.lastSeq).toBe(restoreEvent.seq);
        expect(payload.project.updatedAt).toBe(persistedProject!.updatedAt.toISOString());
        expect(restoredApiProject.updatedAt).toBe(persistedProject!.updatedAt.toISOString());

        // Notification received for seq 2
        expect(receivedNotifications).toContainEqual({
          projectId: project.id,
          seq: 2,
        });
      } finally {
        await subscription.unlisten();
      }
    });

    it("allows Admin to restore project and emits project.restored with admin actorId", async () => {
      const { owner, workspace, project } = await setupWorkspaceAndProject();

      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      const admin = await createAndLoginUser("Admin User", "admin-restore@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: admin.user.id,
        role: "admin",
      });

      const restoreRes = await app.request(`/api/projects/${project.id}/restore`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: admin.cookie,
        },
      });

      expect(restoreRes.status).toBe(200);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(
          and(
            eq(projectEvents.projectId, project.id),
            eq(projectEvents.eventType, "project.restored")
          )
        );

      expect(events).toHaveLength(1);
      expect(events[0]!.actorId).toBe(admin.user.id);
      expect(events[0]!.seq).toBe(2);
    });
  });

  // ============================================================================
  // Scenario F: Project Restore No-op
  // ============================================================================
  describe("Scenario F: Project Restore No-op", () => {
    it("suppresses event emission, preserves sequence, and preserves updatedAt on already active project", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const [beforeProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));

      const res = await app.request(`/api/projects/${project.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      expect(res.status).toBe(200);
      const { project: returnedProject } = await res.json();
      expect(returnedProject.archivedAt).toBeNull();

      // Zero events emitted
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(0);

      // Record untouched
      const [afterProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(afterProject!.lastSeq).toBe(0);
      expect(afterProject!.updatedAt.toISOString()).toBe(beforeProject!.updatedAt.toISOString());
    });
  });

  // ============================================================================
  // Scenario G: Authorization & Validation Non-Emission
  // ============================================================================
  describe("Scenario G: Authorization & Validation Non-Emission", () => {
    it("rejects regular Member attempts to rename with 403 and emits zero events", async () => {
      const { workspace, project } = await setupWorkspaceAndProject();

      const member = await createAndLoginUser("Member User", "member-rename@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const res = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: member.cookie,
        },
        body: JSON.stringify({ name: "Unauthorized Rename" }),
      });

      expect(res.status).toBe(403);
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(0);
    });

    it("rejects regular Member attempts to archive with 403 and emits zero events", async () => {
      const { workspace, project } = await setupWorkspaceAndProject();

      const member = await createAndLoginUser("Member User", "member-archive@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const res = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });

      expect(res.status).toBe(403);
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(0);
    });

    it("rejects regular Member attempts to restore with 403 and emits zero events", async () => {
      const { owner, workspace, project } = await setupWorkspaceAndProject();

      // Owner archives project first
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      const member = await createAndLoginUser("Member User", "member-restore@example.com");
      await testDb.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: member.user.id,
        role: "member",
      });

      const res = await app.request(`/api/projects/${project.id}/restore`, {
        method: "POST",
        headers: { Cookie: member.cookie },
      });

      expect(res.status).toBe(403);

      // Only the initial archive event exists; restore produced 0 events
      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("project.archived");
    });

    it("conceals non-member access with 404 NOT_FOUND and emits zero events", async () => {
      const { project } = await setupWorkspaceAndProject();
      const outsider = await createAndLoginUser("Outsider User", "outsider@example.com");

      // Rename attempt -> 404
      const renameRes = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: outsider.cookie,
        },
        body: JSON.stringify({ name: "Outsider Rename" }),
      });
      expect(renameRes.status).toBe(404);

      // Archive attempt -> 404
      const archiveRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: outsider.cookie },
      });
      expect(archiveRes.status).toBe(404);

      // Restore attempt -> 404
      const restoreRes = await app.request(`/api/projects/${project.id}/restore`, {
        method: "POST",
        headers: { Cookie: outsider.cookie },
      });
      expect(restoreRes.status).toBe(404);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(0);
    });

    it("rejects invalid rename payloads with 400 VALIDATION_ERROR and emits zero events", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      // Empty name
      const emptyRes = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ name: "" }),
      });
      expect(emptyRes.status).toBe(400);

      // Whitespace only name
      const wsRes = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ name: "   " }),
      });
      expect(wsRes.status).toBe(400);

      // Overlength name (> 100 chars)
      const longRes = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ name: "a".repeat(101) }),
      });
      expect(longRes.status).toBe(400);

      const events = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(events).toHaveLength(0);
    });

    it("rejects rename of an archived project with 409 PROJECT_ARCHIVED and emits zero events", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      // Archive project
      await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });

      const initialEvents = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(initialEvents).toHaveLength(1);

      // Attempt rename on archived project
      const renameRes = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ name: "Should Fail Rename" }),
      });

      expect(renameRes.status).toBe(409);
      const errBody = await renameRes.json();
      expect(errBody.error.code).toBe("PROJECT_ARCHIVED");

      // Events count remains 1 (only the archive event)
      const afterEvents = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id));
      expect(afterEvents).toHaveLength(1);
    });
  });

  // ============================================================================
  // Scenario H: Rollback & Notification Atomicity
  // ============================================================================
  describe("Scenario H: Rollback & Notification Atomicity", () => {
    it("atomically rolls back project mutation, event row, and sequence on abort without leaking NOTIFY", async () => {
      const { owner, project } = await setupWorkspaceAndProject();

      const listenerClient = testSqlClient;
      const receivedNotifications: Array<{ projectId: string; seq: number }> = [];

      type NotificationEvent = { channel: string; payload: { projectId: string; seq: number } };
      let waiter: {
        expectedSeq: number;
        resolve: (event: NotificationEvent) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
      } | null = null;

      function waitForNotification(expectedSeq: number, timeoutMs = 5000): Promise<NotificationEvent> {
        return new Promise<NotificationEvent>((resolve, reject) => {
          const existing = receivedNotifications.find((n) => n.seq === expectedSeq);
          if (existing) {
            return resolve({ channel: "project_events", payload: existing });
          }

          const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for notification seq=${expectedSeq}`));
          }, timeoutMs);

          waiter = { expectedSeq, resolve, reject, timer };
        });
      }

      const subscription = await listenerClient.listen("project_events", (payloadStr) => {
        try {
          const parsed = JSON.parse(payloadStr) as { projectId: string; seq: number };
          receivedNotifications.push(parsed);

          if (waiter && waiter.expectedSeq === parsed.seq) {
            clearTimeout(waiter.timer);
            waiter.resolve({ channel: "project_events", payload: parsed });
            waiter = null;
          }
        } catch (err: any) {
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.reject(err);
            waiter = null;
          }
        }
      });

      try {
        // 1. Aborted transaction: modify project and append event, then fail before commit
        let aborted = false;
        try {
          await testDb.transaction(async (tx) => {
            // Lock project row
            await (tx
              .select()
              .from(projects)
              .where(eq(projects.id, project.id)) as any).for("update");

            const now = new Date();
            // Mutate project row
            const [updated] = await tx
              .update(projects)
              .set({
                name: "Name That Must Roll Back",
                updatedAt: now,
              })
              .where(eq(projects.id, project.id))
              .returning();

            // Append project.updated event
            const { EventService } = await import("../../src/services/event.js");
            const { buildProjectSnapshot, buildProjectChanges } = await import(
              "../../src/services/project.js"
            );
            const snapshot = buildProjectSnapshot(updated!, 1, now);
            const changes = buildProjectChanges(project, updated!);

            await EventService.appendProjectEvent(tx, {
              projectId: project.id,
              actorId: owner.user.id,
              eventType: "project.updated",
              entityType: "project",
              entityId: project.id,
              payload: { project: snapshot, changes },
              updatedAt: now,
            });

            // Force deliberate failure after event append
            throw new Error("Deliberate downstream failure after project event append");
          });
        } catch (err: any) {
          if (err.message === "Deliberate downstream failure after project event append") {
            aborted = true;
          }
        }

        expect(aborted).toBe(true);

        // Verify project mutation rolled back: name and lastSeq unchanged
        const [dbProj] = await testDb
          .select()
          .from(projects)
          .where(eq(projects.id, project.id));
        expect(dbProj!.name).toBe("Lifecycle Event Project");
        expect(dbProj!.lastSeq).toBe(0);

        // Verify event rolled back: 0 rows in project_events
        const dbEvents = await testDb
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id));
        expect(dbEvents).toHaveLength(0);

        // 2. Synchronization Barrier: commit a successful project rename mutation
        const barrierPromise = waitForNotification(1);
        const barrierRes = await app.request(`/api/projects/${project.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: owner.cookie,
          },
          body: JSON.stringify({ name: "Barrier Committed Project" }),
        });
        expect(barrierRes.status).toBe(200);

        const barrierNotification = await barrierPromise;
        expect(barrierNotification.payload).toEqual({
          projectId: project.id,
          seq: 1,
        });

        // Exactly one notification was received overall (proves aborted transaction emitted no notification)
        expect(receivedNotifications).toHaveLength(1);
        expect(receivedNotifications[0]).toEqual({
          projectId: project.id,
          seq: 1,
        });
      } finally {
        if (waiter) clearTimeout((waiter as any).timer);
        await subscription.unlisten();
      }
    });
  });

  // ============================================================================
  // Scenario I: Interleaved Sequencing
  // ============================================================================
  describe("Scenario I: Interleaved Sequencing", () => {
    it("maintains strictly contiguous sequences across mixed task and project lifecycle events", async () => {
      const { owner, project, columns } = await setupWorkspaceAndProject();
      const colId = columns[0].id;

      // 1. Task creation -> seq 1 (task.created)
      const task1Res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "Idempotency-Key": `interleave-1-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          title: "Interleaved Task 1",
          columnId: colId,
        }),
      });
      expect(task1Res.status).toBe(201);
      const { task: t1 } = await task1Res.json();

      // 2. Project rename -> seq 2 (project.updated)
      const renameRes = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({ name: "Interleaved Renamed Project" }),
      });
      expect(renameRes.status).toBe(200);

      // 3. Task title update -> seq 3 (task.updated)
      const updateTaskRes = await app.request(`/api/tasks/${t1.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({
          title: "Interleaved Task 1 Renamed",
          expectedVersion: 1,
        }),
      });
      expect(updateTaskRes.status).toBe(200);

      // 4. Project archive -> seq 4 (project.archived)
      const archiveRes = await app.request(`/api/projects/${project.id}/archive`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(archiveRes.status).toBe(200);

      // 5. Project restore -> seq 5 (project.restored)
      const restoreRes = await app.request(`/api/projects/${project.id}/restore`, {
        method: "POST",
        headers: { Cookie: owner.cookie },
      });
      expect(restoreRes.status).toBe(200);

      // 6. Task move -> seq 6 (task.moved)
      const targetColId = columns[1].id;
      const moveRes = await app.request(`/api/tasks/${t1.id}/move`, {
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

      // 7. Task archive -> seq 7 (task.archived)
      const archiveTaskRes = await app.request(`/api/tasks/${t1.id}/archive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({
          expectedVersion: 3,
        }),
      });
      expect(archiveTaskRes.status).toBe(200);

      // 8. Task restore -> seq 8 (task.restored)
      const restoreTaskRes = await app.request(`/api/tasks/${t1.id}/restore`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
        },
        body: JSON.stringify({
          expectedVersion: 4,
        }),
      });
      expect(restoreTaskRes.status).toBe(200);

      // Query all project events in order
      const allEvents = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .orderBy(asc(projectEvents.seq));

      expect(allEvents).toHaveLength(8);

      const expectedTypes = [
        "task.created",
        "project.updated",
        "task.updated",
        "project.archived",
        "project.restored",
        "task.moved",
        "task.archived",
        "task.restored",
      ];

      for (let i = 0; i < 8; i++) {
        expect(allEvents[i]!.seq).toBe(i + 1);
        expect(allEvents[i]!.eventType).toBe(expectedTypes[i]);
      }

      // Check project row lastSeq matches 8
      const [finalProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(finalProject!.lastSeq).toBe(8);
    });
  });
});

