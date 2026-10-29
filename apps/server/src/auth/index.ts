import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import argon2 from "argon2";
import { db as defaultDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import * as schema from "../db/schema/index.js";
import { loadEnv, type EnvConfig } from "../config/env.js";
import { defaultEmailService, type EmailService } from "../services/email.js";

export interface CreateAuthOptions {
  db?: Database | undefined;
  env?: EnvConfig | undefined;
  emailService?: EmailService | undefined;
  rateLimit?: {
    enabled?: boolean | undefined;
    window?: number | undefined;
    max?: number | undefined;
  } | undefined;
}

/**
 * Creates and configures the Better Auth instance.
 *
 * Implements:
 * - Drizzle ORM PostgreSQL persistence
 * - Explicit field mapping: user.displayName <- name
 * - Argon2id password hashing and verification
 * - Mandatory email verification (no auto sign-in on registration or verification)
 * - In-memory rate limiting for single-instance v1 deployment
 * - RFC 4122 v4 UUID identifiers
 */
export function createAuth(options: CreateAuthOptions = {}) {
  const env = options.env ?? loadEnv();
  const targetDb = options.db ?? defaultDb;
  const emailService = options.emailService ?? defaultEmailService;

  const trustedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const baseURL = env.BETTER_AUTH_URL || `http://${env.HOST}:${env.PORT}`;
  const secret =
    env.BETTER_AUTH_SECRET ||
    "development_better_auth_secret_must_be_32_characters_minimum!";

  return betterAuth({
    database: drizzleAdapter(targetDb, {
      provider: "pg",
      schema,
    }),
    user: {
      fields: {
        name: "displayName",
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      password: {
        hash: async (password: string) => {
          return argon2.hash(password, {
            type: argon2.argon2id,
          });
        },
        verify: async ({ hash, password }: { hash: string; password: string }) => {
          return argon2.verify(hash, password);
        },
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: 3600, // 1 hour token expiration
      sendVerificationEmail: async ({ user, url }) => {
        await emailService.sendVerificationEmail({
          email: user.email,
          displayName: user.name,
          verificationUrl: url,
        });
      },
    },
    rateLimit: {
      enabled: options.rateLimit?.enabled ?? true,
      window: options.rateLimit?.window ?? 10,
      max: options.rateLimit?.max ?? 100,
      storage: "memory",
    },
    advanced: {
      database: {
        generateId: "uuid",
      },
      cookiePrefix: "syncspace",
      disableOriginCheck: false,
    },
    baseURL,
    secret,
    trustedOrigins,
  });
}

export type Auth = ReturnType<typeof createAuth>;

// Lazy singleton instance for standard server runtime
let authInstance: Auth | null = null;

export function getAuth(): Auth {
  if (!authInstance) {
    authInstance = createAuth();
  }
  return authInstance;
}

export const auth = new Proxy({} as Auth, {
  get(_target, prop) {
    const instance = getAuth();
    return Reflect.get(instance, prop);
  },
});
