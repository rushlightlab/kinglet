import type { JsonObject } from "../json.ts";

/**
 * Public DTOs for the S3 log archive.
 *
 * The archive is not a backup: one `archive_parts` row addresses one immutable
 * NDJSON object containing whole events (not a database snapshot). Nothing in
 * these types carries credentials, bucket endpoints, or signed URLs.
 */

/** Pipeline phases reported over `/v1/system/events`. */
export type ArchivePhase = "select" | "compress" | "encrypt" | "upload" | "verify" | "delete";

export type ArchiveEncryption = "none" | "age";

export interface ArchiveProjectSetting {
  projectId: string;
  enabled: boolean;
}

/**
 * Persisted archive settings plus the derived schedule description and project
 * toggles. `configured`/`supported` are runtime facts and live on the view.
 */
export interface ArchiveSettings {
  id: number;
  enabled: boolean;
  scheduleCron: string;
  scheduleTimezone: string;
  deleteOnFailure: boolean;
  updatedAt: number;
  /** Human-readable schedule description; derived, not persisted. */
  description: string;
  /** Row per project that has an explicit toggle; missing means off. */
  projects: ArchiveProjectSetting[];
}

export interface ArchiveSettingsView extends ArchiveSettings {
  /** S3 credentials and endpoint are present. */
  configured: boolean;
  /** The running storage/driver supports the archive pipeline. */
  supported: boolean;
  /** Next three scheduled run times as epoch milliseconds. */
  nextRuns: number[];
}

export interface ArchiveProjectToggle {
  projectId: string;
  enabled: boolean;
}

export interface ArchiveSettingsUpdate {
  enabled?: boolean;
  scheduleCron?: string;
  scheduleTimezone?: string;
  deleteOnFailure?: boolean;
  projects?: readonly ArchiveProjectToggle[];
}

/** One immutable archived object, as cached in `archive_parts`. */
export interface ArchivePart {
  id: string;
  projectId: string;
  /** UTC date partition, `YYYY-MM-DD`. */
  date: string;
  firstId: number;
  lastId: number;
  eventCount: number;
  /** SHA-256 of the uncompressed NDJSON (hex). */
  sha256: string;
  /** Stored object bytes after compression and optional encryption. */
  sizeBytes: number;
  createdAt: number;
}

export interface ArchiveStatus {
  configured: boolean;
  supported: boolean;
  enabled: boolean;
  running: boolean;
  phase: ArchivePhase | null;
  /** Project currently being exported, if any. */
  projectId: string | null;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastSkippedAt: number | null;
  lastError: string | null;
  nextRunAt: number | null;
  scheduleCron: string;
  scheduleTimezone: string;
  deleteOnFailure: boolean;
  /** Events older than this many days are eligible for export. */
  intervalDays: number;
  enabledProjectIds: string[];
  archivedEvents: number;
  archivedBytes: number;
  /** Human-readable setup/support problem; null when fully available. */
  problem: string | null;
}

export interface ArchiveRunHandle {
  runId: string;
}

export interface ArchivePartsQuery {
  projectId?: string;
  /** Inclusive UTC date bound, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive UTC date bound, `YYYY-MM-DD`. */
  to?: string;
  limit?: number;
}

export interface ArchiveImportRequest {
  projectId: string;
  from?: string;
  to?: string;
}

export interface ArchiveImportResult {
  imported: number;
  skipped: number;
}

/**
 * One NDJSON line. `sourceId` is traceability only and is never inserted as a
 * rowid on import; `uid` is the identity used for idempotent re-imports.
 */
export interface ArchiveLine {
  v: 1;
  uid: string;
  sourceId: number;
  projectId: string;
  ts: number;
  /** Level name, not the integer. */
  level: string;
  service: string | null;
  env: string | null;
  message: string;
  fields: JsonObject | null;
}

/** Source row shape used while exporting. */
export interface ArchiveEventRow {
  id: number;
  uid: string | null;
  ts: number;
  level: number;
  service: string | null;
  env: string | null;
  message: string;
  fields: string | null;
}

export type ArchiveErrorStatus = 400 | 404 | 409 | 413 | 500 | 502 | 503;

/** Expected, user-safe failure. Messages are sanitized before they get here. */
export class ArchiveError extends Error {
  readonly status: ArchiveErrorStatus;

  constructor(message: string, status: ArchiveErrorStatus = 500) {
    super(message);
    this.name = "ArchiveError";
    this.status = status;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict `YYYY-MM-DD` check; rejects rolled-over dates such as 2026-02-31. */
export function isArchiveDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;

  const parts = value.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
