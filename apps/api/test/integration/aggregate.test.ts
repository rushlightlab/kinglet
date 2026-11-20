import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Normalized } from "../../src/ingest.ts";
import type { JsonObject } from "../../src/json.ts";
import { arrayAt, errorOf, jsonBody, numberAt, objectAt, stringAt } from "../helpers/body.ts";
import { createTestHarness } from "../helpers/harness.ts";
import type { TestHarness } from "../helpers/harness.ts";
import { request, signIn } from "../helpers/request.ts";
import { TEST_USER_PASSWORD, seedApiKey, seedTestData } from "../helpers/seed.ts";
import type { SeededTestData } from "../helpers/seed.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const FROM = NOW - 24 * HOUR;
const TO = NOW + 60_000;

const ALPHA_EVENTS: Normalized[] = [
  {
    ts: NOW - 1 * HOUR,
    level: 4,
    service: "api",
    env: "prod",
    message: "Connection refused by upstream",
    fields: null,
  },
  {
    ts: NOW - 2 * HOUR,
    level: 4,
    service: "api",
    env: "prod",
    message: "upstream timeout",
    fields: null,
  },
  {
    ts: NOW - 3 * HOUR,
    level: 3,
    service: "api",
    env: "staging",
    message: "slow request",
    fields: null,
  },
  {
    ts: NOW - 4 * HOUR,
    level: 2,
    service: "web",
    env: "prod",
    message: "healthcheck ok",
    fields: null,
  },
  {
    ts: NOW - 5 * HOUR,
    level: 2,
    service: "web",
    env: "prod",
    message: "rendered page",
    fields: null,
  },
  {
    ts: NOW - 6 * HOUR,
    level: 2,
    service: null,
    env: null,
    message: "unattributed event",
    fields: null,
  },
  {
    ts: NOW - 7 * HOUR,
    level: 0,
    service: "worker",
    env: "dev",
    message: "trace detail",
    fields: null,
  },
  {
    ts: NOW - 8 * HOUR,
    level: 4,
    service: "worker",
    env: "dev",
    message: "worker failed",
    fields: null,
  },
  {
    // Outside the 31-day clamp; only the clamp test can observe its absence.
    ts: NOW - 40 * DAY,
    level: 4,
    service: "archived-svc",
    env: "prod",
    message: "archived event",
    fields: null,
  },
];

const BETA_EVENTS: Normalized[] = [
  {
    ts: NOW - 1 * HOUR,
    level: 4,
    service: "api",
    env: "prod",
    message: "beta-only event",
    fields: null,
  },
  {
    ts: NOW - 2 * HOUR,
    level: 3,
    service: "beta-svc",
    env: "prod",
    message: "beta second event",
    fields: null,
  },
];

interface AggregateFixture {
  harness: TestHarness;
  data: SeededTestData;
  ingestOnly: string;
  monitorsOnly: string;
}

let fixture: AggregateFixture | null = null;

function ctx(): AggregateFixture {
  if (fixture === null) throw new Error("aggregate suite: fixture missing");

  return fixture;
}

interface AggregateParams {
  q?: string;
  from?: number;
  to?: number;
  groupBy?: string;
  limit?: string | number;
  project?: string;
}

function aggregatePath(params: AggregateParams = {}): string {
  const query = new URLSearchParams();

  query.set("from", String(params.from ?? FROM));
  query.set("to", String(params.to ?? TO));

  if (params.q !== undefined) query.set("q", params.q);

  if (params.groupBy !== undefined) query.set("groupBy", params.groupBy);

  if (params.limit !== undefined) query.set("limit", String(params.limit));

  if (params.project !== undefined) query.set("project", params.project);

  return `/v1/aggregate?${query.toString()}`;
}

async function aggregate(
  params: AggregateParams = {},
  auth: { bearer?: string; cookies?: string } = {},
): Promise<Response> {
  return request(ctx().harness.app, aggregatePath(params), auth);
}

function groupCounts(body: JsonObject): Map<string, number> {
  const counts = new Map<string, number>();

  for (const entry of arrayAt(body.groups, "groups")) {
    const group = objectAt(entry, "group");
    const key = group.key === null ? "null" : stringAt(group.key, "group.key");

    counts.set(key, numberAt(group.count, "group.count"));
  }

  return counts;
}

function sumCounts(counts: Map<string, number>): number {
  let total = 0;

  for (const count of counts.values()) total += count;

  return total;
}

beforeAll(async () => {
  const harness = await createTestHarness();

  try {
    const data = await seedTestData(harness.storage, harness.auth);

    await harness.storage.insertEvents(data.projects.alpha.id, ALPHA_EVENTS, null);
    await harness.storage.insertEvents(data.projects.beta.id, BETA_EVENTS, null);

    const ingestOnly = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "aggregate-ingest-only",
      scopes: ["ingest"],
    });

    const monitorsOnly = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "aggregate-monitors-only",
      keyType: "mcp",
      scopes: ["monitors.read"],
    });

    fixture = {
      harness,
      data,
      ingestOnly: ingestOnly.plaintext,
      monitorsOnly: monitorsOnly.plaintext,
    };
  } catch (err) {
    await harness.close();
    throw err;
  }
});

