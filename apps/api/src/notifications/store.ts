import { and, asc, count, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { uuidv7 } from "../auth/ids.ts";
import { isChannelType, LEGACY_CHANNEL_TYPES } from "../notify.ts";
import type { ChannelType } from "../notify.ts";
import * as schema from "../storage/schema.ts";
import {
  channelContext,
  isSealed,
  lockedReason,
  monitorContext,
  openSecret,
  sealSecret,
  secretFingerprint,
  secretsConfigured,
} from "../secrets.ts";
import { tableSearchCondition } from "../table-search.ts";
import type { Storage } from "../storage/index.ts";
import { isNotificationAction } from "./types.ts";
import type {
  MonitorChannelSummary,
  NotificationAction,
  NotificationChannel,
  NotificationChannelHealth,
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationTestStatus,
} from "./types.ts";

/**
 * Database access shared by the notification routes, engine, migration, and
 * monitor reads. Every URL-bearing type stays internal to the API; callers
 * project to safe DTOs before returning anything over HTTP.
 */

export interface DeliveryTarget {
  id: string;
  name: string;
  type: ChannelType;
  /** Decrypted; empty when `locked`. */
  url: string;
  decoration: boolean;
  /** Why the target can't be decrypted; delivery refuses to send. */
  locked: string | null;
}

/** A channel's stored target, decrypted, and why it can't be when it can't. */
export interface ReadTarget {
  url: string;
  /** Stored encrypted (false only for rows from before KINGLET_SECRET_KEY). */
  encrypted: boolean;
  locked: string | null;
}

export function readChannelTarget(channelId: string, stored: string): ReadTarget {
  const opened = openSecret(stored, channelContext(channelId));

  if (!opened.ok) return { url: "", encrypted: true, locked: lockedReason(opened.reason) };

  return { url: opened.value, encrypted: opened.sealed, locked: null };
}

/**
 * A monitor's legacy inline destinations (JSON with webhook URLs), decrypted.
 * A locked value reads as no destinations: nothing is sent to a guessed URL.
 */
export function openMonitorChannels(monitorId: string, stored: string): string {
  const opened = openSecret(stored, monitorContext(monitorId));

  if (!opened.ok) {
    console.warn(
      `[kinglet] legacy destinations on monitor ${monitorId} are ${lockedReason(opened.reason)}`,
    );

    return "[]";
  }

  return opened.value;
}

/**
 * Legacy destinations for storage: sealed with the key, or plaintext without
 * one (only possible for rows that already held plaintext). An empty list
 * holds no secret and stays readable.
 */
export function sealMonitorChannels(monitorId: string, json: string): string {
  if (json === "[]" || !secretsConfigured()) return json;

  return sealSecret(json, monitorContext(monitorId));
}

/** The keyed fingerprint that keeps two channels from sharing a target. */
export function targetFingerprint(type: ChannelType, url: string): string | null {
  return secretFingerprint(`${type}\n${url}`);
}

/** The stored columns for a channel target. */
export interface StoredTarget {
  url: string;
  targetHash: string | null;
}

/** Columns for storing a target: sealed and fingerprinted. Needs the key. */
export function storedTarget(channelId: string, type: ChannelType, url: string): StoredTarget {
  return {
    url: sealSecret(url, channelContext(channelId)),
    targetHash: targetFingerprint(type, url),
  };
}

/**
 * Seal every secret stored before KINGLET_SECRET_KEY was set: plaintext channel
 * targets (adding their fingerprints) and legacy per-monitor destinations.
 * Runs at boot; safe to repeat, and a no-op without a key.
 */
export async function sealStoredSecrets(
  storage: Storage,
): Promise<{ channels: number; monitors: number }> {
  if (!secretsConfigured()) return { channels: 0, monitors: 0 };
  let channels = 0;
  let monitors = 0;

  const channelRows = await storage.db
    .select({
      id: schema.notificationChannels.id,
      type: schema.notificationChannels.type,
      url: schema.notificationChannels.url,
      targetHash: schema.notificationChannels.targetHash,
    })
    .from(schema.notificationChannels);

  for (const row of channelRows) {
    if (!isChannelType(row.type)) continue;

    if (isSealed(row.url) && row.targetHash !== null) continue;
    const target = readChannelTarget(row.id, row.url);

    // Sealed with another key: leave it locked for an admin to re-enter.
    if (target.locked !== null) continue;
    const stored = storedTarget(row.id, row.type, target.url);

    await storage.db
      .update(schema.notificationChannels)
      .set({ url: stored.url, targetHash: stored.targetHash })
      .where(eq(schema.notificationChannels.id, row.id));
    channels++;
  }

  const monitorRows = await storage.db
    .select({ id: schema.monitors.id, channels: schema.monitors.channels })
    .from(schema.monitors);

  for (const row of monitorRows) {
    if (isSealed(row.channels) || row.channels === "[]") continue;

    await storage.db
      .update(schema.monitors)
      .set({ channels: sealMonitorChannels(row.id, row.channels) })
      .where(eq(schema.monitors.id, row.id));
    monitors++;
  }

  if (channels > 0 || monitors > 0) {
    console.log(
      `[kinglet] encrypted ${channels} notification channel secret(s) and ${monitors} monitor destination list(s)`,
    );
  }

  return { channels, monitors };
}

/** Whether another channel already sends to this target. */
export async function hasChannelWithTarget(
  storage: Storage,
  type: ChannelType,
  url: string,
  excludeId: string | null,
): Promise<boolean> {
  const hash = targetFingerprint(type, url);

  const rows = await storage.db
    .select({
      id: schema.notificationChannels.id,
      type: schema.notificationChannels.type,
      url: schema.notificationChannels.url,
      targetHash: schema.notificationChannels.targetHash,
    })
    .from(schema.notificationChannels);

  // Fingerprints cover sealed rows; rows from before encryption compare as plaintext.
  return rows.some((row) => {
    if (row.id === excludeId) return false;

    if (hash !== null && row.targetHash === hash) return true;

    return row.type === type && readChannelTarget(row.id, row.url).url === url;
  });
}

export interface LatestDeliveryState {
  status: NotificationDeliveryStatus;
  createdAt: number;
  error: string | null;
}

export interface MonitorChannelData {
  /** Every linked channel id, including disabled ones (fallback precedence). */
  channelIds: string[];
  summaries: MonitorChannelSummary[];
  /** Enabled channels only, for the monitor alert engine. */
  delivery: DeliveryTarget[];
}

function testStatus(value: string | null): NotificationTestStatus | null {
  return value === "ok" || value === "failed" ? value : null;
}

export function healthFromDelivery(
  state: LatestDeliveryState | undefined,
): NotificationChannelHealth {
  if (!state) return { status: "unknown", lastDeliveryAt: null, error: null };

  return {
    status: state.status === "sent" ? "ok" : "failed",
    lastDeliveryAt: state.createdAt,
    error: state.status === "failed" ? state.error : null,
  };
}

/** Newest delivery state per channel. The delivery log is capped at 1,000 rows. */
export async function latestDeliveryStates(
  storage: Storage,
  channelIds?: string[],
): Promise<Map<string, LatestDeliveryState>> {
  const states = new Map<string, LatestDeliveryState>();

  if (channelIds !== undefined && channelIds.length === 0) return states;

  const rows = await storage.db
    .select({
      channelId: schema.notificationDeliveries.channelId,
      status: schema.notificationDeliveries.status,
      error: schema.notificationDeliveries.error,
      createdAt: schema.notificationDeliveries.createdAt,
      id: schema.notificationDeliveries.id,
    })
    .from(schema.notificationDeliveries)
    .where(
      channelIds === undefined
        ? undefined
        : inArray(schema.notificationDeliveries.channelId, channelIds),
    )
    .orderBy(desc(schema.notificationDeliveries.createdAt), desc(schema.notificationDeliveries.id))
    .limit(1000);

  for (const row of rows) {
    if (states.has(row.channelId)) continue;

    states.set(row.channelId, {
      status: row.status === "sent" ? "sent" : "failed",
      createdAt: Number(row.createdAt),
      error: row.error ?? null,
    });
  }

  return states;
}

function actionsByChannel(
  rows: Array<typeof schema.notificationChannelActions.$inferSelect>,
): Map<string, NotificationAction[]> {
  const grouped = new Map<string, NotificationAction[]>();

  for (const row of rows) {
    if (!isNotificationAction(row.action)) continue;

    const list = grouped.get(row.channelId);

    if (list) list.push(row.action);
    else grouped.set(row.channelId, [row.action]);
  }

  return grouped;
}

function channelFromRow(
  row: typeof schema.notificationChannels.$inferSelect,
  actions: NotificationAction[],
): NotificationChannel | null {
  const type = row.type;

  if (!isChannelType(type)) return null;
  const target = readChannelTarget(row.id, row.url);

  return {
    id: row.id,
    name: row.name,
    type,
    url: target.url,
    encrypted: target.encrypted,
    locked: target.locked,
    enabled: row.enabled,
    decoration: row.decoration,
    actions,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    lastTestAt: row.lastTestAt === null ? null : Number(row.lastTestAt),
    lastTestStatus: testStatus(row.lastTestStatus),
    lastTestError: row.lastTestError ?? null,
  };
}

/** Full channel records for admin routes; callers mask `url` for lists. */
export async function listChannelRecords(storage: Storage): Promise<NotificationChannel[]> {
  const [rows, actionRows] = await Promise.all([
    storage.db
      .select()
      .from(schema.notificationChannels)
      .orderBy(asc(schema.notificationChannels.name), asc(schema.notificationChannels.id)),
    storage.db.select().from(schema.notificationChannelActions),
  ]);

  const grouped = actionsByChannel(actionRows);
  const channels: NotificationChannel[] = [];

  for (const row of rows) {
    const channel = channelFromRow(row, grouped.get(row.id) ?? []);

    if (channel) channels.push(channel);
  }

  return channels;
}

export async function getChannelRecord(
  storage: Storage,
  id: string,
): Promise<NotificationChannel | null> {
  const [rows, actionRows] = await Promise.all([
    storage.db
      .select()
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.id, id))
      .limit(1),
    storage.db
      .select()
      .from(schema.notificationChannelActions)
      .where(eq(schema.notificationChannelActions.channelId, id)),
  ]);

  const row = rows[0];

  if (!row) return null;

  return channelFromRow(row, actionsByChannel(actionRows).get(id) ?? []);
}

