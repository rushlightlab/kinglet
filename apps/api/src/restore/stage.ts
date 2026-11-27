import { Decrypter } from "age-encryption";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { isUuid } from "../auth/ids.ts";
import { MAX_MANIFEST_BYTES, parseManifest } from "../backups/manifest.ts";
import { BackupStore, describeBackupError, downloadToFile } from "../backups/s3.ts";
import type { BackupObject, BackupObjectHead, BackupObjectStore } from "../backups/s3.ts";
import { BackupError } from "../backups/types.ts";
import type { BackupManifest } from "../backups/types.ts";
import type { Config } from "../env.ts";
import { SCHEMA_VERSION } from "../storage/schema.ts";
import {
  RESTORE_MARKER_FORMAT,
  restorePaths,
  stagedDatabasePath,
  writeRestoreMarker,
} from "./marker.ts";
import type { RestoreSource } from "./marker.ts";
import { beginMaintenance, endMaintenance } from "./state.ts";
import {
  databaseSidecarPaths,
  inspectDatabase,
  localDatabasePath,
  moveFileOver,
  removeFile,
  sha256File,
} from "./util.ts";
import type { DatabaseCheck } from "./util.ts";

/**
 * Restore staging.
 *
 * The live database is never touched here. A snapshot is downloaded, verified,
 * decrypted, decompressed, checked with PRAGMA integrity_check, and written
 * under `<dataDir>/restore/`. Only then is `pending.json` written and
 * maintenance entered. Boot applies the swap; the CLI uses the same path on a
 * fresh host before the server starts.
 */

export interface StageRestoreOptions {
  config: Config;
  snapshotId: string;
  userId?: string | null;
  /**
   * Storage adapter override. Production omits it and staging creates and
   * destroys a BackupStore; tests can inject an in-memory adapter.
   */
  store?: BackupObjectStore;
}

export interface StageLatestRestoreOptions {
  config: Config;
  userId?: string | null;
  /** See StageRestoreOptions.store. */
  store?: BackupObjectStore;
}

export interface StageRestoreResult {
  restartRequired: boolean;
  snapshotId: string;
}

let staging = false;

export async function stageRestore(options: StageRestoreOptions): Promise<StageRestoreResult> {
  const store = requireBackupStore(options.config, options.store);

  try {
    return await stageSnapshot(
      options.config,
      options.snapshotId,
      "snapshot",
      store,
      options.userId,
    );
  } finally {
    if (options.store === undefined) store.destroy();
  }
}

export async function stageLatestRestore(
  options: StageLatestRestoreOptions,
): Promise<StageRestoreResult> {
  const store = requireBackupStore(options.config, options.store);

  try {
    const snapshotId = await findLatestSnapshotId(
      store,
      options.config.backup?.allowUnsignedManifests ?? false,
    );

    return await stageSnapshot(options.config, snapshotId, "latest", store, options.userId);
  } finally {
    if (options.store === undefined) store.destroy();
  }
}

function requireBackupStore(config: Config, injected?: BackupObjectStore): BackupObjectStore {
  if (config.backup === null) {
    const problem =
      config.backupProblem === null
        ? "S3 backups are not configured"
        : `S3 backup configuration is incomplete: ${config.backupProblem}`;

    throw new BackupError(problem, 409);
  }

  if (localDatabasePath(config) === null) {
    throw new BackupError(
      "restore requires local SQLite storage; remote libSQL/Turso databases must use provider point-in-time recovery",
      409,
    );
  }

  if (injected !== undefined) return injected;

  try {
    return new BackupStore(config.backup);
  } catch (cause) {
    throw new BackupError(`S3 client could not be initialized: ${describeBackupError(cause)}`, 502);
  }
}

async function findLatestSnapshotId(
  store: BackupObjectStore,
  allowUnsignedManifests: boolean,
): Promise<string> {
  let objects: BackupObject[];

  try {
    objects = await store.listObjects(store.manifestPrefix);
  } catch (cause) {
    throw new BackupError(`snapshots could not be listed: ${describeBackupError(cause)}`, 502);
  }

  const ids: string[] = [];

  for (const object of objects) {
    const id = store.manifestId(object.key);

    if (id !== null) ids.push(id);
  }

  // Snapshot ids are UUIDv7, so descending lexical order is newest first.
  ids.sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));

  for (const id of ids) {
    let raw: string;

    try {
      raw = await store.getObjectText(store.manifestKey(id), MAX_MANIFEST_BYTES);
    } catch {
      continue;
    }

    const manifest = parseManifest(raw);

    if (manifest === null || manifest.id !== id) continue;

    if (manifest.signature === undefined) {
      if (!allowUnsignedManifests) continue;
    } else if (!store.verifyManifestSignature(manifest)) {
      continue;
    }

    return id;
  }

  throw new BackupError("no restorable snapshots were found in the bucket", 404);
}

