import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../../src/json.ts";
import { seedApiKey, seedUser } from "../helpers/seed.ts";
import type { SeededUser } from "../helpers/seed.ts";
import { arrayAt, errorOf, jsonBody, objectAt, stringAt } from "../helpers/body.ts";
import { request } from "../helpers/request.ts";
import type { CookieJar } from "../helpers/request.ts";
import { createTestSession, signInUser } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

interface KeyContext {
  session: TestSession;
  secondMemberJar: CookieJar;
  betaMemberJar: CookieJar;
}

let context: KeyContext | null = null;

function ctx(): KeyContext {
  if (context === null) throw new Error("keys suite: test context missing");

  return context;
}

function findKey(keys: JsonValue[], id: string): JsonObject | null {
  for (const entry of keys) {
    const key = objectAt(entry, "key");

    if (key.id === id) return key;
  }

  return null;
}

async function addToProject(userId: string, projectId: string): Promise<void> {
  const { session } = ctx();

  const added = await request(session.harness.app, "/v1/projects/" + projectId + "/members", {
    method: "POST",
    body: { userId },
    cookies: session.adminJar,
  });

  if (added.status !== 201) {
    throw new Error(
      `keys suite: could not add ${userId} to project ${projectId} (status ${added.status})`,
    );
  }
}

async function addMember(email: string): Promise<SeededUser> {
  const { session } = ctx();
  const { data } = session;

  const user = await seedUser(session.harness.auth, session.harness.storage, {
    email,
    name: email,
    role: "member",
  });

  await addToProject(user.id, data.projects.alpha.id);

  return user;
}

beforeAll(async () => {
  const session = await createTestSession();

  try {
    const secondMember = await seedUser(session.harness.auth, session.harness.storage, {
      email: "second-member@example.test",
      role: "member",
    });

    const betaMember = await seedUser(session.harness.auth, session.harness.storage, {
      email: "beta-member@example.test",
      role: "member",
    });

    const alphaMember = await request(
      session.harness.app,
      "/v1/projects/" + session.data.projects.alpha.id + "/members",
      {
        method: "POST",
        body: { userId: secondMember.id },
        cookies: session.adminJar,
      },
    );

    const betaMembership = await request(
      session.harness.app,
      "/v1/projects/" + session.data.projects.beta.id + "/members",
      {
        method: "POST",
        body: { userId: betaMember.id },
        cookies: session.adminJar,
      },
    );

    if (alphaMember.status !== 201 || betaMembership.status !== 201) {
      throw new Error("keys suite: membership fixture failed");
    }

    context = {
      session,
      secondMemberJar: await signInUser(session, secondMember.email, secondMember.password),
      betaMemberJar: await signInUser(session, betaMember.email, betaMember.password),
    };
  } catch (err) {
    await session.close();
    throw err;
  }
});

afterAll(async () => {
  await context?.session.close();
  context = null;
});

