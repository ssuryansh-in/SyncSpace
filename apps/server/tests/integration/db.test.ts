import { beforeEach, describe, expect, it } from "vitest";
import { cleanTables, testDb, testSqlClient } from "./setup.js";
import {
  idempotencyRecords,
  projectColumns,
  projectEvents,
  projects,
  tasks,
  users,
  workspaceMembers,
  workspaces,
} from "../../src/db/schema/index.js";
import { eq, sql } from "drizzle-orm";

describe("Database Schema & Constraints (Integration)", () => {
  beforeEach(async () => {
    await cleanTables(testSqlClient);
  });

  it("enforces CITEXT case-insensitive uniqueness on users.email", async () => {
    // Insert initial user with lowercase email
    await testDb.insert(users).values({
      email: "test.user@syncspace.local",
      displayName: "Test User",
    });

    // Attempting to insert uppercase version of the same email should fail
    await expect(
      testDb.insert(users).values({
        email: "TEST.USER@SYNCSPACE.LOCAL",
        displayName: "Duplicate User",
      })
    ).rejects.toThrow();
  });

  it("enforces role check constraint on workspace_members", async () => {
    const [user] = await testDb
      .insert(users)
      .values({ email: "owner@syncspace.local", displayName: "Owner" })
      .returning();

    const [ws] = await testDb
      .insert(workspaces)
      .values({ name: "Workspace 1", ownerId: user!.id })
      .returning();

    // Valid role 'admin'
    await expect(
      testDb.insert(workspaceMembers).values({
        workspaceId: ws!.id,
        userId: user!.id,
        role: "admin",
      })
    ).resolves.toBeDefined();

    // Invalid role 'guest' must violate workspace_members_role_check
    const [anotherUser] = await testDb
      .insert(users)
      .values({ email: "guest@syncspace.local", displayName: "Guest" })
      .returning();

    await expect(
      testDb.insert(workspaceMembers).values({
        workspaceId: ws!.id,
        userId: anotherUser!.id,
        role: "guest",
      })
    ).rejects.toThrow();
  });

  it("enforces unique constraint on project_columns (project_id, position)", async () => {
    const [user] = await testDb
      .insert(users)
      .values({ email: "user@syncspace.local", displayName: "User" })
      .returning();

    const [ws] = await testDb
      .insert(workspaces)
      .values({ name: "WS", ownerId: user!.id })
      .returning();

    const [proj] = await testDb
      .insert(projects)
      .values({ name: "Project", workspaceId: ws!.id, createdBy: user!.id })
      .returning();

    await testDb.insert(projectColumns).values({
      projectId: proj!.id,
      name: "Todo",
      position: 0,
    });

    // Duplicate position on same project must fail
    await expect(
      testDb.insert(projectColumns).values({
        projectId: proj!.id,
        name: "Backlog",
        position: 0,
      })
    ).rejects.toThrow();
  });

  it("indexes and searches tasks full-text vector correctly", async () => {
    const [user] = await testDb
      .insert(users)
      .values({ email: "taskauthor@syncspace.local", displayName: "Author" })
      .returning();

    const [ws] = await testDb
      .insert(workspaces)
      .values({ name: "WS", ownerId: user!.id })
      .returning();

    const [proj] = await testDb
      .insert(projects)
      .values({ name: "Project", workspaceId: ws!.id, createdBy: user!.id })
      .returning();

    const [col] = await testDb
      .insert(projectColumns)
      .values({ projectId: proj!.id, name: "Todo", position: 0 })
      .returning();

    await testDb.insert(tasks).values({
      projectId: proj!.id,
      columnId: col!.id,
      title: "Implement database foundation with Drizzle",
      description: "Setup PostgreSQL connection pool and migration scripts",
      createdBy: user!.id,
      rankKey: "0|hzzzzz:",
      version: 1,
    });

    const searchResults = await testDb
      .select()
      .from(tasks)
      .where(
        sql`to_tsvector('english', ${tasks.title} || ' ' || ${tasks.description}) @@ to_tsquery('english', 'PostgreSQL')`
      );

    expect(searchResults.length).toBe(1);
    expect(searchResults[0]?.title).toBe("Implement database foundation with Drizzle");
  });

  it("enforces unique constraint on project_events (project_id, seq)", async () => {
    const [user] = await testDb
      .insert(users)
      .values({ email: "eventactor@syncspace.local", displayName: "Actor" })
      .returning();

    const [ws] = await testDb
      .insert(workspaces)
      .values({ name: "WS", ownerId: user!.id })
      .returning();

    const [proj] = await testDb
      .insert(projects)
      .values({ name: "Project", workspaceId: ws!.id, createdBy: user!.id })
      .returning();

    await testDb.insert(projectEvents).values({
      projectId: proj!.id,
      seq: 1,
      actorId: user!.id,
      eventType: "task.created",
      entityType: "task",
      entityId: user!.id,
      payload: { hello: "world" },
    });

    // Inserting another event with the same project and seq must fail
    await expect(
      testDb.insert(projectEvents).values({
        projectId: proj!.id,
        seq: 1,
        actorId: user!.id,
        eventType: "task.updated",
        entityType: "task",
        entityId: user!.id,
        payload: { another: "payload" },
      })
    ).rejects.toThrow();
  });

  it("enforces unique constraint on idempotency_records (actor_id, endpoint_key, idempotency_key)", async () => {
    const [user] = await testDb
      .insert(users)
      .values({ email: "idempactor@syncspace.local", displayName: "Actor" })
      .returning();

    await testDb.insert(idempotencyRecords).values({
      actorId: user!.id,
      endpointKey: "tasks:create",
      idempotencyKey: "req-key-1234",
      requestHash: "hash-abc",
      responseStatus: 201,
      responseBody: { taskId: "123" },
    });

    // Duplicate key for same actor and endpoint must fail
    await expect(
      testDb.insert(idempotencyRecords).values({
        actorId: user!.id,
        endpointKey: "tasks:create",
        idempotencyKey: "req-key-1234",
        requestHash: "hash-def",
        responseStatus: 201,
        responseBody: { taskId: "456" },
      })
    ).rejects.toThrow();
  });
});
