import { and, asc, count, desc, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { subscribeEvents } from "./bus.js";
import { buildWhere, matchesEvent, parseFilters } from "./filters.js";
import type { ParsedFilters } from "./filters.js";
import { isJsonObject, isString } from "./json.js";
import type { JsonValue } from "./json.js";
import { validateQueryString } from "./query-validation.js";
import { sendNotice, validateWebhookUrl } from "./notify.js";
import type { AlertNotice, NotifyChannel } from "./notify.js";
import { uuidv7 } from "./auth/ids.js";
import { systemStatus } from "./status.js";
import { localDbBytes } from "./storage/db-size.js";
import * as schema from "./storage/schema.js";
import type { Storage } from "./storage/index.js";
import { LEVEL_NAMES } from "./types.js";
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
  id: string;
  projectId: string;
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
  /** Runtime observability, written by the alert engine. */
  lastEvalAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface AlertRecord {
  id: string;
  monitorId: string;
  monitorName: string | null;
  state: "fired" | "resolved";
  summary: string;
  count: number | null;
  sampleMessage: string | null;
  firedAt: number;
  resolvedAt: number | null;
  /** Delivery outcome of the "fired" notification. */
  notifyStatus: "sent" | "partial" | "failed" | "none" | null;
  notifyError: string | null;
}

const NOTIFY_STATUS_SET = new Set<string>(["sent", "partial", "failed", "none"]);

function isNotifyStatus(value: string | null): value is AlertRecord["notifyStatus"] {
  return value !== null && NOTIFY_STATUS_SET.has(value);
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

const MONITOR_KIND_SET = new Set<string>(MONITOR_KINDS);
const CHANNEL_TYPE_SET = new Set<string>(["webhook", "discord", "slack"]);

function isMonitorKind(value: unknown): value is MonitorKind {
  return isString(value) && MONITOR_KIND_SET.has(value);
}

function isChannelType(value: unknown): value is NotifyChannel["type"] {
  return isString(value) && CHANNEL_TYPE_SET.has(value);
}

function clampInt(raw: JsonValue | undefined, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(raw));

  if (!Number.isFinite(n)) return fallback;

  return Math.min(max, Math.max(min, n));
}

export function parseMonitorInput(
  raw: JsonValue,
  opts: { allowPrivateWebhooks: boolean },
): { ok: true; value: MonitorInput } | { ok: false; error: string } {
  if (!isJsonObject(raw)) {
    return { ok: false, error: "monitor must be an object" };
  }

  const o = raw;

  const name = isString(o.name) ? o.name.trim() : "";

  if (!name || name.length > 128) return { ok: false, error: "name must be 1-128 characters" };

  const query = isString(o.query) ? o.query.trim().slice(0, 500) : "";

  if (/\n|\r/.test(query))
    return { ok: false, error: "query must be a single-line filter expression" };
  const queryProblem = validateQueryString(query);

  if (queryProblem) return { ok: false, error: queryProblem };

  const kind = isMonitorKind(o.kind) ? o.kind : "count_above";

  const channels: NotifyChannel[] = [];
  const rawChannels = Array.isArray(o.channels) ? o.channels.slice(0, 8) : [];

  for (const [index, c] of rawChannels.entries()) {
    if (!isJsonObject(c)) {
      return { ok: false, error: `channel ${index + 1} must be an object` };
    }

    const type = c.type;
    const url = isString(c.url) ? c.url.trim() : "";

    if (!isChannelType(type)) {
      return { ok: false, error: `channel ${index + 1}: type must be webhook, discord, or slack` };
    }

    const urlError = validateWebhookUrl(url, opts.allowPrivateWebhooks);

    if (urlError) {
      return { ok: false, error: `channel ${index + 1}: ${urlError}` };
    }

    channels.push({ type, url });
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

    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((value): NotifyChannel[] => {
      if (!isJsonObject(value)) return [];

      const type = value.type;
      const url = value.url;

      return isChannelType(type) && isString(url) ? [{ type, url }] : [];
    });
  } catch {
    return [];
  }
}

function rowToMonitor(row: typeof schema.monitors.$inferSelect): Monitor {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    query: row.query,
    kind: isMonitorKind(row.kind) ? row.kind : "count_above",
    threshold: Number(row.threshold),
    windowMs: Number(row.windowMs),
    intervalMs: Number(row.intervalMs),
    cooldownMs: Number(row.cooldownMs),
    enabled: Number(row.enabled) === 1,
    channels: parseChannels(row.channels),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    lastEvalAt: row.lastEvalAt === null ? null : Number(row.lastEvalAt),
    lastError: row.lastError ?? null,
    lastErrorAt: row.lastErrorAt === null ? null : Number(row.lastErrorAt),
  };
}

