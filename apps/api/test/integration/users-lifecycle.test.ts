import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../../src/json.js";
import * as schema from "../../src/storage/schema.js";
import { arrayAt, errorOf, jsonBody, numberAt, objectAt, stringAt } from "../helpers/body.js";
import { createTestHarness } from "../helpers/harness.js";
import type { TestHarness } from "../helpers/harness.js";
import { request, signIn } from "../helpers/request.js";
import type { CookieJar, TestRequestOptions } from "../helpers/request.js";
import { seedApiKey, seedProject, seedUser } from "../helpers/seed.js";
import { createTestSession, signInUser } from "../helpers/session.js";
import type { TestSession } from "../helpers/session.js";

/**
 * Last-admin and offboarding invariants through the real routes and Better
 * Auth. Each test seeds its own target user so the baseline administrator and
 * fixture credentials stay untouched.
 */

let session: TestSession | null = null;

function ctx(): TestSession {
  if (session === null) throw new Error("users lifecycle suite: test session missing");

  return session;
}

beforeAll(async () => {
  session = await createTestSession();
});

afterAll(async () => {
  await session?.close();
  session = null;
});

async function adminRequest(path: string, options: TestRequestOptions = {}): Promise<Response> {
  return request(ctx().harness.app, path, { ...options, cookies: ctx().adminJar });
}

async function addToProject(userId: string, projectId: string): Promise<void> {
  const added = await adminRequest("/v1/projects/" + projectId + "/members", {
    method: "POST",
    body: { userId },
  });

  if (added.status !== 201) {
    throw new Error(
      `users lifecycle suite: could not add ${userId} to project ${projectId} (status ${added.status})`,
    );
  }
}

async function listUsers(): Promise<JsonObject> {
  const response = await adminRequest("/v1/users");

  expect(response.status).toBe(200);

  return jsonBody(response);
}

function userFromList(body: JsonObject, id: string): JsonObject | null {
  for (const entry of arrayAt(body.users, "users")) {
    const user = objectAt(entry, "user");

    if (user.id === id) return user;
  }

  return null;
}

async function findUserWith(
  harness: TestHarness,
  jar: CookieJar,
  id: string,
): Promise<JsonObject | null> {
  const response = await request(harness.app, "/v1/users", { cookies: jar });

  expect(response.status).toBe(200);

  return userFromList(await jsonBody(response), id);
}

async function findUser(id: string): Promise<JsonObject | null> {
  const body = await listUsers();

  return userFromList(body, id);
}

async function requireUserRow(id: string): Promise<JsonObject> {
  const user = await findUser(id);

  if (user === null) throw new Error(`users lifecycle suite: user ${id} is missing`);

  return user;
}

/**
 * A fresh harness for last-admin cases, so each test starts with exactly one
 * active administrator instead of depending on test declaration order.
 */
async function withFreshAdmin(
  run: (harness: TestHarness, jar: CookieJar) => Promise<void>,
): Promise<void> {
  const harness = await createTestHarness();

  try {
    const signedIn = await signIn(harness.app, harness.admin.email, harness.admin.password);

    if (!signedIn.response.ok) {
      throw new Error(
        `users lifecycle suite: fresh admin sign-in failed (${signedIn.response.status})`,
      );
    }

    await run(harness, signedIn.jar);
  } finally {
    await harness.close();
  }
}

async function eventCountWithKey(plaintext: string): Promise<number> {
  const response = await request(ctx().harness.app, "/v1/events", { bearer: plaintext });

  expect(response.status).toBe(200);

  return arrayAt((await jsonBody(response)).events, "events").length;
}

async function apiKeyRows(harness: TestHarness, id: string): Promise<number> {
  const rows = await harness.storage.db
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.id, id));

  return rows.length;
}

async function sessionRows(harness: TestHarness, userId: string): Promise<number> {
  const rows = await harness.storage.db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.userId, userId));

  return rows.length;
}

/**
 * A mutation bypasses Better Auth's signed cookie cache in the production
 * auth middleware, so it observes a deleted/disabled session immediately.
 */
async function expectSessionRejected(jar: CookieJar): Promise<void> {
  const response = await request(ctx().harness.app, "/v1/events", {
    method: "POST",
    body: { message: "offboarded session must not write" },
    cookies: jar,
  });

  expect(response.status).toBe(401);
  expect(errorOf(await jsonBody(response))).toBe("unauthorized");
}