/** Enabled channels subscribed to one system action. */
export async function channelsForAction(
  storage: Storage,
  action: NotificationAction,
): Promise<DeliveryTarget[]> {
  const rows = await storage.db
    .select({
      id: schema.notificationChannels.id,
      name: schema.notificationChannels.name,
      type: schema.notificationChannels.type,
      url: schema.notificationChannels.url,
      decoration: schema.notificationChannels.decoration,
    })
    .from(schema.notificationChannels)
    .innerJoin(
      schema.notificationChannelActions,
      eq(schema.notificationChannelActions.channelId, schema.notificationChannels.id),
    )
    .where(
      and(
        eq(schema.notificationChannels.enabled, true),
        eq(schema.notificationChannelActions.action, action),
      ),
    )
    .orderBy(asc(schema.notificationChannels.name), asc(schema.notificationChannels.id));

  const targets: DeliveryTarget[] = [];

  for (const row of rows) {
    if (!isChannelType(row.type)) continue;
    const target = readChannelTarget(row.id, row.url);

    targets.push({
      id: row.id,
      name: row.name,
      type: row.type,
      url: target.url,
      decoration: row.decoration,
      locked: target.locked,
    });
  }

  return targets;
}

/**
 * Fingerprints (`type\nurl`) of every managed channel that a legacy inline
 * destination could duplicate, enabled or not. The legacy fallback must never
 * deliver to one of these: an admin who disables or locks a migrated channel
 * would otherwise be overridden by the inline copy the migration kept.
 */
