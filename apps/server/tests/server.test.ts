import { describe, expect, it } from "vitest";
import { startServer, type ServerHandle } from "../src/server.js";
import { createApp } from "../src/app.js";

describe("HTTP Server Lifecycle & Graceful Shutdown", () => {
  it("starts successfully on an ephemeral port and responds to real HTTP requests", async () => {
    const handle: ServerHandle = await startServer({
      config: {
        NODE_ENV: "test",
        PORT: 0, // Ephemeral port assigned by OS
        HOST: "127.0.0.1",
      },
      registerSignalHandlers: false,
    });

    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.host).toBe("127.0.0.1");

      const response = await fetch(`http://${handle.host}:${handle.port}/health`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe("ok");
    } finally {
      await handle.stop();
    }
  });

  it("handles repeated shutdown requests idempotently without throwing", async () => {
    const handle = await startServer({
      config: {
        NODE_ENV: "test",
        PORT: 0,
        HOST: "127.0.0.1",
      },
      registerSignalHandlers: false,
    });

    // First stop call
    await expect(handle.stop()).resolves.toBeUndefined();

    // Second repeated stop call
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("handles port conflicts predictably by rejecting startup", async () => {
    // 1. Start primary server on an ephemeral port
    const primary = await startServer({
      config: {
        NODE_ENV: "test",
        PORT: 0,
        HOST: "127.0.0.1",
      },
      registerSignalHandlers: false,
    });

    try {
      const boundPort = primary.port;

      // 2. Attempt to bind a second server to the identical host and port
      await expect(
        startServer({
          config: {
            NODE_ENV: "test",
            PORT: boundPort,
            HOST: "127.0.0.1",
          },
          registerSignalHandlers: false,
        })
      ).rejects.toThrow();
    } finally {
      await primary.stop();
    }
  });

  it("enforces bounded shutdown when an active request remains in-flight", async () => {
    // Create an app instance with a long-running route
    const testApp = createApp({
      config: {
        NODE_ENV: "test",
        PORT: 0,
        HOST: "127.0.0.1",
      },
    });

    testApp.get("/hang", async () => {
      // Simulate an unyielding operation lasting 2,000ms
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return new Response("finished");
    });

    const shutdownTimeoutMs = 150;
    const handle = await startServer({
      app: testApp,
      config: {
        NODE_ENV: "test",
        PORT: 0,
        HOST: "127.0.0.1",
      },
      shutdownTimeoutMs,
      registerSignalHandlers: false,
    });

    // Initiate in-flight request without awaiting its response
    const fetchPromise = fetch(`http://${handle.host}:${handle.port}/hang`).catch(
      () => {
        // Expected to abort when connection is force-closed
      }
    );

    // Give a brief moment for the TCP connection to establish and request to hit the server
    await new Promise((resolve) => setTimeout(resolve, 30));

    const shutdownStart = Date.now();
    await handle.stop();
    const shutdownDuration = Date.now() - shutdownStart;

    // Await fetch promise rejection/settlement
    await fetchPromise;

    // Shutdown must complete bounded around the deadline (150ms), well before the 2,000ms route finishes
    expect(shutdownDuration).toBeGreaterThanOrEqual(shutdownTimeoutMs - 50);
    expect(shutdownDuration).toBeLessThan(1000);
  });

  it("stops accepting new requests once shutdown completes", async () => {
    const handle = await startServer({
      config: {
        NODE_ENV: "test",
        PORT: 0,
        HOST: "127.0.0.1",
      },
      registerSignalHandlers: false,
    });

    const url = `http://${handle.host}:${handle.port}/health`;
    await handle.stop();

    // Subsequent requests must fail to connect
    await expect(fetch(url)).rejects.toThrow();
  });
});

