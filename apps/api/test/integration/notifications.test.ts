import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.js";
import * as schema from "../../src/storage/schema.js";
import { arrayAt, errorOf, jsonBody, objectAt, stringAt } from "../helpers/body.js";
import { request } from "../helpers/request.js";
import { createTestSession } from "../helpers/session.js";
import type { TestSession } from "../helpers/session.js";

const EXPECTED_DEFAULT_ACTIONS = [
  "backup.failed",
  "backup.restore_staged",
  "archive.failed",
  "system.warning",
];

let session: TestSession | null = null;

function ctx(): TestSession {
  if (session === null) throw new Error("notifications suite: test session missing");

  return session;
}

function channelList(body: JsonObject): JsonObject[] {
  return arrayAt(body.channels, "channels").map((entry) => objectAt(entry, "channel"));
}

function findChannel(channels: JsonObject[], id: string): JsonObject {
  for (const channel of channels) {
    if (channel.id === id) return channel;
  }

  throw new Error(`notifications suite: channel ${id} missing from response`);
}

function findMonitor(monitors: JsonObject[], id: string): JsonObject {
  for (const monitor of monitors) {
    if (monitor.id === id) return monitor;
  }

  throw new Error(`notifications suite: monitor ${id} missing from response`);
}

async function adminMonitors(projectId: string): Promise<JsonObject[]> {
  const { harness, adminJar } = ctx();

  const response = await request(harness.app, "/v1/monitors?project=" + projectId, {
    cookies: adminJar,
  });

  expect(response.status).toBe(200);

  return arrayAt((await jsonBody(response)).monitors, "monitors").map((entry) =>
    objectAt(entry, "monitor"),
  );
}

beforeAll(async () => {
  session = await createTestSession();
});

afterAll(async () => {
  await session?.close();
  session = null;
});

