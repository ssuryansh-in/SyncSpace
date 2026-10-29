import { describe, expect, it } from "vitest";
import argon2 from "argon2";
import { createAuth } from "../src/auth/index.js";
import { loadEnv } from "../src/config/env.js";

describe("Better Auth Runtime Configuration", () => {
  it("initializes cleanly with Argon2id and mapped schema fields", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: "12345678901234567890123456789012",
      BETTER_AUTH_URL: "http://127.0.0.1:4000",
      ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
    });

    const authInstance = createAuth({
      db: {} as any,
      env,
    });

    expect(authInstance).toBeDefined();
    expect(typeof authInstance.handler).toBe("function");
    expect(authInstance.options.user?.fields?.name).toBe("displayName");
    expect(authInstance.options.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(authInstance.options.emailAndPassword?.autoSignIn).toBe(false);
  });

  it("hashes and verifies passwords using Argon2id", async () => {
    const env = loadEnv({
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: "12345678901234567890123456789012",
      BETTER_AUTH_URL: "http://127.0.0.1:4000",
    });

    const authInstance = createAuth({
      db: {} as any,
      env,
    });

    const hashFn = authInstance.options.emailAndPassword?.password?.hash;
    const verifyFn = authInstance.options.emailAndPassword?.password?.verify;

    expect(hashFn).toBeDefined();
    expect(verifyFn).toBeDefined();

    const plainPassword = "SuperSecretPassword123!";
    const hash = await hashFn!(plainPassword);

    // Verify hash begins with Argon2id identifier
    expect(hash.startsWith("$argon2id$")).toBe(true);

    // Verify correct password succeeds
    const isCorrect = await verifyFn!({ hash, password: plainPassword });
    expect(isCorrect).toBe(true);

    // Verify wrong password fails
    const isWrong = await verifyFn!({ hash, password: "IncorrectPassword" });
    expect(isWrong).toBe(false);
  });
});

