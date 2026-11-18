import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { publishEvents, subscribeEvents } from "./bus.js";
import type { DatabaseType } from "./db.js";
import { buildWhere, matchesEvent, parseFilters } from "./filters.js";
import type { Normalized } from "./ingest.js";
import { normalizeEvent } from "./ingest.js";
import { histogramPoints, insertEvents, listServices, queryEvents } from "./events.js";
import { toClientEvent } from "./types.js";

const MAX_BATCH = 10000;

function parseTimestamp(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function registerRoutes(app: Hono, db: DatabaseType): void {
  const api = new Hono();

  // ---------- ingest: POST /v1/events ----------
  api.post("/events", bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    const text = await c.req.text();
    const raws: unknown[] = [];
    let parseErrors = 0;

    if (contentType.includes("ndjson")) {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          raws.push(JSON.parse(trimmed));
        } catch {
          parseErrors++;
        }
      }
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      if (Array.isArray(parsed)) raws.push(...parsed);
      else if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { events?: unknown }).events))
        raws.push(...(parsed as { events: unknown[] }).events);
      else raws.push(parsed);
    }

    const truncated = raws.length > MAX_BATCH;
    if (truncated) raws.length = MAX_BATCH;

    const normalized: Normalized[] = [];
    const errors: string[] = [];
    for (const raw of raws) {
      const result = normalizeEvent(raw);
      if (result.ok) normalized.push(result.value);
      else errors.push(result.error);
    }

    const rows = insertEvents(db, normalized);
    publishEvents(rows);

    return c.json({
      accepted: rows.length,
      rejected: errors.length + parseErrors,
      ...(truncated ? { truncated: true } : {}),
      ...(errors.length > 0 ? { errors: errors.slice(0, 3) } : {}),
    });
  });

  // ---------- query: GET /v1/events ----------
  api.get("/events", (c) => {
    const q = c.req.query("q") ?? "";
    const now = Date.now();
    const from = parseTimestamp(c.req.query("from"), now - 3600_000);
    const to = parseTimestamp(c.req.query("to"), now);
    const limit = clampInt(c.req.query("limit"), 200, 1, 1000);
    const cursorRaw = Number(c.req.query("cursor"));
    const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;
    const f = parseFilters(q);
    const where = buildWhere(f, { from, to });
    const rows = queryEvents(db, { where: where.sql, params: where.params, limit, cursor });
    return c.json({
      events: rows.map(toClientEvent),
      nextCursor: rows.length === limit ? rows[rows.length - 1]?.id ?? null : null,
    });
  });

  // ---------- histogram: GET /v1/histogram ----------
  api.get("/histogram", (c) => {
    const now = Date.now();
    const from = parseTimestamp(c.req.query("from"), now - 3600_000);
    const to = parseTimestamp(c.req.query("to"), now);
    const buckets = clampInt(c.req.query("buckets"), 60, 1, 240);
    const bucketMs = Math.max(1000, Math.trunc((to - from) / buckets));
    return c.json({ from, to, bucketMs, points: histogramPoints(db, from, to, bucketMs) });
  });

  // ---------- services: GET /v1/services ----------
  api.get("/services", (c) => c.json({ services: listServices(db) }));

  // ---------- live tail: GET /v1/stream (SSE) ----------
  api.get("/stream", (c) => {
    const q = c.req.query("q") ?? "";
    const f = parseFilters(q);
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribeEvents((rows) => {
        for (const row of rows) {
          if (!matchesEvent(f, row)) continue;
          void stream
            .writeSSE({ data: JSON.stringify(toClientEvent(row)) })
            .catch(() => undefined);
        }
      });
      const heartbeat = setInterval(() => {
        void stream.write(": ping\n").catch(() => undefined);
      }, 15000);
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      // Hold the stream open until the client disconnects.
      await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
    });
  });

  app.route("/v1", api);
}
