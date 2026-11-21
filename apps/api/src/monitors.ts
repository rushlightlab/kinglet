import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { subscribeEvents } from "./bus.ts";
import { buildWhere, matchesEvent, parseFilters } from "./filters.ts";
import type { ParsedFilters } from "./filters.ts";
import { isJsonObject, isString } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { validateQueryString } from "./query-validation.ts";
import { isChannelType, sendNotice, validateWebhookUrl } from "./notify.ts";
import type { AlertNotice, NotifyChannel } from "./notify.ts";
import { uuidv7, isUuid } from "./auth/ids.ts";
import type { AlertState } from "./alerts.ts";
import { resolveMonitorChannelData, recordDelivery } from "./notifications/store.ts";
import type { MonitorChannelData } from "./notifications/store.ts";
import { safeErrorMessage } from "./notifications/types.ts";
import type { MonitorChannelSummary } from "./notifications/types.ts";
import { systemStatus } from "./status.ts";
import { localDbBytes } from "./storage/db-size.ts";
import * as schema from "./storage/schema.ts";
import type { Storage } from "./storage/index.ts";
import { LEVEL_NAMES } from "./types.ts";
import type { StoredEvent } from "./types.ts";

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
  /** Legacy inline channels; kept for one release during migration. */
  channels: NotifyChannel[];
  /** First-class notification channel ids linked to this monitor. */
  channelIds: string[];
  /** Safe summaries (id/name/type/enabled/health) — never URLs. */
  resolvedChannels: MonitorChannelSummary[];
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
  channelIds: string[];
  /** PATCH replaces links only when the client sent `channelIds`. */
  channelIdsPresent: boolean;
}

const MONITOR_KIND_SET = new Set<string>(MONITOR_KINDS);

