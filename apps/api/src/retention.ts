import type { Storage } from "./storage/index.js";
import { invalidateDbSizeCache } from "./storage/db-size.js";
import { systemStatus } from "./status.js";

/**
 * Drops events older than KINGLET_RETENTION_DAYS (default 14).
 * Runs at boot and hourly after, deleting in 10k chunks so ingest is never
 * blocked for long. Status is tracked for /healthz.
 */
export function startRetentionJob(
  storage: Storage,
  retentionDays: number,
  alertRetentionDays: number,
): void {
  let running = false;

  const run = (): void => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        const now = Date.now();
        const deleted = await storage.deleteOlderThan(now - retentionDays * 86_400_000);

        const alertsDeleted = await storage.deleteAlertsOlderThan(
          now - alertRetentionDays * 86_400_000,
        );

        systemStatus.retentionLastRunAt = Date.now();
        systemStatus.retentionLastError = null;

        if (deleted > 0 || alertsDeleted > 0) {
          invalidateDbSizeCache();
          await storage.runMaintenance();
          console.log(
            `[kinglet] retention: deleted ${deleted} events older than ${retentionDays}d` +
              (alertsDeleted > 0
                ? ` and ${alertsDeleted} alerts older than ${alertRetentionDays}d`
                : ""),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        systemStatus.retentionLastRunAt = Date.now();
        systemStatus.retentionLastError = message;
        console.warn("[kinglet] retention job failed:", message);
      } finally {
        running = false;
      }
    })();
  };

  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
}
