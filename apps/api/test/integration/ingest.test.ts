import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../../src/json.ts";
import {
  arrayAt,
  errorOf,
  jsonBody,
  messagesOf,
  numberAt,
  objectAt,
  stringAt,
} from "../helpers/body.ts";
import { createTestHarness } from "../helpers/harness.ts";
import type { TestHarness } from "../helpers/harness.ts";
import { request } from "../helpers/request.ts";
import { seedApiKey, seedProject, seedTestData } from "../helpers/seed.ts";
import type { SeededTestData } from "../helpers/seed.ts";

let harness: TestHarness | null = null;
let data: SeededTestData | null = null;

interface IngestContext {
  harness: TestHarness;
  data: SeededTestData;
}

function ctx(): IngestContext {
  if (harness === null || data === null) {
    throw new Error("ingest suite: harness was not created");
  }

  return { harness, data };
}

function queryString(filters: string): string {
  const seeded = ctx().data;

  return "/v1/events?q=" + encodeURIComponent(filters) + "&project=" + seeded.projects.alpha.id;
}

function findEvent(events: JsonValue[], message: string): JsonObject | null {
  for (const entry of events) {
    const event = objectAt(entry, "event");

    if (event.message === message) return event;
  }

  return null;
}

async function ingest(
  body: JsonValue | string,
  bearer: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return request(ctx().harness.app, "/v1/events", {
    method: "POST",
    body,
    bearer,
    headers,
  });
}

beforeAll(async () => {
  const created = await createTestHarness();

  try {
    const seeded = await seedTestData(created.storage, created.auth);

    const alpha = await request(created.app, "/v1/events", {
      method: "POST",
      body: {
        events: [
          {
            message: "Connection refused by upstream",
            level: "error",
            service: "api",
            env: "prod",
          },
          { message: "healthcheck ok", level: "info", service: "web", env: "prod" },
          { message: "timeout after 30s", level: "warn", service: "api", env: "staging" },
        ],
      },
      bearer: seeded.keys.alpha.plaintext,
    });

    const beta = await request(created.app, "/v1/events", {
      method: "POST",
      body: { message: "beta only event", level: "error" },
      bearer: seeded.keys.beta.plaintext,
    });

    if (alpha.status !== 200 || beta.status !== 200) {
      throw new Error("ingest suite: fixture ingest failed");
    }

    harness = created;
    data = seeded;
  } catch (err) {
    await created.close();
    throw err;
  }
});

afterAll(async () => {
  await harness?.close();
  harness = null;
  data = null;
});

