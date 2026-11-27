import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWhere, chooseTextPlan, parseFilters, TEXT_SCAN_MAX_ROWS } from "../../src/filters.ts";
import type { TextPlan } from "../../src/filters.ts";
import type { Normalized } from "../../src/ingest.ts";
import type { SearchMode } from "../../src/types.ts";
import { createStorage } from "../../src/storage/index.ts";
import * as schema from "../../src/storage/schema.ts";
import type { Storage } from "../../src/storage/index.ts";
import { createTempDatabase } from "../helpers/temp.ts";
import type { TempDatabase } from "../helpers/temp.ts";

const PROJECT = "01900000-0000-7000-8000-0000000000a1";
const OTHER_PROJECT = "01900000-0000-7000-8000-0000000000b2";
const BASE = 1_800_000_000_000;
const MINUTE = 60_000;
const RANGE = { from: BASE - MINUTE, to: BASE + 10 * MINUTE };

let temp: TempDatabase | null = null;
let storage: Storage | null = null;

function store(): Storage {
  if (storage === null) throw new Error("text plan suite: storage missing");

  return storage;
}

function event(message: string, ts: number, fields: string | null = null): Normalized {
  return { ts, level: 2, service: null, env: null, message, fields };
}

async function messages(q: string, search: SearchMode, plan: TextPlan): Promise<string[]> {
  const filter = buildWhere(parseFilters(q), RANGE, PROJECT, search, plan);
  const rows = await store().queryEvents({ projectId: PROJECT, filter, limit: 100, cursor: null });

  // Both plans return rows in the same newest-first order.
  return rows.map((row) => row.message);
}

async function openStorage(search: SearchMode): Promise<void> {
  temp = createTempDatabase("kinglet-text-plan-");
  storage = await createStorage({ kind: "sqlite", dbPath: temp.dbPath, search });
}

afterEach(async () => {
  await storage?.close();
  storage = null;
  await temp?.cleanup();
  temp = null;
});

describe("substring text plans", () => {
  beforeEach(async () => {
    await openStorage("substring");
    await store().insertEvents(
      PROJECT,
      [
        event("gateway timeout contacting inventory", BASE),
        event("gateway refused connection", BASE + MINUTE),
        event("inventory sync finished", BASE + 2 * MINUTE),
        event("db ok", BASE + 3 * MINUTE, JSON.stringify({ route: "/checkout" })),
      ],
      null,
    );
    // Same words in another project: never part of the result, in either plan.
    await store().insertEvents(
      OTHER_PROJECT,
      [event("gateway timeout contacting inventory", BASE)],
      null,
    );
  });

  it.each([
    "gateway",
    "gateway timeout",
    "gateway -refused",
    "-gateway -inventory",
    "inventory -timeout -sync",
    "ok",
    "in:all checkout",
    "in:all -checkout gateway",
    '"refused connection"',
  ])("returns the same rows from the index and a scan for %j", async (q) => {
    expect(await messages(q, "substring", "scan")).toEqual(await messages(q, "substring", "index"));
  });

  it("combines index terms into one full-text match", () => {
    const where = buildWhere(
      parseFilters("gateway timeout inventory"),
      RANGE,
      PROJECT,
      "substring",
    );

    const { sql } = store().db.select().from(schema.events).where(where).toSQL();

    expect(sql.match(/events_fts MATCH/g)).toHaveLength(1);
  });

  it("scans a small project window and uses the index for a large one", async () => {
    const f = parseFilters("gateway");

    expect(await chooseTextPlan(store().db, f, RANGE, PROJECT, "substring")).toBe("scan");

    const filler = Array.from({ length: TEXT_SCAN_MAX_ROWS }, (_, i) =>
      event(`filler ${i}`, BASE + (i % 600) * 1_000),
    );

    for (let i = 0; i < filler.length; i += 1_000) {
      await store().insertEvents(PROJECT, filler.slice(i, i + 1_000), null);
    }

    expect(await chooseTextPlan(store().db, f, RANGE, PROJECT, "substring")).toBe("index");
    // The other project's small window still scans.
    expect(await chooseTextPlan(store().db, f, RANGE, OTHER_PROJECT, "substring")).toBe("scan");
  });

  it("scans a large window when other projects match more rows than it holds", async () => {
    const f = parseFilters("gateway");
    const ownRows = TEXT_SCAN_MAX_ROWS + 1;

    const filler = Array.from({ length: ownRows }, (_, i) =>
      event(`filler ${i}`, BASE + (i % 600) * 1_000),
    );

    for (let i = 0; i < filler.length; i += 1_000) {
      await store().insertEvents(PROJECT, filler.slice(i, i + 1_000), null);
    }

    // Few matches anywhere: the index is cheaper than reading the window.
    expect(await chooseTextPlan(store().db, f, RANGE, PROJECT, "substring")).toBe("index");

    // Another project's matches now outnumber this project's window, so the
    // shared index would cost more than a scan of the caller's own rows.
    const matches = Array.from({ length: ownRows + 10 }, (_, i) =>
      event(`gateway noise ${i}`, BASE + (i % 600) * 1_000),
    );

    for (let i = 0; i < matches.length; i += 1_000) {
      await store().insertEvents(OTHER_PROJECT, matches.slice(i, i + 1_000), null);
    }

    expect(await chooseTextPlan(store().db, f, RANGE, PROJECT, "substring")).toBe("scan");
    expect(
      await chooseTextPlan(store().db, parseFilters("-gateway"), RANGE, PROJECT, "substring"),
    ).toBe("scan");
  });

  it("keeps the index for queries the index does not serve", async () => {
    expect(await chooseTextPlan(store().db, parseFilters("ok"), RANGE, PROJECT, "substring")).toBe(
      "index",
    );
    expect(
      await chooseTextPlan(
        store().db,
        parseFilters("in:fields gateway"),
        RANGE,
        PROJECT,
        "substring",
      ),
    ).toBe("index");
  });
});

describe("words text plans", () => {
  beforeEach(async () => {
    await openStorage("words");
    await store().insertEvents(
      PROJECT,
      [event("connection refused by upstream", BASE), event("timeout overtime", BASE + MINUTE)],
      null,
    );
  });

  it("matches word prefixes with every term in one match", async () => {
    expect(await messages("conn refu", "words", "index")).toEqual([
      "connection refused by upstream",
    ]);
    expect(await messages("time -conn", "words", "index")).toEqual(["timeout overtime"]);
  });

  it("always uses the index, since a scan would match inside words", async () => {
    expect(await chooseTextPlan(store().db, parseFilters("time"), RANGE, PROJECT, "words")).toBe(
      "index",
    );
  });
});
