import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { loadEnv } from "../config/env.js";
import * as schema from "./schema/index.js";

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

export interface DbOptions {
  databaseUrl?: string;
  max?: number;
}

let sqlClientInstance: postgres.Sql | null = null;
let dbInstance: Database | null = null;

/**
 * Returns or initializes the underlying postgres.js client.
 */
export function getSqlClient(options?: DbOptions): postgres.Sql {
  if (options?.databaseUrl) {
    return postgres(options.databaseUrl, {
      max: options.max ?? 10,
      idle_timeout: 20,
      connect_timeout: 5,
    });
  }

  if (!sqlClientInstance) {
    const env = loadEnv();
    const url = env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not configured");
    }

    sqlClientInstance = postgres(url, {
      max: options?.max ?? env.DB_POOL_MAX ?? 10,
      idle_timeout: 20,
      connect_timeout: 5,
    });
  }

  return sqlClientInstance;
}

/**
 * Returns or initializes the Drizzle ORM database instance with registered schemas.
 */
export function getDb(options?: DbOptions): Database {
  if (options?.databaseUrl) {
    const client = getSqlClient(options);
    return drizzle(client, { schema });
  }

  if (!dbInstance) {
    const client = getSqlClient();
    dbInstance = drizzle(client, { schema });
  }

  return dbInstance;
}

/**
 * Convenience proxy to the default database instance.
 * Allows `db.select()...` syntax while delaying pool connection until first call.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    const instance = getDb();
    return Reflect.get(instance, prop);
  },
});

/**
 * Health check probe for the database.
 * Executes a lightweight `SELECT 1` with a strict 2-second timeout.
 * Never leaks credentials or connection strings in returned errors.
 */
export async function checkDbHealth(
  client?: postgres.Sql
): Promise<{ ok: boolean; error?: string }> {
  try {
    const targetClient = client ?? (sqlClientInstance || getSqlClient());
    let timeoutHandle: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error("Database health check timed out"));
      }, 2000);
    });

    try {
      await Promise.race([targetClient`SELECT 1`, timeoutPromise]);
      return { ok: true };
    } finally {
      clearTimeout(timeoutHandle!);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Database connection failed";
    // Sanitize message: never leak URL fragments or passwords
    const sanitized =
      message.includes("@") || message.toLowerCase().includes("password")
        ? "Database connection failed"
        : message;

    return {
      ok: false,
      error: sanitized,
    };
  }
}

/**
 * Gracefully shuts down the connection pool with a bounded timeout (2 seconds).
 */
export async function closeDb(client?: postgres.Sql): Promise<void> {
  const target = client ?? sqlClientInstance;
  if (!target) return;

  try {
    await target.end({ timeout: 2 });
  } catch {
    // Graceful drain timeout; suppress error during shutdown
  } finally {
    if (!client || client === sqlClientInstance) {
      sqlClientInstance = null;
      dbInstance = null;
    }
  }
}
