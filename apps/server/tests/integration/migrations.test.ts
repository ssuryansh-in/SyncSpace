import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { testSqlClient, validateTestDatabaseUrl } from "./setup.js";

describe("Database Migration Pipeline (Integration)", () => {
  it("enables the citext extension in PostgreSQL", async () => {
    const extensions = await testSqlClient`
      SELECT extname FROM pg_extension WHERE extname = 'citext';
    `;
    expect(extensions.length).toBe(1);
    expect(extensions[0]?.extname).toBe("citext");
  });

  it("is idempotent and succeeds when run repeatedly", async () => {
    const testUrl = validateTestDatabaseUrl();
    await expect(runMigrations(testUrl)).resolves.not.toThrow();
  });
});