async function stageSnapshot(
  config: Config,
  snapshotId: string,
  source: RestoreSource,
  store: BackupObjectStore,
  userId?: string | null,
): Promise<StageRestoreResult> {
  if (staging) throw new BackupError("a restore is already being staged", 409);

  const id = snapshotId.toLowerCase();

  if (!isUuid(id)) throw new BackupError("invalid snapshot id", 400);

  const backup = config.backup;

  if (backup === null) throw new BackupError("S3 backups are not configured", 409);

  staging = true;

  const paths = restorePaths(config.dataDir);
  const stagedPath = stagedDatabasePath(config.dataDir, id);
  const downloadPath = path.join(paths.restoreDir, `kinglet-${id}.db.download`);
  const partPath = `${stagedPath}.part`;
  let maintenance = false;
  let markerWritten = false;
  let stagedWritten = false;

  try {
    await fs.promises.mkdir(paths.restoreDir, { recursive: true, mode: 0o700 });

    const manifest = await loadManifest(store, id, backup);

    assertRestorable(manifest, backup);
    await assertRestoreDiskSpace(config.dataDir, manifest);

    await removeFile(downloadPath);
    await removeFile(partPath);

    const objectKey = store.objectKey(id, manifest.encryption);
    let head: BackupObjectHead;

    try {
      head = await store.headObject(objectKey);
    } catch (cause) {
      throw new BackupError(
        `snapshot could not be verified before download: ${describeBackupError(cause)}`,
        502,
      );
    }

    if (head.ContentLength !== undefined && head.ContentLength !== manifest.objectBytes) {
      throw new BackupError("stored snapshot size did not match the manifest", 502);
    }

    let downloadedBytes: number;

    try {
      downloadedBytes = await downloadToFile(store, objectKey, downloadPath, {
        maxBytes: manifest.objectBytes,
      });
    } catch (cause) {
      throw new BackupError(`snapshot download failed: ${describeBackupError(cause)}`, 502);
    }

    if (downloadedBytes !== manifest.objectBytes) {
      throw new BackupError("downloaded snapshot size did not match the manifest", 502);
    }

    const digest = await sha256File(downloadPath);

    if (digest.toLowerCase() !== manifest.sha256.toLowerCase()) {
      throw new BackupError("downloaded snapshot checksum did not match the manifest", 502);
    }

    const decodedBytes = await decodeSnapshot(downloadPath, partPath, manifest, backup.passphrase);

    if (decodedBytes !== manifest.sizeBytes) {
      throw new BackupError("decompressed snapshot size did not match the manifest", 502);
    }

    let check: DatabaseCheck;

    try {
      check = await inspectDatabase(partPath);
    } catch (cause) {
      throw new BackupError(
        `staged database could not be opened for verification: ${describeBackupError(cause)}`,
        409,
      );
    }

    if (!check.integrityOk) {
      throw new BackupError("snapshot database failed the integrity check", 409);
    }

    if (check.schemaVersion !== null && check.schemaVersion > SCHEMA_VERSION) {
      throw new BackupError(schemaTooNewMessage(check.schemaVersion), 409);
    }

    // Opening a WAL-mode database for the check can leave sidecars; the staged
    // file must arrive at boot as a single self-contained database.
    const partSidecars = databaseSidecarPaths(partPath);

    await removeFile(partSidecars.wal);
    await removeFile(partSidecars.shm);
    await moveFileOver(partPath, stagedPath);
    stagedWritten = true;

    beginMaintenance(`restoring snapshot ${id}`);
    maintenance = true;

    await writeRestoreMarker(paths.pendingPath, {
      format: RESTORE_MARKER_FORMAT,
      snapshotId: id,
      source,
      stagedAt: Date.now(),
      requestedBy: userId ?? null,
    });
    markerWritten = true;

    try {
      await cleanupOtherStagedFiles(config.dataDir, id);
    } catch (cause) {
      // The new marker is durable; a stale file must not invalidate it.
      console.warn(
        "[kinglet] could not remove an older staged snapshot:",
        describeBackupError(cause),
      );
    }

    return { restartRequired: true, snapshotId: id };
  } catch (cause) {
    if (stagedWritten && !markerWritten) await removeFile(stagedPath);

    if (maintenance) endMaintenance();

    if (cause instanceof BackupError) throw cause;

    throw new BackupError(describeBackupError(cause), 500);
  } finally {
    staging = false;
    await removeFile(downloadPath);
    await removeFile(partPath);
  }
}

async function loadManifest(
  store: BackupObjectStore,
  id: string,
  backup: NonNullable<Config["backup"]>,
): Promise<BackupManifest> {
  let raw: string;

  try {
    raw = await store.getObjectText(store.manifestKey(id), MAX_MANIFEST_BYTES);
  } catch (cause) {
    throw new BackupError(
      `snapshot manifest could not be read: ${describeBackupError(cause)}`,
      502,
    );
  }

  const manifest = parseManifest(raw);

  if (manifest === null || manifest.id !== id) {
    throw new BackupError("snapshot manifest is invalid", 502);
  }

  if (manifest.signature === undefined) {
    if (!backup.allowUnsignedManifests) {
      throw new BackupError(
        "snapshot manifest is not signed; set KINGLET_BACKUP_ALLOW_UNSIGNED_MANIFESTS=1 only for legacy snapshots",
        409,
      );
    }
  } else if (!store.verifyManifestSignature(manifest)) {
    throw new BackupError("snapshot manifest signature is invalid", 409);
  }

  return manifest;
}

