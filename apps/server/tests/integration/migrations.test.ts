import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { testSqlClient, validateTestDatabaseUrl } from "./setup.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../drizzle/migrations");

describe("Database Migration Pipeline (Integration)", () => {
  it("enables the citext extension in PostgreSQL", async () => {
    const extensions = await testSqlClient`
      SELECT extname FROM pg_extension WHERE extname = 'citext';
    `;
    expect(extensions.length).toBe(1);
    expect(extensions[0]?.extname).toBe("citext");
  });

  it("Scenario 1: initializes fresh schema through migrations 0000 and 0001 with all tables and columns", async () => {
    // Verify migration log records both migrations in order
    const applied = await testSqlClient`
      SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id ASC;
    `;
    expect(applied.length).toBeGreaterThanOrEqual(2);

    // Verify all 12 canonical and auth tables exist in the public schema
    const tables = await testSqlClient`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    `;
    const tableNames = new Set(tables.map((t) => t.table_name));
    const expectedTables = [
      "users",
      "workspaces",
      "workspace_members",
      "projects",
      "project_columns",
      "tasks",
      "comments",
      "project_events",
      "idempotency_records",
      "sessions",
      "accounts",
      "verifications",
    ];
    for (const name of expectedTables) {
      expect(tableNames.has(name), `Expected table '${name}' to exist`).toBe(true);
    }

    // Verify newly added columns on users
    const userColumns = await testSqlClient`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users';
    `;
    const colMap = new Map(userColumns.map((c) => [c.column_name, c]));

    expect(colMap.has("email_verified")).toBe(true);
    expect(colMap.get("email_verified")?.data_type).toBe("boolean");
    expect(colMap.get("email_verified")?.is_nullable).toBe("NO");
    expect(colMap.get("email_verified")?.column_default).toBe("false");

    expect(colMap.has("image")).toBe(true);
    expect(colMap.get("image")?.data_type).toBe("text");
    expect(colMap.get("image")?.is_nullable).toBe("YES");

    expect(colMap.has("updated_at")).toBe(true);
    expect(colMap.get("updated_at")?.data_type).toBe("timestamp with time zone");
    expect(colMap.get("updated_at")?.is_nullable).toBe("NO");
    expect(colMap.get("updated_at")?.column_default).toContain("now()");
  });

  it("Scenario 2: upgrades from 0000 schema while strictly preserving existing user, workspace, and membership data", async () => {
    // Read the exact SQL migration files
    const sql0000 = fs.readFileSync(
      path.join(migrationsDir, "0000_futuristic_brood.sql"),
      "utf-8"
    );
    const sql0001 = fs.readFileSync(
      path.join(migrationsDir, "0001_auth_tables.sql"),
      "utf-8"
    );

    // Create an isolated schema to simulate the two-step migration on real PostgreSQL
    await testSqlClient`CREATE SCHEMA IF NOT EXISTS "upgrade_test";`;

    try {
      // Step 1: Run 0000 statements inside the isolated schema
      // Strip Drizzle statement breakpoints and apply
      const statements0000 = sql0000
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      // Execute migration 0000 in upgrade_test search_path
      await testSqlClient.begin(async (tx) => {
        await tx`SET LOCAL search_path = "upgrade_test", public;`;
        for (const statement of statements0000) {
          // Replace references to "public". with "upgrade_test".
          const scoped = statement.replace(/"public"\./g, '"upgrade_test".');
          await tx.unsafe(scoped);
        }
      });

      // Step 2: Seed pre-existing records (user, workspace, workspace_member) prior to 0001 migration
      let seedUserId: string;
      let seedWorkspaceId: string;
      await testSqlClient.begin(async (tx) => {
        await tx`SET LOCAL search_path = "upgrade_test", public;`;
        const [u] = await tx`
          INSERT INTO "users" (email, display_name)
          VALUES ('upgrade.preexisting@syncspace.local', 'Pre-existing User')
          RETURNING id;
        `;
        seedUserId = u!.id;

        const [w] = await tx`
          INSERT INTO "workspaces" (name, owner_id)
          VALUES ('Pre-existing Workspace', ${seedUserId})
          RETURNING id;
        `;
        seedWorkspaceId = w!.id;

        await tx`
          INSERT INTO "workspace_members" (workspace_id, user_id, role)
          VALUES (${seedWorkspaceId}, ${seedUserId}, 'owner');
        `;
      });

      // Step 3: Run migration 0001 statements in the isolated schema
      const statements0001 = sql0001
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      await testSqlClient.begin(async (tx) => {
        await tx`SET LOCAL search_path = "upgrade_test", public;`;
        for (const statement of statements0001) {
          const scoped = statement.replace(/"public"\./g, '"upgrade_test".');
          await tx.unsafe(scoped);
        }
      });

      // Step 4: Verify that pre-existing data is fully intact with correct defaults
      await testSqlClient.begin(async (tx) => {
        await tx`SET LOCAL search_path = "upgrade_test", public;`;

        const [userAfter] = await tx`
          SELECT id, email, display_name, email_verified, image, created_at, updated_at
          FROM "users" WHERE id = ${seedUserId};
        `;

        expect(userAfter).toBeDefined();
        expect(userAfter?.id).toBe(seedUserId);
        expect(userAfter?.email).toBe("upgrade.preexisting@syncspace.local");
        expect(userAfter?.display_name).toBe("Pre-existing User");
        expect(userAfter?.email_verified).toBe(false); // Default applied
        expect(userAfter?.image).toBeNull(); // Nullable
        expect(userAfter?.created_at).toBeDefined();
        expect(userAfter?.updated_at).toBeDefined();

        const [workspaceAfter] = await tx`
          SELECT id, name, owner_id FROM "workspaces" WHERE id = ${seedWorkspaceId};
        `;
        expect(workspaceAfter?.owner_id).toBe(seedUserId);

        const [memberAfter] = await tx`
          SELECT workspace_id, user_id, role
          FROM "workspace_members"
          WHERE workspace_id = ${seedWorkspaceId} AND user_id = ${seedUserId};
        `;
        expect(memberAfter?.role).toBe("owner");

        // Verify that newly added auth tables can reference this pre-existing user
        const [session] = await tx`
          INSERT INTO "sessions" (user_id, token, expires_at)
          VALUES (${seedUserId}, 'upgrade-session-token', now() + interval '1 day')
          RETURNING id, token;
        `;
        expect(session?.token).toBe("upgrade-session-token");
      });
    } finally {
      // Clean up isolated test schema
      await testSqlClient`DROP SCHEMA IF EXISTS "upgrade_test" CASCADE;`;
    }
  });

  it("Scenario 3: is idempotent and performs no operations when re-run at 0001", async () => {
    const testUrl = validateTestDatabaseUrl();

    // Query migration count before re-run
    const beforeCount = await testSqlClient`
      SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations";
    `;

    // Re-run migration runner
    await expect(runMigrations(testUrl)).resolves.not.toThrow();

    // Query migration count after re-run
    const afterCount = await testSqlClient`
      SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations";
    `;

    expect(afterCount[0]?.count).toBe(beforeCount[0]?.count);
  });
});
