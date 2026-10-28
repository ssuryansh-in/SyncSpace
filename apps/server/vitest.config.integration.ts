import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
    passWithNoTests: true,
  },
});
