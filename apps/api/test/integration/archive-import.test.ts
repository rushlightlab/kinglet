import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { importArchive } from "../../src/archive/import.ts";
import { ArchiveError } from "../../src/archive/types.ts";
import type { ArchiveLine } from "../../src/archive/types.ts";
import { uuidv7 } from "../../src/auth/ids.ts";
import { createStorage } from "../../src/storage/index.ts";
import { projectKeyOf } from "../../src/storage/project-keys.ts";
import * as schema from "../../src/storage/schema.ts";
import { InMemoryBackupStore } from "../helpers/backup-store.ts";
import { arrayAt, jsonBody, objectAt, stringAt } from "../helpers/body.ts";
import { createTestHarness } from "../helpers/harness.ts";
import type { TestHarness } from "../helpers/harness.ts";
import { request } from "../helpers/request.ts";
import { seedApiKey, seedProject } from "../helpers/seed.ts";

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

interface FramedPart {
  key: string;
  firstFrame: Buffer;
  secondFrame: Buffer;
}

/** Two zstd frames so a test can pause halfway through the download. */
function storeFramedPart(
  store: InMemoryBackupStore,
  projectId: string,
  firstLines: readonly string[],
  secondLines: readonly string[],
): FramedPart {
  const firstNdjson = `${firstLines.join("\n")}\n`;
  const secondNdjson = `${secondLines.join("\n")}\n`;
  const digest = sha256(firstNdjson + secondNdjson);
  const firstFrame = zstdCompressSync(Buffer.from(firstNdjson, "utf8"));
  const secondFrame = zstdCompressSync(Buffer.from(secondNdjson, "utf8"));
  const key = partKey(projectId, store.prefix, digest.slice(0, 12));

  store.putObject(key, Buffer.concat([firstFrame, secondFrame]));

  return { key, firstFrame, secondFrame };
}

interface GatedDownload {
  response: Response;
  firstPull: Promise<void>;
  release(): void;
}

/** A streaming response that sends one frame, pauses, then sends the rest. */
function gatedDownload(firstFrame: Buffer, secondFrame: Buffer): GatedDownload {
  let releaseGate: (() => void) | null = null;

  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  let signalFirstPull: (() => void) | null = null;

  const firstPull = new Promise<void>((resolve) => {
    signalFirstPull = resolve;
  });

  let step = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (step === 0) {
        step = 1;
        controller.enqueue(new Uint8Array(firstFrame));
        signalFirstPull?.();
        await gate;
        controller.enqueue(new Uint8Array(secondFrame));

        return;
      }

      controller.close();
    },
  });

  return {
    response: new Response(stream, { status: 200 }),
    firstPull,
    release: () => releaseGate?.(),
  };
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
    .where(eq(schema.events.projectKey, projectKeyOf(projectId)));

  return rows.length;
}

