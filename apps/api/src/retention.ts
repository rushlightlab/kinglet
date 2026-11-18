import type { DatabaseType } from "./db.js";
import { deleteOlderThan } from "./events.js";

/**
 * Drops events older than KINGLET_RETENTION_DAYS (default 14).
 * Runs at boot and hourly after, deleting in 10k chunks so ingest is never
 * blocked for long, then returns the freed pages to SQLite.
 */
export function startRetentionJob(db: DatabaseType, retentionDays: number): void {
  const run = (): void => {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const deleted = deleteOlderThan(db, cutoff);
    if (deleted > 0) {
      db.pragma("incremental_vacuum(512)");
      console.log(`[kinglet] retention: deleted ${deleted} events older than ${retentionDays}d`);
    }
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
}
