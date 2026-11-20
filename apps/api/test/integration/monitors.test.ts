import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/ids.ts";
import type { JsonObject } from "../../src/json.ts";
import type { NotificationChannel } from "../../src/notifications/types.ts";
import * as schema from "../../src/storage/schema.ts";
import { arrayAt, errorOf, jsonBody, objectAt, stringAt } from "../helpers/body.ts";
import { request } from "../helpers/request.ts";
import type { CookieJar } from "../helpers/request.ts";
import { seedNotificationChannel } from "../helpers/seed.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

interface MonitorContext {
  session: TestSession;
  channel: NotificationChannel;
}

const CHANNEL_DELIVERY_ERROR = "channel returned HTTP 500";

let context: MonitorContext | null = null;

function ctx(): MonitorContext {
  if (context === null) throw new Error("monitors suite: test context missing");

  return context;
}

function monitorList(body: JsonObject): JsonObject[] {
  return arrayAt(body.monitors, "monitors").map((entry) => objectAt(entry, "monitor"));
}

function channelList(body: JsonObject): JsonObject[] {
  return arrayAt(body.channels, "channels").map((entry) => objectAt(entry, "channel"));
}

function findChannel(channels: JsonObject[], id: string): JsonObject {
  for (const channel of channels) {
    if (channel.id === id) return channel;
  }

  throw new Error(`monitors suite: channel ${id} missing from response`);
}

function findMonitor(monitors: JsonObject[], id: string): JsonObject {
  for (const monitor of monitors) {
    if (monitor.id === id) return monitor;
  }

  throw new Error(`monitors suite: monitor ${id} missing from response`);
}

function hasMonitor(monitors: JsonObject[], id: string): boolean {
  return monitors.some((monitor) => monitor.id === id);
}

function legacyUrls(monitor: JsonObject): string[] {
  return arrayAt(monitor.channels, "channels").map((entry) =>
    stringAt(objectAt(entry, "channel").url, "channel.url"),
  );
}

async function listProjectMonitors(
  session: TestSession,
  projectId: string,
  jar: CookieJar,
): Promise<JsonObject[]> {
  const response = await request(session.harness.app, "/v1/monitors?project=" + projectId, {
    cookies: jar,
  });

  expect(response.status).toBe(200);

  return monitorList(await jsonBody(response));
}

async function deleteMonitor(session: TestSession, id: string, jar: CookieJar, projectId?: string) {
  const path =
    projectId === undefined ? "/v1/monitors/" + id : `/v1/monitors/${id}?project=${projectId}`;

  const response = await request(session.harness.app, path, {
    method: "DELETE",
    cookies: jar,
  });

  expect(response.status).toBe(200);
}

beforeAll(async () => {
  const session = await createTestSession();

  try {
    const channel = await seedNotificationChannel(session.harness.storage, {
      name: "monitor-suite-channel",
      url: "https://example.test/hooks/monitor-suite-secret",
    });

    await session.harness.storage.db.insert(schema.notificationDeliveries).values({
      id: uuidv7(),
      channelId: channel.id,
      scope: "monitor",
      event: "monitor.fired",
      subject: "Alpha errors",
      status: "failed",
      error: CHANNEL_DELIVERY_ERROR,
      createdAt: Date.now(),
    });

    context = { session, channel };
  } catch (err) {
    await session.close();
    throw err;
  }
});

afterAll(async () => {
  await context?.session.close();
  context = null;
});

