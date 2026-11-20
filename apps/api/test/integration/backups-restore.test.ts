import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../../src/auth/ids.js";
import {
  buildManifest,
  MAX_MANIFEST_BYTES,
  serializeManifest,
} from "../../src/backups/manifest.js";
import type { ManifestInput } from "../../src/backups/manifest.js";
import { BackupError } from "../../src/backups/types.js";
import type { BackupManifest } from "../../src/backups/types.js";
import type { BackupConfig, Config } from "../../src/env.js";
import { finalizePendingRestore } from "../../src/restore/boot.js";
import {
  readRestoreMarker,
  RESTORE_MARKER_FORMAT,
  restorePaths,
  stagedDatabasePath,
  writeRestoreMarker,
} from "../../src/restore/marker.js";
import { endMaintenance, maintenanceState } from "../../src/restore/state.js";
import { stageLatestRestore, stageRestore } from "../../src/restore/stage.js";
import { createStorage } from "../../src/storage/index.js";
import { SCHEMA_VERSION } from "../../src/storage/schema.js";
import { InMemoryBackupStore } from "../helpers/backup-store.js";
import { makeTestConfig } from "../helpers/config.js";
import { createTempDatabase } from "../helpers/temp.js";
import type { TempDatabase } from "../helpers/temp.js";

const SIGNING_KEY = "task-5-manifest-signing-key-not-a-real-secret";
const PASSPHRASE = "task-5-backup-passphrase";
const SNAPSHOT_COUNTS = { projects: 1, users: 1, events: 0, monitors: 0 };

interface SnapshotFixture {
  raw: Buffer;
  compressed: Buffer;
  sha256: string;
}

let temp: TempDatabase | null = null;

beforeEach(() => {
  temp = createTempDatabase();
});

afterEach(async () => {
  // Staging flips a process-global gate; a failed assertion must not leak it.
  endMaintenance();

  const current = temp;

  temp = null;

  if (current !== null) await current.cleanup();
});

function currentTemp(): TempDatabase {
  if (temp === null) throw new Error("backups restore suite: temp directory missing");

  return temp;
}

function fixtureBackupConfig(overrides: Partial<BackupConfig> = {}): BackupConfig {
  return {
    bucket: "test-bucket",
    endpoint: "https://backup.invalid",
    region: "auto",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-access-key",
    prefix: "kinglet-test",
    forcePathStyle: true,
    sse: "none",
    partSizeBytes: 5 * 1024 * 1024,
    allowUnsignedManifests: false,
    allowUnencryptedSnapshots: false,
    maxSnapshotBytes: 64 * 1024 * 1024,
    ...overrides,
  };
}

function fixtureConfig(
  scratch: TempDatabase,
  backupOverrides: Partial<BackupConfig> = {},
  configOverrides: Partial<Config> = {},
): Config {
  return makeTestConfig({
    dbPath: scratch.dbPath,
    dataDir: scratch.directory,
    backup: fixtureBackupConfig(backupOverrides),
    ...configOverrides,
  });
}

function createSnapshotFixture(directory: string): SnapshotFixture {
  const databasePath = path.join(directory, `snapshot-source-${randomUUID()}.db`);
  const database = new DatabaseSync(databasePath);

  try {
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    database
      .prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)")
      .run("schema_version", String(SCHEMA_VERSION));
  } finally {
    database.close();
  }

  const raw = fs.readFileSync(databasePath);
  const compressed = zstdCompressSync(raw);

  return {
    raw,
    compressed,
    sha256: createHash("sha256").update(compressed).digest("hex"),
  };
}

function manifestFor(
  fixture: SnapshotFixture,
  overrides: Partial<ManifestInput> = {},
): BackupManifest {
  return buildManifest({
    id: uuidv7(),
    createdAt: Date.now(),
    appVersion: "0.3.0-test",
    schemaVersion: SCHEMA_VERSION,
    sizeBytes: fixture.raw.length,
    objectBytes: fixture.compressed.length,
    sha256: fixture.sha256,
    encryption: "none",
    counts: SNAPSHOT_COUNTS,
    ...overrides,
  });
}

