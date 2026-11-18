import type { DatabaseType } from "./db.js";
import type { Normalized } from "./ingest.js";
import type { StoredEvent } from "./types.js";

export function insertEvents(db: DatabaseType, events: Normalized[]): StoredEvent[] {
  if (events.length === 0) return [];
  const rows: StoredEvent[] = [];
  const insert = db.prepare(
    "INSERT INTO events (ts, level, service, env, message, fields) VALUES (?, ?, ?, ?, ?, ?)"
  );
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
}

export function queryEvents(
  db: DatabaseType,
  opts: { where: string; params: (string | number)[]; limit: number; cursor: number | null }
): StoredEvent[] {
  const parts: string[] = [opts.where];
  const params: (string | number)[] = [...opts.params];
  if (opts.cursor !== null) {
    parts.push("id < ?");
    params.push(opts.cursor);
  }
  const sql = `SELECT id, ts, level, service, env, message, fields FROM events WHERE ${parts.join(" AND ")} ORDER BY id DESC LIMIT ?`;
  params.push(opts.limit);
  return db.prepare(sql).all(...params) as StoredEvent[];
}

export function histogramPoints(
  db: DatabaseType,
  from: number,
  to: number,
  bucketMs: number
): { ts: number; counts: number[] }[] {
  const sql = `
    SELECT CAST(ts / @bucketMs AS INTEGER) * @bucketMs AS bucket, level, COUNT(*) AS n
    FROM events
    WHERE ts >= @from AND ts <= @to
    GROUP BY bucket, level
    ORDER BY bucket ASC
  `;
  type Row = { bucket: number; level: number; n: number };
  const rows = db.prepare(sql).all({ from, to, bucketMs }) as Row[];
  const map = new Map<number, number[]>();
  for (const row of rows) {
    const counts = map.get(row.bucket) ?? [0, 0, 0, 0, 0, 0];
    if (row.level >= 0 && row.level <= 5) counts[row.level] = row.n;
    map.set(row.bucket, counts);
  }
  const points: { ts: number; counts: number[] }[] = [];
  for (let t = Math.floor(from / bucketMs) * bucketMs; t <= to; t += bucketMs) {
    points.push({ ts: t, counts: map.get(t) ?? [0, 0, 0, 0, 0, 0] });
  }
  return points;
}

export function listServices(db: DatabaseType): { name: string; count: number }[] {
  return db
    .prepare(
      "SELECT service AS name, COUNT(*) AS count FROM events WHERE service IS NOT NULL GROUP BY service ORDER BY count DESC LIMIT 200"
    )
    .all() as { name: string; count: number }[];
}

/** Chunked delete so a big backlog never blocks ingest for long. */
export function deleteOlderThan(db: DatabaseType, ts: number): number {
  const del = db.prepare(
    "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ? ORDER BY id LIMIT 10000)"
  );
  let total = 0;
  let changes = -1;
  while (changes !== 0) {
    changes = del.run(ts).changes;
    total += changes;
  }
  return total;
}
