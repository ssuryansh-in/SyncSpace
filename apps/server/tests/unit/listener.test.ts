import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import { PostgresListenerService } from "../../src/services/listener.js";

function createControlledPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PostgresListenerService Lifecycle & Serialization (Unit)", () => {
  it("serializes restart operations when start is requested while stop is still pending", async () => {
    let listenCount = 0;
    const unlistenControlled = createControlledPromise<void>();
    let initialUnlistenCallCount = 0;
    let restartUnlistenCallCount = 0;

    const initialHandle1 = {
      unlisten: async () => {
        initialUnlistenCallCount++;
        // Keep the stop cleanup operation pending until controlled barrier resolves
        await unlistenControlled.promise;
      },
      state: { pid: 1001 },
    };

    const initialHandle2 = {
      unlisten: async () => {
        initialUnlistenCallCount++;
      },
      state: { pid: 1001 },
    };

    const restartHandle1 = {
      unlisten: async () => {
        restartUnlistenCallCount++;
      },
      state: { pid: 2002 },
    };

    const restartHandle2 = {
      unlisten: async () => {
        restartUnlistenCallCount++;
      },
      state: { pid: 2002 },
    };

    const mockSqlClient = {
      listen: async (channel: string) => {
        listenCount++;
        if (listenCount <= 2) {
          return channel === "project_events" ? initialHandle1 : initialHandle2;
        }
        return channel === "project_events" ? restartHandle1 : restartHandle2;
      },
    } as unknown as postgres.Sql;

    const listener = new PostgresListenerService({
      sqlClient: mockSqlClient,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    // 1. Initial startup completes successfully
    await listener.start();
    expect(listener.status).toBe("ready");
    expect(listener.getInitialBackendPid()).toBe(1001);
    expect(listenCount).toBe(2);

    // 2. Initiate stop (which invokes handle.unlisten() and remains pending)
    const stopPromise = listener.stop();
    expect(initialUnlistenCallCount).toBeGreaterThan(0);

    // 3. Request start while previous stop is still cleaning up
    const restartPromise = listener.start();

    // 4. Verify restart does not overlap unsafely: new subscriptions have not been initiated yet
    expect(listenCount).toBe(2);

    // 5. Release the pending unlisten barrier to let stop complete
    unlistenControlled.resolve();

    // 6. Both stop and subsequent restart settle cleanly
    await Promise.all([stopPromise, restartPromise]);

    // 7. Verify serialized state:
    // - New subscriptions were established after stop completed (listenCount is now 4)
    // - Service is ready with new subscriptions
    // - Initial handles were unlistened
    expect(listenCount).toBe(4);
    expect(listener.status).toBe("ready");
    expect(listener.getInitialBackendPid()).toBe(2002);

    // Clean up final handles
    await listener.stop();
    expect(listener.status).toBe("stopped");
    expect(restartUnlistenCallCount).toBe(2);
  });

  it("coalesces concurrent start calls onto a single subscription attempt", async () => {
    let listenCount = 0;
    const mockSqlClient = {
      listen: async () => {
        listenCount++;
        return {
          unlisten: async () => {},
          state: { pid: 1234 },
        };
      },
    } as unknown as postgres.Sql;

    const listener = new PostgresListenerService({
      sqlClient: mockSqlClient,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await Promise.all([listener.start(), listener.start(), listener.start()]);

    expect(listener.status).toBe("ready");
    expect(listenCount).toBe(2); // exactly 1 for project_events, 1 for membership_changes
  });

  it("coalesces concurrent stop calls onto a single cleanup attempt", async () => {
    let unlistenCount = 0;
    const mockSqlClient = {
      listen: async () => {
        return {
          unlisten: async () => {
            unlistenCount++;
          },
          state: { pid: 1234 },
        };
      },
    } as unknown as postgres.Sql;

    const listener = new PostgresListenerService({
      sqlClient: mockSqlClient,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await listener.start();
    expect(listener.status).toBe("ready");

    await Promise.all([listener.stop(), listener.stop(), listener.stop()]);

    expect(listener.status).toBe("stopped");
    expect(unlistenCount).toBe(2); // exactly once per channel handle
  });

  it("aborts startup and unlistens handles when stop is requested during start", async () => {
    let unlistenCount = 0;
    const startupControlled = createControlledPromise<any>();

    const mockSqlClient = {
      listen: async (channel: string) => {
        if (channel === "project_events") {
          return {
            unlisten: async () => {
              unlistenCount++;
            },
            state: { pid: 1234 },
          };
        }
        // Channel 2 stays pending until controlled barrier resolves
        return startupControlled.promise;
      },
    } as unknown as postgres.Sql;

    const listener = new PostgresListenerService({
      sqlClient: mockSqlClient,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const startPromise = listener.start();
    expect(listener.status).toBe("starting");

    // Initiate stop while Channel 2 is still pending
    const stopPromise = listener.stop();

    // Now resolve Channel 2
    startupControlled.resolve({
      unlisten: async () => {
        unlistenCount++;
      },
      state: { pid: 1234 },
    });

    await Promise.all([startPromise, stopPromise]);

    expect(listener.status).toBe("stopped");
    expect(unlistenCount).toBe(2); // both handles were unlistened
  });

  it("cancels pending restart when stop is requested while waiting for earlier stop to finish", async () => {
    let listenCount = 0;
    const unlistenControlled = createControlledPromise<void>();
    let handle1UnlistenCount = 0;
    let handle2UnlistenCount = 0;

    const initialHandle1 = {
      unlisten: async () => {
        handle1UnlistenCount++;
        // Hold unlisten operation pending until barrier resolves
        await unlistenControlled.promise;
      },
      state: { pid: 1001 },
    };

    const initialHandle2 = {
      unlisten: async () => {
        handle2UnlistenCount++;
      },
      state: { pid: 1001 },
    };

    let freshHandle1UnlistenCount = 0;
    let freshHandle2UnlistenCount = 0;
    const freshHandle1 = {
      unlisten: async () => {
        freshHandle1UnlistenCount++;
      },
      state: { pid: 3003 },
    };
    const freshHandle2 = {
      unlisten: async () => {
        freshHandle2UnlistenCount++;
      },
      state: { pid: 3003 },
    };

    const mockSqlClient = {
      listen: async (channel: string) => {
        listenCount++;
        if (listenCount <= 2) {
          return channel === "project_events" ? initialHandle1 : initialHandle2;
        }
        return channel === "project_events" ? freshHandle1 : freshHandle2;
      },
    } as unknown as postgres.Sql;

    const listener = new PostgresListenerService({
      sqlClient: mockSqlClient,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    // 1. Start the listener successfully
    await listener.start();
    expect(listener.status).toBe("ready");
    expect(listenCount).toBe(2);

    // 2. Call stop() and hold one unlisten() operation pending using a controlled promise
    const firstStopPromise = listener.stop();
    expect(handle1UnlistenCount).toBe(1);

    // 3. Call start() while the first stop is pending
    const restartPromise = listener.start();
    expect(listenCount).toBe(2);

    // 4. Call stop() again while the restart is waiting
    const secondStopPromise = listener.stop();

    // 5. Release the original cleanup barrier
    unlistenControlled.resolve();

    // 6. Await all operations
    await Promise.all([firstStopPromise, restartPromise, secondStopPromise]);

    // 7. Verify the listener ends in stopped state
    expect(listener.status).toBe("stopped");

    // 8. Verify no new subscriptions were established for the cancelled restart
    expect(listenCount).toBe(2);

    // 9. Verify each original handle was unlistened exactly once
    expect(handle1UnlistenCount).toBe(1);
    expect(handle2UnlistenCount).toBe(1);

    // 10. Verify a subsequent fresh start() still succeeds
    await listener.start();
    expect(listener.status).toBe("ready");
    expect(listenCount).toBe(4);
    expect(listener.getInitialBackendPid()).toBe(3003);

    // Clean up
    await listener.stop();
    expect(listener.status).toBe("stopped");
    expect(freshHandle1UnlistenCount).toBe(1);
    expect(freshHandle2UnlistenCount).toBe(1);
  });

  it("serializes fresh startup behind an in-flight cancellation operation when restart promise has a chained start continuation", async () => {
    let listenCount = 0;
    const initialCleanupBarrier = createControlledPromise<void>();
    let handle1UnlistenCount = 0;
    let handle2UnlistenCount = 0;

    const initialHandle1 = {
      unlisten: async () => {
        handle1UnlistenCount++;
        // Hold cleanup operation pending until barrier resolves
        await initialCleanupBarrier.promise;
      },
      state: { pid: 1001 },
    };

    const initialHandle2 = {
      unlisten: async () => {
        handle2UnlistenCount++;
      },
      state: { pid: 1001 },
    };

    let secondStopCompleted = false;
    let freshHandlesUnlistenCount = 0;

    const freshHandle1 = {
      unlisten: async () => {
        freshHandlesUnlistenCount++;
      },
      state: { pid: 2002 },
    };

    const freshHandle2 = {
      unlisten: async () => {
        freshHandlesUnlistenCount++;
      },
      state: { pid: 2002 },
    };

    const mockSqlClient = {
      listen: async (channel: string) => {
        listenCount++;
        if (listenCount <= 2) {
          return channel === "project_events" ? initialHandle1 : initialHandle2;
        }
        // Subscriptions 3 & 4 belong to the fresh startup initiated via continuation.
        // Assert deterministically that the second stop operation had already fully completed
        // before the fresh startup was permitted to initiate new channel subscriptions.
        expect(secondStopCompleted).toBe(true);
        return channel === "project_events" ? freshHandle1 : freshHandle2;
      },
    } as unknown as postgres.Sql;

    const listener = new PostgresListenerService({
      sqlClient: mockSqlClient,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    // 1. Starts the listener
    await listener.start();
    expect(listener.status).toBe("ready");
    expect(listenCount).toBe(2);

    // 2. Initiates stop and holds cleanup pending with a controlled promise
    const firstStopPromise = listener.stop();
    expect(handle1UnlistenCount).toBe(1);

    // 3. Requests a restart
    const restartPromise = listener.start();
    expect(listenCount).toBe(2);

    // 4. Registers a .then() continuation on the restart promise that calls listener.start()
    const chainedFreshStartPromise = restartPromise.then(() => {
      return listener.start();
    });

    // 5. Requests the second stop
    const secondStopPromise = listener.stop().then(() => {
      secondStopCompleted = true;
    });

    // 6. Releases the cleanup barrier
    initialCleanupBarrier.resolve();

    // 7. Awaits the relevant operations
    await Promise.all([firstStopPromise, secondStopPromise, chainedFreshStartPromise]);

    // 8. Verifies the second stop completes without overlapping the fresh startup
    expect(secondStopCompleted).toBe(true);

    // 9. Verifies final status and active subscription handles are consistent with the operation ordering:
    // Chained fresh startup was executed after the second stop settled, ending in 'ready' state with new handles
    expect(listener.status).toBe("ready");
    expect(listenCount).toBe(4);
    expect(listener.getInitialBackendPid()).toBe(2002);
    expect(handle1UnlistenCount).toBe(1);
    expect(handle2UnlistenCount).toBe(1);

    // 10. Verifies a subsequent start/stop cycle still works
    await listener.stop();
    expect(listener.status).toBe("stopped");
    expect(freshHandlesUnlistenCount).toBe(2);

    await listener.start();
    expect(listener.status).toBe("ready");
    expect(listenCount).toBe(6);

    await listener.stop();
    expect(listener.status).toBe("stopped");
  });
});