export async function managedLegacyTargets(storage: Storage): Promise<Set<string>> {
  const rows = await storage.db
    .select({
      id: schema.notificationChannels.id,
      type: schema.notificationChannels.type,
      url: schema.notificationChannels.url,
    })
    .from(schema.notificationChannels)
    .where(inArray(schema.notificationChannels.type, [...LEGACY_CHANNEL_TYPES]));

  const targets = new Set<string>();

  for (const row of rows) {
    const target = readChannelTarget(row.id, row.url);

    if (target.url) targets.add(`${row.type}\n${target.url.trim()}`);
  }

  return targets;
}

/**
 * Resolve every monitor's linked channels in one query. Summaries never carry
 * URLs; `delivery` does and stays inside the API.
 */
export async function resolveMonitorChannelData(
  storage: Storage,
  monitorIds: string[],
): Promise<Map<string, MonitorChannelData>> {
  const result = new Map<string, MonitorChannelData>();

  for (const monitorId of monitorIds) {
    result.set(monitorId, { channelIds: [], summaries: [], delivery: [] });
  }

  if (monitorIds.length === 0) return result;

  const rows = await storage.db
    .select({
      monitorId: schema.monitorChannels.monitorId,
      channelId: schema.notificationChannels.id,
      name: schema.notificationChannels.name,
      type: schema.notificationChannels.type,
      url: schema.notificationChannels.url,
      enabled: schema.notificationChannels.enabled,
      decoration: schema.notificationChannels.decoration,
    })
    .from(schema.monitorChannels)
    .innerJoin(
      schema.notificationChannels,
      eq(schema.notificationChannels.id, schema.monitorChannels.channelId),
    )
    .where(inArray(schema.monitorChannels.monitorId, monitorIds))
    .orderBy(asc(schema.notificationChannels.name), asc(schema.notificationChannels.id));

  const channelIds: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.channelId)) continue;
    seen.add(row.channelId);
    channelIds.push(row.channelId);
  }

  const states = await latestDeliveryStates(storage, channelIds);

  for (const row of rows) {
    const entry = result.get(row.monitorId);

    if (!entry || !isChannelType(row.type)) continue;

    entry.channelIds.push(row.channelId);
    entry.summaries.push({
      id: row.channelId,
      name: row.name,
      type: row.type,
      enabled: row.enabled,
      health: healthFromDelivery(states.get(row.channelId)),
    });

    if (row.enabled) {
      const target = readChannelTarget(row.channelId, row.url);

      entry.delivery.push({
        id: row.channelId,
        name: row.name,
        type: row.type,
        url: target.url,
        decoration: row.decoration,
        locked: target.locked,
      });
    }
  }

  return result;
}