describe("notification channels", () => {
  it("masks list responses, reveals the URL on detail/edit, and is admin-only", async () => {
    const { harness, adminJar, memberJar } = ctx();
    const url = "https://example.test/hooks/notification-secret-abcd";
    const masked = "https://example.test/…abcd";
    let channelId = "";

    try {
      const created = await request(harness.app, "/v1/notifications/channels", {
        method: "POST",
        body: { name: "ops-webhook", type: "webhook", url },
        cookies: adminJar,
      });

      expect(created.status).toBe(201);

      const channel = objectAt((await jsonBody(created)).channel, "channel");

      channelId = stringAt(channel.id, "channel.id");

      // Admin create/detail/edit responses are the only places the URL appears.
      expect(channel.url).toBe(url);

      const createdActions = new Set(
        arrayAt(channel.actions, "actions").map((action) => stringAt(action, "action")),
      );

      expect(createdActions).toEqual(new Set(EXPECTED_DEFAULT_ACTIONS));
      expect(createdActions.has("backup.succeeded")).toBe(false);

      const listed = await request(harness.app, "/v1/notifications/channels", {
        cookies: adminJar,
      });

      expect(listed.status).toBe(200);

      const listChannel = findChannel(channelList(await jsonBody(listed)), channelId);

      expect(listChannel.url).toBe(masked);
      expect(listChannel.url).not.toBe(url);
      expect(JSON.stringify(listChannel)).not.toContain(url);

      const detail = await request(harness.app, "/v1/notifications/channels/" + channelId, {
        cookies: adminJar,
      });

      expect(detail.status).toBe(200);
      expect(objectAt((await jsonBody(detail)).channel, "channel").url).toBe(url);

      const edited = await request(harness.app, "/v1/notifications/channels/" + channelId, {
        method: "PATCH",
        body: { name: "ops-webhook-renamed" },
        cookies: adminJar,
      });

      expect(edited.status).toBe(200);

      const editedChannel = objectAt((await jsonBody(edited)).channel, "channel");

      expect(editedChannel.name).toBe("ops-webhook-renamed");
      expect(editedChannel.url).toBe(url);

      for (const response of [
        await request(harness.app, "/v1/notifications/channels", { cookies: memberJar }),
        await request(harness.app, "/v1/notifications/channels/" + channelId, {
          cookies: memberJar,
        }),
        await request(harness.app, "/v1/notifications/channels/" + channelId, {
          method: "PATCH",
          body: { name: "member-edit" },
          cookies: memberJar,
        }),
        await request(harness.app, "/v1/notifications/channels/" + channelId, {
          method: "DELETE",
          cookies: memberJar,
        }),
      ]) {
        expect(response.status).toBe(403);
        expect(errorOf(await jsonBody(response))).toBe("forbidden");
      }
    } finally {
      if (channelId !== "") {
        const removed = await request(harness.app, "/v1/notifications/channels/" + channelId, {
          method: "DELETE",
          cookies: adminJar,
        });

        expect(removed.status).toBe(200);
      }
    }
  });

  it("rejects invalid and private destinations before storing them", async () => {
    const { harness, data, adminJar } = ctx();

    const rejected: Array<{ body: JsonObject; status: number; messagePart: string }> = [
      {
        body: { name: "bad-protocol", type: "webhook", url: "ftp://example.test/hook" },
        status: 400,
        messagePart: "http:// or https://",
      },
      {
        body: {
          name: "credentials",
          type: "webhook",
          url: "https://user:pass@example.test/hook",
        },
        status: 400,
        messagePart: "credentials",
      },
      {
        body: { name: "private", type: "webhook", url: "http://127.0.0.1:9/hook" },
        status: 400,
        messagePart: "private/metadata",
      },
    ];

    for (const testCase of rejected) {
      const response = await request(harness.app, "/v1/notifications/channels", {
        method: "POST",
        body: testCase.body,
        cookies: adminJar,
      });

      expect(response.status).toBe(testCase.status);
      expect(errorOf(await jsonBody(response))).toContain(testCase.messagePart);
    }

    const privateMonitor = await request(
      harness.app,
      "/v1/monitors?project=" + data.projects.alpha.id,
      {
        method: "POST",
        body: {
          name: "private-legacy",
          query: "level>=error",
          kind: "match",
          channels: [{ type: "webhook", url: "http://127.0.0.1:9/hook" }],
        },
        cookies: adminJar,
      },
    );

    expect(privateMonitor.status).toBe(400);
    expect(errorOf(await jsonBody(privateMonitor))).toContain("private/metadata");

    let channelId = "";
    let monitorId = "";

    try {
      const createdChannel = await request(harness.app, "/v1/notifications/channels", {
        method: "POST",
        body: {
          name: "patch-validation",
          type: "webhook",
          url: "https://example.test/hooks/patch-validation",
        },
        cookies: adminJar,
      });

      expect(createdChannel.status).toBe(201);

      channelId = stringAt(
        objectAt((await jsonBody(createdChannel)).channel, "channel").id,
        "channel.id",
      );

      for (const testCase of [
        { url: "ftp://example.test/hook", messagePart: "http:// or https://" },
        { url: "http://127.0.0.1:9/hook", messagePart: "private/metadata" },
      ]) {
        const response = await request(harness.app, "/v1/notifications/channels/" + channelId, {
          method: "PATCH",
          body: { url: testCase.url },
          cookies: adminJar,
        });

        expect(response.status).toBe(400);
        expect(errorOf(await jsonBody(response))).toContain(testCase.messagePart);
      }

      const createdMonitor = await request(
        harness.app,
        "/v1/monitors?project=" + data.projects.alpha.id,
        {
          method: "POST",
          body: {
            name: "patch-legacy-validation",
            query: "level>=error",
            kind: "match",
            channels: [{ type: "webhook", url: "https://example.test/hooks/patch-legacy" }],
          },
          cookies: adminJar,
        },
      );

      expect(createdMonitor.status).toBe(201);

      monitorId = stringAt(
        objectAt((await jsonBody(createdMonitor)).monitor, "monitor").id,
        "monitor.id",
      );

      for (const testCase of [
        { url: "ftp://example.test/hook", messagePart: "http:// or https://" },
        { url: "http://127.0.0.1:9/hook", messagePart: "private/metadata" },
      ]) {
        const response = await request(
          harness.app,
          `/v1/monitors/${monitorId}?project=${data.projects.alpha.id}`,
          {
            method: "PATCH",
            body: { channels: [{ type: "webhook", url: testCase.url }] },
            cookies: adminJar,
          },
        );

        expect(response.status).toBe(400);
        expect(errorOf(await jsonBody(response))).toContain(testCase.messagePart);
      }
    } finally {
      if (monitorId !== "") {
        const removedMonitor = await request(
          harness.app,
          `/v1/monitors/${monitorId}?project=${data.projects.alpha.id}`,
          {
            method: "DELETE",
            cookies: adminJar,
          },
        );

        expect(removedMonitor.status).toBe(200);
      }

      if (channelId !== "") {
        const removedChannel = await request(
          harness.app,
          "/v1/notifications/channels/" + channelId,
          {
            method: "DELETE",
            cookies: adminJar,
          },
        );

        expect(removedChannel.status).toBe(200);
      }
    }
  });

  it("scrubs legacy URLs and removes links/actions when a channel is deleted", async () => {
    const { harness, data, adminJar } = ctx();
    const url = "https://example.test/hooks/notification-delete-secret";
    let channelId = "";
    let legacyMonitorId = "";
    let linkedMonitorId = "";

    try {
      const created = await request(harness.app, "/v1/notifications/channels", {
        method: "POST",
        body: {
          name: "delete-me",
          type: "webhook",
          url,
          actions: ["system.warning"],
        },
        cookies: adminJar,
      });

      expect(created.status).toBe(201);

      const channel = objectAt((await jsonBody(created)).channel, "channel");

      channelId = stringAt(channel.id, "channel.id");
      expect(arrayAt(channel.actions, "actions")).toEqual(["system.warning"]);

      const legacyCreated = await request(
        harness.app,
        "/v1/monitors?project=" + data.projects.alpha.id,
        {
          method: "POST",
          body: {
            name: "legacy-copy",
            query: "level>=error",
            kind: "match",
            channels: [{ type: "webhook", url }],
          },
          cookies: adminJar,
        },
      );

      expect(legacyCreated.status).toBe(201);

      legacyMonitorId = stringAt(
        objectAt((await jsonBody(legacyCreated)).monitor, "monitor").id,
        "monitor.id",
      );

      const linkedCreated = await request(
        harness.app,
        "/v1/monitors?project=" + data.projects.alpha.id,
        {
          method: "POST",
          body: {
            name: "linked-copy",
            query: "level>=error",
            kind: "count_above",
            channelIds: [channelId],
          },
          cookies: adminJar,
        },
      );

      expect(linkedCreated.status).toBe(201);

      linkedMonitorId = stringAt(
        objectAt((await jsonBody(linkedCreated)).monitor, "monitor").id,
        "monitor.id",
      );

      const removed = await request(harness.app, "/v1/notifications/channels/" + channelId, {
        method: "DELETE",
        cookies: adminJar,
      });

      expect(removed.status).toBe(200);
      expect((await jsonBody(removed)).ok).toBe(true);

      const monitors = await adminMonitors(data.projects.alpha.id);
      const legacyMonitor = findMonitor(monitors, legacyMonitorId);
      const linkedMonitor = findMonitor(monitors, linkedMonitorId);

      expect(arrayAt(legacyMonitor.channels, "channels")).toHaveLength(0);
      expect(arrayAt(linkedMonitor.channelIds, "channelIds")).toHaveLength(0);
      expect(arrayAt(linkedMonitor.resolvedChannels, "resolvedChannels")).toHaveLength(0);

      const channelRows = await harness.storage.db
        .select({ id: schema.notificationChannels.id })
        .from(schema.notificationChannels)
        .where(eq(schema.notificationChannels.id, channelId));

      expect(channelRows).toHaveLength(0);

      const actionRows = await harness.storage.db
        .select({ channelId: schema.notificationChannelActions.channelId })
        .from(schema.notificationChannelActions)
        .where(eq(schema.notificationChannelActions.channelId, channelId));

      expect(actionRows).toHaveLength(0);

      const linkRows = await harness.storage.db
        .select({ channelId: schema.monitorChannels.channelId })
        .from(schema.monitorChannels)
        .where(eq(schema.monitorChannels.channelId, channelId));

      expect(linkRows).toHaveLength(0);
    } finally {
      for (const monitorId of [legacyMonitorId, linkedMonitorId]) {
        if (monitorId === "") continue;

        const response = await request(
          harness.app,
          `/v1/monitors/${monitorId}?project=${data.projects.alpha.id}`,
          {
            method: "DELETE",
            cookies: adminJar,
          },
        );

        expect(response.status).toBe(200);
      }

      if (channelId !== "") {
        await request(harness.app, "/v1/notifications/channels/" + channelId, {
          method: "DELETE",
          cookies: adminJar,
        });
      }
    }
  });
});
