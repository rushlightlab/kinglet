import { Encrypter } from "age-encryption";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql, sum } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import { isUuid, uuidv7 } from "../auth/ids.ts";
import { BackupStore, describeBackupError } from "../backups/s3.ts";
import type { Config } from "../env.ts";
import { isFiniteNumber } from "../json.ts";
import { createCronScheduler, validateCron } from "../schedule.ts";
import type { CronScheduler } from "../schedule.ts";
import type { Storage } from "../storage/index.ts";
import * as schema from "../storage/schema.ts";
import { publishSystemEvent } from "../system-events.ts";
import { importArchive } from "./import.ts";
import { archiveDateKey, eventToArchiveLine } from "./ndjson.ts";
import {
  ensureArchiveSettings,
  getArchiveSettings,
  listArchiveEnabledProjectIds,
  setProjectArchiveEnabled,
  updateArchiveSettings,
} from "./settings.ts";
import { ArchiveError, isArchiveDate } from "./types.ts";
import type {
  ArchiveEncryption,
  ArchiveEventRow,
  ArchiveImportRequest,
  ArchiveImportResult,
  ArchivePart,
  ArchivePartsQuery,
  ArchivePhase,
  ArchiveProjectSetting,
  ArchiveRunHandle,
  ArchiveSettings,
  ArchiveSettingsUpdate,
  ArchiveSettingsView,
  ArchiveStatus,
} from "./types.ts";

export type {
  ArchivePart,
  ArchiveRunHandle,
  ArchiveSettings,
  ArchiveSettingsView,
  ArchiveStatus,
} from "./types.ts";

export { ArchiveError } from "./types.ts";

/**
 * Log archive engine.
 *
 * Exports events that have reached `KINGLET_RETENTION_DAYS` for projects that
 * opted in, writes deterministic zstd (optionally age-encrypted) NDJSON parts
 * under the configured S3 prefix, and deletes rows only after upload + HEAD
 * verification. A failure keeps the rows unless the admin explicitly enabled
 * `delete_on_failure`; the next cron tick owns the retry.
 */

const MAX_PART_EVENTS = 10_000;
const DELETE_CHUNK = 500;
const TIME_BUDGET_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const PROGRESS_STEP_BYTES = 1_048_576;
const NDJSON_FLUSH_CHARS = 1_048_576;
const DEFAULT_PART_LIMIT = 100;
const MAX_PART_LIMIT = 500;

export interface ArchiveEngine {
  readonly configured: boolean;
  readonly supported: boolean;
  status(): Promise<ArchiveStatus>;
  /** Settings plus availability and the next scheduled runs. */
  getSettings(): Promise<ArchiveSettingsView>;
  updateSettings(input: ArchiveSettingsUpdate): Promise<ArchiveSettingsView>;
  setProjectEnabled(projectId: string, enabled: boolean): Promise<ArchiveProjectSetting>;
  listParts(query?: ArchivePartsQuery): Promise<ArchivePart[]>;
  importEvents(input: ArchiveImportRequest): Promise<ArchiveImportResult>;
  run(projectId?: string): Promise<ArchiveRunHandle>;
  stop(): void;
}

interface ActiveRun {
  readonly runId: string;
  phase: ArchivePhase | null;
  projectId: string | null;
}

interface EngineState {
  activeRun: ActiveRun | null;
  scheduler: CronScheduler | null;
  lastRunAt: number | null;
  lastFailureAt: number | null;
  lastSkippedAt: number | null;
  lastError: string | null;
  stopped: boolean;
}

interface PendingBatch {
  ids: number[];
}

interface TempPaths {
  ndjson: string;
  compressed: string;
  encrypted: string;
}

interface ArchiveDateGroup {
  date: string;
  rows: ArchiveEventRow[];
}

interface FileDigest {
  bytes: number;
}

interface Digester {
  stream: Transform;
  finish: () => number;
}

export function startArchiveEngine(options: { storage: Storage; config: Config }): ArchiveEngine {
  return createEngine(options.storage, options.config);
}

