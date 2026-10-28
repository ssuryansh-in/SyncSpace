import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../config/env.js";

/**
 * Runs Drizzle migrations against the specified or environment database.
 * Ensures the PostgreSQL `citext` extension exists before migrations run.
 */
export async function runMigrations(dbUrl?: string): Promise<void> {
  const url = dbUrl || loadEnv().DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const client = postgres(url, { max: 1 });
  try {
    // Ensure citext extension is enabled before tables using citext are created
    await client`CREATE EXTENSION IF NOT EXISTS "citext"`;
    const db = drizzle(client);

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = path.resolve(__dirname, "../../drizzle/migrations");

    await migrate(db, { migrationsFolder });
  } finally {
    await client.end({ timeout: 2 });
  }
}

// Standalone execution check
const isMainModule =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")) ||
    process.argv[1].endsWith("migrate.ts") ||
    process.argv[1].endsWith("migrate.js"));

if (isMainModule) {
  runMigrations()
    .then(() => {
      console.log("Migrations applied successfully.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
