import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordDelivery } from "../../src/notifications/store.ts";
import { configureSecrets } from "../../src/secrets.ts";
import * as schema from "../../src/storage/schema.ts";
import { errorOf, jsonBody } from "../helpers/body.ts";
import { makeTestConfig } from "../helpers/config.ts";
import { request } from "../helpers/request.ts";
import { seedApiKey, seedNotificationChannel, seedUser } from "../helpers/seed.ts";
import type { SeededUser } from "../helpers/seed.ts";
import { createTestSession, signInUser } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

/**
 * Regression tests for limits and lifecycle rules: credentials after a
 * password change, locked channel deletes, key counts, ingest admission, and
 * the delivery log cap.
 */

let session: TestSession | null = null;

function ctx(): TestSession {
  if (session === null) throw new Error("security limits suite: test session missing");

  return session;
}

beforeAll(async () => {
  session = await createTestSession();
});

afterAll(async () => {
  await session?.close();
  session = null;
});

let userCounter = 0;

async function memberOfAlpha(): Promise<SeededUser> {
  const test = ctx();

  const user = await seedUser(test.harness.auth, test.harness.storage, {
    email: `limits-${++userCounter}@example.test`,
    role: "member",
  });

  const added = await request(
    test.harness.app,
    `/v1/projects/${test.data.projects.alpha.id}/members`,
    { method: "POST", body: { userId: user.id }, cookies: test.adminJar },
  );

  expect(added.status).toBe(201);

  return user;
}

async function queryWithKey(plaintext: string): Promise<number> {
  const response = await request(ctx().harness.app, "/v1/events", { bearer: plaintext });

  return response.status;
}

async function changePassword(
  user: SeededUser,
  body: Record<string, string | boolean>,
): Promise<void> {
  const jar = await signInUser(ctx(), user.email, user.password);

  const response = await request(ctx().harness.app, "/api/auth/change-password", {
    method: "POST",
    cookies: jar,
    body: { currentPassword: user.password, newPassword: "ChangedPass456!", ...body },
  });

  expect(response.status).toBe(200);
}

describe("self-service password change", () => {
  it("revokes the keys the user minted when it signs out other sessions", async () => {
    const user = await memberOfAlpha();

    const key = await seedApiKey(ctx().harness.storage, {
      projectId: ctx().data.projects.alpha.id,
      name: "minted-before-change",
      scopes: ["ingest", "query"],
      createdBy: user.id,
    });

    expect(await queryWithKey(key.plaintext)).toBe(200);

    await changePassword(user, { revokeOtherSessions: true });

    expect(await queryWithKey(key.plaintext)).toBe(401);
  });

  it("keeps the keys when the caller opts out", async () => {
    const user = await memberOfAlpha();

    const key = await seedApiKey(ctx().harness.storage, {
      projectId: ctx().data.projects.alpha.id,
      name: "kept-after-change",
      scopes: ["query"],
      createdBy: user.id,
    });

    await changePassword(user, { revokeOtherSessions: true, revokeApiKeys: false });

    expect(await queryWithKey(key.plaintext)).toBe(200);
  });
});

describe("locked notification channels", () => {
  it("refuses to delete a locked legacy-type channel until the key is back", async () => {
    const test = ctx();

    const channel = await seedNotificationChannel(test.harness.storage, {
      name: "locked-delete",
      url: "https://example.test/hooks/locked-delete",
    });

    configureSecrets(Buffer.alloc(32, 7));

    try {
      const refused = await request(test.harness.app, `/v1/notifications/channels/${channel.id}`, {
        method: "DELETE",
        cookies: test.adminJar,
      });

      expect(refused.status).toBe(409);
      expect(errorOf(await jsonBody(refused))).toMatch(/locked/);
    } finally {
      configureSecrets(makeTestConfig().secretKey);
    }

    const deleted = await request(test.harness.app, `/v1/notifications/channels/${channel.id}`, {
      method: "DELETE",
      cookies: test.adminJar,
    });

    expect(deleted.status).toBe(200);
  });
});

