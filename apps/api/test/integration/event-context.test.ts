import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Normalized } from "../../src/ingest.ts";
import type { JsonObject, JsonValue } from "../../src/json.ts";
import { arrayAt, errorOf, jsonBody, objectAt, stringAt } from "../helpers/body.ts";
import { request } from "../helpers/request.ts";
import { seedApiKey, seedProject } from "../helpers/seed.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

const BASE = 1_800_000_000_000;
const MINUTE = 60_000;

interface ContextFixture {
  session: TestSession;
  projectId: string;
  key: string;
  ingestOnly: string;
  mcpKey: string;
  firstUid: string;
  middleUid: string;
  lastUid: string;
  equalUid: string;
  equalFirstUid: string;
  equalLastUid: string;
  betaUid: string;
}

let fixture: ContextFixture | null = null;

function ctx(): ContextFixture {
  if (fixture === null) throw new Error("event context suite: fixture missing");

  return fixture;
}

function contextPath(uid: string, before?: number | string, after?: number | string): string {
  const query = new URLSearchParams({ project: ctx().projectId });

  if (before !== undefined) query.set("before", String(before));

  if (after !== undefined) query.set("after", String(after));

  return `/v1/events/${uid}/context?${query.toString()}`;
}

function messages(events: JsonValue[]): string[] {
  return events.map((entry) => stringAt(objectAt(entry, "event").message, "event.message"));
}

function messagesOf(body: JsonObject, name: "before" | "after"): string[] {
  return messages(arrayAt(body[name], name));
}

async function getContext(
  uid: string,
  params: { before?: number | string; after?: number | string } = {},
  auth: { bearer?: string; cookies?: string } = {},
): Promise<JsonObject> {
  const response = await request(
    ctx().session.harness.app,
    contextPath(uid, params.before, params.after),
    auth,
  );

  expect(response.status).toBe(200);

  return jsonBody(response);
}

beforeAll(async () => {
  const session = await createTestSession();

  try {
    const storage = session.harness.storage;

    const project = await seedProject(storage, {
      name: "Context",
      memberIds: [session.data.member.id, session.data.viewer.id],
    });

    const key = await seedApiKey(storage, {
      projectId: project.id,
      name: "context-key",
      scopes: ["ingest", "query"],
    });

    const ingestOnly = await seedApiKey(storage, {
      projectId: project.id,
      name: "context-ingest-only",
      scopes: ["ingest"],
    });

    const mcpKey = await seedApiKey(storage, {
      projectId: project.id,
      name: "context-mcp",
      keyType: "mcp",
      scopes: ["logs.read"],
    });

    const events: Normalized[] = Array.from({ length: 25 }, (_, index) => ({
      ts: BASE + index * MINUTE,
      level: 2,
      service: "ctx",
      env: "test",
      message: `ctx-${String(index).padStart(2, "0")}`,
      fields: null,
    }));

    const inserted = await storage.insertEvents(project.id, events, null);

    const equal = await storage.insertEvents(
      project.id,
      [
        {
          ts: BASE + 12 * MINUTE + 30_000,
          level: 3,
          service: "ctx",
          env: "test",
          message: "ctx-equal-a",
          fields: null,
        },
        {
          ts: BASE + 12 * MINUTE + 30_000,
          level: 3,
          service: "ctx",
          env: "test",
          message: "ctx-equal-b",
          fields: null,
        },
        {
          ts: BASE + 12 * MINUTE + 30_000,
          level: 3,
          service: "ctx",
          env: "test",
          message: "ctx-equal-c",
          fields: null,
        },
      ],
      null,
    );

    const beta = await storage.insertEvents(
      session.data.projects.beta.id,
      [
        {
          ts: BASE + 12 * MINUTE,
          level: 4,
          service: "beta",
          env: "test",
          message: "beta context event",
          fields: null,
        },
      ],
      null,
    );

    const first = inserted[0];
    const middle = inserted[12];
    const last = inserted[24];
    const equalFirst = equal[0];
    const equalMiddle = equal[1];
    const equalLast = equal[2];
    const betaEvent = beta[0];

    if (!first?.uid || !middle?.uid || !last?.uid) {
      throw new Error("event context suite: fixture uids missing");
    }

    if (!equalFirst?.uid || !equalMiddle?.uid || !equalLast?.uid || !betaEvent?.uid) {
      throw new Error("event context suite: equal/beta fixture uids missing");
    }

    fixture = {
      session,
      projectId: project.id,
      key: key.plaintext,
      ingestOnly: ingestOnly.plaintext,
      mcpKey: mcpKey.plaintext,
      firstUid: first.uid,
      middleUid: middle.uid,
      lastUid: last.uid,
      equalUid: equalMiddle.uid,
      equalFirstUid: equalFirst.uid,
      equalLastUid: equalLast.uid,
      betaUid: betaEvent.uid,
    };
  } catch (err) {
    await session.close();
    throw err;
  }
});

