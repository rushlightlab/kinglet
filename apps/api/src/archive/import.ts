import { Decrypter } from "age-encryption";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { isUuid } from "../auth/ids.js";
import { describeBackupError } from "../backups/s3.js";
import type { BackupObjectStore } from "../backups/s3.js";
import { eventSizeBytes } from "../storage/events.js";
import type { KingletDb } from "../storage/db.js";
import type { Storage } from "../storage/index.js";
import * as schema from "../storage/schema.js";
import { archiveLevelIndex, parseArchiveLine } from "./ndjson.js";
import { resolveMaxSpoolBytes } from "./spool.js";
import { ArchiveError, isArchiveDate } from "./types.js";
import type { ArchiveImportResult, ArchiveLine } from "./types.js";

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

const MAX_IMPORT_MESSAGE = 8_000;
const MAX_IMPORT_FIELDS = 32_768;
const MAX_IMPORT_FUTURE_SKEW_MS = 5 * 60_000;

export interface ImportArchiveOptions {
  projectId: string;
  /** Inclusive UTC date bounds, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
  /** Scratch directory for the verified spool file. */
  dataDir: string;
  passphrase?: string;
  s3: BackupObjectStore;
  /**
   * Decompressed spool cap. Production uses `MAX_SPOOL_BYTES`; tests inject a
   * small value so the bound can be exercised without a giant fixture.
   */
  maxSpoolBytes?: number;
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
  const projectId = options.projectId.trim().toLowerCase();

  if (!isUuid(projectId)) throw new ArchiveError("invalid project id", 400);

  await assertProjectExists(storage, projectId);

  const from = normalizeDate(options.from, "from");
  const to = normalizeDate(options.to, "to");

  if (from !== null && to !== null && from > to) {
    throw new ArchiveError("from must not be after to", 400);
  }

  const prefix = `${options.s3.prefix}/archive/events/project=${projectId}/`;

  let objects: Awaited<ReturnType<BackupObjectStore["listObjects"]>>;

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
    // Bound the download and do not follow redirects: the presigned URL is
    // already the final object location.
    response = await fetch(signed.url, {
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
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

  const digest = createHash("sha256");
  const maxSpoolBytes = resolveMaxSpoolBytes(options.maxSpoolBytes);
  let spooledBytes = 0;

  // Count decompressed bytes before they reach the spool file. Failing inside
  // the pipeline tears down the download, so an oversized or hostile object
  // never writes an unbounded stream to disk.
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      spooledBytes += chunk.length;

      if (spooledBytes > maxSpoolBytes) {
        callback(new ArchiveError("archive part is too large to import", 413));

        return;
      }

      digest.update(chunk);
      callback(null, chunk);
    },
  });

  const zstd = createZstdDecompress();
  let tempDir: string | null = null;

  try {
    // Spool while downloading so the SQLite write lock is never held across a
    // network read. Nothing is inserted until the digest is verified. The
    // whole chain goes through one pipeline so an early decompress or spool
    // error is observed instead of surfacing as an unhandled stream error.
    const tempRoot = path.join(options.dataDir, "tmp");

    await fs.promises.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    tempDir = await fs.promises.mkdtemp(path.join(tempRoot, "archive-import-"));

    const spoolPath = path.join(tempDir, "part.ndjson");

    await pipeline(source, zstd, hasher, fs.createWriteStream(spoolPath, { mode: 0o600 }));

    await verifyPartDigest(storage.db, ref.key, filename, digest.digest("hex"));

    const importNow = Date.now();
    const skipped = await validateSpoolFile(spoolPath, projectId, importNow);
    const inserted = await insertSpoolFile(storage, spoolPath, projectId, importNow);

    return { imported: inserted.imported, skipped: skipped + inserted.skipped };
  } catch (cause) {
    if (cause instanceof ArchiveError) throw cause;

    console.warn(`[kinglet] archive import failed for ${ref.key}:`, describeBackupError(cause));
    throw new ArchiveError("archive import failed", 500);
  } finally {
    hasher.destroy();
    zstd.destroy();
    source.destroy();
    downloaded.destroy();

    if (tempDir !== null) {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Best effort; the original import result is more useful.
      }
    }
  }
}

