import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../../src/json.ts";
import { isJsonObject } from "../../src/json.ts";
import { errorOf, jsonBody } from "../helpers/body.ts";
import { request } from "../helpers/request.ts";
import type { TestRequestOptions } from "../helpers/request.ts";
import { seedApiKey, seedUser } from "../helpers/seed.ts";
import { createTestSession, signInUser } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";
import { SseReader } from "../helpers/sse.ts";

/**
 * `/v1/stream` contract: credential forms, project isolation, query filtering,
 * heartbeat revalidation, per-identity limits, and the bounded lifetime.
 * Fake timers are limited to the heartbeat and lifetime tests; event reads use
 * real conditions with a bounded wait.
 */

let session: TestSession | null = null;

function ctx(): TestSession {
  if (session === null) throw new Error("stream suite: test session missing");

  return session;
}

beforeAll(async () => {
  session = await createTestSession();
});

afterAll(async () => {
  await session?.close();
  session = null;
});

function streamUrl(key: string, extra = ""): string {
  return "/v1/stream?key=" + encodeURIComponent(key) + extra;
}

async function openStream(path: string, options: TestRequestOptions = {}): Promise<SseReader> {
  const response = await request(ctx().harness.app, path, options);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const reader = new SseReader(response);

  try {
    const connected = await reader.next();

    expect(connected?.comment).toBe("connected");

    return reader;
  } catch (err) {
    await reader.close();
    throw err;
  }
}

async function nextEvent(reader: SseReader): Promise<JsonObject> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const frame = await reader.next();

    if (frame === null) break;

    if (frame.data === null) continue;

    const parsed: unknown = JSON.parse(frame.data);

    if (!isJsonObject(parsed)) throw new Error("stream suite: event data is not an object");

    return parsed;
  }

  throw new Error("stream suite: expected a data frame before the stream closed");
}

async function expectClosed(reader: SseReader): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt++) {
    const frame = await reader.next(5_000);

    if (frame === null) return;
  }

  throw new Error("stream suite: stream did not close");
}

async function ingest(key: string, event: { message: string; level?: string }): Promise<void> {
  const response = await request(ctx().harness.app, "/v1/events", {
    method: "POST",
    body: event,
    bearer: key,
  });

  expect(response.status).toBe(200);
}

async function addToProject(userId: string, projectId: string): Promise<void> {
  const response = await request(ctx().harness.app, "/v1/projects/" + projectId + "/members", {
    method: "POST",
    body: { userId },
    cookies: ctx().adminJar,
  });

  if (response.status !== 201) {
    throw new Error(
      `stream suite: could not add ${userId} to project ${projectId} (status ${response.status})`,
    );
  }
}

async function disableUser(userId: string): Promise<void> {
  const response = await request(ctx().harness.app, "/v1/users/" + userId, {
    method: "PATCH",
    body: { disabled: true },
    cookies: ctx().adminJar,
  });

  expect(response.status).toBe(200);
}

describe("live stream authentication", () => {
  it("opens the stream for a cookie session", async () => {
    const test = ctx();

    const reader = await openStream("/v1/stream?project=" + test.data.projects.alpha.id, {
      cookies: test.memberJar,
    });

    // openStream asserts the 200, SSE content type, and "connected" frame.
    await reader.close();
  });

  it("opens the stream with the API key query parameter", async () => {
    const reader = await openStream(streamUrl(ctx().data.keys.alpha.plaintext));

    await reader.close();
  });

  it("rejects missing and unknown live-stream credentials", async () => {
    const { harness } = ctx();

    const missing = await request(harness.app, "/v1/stream");

    expect(missing.status).toBe(401);
    expect(errorOf(await jsonBody(missing))).toBe("unauthorized");

    const unknown = await request(harness.app, streamUrl("kl_not-a-real-key"));

    expect(unknown.status).toBe(401);
    expect(errorOf(await jsonBody(unknown))).toBe("unauthorized");
  });

  it("rejects an MCP key with the live-stream-specific error", async () => {
    const { harness, data } = ctx();
    const path = streamUrl(data.keys.mcp.plaintext);

    const viaQuery = await request(harness.app, path);

    expect(viaQuery.status).toBe(403);
    expect(errorOf(await jsonBody(viaQuery))).toBe("MCP keys cannot open the live stream");

    const viaBearer = await request(harness.app, "/v1/stream", {
      bearer: data.keys.mcp.plaintext,
    });

    expect(viaBearer.status).toBe(403);
    expect(errorOf(await jsonBody(viaBearer))).toBe("MCP keys cannot open the live stream");
  });

  it("rejects an API key without the query scope", async () => {
    const { harness, data } = ctx();

    const ingestOnly = await seedApiKey(harness.storage, {
      projectId: data.projects.alpha.id,
      name: "stream-ingest-only",
      scopes: ["ingest"],
      createdBy: harness.admin.id,
    });

    const response = await request(harness.app, streamUrl(ingestOnly.plaintext));

    expect(response.status).toBe(403);
    expect(errorOf(await jsonBody(response))).toBe("this key cannot query (missing query scope)");
  });
});

