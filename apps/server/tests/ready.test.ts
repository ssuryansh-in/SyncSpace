import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("GET /ready endpoint", () => {
  it("returns 200 and connected status when database is healthy", async () => {
    const app = createApp({
      checkDb: async () => ({ ok: true }),
      isShuttingDown: () => false,
    });

    const res = await app.request("/ready");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({
      status: "ready",
      database: "connected",
    });
  });

  it("returns 503 with standardized error when database health check fails", async () => {
    const app = createApp({
      checkDb: async () => ({
        ok: false,
        error: "Connection terminated unexpectedly",
      }),
      isShuttingDown: () => false,
    });

    const res = await app.request("/ready");
    expect(res.status).toBe(503);

    const data = await res.json();
    expect(data).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Database unreachable",
      },
    });
  });

  it("returns 503 when server is in the process of shutting down", async () => {
    const app = createApp({
      checkDb: async () => ({ ok: true }),
      isShuttingDown: () => true,
    });

    const res = await app.request("/ready");
    expect(res.status).toBe(503);

    const data = await res.json();
    expect(data).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Server is shutting down",
      },
    });
  });

  it("does not leak error details or connection strings on failure", async () => {
    const app = createApp({
      checkDb: async () => ({
        ok: false,
        error: "postgres://user:super_secret@localhost:5432/syncspace error",
      }),
      isShuttingDown: () => false,
    });

    const res = await app.request("/ready");
    expect(res.status).toBe(503);

    const data = await res.json();
    expect(JSON.stringify(data)).not.toContain("super_secret");
    expect(JSON.stringify(data)).not.toContain("postgres://");
    expect(data.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(data.error.message).toBe("Database unreachable");
  });
});
