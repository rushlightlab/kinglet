import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildWhere, parseFilters } from "../../src/filters.ts";
import { createStorage } from "../../src/storage/index.ts";
import type { Storage } from "../../src/storage/index.ts";
import { createTempDatabase } from "../helpers/temp.ts";
import type { TempDatabase } from "../helpers/temp.ts";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const ALPHA = "01900000-0000-7000-8000-0000000000a1";
const BETA = "01900000-0000-7000-8000-0000000000b2";
const ORPHAN = "01900000-0000-7000-8000-0000000000c3";
const BASE = 1_800_000_000_000;

let temp: TempDatabase | null = null;
let storage: Storage | null = null;

afterEach(async () => {
  await storage?.close();
  storage = null;
  await temp?.cleanup();
  temp = null;
});

/** A database at schema v10: every migration before 0011, then old-shape rows. */
async function createV10Database(dbPath: string, scratch: string): Promise<void> {
  const folder = path.join(scratch, "migrations-v10");

  fs.cpSync(MIGRATIONS, folder, { recursive: true });

  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));

  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 10);
  fs.writeFileSync(journalPath, JSON.stringify(journal));

  const client = createClient({ url: `file:${dbPath}` });

  try {
    // Boot prepares these (empty on a fresh database) for the 0006 UUID migration.
    for (const map of ["projects", "api_keys", "monitors", "alerts", "project_members"]) {
      await client.execute(
        `CREATE TABLE __uuid_${map} (old_id INTEGER PRIMARY KEY, new_id TEXT NOT NULL)`,
      );
    }

    await migrate(drizzle(client), { migrationsFolder: folder });

    const now = BASE;

    await client.batch(
      [
        {
          sql: "INSERT INTO projects (id, name, slug, created_at) VALUES (?, 'Alpha', 'alpha', ?), (?, 'Beta', 'beta', ?)",
          args: [ALPHA, now, BETA, now],
        },
        {
          sql: `INSERT INTO events (id, uid, project_id, ts, level, service, env, message, size_bytes) VALUES
            (10, '01900000-0000-7000-8000-000000000010', ?, ?, 2, 'api', 'prod', 'alpha connection refused', 24),
            (11, '01900000-0000-7000-8000-000000000011', ?, ?, 4, 'web', 'prod', 'alpha timeout', 13),
            (12, '01900000-0000-7000-8000-000000000012', ?, ?, 2, 'api', 'prod', 'beta started', 12),
            (13, '01900000-0000-7000-8000-000000000013', ?, ?, 2, null, null, 'orphan row', 10)`,
          args: [ALPHA, now, ALPHA, now + 1, BETA, now + 2, ORPHAN, now + 3],
        },
      ],
      "write",
    );
  } finally {
    client.close();
  }
}

describe("migration 0011: integer project keys", () => {
  it("keeps every row, id, usage counter, and search result", async () => {
    temp = createTempDatabase("kinglet-project-keys-");
    await createV10Database(temp.dbPath, temp.directory);

    storage = await createStorage({ kind: "sqlite", dbPath: temp.dbPath, search: "substring" });

    const columns = await storage.client.execute("PRAGMA table_info(events)");
    const names = columns.rows.map((row) => String(row.name));

    expect(names).toContain("project_key");
    expect(names).not.toContain("project_id");

    // Orphaned rows are kept under their own key, never folded into a project.
    const total = await storage.client.execute("SELECT count(*) AS n FROM events");

    expect(Number(total.rows[0]?.n)).toBe(4);

    const keys = await storage.client.execute("SELECT count(*) AS n FROM project_keys");

    expect(Number(keys.rows[0]?.n)).toBe(3);

    const range = { from: BASE - 1, to: BASE + 60_000 };

    const list = async (projectId: string, q = ""): Promise<string[]> => {
      const filter = buildWhere(parseFilters(q), range, projectId, "substring");
      const rows = await storage!.queryEvents({ projectId, filter, limit: 50, cursor: null });

      return rows.map((row) => `${row.id}:${row.projectId}:${row.message}`);
    };

    expect(await list(ALPHA)).toEqual([
      `11:${ALPHA}:alpha timeout`,
      `10:${ALPHA}:alpha connection refused`,
    ]);
    expect(await list(BETA)).toEqual([`12:${BETA}:beta started`]);

    // The trigram index survived the table rebuild...
    expect(await list(ALPHA, "fused")).toEqual([`10:${ALPHA}:alpha connection refused`]);

    // ...and its triggers were re-attached for new rows.
    const [inserted] = await storage.insertEvents(
      BETA,
      [
        {
          ts: BASE + 5,
          level: 3,
          service: "api",
          env: null,
          message: "beta refused",
          fields: null,
        },
      ],
      null,
    );

    expect(inserted?.id).toBeGreaterThan(13);
    expect(await list(BETA, "fused")).toEqual([`${inserted?.id}:${BETA}:beta refused`]);

    const usage = async (projectId: string): Promise<number> => {
      const result = await storage!.client.execute({
        sql: "SELECT events FROM project_usage WHERE project_id = ?",
        args: [projectId],
      });

      return Number(result.rows[0]?.events ?? 0);
    };

    expect(await usage(ALPHA)).toBe(2);
    expect(await usage(BETA)).toBe(2);

    expect(await storage.deleteByProject(ALPHA)).toBe(2);
    expect(await usage(ALPHA)).toBe(0);
    expect(await list(ALPHA, "fused")).toEqual([]);

    const event = await storage.getEventByUid(BETA, "01900000-0000-7000-8000-000000000012");

    expect(event?.projectId).toBe(BETA);
    expect(await storage.getEventByUid(ALPHA, "01900000-0000-7000-8000-000000000012")).toBeNull();
  });

  it("assigns a fresh key to a new project without reusing old ones", async () => {
    temp = createTempDatabase("kinglet-project-keys-");
    storage = await createStorage({ kind: "sqlite", dbPath: temp.dbPath });

    await storage.insertEvents(
      ALPHA,
      [{ ts: BASE, level: 2, service: null, env: null, message: "a", fields: null }],
      null,
    );
    await storage.insertEvents(
      BETA,
      [{ ts: BASE, level: 2, service: null, env: null, message: "b", fields: null }],
      null,
    );
    await storage.deleteByProject(ALPHA);
    await storage.insertEvents(
      ORPHAN,
      [{ ts: BASE, level: 2, service: null, env: null, message: "c", fields: null }],
      null,
    );

    const keys = await storage.client.execute(
      "SELECT project_id, key FROM project_keys ORDER BY key",
    );

    expect(keys.rows.map((row) => [row.project_id, Number(row.key)])).toEqual([
      [ALPHA, 1],
      [BETA, 2],
      [ORPHAN, 3],
    ]);
  });
});
