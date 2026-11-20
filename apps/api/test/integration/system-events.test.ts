import fs from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../../src/auth/ids.js";
import { publishSystemEvent } from "../../src/system-events.js";
import {
  RESTORE_MARKER_FORMAT,
  restorePaths,
  writeRestoreMarker,
} from "../../src/restore/marker.js";
import { isFiniteNumber, isJsonObject } from "../../src/json.js";
import type { JsonObject } from "../../src/json.js";
import * as schema from "../../src/storage/schema.js";
import { errorOf, jsonBody, objectAt } from "../helpers/body.js";
import { createTestSession } from "../helpers/session.js";
import type { TestSession } from "../helpers/session.js";
import { request } from "../helpers/request.js";

interface SseFrame {
  event: string | null;
  data: string | null;
  comment: string | null;
}

let session: TestSession | null = null;

beforeAll(async () => {
  session = await createTestSession();
});

afterAll(async () => {
  await session?.close();
  session = null;
});

function current(): TestSession {
  if (session === null) throw new Error("system events suite: fixture missing");

  return session;
}

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private closed = false;

  constructor(response: Response) {
    if (response.body === null) throw new Error("system events suite: SSE response has no body");

    this.reader = response.body.getReader();
  }

  /** Next complete frame, or null once the server closes the stream. */
  async next(timeoutMs = 5_000): Promise<SseFrame | null> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");

      if (boundary >= 0) {
        const raw = this.buffer.slice(0, boundary);

        this.buffer = this.buffer.slice(boundary + 2);

        return parseFrame(raw);
      }

      if (this.closed) return null;

      const remaining = deadline - Date.now();

      if (remaining <= 0)
        throw new Error("system events suite: timed out waiting for an SSE frame");

      const chunk = await readChunk(this.reader, remaining);

      if (chunk === null) {
        this.closed = true;
        continue;
      }

      this.buffer += this.decoder.decode(chunk, { stream: true });
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // The server may have closed the stream first.
    }

    // Let the stream callback's finally block unsubscribe from the bus.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      reader.read().then((result) => (result.done ? null : result.value)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("system events suite: SSE read timed out")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseFrame(raw: string): SseFrame {
  const comments: string[] = [];
  const data: string[] = [];
  let event: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      comments.push(line.slice(1).trim());
    } else if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  return {
    event,
    data: data.length > 0 ? data.join("\n") : null,
    comment: comments.length > 0 ? comments.join("\n") : null,
  };
}

async function openEvents(jar: { header(): string }): Promise<SseReader> {
  const response = await request(current().harness.app, "/v1/system/events", {
    cookies: jar.header(),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("x-accel-buffering")).toBe("no");

  return new SseReader(response);
}

function eventData(frame: SseFrame): JsonObject {
  if (frame.data === null) throw new Error("system events suite: frame has no data");

  const parsed: unknown = JSON.parse(frame.data);

  if (!isJsonObject(parsed)) throw new Error("system events suite: frame data is not an object");

  return parsed;
}

function requireFrame(frame: SseFrame | null): SseFrame {
  if (frame === null) throw new Error("system events suite: stream closed before the frame");

  return frame;
}

describe("system event authorization", () => {
  it("rejects unauthenticated callers and machine keys", async () => {
    const test = current();

    const anonymous = await request(test.harness.app, "/v1/system/events");

    expect(anonymous.status).toBe(401);

    for (const key of [test.data.keys.alpha.plaintext, test.data.keys.mcp.plaintext]) {
      const machine = await request(test.harness.app, "/v1/system/events", { bearer: key });

      expect(machine.status).toBe(403);
      expect(errorOf(await jsonBody(machine))).toBe("forbidden");
    }
  });

  it("rejects member and viewer sessions", async () => {
    const test = current();

    for (const jar of [test.memberJar, test.viewerJar]) {
      const response = await request(test.harness.app, "/v1/system/events", {
        cookies: jar.header(),
      });

      expect(response.status).toBe(403);
      expect(errorOf(await jsonBody(response))).toBe("forbidden");
    }
  });
});

describe("system event stream contract", () => {
  it("opens for an admin with a status frame carrying the staged restore id", async () => {
    const test = current();
    const pendingPath = restorePaths(test.harness.config.dataDir).pendingPath;
    const snapshotId = uuidv7();

    await writeRestoreMarker(pendingPath, {
      format: RESTORE_MARKER_FORMAT,
      snapshotId,
      source: "snapshot",
      stagedAt: Date.now(),
      requestedBy: test.harness.admin.id,
    });

    const reader = await openEvents(test.adminJar);

    try {
      const frame = await reader.next();

      expect(frame?.event).toBe("system.status");

      const data = eventData(requireFrame(frame));
      const backup = objectAt(data.backup, "backup");
      const archive = objectAt(data.archive, "archive");

      expect(backup.restoreStagedId).toBe(snapshotId);
      expect(backup.configured).toBe(false);
      expect(archive.enabled).toBe(false);
    } finally {
      await reader.close();
      await fs.promises.rm(pendingPath, { force: true });
    }
  });

  it("frames named system events with their event name and payload", async () => {
    const test = current();
    const reader = await openEvents(test.adminJar);

    try {
      const status = await reader.next();

      expect(status?.event).toBe("system.status");

      const id = uuidv7();

      publishSystemEvent({ type: "restore.staged", data: { id } });

      const frame = await reader.next();

      expect(frame?.event).toBe("restore.staged");

      const data = eventData(requireFrame(frame));

      expect(data.id).toBe(id);
      expect(isFiniteNumber(data.at)).toBe(true);
    } finally {
      await reader.close();
    }
  });

  it("closes a demoted admin's stream when the heartbeat revalidates the session", async () => {
    const test = current();
    let reader: SseReader | null = null;

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    try {
      reader = await openEvents(test.adminJar);

      expect((await reader.next())?.event).toBe("system.status");

      await test.harness.storage.db
        .update(schema.user)
        .set({ role: "viewer" })
        .where(eq(schema.user.id, test.harness.admin.id));

      // Four heartbeat ticks (15s each) trigger the fresh-session revalidation.
      vi.advanceTimersByTime(60_000);

      let closed = false;

      for (let attempt = 0; attempt < 12; attempt++) {
        const frame = await reader.next(5_000);

        if (frame === null) {
          closed = true;
          break;
        }
      }

      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();

      await test.harness.storage.db
        .update(schema.user)
        .set({ role: "admin" })
        .where(eq(schema.user.id, test.harness.admin.id));

      await reader?.close();
    }
  });
});
