import { afterAll, beforeAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../src/db/schema/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { validateTestDatabaseUrl } from "./safety.js";

export { validateTestDatabaseUrl } from "./safety.js";

// Advisory lock key: 0x53594e4353504345n (ASCII for "SYNCSPCE")
const ADVISORY_LOCK_KEY = 6008688537554528325n;

export let testSqlClient: postgres.Sql;
export let testDb: PostgresJsDatabase<typeof schema>;

let lockConnection: postgres.Sql | null = null;

/**
 * Truncates all domain and authentication tables in cascade to ensure a clean slate.
 */
export async function cleanTables(sqlClient: postgres.Sql = testSqlClient): Promise<void> {
  await sqlClient`
    TRUNCATE TABLE
      users,
      sessions,
      accounts,
      verifications,
      workspaces,
      workspace_members,
      projects,
      project_columns,
      tasks,
      comments,
      project_events,
      idempotency_records
    RESTART IDENTITY CASCADE;
  `;
}

beforeAll(async () => {
  const testUrl = validateTestDatabaseUrl();

  // Create a dedicated single-connection client for acquiring the cross-process advisory lock
  lockConnection = postgres(testUrl, { max: 1 });
  await lockConnection`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY.toString()})`;

  // Ensure migrations are fully applied
  await runMigrations(testUrl);

  // Initialize shared integration test client pool
  testSqlClient = postgres(testUrl, { max: 5 });
  testDb = drizzle(testSqlClient, { schema });

  // Clean tables before tests start
  await cleanTables(testSqlClient);
});

afterAll(async () => {
  if (testSqlClient) {
    await testSqlClient.end({ timeout: 2 }).catch(() => {});
  }

  if (lockConnection) {
    try {
      await lockConnection`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY.toString()})`;
      await lockConnection.end({ timeout: 2 });
    } catch {
      // Ignore unlock cleanup error on shutdown
    } finally {
      lockConnection = null;
    }
  }
});
