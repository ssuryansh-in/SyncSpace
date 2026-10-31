import { Hono } from "hono";
import { healthRoute } from "./routes/health.js";
import { createReadyRoute } from "./routes/ready.js";
import { createWorkspaceRoutes } from "./routes/workspaces.js";
import { createAuth, type Auth } from "./auth/index.js";
import { db as defaultDb, type Database } from "./db/index.js";
import type { EnvConfig } from "./config/env.js";
import { AppError } from "./errors/index.js";

export interface AppOptions {
  config?: EnvConfig | undefined;
  checkDb?: (() => Promise<{ ok: boolean; error?: string }>) | undefined;
  isShuttingDown?: (() => boolean) | undefined;
  auth?: Auth | undefined;
  db?: Database | undefined;
  rateLimit?: {
    enabled?: boolean | undefined;
    windowMs?: number | undefined;
    max?: number | undefined;
  } | undefined;
}

/**
 * Creates and configures the Hono application instance.
 * Decoupled from the network listener for fast, in-memory testing.
 */
export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  const targetDb = options.db ?? defaultDb;
  const authInstance =
    options.auth ?? createAuth({ env: options.config, db: targetDb });

  // Standardized 404 Not Found handler
  app.notFound((c) => {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Route not found",
        },
      },
      404
    );
  });

  // Standardized application error handler
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          },
        },
        err.statusCode as any
      );
    }

    // Non-sensitive diagnostic log; avoid cluttering test outputs
    if (options.config?.NODE_ENV !== "test") {
      console.error("[ServerError]", err.name || "Error", err.message);
    }

    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        },
      },
      500
    );
  });

  // Mount routes
  app.on(["POST", "GET"], "/api/auth/*", (c) => authInstance.handler(c.req.raw));
  app.route(
    "/api/workspaces",
    createWorkspaceRoutes({
      db: targetDb,
      auth: authInstance,
      rateLimit: options.rateLimit,
    })
  );
  app.route("/health", healthRoute);
  app.route(
    "/ready",
    createReadyRoute({
      checkDb: options.checkDb,
      isShuttingDown: options.isShuttingDown,
    })
  );

  return app;
}

