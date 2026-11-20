import { Decrypter } from "age-encryption";
import { eq } from "drizzle-orm";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createZstdDecompress } from "node:zlib";
import { isUuid } from "../auth/ids.js";
import { describeBackupError } from "../backups/s3.js";
import type { BackupStore } from "../backups/s3.js";
import { eventSizeBytes } from "../storage/events.js";
import type { Storage } from "../storage/index.js";
import * as schema from "../storage/schema.js";
import { archiveLevelIndex, parseArchiveLine } from "./ndjson.js";
import { ArchiveError, isArchiveDate } from "./types.js";
import type { ArchiveImportResult } from "./types.js";

/**
 * Streamed archive import.
 *
 * Lists the project's parts under the configured prefix, downloads each through
 * a short-lived presigned URL, decrypts (age) and decompresses (zstd), then
 * inserts events in chunks with `ON CONFLICT DO NOTHING` on `uid`. `sourceId`
 * is never used as a rowid, so FTS5 and `project_usage` triggers fire exactly
 * as they do for ingest, and a repeated import only reports skipped rows.
 */

const INSERT_CHUNK = 500;

const PART_RE =
  /^date=(\d{4}-\d{2}-\d{2})\/part-(\d+)-(\d+)-(\d+)-([0-9a-fA-F]{12})\.ndjson\.zst(\.age)?$/;

export interface ImportArchiveOptions {
  projectId: string;
  /** Inclusive UTC date bounds, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
  /** Kept for CLI parity; streaming import does not need local temp files. */
  dataDir: string;
  passphrase?: string;
  s3: BackupStore;
}

interface ArchiveObjectRef {
  key: string;
  date: string;
  firstId: number;
  lastId: number;
  count: number;
  encrypted: boolean;
}

interface ImportRow {
  uid: string;
  projectId: string;
  apiKeyId: null;
  ts: number;
  level: number;
  service: string | null;
  env: string | null;
  message: string;
  fields: string | null;
  sizeBytes: number;
}

export async function importArchive(
  storage: Storage,
  options: ImportArchiveOptions,
): Promise<ArchiveImportResult> {
  void options.dataDir;

  const projectId = options.projectId.trim().toLowerCase();

  if (!isUuid(projectId)) throw new ArchiveError("invalid project id", 400);

  await assertProjectExists(storage, projectId);

  const from = normalizeDate(options.from, "from");
  const to = normalizeDate(options.to, "to");

  if (from !== null && to !== null && from > to) {
    throw new ArchiveError("from must not be after to", 400);
  }

  const prefix = `${options.s3.prefix}/archive/events/project=${projectId}/`;

  let objects: Awaited<ReturnType<BackupStore["listObjects"]>>;

  try {
    objects = await options.s3.listObjects(prefix);
  } catch (cause) {
    throw new ArchiveError(`archive parts could not be listed: ${describeBackupError(cause)}`, 502);
  }

  const refs: ArchiveObjectRef[] = [];

  for (const object of objects) {
    const ref = parsePartKey(object.key, prefix);

    if (ref === null) continue;

    if (from !== null && ref.date < from) continue;

    if (to !== null && ref.date > to) continue;

    refs.push(ref);
  }

  refs.sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? -1 : 1;

    return left.firstId - right.firstId;
  });

  let imported = 0;
  let skipped = 0;

  for (const ref of refs) {
    const result = await importPart(storage, options, projectId, ref);

    imported += result.imported;
    skipped += result.skipped;
  }

  return { imported, skipped };
}

