import { count, desc, eq } from "drizzle-orm";
import { Cron } from "croner";
import { Encrypter } from "age-encryption";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import { uuidv7 } from "../auth/ids.js";
import type { Config } from "../env.js";
import { isFiniteNumber, isString } from "../json.js";
import { createCronScheduler, describeCron, validateCron } from "../schedule.js";
import type { CronScheduler, CronValidation } from "../schedule.js";
import { publishSystemEvent } from "../system-events.js";
import type { BackupPhase, BackupTrigger } from "../system-events.js";
import { SCHEMA_VERSION } from "../storage/schema.js";
import * as schema from "../storage/schema.js";
import type { Storage } from "../storage/index.js";
import { APP_VERSION } from "../version.js";
import {
  buildManifest,
  countsToJson,
  parseCountsJson,
  parseManifest,
  serializeManifest,
  MAX_MANIFEST_BYTES,
} from "./manifest.js";
import { BackupStore, describeBackupError } from "./s3.js";
import { BackupError } from "./types.js";
import type {
  BackupCounts,
  BackupDownload,
  BackupEncryption,
  BackupSettings,
  BackupSnapshot,
  BackupSnapshotState,
  BackupSnapshotTrigger,
  BackupStatus,
} from "./types.js";

export type { BackupSettings, BackupSnapshot, BackupStatus } from "./types.js";

export { BackupError } from "./types.js";

/**
 * Backup engine: a single-flight snapshot pipeline plus a cron scheduler and a
 * bucket-backed cache. The bucket is the source of truth; backup_snapshots is a
 * disposable cache for the UI. Nothing here runs unless S3 is configured and
 * storage is local SQLite.
 */

const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];
const AUTO_REFRESH_MS = 60_000;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60_000;
const PROGRESS_STEP_BYTES = 1_048_576;
const MIN_RETENTION = 2;
const MAX_RETENTION = 365;
const CATCH_UP_DELAY_MS = 1_500;

const SETUP_VARS = [
  "KINGLET_BACKUP_S3_BUCKET",
  "KINGLET_BACKUP_S3_ENDPOINT",
  "KINGLET_BACKUP_S3_ACCESS_KEY_ID",
  "KINGLET_BACKUP_S3_SECRET_ACCESS_KEY",
] as const;

export interface BackupEngine {
  readonly configured: boolean;
  readonly supported: boolean;
  status(): Promise<BackupStatus>;
  getSettings(): Promise<BackupSettings>;
  updateSettings(input: {
    enabled?: boolean;
    scheduleCron?: string;
    scheduleTimezone?: string;
    retentionCount?: number;
  }): Promise<BackupSettings>;
  preview(input: { cron: string; timezone: string }): CronValidation;
  run(trigger: BackupTrigger): Promise<BackupRunHandle>;
  list(): Promise<BackupSnapshot[]>;
  refresh(): Promise<void>;
  remove(id: string): Promise<void>;
  download(id: string, userId: string): Promise<BackupDownload>;
  testConnection(): Promise<void>;
  stop(): void;
}

export interface BackupRunHandle {
  runId: string;
}

interface HashSink {
  stream: Transform;
  finish: () => FileDigest;
}

interface ActiveRun {
  readonly runId: string;
  readonly trigger: BackupTrigger;
  phase: BackupPhase | null;
}

interface EngineState {
  activeRun: ActiveRun | null;
  scheduler: CronScheduler | null;
  refreshPromise: Promise<void> | null;
  lastRefreshAt: number | null;
  lastRefreshAttemptAt: number | null;
  lastRefreshError: string | null;
  retryTimer: NodeJS.Timeout | null;
  retryAttempt: number;
  catchUpTimer: NodeJS.Timeout | null;
  stopped: boolean;
}

interface TempPaths {
  snapshot: string;
  compressed: string;
  encrypted: string;
}

interface FileDigest {
  bytes: number;
  sha256: string;
}

export function startBackupEngine(options: { storage: Storage; config: Config }): BackupEngine {
  return createEngine(options.storage, options.config);
}

