import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

describe("Environment Configuration (loadEnv)", () => {
  it("applies documented defaults when configuration is empty", () => {
    const config = loadEnv({});

    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(4000);
    expect(config.HOST).toBe("127.0.0.1");
  });

  it("parses valid custom values correctly", () => {
    const config = loadEnv({
      NODE_ENV: "production",
      PORT: "8080",
      HOST: "0.0.0.0",
    });

    expect(config.NODE_ENV).toBe("production");
    expect(config.PORT).toBe(8080);
    expect(config.HOST).toBe("0.0.0.0");
  });

  it("supports ephemeral port 0 for dynamic test bindings", () => {
    const config = loadEnv({
      PORT: "0",
    });

    expect(config.PORT).toBe(0);
  });

  it("rejects invalid NODE_ENV values", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "staging" as unknown as string,
      })
    ).toThrowError(/NODE_ENV must be one of: development, production, test/);
  });

  it("rejects non-numeric PORT values", () => {
    expect(() =>
      loadEnv({
        PORT: "not-a-number",
      })
    ).toThrowError(/PORT must be a valid number/);
  });

  it("rejects negative PORT values", () => {
    expect(() =>
      loadEnv({
        PORT: "-1",
      })
    ).toThrowError(/PORT must be between 0 and 65535/);
  });

  it("rejects out-of-range PORT values (> 65535)", () => {
    expect(() =>
      loadEnv({
        PORT: "70000",
      })
    ).toThrowError(/PORT must be between 0 and 65535/);
  });

  it("rejects non-integer PORT values", () => {
    expect(() =>
      loadEnv({
        PORT: "3000.5",
      })
    ).toThrowError(/PORT must be an integer/);
  });

  it("rejects empty HOST values", () => {
    expect(() =>
      loadEnv({
        HOST: "",
      })
    ).toThrowError(/HOST cannot be empty/);
  });

  it("formats error messages safely without printing raw secret values", () => {
    const sensitiveValue = "SUPER_SECRET_TOKEN_DO_NOT_LEAK";

    try {
      loadEnv({
        PORT: sensitiveValue,
      });
      expect.unreachable("Should have thrown validation error");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain("PORT");
      // Must not leak the actual sensitive value
      expect(message).not.toContain(sensitiveValue);
    }
  });
});