function createEngine(storage: Storage, config: Config): ArchiveEngine {
  const configured = config.backup !== null;
  // Archive only reads events and writes local temp files; it works on both
  // local SQLite and hosted libSQL. Kept as a field for UI parity and future
  // driver-specific restrictions.
  const supported = true;
  let store: BackupStore | null = null;
  let storeProblem: string | null = null;

  if (config.backup !== null) {
    try {
      store = new BackupStore(config.backup);
    } catch (cause) {
      storeProblem = `S3 client could not be initialized: ${describeBackupError(cause)}`;
      console.warn("[kinglet]", storeProblem);
    }
  }

  const problem = resolveProblem(config, storeProblem);

  const state: EngineState = {
    activeRun: null,
    scheduler: null,
    lastRunAt: null,
    lastFailureAt: null,
    lastSkippedAt: null,
    lastError: null,
    stopped: false,
  };

  let schedulerGeneration = 0;
  let partCounter = 0;

  function requireStore(): BackupStore {
    if (!configured) throw new ArchiveError("S3 archive storage is not configured", 409);

    if (store === null) {
      throw new ArchiveError(storeProblem ?? "S3 archive storage is not configured", 409);
    }

    return store;
  }

  async function status(): Promise<ArchiveStatus> {
    const settings = await getArchiveSettings(storage);
    const enabledProjectIds = await listArchiveEnabledProjectIds(storage);

    const [totals, latest] = await Promise.all([
      storage.db
        .select({
          events: sum(schema.archiveParts.eventCount),
          bytes: sum(schema.archiveParts.sizeBytes),
        })
        .from(schema.archiveParts),
      storage.db
        .select({ createdAt: schema.archiveParts.createdAt })
        .from(schema.archiveParts)
        .orderBy(desc(schema.archiveParts.createdAt))
        .limit(1),
    ]);

    const lastSuccessAt = latest[0] === undefined ? null : Number(latest[0].createdAt);
    const archivedEvents = Number(totals[0]?.events ?? 0);
    const archivedBytes = Number(totals[0]?.bytes ?? 0);

    return {
      configured,
      supported,
      enabled: settings.enabled,
      running: state.activeRun !== null,
      phase: state.activeRun?.phase ?? null,
      projectId: state.activeRun?.projectId ?? null,
      lastRunAt: pickLatest(state.lastRunAt, lastSuccessAt),
      lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      lastSkippedAt: state.lastSkippedAt,
      lastError: state.lastError,
      nextRunAt: state.scheduler?.nextRunAt ?? null,
      scheduleCron: settings.scheduleCron,
      scheduleTimezone: settings.scheduleTimezone,
      deleteOnFailure: settings.deleteOnFailure,
      intervalDays: config.retentionDays,
      enabledProjectIds: [...enabledProjectIds],
      archivedEvents: isFiniteNumber(archivedEvents) ? archivedEvents : 0,
      archivedBytes: isFiniteNumber(archivedBytes) ? archivedBytes : 0,
      problem,
    };
  }

  async function getSettings(): Promise<ArchiveSettingsView> {
    return toView(await getArchiveSettings(storage));
  }

  async function updateSettings(input: ArchiveSettingsUpdate): Promise<ArchiveSettingsView> {
    if (input.enabled === true) requireStore();

    const settings = await updateArchiveSettings(storage, input);

    await armScheduler();

    return toView(settings);
  }

  async function setProjectEnabled(
    projectId: string,
    enabled: boolean,
  ): Promise<ArchiveProjectSetting> {
    if (enabled) requireStore();

    return setProjectArchiveEnabled(storage, projectId, enabled);
  }

  async function listParts(query: ArchivePartsQuery = {}): Promise<ArchivePart[]> {
    const conditions: SQL[] = [];

    if (query.projectId !== undefined) {
      if (!isUuid(query.projectId)) throw new ArchiveError("invalid project id", 400);
      conditions.push(eq(schema.archiveParts.projectId, query.projectId.toLowerCase()));
    }

    if (query.from !== undefined) {
      if (!isArchiveDate(query.from)) {
        throw new ArchiveError("from must be a YYYY-MM-DD date", 400);
      }

      conditions.push(gte(schema.archiveParts.date, query.from));
    }

    if (query.to !== undefined) {
      if (!isArchiveDate(query.to)) {
        throw new ArchiveError("to must be a YYYY-MM-DD date", 400);
      }

      conditions.push(lte(schema.archiveParts.date, query.to));
    }

    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      throw new ArchiveError("from must not be after to", 400);
    }

    const rows = await storage.db
      .select()
      .from(schema.archiveParts)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.archiveParts.createdAt), desc(schema.archiveParts.id))
      .limit(clampPartLimit(query.limit));

    return rows.map(rowToPart);
  }

  async function importEvents(input: ArchiveImportRequest): Promise<ArchiveImportResult> {
    const activeStore = requireStore();

    return importArchive(storage, {
      projectId: input.projectId,
      from: input.from,
      to: input.to,
      dataDir: config.dataDir,
      passphrase: config.backup?.passphrase,
      s3: activeStore,
    });
  }

  async function run(projectId?: string): Promise<ArchiveRunHandle> {
    return startRun(projectId);
  }

  async function startRun(projectId?: string): Promise<ArchiveRunHandle> {
    const activeStore = requireStore();

    if (state.activeRun !== null) throw new ArchiveError("an archive run is already running", 409);

    // Claim single-flight before the first await so two concurrent manual
    // requests cannot both pass the guard.
    const runId = uuidv7();
    const claim: ActiveRun = { runId, phase: null, projectId: projectId ?? null };

    state.activeRun = claim;

    try {
      const settings = await getArchiveSettings(storage);

      if (!settings.enabled) throw new ArchiveError("log archive is disabled", 409);

      const targets = await selectTargets(projectId);

      partCounter = 0;
      claim.projectId = targets[0] ?? null;

      void executeRun({ runId, targets, settings, activeStore }).catch((cause) => {
        console.warn(
          `[kinglet] archive run ${runId} failed unexpectedly:`,
          describeBackupError(cause),
        );

        if (state.activeRun?.runId === runId) state.activeRun = null;
      });

      return { runId };
    } catch (cause) {
      if (state.activeRun === claim) state.activeRun = null;

      throw cause;
    }
  }

  async function selectTargets(projectId?: string): Promise<string[]> {
    const enabled = await listArchiveEnabledProjectIds(storage);

    if (projectId === undefined) {
      if (enabled.length === 0) throw new ArchiveError("no projects have archive enabled", 409);

      return [...enabled];
    }

    const id = projectId.trim().toLowerCase();

    if (!enabled.includes(id)) {
      throw new ArchiveError("archive is not enabled for this project", 409);
    }

    return [id];
  }

  async function executeRun(input: {
    runId: string;
    targets: readonly string[];
    settings: ArchiveSettings;
    activeStore: BackupStore;
  }): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + TIME_BUDGET_MS;
    const cutoff = startedAt - config.retentionDays * DAY_MS;
    const passphrase = config.backup?.passphrase;
    const pending: PendingBatch = { ids: [] };
    let failed = false;

    try {
      for (const projectId of input.targets) {
        if (state.stopped || Date.now() >= deadline) break;

        try {
          await archiveProject({
            runId: input.runId,
            projectId,
            cutoff,
            deadline,
            activeStore: input.activeStore,
            passphrase,
            pending,
          });
        } catch (cause) {
          failed = true;
          const message = describeBackupError(cause);

          state.lastFailureAt = Date.now();
          state.lastError = message;
          console.warn(`[kinglet] archive failed for project ${projectId}: ${message}`);
          publishSystemEvent({
            type: "archive.failed",
            data: { projectId, error: message },
          });

          // Explicit escape hatch: deleting rows after a failed archive loses
          // data, so it only happens when the admin opted in.
          if (input.settings.deleteOnFailure && pending.ids.length > 0) {
            try {
              await deleteEventIds(pending.ids, projectId);
            } catch (deleteCause) {
              console.warn(
                "[kinglet] archive failure override could not delete rows:",
                describeBackupError(deleteCause),
              );
            }
          }

          pending.ids = [];
          break;
        }
      }

      state.lastRunAt = Date.now();

      if (!failed) state.lastError = null;
    } finally {
      if (state.activeRun?.runId === input.runId) state.activeRun = null;
    }
  }

  async function archiveProject(input: {
    runId: string;
    projectId: string;
    cutoff: number;
    deadline: number;
    activeStore: BackupStore;
    passphrase: string | undefined;
    pending: PendingBatch;
  }): Promise<void> {
    for (;;) {
      if (state.stopped || Date.now() >= input.deadline) return;

      const rows = await selectExpiredEvents(input.projectId, input.cutoff);

      if (rows.length === 0) return;

      const groups = groupByDate(rows);

      for (const group of groups) {
        if (state.stopped || Date.now() >= input.deadline) return;

        input.pending.ids = group.rows.map((row) => row.id);

        await exportGroup({
          runId: input.runId,
          store: input.activeStore,
          projectId: input.projectId,
          date: group.date,
          rows: group.rows,
          passphrase: input.passphrase,
          partIndex: partCounter++,
        });

        input.pending.ids = [];
      }
    }
  }

  async function selectExpiredEvents(
    projectId: string,
    cutoff: number,
  ): Promise<ArchiveEventRow[]> {
    const rows = await storage.db
      .select({
        id: schema.events.id,
        uid: schema.events.uid,
        ts: schema.events.ts,
        level: schema.events.level,
        service: schema.events.service,
        env: schema.events.env,
        message: schema.events.message,
        fields: schema.events.fields,
      })
      .from(schema.events)
      .where(and(eq(schema.events.projectId, projectId), lt(schema.events.ts, cutoff)))
      .orderBy(asc(schema.events.id))
      .limit(MAX_PART_EVENTS);

    const mapped: ArchiveEventRow[] = [];

    for (const row of rows) {
      mapped.push({
        id: Number(row.id),
        uid: row.uid ?? null,
        ts: Number(row.ts),
        level: Number(row.level),
        service: row.service ?? null,
        env: row.env ?? null,
        message: row.message,
        fields: row.fields ?? null,
      });
    }

    return mapped;
  }

  async function exportGroup(input: {
    runId: string;
    store: BackupStore;
    projectId: string;
    date: string;
    rows: readonly ArchiveEventRow[];
    passphrase: string | undefined;
    partIndex: number;
  }): Promise<void> {
    const first = input.rows[0];
    const last = input.rows[input.rows.length - 1];

    if (first === undefined || last === undefined) {
      throw new ArchiveError("archive part has no events", 500);
    }

    const paths = tempPathsFor(config.dataDir, input.runId, input.partIndex);

    try {
      await fs.promises.mkdir(path.dirname(paths.ndjson), { recursive: true, mode: 0o700 });

      reportProgress(input.runId, input.projectId, "select", 0, input.rows.length);

      const ndjson = await writeNdjson(paths.ndjson, input.rows, input.projectId, (done, total) =>
        reportProgress(input.runId, input.projectId, "select", done, total),
      );

      reportProgress(input.runId, input.projectId, "compress", 0, ndjson.bytes);

      const compressed = await compressFile(
        paths.ndjson,
        paths.compressed,
        ndjson.bytes,
        (done, total) => reportProgress(input.runId, input.projectId, "compress", done, total),
      );

      let finalPath = paths.compressed;
      let finalBytes = compressed.bytes;
      let encryption: ArchiveEncryption = "none";

      if (input.passphrase !== undefined) {
        reportProgress(input.runId, input.projectId, "encrypt", 0, compressed.bytes);

        const encrypted = await encryptFile(
          paths.compressed,
          paths.encrypted,
          input.passphrase,
          compressed.bytes,
          (done, total) => reportProgress(input.runId, input.projectId, "encrypt", done, total),
        );

        finalPath = paths.encrypted;
        finalBytes = encrypted.bytes;
        encryption = "age";
      }

      const objectKey = archivePartKey({
        prefix: input.store.prefix,
        projectId: input.projectId,
        date: input.date,
        firstId: first.id,
        lastId: last.id,
        count: input.rows.length,
        sha256: ndjson.sha256,
        encryption,
      });

      reportProgress(input.runId, input.projectId, "upload", 0, finalBytes);

      await input.store.uploadFile({
        key: objectKey,
        filePath: finalPath,
        sizeBytes: finalBytes,
        sha256: ndjson.sha256,
        onProgress: (done, total) =>
          reportProgress(input.runId, input.projectId, "upload", done, total),
      });

      setPhase(input.runId, input.projectId, "verify");

      const head = await input.store.headObject(objectKey);

      if (Number(head.ContentLength ?? 0) !== finalBytes) {
        throw new ArchiveError("uploaded archive object size did not match", 502);
      }

      if ((head.Metadata?.sha256 ?? "").toLowerCase() !== ndjson.sha256) {
        throw new ArchiveError("uploaded archive object checksum did not match", 502);
      }

      await recordPart({
        projectId: input.projectId,
        date: input.date,
        firstId: first.id,
        lastId: last.id,
        eventCount: input.rows.length,
        objectKey,
        sha256: ndjson.sha256,
        sizeBytes: finalBytes,
      });

      setPhase(input.runId, input.projectId, "delete");
      await deleteEventIds(
        input.rows.map((row) => row.id),
        input.projectId,
      );

      publishSystemEvent({
        type: "archive.succeeded",
        data: { projectId: input.projectId, events: input.rows.length, bytes: finalBytes },
      });
    } finally {
      await cleanupTempFiles(paths);
    }
  }

  async function recordPart(input: {
    projectId: string;
    date: string;
    firstId: number;
    lastId: number;
    eventCount: number;
    objectKey: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<void> {
    const existing = await storage.db
      .select({ id: schema.archiveParts.id })
      .from(schema.archiveParts)
      .where(eq(schema.archiveParts.objectKey, input.objectKey))
      .limit(1);

    // A crash between insert and delete re-creates the same deterministic key;
    // keep one cache row per object.
    if (existing.length > 0) return;

    await storage.db
      .insert(schema.archiveParts)
      .values({
        id: uuidv7(),
        projectId: input.projectId,
        date: input.date,
        firstId: input.firstId,
        lastId: input.lastId,
        eventCount: input.eventCount,
        objectKey: input.objectKey,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        createdAt: Date.now(),
      })
      .onConflictDoNothing();
  }

  async function deleteEventIds(ids: readonly number[], projectId: string): Promise<number> {
    let deleted = 0;

    for (let index = 0; index < ids.length; index += DELETE_CHUNK) {
      const chunk = ids.slice(index, index + DELETE_CHUNK);

      // Keep the project predicate in the DELETE itself: SQLite can reuse
      // rowids after a concurrent clear/project wipe, and the archive boundary
      // must not depend on a separate read.
      const result = await storage.db.run(
        sql`DELETE FROM events WHERE ${eq(schema.events.projectId, projectId)} AND ${inArray(
          schema.events.id,
          chunk,
        )}`,
      );

      deleted += Number(result.rowsAffected ?? 0);
    }

    return deleted;
  }

  function onScheduledTick(): void {
    void launchScheduled();
  }

  async function launchScheduled(): Promise<void> {
    if (state.stopped || !configured || !supported) return;

    if (state.activeRun !== null) {
      state.lastSkippedAt = Date.now();
      console.warn("[kinglet] archive tick skipped: a run is already active");

      return;
    }

    try {
      const settings = await getArchiveSettings(storage);

      if (state.stopped || !settings.enabled) return;

      const targets = await listArchiveEnabledProjectIds(storage);

      if (targets.length === 0) return;

      await startRun();
    } catch (cause) {
      console.warn("[kinglet] scheduled archive could not start:", describeBackupError(cause));
    }
  }

  async function armScheduler(): Promise<void> {
    const generation = ++schedulerGeneration;

    state.scheduler?.stop();
    state.scheduler = null;

    if (state.stopped) return;

    let settings: ArchiveSettings;

    try {
      settings = await getArchiveSettings(storage);
    } catch (cause) {
      console.warn("[kinglet] archive settings could not be read:", describeBackupError(cause));

      return;
    }

    if (state.stopped || generation !== schedulerGeneration) return;

    if (!configured || !supported || !settings.enabled) return;

    const validation = validateCron(settings.scheduleCron, settings.scheduleTimezone);

    if (!validation.ok) {
      console.warn(`[kinglet] archive schedule is invalid: ${validation.error}`);

      return;
    }

    state.scheduler = createCronScheduler({
      cron: validation.cron,
      timezone: settings.scheduleTimezone,
      onTick: onScheduledTick,
      onError: (cause) =>
        console.warn("[kinglet] archive scheduler error:", describeBackupError(cause)),
    });
  }

  async function initialize(): Promise<void> {
    if (state.stopped) return;

    try {
      await ensureArchiveSettings(storage, config.timezone);
    } catch (cause) {
      console.warn(
        "[kinglet] archive settings could not be initialized:",
        describeBackupError(cause),
      );
    }

    if (state.stopped) return;

    try {
      await armScheduler();
    } catch (cause) {
      console.warn("[kinglet] archive scheduler could not start:", describeBackupError(cause));
    }
  }

  function stop(): void {
    if (state.stopped) return;

    state.stopped = true;
    state.scheduler?.stop();
    state.scheduler = null;
    store?.destroy();
  }

  function setPhase(runId: string, projectId: string, phase: ArchivePhase): void {
    if (state.activeRun?.runId === runId) {
      state.activeRun.phase = phase;
      state.activeRun.projectId = projectId;
    }

    publishSystemEvent({ type: "archive.progress", data: { projectId, phase } });
  }

  function reportProgress(
    runId: string,
    projectId: string,
    phase: ArchivePhase,
    done: number,
    total: number,
  ): void {
    if (state.activeRun?.runId === runId) {
      state.activeRun.phase = phase;
      state.activeRun.projectId = projectId;
    }

    publishSystemEvent({ type: "archive.progress", data: { projectId, phase, done, total } });
  }

  function toView(settings: ArchiveSettings): ArchiveSettingsView {
    const validation = validateCron(settings.scheduleCron, settings.scheduleTimezone);

    return {
      ...settings,
      configured,
      supported,
      nextRuns: validation.ok ? validation.nextRuns : [],
    };
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
    getSettings,
    updateSettings,
    setProjectEnabled,
    listParts,
    importEvents,
    run,
    stop,
  };
}

function resolveProblem(config: Config, storeProblem: string | null): string | null {
  const parts: string[] = [];

  if (config.backup === null) {
    parts.push(
      config.backupProblem === null
        ? "S3 archive storage is not configured"
        : `S3 archive configuration is incomplete: ${config.backupProblem}`,
    );
  }

  if (storeProblem !== null) parts.push(storeProblem);

  return parts.length === 0 ? null : parts.join("; ");
}

function pickLatest(left: number | null, right: number | null): number | null {
  if (left === null) return right;

  if (right === null) return left;

  return Math.max(left, right);
}

function clampPartLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PART_LIMIT;

  return Math.min(MAX_PART_LIMIT, Math.max(1, Math.trunc(value)));
}