afterAll(async () => {
  await fixture?.harness.close();
  fixture = null;
});

describe("GET /v1/aggregate auth and project scope", () => {
  it("requires credentials and a logs.read capability", async () => {
    const test = ctx();

    expect((await aggregate()).status).toBe(401);

    const ingestOnly = await aggregate({}, { bearer: test.ingestOnly });

    expect(ingestOnly.status).toBe(403);
    expect(errorOf(await jsonBody(ingestOnly))).toContain("missing query scope");

    const monitorsOnly = await aggregate({}, { bearer: test.monitorsOnly });

    expect(monitorsOnly.status).toBe(403);
    expect(errorOf(await jsonBody(monitorsOnly))).toContain("logs.read");
  });

  it("allows members, viewers, API keys, and MCP keys to read their project", async () => {
    const test = ctx();
    const path = aggregatePath({ project: test.data.projects.alpha.id });

    for (const user of [test.data.member, test.data.viewer]) {
      const signed = await signIn(test.harness.app, user.email, user.password);

      expect(signed.response.status).toBe(200);

      const response = await request(test.harness.app, path, { cookies: signed.jar });

      expect(response.status).toBe(200);
      expect(numberAt((await jsonBody(response)).total, "total")).toBe(8);
    }

    for (const bearer of [test.data.keys.alpha.plaintext, test.data.keys.mcp.plaintext]) {
      const response = await request(test.harness.app, aggregatePath(), { bearer });

      expect(response.status).toBe(200);
      expect(numberAt((await jsonBody(response)).total, "total")).toBe(8);
    }
  });

  it("never lets an API key cross into another project", async () => {
    const test = ctx();

    const beta = await request(
      test.harness.app,
      aggregatePath({ project: test.data.projects.beta.id }),
      { bearer: test.data.keys.alpha.plaintext },
    );

    expect(beta.status).toBe(200);

    const body = await jsonBody(beta);

    expect(numberAt(body.total, "total")).toBe(8);
    expect(JSON.stringify(body)).not.toContain("beta-svc");
  });

  it("denies a member another project and lets an admin read it", async () => {
    const test = ctx();
    const member = await signIn(test.harness.app, test.data.member.email, TEST_USER_PASSWORD);
    const betaPath = aggregatePath({ project: test.data.projects.beta.id });

    const denied = await request(test.harness.app, betaPath, { cookies: member.jar });

    expect(denied.status).toBe(404);

    const admin = await signIn(
      test.harness.app,
      test.harness.admin.email,
      test.harness.admin.password,
    );

    const allowed = await request(test.harness.app, betaPath, { cookies: admin.jar });

    expect(allowed.status).toBe(200);
    expect(numberAt((await jsonBody(allowed)).total, "total")).toBe(2);
  });
});

describe("GET /v1/aggregate grouping", () => {
  it("returns a total-only response without group fields", async () => {
    const response = await aggregate({}, { bearer: ctx().data.keys.alpha.plaintext });

    expect(response.status).toBe(200);

    const body = await jsonBody(response);

    expect(numberAt(body.total, "total")).toBe(8);
    expect(numberAt(body.from, "from")).toBe(FROM);
    expect(numberAt(body.to, "to")).toBe(TO);
    expect(body.groupBy).toBeUndefined();
    expect(body.groups).toBeUndefined();
    expect(body.truncated).toBeUndefined();
  });

  it("groups by service, including uncategorized events, ordered by count", async () => {
    const response = await aggregate(
      { groupBy: "service" },
      { bearer: ctx().data.keys.alpha.plaintext },
    );

    expect(response.status).toBe(200);

    const body = await jsonBody(response);
    const groups = arrayAt(body.groups, "groups");

    expect(stringAt(body.groupBy, "groupBy")).toBe("service");
    expect(numberAt(body.total, "total")).toBe(8);
    expect(
      groups.map((entry) => {
        const group = objectAt(entry, "group");

        return group.key === null ? null : stringAt(group.key, "group.key");
      }),
    ).toEqual(["api", "web", "worker", null]);
    expect([...groupCounts(body).entries()]).toEqual([
      ["api", 3],
      ["web", 2],
      ["worker", 2],
      ["null", 1],
    ]);
    expect(sumCounts(groupCounts(body))).toBe(8);
    expect(body.truncated).toBeUndefined();
  });

  it("groups by level using human-readable names", async () => {
    const response = await aggregate(
      { groupBy: "level" },
      { bearer: ctx().data.keys.alpha.plaintext },
    );

    expect(response.status).toBe(200);

    const body = await jsonBody(response);
    const counts = groupCounts(body);

    expect(stringAt(body.groupBy, "groupBy")).toBe("level");
    expect(counts).toEqual(
      new Map([
        ["error", 3],
        ["info", 3],
        ["trace", 1],
        ["warn", 1],
      ]),
    );
    expect([...counts.keys()].some((key) => /^\d+$/.test(key))).toBe(false);
  });

  it("groups by env with a null key", async () => {
    const response = await aggregate(
      { groupBy: "env" },
      { bearer: ctx().data.keys.alpha.plaintext },
    );

    expect(response.status).toBe(200);

    const body = await jsonBody(response);
    const counts = groupCounts(body);

    expect(stringAt(body.groupBy, "groupBy")).toBe("env");
    expect(counts.get("prod")).toBe(4);
    expect(counts.get("dev")).toBe(2);
    expect(counts.get("staging")).toBe(1);
    expect(counts.get("null")).toBe(1);
    expect(sumCounts(counts)).toBe(8);
  });
});