function createEngine(storage: Storage, config: Config): BackupEngine {
  const configured = config.backup !== null;
  const supported = storage.kind === "sqlite";
  let store: BackupStore | null = null;
  let storeProblem: string | null = null;

  if (config.backup !== null && supported) {
    try {
      store = new BackupStore(config.backup);
    } catch (cause) {
      storeProblem = `S3 client could not be initialized: ${describeBackupError(cause)}`;
      console.warn("[kinglet]", storeProblem);
    }
  }

  const setupMissing = resolveSetupMissing(config);
  const problem = resolveProblem(config, supported, storeProblem);

  const state: EngineState = {
    activeRun: null,
    scheduler: null,
    refreshPromise: null,
    lastRefreshAt: null,
    lastRefreshAttemptAt: null,
    lastRefreshError: null,
    retryTimer: null,
    retryAttempt: 0,
    catchUpTimer: null,
    stopped: false,
  };

  let schedulerGeneration = 0;

  function requireStore(): BackupStore {
    if (!configured) throw new BackupError("S3 backups are not configured", 409);

    if (!supported) throw new BackupError("backups require local SQLite storage", 409);

    if (store === null) throw new BackupError(storeProblem ?? "S3 backups are not configured", 409);

    return store;
  }

  async function readSettings(): Promise<BackupSettings> {
    const rows = await storage.db
      .select()
      .from(schema.backupSettings)
      .where(eq(schema.backupSettings.id, 1))
      .limit(1);

    const row = rows[0];

    if (row !== undefined) return rowToSettings(row);

    await storage.db
      .insert(schema.backupSettings)
      .values({ id: 1, scheduleTimezone: config.timezone, updatedAt: Date.now() })
      .onConflictDoNothing();

    const created = await storage.db
      .select()
      .from(schema.backupSettings)
      .where(eq(schema.backupSettings.id, 1))
      .limit(1);

    const createdRow = created[0];

    if (createdRow === undefined)
      throw new BackupError("could not initialize backup settings", 500);

    return rowToSettings(createdRow);
  }

  async function updateSettings(input: {
    enabled?: boolean;
    scheduleCron?: string;
    scheduleTimezone?: string;
    retentionCount?: number;
  }): Promise<BackupSettings> {
    const current = await readSettings();
    let cron = current.scheduleCron;
    let timezone = current.scheduleTimezone;

    if (input.scheduleCron !== undefined || input.scheduleTimezone !== undefined) {
      const validation = validateCron(
        input.scheduleCron ?? current.scheduleCron,
        input.scheduleTimezone ?? current.scheduleTimezone,
      );

      if (!validation.ok) throw new BackupError(validation.error, 400);

      cron = validation.cron;
      timezone = input.scheduleTimezone ?? current.scheduleTimezone;
    }

    let retention = current.retentionCount;

    if (input.retentionCount !== undefined) {
      if (
        !Number.isInteger(input.retentionCount) ||
        input.retentionCount < MIN_RETENTION ||
        input.retentionCount > MAX_RETENTION
      ) {
        throw new BackupError(
          `retentionCount must be an integer between ${MIN_RETENTION} and ${MAX_RETENTION}`,
          400,
        );
      }

      retention = input.retentionCount;
    }

    await storage.db
      .update(schema.backupSettings)
      .set({
        enabled: input.enabled ?? current.enabled,
        scheduleCron: cron,
        scheduleTimezone: timezone,
        retentionCount: retention,
        updatedAt: Date.now(),
      })
      .where(eq(schema.backupSettings.id, 1));
    const updated = await readSettings();

    await armScheduler();

    return updated;
  }

  async function run(trigger: BackupTrigger): Promise<BackupRunHandle> {
    return startRun(trigger);
  }

  function startRun(trigger: BackupTrigger): BackupRunHandle {
    const activeStore = requireStore();

    if (state.activeRun !== null) throw new BackupError("a backup is already running", 409);

    const runId = uuidv7();

    state.activeRun = { runId, trigger, phase: null };
    publishSystemEvent({ type: "backup.queued", data: { runId, trigger } });
    void executeRun(runId, trigger, activeStore).catch((cause) => {
      console.warn(
        `[kinglet] backup run ${runId} failed unexpectedly:`,
        describeBackupError(cause),
      );

      if (state.activeRun?.runId === runId) state.activeRun = null;
    });

    return { runId };
  }

  async function executeRun(
    runId: string,
    trigger: BackupTrigger,
    activeStore: BackupStore,
  ): Promise<void> {
    const startedAt = Date.now();
    const tempPaths = tempPathsFor(config.dataDir, runId);
    let phase: BackupPhase = "snapshot";
    let objectKey: string | null = null;
    let objectUploaded = false;
    let manifestUploaded = false;
    let runRecorded = false;

    try {
      await storage.db.insert(schema.backupRuns).values({
        id: runId,
        trigger,
        status: "running",
        phase,
        startedAt,
      });
      runRecorded = true;
      publishSystemEvent({ type: "backup.started", data: { runId, trigger } });
      setPhase(runId, phase);

      await fs.promises.mkdir(path.dirname(tempPaths.snapshot), {
        recursive: true,
        mode: 0o700,
      });

      const liveDatabasePath = localDatabasePath(config);
      const liveDatabaseBytes = liveDatabasePath === null ? 0 : await fileSize(liveDatabasePath);

      await assertFreeDisk(liveDatabaseBytes);

      await removeFile(tempPaths.snapshot);
      const escapedPath = escapeSqlLiteral(tempPaths.snapshot);

      await storage.client.execute(`VACUUM INTO '${escapedPath}'`);
      const snapshotBytes = await fileSize(tempPaths.snapshot);

      if (snapshotBytes === 0) throw new BackupError("database snapshot is empty", 500);

      phase = "compress";
      setPhase(runId, phase);

      const compressed = await compressSnapshot(
        tempPaths.snapshot,
        tempPaths.compressed,
        snapshotBytes,
        runId,
      );

      await removeFile(tempPaths.snapshot);

      let finalPath = tempPaths.compressed;
      let finalBytes = compressed.bytes;
      let finalSha256 = compressed.sha256;
      let encryption: BackupEncryption = "none";
      const passphrase = config.backup?.passphrase;

      if (passphrase !== undefined) {
        phase = "encrypt";
        setPhase(runId, phase);

        const encrypted = await encryptSnapshot(
          tempPaths.compressed,
          tempPaths.encrypted,
          passphrase,
          compressed.bytes,
          runId,
        );

        await removeFile(tempPaths.compressed);
        finalPath = tempPaths.encrypted;
        finalBytes = encrypted.bytes;
        finalSha256 = encrypted.sha256;
        encryption = "age";
      }

      const manifestCounts = await readCounts();
      const schemaVersion = await readSchemaVersion();
      const snapshotId = uuidv7();
      const fullObjectKey = activeStore.objectKey(snapshotId, encryption);

      objectKey = fullObjectKey;

      phase = "upload";
      setPhase(runId, phase);
      reportProgress(runId, phase, 0, finalBytes);
      await activeStore.uploadFile({
        key: fullObjectKey,
        filePath: finalPath,
        sizeBytes: finalBytes,
        sha256: finalSha256,
        onProgress: (done, total) => reportProgress(runId, "upload", done, total),
      });
      objectUploaded = true;

      phase = "verify";
      setPhase(runId, phase);
      const head = await activeStore.headObject(fullObjectKey);

      if (head.ContentLength !== finalBytes) {
        throw new BackupError("uploaded object size did not match", 502);
      }

      if ((head.Metadata?.sha256 ?? "").toLowerCase() !== finalSha256) {
        throw new BackupError("uploaded object checksum did not match", 502);
      }

      const manifest = buildManifest({
        id: snapshotId,
        createdAt: Date.now(),
        appVersion: APP_VERSION,
        schemaVersion,
        sizeBytes: snapshotBytes,
        objectBytes: finalBytes,
        sha256: finalSha256,
        encryption,
        counts: manifestCounts,
      });

      const manifestKey = activeStore.manifestKey(snapshotId);

      await activeStore.putManifest(manifestKey, serializeManifest(manifest));
      manifestUploaded = true;

      await storage.db.insert(schema.backupSnapshots).values({
        id: snapshotId,
        runId,
        trigger,
        manifestKey,
        objectKey: fullObjectKey,
        createdAt: manifest.createdAt,
        sizeBytes: manifest.sizeBytes,
        sha256: manifest.sha256,
        encryption: manifest.encryption,
        appVersion: manifest.appVersion,
        schemaVersion: manifest.schemaVersion,
        countsJson: countsToJson(manifest.counts),
        state: "ready",
        downloadedAt: null,
        downloadedBy: null,
        discovered: false,
      });

      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;

      await storage.db
        .update(schema.backupRuns)
        .set({
          status: "succeeded",
          phase: null,
          finishedAt,
          sizeBytes: finalBytes,
          error: null,
        })
        .where(eq(schema.backupRuns.id, runId));

      clearRetry();
      state.retryAttempt = 0;
      publishSystemEvent({
        type: "backup.succeeded",
        data: { runId, id: snapshotId, sizeBytes: finalBytes, durationMs },
      });

      phase = "retention";
      setPhase(runId, phase);

      try {
        await applyRetention(activeStore);
      } catch (cause) {
        console.warn("[kinglet] backup retention failed:", describeBackupError(cause));
      }

      try {
        await cleanupOrphans(activeStore);
      } catch (cause) {
        console.warn("[kinglet] backup orphan cleanup failed:", describeBackupError(cause));
      }
    } catch (cause) {
      const message = describeBackupError(cause);

      console.warn(`[kinglet] backup failed during ${phase}: ${message}`);

      if (objectUploaded && !manifestUploaded && objectKey !== null) {
        try {
          await activeStore.deleteObject(objectKey);
        } catch {
          // The object has no manifest, so the orphan sweep will retry later.
        }
      }

      try {
        if (runRecorded) {
          await storage.db
            .update(schema.backupRuns)
            .set({ status: "failed", phase, finishedAt: Date.now(), error: message })
            .where(eq(schema.backupRuns.id, runId));
        } else {
          await storage.db.insert(schema.backupRuns).values({
            id: runId,
            trigger,
            status: "failed",
            phase,
            startedAt,
            finishedAt: Date.now(),
            error: message,
          });
        }
      } catch (updateCause) {
        console.warn(
          "[kinglet] could not record backup failure:",
          describeBackupError(updateCause),
        );
      }

      publishSystemEvent({ type: "backup.failed", data: { runId, phase, error: message } });

      if (trigger === "scheduled" || trigger === "catch-up") scheduleRetry();
    } finally {
      await cleanupTempFiles(tempPaths);

      if (state.activeRun?.runId === runId) state.activeRun = null;
    }
  }

  async function list(): Promise<BackupSnapshot[]> {
    if (configured && supported) {
      const now = Date.now();
      const stale = state.lastRefreshAt === null || now - state.lastRefreshAt > AUTO_REFRESH_MS;

      const canAttempt =
        state.lastRefreshAttemptAt === null || now - state.lastRefreshAttemptAt > AUTO_REFRESH_MS;

      if (stale && canAttempt) {
        try {
          await refresh();
        } catch {
          // Cache and status.lastRefreshError still serve the last known state.
        }
      }
    }

    return readCachedSnapshots();
  }

  async function refresh(): Promise<void> {
    requireStore();

    if (state.refreshPromise !== null) return state.refreshPromise;

    const active = doRefresh().finally(() => {
      state.refreshPromise = null;
    });

    state.refreshPromise = active;

    return active;
  }

  async function doRefresh(): Promise<void> {
    const activeStore = requireStore();

    state.lastRefreshAttemptAt = Date.now();

    try {
      const manifestObjects = await activeStore.listObjects(activeStore.manifestPrefix);
      const manifestIds = new Set<string>();

      const cachedRows = await storage.db
        .select({ id: schema.backupSnapshots.id, state: schema.backupSnapshots.state })
        .from(schema.backupSnapshots);

      const cached = new Map<string, string>();

      for (const row of cachedRows) cached.set(row.id, row.state);

      for (const object of manifestObjects) {
        const id = activeStore.manifestId(object.key);

        if (id === null) continue;
        manifestIds.add(id);

        const cachedState = cached.get(id);

        if (cachedState !== undefined) {
          if (cachedState !== "ready") {
            await storage.db
              .update(schema.backupSnapshots)
              .set({ state: "ready" })
              .where(eq(schema.backupSnapshots.id, id));
          }

          continue;
        }

        let raw: string;

        try {
          raw = await activeStore.getObjectText(object.key, MAX_MANIFEST_BYTES);
        } catch (cause) {
          console.warn(
            `[kinglet] backup manifest ${id} could not be read:`,
            describeBackupError(cause),
          );
          continue;
        }

        const manifest = parseManifest(raw);

        if (manifest === null || manifest.id !== id) {
          console.warn(`[kinglet] backup manifest ${id} is invalid; skipping`);
          continue;
        }

        try {
          await storage.db
            .insert(schema.backupSnapshots)
            .values({
              id: manifest.id,
              runId: null,
              trigger: "discovered",
              manifestKey: activeStore.manifestKey(manifest.id),
              objectKey: activeStore.objectKey(manifest.id, manifest.encryption),
              createdAt: manifest.createdAt,
              sizeBytes: manifest.sizeBytes,
              sha256: manifest.sha256,
              encryption: manifest.encryption,
              appVersion: manifest.appVersion,
              schemaVersion: manifest.schemaVersion,
              countsJson: countsToJson(manifest.counts),
              state: "ready",
              downloadedAt: null,
              downloadedBy: null,
              discovered: true,
            })
            .onConflictDoNothing();
        } catch (cause) {
          console.warn(
            `[kinglet] backup manifest ${id} could not be cached:`,
            describeBackupError(cause),
          );
        }
      }

      for (const row of cachedRows) {
        if (manifestIds.has(row.id) || row.state === "missing") continue;

        await storage.db
          .update(schema.backupSnapshots)
          .set({ state: "missing" })
          .where(eq(schema.backupSnapshots.id, row.id));
      }

      try {
        await cleanupOrphanObjects(activeStore, manifestIds);
      } catch (cause) {
        console.warn("[kinglet] backup orphan cleanup failed:", describeBackupError(cause));
      }

      state.lastRefreshAt = Date.now();
      state.lastRefreshError = null;
    } catch (cause) {
      const message = describeBackupError(cause);

      state.lastRefreshError = message;
      throw new BackupError(message, 502);
    }
  }

  async function remove(id: string): Promise<void> {
    const activeStore = requireStore();
    const snapshotId = id.toLowerCase();

    const rows = await storage.db
      .select({
        id: schema.backupSnapshots.id,
        manifestKey: schema.backupSnapshots.manifestKey,
        objectKey: schema.backupSnapshots.objectKey,
      })
      .from(schema.backupSnapshots)
      .where(eq(schema.backupSnapshots.id, snapshotId))
      .limit(1);

    const row = rows[0];

    if (row === undefined) throw new BackupError("snapshot not found", 404);

    await activeStore.deleteObject(row.manifestKey);
    await activeStore.deleteObject(row.objectKey);
    await storage.db
      .delete(schema.backupSnapshots)
      .where(eq(schema.backupSnapshots.id, snapshotId));
    publishSystemEvent({ type: "backup.deleted", data: { id: snapshotId, reason: "manual" } });
  }

  async function download(id: string, userId: string): Promise<BackupDownload> {
    const activeStore = requireStore();
    const snapshotId = id.toLowerCase();

    const rows = await storage.db
      .select({
        id: schema.backupSnapshots.id,
        objectKey: schema.backupSnapshots.objectKey,
        encryption: schema.backupSnapshots.encryption,
        state: schema.backupSnapshots.state,
      })
      .from(schema.backupSnapshots)
      .where(eq(schema.backupSnapshots.id, snapshotId))
      .limit(1);

    const row = rows[0];

    if (row === undefined) throw new BackupError("snapshot not found", 404);

    if (row.state === "missing") {
      throw new BackupError("snapshot object is missing from the bucket", 404);
    }

    const encryption: BackupEncryption = row.encryption === "age" ? "age" : "none";

    const filename =
      encryption === "age" ? `kinglet-${row.id}.db.zst.age` : `kinglet-${row.id}.db.zst`;

    const signed = await activeStore.presignDownload(row.objectKey, filename);

    try {
      await storage.db
        .update(schema.backupSnapshots)
        .set({ downloadedAt: Date.now(), downloadedBy: userId })
        .where(eq(schema.backupSnapshots.id, snapshotId));
    } catch (cause) {
      console.warn("[kinglet] could not record backup download:", describeBackupError(cause));
    }

    return { url: signed.url, filename, expiresAt: signed.expiresAt };
  }

  async function testConnection(): Promise<void> {
    const activeStore = requireStore();

    try {
      await activeStore.testConnection();
    } catch (cause) {
      throw new BackupError(`S3 connection test failed: ${describeBackupError(cause)}`, 502);
    }
  }

  async function status(): Promise<BackupStatus> {
    const settings = await readSettings();

    const [snapshotRows, successRows, failureRows] = await Promise.all([
      storage.db
        .select({ n: count() })
        .from(schema.backupSnapshots)
        .where(eq(schema.backupSnapshots.state, "ready")),
      storage.db
        .select({
          finishedAt: schema.backupRuns.finishedAt,
          startedAt: schema.backupRuns.startedAt,
        })
        .from(schema.backupRuns)
        .where(eq(schema.backupRuns.status, "succeeded"))
        .orderBy(desc(schema.backupRuns.finishedAt), desc(schema.backupRuns.startedAt))
        .limit(1),
      storage.db
        .select({
          finishedAt: schema.backupRuns.finishedAt,
          startedAt: schema.backupRuns.startedAt,
          error: schema.backupRuns.error,
        })
        .from(schema.backupRuns)
        .where(eq(schema.backupRuns.status, "failed"))
        .orderBy(desc(schema.backupRuns.finishedAt), desc(schema.backupRuns.startedAt))
        .limit(1),
    ]);

    const success = successRows[0];
    const failure = failureRows[0];

    return {
      configured,
      supported,
      storage: supported ? "sqlite" : "remote-libsql",
      enabled: settings.enabled,
      running: state.activeRun !== null,
      phase: state.activeRun?.phase ?? null,
      lastSuccessAt: success === undefined ? null : (success.finishedAt ?? success.startedAt),
      lastFailureAt: failure === undefined ? null : (failure.finishedAt ?? failure.startedAt),
      nextRunAt: state.scheduler?.nextRunAt ?? null,
      lastError: failure?.error ?? null,
      databaseBytes: await currentDatabaseBytes(),
      setupMissing,
      retentionCount: settings.retentionCount,
      snapshotCount: Number(snapshotRows[0]?.n ?? 0),
      scheduleCron: settings.scheduleCron,
      scheduleTimezone: settings.scheduleTimezone,
      encrypted: config.backup !== null && config.backup.passphrase !== undefined,
      lastRefreshError: state.lastRefreshError,
      problem,
    };
  }

  async function currentDatabaseBytes(): Promise<number | null> {
    if (!supported) return null;

    const databasePath = localDatabasePath(config);

    if (databasePath === null) return null;

    try {
      return (await fs.promises.stat(databasePath)).size;
    } catch {
      return null;
    }
  }

  async function readCachedSnapshots(): Promise<BackupSnapshot[]> {
    const rows = await storage.db
      .select()
      .from(schema.backupSnapshots)
      .orderBy(desc(schema.backupSnapshots.createdAt), desc(schema.backupSnapshots.id));

    return rows.map(rowToSnapshot);
  }

  async function readCounts(): Promise<BackupCounts> {
    const [projects, users, events, monitors] = await Promise.all([
      storage.db.select({ n: count() }).from(schema.projects),
      storage.db.select({ n: count() }).from(schema.user),
      storage.db.select({ n: count() }).from(schema.events),
      storage.db.select({ n: count() }).from(schema.monitors),
    ]);

    return {
      projects: countValue(projects[0]?.n),
      users: countValue(users[0]?.n),
      events: countValue(events[0]?.n),
      monitors: countValue(monitors[0]?.n),
    };
  }

  async function readSchemaVersion(): Promise<number> {
    try {
      const rows = await storage.db
        .select({ value: schema.appMeta.value })
        .from(schema.appMeta)
        .where(eq(schema.appMeta.key, "schema_version"))
        .limit(1);

      const raw = rows[0]?.value;

      if (isString(raw)) {
        const parsed = Number.parseInt(raw, 10);

        if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
      }
    } catch {
      // Fall back to the compiled schema version.
    }

    return SCHEMA_VERSION;
  }

  async function applyRetention(activeStore: BackupStore): Promise<void> {
    const settings = await readSettings();

    const keep = Math.min(
      MAX_RETENTION,
      Math.max(MIN_RETENTION, Math.trunc(settings.retentionCount)),
    );

    const rows = await storage.db
      .select({
        id: schema.backupSnapshots.id,
        manifestKey: schema.backupSnapshots.manifestKey,
        objectKey: schema.backupSnapshots.objectKey,
      })
      .from(schema.backupSnapshots)
      .where(eq(schema.backupSnapshots.state, "ready"))
      .orderBy(desc(schema.backupSnapshots.createdAt), desc(schema.backupSnapshots.id));

    if (rows.length <= keep) return;

    let removed = 0;

    for (let index = keep; index < rows.length; index++) {
      const row = rows[index];

      if (row === undefined || index === 0) continue;

      try {
        await activeStore.deleteObject(row.manifestKey);
        await activeStore.deleteObject(row.objectKey);
        await storage.db
          .delete(schema.backupSnapshots)
          .where(eq(schema.backupSnapshots.id, row.id));
        removed++;
        publishSystemEvent({
          type: "backup.deleted",
          data: { id: row.id, reason: "retention" },
        });
      } catch (cause) {
        console.warn(
          `[kinglet] backup retention could not remove ${row.id}:`,
          describeBackupError(cause),
        );
      }
    }

    if (removed > 0) console.log(`[kinglet] backup retention removed ${removed} snapshot(s)`);
  }

  async function assertFreeDisk(databaseBytes: number): Promise<void> {
    const margin = Math.max(32 * 1024 * 1024, Math.ceil(databaseBytes * 0.5));
    const required = databaseBytes + margin;
    let stats: Awaited<ReturnType<typeof fs.promises.statfs>>;

    try {
      stats = await fs.promises.statfs(config.dataDir);
    } catch (cause) {
      console.warn("[kinglet] backup disk check skipped:", describeBackupError(cause));

      return;
    }

    const free = Number(stats.bavail) * Number(stats.bsize);

    if (Number.isFinite(free) && free < required) {
      throw new BackupError("not enough free disk space for a snapshot", 500);
    }
  }

  function setPhase(runId: string, phase: BackupPhase): void {
    if (state.activeRun?.runId === runId) state.activeRun.phase = phase;

    reportProgress(runId, phase);
  }

  function scheduleRetry(): void {
    if (state.stopped) return;

    const delay = RETRY_DELAYS_MS[state.retryAttempt];

    if (delay === undefined) return;

    state.retryAttempt += 1;
    clearRetry();
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;

      if (state.stopped) return;

      void launchScheduled("scheduled");
    }, delay);
    state.retryTimer.unref();
  }

  function clearRetry(): void {
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
  }

  function onScheduledTick(): void {
    clearRetry();
    state.retryAttempt = 0;
    void launchScheduled("scheduled");
  }

  async function launchScheduled(trigger: BackupTrigger): Promise<void> {
    if (state.stopped || !configured || !supported) return;

    if (state.activeRun !== null) {
      await recordSkippedRun(trigger);

      return;
    }

    try {
      startRun(trigger);
    } catch (cause) {
      console.warn("[kinglet] scheduled backup could not start:", describeBackupError(cause));
    }
  }

  async function recordSkippedRun(trigger: BackupTrigger): Promise<void> {
    const now = Date.now();

    try {
      await storage.db.insert(schema.backupRuns).values({
        id: uuidv7(),
        trigger,
        status: "skipped",
        phase: null,
        startedAt: now,
        finishedAt: now,
      });
    } catch (cause) {
      console.warn("[kinglet] could not record skipped backup:", describeBackupError(cause));
    }
  }

  async function armScheduler(): Promise<void> {
    const generation = ++schedulerGeneration;

    state.scheduler?.stop();
    state.scheduler = null;
    clearRetry();
    state.retryAttempt = 0;

    if (state.stopped) return;

    let settings: BackupSettings;

    try {
      settings = await readSettings();
    } catch (cause) {
      console.warn("[kinglet] backup settings could not be read:", describeBackupError(cause));

      return;
    }

    if (state.stopped || generation !== schedulerGeneration) return;

    if (!configured || !supported || !settings.enabled) return;

    const validation = validateCron(settings.scheduleCron, settings.scheduleTimezone);

    if (!validation.ok) {
      console.warn(`[kinglet] backup schedule is invalid: ${validation.error}`);

      return;
    }

    state.scheduler = createCronScheduler({
      cron: validation.cron,
      timezone: settings.scheduleTimezone,
      onTick: onScheduledTick,
      onError: (cause) =>
        console.warn("[kinglet] backup scheduler error:", describeBackupError(cause)),
    });
  }

  async function maybeCatchUp(): Promise<void> {
    if (state.stopped || !configured || !supported) return;

    const settings = await readSettings();

    if (state.stopped || !settings.enabled) return;

    const validation = validateCron(settings.scheduleCron, settings.scheduleTimezone);

    if (!validation.ok) return;

    let previousSlot: number | null = null;

    try {
      const job = new Cron(validation.cron, {
        timezone: settings.scheduleTimezone,
        paused: true,
        mode: "5-part",
      });

      const previous = job.previousRun();

      previousSlot = previous === null ? null : previous.getTime();
    } catch (cause) {
      console.warn("[kinglet] backup catch-up check failed:", describeBackupError(cause));

      return;
    }

    if (previousSlot === null) return;

    const lastSuccess = await latestSuccessAt();

    if (lastSuccess !== null && lastSuccess >= previousSlot) return;

    state.catchUpTimer = setTimeout(() => {
      state.catchUpTimer = null;

      if (state.stopped) return;

      void launchScheduled("catch-up");
    }, CATCH_UP_DELAY_MS);
    state.catchUpTimer.unref();
  }

  async function latestSuccessAt(): Promise<number | null> {
    const rows = await storage.db
      .select({
        finishedAt: schema.backupRuns.finishedAt,
        startedAt: schema.backupRuns.startedAt,
      })
      .from(schema.backupRuns)
      .where(eq(schema.backupRuns.status, "succeeded"))
      .orderBy(desc(schema.backupRuns.finishedAt), desc(schema.backupRuns.startedAt))
      .limit(1);

    const row = rows[0];

    if (row !== undefined) return row.finishedAt ?? row.startedAt;

    // A restored instance discovers bucket snapshots before it has run rows.
    const snapshots = await storage.db
      .select({ createdAt: schema.backupSnapshots.createdAt })
      .from(schema.backupSnapshots)
      .orderBy(desc(schema.backupSnapshots.createdAt))
      .limit(1);

    return snapshots[0]?.createdAt ?? null;
  }

  async function recoverInterruptedRuns(): Promise<void> {
    try {
      await storage.db
        .update(schema.backupRuns)
        .set({
          status: "failed",
          finishedAt: Date.now(),
          error: "interrupted by restart",
        })
        .where(eq(schema.backupRuns.status, "running"));
    } catch (cause) {
      console.warn("[kinglet] backup recovery failed:", describeBackupError(cause));
    }
  }

  async function initialize(): Promise<void> {
    if (state.stopped) return;

    await recoverInterruptedRuns();

    if (state.stopped) return;

    try {
      await armScheduler();
    } catch (cause) {
      console.warn("[kinglet] backup scheduler could not start:", describeBackupError(cause));
    }

    if (state.stopped) return;

    try {
      await maybeCatchUp();
    } catch (cause) {
      console.warn("[kinglet] backup catch-up check failed:", describeBackupError(cause));
    }
  }

  function stop(): void {
    if (state.stopped) return;

    state.stopped = true;
    state.scheduler?.stop();
    state.scheduler = null;
    clearRetry();

    if (state.catchUpTimer !== null) {
      clearTimeout(state.catchUpTimer);
      state.catchUpTimer = null;
    }

    store?.destroy();
  }

  void initialize();

  return {
    get configured() {
      return configured;
    },
    get supported() {
      return supported;
    },
    status,
    getSettings: readSettings,
    updateSettings,
    preview: previewSchedule,
    run,
    list,
    refresh,
    remove,
    download,
    testConnection,
    stop,
  };
}