/** All monitors when projectId is omitted (the alert engine); one project otherwise. */
export async function listMonitors(storage: Storage, projectId?: string): Promise<Monitor[]> {
  const rows = await storage.db
    .select()
    .from(schema.monitors)
    .where(projectId === undefined ? undefined : eq(schema.monitors.projectId, projectId))
    .orderBy(asc(schema.monitors.id));

  return rows.map(rowToMonitor);
}

export async function getMonitor(
  storage: Storage,
  id: string,
  projectId?: string,
): Promise<Monitor | null> {
  const condition =
    projectId === undefined
      ? eq(schema.monitors.id, id)
      : and(eq(schema.monitors.id, id), eq(schema.monitors.projectId, projectId));

  const rows = await storage.db.select().from(schema.monitors).where(condition).limit(1);
  const row = rows[0];

  return row ? rowToMonitor(row) : null;
}

export type MonitorResult = { ok: true; monitor: Monitor } | { ok: false; error: string };

export async function createMonitorFromRaw(
  storage: Storage,
  projectId: string,
  raw: JsonValue,
  opts: { allowPrivateWebhooks: boolean },
): Promise<MonitorResult> {
  const input = parseMonitorInput(raw, opts);

  if (!input.ok) return input;
  const v = input.value;
  const now = Date.now();

  const rows = await storage.db
    .insert(schema.monitors)
    .values({
      id: uuidv7(),
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
  id: string,
  projectId: string,
  raw: JsonValue,
  opts: { allowPrivateWebhooks: boolean },
): Promise<MonitorResult | { ok: false; error: string; notFound: true }> {
  const input = parseMonitorInput(raw, opts);

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

  return row
    ? { ok: true, monitor: rowToMonitor(row) }
    : { ok: false, error: "monitor not found", notFound: true };
}

export async function deleteMonitor(
  storage: Storage,
  id: string,
  projectId: string,
): Promise<boolean> {
  return storage.db.transaction(async (tx) => {
    const result = await tx
      .delete(schema.monitors)
      .where(and(eq(schema.monitors.id, id), eq(schema.monitors.projectId, projectId)));

    if (Number(result.rowsAffected ?? 0) === 0) return false;
    await tx.delete(schema.alerts).where(eq(schema.alerts.monitorId, id));

    return true;
  });
}

export async function listAlerts(
  storage: Storage,
  limit: number,
  projectId: string,
): Promise<AlertRecord[]> {
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
      notifyStatus: schema.alerts.notifyStatus,
      notifyError: schema.alerts.notifyError,
      monitorName: schema.monitors.name,
    })
    .from(schema.alerts)
    .innerJoin(schema.monitors, eq(schema.monitors.id, schema.alerts.monitorId))
    .where(eq(schema.monitors.projectId, projectId))
    .orderBy(desc(schema.alerts.firedAt))
    .limit(Math.min(500, Math.max(1, limit)));

  return rows.map((row) => ({
    id: row.id,
    monitorId: row.monitorId,
    monitorName: row.monitorName ?? null,
    state: row.state === "resolved" ? "resolved" : "fired",
    summary: row.summary,
    count: row.count === null ? null : Number(row.count),
    sampleMessage: row.sampleMessage ?? null,
    firedAt: Number(row.firedAt),
    resolvedAt: row.resolvedAt === null ? null : Number(row.resolvedAt),
    notifyStatus: isNotifyStatus(row.notifyStatus) ? row.notifyStatus : null,
    notifyError: row.notifyError ?? null,
  }));
}

export interface MonitorEngine {
  /** Reload monitors from storage (call after any CRUD mutation). */
  refresh(): Promise<void>;
  stop(): void;
}

