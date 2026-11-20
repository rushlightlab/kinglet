import { and, asc, desc, eq, inArray, lt, or } from "drizzle-orm";
import { uuidv7 } from "../auth/ids.js";
import { isChannelType } from "../notify.js";
import type { ChannelType } from "../notify.js";
import * as schema from "../storage/schema.js";
import type { Storage } from "../storage/index.js";
import { isNotificationAction } from "./types.js";
import type {
  MonitorChannelSummary,
  NotificationAction,
  NotificationChannel,
  NotificationChannelHealth,
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationTestStatus,
} from "./types.js";

/**
 * Database access shared by the notification routes, engine, migration, and
 * monitor reads. Every URL-bearing type stays internal to the API; callers
 * project to safe DTOs before returning anything over HTTP.
 */

export interface DeliveryTarget {
  id: string;
  name: string;
  type: ChannelType;
  url: string;
  decoration: boolean;
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

  return {
    id: row.id,
    name: row.name,
    type,
    url: row.url,
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
  const rows = await storage.db
    .select()
    .from(schema.notificationChannels)
    .where(eq(schema.notificationChannels.id, id))
    .limit(1);

  const row = rows[0];

  if (!row) return null;

  const actionRows = await storage.db
    .select()
    .from(schema.notificationChannelActions)
    .where(eq(schema.notificationChannelActions.channelId, id));

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
    targets.push({
      id: row.id,
      name: row.name,
      type: row.type,
      url: row.url,
      decoration: row.decoration,
    });
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
      entry.delivery.push({
        id: row.channelId,
        name: row.name,
        type: row.type,
        url: row.url,
        decoration: row.decoration,
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

export async function recordDelivery(storage: Storage, input: DeliveryRecordInput): Promise<void> {
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

export async function listDeliveryRecords(
  storage: Storage,
  limit: number,
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
    .orderBy(desc(schema.notificationDeliveries.createdAt), desc(schema.notificationDeliveries.id))
    .limit(limit);

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