describe("live stream content", () => {
  it("keeps each project key's live stream to its own project", async () => {
    const { data } = ctx();
    const alphaReader = await openStream(streamUrl(data.keys.alpha.plaintext));
    let betaReader: SseReader | null = null;

    try {
      betaReader = await openStream(streamUrl(data.keys.beta.plaintext));

      // Interleave the projects: a leak would put the other project's message
      // between the two own-project frames.
      await ingest(data.keys.alpha.plaintext, { message: "alpha-one" });
      await ingest(data.keys.beta.plaintext, { message: "beta-one" });
      await ingest(data.keys.alpha.plaintext, { message: "alpha-two" });
      await ingest(data.keys.beta.plaintext, { message: "beta-two" });

      expect((await nextEvent(alphaReader)).message).toBe("alpha-one");
      expect((await nextEvent(alphaReader)).message).toBe("alpha-two");
      expect((await nextEvent(betaReader)).message).toBe("beta-one");
      expect((await nextEvent(betaReader)).message).toBe("beta-two");
    } finally {
      await alphaReader.close();
      await betaReader?.close();
    }
  });

  it("filters live events with the q grammar", async () => {
    const { data } = ctx();

    const reader = await openStream(
      streamUrl(data.keys.alpha.plaintext, "&q=" + encodeURIComponent("level>=error")),
    );

    try {
      await ingest(data.keys.alpha.plaintext, { message: "warn-live", level: "warn" });
      await ingest(data.keys.alpha.plaintext, { message: "error-live", level: "error" });

      expect((await nextEvent(reader)).message).toBe("error-live");
    } finally {
      await reader.close();
    }
  });
});

describe("live stream revalidation", () => {
  it("closes a disabled member's stream while a valid session stays open", async () => {
    const test = ctx();

    const target = await seedUser(test.harness.auth, test.harness.storage, {
      email: "stream-disabled@example.test",
      role: "member",
    });

    await addToProject(target.id, test.data.projects.alpha.id);

    const targetJar = await signInUser(test, target.email, target.password);
    let disabledReader: SseReader | null = null;
    let controlReader: SseReader | null = null;

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    try {
      disabledReader = await openStream("/v1/stream?project=" + test.data.projects.alpha.id, {
        cookies: targetJar,
      });
      controlReader = await openStream("/v1/stream?project=" + test.data.projects.alpha.id, {
        cookies: test.memberJar,
      });

      await disableUser(target.id);
      // Four heartbeat ticks (15s each) trigger the fresh-session revalidation.
      await vi.advanceTimersByTimeAsync(60_000);

      for (let tick = 0; tick < 4; tick++) {
        expect(await controlReader.nextComment()).toBe("ping");
      }

      // A fifth tick proves the control survived tick four's revalidation.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await controlReader.nextComment()).toBe("ping");

      await expectClosed(disabledReader);
    } finally {
      try {
        await disabledReader?.close();
        await controlReader?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("closes a revoked key's stream while another key stays open", async () => {
    const test = ctx();

    const revoked = await seedApiKey(test.harness.storage, {
      projectId: test.data.projects.alpha.id,
      name: "stream-revoked",
      scopes: ["query"],
      createdBy: test.harness.admin.id,
    });

    const control = await seedApiKey(test.harness.storage, {
      projectId: test.data.projects.alpha.id,
      name: "stream-control",
      scopes: ["query"],
      createdBy: test.harness.admin.id,
    });

    let revokedReader: SseReader | null = null;
    let controlReader: SseReader | null = null;

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    try {
      revokedReader = await openStream(streamUrl(revoked.plaintext));
      controlReader = await openStream(streamUrl(control.plaintext));

      const deleted = await request(
        test.harness.app,
        "/v1/keys/" + revoked.key.id + "?project=" + test.data.projects.alpha.id,
        { method: "DELETE", cookies: test.adminJar },
      );

      expect(deleted.status).toBe(200);
      expect(
        (await request(test.harness.app, "/v1/events", { bearer: revoked.plaintext })).status,
      ).toBe(401);

      await vi.advanceTimersByTimeAsync(60_000);

      for (let tick = 0; tick < 4; tick++) {
        expect(await controlReader.nextComment()).toBe("ping");
      }

      // A fifth tick proves the control survived tick four's revalidation.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await controlReader.nextComment()).toBe("ping");

      await expectClosed(revokedReader);
    } finally {
      try {
        await revokedReader?.close();
        await controlReader?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });
});

describe("live stream limits", () => {
  it("limits one identity to ten concurrent streams and releases the count on cancel", async () => {
    const test = ctx();

    const key = await seedApiKey(test.harness.storage, {
      projectId: test.data.projects.alpha.id,
      name: "stream-limit",
      scopes: ["query"],
      createdBy: test.harness.admin.id,
    });

    const readers: SseReader[] = [];

    try {
      for (let index = 0; index < 10; index++) {
        readers.push(await openStream(streamUrl(key.plaintext)));
      }

      const eleventh = await request(test.harness.app, streamUrl(key.plaintext));

      expect(eleventh.status).toBe(429);
      expect(errorOf(await jsonBody(eleventh))).toBe(
        "too many live streams for this account — close one and retry",
      );

      const released = readers.shift();

      if (released === undefined) throw new Error("stream suite: no reader to release");
      await released.close();

      // Cancellation releases the identity slot before close() resolves.
      readers.push(await openStream(streamUrl(key.plaintext)));
    } finally {
      for (const reader of readers) {
        try {
          await reader.close();
        } catch {
          // The server may have closed the stream first.
        }
      }
    }
  });
});

describe("live stream lifetime", () => {
  it("closes at the 30-minute bound and not before", async () => {
    const test = ctx();
    let reader: SseReader | null = null;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      reader = await openStream(streamUrl(test.data.keys.alpha.plaintext));

      await vi.advanceTimersByTimeAsync(29 * 60_000);
      await ingest(test.data.keys.alpha.plaintext, { message: "still-open-at-29-minutes" });
      expect((await nextEvent(reader)).message).toBe("still-open-at-29-minutes");

      await vi.advanceTimersByTimeAsync(60_000);
      await expectClosed(reader);
    } finally {
      try {
        await reader?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
