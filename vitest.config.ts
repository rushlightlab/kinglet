import { defineConfig } from "vitest/config";

/**
 * Default Vitest configuration: every unit and integration suite. The
 * dedicated unit/integration configs narrow `include` for the root scripts.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/api/test/unit/**/*.test.ts",
      "apps/api/test/integration/**/*.test.ts",
      "packages/*/test/unit/**/*.test.ts",
      "packages/*/test/integration/**/*.test.ts",
      "apps/web/test/unit/**/*.test.ts",
    ],
    // Integration helpers release libSQL file handles with an explicit GC on
    // Windows; see test/helpers/temp.ts.
    execArgv: ["--expose-gc"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["apps/api/src/**/*.ts", "packages/*/src/**/*.ts", "apps/web/src/**/*.ts"],
      exclude: ["**/dist/**", "**/*.d.ts", "apps/api/drizzle/**"],
    },
  },
});