describe("GET /v1/aggregate filters and limits", () => {
  it("applies the same filter grammar as /v1/events", async () => {
    const bearer = ctx().data.keys.alpha.plaintext;

    const level = await aggregate({ q: "level>=error" }, { bearer });
    const service = await aggregate({ q: "service:api" }, { bearer });
    const phrase = await aggregate({ q: '"connection refused"' }, { bearer });
    const excluded = await aggregate({ q: "-healthcheck" }, { bearer });

    const combined = await aggregate(
      { q: "level>=error service:api", groupBy: "service" },
      { bearer },
    );

    expect(numberAt((await jsonBody(level)).total, "total")).toBe(3);
    expect(numberAt((await jsonBody(service)).total, "total")).toBe(3);
    expect(numberAt((await jsonBody(phrase)).total, "total")).toBe(1);
    expect(numberAt((await jsonBody(excluded)).total, "total")).toBe(7);

    const combinedBody = await jsonBody(combined);

    expect(numberAt(combinedBody.total, "total")).toBe(2);
    expect(groupCounts(combinedBody)).toEqual(new Map([["api", 2]]));
  });

  it("returns an empty grouped result without truncation", async () => {
    const response = await aggregate(
      { q: "service:missing", groupBy: "service" },
      { bearer: ctx().data.keys.alpha.plaintext },
    );

    expect(response.status).toBe(200);

    const body = await jsonBody(response);

    expect(numberAt(body.total, "total")).toBe(0);
    expect(arrayAt(body.groups, "groups")).toEqual([]);
    expect(body.truncated).toBeUndefined();
  });

  it("clamps the window to 31 days", async () => {
    const response = await aggregate(
      { from: NOW - 40 * DAY, to: NOW },
      { bearer: ctx().data.keys.alpha.plaintext },
    );

    expect(response.status).toBe(200);

    const body = await jsonBody(response);

    expect(numberAt(body.from, "from")).toBe(NOW - 31 * DAY);
    expect(numberAt(body.to, "to")).toBe(NOW);
    expect(numberAt(body.total, "total")).toBe(8);
  });

  it("truncates fractional groups and clamps the limit", async () => {
    const bearer = ctx().data.keys.alpha.plaintext;

    const limited = await aggregate({ groupBy: "service", limit: 2 }, { bearer });

    expect(limited.status).toBe(200);

    const limitedBody = await jsonBody(limited);

    expect(arrayAt(limitedBody.groups, "groups")).toHaveLength(2);
    expect(limitedBody.truncated).toBe(true);

    const one = await aggregate({ groupBy: "service", limit: 1 }, { bearer });
    const oneBody = await jsonBody(one);

    expect(arrayAt(oneBody.groups, "groups")).toHaveLength(1);
    expect(oneBody.truncated).toBe(true);

    const exact = await aggregate({ groupBy: "service", limit: 4 }, { bearer });
    const exactBody = await jsonBody(exact);

    expect(arrayAt(exactBody.groups, "groups")).toHaveLength(4);
    expect(exactBody.truncated).toBeUndefined();

    const fallback = await aggregate({ groupBy: "service", limit: "not-a-number" }, { bearer });
    const fallbackBody = await jsonBody(fallback);

    expect(arrayAt(fallbackBody.groups, "groups")).toHaveLength(4);
    expect(fallbackBody.truncated).toBeUndefined();
  });

  it("rejects an invalid groupBy, filter, and range", async () => {
    const bearer = ctx().data.keys.alpha.plaintext;

    for (const groupBy of ["message", "fields", "service,level", ""]) {
      const response = await aggregate({ groupBy }, { bearer });

      expect(response.status).toBe(400);
      expect(errorOf(await jsonBody(response))).toContain("groupBy");
    }

    const longFilter = await aggregate({ q: "a".repeat(501) }, { bearer });

    expect(longFilter.status).toBe(400);
    expect(errorOf(await jsonBody(longFilter))).toContain("filter is too long");

    const inverted = await aggregate({ from: NOW, to: NOW - 1_000 }, { bearer });

    expect(inverted.status).toBe(400);
    expect(errorOf(await jsonBody(inverted))).toContain("from must be before to");

    const missing = await aggregate({ from: 0, to: NOW }, { bearer });

    expect(missing.status).toBe(400);
    expect(errorOf(await jsonBody(missing))).toContain("epoch milliseconds");
  });
});
