import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import type { Normalized } from "../ingest.js";
import type { StoredEvent } from "../types.js";
import {
  DELETE_CHUNK_SQL,
  FTS_SQL_TRIGRAM,
  FTS_SQL_UNICODE61,
  HISTOGRAM_SQL,
  INSERT_SQL,
  SCHEMA_SQL,
  SERVICES_SQL,
  buildSelectSql,
  histogramFromRows,
  rowToStoredEvent,
  servicesFromRows,
} from "./queries.js";
import type { HistogramPointRow, QueryOptions, ServiceRow, Storage } from "./types.js";

/**
 * The libSQL driver: local `file:` databases or a hosted Turso instance
 * (`libsql://your-db.turso.io` + auth token). The same HTTP ingestion path,
 * the same schema, zero code changes at the API layer.
 */
export async function createLibsqlStorage(opts: {
  url: string;
  authToken?: string;
  description?: string;
}): Promise<Storage> {
  // Local file databases: the native binding won't create parent
  // directories, so make sure they exist before connecting.
  const looksRemote = /^(libsql:\/\/|https?:\/\/|wss?:\/\/)/i.test(opts.url);
  if (!looksRemote) {
    const localPath = opts.url.toLowerCase().startsWith("file:") ? opts.url.slice(5) : opts.url;
    if (localPath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(localPath)), { recursive: true });
    }
  }

  const client: Client = createClient({
    url: opts.url,
    ...(opts.authToken ? { authToken: opts.authToken } : {}),
  });

  try {
    await client.executeMultiple(SCHEMA_SQL + FTS_SQL_TRIGRAM);
  } catch (err) {
    // Some hosted libSQL builds lack the FTS5 trigram tokenizer — degrade
    // to word-prefix search rather than refusing to boot.
    console.warn(
      "[kinglet] FTS5 trigram unavailable on this libSQL build; falling back to unicode61 " +
        "(substring search degraded to word-prefix):",
      err instanceof Error ? err.message : err
    );
    await client.execute("DROP TABLE IF EXISTS events_fts");
    await client.executeMultiple(SCHEMA_SQL + FTS_SQL_UNICODE61);
  }

  const storage: Storage = {
    kind: "libsql",
    description: opts.description ?? `libsql · ${opts.url}`,

    async insertEvents(events: Normalized[]): Promise<StoredEvent[]> {
      if (events.length === 0) return [];
      await client.batch(
        events.map((e) => ({
          sql: INSERT_SQL,
          args: [e.ts, e.level, e.service, e.env, e.message, e.fields],
        })),
        "write"
      );
      // Read the freshly assigned ids back (single-writer ingest makes this
      // reliable; avoids driver differences in lastInsertRowid reporting).
      const idRows = await client.execute({
        sql: "SELECT id FROM events ORDER BY id DESC LIMIT ?",
        args: [events.length],
      });
      const ids = idRows.rows.map((row) => Number(row.id)).reverse();
      return events.map((e, i) => {
        const id = ids[i];
        return {
          id: id === undefined ? -(i + 1) : id,
          ts: e.ts,
          level: e.level,
          service: e.service,
          env: e.env,
          message: e.message,
          fields: e.fields,
        };
      });
    },

    async queryEvents(opts: QueryOptions): Promise<StoredEvent[]> {
      const params: (string | number)[] = [...opts.params];
      if (opts.cursor !== null) params.push(opts.cursor);
      params.push(opts.limit);
      const result = await client.execute({
        sql: buildSelectSql(opts.where, opts.cursor !== null),
        args: params,
      });
      return result.rows.map((row) => rowToStoredEvent(row as Record<string, unknown>));
    },

    async histogramPoints(
      from: number,
      to: number,
      bucketMs: number
    ): Promise<HistogramPointRow[]> {
      const result = await client.execute({
        sql: HISTOGRAM_SQL,
        args: [bucketMs, bucketMs, from, to],
      });
      return histogramFromRows(
        result.rows as unknown as { bucket: unknown; level: unknown; n: unknown }[],
        from,
        to,
        bucketMs
      );
    },

    async listServices(): Promise<ServiceRow[]> {
      const result = await client.execute(SERVICES_SQL);
      return servicesFromRows(
        result.rows as unknown as { name: unknown; count: unknown }[]
      );
    },

    async deleteOlderThan(ts: number): Promise<number> {
      let total = 0;
      for (;;) {
        const result = await client.execute({ sql: DELETE_CHUNK_SQL, args: [ts] });
        const changes = result.rowsAffected;
        total += changes;
        if (changes === 0) return total;
      }
    },

    async runMaintenance(): Promise<void> {
      // Managed backends (Turso) handle housekeeping themselves.
    },

    async close(): Promise<void> {
      client.close();
    },
  };

  return storage;
}
