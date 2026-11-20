import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-test-file scratch directory with a SQLite database path. Tests must call
 * `cleanup()` after closing storage; nothing here touches `apps/api/data`.
 */
export interface TempDatabase {
  /** Directory that also serves as the test `dataDir`. */
  directory: string;
  /** Plain SQLite file path, accepted by `createStorage`. */
  dbPath: string;
  cleanup(): Promise<void>;
}

export function createTempDatabase(prefix = "kinglet-test-"): TempDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  return {
    directory,
    dbPath: path.join(directory, "kinglet.db"),
    async cleanup() {
      // libSQL statements are finalized by GC. Without an explicit collection
      // Windows keeps the SQLite handle open for ~25s and the temp directory
      // cannot be removed. The integration Vitest config runs workers with
      // --expose-gc for this call; when unavailable the rm retries and then
      // fails loudly instead of hanging the suite.
      globalThis.gc?.();
      globalThis.gc?.();

      await fs.promises.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    },
  };
}