describe("last administrator", () => {
  it("refuses to demote the only active administrator", async () => {
    await withFreshAdmin(async (harness, jar) => {
      const response = await request(harness.app, "/v1/users/" + harness.admin.id, {
        method: "PATCH",
        body: { role: "viewer" },
        cookies: jar,
      });

      expect(response.status).toBe(400);
      expect(errorOf(await jsonBody(response))).toBe("cannot demote the last administrator");

      const row = await findUserWith(harness, jar, harness.admin.id);

      expect(row?.role).toBe("admin");
    });
  });

  it("demotes an administrator when another active administrator remains", async () => {
    await withFreshAdmin(async (harness, jar) => {
      const second = await seedUser(harness.auth, harness.storage, {
        email: "second-admin@example.test",
        role: "admin",
      });

      const response = await request(harness.app, "/v1/users/" + second.id, {
        method: "PATCH",
        body: { role: "member" },
        cookies: jar,
      });

      expect(response.status).toBe(200);
      expect(objectAt((await jsonBody(response)).user, "user").role).toBe("member");

      const row = await findUserWith(harness, jar, second.id);

      expect(row?.role).toBe("member");
    });
  });

  it("does not count a banned administrator toward the last-admin guard", async () => {
    await withFreshAdmin(async (harness, jar) => {
      const dormant = await seedUser(harness.auth, harness.storage, {
        email: "banned-admin@example.test",
        role: "admin",
      });

      // The route refuses to disable an administrator, so the row is seeded
      // directly to model one left banned by an earlier state.
      await harness.storage.db
        .update(schema.user)
        .set({ banned: true })
        .where(eq(schema.user.id, dormant.id));

      const response = await request(harness.app, "/v1/users/" + harness.admin.id, {
        method: "PATCH",
        body: { role: "viewer" },
        cookies: jar,
      });

      expect(response.status).toBe(400);
      expect(errorOf(await jsonBody(response))).toBe("cannot demote the last administrator");

      const row = await findUserWith(harness, jar, harness.admin.id);

      expect(row?.role).toBe("admin");
    });
  });

  it("rejects a combined demote and disable of the last administrator without side effects", async () => {
    await withFreshAdmin(async (harness, jar) => {
      const project = await seedProject(harness.storage, {
        name: "Combined Last Admin",
        slug: "combined-last-admin",
      });

      const key = await seedApiKey(harness.storage, {
        projectId: project.id,
        name: "combined-last-admin-key",
        scopes: ["ingest", "query"],
        createdBy: harness.admin.id,
      });

      const response = await request(harness.app, "/v1/users/" + harness.admin.id, {
        method: "PATCH",
        body: { role: "viewer", disabled: true },
        cookies: jar,
      });

      expect(response.status).toBe(400);
      // The sole callable administrator is also the target, so the self-disable
      // guard rejects before the last-admin guard; neither writes anything.
      expect(errorOf(await jsonBody(response))).toBe("you cannot disable your own account");

      const row = await findUserWith(harness, jar, harness.admin.id);

      expect(row?.role).toBe("admin");
      expect(row?.disabled).toBe(false);

      const keyAfter = await request(harness.app, "/v1/events", { bearer: key.plaintext });

      expect(keyAfter.status).toBe(200);

      const me = await request(harness.app, "/v1/me", { cookies: jar });

      expect(me.status).toBe(200);
    });
  });

  it("demotes and disables an administrator when another active administrator remains", async () => {
    await withFreshAdmin(async (harness, jar) => {
      const second = await seedUser(harness.auth, harness.storage, {
        email: "combined-admin@example.test",
        role: "admin",
      });

      const response = await request(harness.app, "/v1/users/" + second.id, {
        method: "PATCH",
        body: { role: "viewer", disabled: true },
        cookies: jar,
      });

      expect(response.status).toBe(200);

      const updated = objectAt((await jsonBody(response)).user, "user");

      expect(updated.role).toBe("viewer");
      expect(updated.disabled).toBe(true);

      const row = await findUserWith(harness, jar, second.id);

      expect(row?.role).toBe("viewer");
      expect(row?.disabled).toBe(true);
    });
  });
});

