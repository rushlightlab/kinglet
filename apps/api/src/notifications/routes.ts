import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { isUuid, uuidv7 } from "../auth/ids.ts";
import { canCapability } from "../auth/key-capabilities.ts";
import { getAuth, requirePermission } from "../auth/middleware.ts";
import type { AppEnv } from "../auth/middleware.ts";
import type { Config } from "../env.ts";
import { isBoolean, isJsonObject, isString } from "../json.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { isChannelType, sendGeneric, validateWebhookUrl } from "../notify.ts";
import type { ChannelType } from "../notify.ts";
import * as schema from "../storage/schema.ts";
import type { Storage } from "../storage/index.ts";
import type { NotificationEngine } from "./engine.ts";
import { scrubLegacyChannelUrl } from "./migrate.ts";
import {
  getChannelRecord,
  healthFromDelivery,
  latestDeliveryStates,
  listChannelRecords,
  listDeliveryRecords,
} from "./store.ts";
import {
  DEFAULT_NOTIFICATION_ACTIONS,
  NOTIFICATION_ACTIONS,
  isNotificationAction,
  maskChannelUrl,
  safeErrorMessage,
} from "./types.ts";
import type {
  NotificationAction,
  NotificationChannel,
  NotificationChannelSummary,
} from "./types.ts";

/**
 * Notification channel administration and delivery history.
 *
 * All routes are user-session only (`notifications.*` is admin-only today).
 * URLs are bearer secrets: lists mask them, only the admin detail/edit
 * responses reveal the full value, and no response or log ever includes an
 * endpoint error verbatim when it may name an internal host.
 */

interface ChannelInput {
  name?: string;
  type?: ChannelType;
  url?: string;
  enabled?: boolean;
  decoration?: boolean;
  actions?: NotificationAction[];
}

type ChannelParse = { ok: true; value: ChannelInput } | { ok: false; error: string };

async function readJsonBody(
  c: Context<AppEnv>,
): Promise<{ ok: true; body: JsonObject } | { ok: false; error: string }> {
  try {
    const body: unknown = await c.req.json();

    if (!isJsonObject(body)) return { ok: false, error: "invalid JSON body" };

    return { ok: true, body };
  } catch {
    return { ok: false, error: "invalid JSON body" };
  }
}

function parseActions(
  value: JsonValue,
): { ok: true; actions: NotificationAction[] } | { ok: false } {
  if (!Array.isArray(value)) return { ok: false };

  const seen = new Set<NotificationAction>();
  const actions: NotificationAction[] = [];

  for (const entry of value) {
    if (!isNotificationAction(entry)) return { ok: false };

    if (seen.has(entry)) continue;
    seen.add(entry);
    actions.push(entry);
  }

  return { ok: true, actions };
}

function parseChannelInput(raw: JsonObject, partial: boolean, config: Config): ChannelParse {
  const value: ChannelInput = {};

  if (!partial || raw.name !== undefined) {
    if (!isString(raw.name)) return { ok: false, error: "name is required" };
    const name = raw.name.trim();

    if (name.length < 1 || name.length > 64) {
      return { ok: false, error: "name must be 1-64 characters" };
    }

    value.name = name;
  }

  if (!partial || raw.type !== undefined) {
    if (!isChannelType(raw.type)) {
      return { ok: false, error: "type must be webhook, discord, or slack" };
    }

    value.type = raw.type;
  }

  if (!partial || raw.url !== undefined) {
    if (!isString(raw.url)) return { ok: false, error: "url is required" };
    const url = raw.url.trim();
    const urlError = validateWebhookUrl(url, config.allowPrivateWebhooks);

    if (urlError) return { ok: false, error: urlError };
    value.url = url;
  }

  if (raw.enabled !== undefined) {
    if (!isBoolean(raw.enabled)) return { ok: false, error: "enabled must be a boolean" };
    value.enabled = raw.enabled;
  }

  if (raw.decoration !== undefined) {
    if (!isBoolean(raw.decoration)) {
      return { ok: false, error: "decoration must be a boolean" };
    }

    value.decoration = raw.decoration;
  }

  if (raw.actions !== undefined) {
    const parsed = parseActions(raw.actions);

    if (!parsed.ok) {
      return { ok: false, error: `actions must contain only: ${NOTIFICATION_ACTIONS.join(", ")}` };
    }

    value.actions = parsed.actions;
  }

  return { ok: true, value };
}

