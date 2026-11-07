import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import {
  testDb,
  testSqlClient,
  cleanTables,
  validateTestDatabaseUrl,
} from "./setup.js";
import {
  users,
  workspaces,
  projects,
  projectColumns,
  tasks,
  projectEvents,
} from "../../src/db/schema/index.js";
import {
  EventService,
  appendProjectEvent,
  appendProjectEvents,
  type AppendProjectEventInput,
} from "../../src/services/event.js";
import { AppError } from "../../src/errors/index.js";

describe("Transactional Event Infrastructure (Integration - Milestone 7.1)", () => {
  let testUrl: string;
  let activeListeners: postgres.Sql[] = [];

  let testUser: typeof users.$inferSelect;
  let testWorkspace: typeof workspaces.$inferSelect;
  let testProject: typeof projects.$inferSelect;
  let testColumn: typeof projectColumns.$inferSelect;
  let testTask: typeof tasks.$inferSelect;

  beforeEach(async () => {
    testUrl = validateTestDatabaseUrl();
    await cleanTables(testSqlClient);

    // Seed foundational test data
    const [user] = await testDb
      .insert(users)
      .values({
        email: "event-tester@example.com",
        displayName: "Event Tester",
        emailVerified: true,
      })
      .returning();
    testUser = user!;

    const [ws] = await testDb
      .insert(workspaces)
      .values({
        name: "Event Workspace",
        ownerId: testUser.id,
      })
      .returning();
    testWorkspace = ws!;

    const [proj] = await testDb
      .insert(projects)
      .values({
        workspaceId: testWorkspace.id,
        name: "Event Project",
        createdBy: testUser.id,
      })
      .returning();
    testProject = proj!;

    const [col] = await testDb
      .insert(projectColumns)
      .values({
        projectId: testProject.id,
        name: "Todo",
        position: 0,
      })
      .returning();
    testColumn = col!;

    const [t] = await testDb
      .insert(tasks)
      .values({
        projectId: testProject.id,
        columnId: testColumn.id,
        title: "Test Task",
        createdBy: testUser.id,
        rankKey: "a0",
        version: 1,
      })
      .returning();
    testTask = t!;
  });

  afterEach(async () => {
    // Clean up any test LISTEN clients
    for (const listener of activeListeners) {
      await listener.end({ timeout: 2 }).catch(() => {});
    }
    activeListeners = [];
  });

  function createValidTaskEventInput(
    overrides: Partial<AppendProjectEventInput> = {}
  ): AppendProjectEventInput {
    return {
      projectId: testProject.id,
      actorId: testUser.id,
      eventType: "task.created",
      entityType: "task",
      entityId: testTask.id,
      payload: {
        task: {
          id: testTask.id,
          projectId: testProject.id,
          columnId: testColumn.id,
          title: testTask.title,
          description: testTask.description,
          createdBy: testUser.id,
          assigneeId: null,
          rankKey: testTask.rankKey,
          version: testTask.version,
          dueDate: null,
          createdAt: testTask.createdAt.toISOString(),
          updatedAt: testTask.updatedAt.toISOString(),
          archivedAt: null,
        },
        changes: {
          title: { to: testTask.title },
          columnId: { to: testColumn.id },
        },
      },
      ...overrides,
    };
  }

  describe("A. Basic Sequence Allocation & Persistence", () => {
    it("allocates sequence 1 on initial event, increments last_seq to 1, and persists event row", async () => {
      // 1. Verify initial baseline
      const [initialProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, testProject.id));
      expect(initialProject!.lastSeq).toBe(0);

      // 2. Append event inside transaction
      const createdEvent = await testDb.transaction(async (tx) => {
        return await appendProjectEvent(tx, createValidTaskEventInput());
      });

      // 3. Verify returned event properties
      expect(createdEvent.seq).toBe(1);
      expect(createdEvent.projectId).toBe(testProject.id);
      expect(createdEvent.actorId).toBe(testUser.id);
      expect(createdEvent.eventType).toBe("task.created");
      expect(createdEvent.entityType).toBe("task");
      expect(createdEvent.entityId).toBe(testTask.id);

      // 4. Verify projects.last_seq updated to 1
      const [updatedProject] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, testProject.id));
      expect(updatedProject!.lastSeq).toBe(1);

      // 5. Verify project_events table row
      const eventRows = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, testProject.id));
      expect(eventRows).toHaveLength(1);
      expect(eventRows[0]!.seq).toBe(1);
      expect(eventRows[0]!.eventType).toBe("task.created");
    });
  });

  describe("B. Multiple Events Within One Transaction", () => {
    it("allocates consecutive sequence numbers (1, 2) and updates last_seq to 2 for sequential calls in one transaction", async () => {
      const rebalanceInput: AppendProjectEventInput = {
        projectId: testProject.id,
        actorId: testUser.id,
        eventType: "column.rebalanced",
        entityType: "column",
        entityId: testColumn.id,
        payload: {
          columnId: testColumn.id,
          rankKeyMap: {
            [testTask.id]: "a0",
          },
        },
      };

      const moveInput: AppendProjectEventInput = {
        projectId: testProject.id,
        actorId: testUser.id,
        eventType: "task.moved",
        entityType: "task",
        entityId: testTask.id,
        payload: {
          task: {
            id: testTask.id,
            projectId: testProject.id,
            columnId: testColumn.id,
            title: testTask.title,
            description: testTask.description,
            createdBy: testUser.id,
            assigneeId: null,
            rankKey: "a1",
            version: 2,
            dueDate: null,
            createdAt: testTask.createdAt.toISOString(),
            updatedAt: testTask.updatedAt.toISOString(),
            archivedAt: null,
          },
          changes: {
            rankKey: { from: "a0", to: "a1" },
          },
        },
      };

      const [event1, event2] = await testDb.transaction(async (tx) => {
        const e1 = await appendProjectEvent(tx, rebalanceInput);
        const e2 = await appendProjectEvent(tx, moveInput);
        return [e1, e2];
      });

      expect(event1!.seq).toBe(1);
      expect(event1!.eventType).toBe("column.rebalanced");

      expect(event2!.seq).toBe(2);
      expect(event2!.eventType).toBe("task.moved");

      const [project] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, testProject.id));
      expect(project!.lastSeq).toBe(2);

      const rows = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, testProject.id))
        .orderBy(projectEvents.seq);

      expect(rows).toHaveLength(2);
      expect(rows[0]!.seq).toBe(1);
      expect(rows[1]!.seq).toBe(2);
    });

    it("supports appendProjectEvents batch helper allocating strictly consecutive sequences", async () => {
      const inputs = [
        createValidTaskEventInput({ eventType: "task.created" }),
        createValidTaskEventInput({
          eventType: "task.updated",
          payload: {
            task: {
              id: testTask.id,
              projectId: testProject.id,
              columnId: testColumn.id,
              title: "Updated",
              description: testTask.description,
              createdBy: testUser.id,
              assigneeId: null,
              rankKey: testTask.rankKey,
              version: 2,
              dueDate: null,
              createdAt: testTask.createdAt.toISOString(),
              updatedAt: testTask.updatedAt.toISOString(),
              archivedAt: null,
            },
            changes: {
              title: { from: "Test Task", to: "Updated" },
            },
          },
        }),
      ];

      const events = await testDb.transaction(async (tx) => {
        return await appendProjectEvents(tx, inputs);
      });

      expect(events).toHaveLength(2);
      expect(events[0]!.seq).toBe(1);
      expect(events[1]!.seq).toBe(2);

      const [project] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, testProject.id));
      expect(project!.lastSeq).toBe(2);
    });
  });

  describe("C. Transaction Rollback & Atomicity", () => {
    it("leaves 0 events and does not increment last_seq when transaction aborts", async () => {
      let aborted = false;

      try {
        await testDb.transaction(async (tx) => {
          await appendProjectEvent(tx, createValidTaskEventInput());
          // Deliberately trigger error to force ACID rollback
          throw new Error("Deliberate transaction failure");
        });
      } catch (err: any) {
        if (err.message === "Deliberate transaction failure") {
          aborted = true;
        }
      }

      expect(aborted).toBe(true);

      // Verify sequence counter was NOT incremented
      const [project] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, testProject.id));
      expect(project!.lastSeq).toBe(0);

      // Verify no event row was committed
      const rows = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, testProject.id));
      expect(rows).toHaveLength(0);
    });
  });

  describe("D. Concurrent Transactions (Same Project)", () => {
    it("serializes concurrent writes via project row lock, allocating unique, contiguous, gap-free sequences", async () => {
      // Launch 5 genuinely concurrent transactions appending events to the same project
      const concurrencyCount = 5;

      const promises = Array.from({ length: concurrencyCount }, (_, i) => {
        return testDb.transaction(async (tx) => {
          return await appendProjectEvent(
            tx,
            createValidTaskEventInput({
              payload: {
                task: {
                  id: testTask.id,
                  projectId: testProject.id,
                  columnId: testColumn.id,
                  title: `Concurrent task edit ${i}`,
                  description: testTask.description,
                  createdBy: testUser.id,
                  assigneeId: null,
                  rankKey: testTask.rankKey,
                  version: i + 1,
                  dueDate: null,
                  createdAt: testTask.createdAt.toISOString(),
                  updatedAt: testTask.updatedAt.toISOString(),
                  archivedAt: null,
                },
                changes: {
                  title: { to: `Concurrent task edit ${i}` },
                },
              },
            })
          );
        });
      });

      const results = await Promise.all(promises);

      // Verify each transaction returned a unique sequence number
      const allocatedSeqs = results.map((r) => r.seq).sort((a, b) => a - b);
      expect(allocatedSeqs).toEqual([1, 2, 3, 4, 5]);

      // Verify projects.last_seq is strictly 5
      const [project] = await testDb
        .select()
        .from(projects)
        .where(eq(projects.id, testProject.id));
      expect(project!.lastSeq).toBe(concurrencyCount);

      // Verify committed events in database are strictly contiguous 1..5
      const rows = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, testProject.id))
        .orderBy(projectEvents.seq);

      expect(rows).toHaveLength(concurrencyCount);
      const dbSeqs = rows.map((r) => r.seq);
      expect(dbSeqs).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("E. Project Sequence Isolation", () => {
    it("maintains completely independent sequence counters for different projects", async () => {
      // Create Project B
      const [projectB] = await testDb
        .insert(projects)
        .values({
          workspaceId: testWorkspace.id,
          name: "Project B",
          createdBy: testUser.id,
        })
        .returning();

      // Append 2 events to Project A
      await testDb.transaction(async (tx) => {
        await appendProjectEvent(tx, createValidTaskEventInput({ projectId: testProject.id }));
        await appendProjectEvent(tx, createValidTaskEventInput({ projectId: testProject.id }));
      });

      // Append 1 event to Project B
      await testDb.transaction(async (tx) => {
        await appendProjectEvent(tx, createValidTaskEventInput({ projectId: projectB!.id }));
      });

      // Verify Project A has last_seq = 2 and sequences 1, 2
      const [finalA] = await testDb.select().from(projects).where(eq(projects.id, testProject.id));
      expect(finalA!.lastSeq).toBe(2);

      const rowsA = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, testProject.id))
        .orderBy(projectEvents.seq);
      expect(rowsA.map((r) => r.seq)).toEqual([1, 2]);

      // Verify Project B has last_seq = 1 and sequence 1
      const [finalB] = await testDb.select().from(projects).where(eq(projects.id, projectB!.id));
      expect(finalB!.lastSeq).toBe(1);

      const rowsB = await testDb
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, projectB!.id))
        .orderBy(projectEvents.seq);
      expect(rowsB.map((r) => r.seq)).toEqual([1]);
    });
  });

  describe("F. Missing Project Handling", () => {
    it("throws AppError.notFound (404) and inserts 0 events when project does not exist", async () => {
      const nonExistentProjectId = "00000000-0000-0000-0000-999999999999";

      await expect(
        testDb.transaction(async (tx) => {
          return await appendProjectEvent(
            tx,
            createValidTaskEventInput({ projectId: nonExistentProjectId })
          );
        })
      ).rejects.toThrow(AppError);

      try {
        await testDb.transaction(async (tx) => {
          await appendProjectEvent(
            tx,
            createValidTaskEventInput({ projectId: nonExistentProjectId })
          );
        });
      } catch (err: any) {
        expect(err.code).toBe("NOT_FOUND");
        expect(err.statusCode).toBe(404);
        expect(err.message).toBe("Project not found");
      }

      const rows = await testDb.select().from(projectEvents);
      expect(rows).toHaveLength(0);
    });
  });

  describe("G. PostgreSQL Transactional NOTIFY Behavior", () => {
    it("delivers notification only upon successful commit and delivers 0 notifications upon rollback", async () => {
      const listenerClient = postgres(testUrl, { max: 1 });
      activeListeners.push(listenerClient);

      const receivedNotifications: Array<{ projectId: string; seq: number }> = [];
      const channelName = "project_events";

      type NotificationEvent = { channel: string; payload: { projectId: string; seq: number } };
      const waiters: Array<{
        expectedSeq: number;
        resolve: (event: NotificationEvent) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
      }> = [];

      function waitForNotification(expectedSeq: number, timeoutMs = 5000): Promise<NotificationEvent> {
        return new Promise<NotificationEvent>((resolve, reject) => {
          const existing = receivedNotifications.find((n) => n.seq === expectedSeq);
          if (existing) {
            return resolve({ channel: channelName, payload: existing });
          }

          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.expectedSeq === expectedSeq);
            if (idx !== -1) waiters.splice(idx, 1);
            reject(new Error(`Timed out waiting for notification with seq=${expectedSeq} on '${channelName}'`));
          }, timeoutMs);

          waiters.push({ expectedSeq, resolve, reject, timer });
        });
      }

      // Start listening on project_events channel before committing any transaction
      await listenerClient.listen(channelName, (payloadStr) => {
        try {
          const parsed = JSON.parse(payloadStr) as { projectId: string; seq: number };
          receivedNotifications.push(parsed);

          const waiterIndex = waiters.findIndex((w) => w.expectedSeq === parsed.seq);
          if (waiterIndex !== -1) {
            const waiter = waiters.splice(waiterIndex, 1)[0]!;
            clearTimeout(waiter.timer);
            waiter.resolve({ channel: channelName, payload: parsed });
          }
        } catch (err: any) {
          while (waiters.length > 0) {
            const waiter = waiters.pop()!;
            clearTimeout(waiter.timer);
            waiter.reject(err);
          }
        }
      });

      try {
        // 1. Commit first valid event transaction
        const notificationPromise1 = waitForNotification(1);
        await testDb.transaction(async (tx) => {
          await appendProjectEvent(tx, createValidTaskEventInput());
        });

        // Await notification from the first committed transaction
        const notification1 = await notificationPromise1;

        // Verify channel and exact payload for event 1
        expect(notification1.channel).toBe("project_events");
        expect(notification1.payload).toEqual({
          projectId: testProject.id,
          seq: 1,
        });
        expect(receivedNotifications).toHaveLength(1);
        expect(receivedNotifications[0]).toEqual({
          projectId: testProject.id,
          seq: 1,
        });

        // 2. Abort an event transaction (must NOT dispatch notification, must NOT consume sequence)
        try {
          await testDb.transaction(async (tx) => {
            await appendProjectEvent(tx, createValidTaskEventInput());
            throw new Error("Abort transaction after notify");
          });
        } catch {
          // Expected abort
        }

        // 3. Commit a second valid event transaction as a synchronization barrier
        const notificationPromise2 = waitForNotification(2);
        await testDb.transaction(async (tx) => {
          await appendProjectEvent(tx, createValidTaskEventInput());
        });

        // Await notification from the second committed transaction
        const notification2 = await notificationPromise2;

        // Verify channel and exact payload for event 2 (proving rollback did not consume seq 2)
        expect(notification2.channel).toBe("project_events");
        expect(notification2.payload).toEqual({
          projectId: testProject.id,
          seq: 2,
        });

        // 4. Assert that exactly two notifications were received in total:
        // - First committed event: sequence 1
        // - Second committed event: sequence 2
        // Proves that the aborted transaction never dispatched a phantom notification
        expect(receivedNotifications).toHaveLength(2);
        expect(receivedNotifications[0]).toEqual({
          projectId: testProject.id,
          seq: 1,
        });
        expect(receivedNotifications[1]).toEqual({
          projectId: testProject.id,
          seq: 2,
        });
      } finally {
        for (const w of waiters) {
          clearTimeout(w.timer);
        }
      }
    });
  });

  describe("H. Atomicity & Notification Failure Handling", () => {
    it("aborts entire transaction if an error occurs after event insertion", async () => {
      let aborted = false;

      try {
        await testDb.transaction(async (tx) => {
          await appendProjectEvent(tx, createValidTaskEventInput());
          // Simulate downstream domain mutation failure in the same transaction
          throw new Error("Downstream domain validation failed");
        });
      } catch (err: any) {
        if (err.message === "Downstream domain validation failed") {
          aborted = true;
        }
      }

      expect(aborted).toBe(true);

      const [proj] = await testDb.select().from(projects).where(eq(projects.id, testProject.id));
      expect(proj!.lastSeq).toBe(0);

      const rows = await testDb.select().from(projectEvents);
      expect(rows).toHaveLength(0);
    });
  });
});

