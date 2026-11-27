import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arrayAt, errorOf, jsonBody, objectAt } from "../helpers/body.ts";
import { request, signIn } from "../helpers/request.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

let session: TestSession | null = null;

function ctx(): TestSession {
  if (session === null) throw new Error("authentication suite: test session missing");

  return session;
}

beforeAll(async () => {
  session = await createTestSession();
});

afterAll(async () => {
  await session?.close();
  session = null;
});

describe("authentication", () => {
  it("rejects unauthenticated requests to protected API routes", async () => {
    const harness = ctx().harness;

    const me = await request(harness.app, "/v1/me");
    expect(me.status).toBe(401);
    expect(errorOf(await jsonBody(me))).toBe("unauthorized");

    const events = await request(harness.app, "/v1/events");
    expect(events.status).toBe(401);

    const ingest = await request(harness.app, "/v1/events", {
      method: "POST",
      body: { message: "anonymous write" },
      csrf: true,
    });

    expect(ingest.status).toBe(401);

    const badKey = await request(harness.app, "/v1/me", { bearer: "kl_not-a-real-key" });
    expect(badKey.status).toBe(401);
  });

  it("signs in through Better Auth and exposes the session identity", async () => {
    const harness = ctx().harness;

    const signedIn = await signIn(harness.app, harness.admin.email, harness.admin.password);

    expect(signedIn.response.status).toBe(200);
    expect(signedIn.jar.size).toBeGreaterThan(0);

    const me = await request(harness.app, "/v1/me", { cookies: signedIn.jar });
    expect(me.status).toBe(200);

    const body = await jsonBody(me);
    const user = objectAt(body.user, "user");

    expect(user.email).toBe(harness.admin.email);
    expect(user.role).toBe("admin");
    expect(arrayAt(body.permissions, "permissions")).toContain("users.write");
  });

  it("rejects a wrong password without issuing a session cookie", async () => {
    const harness = ctx().harness;

    const rejected = await signIn(harness.app, harness.admin.email, "WrongPass123!");

    expect(rejected.response.status).toBe(401);
    expect(rejected.jar.size).toBe(0);

    const me = await request(harness.app, "/v1/me", { cookies: rejected.jar });
    expect(me.status).toBe(401);
  });

  it("rejects an API key on user-only endpoints", async () => {
    const { harness, data } = ctx();

    const me = await request(harness.app, "/v1/me", { bearer: data.keys.alpha.plaintext });
    expect(me.status).toBe(403);
    expect(errorOf(await jsonBody(me))).toBe("user session required");

    const users = await request(harness.app, "/v1/users", { bearer: data.keys.alpha.plaintext });
    expect(users.status).toBe(403);
  });

  it("treats a cookie session as authenticated for reads", async () => {
    const { harness, data, viewerJar } = ctx();

    const response = await request(harness.app, "/v1/events?project=" + data.projects.alpha.id, {
      cookies: viewerJar,
    });

    expect(response.status).toBe(200);
    expect(arrayAt((await jsonBody(response)).events, "events")).toEqual([]);
  });
});

describe("Better Auth routes", () => {
  it("serves only the auth endpoints Kinglet uses", async () => {
    const { harness, adminJar } = ctx();

    const current = await request(harness.app, "/api/auth/get-session", { cookies: adminJar });

    expect(current.status).toBe(200);

    // Better Auth serves these, but Kinglet does not use them, so they are not
    // forwarded: unused endpoints stay closed even to an administrator.
    for (const path of ["/api/auth/ok", "/api/auth/admin/get-user?id=" + harness.admin.id]) {
      const response = await request(harness.app, path, { cookies: adminJar });

      expect(response.status, path).toBe(404);
    }

    // Unknown and percent-encoded paths never reach Better Auth either, so
    // they cannot add per-path rate-limit buckets.
    for (const path of [
      "/api/auth/unknown-" + "x".repeat(64),
      "/api/auth/sign-in/%65mail",
      "/api/auth/sign-in/email/",
    ]) {
      const response = await request(harness.app, path, { method: "POST", body: {} });

      expect(response.status, path).toBe(404);
    }
  });
});
