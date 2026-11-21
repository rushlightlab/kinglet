import type { Client, InStatement } from "@libsql/client";
import type { SearchMode } from "../types.ts";

/**
 * The events full-text index (`events_fts`) in one of three shapes:
 *
 *  - `substring`: FTS5 trigram. Any 3+ character substring matches. The most
 *    capable and the most expensive: roughly half of each insert's cost.
 *  - `words`: FTS5 unicode61. Word and word-prefix matches (`time` finds
 *    `timeout`, `out` does not). Much cheaper to write and store.
 *  - `off`: no index. Text filters scan the project/time window with LIKE.
 *
 * The baseline migration creates the trigram table; boot reconciles it with
 * the configured mode.
 */
const TOKENIZERS = { substring: "trigram", words: "unicode61" } as const;

export async function currentSearchMode(client: Client): Promise<SearchMode> {
  const result = await client.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events_fts'",
  );

  const ddl = String(result.rows[0]?.sql ?? "");

  if (ddl === "") return "off";

  return /trigram/i.test(ddl) ? "substring" : "words";
}

const DROP_INDEX: InStatement[] = [
  "DROP TRIGGER IF EXISTS events_ai",
  "DROP TRIGGER IF EXISTS events_ad",
  "DROP TABLE IF EXISTS events_fts",
];

const CREATE_TRIGGERS: InStatement[] = [
  `CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts (rowid, message) VALUES (new.id, new.message);
  END`,
  `CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts (events_fts, rowid, message) VALUES ('delete', old.id, old.message);
  END`,
];

function createIndex(tokenizer: string): InStatement[] {
  return [
    `CREATE VIRTUAL TABLE events_fts USING fts5 (message, content='events', content_rowid='id', tokenize='${tokenizer}')`,
    ...CREATE_TRIGGERS,
    "INSERT INTO events_fts(events_fts) VALUES('rebuild')",
  ];
}

/**
 * A migration that rebuilds the events table drops its triggers but not the
 * index, whose rowids and text are unchanged. Re-attach the sync triggers so
 * new rows keep being indexed; no rebuild is needed.
 */
export async function ensureSearchTriggers(client: Client): Promise<void> {
  if ((await currentSearchMode(client)) === "off") return;

  await client.batch(CREATE_TRIGGERS, "write");
}

/**
 * Bring the index in line with the configured mode and return the mode in
 * effect. The switch runs as one atomic batch: a crash mid-rebuild or a
 * backend without the trigram tokenizer rolls back to the previous index
 * instead of leaving a half-built one that would look current next boot.
 */
export async function reconcileSearchIndex(
  client: Client,
  wanted: SearchMode,
): Promise<SearchMode> {
  const current = await currentSearchMode(client);

  if (current === wanted) return current;

  const started = Date.now();

  const statements =
    wanted === "off" ? DROP_INDEX : [...DROP_INDEX, ...createIndex(TOKENIZERS[wanted])];

  try {
    await client.batch(statements, "write");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (wanted !== "substring" || !/trigram|tokenizer/i.test(message)) throw err;
    console.warn(`[kinglet] FTS5 trigram unavailable; keeping ${current} search:`, message);

    if (current !== "off") return current;
    await client.batch([...DROP_INDEX, ...createIndex(TOKENIZERS.words)], "write");

    return "words";
  }

  console.log(
    `[kinglet] search index changed: ${current} → ${wanted} (${Date.now() - started} ms)`,
  );

  return wanted;
}