describe("ingest formats", () => {
  it("accepts a single event and normalizes its fields", async () => {
    const { harness: test, data: seeded } = ctx();

    const response = await ingest(
      {
        msg: "single event",
        level: "warn",
        service: "API",
        env: "PROD",
        fields: { requestId: "r-1", nested: { ok: true } },
      },
      seeded.keys.alpha.plaintext,
    );

    expect(response.status).toBe(200);

    const body = await jsonBody(response);
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);

    const query = await request(test.app, "/v1/events?q=" + encodeURIComponent('"single event"'), {
      bearer: seeded.keys.alpha.plaintext,
    });

    expect(query.status).toBe(200);

    const events = arrayAt((await jsonBody(query)).events, "events");
    const event = findEvent(events, "single event");

    if (event === null) throw new Error("single event was not stored");
    expect(event.level).toBe(3);
    expect(event.service).toBe("api");
    expect(event.env).toBe("prod");
    expect(event.projectId).toBe(seeded.projects.alpha.id);
    expect(event.apiKeyId).toBe(seeded.keys.alpha.key.id);
    expect(stringAt(event.uid, "event.uid")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(objectAt(event.fields, "event.fields")).toEqual({
      requestId: "r-1",
      nested: { ok: true },
    });
  });

  it("accepts a JSON array and an { events } envelope", async () => {
    const { data: seeded } = ctx();

    const array = await ingest(
      [{ message: "array one" }, { message: "array two", level: 5 }],
      seeded.keys.alpha.plaintext,
    );

    expect(array.status).toBe(200);
    expect((await jsonBody(array)).accepted).toBe(2);

    const envelope = await ingest(
      { events: [{ message: "envelope one" }, { message: "envelope two", level: "debug" }] },
      seeded.keys.alpha.plaintext,
    );

    expect(envelope.status).toBe(200);
    expect((await jsonBody(envelope)).accepted).toBe(2);
  });

  it("accepts NDJSON and counts malformed lines", async () => {
    const { data: seeded } = ctx();
    const body = '{"message":"ndjson one"}\n{"message":"ndjson two"}\nnot-json\n';

    const response = await ingest(body, seeded.keys.alpha.plaintext, {
      "content-type": "application/x-ndjson",
    });

    expect(response.status).toBe(200);

    const parsed = await jsonBody(response);
    expect(parsed.accepted).toBe(2);
    expect(parsed.rejected).toBe(1);

    const invalid = await ingest('not-json\n{"nope":true}\n', seeded.keys.alpha.plaintext, {
      "content-type": "application/x-ndjson",
    });

    expect(invalid.status).toBe(422);

    const invalidBody = await jsonBody(invalid);
    expect(invalidBody.accepted).toBe(0);
    expect(invalidBody.rejected).toBe(2);
  });

  it("rejects invalid event shapes without dropping valid siblings", async () => {
    const { data: seeded } = ctx();

    const badFields = await ingest(
      { message: "bad fields", fields: [1, 2] },
      seeded.keys.alpha.plaintext,
    );

    expect(badFields.status).toBe(422);

    const badFieldsBody = await jsonBody(badFields);
    expect(badFieldsBody.accepted).toBe(0);
    expect(badFieldsBody.rejected).toBe(1);
    expect(arrayAt(badFieldsBody.errors, "errors")[0]).toContain("fields must be a JSON object");

    const missingMessage = await ingest({ level: "error" }, seeded.keys.alpha.plaintext);
    expect(missingMessage.status).toBe(422);

    const missingBody = await jsonBody(missingMessage);
    expect(missingBody.accepted).toBe(0);
    expect(missingBody.rejected).toBe(1);
    expect(arrayAt(missingBody.errors, "errors")[0]).toContain("missing message");

    const notAnObject = await ingest([42], seeded.keys.alpha.plaintext);
    expect(notAnObject.status).toBe(422);

    const notAnObjectBody = await jsonBody(notAnObject);
    expect(notAnObjectBody.accepted).toBe(0);
    expect(notAnObjectBody.rejected).toBe(1);
    expect(arrayAt(notAnObjectBody.errors, "errors")[0]).toContain("event must be an object");

    const mixed = await ingest(
      { events: [{ message: "valid sibling" }, { nope: true }] },
      seeded.keys.alpha.plaintext,
    );

    expect(mixed.status).toBe(200);

    const mixedBody = await jsonBody(mixed);
    expect(mixedBody.accepted).toBe(1);
    expect(mixedBody.rejected).toBe(1);
  });

  it("rejects a body above the 8 MiB ingest limit", async () => {
    const { data: seeded } = ctx();
    const oversized = "x".repeat(8 * 1024 * 1024 + 1);

    const response = await ingest(oversized, seeded.keys.alpha.plaintext, {
      "content-type": "application/json",
    });

    expect(response.status).toBe(413);
  });

  it("enforces the per-project byte quota cumulatively", async () => {
    const limited = await createTestHarness({ config: { maxProjectBytes: 20 } });

    try {
      const project = await seedProject(limited.storage, { name: "Quota" });

      const key = await seedApiKey(limited.storage, {
        projectId: project.id,
        name: "quota-key",
        scopes: ["ingest", "query"],
      });

      const first = await request(limited.app, "/v1/events", {
        method: "POST",
        body: { message: "first-ok" },
        bearer: key.plaintext,
      });

      expect(first.status).toBe(200);
      expect((await jsonBody(first)).accepted).toBe(1);

      // 8 stored bytes + a 20-byte message crosses the 20-byte cap.
      const second = await request(limited.app, "/v1/events", {
        method: "POST",
        body: { message: "second-event-payload" },
        bearer: key.plaintext,
      });

      expect(second.status).toBe(507);
      expect(errorOf(await jsonBody(second))).toContain("project storage limit reached");

      const stored = await request(limited.app, "/v1/events", { bearer: key.plaintext });
      const messages = messagesOf(await jsonBody(stored));

      expect(messages).toEqual(["first-ok"]);
      expect(messages).not.toContain("second-event-payload");
    } finally {
      await limited.close();
    }
  });

  it("enforces the per-project event-count quota", async () => {
    const limited = await createTestHarness({ config: { maxEventsPerProject: 1 } });

    try {
      const project = await seedProject(limited.storage, { name: "Count quota" });

      const key = await seedApiKey(limited.storage, {
        projectId: project.id,
        name: "count-key",
        scopes: ["ingest", "query"],
      });

      const first = await request(limited.app, "/v1/events", {
        method: "POST",
        body: { message: "first event" },
        bearer: key.plaintext,
      });

      expect(first.status).toBe(200);

      const second = await request(limited.app, "/v1/events", {
        method: "POST",
        body: { message: "second event" },
        bearer: key.plaintext,
      });

      expect(second.status).toBe(429);
      expect(errorOf(await jsonBody(second))).toContain("project event limit reached");

      const stored = await request(limited.app, "/v1/events", { bearer: key.plaintext });
      const messages = messagesOf(await jsonBody(stored));

      expect(messages).toEqual(["first event"]);
      expect(messages).not.toContain("second event");
    } finally {
      await limited.close();
    }
  });
});

