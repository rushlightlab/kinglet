import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/ids.ts";
import * as schema from "../../src/storage/schema.ts";
import { errorOf, jsonBody, objectAt } from "../helpers/body.ts";
import { request } from "../helpers/request.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

/**
 * Without KINGLET_SECRET_KEY nothing new is stored as a secret: adding a
 * channel or changing where one sends is refused, while existing channels
 * keep working so an upgrade doesn't silently stop alerts.
 */

let session: TestSession | null = null;
let plaintextId = "";

function ctx(): TestSession {
  if (session === null) throw new Error("no-key suite: session missing");

  return session;
}

beforeAll(async () => {
  session = await createTestSession({ config: { secretKey: null } });
  plaintextId = uuidv7();
  const now = Date.now();

  // A channel from before encryption existed.
  await session.harness.storage.db.insert(schema.notificationChannels).values({
    id: plaintextId,
    name: "old webhook",
    type: "webhook",
    url: "https://example.test/hooks/no-key-plaintext",
    enabled: true,
    decoration: false,
    createdAt: now,
    updatedAt: now,
  });
});

afterAll(async () => {
  await session?.close();
  session = null;
});

describe("without KINGLET_SECRET_KEY", () => {
  it("tells the UI that channels can't be added", async () => {
    const response = await request(ctx().harness.app, "/v1/notifications/capabilities", {
      cookies: ctx().adminJar,
    });

    expect(objectAt((await jsonBody(response)).secrets, "secrets").configured).toBe(false);
  });

  it("refuses new channels", async () => {
    const response = await request(ctx().harness.app, "/v1/notifications/channels", {
      cookies: ctx().adminJar,
      body: { name: "new", type: "webhook", url: "https://example.test/hooks/new", actions: [] },
    });

    expect(response.status).toBe(400);
    expect(errorOf(await jsonBody(response))).toMatch(/KINGLET_SECRET_KEY/);
  });

  it("lets an existing channel be renamed, but not pointed somewhere new", async () => {
    const path = `/v1/notifications/channels/${plaintextId}`;

    const rename = await request(ctx().harness.app, path, {
      cookies: ctx().adminJar,
      method: "PATCH",
      body: { name: "renamed webhook" },
    });

    expect(rename.status).toBe(200);
    expect(objectAt((await jsonBody(rename)).channel, "channel").encrypted).toBe(false);

    const retarget = await request(ctx().harness.app, path, {
      cookies: ctx().adminJar,
      method: "PATCH",
      body: { url: "https://example.test/hooks/elsewhere" },
    });

    expect(retarget.status).toBe(400);
    expect(errorOf(await jsonBody(retarget))).toMatch(/KINGLET_SECRET_KEY/);
  });

  it("refuses inline webhook destinations on monitors", async () => {
    const response = await request(
      ctx().harness.app,
      `/v1/monitors?project=${ctx().data.projects.alpha.id}`,
      {
        cookies: ctx().adminJar,
        body: {
          name: "inline",
          query: "level>=error",
          kind: "match",
          channels: [{ type: "webhook", url: "https://example.test/hooks/inline" }],
        },
      },
    );

    expect(response.status).toBe(400);
    expect(errorOf(await jsonBody(response))).toMatch(/KINGLET_SECRET_KEY/);
  });
});