describe("administrator protection", () => {
  it("refuses to disable an administrator", async () => {
    const { harness } = ctx();

    const target = await seedUser(harness.auth, harness.storage, {
      email: "protected-admin@example.test",
      role: "admin",
    });

    const plain = await adminRequest("/v1/users/" + target.id, {
      method: "PATCH",
      body: { disabled: true },
    });

    expect(plain.status).toBe(400);
    expect(errorOf(await jsonBody(plain))).toBe("administrators cannot be disabled");

    const combined = await adminRequest("/v1/users/" + target.id, {
      method: "PATCH",
      body: { disabled: true, role: "admin" },
    });

    expect(combined.status).toBe(400);
    expect(errorOf(await jsonBody(combined))).toBe("administrators cannot be disabled");

    const row = await requireUserRow(target.id);

    expect(row.role).toBe("admin");
    expect(row.disabled).toBe(false);
  });

  it("refuses a combined role and disable that would create a banned administrator", async () => {
    const { harness } = ctx();

    const target = await seedUser(harness.auth, harness.storage, {
      email: "combined-promotion@example.test",
      role: "member",
    });

    const response = await adminRequest("/v1/users/" + target.id, {
      method: "PATCH",
      body: { role: "admin", disabled: true },
    });

    expect(response.status).toBe(400);
    expect(errorOf(await jsonBody(response))).toBe("administrators cannot be disabled");

    const row = await requireUserRow(target.id);

    expect(row.role).toBe("member");
    expect(row.disabled).toBe(false);
  });

  it("refuses to delete an administrator", async () => {
    const { harness } = ctx();

    const target = await seedUser(harness.auth, harness.storage, {
      email: "undeletable-admin@example.test",
      role: "admin",
    });

    const response = await adminRequest("/v1/users/" + target.id, { method: "DELETE" });

    expect(response.status).toBe(400);
    expect(errorOf(await jsonBody(response))).toBe("administrators cannot be deleted");

    const row = await requireUserRow(target.id);

    expect(row.role).toBe("admin");
    expect(row.disabled).toBe(false);
  });
});

