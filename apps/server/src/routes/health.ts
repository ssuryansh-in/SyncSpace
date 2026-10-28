import { Hono } from "hono";
import { monitorEventLoopDelay } from "node:perf_hooks";

export const healthRoute = new Hono();

// Initialize and enable event-loop delay monitoring
const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

/**
 * Health check route handler.
 * Verifies Node.js process responsiveness and event-loop latency.
 * Strictly independent of database connectivity or external services.
 */
healthRoute.get("/", (c) => {
  // Convert mean nanoseconds to milliseconds, safe against NaN or negative bounds
  const rawMeanMs = histogram.mean / 1e6;
  const eventLoopLatencyMs =
    Number.isNaN(rawMeanMs) || rawMeanMs < 0 ? 0 : Number(rawMeanMs.toFixed(3));

  return c.json(
    {
      status: "ok",
      uptime: process.uptime(),
      eventLoopLatencyMs,
      timestamp: new Date().toISOString(),
    },
    200
  );
});
