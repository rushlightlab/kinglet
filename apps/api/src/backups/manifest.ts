import { isUuid } from "../auth/ids.js";
import { isFiniteNumber, isJsonObject, isString } from "../json.js";
import type { JsonObject } from "../json.js";
import { relativeObjectKey } from "./s3.js";
import type { BackupCounts, BackupEncryption, BackupManifest } from "./types.js";

/**
 * Manifest serialization and parsing. A manifest is the bucket's source of
 * truth for one snapshot, so parsing is strict and rejects unknown formats,
 * mismatched object paths, and impossible counts.
 */

export const MANIFEST_FORMAT = "kinglet-backup/v1";
export const MAX_MANIFEST_BYTES = 64 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface ManifestInput {
  id: string;
  createdAt: number;
  appVersion: string;
  schemaVersion: number;
  sizeBytes: number;
  objectBytes: number;
  sha256: string;
  encryption: BackupEncryption;
  counts: BackupCounts;
}

export function buildManifest(input: ManifestInput): BackupManifest {
  return {
    format: MANIFEST_FORMAT,
    id: input.id,
    createdAt: input.createdAt,
    appVersion: input.appVersion,
    schemaVersion: input.schemaVersion,
    object: relativeObjectKey(input.id, input.encryption),
    sizeBytes: input.sizeBytes,
    objectBytes: input.objectBytes,
    sha256: input.sha256,
    compression: "zstd",
    encryption: input.encryption,
    storage: "sqlite",
    counts: input.counts,
  };
}

export function serializeManifest(manifest: BackupManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

export function parseManifest(raw: string): BackupManifest | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isJsonObject(parsed)) return null;

  if (parsed.format !== MANIFEST_FORMAT) return null;

  if (!isString(parsed.id) || !isUuid(parsed.id)) return null;

  if (!isNonNegativeInt(parsed.createdAt) || parsed.createdAt === 0) return null;

  if (!isString(parsed.appVersion) || parsed.appVersion.length === 0) return null;

  if (parsed.appVersion.length > 64) return null;

  if (!isPositiveInt(parsed.schemaVersion)) return null;

  if (!isNonNegativeInt(parsed.sizeBytes)) return null;

  if (!isPositiveInt(parsed.objectBytes)) return null;

  if (!isString(parsed.sha256) || !SHA256_RE.test(parsed.sha256)) return null;

  if (parsed.compression !== "zstd" || parsed.storage !== "sqlite") return null;

  const encryption = parsed.encryption;

  if (encryption !== "none" && encryption !== "age") return null;

  if (!isString(parsed.object)) return null;

  if (parsed.object !== relativeObjectKey(parsed.id, encryption)) return null;

  if (!isJsonObject(parsed.counts)) return null;

  return {
    format: MANIFEST_FORMAT,
    id: parsed.id,
    createdAt: parsed.createdAt,
    appVersion: parsed.appVersion,
    schemaVersion: parsed.schemaVersion,
    object: parsed.object,
    sizeBytes: parsed.sizeBytes,
    objectBytes: parsed.objectBytes,
    sha256: parsed.sha256,
    compression: "zstd",
    encryption,
    storage: "sqlite",
    counts: {
      projects: readCount(parsed.counts, "projects"),
      users: readCount(parsed.counts, "users"),
      events: readCount(parsed.counts, "events"),
      monitors: readCount(parsed.counts, "monitors"),
    },
  };
}

export function parseCountsJson(raw: string): BackupCounts {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyCounts();
  }

  if (!isJsonObject(parsed)) return emptyCounts();

  return {
    projects: readCount(parsed, "projects"),
    users: readCount(parsed, "users"),
    events: readCount(parsed, "events"),
    monitors: readCount(parsed, "monitors"),
  };
}

export function countsToJson(counts: BackupCounts): string {
  return JSON.stringify(counts);
}

export function emptyCounts(): BackupCounts {
  return { projects: 0, users: 0, events: 0, monitors: 0 };
}

function readCount(source: JsonObject, key: keyof BackupCounts): number {
  const value = source[key];

  return isNonNegativeInt(value) ? value : 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return isNonNegativeInt(value) && value > 0;
}