export interface DeliveryRecordInput {
  channelId: string;
  scope: string;
  event: string;
  subject: string;
  status: NotificationDeliveryStatus;
  error?: string | null;
}

/** Inserts between write-time prunes, so the 1,000-row cap holds between the daily runs. */
const PRUNE_EVERY_INSERTS = 100;
const insertsSincePrune = new WeakMap<Storage, number>();

export async function recordDelivery(storage: Storage, input: DeliveryRecordInput): Promise<void> {
  await insertDelivery(storage, input);

  const inserts = (insertsSincePrune.get(storage) ?? 0) + 1;

  if (inserts < PRUNE_EVERY_INSERTS) {
    insertsSincePrune.set(storage, inserts);

    return;
  }

  insertsSincePrune.set(storage, 0);
  await pruneDeliveries(storage);
}

async function insertDelivery(storage: Storage, input: DeliveryRecordInput): Promise<void> {
  await storage.db.insert(schema.notificationDeliveries).values({
    id: uuidv7(),
    channelId: input.channelId,
    scope: input.scope,
    event: input.event,
    subject: input.subject,
    status: input.status,
    error: input.error ?? null,
    createdAt: Date.now(),
  });
}

export interface DeliveryPage {
  deliveries: NotificationDelivery[];
  /** Deliveries matching the search, across every page. */
  total: number;
}