interface MonitorState {
  active: boolean;
  firing: boolean;
  lastFiredAt: number;
  lastEvalAt: number;
  openAlertId: string | null;
  evaluating: boolean;
}

export function startMonitorEngine(
  storage: Storage,
  opts: {
    baseUrl?: string;
    allowPrivateWebhooks?: boolean;
    dbPath?: string;
    maxDbBytes?: number;
  } = {},
): MonitorEngine {
  const allowPrivate = opts.allowPrivateWebhooks ?? false;
  const maxDbBytes = opts.maxDbBytes ?? 0;
  let monitors: Monitor[] = [];
  let projectNames = new Map<string, string>();
  const state = new Map<string, MonitorState>();
  const parsedCache = new Map<string, ParsedFilters>();

  const parsed = (query: string): ParsedFilters => {
    let f = parsedCache.get(query);

    if (!f) {
      f = parseFilters(query);
      parsedCache.set(query, f);
    }

    return f;
  };

  const getState = (id: string): MonitorState => {
    let s = state.get(id);

    if (!s) {
      s = {
        active: false,
        firing: false,
        lastFiredAt: 0,
        lastEvalAt: 0,
        openAlertId: null,
        evaluating: false,
      };
      state.set(id, s);
    }

    return s;
  };

  async function refresh(): Promise<void> {
    try {
      const [rows, projectRows] = await Promise.all([
        listMonitors(storage),
        storage.db
          .select({ id: schema.projects.id, name: schema.projects.name })
          .from(schema.projects),
      ]);

      monitors = rows;
      projectNames = new Map(projectRows.map((project) => [project.id, project.name]));
      const ids = new Set(monitors.map((m) => m.id));

      for (const id of state.keys()) {
        if (!ids.has(id)) state.delete(id);
      }

      const queries = new Set(monitors.map((m) => m.query));

      for (const key of parsedCache.keys()) {
        if (!queries.has(key)) parsedCache.delete(key);
      }

      // Disabling a monitor must resolve its open alert instead of leaving
      // it "fired" forever.
      for (const m of monitors) {
        const s = state.get(m.id);

        if (!m.enabled && s?.active) {
          try {
            await resolve(m, s);
          } catch (err) {
            console.warn(
              "[kinglet] could not resolve disabled monitor:",
              err instanceof Error ? err.message : err,
            );
          }
        }
      }

      systemStatus.monitorRefreshAt = Date.now();
      systemStatus.monitorRefreshError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      systemStatus.monitorRefreshError = message;
      console.warn("[kinglet] monitor refresh failed:", message);
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

  async function notifyAll(
    m: Monitor,
    notice: AlertNotice,
  ): Promise<{ sent: number; failed: number; errors: string[] }> {
    const results = await Promise.allSettled(
      m.channels.map((ch) => sendNotice(ch, notice, { allowPrivate })),
    );

    let failed = 0;
    const errors: string[] = [];

    for (const r of results) {
      if (r.status === "rejected") {
        failed++;
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        errors.push(message);
        console.warn("[kinglet] notification failed:", message);
      }
    }

    if (failed > 0)
      console.warn(`[kinglet] ${failed}/${m.channels.length} channels failed for "${m.name}"`);

    return { sent: m.channels.length - failed, failed, errors };
  }

  async function fire(
    m: Monitor,
    s: MonitorState,
    detail: {
      count?: number;
      sampleMessage?: string;
      sampleService?: string | null;
      sampleEnv?: string | null;
      sampleLevel?: string | null;
    },
  ): Promise<void> {
    // Reserve synchronously so concurrent ingest batches cannot double-fire.
    if (s.firing) return;
    s.firing = true;

    try {
      if (maxDbBytes > 0 && opts.dbPath) {
        const bytes = localDbBytes(opts.dbPath);

        if (bytes !== null && bytes >= maxDbBytes) {
          console.warn("[kinglet] alert not recorded: database size limit reached");

          return;
        }
      }

      const now = Date.now();
      const summary = summaryFor(m, detail);
      let alertId = s.openAlertId;

      if (alertId !== null && s.active) {
        // A match monitor that is already firing updates its open alert
        // instead of inserting a new row on every cooldown expiry. This keeps
        // alert history bounded without losing the latest sample.
        await storage.db
          .update(schema.alerts)
          .set({
            state: "fired",
            summary,
            count: detail.count ?? null,
            sampleMessage: detail.sampleMessage ?? null,
            firedAt: now,
            resolvedAt: null,
            notifyStatus: null,
            notifyError: null,
          })
          .where(eq(schema.alerts.id, alertId));
      } else {
        const inserted = await storage.db
          .insert(schema.alerts)
          .values({
            id: uuidv7(),
            monitorId: m.id,
            state: "fired",
            summary,
            count: detail.count ?? null,
            sampleMessage: detail.sampleMessage ?? null,
            firedAt: now,
          })
          .returning({ id: schema.alerts.id });

        alertId = inserted[0]?.id ?? null;
        s.openAlertId = alertId;
      }

      s.active = true;
      s.lastFiredAt = now;

      const delivery = await notifyAll(m, {
        monitorId: m.id,
        monitorName: m.name,
        projectName: projectNames.get(m.projectId),
        service: detail.sampleService ?? null,
        env: detail.sampleEnv ?? null,
        level: detail.sampleLevel ?? null,
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

      if (alertId !== null) {
        const notifyStatus =
          m.channels.length === 0
            ? "none"
            : delivery.failed === 0
              ? "sent"
              : delivery.sent > 0
                ? "partial"
                : "failed";

        try {
          await storage.db
            .update(schema.alerts)
            .set({
              notifyStatus,
              notifyError:
                delivery.errors.length > 0
                  ? delivery.errors.slice(0, 3).join("; ").slice(0, 500)
                  : null,
            })
            .where(eq(schema.alerts.id, alertId));
        } catch (err) {
          console.warn(
            "[kinglet] could not record notify status:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    } finally {
      s.firing = false;
    }
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
      projectName: projectNames.get(m.projectId),
      query: m.query,
      state: "resolved",
      summary: "condition cleared",
      firedAt: now,
      link: linkFor(m, now),
    });
  }

  function summaryFor(m: Monitor, detail: { count?: number; sampleMessage?: string }): string {
    if (m.kind === "match") {
      return detail.sampleMessage
        ? `matched: ${detail.sampleMessage.slice(0, 160)}`
        : "event matched";
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

      const where: SQL = buildWhere(
        parsed(m.query),
        { from: now - m.windowMs, to: now },
        m.projectId,
      );

      const rows = await storage.db.select({ n: count() }).from(schema.events).where(where);
      const total = Number(rows[0]?.n ?? 0);
      const cond = m.kind === "count_above" ? total > m.threshold : total < m.threshold;
      void storage.db
        .update(schema.monitors)
        .set({ lastEvalAt: now, lastError: null, lastErrorAt: null })
        .where(eq(schema.monitors.id, m.id))
        .catch(() => undefined);

      if (cond && !s.active && now - s.lastFiredAt >= m.cooldownMs) {
        await fire(m, s, { count: total });
      } else if (!cond && s.active) {
        await resolve(m, s);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[kinglet] monitor "${m.name}" evaluation failed:`, message);
      void storage.db
        .update(schema.monitors)
        .set({ lastError: message.slice(0, 500), lastErrorAt: Date.now() })
        .where(eq(schema.monitors.id, m.id))
        .catch(() => undefined);
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

          if (s.firing) break;

          if (now - s.lastFiredAt < m.cooldownMs) break;
          await fire(m, s, {
            sampleMessage: row.message,
            sampleService: row.service,
            sampleEnv: row.env,
            sampleLevel: LEVEL_NAMES[row.level] ?? null,
          });
          break; // one fire per batch per monitor
        }
      } catch (err) {
        // A failed alert insert must never take down ingest or the process.
        console.error(
          `[kinglet] monitor "${m.name}" event processing failed:`,
          err instanceof Error ? err.message : err,
        );
        void storage.db
          .update(schema.monitors)
          .set({
            lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
            lastErrorAt: Date.now(),
          })
          .where(eq(schema.monitors.id, m.id))
          .catch(() => undefined);
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
