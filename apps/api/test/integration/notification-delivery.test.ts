import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.ts";
import { arrayAt, errorOf, jsonBody, numberAt, objectAt, stringAt } from "../helpers/body.ts";
import { createTestHarness } from "../helpers/harness.ts";
import type { TestHarness } from "../helpers/harness.ts";
import { reserveClosedLoopbackPort } from "../helpers/loopback.ts";
import { request, signIn } from "../helpers/request.ts";
import type { CookieJar } from "../helpers/request.ts";
import { seedProject } from "../helpers/seed.ts";
import type { SeededProject } from "../helpers/seed.ts";

/**
 * Loopback-only delivery checks. The target port was reserved and released, so
 * the connection is refused immediately: no request leaves the machine and no
 * real webhook is used.
 */

interface DeliveryContext {
  harness: TestHarness;
  adminJar: CookieJar;
  project: SeededProject;
  closedPort: number;
}

let context: DeliveryContext | null = null;

function ctx(): DeliveryContext {
  if (context === null) throw new Error("notification delivery suite: test context missing");

  return context;
}

beforeAll(async () => {
  const harness = await createTestHarness({
    config: { allowPrivateWebhooks: true, mcpAllowMonitorWrites: true },
  });

  try {
    const project = await seedProject(harness.storage, { name: "Loopback", slug: "loopback" });
    const closedPort = await reserveClosedLoopbackPort();
    const admin = await signIn(harness.app, harness.admin.email, harness.admin.password);

    if (!admin.response.ok) {
      throw new Error(
        `notification delivery suite: admin sign-in failed (${admin.response.status})`,
      );
    }

    context = { harness, adminJar: admin.jar, project, closedPort };
  } catch (err) {
    await harness.close();
    throw err;
  }
});

afterAll(async () => {
  await context?.harness.close();
  context = null;
});

async function createChannel(url: string): Promise<string> {
  const { harness, adminJar } = ctx();

  const response = await request(harness.app, "/v1/notifications/channels", {
    method: "POST",
    body: { name: "loopback-channel", type: "webhook", url },
    cookies: adminJar,
  });

  expect(response.status).toBe(201);

  return stringAt(objectAt((await jsonBody(response)).channel, "channel").id, "channel.id");
}

function expectRecentTestFailure(body: JsonObject): void {
  const retryAfterMs = numberAt(body.retryAfterMs, "retryAfterMs");

  expect(retryAfterMs).toBeGreaterThan(0);
  expect(retryAfterMs).toBeLessThanOrEqual(60_000);
  expect(errorOf(body)).toBe("channel was tested recently");
}

describe("notification test cooldowns", () => {
  it("records the first channel test failure and rejects an immediate retry", async () => {
    const { harness, adminJar, closedPort } = ctx();
    const channelId = await createChannel(`http://127.0.0.1:${closedPort}/channel-hook`);

    try {
      const first = await request(
        harness.app,
        "/v1/notifications/channels/" + channelId + "/test",
        { method: "POST", cookies: adminJar },
      );

      expect(first.status).toBe(502);

      const firstError = errorOf(await jsonBody(first));

      expect(firstError.length).toBeGreaterThan(0);
      expect(firstError).not.toContain("127.0.0.1");

      const detail = await request(harness.app, "/v1/notifications/channels/" + channelId, {
        cookies: adminJar,
      });

      expect(detail.status).toBe(200);

      const channel = objectAt((await jsonBody(detail)).channel, "channel");

      expect(channel.lastTestStatus).toBe("failed");
      expect(numberAt(channel.lastTestAt, "lastTestAt")).toBeGreaterThan(0);
      expect(stringAt(channel.lastTestError, "lastTestError")).not.toContain("127.0.0.1");

      const second = await request(
        harness.app,
        "/v1/notifications/channels/" + channelId + "/test",
        { method: "POST", cookies: adminJar },
      );

      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).not.toBe(null);
      expectRecentTestFailure(await jsonBody(second));
    } finally {
      await request(harness.app, "/v1/notifications/channels/" + channelId, {
        method: "DELETE",
        cookies: adminJar,
      });
    }
  });

  it("records the first monitor test failure and rejects an immediate retry", async () => {
    const { harness, project, adminJar, closedPort } = ctx();

    const created = await request(harness.app, "/v1/monitors?project=" + project.id, {
      method: "POST",
      body: {
        name: "loopback-monitor",
        query: "level>=error",
        kind: "match",
        channels: [{ type: "webhook", url: `http://127.0.0.1:${closedPort}/monitor-hook` }],
      },
      cookies: adminJar,
    });

    expect(created.status).toBe(201);

    const monitorId = stringAt(
      objectAt((await jsonBody(created)).monitor, "monitor").id,
      "monitor.id",
    );

    try {
      const first = await request(
        harness.app,
        `/v1/monitors/${monitorId}/test?project=${project.id}`,
        {
          method: "POST",
          cookies: adminJar,
        },
      );

      expect(first.status).toBe(200);

      const results = arrayAt((await jsonBody(first)).results, "results");
      expect(results).toHaveLength(1);

      const result = objectAt(results[0], "results[0]");

      expect(result.type).toBe("webhook");
      expect(result.ok).toBe(false);
      expect(stringAt(result.error, "results[0].error")).not.toContain("127.0.0.1");

      const second = await request(
        harness.app,
        `/v1/monitors/${monitorId}/test?project=${project.id}`,
        {
          method: "POST",
          cookies: adminJar,
        },
      );

      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).not.toBe(null);

      const body = await jsonBody(second);

      expect(numberAt(body.retryAfterMs, "retryAfterMs")).toBeGreaterThan(0);
      expect(errorOf(body)).toBe("monitor was tested recently");
    } finally {
      await request(harness.app, `/v1/monitors/${monitorId}?project=${project.id}`, {
        method: "DELETE",
        cookies: adminJar,
      });
    }
  });
});
