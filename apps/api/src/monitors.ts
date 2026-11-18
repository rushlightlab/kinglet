import { subscribeEvents } from "./bus.js";
import { buildWhere, matchesEvent, parseFilters } from "./filters.js";
import type { ParsedFilters } from "./filters.js";
import { sendNotice } from "./notify.js";
import type { AlertNotice, NotifyChannel } from "./notify.js";
import type { Storage } from "./storage/index.js";
import type { StoredEvent } from "./types.js";

/**
 * Monitors: standing queries that watch your event stream.
 *
 *   match        — any event matching the query fires immediately
 *                  (rides the in-process ingest bus — zero queries)
 *   count_above  — more than `threshold` matches within `windowMs` fires
 *   count_below  — fewer than `threshold` matches within `windowMs` fires
 *                  (silence / heartbeat detection)
 *
 * Firing is debounced by `cooldownMs`; count monitors auto-resolve when the
 * condition clears, sending a "resolved" notification.
 */

export type MonitorKind = "match" | "count_above" | "count_below";
export const MONITOR_KINDS: readonly MonitorKind[] = ["match", "count_above", "count_below"];

export interface Monitor {
  id: number;
  name: string;
  query: string;
  kind: MonitorKind;
  threshold: number;
  windowMs: number;
  intervalMs: number;
  cooldownMs: number;
  enabled: boolean;
  channels: NotifyChannel[];
  createdAt: number;
  updatedAt: number;
}

export interface AlertRecord {
  id: number;
  monitorId: number;
  monitorName: string | null;
  state: "fired" | "resolved";
  summary: string;
  count: number | null;
  sampleMessage: string | null;
  firedAt: number;
  resolvedAt: number | null;
}

interface MonitorInput {
  name: string;
  query: string;
  kind: MonitorKind;
  threshold: number;
  windowMs: number;
  intervalMs: number;
  cooldownMs: number;
  enabled: boolean;
  channels: NotifyChannel[];
}

const CHANNEL_TYPES: readonly string[] = ["webhook", "discord", "slack"];

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function parseMonitorInput(raw: unknown): { ok: true; value: MonitorInput } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "monitor must be an object" };
  }
  const o = raw as Record<string, unknown>;

  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name || name.length > 128) return { ok: false, error: "name must be 1-128 characters" };

  const query = typeof o.query === "string" ? o.query.trim().slice(0, 500) : "";
  if (/\n|\r/.test(query)) return { ok: false, error: "query must be a single-line filter expression" };

  const kind =
    typeof o.kind === "string" && (MONITOR_KINDS as readonly string[]).includes(o.kind)
      ? (o.kind as MonitorKind)
      : "count_above";

  const channels: NotifyChannel[] = [];
  const rawChannels = Array.isArray(o.channels) ? o.channels.slice(0, 8) : [];
  for (const c of rawChannels) {
    if (c === null || typeof c !== "object") continue;
    const cc = c as Record<string, unknown>;
    const type = cc.type;
    const url = typeof cc.url === "string" ? cc.url.trim() : "";
    if (typeof type === "string" && CHANNEL_TYPES.includes(type) && /^https?:\/\//i.test(url) && url.length <= 2048) {
      channels.push({ type: type as NotifyChannel["type"], url });
    }
  }

  return {
    ok: true,
    value: {
      name,
      query,
      kind,
      threshold: clampInt(o.threshold, 1, 1, 1_000_000),
      windowMs: clampInt(o.windowMs, 300_000, 60_000, 30 * 24 * 3_600_000),
      intervalMs: clampInt(o.intervalMs, 60_000, 10_000, 24 * 3_600_000),
      cooldownMs: clampInt(o.cooldownMs, 600_000, 0, 7 * 24 * 3_600_000),
      enabled: o.enabled === undefined ? true : Boolean(o.enabled),
      channels,
    },
  };
}