/**
 * One page of the delivery log, newest first. `q` matches the channel name,
 * event, status, and subject; delivery errors are not searched.
 */
export async function pageDeliveryRecords(
  storage: Storage,
  page: { limit: number; offset: number; q?: string },
): Promise<DeliveryPage> {
  const where = tableSearchCondition(page.q, [
    schema.notificationChannels.name,
    schema.notificationDeliveries.event,
    schema.notificationDeliveries.status,
    schema.notificationDeliveries.subject,
  ]);

  const [deliveries, totals] = await Promise.all([
    listDeliveryRecords(storage, page.limit, page.offset, where),
    storage.db
      .select({ n: count() })
      .from(schema.notificationDeliveries)
      .leftJoin(
        schema.notificationChannels,
        eq(schema.notificationChannels.id, schema.notificationDeliveries.channelId),
      )
      .where(where),
  ]);

  return { deliveries, total: Number(totals[0]?.n ?? 0) };
}

export async function listDeliveryRecords(
  storage: Storage,
  limit: number,
  offset = 0,
  where?: SQL,
): Promise<NotificationDelivery[]> {
  const rows = await storage.db
    .select({
      id: schema.notificationDeliveries.id,
      channelId: schema.notificationDeliveries.channelId,
      channelName: schema.notificationChannels.name,
      scope: schema.notificationDeliveries.scope,
      event: schema.notificationDeliveries.event,
      subject: schema.notificationDeliveries.subject,
      status: schema.notificationDeliveries.status,
      error: schema.notificationDeliveries.error,
      createdAt: schema.notificationDeliveries.createdAt,
    })
    .from(schema.notificationDeliveries)
    .leftJoin(
      schema.notificationChannels,
      eq(schema.notificationChannels.id, schema.notificationDeliveries.channelId),
    )
    .where(where)
    .orderBy(desc(schema.notificationDeliveries.createdAt), desc(schema.notificationDeliveries.id))
    .limit(limit)
    .offset(Math.max(0, offset));

  return rows.map((row) => ({
    id: row.id,
    channelId: row.channelId,
    channelName: row.channelName ?? null,
    scope: row.scope,
    event: row.event,
    subject: row.subject,
    status: row.status === "sent" ? "sent" : "failed",
    error: row.error ?? null,
    createdAt: Number(row.createdAt),
  }));
}

/**
 * Delivery log retention: 30 days and a hard cap of 1,000 rows. The cap keeps
 * a noisy endpoint from growing the metadata database without bound even when
 * the time window has not elapsed.
 */
export async function pruneDeliveries(storage: Storage): Promise<void> {
  const cutoff = Date.now() - 30 * 86_400_000;

  await storage.db
    .delete(schema.notificationDeliveries)
    .where(lt(schema.notificationDeliveries.createdAt, cutoff));

  const boundaryRows = await storage.db
    .select({
      id: schema.notificationDeliveries.id,
      createdAt: schema.notificationDeliveries.createdAt,
    })
    .from(schema.notificationDeliveries)
    .orderBy(desc(schema.notificationDeliveries.createdAt), desc(schema.notificationDeliveries.id))
    .limit(1)
    .offset(999);

  const boundary = boundaryRows[0];

  if (!boundary) return;

  await storage.db
    .delete(schema.notificationDeliveries)
    .where(
      or(
        lt(schema.notificationDeliveries.createdAt, boundary.createdAt),
        and(
          eq(schema.notificationDeliveries.createdAt, boundary.createdAt),
          lt(schema.notificationDeliveries.id, boundary.id),
        ),
      ),
    );
}
