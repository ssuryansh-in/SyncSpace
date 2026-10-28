import { describe, expect, it } from "vitest";
import { validateTestDatabaseUrl } from "./integration/safety.js";

describe("Integration Test Safety Guard", () => {
  it("throws when TEST_DATABASE_URL is not set", () => {
    const origTest = process.env["TEST_DATABASE_URL"];
    delete process.env["TEST_DATABASE_URL"];

    try {
      expect(() => validateTestDatabaseUrl()).toThrow(/TEST_DATABASE_URL is not set/);
    } finally {
      if (origTest !== undefined) {
        process.env["TEST_DATABASE_URL"] = origTest;
      }
    }
  });

  it("throws when TEST_DATABASE_URL is non-loopback host", () => {
    const origTest = process.env["TEST_DATABASE_URL"];
    process.env["TEST_DATABASE_URL"] =
      "postgres://syncspace:pass@remote-postgres.internal:5432/syncspace_test";

    try {
      expect(() => validateTestDatabaseUrl()).toThrow(/local loopback/);
    } finally {
      if (origTest !== undefined) {
        process.env["TEST_DATABASE_URL"] = origTest;
      } else {
        delete process.env["TEST_DATABASE_URL"];
      }
    }
  });

  it("throws when TEST_DATABASE_URL database name does not end in _test", () => {
    const origTest = process.env["TEST_DATABASE_URL"];
    process.env["TEST_DATABASE_URL"] =
      "postgres://syncspace:pass@127.0.0.1:5432/syncspace_production";

    try {
      expect(() => validateTestDatabaseUrl()).toThrow(/must end in '_test'/);
    } finally {
      if (origTest !== undefined) {
        process.env["TEST_DATABASE_URL"] = origTest;
      } else {
        delete process.env["TEST_DATABASE_URL"];
      }
    }
  });

  it("throws when TEST_DATABASE_URL matches DATABASE_URL", () => {
    const origTest = process.env["TEST_DATABASE_URL"];
    const origDev = process.env["DATABASE_URL"];

    process.env["DATABASE_URL"] =
      "postgres://syncspace:pass@127.0.0.1:5432/syncspace_test";
    process.env["TEST_DATABASE_URL"] =
      "postgres://syncspace:pass@127.0.0.1:5432/syncspace_test";

    try {
      expect(() => validateTestDatabaseUrl()).toThrow(/Safety violation/);
    } finally {
      if (origTest !== undefined) {
        process.env["TEST_DATABASE_URL"] = origTest;
      } else {
        delete process.env["TEST_DATABASE_URL"];
      }
      if (origDev !== undefined) {
        process.env["DATABASE_URL"] = origDev;
      } else {
        delete process.env["DATABASE_URL"];
      }
    }
  });
});
