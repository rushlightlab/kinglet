import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Normalized } from "../ingest.ts";
import { uuidv7 } from "../auth/ids.ts";
import type { StoredEvent } from "../types.ts";
import type { KingletDb } from "./db.ts";
import * as schema from "./schema.ts";
import type {
  AggregateGroupBy,
  AggregateGroups,
  EventContext,
  HistogramPointRow,
  QueryOptions,
  ServiceRow,
} from "./types.ts";

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

/** Total rows matching a project-scoped condition built by buildWhere(). */
export async function countEvents(db: KingletDb, filter: SQL): Promise<number> {
  const rows = await db.select({ n: count() }).from(schema.events).where(filter);

  return Number(rows[0]?.n ?? 0);
}

/**
 * Top groups for a closed dimension. The dimension is a typed union, never a
 * caller-supplied SQL expression; one extra row detects truncation.
 */
export async function groupEventCounts(
  db: KingletDb,
  filter: SQL,
  groupBy: AggregateGroupBy,
  limit: number,
): Promise<AggregateGroups> {
  const bounded = Math.max(1, Math.trunc(limit));

  if (groupBy === "level") {
    const rows = await db
      .select({ key: schema.events.level, n: count() })
      .from(schema.events)
      .where(filter)
      .groupBy(schema.events.level)
      .orderBy(desc(count()), asc(schema.events.level))
      .limit(bounded + 1);

    return {
      groups: rows.slice(0, bounded).map((row) => ({
        dimension: "level",
        key: Number(row.key),
        count: Number(row.n),
      })),
      truncated: rows.length > bounded,
    };
  }

  const column = groupBy === "service" ? schema.events.service : schema.events.env;

  const rows = await db
    .select({ key: column, n: count() })
    .from(schema.events)
    .where(filter)
    .groupBy(column)
    .orderBy(desc(count()), asc(column))
    .limit(bounded + 1);

  return {
    groups: rows.slice(0, bounded).map((row) => ({
      dimension: groupBy,
      key: row.key === null ? null : String(row.key),
      count: Number(row.n),
    })),
    truncated: rows.length > bounded,
  };
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

/**
 * Surrounding events in deterministic `(ts, id)` order. Querying each side by
 * that tuple keeps equal timestamps stable; the before side is fetched
 * newest-first for the LIMIT and reversed for chronological output.
 */
export async function getEventContext(
  db: KingletDb,
  projectId: string,
  uid: string,
  before: number,
  after: number,
): Promise<EventContext | null> {
  const event = await getEventByUid(db, projectId, uid);

  if (!event) return null;

  const beforeCount = Math.min(20, Math.max(0, Math.trunc(before)));
  const afterCount = Math.min(20, Math.max(0, Math.trunc(after)));

  const beforeRows =
    beforeCount === 0
      ? []
      : await db
          .select()
          .from(schema.events)
          .where(
            and(
              eq(schema.events.projectId, projectId),
              or(
                lt(schema.events.ts, event.ts),
                and(eq(schema.events.ts, event.ts), lt(schema.events.id, event.id)),
              ),
            ),
          )
          .orderBy(desc(schema.events.ts), desc(schema.events.id))
          .limit(beforeCount);

  const afterRows =
    afterCount === 0
      ? []
      : await db
          .select()
          .from(schema.events)
          .where(
            and(
              eq(schema.events.projectId, projectId),
              or(
                gt(schema.events.ts, event.ts),
                and(eq(schema.events.ts, event.ts), gt(schema.events.id, event.id)),
              ),
            ),
          )
          .orderBy(asc(schema.events.ts), asc(schema.events.id))
          .limit(afterCount);

  const beforeEvents: StoredEvent[] = [];

  for (let i = beforeRows.length - 1; i >= 0; i--) {
    const row = beforeRows[i];

    if (row) beforeEvents.push(mapEventRow(row));
  }

  return {
    event,
    before: beforeEvents,
    after: afterRows.map(mapEventRow),
  };
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

/**
 * Chunked delete so a big backlog never blocks ingest for long. Projects with
 * archive enabled are excluded; their archive job owns deletion.
 */
export async function deleteOlderThan(
  db: KingletDb,
  ts: number,
  excludeProjectIds: readonly string[] = [],
): Promise<number> {
  let total = 0;

  const exclusion =
    excludeProjectIds.length > 0
      ? notInArray(schema.events.projectId, [...excludeProjectIds])
      : undefined;

  for (;;) {
    const result = await db.run(
      sql`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ${ts}${exclusion ? sql` AND ${exclusion}` : sql``} ORDER BY id LIMIT 10000)`,
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
