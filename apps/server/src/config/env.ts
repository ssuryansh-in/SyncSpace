import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"], {
        errorMap: () => ({
          message: "NODE_ENV must be one of: development, production, test",
        }),
      })
      .default("development"),
    PORT: z
      .preprocess((val) => {
        if (val === undefined || val === null || val === "") {
          return 4000;
        }
        if (typeof val === "string") {
          const parsed = Number(val);
          return Number.isNaN(parsed) ? val : parsed;
        }
        return val;
      }, z.number({ invalid_type_error: "PORT must be a valid number" })
        .int("PORT must be an integer")
        .min(0, "PORT must be between 0 and 65535")
        .max(65535, "PORT must be between 0 and 65535"))
      .default(4000),
    HOST: z
      .string({ invalid_type_error: "HOST must be a string" })
      .min(1, "HOST cannot be empty")
      .default("127.0.0.1"),
    DATABASE_URL: z
      .string({ invalid_type_error: "DATABASE_URL must be a string" })
      .url("DATABASE_URL must be a valid URL")
      .refine(
        (val) =>
          val.startsWith("postgres://") || val.startsWith("postgresql://"),
        {
          message:
            "DATABASE_URL must use postgres:// or postgresql:// protocol",
        }
      )
      .optional(),
    DB_POOL_MAX: z
      .preprocess((val) => {
        if (val === undefined || val === null || val === "") return 10;
        if (typeof val === "string") {
          const parsed = Number(val);
          return Number.isNaN(parsed) ? val : parsed;
        }
        return val;
      }, z.number({ invalid_type_error: "DB_POOL_MAX must be a valid number" })
        .int("DB_POOL_MAX must be an integer")
        .min(1, "DB_POOL_MAX must be at least 1")
        .max(100, "DB_POOL_MAX cannot exceed 100"))
      .default(10),
    BETTER_AUTH_SECRET: z
      .string({ invalid_type_error: "BETTER_AUTH_SECRET must be a string" })
      .min(32, "BETTER_AUTH_SECRET must be at least 32 characters long")
      .optional(),
    BETTER_AUTH_URL: z
      .string({ invalid_type_error: "BETTER_AUTH_URL must be a string" })
      .url("BETTER_AUTH_URL must be a valid URL")
      .optional(),
    ALLOWED_ORIGINS: z
      .string({ invalid_type_error: "ALLOWED_ORIGINS must be a string" })
      .default("http://localhost:3000"),
    EMAIL_FROM: z
      .string({ invalid_type_error: "EMAIL_FROM must be a string" })
      .min(1, "EMAIL_FROM cannot be empty")
      .default("SyncSpace <noreply@syncspace.dev>"),
    RESEND_API_KEY: z
      .string({ invalid_type_error: "RESEND_API_KEY must be a string" })
      .min(1, "RESEND_API_KEY cannot be empty")
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === "production") {
      if (!data.DATABASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DATABASE_URL"],
          message: "DATABASE_URL is required in production",
        });
      }
      if (!data.BETTER_AUTH_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["BETTER_AUTH_SECRET"],
          message: "BETTER_AUTH_SECRET is required in production",
        });
      }
      if (!data.BETTER_AUTH_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["BETTER_AUTH_URL"],
          message: "BETTER_AUTH_URL is required in production",
        });
      } else if (!data.BETTER_AUTH_URL.startsWith("https://")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["BETTER_AUTH_URL"],
          message: "BETTER_AUTH_URL must use https:// protocol in production",
        });
      }
      if (!data.RESEND_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["RESEND_API_KEY"],
          message: "RESEND_API_KEY is required in production",
        });
      }
    }
  });

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Formats Zod errors safely without disclosing variable values or sensitive strings.
 */
function formatZodErrors(error: z.ZodError): string {
  const details = error.issues
    .map((issue) => {
      const field = issue.path.join(".") || "Configuration";
      return `  - ${field}: ${issue.message}`;
    })
    .join("\n");

  return `Invalid environment configuration:\n${details}`;
}

/**
 * Parses and validates environment variables.
 * Safe for use in both runtime and test environments.
 *
 * @param source Optional custom environment dictionary. Defaults to process.env.
 * @returns Validated and typed configuration object.
 * @throws Error with descriptive, non-sensitive messages when validation fails.
 */
export function loadEnv(
  source: Record<string, string | undefined> = process.env
): EnvConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const message = formatZodErrors(result.error);
    throw new Error(message);
  }

  return result.data;
}
