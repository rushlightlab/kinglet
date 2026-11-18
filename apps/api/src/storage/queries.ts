import type { StoredEvent } from "../types.js";
import type { HistogramPointRow, ServiceRow } from "./types.js";

/**
 * SQL shared by every storage driver. Deliberately boring, standard SQLite
 * dialect — the same statements run on better-sqlite3, local libSQL, and
 * hosted Turso.
 *
 * Multi-project: events and monitors carry project_id. Users, sessions and
 * API keys are meta tables (managed through storage.sql).
 */

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys (project_id);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL DEFAULT 1,
    ts INTEGER NOT NULL,
    level INTEGER NOT NULL,
    service TEXT,
    env TEXT,
    message TEXT NOT NULL,
    fields BLOB
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
  CREATE INDEX IF NOT EXISTS idx_events_service_ts ON events (service, ts);
  CREATE INDEX IF NOT EXISTS idx_events_env_ts ON events (env, ts);

  CREATE TABLE IF NOT EXISTS monitors (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    query TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'count_above',
    threshold INTEGER NOT NULL DEFAULT 1,
    window_ms INTEGER NOT NULL DEFAULT 300000,
    interval_ms INTEGER NOT NULL DEFAULT 60000,
    cooldown_ms INTEGER NOT NULL DEFAULT 600000,
    enabled INTEGER NOT NULL DEFAULT 1,
    channels TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL,
    state TEXT NOT NULL,
    summary TEXT NOT NULL,
    count INTEGER,
    sample_message TEXT,
    fired_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_monitor ON alerts (monitor_id, fired_at DESC);
`;

/**
 * FTS5 with the trigram tokenizer enables substring search ("timeout"
 * matches "connectiontimeouterror"). Some hosted libSQL builds lack
 * trigram support; drivers fall back to FTS_SQL_UNICODE61 with a warning.
 */
export const FTS_SQL_TRIGRAM = `
  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5 (
    message,
    content='events',
    content_rowid='id',
    tokenize='trigram'
  );
  CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts (rowid, message) VALUES (new.id, new.message);
  END;
  CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts (events_fts, rowid, message) VALUES ('delete', old.id, old.message);
  END;
`;

export const FTS_SQL_UNICODE61 = FTS_SQL_TRIGRAM.replace(
  "tokenize='trigram'",
  "tokenize='unicode61'"
);

export const INSERT_SQL =
  "INSERT INTO events (project_id, ts, level, service, env, message, fields) VALUES (?, ?, ?, ?, ?, ?, ?)";

export const SELECT_FIELDS = "id, project_id, ts, level, service, env, message, fields";

export const SERVICES_SQL =
  "SELECT service AS name, COUNT(*) AS count FROM events WHERE project_id = ? AND service IS NOT NULL GROUP BY service ORDER BY count DESC LIMIT 200";

export const DELETE_CHUNK_SQL =
  "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ? ORDER BY id LIMIT 10000)";

export const HISTOGRAM_SQL =
  "SELECT CAST(ts / ? AS INTEGER) * ? AS bucket, level, COUNT(*) AS n FROM events WHERE ts >= ? AND ts <= ? AND project_id = ? GROUP BY bucket, level ORDER BY bucket ASC";

export function buildSelectSql(where: string, hasCursor: boolean): string {
  return `SELECT ${SELECT_FIELDS} FROM events WHERE ${[where, ...(hasCursor ? ["id < ?"] : [])].join(" AND ")} ORDER BY id DESC LIMIT ?`;
}

/** Maps a raw driver row (numbers may be number|bigint) into a StoredEvent. */
export function rowToStoredEvent(row: Record<string, unknown>): StoredEvent {
  const fields = row.fields;
  return {
    id: Number(row.id),
    projectId: Number(row.project_id ?? 1),
    ts: Number(row.ts),
    level: Number(row.level),
    service: row.service === null || row.service === undefined ? null : String(row.service),
    env: row.env === null || row.env === undefined ? null : String(row.env),
    message: String(row.message ?? ""),
    fields: typeof fields === "string" ? fields : null,
  };
}

export function histogramFromRows(
  rows: { bucket: unknown; level: unknown; n: unknown }[],
  from: number,
  to: number,
  bucketMs: number
): HistogramPointRow[] {
  const map = new Map<number, number[]>();
  for (const row of rows) {
    const bucket = Number(row.bucket);
    const level = Number(row.level);
    const n = Number(row.n);
    if (!Number.isFinite(bucket) || !Number.isFinite(level)) continue;
    const counts = map.get(bucket) ?? [0, 0, 0, 0, 0, 0];
    if (level >= 0 && level <= 5) counts[level] = n;
    map.set(bucket, counts);
  }
  const points: HistogramPointRow[] = [];
  for (let t = Math.floor(from / bucketMs) * bucketMs; t <= to; t += bucketMs) {
    points.push({ ts: t, counts: map.get(t) ?? [0, 0, 0, 0, 0, 0] });
  }
  return points;
}

export function servicesFromRows(rows: { name: unknown; count: unknown }[]): ServiceRow[] {
  return rows.map((row) => ({ name: String(row.name), count: Number(row.count) }));
}
