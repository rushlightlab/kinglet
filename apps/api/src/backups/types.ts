import type { BackupPhase, BackupTrigger } from "../system-events.js";

/**
 * Public DTOs for the S3 snapshot feature. Routes and the web UI consume these;
 * nothing here contains credentials, bucket URLs, or manifest internals.
 */

export type BackupEncryption = "none" | "age";

export type BackupSnapshotState = "ready" | "missing";

/** Stored triggers plus the value used for rows discovered from the bucket. */
export type BackupSnapshotTrigger = BackupTrigger | "discovered";

export interface BackupCounts {
  projects: number;
  users: number;
  events: number;
  monitors: number;
}

export interface BackupSnapshot {
  id: string;
  /** Run that produced this snapshot; null for discovered rows. */
  runId: string | null;
  trigger: BackupSnapshotTrigger;
  createdAt: number;
  /** Uncompressed database size from the manifest. */
  sizeBytes: number;
  sha256: string;
  encryption: BackupEncryption;
  appVersion: string;
  schemaVersion: number;
  counts: BackupCounts;
  state: BackupSnapshotState;
  downloadedAt: number | null;
  downloadedBy: string | null;
  discovered: boolean;
}

export interface BackupSettings {
  id: number;
  enabled: boolean;
  scheduleCron: string;
  scheduleTimezone: string;
  retentionCount: number;
  updatedAt: number;
  /** Human-readable schedule description; derived, not persisted. */
  description: string;
}

export interface BackupStatus {
  configured: boolean;
  supported: boolean;
  /** Storage backend label for the UI: local SQLite or remote libSQL/Turso. */
  storage: "sqlite" | "remote-libsql";
  enabled: boolean;
  running: boolean;
  phase: BackupPhase | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  nextRunAt: number | null;
  lastError: string | null;
  databaseBytes: number | null;
  /** Required environment variable names only — never values. */
  setupMissing: string[];
  /** Extra operational context for the admin UI. */
  retentionCount: number;
  snapshotCount: number;
  scheduleCron: string;
  scheduleTimezone: string;
  encrypted: boolean;
  lastRefreshError: string | null;
  /** Human-readable setup or support problem; null when fully available. */
  problem: string | null;
}

export interface BackupDownload {
  url: string;
  filename: string;
  expiresAt: number;
}

/**
 * Manifest written last to `<prefix>/manifests/<id>.json`. It describes the
 * snapshot but never includes credentials, endpoints, or signed URLs.
 */
export interface BackupManifest {
  format: "kinglet-backup/v1";
  id: string;
  createdAt: number;
  appVersion: string;
  schemaVersion: number;
  /** Object key relative to the configured prefix, e.g. snapshots/<id>.db.zst. */
  object: string;
  /** Uncompressed database bytes. */
  sizeBytes: number;
  /** Stored object bytes after compression and optional encryption. */
  objectBytes: number;
  sha256: string;
  compression: "zstd";
  encryption: BackupEncryption;
  storage: "sqlite";
  counts: BackupCounts;
}

export type BackupErrorStatus = 400 | 404 | 409 | 500 | 502 | 503;

/** Expected, user-safe failure. Messages are sanitized before they get here. */
export class BackupError extends Error {
  readonly status: BackupErrorStatus;

  constructor(message: string, status: BackupErrorStatus = 500) {
    super(message);
    this.name = "BackupError";
    this.status = status;
  }
}
