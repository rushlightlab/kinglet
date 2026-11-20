import { and, eq } from "drizzle-orm";
import { isChannelType, validateWebhookUrl } from "../notify.js";
import type { ChannelType } from "../notify.js";
import { isJsonObject, isString } from "../json.js";
import { uuidv7 } from "../auth/ids.js";
import * as schema from "../storage/schema.js";
import type { Storage } from "../storage/index.js";
import { DEFAULT_NOTIFICATION_ACTIONS } from "./types.js";

/**
 * One-time migration from `monitors.channels` inline JSON to first-class
 * notification channels plus `monitor_channels` links.
 *
 * The app_meta marker makes this genuinely one-time. Without it, a monitor
 * writer could add a legacy inline URL after upgrade and have the next boot
 * promote it into a global channel with system-action subscriptions.
 *
 * Legacy JSON is deliberately left in place for this release so a rollback
 * still has the old data; new monitor writes use `channelIds`.
 */

const LEGACY_MIGRATION_KEY = "notification_legacy_migrated_at";

export interface NotificationMigrationResult {
  monitorsScanned: number;
  channelsCreated: number;
  linksCreated: number;
}

interface LegacyChannel {
  type: ChannelType;
  url: string;
}

type PendingChannel = LegacyChannel;

const TYPE_LABEL: Record<ChannelType, string> = {
  webhook: "Webhook",
  discord: "Discord",
  slack: "Slack",
};

function legacyKey(type: ChannelType, url: string): string {
  return `${type}\n${url}`;
}

function parseLegacyChannels(raw: string): LegacyChannel[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    const channels: LegacyChannel[] = [];

    for (const value of parsed) {
      if (!isJsonObject(value)) continue;

      const type = value.type;
      const rawUrl = value.url;

      if (!isChannelType(type) || !isString(rawUrl)) continue;
      const url = rawUrl.trim();

      if (!url) continue;
      channels.push({ type, url });
    }

    return channels;
  } catch {
    return [];
  }
}

function nextChannelName(
  type: ChannelType,
  usedNames: Set<string>,
  counters: Map<ChannelType, number>,
): string {
  const label = TYPE_LABEL[type];
  let counter = counters.get(type) ?? 0;
  let name = "";

  do {
    counter++;
    name = `${label} ${counter}`;
  } while (usedNames.has(name));

  counters.set(type, counter);
  usedNames.add(name);

  return name;
}

