/**
 * Validates that TEST_DATABASE_URL is explicitly defined and strictly adheres to
 * safety policies (dedicated test database, loopback host, distinct from dev database).
 */
export function validateTestDatabaseUrl(): string {
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) {
    throw new Error(
      "Safety check failed: TEST_DATABASE_URL is not set. Integration tests require an explicit dedicated test database."
    );
  }

  let parsedTestUrl: URL;
  try {
    parsedTestUrl = new URL(url);
  } catch {
    throw new Error("Safety check failed: TEST_DATABASE_URL is not a valid URL.");
  }

  if (parsedTestUrl.protocol !== "postgres:" && parsedTestUrl.protocol !== "postgresql:") {
    throw new Error(
      `Safety check failed: TEST_DATABASE_URL protocol must be postgres: or postgresql:, got: ${parsedTestUrl.protocol}`
    );
  }

  const testHost = parsedTestUrl.hostname.toLowerCase();
  if (testHost !== "localhost" && testHost !== "127.0.0.1" && testHost !== "::1") {
    throw new Error(
      `Safety check failed: TEST_DATABASE_URL must target a local loopback address, got: ${testHost}`
    );
  }

  const testDbName = parsedTestUrl.pathname.replace(/^\//, "");
  if (!testDbName.endsWith("_test") && testDbName !== "test") {
    throw new Error(
      `Safety check failed: TEST_DATABASE_URL database name must end in '_test', got: ${testDbName}`
    );
  }

  const devUrl = process.env["DATABASE_URL"];
  if (devUrl) {
    try {
      const parsedDevUrl = new URL(devUrl);
      const devDbName = parsedDevUrl.pathname.replace(/^\//, "");
      if (devDbName === testDbName) {
        throw new Error(
          `Safety violation: TEST_DATABASE_URL database name ('${testDbName}') matches DATABASE_URL ('${devDbName}'). Integration tests must use a distinct database!`
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("Safety violation")) throw e;
    }
  }

  return url;
}