describe("key limits", () => {
  it("caps how many keys one person can mint in a project", async () => {
    const test = ctx();
    const user = await memberOfAlpha();
    const jar = await signInUser(test, user.email, user.password);

    const mint = (name: string): Promise<Response> =>
      request(test.harness.app, `/v1/projects/${test.data.projects.alpha.id}/keys`, {
        method: "POST",
        cookies: jar,
        body: { name, scopes: ["query"] },
      });

    for (let index = 0; index < 25; index++) {
      expect((await mint(`limit-${index}`)).status).toBe(201);
    }

    const over = await mint("limit-over");

    expect(over.status).toBe(409);
    expect(errorOf(await jsonBody(over))).toMatch(/key limit reached/);
  });
});

/** A request body that counts how much of it the server pulls. */
function countingBody(chunks: number, stall: boolean) {
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  let pulled = 0;
  let sent = 0;
  let fail: ((reason: Error) => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      fail = (reason) => controller.error(reason);
    },
    pull(controller) {
      if (sent >= chunks) {
        if (!stall) controller.close();

        return;
      }

      sent++;
      pulled += chunk.length;
      controller.enqueue(chunk);
    },
  });

  return {
    stream,
    pulled: () => pulled,
    abort: () => fail?.(new Error("client gone")),
  };
}

function ingest(plaintext: string, body: ReadableStream<Uint8Array>): Promise<Response> {
  return Promise.resolve(
    ctx().harness.app.request("http://localhost:3000/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${plaintext}`, "content-type": "application/x-ndjson" },
      body,
      duplex: "half",
    }),
  );
}

describe("ingest admission", () => {
  it("refuses an over-budget caller before reading its body", async () => {
    const key = await seedApiKey(ctx().harness.storage, {
      projectId: ctx().data.projects.alpha.id,
      name: "ingest-budget",
      scopes: ["ingest"],
    });

    for (let index = 0; index < 600; index++) {
      const accepted = await request(ctx().harness.app, "/v1/events", {
        method: "POST",
        bearer: key.plaintext,
        headers: { "content-type": "application/x-ndjson" },
        body: new Uint8Array(),
      });

      expect(accepted.status).toBe(200);
    }

    const body = countingBody(64, false);
    const refused = await ingest(key.plaintext, body.stream);

    expect(refused.status).toBe(429);
    expect(body.pulled()).toBeLessThanOrEqual(64 * 1024);
  });

  it("limits how many bodies one key has in flight", async () => {
    const key = await seedApiKey(ctx().harness.storage, {
      projectId: ctx().data.projects.alpha.id,
      name: "ingest-in-flight",
      scopes: ["ingest"],
    });

    const held = [0, 1, 2, 3].map(() => countingBody(2, true));
    const pending = held.map((body) => ingest(key.plaintext, body.stream));

    try {
      // Let the four uploads reach the body read and stall there.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const fifth = await ingest(key.plaintext, countingBody(1, false).stream);

      expect(fifth.status).toBe(429);
      expect(errorOf(await jsonBody(fifth))).toMatch(/in flight/);
    } finally {
      for (const body of held) body.abort();
      await Promise.allSettled(pending);
    }

    const after = await request(ctx().harness.app, "/v1/events", {
      method: "POST",
      bearer: key.plaintext,
      body: { message: "after the stalled uploads" },
    });

    expect(after.status).toBe(200);
  });
});

describe("delivery log", () => {
  it("holds the 1,000-row cap as deliveries are written", async () => {
    const test = ctx();
    const channelId = test.data.channel.id;

    for (let index = 0; index < 1_150; index++) {
      await recordDelivery(test.harness.storage, {
        channelId,
        scope: "monitor",
        event: "monitor.fired",
        subject: `delivery ${index}`,
        status: "sent",
      });
    }

    const rows = await test.harness.storage.db
      .select({ n: count() })
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.channelId, channelId));

    // Pruned every 100 writes, so at most one interval above the cap.
    expect(Number(rows[0]?.n ?? 0)).toBeLessThan(1_100);
  });
});