function seedSnapshot(
  store: InMemoryBackupStore,
  manifest: BackupManifest,
  objectBody: Buffer,
): void {
  store.putObject(store.objectKey(manifest.id, manifest.encryption), objectBody);
  store.putManifest(store.manifestKey(manifest.id), serializeManifest(manifest));
}

async function backupErrorOf(action: Promise<unknown>): Promise<BackupError> {
  try {
    await action;
  } catch (cause) {
    if (cause instanceof BackupError) return cause;

    throw cause;
  }

  throw new Error("expected the restore operation to fail");
}

describe("restore staging", () => {
  it("stages a signed unencrypted snapshot and records the requesting user", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const manifest = store.signManifest(manifestFor(fixture, { id }));

    seedSnapshot(store, manifest, fixture.compressed);

    const requestedBy = uuidv7();

    const result = await stageRestore({
      config: fixtureConfig(scratch),
      snapshotId: id,
      userId: requestedBy,
      store,
    });

    expect(result).toEqual({ restartRequired: true, snapshotId: id });
    expect(fs.existsSync(stagedDatabasePath(scratch.directory, id))).toBe(true);
    expect(maintenanceState().active).toBe(true);

    const pending = await readRestoreMarker(restorePaths(scratch.directory).pendingPath);

    expect(pending.kind).toBe("ok");

    if (pending.kind !== "ok") throw new Error("expected the pending restore marker");

    expect(pending.marker.snapshotId).toBe(id);
    expect(pending.marker.source).toBe("snapshot");
    expect(pending.marker.requestedBy).toBe(requestedBy);
  });

  it("stages the latest snapshot and records a null requester for the CLI", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();

    seedSnapshot(store, store.signManifest(manifestFor(fixture, { id })), fixture.compressed);

    const result = await stageLatestRestore({ config: fixtureConfig(scratch), store });

    expect(result).toEqual({ restartRequired: true, snapshotId: id });
    expect(maintenanceState().active).toBe(true);

    const pending = await readRestoreMarker(restorePaths(scratch.directory).pendingPath);

    expect(pending.kind).toBe("ok");

    if (pending.kind !== "ok") throw new Error("expected the pending restore marker");

    expect(pending.marker.source).toBe("latest");
    expect(pending.marker.requestedBy).toBeNull();
  });

  it("rejects a snapshot id that is not a UUID", async () => {
    const scratch = currentTemp();
    const store = new InMemoryBackupStore(SIGNING_KEY);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: "not-a-uuid", store }),
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe("invalid snapshot id");
    expect(maintenanceState().active).toBe(false);
  });

  it("rejects an unsigned manifest", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();

    seedSnapshot(store, manifestFor(fixture, { id }), fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toContain("manifest is not signed");
    expect(fs.existsSync(stagedDatabasePath(scratch.directory, id))).toBe(false);
    expect(maintenanceState().active).toBe(false);
  });

  it("rejects a manifest whose signed fields were tampered with", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const signed = store.signManifest(manifestFor(fixture, { id }));
    const tampered: BackupManifest = { ...signed, createdAt: signed.createdAt + 1 };

    seedSnapshot(store, tampered, fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toContain("manifest signature is invalid");
    expect(maintenanceState().active).toBe(false);
  });

  it("rejects an object whose checksum does not match the manifest", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const manifest = store.signManifest(manifestFor(fixture, { id, sha256: "b".repeat(64) }));

    seedSnapshot(store, manifest, fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(502);
    expect(error.message).toContain("checksum did not match");
    expect(fs.existsSync(stagedDatabasePath(scratch.directory, id))).toBe(false);
  });

  it("rejects an object whose stored size does not match the manifest", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();

    const manifest = store.signManifest(
      manifestFor(fixture, { id, objectBytes: fixture.compressed.length + 1 }),
    );

    seedSnapshot(store, manifest, fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(502);
    expect(error.message).toContain("stored snapshot size did not match");
  });

  it("rejects a manifest with sizeBytes=0 before downloading", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const manifest = store.signManifest(manifestFor(fixture, { id, sizeBytes: 0 }));

    seedSnapshot(store, manifest, fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(502);
    expect(error.message).toBe("snapshot manifest is invalid");
  });

  it("rejects an oversized manifest", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const manifest = store.signManifest(manifestFor(fixture, { id }));
    const padded = `${serializeManifest(manifest)}${" ".repeat(MAX_MANIFEST_BYTES + 1024)}`;

    store.putManifest(store.manifestKey(id), padded);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(502);
    expect(error.message).toContain("manifest could not be read");
    expect(error.message).toContain("too large");
  });

  it("rejects an object above the configured snapshot cap", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();

    const manifest = store.signManifest(
      manifestFor(fixture, { id, objectBytes: 8192, sizeBytes: 2048 }),
    );

    store.putManifest(store.manifestKey(id), serializeManifest(manifest));

    const error = await backupErrorOf(
      stageRestore({
        config: fixtureConfig(scratch, { maxSnapshotBytes: 4096 }),
        snapshotId: id,
        store,
      }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toBe("snapshot exceeds the configured size limit");
  });

  it("rejects a database above the configured snapshot cap", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();

    const manifest = store.signManifest(
      manifestFor(fixture, { id, objectBytes: 1024, sizeBytes: 8192 }),
    );

    store.putManifest(store.manifestKey(id), serializeManifest(manifest));

    const error = await backupErrorOf(
      stageRestore({
        config: fixtureConfig(scratch, { maxSnapshotBytes: 4096 }),
        snapshotId: id,
        store,
      }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toBe("snapshot database exceeds the configured size limit");
  });

  it("rejects a snapshot from a newer schema", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();

    const manifest = store.signManifest(
      manifestFor(fixture, { id, schemaVersion: SCHEMA_VERSION + 1 }),
    );

    store.putManifest(store.manifestKey(id), serializeManifest(manifest));

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toContain("newer than this build");
  });

  it("rejects an unencrypted snapshot when a passphrase is configured", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const manifest = store.signManifest(manifestFor(fixture, { id, encryption: "none" }));

    seedSnapshot(store, manifest, fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({
        config: fixtureConfig(scratch, { passphrase: PASSPHRASE }),
        snapshotId: id,
        store,
      }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toContain("not age-encrypted");
    expect(fs.existsSync(stagedDatabasePath(scratch.directory, id))).toBe(false);
  });

  it("rejects an age snapshot when no passphrase is configured", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const manifest = store.signManifest(manifestFor(fixture, { id, encryption: "age" }));

    seedSnapshot(store, manifest, fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toContain("KINGLET_BACKUP_PASSPHRASE is not set");
  });

  it("refuses remote libSQL storage before touching the store", async () => {
    const scratch = currentTemp();
    const store = new InMemoryBackupStore(SIGNING_KEY);

    const error = await backupErrorOf(
      stageRestore({
        config: fixtureConfig(
          scratch,
          {},
          {
            dbPath: "libsql://kinglet-test.turso.io",
            storageKind: "libsql",
          },
        ),
        snapshotId: uuidv7(),
        store,
      }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toContain("remote libSQL/Turso");
  });
});

describe("finalizePendingRestore", () => {
  it("fails closed and keeps the applied marker when session clearing throws", async () => {
    const scratch = currentTemp();
    const paths = restorePaths(scratch.directory);
    const snapshotId = uuidv7();
    const now = Date.now();

    await writeRestoreMarker(paths.appliedPath, {
      format: RESTORE_MARKER_FORMAT,
      snapshotId,
      source: "snapshot",
      stagedAt: now,
      appliedAt: now,
      requestedBy: null,
    });

    const storage = await createStorage({ kind: "sqlite", dbPath: scratch.dbPath });
    const transactionSpy = vi.spyOn(storage.db, "transaction");

    try {
      transactionSpy.mockImplementation(async () => {
        throw new Error("simulated transaction failure");
      });

      await expect(
        finalizePendingRestore(storage, makeTestConfig({ dataDir: scratch.directory })),
      ).rejects.toThrow(/restore session clearing failed/);

      const applied = await readRestoreMarker(paths.appliedPath);

      expect(applied.kind).toBe("ok");
    } finally {
      transactionSpy.mockRestore();
      await storage.close();
    }
  });
});