export async function migrateLegacyMonitorChannels(
  storage: Storage,
  allowPrivateWebhooks = false,
): Promise<NotificationMigrationResult> {
  const result = await storage.db.transaction(async (tx) => {
    const alreadyMigrated = await tx
      .select({ value: schema.appMeta.value })
      .from(schema.appMeta)
      .where(eq(schema.appMeta.key, LEGACY_MIGRATION_KEY))
      .limit(1);

    if (alreadyMigrated.length > 0) {
      return { monitorsScanned: 0, channelsCreated: 0, linksCreated: 0 };
    }

    // Only migrate monitors that are actually enabled. A disabled monitor can
    // keep its legacy inline delivery, but it must not create a global channel
    // with system-action subscriptions.
    const monitors = await tx
      .select({ id: schema.monitors.id, channels: schema.monitors.channels })
      .from(schema.monitors)
      .where(eq(schema.monitors.enabled, 1));

    const existing = await tx
      .select({
        id: schema.notificationChannels.id,
        name: schema.notificationChannels.name,
        type: schema.notificationChannels.type,
        url: schema.notificationChannels.url,
      })
      .from(schema.notificationChannels);

    const byKey = new Map<string, string>();
    const usedNames = new Set<string>();

    for (const row of existing) {
      usedNames.add(row.name);

      if (isChannelType(row.type)) byKey.set(legacyKey(row.type, row.url), row.id);
    }

    const monitorLegacy = new Map<string, LegacyChannel[]>();
    const pending = new Map<string, PendingChannel>();

    for (const monitor of monitors) {
      const channels = parseLegacyChannels(monitor.channels);

      if (channels.length === 0) continue;
      monitorLegacy.set(monitor.id, channels);

      for (const channel of channels) {
        const key = legacyKey(channel.type, channel.url);

        if (byKey.has(key) || pending.has(key)) continue;

        const invalid = validateWebhookUrl(channel.url, allowPrivateWebhooks);

        if (invalid) {
          console.warn(
            `[kinglet] notifications: skipping invalid legacy channel on monitor ${monitor.id}: ${invalid}`,
          );
          continue;
        }

        pending.set(key, channel);
      }
    }

    const counters = new Map<ChannelType, number>();
    let channelsCreated = 0;

    for (const [key, channel] of pending) {
      const name = nextChannelName(channel.type, usedNames, counters);
      const now = Date.now();

      const inserted = await tx
        .insert(schema.notificationChannels)
        .values({
          id: uuidv7(),
          name,
          type: channel.type,
          url: channel.url,
          enabled: true,
          decoration: false,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: schema.notificationChannels.id });

      let channelId = inserted[0]?.id;

      if (!channelId) {
        // Another instance won the unique (type, url) race.
        const found = await tx
          .select({ id: schema.notificationChannels.id })
          .from(schema.notificationChannels)
          .where(
            and(
              eq(schema.notificationChannels.type, channel.type),
              eq(schema.notificationChannels.url, channel.url),
            ),
          )
          .limit(1);

        channelId = found[0]?.id;
      }

      if (!channelId) continue;
      byKey.set(key, channelId);

      if (inserted.length === 0) continue;
      channelsCreated++;

      await tx
        .insert(schema.notificationChannelActions)
        .values(
          DEFAULT_NOTIFICATION_ACTIONS.map((action) => ({
            channelId,
            action,
          })),
        )
        .onConflictDoNothing();
    }

    const pairs: Array<{ monitorId: string; channelId: string }> = [];
    const seenPairs = new Set<string>();

    for (const [monitorId, channels] of monitorLegacy) {
      for (const channel of channels) {
        const channelId = byKey.get(legacyKey(channel.type, channel.url));

        if (!channelId) continue;
        const pairKey = `${monitorId}\n${channelId}`;

        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        pairs.push({ monitorId, channelId });
      }
    }

    let linksCreated = 0;

    for (let index = 0; index < pairs.length; index += 200) {
      const chunk = pairs.slice(index, index + 200);

      if (chunk.length === 0) continue;

      const insertedLinks = await tx
        .insert(schema.monitorChannels)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ monitorId: schema.monitorChannels.monitorId });

      linksCreated += insertedLinks.length;
    }

    await tx
      .insert(schema.appMeta)
      .values({ key: LEGACY_MIGRATION_KEY, value: String(Date.now()) })
      .onConflictDoNothing();

    return {
      monitorsScanned: monitors.length,
      channelsCreated,
      linksCreated,
    };
  });

  if (result.channelsCreated > 0 || result.linksCreated > 0) {
    console.log(
      `[kinglet] notifications: migrated ${result.channelsCreated} legacy channel(s) ` +
        `and ${result.linksCreated} monitor link(s)`,
    );
  }

  return result;
}

/**
 * Remove one legacy inline URL from every monitor. Channel delete/rotate uses
 * this so a retired destination cannot keep receiving alerts through the
 * legacy fallback or be recreated by a later migration.
 */
export async function scrubLegacyChannelUrl(
  storage: Storage,
  type: ChannelType,
  url: string,
): Promise<number> {
  const rows = await storage.db
    .select({ id: schema.monitors.id, channels: schema.monitors.channels })
    .from(schema.monitors);

  let updated = 0;

  for (const row of rows) {
    const channels = parseLegacyChannels(row.channels);
    const filtered = channels.filter((channel) => channel.type !== type || channel.url !== url);

    if (filtered.length === channels.length) continue;

    await storage.db
      .update(schema.monitors)
      .set({ channels: JSON.stringify(filtered), updatedAt: Date.now() })
      .where(eq(schema.monitors.id, row.id));

    updated++;
  }

  return updated;
}
