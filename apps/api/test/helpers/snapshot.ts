import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { uuidv7 } from "../../src/auth/ids.js";
import { buildManifest, serializeManifest } from "../../src/backups/manifest.js";
import type { ManifestInput } from "../../src/backups/manifest.js";
import type { BackupManifest } from "../../src/backups/types.js";
import { SCHEMA_VERSION } from "../../src/storage/schema.js";
import type { InMemoryBackupStore } from "./backup-store.js";

/**
 * Deterministic snapshot fixtures for restore tests: a tiny SQLite database
 * carrying the current schema version, its zstd object, and matching manifest.
 * Nothing here touches S3 or the network.
 */

export const SNAPSHOT_COUNTS = { projects: 1, users: 1, events: 0, monitors: 0 };

export interface SnapshotFixture {
  raw: Buffer;
  rawSha256: string;
  compressed: Buffer;
  compressedSha256: string;
}

export function createSnapshotFixture(directory: string): SnapshotFixture {
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
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    compressed,
    compressedSha256: createHash("sha256").update(compressed).digest("hex"),
  };
}

export function manifestFor(
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
    sha256: fixture.compressedSha256,
    encryption: "none",
    counts: SNAPSHOT_COUNTS,
    ...overrides,
  });
}

export function seedSnapshot(
  store: InMemoryBackupStore,
  manifest: BackupManifest,
  objectBody: Buffer,
): void {
  store.putObject(store.objectKey(manifest.id, manifest.encryption), objectBody);
  store.putManifest(store.manifestKey(manifest.id), serializeManifest(manifest));
}