function isMonitorKind(value: unknown): value is MonitorKind {
  return isString(value) && MONITOR_KIND_SET.has(value);
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

  let channelIds: string[] = [];
  let channelIdsPresent = false;

  if (o.channelIds !== undefined) {
    channelIdsPresent = true;

    if (!Array.isArray(o.channelIds)) {
      return { ok: false, error: "channelIds must be an array" };
    }

    if (o.channelIds.length > 8) {
      return { ok: false, error: "a monitor can use at most 8 channels" };
    }

    const seen = new Set<string>();

    for (const [index, value] of o.channelIds.entries()) {
      if (!isString(value) || !isUuid(value)) {
        return { ok: false, error: `channelIds[${index}] is not a valid channel id` };
      }

      const channelId = value.toLowerCase();

      if (!seen.has(channelId)) {
        seen.add(channelId);
        channelIds.push(channelId);
      }
    }
  }

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
      channelIds,
      channelIdsPresent,
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

const EMPTY_CHANNEL_DATA: MonitorChannelData = {
  channelIds: [],
  summaries: [],
  delivery: [],
};

function rowToMonitor(
  row: typeof schema.monitors.$inferSelect,
  channelData?: MonitorChannelData,
): Monitor {
  const linked = channelData ?? EMPTY_CHANNEL_DATA;

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
    channelIds: linked.channelIds,
    resolvedChannels: linked.summaries,
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

  const channelData = await resolveMonitorChannelData(
    storage,
    rows.map((row) => row.id),
  );

  return rows.map((row) => rowToMonitor(row, channelData.get(row.id)));
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

  if (!row) return null;

  const channelData = await resolveMonitorChannelData(storage, [row.id]);

  return rowToMonitor(row, channelData.get(row.id));
}

export type MonitorResult = { ok: true; monitor: Monitor } | { ok: false; error: string };

async function validateChannelIds(storage: Storage, channelIds: string[]): Promise<string | null> {
  if (channelIds.length === 0) return null;

  const rows = await storage.db
    .select({ id: schema.notificationChannels.id })
    .from(schema.notificationChannels)
    .where(inArray(schema.notificationChannels.id, channelIds));

  const found = new Set(rows.map((row) => row.id));

  for (const id of channelIds) {
    if (!found.has(id)) return "one or more channels were not found";
  }

  return null;
}

export async function createMonitorFromRaw(
  storage: Storage,
  projectId: string,
  raw: JsonValue,
  opts: { allowPrivateWebhooks: boolean },
): Promise<MonitorResult> {
  const input = parseMonitorInput(raw, opts);

  if (!input.ok) return input;
  const v = input.value;
  const channelProblem = await validateChannelIds(storage, v.channelIds);

  if (channelProblem) return { ok: false, error: channelProblem };
  const now = Date.now();

  const createdId = await storage.db.transaction(async (tx) => {
    const rows = await tx
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
      .returning({ id: schema.monitors.id });

    const id = rows[0]?.id;

    if (!id) return null;

    if (v.channelIds.length > 0) {
      await tx
        .insert(schema.monitorChannels)
        .values(v.channelIds.map((channelId) => ({ monitorId: id, channelId })))
        .onConflictDoNothing();
    }

    return id;
  });

  if (!createdId) return { ok: false, error: "insert failed" };

  const monitor = await getMonitor(storage, createdId, projectId);

  return monitor ? { ok: true, monitor } : { ok: false, error: "insert failed" };
}

export async function updateMonitorFromRaw(
  storage: Storage,
  id: string,
  projectId: string,
  raw: JsonValue,
  opts: { allowPrivateWebhooks: boolean },
): Promise<MonitorResult | { ok: false; error: string; notFound: true }> {
  if (!isJsonObject(raw)) return { ok: false, error: "monitor must be an object" };

  const existing = await getMonitor(storage, id, projectId);

  if (!existing) return { ok: false, error: "monitor not found", notFound: true };

  // PATCH is a partial update: merge supplied fields over the stored monitor
  // instead of running the create defaults over an incomplete body. Only pass
  // channelIds when the caller actually supplied it, so an omitted field keeps
  // the existing first-class links intact.
  const merged: JsonObject = {
    name: existing.name,
    query: existing.query,
    kind: existing.kind,
    threshold: existing.threshold,
    windowMs: existing.windowMs,
    intervalMs: existing.intervalMs,
    cooldownMs: existing.cooldownMs,
    enabled: existing.enabled,
    channels: existing.channels.map((channel) => ({ type: channel.type, url: channel.url })),
    ...raw,
  };

  if (!Object.prototype.hasOwnProperty.call(raw, "channelIds")) delete merged.channelIds;

  const input = parseMonitorInput(merged, opts);

  if (!input.ok) return input;
  const v = input.value;
  const channelProblem = await validateChannelIds(storage, v.channelIds);

  if (channelProblem) return { ok: false, error: channelProblem };

  const updatedId = await storage.db.transaction(async (tx) => {
    const rows = await tx
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
      .returning({ id: schema.monitors.id });

    const updated = rows[0]?.id;

    if (!updated) return null;

    // PATCH without channelIds must not wipe existing links; the old UI does
    // not know about them yet.
    if (v.channelIdsPresent) {
      await tx.delete(schema.monitorChannels).where(eq(schema.monitorChannels.monitorId, updated));

      if (v.channelIds.length > 0) {
        await tx
          .insert(schema.monitorChannels)
          .values(v.channelIds.map((channelId) => ({ monitorId: updated, channelId })))
          .onConflictDoNothing();
      }
    }

    return updated;
  });

  if (!updatedId) return { ok: false, error: "monitor not found", notFound: true };

  const monitor = await getMonitor(storage, updatedId, projectId);

  return monitor
    ? { ok: true, monitor }
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
    await tx.delete(schema.monitorChannels).where(eq(schema.monitorChannels.monitorId, id));

    return true;
  });
}

export interface AlertListFilters {
  monitorId?: string;
  state?: AlertState;
  from?: number;
  to?: number;
}

type AlertQueryRow = {
  id: string;
  monitorId: string;
  state: string;
  summary: string;
  count: number | null;
  sampleMessage: string | null;
  firedAt: number;
  resolvedAt: number | null;
  notifyStatus: string | null;
  notifyError: string | null;
  monitorName: string | null;
};

const alertSelection = {
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
} as const;

function mapAlertRow(row: AlertQueryRow): AlertRecord {
  return {
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
  };
}

