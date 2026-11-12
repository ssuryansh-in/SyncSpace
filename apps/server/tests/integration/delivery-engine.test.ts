import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import type { Database } from "../../src/db/index.js";
import {
  cleanTables,
  testDb,
  validateTestDatabaseUrl,
} from "./setup.js";
import { PostgresListenerService } from "../../src/services/listener.js";
import { MembershipConsumerService } from "../../src/services/membership-consumer.js";
import {
  DeliveryEngine,
  type ProjectSubscriber,
} from "../../src/services/delivery.js";
import { ProjectService } from "../../src/services/project.js";
import { WorkspaceService } from "../../src/services/workspace.js";
import {
  users,
  workspaceMembers,
  type ProjectEvent,
} from "../../src/db/schema/index.js";

// ============================================================================
// Deterministic Synchronization Barrier
// ============================================================================

function createBarrier<T = void>(timeoutMs = 10000): {
  promise: Promise<T>;
  resolve: (val: T) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (val: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => {
    reject(new Error(`Barrier timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    promise: promise.finally(() => clearTimeout(timer)),
    resolve,
    reject,
  };
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("DeliveryEngine (Integration - M8.3)", () => {
  let testUrl: string;
  let activeClients: postgres.Sql[] = [];
  let activeListeners: PostgresListenerService[] = [];
  let activeConsumers: MembershipConsumerService[] = [];
  let activeEngines: DeliveryEngine[] = [];

  beforeEach(async () => {
    testUrl = validateTestDatabaseUrl();
    await cleanTables();
  });

  afterEach(async () => {
    for (const engine of activeEngines) {
      await engine.stop().catch(() => {});
    }
    activeEngines = [];

    for (const consumer of activeConsumers) {
      await consumer.stop().catch(() => {});
    }
    activeConsumers = [];

    for (const listener of activeListeners) {
      await listener.stop().catch(() => {});
    }
    activeListeners = [];

    for (const client of activeClients) {
      await client.end({ timeout: 2 }).catch(() => {});
    }
    activeClients = [];
  });

  function createTestListener(): {
    listener: PostgresListenerService;
    client: postgres.Sql;
  } {
    const client = postgres(testUrl, { max: 1 });
    activeClients.push(client);
    const listener = new PostgresListenerService({
      sqlClient: client,
      logger: silentLogger,
    });
    activeListeners.push(listener);
    return { listener, client };
  }

  function createTestConsumer(
    listener: PostgresListenerService,
    db: Database = testDb
  ): MembershipConsumerService {
    const consumer = new MembershipConsumerService({
      db,
      listener,
      logger: silentLogger,
    });
    activeConsumers.push(consumer);
    return consumer;
  }

  function createTestEngine(
    listener: PostgresListenerService,
    consumer?: MembershipConsumerService,
    options: {
      pollingIntervalMs?: number;
      subscriberSendTimeoutMs?: number;
      batchSize?: number;
    } = {}
  ): DeliveryEngine {
    const engine = new DeliveryEngine({
      db: testDb,
      listener,
      membershipConsumer: consumer,
      pollingIntervalMs: options.pollingIntervalMs ?? 100, // Fast polling for tests
      subscriberSendTimeoutMs: options.subscriberSendTimeoutMs ?? 2000,
      batchSize: options.batchSize ?? 100,
      logger: silentLogger,
    });
    activeEngines.push(engine);
    return engine;
  }

  async function createTestUser(email = "user@example.com", name = "Test User") {
    const [user] = await testDb
      .insert(users)
      .values({
        email,
        displayName: name,
        emailVerified: true,
      })
      .returning();
    return user!;
  }

  async function createTestWorkspace(ownerId: string, name = "Test WS") {
    const res = await WorkspaceService.createWorkspace(testDb, { name, ownerId });
    return res.workspace;
  }

  async function createTestProject(workspaceId: string, ownerId: string, name = "Test Project") {
    const res = await ProjectService.createProject(testDb, {
      workspaceId,
      callerId: ownerId,
      name,
    });
    return res.project;
  }

  it("Live Notification Dispatch: delivers committed event in real-time over listener wake-up", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const consumer = createTestConsumer(listener);
    consumer.start();

    const engine = createTestEngine(listener, consumer);
    engine.start();

    const owner = await createTestUser("owner1@example.com");
    const ws = await createTestWorkspace(owner.id);
    const project = await createTestProject(ws.id, owner.id);

    const eventBarrier = createBarrier<ProjectEvent>();
    const subscriber: ProjectSubscriber = {
      id: "sub-1",
      userId: owner.id,
      workspaceId: ws.id,
      send: (ev) => {
        eventBarrier.resolve(ev);
      },
      close: vi.fn(),
    };

    await engine.subscribeProject(project.id, subscriber);

    // Commit an event using ProjectService.renameProject
    await ProjectService.renameProject(testDb, {
      projectId: project.id,
      callerId: owner.id,
      name: "Renamed Project",
    });

    const receivedEvent = await eventBarrier.promise;
    expect(receivedEvent.projectId).toBe(project.id);
    expect(receivedEvent.seq).toBe(1);
    expect(receivedEvent.eventType).toBe("project.updated");

    await vi.waitFor(() => {
      const state = engine.getProjectState(project.id);
      expect(state?.localLastDeliveredSeq).toBe(1);
    });
  });

  it("More than 100 Pending Events: dispatches 150 events in strictly ascending sequence order", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const engine = createTestEngine(listener, undefined, { batchSize: 50 }); // Force multi-batch drain
    engine.start();

    const owner = await createTestUser("owner-batch@example.com");
    const ws = await createTestWorkspace(owner.id);
    const project = await createTestProject(ws.id, owner.id);

    // Seed 150 events
    const totalEvents = 150;
    for (let i = 1; i <= totalEvents; i++) {
      await ProjectService.renameProject(testDb, {
        projectId: project.id,
        callerId: owner.id,
        name: `Project Iteration ${i}`,
      });
    }

    const receivedEvents: ProjectEvent[] = [];
    const allEventsBarrier = createBarrier<void>();

    const subscriber: ProjectSubscriber = {
      id: "batch-sub",
      userId: owner.id,
      workspaceId: ws.id,
      send: (ev) => {
        receivedEvents.push(ev);
        if (receivedEvents.length === totalEvents) {
          allEventsBarrier.resolve();
        }
      },
      close: vi.fn(),
    };

    const engineInternal = engine as unknown as {
      activeProjects: Map<
        string,
        {
          localLastDeliveredSeq: number;
        }
      >;
    };

    await engine.subscribeProject(project.id, subscriber);
    // Reset localLastDeliveredSeq to 0 to simulate instance starting with a large backlog
    engineInternal.activeProjects.get(project.id)!.localLastDeliveredSeq = 0;
    engine.triggerDrain(project.id);

    await allEventsBarrier.promise;

    expect(receivedEvents).toHaveLength(totalEvents);
    for (let i = 0; i < totalEvents; i++) {
      expect(receivedEvents[i]!.seq).toBe(i + 1);
    }

    await vi.waitFor(() => {
      const state = engine.getProjectState(project.id);
      expect(state?.localLastDeliveredSeq).toBe(totalEvents);
    });
  });

  it("Missed Notification Recovery: recovers events on next polling cycle when listener is silenced", async () => {
    const { listener } = createTestListener();
    await listener.start();

    // Create engine with fast polling (100ms)
    const engine = createTestEngine(listener, undefined, { pollingIntervalMs: 100 });
    engine.start();

    const owner = await createTestUser("owner-poll@example.com");
    const ws = await createTestWorkspace(owner.id);
    const project = await createTestProject(ws.id, owner.id);

    const pollingReceivedBarrier = createBarrier<ProjectEvent>();
    const subscriber: ProjectSubscriber = {
      id: "poll-sub",
      userId: owner.id,
      workspaceId: ws.id,
      send: (ev) => {
        pollingReceivedBarrier.resolve(ev);
      },
      close: vi.fn(),
    };

    await engine.subscribeProject(project.id, subscriber);

    // Silence the listener callback
    const engineInternal = engine as unknown as {
      unsubscribeListener: (() => void) | null;
    };
    if (engineInternal.unsubscribeListener) {
      engineInternal.unsubscribeListener();
      engineInternal.unsubscribeListener = null;
    }

    // Commit an event in PostgreSQL without listener delivery
    await ProjectService.renameProject(testDb, {
      projectId: project.id,
      callerId: owner.id,
      name: "Silent Commit",
    });

    // The single-flight polling fallback must discover the event on its next tick
    const recoveredEvent = await pollingReceivedBarrier.promise;
    expect(recoveredEvent.projectId).toBe(project.id);
    expect(recoveredEvent.seq).toBe(1);
  });

  it("Pre-Dispatch Membership Revocation: blocks delivery and evicts subscriber when removed in DB", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const engine = createTestEngine(listener);
    engine.start();

    const owner = await createTestUser("owner-rev@example.com");
    const member = await createTestUser("member-rev@example.com");
    const ws = await createTestWorkspace(owner.id);
    const project = await createTestProject(ws.id, owner.id);

    // Add member to workspace
    await testDb.insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: member.id,
      role: "member",
    });

    const subCloseBarrier = createBarrier();
    const subSendSpy = vi.fn();
    const subscriber: ProjectSubscriber = {
      id: "revoked-sub",
      userId: member.id,
      workspaceId: ws.id,
      send: subSendSpy,
      close: () => {
        subCloseBarrier.resolve();
      },
    };

    await engine.subscribeProject(project.id, subscriber);

    // Delete membership from database directly before commit of event
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.userId, member.id));

    // Commit project event
    await ProjectService.renameProject(testDb, {
      projectId: project.id,
      callerId: owner.id,
      name: "Revocation Trigger Event",
    });

    // Pre-dispatch authorization gate must detect absence, evict and close subscriber, and NOT send data
    await subCloseBarrier.promise;
    expect(subSendSpy).not.toHaveBeenCalled();
    expect(engine.getProjectState(project.id)).toBeNull(); // Cleaned up as 0 subscribers remain
  });

  it("Multiple Projects Isolation: strictly isolates events between different projects", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const engine = createTestEngine(listener);
    engine.start();

    const owner = await createTestUser("owner-multi@example.com");
    const ws = await createTestWorkspace(owner.id);
    const projectA = await createTestProject(ws.id, owner.id, "Project A");
    const projectB = await createTestProject(ws.id, owner.id, "Project B");

    const pAEvents: ProjectEvent[] = [];
    const pBEvents: ProjectEvent[] = [];

    const subABarrier = createBarrier<void>();
    const subBBarrier = createBarrier<void>();

    const subA: ProjectSubscriber = {
      id: "sub-A",
      userId: owner.id,
      workspaceId: ws.id,
      send: (ev) => {
        pAEvents.push(ev);
        subABarrier.resolve();
      },
      close: vi.fn(),
    };

    const subB: ProjectSubscriber = {
      id: "sub-B",
      userId: owner.id,
      workspaceId: ws.id,
      send: (ev) => {
        pBEvents.push(ev);
        subBBarrier.resolve();
      },
      close: vi.fn(),
    };

    await engine.subscribeProject(projectA.id, subA);
    await engine.subscribeProject(projectB.id, subB);

    // Commit an event on Project A
    await ProjectService.renameProject(testDb, {
      projectId: projectA.id,
      callerId: owner.id,
      name: "Project A Updated",
    });

    // Commit an event on Project B
    await ProjectService.renameProject(testDb, {
      projectId: projectB.id,
      callerId: owner.id,
      name: "Project B Updated",
    });

    await Promise.all([subABarrier.promise, subBBarrier.promise]);

    expect(pAEvents).toHaveLength(1);
    expect(pAEvents[0]!.projectId).toBe(projectA.id);

    expect(pBEvents).toHaveLength(1);
    expect(pBEvents[0]!.projectId).toBe(projectB.id);
  });

  it("Event Committed During Active Drain: coalesced pending drain delivers subsequent event in order", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const engine = createTestEngine(listener);
    engine.start();

    const owner = await createTestUser("owner-coalesce@example.com");
    const ws = await createTestWorkspace(owner.id);
    const project = await createTestProject(ws.id, owner.id);

    const receivedSeqs: number[] = [];
    const event2Barrier = createBarrier<void>();
    const event1SendStarted = createBarrier<void>();
    const event1AllowFinish = createBarrier<void>();

    const subscriber: ProjectSubscriber = {
      id: "coalesce-sub",
      userId: owner.id,
      workspaceId: ws.id,
      send: async (ev) => {
        receivedSeqs.push(ev.seq);
        if (ev.seq === 1) {
          event1SendStarted.resolve();
          // Hold event 1 delivery until test commits event 2
          await event1AllowFinish.promise;
        } else if (ev.seq === 2) {
          event2Barrier.resolve();
        }
      },
      close: vi.fn(),
    };

    await engine.subscribeProject(project.id, subscriber);

    // Commit Event 1
    await ProjectService.renameProject(testDb, {
      projectId: project.id,
      callerId: owner.id,
      name: "Coalesce Step 1",
    });

    // Wait until Event 1 is being sent
    await event1SendStarted.promise;

    // While Event 1 is actively being sent, commit Event 2 in PostgreSQL
    await ProjectService.renameProject(testDb, {
      projectId: project.id,
      callerId: owner.id,
      name: "Coalesce Step 2",
    });

    // Allow Event 1 to complete
    event1AllowFinish.resolve();

    // Event 2 must be processed by the coalesced pending drain
    await event2Barrier.promise;

    expect(receivedSeqs).toEqual([1, 2]);
    await vi.waitFor(() => {
      const state = engine.getProjectState(project.id);
      expect(state?.localLastDeliveredSeq).toBe(2);
    });
  });

  it("Shutdown during active drain: ceases new subscriber sends, stops polling, and closes subscribers cleanly", async () => {
    const { listener } = createTestListener();
    await listener.start();

    const engine = createTestEngine(listener, undefined, { shutdownTimeoutMs: 500 });
    engine.start();

    const owner = await createTestUser("owner-shut@example.com");
    const ws = await createTestWorkspace(owner.id);
    const project = await createTestProject(ws.id, owner.id);

    const sendStarted = createBarrier<void>();
    const sendCanFinish = createBarrier<void>();
    const subCloseBarrier = createBarrier<void>();

    const subscriber: ProjectSubscriber = {
      id: "shut-sub",
      userId: owner.id,
      workspaceId: ws.id,
      send: async () => {
        sendStarted.resolve();
        await sendCanFinish.promise;
      },
      close: () => {
        subCloseBarrier.resolve();
      },
    };

    await engine.subscribeProject(project.id, subscriber);

    // Commit Event
    await ProjectService.renameProject(testDb, {
      projectId: project.id,
      callerId: owner.id,
      name: "Shutdown Test Event",
    });

    await sendStarted.promise;

    // Trigger stop() while send is active
    const stopPromise = engine.stop();

    // Release send
    sendCanFinish.resolve();

    await stopPromise;
    await subCloseBarrier.promise;

    expect(engine.isRunning()).toBe(false);
    expect(engine.getActiveProjectsCount()).toBe(0);
  });
});