afterAll(async () => {
  await fixture?.session.close();
  fixture = null;
});

describe("GET /v1/events/:uid/context ordering", () => {
  it("returns no earlier events for the first event and five later by default", async () => {
    const body = await getContext(ctx().firstUid, {}, { bearer: ctx().key });

    expect(stringAt(objectAt(body.event, "event").uid, "event.uid")).toBe(ctx().firstUid);
    expect(arrayAt(body.before, "before")).toEqual([]);
    expect(messagesOf(body, "after")).toEqual(["ctx-01", "ctx-02", "ctx-03", "ctx-04", "ctx-05"]);
  });

  it("returns five before and five after a middle event, oldest first", async () => {
    const body = await getContext(ctx().middleUid, {}, { bearer: ctx().key });

    expect(messagesOf(body, "before")).toEqual(["ctx-07", "ctx-08", "ctx-09", "ctx-10", "ctx-11"]);
    expect(messagesOf(body, "after")).toEqual([
      "ctx-equal-a",
      "ctx-equal-b",
      "ctx-equal-c",
      "ctx-13",
      "ctx-14",
    ]);
  });

  it("returns five earlier events and no later events for the last event", async () => {
    const body = await getContext(ctx().lastUid, {}, { bearer: ctx().key });

    expect(messagesOf(body, "before")).toEqual(["ctx-19", "ctx-20", "ctx-21", "ctx-22", "ctx-23"]);
    expect(arrayAt(body.after, "after")).toEqual([]);
  });

  it("orders equal timestamps deterministically by id", async () => {
    const before = await getContext(ctx().equalUid, { before: 1, after: 1 }, { bearer: ctx().key });

    const after = await getContext(
      ctx().equalLastUid,
      { before: 1, after: 0 },
      { bearer: ctx().key },
    );

    expect(messagesOf(before, "before")).toEqual(["ctx-equal-a"]);
    expect(messagesOf(before, "after")).toEqual(["ctx-equal-c"]);
    expect(messagesOf(after, "before")).toEqual(["ctx-equal-b"]);
  });

  it("honors zero and clamps before/after to 20", async () => {
    const zero = await getContext(ctx().middleUid, { before: 0, after: 0 }, { bearer: ctx().key });
    const cappedBefore = await getContext(ctx().lastUid, { before: 99 }, { bearer: ctx().key });
    const cappedAfter = await getContext(ctx().firstUid, { after: 99 }, { bearer: ctx().key });

    expect(arrayAt(zero.before, "before")).toEqual([]);
    expect(arrayAt(zero.after, "after")).toEqual([]);
    expect(arrayAt(cappedBefore.before, "before")).toHaveLength(20);
    expect(arrayAt(cappedAfter.after, "after")).toHaveLength(20);
  });

  it("returns 404 for unknown and cross-project uids, and 400 for malformed ids", async () => {
    const harness = ctx().session.harness.app;

    const unknown = await request(harness, contextPath("0190f5b2-7c3a-7def-8abc-0123456789ab"), {
      bearer: ctx().key,
    });

    expect(unknown.status).toBe(404);
    expect(errorOf(await jsonBody(unknown))).toBe("event not found");

    const crossProject = await request(harness, contextPath(ctx().betaUid), {
      bearer: ctx().key,
    });

    expect(crossProject.status).toBe(404);

    const malformed = await request(harness, contextPath("not-a-uuid"), {
      bearer: ctx().key,
    });

    expect(malformed.status).toBe(400);
    expect(errorOf(await jsonBody(malformed))).toBe("invalid event id");
  });
});

describe("GET /v1/events/:uid/context auth", () => {
  it("requires credentials and logs.read", async () => {
    const harness = ctx().session.harness.app;

    expect((await request(harness, contextPath(ctx().firstUid))).status).toBe(401);

    const ingestOnly = await request(harness, contextPath(ctx().firstUid), {
      bearer: ctx().ingestOnly,
    });

    expect(ingestOnly.status).toBe(403);
    expect(errorOf(await jsonBody(ingestOnly))).toContain("missing query scope");
  });

  it("allows members, viewers, API keys, and MCP keys for the project", async () => {
    const { session } = ctx();
    const path = contextPath(ctx().firstUid);

    for (const jar of [session.memberJar, session.viewerJar]) {
      const response = await request(session.harness.app, path, { cookies: jar });

      expect(response.status).toBe(200);
      expect(numberOfAfter(await jsonBody(response))).toBe(5);
    }

    const apiKey = await request(session.harness.app, contextPath(ctx().firstUid), {
      bearer: ctx().key,
    });

    const mcpKey = await request(session.harness.app, contextPath(ctx().firstUid), {
      bearer: ctx().mcpKey,
    });

    expect(apiKey.status).toBe(200);
    expect(mcpKey.status).toBe(200);
  });
});

function numberOfAfter(body: JsonObject): number {
  return arrayAt(body.after, "after").length;
}