function channelDto(channel: NotificationChannel, revealUrl: boolean): NotificationChannel {
  return {
    ...channel,
    url: revealUrl ? channel.url : maskChannelUrl(channel.url),
    // Test errors can echo internal hosts; only the admin edit view sees them.
    lastTestError: revealUrl ? channel.lastTestError : null,
  };
}

function isUniqueViolation(message: string): boolean {
  return /unique/i.test(message);
}

async function hasDuplicateChannel(
  storage: Storage,
  type: ChannelType,
  url: string,
  excludeId: string | null,
): Promise<boolean> {
  const rows = await storage.db
    .select({ id: schema.notificationChannels.id })
    .from(schema.notificationChannels)
    .where(
      and(eq(schema.notificationChannels.type, type), eq(schema.notificationChannels.url, url)),
    )
    .limit(2);

  return rows.some((row) => row.id !== excludeId);
}

/** One test per channel per minute, enforced in memory and by last_test_at. */
const testLocks = new Map<string, number>();

const TEST_COOLDOWN_MS = 60_000;

export function registerNotificationRoutes(
  app: Hono<AppEnv>,
  deps: {
    storage: Storage;
    config: Config;
    engine: NotificationEngine;
    /** Re-read monitor channel links after a channel mutation. */
    refreshMonitors?: () => Promise<void>;
  },
): void {
  const { storage, config, refreshMonitors } = deps;

  // Delivery reads and pruning live in the engine; route state is read live.
  void deps.engine;

  app.use(
    "/v1/notifications/*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: "payload too large (max 256 KiB)" }, 413),
    }),
  );

  // Static route before `/channels/:id`. MCP keys with monitors.read may use it.
  app.get("/v1/notifications/channels/summary", async (c) => {
    if (!canCapability(getAuth(c), "monitors.read")) {
      return c.json({ error: "forbidden" }, 403);
    }

    const authInfo = getAuth(c);
    const canSeeErrors = authInfo.kind === "user" && authInfo.user.role === "admin";
    const channels = await listChannelRecords(storage);
    const states = await latestDeliveryStates(storage);
    const summaries: NotificationChannelSummary[] = [];

    for (const channel of channels) {
      const health = healthFromDelivery(states.get(channel.id));

      summaries.push({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        enabled: channel.enabled,
        health: canSeeErrors ? health : { ...health, error: null },
      });
    }

    return c.json({ channels: summaries });
  });

  app.get("/v1/notifications/channels", async (c) => {
    const denied = requirePermission(c, "notifications.read");

    if (denied) return denied;

    const channels = await listChannelRecords(storage);

    return c.json({ channels: channels.map((channel) => channelDto(channel, false)) });
  });

  app.post("/v1/notifications/channels", async (c) => {
    const denied = requirePermission(c, "notifications.write");

    if (denied) return denied;

    const body = await readJsonBody(c);

    if (!body.ok) return c.json({ error: body.error }, 400);

    const parsed = parseChannelInput(body.body, false, config);

    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const { name, type, url } = parsed.value;

    if (name === undefined || type === undefined || url === undefined) {
      return c.json({ error: "name, type, and url are required" }, 400);
    }

    if (await hasDuplicateChannel(storage, type, url, null)) {
      return c.json({ error: "a channel with this type and URL already exists" }, 409);
    }

    const actions = parsed.value.actions ?? [...DEFAULT_NOTIFICATION_ACTIONS];
    const enabled = parsed.value.enabled ?? true;
    const decoration = parsed.value.decoration ?? false;
    const now = Date.now();

    try {
      const created = await storage.db.transaction(async (tx) => {
        const rows = await tx
          .insert(schema.notificationChannels)
          .values({
            id: uuidv7(),
            name,
            type,
            url,
            enabled,
            decoration,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: schema.notificationChannels.id });

        const channelId = rows[0]?.id;

        if (!channelId) return null;

        if (actions.length > 0) {
          await tx
            .insert(schema.notificationChannelActions)
            .values(actions.map((action) => ({ channelId, action })));
        }

        return channelId;
      });

      if (!created) return c.json({ error: "could not create channel" }, 500);

      const channel = await getChannelRecord(storage, created);

      if (!channel) return c.json({ error: "could not create channel" }, 500);

      await refreshMonitors?.();

      return c.json({ channel: channelDto(channel, true) }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (isUniqueViolation(message)) {
        return c.json({ error: "a channel with this type and URL already exists" }, 409);
      }

      // The driver error can include bound parameters (the URL); keep it out
      // of logs and return a generic failure.
      console.warn(
        "[kinglet] could not create notification channel:",
        safeErrorMessage(message, 300),
      );

      return c.json({ error: "could not create channel" }, 500);
    }
  });

  app.get("/v1/notifications/channels/:id", async (c) => {
    const denied = requirePermission(c, "notifications.read");

    if (denied) return denied;

    const id = c.req.param("id");

    if (!isUuid(id)) return c.json({ error: "invalid channel id" }, 400);

    const channel = await getChannelRecord(storage, id.toLowerCase());

    if (!channel) return c.json({ error: "channel not found" }, 404);

    return c.json({ channel: channelDto(channel, true) });
  });

  app.patch("/v1/notifications/channels/:id", async (c) => {
    const denied = requirePermission(c, "notifications.write");

    if (denied) return denied;

    const id = c.req.param("id");

    if (!isUuid(id)) return c.json({ error: "invalid channel id" }, 400);
    const channelId = id.toLowerCase();
    const existing = await getChannelRecord(storage, channelId);

    if (!existing) return c.json({ error: "channel not found" }, 404);

    const body = await readJsonBody(c);

    if (!body.ok) return c.json({ error: body.error }, 400);

    const parsed = parseChannelInput(body.body, true, config);

    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const name = parsed.value.name ?? existing.name;
    const type = parsed.value.type ?? existing.type;
    const url = parsed.value.url ?? existing.url;
    const enabled = parsed.value.enabled ?? existing.enabled;
    const decoration = parsed.value.decoration ?? existing.decoration;

    if (await hasDuplicateChannel(storage, type, url, channelId)) {
      return c.json({ error: "a channel with this type and URL already exists" }, 409);
    }

    const destinationChanged = existing.type !== type || existing.url !== url;

    if (destinationChanged) {
      // Retire the old legacy copy before the new destination is live. The
      // one-time migration marker prevents recreation, and removing the copy
      // stops the legacy fallback from delivering to the old URL.
      await scrubLegacyChannelUrl(storage, existing.type, existing.url);
    }

    const now = Date.now();

    const changes: Partial<typeof schema.notificationChannels.$inferInsert> = {
      name,
      type,
      url,
      enabled,
      decoration,
      updatedAt: now,
    };

    if (destinationChanged) {
      changes.lastTestAt = null;
      changes.lastTestStatus = null;
      changes.lastTestError = null;
    }

    try {
      await storage.db.transaction(async (tx) => {
        await tx
          .update(schema.notificationChannels)
          .set(changes)
          .where(eq(schema.notificationChannels.id, channelId));

        if (parsed.value.actions !== undefined) {
          await tx
            .delete(schema.notificationChannelActions)
            .where(eq(schema.notificationChannelActions.channelId, channelId));

          if (parsed.value.actions.length > 0) {
            await tx
              .insert(schema.notificationChannelActions)
              .values(parsed.value.actions.map((action) => ({ channelId, action })));
          }
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (isUniqueViolation(message)) {
        return c.json({ error: "a channel with this type and URL already exists" }, 409);
      }

      console.warn(
        "[kinglet] could not update notification channel:",
        safeErrorMessage(message, 300),
      );

      return c.json({ error: "could not update channel" }, 500);
    }

    const channel = await getChannelRecord(storage, channelId);

    if (!channel) return c.json({ error: "channel not found" }, 404);

    await refreshMonitors?.();

    return c.json({ channel: channelDto(channel, true) });
  });

  app.delete("/v1/notifications/channels/:id", async (c) => {
    const denied = requirePermission(c, "notifications.write");

    if (denied) return denied;

    const id = c.req.param("id");

    if (!isUuid(id)) return c.json({ error: "invalid channel id" }, 400);
    const channelId = id.toLowerCase();

    const channel = await getChannelRecord(storage, channelId);

    if (!channel) return c.json({ error: "channel not found" }, 404);

    // Remove the legacy inline copy first so the fallback cannot keep posting
    // to a destination the admin just deleted.
    await scrubLegacyChannelUrl(storage, channel.type, channel.url);

    // Delivery rows are kept for audit; they contain no URLs. Links and
    // action subscriptions have no other owner and are removed with the
    // channel.
    await storage.db.transaction(async (tx) => {
      await tx
        .delete(schema.notificationChannelActions)
        .where(eq(schema.notificationChannelActions.channelId, channelId));
      await tx
        .delete(schema.monitorChannels)
        .where(eq(schema.monitorChannels.channelId, channelId));
      await tx
        .delete(schema.notificationChannels)
        .where(eq(schema.notificationChannels.id, channelId));
    });

    await refreshMonitors?.();

    return c.json({ ok: true });
  });

  app.post("/v1/notifications/channels/:id/test", async (c) => {
    const denied = requirePermission(c, "notifications.write");

    if (denied) return denied;

    const id = c.req.param("id");

    if (!isUuid(id)) return c.json({ error: "invalid channel id" }, 400);
    const channelId = id.toLowerCase();
    const channel = await getChannelRecord(storage, channelId);

    if (!channel) return c.json({ error: "channel not found" }, 404);

    const now = Date.now();
    const lockedAt = testLocks.get(channelId);
    const lastTestAt = channel.lastTestAt ?? 0;
    const lastAttempt = Math.max(lockedAt ?? 0, lastTestAt);

    if (lastAttempt > 0 && now - lastAttempt < TEST_COOLDOWN_MS) {
      const retryAfterMs = TEST_COOLDOWN_MS - (now - lastAttempt);

      c.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));

      return c.json({ error: "channel was tested recently", retryAfterMs }, 429);
    }

    testLocks.set(channelId, now);

    let testError: string | null = null;

    try {
      await sendGeneric(
        { type: channel.type, url: channel.url, decoration: channel.decoration },
        {
          action: "test",
          subject: "Test notification",
          summary: `Test notification from Kinglet — ${channel.name} works.`,
          at: Date.now(),
        },
        { allowPrivate: config.allowPrivateWebhooks },
      );
    } catch (err) {
      testError = safeErrorMessage(err instanceof Error ? err : String(err), 500);
    }

    const testedAt = Date.now();

    await storage.db
      .update(schema.notificationChannels)
      .set({
        lastTestAt: testedAt,
        lastTestStatus: testError ? "failed" : "ok",
        lastTestError: testError,
      })
      .where(eq(schema.notificationChannels.id, channelId));

    if (testError) {
      console.warn(`[kinglet] notification channel test failed (${channel.type}):`, testError);

      const authInfo = getAuth(c);
      const detailed = authInfo.kind !== "user" || authInfo.user.role === "admin";

      return c.json({ error: detailed ? testError : "channel test failed" }, 502);
    }

    return c.json({ ok: true });
  });

  app.get("/v1/notifications/deliveries", async (c) => {
    const denied = requirePermission(c, "notifications.read");

    if (denied) return denied;

    const rawLimit = c.req.query("limit");
    const parsedLimit = rawLimit === undefined ? 100 : Number(rawLimit);

    const limit = Number.isFinite(parsedLimit)
      ? Math.min(100, Math.max(1, Math.trunc(parsedLimit)))
      : 100;

    return c.json({ deliveries: await listDeliveryRecords(storage, limit) });
  });
}
