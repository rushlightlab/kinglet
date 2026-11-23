import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { startArchiveEngine } from "../../src/archive/engine.ts";
import type { ArchiveEngine } from "../../src/archive/engine.ts";
import type { BackupUploadInput } from "../../src/backups/s3.ts";
import type { BackupConfig } from "../../src/env.ts";
import { projectKeyOf } from "../../src/storage/project-keys.ts";
import * as schema from "../../src/storage/schema.ts";
import { InMemoryBackupStore } from "../helpers/backup-store.ts";
import { createTestHarness } from "../helpers/harness.ts";
import type { TestHarness } from "../helpers/harness.ts";
import { seedProject } from "../helpers/seed.ts";

const BACKUP: BackupConfig = {
  bucket: "kinglet-test",
  endpoint: "http://127.0.0.1:9",
  region: "auto",
  accessKeyId: "dummy-access-key",
  secretAccessKey: "dummy-secret-key",
  prefix: "kinglet-test",
  forcePathStyle: true,
  sse: "none",
  partSizeBytes: 8 * 1024 * 1024,
  allowUnsignedManifests: false,
  allowUnencryptedSnapshots: false,
  maxSnapshotBytes: 1024 * 1024 * 1024,
};

/** Holds every part upload until `release` is called. */
class GatedStore extends InMemoryBackupStore {
  uploading: Promise<void>;
  private started: () => void = () => {};
  private gate: Promise<void>;
  release: () => void = () => {};

  constructor() {
    super();
    this.uploading = new Promise((resolve) => {
      this.started = resolve;
    });
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  override async uploadFile(input: BackupUploadInput): Promise<void> {
    this.started();
    await this.gate;
    await super.uploadFile(input);
  }
}

let harness: TestHarness | null = null;
let engine: ArchiveEngine | null = null;

afterEach(async () => {
  engine?.stop();
  engine = null;
  await harness?.close();
  harness = null;
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("archive fence suite: condition not reached");
}

describe("archive fence", () => {
  it("drops a part whose upload overlapped a clear, instead of recording it", async () => {
    harness = await createTestHarness();
    const { storage } = harness;
    const config = { ...harness.config, backup: BACKUP };
    const store = new GatedStore();
    const project = await seedProject(storage, { name: "fenced" });

    engine = startArchiveEngine({ storage, config, store });
    await engine.updateSettings({ enabled: true });
    await engine.setProjectEnabled(project.id, true);

    // Older than retention, so the run picks it up.
    await storage.insertEvents(
      project.id,
      [
        {
          ts: Date.now() - (config.retentionDays + 2) * 86_400_000,
          level: 2,
          service: null,
          env: null,
          message: "expired and being cleared",
          fields: null,
        },
      ],
      null,
    );

    await engine.run(project.id);
    await store.uploading;

    // The clear starts while the part upload is in flight.
    const fence = engine.fenceProject(project.id);

    store.release();

    const release = await fence;

    try {
      expect(store.keys().filter((key) => key.includes("/archive/"))).toEqual([]);

      const parts = await storage.db
        .select({ id: schema.archiveParts.id })
        .from(schema.archiveParts)
        .where(eq(schema.archiveParts.projectId, project.id));

      expect(parts).toEqual([]);
    } finally {
      release();
    }

    // The run gave up on the project without deleting its rows; the caller's
    // clear owns them.
    await waitFor(async () => !(await engine?.status())?.running);

    const rows = await storage.db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.projectKey, projectKeyOf(project.id)));

    expect(rows).toHaveLength(1);
  });
});
