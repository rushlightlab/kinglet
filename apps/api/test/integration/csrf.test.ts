import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorOf, jsonBody, objectAt } from "../helpers/body.ts";
import { request } from "../helpers/request.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

const FOREIGN_ORIGIN = "https://evil.example";

let session: TestSession | null = null;

function ctx(): TestSession {
  if (session === null) throw new Error("CSRF suite: test session missing");

  return session;
}

beforeAll(async () => {
  session = await createTestSession();
});

afterAll(async () => {
  await session?.close();
  session = null;
});

describe("CSRF guard for cookie mutations", () => {
  it("rejects a cookie mutation without X-Kinglet-Request", async () => {
    const { harness, adminJar } = ctx();

    const response = await request(harness.app, "/v1/projects", {
      method: "POST",
      body: { name: "no-marker" },
      cookies: adminJar,
      csrf: false,
    });

    expect(response.status).toBe(403);
    expect(errorOf(await jsonBody(response))).toContain("X-Kinglet-Request");
  });

  it("does not exempt an empty Bearer token that falls back to the cookie", async () => {
    const { harness, adminJar } = ctx();

    const response = await request(harness.app, "/v1/projects", {
      method: "POST",
      body: { name: "empty-bearer" },
      cookies: adminJar,
      // Header values are trimmed of ASCII spaces, but a no-break space
      // survives and is then removed by the token's String.prototype.trim().
      headers: { authorization: "Bearer \u00a0" },
      csrf: false,
    });

    expect(response.status).toBe(403);
    expect(errorOf(await jsonBody(response))).toContain("X-Kinglet-Request");
  });

  it("rejects a cookie mutation from a foreign Origin even with the marker", async () => {
    const { harness, adminJar } = ctx();

    const response = await request(harness.app, "/v1/projects", {
      method: "POST",
      body: { name: "cross-origin" },
      cookies: adminJar,
      headers: { origin: FOREIGN_ORIGIN },
    });

    expect(response.status).toBe(403);
    expect(errorOf(await jsonBody(response))).toBe("cross-origin request rejected");
  });

  it("rejects a cookie DELETE without the marker", async () => {
    const { harness, data, adminJar } = ctx();

    const response = await request(harness.app, "/v1/events?project=" + data.projects.alpha.id, {
      method: "DELETE",
      cookies: adminJar,
      csrf: false,
    });

    expect(response.status).toBe(403);
    expect(errorOf(await jsonBody(response))).toContain("X-Kinglet-Request");
  });

  it("accepts a same-origin cookie mutation with the marker", async () => {
    const { harness, adminJar } = ctx();

    const response = await request(harness.app, "/v1/projects", {
      method: "POST",
      body: { name: "csrf-ok" },
      cookies: adminJar,
      headers: { origin: "http://localhost:3000" },
    });

    expect(response.status).toBe(201);
    expect(objectAt((await jsonBody(response)).project, "project").name).toBe("csrf-ok");
  });

  it("accepts the documented local dev origin with the marker", async () => {
    const { harness, adminJar } = ctx();

    const response = await request(harness.app, "/v1/projects", {
      method: "POST",
      body: { name: "dev-origin" },
      cookies: adminJar,
      headers: { origin: "http://localhost:5173" },
    });

    expect(response.status).toBe(201);
  });

  it("exempts Bearer mutations from the marker and the origin check", async () => {
    const { harness, data } = ctx();

    const response = await request(harness.app, "/v1/events", {
      method: "POST",
      body: { message: "bearer csrf exemption" },
      bearer: data.keys.alpha.plaintext,
      csrf: false,
      headers: { origin: FOREIGN_ORIGIN },
    });

    expect(response.status).toBe(200);
    expect((await jsonBody(response)).accepted).toBe(1);
  });

  it("keeps GET requests exempt from the marker and origin check", async () => {
    const { harness, data, viewerJar } = ctx();

    const response = await request(harness.app, "/v1/events?project=" + data.projects.alpha.id, {
      cookies: viewerJar,
      headers: { origin: FOREIGN_ORIGIN },
    });

    expect(response.status).toBe(200);
  });
});
