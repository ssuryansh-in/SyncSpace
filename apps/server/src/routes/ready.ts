import { Hono } from "hono";
import { checkDbHealth } from "../db/index.js";

export interface ReadyRouteOptions {
  checkDb?: (() => Promise<{ ok: boolean; error?: string }>) | undefined;
  isShuttingDown?: (() => boolean) | undefined;
}

/**
 * Creates the /ready route handler.
 * Accepts optional checkDb and isShuttingDown dependencies for testing.
 */
export function createReadyRoute(options: ReadyRouteOptions = {}): Hono {
  const router = new Hono();
  const dbHealthChecker = options.checkDb ?? checkDbHealth;
  const isShuttingDown = options.isShuttingDown ?? (() => false);

  router.get("/", async (c) => {
    if (isShuttingDown()) {
      return c.json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Server is shutting down",
          },
        },
        503
      );
    }

    const result = await dbHealthChecker();
    if (!result.ok) {
      return c.json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Database unreachable",
          },
        },
        503
      );
    }

    return c.json(
      {
        status: "ready",
        database: "connected",
      },
      200
    );
  });

  return router;
}

export const readyRoute = createReadyRoute();