async function importPart(
  storage: Storage,
  options: ImportArchiveOptions,
  projectId: string,
  ref: ArchiveObjectRef,
): Promise<ArchiveImportResult> {
  if (ref.encrypted && options.passphrase === undefined) {
    throw new ArchiveError(
      "archive part is encrypted; set KINGLET_BACKUP_PASSPHRASE to import it",
      400,
    );
  }

  const filename = ref.key.slice(ref.key.lastIndexOf("/") + 1);
  let signed: { url: string; expiresAt: number };

  try {
    signed = await options.s3.presignDownload(ref.key, filename);
  } catch (cause) {
    throw new ArchiveError(`archive download link failed: ${describeBackupError(cause)}`, 502);
  }

  let response: Response;

  try {
    response = await fetch(signed.url);
  } catch {
    throw new ArchiveError("archive object download failed", 502);
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new ArchiveError(`archive object download failed (HTTP ${response.status})`, 502);
  }

  if (response.body === null) {
    throw new ArchiveError("archive object download failed", 502);
  }

  const downloaded = Readable.fromWeb(response.body);
  let source = downloaded;

  if (ref.encrypted && options.passphrase !== undefined) {
    try {
      const decrypter = new Decrypter();

      decrypter.addPassphrase(options.passphrase);
      source = Readable.fromWeb(await decrypter.decrypt(Readable.toWeb(source)));
    } catch {
      downloaded.destroy();
      throw new ArchiveError("archive object could not be decrypted", 400);
    }
  }

  const decompressed = source.pipe(createZstdDecompress());
  const lines = createInterface({ input: decompressed, crlfDelay: Infinity });

  let imported = 0;
  let skipped = 0;
  let batch: ImportRow[] = [];

  try {
    for await (const raw of lines) {
      if (raw.trim() === "") continue;

      const line = parseArchiveLine(raw);

      if (line === null) {
        skipped++;
        continue;
      }

      if (line.projectId.toLowerCase() !== projectId) {
        throw new ArchiveError("archive object contains events for another project", 400);
      }

      const level = archiveLevelIndex(line.level);

      if (level < 0) {
        skipped++;
        continue;
      }

      const fields = line.fields === null ? null : JSON.stringify(line.fields);

      batch.push({
        uid: line.uid,
        projectId,
        apiKeyId: null,
        ts: line.ts,
        level,
        service: line.service,
        env: line.env,
        message: line.message,
        fields,
        sizeBytes: eventSizeBytes({
          ts: line.ts,
          level,
          service: line.service,
          env: line.env,
          message: line.message,
          fields,
        }),
      });

      if (batch.length >= INSERT_CHUNK) {
        const flushed = await flushBatch(storage, batch);

        imported += flushed.imported;
        skipped += flushed.skipped;
        batch = [];
      }
    }

    if (batch.length > 0) {
      const flushed = await flushBatch(storage, batch);

      imported += flushed.imported;
      skipped += flushed.skipped;
    }
  } catch (cause) {
    if (cause instanceof ArchiveError) throw cause;

    console.warn(`[kinglet] archive import failed for ${ref.key}:`, describeBackupError(cause));
    throw new ArchiveError("archive import failed", 500);
  } finally {
    lines.close();
    decompressed.destroy();
    source.destroy();
    downloaded.destroy();
  }

  return { imported, skipped };
}

async function flushBatch(storage: Storage, batch: ImportRow[]): Promise<ArchiveImportResult> {
  if (batch.length === 0) return { imported: 0, skipped: 0 };

  const inserted = await storage.db
    .insert(schema.events)
    .values(batch)
    .onConflictDoNothing()
    .returning({ id: schema.events.id });

  return { imported: inserted.length, skipped: batch.length - inserted.length };
}

function parsePartKey(key: string, prefix: string): ArchiveObjectRef | null {
  if (!key.startsWith(prefix)) return null;

  const match = PART_RE.exec(key.slice(prefix.length));

  if (match === null) return null;

  const date = match[1];
  const first = match[2];
  const last = match[3];
  const count = match[4];

  if (date === undefined || first === undefined || last === undefined || count === undefined) {
    return null;
  }

  if (!isArchiveDate(date)) return null;

  const firstId = Number.parseInt(first, 10);
  const lastId = Number.parseInt(last, 10);
  const eventCount = Number.parseInt(count, 10);

  if (
    !Number.isSafeInteger(firstId) ||
    !Number.isSafeInteger(lastId) ||
    !Number.isSafeInteger(eventCount) ||
    firstId < 0 ||
    lastId < firstId ||
    eventCount <= 0
  ) {
    return null;
  }

  return {
    key,
    date,
    firstId,
    lastId,
    count: eventCount,
    encrypted: match[6] !== undefined,
  };
}

function normalizeDate(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;

  const trimmed = value.trim();

  if (trimmed === "") return null;

  if (!isArchiveDate(trimmed)) {
    throw new ArchiveError(`${label} must be a YYYY-MM-DD date`, 400);
  }

  return trimmed;
}

async function assertProjectExists(storage: Storage, projectId: string): Promise<void> {
  const rows = await storage.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);

  if (rows.length === 0) throw new ArchiveError("project not found", 404);
}