/**
 * First pass over the spooled file: reject a cross-project part before any
 * insert and count rows that will be skipped. The fixed `importNow` keeps the
 * future-timestamp decision identical to the insert pass.
 */
async function validateSpoolFile(
  filePath: string,
  projectId: string,
  importNow: number,
): Promise<number> {
  const stream = fs.createReadStream(filePath);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let skipped = 0;

  try {
    for await (const raw of lines) {
      if (raw.trim() === "") continue;

      if (parseImportLine(raw, projectId, importNow) === null) skipped++;
    }
  } finally {
    // Closing the readline interface does not destroy its input stream.
    lines.close();
    stream.destroy();
  }

  return skipped;
}

/** Second pass: insert validated rows in bounded chunks, never a whole part. */
async function insertSpoolFile(
  storage: Storage,
  filePath: string,
  projectId: string,
  importNow: number,
): Promise<ArchiveImportResult> {
  const stream = fs.createReadStream(filePath);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let imported = 0;
  let skipped = 0;
  let batch: ImportRow[] = [];

  try {
    for await (const raw of lines) {
      if (raw.trim() === "") continue;

      const parsed = parseImportLine(raw, projectId, importNow);

      if (parsed === null) continue;

      const { line, level } = parsed;
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
        const flushed = await flushBatch(storage.db, batch);

        imported += flushed.imported;
        skipped += flushed.skipped;
        batch = [];
      }
    }

    if (batch.length > 0) {
      const flushed = await flushBatch(storage.db, batch);

      imported += flushed.imported;
      skipped += flushed.skipped;
    }

    return { imported, skipped };
  } finally {
    // Closing the readline interface does not destroy its input stream.
    lines.close();
    stream.destroy();
  }
}

interface ParsedImportLine {
  line: ArchiveLine;
  level: number;
}

/** Parse, cap, and project-check one archive line. Null means skip. */
function parseImportLine(
  raw: string,
  projectId: string,
  importNow: number,
): ParsedImportLine | null {
  const line = parseArchiveLine(raw);

  if (line === null) return null;

  if (
    line.uid.length > 128 ||
    line.message.length > MAX_IMPORT_MESSAGE ||
    (line.fields !== null && JSON.stringify(line.fields).length > MAX_IMPORT_FIELDS) ||
    (line.service?.length ?? 0) > 128 ||
    (line.env?.length ?? 0) > 64 ||
    line.ts > importNow + MAX_IMPORT_FUTURE_SKEW_MS
  ) {
    return null;
  }

  if (line.projectId.toLowerCase() !== projectId) {
    throw new ArchiveError("archive object contains events for another project", 400);
  }

  const level = archiveLevelIndex(line.level);

  if (level < 0) return null;

  return { line, level };
}

async function verifyPartDigest(
  db: KingletDb,
  objectKey: string,
  filename: string,
  actual: string,
): Promise<void> {
  const rows = await db
    .select({ sha256: schema.archiveParts.sha256 })
    .from(schema.archiveParts)
    .where(eq(schema.archiveParts.objectKey, objectKey))
    .limit(1);

  const cached = rows[0]?.sha256;

  if (cached !== undefined) {
    if (actual !== cached) {
      throw new ArchiveError("archive object checksum did not match the cached part", 502);
    }

    return;
  }

  // Importing a part from another instance may not have a local cache row.
  // The deterministic key still commits to the first 12 hex characters.
  const match = /^part-\d+-\d+-\d+-([0-9a-f]{12})\.ndjson\.zst(?:\.age)?$/.exec(filename);

  if (!match || !actual.startsWith(match[1] ?? "")) {
    throw new ArchiveError("archive object checksum did not match its key", 502);
  }
}

async function flushBatch(db: KingletDb, batch: ImportRow[]): Promise<ArchiveImportResult> {
  if (batch.length === 0) return { imported: 0, skipped: 0 };

  const inserted = await db
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
