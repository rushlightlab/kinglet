import type { Storage } from "./storage/index.js";

/**
 * Drops events older than KINGLET_RETENTION_DAYS (default 14).
 * Runs at boot and hourly after, deleting in 10k chunks so ingest is never
 * blocked for long, then lets the store do its housekeeping (vacuum).
 */
export function startRetentionJob(storage: Storage, retentionDays: number): void {
  const run = (): void => {
    void (async () => {
      try {
        const cutoff = Date.now() - retentionDays * 86_400_000;
        const deleted = await storage.deleteOlderThan(cutoff);
        if (deleted > 0) {
          await storage.runMaintenance();
          console.log(`[kinglet] retention: deleted ${deleted} events older than ${retentionDays}d`);
        }
      } catch (err) {
        console.warn("[kinglet] retention job failed:", err instanceof Error ? err.message : err);
      }
    })();
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
}
