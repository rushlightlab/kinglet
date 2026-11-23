import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/ids.ts";
import type { Normalized } from "../../src/ingest.ts";
import { arrayAt, errorOf, jsonBody, numberAt, objectAt } from "../helpers/body.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";
import { request } from "../helpers/request.ts";
import { seedProject } from "../helpers/seed.ts";
import type { SeededProject } from "../helpers/seed.ts";

let session: TestSession | null = null;

function current(): TestSession {
  if (session === null) throw new Error("clear-by-query suite: session missing");

  return session;
}

function event(message: string, service: string, fields: string | null = null): Normalized {
  return { ts: Date.now() - 1_000, level: 2, service, env: "prod", message, fields };
}

/** A project with worker and api events, one of them carrying fields. */
async function seededProject(name: string): Promise<SeededProject> {
  const test = current();
  const project = await seedProject(test.harness.storage, { name: `${name}-${uuidv7()}` });

  await test.harness.storage.insertEvents(
    project.id,
    [
      event("worker tick 1", "worker"),
      event("worker tick 2", "worker"),
      event("worker failed job", "worker", JSON.stringify({ jobId: "J-7", attempts: 3 })),
      event("api request", "api"),
    ],
    null,
  );

  return project;
}

/** Messages left in the project, as a set: order does not matter here. */
async function remainingMessages(projectId: string): Promise<Set<string>> {
  const response = await request(current().harness.app, `/v1/events?project=${projectId}`, {
    cookies: current().adminJar,
  });

  return new Set(
    arrayAt((await jsonBody(response)).events, "events").map((row) =>
      String(objectAt(row, "event").message),
    ),
  );
}

function clearPath(projectId: string, q: string, preview = false): string {
  const params = new URLSearchParams({ project: projectId, q });

  return `/v1/events${preview ? "/clear/preview" : ""}?${params.toString()}`;
}

beforeAll(async () => {
  session = await createTestSession();
});

afterAll(async () => {
  await session?.close();
  session = null;
});

describe("clear preview", () => {
  it("counts, groups, and samples what a query clear would delete", async () => {
    const project = await seededProject("preview");

    const response = await request(
      current().harness.app,
      clearPath(project.id, "service:worker", true),
      {
        cookies: current().adminJar,
      },
    );

    expect(response.status).toBe(200);

    const body = await jsonBody(response);

    expect(numberAt(body.total, "total")).toBe(3);
    expect(arrayAt(body.services, "services")).toEqual([{ key: "worker", count: 3 }]);
    expect(arrayAt(body.sample, "sample")).toHaveLength(3);
    expect(body.archive).toBe(false);

    // A preview deletes nothing.
    expect((await remainingMessages(project.id)).size).toBe(4);
  });

  it("marks an unfiltered all-time clear as also removing the archive", async () => {
    const project = await seededProject("preview-all");

    const response = await request(current().harness.app, clearPath(project.id, "", true), {
      cookies: current().adminJar,
    });

    const body = await jsonBody(response);

    expect(numberAt(body.total, "total")).toBe(4);
    expect(body.archive).toBe(true);
  });
});

describe("clear by query", () => {
  it("deletes only the matching events and leaves other projects alone", async () => {
    const project = await seededProject("clear-service");
    const other = await seededProject("clear-service-other");

    const response = await request(current().harness.app, clearPath(project.id, "service:worker"), {
      method: "DELETE",
      cookies: current().adminJar,
    });

    expect(response.status).toBe(200);

    const body = await jsonBody(response);

    expect(numberAt(body.deleted, "deleted")).toBe(3);
    expect(body.q).toBe("service:worker");
    expect(await remainingMessages(project.id)).toEqual(new Set(["api request"]));
    expect((await remainingMessages(other.id)).size).toBe(4);
  });

  it("deletes by field filter combined with text", async () => {
    const project = await seededProject("clear-field");

    const response = await request(
      current().harness.app,
      clearPath(project.id, "worker field.attempts>=3"),
      { method: "DELETE", cookies: current().adminJar },
    );

    expect(numberAt((await jsonBody(response)).deleted, "deleted")).toBe(1);
    expect(await remainingMessages(project.id)).toEqual(
      new Set(["api request", "worker tick 1", "worker tick 2"]),
    );
  });

  it("refuses users without clear permission, for the preview and the delete", async () => {
    const { data, memberJar, viewerJar } = current();
    const projectId = data.projects.alpha.id;

    for (const cookies of [memberJar, viewerJar]) {
      const preview = await request(
        current().harness.app,
        clearPath(projectId, "service:x", true),
        {
          cookies,
        },
      );

      const deletion = await request(current().harness.app, clearPath(projectId, "service:x"), {
        method: "DELETE",
        cookies,
      });

      expect(preview.status).toBe(403);
      expect(deletion.status).toBe(403);
    }
  });

  it("refuses API keys, which can never delete logs", async () => {
    const { data } = current();

    const response = await request(
      current().harness.app,
      clearPath(data.projects.alpha.id, "service:x", true),
      { bearer: data.keys.alpha.plaintext },
    );

    expect(response.status).toBe(403);
  });

  it("rejects a query over the filter limits", async () => {
    const project = await seededProject("clear-limit");

    const response = await request(current().harness.app, clearPath(project.id, "x".repeat(501)), {
      method: "DELETE",
      cookies: current().adminJar,
    });

    expect(response.status).toBe(400);
    expect(errorOf(await jsonBody(response))).toContain("too long");
    expect((await remainingMessages(project.id)).size).toBe(4);
  });
});
