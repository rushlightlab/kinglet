import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../env.js";
import { isString } from "../json.js";

/**
 * Filesystem and database helpers shared by restore staging and the boot swap.
 * Everything here is scoped to a caller-provided path; no helper logs or
 * returns more than the caller already knows.
 */

export interface DatabaseCheck {
  integrityOk: boolean;
  /** Value from app_meta, or null when the table/row is absent. */
  schemaVersion: number | null;
}

/**
 * Absolute local SQLite path, or null when the configured database is remote
 * (libSQL/Turso) or in-memory. Restore never runs against remote storage.
 */
export function localDatabasePath(config: Config): string | null {
  const lower = config.dbPath.toLowerCase();

  if (
    lower.startsWith("libsql:") ||
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("ws://") ||
    lower.startsWith("wss://")
  ) {
    return null;
  }

  const local = lower.startsWith("file:") ? config.dbPath.slice(5) : config.dbPath;

  if (local === ":memory:" || local.startsWith(":memory:")) return null;

  return path.resolve(local);
}

export interface DatabaseSidecars {
  wal: string;
  shm: string;
}

export function databaseSidecarPaths(databasePath: string): DatabaseSidecars {
  return { wal: `${databasePath}-wal`, shm: `${databasePath}-shm` };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);

    return true;
  } catch {
    return false;
  }
}

export async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.promises.stat(filePath)).size;
  } catch {
    return 0;
  }
}

export async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch {
    // Cleanup is best-effort; the original failure is the useful one.
  }
}

/**
 * Move a file onto a destination path. POSIX rename replaces atomically;
 * Windows refuses to rename over an existing file, so retry after removing the
 * destination. A cross-device rename falls back to copy + delete.
 */
export async function moveFileOver(source: string, destination: string): Promise<void> {
  try {
    await fs.promises.rename(source, destination);

    return;
  } catch {
    // Windows EPERM/EEXIST, or a destination that must be replaced.
  }

  await fs.promises.rm(destination, { force: true });

  try {
    await fs.promises.rename(source, destination);
  } catch {
    await fs.promises.copyFile(source, destination);
    await fs.promises.rm(source, { force: true });
  }
}

export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

  await fs.promises.writeFile(temporaryPath, contents, { mode: 0o600 });

  try {
    await moveFileOver(temporaryPath, filePath);
  } finally {
    await removeFile(temporaryPath);
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

/**
 * Run SQLite's full integrity check and read the stored schema version from a
 * staged database. The caller opens the file before it becomes live, so a
 * failure here never touches production data.
 */
export async function inspectDatabase(filePath: string): Promise<DatabaseCheck> {
  // node:sqlite closes synchronously; a libSQL client can keep a Windows file
  // handle alive briefly, which breaks the staged-file rename at boot.
  const database = new DatabaseSync(filePath, { timeout: 5000 });

  try {
    const integrity = database.prepare("PRAGMA integrity_check").all();
    const integrityOk = integrity[0]?.integrity_check === "ok";
    let schemaVersion: number | null = null;

    if (integrityOk) {
      try {
        const meta = database
          .prepare("SELECT value FROM app_meta WHERE key = ?")
          .get("schema_version");

        const raw = meta?.value;

        if (isString(raw)) {
          const parsed = Number.parseInt(raw, 10);

          if (Number.isSafeInteger(parsed) && parsed > 0) schemaVersion = parsed;
        }
      } catch {
        // Older snapshots may predate app_meta; migrations decide compatibility.
      }
    }

    return { integrityOk, schemaVersion };
  } finally {
    database.close();
  }
}
