import type { SQL } from "drizzle-orm";
import type { Normalized } from "../ingest.js";
import type { StoredEvent } from "../types.js";
import type { KingletDb } from "./db.js";

export type StorageKind = "sqlite" | "libsql";

export interface QueryOptions {
  /** Drizzle condition from buildWhere() — includes the project filter. */
  filter: SQL;
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
 * The high-level storage seam. Today there is a single implementation (the
 * libSQL client: local file or hosted Turso) and it also exposes the typed
 * Drizzle database that auth, monitors, and projects use directly.
 *
 * A future ClickHouse backend would replace the event methods below while a
 * small SQLite-compatible meta store keeps users/sessions/keys/monitors.
 */
export interface Storage {
  readonly kind: StorageKind;
  /** Human-readable target for the boot banner. */
  readonly description: string;
  /** Typed Drizzle database for meta tables and ad-hoc queries. */
  readonly db: KingletDb;
  insertEvents(projectId: number, events: Normalized[]): Promise<StoredEvent[]>;
  queryEvents(opts: QueryOptions): Promise<StoredEvent[]>;
  histogramPoints(
    projectId: number,
    from: number,
    to: number,
    bucketMs: number
  ): Promise<HistogramPointRow[]>;
  listServices(projectId: number): Promise<ServiceRow[]>;
  /** Chunked delete; returns how many events were dropped. */
  deleteOlderThan(ts: number): Promise<number>;
  /** Chunked delete of every event in one project; returns the count. */
  deleteByProject(projectId: number, range?: { from: number; to: number }): Promise<number>;
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
    p.startsWith("http://") ||
    p.startsWith("https://") ||
    p.startsWith("ws://") ||
    p.startsWith("wss://")
  ) {
    return "libsql";
  }
  return "sqlite";
}
