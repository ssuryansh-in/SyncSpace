import { loadEnv } from "../config/env.js";

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string | undefined;
}

export interface SentEmailRecord {
  to: string;
  subject: string;
  html: string;
  text?: string | undefined;
  sentAt: Date;
}

// In-memory capture for tests and development inspection
const sentEmailsForTest: SentEmailRecord[] = [];

/**
 * Returns recorded sent emails for assertions in tests.
 */
export function getSentEmailsForTest(): readonly SentEmailRecord[] {
  return sentEmailsForTest;
}

/**
 * Clears recorded sent emails.
 */
export function clearSentEmailsForTest(): void {
  sentEmailsForTest.length = 0;
}

export interface EmailService {
  sendEmail(options: SendEmailOptions): Promise<{ id?: string; simulated?: boolean }>;
  sendVerificationEmail(options: {
    email: string;
    displayName: string;
    verificationUrl: string;
  }): Promise<{ id?: string; simulated?: boolean }>;
}

/**
 * Creates the email service configured from application environment.
 */
export function createEmailService(
  customEnv?: ReturnType<typeof loadEnv>
): EmailService {
  const env = customEnv ?? loadEnv();

  const sendEmail = async (
    options: SendEmailOptions
  ): Promise<{ id?: string; simulated?: boolean }> => {
    const isProd = env.NODE_ENV === "production";
    const apiKey = env.RESEND_API_KEY;

    // In production, simulation is strictly disallowed; an API key is required
    if (isProd) {
      if (!apiKey) {
        throw new Error(
          "Email delivery failed: RESEND_API_KEY is required in production"
        );
      }
    } else {
      // In development or test, simulate delivery when API key is not provided (or always in test)
      if (env.NODE_ENV === "test" || !apiKey) {
        const record: SentEmailRecord = {
          to: options.to,
          subject: options.subject,
          html: options.html,
          text: options.text,
          sentAt: new Date(),
        };
        sentEmailsForTest.push(record);

        if (env.NODE_ENV === "development") {
          console.log(
            `[Email Dev] Simulated email to: ${options.to} | Subject: ${options.subject}`
          );
        }

        return { id: `simulated-${Date.now()}`, simulated: true };
      }
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [options.to],
        subject: options.subject,
        html: options.html,
        text: options.text,
      }),
    });

    if (!response.ok) {
      let safeDetail = "";
      try {
        const errJson = (await response.json()) as {
          name?: string | undefined;
          message?: string | undefined;
        };
        const parts: string[] = [];
        if (typeof errJson?.name === "string" && errJson.name.length <= 100) {
          parts.push(errJson.name);
        }
        if (typeof errJson?.message === "string" && errJson.message.length <= 200) {
          // Sanitize message: never leak URLs, verification tokens, or API keys
          const cleanMessage = errJson.message
            .replace(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]")
            .replace(/token=[a-zA-Z0-9._-]+/gi, "token=[REDACTED_TOKEN]")
            .replace(/re_[a-zA-Z0-9_-]+/g, "[REDACTED_KEY]");
          parts.push(cleanMessage);
        }
        if (parts.length > 0) {
          safeDetail = `: ${parts.join(" - ")}`;
        }
      } catch {
        // If response is not JSON, use standard HTTP status text rather than dumping raw body
        safeDetail = response.statusText ? `: ${response.statusText}` : "";
      }

      throw new Error(`Email provider error (${response.status})${safeDetail}`);
    }

    const data = (await response.json()) as { id?: string | undefined };
    return data?.id !== undefined
      ? { id: data.id, simulated: false }
      : { simulated: false };
  };

  const sendVerificationEmail = async ({
    email,
    displayName,
    verificationUrl,
  }: {
    email: string;
    displayName: string;
    verificationUrl: string;
  }) => {
    const subject = "Verify your SyncSpace account";
    const safeName = displayName || "there";
    const html = `
      <div style="font-family: sans-serif; line-height: 1.5; color: #111;">
        <h2>Welcome to SyncSpace, ${safeName}!</h2>
        <p>Please click the link below to verify your email address and activate your account:</p>
        <p><a href="${verificationUrl}" style="display: inline-block; padding: 10px 20px; background: #000; color: #fff; text-decoration: none; border-radius: 4px;">Verify Email</a></p>
        <p>Or paste this URL into your browser:</p>
        <p><a href="${verificationUrl}">${verificationUrl}</a></p>
        <p>This link will expire in 1 hour.</p>
      </div>
    `.trim();

    const text = `Welcome to SyncSpace, ${safeName}!\n\nPlease verify your email address by visiting:\n${verificationUrl}\n\nThis link will expire in 1 hour.`;

    return sendEmail({
      to: email,
      subject,
      html,
      text,
    });
  };

  return {
    sendEmail,
    sendVerificationEmail,
  };
}

export const defaultEmailService = createEmailService();
