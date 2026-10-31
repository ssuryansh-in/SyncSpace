import type { Context, Next } from "hono";

export interface RateLimiterOptions {
  windowMs?: number;
  max?: number;
  enabled?: boolean;
}

/**
 * Lightweight in-memory sliding-window rate limiter for sensitive endpoints.
 * Reference: docs/SPECIFICATION.md Section 6.2 & 12.9
 */
export function createRateLimiter(options: RateLimiterOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 10;
  const enabled = options.enabled ?? true;
  const hits = new Map<string, number[]>();

  return async function rateLimiter(c: Context, next: Next) {
    if (!enabled) {
      return next();
    }

    const user = c.get("user");
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("cf-connecting-ip") ||
      "127.0.0.1";
    const key = user?.id ? `user:${user.id}` : `ip:${ip}`;

    const now = Date.now();

    // Periodic / on-request cleanup: prune expired entries to prevent memory retention
    for (const [k, timestamps] of hits.entries()) {
      if (timestamps.length === 0 || now - timestamps[timestamps.length - 1]! >= windowMs) {
        hits.delete(k);
      }
    }

    const timestamps = hits.get(key) || [];
    const recent = timestamps.filter((t) => now - t < windowMs);

    if (recent.length >= max) {
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many member addition attempts. Please try again later.",
          },
        },
        429
      );
    }

    recent.push(now);
    hits.set(key, recent);
    await next();
  };
}
