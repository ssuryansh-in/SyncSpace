import { z } from "zod";

const envSchema = z.object({
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

