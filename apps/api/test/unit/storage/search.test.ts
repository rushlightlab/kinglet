import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { isVirtualTableUnsupported, withoutSearchIndex } from "../../../src/storage/search.ts";

const BREAKPOINT = "--> statement-breakpoint";
const INIT = fs.readFileSync(new URL("../../../drizzle/0000_init.sql", import.meta.url), "utf8");

function statements(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

describe("withoutSearchIndex", () => {
  it("drops the FTS table and its triggers from the baseline migration", () => {
    const stripped = withoutSearchIndex(INIT);

    expect(INIT).toContain("events_fts");
    expect(stripped).not.toContain("events_fts");
    expect(statements(stripped)).toHaveLength(statements(INIT).length - 3);
  });

  it("keeps every other statement byte for byte", () => {
    const kept = statements(INIT).filter((statement) => !statement.includes("events_fts"));

    expect(statements(withoutSearchIndex(INIT))).toEqual(kept);
  });

  it("leaves a migration without search statements unchanged", () => {
    const sql = `CREATE TABLE a (id integer);${BREAKPOINT}\nCREATE INDEX b ON a (id);`;

    expect(withoutSearchIndex(sql)).toBe(sql);
  });
});

describe("isVirtualTableUnsupported", () => {
  it("recognizes engines that cannot create the index", () => {
    expect(
      isVirtualTableUnsupported(
        "SQL_INPUT_ERROR: Tursodb error: Parse error: Virtual tables are not supported in MVCC mode",
      ),
    ).toBe(true);
    expect(isVirtualTableUnsupported("no such module: fts5")).toBe(true);
  });

  it("does not swallow unrelated or tokenizer errors", () => {
    expect(isVirtualTableUnsupported("no such tokenizer: trigram")).toBe(false);
    expect(isVirtualTableUnsupported("UNIQUE constraint failed: events.uid")).toBe(false);
  });
});
