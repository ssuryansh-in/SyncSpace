import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("Application Factory & Health Endpoint (In-Memory HTTP)", () => {
  const app = createApp({
    config: {
      NODE_ENV: "test",
      PORT: 4000,
      HOST: "127.0.0.1",
    },
  });

  it("GET /health returns HTTP 200 with valid JSON body", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json();
    expect(body).toMatchObject({
      status: "ok",
      uptime: expect.any(Number),
      eventLoopLatencyMs: expect.any(Number),
      timestamp: expect.any(String),
    });

    // Verify timestamp is a valid ISO 8601 string
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.eventLoopLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns standardized JSON 404 for unknown routes", async () => {
    const res = await app.request("/non-existent-route");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
      },
    });
  });

  it("returns sanitized JSON 500 for unexpected errors without leaking stack traces", async () => {
    // Instantiate test app with an error-throwing test route
    const testApp = createApp({
      config: {
        NODE_ENV: "test",
        PORT: 4000,
        HOST: "127.0.0.1",
      },
    });

    testApp.get("/test-error", () => {
      throw new Error("SensitiveDatabaseConnectionFailure: secret_password");
    });

    const res = await testApp.request("/test-error");

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      },
    });

    // Ensure error details and stack traces are not leaked to the client
    const rawText = JSON.stringify(body);
    expect(rawText).not.toContain("SensitiveDatabaseConnectionFailure");
    expect(rawText).not.toContain("secret_password");
    expect(rawText).not.toContain("stack");
  });
});

