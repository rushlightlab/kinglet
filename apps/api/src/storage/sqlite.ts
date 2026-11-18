import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Normalized } from "../ingest.js";
import type { StoredEvent } from "../types.js";
import {
  DELETE_CHUNK_SQL,
  FTS_SQL_TRIGRAM,
  HISTOGRAM_SQL,
  INSERT_SQL,
  SCHEMA_SQL,
  SERVICES_SQL,
  buildSelectSql,
  histogramFromRows,
  rowToStoredEvent,
  servicesFromRows,
} from "./queries.js";
import type { HistogramPointRow, QueryOptions, ServiceRow, SqlExecutor, Storage } from "./types.js";

/**
 * The zero-config default: better-sqlite3, one file, WAL mode so readers
 * never block the single writer, FTS5 trigram for substring search.
 */
export function createSqliteStorage(dbPath: string): Storage {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  // Takes effect on fresh databases; keeps retention deletes cheap later.
  db.pragma("auto_vacuum = INCREMENTAL");
  db.exec(SCHEMA_SQL + FTS_SQL_TRIGRAM);

  const insert = db.prepare(INSERT_SQL);
  const histogram = db.prepare(HISTOGRAM_SQL);
  const services = db.prepare(SERVICES_SQL);
  const deleteChunk = db.prepare(DELETE_CHUNK_SQL);

  /** Shared meta-table surface (monitors, alerts). */
  const sql: SqlExecutor = {
    async exec(statements) {
      db.exec(statements);
    },
    async run(sqlText, args = []) {
      const info = db.prepare(sqlText).run(...args);
      return { rowsAffected: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
    },
    async all(sqlText, args = []) {
      return db.prepare(sqlText).all(...args) as Record<string, unknown>[];
    },
  };

  const storage: Storage = {
    kind: "sqlite",
    description: `sqlite · ${path.resolve(dbPath)}`,
    sql,

    async insertEvents(events: Normalized[]): Promise<StoredEvent[]> {
      if (events.length === 0) return [];
      const rows: StoredEvent[] = [];
      const tx = db.transaction((batch: Normalized[]) => {
        for (const e of batch) {
          const info = insert.run(e.ts, e.level, e.service, e.env, e.message, e.fields);
          rows.push({
            id: Number(info.lastInsertRowid),
            ts: e.ts,
            level: e.level,
            service: e.service,
            env: e.env,
            message: e.message,
            fields: e.fields,
          });
        }
      });
      tx(events);
      return rows;
    },

    async queryEvents(opts: QueryOptions): Promise<StoredEvent[]> {
      const params: (string | number)[] = [...opts.params];
      if (opts.cursor !== null) params.push(opts.cursor);
      params.push(opts.limit);
      const rows = db
        .prepare(buildSelectSql(opts.where, opts.cursor !== null))
        .all(...params) as Record<string, unknown>[];
      return rows.map(rowToStoredEvent);
    },

    async histogramPoints(
      from: number,
      to: number,
      bucketMs: number
    ): Promise<HistogramPointRow[]> {
      const rows = histogram.all(bucketMs, bucketMs, from, to) as unknown as {
        bucket: unknown;
        level: unknown;
        n: unknown;
      }[];
      return histogramFromRows(rows, from, to, bucketMs);
    },

    async listServices(): Promise<ServiceRow[]> {
      const rows = services.all() as unknown as { name: unknown; count: unknown }[];
      return servicesFromRows(rows);
    },

    async deleteOlderThan(ts: number): Promise<number> {
      let total = 0;
      let changes = -1;
      while (changes !== 0) {
        changes = deleteChunk.run(ts).changes;
        total += changes;
      }
      return total;
    },

    async runMaintenance(): Promise<void> {
      db.pragma("incremental_vacuum(512)");
    },

    async close(): Promise<void> {
      db.close();
    },
  };

  return storage;
}
