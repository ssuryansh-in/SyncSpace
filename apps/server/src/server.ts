import { serve } from "@hono/node-server";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import { loadEnv, type EnvConfig } from "./config/env.js";
import { closeDb } from "./db/index.js";

export interface StartServerOptions {
  config?: Partial<EnvConfig>;
  shutdownTimeoutMs?: number;
  registerSignalHandlers?: boolean;
  app?: Hono;
}

export interface ServerHandle {
  host: string;
  port: number;
  stop: () => Promise<void>;
}

/**
 * Starts the Hono application using @hono/node-server in a persistent Node.js process.
 *
 * @param options Configuration overrides, optional custom app, and lifecycle options
 * @returns ServerHandle containing the bound address and an idempotent stop function
 */
export async function startServer(
  options: StartServerOptions = {}
): Promise<ServerHandle> {
  const env: EnvConfig = {
    ...loadEnv(),
    ...options.config,
  };

  let isShuttingDown = false;

  const app =
    options.app ??
    createApp({
      config: env,
      isShuttingDown: () => isShuttingDown,
    });
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
  const registerSignals = options.registerSignalHandlers ?? false;

  return new Promise<ServerHandle>((resolve, reject) => {
    let isStarted = false;

    // Start network server using @hono/node-server
    const nodeServer = serve({
      fetch: app.fetch,
      port: env.PORT,
      hostname: env.HOST,
    });

    // Cleanup listeners and reject if startup encounters an error (e.g. EADDRINUSE)
    const onStartupError = (err: Error) => {
      if (!isStarted) {
        nodeServer.off("listening", onListening);
        reject(err);
      }
    };

    const onListening = () => {
      isStarted = true;
      nodeServer.off("error", onStartupError);

      const address = nodeServer.address();
      let boundPort = env.PORT;
      let boundHost = env.HOST;

      if (address && typeof address === "object") {
        const addrInfo = address as AddressInfo;
        boundPort = addrInfo.port;
        boundHost = addrInfo.address;
      }

      let shutdownPromise: Promise<void> | null = null;

      // Bounded graceful shutdown sequence
      const stop = async (): Promise<void> => {
        if (isShuttingDown && shutdownPromise) {
          return shutdownPromise;
        }

        isShuttingDown = true;

        shutdownPromise = (async () => {
          // 1. Drain and close HTTP server connections
          await new Promise<void>((resolveShutdown, rejectShutdown) => {
            let forceCloseTimer: NodeJS.Timeout | null = null;

            // Stop accepting new connections
            nodeServer.close((closeErr) => {
              if (forceCloseTimer) {
                clearTimeout(forceCloseTimer);
              }
              if (closeErr) {
                rejectShutdown(closeErr);
              } else {
                resolveShutdown();
              }
            });

            // Close idle keep-alive connections immediately
            if (
              "closeIdleConnections" in nodeServer &&
              typeof (nodeServer as { closeIdleConnections?: () => void }).closeIdleConnections === "function"
            ) {
              (nodeServer as { closeIdleConnections: () => void }).closeIdleConnections();
            }

            // Force-close in-flight connections that exceed the shutdown timeout boundary
            forceCloseTimer = setTimeout(() => {
              if (
                "closeAllConnections" in nodeServer &&
                typeof (nodeServer as { closeAllConnections?: () => void }).closeAllConnections === "function"
              ) {
                (nodeServer as { closeAllConnections: () => void }).closeAllConnections();
              }
            }, shutdownTimeoutMs);

            // Allow event loop to exit naturally if all connections drain before timer
            if (typeof forceCloseTimer.unref === "function") {
              forceCloseTimer.unref();
            }
          });

          // 2. Close database connection pool with bounded timeout (2s)
          await closeDb();

          // Remove signal handlers upon shutdown completion if they were registered
          if (registerSignals) {
            process.off("SIGINT", onSigint);
            process.off("SIGTERM", onSigterm);
          }
        })();

        return shutdownPromise;
      };

      const onSigint = async () => {
        try {
          await stop();
        } catch {
          process.exit(1);
        }
      };

      const onSigterm = async () => {
        try {
          await stop();
        } catch {
          process.exit(1);
        }
      };

      if (registerSignals) {
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);
      }

      resolve({
        host: boundHost,
        port: boundPort,
        stop,
      });
    };

    nodeServer.once("error", onStartupError);
    nodeServer.once("listening", onListening);
  });
}

// Direct execution entry point
const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const env = loadEnv();
  startServer({
    config: env,
    registerSignalHandlers: true,
  })
    .then((handle) => {
      console.log(
        `SyncSpace server running at http://${handle.host}:${handle.port} (${env.NODE_ENV})`
      );
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Startup Error]", message);
      process.exit(1);
    });
}