describe("API key lifecycle", () => {
  it("creates a key and lists it without exposing the secret", async () => {
    const { session } = ctx();
    const { harness, data, memberJar } = session;

    const created = await request(harness.app, "/v1/projects/" + data.projects.alpha.id + "/keys", {
      method: "POST",
      body: { name: "reader", scopes: ["ingest", "query"] },
      cookies: memberJar,
    });

    expect(created.status).toBe(201);

    const createdBody = await jsonBody(created);
    const key = objectAt(createdBody.key, "key");
    const keyId = stringAt(key.id, "key.id");
    const plaintext = stringAt(createdBody.plaintext, "plaintext");

    expect(plaintext).toMatch(/^kl_/);
    expect(stringAt(key.prefix, "key.prefix")).toBe(plaintext.slice(0, 11) + "…");
    expect(key.projectId).toBe(data.projects.alpha.id);
    expect(key.createdBy).toBe(data.member.id);

    const list = await request(harness.app, "/v1/projects/" + data.projects.alpha.id + "/keys", {
      cookies: memberJar,
    });

    expect(list.status).toBe(200);

    const keys = arrayAt((await jsonBody(list)).keys, "keys");
    const listed = findKey(keys, keyId);

    if (listed === null) throw new Error("created key missing from the list");
    expect(listed.prefix).toBe(key.prefix);
    expect(JSON.stringify(keys)).not.toContain(plaintext);

    for (const entry of keys) {
      const entryBody = objectAt(entry, "key");

      expect(entryBody.plaintext).toBeUndefined();
      expect(entryBody.keyHash).toBeUndefined();
      expect(stringAt(entryBody.prefix, "key.prefix")).toMatch(/…$/);
    }
  });

  it("updates scopes and enforces the new scope immediately", async () => {
    const { session } = ctx();
    const { harness, data, memberJar } = session;

    const created = await request(harness.app, "/v1/projects/" + data.projects.alpha.id + "/keys", {
      method: "POST",
      body: { name: "scope-key", scopes: ["ingest"] },
      cookies: memberJar,
    });

    expect(created.status).toBe(201);

    const createdBody = await jsonBody(created);
    const keyId = stringAt(objectAt(createdBody.key, "key").id, "key.id");
    const plaintext = stringAt(createdBody.plaintext, "plaintext");

    const ingest = await request(harness.app, "/v1/events", {
      method: "POST",
      body: { message: "scoped ingest" },
      bearer: plaintext,
    });

    expect(ingest.status).toBe(200);

    const readDenied = await request(harness.app, "/v1/events", { bearer: plaintext });
    expect(readDenied.status).toBe(403);
    expect(errorOf(await jsonBody(readDenied))).toContain("missing query scope");

    const queryUri = "/v1/keys/" + keyId + "?project=" + data.projects.alpha.id;

    const updated = await request(harness.app, queryUri, {
      method: "PATCH",
      body: { scopes: ["query"] },
      cookies: memberJar,
    });

    expect(updated.status).toBe(200);
    expect(arrayAt((await jsonBody(updated)).scopes, "scopes")).toEqual(["query"]);

    const writeDenied = await request(harness.app, "/v1/events", {
      method: "POST",
      body: { message: "scoped ingest after update" },
      bearer: plaintext,
    });

    expect(writeDenied.status).toBe(403);
    expect(errorOf(await jsonBody(writeDenied))).toContain("missing ingest scope");

    const read = await request(harness.app, "/v1/events", { bearer: plaintext });
    expect(read.status).toBe(200);

    const invalid = await request(harness.app, queryUri, {
      method: "PATCH",
      body: { scopes: ["logs.read"] },
      cookies: memberJar,
    });

    expect(invalid.status).toBe(400);

    const empty = await request(harness.app, queryUri, {
      method: "PATCH",
      body: { scopes: [] },
      cookies: memberJar,
    });

    expect(empty.status).toBe(400);
  });

  it("rotates a key so the old secret stops working", async () => {
    const { session } = ctx();
    const { harness, data, memberJar } = session;

    const created = await request(harness.app, "/v1/projects/" + data.projects.alpha.id + "/keys", {
      method: "POST",
      body: { name: "rotate-key", scopes: ["ingest", "query"] },
      cookies: memberJar,
    });

    expect(created.status).toBe(201);

    const createdBody = await jsonBody(created);
    const keyId = stringAt(objectAt(createdBody.key, "key").id, "key.id");
    const oldPlaintext = stringAt(createdBody.plaintext, "plaintext");

    const before = await request(harness.app, "/v1/events", { bearer: oldPlaintext });
    expect(before.status).toBe(200);

    const rotated = await request(
      harness.app,
      "/v1/keys/" + keyId + "/rotate?project=" + data.projects.alpha.id,
      { method: "POST", cookies: memberJar },
    );

    expect(rotated.status).toBe(200);

    const rotatedBody = await jsonBody(rotated);
    const newPlaintext = stringAt(rotatedBody.plaintext, "plaintext");

    expect(newPlaintext).toMatch(/^kl_/);
    expect(newPlaintext).not.toBe(oldPlaintext);
    expect(stringAt(rotatedBody.prefix, "prefix")).toBe(newPlaintext.slice(0, 11) + "…");

    const oldDenied = await request(harness.app, "/v1/events", { bearer: oldPlaintext });
    expect(oldDenied.status).toBe(401);

    const newAllowed = await request(harness.app, "/v1/events", { bearer: newPlaintext });
    expect(newAllowed.status).toBe(200);

    const list = await request(harness.app, "/v1/projects/" + data.projects.alpha.id + "/keys", {
      cookies: memberJar,
    });

    const listed = findKey(arrayAt((await jsonBody(list)).keys, "keys"), keyId);

    if (listed === null) throw new Error("rotated key missing from the list");
    expect(listed.prefix).toBe(rotatedBody.prefix);
  });

  it("revokes a key and removes it from the list", async () => {
    const { session } = ctx();
    const { harness, data, memberJar } = session;

    const created = await request(harness.app, "/v1/projects/" + data.projects.alpha.id + "/keys", {
      method: "POST",
      body: { name: "revoke-key", scopes: ["ingest", "query"] },
      cookies: memberJar,
    });

    expect(created.status).toBe(201);

    const createdBody = await jsonBody(created);
    const keyId = stringAt(objectAt(createdBody.key, "key").id, "key.id");
    const plaintext = stringAt(createdBody.plaintext, "plaintext");

    const removed = await request(
      harness.app,
      "/v1/keys/" + keyId + "?project=" + data.projects.alpha.id,
      { method: "DELETE", cookies: memberJar },
    );

    expect(removed.status).toBe(200);
    expect((await jsonBody(removed)).ok).toBe(true);

    const denied = await request(harness.app, "/v1/events", { bearer: plaintext });
    expect(denied.status).toBe(401);

    const list = await request(harness.app, "/v1/projects/" + data.projects.alpha.id + "/keys", {
      cookies: memberJar,
    });

    expect(findKey(arrayAt((await jsonBody(list)).keys, "keys"), keyId)).toBeNull();
  });

  it("refuses key management from a member of another project", async () => {
    const { session, betaMemberJar } = ctx();
    const { harness, data } = session;
    const alphaKeyId = data.keys.alpha.key.id;
    const alphaKeys = "/v1/projects/" + data.projects.alpha.id + "/keys";

    const list = await request(harness.app, alphaKeys, { cookies: betaMemberJar });
    expect(list.status).toBe(404);

    const ownList = await request(harness.app, "/v1/projects/" + data.projects.beta.id + "/keys", {
      cookies: betaMemberJar,
    });

    expect(ownList.status).toBe(200);

    const keyUri = "/v1/keys/" + alphaKeyId + "?project=" + data.projects.alpha.id;
    const rotateUri = "/v1/keys/" + alphaKeyId + "/rotate?project=" + data.projects.alpha.id;

    const update = await request(harness.app, keyUri, {
      method: "PATCH",
      body: { scopes: ["query"] },
      cookies: betaMemberJar,
    });

    expect(update.status).toBe(404);

    const rotate = await request(harness.app, rotateUri, {
      method: "POST",
      cookies: betaMemberJar,
    });

    expect(rotate.status).toBe(404);

    const revoke = await request(harness.app, keyUri, {
      method: "DELETE",
      cookies: betaMemberJar,
    });

    expect(revoke.status).toBe(404);
  });

  it("refuses same-project members who did not create the key", async () => {
    const { session, secondMemberJar } = ctx();
    const { harness, data } = session;
    const alphaKeyId = data.keys.alpha.key.id;
    const keyUri = "/v1/keys/" + alphaKeyId + "?project=" + data.projects.alpha.id;
    const rotateUri = "/v1/keys/" + alphaKeyId + "/rotate?project=" + data.projects.alpha.id;

    const update = await request(harness.app, keyUri, {
      method: "PATCH",
      body: { scopes: ["query"] },
      cookies: secondMemberJar,
    });

    expect(update.status).toBe(403);
    expect(errorOf(await jsonBody(update))).toContain("only the key creator");

    const rotate = await request(harness.app, rotateUri, {
      method: "POST",
      cookies: secondMemberJar,
    });

    expect(rotate.status).toBe(403);

    const revoke = await request(harness.app, keyUri, {
      method: "DELETE",
      cookies: secondMemberJar,
    });

    expect(revoke.status).toBe(403);

    const stillWorks = await request(harness.app, "/v1/events", {
      bearer: data.keys.alpha.plaintext,
    });

    expect(stillWorks.status).toBe(200);
  });

  it("revokes owned keys when a project member is removed", async () => {
    const { session } = ctx();
    const { harness, data } = session;
    const user = await addMember("removed-member@example.test");

    await addToProject(user.id, data.projects.beta.id);

    const firstAlphaKey = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "removed-member-key-1",
      scopes: ["ingest", "query"],
      createdBy: user.id,
    });

    const secondAlphaKey = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "removed-member-key-2",
      scopes: ["ingest", "query"],
      createdBy: user.id,
    });

    const betaKey = await seedApiKey(harness.storage, {
      projectId: data.projects.beta.id,
      name: "removed-member-beta-key",
      scopes: ["ingest", "query"],
      createdBy: user.id,
    });

    for (const key of [firstAlphaKey, secondAlphaKey, betaKey]) {
      const before = await request(harness.app, "/v1/events", { bearer: key.plaintext });
      expect(before.status).toBe(200);
    }

    const removed = await request(
      harness.app,
      "/v1/projects/" + data.projects.alpha.id + "/members/" + user.id,
      { method: "DELETE", cookies: session.adminJar },
    );

    expect(removed.status).toBe(200);
    expect((await jsonBody(removed)).revokedKeys).toBe(2);

    for (const key of [firstAlphaKey, secondAlphaKey]) {
      const after = await request(harness.app, "/v1/events", { bearer: key.plaintext });
      expect(after.status).toBe(401);
    }

    const betaStillWorks = await request(harness.app, "/v1/events", {
      bearer: betaKey.plaintext,
    });

    expect(betaStillWorks.status).toBe(200);
  });

  it("revokes owned keys in every project when a member is demoted", async () => {
    const { session } = ctx();
    const { harness, data } = session;
    const user = await addMember("demoted-member@example.test");

    await addToProject(user.id, data.projects.beta.id);

    const alphaKey = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "demoted-member-alpha-key",
      scopes: ["ingest", "query"],
      createdBy: user.id,
    });

    const betaKey = await seedApiKey(harness.storage, {
      projectId: data.projects.beta.id,
      name: "demoted-member-beta-key",
      scopes: ["ingest", "query"],
      createdBy: user.id,
    });

    for (const key of [alphaKey, betaKey]) {
      const before = await request(harness.app, "/v1/events", { bearer: key.plaintext });
      expect(before.status).toBe(200);
    }

    const demoted = await request(harness.app, "/v1/users/" + user.id, {
      method: "PATCH",
      body: { role: "viewer" },
      cookies: session.adminJar,
    });

    expect(demoted.status).toBe(200);
    expect(objectAt((await jsonBody(demoted)).user, "user").role).toBe("viewer");

    for (const key of [alphaKey, betaKey]) {
      const after = await request(harness.app, "/v1/events", { bearer: key.plaintext });
      expect(after.status).toBe(401);
    }
  });

  it("still revokes owned keys when member removal is retried", async () => {
    const { session } = ctx();
    const { harness, data } = session;
    const user = await addMember("retry-member@example.test");
    const memberUri = "/v1/projects/" + data.projects.alpha.id + "/members/" + user.id;

    const first = await request(harness.app, memberUri, {
      method: "DELETE",
      cookies: session.adminJar,
    });

    expect(first.status).toBe(200);

    // Leftover keys from the first attempt must not survive a retry, even
    // though the membership row is already gone (404 for the membership).
    const firstLeftover = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "retry-leftover-key-1",
      scopes: ["ingest", "query"],
      createdBy: user.id,
    });

    const secondLeftover = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "retry-leftover-key-2",
      scopes: ["ingest", "query"],
      createdBy: user.id,
    });

    const retry = await request(harness.app, memberUri, {
      method: "DELETE",
      cookies: session.adminJar,
    });

    expect(retry.status).toBe(404);
    expect(errorOf(await jsonBody(retry))).toBe("member not found");

    for (const key of [firstLeftover, secondLeftover]) {
      const after = await request(harness.app, "/v1/events", { bearer: key.plaintext });
      expect(after.status).toBe(401);
    }
  });

  it("does not let an API key manage project keys", async () => {
    const { session } = ctx();
    const { harness, data, memberJar } = session;

    const created = await request(harness.app, "/v1/projects/" + data.projects.alpha.id + "/keys", {
      method: "POST",
      body: { name: "key-management-target", scopes: ["ingest", "query"] },
      cookies: memberJar,
    });

    expect(created.status).toBe(201);

    const createdBody = await jsonBody(created);
    const targetId = stringAt(objectAt(createdBody.key, "key").id, "key.id");
    const targetPlaintext = stringAt(createdBody.plaintext, "plaintext");
    const keyUri = "/v1/keys/" + targetId + "?project=" + data.projects.alpha.id;
    const rotateUri = "/v1/keys/" + targetId + "/rotate?project=" + data.projects.alpha.id;

    const list = await request(harness.app, "/v1/projects/" + data.projects.alpha.id + "/keys", {
      bearer: data.keys.alpha.plaintext,
    });

    expect(list.status).toBe(403);

    const create = await request(harness.app, "/v1/projects/" + data.projects.alpha.id + "/keys", {
      method: "POST",
      body: { name: "key-from-key" },
      bearer: data.keys.alpha.plaintext,
    });

    expect(create.status).toBe(403);

    const update = await request(harness.app, keyUri, {
      method: "PATCH",
      body: { scopes: ["ingest"] },
      bearer: data.keys.alpha.plaintext,
    });

    expect(update.status).toBe(403);

    const rotate = await request(harness.app, rotateUri, {
      method: "POST",
      bearer: data.keys.alpha.plaintext,
    });

    expect(rotate.status).toBe(403);

    const revoke = await request(harness.app, keyUri, {
      method: "DELETE",
      bearer: data.keys.alpha.plaintext,
    });

    expect(revoke.status).toBe(403);

    const targetStillWorks = await request(harness.app, "/v1/events", {
      bearer: targetPlaintext,
    });

    expect(targetStillWorks.status).toBe(200);
  });
});