function rowToMonitor(row: Record<string, unknown>): Monitor {
  let channels: NotifyChannel[] = [];
  try {
    const parsed = JSON.parse(String(row.channels ?? "[]")) as unknown;
    if (Array.isArray(parsed)) channels = parsed as NotifyChannel[];
  } catch {
    // fall back to no channels rather than breaking the monitor list
  }
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    query: String(row.query ?? ""),
    kind: (MONITOR_KINDS as readonly string[]).includes(String(row.kind))
      ? (String(row.kind) as MonitorKind)
      : "count_above",
    threshold: Number(row.threshold ?? 1),
    windowMs: Number(row.window_ms ?? 300_000),
    intervalMs: Number(row.interval_ms ?? 60_000),
    cooldownMs: Number(row.cooldown_ms ?? 600_000),
    enabled: Number(row.enabled ?? 1) === 1,
    channels,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function rowToAlert(row: Record<string, unknown>): AlertRecord {
  return {
    id: Number(row.id),
    monitorId: Number(row.monitor_id),
    monitorName: row.monitor_name === null || row.monitor_name === undefined ? null : String(row.monitor_name),
    state: String(row.state) === "resolved" ? "resolved" : "fired",
    summary: String(row.summary ?? ""),
    count: row.count === null || row.count === undefined ? null : Number(row.count),
    sampleMessage:
      row.sample_message === null || row.sample_message === undefined ? null : String(row.sample_message),
    firedAt: Number(row.fired_at ?? 0),
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : Number(row.resolved_at),
  };
}

export async function listMonitors(storage: Storage): Promise<Monitor[]> {
  const rows = await storage.sql.all("SELECT * FROM monitors ORDER BY id ASC");
  return rows.map(rowToMonitor);
}

export async function getMonitor(storage: Storage, id: number): Promise<Monitor | null> {
  const rows = await storage.sql.all("SELECT * FROM monitors WHERE id = ?", [id]);
  const row = rows[0];
  return row ? rowToMonitor(row) : null;
}

export type MonitorResult = { ok: true; monitor: Monitor } | { ok: false; error: string };

export async function createMonitorFromRaw(storage: Storage, raw: unknown): Promise<MonitorResult> {
  const input = parseMonitorInput(raw);
  if (!input.ok) return input;
  const v = input.value;
  const now = Date.now();
  const info = await storage.sql.run(
    "INSERT INTO monitors (name, query, kind, threshold, window_ms, interval_ms, cooldown_ms, enabled, channels, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [v.name, v.query, v.kind, v.threshold, v.windowMs, v.intervalMs, v.cooldownMs, v.enabled ? 1 : 0, JSON.stringify(v.channels), now, now]
  );
  return { ok: true, monitor: { id: info.lastInsertRowid ?? 0, ...v, createdAt: now, updatedAt: now } };
}

export async function updateMonitorFromRaw(
  storage: Storage,
  id: number,
  raw: unknown
): Promise<MonitorResult | { ok: false; error: string; notFound: true }> {
  const input = parseMonitorInput(raw);
  if (!input.ok) return input;
  const v = input.value;
  const info = await storage.sql.run(
    "UPDATE monitors SET name = ?, query = ?, kind = ?, threshold = ?, window_ms = ?, interval_ms = ?, cooldown_ms = ?, enabled = ?, channels = ?, updated_at = ? WHERE id = ?",
    [v.name, v.query, v.kind, v.threshold, v.windowMs, v.intervalMs, v.cooldownMs, v.enabled ? 1 : 0, JSON.stringify(v.channels), Date.now(), id]
  );
  if (info.rowsAffected === 0) return { ok: false, error: "monitor not found", notFound: true };
  const monitor = await getMonitor(storage, id);
  return monitor ? { ok: true, monitor } : { ok: false, error: "monitor not found", notFound: true };
}

export async function deleteMonitor(storage: Storage, id: number): Promise<boolean> {
  const info = await storage.sql.run("DELETE FROM monitors WHERE id = ?", [id]);
  if (info.rowsAffected === 0) return false;
  await storage.sql.run("DELETE FROM alerts WHERE monitor_id = ?", [id]);
  return true;
}

export async function listAlerts(storage: Storage, limit: number): Promise<AlertRecord[]> {
  const rows = await storage.sql.all(
    `SELECT a.id, a.monitor_id, a.state, a.summary, a.count, a.sample_message, a.fired_at, a.resolved_at, m.name AS monitor_name
     FROM alerts a LEFT JOIN monitors m ON m.id = a.monitor_id
     ORDER BY a.fired_at DESC LIMIT ?`,
    [Math.min(500, Math.max(1, limit))]
  );
  return rows.map(rowToAlert);
}

export interface MonitorEngine {
  /** Reload monitors from storage (call after any CRUD mutation). */
  refresh(): Promise<void>;
  stop(): void;
}

interface MonitorState {
  active: boolean;
  lastFiredAt: number;
  lastEvalAt: number;
  openAlertId: number | null;
  evaluating: boolean;
}

export function startMonitorEngine(storage: Storage, opts: { baseUrl?: string } = {}): MonitorEngine {
  let monitors: Monitor[] = [];
  const state = new Map<number, MonitorState>();
  const parsedCache = new Map<string, ParsedFilters>();

  const parsed = (query: string): ParsedFilters => {
    let f = parsedCache.get(query);
    if (!f) {
      f = parseFilters(query);
      parsedCache.set(query, f);
    }
    return f;
  };

  const getState = (id: number): MonitorState => {
    let s = state.get(id);
    if (!s) {
      s = { active: false, lastFiredAt: 0, lastEvalAt: 0, openAlertId: null, evaluating: false };
      state.set(id, s);
    }
    return s;
  };

  async function refresh(): Promise<void> {
    try {
      monitors = await listMonitors(storage);
    } catch (err) {
      console.warn("[kinglet] monitor refresh failed:", err instanceof Error ? err.message : err);
    }
  }

  function linkFor(m: Monitor, ts: number): string | undefined {
    if (!opts.baseUrl) return undefined;
    const from = ts - (m.windowMs || 3_600_000);
    const params = new URLSearchParams({ from: String(from), to: String(ts) });
    if (m.query) params.set("q", m.query);
    return `${opts.baseUrl.replace(/\/+$/, "")}/?${params.toString()}`;
  }

  async function notifyAll(m: Monitor, notice: AlertNotice): Promise<void> {
    const results = await Promise.allSettled(m.channels.map((ch) => sendNotice(ch, notice)));
    let failed = 0;
    for (const r of results) {
      if (r.status === "rejected") {
        failed++;
        console.warn("[kinglet] notification failed:", r.reason instanceof Error ? r.reason.message : r.reason);
      }
    }
    if (failed > 0) console.warn(`[kinglet] ${failed}/${m.channels.length} channels failed for "${m.name}"`);
  }

  async function fire(
    m: Monitor,
    s: MonitorState,
    detail: { count?: number; sampleMessage?: string }
  ): Promise<void> {
    const now = Date.now();
    const summary = summaryFor(m, detail);
    const info = await storage.sql.run(
      "INSERT INTO alerts (monitor_id, state, summary, count, sample_message, fired_at) VALUES (?, 'fired', ?, ?, ?, ?)",
      [m.id, summary, detail.count ?? null, detail.sampleMessage ?? null, now]
    );
    s.active = true;
    s.lastFiredAt = now;
    s.openAlertId = info.lastInsertRowid ?? null;
    await notifyAll(m, {
      monitorId: m.id,
      monitorName: m.name,
      query: m.query,
      state: "fired",
      summary,
      count: detail.count ?? null,
      threshold: m.threshold,
      windowMs: m.windowMs,
      sampleMessage: detail.sampleMessage ?? null,
      firedAt: now,
      link: linkFor(m, now),
    });
  }

  async function resolve(m: Monitor, s: MonitorState): Promise<void> {
    const now = Date.now();
    if (s.openAlertId !== null) {
      await storage.sql.run("UPDATE alerts SET state = 'resolved', resolved_at = ? WHERE id = ?", [now, s.openAlertId]);
    }
    s.active = false;
    s.openAlertId = null;
    await notifyAll(m, {
      monitorId: m.id,
      monitorName: m.name,
      query: m.query,
      state: "resolved",
      summary: "condition cleared",
      firedAt: now,
      link: linkFor(m, now),
    });
  }

  function summaryFor(m: Monitor, detail: { count?: number; sampleMessage?: string }): string {
    if (m.kind === "match") {
      return detail.sampleMessage ? `matched: ${detail.sampleMessage.slice(0, 160)}` : "event matched";
    }
    const op = m.kind === "count_above" ? "more than" : "fewer than";
    return `${detail.count ?? 0} events in ${durationLabel(m.windowMs)} (${op} ${m.threshold})`;
  }

  async function evaluate(m: Monitor): Promise<void> {
    const s = getState(m.id);
    if (s.evaluating) return;
    s.evaluating = true;
    s.lastEvalAt = Date.now();
    try {
      const now = Date.now();
      const where = buildWhere(parsed(m.query), { from: now - m.windowMs, to: now });
      const rows = await storage.sql.all(`SELECT COUNT(*) AS n FROM events WHERE ${where.sql}`, where.params);
      const count = Number(rows[0]?.n ?? 0);
      const cond = m.kind === "count_above" ? count > m.threshold : count < m.threshold;
      if (cond && !s.active && now - s.lastFiredAt >= m.cooldownMs) {
        await fire(m, s, { count });
      } else if (!cond && s.active) {
        await resolve(m, s);
      }
    } catch (err) {
      console.warn(`[kinglet] monitor "${m.name}" evaluation failed:`, err instanceof Error ? err.message : err);
    } finally {
      s.evaluating = false;
    }
  }

  async function onEvents(rows: StoredEvent[]): Promise<void> {
    for (const m of monitors) {
      if (!m.enabled || m.kind !== "match") continue;
      const f = parsed(m.query);
      for (const row of rows) {
        if (!matchesEvent(f, row)) continue;
        const s = getState(m.id);
        const now = Date.now();
        if (now - s.lastFiredAt < m.cooldownMs) break;
        await fire(m, s, { sampleMessage: row.message });
        break; // one fire per batch per monitor
      }
    }
  }

  const unsubscribe = subscribeEvents((rows) => {
    void onEvents(rows);
  });

  const tick = setInterval(() => {
    const now = Date.now();
    for (const m of monitors) {
      if (!m.enabled || m.kind === "match") continue;
      const s = getState(m.id);
      if (now - s.lastEvalAt >= m.intervalMs) void evaluate(m);
    }
  }, 5_000);
  tick.unref();

  void refresh();

  return {
    refresh,
    stop() {
      unsubscribe();
      clearInterval(tick);
    },
  };
}

function durationLabel(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}
