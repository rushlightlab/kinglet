import { and, asc, count, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { Client, InStatement, InValue } from "@libsql/client";
import type { SQL } from "drizzle-orm";
import type { Normalized } from "../ingest.ts";
import { uuidv7 } from "../auth/ids.ts";
import type { StoredEvent } from "../types.ts";
import type { KingletDb } from "./db.ts";
import { ensureProjectKey, projectKeyOf, projectKeysOf } from "./project-keys.ts";
import * as schema from "./schema.ts";
import type {
  AggregateGroupBy,
  SqlEngine,
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

function mapEventRow(row: typeof schema.events.$inferSelect, projectId: string): StoredEvent {
  return {
    id: Number(row.id),
    uid: row.uid ?? null,
    projectId,
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
  let bytes = event.message ? Buffer.byteLength(event.message) : 0;

  if (event.fields) bytes += Buffer.byteLength(event.fields);

  if (event.service) bytes += Buffer.byteLength(event.service);

  if (event.env) bytes += Buffer.byteLength(event.env);

  return bytes;
}

const EVENT_COLUMNS =
  "uid, project_key, api_key_id, ts, level, service, env, message, fields, size_bytes";

const EVENT_PLACEHOLDERS = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function buildInsertSql(rowCount: number): string {
  const values = Array.from({ length: rowCount }, () => EVENT_PLACEHOLDERS).join(", ");

  return `INSERT INTO events (${EVENT_COLUMNS}) VALUES ${values} RETURNING id`;
}

const FULL_CHUNK_INSERT_SQL = buildInsertSql(INSERT_CHUNK);

function insertSql(rowCount: number): string {
  return rowCount === INSERT_CHUNK ? FULL_CHUNK_INSERT_SQL : buildInsertSql(rowCount);
}

/**
 * Ingest hot path. Hand-built parameterized SQL (columns fixed, values always
 * bound) because the query builder costs more than SQLite on 500-row inserts.
 * The whole request is one atomic `batch()`: the local client runs it on its
 * long-lived connection (keeping pragmas and page cache) instead of opening a
 * connection per interactive transaction, and remote libSQL gets one round
 * trip.
 */
export async function insertEvents(
  client: Client,
  projectId: string,
  events: Normalized[],
  apiKeyId: string | null,
): Promise<StoredEvent[]> {
  if (events.length === 0) return [];
  const projectKey = await ensureProjectKey(client, projectId);
  const chunks: StoredEvent[][] = [];
  const statements: InStatement[] = [];

  for (let i = 0; i < events.length; i += INSERT_CHUNK) {
    const end = Math.min(i + INSERT_CHUNK, events.length);
    const chunk: StoredEvent[] = [];
    const args: InValue[] = [];

    for (let j = i; j < end; j++) {
      const event = events[j];

      if (!event) continue;
      const uid = uuidv7();

      chunk.push({
        id: 0,
        uid,
        projectId,
        apiKeyId,
        ts: event.ts,
        level: event.level,
        service: event.service,
        env: event.env,
        message: event.message,
        fields: event.fields,
      });
      args.push(
        uid,
        projectKey,
        apiKeyId,
        event.ts,
        event.level,
        event.service,
        event.env,
        event.message,
        event.fields,
        eventSizeBytes(event),
      );
    }

    chunks.push(chunk);
    statements.push({ sql: insertSql(chunk.length), args });
  }

  const results = await client.batch(statements, "write");
  const rows: StoredEvent[] = [];

  for (let chunkIndex = 0; chunkIndex < results.length; chunkIndex++) {
    const result = results[chunkIndex];
    const chunk = chunks[chunkIndex];

    if (!result || !chunk) continue;

    for (let index = 0; index < result.rows.length; index++) {
      const insertedRow = result.rows[index];
      const event = chunk[index];

      if (!insertedRow || !event) continue;
      event.id = Number(insertedRow.id);
      rows.push(event);
    }
  }

  return rows;
}

/**
 * Newest-first by event time, ties broken by id, so SQLite walks the
 * `(project_key, ts)` index and stops at the LIMIT instead of sorting the whole
 * window. The public cursor stays the numeric id of the last row; its
 * timestamp is looked up inside the same project-scoped filter to seek the
 * next page. A cursor row that no longer matches (deleted by retention) falls
 * back to plain id order.
 */
export async function queryEvents(db: KingletDb, opts: QueryOptions): Promise<StoredEvent[]> {
  const conditions: SQL[] = [opts.filter];

  if (opts.cursor !== null) {
    const anchor = await db
      .select({ ts: schema.events.ts })
      .from(schema.events)
      .where(and(eq(schema.events.id, opts.cursor), opts.filter))
      .limit(1);

    const anchorTs = anchor[0]?.ts;

    conditions.push(
      anchorTs === undefined
        ? lt(schema.events.id, opts.cursor)
        : sql`(${schema.events.ts}, ${schema.events.id}) < (${anchorTs}, ${opts.cursor})`,
    );
  }

  const rows = await db
    .select()
    .from(schema.events)
    .where(and(...conditions))
    .orderBy(desc(schema.events.ts), desc(schema.events.id))
    .limit(opts.limit);

  return rows.map((row) => mapEventRow(row, opts.projectId));
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
    .where(and(eq(schema.events.projectKey, projectKeyOf(projectId)), eq(schema.events.uid, uid)))
    .limit(1);

  const row = rows[0];

  return row ? mapEventRow(row, projectId) : null;
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

  const [beforeRows, afterRows] = await Promise.all([
    beforeCount === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(schema.events)
          .where(
            and(
              eq(schema.events.projectKey, projectKeyOf(projectId)),
              sql`(${schema.events.ts}, ${schema.events.id}) < (${event.ts}, ${event.id})`,
            ),
          )
          .orderBy(desc(schema.events.ts), desc(schema.events.id))
          .limit(beforeCount),
    afterCount === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(schema.events)
          .where(
            and(
              eq(schema.events.projectKey, projectKeyOf(projectId)),
              sql`(${schema.events.ts}, ${schema.events.id}) > (${event.ts}, ${event.id})`,
            ),
          )
          .orderBy(asc(schema.events.ts), asc(schema.events.id))
          .limit(afterCount),
  ]);

  const beforeEvents: StoredEvent[] = [];

  for (let i = beforeRows.length - 1; i >= 0; i--) {
    const row = beforeRows[i];

    if (row) beforeEvents.push(mapEventRow(row, projectId));
  }

  return {
    event,
    before: beforeEvents,
    after: afterRows.map((row) => mapEventRow(row, projectId)),
  };
}

const HISTOGRAM_MAX_POINTS = 500;

/**
 * Per-bucket, per-level counts. On SQLite, grouping by a computed bucket sorts
 * every row in the window; instead, generate the bucket starts and count each
 * (level, bucket) slice as an index-only range on `(project_key, level, ts)`:
 * same totals, roughly 6x faster on a busy day. Turso's MVCC engine runs those
 * hundreds of correlated subqueries an order of magnitude slower than a plain
 * GROUP BY, so it gets the grouped form.
 *
 * A search filter (from buildWhere, already scoped to the project and window)
 * also takes the grouped form: the slices only use the level index, so they
 * cannot apply arbitrary text or field conditions.
 */
export async function histogramPoints(
  db: KingletDb,
  engine: SqlEngine,
  projectId: string,
  from: number,
  to: number,
  bucketMs: number,
  filter?: SQL,
): Promise<HistogramPointRow[]> {
  const start = Math.floor(from / bucketMs) * bucketMs;

  const map =
    filter !== undefined || engine === "turso-mvcc"
      ? await groupedHistogram(db, projectId, from, to, bucketMs, filter)
      : await sliceHistogram(db, projectId, from, to, bucketMs, start);

  const points: HistogramPointRow[] = [];
  const pointCount = Math.min(HISTOGRAM_MAX_POINTS, Math.ceil((to - start) / bucketMs) + 1);

  for (let i = 0; i < pointCount; i++) {
    const t = start + i * bucketMs;
    points.push({ ts: t, counts: map.get(t) ?? [0, 0, 0, 0, 0, 0] });
  }

  return points;
}

async function groupedHistogram(
  db: KingletDb,
  projectId: string,
  from: number,
  to: number,
  bucketMs: number,
  filter?: SQL,
): Promise<Map<number, number[]>> {
  const bucket = sql<number>`(CAST(${schema.events.ts} / ${bucketMs} AS INTEGER) * ${bucketMs})`;

  const rows = await db
    .select({ bucket, level: schema.events.level, n: count() })
    .from(schema.events)
    .where(
      and(
        sql`${schema.events.ts} >= ${from}`,
        sql`${schema.events.ts} <= ${to}`,
        eq(schema.events.projectKey, projectKeyOf(projectId)),
        filter,
      ),
    )
    .groupBy(bucket, schema.events.level);

  const map = new Map<number, number[]>();

  for (const row of rows) {
    const bucketTs = Number(row.bucket);
    const level = Number(row.level);

    if (!Number.isFinite(bucketTs) || level < 0 || level > 5) continue;
    const counts = map.get(bucketTs) ?? [0, 0, 0, 0, 0, 0];

    counts[level] = Number(row.n);
    map.set(bucketTs, counts);
  }

  return map;
}

async function sliceHistogram(
  db: KingletDb,
  projectId: string,
  from: number,
  to: number,
  bucketMs: number,
  start: number,
): Promise<Map<number, number[]>> {
  const levelCount = (level: number): SQL =>
    sql`(SELECT count(*) FROM events e WHERE e.project_key = ${projectKeyOf(projectId)} AND e.level = ${level} AND e.ts >= max(buckets.s, ${from}) AND e.ts < buckets.s + ${bucketMs} AND e.ts <= ${to})`;

  const rows = await db.all<{
    s: number;
    l0: number;
    l1: number;
    l2: number;
    l3: number;
    l4: number;
    l5: number;
  }>(sql`
    WITH RECURSIVE buckets(s, n) AS (
      SELECT ${start}, 1
      UNION ALL
      SELECT s + ${bucketMs}, n + 1 FROM buckets
      WHERE s + ${bucketMs} <= ${to} AND n < ${HISTOGRAM_MAX_POINTS}
    )
    SELECT s,
      ${levelCount(0)} AS l0, ${levelCount(1)} AS l1, ${levelCount(2)} AS l2,
      ${levelCount(3)} AS l3, ${levelCount(4)} AS l4, ${levelCount(5)} AS l5
    FROM buckets
  `);

  const map = new Map<number, number[]>();

  for (const row of rows) {
    const counts = [row.l0, row.l1, row.l2, row.l3, row.l4, row.l5].map(Number);

    if (counts.some((n) => n > 0)) map.set(Number(row.s), counts);
  }

  return map;
}

export async function listServices(db: KingletDb, projectId: string): Promise<ServiceRow[]> {
  const rows = await db
    .select({ name: schema.events.service, n: count() })
    .from(schema.events)
    .where(
      and(eq(schema.events.projectKey, projectKeyOf(projectId)), isNotNull(schema.events.service)),
    )
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
      ? sql`${schema.events.projectKey} NOT IN ${projectKeysOf(excludeProjectIds)}`
      : undefined;

  for (;;) {
    const result = await db.run(
      sql`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ${ts}${exclusion ? sql` AND ${exclusion}` : sql``} LIMIT 10000)`,
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
      sql`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE project_key = ${projectKeyOf(projectId)}${rangeClause} LIMIT 10000)`,
    );

    const changed = Number(result.rowsAffected ?? 0);
    total += changed;

    if (changed === 0) return total;
    await yieldToEventLoop();
  }
}

/**
 * Chunked delete of the events matching a buildWhere() condition, which is
 * always scoped to one project. Yields between chunks like deleteByProject.
 */
export async function deleteMatching(db: KingletDb, filter: SQL): Promise<number> {
  let total = 0;

  for (;;) {
    const result = await db.run(
      sql`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ${filter} LIMIT 10000)`,
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