/** Names left under `<dataDir>/tmp`; [] when the root does not exist. */
function spoolEntries(dataDir: string): string[] {
  const root = path.join(dataDir, "tmp");

  return fs.existsSync(root) ? fs.readdirSync(root) : [];
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

  it("rejects a part whose decompressed NDJSON exceeds the spool cap", async () => {
    const { config, storage } = current();
    const projectId = await newProject("spool-cap");
    const store = new InMemoryBackupStore();

    const part = storePart(store, projectId, [
      makeLine(projectId, { message: "a".repeat(2_000) }),
      makeLine(projectId, { message: "b".repeat(2_000) }),
    ]);

    stubDownload(part.compressed);

    const error = await archiveErrorOf(
      importArchive(storage, {
        projectId,
        dataDir: config.dataDir,
        s3: store,
        // Injected so the cap is exercised without a 1 GiB fixture.
        maxSpoolBytes: 1_000,
      }),
    );

    expect(error.status).toBe(413);
    expect(error.message).toBe("archive part is too large to import");
    expect(await eventCount(projectId)).toBe(0);

    const leftovers = spoolEntries(config.dataDir);

    expect(leftovers.filter((name) => name.startsWith("archive-import-"))).toEqual([]);
  });

  it("rejects a part whose downloaded bytes are not valid zstd", async () => {
    const { config, storage } = current();
    const projectId = await newProject("corrupt-zstd");
    const store = new InMemoryBackupStore();
    const key = partKey(projectId, store.prefix, "deadbeef0000");
    const corrupt = Buffer.from("this is not a zstd frame", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    store.putObject(key, corrupt);
    stubDownload(corrupt);

    try {
      const error = await archiveErrorOf(
        importArchive(storage, {
          projectId,
          dataDir: config.dataDir,
          s3: store,
        }),
      );

      expect(error.status).toBe(500);
      expect(error.message).toBe("archive import failed");
      expect(error.message).not.toContain("zstd");
      expect(await eventCount(projectId)).toBe(0);
      expect(spoolEntries(config.dataDir)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
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

  it("rejects a part with a line too long to hold in memory", async () => {
    const { config, storage } = current();
    const projectId = await newProject("long-line");
    const store = new InMemoryBackupStore();

    const part = storePart(store, projectId, [
      makeLine(projectId, { message: "a".repeat(300 * 1024) }),
    ]);

    stubDownload(part.compressed);

    const error = await archiveErrorOf(
      importArchive(storage, { projectId, dataDir: config.dataDir, s3: store }),
    );

    expect(error.status).toBe(413);
    expect(error.message).toBe("archive part has a line that is too long to import");
    expect(await eventCount(projectId)).toBe(0);
  });

  it("refuses an unencrypted part while a passphrase is configured", async () => {
    const { config, storage } = current();
    const projectId = await newProject("plaintext-with-passphrase");
    const store = new InMemoryBackupStore();
    const part = storePart(store, projectId, [makeLine(projectId)]);

    stubDownload(part.compressed);

    const error = await archiveErrorOf(
      importArchive(storage, {
        projectId,
        dataDir: config.dataDir,
        passphrase: "dummy-operator-passphrase",
        s3: store,
      }),
    );

    expect(error.status).toBe(409);
    expect(error.message).toMatch(/not age-encrypted/);
    expect(await eventCount(projectId)).toBe(0);
  });

  it("imports an unencrypted legacy part when the operator allows it", async () => {
    const { config, storage } = current();
    const projectId = await newProject("plaintext-allowed");
    const store = new InMemoryBackupStore();
    const part = storePart(store, projectId, [makeLine(projectId)]);

    stubDownload(part.compressed);

    const result = await importArchive(storage, {
      projectId,
      dataDir: config.dataDir,
      passphrase: "dummy-operator-passphrase",
      allowUnencrypted: true,
      s3: store,
    });

    expect(result.imported).toBe(1);
  });
});

describe("archive import locking", () => {
  it("does not hold a write transaction while the download is pending", async () => {
    const { config, storage } = current();
    const projectId = await newProject("download-lock");
    const otherProjectId = await newProject("download-lock-other");
    const store = new InMemoryBackupStore();

    const firstLines = Array.from({ length: 1_000 }, (_, index) =>
      makeLine(projectId, { sourceId: index + 1, message: `first-frame-${index}` }),
    );

    const part = storeFramedPart(store, projectId, firstLines, [
      makeLine(projectId, { message: "second-frame" }),
    ]);

    const gated = gatedDownload(part.firstFrame, part.secondFrame);
    const fetchMock = vi.fn(async (): Promise<Response> => gated.response);

    vi.stubGlobal("fetch", fetchMock);

    const concurrent = await createStorage({ kind: "sqlite", dbPath: config.dbPath });

    // A second connection must not block behind an import-held SQLite lock.
    await concurrent.client.execute("PRAGMA busy_timeout = 0");

    const importPromise = importArchive(storage, {
      projectId,
      dataDir: config.dataDir,
      s3: store,
    });

    try {
      await gated.firstPull;

      // The first frame is buffered but the part is not verified until the
      // download finishes, so no rows may exist while the gate is held.
      expect(await eventCount(projectId)).toBe(0);

      const written = await concurrent.insertEvents(
        otherProjectId,
        [
          {
            ts: Date.now() - 1_000,
            level: 2,
            service: null,
            env: null,
            message: "concurrent-write",
            fields: null,
          },
        ],
        null,
      );

      expect(written).toHaveLength(1);

      gated.release();

      const result = await importPromise;

      expect(result).toEqual({ imported: 1_001, skipped: 0 });
      expect(await eventCount(projectId)).toBe(1_001);

      const otherRows = await concurrent.db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.projectKey, projectKeyOf(otherProjectId)));

      expect(otherRows).toHaveLength(1);
      expect(fs.readdirSync(path.join(config.dataDir, "tmp"))).toEqual([]);
    } finally {
      gated.release();
      await importPromise.catch(() => {});
      await concurrent.close();
    }
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
      .where(eq(schema.events.projectKey, projectKeyOf(projectId)));

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
