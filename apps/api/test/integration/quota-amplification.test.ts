import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/storage/schema.ts";
import { request } from "../helpers/request.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

/**
 * The per-project byte quota counts raw column bytes, while the search index
 * and secondary indexes add several times that on disk. The quota check scales
 * counted bytes by the database's measured ratio, so a project at its quota
 * cannot fill the shared database cap. Kept in its own file: the ratio is
 * cached per process for 30 s.
 */

let session: TestSession | null = null;

function ctx(): TestSession {
  if (session === null) throw new Error("quota amplification suite: test session missing");

  return session;
}

const MESSAGE = (seed: number): string =>
  Array.from(
    { length: 8_000 },
    (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[(i * 31 + seed * 7) % 36],
  ).join("");

beforeAll(async () => {
  // About 9 MB of counted message text: past the 8 MiB floor for measuring.
  const counted = 1_150 * 8_000;

  session = await createTestSession({
    config: { maxProjectBytes: counted + 2 * 1_048_576, maxDbBytes: 0, maxEventsPerProject: 0 },
  });

  const { storage } = session.harness;
  const projectId = session.data.projects.alpha.id;

  for (let start = 0; start < 1_150; start += 50) {
    await storage.insertEvents(
      projectId,
      Array.from({ length: 50 }, (_, i) => ({
        ts: Date.now() - 1_000,
        level: 2,
        service: null,
        env: null,
        message: MESSAGE(start + i),
        fields: null,
      })),
      null,
    );
  }
});

afterAll(async () => {
  await session?.close();
  session = null;
});

describe("project byte quota", () => {
  it("counts index overhead, so raw bytes under the quota can still be refused", async () => {
    const test = ctx();

    const usage = await test.harness.storage.db
      .select({ bytes: schema.projectUsage.bytes })
      .from(schema.projectUsage)
      .where(eq(schema.projectUsage.projectId, test.data.projects.alpha.id));

    // Raw counted bytes are still below the configured quota...
    expect(Number(usage[0]?.bytes ?? 0)).toBeLessThan(test.harness.config.maxProjectBytes);

    // ...but on disk the project is well past it, so ingest is refused.
    const response = await request(test.harness.app, "/v1/events", {
      method: "POST",
      bearer: test.data.keys.alpha.plaintext,
      body: { message: "one more" },
    });

    expect(response.status).toBe(507);
  });
});
