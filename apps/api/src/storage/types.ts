import type { Normalized } from "../ingest.js";
import type { StoredEvent } from "../types.js";

export type StorageKind = "sqlite" | "libsql";

export type SqlValue = string | number | null;

/**
 * Minimal SQL escape hatch shared by both drivers, used for Kinglet's meta
 * tables (projects, users, sessions, API keys, monitors) so that logic is
 * written once. Event queries go through the Storage methods below.
 */
export interface SqlExecutor {
  exec(statements: string): Promise<void>;
  run(sql: string, args?: SqlValue[]): Promise<{ rowsAffected: number; lastInsertRowid: number | null }>;
  all(sql: string, args?: SqlValue[]): Promise<Record<string, unknown>[]>;
}

export interface QueryOptions {
  where: string;
  params: (string | number)[];
  limit: number;
  cursor: number | null;
}

export interface ServiceRow {
  name: string;
  count: number;
}

export interface HistogramPointRow {
  ts: number;
  counts: number[];
}

/**
 * The seam that makes Kinglet's storage pluggable.
 *
 * Today: "sqlite" (better-sqlite3, zero-config default) and "libsql"
 * (local `file:` databases or a remote Turso instance). Tomorrow: ClickHouse
 * or Postgres implementations of this same interface.
 */
export interface Storage {
  readonly kind: StorageKind;
  /** Human-readable target for the boot banner. */
  readonly description: string;
  /** Shared surface for Kinglet's meta tables. */
  readonly sql: SqlExecutor;
  insertEvents(projectId: number, events: Normalized[]): Promise<StoredEvent[]>;
  queryEvents(opts: QueryOptions): Promise<StoredEvent[]>;
  histogramPoints(projectId: number, from: number, to: number, bucketMs: number): Promise<HistogramPointRow[]>;
  listServices(projectId: number): Promise<ServiceRow[]>;
  /** Chunked delete; returns how many events were dropped. */
  deleteOlderThan(ts: number): Promise<number>;
  /** Housekeeping after big deletes (vacuum etc.). No-op on managed backends. */
  runMaintenance(): Promise<void>;
  close(): Promise<void>;
}

export interface StorageSettings {
  /** "auto" infers the driver from the db path scheme. */
  kind: "auto" | StorageKind;
  dbPath: string;
  /** Auth token for remote libSQL / Turso. */
  authToken?: string;
}

export function resolveStorageKind(settings: StorageSettings): StorageKind {
  if (settings.kind !== "auto") return settings.kind;
  const p = settings.dbPath.toLowerCase();
  if (
    p.startsWith("libsql") ||
    p.startsWith("file:") ||
    p.startsWith("http://") ||
    p.startsWith("https://") ||
    p.startsWith("ws://") ||
    p.startsWith("wss://")
  ) {
    return "libsql";
  }
  return "sqlite";
}
