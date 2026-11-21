import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWhere, parseFilters } from "../../src/filters.ts";
import type { Normalized } from "../../src/ingest.ts";
import type { SearchMode } from "../../src/types.ts";
import { createStorage } from "../../src/storage/index.ts";
import type { Storage } from "../../src/storage/index.ts";
import { createTempDatabase } from "../helpers/temp.ts";
import type { TempDatabase } from "../helpers/temp.ts";

const PROJECT = "01900000-0000-7000-8000-0000000000a1";
const OTHER_PROJECT = "01900000-0000-7000-8000-0000000000b2";
const BASE = 1_800_000_000_000;
const MINUTE = 60_000;

let temp: TempDatabase | null = null;
let storage: Storage | null = null;

function store(): Storage {
  if (storage === null) throw new Error("event storage suite: storage missing");

  return storage;
}

function event(message: string, ts: number, level = 2): Normalized {
  return { ts, level, service: null, env: null, message, fields: null };
}

async function pragma(name: string): Promise<number> {
  const result = await store().client.execute(`PRAGMA ${name}`);

  return Number(Object.values(result.rows[0] ?? {})[0]);
}

beforeEach(async () => {
  temp = createTempDatabase("kinglet-event-storage-");
  storage = await createStorage({ kind: "sqlite", dbPath: temp.dbPath });
});

afterEach(async () => {
  await storage?.close();
  storage = null;
  await temp?.cleanup();
  temp = null;
});

describe("local SQLite connection settings", () => {
  it("keeps NORMAL sync and the busy timeout after an interactive transaction", async () => {
    // The local libSQL client opens a fresh connection after each
    // transaction; the pragmas must follow it.
    await store().db.transaction(async () => undefined);

    expect(await pragma("synchronous")).toBe(1);
    expect(await pragma("busy_timeout")).toBe(5000);
  });

  it("does not hand ingest its own connection", async () => {
    await store().insertEvents(PROJECT, [event("one", BASE)], null);

    expect(await pragma("synchronous")).toBe(1);
    expect(await pragma("busy_timeout")).toBe(5000);
  });
});

describe("insertEvents", () => {
  it("returns every row with its id across insert chunks", async () => {
    const events = Array.from({ length: 1_203 }, (_, i) => event(`bulk ${i}`, BASE + i));
    const rows = await store().insertEvents(PROJECT, events, null);

    expect(rows).toHaveLength(1_203);
    expect(rows[0]?.message).toBe("bulk 0");
    expect(rows[1_202]?.message).toBe("bulk 1202");
    expect(new Set(rows.map((row) => row.id)).size).toBe(1_203);
    expect(new Set(rows.map((row) => row.uid)).size).toBe(1_203);

    const stored = await store().getEventByUid(PROJECT, rows[700]?.uid ?? "");

    expect(stored?.id).toBe(rows[700]?.id);
    expect(stored?.message).toBe("bulk 700");
  });
});

describe("queryEvents", () => {
  it("orders by event time and pages by the id cursor", async () => {
    // Arrival order differs from event time: a late, backdated event must
    // sort by its timestamp, and equal timestamps fall back to id order.
    await store().insertEvents(
      PROJECT,
      [
        event("t3", BASE + 3 * MINUTE),
        event("t1", BASE + MINUTE),
        event("t5 first", BASE + 5 * MINUTE),
        event("t5 second", BASE + 5 * MINUTE),
        event("t2", BASE + 2 * MINUTE),
      ],
      null,
    );
    await store().insertEvents(OTHER_PROJECT, [event("other", BASE + 4 * MINUTE)], null);

    const filter = buildWhere(
      parseFilters(""),
      { from: BASE, to: BASE + 10 * MINUTE },
      PROJECT,
      "substring",
    );

    const pages: string[][] = [];
    let cursor: number | null = null;

    for (let page = 0; page < 4; page++) {
      const rows = await store().queryEvents({ projectId: PROJECT, filter, limit: 2, cursor });

      if (rows.length === 0) break;
      pages.push(rows.map((row) => row.message));
      cursor = rows.at(-1)?.id ?? null;
    }

    expect(pages).toEqual([["t5 second", "t5 first"], ["t3", "t2"], ["t1"]]);
  });

  it("falls back to id order when the cursor row is gone", async () => {
    const rows = await store().insertEvents(
      PROJECT,
      [event("a", BASE + MINUTE), event("b", BASE + 2 * MINUTE), event("c", BASE + 3 * MINUTE)],
      null,
    );

    const filter = buildWhere(
      parseFilters(""),
      { from: BASE, to: BASE + 10 * MINUTE },
      PROJECT,
      "substring",
    );

    const missingCursor = (rows[2]?.id ?? 0) + 1_000;

    const page = await store().queryEvents({
      projectId: PROJECT,
      filter,
      limit: 10,
      cursor: missingCursor,
    });

    expect(page.map((row) => row.message)).toEqual(["c", "b", "a"]);
  });

  it("does not use another project's row as a cursor anchor", async () => {
    await store().insertEvents(PROJECT, [event("mine", BASE + MINUTE)], null);

    const [foreign] = await store().insertEvents(OTHER_PROJECT, [event("foreign", BASE)], null);

    const filter = buildWhere(
      parseFilters(""),
      { from: BASE - MINUTE, to: BASE + 10 * MINUTE },
      PROJECT,
      "substring",
    );

    // With the foreign row's timestamp as an anchor, "mine" (later) would be
    // hidden. Scoped to the project, the anchor is absent and id order applies.
    const page = await store().queryEvents({
      projectId: PROJECT,
      filter,
      limit: 10,
      cursor: foreign?.id ?? 0,
    });

    expect(page.map((row) => row.message)).toEqual(["mine"]);
  });
});

