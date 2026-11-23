import os from "node:os";
import type { Config } from "../../src/env.ts";

export const TEST_ADMIN_EMAIL = "admin@example.test";
export const TEST_ADMIN_PASSWORD = "TestPass123!";

/** Deterministic signing key; never reuse this value outside tests. */
const TEST_AUTH_SECRET = "kinglet-test-auth-secret-0123456789abcdef0123456789abcdef";

/**
 * A complete `Config` for tests. Callers normally override `dbPath` and
 * `dataDir` with a temporary directory from `createTempDatabase`.
 */
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    dbPath: ":memory:",
    storageKind: "sqlite",
    searchMode: "substring",
    baseUrl: "http://localhost:3000",
    allowPrivateWebhooks: false,
    smtp: null,
    // A fixed test key so channel secrets are sealed like production.
    secretKey: Buffer.from("kinglet-test-secret-key-0123456789abcdef", "utf8"),
    mcpAllowMonitorWrites: false,
    authSecret: TEST_AUTH_SECRET,
    trustedProxies: [],
    dataDir: os.tmpdir(),
    retentionDays: 14,
    alertRetentionDays: 7,
    sessionDays: 30,
    maxEventsPerProject: 10_000,
    maxProjectBytes: 16 * 1024 * 1024,
    maxDbBytes: 128 * 1024 * 1024,
    adminEmail: TEST_ADMIN_EMAIL,
    adminPassword: TEST_ADMIN_PASSWORD,
    timezone: "UTC",
    backup: null,
    backupProblem: null,
    ...overrides,
  };
}
