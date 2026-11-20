import { defineConfig } from "vitest/config";

/**
 * Fast, database-free unit suites. Tests must not open a socket or a database;
 * use the integration config when real storage is required.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/api/test/unit/**/*.test.ts",
      "packages/*/test/unit/**/*.test.ts",
      "apps/web/test/unit/**/*.test.ts",
    ],
    testTimeout: 10_000,
  },
});
