import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../../src/auth/ids.ts";
import { MAX_MANIFEST_BYTES, serializeManifest } from "../../src/backups/manifest.ts";
import { BackupError } from "../../src/backups/types.ts";
import type { BackupManifest } from "../../src/backups/types.ts";
import type { BackupConfig, Config } from "../../src/env.ts";
import { finalizePendingRestore } from "../../src/restore/boot.ts";
import {
  readRestoreMarker,
  RESTORE_MARKER_FORMAT,
  restorePaths,
  stagedDatabasePath,
  writeRestoreMarker,
} from "../../src/restore/marker.ts";
import { endMaintenance, maintenanceState } from "../../src/restore/state.ts";
import { stageLatestRestore, stageRestore } from "../../src/restore/stage.ts";
import { createStorage } from "../../src/storage/index.ts";
import { SCHEMA_VERSION } from "../../src/storage/schema.ts";
import { InMemoryBackupStore } from "../helpers/backup-store.ts";
import { jsonBody } from "../helpers/body.ts";
import { makeTestConfig } from "../helpers/config.ts";
import { request } from "../helpers/request.ts";
import { createTestSession } from "../helpers/session.ts";
import { createSnapshotFixture, manifestFor, seedSnapshot } from "../helpers/snapshot.ts";
import { createTempDatabase } from "../helpers/temp.ts";
import type { TempDatabase } from "../helpers/temp.ts";

const SIGNING_KEY = "task-5-manifest-signing-key-not-a-real-secret";
const PASSPHRASE = "task-5-backup-passphrase";
const OLDER_SNAPSHOT_ID = "0190f5b2-7c3a-7def-8abc-0123456789ab";
const NEWER_SNAPSHOT_ID = "0190f5b3-7c3a-7def-8abc-0123456789ab";

let temp: TempDatabase | null = null;

beforeEach(() => {
  temp = createTempDatabase();
});

