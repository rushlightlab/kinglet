import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createAuth } from "./auth/auth.ts";
import { ensureBootstrapAdmin, ensureSchemaExtras } from "./auth/setup.ts";
import { isRemoteDbPath, loadConfig } from "./env.ts";
import type { Config } from "./env.ts";
import { startArchiveEngine } from "./archive/engine.ts";
import { listArchiveEnabledProjectIds } from "./archive/settings.ts";
import { startBackupEngine } from "./backups/engine.ts";
import { startMonitorEngine } from "./monitors.ts";
import { sealStoredSecrets } from "./notifications/store.ts";
import { configureSecrets } from "./secrets.ts";
import { notifyAction, startNotificationEngine } from "./notifications/engine.ts";
import { finalizePendingRestore, preparePendingRestore } from "./restore/boot.ts";
import { startRetentionJob } from "./retention.ts";
import { createStorage } from "./storage/index.ts";
import type { Storage } from "./storage/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Secret files (token, admin password, auth secret) and the database should
// not be world-readable by default.
process.umask(0o077);

// A stray rejected promise must never take the log platform down.
process.on("unhandledRejection", (reason) => {
  console.error("[kinglet] unhandled promise rejection:", reason);
});

async function main(): Promise<void> {
  const config = loadConfig();

  // Before anything reads a stored channel secret.
  configureSecrets(config.secretKey);

  if (config.secretKey === null) {
    console.warn(
      "[kinglet] KINGLET_SECRET_KEY is not set: notification channels can't be added or changed, and any existing channel secrets stay unencrypted. Generate one with: openssl rand -base64 32",
    );
  }

  // Must run before the live database is opened: applies a staged restore.
  const restoreBoot = await preparePendingRestore(config);

  if (restoreBoot.applied) {
    console.log(
      `[kinglet] applied staged restore ${restoreBoot.snapshotId ?? "unknown"}` +
        (restoreBoot.preRestorePath ? `; pre-restore copy: ${restoreBoot.preRestorePath}` : ""),
    );
  }

  const storage = await createStorage({
    kind: config.storageKind,
    dbPath: config.dbPath,
    authToken: config.dbAuthToken,
    search: config.searchMode,
  });

  await ensureSchemaExtras(storage, config.timezone);
  await finalizePendingRestore(storage, config);

  if (config.backupProblem) {
    console.warn(`[kinglet] backup S3 is not configured: ${config.backupProblem}`);
  }

  const auth = createAuth(storage.db, {
    baseUrl: config.baseUrl,
    port: config.port,
    secret: config.authSecret,
    trustedProxies: config.trustedProxies,
    sessionDays: config.sessionDays,
  });

  const bootstrap = await ensureBootstrapAdmin(storage, config, auth);

  // Encrypt secrets stored before a key was set (or before encryption existed).
  try {
    await sealStoredSecrets(storage);
  } catch (err) {
    console.warn(
      "[kinglet] could not encrypt stored channel secrets:",
      err instanceof Error ? err.message : err,
    );
  }

  // Start notifications before the monitor engine so legacy monitor channels
  // are linked before the first refresh. A migration failure must not take
  // logging down; monitors fall back to inline channels.
  const notificationEngine = startNotificationEngine({ storage, config });

  try {
    await notificationEngine.ready;
  } catch (err) {
    console.warn(
      "[kinglet] notification migration failed:",
      err instanceof Error ? err.message : err,
    );
  }

  const monitorEngine = startMonitorEngine(storage, {
    baseUrl: config.baseUrl,
    allowPrivateWebhooks: config.allowPrivateWebhooks,
    smtp: config.smtp,
    dbPath: config.dbPath,
    maxDbBytes: config.maxDbBytes,
  });

  const backupEngine = startBackupEngine({ storage, config });
  const archiveEngine = startArchiveEngine({ storage, config });

  const app = createApp({
    storage,
    config,
    auth,
    engines: {
      monitor: monitorEngine,
      notification: notificationEngine,
      backup: backupEngine,
      archive: archiveEngine,
    },
    onRestoreStaged: () => {
      // Let the 202 flush, then exit so a supervisor restarts into the swap.
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 500).unref();
    },
  });

  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: config.host,
      // Node's 300 s default would let a slow upload hold its buffered body
      // for five minutes; 60 s still allows an 8 MiB batch at ~140 KB/s.
      // Live tail is unaffected: these limits cover receiving the request,
      // not how long the response streams.
      serverOptions: { requestTimeout: 60_000, headersTimeout: 20_000 },
    },
    () => printBanner(config, storage, bootstrap),
  );

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error("");
    console.error(`  ✖ Kinglet could not listen on port ${config.port}: ${err.message}`);
    console.error("    Is another process using that port? Set KINGLET_PORT to change it.");
    console.error("");
    // Fire-and-forget cleanup: the process exits once the store closes.
    // oxlint-disable-next-line promise/no-promise-in-callback
    void storage.close().finally(() => process.exit(1));
  });
  startRetentionJob(storage, config.retentionDays, config.alertRetentionDays, {
    // Archive can only own deletion when S3 is configured. If the operator
    // removes S3 after enabling archive, retention must not keep skipping the
    // project and letting events accumulate forever.
    excludedProjectIds: () =>
      config.backup === null ? Promise.resolve([]) : listArchiveEnabledProjectIds(storage),
    onWarning: (message) => {
      void notifyAction(storage, config, {
        action: "system.warning",
        subject: "Retention warning",
        summary: message,
      }).catch(() => {
        console.warn("[kinglet] system warning notification failed");
      });
    },
  });

  const shutdown = (): void => {
    console.log("[kinglet] shutting down…");
    monitorEngine.stop();
    notificationEngine.stop();
    backupEngine.stop();
    archiveEngine.stop();
    server.close();
    void storage.close().finally(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("");
  console.error("  ✖ Kinglet failed to start");
  console.error("");
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  console.error("");
  console.error("  If this is a database from an older Kinglet version, back it up and");
  console.error("  start Kinglet again — schema migrations run automatically on boot.");
  process.exit(1);
});

function printBanner(
  config: Config,
  storage: Storage,
  bootstrap: { adminEmail: string; generatedPassword: string | null } | null,
): void {
  const uiBuilt = fs.existsSync(path.resolve(__dirname, "../../web/dist"));
  console.log("");
  console.log("  👑 Kinglet — small. light. king.");
  console.log("");
  console.log(`  API listening → http://localhost:${config.port}`);
  console.log(`  Ingest        → POST /v1/events   (project API key)`);

  if (uiBuilt) console.log(`  UI            → http://localhost:${config.port}`);
  else console.log(`  UI            → not built; run "pnpm --filter @kinglet/web dev"`);
  console.log(`  Storage       → ${storage.description}`);

  if (bootstrap) {
    console.log(`  Admin         → ${bootstrap.adminEmail}`);

    if (bootstrap.generatedPassword) {
      console.log(`  Admin password→ ${bootstrap.generatedPassword}`);

      if (!isRemoteDbPath(config.dbPath)) {
        console.log(
          `                  also written to ${path.join(config.dataDir, "admin-password.txt")}`,
        );
      }
    }
  }

  console.log("");
}
