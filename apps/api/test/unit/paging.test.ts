import { describe, expect, it } from "vitest";
import { matchesTableSearch, pageList, readPageRequest } from "../../src/paging.ts";
import { containsPattern, tableSearchWords } from "../../src/table-search.ts";

function query(params: Record<string, string>): (name: string) => string | undefined {
  return (name) => params[name];
}

describe("readPageRequest", () => {
  it("returns every row when no limit is given", () => {
    expect(readPageRequest(query({}))).toEqual({ limit: null, offset: 0, q: undefined });
  });

  it("clamps the limit to 1–100 and the offset to zero or more", () => {
    expect(readPageRequest(query({ limit: "500", offset: "-3" }))).toMatchObject({
      limit: 100,
      offset: 0,
    });
    expect(readPageRequest(query({ limit: "0" })).limit).toBe(1);
    expect(readPageRequest(query({ limit: "abc" })).limit).toBeNull();
  });
});

describe("matchesTableSearch", () => {
  it("needs every word, in any order and case", () => {
    expect(matchesTableSearch("Quiet UDP", ["udp gone quiet", "silence"])).toBe(true);
    expect(matchesTableSearch("quiet spike", ["udp gone quiet", "silence"])).toBe(false);
    expect(matchesTableSearch("", [])).toBe(true);
  });
});

function text(row: string): string[] {
  return [row];
}

describe("pageList", () => {
  const rows = ["alpha", "beta", "gamma", "delta", "epsilon"];

  it("pages the matching rows and counts them all", () => {
    expect(pageList(rows, { limit: 2, offset: 2, q: undefined }, text)).toEqual({
      items: ["gamma", "delta"],
      total: 5,
    });
    expect(pageList(rows, { limit: 2, offset: 0, q: "ta" }, text)).toEqual({
      items: ["beta", "delta"],
      total: 2,
    });
  });

  it("returns an empty page past the end and everything without a limit", () => {
    expect(pageList(rows, { limit: 2, offset: 9, q: undefined }, text)).toEqual({
      items: [],
      total: 5,
    });
    expect(pageList(rows, { limit: null, offset: 0, q: undefined }, text).items).toHaveLength(5);
  });
});

describe("table search SQL helpers", () => {
  it("caps the words and lowercases them", () => {
    expect(tableSearchWords("  A b C d e f g h i j ")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
    expect(tableSearchWords(undefined)).toEqual([]);
  });

  it("escapes LIKE wildcards so they match literally", () => {
    expect(containsPattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});
