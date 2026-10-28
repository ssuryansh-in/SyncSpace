import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { checkDbHealth } from "../../src/db/index.js";
import { testSqlClient } from "./setup.js";

describe("GET /ready endpoint (Integration)", () => {
  it("returns 200 with database: connected when PostgreSQL is reachable", async () => {
    const app = createApp({
      checkDb: () => checkDbHealth(testSqlClient),
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

  it("returns 503 when isShuttingDown is true even if PostgreSQL is reachable", async () => {
    const app = createApp({
      checkDb: () => checkDbHealth(testSqlClient),
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
});
