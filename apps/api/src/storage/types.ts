import type { Normalized } from "../ingest.js";
import type { StoredEvent } from "../types.js";

export type StorageKind = "sqlite" | "libsql";

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

export type SqlValue = string | number | null;

/**
 * Minimal SQL escape hatch for Kinglet's own meta tables (monitors, alert
 * history). Both drivers expose the same tiny surface so meta logic is
 * written once. Not for event queries — those go through Storage methods.
 */
export interface SqlExecutor {
  exec(statements: string): Promise<void>;
  run(sql: string, args?: SqlValue[]): Promise<{ rowsAffected: number; lastInsertRowid: number | null }>;
  all(sql: string, args?: SqlValue[]): Promise<Record<string, unknown>[]>;
}

/**
 * The seam that makes Kinglet's storage pluggable.
 *
 * Today: "sqlite" (better-sqlite3, zero-config default) and "libsql"
 * (local `file:` databases or a remote Turso instance). Tomorrow: ClickHouse
 * or Postgres implementations of this same interface — the API, retention,
 * and live tail never know which driver is underneath.
 */
export interface Storage {
  readonly kind: StorageKind;
  /** Human-readable target for the boot banner. */
  readonly description: string;
  /** Shared surface for Kinglet's meta tables (monitors, alerts). */
  readonly sql: SqlExecutor;
  insertEvents(events: Normalized[]): Promise<StoredEvent[]>;
  queryEvents(opts: QueryOptions): Promise<StoredEvent[]>;
  histogramPoints(from: number, to: number, bucketMs: number): Promise<HistogramPointRow[]>;
  listServices(): Promise<ServiceRow[]>;
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
