import type { Client } from "@libsql/client";
import type { SQL } from "drizzle-orm";
import type { Normalized } from "../ingest.ts";
import type { SearchMode, StoredEvent } from "../types.ts";
import type { KingletDb } from "./db.ts";

export type StorageKind = "sqlite" | "libsql";

export interface QueryOptions {
  /** Project the filter is scoped to; stamped on the returned rows. */
  projectId: string;
  /** Drizzle condition from buildWhere() — includes the project filter. */
  filter: SQL;
  limit: number;
  cursor: number | null;
}

/** Closed set of group-by dimensions accepted by GET /v1/aggregate. */
export type AggregateGroupBy = "service" | "level" | "env";

export type AggregateGroupRow =
  | { dimension: "service" | "env"; key: string | null; count: number }
  | { dimension: "level"; key: number; count: number };

export interface AggregateGroups {
  groups: AggregateGroupRow[];
  /** True when more groups exist beyond the requested limit. */
  truncated: boolean;
}

export interface ServiceRow {
  name: string;
  count: number;
}

export interface HistogramPointRow {
  ts: number;
  counts: number[];
}

export interface EventContext {
  event: StoredEvent;
  before: StoredEvent[];
  after: StoredEvent[];
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
  /** Raw libSQL client, needed for `VACUUM INTO` and pragmas. */
  readonly client: Client;
  /** Full-text index in effect (may differ from the setting on fallback). */
  readonly searchMode: SearchMode;
  insertEvents(
    projectId: string,
    events: Normalized[],
    apiKeyId: string | null,
  ): Promise<StoredEvent[]>;
  queryEvents(opts: QueryOptions): Promise<StoredEvent[]>;
  getEventByUid(projectId: string, uid: string): Promise<StoredEvent | null>;
  /**
   * One event plus its neighbours in deterministic `(ts, id)` order. Both
   * arrays are chronological and project-scoped.
   */
  getEventContext(
    projectId: string,
    uid: string,
    before: number,
    after: number,
  ): Promise<EventContext | null>;
  /** Total rows matching a project-scoped condition from buildWhere(). */
  countEvents(filter: SQL): Promise<number>;
  /**
   * Top groups for one closed dimension. Returns at most `limit` rows and sets
   * `truncated` when another group exists.
   */
  groupEventCounts(filter: SQL, groupBy: AggregateGroupBy, limit: number): Promise<AggregateGroups>;
  histogramPoints(
    projectId: string,
    from: number,
    to: number,
    bucketMs: number,
  ): Promise<HistogramPointRow[]>;
  listServices(projectId: string): Promise<ServiceRow[]>;
  /** Chunked delete; archive-enabled projects can be excluded. */
  deleteOlderThan(ts: number, excludeProjectIds?: readonly string[]): Promise<number>;
  /** Chunked alert retention; returns how many alert rows were dropped. */
  deleteAlertsOlderThan(ts: number): Promise<number>;
  /** Chunked delete of every event in one project; returns the count. */
  deleteByProject(projectId: string, range?: { from: number; to: number }): Promise<number>;
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
  /**
   * Wanted full-text index. The server sets it; one-off tools omit it and
   * use whatever index the database already has.
   */
  search?: SearchMode;
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
