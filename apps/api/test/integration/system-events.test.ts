import fs from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../../src/auth/ids.ts";
import { publishSystemEvent } from "../../src/system-events.ts";
import {
  RESTORE_MARKER_FORMAT,
  restorePaths,
  writeRestoreMarker,
} from "../../src/restore/marker.ts";
import { isFiniteNumber, isJsonObject } from "../../src/json.ts";
import type { JsonObject } from "../../src/json.ts";
import * as schema from "../../src/storage/schema.ts";
import { errorOf, jsonBody, objectAt } from "../helpers/body.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";
import { request } from "../helpers/request.ts";
import { SseReader } from "../helpers/sse.ts";
import type { SseFrame } from "../helpers/sse.ts";

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

  it("keeps an admin stream open across the same heartbeat window", async () => {
    const test = current();
    let reader: SseReader | null = null;

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    try {
      reader = await openEvents(test.adminJar);

      expect((await reader.next())?.event).toBe("system.status");

      vi.advanceTimersByTime(60_000);

      for (let tick = 0; tick < 4; tick++) {
        const frame = await reader.next();

        expect(frame?.comment).toBe("ping");
      }

      await expect(reader.next(300)).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
      await reader?.close();
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
