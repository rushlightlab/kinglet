import fs from "node:fs";
import path from "node:path";

/**
 * Shared on-disk state between Playwright's global setup, the setup project,
 * and the test files. The directory is gitignored and removed by global
 * teardown.
 */

export interface SeedState {
  baseURL: string;
  runId: string;
  projects: {
    defaultId: string;
    stagingId: string;
  };
  /** Plaintext for the seeded ingest/query key. Test-only, never logged. */
  apiKey: string;
}

export const E2E_DIR = path.join(process.cwd(), ".e2e");
export const ADMIN_STATE_PATH = path.join(E2E_DIR, "admin.json");
export const MEMBER_STATE_PATH = path.join(E2E_DIR, "member.json");
export const SEED_PATH = path.join(E2E_DIR, "seed.json");
export const SERVER_STATE_PATH = path.join(E2E_DIR, "server.json");

export function readSeed(): SeedState {
  const raw = fs.readFileSync(SEED_PATH, "utf8");
  const seed: SeedState = JSON.parse(raw);

  return seed;
}