export async function listAlerts(
  storage: Storage,
  limit: number,
  projectId: string,
  filters: AlertListFilters = {},
): Promise<AlertRecord[]> {
  const conditions: SQL[] = [eq(schema.monitors.projectId, projectId)];

  if (filters.monitorId !== undefined) {
    conditions.push(eq(schema.alerts.monitorId, filters.monitorId));
  }

  if (filters.state !== undefined) conditions.push(eq(schema.alerts.state, filters.state));

  if (filters.from !== undefined) conditions.push(gte(schema.alerts.firedAt, filters.from));

  if (filters.to !== undefined) conditions.push(lte(schema.alerts.firedAt, filters.to));

  const rows = await storage.db
    .select(alertSelection)
    .from(schema.alerts)
    .innerJoin(schema.monitors, eq(schema.monitors.id, schema.alerts.monitorId))
    .where(and(...conditions))
    .orderBy(desc(schema.alerts.firedAt))
    .limit(Math.min(500, Math.max(1, limit)));

  return rows.map(mapAlertRow);
}

/** One alert by id, scoped through its monitor's project. */
export async function getAlert(
  storage: Storage,
  id: string,
  projectId: string,
): Promise<AlertRecord | null> {
  const rows = await storage.db
    .select(alertSelection)
    .from(schema.alerts)
    .innerJoin(schema.monitors, eq(schema.monitors.id, schema.alerts.monitorId))
    .where(and(eq(schema.alerts.id, id), eq(schema.monitors.projectId, projectId)))
    .limit(1);

  const row = rows[0];

  return row ? mapAlertRow(row) : null;
}

/**
 * Delivery targets for one monitor: linked channels when present, otherwise
 * legacy inline channels. Route handlers can use this for monitor test sends.
 */
export async function resolveMonitorNotifyTargets(
  storage: Storage,
  monitor: Monitor,
): Promise<NotifyChannel[]> {
  if (monitor.channelIds.length === 0) return monitor.channels;

  const data = await resolveMonitorChannelData(storage, [monitor.id]);

  return data.get(monitor.id)?.delivery ?? [];
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

  async function recordMonitorDelivery(
    m: Monitor,
    channel: NotifyChannel,
    notice: AlertNotice,
    status: "sent" | "failed",
    error: string | null,
  ): Promise<void> {
    if (!channel.id) return;

    try {
      await recordDelivery(storage, {
        channelId: channel.id,
        scope: "monitor",
        event: `monitor.${notice.state}`,
        subject: m.name.slice(0, 200),
        status,
        error,
      });
    } catch (err) {
      console.warn(
        "[kinglet] could not record monitor delivery:",
        safeErrorMessage(err instanceof Error ? err : String(err), 200),
      );
    }
  }

  async function notifyAll(
    m: Monitor,
    notice: AlertNotice,
    targets: NotifyChannel[],
  ): Promise<{ sent: number; failed: number; errors: string[]; total: number }> {
    const outcomes = await Promise.all(
      targets.map(async (ch) => {
        try {
          await sendNotice(ch, notice, { allowPrivate });
        } catch (err) {
          const message = safeErrorMessage(err instanceof Error ? err : String(err), 500);

          await recordMonitorDelivery(m, ch, notice, "failed", message);
          console.warn("[kinglet] notification failed:", message);

          return message;
        }

        await recordMonitorDelivery(m, ch, notice, "sent", null);

        return null;
      }),
    );

    let failed = 0;
    const errors: string[] = [];

    for (const message of outcomes) {
      if (message === null) continue;
      failed++;
      errors.push(message);
    }

    if (failed > 0)
      console.warn(`[kinglet] ${failed}/${targets.length} channels failed for "${m.name}"`);

    return { sent: targets.length - failed, failed, errors, total: targets.length };
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

      const targets = await resolveMonitorNotifyTargets(storage, m);

      const delivery = await notifyAll(
        m,
        {
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
        },
        targets,
      );

      if (alertId !== null) {
        const notifyStatus =
          delivery.total === 0
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
    await notifyAll(
      m,
      {
        monitorId: m.id,
        monitorName: m.name,
        projectName: projectNames.get(m.projectId),
        query: m.query,
        state: "resolved",
        summary: "condition cleared",
        firedAt: now,
        link: linkFor(m, now),
      },
      await resolveMonitorNotifyTargets(storage, m),
    );
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
        storage.searchMode,
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