describe("offboarding side effects", () => {
  it("disabling a member revokes owned keys and invalidates the session", async () => {
    const { harness, data } = ctx();

    const target = await seedUser(harness.auth, harness.storage, {
      email: "disabled-member@example.test",
      role: "member",
    });

    await addToProject(target.id, data.projects.alpha.id);

    const key = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "disabled-member-key",
      scopes: ["ingest", "query"],
      createdBy: target.id,
    });

    const jar = await signInUser(ctx(), target.email, target.password);

    expect(await eventCountWithKey(key.plaintext)).toBe(0);

    const response = await adminRequest("/v1/users/" + target.id, {
      method: "PATCH",
      body: { disabled: true },
    });

    expect(response.status).toBe(200);

    const updated = objectAt((await jsonBody(response)).user, "user");

    expect(updated.disabled).toBe(true);
    expect(updated.role).toBe("member");

    const keyAfter = await request(harness.app, "/v1/events", { bearer: key.plaintext });

    expect(keyAfter.status).toBe(401);
    await expectSessionRejected(jar);
  });

  it("demoting an administrator revokes owned keys and invalidates the session", async () => {
    const { harness, data } = ctx();

    const target = await seedUser(harness.auth, harness.storage, {
      email: "demoted-admin@example.test",
      role: "admin",
    });

    const key = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "demoted-admin-key",
      scopes: ["ingest", "query"],
      createdBy: target.id,
    });

    const jar = await signInUser(ctx(), target.email, target.password);

    expect(await eventCountWithKey(key.plaintext)).toBe(0);

    const response = await adminRequest("/v1/users/" + target.id, {
      method: "PATCH",
      body: { role: "member" },
    });

    expect(response.status).toBe(200);
    expect(objectAt((await jsonBody(response)).user, "user").role).toBe("member");

    const keyAfter = await request(harness.app, "/v1/events", { bearer: key.plaintext });

    expect(keyAfter.status).toBe(401);
    await expectSessionRejected(jar);
  });

  it("demoting a member revokes owned keys", async () => {
    const { harness, data } = ctx();

    const target = await seedUser(harness.auth, harness.storage, {
      email: "demoted-member@example.test",
      role: "member",
    });

    await addToProject(target.id, data.projects.alpha.id);

    const key = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "demoted-member-key",
      scopes: ["ingest", "query"],
      createdBy: target.id,
    });

    expect(await eventCountWithKey(key.plaintext)).toBe(0);

    const response = await adminRequest("/v1/users/" + target.id, {
      method: "PATCH",
      body: { role: "viewer" },
    });

    expect(response.status).toBe(200);
    expect(objectAt((await jsonBody(response)).user, "user").role).toBe("viewer");

    const keyAfter = await request(harness.app, "/v1/events", { bearer: key.plaintext });

    expect(keyAfter.status).toBe(401);
  });

  it("keeps the old role when owned-key revocation fails", async () => {
    const { harness, data } = ctx();

    const target = await seedUser(harness.auth, harness.storage, {
      email: "revocation-failure@example.test",
      role: "member",
    });

    await addToProject(target.id, data.projects.alpha.id);

    const key = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "revocation-failure-key",
      scopes: ["ingest", "query"],
      createdBy: target.id,
    });

    expect(await eventCountWithKey(key.plaintext)).toBe(0);

    const deleteSpy = vi.spyOn(harness.storage.db, "delete");
    let response: Response;

    deleteSpy.mockImplementationOnce(() => {
      throw new Error("injected key deletion failure");
    });

    try {
      response = await adminRequest("/v1/users/" + target.id, {
        method: "PATCH",
        body: { role: "viewer" },
      });
    } finally {
      deleteSpy.mockRestore();
    }

    expect(response.status).toBe(500);
    expect(errorOf(await jsonBody(response))).toBe("could not revoke owned keys; role unchanged");

    const row = await requireUserRow(target.id);

    expect(row.role).toBe("member");

    const keyAfter = await request(harness.app, "/v1/events", { bearer: key.plaintext });

    expect(keyAfter.status).toBe(200);
  });

  it("leaves a member active with live keys when disable-time revocation fails", async () => {
    const { harness, data } = ctx();

    const target = await seedUser(harness.auth, harness.storage, {
      email: "disable-revocation-failure@example.test",
      role: "member",
    });

    await addToProject(target.id, data.projects.alpha.id);

    const key = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "disable-revocation-failure-key",
      scopes: ["ingest", "query"],
      createdBy: target.id,
    });

    expect(await eventCountWithKey(key.plaintext)).toBe(0);
    expect(await apiKeyRows(harness, key.key.id)).toBe(1);

    const deleteSpy = vi.spyOn(harness.storage.db, "delete");

    deleteSpy.mockImplementationOnce(() => {
      throw new Error("injected disable-time key deletion failure");
    });

    try {
      const response = await adminRequest("/v1/users/" + target.id, {
        method: "PATCH",
        body: { disabled: true },
      });

      expect(response.status).toBe(500);
      expect(errorOf(await jsonBody(response))).toBe(
        "could not revoke owned keys; account not disabled",
      );
    } finally {
      deleteSpy.mockRestore();
    }

    const row = await requireUserRow(target.id);

    expect(row.role).toBe("member");
    expect(row.disabled).toBe(false);
    expect(await apiKeyRows(harness, key.key.id)).toBe(1);

    const keyAfterFailure = await request(harness.app, "/v1/events", {
      bearer: key.plaintext,
    });

    expect(keyAfterFailure.status).toBe(200);

    // Retry after the injected failure: revocation succeeds, then the ban.
    const retried = await adminRequest("/v1/users/" + target.id, {
      method: "PATCH",
      body: { disabled: true },
    });

    expect(retried.status).toBe(200);
    expect(objectAt((await jsonBody(retried)).user, "user").disabled).toBe(true);
    expect(await apiKeyRows(harness, key.key.id)).toBe(0);

    const keyAfterDisable = await request(harness.app, "/v1/events", {
      bearer: key.plaintext,
    });

    expect(keyAfterDisable.status).toBe(401);

    const unbanned = await adminRequest("/v1/users/" + target.id, {
      method: "PATCH",
      body: { disabled: false },
    });

    expect(unbanned.status).toBe(200);
    expect(objectAt((await jsonBody(unbanned)).user, "user").disabled).toBe(false);

    const keyAfterUnban = await request(harness.app, "/v1/events", {
      bearer: key.plaintext,
    });

    expect(keyAfterUnban.status).toBe(401);
    expect(await apiKeyRows(harness, key.key.id)).toBe(0);
  });

  it("unbanning a member does not restore keys revoked on disable", async () => {
    const { harness, data } = ctx();

    const target = await seedUser(harness.auth, harness.storage, {
      email: "unbanned-member@example.test",
      role: "member",
    });

    await addToProject(target.id, data.projects.alpha.id);

    const key = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "unbanned-member-key",
      scopes: ["ingest", "query"],
      createdBy: target.id,
    });

    expect(await eventCountWithKey(key.plaintext)).toBe(0);
    expect(await apiKeyRows(harness, key.key.id)).toBe(1);

    const disabled = await adminRequest("/v1/users/" + target.id, {
      method: "PATCH",
      body: { disabled: true },
    });

    expect(disabled.status).toBe(200);
    expect(await apiKeyRows(harness, key.key.id)).toBe(0);

    const unbanned = await adminRequest("/v1/users/" + target.id, {
      method: "PATCH",
      body: { disabled: false },
    });

    expect(unbanned.status).toBe(200);
    expect(objectAt((await jsonBody(unbanned)).user, "user").disabled).toBe(false);

    const keyAfter = await request(harness.app, "/v1/events", { bearer: key.plaintext });

    expect(keyAfter.status).toBe(401);
    expect(await apiKeyRows(harness, key.key.id)).toBe(0);
  });

  it("resetting a password rotates credentials, revokes keys, and invalidates sessions", async () => {
    const { harness, data } = ctx();

    const target = await seedUser(harness.auth, harness.storage, {
      email: "reset-member@example.test",
      role: "member",
    });

    await addToProject(target.id, data.projects.alpha.id);

    const key = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "reset-member-key",
      scopes: ["ingest", "query"],
      createdBy: target.id,
    });

    const jar = await signInUser(ctx(), target.email, target.password);

    expect(await eventCountWithKey(key.plaintext)).toBe(0);

    const response = await adminRequest("/v1/users/" + target.id + "/reset-password", {
      method: "POST",
    });

    expect(response.status).toBe(200);

    const body = await jsonBody(response);
    const newPassword = stringAt(body.password, "password");

    expect(newPassword.length).toBeGreaterThan(0);
    expect(numberAt(body.revokedKeys, "revokedKeys")).toBe(1);

    await expectSessionRejected(jar);

    const oldLogin = await signIn(harness.app, target.email, target.password);

    expect(oldLogin.response.status).toBe(401);
    expect(oldLogin.jar.size).toBe(0);

    const newLogin = await signIn(harness.app, target.email, newPassword);

    expect(newLogin.response.status).toBe(200);

    const me = await request(harness.app, "/v1/me", { cookies: newLogin.jar });

    expect(me.status).toBe(200);

    const keyAfter = await request(harness.app, "/v1/events", { bearer: key.plaintext });

    expect(keyAfter.status).toBe(401);
  });

  it("deleting a member removes the account, sessions, and owned keys", async () => {
    const { harness, data } = ctx();

    const target = await seedUser(harness.auth, harness.storage, {
      email: "deleted-member@example.test",
      role: "member",
    });

    await addToProject(target.id, data.projects.alpha.id);

    const key = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "deleted-member-key",
      scopes: ["ingest", "query"],
      createdBy: target.id,
    });

    const jar = await signInUser(ctx(), target.email, target.password);

    expect(await eventCountWithKey(key.plaintext)).toBe(0);
    expect(await apiKeyRows(harness, key.key.id)).toBe(1);
    // Seed sign-up and sign-in each created a session row.
    expect(await sessionRows(harness, target.id)).toBeGreaterThan(0);

    const response = await adminRequest("/v1/users/" + target.id, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect((await jsonBody(response)).ok).toBe(true);

    const keyAfter = await request(harness.app, "/v1/events", { bearer: key.plaintext });

    expect(keyAfter.status).toBe(401);
    await expectSessionRejected(jar);
    expect(await findUser(target.id)).toBeNull();
    expect(await apiKeyRows(harness, key.key.id)).toBe(0);
    expect(await sessionRows(harness, target.id)).toBe(0);
  });
});