function rowToPart(row: typeof schema.archiveParts.$inferSelect): ArchivePart {
  return {
    id: row.id,
    projectId: row.projectId,
    date: row.date,
    firstId: Number(row.firstId),
    lastId: Number(row.lastId),
    eventCount: Number(row.eventCount),
    sha256: row.sha256,
    sizeBytes: Number(row.sizeBytes),
    createdAt: Number(row.createdAt),
  };
}

function groupByDate(rows: readonly ArchiveEventRow[]): ArchiveDateGroup[] {
  const groups = new Map<string, ArchiveDateGroup>();

  for (const row of rows) {
    const date = archiveDateKey(row.ts);
    const existing = groups.get(date);

    if (existing === undefined) {
      groups.set(date, { date, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }

  return [...groups.values()];
}

interface ArchivePartKeyInput {
  prefix: string;
  projectId: string;
  date: string;
  firstId: number;
  lastId: number;
  count: number;
  sha256: string;
  encryption: ArchiveEncryption;
}

function archivePartKey(input: ArchivePartKeyInput): string {
  const suffix = input.encryption === "age" ? ".age" : "";

  return (
    `${input.prefix}/archive/events/project=${input.projectId}/date=${input.date}/` +
    `part-${input.firstId}-${input.lastId}-${input.count}-${input.sha256.slice(0, 12)}` +
    `.ndjson.zst${suffix}`
  );
}

function tempPathsFor(dataDir: string, runId: string, partIndex: number): TempPaths {
  const directory = path.join(dataDir, "tmp");
  const stem = `kinglet-archive-${runId}-${partIndex}`;

  return {
    ndjson: path.join(directory, `${stem}.ndjson`),
    compressed: path.join(directory, `${stem}.ndjson.zst`),
    encrypted: path.join(directory, `${stem}.ndjson.zst.age`),
  };
}

async function writeNdjson(
  filePath: string,
  rows: readonly ArchiveEventRow[],
  projectId: string,
  onProgress: (done: number, total: number) => void,
): Promise<{ bytes: number; sha256: string }> {
  const handle = await fs.promises.open(filePath, "w", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  let pending = "";

  const flush = async (): Promise<void> => {
    if (pending === "") return;

    const buffer = Buffer.from(pending, "utf8");

    pending = "";
    hash.update(buffer);
    bytes += buffer.length;
    await handle.write(buffer);
  };

  try {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];

      if (row === undefined) continue;

      pending += `${JSON.stringify(eventToArchiveLine(row, projectId))}\n`;

      if (pending.length >= NDJSON_FLUSH_CHARS) await flush();

      if ((index + 1) % 500 === 0) onProgress(index + 1, rows.length);
    }

    await flush();
    onProgress(rows.length, rows.length);

    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function compressFile(
  sourcePath: string,
  destinationPath: string,
  inputBytes: number,
  onProgress: (done: number, total: number) => void,
): Promise<FileDigest> {
  await removeFile(destinationPath);

  const counter = byteCounter();
  const source = fs.createReadStream(sourcePath, { highWaterMark: 1024 * 1024 });

  await pipeline(
    source,
    progressMeter(inputBytes, onProgress),
    createZstdCompress(),
    counter.stream,
    fs.createWriteStream(destinationPath),
  );
  onProgress(inputBytes, inputBytes);

  return { bytes: counter.finish() };
}

async function encryptFile(
  sourcePath: string,
  destinationPath: string,
  passphrase: string,
  inputBytes: number,
  onProgress: (done: number, total: number) => void,
): Promise<FileDigest> {
  await removeFile(destinationPath);

  const encrypter = new Encrypter();

  encrypter.setPassphrase(passphrase);

  const source = fs.createReadStream(sourcePath, { highWaterMark: 1024 * 1024 });

  try {
    const encrypted = await encrypter.encrypt(Readable.toWeb(source));
    const total = encrypted.size(inputBytes);
    const counter = byteCounter();
    const meter = progressMeter(total, onProgress);

    await pipeline(
      Readable.fromWeb(encrypted),
      meter,
      counter.stream,
      fs.createWriteStream(destinationPath),
    );
    onProgress(total, total);

    return { bytes: counter.finish() };
  } finally {
    source.destroy();
  }
}

function byteCounter(): Digester {
  let bytes = 0;

  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      bytes += buffer.length;
      callback(null, buffer);
    },
  });

  return { stream, finish: () => bytes };
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

async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch {
    // Cleanup is best-effort; the original error is more useful.
  }
}

async function cleanupTempFiles(paths: TempPaths): Promise<void> {
  await Promise.allSettled([
    removeFile(paths.ndjson),
    removeFile(paths.compressed),
    removeFile(paths.encrypted),
  ]);
}
