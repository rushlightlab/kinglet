import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteArchivedProjectObjects } from "../../src/archive/cleanup.js";
import { uuidv7 } from "../../src/auth/ids.js";
import * as schema from "../../src/storage/schema.js";
import { InMemoryBackupStore } from "../helpers/backup-store.js";
import { jsonBody, stringAt } from "../helpers/body.js";
import { createTestSession } from "../helpers/session.js";
import type { TestSession } from "../helpers/session.js";
import { request } from "../helpers/request.js";
import { seedProject } from "../helpers/seed.js";
import type { SeededProject } from "../helpers/seed.js";

interface CleanupCall {
  projectId: string;
}

interface CleanupFixture {
  session: TestSession;
  store: InMemoryBackupStore;
}

let session: TestSession | null = null;
let store: InMemoryBackupStore | null = null;
let cleanupCalls: CleanupCall[] = [];

function current(): CleanupFixture {
  if (session === null || store === null) {
    throw new Error("archive cleanup suite: fixture missing");
  }

  return { session, store };
}

function archiveKey(projectId: string, name: string): string {
  const active = current().store;

  return `${active.prefix}/archive/events/project=${projectId}/date=2026-01-15/${name}`;
}

function seedArchivedObjects(projectId: string, count = 2): string[] {
  const { store: active } = current();
  const keys: string[] = [];

  for (let index = 0; index < count; index++) {
    const key = archiveKey(
      projectId,
      `part-1-1-1-${index.toString(16).padStart(12, "0")}.ndjson.zst`,
    );

    active.putObject(key, `archived-${index}`);
    keys.push(key);
  }

  return keys;
}

async function newProject(name: string): Promise<SeededProject> {
  return seedProject(current().session.harness.storage, { name: `${name}-${uuidv7()}` });
}

async function seedEvent(projectId: string, message: string): Promise<number> {
  const inserted = await current().session.harness.storage.insertEvents(
    projectId,
    [
      {
        ts: Date.now() - 1_000,
        level: 2,
        service: null,
        env: null,
        message,
        fields: null,
      },
    ],
    null,
  );

  return inserted.length;
}

beforeAll(async () => {
  store = new InMemoryBackupStore();
  cleanupCalls = [];

  const created = await createTestSession({
    deleteArchivedObjects: async (config, projectId) => {
      cleanupCalls.push({ projectId });

      return deleteArchivedProjectObjects(config, projectId, store ?? undefined);
    },
  });

  session = created;
});

afterAll(async () => {
  await session?.close();
  session = null;
  store = null;
  cleanupCalls = [];
});

describe("deleteArchivedProjectObjects", () => {
  it("deletes only the selected project's archived objects from an injected store", async () => {
    const { session: test, store: active } = current();
    const project = await newProject("cleanup-direct");
    const other = await newProject("cleanup-direct-other");
    const projectKeys = seedArchivedObjects(project.id);
    const otherKeys = seedArchivedObjects(other.id);
    const unrelatedKey = `${active.prefix}/snapshots/keep.db.zst`;
    const destroySpy = vi.spyOn(active, "destroy");

    active.putObject(unrelatedKey, "snapshot");

    const count = await deleteArchivedProjectObjects(test.harness.config, project.id, active);

    expect(count).toBe(projectKeys.length);
    expect(destroySpy).not.toHaveBeenCalled();

    for (const key of projectKeys) expect(active.hasObject(key)).toBe(false);

    for (const key of otherKeys) expect(active.hasObject(key)).toBe(true);
    expect(active.hasObject(unrelatedKey)).toBe(true);
  });

  it("stays a no-op when backups are not configured and no store is injected", async () => {
    const { session: test } = current();

    expect(test.harness.config.backup).toBe(null);
    expect(await deleteArchivedProjectObjects(test.harness.config, uuidv7())).toBe(0);
  });
});

describe("archive cleanup route wiring", () => {
  it("removes a deleted project's archived objects and leaves other projects alone", async () => {
    const { session: test, store: active } = current();
    const project = await newProject("project-delete");
    const other = await newProject("project-delete-other");
    const projectKeys = seedArchivedObjects(project.id);
    const otherKeys = seedArchivedObjects(other.id);

    cleanupCalls = [];

    const response = await request(test.harness.app, "/v1/projects/" + project.id, {
      method: "DELETE",
      cookies: test.adminJar,
    });

    expect(response.status).toBe(200);
    expect((await jsonBody(response)).ok).toBe(true);
    expect(cleanupCalls).toEqual([{ projectId: project.id }]);

    for (const key of projectKeys) expect(active.hasObject(key)).toBe(false);

    for (const key of otherKeys) expect(active.hasObject(key)).toBe(true);

    const rows = await test.harness.storage.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.id, project.id));

    expect(rows).toEqual([]);
  });

  it("removes archived objects on an all-time clear", async () => {
    const { session: test, store: active } = current();
    const project = await newProject("clear-all");
    const projectKeys = seedArchivedObjects(project.id);

    expect(await seedEvent(project.id, "clear me")).toBe(1);
    cleanupCalls = [];

    const response = await request(test.harness.app, "/v1/events?project=" + project.id, {
      method: "DELETE",
      cookies: test.adminJar,
    });

    expect(response.status).toBe(200);

    const body = await jsonBody(response);

    expect(body.deleted).toBe(1);
    expect(stringAt(body.projectId, "projectId")).toBe(project.id);
    expect(cleanupCalls).toEqual([{ projectId: project.id }]);

    for (const key of projectKeys) expect(active.hasObject(key)).toBe(false);
  });

  it("leaves archived objects alone for a bounded range clear", async () => {
    const { session: test, store: active } = current();
    const project = await newProject("clear-range");
    const projectKeys = seedArchivedObjects(project.id);

    expect(await seedEvent(project.id, "range clear")).toBe(1);
    cleanupCalls = [];

    const now = Date.now();

    const response = await request(
      test.harness.app,
      `/v1/events?project=${project.id}&from=0&to=${now + 1_000}`,
      { method: "DELETE", cookies: test.adminJar },
    );

    expect(response.status).toBe(200);

    const body = await jsonBody(response);

    expect(body.deleted).toBe(1);
    expect(cleanupCalls).toEqual([]);

    for (const key of projectKeys) expect(active.hasObject(key)).toBe(true);
  });
});