function rowToSettings(row: typeof schema.backupSettings.$inferSelect): BackupSettings {
  return {
    id: Number(row.id),
    enabled: row.enabled,
    scheduleCron: row.scheduleCron,
    scheduleTimezone: row.scheduleTimezone,
    retentionCount: Number(row.retentionCount),
    updatedAt: Number(row.updatedAt),
    description: describeCron(row.scheduleCron),
  };
}

function rowToSnapshot(row: typeof schema.backupSnapshots.$inferSelect): BackupSnapshot {
  return {
    id: row.id,
    runId: row.runId ?? null,
    trigger: parseSnapshotTrigger(row.trigger),
    createdAt: Number(row.createdAt),
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    encryption: row.encryption === "age" ? "age" : "none",
    appVersion: row.appVersion,
    schemaVersion: Number(row.schemaVersion),
    counts: parseCountsJson(row.countsJson),
    state: parseSnapshotState(row.state),
    downloadedAt: row.downloadedAt === null ? null : Number(row.downloadedAt),
    downloadedBy: row.downloadedBy ?? null,
    discovered: row.discovered,
  };
}

function parseSnapshotTrigger(value: string): BackupSnapshotTrigger {
  if (value === "scheduled" || value === "manual" || value === "catch-up") return value;

  return "discovered";
}

