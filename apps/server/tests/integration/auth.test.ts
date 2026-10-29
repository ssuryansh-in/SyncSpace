import { beforeEach, describe, expect, it } from "vitest";
import { cleanTables, testDb, testSqlClient } from "./setup.js";
import { users, accounts, sessions, workspaceMembers } from "../../src/db/schema/index.js";
import { eq } from "drizzle-orm";
import argon2 from "argon2";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth/index.js";
import { loadEnv } from "../../src/config/env.js";
import {
  createEmailService,
  getSentEmailsForTest,
  clearSentEmailsForTest,
} from "../../src/services/email.js";
import { signJWT } from "better-auth/crypto";

describe("Better Auth Runtime & Lifecycle (Integration)", () => {
  const testEnv = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: process.env["TEST_DATABASE_URL"],
    BETTER_AUTH_SECRET: "integration_test_secret_32_characters_minimum!",
    BETTER_AUTH_URL: "http://127.0.0.1:4000",
    ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:4000",
  });

  const testEmailService = createEmailService(testEnv);
  let testAuth: ReturnType<typeof createAuth>;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await cleanTables(testSqlClient);
    clearSentEmailsForTest();

    testAuth = createAuth({
      db: testDb,
      env: testEnv,
      emailService: testEmailService,
      rateLimit: { enabled: false },
    });

    app = createApp({
      config: testEnv,
      auth: testAuth,
    });
  });

  it("registers an unverified user, hashes password with Argon2id, and does not issue a session", async () => {
    const signupRes = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        name: "Alice Developer",
        email: "alice@example.com",
        password: "ValidPassword123!",
      }),
    });

    expect(signupRes.status).toBe(200);
    const signupBody = await signupRes.json();

    // Verification token should be generated and user returned, but NO session token
    expect(signupBody.token).toBeNull();
    expect(signupBody.user).toBeDefined();
    expect(signupBody.user.email).toBe("alice@example.com");
    expect(signupBody.user.name).toBe("Alice Developer");
    expect(signupBody.user.emailVerified).toBe(false);

    // No session cookie should be issued
    const setCookie = signupRes.headers.get("set-cookie");
    expect(setCookie).toBeFalsy();

    // Verify PostgreSQL records
    const [dbUser] = await testDb
      .select()
      .from(users)
      .where(eq(users.email, "alice@example.com"));

    expect(dbUser).toBeDefined();
    expect(dbUser.displayName).toBe("Alice Developer");
    expect(dbUser.emailVerified).toBe(false);

    const [dbAccount] = await testDb
      .select()
      .from(accounts)
      .where(eq(accounts.userId, dbUser.id));

    expect(dbAccount).toBeDefined();
    expect(dbAccount.providerId).toBe("credential");
    expect(dbAccount.password).toBeDefined();
    expect(dbAccount.password!.startsWith("$argon2id$")).toBe(true);

    // Verify Argon2id password verification succeeds
    const isPasswordValid = await argon2.verify(
      dbAccount.password!,
      "ValidPassword123!"
    );
    expect(isPasswordValid).toBe(true);

    // Verify NO sessions exist in database
    const dbSessions = await testDb.select().from(sessions);
    expect(dbSessions.length).toBe(0);

    // Verify verification email was dispatched
    const sentEmails = getSentEmailsForTest();
    expect(sentEmails.length).toBe(1);
    expect(sentEmails[0].to).toBe("alice@example.com");
    expect(sentEmails[0].html).toContain("/verify-email?token=");
  });

  it("rejects login attempts by an unverified user", async () => {
    // 1. Register user
    await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        name: "Bob Builder",
        email: "bob@example.com",
        password: "ValidPassword123!",
      }),
    });

    // 2. Attempt login before email verification
    const loginRes = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        email: "bob@example.com",
        password: "ValidPassword123!",
      }),
    });

    expect(loginRes.status).toBe(403);
    const loginBody = await loginRes.json();
    expect(loginBody.code).toBe("EMAIL_NOT_VERIFIED");

    // No session in DB
    const dbSessions = await testDb.select().from(sessions);
    expect(dbSessions.length).toBe(0);
  });

  it("verifies email with valid token without creating a session, then allows login", async () => {
    // 1. Register user
    await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        name: "Carol Danvers",
        email: "carol@example.com",
        password: "ValidPassword123!",
      }),
    });

    const sentEmails = getSentEmailsForTest();
    expect(sentEmails.length).toBe(1);

    // Extract token from email URL
    const match = sentEmails[0].html.match(/token=([a-zA-Z0-9._-]+)/);
    expect(match).toBeTruthy();
    const token = match![1];

    // 2. Call verify-email endpoint
    const verifyRes = await app.request(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
      {
        method: "GET",
      }
    );

    expect(verifyRes.status).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.status).toBe(true);

    // Verify DB user is now email_verified = true
    const [dbUser] = await testDb
      .select()
      .from(users)
      .where(eq(users.email, "carol@example.com"));
    expect(dbUser.emailVerified).toBe(true);

    // Verify verification did NOT create a session
    const sessionsAfterVerify = await testDb.select().from(sessions);
    expect(sessionsAfterVerify.length).toBe(0);

    // 3. Now login should succeed
    const loginRes = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        email: "carol@example.com",
        password: "ValidPassword123!",
      }),
    });

    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.token).toBeDefined();
    expect(loginBody.user.email).toBe("carol@example.com");

    const setCookie = loginRes.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("syncspace.session_token=");

    // Verify session row exists in PostgreSQL
    const [dbSession] = await testDb
      .select()
      .from(sessions)
      .where(eq(sessions.userId, dbUser.id));

    expect(dbSession).toBeDefined();
    expect(dbSession.token).toBe(loginBody.token);

    // 4. Validate session via get-session
    const sessionRes = await app.request("/api/auth/get-session", {
      headers: {
        Cookie: setCookie!,
      },
    });

    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.user.email).toBe("carol@example.com");
    expect(sessionBody.user.name).toBe("Carol Danvers");
    expect(sessionBody.session.token).toBe(loginBody.token);

    // 5. Sign out and verify session revocation
    const signoutRes = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: {
        Cookie: setCookie!,
        Origin: "http://127.0.0.1:4000",
      },
    });

    expect(signoutRes.status).toBe(200);

    // Session row must be deleted from PostgreSQL
    const sessionsAfterSignout = await testDb
      .select()
      .from(sessions)
      .where(eq(sessions.userId, dbUser.id));
    expect(sessionsAfterSignout.length).toBe(0);
  });

  it("rejects invalid, tampered, or expired verification tokens", async () => {
    // Tampered token
    const tamperedRes = await app.request(
      "/api/auth/verify-email?token=invalid.tampered.token",
      {
        method: "GET",
      }
    );
    expect(tamperedRes.status).toBe(401);

    // Expired token (create a token with negative expiration)
    const expiredToken = await signJWT(
      { email: "someone@example.com" },
      testEnv.BETTER_AUTH_SECRET!,
      -10 // expired 10 seconds ago
    );

    const expiredRes = await app.request(
      `/api/auth/verify-email?token=${encodeURIComponent(expiredToken)}`,
      {
        method: "GET",
      }
    );
    expect(expiredRes.status).toBe(401);
  });

  it("protects against account enumeration on duplicate registration", async () => {
    // 1. First registration
    const res1 = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        name: "David Tenant",
        email: "david@example.com",
        password: "ValidPassword123!",
      }),
    });
    expect(res1.status).toBe(200);

    // 2. Duplicate registration with same email
    const res2 = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        name: "David Clone",
        email: "david@example.com",
        password: "DifferentPassword456!",
      }),
    });

    // Better Auth returns 200 with generic response (does not leak that account exists)
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.token).toBeNull();

    // Verify database has strictly 1 user row
    const userRows = await testDb
      .select()
      .from(users)
      .where(eq(users.email, "david@example.com"));
    expect(userRows.length).toBe(1);
    expect(userRows[0].displayName).toBe("David Tenant");
  });

  it("never grants workspace membership during public registration", async () => {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        name: "Eve Alone",
        email: "eve@example.com",
        password: "ValidPassword123!",
      }),
    });

    expect(res.status).toBe(200);
    const [dbUser] = await testDb
      .select()
      .from(users)
      .where(eq(users.email, "eve@example.com"));

    // User must have 0 workspace memberships
    const memberships = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, dbUser.id));
    expect(memberships.length).toBe(0);
  });

  it("rejects login with incorrect password", async () => {
    // 1. Create verified user via sign-up and verify-email flow
    await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        name: "Frank Castle",
        email: "frank@example.com",
        password: "CorrectPassword123!",
      }),
    });

    // Manually mark verified in DB
    await testDb
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.email, "frank@example.com"));

    // 2. Try to log in with wrong password
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        email: "frank@example.com",
        password: "WrongPassword123!",
      }),
    });

    // Better Auth returns 401 for incorrect password
    expect(res.status).toBe(401);
  });

  it("enforces rate limiting on rapid repeated requests when enabled", async () => {
    const rateLimitedAuth = createAuth({
      db: testDb,
      env: testEnv,
      emailService: testEmailService,
      rateLimit: { enabled: true, window: 10, max: 2 },
    });

    const rateLimitedApp = createApp({
      config: testEnv,
      auth: rateLimitedAuth,
    });

    const attempts = [];
    for (let i = 0; i < 5; i++) {
      attempts.push(
        rateLimitedApp.request("/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:4000",
          },
          body: JSON.stringify({
            email: "rate-limited@example.com",
            password: "SomePassword123!",
          }),
        })
      );
    }

    const responses = await Promise.all(attempts);
    const statuses = responses.map((r) => r.status);

    // At least one response should be 429 Too Many Requests
    expect(statuses).toContain(429);
  });

  it("blocks mutation requests with untrusted Origin header", async () => {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://attacker-evil-site.com",
      },
      body: JSON.stringify({
        name: "Untrusted Actor",
        email: "untrusted@example.com",
        password: "ValidPassword123!",
      }),
    });

    // Better Auth rejects untrusted origin with 403 Forbidden
    expect(res.status).toBe(403);
  });

  it("handles repeated verification attempts for an already verified account safely", async () => {
    // 1. Register user
    await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        name: "Grace Hopper",
        email: "grace@example.com",
        password: "ValidPassword123!",
      }),
    });

    const sentEmails = getSentEmailsForTest();
    const token = sentEmails[0].html.match(/token=([a-zA-Z0-9._-]+)/)![1];

    // 2. First verification
    const res1 = await app.request(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
      { method: "GET" }
    );
    expect(res1.status).toBe(200);

    // 3. Second verification with same token (already verified)
    const res2 = await app.request(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
      { method: "GET" }
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.status).toBe(true);
  });

  it("allows resending verification emails to unverified users", async () => {
    // 1. Register user
    await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        name: "Ada Lovelace",
        email: "ada@example.com",
        password: "ValidPassword123!",
      }),
    });

    clearSentEmailsForTest();

    // 2. Resend verification email
    const resendRes = await app.request("/api/auth/send-verification-email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4000",
      },
      body: JSON.stringify({
        email: "ada@example.com",
      }),
    });

    expect(resendRes.status).toBe(200);
    const resendBody = await resendRes.json();
    expect(resendBody.status).toBe(true);

    const sentEmails = getSentEmailsForTest();
    expect(sentEmails.length).toBe(1);
    expect(sentEmails[0].to).toBe("ada@example.com");
  });
});