afterEach(async () => {
  const current = temp;

  temp = null;

  // Staging flips a process-global gate; a failed assertion must not leak it,
  // and a maintenance failure must not skip the temporary-directory cleanup.
  const [maintenance, cleanup] = await Promise.allSettled([
    Promise.resolve().then(() => endMaintenance()),
    current === null ? Promise.resolve() : current.cleanup(),
  ]);

  if (maintenance.status === "rejected") throw maintenance.reason;

  if (cleanup.status === "rejected") throw cleanup.reason;
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

/** Any app-managed staging artifact (staged db, sidecar, part, or download). */
function stagedArtifacts(directory: string): string[] {
  const { restoreDir } = restorePaths(directory);

  if (!fs.existsSync(restoreDir)) return [];

  return fs.readdirSync(restoreDir).filter((name) => {
    return name.includes(".db") || name.endsWith(".part") || name.endsWith(".download");
  });
}

/** Every rejected stage path must leave the process and disk in a clean state. */
function expectRejectedStage(scratch: TempDatabase, store: InMemoryBackupStore): void {
  expect(maintenanceState().active).toBe(false);
  expect(stagedArtifacts(scratch.directory)).toEqual([]);
  expect(fs.existsSync(restorePaths(scratch.directory).pendingPath)).toBe(false);
  expect(store.destroy).not.toHaveBeenCalled();
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
    const destroy = vi.spyOn(store, "destroy");

    const result = await stageRestore({
      config: fixtureConfig(scratch),
      snapshotId: id,
      userId: requestedBy,
      store,
    });

    expect(result).toEqual({ restartRequired: true, snapshotId: id });
    expect(destroy).not.toHaveBeenCalled();
    expect(maintenanceState().active).toBe(true);

    const stagedPath = stagedDatabasePath(scratch.directory, id);
    const staged = fs.readFileSync(stagedPath);
    const stagedSha256 = createHash("sha256").update(staged).digest("hex");

    expect(staged.length).toBe(fixture.raw.length);
    expect(stagedSha256).toBe(fixture.rawSha256);
    expect(stagedArtifacts(scratch.directory)).toEqual([`kinglet-${id}.db`]);

    const pending = await readRestoreMarker(restorePaths(scratch.directory).pendingPath);

    expect(pending.kind).toBe("ok");

    if (pending.kind !== "ok") throw new Error("expected the pending restore marker");

    expect(pending.marker.snapshotId).toBe(id);
    expect(pending.marker.source).toBe("snapshot");
    expect(pending.marker.requestedBy).toBe(requestedBy);
  });

  it("skips an invalid newer manifest and stages the latest valid snapshot", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const destroy = vi.spyOn(store, "destroy");

    const olderManifest = store.signManifest(manifestFor(fixture, { id: OLDER_SNAPSHOT_ID }));
    const newerSigned = store.signManifest(manifestFor(fixture, { id: NEWER_SNAPSHOT_ID }));

    const newerInvalid: BackupManifest = {
      ...newerSigned,
      sizeBytes: newerSigned.sizeBytes + 1,
    };

    seedSnapshot(store, olderManifest, fixture.compressed);
    seedSnapshot(store, newerInvalid, fixture.compressed);

    const result = await stageLatestRestore({ config: fixtureConfig(scratch), store });

    expect(result).toEqual({ restartRequired: true, snapshotId: OLDER_SNAPSHOT_ID });
    expect(destroy).not.toHaveBeenCalled();
    expect(fs.existsSync(stagedDatabasePath(scratch.directory, NEWER_SNAPSHOT_ID))).toBe(false);
    expect(fs.statSync(stagedDatabasePath(scratch.directory, OLDER_SNAPSHOT_ID)).size).toBe(
      fixture.raw.length,
    );
    expect(stagedArtifacts(scratch.directory)).toEqual([`kinglet-${OLDER_SNAPSHOT_ID}.db`]);

    const pending = await readRestoreMarker(restorePaths(scratch.directory).pendingPath);

    expect(pending.kind).toBe("ok");

    if (pending.kind !== "ok") throw new Error("expected the pending restore marker");

    expect(pending.marker.snapshotId).toBe(OLDER_SNAPSHOT_ID);
    expect(pending.marker.source).toBe("latest");
    expect(pending.marker.requestedBy).toBeNull();
  });

  it("stages the latest snapshot and records a null requester for the CLI", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const destroy = vi.spyOn(store, "destroy");

    seedSnapshot(store, store.signManifest(manifestFor(fixture, { id })), fixture.compressed);

    const result = await stageLatestRestore({ config: fixtureConfig(scratch), store });

    expect(result).toEqual({ restartRequired: true, snapshotId: id });
    expect(destroy).not.toHaveBeenCalled();
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
    const destroy = vi.spyOn(store, "destroy");

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: "not-a-uuid", store }),
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe("invalid snapshot id");
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("rejects an unsigned manifest", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const destroy = vi.spyOn(store, "destroy");

    seedSnapshot(store, manifestFor(fixture, { id }), fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toContain("manifest is not signed");
    expect(fs.existsSync(stagedDatabasePath(scratch.directory, id))).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("rejects a manifest whose signed fields were tampered with", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const signed = store.signManifest(manifestFor(fixture, { id }));
    const tampered: BackupManifest = { ...signed, createdAt: signed.createdAt + 1 };
    const destroy = vi.spyOn(store, "destroy");

    seedSnapshot(store, tampered, fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toContain("manifest signature is invalid");
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("rejects an object whose checksum does not match the manifest", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const manifest = store.signManifest(manifestFor(fixture, { id, sha256: "b".repeat(64) }));
    const destroy = vi.spyOn(store, "destroy");

    seedSnapshot(store, manifest, fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(502);
    expect(error.message).toContain("checksum did not match");
    expect(fs.existsSync(stagedDatabasePath(scratch.directory, id))).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("rejects an object whose stored size does not match the manifest", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();

    const manifest = store.signManifest(
      manifestFor(fixture, { id, objectBytes: fixture.compressed.length + 1 }),
    );

    const destroy = vi.spyOn(store, "destroy");

    seedSnapshot(store, manifest, fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(502);
    expect(error.message).toContain("stored snapshot size did not match");
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("stops a download that runs past the manifest size when HEAD has no length", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();

    const manifest = store.signManifest(
      manifestFor(fixture, { id, objectBytes: fixture.compressed.length - 1 }),
    );

    const destroy = vi.spyOn(store, "destroy");

    seedSnapshot(store, manifest, fixture.compressed);
    // Some S3-compatible stores omit ContentLength, so only the stream can tell.
    vi.spyOn(store, "headObject").mockResolvedValue({});

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(502);
    expect(error.message).toContain("larger than the expected");
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("rejects a manifest with sizeBytes=0 before downloading", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const manifest = store.signManifest(manifestFor(fixture, { id, sizeBytes: 0 }));
    const destroy = vi.spyOn(store, "destroy");

    seedSnapshot(store, manifest, fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(502);
    expect(error.message).toBe("snapshot manifest is invalid");
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("rejects an oversized manifest", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const manifest = store.signManifest(manifestFor(fixture, { id }));
    const padded = `${serializeManifest(manifest)}${" ".repeat(MAX_MANIFEST_BYTES + 1024)}`;
    const destroy = vi.spyOn(store, "destroy");

    store.putManifest(store.manifestKey(id), padded);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(502);
    expect(error.message).toContain("manifest could not be read");
    expect(error.message).toContain("too large");
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("rejects an object above the configured snapshot cap", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();

    const manifest = store.signManifest(
      manifestFor(fixture, { id, objectBytes: 8192, sizeBytes: 2048 }),
    );

    const destroy = vi.spyOn(store, "destroy");

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
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("rejects a database above the configured snapshot cap", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();

    const manifest = store.signManifest(
      manifestFor(fixture, { id, objectBytes: 1024, sizeBytes: 8192 }),
    );

    const destroy = vi.spyOn(store, "destroy");

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
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("rejects a snapshot from a newer schema", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();

    const manifest = store.signManifest(
      manifestFor(fixture, { id, schemaVersion: SCHEMA_VERSION + 1 }),
    );

    const destroy = vi.spyOn(store, "destroy");

    store.putManifest(store.manifestKey(id), serializeManifest(manifest));

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toContain("newer than this build");
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("rejects an unencrypted snapshot when a passphrase is configured", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const manifest = store.signManifest(manifestFor(fixture, { id, encryption: "none" }));
    const destroy = vi.spyOn(store, "destroy");

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
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("rejects an age snapshot when no passphrase is configured", async () => {
    const scratch = currentTemp();
    const fixture = createSnapshotFixture(scratch.directory);
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const id = uuidv7();
    const manifest = store.signManifest(manifestFor(fixture, { id, encryption: "age" }));
    const destroy = vi.spyOn(store, "destroy");

    seedSnapshot(store, manifest, fixture.compressed);

    const error = await backupErrorOf(
      stageRestore({ config: fixtureConfig(scratch), snapshotId: id, store }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toContain("KINGLET_BACKUP_PASSPHRASE is not set");
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });

  it("refuses remote libSQL storage before touching the store", async () => {
    const scratch = currentTemp();
    const store = new InMemoryBackupStore(SIGNING_KEY);
    const destroy = vi.spyOn(store, "destroy");

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
    expect(destroy).not.toHaveBeenCalled();
    expectRejectedStage(scratch, store);
  });
});

describe("restore route", () => {
  it("records the authenticated admin as requestedBy and keeps the injected store", async () => {
    const store = new InMemoryBackupStore(SIGNING_KEY);

    const session = await createTestSession({
      config: { backup: fixtureBackupConfig() },
      restoreStore: store,
    });

    try {
      const fixture = createSnapshotFixture(session.harness.config.dataDir);
      const id = uuidv7();

      seedSnapshot(store, store.signManifest(manifestFor(fixture, { id })), fixture.compressed);

      const destroy = vi.spyOn(store, "destroy");

      const denied = await request(session.harness.app, `/v1/backups/${id}/restore`, {
        method: "POST",
        cookies: session.memberJar,
      });

      expect(denied.status).toBe(403);
      expect(await jsonBody(denied)).toEqual({ error: "forbidden" });
      expect(destroy).not.toHaveBeenCalled();
      expect(maintenanceState().active).toBe(false);
      expect(fs.existsSync(restorePaths(session.harness.config.dataDir).pendingPath)).toBe(false);

      const response = await request(session.harness.app, `/v1/backups/${id}/restore`, {
        method: "POST",
        cookies: session.adminJar,
      });

      expect(response.status).toBe(202);
      expect(await jsonBody(response)).toEqual({
        ok: true,
        staged: true,
        restartRequired: true,
        snapshotId: id,
      });
      expect(destroy).not.toHaveBeenCalled();
      expect(maintenanceState().active).toBe(true);

      const pending = await readRestoreMarker(
        restorePaths(session.harness.config.dataDir).pendingPath,
      );

      expect(pending.kind).toBe("ok");

      if (pending.kind !== "ok") throw new Error("expected the pending restore marker");

      expect(pending.marker.snapshotId).toBe(id);
      expect(pending.marker.source).toBe("snapshot");
      expect(pending.marker.requestedBy).toBe(session.harness.admin.id);

      const staged = fs.readFileSync(stagedDatabasePath(session.harness.config.dataDir, id));

      expect(staged.length).toBe(fixture.raw.length);
      expect(createHash("sha256").update(staged).digest("hex")).toBe(fixture.rawSha256);
      expect(stagedArtifacts(session.harness.config.dataDir)).toEqual([`kinglet-${id}.db`]);
    } finally {
      await session.close();
    }
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