function parseSnapshotState(value: string): BackupSnapshotState {
  return value === "missing" ? "missing" : "ready";
}

function countValue(value: number | undefined): number {
  return isFiniteNumber(value) ? value : 0;
}

function tempPathsFor(dataDir: string, runId: string): TempPaths {
  const directory = path.join(dataDir, "tmp");

  return {
    snapshot: path.join(directory, `kinglet-${runId}.db`),
    compressed: path.join(directory, `kinglet-${runId}.db.zst`),
    encrypted: path.join(directory, `kinglet-${runId}.db.zst.age`),
  };
}

function resolveSetupMissing(config: Config): string[] {
  if (config.backup !== null) return [];

  if (config.backupProblem === null) return [...SETUP_VARS];

  const names = config.backupProblem.match(/KINGLET_[A-Z0-9_]+/g);

  if (names === null || names.length === 0) return [...SETUP_VARS];

  return [...new Set(names)];
}

function resolveProblem(
  config: Config,
  supported: boolean,
  storeProblem: string | null,
): string | null {
  const parts: string[] = [];

  if (config.backup === null) {
    parts.push(
      config.backupProblem === null
        ? "S3 backups are not configured"
        : `S3 backup configuration is incomplete: ${config.backupProblem}`,
    );
  }

  if (!supported) {
    parts.push("snapshots require local SQLite storage (remote libSQL is not supported)");
  }

  if (storeProblem !== null) parts.push(storeProblem);

  return parts.length === 0 ? null : parts.join("; ");
}

