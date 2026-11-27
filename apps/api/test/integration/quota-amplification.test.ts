import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Normalized } from "../../src/ingest.ts";
import { eventSizeBytes } from "../../src/storage/events.ts";
import * as schema from "../../src/storage/schema.ts";
import { request } from "../helpers/request.ts";
import { seedApiKey, seedProject } from "../helpers/seed.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

/**
 * The per-project byte quota charges each row's estimated on-disk size,
 * indexes included, computed from that row alone. The search index makes
 * message text cost several times its raw bytes, and no other project's data
 * can move a project's estimate. Kept in its own file: usage is cached per
 * process for 30 s.
 */

let session: TestSession | null = null;

function ctx(): TestSession {
  if (session === null) throw new Error("quota estimate suite: test session missing");

  return session;
}

const MESSAGE_BYTES = 8_000;
const ALPHA_ROWS = 300;

// Raw alpha text is 2.4 MB; the quota sits 1 MiB above it.
const QUOTA = ALPHA_ROWS * MESSAGE_BYTES + 1_048_576;

function text(length: number, seed: number): string {
  return Array.from(
    { length },
    (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[(i * 31 + seed * 7) % 36],
  ).join("");
}

function event(message: string): Normalized {
  return { ts: Date.now() - 1_000, level: 2, service: null, env: null, message, fields: null };
}

async function insertRows(projectId: string, rows: Normalized[]): Promise<void> {
  for (let start = 0; start < rows.length; start += 50) {
    await ctx().harness.storage.insertEvents(projectId, rows.slice(start, start + 50), null);
  }
}

async function usageBytes(projectId: string): Promise<number> {
  const rows = await ctx()
    .harness.storage.db.select({ bytes: schema.projectUsage.bytes })
    .from(schema.projectUsage)
    .where(eq(schema.projectUsage.projectId, projectId));

  return Number(rows[0]?.bytes ?? 0);
}

beforeAll(async () => {
  session = await createTestSession({
    config: { maxProjectBytes: QUOTA, maxDbBytes: 0, maxEventsPerProject: 0 },
  });

  await insertRows(
    session.data.projects.alpha.id,
    Array.from({ length: ALPHA_ROWS }, (_, i) => event(text(MESSAGE_BYTES, i))),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await session?.close();
  session = null;
});

describe("project byte quota", () => {
  it("counts index overhead, so raw text under the quota can still be refused", async () => {
    const test = ctx();

    // The raw text alone would fit, but the stored estimate is past the quota.
    expect(ALPHA_ROWS * MESSAGE_BYTES).toBeLessThan(QUOTA);
    expect(await usageBytes(test.data.projects.alpha.id)).toBeGreaterThan(QUOTA);

    const response = await request(test.harness.app, "/v1/events", {
      method: "POST",
      bearer: test.data.keys.alpha.plaintext,
      body: { message: "one more" },
    });

    expect(response.status).toBe(507);
  });

  it("is not pushed over its quota by another project's ingest", async () => {
    const test = ctx();
    const victim = test.data.projects.beta.id;

    // The victim sits at about 90% of its quota.
    const row = event(text(2_000, 1));
    await insertRows(
      victim,
      Array.from({ length: Math.floor((QUOTA * 0.9) / eventSizeBytes(row)) }, (_, i) =>
        event(text(2_000, i)),
      ),
    );
    const victimBefore = await usageBytes(victim);

    // A neighbour ingests many tiny events, whose overhead a database-wide
    // ratio would have spread over every project.
    const neighbour = await seedProject(test.harness.storage, { name: "Neighbour" });

    const neighbourKey = await seedApiKey(test.harness.storage, {
      projectId: neighbour.id,
      name: "neighbour-ingest",
      scopes: ["ingest"],
    });

    for (let batch = 0; batch < 4; batch++) {
      const response = await request(test.harness.app, "/v1/events", {
        method: "POST",
        bearer: neighbourKey.plaintext,
        body: Array.from({ length: 1_000 }, (_, i) => ({ message: `x${batch}-${i}` })),
      });

      expect(response.status).toBe(200);
    }

    // Past every 30 s usage cache, the victim's estimate is its own rows only.
    const later = Date.now() + 31_000;
    vi.spyOn(Date, "now").mockReturnValue(later);

    expect(await usageBytes(victim)).toBe(victimBefore);

    const response = await request(test.harness.app, "/v1/events", {
      method: "POST",
      bearer: test.data.keys.beta.plaintext,
      body: { message: "beta still fits" },
    });

    expect(response.status).toBe(200);
  });
});
