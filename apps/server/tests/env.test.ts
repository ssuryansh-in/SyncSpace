import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

describe("Environment Configuration (loadEnv)", () => {
  it("applies documented defaults when configuration is empty", () => {
    const config = loadEnv({});

    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(4000);
    expect(config.HOST).toBe("127.0.0.1");
    expect(config.DB_POOL_MAX).toBe(10);
    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.BETTER_AUTH_SECRET).toBeUndefined();
    expect(config.BETTER_AUTH_URL).toBeUndefined();
    expect(config.ALLOWED_ORIGINS).toBe("http://localhost:3000");
    expect(config.EMAIL_FROM).toBe("SyncSpace <noreply@syncspace.dev>");
    expect(config.RESEND_API_KEY).toBeUndefined();
  });

  it("parses valid custom values correctly", () => {
    const config = loadEnv({
      NODE_ENV: "production",
      PORT: "8080",
      HOST: "0.0.0.0",
      DATABASE_URL: "postgres://user:password@localhost:5432/syncspace",
      DB_POOL_MAX: "25",
      BETTER_AUTH_SECRET: "a_very_secure_secret_with_more_than_32_characters_here",
      BETTER_AUTH_URL: "https://auth.example.com:8080",
      ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com",
      EMAIL_FROM: "SyncSpace Team <team@example.com>",
      RESEND_API_KEY: "re_1234567890abcdef",
    });

    expect(config.NODE_ENV).toBe("production");
    expect(config.PORT).toBe(8080);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.DATABASE_URL).toBe(
      "postgres://user:password@localhost:5432/syncspace"
    );
    expect(config.DB_POOL_MAX).toBe(25);
    expect(config.BETTER_AUTH_SECRET).toBe(
      "a_very_secure_secret_with_more_than_32_characters_here"
    );
    expect(config.BETTER_AUTH_URL).toBe("https://auth.example.com:8080");
    expect(config.ALLOWED_ORIGINS).toBe("https://app.example.com,https://admin.example.com");
    expect(config.EMAIL_FROM).toBe("SyncSpace Team <team@example.com>");
    expect(config.RESEND_API_KEY).toBe("re_1234567890abcdef");
  });

  it("accepts postgresql:// protocol alias", () => {
    const config = loadEnv({
      DATABASE_URL: "postgresql://user:password@localhost:5432/syncspace",
    });

    expect(config.DATABASE_URL).toBe(
      "postgresql://user:password@localhost:5432/syncspace"
    );
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

  it("rejects malformed DATABASE_URL strings", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: "not-a-valid-url",
      })
    ).toThrowError(/DATABASE_URL must be a valid URL/);
  });

  it("rejects unsupported protocols in DATABASE_URL", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: "mysql://user:pass@localhost:3306/db",
      })
    ).toThrowError(/DATABASE_URL must use postgres:\/\/ or postgresql:\/\/ protocol/);
  });

  it("requires DATABASE_URL when NODE_ENV is production", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
      })
    ).toThrowError(/DATABASE_URL is required in production/);
  });

  it("requires BETTER_AUTH_SECRET when NODE_ENV is production", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://user:password@localhost:5432/syncspace",
        BETTER_AUTH_URL: "https://auth.example.com",
      })
    ).toThrowError(/BETTER_AUTH_SECRET is required in production/);
  });

  it("requires BETTER_AUTH_URL when NODE_ENV is production", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://user:password@localhost:5432/syncspace",
        BETTER_AUTH_SECRET: "a_very_secure_secret_with_more_than_32_characters_here",
      })
    ).toThrowError(/BETTER_AUTH_URL is required in production/);
  });

  it("requires RESEND_API_KEY when NODE_ENV is production", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://user:password@localhost:5432/syncspace",
        BETTER_AUTH_SECRET: "a_very_secure_secret_with_more_than_32_characters_here",
        BETTER_AUTH_URL: "https://auth.syncspace.dev",
      })
    ).toThrowError(/RESEND_API_KEY is required in production/);
  });

  it("accepts a production HTTPS authentication URL when production settings are valid", () => {
    const config = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:password@localhost:5432/syncspace",
      BETTER_AUTH_SECRET: "a_very_secure_secret_with_more_than_32_characters_here",
      BETTER_AUTH_URL: "https://auth.syncspace.dev",
      RESEND_API_KEY: "re_valid_api_key_here",
    });

    expect(config.BETTER_AUTH_URL).toBe("https://auth.syncspace.dev");
  });

  it("rejects non-HTTPS BETTER_AUTH_URL when NODE_ENV is production", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://user:password@localhost:5432/syncspace",
        BETTER_AUTH_SECRET: "a_very_secure_secret_with_more_than_32_characters_here",
        BETTER_AUTH_URL: "http://auth.syncspace.dev",
        RESEND_API_KEY: "re_valid_api_key_here",
      })
    ).toThrowError(/BETTER_AUTH_URL must use https:\/\/ protocol in production/);
  });

  it("allows HTTP BETTER_AUTH_URL in development and test environments", () => {
    const devConfig = loadEnv({
      NODE_ENV: "development",
      BETTER_AUTH_URL: "http://127.0.0.1:4000",
    });
    expect(devConfig.BETTER_AUTH_URL).toBe("http://127.0.0.1:4000");

    const testConfig = loadEnv({
      NODE_ENV: "test",
      BETTER_AUTH_URL: "http://localhost:4000",
    });
    expect(testConfig.BETTER_AUTH_URL).toBe("http://localhost:4000");
  });

  it("rejects BETTER_AUTH_SECRET shorter than 32 characters", () => {
    expect(() =>
      loadEnv({
        BETTER_AUTH_SECRET: "short-secret",
      })
    ).toThrowError(/BETTER_AUTH_SECRET must be at least 32 characters long/);
  });

  it("rejects malformed BETTER_AUTH_URL values", () => {
    expect(() =>
      loadEnv({
        BETTER_AUTH_URL: "not-a-valid-url",
      })
    ).toThrowError(/BETTER_AUTH_URL must be a valid URL/);
  });

  it("does not leak BETTER_AUTH_SECRET in validation errors", () => {
    const rawSecret = "too-short-secret-leaked?";
    try {
      loadEnv({
        BETTER_AUTH_SECRET: rawSecret,
      });
      expect.unreachable("Should have thrown validation error");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain("BETTER_AUTH_SECRET");
      expect(message).not.toContain(rawSecret);
    }
  });

  it("rejects invalid DB_POOL_MAX values (< 1 or > 100)", () => {
    expect(() =>
      loadEnv({
        DB_POOL_MAX: "0",
      })
    ).toThrowError(/DB_POOL_MAX must be at least 1/);

    expect(() =>
      loadEnv({
        DB_POOL_MAX: "150",
      })
    ).toThrowError(/DB_POOL_MAX cannot exceed 100/);
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

  it("does not leak credentials in DATABASE_URL validation errors", () => {
    const secretPassword = "SuperConfidentialPassword123!";
    const invalidUrlWithPassword = `mysql://admin:${secretPassword}@db.example.com:5432/syncspace`;

    try {
      loadEnv({
        DATABASE_URL: invalidUrlWithPassword,
      });
      expect.unreachable("Should have thrown validation error");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).not.toContain(secretPassword);
    }
  });
});
