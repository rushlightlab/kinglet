import { and, count, desc, eq, gte, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Normalized } from "../ingest.js";
import { uuidv7 } from "../auth/ids.js";
import type { StoredEvent } from "../types.js";
import type { KingletDb } from "./db.js";
import * as schema from "./schema.js";
import type { HistogramPointRow, QueryOptions, ServiceRow } from "./types.js";

/** SQLite caps the number of bound variables per statement. */
const INSERT_CHUNK = 500;

/** Yield a real macrotask so large deletes do not monopolize the event loop. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function mapEventRow(row: typeof schema.events.$inferSelect): StoredEvent {
  return {
    id: Number(row.id),
    uid: row.uid ?? null,
    projectId: row.projectId,
    apiKeyId: row.apiKeyId ?? null,
    ts: Number(row.ts),
    level: Number(row.level),
    service: row.service,
    env: row.env,
    message: row.message,
    fields: row.fields ?? null,
  };
}

export function eventSizeBytes(event: Normalized): number {
  return (
    Buffer.byteLength(event.message) +
    Buffer.byteLength(event.fields ?? "") +
    Buffer.byteLength(event.service ?? "") +
    Buffer.byteLength(event.env ?? "")
  );
}

export async function insertEvents(
  db: KingletDb,
  projectId: string,
  events: Normalized[],
  apiKeyId: string | null,
): Promise<StoredEvent[]> {
  if (events.length === 0) return [];
  const rows: StoredEvent[] = [];
  await db.transaction(async (tx) => {
    for (let i = 0; i < events.length; i += INSERT_CHUNK) {
      const chunk = events.slice(i, i + INSERT_CHUNK).map((event) => ({
        ...event,
        uid: uuidv7(),
      }));
      const inserted = await tx
        .insert(schema.events)
        .values(
          chunk.map((e) => ({
            uid: e.uid,
            projectId,
            apiKeyId,
            ts: e.ts,
            level: e.level,
            service: e.service,
            env: e.env,
            message: e.message,
            fields: e.fields,
            sizeBytes: eventSizeBytes(e),
          })),
        )
        .returning({ id: schema.events.id });
      inserted.forEach((insertedRow, index) => {
        const event = chunk[index];
        if (!event) return;
        rows.push({
          id: Number(insertedRow.id),
          uid: event.uid,
          projectId,
          apiKeyId,
          ts: event.ts,
          level: event.level,
          service: event.service,
          env: event.env,
          message: event.message,
          fields: event.fields,
        });
      });
    }
  });
  return rows;
}

export async function queryEvents(db: KingletDb, opts: QueryOptions): Promise<StoredEvent[]> {
  const conditions: SQL[] = [opts.filter];
  if (opts.cursor !== null) conditions.push(lt(schema.events.id, opts.cursor));
  const rows = await db
    .select()
    .from(schema.events)
    .where(and(...conditions))
    .orderBy(desc(schema.events.id))
    .limit(opts.limit);
  return rows.map(mapEventRow);
}

/** Single-event lookup for shareable UUIDs; fast thanks to uq_events_uid. */
export async function getEventByUid(
  db: KingletDb,
  projectId: string,
  uid: string,
): Promise<StoredEvent | null> {
  const rows = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.projectId, projectId), eq(schema.events.uid, uid)))
    .limit(1);
  const row = rows[0];
  return row ? mapEventRow(row) : null;
}

export async function histogramPoints(
  db: KingletDb,
  projectId: string,
  from: number,
  to: number,
  bucketMs: number,
): Promise<HistogramPointRow[]> {
  const bucket = sql<number>`(CAST(${schema.events.ts} / ${bucketMs} AS INTEGER) * ${bucketMs})`;
  const rows = await db
    .select({ bucket, level: schema.events.level, n: count() })
    .from(schema.events)
    .where(
      and(
        gte(schema.events.ts, from),
        lte(schema.events.ts, to),
        eq(schema.events.projectId, projectId),
      ),
    )
    .groupBy(bucket, schema.events.level)
    .orderBy(bucket);

  const map = new Map<number, number[]>();
  for (const row of rows) {
    const bucketTs = Number(row.bucket);
    const level = Number(row.level);
    const n = Number(row.n);
    if (!Number.isFinite(bucketTs) || !Number.isFinite(level)) continue;
    const counts = map.get(bucketTs) ?? [0, 0, 0, 0, 0, 0];
    if (level >= 0 && level <= 5) counts[level] = n;
    map.set(bucketTs, counts);
  }
  const points: HistogramPointRow[] = [];
  const start = Math.floor(from / bucketMs) * bucketMs;
  const pointCount = Math.min(500, Math.ceil((to - start) / bucketMs) + 1);
  for (let i = 0; i < pointCount; i++) {
    const t = start + i * bucketMs;
    points.push({ ts: t, counts: map.get(t) ?? [0, 0, 0, 0, 0, 0] });
  }
  return points;
}

export async function listServices(db: KingletDb, projectId: string): Promise<ServiceRow[]> {
  const rows = await db
    .select({ name: schema.events.service, n: count() })
    .from(schema.events)
    .where(and(eq(schema.events.projectId, projectId), isNotNull(schema.events.service)))
    .groupBy(schema.events.service)
    .orderBy(desc(count()))
    .limit(200);
  return rows.map((row) => ({ name: String(row.name), count: Number(row.n) }));
}

/** Chunked delete so a big backlog never blocks ingest for long. */
export async function deleteOlderThan(db: KingletDb, ts: number): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.run(
      sql`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ${ts} ORDER BY id LIMIT 10000)`,
    );
    const changed = Number(result.rowsAffected ?? 0);
    total += changed;
    if (changed === 0) return total;
    await yieldToEventLoop();
  }
}

/** Chunked project wipe: keys, monitors, and alert history are untouched. */
export async function deleteByProject(
  db: KingletDb,
  projectId: string,
  range?: { from: number; to: number },
): Promise<number> {
  let total = 0;
  for (;;) {
    const rangeClause = range ? sql` AND ts >= ${range.from} AND ts <= ${range.to}` : sql``;
    const result = await db.run(
      sql`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE project_id = ${projectId}${rangeClause} ORDER BY id LIMIT 10000)`,
    );
    const changed = Number(result.rowsAffected ?? 0);
    total += changed;
    if (changed === 0) return total;
    await yieldToEventLoop();
  }
}

/** Chunked alert-history retention, yielded so it never blocks the loop. */
export async function deleteAlertsOlderThan(db: KingletDb, ts: number): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.run(
      sql`DELETE FROM alerts WHERE id IN (SELECT id FROM alerts WHERE fired_at < ${ts} ORDER BY fired_at LIMIT 10000)`,
    );
    const changed = Number(result.rowsAffected ?? 0);
    total += changed;
    if (changed === 0) return total;
    await yieldToEventLoop();
  }
}
