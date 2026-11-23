import { eq } from "drizzle-orm";
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
import { pageList, readPageRequest } from "../paging.ts";
import {
  CHANNEL_TYPES,
  isChannelType,
  isLegacyChannelType,
  sendGeneric,
  validateChannelUrl,
} from "../notify.ts";
import type { TargetCheck } from "../notify.ts";
import type { ChannelType } from "../notify.ts";
import { secretsConfigured } from "../secrets.ts";
import * as schema from "../storage/schema.ts";
import type { Storage } from "../storage/index.ts";
import type { NotificationEngine } from "./engine.ts";
import { scrubLegacyChannelUrl } from "./migrate.ts";
import {
  getChannelRecord,
  hasChannelWithTarget,
  healthFromDelivery,
  latestDeliveryStates,
  listChannelRecords,
  pageDeliveryRecords,
  storedTarget,
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

function parseChannelInput(raw: JsonObject, partial: boolean): ChannelParse {
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
      return { ok: false, error: `type must be one of: ${CHANNEL_TYPES.join(", ")}` };
    }

    value.type = raw.type;
  }

  if (!partial || raw.url !== undefined) {
    if (!isString(raw.url)) return { ok: false, error: "url is required" };
    // The target is checked against its type once the type is known (create
    // and update), since an update may change only one of them.
    const url = raw.url.trim();

    if (url.length === 0 || url.length > 2048) {
      return { ok: false, error: "url must be 1-2048 characters" };
    }

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

const SECRET_KEY_REQUIRED =
  "set KINGLET_SECRET_KEY to add or change notification channels: their tokens and URLs are stored encrypted (generate one with: openssl rand -base64 32)";

const LOCKED_LEGACY_CHANNEL =
  "this channel is locked (KINGLET_SECRET_KEY is missing or different from the one that sealed it): restore the original key before deleting or re-pointing it, so its copies on older monitors can be removed too";

function targetCheck(config: Config): TargetCheck {
  return { allowPrivate: config.allowPrivateWebhooks, smtpConfigured: config.smtp !== null };
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
  // What the channel form can offer: email needs a server-side SMTP config.
  app.get("/v1/notifications/capabilities", (c) => {
    const denied = requirePermission(c, "notifications.read");

    if (denied) return denied;

    return c.json({
      email: { configured: config.smtp !== null, from: config.smtp?.from ?? null },
      // Adding or changing a channel needs KINGLET_SECRET_KEY.
      secrets: { configured: secretsConfigured() },
    });
  });

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

    // Search runs on the masked projection, so it can't probe a webhook secret.
    const page = pageList(
      (await listChannelRecords(storage)).map((channel) => channelDto(channel, false)),
      readPageRequest((name) => c.req.query(name)),
      (channel) => [
        channel.name,
        channel.type,
        channel.enabled ? "enabled" : "disabled",
        channel.url,
        ...channel.actions,
      ],
    );

    return c.json({ channels: page.items, total: page.total });
  });

  app.post("/v1/notifications/channels", async (c) => {
    const denied = requirePermission(c, "notifications.write");

    if (denied) return denied;

    const body = await readJsonBody(c);

    if (!body.ok) return c.json({ error: body.error }, 400);

    const parsed = parseChannelInput(body.body, false);

    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const { name, type, url } = parsed.value;

    if (name === undefined || type === undefined || url === undefined) {
      return c.json({ error: "name, type, and url are required" }, 400);
    }

    const targetError = validateChannelUrl(type, url, targetCheck(config));

    if (targetError) return c.json({ error: targetError }, 400);

    // Channel targets are secrets and are only ever stored encrypted.
    if (!secretsConfigured()) return c.json({ error: SECRET_KEY_REQUIRED }, 400);

    if (await hasChannelWithTarget(storage, type, url, null)) {
      return c.json({ error: "a channel with this type and URL already exists" }, 409);
    }

    const actions = parsed.value.actions ?? [...DEFAULT_NOTIFICATION_ACTIONS];
    const enabled = parsed.value.enabled ?? true;
    const decoration = parsed.value.decoration ?? false;
    const now = Date.now();

    try {
      const id = uuidv7();
      const stored = storedTarget(id, type, url);

      const created = await storage.db.transaction(async (tx) => {
        const rows = await tx
          .insert(schema.notificationChannels)
          .values({
            id,
            name,
            type,
            url: stored.url,
            targetHash: stored.targetHash,
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

    const parsed = parseChannelInput(body.body, true);

    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const name = parsed.value.name ?? existing.name;
    const type = parsed.value.type ?? existing.type;
    const url = parsed.value.url ?? existing.url;
    const enabled = parsed.value.enabled ?? existing.enabled;
    const decoration = parsed.value.decoration ?? existing.decoration;

    const destinationChanged = existing.type !== type || existing.url !== url;

    if (destinationChanged) {
      const targetError = validateChannelUrl(type, url, targetCheck(config));

      if (targetError) return c.json({ error: targetError }, 400);

      // A new target is a new secret: it can only be stored encrypted. Renames,
      // subscriptions, and on/off changes still work without the key.
      if (!secretsConfigured()) return c.json({ error: SECRET_KEY_REQUIRED }, 400);

      if (await hasChannelWithTarget(storage, type, url, channelId)) {
        return c.json({ error: "a channel with this type and URL already exists" }, 409);
      }
    }

    if (destinationChanged) {
      if (existing.locked !== null && isLegacyChannelType(existing.type)) {
        return c.json({ error: LOCKED_LEGACY_CHANNEL }, 409);
      }

      // Retire the old legacy copy before the new destination is live. The
      // one-time migration marker prevents recreation, and removing the copy
      // stops the legacy fallback from delivering to the old URL.
      // Only the original three types ever had legacy inline copies.
      if (isLegacyChannelType(existing.type)) {
        await scrubLegacyChannelUrl(storage, existing.type, existing.url);
      }
    }

    const now = Date.now();

    // The stored target is only rewritten when it changes, so an unchanged
    // secret is never written back as plaintext.
    const changes: Partial<typeof schema.notificationChannels.$inferInsert> = {
      name,
      enabled,
      decoration,
      updatedAt: now,
    };

    if (destinationChanged) {
      const stored = storedTarget(channelId, type, url);

      changes.type = type;
      changes.url = stored.url;
      changes.targetHash = stored.targetHash;
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
    // to a destination the admin just deleted. A locked channel's URL, and its
    // monitors' legacy copies, cannot be read, so nothing could be scrubbed:
    // refuse rather than leave the old URL live behind the delete.
    if (isLegacyChannelType(channel.type)) {
      if (channel.locked !== null) return c.json({ error: LOCKED_LEGACY_CHANNEL }, 409);

      await scrubLegacyChannelUrl(storage, channel.type, channel.url);
    }

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
        {
          type: channel.type,
          url: channel.url,
          decoration: channel.decoration,
          locked: channel.locked,
        },
        {
          action: "test",
          subject: "Test notification",
          summary: `Test notification from Kinglet — ${channel.name} works.`,
          at: Date.now(),
        },
        { allowPrivate: config.allowPrivateWebhooks, smtp: config.smtp },
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

    const rawOffset = Number(c.req.query("offset") ?? 0);

    const offset = Number.isFinite(rawOffset)
      ? Math.min(1_000_000, Math.max(0, Math.trunc(rawOffset)))
      : 0;

    return c.json(await pageDeliveryRecords(storage, { limit, offset, q: c.req.query("q") }));
  });
}
