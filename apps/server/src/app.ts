import { Hono } from "hono";
import { healthRoute } from "./routes/health.js";
import type { EnvConfig } from "./config/env.js";

export interface AppOptions {
  config?: EnvConfig;
}

/**
 * Creates and configures the Hono application instance.
 * Decoupled from the network listener for fast, in-memory testing.
 */
export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();

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

  // Sanitized 500 Internal Server Error handler
  app.onError((err, c) => {
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
  app.route("/health", healthRoute);

  return app;
}

