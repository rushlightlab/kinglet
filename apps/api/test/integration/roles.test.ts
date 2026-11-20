import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arrayAt, errorOf, jsonBody, objectAt, stringAt } from "../helpers/body.ts";
import { request } from "../helpers/request.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

let session: TestSession | null = null;

function ctx(): TestSession {
  if (session === null) throw new Error("roles suite: test session missing");

  return session;
}

beforeAll(async () => {
  session = await createTestSession();
});

afterAll(async () => {
  await session?.close();
  session = null;
});

describe("role permissions", () => {
  it("lets a viewer read logs and monitors but not write", async () => {
    const { harness, data, viewerJar } = ctx();

    const events = await request(harness.app, "/v1/events", { cookies: viewerJar });
    expect(events.status).toBe(200);

    const monitors = await request(harness.app, "/v1/monitors", { cookies: viewerJar });
    expect(monitors.status).toBe(200);

    const createMonitor = await request(harness.app, "/v1/monitors", {
      method: "POST",
      body: { name: "viewer-monitor", query: "level>=error", kind: "match" },
      cookies: viewerJar,
    });

    expect(createMonitor.status).toBe(403);
    expect(errorOf(await jsonBody(createMonitor))).toBe("forbidden");

    const ingest = await request(harness.app, "/v1/events", {
      method: "POST",
      body: { message: "viewer ingest attempt" },
      cookies: viewerJar,
    });

    expect(ingest.status).toBe(403);
    expect(errorOf(await jsonBody(ingest))).toBe("forbidden");

    const createKey = await request(
      harness.app,
      "/v1/projects/" + data.projects.alpha.id + "/keys",
      {
        method: "POST",
        body: { name: "viewer-key" },
        cookies: viewerJar,
      },
    );

    expect(createKey.status).toBe(403);
  });

  it("lets a member manage monitors inside an assigned project", async () => {
    const { harness, data, memberJar } = ctx();

    const created = await request(harness.app, "/v1/monitors", {
      method: "POST",
      body: { name: "member-monitor", query: "level>=warn", kind: "count_above", threshold: 3 },
      cookies: memberJar,
    });

    expect(created.status).toBe(201);

    const createdBody = await jsonBody(created);
    const monitor = objectAt(createdBody.monitor, "monitor");
    const monitorId = stringAt(monitor.id, "monitor.id");

    expect(monitor.projectId).toBe(data.projects.alpha.id);
    expect(monitor.enabled).toBe(true);

    const updated = await request(harness.app, "/v1/monitors/" + monitorId, {
      method: "PATCH",
      body: { enabled: false },
      cookies: memberJar,
    });

    expect(updated.status).toBe(200);
    expect(objectAt((await jsonBody(updated)).monitor, "monitor").enabled).toBe(false);

    const removed = await request(harness.app, "/v1/monitors/" + monitorId, {
      method: "DELETE",
      cookies: memberJar,
    });

    expect(removed.status).toBe(200);
    expect((await jsonBody(removed)).ok).toBe(true);
  });

  it("lets a member create a key in an assigned project", async () => {
    const { harness, data, memberJar } = ctx();

    const created = await request(harness.app, "/v1/projects/" + data.projects.alpha.id + "/keys", {
      method: "POST",
      body: { name: "member-key", scopes: ["ingest", "query"] },
      cookies: memberJar,
    });

    expect(created.status).toBe(201);

    const body = await jsonBody(created);
    const key = objectAt(body.key, "key");

    expect(key.projectId).toBe(data.projects.alpha.id);
    expect(key.createdBy).toBe(data.member.id);
    expect(stringAt(body.plaintext, "plaintext")).toMatch(/^kl_/);
  });

  it("hides projects the member is not assigned to", async () => {
    const { harness, data, memberJar } = ctx();

    const deniedKey = await request(
      harness.app,
      "/v1/projects/" + data.projects.beta.id + "/keys",
      {
        method: "POST",
        body: { name: "beta-key" },
        cookies: memberJar,
      },
    );

    expect(deniedKey.status).toBe(404);
    expect(errorOf(await jsonBody(deniedKey))).toBe("project not found");
  });

  it("gives admin access to users and system status", async () => {
    const { harness, adminJar } = ctx();

    const users = await request(harness.app, "/v1/users", { cookies: adminJar });
    expect(users.status).toBe(200);

    const userList = arrayAt((await jsonBody(users)).users, "users");
    expect(userList.length).toBeGreaterThanOrEqual(3);

    const status = await request(harness.app, "/v1/system/status", { cookies: adminJar });
    expect(status.status).toBe(200);

    const statusBody = await jsonBody(status);
    expect(statusBody.ok).toBe(true);
    expect(statusBody.name).toBe("kinglet");
    expect(objectAt(statusBody.counts, "counts").users).toBeGreaterThanOrEqual(3);
  });

  it("forbids non-admins from admin-only routes", async () => {
    const { harness, memberJar, viewerJar } = ctx();

    for (const jar of [memberJar, viewerJar]) {
      const users = await request(harness.app, "/v1/users", { cookies: jar });
      expect(users.status).toBe(403);
      expect(errorOf(await jsonBody(users))).toBe("forbidden");

      const status = await request(harness.app, "/v1/system/status", { cookies: jar });
      expect(status.status).toBe(403);
      expect(errorOf(await jsonBody(status))).toBe("forbidden");
    }
  });
});
