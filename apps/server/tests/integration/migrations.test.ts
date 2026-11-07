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

  it("Scenario 1: initializes fresh schema through migrations 0000, 0001, and 0002 with all tables, columns, and C collation", async () => {
    // Verify migration log records all three migrations in order
    const applied = await testSqlClient`
      SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id ASC;
    `;
    expect(applied.length).toBeGreaterThanOrEqual(3);

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

    // Verify tasks.rank_key has explicit collation "C" applied by migration 0002
    const [rankCol] = await testSqlClient`
      SELECT a.attname, c.collname
      FROM pg_attribute a
      JOIN pg_class t ON a.attrelid = t.oid
      LEFT JOIN pg_collation c ON a.attcollation = c.oid
      WHERE t.relname = 'tasks' AND a.attname = 'rank_key';
    `;
    expect(rankCol).toBeDefined();
    expect(rankCol?.collname).toBe("C");

    // Verify idx_tasks_board index column for rank_key reflects collation "C"
    const [boardIdx] = await testSqlClient`
      SELECT i.relname AS index_name, a.attname, c.collname
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(x.indkey)
      LEFT JOIN pg_collation c ON a.attcollation = c.oid
      WHERE t.relname = 'tasks' AND i.relname = 'idx_tasks_board' AND a.attname = 'rank_key';
    `;
    expect(boardIdx).toBeDefined();
    expect(boardIdx?.collname).toBe("C");
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

  it("Scenario 3: is idempotent and performs no operations when re-run at latest migration (0002)", async () => {
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

  it("Scenario 4: upgrades tasks.rank_key to COLLATE \"C\" preserving existing data, enforcing binary ordering, and supporting rollback", async () => {
    // Read the exact SQL migration files
    const sql0000 = fs.readFileSync(
      path.join(migrationsDir, "0000_futuristic_brood.sql"),
      "utf-8"
    );
    const sql0001 = fs.readFileSync(
      path.join(migrationsDir, "0001_auth_tables.sql"),
      "utf-8"
    );
    const sql0002 = fs.readFileSync(
      path.join(migrationsDir, "0002_task_rank_key_collation.sql"),
      "utf-8"
    );

    // Create an isolated schema to simulate the upgrade and rollback lifecycle
    await testSqlClient`CREATE SCHEMA IF NOT EXISTS "collation_upgrade_test";`;

    try {
      // Step 1: Run 0000 and 0001 statements in the isolated schema
      const statements0000 = sql0000
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      const statements0001 = sql0001
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      await testSqlClient.begin(async (tx) => {
        await tx`SET LOCAL search_path = "collation_upgrade_test", public;`;
        for (const statement of statements0000) {
          await tx.unsafe(statement.replace(/"public"\./g, '"collation_upgrade_test".'));
        }
        for (const statement of statements0001) {
          await tx.unsafe(statement.replace(/"public"\./g, '"collation_upgrade_test".'));
        }
      });

      // Step 2: Seed pre-existing project, column, and tasks prior to migration 0002
      let seedUserId: string;
      let seedProjectId: string;
      let seedColumnId: string;
      let taskZzId: string;
      let taskA0Id: string;
      let taskA1Id: string;

      await testSqlClient.begin(async (tx) => {
        await tx`SET LOCAL search_path = "collation_upgrade_test", public;`;
        const [u] = await tx`
          INSERT INTO "users" (email, display_name)
          VALUES ('collation.user@syncspace.local', 'Collation User')
          RETURNING id;
        `;
        seedUserId = u!.id;

        const [w] = await tx`
          INSERT INTO "workspaces" (name, owner_id)
          VALUES ('Collation Workspace', ${seedUserId})
          RETURNING id;
        `;

        const [p] = await tx`
          INSERT INTO "projects" (workspace_id, name, created_by)
          VALUES (${w!.id}, 'Collation Project', ${seedUserId})
          RETURNING id;
        `;
        seedProjectId = p!.id;

        const [c] = await tx`
          INSERT INTO "project_columns" (project_id, name, position)
          VALUES (${seedProjectId}, 'Backlog', 0)
          RETURNING id;
        `;
        seedColumnId = c!.id;

        // Insert tasks with representative fractional-indexing keys:
        // "Zz" (uppercase prefix from prepend), "a0" (initial key), "a1" (append)
        const [t1] = await tx`
          INSERT INTO "tasks" (project_id, column_id, title, created_by, rank_key)
          VALUES (${seedProjectId}, ${seedColumnId}, 'Task a0', ${seedUserId}, 'a0')
          RETURNING id;
        `;
        taskA0Id = t1!.id;

        const [t2] = await tx`
          INSERT INTO "tasks" (project_id, column_id, title, created_by, rank_key)
          VALUES (${seedProjectId}, ${seedColumnId}, 'Task Zz', ${seedUserId}, 'Zz')
          RETURNING id;
        `;
        taskZzId = t2!.id;

        const [t3] = await tx`
          INSERT INTO "tasks" (project_id, column_id, title, created_by, rank_key)
          VALUES (${seedProjectId}, ${seedColumnId}, 'Task a1', ${seedUserId}, 'a1')
          RETURNING id;
        `;
        taskA1Id = t3!.id;
      });

      // Verify collation before 0002 is default
      const [colBefore] = await testSqlClient`
        SELECT a.attname, c.collname
        FROM pg_attribute a
        JOIN pg_class t ON a.attrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        LEFT JOIN pg_collation c ON a.attcollation = c.oid
        WHERE n.nspname = 'collation_upgrade_test' AND t.relname = 'tasks' AND a.attname = 'rank_key';
      `;
      expect(colBefore?.collname).toBe("default");

      // Step 3: Run migration 0002 in the isolated schema
      const statements0002 = sql0002
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      await testSqlClient.begin(async (tx) => {
        await tx`SET LOCAL search_path = "collation_upgrade_test", public;`;
        for (const statement of statements0002) {
          await tx.unsafe(statement.replace(/"public"\./g, '"collation_upgrade_test".'));
        }
      });

      // Step 4: Verify collation is now "C"
      const [colAfter] = await testSqlClient`
        SELECT a.attname, c.collname
        FROM pg_attribute a
        JOIN pg_class t ON a.attrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        LEFT JOIN pg_collation c ON a.attcollation = c.oid
        WHERE n.nspname = 'collation_upgrade_test' AND t.relname = 'tasks' AND a.attname = 'rank_key';
      `;
      expect(colAfter?.collname).toBe("C");

      // Verify index idx_tasks_board reflects collation "C" on rank_key
      const [idxAfter] = await testSqlClient`
        SELECT i.relname AS index_name, a.attname, c.collname
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(x.indkey)
        LEFT JOIN pg_collation c ON a.attcollation = c.oid
        WHERE n.nspname = 'collation_upgrade_test' AND t.relname = 'tasks'
          AND i.relname = 'idx_tasks_board' AND a.attname = 'rank_key';
      `;
      expect(idxAfter?.collname).toBe("C");

      // Step 5: Verify pre-existing data is strictly intact and ordered by rank_key ASC
      // In ASCII/binary collation "C": "Zz" < "a0" < "a1"
      const orderedRows = await testSqlClient`
        SELECT id, rank_key
        FROM "collation_upgrade_test"."tasks"
        WHERE project_id = ${seedProjectId} AND column_id = ${seedColumnId}
        ORDER BY rank_key ASC, id ASC;
      `;
      expect(orderedRows.map((r) => r.rank_key)).toEqual(["Zz", "a0", "a1"]);
      expect(orderedRows[0]?.id).toBe(taskZzId);
      expect(orderedRows[1]?.id).toBe(taskA0Id);
      expect(orderedRows[2]?.id).toBe(taskA1Id);

      // Step 6: Verify rollback operation
      await testSqlClient`
        ALTER TABLE "collation_upgrade_test"."tasks" ALTER COLUMN "rank_key" TYPE text COLLATE "default";
      `;

      const [colRollback] = await testSqlClient`
        SELECT a.attname, c.collname
        FROM pg_attribute a
        JOIN pg_class t ON a.attrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        LEFT JOIN pg_collation c ON a.attcollation = c.oid
        WHERE n.nspname = 'collation_upgrade_test' AND t.relname = 'tasks' AND a.attname = 'rank_key';
      `;
      expect(colRollback?.collname).toBe("default");

      // Verify data remains intact after rollback
      const rowsAfterRollback = await testSqlClient`
        SELECT rank_key FROM "collation_upgrade_test"."tasks" WHERE id = ${taskZzId};
      `;
      expect(rowsAfterRollback[0]?.rank_key).toBe("Zz");
    } finally {
      await testSqlClient`DROP SCHEMA IF EXISTS "collation_upgrade_test" CASCADE;`;
    }
  });
});
