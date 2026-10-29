import { describe, expect, it, beforeEach } from "vitest";
import {
  createEmailService,
  getSentEmailsForTest,
  clearSentEmailsForTest,
} from "../src/services/email.js";
import { loadEnv } from "../src/config/env.js";

describe("Email Service", () => {
  beforeEach(() => {
    clearSentEmailsForTest();
  });

  it("simulates email delivery in test environment without calling external API", async () => {
    const service = createEmailService(
      loadEnv({
        NODE_ENV: "test",
      })
    );

    const result = await service.sendVerificationEmail({
      email: "user@example.com",
      displayName: "Test User",
      verificationUrl: "http://127.0.0.1:4000/verify-email?token=xyz",
    });

    expect(result.simulated).toBe(true);
    const sent = getSentEmailsForTest();
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("user@example.com");
    expect(sent[0].subject).toBe("Verify your SyncSpace account");
    expect(sent[0].html).toContain("http://127.0.0.1:4000/verify-email?token=xyz");
    expect(sent[0].text).toContain("http://127.0.0.1:4000/verify-email?token=xyz");
  });

  it("simulates email delivery in development environment when RESEND_API_KEY is absent", async () => {
    const service = createEmailService(
      loadEnv({
        NODE_ENV: "development",
      })
    );

    const result = await service.sendVerificationEmail({
      email: "dev-user@example.com",
      displayName: "Dev User",
      verificationUrl: "http://localhost:4000/verify-email?token=dev-token",
    });

    expect(result.simulated).toBe(true);
    const sent = getSentEmailsForTest();
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("dev-user@example.com");
  });

  it("fails safely in production when RESEND_API_KEY is not configured and never falls back to simulation", async () => {
    // Construct production env config without RESEND_API_KEY directly
    const unsafeProdEnv = {
      NODE_ENV: "production" as const,
      PORT: 4000,
      HOST: "127.0.0.1",
      DB_POOL_MAX: 10,
      DATABASE_URL: "postgres://user:pass@localhost:5432/syncspace",
      BETTER_AUTH_SECRET: "12345678901234567890123456789012",
      BETTER_AUTH_URL: "https://auth.example.com",
      ALLOWED_ORIGINS: "http://localhost:3000",
      EMAIL_FROM: "SyncSpace <noreply@syncspace.dev>",
      RESEND_API_KEY: undefined,
    };

    const service = createEmailService(unsafeProdEnv);

    await expect(
      service.sendEmail({
        to: "prod-user@example.com",
        subject: "Verify",
        html: "<p>Link</p>",
      })
    ).rejects.toThrowError(/RESEND_API_KEY is required in production/);

    // Verify emails are NEVER captured into test/dev memory in production
    const sent = getSentEmailsForTest();
    expect(sent.length).toBe(0);
  });

  it("handles Resend network errors safely without disclosing secrets", async () => {
    const mockEnv = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@localhost:5432/syncspace",
      BETTER_AUTH_SECRET: "12345678901234567890123456789012",
      BETTER_AUTH_URL: "https://auth.example.com",
      RESEND_API_KEY: "re_fake_secret_key_12345",
    });

    // Mock global fetch to simulate an error with diagnostic message from Resend
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          name: "authentication_error",
          message: "Invalid API key re_fake_secret_key_12345",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );

    try {
      const service = createEmailService(mockEnv);
      let errorThrown: Error | null = null;
      try {
        await service.sendEmail({
          to: "user@example.com",
          subject: "Test",
          html: "<p>Test</p>",
        });
      } catch (err) {
        errorThrown = err as Error;
      }

      expect(errorThrown).not.toBeNull();
      expect(errorThrown!.message).toContain("Email provider error (401): authentication_error");
      expect(errorThrown!.message).not.toContain("re_fake_secret_key_12345");
      expect(errorThrown!.message).toContain("[REDACTED_KEY]");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("regression: prevents leakage of verification tokens, URLs, and sensitive values in error messages", async () => {
    const mockEnv = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@localhost:5432/syncspace",
      BETTER_AUTH_SECRET: "12345678901234567890123456789012",
      BETTER_AUTH_URL: "https://auth.example.com",
      RESEND_API_KEY: "re_prod_key_98765",
    });

    const sensitiveToken = "super-confidential-verification-token-secret-999";
    const sensitiveUrl = `https://auth.example.com/verify-email?token=${sensitiveToken}`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          name: "validation_error",
          message: `Delivery rejected for ${sensitiveUrl} with key re_prod_key_98765`,
        }),
        {
          status: 422,
          headers: { "Content-Type": "application/json" },
        }
      );

    try {
      const service = createEmailService(mockEnv);
      let errorThrown: Error | null = null;
      try {
        await service.sendVerificationEmail({
          email: "target@example.com",
          displayName: "Target User",
          verificationUrl: sensitiveUrl,
        });
      } catch (err) {
        errorThrown = err as Error;
      }

      expect(errorThrown).not.toBeNull();
      const msg = errorThrown!.message;
      expect(msg).toContain("Email provider error (422): validation_error");
      // Must not leak token, URL, or API key
      expect(msg).not.toContain(sensitiveToken);
      expect(msg).not.toContain(sensitiveUrl);
      expect(msg).not.toContain("re_prod_key_98765");
      expect(msg).toContain("[REDACTED_URL]");
      expect(msg).toContain("[REDACTED_KEY]");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("regression: handles non-JSON upstream provider failures without dumping raw response body", async () => {
    const mockEnv = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@localhost:5432/syncspace",
      BETTER_AUTH_SECRET: "12345678901234567890123456789012",
      BETTER_AUTH_URL: "https://auth.example.com",
      RESEND_API_KEY: "re_prod_key_98765",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        "<html><body>502 Bad Gateway: unparsed internal error with token=sensitive_raw_token_xyz</body></html>",
        {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "text/html" },
        }
      );

    try {
      const service = createEmailService(mockEnv);
      let errorThrown: Error | null = null;
      try {
        await service.sendEmail({
          to: "user@example.com",
          subject: "Test",
          html: "<p>Test</p>",
        });
      } catch (err) {
        errorThrown = err as Error;
      }

      expect(errorThrown).not.toBeNull();
      const msg = errorThrown!.message;
      expect(msg).toBe("Email provider error (502): Bad Gateway");
      expect(msg).not.toContain("<html>");
      expect(msg).not.toContain("sensitive_raw_token_xyz");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("simulates password reset email delivery in test environment without calling external API", async () => {
    const service = createEmailService(
      loadEnv({
        NODE_ENV: "test",
      })
    );

    const result = await service.sendPasswordResetEmail({
      email: "reset-user@example.com",
      displayName: "Reset User",
      resetUrl: "http://127.0.0.1:4000/api/auth/reset-password/abc123xyz?callbackURL=%2F",
    });

    expect(result.simulated).toBe(true);
    const sent = getSentEmailsForTest();
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("reset-user@example.com");
    expect(sent[0].subject).toBe("Reset your SyncSpace password");
    expect(sent[0].html).toContain("Reset your password, Reset User");
    expect(sent[0].html).toContain("http://127.0.0.1:4000/api/auth/reset-password/abc123xyz");
    expect(sent[0].text).toContain("http://127.0.0.1:4000/api/auth/reset-password/abc123xyz");
  });

  it("regression: prevents leakage of reset tokens and URLs when sending password reset email fails", async () => {
    const mockEnv = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@localhost:5432/syncspace",
      BETTER_AUTH_SECRET: "12345678901234567890123456789012",
      BETTER_AUTH_URL: "https://auth.example.com",
      RESEND_API_KEY: "re_fake_secret_key_12345",
    });

    const resetToken = "sensitive-password-reset-token-999";
    const resetUrl = `https://auth.example.com/api/auth/reset-password/${resetToken}?callbackURL=https%3A%2F%2Fapp.example.com`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          name: "delivery_error",
          message: `Failed to dispatch to ${resetUrl} with token=${resetToken} and key re_fake_secret_key_12345`,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );

    try {
      const service = createEmailService(mockEnv);
      let errorThrown: Error | null = null;
      try {
        await service.sendPasswordResetEmail({
          email: "user@example.com",
          displayName: "User",
          resetUrl,
        });
      } catch (err) {
        errorThrown = err as Error;
      }

      expect(errorThrown).not.toBeNull();
      const msg = errorThrown!.message;
      expect(msg).toContain("Email provider error (400): delivery_error");
      expect(msg).not.toContain(resetToken);
      expect(msg).not.toContain(resetUrl);
      expect(msg).not.toContain("re_fake_secret_key_12345");
      expect(msg).toContain("[REDACTED_URL]");
      expect(msg).toContain("[REDACTED_KEY]");
      expect(msg).toContain("token=[REDACTED_TOKEN]");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