describe("histogramPoints", () => {
  it("counts each event once in its level and bucket inside the window", async () => {
    await store().insertEvents(
      PROJECT,
      [
        event("before window", BASE - 1, 4),
        event("bucket 0 info", BASE, 2),
        event("bucket 0 error", BASE + MINUTE - 1, 4),
        event("bucket 2 warn", BASE + 2 * MINUTE + 5, 3),
        event("bucket 2 warn again", BASE + 2 * MINUTE + 6, 3),
        event("at window end", BASE + 3 * MINUTE, 5),
        event("after window", BASE + 3 * MINUTE + 1, 5),
      ],
      null,
    );
    await store().insertEvents(OTHER_PROJECT, [event("other", BASE, 2)], null);

    const points = await store().histogramPoints(PROJECT, BASE, BASE + 3 * MINUTE, MINUTE);

    expect(points).toEqual([
      { ts: BASE, counts: [0, 0, 1, 0, 1, 0] },
      { ts: BASE + MINUTE, counts: [0, 0, 0, 0, 0, 0] },
      { ts: BASE + 2 * MINUTE, counts: [0, 0, 0, 2, 0, 0] },
      { ts: BASE + 3 * MINUTE, counts: [0, 0, 0, 0, 0, 1] },
    ]);
  });

  it("aligns buckets to the bucket width when the window is not aligned", async () => {
    await store().insertEvents(
      PROJECT,
      [event("first", BASE + 30_000, 2), event("second", BASE + 90_000, 2)],
      null,
    );

    const points = await store().histogramPoints(PROJECT, BASE + 30_000, BASE + 90_000, MINUTE);

    expect(points.map((point) => [point.ts, point.counts[2]])).toEqual([
      [BASE, 1],
      [BASE + MINUTE, 1],
      [BASE + 2 * MINUTE, 0],
    ]);
  });
});

async function search(mode: SearchMode, q: string): Promise<string[]> {
  const filter = buildWhere(
    parseFilters(q),
    { from: BASE - MINUTE, to: BASE + 10 * MINUTE },
    PROJECT,
    mode,
  );

  const rows = await store().queryEvents({ projectId: PROJECT, filter, limit: 50, cursor: null });

  // Newest first by event time.
  return rows.map((row) => row.message);
}

async function reopen(mode: SearchMode): Promise<void> {
  await store().close();
  storage = await createStorage({ kind: "sqlite", dbPath: temp?.dbPath ?? "", search: mode });
}

describe("search modes", () => {
  const corpus = [
    "connection refused by upstream",
    "request timeout after 30s",
    "user signed in",
    "cache hit ratio=0.93",
  ];

  beforeEach(async () => {
    await store().insertEvents(
      PROJECT,
      corpus.map((message, i) => event(message, BASE + i)),
      null,
    );
  });

  it("matches inner substrings with the trigram index", async () => {
    await reopen("substring");

    expect(store().searchMode).toBe("substring");
    expect(await search("substring", "fused")).toEqual(["connection refused by upstream"]);
    expect(await search("substring", "ratio=0.9")).toEqual(["cache hit ratio=0.93"]);
  });

  it("switches to word-prefix search and back, rebuilding existing rows", async () => {
    await reopen("words");

    expect(store().searchMode).toBe("words");
    expect(await search("words", "time")).toEqual(["request timeout after 30s"]);
    expect(await search("words", '"connection ref"')).toEqual(["connection refused by upstream"]);
    expect(await search("words", "fused")).toEqual([]);
    expect(await search("words", "-user")).toHaveLength(3);

    // New rows are indexed by the recreated triggers.
    await store().insertEvents(PROJECT, [event("timeline rendered", BASE + 9)], null);
    expect(await search("words", "time")).toEqual([
      "timeline rendered",
      "request timeout after 30s",
    ]);

    await reopen("substring");

    expect(store().searchMode).toBe("substring");
    expect(await search("substring", "fused")).toEqual(["connection refused by upstream"]);
  });

  it("drops the index when search is off and still filters by substring", async () => {
    await reopen("off");

    expect(store().searchMode).toBe("off");

    const fts = await store().client.execute(
      "SELECT count(*) AS n FROM sqlite_master WHERE name = 'events_fts'",
    );

    expect(Number(fts.rows[0]?.n)).toBe(0);

    // Inserts and deletes keep working without the triggers.
    await store().insertEvents(PROJECT, [event("refused again", BASE + 9)], null);
    expect(await search("off", "fused")).toEqual([
      "refused again",
      "connection refused by upstream",
    ]);
    expect(await store().deleteByProject(PROJECT)).toBe(5);
  });

  it("keeps the current index when no mode is requested", async () => {
    await reopen("words");
    await store().close();
    storage = await createStorage({ kind: "sqlite", dbPath: temp?.dbPath ?? "" });

    expect(store().searchMode).toBe("words");
  });
});