describe("query filters", () => {
  it("filters by level, service, env, phrase, and exclusion", async () => {
    const { harness: test, data: seeded } = ctx();
    const bearer = seeded.keys.alpha.plaintext;

    const warn = await request(test.app, queryString("level>=warn"), { bearer });
    expect(warn.status).toBe(200);

    const warnMessages = messagesOf(await jsonBody(warn));
    expect(warnMessages).toContain("Connection refused by upstream");
    expect(warnMessages).toContain("timeout after 30s");
    expect(warnMessages).not.toContain("healthcheck ok");

    const service = await request(test.app, queryString("service:api"), { bearer });
    const serviceMessages = messagesOf(await jsonBody(service));
    expect(serviceMessages).toContain("Connection refused by upstream");
    expect(serviceMessages).toContain("timeout after 30s");
    expect(serviceMessages).not.toContain("healthcheck ok");

    const env = await request(test.app, queryString("env:prod"), { bearer });
    const envMessages = messagesOf(await jsonBody(env));
    expect(envMessages).toContain("Connection refused by upstream");
    expect(envMessages).toContain("healthcheck ok");
    expect(envMessages).not.toContain("timeout after 30s");

    const phraseSeed = await ingest(
      { message: "connection reset by peer", level: "warn", service: "api", env: "prod" },
      bearer,
    );

    expect(phraseSeed.status).toBe(200);

    const phrase = await request(test.app, queryString('"connection refused"'), { bearer });
    const phraseMessages = messagesOf(await jsonBody(phrase));
    expect(phraseMessages).toContain("Connection refused by upstream");
    expect(phraseMessages).not.toContain("connection reset by peer");
    expect(phraseMessages).not.toContain("timeout after 30s");

    const excluded = await request(test.app, queryString("-healthcheck"), { bearer });
    const excludedMessages = messagesOf(await jsonBody(excluded));
    expect(excludedMessages).not.toContain("healthcheck ok");
    expect(excludedMessages).toContain("Connection refused by upstream");

    const levelError = await request(test.app, queryString("level:error"), { bearer });
    const errorMessages = messagesOf(await jsonBody(levelError));
    expect(errorMessages).toContain("Connection refused by upstream");
    expect(errorMessages).not.toContain("timeout after 30s");
  });

  it("filters by the ingesting API key and stays inside the project", async () => {
    const { harness: test, data: seeded } = ctx();

    const second = await seedApiKey(test.storage, {
      projectId: seeded.projects.alpha.id,
      name: "alpha-second",
      scopes: ["ingest", "query"],
    });

    const secondIngest = await ingest({ message: "second alpha key event" }, second.plaintext);

    expect(secondIngest.status).toBe(200);

    const alphaFiltered = await request(
      test.app,
      "/v1/events?q=" + encodeURIComponent("key:" + seeded.keys.alpha.key.id),
      { bearer: seeded.keys.alpha.plaintext },
    );

    expect(alphaFiltered.status).toBe(200);

    const alphaMessages = messagesOf(await jsonBody(alphaFiltered));
    expect(alphaMessages).toContain("Connection refused by upstream");
    expect(alphaMessages).not.toContain("second alpha key event");
    expect(alphaMessages).not.toContain("beta only event");

    const secondFiltered = await request(
      test.app,
      "/v1/events?q=" + encodeURIComponent("key:" + second.key.id),
      { bearer: seeded.keys.alpha.plaintext },
    );

    expect(secondFiltered.status).toBe(200);

    const secondMessages = messagesOf(await jsonBody(secondFiltered));
    expect(secondMessages).toContain("second alpha key event");
    expect(secondMessages).not.toContain("Connection refused by upstream");
  });

  it("rejects an over-long filter expression", async () => {
    const { harness: test, data: seeded } = ctx();

    const response = await request(test.app, "/v1/events?q=" + "a".repeat(501), {
      bearer: seeded.keys.alpha.plaintext,
    });

    expect(response.status).toBe(400);
    expect(errorOf(await jsonBody(response))).toContain("filter is too long");
  });

  it("paginates with a descending cursor", async () => {
    const { harness: test, data: seeded } = ctx();
    const bearer = seeded.keys.alpha.plaintext;

    const ingestResponse = await ingest(
      { events: [{ message: "page one" }, { message: "page two" }, { message: "page three" }] },
      bearer,
    );

    expect(ingestResponse.status).toBe(200);

    const first = await request(
      test.app,
      "/v1/events?q=" + encodeURIComponent('"page"') + "&limit=2",
      { bearer },
    );

    expect(first.status).toBe(200);

    const firstBody = await jsonBody(first);
    const firstMessages = messagesOf(firstBody);

    expect(firstMessages).toHaveLength(2);
    expect(firstMessages).toEqual(["page three", "page two"]);

    const cursor = numberAt(firstBody.nextCursor, "nextCursor");

    const second = await request(
      test.app,
      "/v1/events?q=" + encodeURIComponent('"page"') + "&limit=2&cursor=" + cursor,
      { bearer },
    );

    expect(second.status).toBe(200);
    expect(messagesOf(await jsonBody(second))).toEqual(["page one"]);
  });
});
