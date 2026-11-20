import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { importArchive } from "../../src/archive/import.js";
import { ArchiveError } from "../../src/archive/types.js";
import type { ArchiveLine } from "../../src/archive/types.js";
import { uuidv7 } from "../../src/auth/ids.js";
import * as schema from "../../src/storage/schema.js";
import { InMemoryBackupStore } from "../helpers/backup-store.js";
import { arrayAt, jsonBody, objectAt, stringAt } from "../helpers/body.js";
import { createTestHarness } from "../helpers/harness.js";
import type { TestHarness } from "../helpers/harness.js";
import { request } from "../helpers/request.js";
import { seedApiKey, seedProject } from "../helpers/seed.js";

const PART_DATE = "2026-01-15";

let harness: TestHarness | null = null;

beforeAll(async () => {
  harness = await createTestHarness();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await harness?.close();
  harness = null;
});

function current(): TestHarness {
  if (harness === null) throw new Error("archive import suite: harness missing");

  return harness;
}

function makeLine(projectId: string, overrides: Partial<ArchiveLine> = {}): string {
  const line: ArchiveLine = {
    v: 1,
    uid: uuidv7(),
    sourceId: 1,
    projectId,
    ts: Date.now() - 60_000,
    level: "info",
    service: null,
    env: null,
    message: "archived event",
    fields: null,
    ...overrides,
  };

  return JSON.stringify(line);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function partKey(projectId: string, prefix: string, hashPrefix: string): string {
  return (
    `${prefix}/archive/events/project=${projectId}/date=${PART_DATE}/` +
    `part-1-1-1-${hashPrefix}.ndjson.zst`
  );
}

interface StoredPart {
  key: string;
  compressed: Buffer;
}

/**
 * Seed one zstd part. The key commits to the first 12 hex characters of the
 * uncompressed NDJSON digest, exactly like the export pipeline.
 */
function storePart(
  store: InMemoryBackupStore,
  projectId: string,
  lines: readonly string[],
  hashPrefix?: string,
): StoredPart {
  const ndjson = `${lines.join("\n")}\n`;
  const digest = sha256(ndjson);
  const compressed = zstdCompressSync(Buffer.from(ndjson, "utf8"));
  const key = partKey(projectId, store.prefix, hashPrefix ?? digest.slice(0, 12));

  store.putObject(key, compressed);

  return { key, compressed };
}

/** The importer downloads through the presigned URL; keep it on a fake. */
function stubDownload(body: Buffer): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async (): Promise<Response> => new Response(new Uint8Array(body), { status: 200 }),
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

async function signedUrl(store: InMemoryBackupStore, key: string): Promise<string> {
  const filename = key.slice(key.lastIndexOf("/") + 1);

  return (await store.presignDownload(key, filename)).url;
}

async function archiveErrorOf(action: Promise<unknown>): Promise<ArchiveError> {
  try {
    await action;
  } catch (cause) {
    if (cause instanceof ArchiveError) return cause;

    throw cause;
  }

  throw new Error("expected the archive operation to fail");
}

async function newProject(name: string): Promise<string> {
  const project = await seedProject(current().storage, { name: `${name}-${uuidv7()}` });

  return project.id;
}

async function eventCount(projectId: string): Promise<number> {
  const rows = await current()
    .storage.db.select({ id: schema.events.id })
    .from(schema.events)
    .where(eq(schema.events.projectId, projectId));

  return rows.length;
}

describe("archive import integrity", () => {
  it("rejects a part whose digest differs from the cached archive row", async () => {
    const { storage } = current();
    const projectId = await newProject("cached-checksum");
    const store = new InMemoryBackupStore();
    const part = storePart(store, projectId, [makeLine(projectId)]);

    await storage.db.insert(schema.archiveParts).values({
      id: uuidv7(),
      projectId,
      date: PART_DATE,
      firstId: 1,
      lastId: 1,
      eventCount: 1,
      objectKey: part.key,
      sha256: "b".repeat(64),
      sizeBytes: part.compressed.length,
      createdAt: Date.now(),
    });

    const fetchMock = stubDownload(part.compressed);

    const error = await archiveErrorOf(
      importArchive(storage, {
        projectId,
        dataDir: current().config.dataDir,
        s3: store,
      }),
    );

    expect(error.status).toBe(502);
    expect(error.message).toBe("archive object checksum did not match the cached part");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(await signedUrl(store, part.key));
    expect(await eventCount(projectId)).toBe(0);
  });

  it("rejects an uncached part whose key prefix does not match its digest", async () => {
    const { storage } = current();
    const projectId = await newProject("key-checksum");
    const store = new InMemoryBackupStore();
    const part = storePart(store, projectId, [makeLine(projectId)], "deadbeef0000");

    stubDownload(part.compressed);

    const error = await archiveErrorOf(
      importArchive(storage, {
        projectId,
        dataDir: current().config.dataDir,
        s3: store,
      }),
    );

    expect(error.status).toBe(502);
    expect(error.message).toBe("archive object checksum did not match its key");
    expect(await eventCount(projectId)).toBe(0);
  });
});

describe("archive import validation", () => {
  it("skips an oversized message and oversized fields without dropping valid rows", async () => {
    const { storage } = current();
    const projectId = await newProject("oversized");
    const store = new InMemoryBackupStore();
    const validUid = uuidv7();

    const part = storePart(store, projectId, [
      makeLine(projectId, { message: "m".repeat(8_001) }),
      makeLine(projectId, { fields: { blob: "x".repeat(33_000) } }),
      makeLine(projectId, { uid: validUid, message: "kept" }),
    ]);

    stubDownload(part.compressed);

    const result = await importArchive(storage, {
      projectId,
      dataDir: current().config.dataDir,
      s3: store,
    });

    expect(result).toEqual({ imported: 1, skipped: 2 });

    const rows = await storage.db
      .select({ uid: schema.events.uid, message: schema.events.message })
      .from(schema.events)
      .where(eq(schema.events.projectId, projectId));

    expect(rows).toEqual([{ uid: validUid, message: "kept" }]);
  });

  it("rejects malformed and inverted import dates before listing objects", async () => {
    const { config, storage } = current();
    const projectId = await newProject("dates");
    const store = new InMemoryBackupStore();
    const listSpy = vi.spyOn(store, "listObjects");
    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    for (const bounds of [
      { from: "2026-02-31" },
      { to: "not-a-date" },
      { from: "2026-03-02", to: "2026-03-01" },
    ]) {
      const error = await archiveErrorOf(
        importArchive(storage, {
          projectId,
          ...bounds,
          dataDir: config.dataDir,
          s3: store,
        }),
      );

      expect(error.status).toBe(400);
    }

    expect(listSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects archive rows for another project instead of importing them", async () => {
    const { storage } = current();
    const projectId = await newProject("cross-project");
    const otherProjectId = await newProject("cross-project-other");
    const store = new InMemoryBackupStore();

    const validLines = Array.from({ length: 501 }, (_, index) =>
      makeLine(projectId, { sourceId: index + 1, message: `valid-${index}` }),
    );

    const part = storePart(store, projectId, [
      ...validLines,
      makeLine(otherProjectId, { message: "other project" }),
    ]);

    stubDownload(part.compressed);

    const error = await archiveErrorOf(
      importArchive(storage, {
        projectId,
        dataDir: current().config.dataDir,
        s3: store,
      }),
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe("archive object contains events for another project");

    expect(await eventCount(projectId)).toBe(0);
    expect(await eventCount(otherProjectId)).toBe(0);
  });
});

describe("archive ingest contract", () => {
  it("rejects an array fields value at ingest while keeping valid siblings", async () => {
    const { app, storage } = current();
    const project = await seedProject(storage, { name: `array-fields-${uuidv7()}` });

    const key = await seedApiKey(storage, {
      projectId: project.id,
      name: "array-fields-ingest",
      scopes: ["ingest", "query"],
    });

    const rejected = await request(app, "/v1/events", {
      method: "POST",
      body: { message: "bad fields", fields: [1, 2, 3] },
      bearer: key.plaintext,
    });

    expect(rejected.status).toBe(422);

    const rejectedBody = await jsonBody(rejected);

    expect(rejectedBody.accepted).toBe(0);
    expect(rejectedBody.rejected).toBe(1);
    expect(arrayAt(rejectedBody.errors, "errors")[0]).toContain("fields must be a JSON object");

    const mixed = await request(app, "/v1/events", {
      method: "POST",
      body: {
        events: [
          { message: "valid sibling", fields: { ok: true } },
          { message: "array sibling", fields: [{ nope: true }] },
        ],
      },
      bearer: key.plaintext,
    });

    expect(mixed.status).toBe(200);

    const mixedBody = await jsonBody(mixed);

    expect(mixedBody.accepted).toBe(1);
    expect(mixedBody.rejected).toBe(1);

    const stored = await request(app, "/v1/events", { bearer: key.plaintext });

    expect(stored.status).toBe(200);

    const events = arrayAt((await jsonBody(stored)).events, "events");

    expect(events).toHaveLength(1);

    const event = objectAt(events[0], "event");

    expect(stringAt(event.message, "message")).toBe("valid sibling");
  });
});