describe("monitor CRUD", () => {
  it("creates, lists, and deletes a monitor inside the member's project", async () => {
    const { session } = ctx();
    const { harness, data, memberJar } = session;

    const created = await request(harness.app, "/v1/monitors?project=" + data.projects.alpha.id, {
      method: "POST",
      body: { name: "member-created", query: "level>=warn", kind: "count_above", threshold: 3 },
      cookies: memberJar,
    });

    expect(created.status).toBe(201);

    const monitor = objectAt((await jsonBody(created)).monitor, "monitor");
    const id = stringAt(monitor.id, "monitor.id");

    expect(monitor.projectId).toBe(data.projects.alpha.id);
    expect(monitor.name).toBe("member-created");
    expect(monitor.query).toBe("level>=warn");
    expect(monitor.kind).toBe("count_above");
    expect(monitor.threshold).toBe(3);
    expect(monitor.enabled).toBe(true);

    const listed = await listProjectMonitors(session, data.projects.alpha.id, memberJar);
    expect(hasMonitor(listed, id)).toBe(true);

    await deleteMonitor(session, id, memberJar, data.projects.alpha.id);

    const afterDelete = await listProjectMonitors(session, data.projects.alpha.id, memberJar);
    expect(hasMonitor(afterDelete, id)).toBe(false);

    const secondDelete = await request(harness.app, "/v1/monitors/" + id, {
      method: "DELETE",
      cookies: memberJar,
    });

    expect(secondDelete.status).toBe(404);
    expect(errorOf(await jsonBody(secondDelete))).toBe("monitor not found");
  });

  it("enforces the project boundary for monitor reads and writes", async () => {
    const { session } = ctx();
    const { harness, data, adminJar, memberJar } = session;

    const deniedCreate = await request(
      harness.app,
      "/v1/monitors?project=" + data.projects.beta.id,
      {
        method: "POST",
        body: { name: "member-beta", query: "level>=error", kind: "match" },
        cookies: memberJar,
      },
    );

    expect(deniedCreate.status).toBe(404);
    expect(errorOf(await jsonBody(deniedCreate))).toBe("project not found");

    const adminCreated = await request(
      harness.app,
      "/v1/monitors?project=" + data.projects.beta.id,
      {
        method: "POST",
        body: { name: "admin-beta", query: "level>=error", kind: "match" },
        cookies: adminJar,
      },
    );

    expect(adminCreated.status).toBe(201);

    const betaId = stringAt(
      objectAt((await jsonBody(adminCreated)).monitor, "monitor").id,
      "monitor.id",
    );

    try {
      const alphaList = await listProjectMonitors(session, data.projects.alpha.id, memberJar);
      expect(hasMonitor(alphaList, betaId)).toBe(false);

      // No project query means the member's own project; the beta monitor id
      // must still resolve as not found rather than crossing the boundary.
      const crossUpdate = await request(harness.app, "/v1/monitors/" + betaId, {
        method: "PATCH",
        body: { name: "stolen" },
        cookies: memberJar,
      });

      expect(crossUpdate.status).toBe(404);
      expect(errorOf(await jsonBody(crossUpdate))).toBe("monitor not found");

      const crossDelete = await request(harness.app, "/v1/monitors/" + betaId, {
        method: "DELETE",
        cookies: memberJar,
      });

      expect(crossDelete.status).toBe(404);
      expect(errorOf(await jsonBody(crossDelete))).toBe("monitor not found");
    } finally {
      await deleteMonitor(session, betaId, adminJar, data.projects.beta.id);
    }
  });

  it("merges partial PATCH bodies without resetting untouched fields", async () => {
    const { session } = ctx();
    const { harness, data, memberJar } = session;

    const created = await request(harness.app, "/v1/monitors?project=" + data.projects.alpha.id, {
      method: "POST",
      body: {
        name: "patch-source",
        query: "service:api level>=error",
        kind: "match",
        threshold: 7,
        windowMs: 120_000,
      },
      cookies: memberJar,
    });

    expect(created.status).toBe(201);

    const id = stringAt(objectAt((await jsonBody(created)).monitor, "monitor").id, "monitor.id");

    try {
      const paused = await request(harness.app, "/v1/monitors/" + id, {
        method: "PATCH",
        body: { enabled: false },
        cookies: memberJar,
      });

      expect(paused.status).toBe(200);

      const pausedMonitor = objectAt((await jsonBody(paused)).monitor, "monitor");

      expect(pausedMonitor.enabled).toBe(false);
      expect(pausedMonitor.query).toBe("service:api level>=error");
      expect(pausedMonitor.kind).toBe("match");
      expect(pausedMonitor.threshold).toBe(7);
      expect(pausedMonitor.windowMs).toBe(120_000);

      const renamed = await request(harness.app, "/v1/monitors/" + id, {
        method: "PATCH",
        body: { name: "patch-renamed" },
        cookies: memberJar,
      });

      expect(renamed.status).toBe(200);

      const renamedMonitor = objectAt((await jsonBody(renamed)).monitor, "monitor");

      // A name-only PATCH must not accidentally resume a paused monitor.
      expect(renamedMonitor.enabled).toBe(false);
      expect(renamedMonitor.name).toBe("patch-renamed");
      expect(renamedMonitor.query).toBe("service:api level>=error");
      expect(renamedMonitor.kind).toBe("match");
    } finally {
      await deleteMonitor(session, id, memberJar, data.projects.alpha.id);
    }
  });

  it("links channelIds but rejects member-supplied legacy channels", async () => {
    const { session, channel } = ctx();
    const { harness, data, adminJar, memberJar } = session;

    const created = await request(harness.app, "/v1/monitors?project=" + data.projects.alpha.id, {
      method: "POST",
      body: {
        name: "linked-monitor",
        query: "level>=error",
        kind: "count_above",
        channelIds: [channel.id],
      },
      cookies: memberJar,
    });

    expect(created.status).toBe(201);

    const monitor = objectAt((await jsonBody(created)).monitor, "monitor");
    const id = stringAt(monitor.id, "monitor.id");

    try {
      expect(arrayAt(monitor.channelIds, "channelIds")).toEqual([channel.id]);

      const summaries = arrayAt(monitor.resolvedChannels, "resolvedChannels");
      expect(summaries).toHaveLength(1);

      const summary = objectAt(summaries[0], "resolvedChannels[0]");

      expect(summary.id).toBe(channel.id);
      expect(summary.name).toBe(channel.name);
      expect(summary.type).toBe(channel.type);
      expect(summary.enabled).toBe(true);
      expect(summary).not.toHaveProperty("url");
      expect(JSON.stringify(summary)).not.toContain(channel.url);

      const memberHealth = objectAt(summary.health, "health");

      expect(memberHealth.status).toBe("failed");
      expect(memberHealth.error).toBe(null);

      const mcpMonitors = await request(harness.app, "/v1/monitors", {
        bearer: data.keys.mcp.plaintext,
      });

      expect(mcpMonitors.status).toBe(200);

      const mcpSummary = objectAt(
        arrayAt(
          findMonitor(monitorList(await jsonBody(mcpMonitors)), id).resolvedChannels,
          "resolvedChannels",
        )[0],
        "resolvedChannels[0]",
      );

      const mcpHealth = objectAt(mcpSummary.health, "health");

      expect(mcpSummary).not.toHaveProperty("url");
      expect(JSON.stringify(mcpSummary)).not.toContain(channel.url);
      expect(mcpHealth.status).toBe("failed");
      expect(mcpHealth.error).toBe(null);

      const adminList = await listProjectMonitors(session, data.projects.alpha.id, adminJar);

      const adminSummary = objectAt(
        arrayAt(findMonitor(adminList, id).resolvedChannels, "resolvedChannels")[0],
        "resolvedChannels[0]",
      );

      expect(adminSummary).not.toHaveProperty("url");
      expect(JSON.stringify(adminSummary)).not.toContain(channel.url);

      const adminHealth = objectAt(adminSummary.health, "health");

      expect(adminHealth.status).toBe("failed");
      expect(adminHealth.error).toBe(CHANNEL_DELIVERY_ERROR);

      const adminSummaryResponse = await request(
        harness.app,
        "/v1/notifications/channels/summary",
        { cookies: adminJar },
      );

      expect(adminSummaryResponse.status).toBe(200);

      const adminChannelSummary = findChannel(
        channelList(await jsonBody(adminSummaryResponse)),
        channel.id,
      );

      const adminChannelHealth = objectAt(adminChannelSummary.health, "health");

      expect(adminChannelHealth.status).toBe("failed");
      expect(adminChannelHealth.error).toBe(CHANNEL_DELIVERY_ERROR);

      const memberSummaryResponse = await request(
        harness.app,
        "/v1/notifications/channels/summary",
        { cookies: memberJar },
      );

      expect(memberSummaryResponse.status).toBe(200);
      expect(
        objectAt(
          findChannel(channelList(await jsonBody(memberSummaryResponse)), channel.id).health,
          "health",
        ).error,
      ).toBe(null);

      const mcpSummaryResponse = await request(harness.app, "/v1/notifications/channels/summary", {
        bearer: data.keys.mcp.plaintext,
      });

      expect(mcpSummaryResponse.status).toBe(200);
      expect(
        objectAt(
          findChannel(channelList(await jsonBody(mcpSummaryResponse)), channel.id).health,
          "health",
        ).error,
      ).toBe(null);

      const adminChannels = await request(harness.app, "/v1/notifications/channels", {
        cookies: adminJar,
      });

      expect(adminChannels.status).toBe(200);

      const listedChannel = findChannel(channelList(await jsonBody(adminChannels)), channel.id);

      expect(listedChannel.url).not.toBe(channel.url);
      expect(JSON.stringify(listedChannel)).not.toContain(channel.url);

      const memberLegacy = await request(harness.app, "/v1/monitors/" + id, {
        method: "PATCH",
        body: { channels: [{ type: "webhook", url: "https://example.test/hooks/member-legacy" }] },
        cookies: memberJar,
      });

      expect(memberLegacy.status).toBe(403);
      expect(errorOf(await jsonBody(memberLegacy))).toBe(
        "only administrators can configure legacy inline webhook channels",
      );

      const memberLegacyCreate = await request(
        harness.app,
        "/v1/monitors?project=" + data.projects.alpha.id,
        {
          method: "POST",
          body: {
            name: "member-legacy",
            query: "level>=error",
            kind: "match",
            channels: [{ type: "webhook", url: "https://example.test/hooks/member-legacy" }],
          },
          cookies: memberJar,
        },
      );

      expect(memberLegacyCreate.status).toBe(403);
      expect(errorOf(await jsonBody(memberLegacyCreate))).toBe(
        "only administrators can configure legacy inline webhook channels",
      );
    } finally {
      await deleteMonitor(session, id, memberJar, data.projects.alpha.id);
    }
  });

  it("lets an admin supply legacy channels and only reveals them to admins", async () => {
    const { session } = ctx();
    const { harness, data, adminJar, memberJar } = session;
    const legacyUrl = "https://example.test/hooks/admin-legacy-secret";
    const engineError = "https://internal.example.test/secret connect failed";

    const created = await request(harness.app, "/v1/monitors?project=" + data.projects.alpha.id, {
      method: "POST",
      body: {
        name: "admin-legacy",
        query: "level>=error",
        kind: "match",
        channels: [{ type: "webhook", url: legacyUrl }],
      },
      cookies: adminJar,
    });

    expect(created.status).toBe(201);

    const createdMonitor = objectAt((await jsonBody(created)).monitor, "monitor");
    const id = stringAt(createdMonitor.id, "monitor.id");

    expect(legacyUrls(createdMonitor)).toEqual([legacyUrl]);

    try {
      await harness.storage.db
        .update(schema.monitors)
        .set({ lastError: engineError, lastErrorAt: Date.now() })
        .where(eq(schema.monitors.id, id));

      const memberList = await listProjectMonitors(session, data.projects.alpha.id, memberJar);
      const memberMonitor = findMonitor(memberList, id);

      expect(legacyUrls(memberMonitor)).toEqual(["hidden"]);
      expect(memberMonitor.lastError).toBe(null);
      expect(memberMonitor.lastErrorAt).toBe(null);

      const mcpResponse = await request(harness.app, "/v1/monitors", {
        bearer: data.keys.mcp.plaintext,
      });

      expect(mcpResponse.status).toBe(200);

      const mcpMonitor = findMonitor(monitorList(await jsonBody(mcpResponse)), id);

      expect(legacyUrls(mcpMonitor)).toEqual(["hidden"]);
      expect(mcpMonitor.lastError).toBe(null);
      expect(mcpMonitor.lastErrorAt).toBe(null);

      const adminList = await listProjectMonitors(session, data.projects.alpha.id, adminJar);
      const adminMonitor = findMonitor(adminList, id);

      expect(legacyUrls(adminMonitor)).toEqual([legacyUrl]);
      expect(adminMonitor.lastError).toBe(engineError);
      expect(adminMonitor.lastErrorAt).not.toBe(null);
    } finally {
      await deleteMonitor(session, id, adminJar, data.projects.alpha.id);
    }
  });

  it("deletes a monitor's channel links and alert history", async () => {
    const { session, channel } = ctx();
    const { harness, data, memberJar } = session;

    const created = await request(harness.app, "/v1/monitors?project=" + data.projects.alpha.id, {
      method: "POST",
      body: {
        name: "delete-cascade",
        query: "level>=error",
        kind: "count_above",
        channelIds: [channel.id],
      },
      cookies: memberJar,
    });

    expect(created.status).toBe(201);

    const id = stringAt(objectAt((await jsonBody(created)).monitor, "monitor").id, "monitor.id");

    await harness.storage.db.insert(schema.alerts).values({
      id: uuidv7(),
      monitorId: id,
      state: "fired",
      summary: "1 events in 5m (more than 0)",
      firedAt: Date.now(),
    });

    await deleteMonitor(session, id, memberJar, data.projects.alpha.id);

    const alerts = await harness.storage.db
      .select({ id: schema.alerts.id })
      .from(schema.alerts)
      .where(eq(schema.alerts.monitorId, id));

    expect(alerts).toHaveLength(0);

    const links = await harness.storage.db
      .select({ monitorId: schema.monitorChannels.monitorId })
      .from(schema.monitorChannels)
      .where(eq(schema.monitorChannels.monitorId, id));

    expect(links).toHaveLength(0);
  });
});
