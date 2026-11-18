import { and, asc, count, desc, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { subscribeEvents } from "./bus.js";
import { buildWhere, matchesEvent, parseFilters } from "./filters.js";
import type { ParsedFilters } from "./filters.js";
import { sendNotice } from "./notify.js";
import type { AlertNotice, NotifyChannel } from "./notify.js";
import * as schema from "./storage/schema.js";
import type { Storage } from "./storage/index.js";
import type { StoredEvent } from "./types.js";

/**
 * Monitors: standing queries that watch a project's event stream.
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
  projectId: number;
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
  for (const [index, c] of rawChannels.entries()) {
    if (c === null || typeof c !== "object") {
      return { ok: false, error: `channel ${index + 1} must be an object` };
    }
    const cc = c as Record<string, unknown>;
    const type = cc.type;
    const url = typeof cc.url === "string" ? cc.url.trim() : "";
    if (typeof type !== "string" || !CHANNEL_TYPES.includes(type)) {
      return { ok: false, error: `channel ${index + 1}: type must be webhook, discord, or slack` };
    }
    if (!/^https?:\/\//i.test(url) || url.length > 2048) {
      return { ok: false, error: `channel ${index + 1}: url must start with http:// or https://` };
    }
    channels.push({ type: type as NotifyChannel["type"], url });
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

function parseChannels(raw: string): NotifyChannel[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NotifyChannel[]) : [];
  } catch {
    return [];
  }
}

function rowToMonitor(row: typeof schema.monitors.$inferSelect): Monitor {
  return {
    id: Number(row.id),
    projectId: Number(row.projectId),
    name: row.name,
    query: row.query,
    kind: (MONITOR_KINDS as readonly string[]).includes(row.kind) ? (row.kind as MonitorKind) : "count_above",
    threshold: Number(row.threshold),
    windowMs: Number(row.windowMs),
    intervalMs: Number(row.intervalMs),
    cooldownMs: Number(row.cooldownMs),
    enabled: Number(row.enabled) === 1,
    channels: parseChannels(row.channels),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

/** All monitors when projectId is omitted (the alert engine); one project otherwise. */
export async function listMonitors(storage: Storage, projectId?: number): Promise<Monitor[]> {
  const rows = await storage.db
    .select()
    .from(schema.monitors)
    .where(projectId === undefined ? undefined : eq(schema.monitors.projectId, projectId))
    .orderBy(asc(schema.monitors.id));
  return rows.map(rowToMonitor);
}

export async function getMonitor(
  storage: Storage,
  id: number,
  projectId?: number
): Promise<Monitor | null> {
  const condition = projectId === undefined
    ? eq(schema.monitors.id, id)
    : and(eq(schema.monitors.id, id), eq(schema.monitors.projectId, projectId));
  const rows = await storage.db.select().from(schema.monitors).where(condition).limit(1);
  const row = rows[0];
  return row ? rowToMonitor(row) : null;
}

export type MonitorResult = { ok: true; monitor: Monitor } | { ok: false; error: string };

export async function createMonitorFromRaw(
  storage: Storage,
  projectId: number,
  raw: unknown
): Promise<MonitorResult> {
  const input = parseMonitorInput(raw);
  if (!input.ok) return input;
  const v = input.value;
  const now = Date.now();
  const rows = await storage.db
    .insert(schema.monitors)
    .values({
      projectId,
      name: v.name,
      query: v.query,
      kind: v.kind,
      threshold: v.threshold,
      windowMs: v.windowMs,
      intervalMs: v.intervalMs,
      cooldownMs: v.cooldownMs,
      enabled: v.enabled ? 1 : 0,
      channels: JSON.stringify(v.channels),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const row = rows[0];
  return row ? { ok: true, monitor: rowToMonitor(row) } : { ok: false, error: "insert failed" };
}

export async function updateMonitorFromRaw(
  storage: Storage,
  id: number,
  projectId: number,
  raw: unknown
): Promise<MonitorResult | { ok: false; error: string; notFound: true }> {
  const input = parseMonitorInput(raw);
  if (!input.ok) return input;
  const v = input.value;
  const rows = await storage.db
    .update(schema.monitors)
    .set({
      name: v.name,
      query: v.query,
      kind: v.kind,
      threshold: v.threshold,
      windowMs: v.windowMs,
      intervalMs: v.intervalMs,
      cooldownMs: v.cooldownMs,
      enabled: v.enabled ? 1 : 0,
      channels: JSON.stringify(v.channels),
      updatedAt: Date.now(),
    })
    .where(and(eq(schema.monitors.id, id), eq(schema.monitors.projectId, projectId)))
    .returning();
  const row = rows[0];
  return row ? { ok: true, monitor: rowToMonitor(row) } : { ok: false, error: "monitor not found", notFound: true };
}

export async function deleteMonitor(storage: Storage, id: number, projectId: number): Promise<boolean> {
  return storage.db.transaction(async (tx) => {
    const result = await tx
      .delete(schema.monitors)
      .where(and(eq(schema.monitors.id, id), eq(schema.monitors.projectId, projectId)));
    if (Number(result.rowsAffected ?? 0) === 0) return false;
    await tx.delete(schema.alerts).where(eq(schema.alerts.monitorId, id));
    return true;
  });
}

export async function listAlerts(storage: Storage, limit: number, projectId: number): Promise<AlertRecord[]> {
  const rows = await storage.db
    .select({
      id: schema.alerts.id,
      monitorId: schema.alerts.monitorId,
      state: schema.alerts.state,
      summary: schema.alerts.summary,
      count: schema.alerts.count,
      sampleMessage: schema.alerts.sampleMessage,
      firedAt: schema.alerts.firedAt,
      resolvedAt: schema.alerts.resolvedAt,
      monitorName: schema.monitors.name,
    })
    .from(schema.alerts)
    .innerJoin(schema.monitors, eq(schema.monitors.id, schema.alerts.monitorId))
    .where(eq(schema.monitors.projectId, projectId))
    .orderBy(desc(schema.alerts.firedAt))
    .limit(Math.min(500, Math.max(1, limit)));
  return rows.map((row) => ({
    id: Number(row.id),
    monitorId: Number(row.monitorId),
    monitorName: row.monitorName ?? null,
    state: row.state === "resolved" ? "resolved" : "fired",
    summary: row.summary,
    count: row.count === null ? null : Number(row.count),
    sampleMessage: row.sampleMessage ?? null,
    firedAt: Number(row.firedAt),
    resolvedAt: row.resolvedAt === null ? null : Number(row.resolvedAt),
  }));
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
    const params = new URLSearchParams({
      project: String(m.projectId),
      from: String(from),
      to: String(ts),
    });
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
    const inserted = await storage.db
      .insert(schema.alerts)
      .values({
        monitorId: m.id,
        state: "fired",
        summary,
        count: detail.count ?? null,
        sampleMessage: detail.sampleMessage ?? null,
        firedAt: now,
      })
      .returning({ id: schema.alerts.id });
    s.active = true;
    s.lastFiredAt = now;
    s.openAlertId = Number(inserted[0]?.id ?? 0) || null;
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
      await storage.db
        .update(schema.alerts)
        .set({ state: "resolved", resolvedAt: now })
        .where(eq(schema.alerts.id, s.openAlertId));
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
      const where: SQL = buildWhere(parsed(m.query), { from: now - m.windowMs, to: now }, m.projectId);
      const rows = await storage.db.select({ n: count() }).from(schema.events).where(where);
      const total = Number(rows[0]?.n ?? 0);
      const cond = m.kind === "count_above" ? total > m.threshold : total < m.threshold;
      if (cond && !s.active && now - s.lastFiredAt >= m.cooldownMs) {
        await fire(m, s, { count: total });
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
      try {
        const f = parsed(m.query);
        for (const row of rows) {
          if (row.projectId !== m.projectId) continue;
          if (!matchesEvent(f, row)) continue;
          const s = getState(m.id);
          const now = Date.now();
          if (now - s.lastFiredAt < m.cooldownMs) break;
          await fire(m, s, { sampleMessage: row.message });
          break; // one fire per batch per monitor
        }
      } catch (err) {
        // A failed alert insert must never take down ingest or the process.
        console.error(
          `[kinglet] monitor "${m.name}" event processing failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  const unsubscribe = subscribeEvents((rows) => {
    void onEvents(rows).catch((err) => {
      console.error("[kinglet] monitor batch processing failed:", err);
    });
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
