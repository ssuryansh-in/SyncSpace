import { Hono } from "hono";

export const healthRoute = new Hono();

/**
 * Health check route handler.
 * Verifies Node.js process responsiveness and event-loop availability.
 * Does not check database connectivity or authentication state.
 */
healthRoute.get("/", (c) => {
  return c.json(
    {
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
    200
  );
});