function assertRestorable(manifest: BackupManifest, backup: NonNullable<Config["backup"]>): void {
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new BackupError(schemaTooNewMessage(manifest.schemaVersion), 409);
  }

  if (manifest.objectBytes > backup.maxSnapshotBytes) {
    throw new BackupError("snapshot exceeds the configured size limit", 409);
  }

  if (manifest.sizeBytes > backup.maxSnapshotBytes) {
    throw new BackupError("snapshot database exceeds the configured size limit", 409);
  }

  if (
    manifest.encryption === "age" &&
    (backup.passphrase === undefined || backup.passphrase === "")
  ) {
    throw new BackupError(
      "snapshot is age-encrypted but KINGLET_BACKUP_PASSPHRASE is not set",
      409,
    );
  }

  // If a passphrase is configured, do not let a bucket writer choose an
  // unencrypted snapshot. The escape hatch exists only for legacy snapshots.
  if (
    backup.passphrase !== undefined &&
    backup.passphrase !== "" &&
    manifest.encryption !== "age" &&
    !backup.allowUnencryptedSnapshots
  ) {
    throw new BackupError(
      "snapshot is not age-encrypted; set KINGLET_BACKUP_ALLOW_UNENCRYPTED_SNAPSHOTS=1 only for legacy snapshots",
      409,
    );
  }
}

async function assertRestoreDiskSpace(dataDir: string, manifest: BackupManifest): Promise<void> {
  const margin = Math.max(64 * 1024 * 1024, Math.ceil(manifest.sizeBytes * 0.25));
  const required = manifest.objectBytes + manifest.sizeBytes + margin;

  try {
    const stats = await fs.promises.statfs(dataDir);
    const free = Number(stats.bavail) * Number(stats.bsize);

    if (Number.isFinite(free) && free < required) {
      throw new BackupError("not enough free disk space to stage the snapshot", 409);
    }
  } catch (cause) {
    if (cause instanceof BackupError) throw cause;

    console.warn("[kinglet] restore disk check skipped:", describeBackupError(cause));
  }
}

function schemaTooNewMessage(snapshotSchema: number): string {
  return (
    `snapshot schema v${snapshotSchema} is newer than this build ` +
    `(v${SCHEMA_VERSION}); upgrade Kinglet before restoring`
  );
}

async function decodeSnapshot(
  sourcePath: string,
  destinationPath: string,
  manifest: BackupManifest,
  passphrase: string | undefined,
): Promise<number> {
  let source: Readable = fs.createReadStream(sourcePath, { highWaterMark: 1024 * 1024 });

  if (manifest.encryption === "age") {
    if (passphrase === undefined) {
      throw new BackupError(
        "snapshot is age-encrypted but KINGLET_BACKUP_PASSPHRASE is not set",
        409,
      );
    }

    const decrypter = new Decrypter();

    decrypter.addPassphrase(passphrase);

    try {
      const decrypted = await decrypter.decrypt(Readable.toWeb(source));

      source = Readable.fromWeb(decrypted);
    } catch {
      source.destroy();
      throw new BackupError(
        "snapshot could not be decrypted; check KINGLET_BACKUP_PASSPHRASE",
        409,
      );
    }
  }

  let decodedBytes = 0;
  const decodedLimit = manifest.sizeBytes;

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      decodedBytes += buffer.length;

      if (decodedBytes > decodedLimit) {
        callback(new Error("decompressed snapshot exceeded the manifest size"));

        return;
      }

      callback(null, buffer);
    },
  });

  try {
    await pipeline(source, createZstdDecompress(), meter, fs.createWriteStream(destinationPath));
  } catch (cause) {
    if (manifest.encryption === "age") {
      throw new BackupError(
        `snapshot could not be decrypted or decompressed: ${describeBackupError(cause)}`,
        409,
      );
    }

    throw new BackupError(`snapshot decompression failed: ${describeBackupError(cause)}`, 502);
  }

  return decodedBytes;
}

/**
 * A previous staged snapshot (possibly from a crashed attempt) must not linger
 * next to the newly staged one. Only app-managed names in the restore directory
 * are removed.
 */
async function cleanupOtherStagedFiles(dataDir: string, keepSnapshotId: string): Promise<void> {
  const { restoreDir } = restorePaths(dataDir);
  const keep = `kinglet-${keepSnapshotId}.db`;
  let names: string[];

  try {
    names = await fs.promises.readdir(restoreDir);
  } catch {
    return;
  }

  for (const name of names) {
    if (name === keep || !name.startsWith("kinglet-")) continue;

    const managed =
      name.endsWith(".db") ||
      name.endsWith(".db-wal") ||
      name.endsWith(".db-shm") ||
      name.endsWith(".db.part") ||
      name.endsWith(".db.download");

    if (managed) await removeFile(path.join(restoreDir, name));
  }
}
