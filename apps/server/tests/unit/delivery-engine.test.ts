import { describe, expect, it, vi } from "vitest";
import {
  DeliveryEngine,
  type ProjectSubscriber,
} from "../../src/services/delivery.js";
import type { Database } from "../../src/db/index.js";
import { AppError } from "../../src/errors/index.js";
import type { ProjectEvent } from "../../src/db/schema/index.js";
import type { PostgresListenerService } from "../../src/services/listener.js";
import type { MembershipConsumerService } from "../../src/services/membership-consumer.js";

// ============================================================================
// Test Utilities & Mocks
// ============================================================================

function createBarrier<T = void>(timeoutMs = 5000): {
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

function createMockEvent(projectId: string, seq: number): ProjectEvent {
  return {
    id: `event-${seq}`,
    projectId,
    seq,
    eventType: "task.created",
    entityType: "task",
    entityId: "task-123",
    payload: { title: "Test Task" },
    createdAt: new Date(),
  };
}

describe("DeliveryEngine (Unit Tests - M8.3)", () => {
  it("registers first subscriber, authoritatively initializes cursor to project.lastSeq, and triggers initial drain", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            // 1st call: select project
            .mockResolvedValueOnce([
              {
                id: "proj-1",
                workspaceId: "ws-1",
                lastSeq: 42,
              },
            ])
            // 2nd call: select workspace_members
            .mockResolvedValueOnce([{ role: "member" }])
            // 3rd call in initial triggerDrain: select project_events
            .mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
        }),
      }),
    } as unknown as Database;

    const mockListener = {
      onProjectEvent: vi.fn().mockReturnValue(() => {}),
    } as unknown as PostgresListenerService;

    const engine = new DeliveryEngine({
      db: mockDb,
      listener: mockListener,
      logger: silentLogger,
    });

    const subscriber: ProjectSubscriber = {
      id: "sub-1",
      userId: "user-1",
      workspaceId: "ws-1",
      send: vi.fn(),
      close: vi.fn(),
    };

    const result = await engine.subscribeProject("proj-1", subscriber);

    expect(result.currentSeq).toBe(42);
    const state = engine.getProjectState("proj-1");
    expect(state).not.toBeNull();
    expect(state?.localLastDeliveredSeq).toBe(42);
    expect(state?.subscriberCount).toBe(1);
  });

  it("conceals nonexistent project and workspace mismatch with 404 NOT_FOUND", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValueOnce([]) // project not found
            .mockResolvedValueOnce([
              { id: "proj-1", workspaceId: "ws-real", lastSeq: 10 },
            ]), // workspace mismatch
        }),
      }),
    } as unknown as Database;

    const engine = new DeliveryEngine({
      db: mockDb,
      listener: {} as PostgresListenerService,
      logger: silentLogger,
    });

    const sub1: ProjectSubscriber = {
      id: "sub-1",
      userId: "user-1",
      workspaceId: "ws-1",
      send: vi.fn(),
      close: vi.fn(),
    };

    // Nonexistent project
    await expect(engine.subscribeProject("proj-none", sub1)).rejects.toThrow(
      AppError
    );

    // Workspace mismatch
    const sub2: ProjectSubscriber = {
      id: "sub-2",
      userId: "user-1",
      workspaceId: "ws-spoofed",
      send: vi.fn(),
      close: vi.fn(),
    };
    await expect(engine.subscribeProject("proj-1", sub2)).rejects.toThrow(
      AppError
    );
  });

  it("fans out concurrently to eligible subscribers using Promise.allSettled and isolates synchronous throws", async () => {
    const event = createMockEvent("proj-1", 43);

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            // 1st: fetch events (returns event 43)
            .mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([event]),
              }),
            })
            // 2nd: pre-dispatch membership check (both active)
            .mockResolvedValueOnce([
              { userId: "user-1", role: "member" },
              { userId: "user-2", role: "member" },
            ])
            // 3rd: next loop batch check
            .mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
        }),
      }),
    } as unknown as Database;

    const engine = new DeliveryEngine({
      db: mockDb,
      listener: {} as PostgresListenerService,
      logger: silentLogger,
    });

    // Sub 1 throws synchronously
    const sub1CloseBarrier = createBarrier();
    const sub1: ProjectSubscriber = {
      id: "sub-1",
      userId: "user-1",
      workspaceId: "ws-1",
      send: () => {
        throw new Error("Immediate synchronous failure in send()");
      },
      close: () => {
        sub1CloseBarrier.resolve();
      },
    };

    // Sub 2 succeeds asynchronously
    const sub2SendBarrier = createBarrier<ProjectEvent>();
    const sub2: ProjectSubscriber = {
      id: "sub-2",
      userId: "user-2",
      workspaceId: "ws-1",
      send: async (ev) => {
        sub2SendBarrier.resolve(ev);
      },
      close: vi.fn(),
    };

    const engineInternal = engine as unknown as {
      activeProjects: Map<
        string,
        {
          projectId: string;
          workspaceId: string;
          localLastDeliveredSeq: number;
          subscribers: Map<string, ProjectSubscriber>;
          activeDrain: Promise<void> | null;
          pendingDrain: boolean;
        }
      >;
    };

    // Register both subscribers before drain runs
    engineInternal.activeProjects.set("proj-1", {
      projectId: "proj-1",
      workspaceId: "ws-1",
      localLastDeliveredSeq: 42,
      subscribers: new Map([
        ["sub-1", sub1],
        ["sub-2", sub2],
      ]),
      activeDrain: null,
      pendingDrain: false,
    });

    engine.triggerDrain("proj-1");

    // Sub 2 must receive event despite sub 1 throwing synchronously!
    const receivedEvent = await sub2SendBarrier.promise;
    expect(receivedEvent.seq).toBe(43);

    // Sub 1 must be closed and evicted
    await sub1CloseBarrier.promise;
    const finalState = engine.getProjectState("proj-1");
    expect(finalState?.localLastDeliveredSeq).toBe(43);
    expect(finalState?.subscriberCount).toBe(1); // sub-1 evicted, sub-2 remains
  });

  it("Option A Send Timeout: evicts timed-out subscriber, ignores late resolution, and delivers to healthy subscribers", async () => {
    const event = createMockEvent("proj-1", 100);

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            // drain query
            .mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([event]),
              }),
            })
            // pre-dispatch auth
            .mockResolvedValueOnce([
              { userId: "slow-user", role: "member" },
              { userId: "fast-user", role: "member" },
            ])
            // next batch
            .mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
        }),
      }),
    } as unknown as Database;

    const engine = new DeliveryEngine({
      db: mockDb,
      listener: {} as PostgresListenerService,
      subscriberSendTimeoutMs: 50, // Short timeout for unit test
      logger: silentLogger,
    });

    const slowSubCloseBarrier = createBarrier();
    const slowSendLateResolveBarrier = createBarrier();
    let slowSendFinished = false;

    const slowSub: ProjectSubscriber = {
      id: "slow-sub",
      userId: "slow-user",
      workspaceId: "ws-1",
      send: () => {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            slowSendFinished = true;
            slowSendLateResolveBarrier.resolve();
            resolve();
          }, 150); // Exceeds 50ms timeout
        });
      },
      close: () => {
        slowSubCloseBarrier.resolve();
      },
    };

    const fastSubReceivedBarrier = createBarrier<ProjectEvent>();
    const fastSub: ProjectSubscriber = {
      id: "fast-sub",
      userId: "fast-user",
      workspaceId: "ws-1",
      send: async (ev) => {
        fastSubReceivedBarrier.resolve(ev);
      },
      close: vi.fn(),
    };

    const engineInternal = engine as unknown as {
      activeProjects: Map<
        string,
        {
          projectId: string;
          workspaceId: string;
          localLastDeliveredSeq: number;
          subscribers: Map<string, ProjectSubscriber>;
          activeDrain: Promise<void> | null;
          pendingDrain: boolean;
        }
      >;
    };

    // Both present before drain
    engineInternal.activeProjects.set("proj-1", {
      projectId: "proj-1",
      workspaceId: "ws-1",
      localLastDeliveredSeq: 99,
      subscribers: new Map([
        ["slow-sub", slowSub],
        ["fast-sub", fastSub],
      ]),
      activeDrain: null,
      pendingDrain: false,
    });

    engine.triggerDrain("proj-1");

    // Fast subscriber receives event without waiting for slow subscriber
    const receivedEvent = await fastSubReceivedBarrier.promise;
    expect(receivedEvent.seq).toBe(100);

    // Slow subscriber is evicted and closed on timeout
    await slowSubCloseBarrier.promise;
    expect(slowSendFinished).toBe(false); // Slow send has not completed yet!

    // Wait for slow subscriber to finish late
    await slowSendLateResolveBarrier.promise;
    expect(slowSendFinished).toBe(true);

    // Confirm cursor is at 100 and only fast-sub remains
    const state = engine.getProjectState("proj-1");
    expect(state?.localLastDeliveredSeq).toBe(100);
    expect(state?.subscriberCount).toBe(1);
  });

  it("Option A Send Timeout: safely handles late rejection without unhandled promise rejection", async () => {
    const event = createMockEvent("proj-1", 100);

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([event]),
              }),
            })
            .mockResolvedValueOnce([{ userId: "reject-user", role: "member" }])
            .mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([]),
              }),
            }),
        }),
      }),
    } as unknown as Database;

    const engine = new DeliveryEngine({
      db: mockDb,
      listener: {} as PostgresListenerService,
      subscriberSendTimeoutMs: 50,
      logger: silentLogger,
    });

    const closeBarrier = createBarrier();
    const lateRejectBarrier = createBarrier();

    const lateRejectSub: ProjectSubscriber = {
      id: "reject-sub",
      userId: "reject-user",
      workspaceId: "ws-1",
      send: () => {
        return new Promise<void>((_, reject) => {
          setTimeout(() => {
            lateRejectBarrier.resolve();
            reject(new Error("Late asynchronous rejection after timeout"));
          }, 150);
        });
      },
      close: () => {
        closeBarrier.resolve();
      },
    };

    const engineInternal = engine as unknown as {
      activeProjects: Map<
        string,
        {
          projectId: string;
          workspaceId: string;
          localLastDeliveredSeq: number;
          subscribers: Map<string, ProjectSubscriber>;
          activeDrain: Promise<void> | null;
          pendingDrain: boolean;
        }
      >;
    };

    engineInternal.activeProjects.set("proj-1", {
      projectId: "proj-1",
      workspaceId: "ws-1",
      localLastDeliveredSeq: 99,
      subscribers: new Map([["reject-sub", lateRejectSub]]),
      activeDrain: null,
      pendingDrain: false,
    });

    engine.triggerDrain("proj-1");

    await closeBarrier.promise;
    await lateRejectBarrier.promise;

    // Must settle without throwing unhandled rejection and clean up state
    expect(engine.getProjectState("proj-1")).toBeNull();
  });

  it("coalesces simultaneous wake-ups into a single active drain and queues pending drain", async () => {
    let selectEventsCount = 0;
    const drainReleaseBarrier = createBarrier();

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectEventsCount++;
            if (selectEventsCount === 1) {
              return {
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockImplementation(async () => {
                    await drainReleaseBarrier.promise;
                    return [createMockEvent("proj-1", 1)];
                  }),
                }),
              };
            }
            if (selectEventsCount === 2) {
              // Pre-dispatch membership check
              return Promise.resolve([{ userId: "u-1", role: "member" }]);
            }
            // Next loop check
            return {
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            };
          }),
        }),
      }),
    } as unknown as Database;

    const engine = new DeliveryEngine({
      db: mockDb,
      listener: {} as PostgresListenerService,
      logger: silentLogger,
    });

    const engineInternal = engine as unknown as {
      activeProjects: Map<
        string,
        {
          projectId: string;
          workspaceId: string;
          localLastDeliveredSeq: number;
          subscribers: Map<string, ProjectSubscriber>;
          activeDrain: Promise<void> | null;
          pendingDrain: boolean;
        }
      >;
    };

    const sub: ProjectSubscriber = {
      id: "sub-1",
      userId: "u-1",
      workspaceId: "ws-1",
      send: vi.fn(),
      close: vi.fn(),
    };

    engineInternal.activeProjects.set("proj-1", {
      projectId: "proj-1",
      workspaceId: "ws-1",
      localLastDeliveredSeq: 0,
      subscribers: new Map([["sub-1", sub]]),
      activeDrain: null,
      pendingDrain: false,
    });

    // Fire 5 concurrent triggers
    engine.triggerDrain("proj-1");
    engine.triggerDrain("proj-1");
    engine.triggerDrain("proj-1");
    engine.triggerDrain("proj-1");
    engine.triggerDrain("proj-1");

    const state = engineInternal.activeProjects.get("proj-1")!;
    expect(state.activeDrain).not.toBeNull();
    expect(state.pendingDrain).toBe(true);

    // Release the active drain
    drainReleaseBarrier.resolve();
    await state.activeDrain;

    // Verify drain settled
    expect(state.activeDrain).toBeNull();
  });

  it("single-flight polling guard skips overlapping polling executions", async () => {
    const drainSpy = vi.fn();

    const engine = new DeliveryEngine({
      db: {} as Database,
      listener: {} as PostgresListenerService,
      logger: silentLogger,
    });

    const engineInternal = engine as unknown as {
      isPolling: boolean;
      activeProjects: Map<
        string,
        {
          subscribers: Map<string, ProjectSubscriber>;
        }
      >;
      pollActiveProjects: () => Promise<void>;
      triggerDrain: (id: string) => void;
    };

    engineInternal.triggerDrain = drainSpy;
    engineInternal.activeProjects.set("proj-1", {
      subscribers: new Map([
        [
          "sub-1",
          {
            id: "sub-1",
            userId: "u1",
            workspaceId: "w1",
            send: vi.fn(),
            close: vi.fn(),
          },
        ],
      ]),
    });

    // If isPolling is true, pollActiveProjects must return immediately without calling triggerDrain
    engineInternal.isPolling = true;
    await engineInternal.pollActiveProjects();
    expect(drainSpy).not.toHaveBeenCalled();

    // When isPolling is false, it proceeds
    engineInternal.isPolling = false;
    await engineInternal.pollActiveProjects();
    expect(drainSpy).toHaveBeenCalledWith("proj-1");
  });

  it("fails closed on database authorization error: skips dispatch and leaves cursor untouched without evicting subscribers", async () => {
    const event = createMockEvent("proj-1", 10);

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([event]),
              }),
            })
            // Pre-dispatch query throws database error
            .mockRejectedValueOnce(new Error("Transient connection error")),
        }),
      }),
    } as unknown as Database;

    const engine = new DeliveryEngine({
      db: mockDb,
      listener: {} as PostgresListenerService,
      logger: silentLogger,
    });

    const subCloseSpy = vi.fn();
    const subSendSpy = vi.fn();
    const sub: ProjectSubscriber = {
      id: "sub-1",
      userId: "u-1",
      workspaceId: "ws-1",
      send: subSendSpy,
      close: subCloseSpy,
    };

    const engineInternal = engine as unknown as {
      activeProjects: Map<
        string,
        {
          projectId: string;
          workspaceId: string;
          localLastDeliveredSeq: number;
          subscribers: Map<string, ProjectSubscriber>;
          activeDrain: Promise<void> | null;
          pendingDrain: boolean;
        }
      >;
    };

    engineInternal.activeProjects.set("proj-1", {
      projectId: "proj-1",
      workspaceId: "ws-1",
      localLastDeliveredSeq: 9,
      subscribers: new Map([["sub-1", sub]]),
      activeDrain: null,
      pendingDrain: false,
    });

    engine.triggerDrain("proj-1");
    await engineInternal.activeProjects.get("proj-1")!.activeDrain;

    // Send was not called, sub was not evicted, cursor remains at 9
    expect(subSendSpy).not.toHaveBeenCalled();
    expect(subCloseSpy).not.toHaveBeenCalled();
    const state = engine.getProjectState("proj-1");
    expect(state?.localLastDeliveredSeq).toBe(9);
    expect(state?.subscriberCount).toBe(1);
  });

  it("evicts subscriber when confirmed absent in PostgreSQL workspace_members", async () => {
    const event = createMockEvent("proj-1", 10);

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([event]),
              }),
            })
            // Returns empty array -> user is absent
            .mockResolvedValueOnce([]),
        }),
      }),
    } as unknown as Database;

    const engine = new DeliveryEngine({
      db: mockDb,
      listener: {} as PostgresListenerService,
      logger: silentLogger,
    });

    const subCloseSpy = vi.fn();
    const subSendSpy = vi.fn();
    const sub: ProjectSubscriber = {
      id: "sub-1",
      userId: "u-1",
      workspaceId: "ws-1",
      send: subSendSpy,
      close: subCloseSpy,
    };

    const engineInternal = engine as unknown as {
      activeProjects: Map<
        string,
        {
          projectId: string;
          workspaceId: string;
          localLastDeliveredSeq: number;
          subscribers: Map<string, ProjectSubscriber>;
          activeDrain: Promise<void> | null;
          pendingDrain: boolean;
        }
      >;
    };

    engineInternal.activeProjects.set("proj-1", {
      projectId: "proj-1",
      workspaceId: "ws-1",
      localLastDeliveredSeq: 9,
      subscribers: new Map([["sub-1", sub]]),
      activeDrain: null,
      pendingDrain: false,
    });

    engine.triggerDrain("proj-1");
    await engineInternal.activeProjects.get("proj-1")!.activeDrain;

    // Sub was evicted and closed, event was not delivered
    expect(subSendSpy).not.toHaveBeenCalled();
    expect(subCloseSpy).toHaveBeenCalledTimes(1);
    expect(engine.getProjectState("proj-1")).toBeNull(); // Cleaned up because 0 subs remain
  });

  it("revocation event from MembershipConsumerService evicts matching subscribers across workspace projects and isolates other workspaces", () => {
    let consumerCallback!: (event: {
      type: "revoked";
      workspaceId: string;
      userId: string;
    }) => void;

    const mockConsumer = {
      onEvent: vi.fn().mockImplementation((cb) => {
        consumerCallback = cb;
        return () => {};
      }),
    } as unknown as MembershipConsumerService;

    const mockListener = {
      onProjectEvent: vi.fn().mockReturnValue(() => {}),
    } as unknown as PostgresListenerService;

    const engine = new DeliveryEngine({
      db: {} as Database,
      listener: mockListener,
      membershipConsumer: mockConsumer,
      logger: silentLogger,
    });

    engine.start();

    const sub1CloseSpy = vi.fn();
    const sub2CloseSpy = vi.fn();
    const sub3CloseSpy = vi.fn();

    const sub1: ProjectSubscriber = {
      id: "sub-1",
      userId: "user-target",
      workspaceId: "ws-1",
      send: vi.fn(),
      close: sub1CloseSpy,
    };

    const sub2: ProjectSubscriber = {
      id: "sub-2",
      userId: "user-other",
      workspaceId: "ws-1",
      send: vi.fn(),
      close: sub2CloseSpy,
    };

    const sub3: ProjectSubscriber = {
      id: "sub-3",
      userId: "user-target",
      workspaceId: "ws-2", // Different workspace!
      send: vi.fn(),
      close: sub3CloseSpy,
    };

    const engineInternal = engine as unknown as {
      activeProjects: Map<
        string,
        {
          projectId: string;
          workspaceId: string;
          localLastDeliveredSeq: number;
          subscribers: Map<string, ProjectSubscriber>;
          activeDrain: Promise<void> | null;
          pendingDrain: boolean;
        }
      >;
    };

    engineInternal.activeProjects.set("proj-1", {
      projectId: "proj-1",
      workspaceId: "ws-1",
      localLastDeliveredSeq: 0,
      subscribers: new Map([
        ["sub-1", sub1],
        ["sub-2", sub2],
      ]),
      activeDrain: null,
      pendingDrain: false,
    });

    engineInternal.activeProjects.set("proj-2", {
      projectId: "proj-2",
      workspaceId: "ws-2",
      localLastDeliveredSeq: 0,
      subscribers: new Map([["sub-3", sub3]]),
      activeDrain: null,
      pendingDrain: false,
    });

    // Revoke user-target in ws-1
    consumerCallback({
      type: "revoked",
      workspaceId: "ws-1",
      userId: "user-target",
    });

    // sub-1 in ws-1 evicted and closed
    expect(sub1CloseSpy).toHaveBeenCalledTimes(1);
    // sub-2 in ws-1 unaffected
    expect(sub2CloseSpy).not.toHaveBeenCalled();
    // sub-3 in ws-2 completely isolated and unaffected!
    expect(sub3CloseSpy).not.toHaveBeenCalled();

    const p1State = engine.getProjectState("proj-1");
    expect(p1State?.subscriberCount).toBe(1);
    const p2State = engine.getProjectState("proj-2");
    expect(p2State?.subscriberCount).toBe(1);
  });

  it("graceful shutdown: prevents new subscriber sends, stops polling, awaits active drains, and closes subscribers on timeout", async () => {
    const sendStartedBarrier = createBarrier();
    const drainBlockedBarrier = createBarrier();
    let unblockedSendCompleted = false;

    const subCloseSpy = vi.fn();
    const hangingSub: ProjectSubscriber = {
      id: "hang-sub",
      userId: "u-1",
      workspaceId: "ws-1",
      send: async () => {
        sendStartedBarrier.resolve();
        // Block until test releases
        await drainBlockedBarrier.promise;
        unblockedSendCompleted = true;
      },
      close: subCloseSpy,
    };

    const event = createMockEvent("proj-1", 1);
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([event]),
              }),
            })
            .mockResolvedValueOnce([{ userId: "u-1", role: "member" }]),
        }),
      }),
    } as unknown as Database;

    const engine = new DeliveryEngine({
      db: mockDb,
      listener: { onProjectEvent: vi.fn().mockReturnValue(() => {}) } as unknown as PostgresListenerService,
      shutdownTimeoutMs: 50, // Short timeout for test
      logger: silentLogger,
    });

    const engineInternal = engine as unknown as {
      activeProjects: Map<
        string,
        {
          projectId: string;
          workspaceId: string;
          localLastDeliveredSeq: number;
          subscribers: Map<string, ProjectSubscriber>;
          activeDrain: Promise<void> | null;
          pendingDrain: boolean;
        }
      >;
    };

    engineInternal.activeProjects.set("proj-1", {
      projectId: "proj-1",
      workspaceId: "ws-1",
      localLastDeliveredSeq: 0,
      subscribers: new Map([["hang-sub", hangingSub]]),
      activeDrain: null,
      pendingDrain: false,
    });

    // Start draining event
    engine.triggerDrain("proj-1");

    // Wait until send has actively started
    await sendStartedBarrier.promise;

    // Initiate stop() while send is hanging
    const stopPromise = engine.stop();

    // Await stop() to finish via timeout (50ms)
    await stopPromise;

    // Confirm that subscriber close was invoked upon timeout
    expect(subCloseSpy).toHaveBeenCalledTimes(1);
    expect(engine.getActiveProjectsCount()).toBe(0);

    // Release the blocked send
    drainBlockedBarrier.resolve();
    // Allow macro task tick for async send to finish
    await new Promise((r) => setTimeout(r, 20));

    // Confirm send resolved, but did not corrupt state or trigger new dispatch
    expect(unblockedSendCompleted).toBe(true);
    expect(engine.getActiveProjectsCount()).toBe(0);
  });

  it("per-subscriber shutdown protection: stops send loop if subscriber initiates shutdown and leaves cursor unchanged", async () => {
    let stopPromise: Promise<void> | null = null;
    let sub1SendCalled = false;
    let sub2SendCalled = false;
    let cursorAtClose: number | undefined;

    const sub1: ProjectSubscriber = {
      id: "sub-1",
      userId: "u-1",
      workspaceId: "ws-1",
      send: () => {
        sub1SendCalled = true;
        // Synchronously initiate engine shutdown
        stopPromise = engine.stop();
      },
      close: vi.fn(() => {
        cursorAtClose = engineInternal.activeProjects.get("proj-1")?.localLastDeliveredSeq;
      }),
    };

    const sub2: ProjectSubscriber = {
      id: "sub-2",
      userId: "u-2",
      workspaceId: "ws-1",
      send: () => {
        sub2SendCalled = true;
      },
      close: vi.fn(),
    };

    const event = createMockEvent("proj-1", 1);
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValueOnce({
              orderBy: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([event]),
              }),
            })
            .mockResolvedValueOnce([
              { userId: "u-1", role: "member" },
              { userId: "u-2", role: "member" },
            ]),
        }),
      }),
    } as unknown as Database;

    const engine = new DeliveryEngine({
      db: mockDb,
      listener: { onProjectEvent: vi.fn().mockReturnValue(() => {}) } as unknown as PostgresListenerService,
      logger: silentLogger,
    });

    const engineInternal = engine as unknown as {
      activeProjects: Map<
        string,
        {
          projectId: string;
          workspaceId: string;
          localLastDeliveredSeq: number;
          subscribers: Map<string, ProjectSubscriber>;
          activeDrain: Promise<void> | null;
          pendingDrain: boolean;
        }
      >;
    };

    engineInternal.activeProjects.set("proj-1", {
      projectId: "proj-1",
      workspaceId: "ws-1",
      localLastDeliveredSeq: 0,
      subscribers: new Map([
        ["sub-1", sub1],
        ["sub-2", sub2],
      ]),
      activeDrain: null,
      pendingDrain: false,
    });

    // Start draining event
    engine.triggerDrain("proj-1");

    // Allow synchronous map and stopPromise to settle
    await new Promise((r) => setTimeout(r, 30));
    if (stopPromise) {
      await stopPromise;
    }

    // sub-1 was invoked
    expect(sub1SendCalled).toBe(true);
    // sub-2 was NEVER invoked because shutdown started before its send
    expect(sub2SendCalled).toBe(false);

    // Verify cursor did not advance after shutdown began
    expect(cursorAtClose).toBe(0);

    // Both subscribers closed cleanly upon shutdown
    expect(sub1.close).toHaveBeenCalledTimes(1);
    expect(sub2.close).toHaveBeenCalledTimes(1);

    // Shutdown completed cleanly
    expect(engine.isRunning()).toBe(false);
    expect(engine.getActiveProjectsCount()).toBe(0);
  });

  it("clears shutdown timeout when active drains complete quickly", async () => {
    vi.useFakeTimers();
    try {
      const mockDb = {
        select: vi.fn(),
      } as unknown as Database;

      const engine = new DeliveryEngine({
        db: mockDb,
        listener: { onProjectEvent: vi.fn().mockReturnValue(() => {}) } as unknown as PostgresListenerService,
        shutdownTimeoutMs: 5000,
        logger: silentLogger,
      });

      const engineInternal = engine as unknown as {
        activeProjects: Map<
          string,
          {
            projectId: string;
            workspaceId: string;
            localLastDeliveredSeq: number;
            subscribers: Map<string, ProjectSubscriber>;
            activeDrain: Promise<void> | null;
            pendingDrain: boolean;
          }
        >;
      };

      // An active drain that settles quickly (e.g. 50ms)
      let drainResolved = false;
      const activeDrainPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          drainResolved = true;
          resolve();
        }, 50);
      });

      engineInternal.activeProjects.set("proj-1", {
        projectId: "proj-1",
        workspaceId: "ws-1",
        localLastDeliveredSeq: 0,
        subscribers: new Map(),
        activeDrain: activeDrainPromise,
        pendingDrain: false,
      });

      const stopPromise = engine.stop();

      // Advance timers by 50ms to allow activeDrainPromise to resolve
      await vi.advanceTimersByTimeAsync(50);
      await stopPromise;

      expect(drainResolved).toBe(true);
      expect(engine.isRunning()).toBe(false);

      // Verify that no pending shutdown timeout (5000ms timer) remains
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
