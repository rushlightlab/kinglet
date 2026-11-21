import { defineConfig } from "vitest/config";

/**
 * Integration suites: real temporary SQLite databases through the app seam.
 * Each test file owns and removes its own temp directory. Loopback-only HTTP
 * sockets are allowed for machine-contract tests; nothing may call out.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/api/test/integration/**/*.test.ts", "packages/*/test/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // libSQL on Windows keeps SQLite file handles until a statement finalizer
    // runs. Expose GC so `createTempDatabase().cleanup()` can release them
    // before removing the temp directory; see test/helpers/temp.ts.
    execArgv: ["--expose-gc"],
  },
});
