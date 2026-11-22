import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/ids.ts";
import { sealStoredSecrets } from "../../src/notifications/store.ts";
import { configureSecrets, isSealed } from "../../src/secrets.ts";
import * as schema from "../../src/storage/schema.ts";
import { errorOf, jsonBody, objectAt, stringAt } from "../helpers/body.ts";
import { makeTestConfig } from "../helpers/config.ts";
import { request } from "../helpers/request.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

// Fake token: shaped to pass the Telegram format check, never a real bot.
const TELEGRAM =
  "https://api.telegram.org/bot123456:FAKE_fake_FAKE_fake_token_00/sendMessage?chat_id=42";

let session: TestSession | null = null;

function ctx(): TestSession {
  if (session === null) throw new Error("channel secrets suite: session missing");

  return session;
}

async function rawChannel(id: string) {
  const rows = await ctx()
    .harness.storage.db.select()
    .from(schema.notificationChannels)
    .where(eq(schema.notificationChannels.id, id));

  return rows[0];
}

async function channelDetail(id: string) {
  const response = await request(ctx().harness.app, `/v1/notifications/channels/${id}`, {
    cookies: ctx().adminJar,
  });

  return objectAt((await jsonBody(response)).channel, "channel");
}

beforeAll(async () => {
  session = await createTestSession();
});

afterAll(async () => {
  await session?.close();
  session = null;
});

describe("channel secrets at rest", () => {
  it("stores a new channel's token encrypted and shows it only in the admin detail", async () => {
    const created = await request(ctx().harness.app, "/v1/notifications/channels", {
      cookies: ctx().adminJar,
      body: { name: "ops telegram", type: "telegram", url: TELEGRAM, actions: [] },
    });

    expect(created.status).toBe(201);
    const id = stringAt(objectAt((await jsonBody(created)).channel, "channel").id, "id");
    const row = await rawChannel(id);

    expect(row && isSealed(row.url)).toBe(true);
    expect(row?.url).not.toContain("FAKE");
    expect(row?.targetHash).toMatch(/^[0-9a-f]{64}$/);

    const detail = await channelDetail(id);

    expect(detail.url).toBe(TELEGRAM);
    expect(detail.encrypted).toBe(true);
    expect(detail.locked).toBeNull();
  });

  it("still refuses a second channel with the same target", async () => {
    const duplicate = await request(ctx().harness.app, "/v1/notifications/channels", {
      cookies: ctx().adminJar,
      body: { name: "copy", type: "telegram", url: TELEGRAM, actions: [] },
    });

    expect(duplicate.status).toBe(409);
  });

  it("encrypts plaintext left from before the key, channels and monitor destinations", async () => {
    const { storage } = ctx().harness;
    const channelId = uuidv7();
    const monitorId = uuidv7();
    const now = Date.now();
    const plainUrl = "https://example.test/hooks/plaintext-before-key";

    await storage.db.insert(schema.notificationChannels).values({
      id: channelId,
      name: "old plaintext",
      type: "webhook",
      url: plainUrl,
      enabled: true,
      decoration: false,
      createdAt: now,
      updatedAt: now,
    });
    await storage.db.insert(schema.monitors).values({
      id: monitorId,
      projectId: ctx().data.projects.alpha.id,
      name: "old inline",
      query: "",
      channels: JSON.stringify([{ type: "webhook", url: plainUrl }]),
      createdAt: now,
      updatedAt: now,
    });

    const sealed = await sealStoredSecrets(storage);

    expect(sealed.channels).toBeGreaterThanOrEqual(1);
    expect(sealed.monitors).toBeGreaterThanOrEqual(1);

    const row = await rawChannel(channelId);

    const monitor = await storage.db
      .select({ channels: schema.monitors.channels })
      .from(schema.monitors)
      .where(eq(schema.monitors.id, monitorId));

    expect(row && isSealed(row.url)).toBe(true);
    expect(isSealed(monitor[0]?.channels ?? "")).toBe(true);
    expect((await channelDetail(channelId)).url).toBe(plainUrl);

    // Running again changes nothing.
    expect(await sealStoredSecrets(storage)).toEqual({ channels: 0, monitors: 0 });
  });

  it("locks channels sealed with a different key instead of sending", async () => {
    const created = await request(ctx().harness.app, "/v1/notifications/channels", {
      cookies: ctx().adminJar,
      body: {
        name: "locked webhook",
        type: "webhook",
        url: "https://example.test/hooks/sealed-with-old-key",
        actions: [],
      },
    });

    const id = stringAt(objectAt((await jsonBody(created)).channel, "channel").id, "id");

    // Same process, another key: as if KINGLET_SECRET_KEY had been changed.
    configureSecrets(Buffer.alloc(32, 3));

    try {
      const detail = await channelDetail(id);

      expect(detail.url).toBe("");
      expect(detail.locked).toMatch(/different KINGLET_SECRET_KEY/);

      const test = await request(ctx().harness.app, `/v1/notifications/channels/${id}/test`, {
        cookies: ctx().adminJar,
        method: "POST",
      });

      expect(test.status).toBe(502);
      expect(errorOf(await jsonBody(test))).toMatch(/locked/);
    } finally {
      configureSecrets(makeTestConfig().secretKey);
    }
  });
});