function localDatabasePath(config: Config): string | null {
  const raw = config.dbPath;
  const lower = raw.toLowerCase();

  if (
    lower.startsWith("libsql:") ||
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("ws://") ||
    lower.startsWith("wss://")
  ) {
    return null;
  }

  const local = lower.startsWith("file:") ? raw.slice(5) : raw;

  if (local === ":memory:" || local.startsWith(":memory:")) return null;

  return path.resolve(local);
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.promises.stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch {
    // Cleanup is best-effort; the original error is more useful.
  }
}

async function cleanupTempFiles(paths: TempPaths): Promise<void> {
  await Promise.allSettled([
    removeFile(paths.snapshot),
    removeFile(paths.compressed),
    removeFile(paths.encrypted),
  ]);
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function previewSchedule(input: { cron: string; timezone: string }): CronValidation {
  return validateCron(input.cron, input.timezone);
}

async function cleanupOrphans(activeStore: BackupStore): Promise<void> {
  const manifestObjects = await activeStore.listObjects(activeStore.manifestPrefix);
  const manifestIds = new Set<string>();

  for (const object of manifestObjects) {
    const id = activeStore.manifestId(object.key);

    if (id !== null) manifestIds.add(id);
  }

  await cleanupOrphanObjects(activeStore, manifestIds);
}

async function cleanupOrphanObjects(
  activeStore: BackupStore,
  manifestIds: ReadonlySet<string>,
): Promise<void> {
  const objects = await activeStore.listObjects(activeStore.snapshotPrefix);
  const cutoff = Date.now() - ORPHAN_MAX_AGE_MS;
  let removed = 0;

  for (const object of objects) {
    const id = activeStore.objectId(object.key);

    if (id === null || manifestIds.has(id)) continue;

    if (object.lastModified === null || object.lastModified > cutoff) continue;

    try {
      await activeStore.deleteObject(object.key);
      removed++;
    } catch (cause) {
      console.warn(
        `[kinglet] backup orphan ${object.key} could not be removed:`,
        describeBackupError(cause),
      );
    }
  }

  if (removed > 0) console.log(`[kinglet] backup cleanup removed ${removed} orphan object(s)`);
}

async function compressSnapshot(
  sourcePath: string,
  destinationPath: string,
  inputBytes: number,
  runId: string,
): Promise<FileDigest> {
  await removeFile(destinationPath);

  const source = fs.createReadStream(sourcePath, { highWaterMark: 1024 * 1024 });

  const meter = progressMeter(inputBytes, (done, total) =>
    reportProgress(runId, "compress", done, total),
  );

  const sink = createHashSink();

  await pipeline(
    source,
    meter,
    createZstdCompress(),
    sink.stream,
    fs.createWriteStream(destinationPath),
  );
  reportProgress(runId, "compress", inputBytes, inputBytes);

  return sink.finish();
}

async function encryptSnapshot(
  sourcePath: string,
  destinationPath: string,
  passphrase: string,
  inputBytes: number,
  runId: string,
): Promise<FileDigest> {
  await removeFile(destinationPath);

  const encrypter = new Encrypter();

  encrypter.setPassphrase(passphrase);

  const source = fs.createReadStream(sourcePath, { highWaterMark: 1024 * 1024 });
  const encrypted = await encrypter.encrypt(Readable.toWeb(source));
  const total = encrypted.size(inputBytes);

  const meter = progressMeter(total, (done, expected) =>
    reportProgress(runId, "encrypt", done, expected),
  );

  const sink = createHashSink();
  const encryptedNode = Readable.fromWeb(encrypted);

  await pipeline(encryptedNode, meter, sink.stream, fs.createWriteStream(destinationPath));
  reportProgress(runId, "encrypt", total, total);

  return sink.finish();
}

function createHashSink(): HashSink {
  const hash = createHash("sha256");
  let bytes = 0;
  let digest: FileDigest | null = null;

  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      bytes += buffer.length;
      hash.update(buffer);
      callback(null, buffer);
    },
  });

  return {
    stream,
    finish: () => {
      if (digest === null) digest = { bytes, sha256: hash.digest("hex") };

      return digest;
    },
  };
}

function progressMeter(total: number, report: (done: number, total: number) => void): Transform {
  let done = 0;
  let lastReported = 0;

  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      done += buffer.length;

      if (done - lastReported >= PROGRESS_STEP_BYTES || done >= total) {
        lastReported = done;
        report(done, total);
      }

      callback(null, buffer);
    },
  });
}

function reportProgress(runId: string, phase: BackupPhase, done?: number, total?: number): void {
  publishSystemEvent({ type: "backup.progress", data: { runId, phase, done, total } });
}
