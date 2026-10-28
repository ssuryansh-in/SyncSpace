import { describe, expect, it } from "vitest";
import { checkDbHealth, closeDb } from "../src/db/index.js";

describe("Database client module (unit tests)", () => {
  it("checkDbHealth returns ok: false when DATABASE_URL is not set without uncaught exception", async () => {
    // Delete DATABASE_URL temporarily to test unconfigured handling
    const origUrl = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];

    try {
      const result = await checkDbHealth();
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      if (origUrl !== undefined) {
        process.env["DATABASE_URL"] = origUrl;
      }
    }
  });

  it("checkDbHealth sanitizes errors containing passwords or connection URLs", async () => {
    // Mock a client that throws an error containing sensitive information
    const mockClient = (() => {
      throw new Error("Failed to connect: postgres://user:super_secret_pw@db.internal:5432/syncspace");
    }) as unknown as Parameters<typeof checkDbHealth>[0];

    const result = await checkDbHealth(mockClient);
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("super_secret_pw");
    expect(result.error).not.toContain("@db.internal");
    expect(result.error).toBe("Database connection failed");
  });

  it("closeDb is idempotent and can be safely called multiple times", async () => {
    await expect(closeDb()).resolves.toBeUndefined();
    await expect(closeDb()).resolves.toBeUndefined();
  });
});
