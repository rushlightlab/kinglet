import fs from "node:fs";
import path from "node:path";

interface DbSizeCache {
  bytes: number | null;
  checkedAt: number;
}

let dbSizeCache: DbSizeCache = { bytes: null, checkedAt: 0 };

/** Size of a local libSQL store, WAL included; null for remote stores. */
export function localDbBytes(dbPath: string): number | null {
  const local = dbPath.toLowerCase().startsWith("file:") ? dbPath.slice(5) : dbPath;

  if (/^(libsql:\/\/|https?:\/\/|wss?:\/\/)/i.test(local)) return null;
  const now = Date.now();

  if (now - dbSizeCache.checkedAt < 30_000) return dbSizeCache.bytes;
  let bytes: number | null = null;

  try {
    const resolved = path.resolve(local);
    bytes = fs.statSync(resolved).size;

    for (const suffix of ["-wal", "-shm"]) {
      try {
        bytes += fs.statSync(resolved + suffix).size;
      } catch {
        // file may not exist
      }
    }
  } catch {
    bytes = null;
  }

  dbSizeCache = { bytes, checkedAt: now };

  return bytes;
}

/** Force the next size check to hit the filesystem (after a large delete). */
export function invalidateDbSizeCache(): void {
  dbSizeCache = { bytes: null, checkedAt: 0 };
}
