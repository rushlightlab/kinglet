import { describe, expect, it } from "vitest";
import { matchesEvent, parseFilters } from "../../src/filters.js";
import type { ParsedFilters } from "../../src/filters.js";

function emptyFilters(): ParsedFilters {
  return {
    levelOp: null,
    levelValue: null,
    service: null,
    env: null,
    apiKeyId: null,
    includes: [],
    excludes: [],
  };
}

const SAMPLE_ROW = {
  level: 3,
  service: "API",
  env: "prod",
  message: "Connection refused by upstream proxy",
  apiKeyId: "0190f5b2-7c3a-7def-8abc-0123456789ab",
};

describe("parseFilters", () => {
  it("returns empty filters for empty input", () => {
    expect(parseFilters("")).toEqual(emptyFilters());
    expect(parseFilters("   ")).toEqual(emptyFilters());
  });

  it("parses quoted phrases and lowercases free text", () => {
    const filters = parseFilters('"Connection Refused" Timeout');

    expect(filters.includes).toEqual(["connection refused", "timeout"]);
    expect(filters.excludes).toEqual([]);
  });

  it("parses single-quoted phrases", () => {
    expect(parseFilters("'heart beat' slow").includes).toEqual(["heart beat", "slow"]);
  });

  it("accepts an unterminated quote as a plain term", () => {
    expect(parseFilters('"connection').includes).toEqual(["connection"]);
  });

  it("parses exclusions", () => {
    const filters = parseFilters('-healthcheck -"heart beat"');

    expect(filters.excludes).toEqual(["healthcheck", "heart beat"]);
    expect(filters.includes).toEqual([]);
  });

  it.each([
    ["level:trace", "=", 0],
    ["level=debug", "=", 1],
    ["level:info", "=", 2],
    ["level>=warn", ">=", 3],
    ["level>error", ">", 4],
    ["level<error", "<", 4],
    ["level<=warn", "<=", 3],
    ["LEVEL>=WARN", ">=", 3],
  ])("parses %s", (query, levelOp, levelValue) => {
    const filters = parseFilters(query);

    expect(filters.levelOp).toBe(levelOp);
    expect(filters.levelValue).toBe(levelValue);
    expect(filters.includes).toEqual([]);
  });

  it("treats an unknown level name as free text", () => {
    const filters = parseFilters("level>=bogus");

    expect(filters.levelOp).toBeNull();
    expect(filters.levelValue).toBeNull();
    expect(filters.includes).toEqual(["level>=bogus"]);
  });

  it("treats a negative level filter as an exclusion", () => {
    const filters = parseFilters("-level>=warn");

    expect(filters.levelOp).toBeNull();
    expect(filters.excludes).toEqual(["level>=warn"]);
  });

  it("parses service and env keys case-insensitively", () => {
    const filters = parseFilters("service:API Env:Prod");

    expect(filters.service).toBe("api");
    expect(filters.env).toBe("prod");
    expect(filters.includes).toEqual([]);
  });

  it("lets the last service or env token win", () => {
    const filters = parseFilters("service:first service:second env:a env:b");

    expect(filters.service).toBe("second");
    expect(filters.env).toBe("b");
  });

  it("parses key and api_key UUID filters", () => {
    const id = "0190F5B2-7C3A-7DEF-8ABC-0123456789AB";

    expect(parseFilters(`key:${id}`).apiKeyId).toBe(id.toLowerCase());
    expect(parseFilters(`api_key:${id.toLowerCase()}`).apiKeyId).toBe(id.toLowerCase());
    expect(parseFilters("key:not-a-uuid").apiKeyId).toBeNull();
    expect(parseFilters("key:not-a-uuid").includes).toEqual(["key:not-a-uuid"]);
  });

  it("treats unknown fields as free text", () => {
    const filters = parseFilters("trace_id:abc has:extra");

    expect(filters.includes).toEqual(["trace_id:abc", "has:extra"]);
  });

  it("splits mixed includes and excludes in order", () => {
    const filters = parseFilters('Foo -Bar "Baz Qux"');

    expect(filters.includes).toEqual(["foo", "baz qux"]);
    expect(filters.excludes).toEqual(["bar"]);
  });
});

describe("matchesEvent", () => {
  it("matches everything with empty filters", () => {
    expect(matchesEvent(emptyFilters(), SAMPLE_ROW)).toBe(true);
  });

  it("applies level comparisons", () => {
    expect(matchesEvent({ ...emptyFilters(), levelOp: ">=", levelValue: 3 }, SAMPLE_ROW)).toBe(
      true,
    );
    expect(matchesEvent({ ...emptyFilters(), levelOp: ">", levelValue: 2 }, SAMPLE_ROW)).toBe(true);
    expect(matchesEvent({ ...emptyFilters(), levelOp: ">", levelValue: 3 }, SAMPLE_ROW)).toBe(
      false,
    );
    expect(matchesEvent({ ...emptyFilters(), levelOp: "<", levelValue: 3 }, SAMPLE_ROW)).toBe(
      false,
    );
    expect(matchesEvent({ ...emptyFilters(), levelOp: "=", levelValue: 3 }, SAMPLE_ROW)).toBe(true);
    expect(matchesEvent({ ...emptyFilters(), levelOp: "=", levelValue: 4 }, SAMPLE_ROW)).toBe(
      false,
    );
    expect(matchesEvent({ ...emptyFilters(), levelOp: "<=", levelValue: 2 }, SAMPLE_ROW)).toBe(
      false,
    );
  });

  it("matches service and env without case sensitivity", () => {
    expect(matchesEvent({ ...emptyFilters(), service: "api" }, SAMPLE_ROW)).toBe(true);
    expect(matchesEvent({ ...emptyFilters(), env: "prod" }, SAMPLE_ROW)).toBe(true);
    expect(matchesEvent({ ...emptyFilters(), service: "worker" }, SAMPLE_ROW)).toBe(false);
    expect(matchesEvent({ ...emptyFilters(), env: "staging" }, SAMPLE_ROW)).toBe(false);
  });

  it("treats leftover text as a case-insensitive substring", () => {
    expect(matchesEvent({ ...emptyFilters(), includes: ["connection"] }, SAMPLE_ROW)).toBe(true);
    expect(matchesEvent({ ...emptyFilters(), includes: ["refused by"] }, SAMPLE_ROW)).toBe(true);
    expect(matchesEvent({ ...emptyFilters(), includes: ["timeout"] }, SAMPLE_ROW)).toBe(false);
  });

  it("requires every include term to match", () => {
    expect(matchesEvent({ ...emptyFilters(), includes: ["connection", "proxy"] }, SAMPLE_ROW)).toBe(
      true,
    );
    expect(
      matchesEvent({ ...emptyFilters(), includes: ["connection", "timeout"] }, SAMPLE_ROW),
    ).toBe(false);
  });

  it("rejects rows containing an excluded term", () => {
    expect(matchesEvent({ ...emptyFilters(), excludes: ["timeout"] }, SAMPLE_ROW)).toBe(true);
    expect(matchesEvent({ ...emptyFilters(), excludes: ["refused"] }, SAMPLE_ROW)).toBe(false);
  });

  it("matches the api key id exactly", () => {
    const id = SAMPLE_ROW.apiKeyId;

    expect(matchesEvent({ ...emptyFilters(), apiKeyId: id }, SAMPLE_ROW)).toBe(true);
    expect(matchesEvent({ ...emptyFilters(), apiKeyId: "other-key" }, SAMPLE_ROW)).toBe(false);
    expect(
      matchesEvent({ ...emptyFilters(), apiKeyId: id }, { ...SAMPLE_ROW, apiKeyId: null }),
    ).toBe(false);
    expect(
      matchesEvent({ ...emptyFilters(), apiKeyId: id }, { ...SAMPLE_ROW, apiKeyId: undefined }),
    ).toBe(false);
  });

  it("combines level, service, and text filters", () => {
    const filters: ParsedFilters = {
      ...emptyFilters(),
      levelOp: ">=",
      levelValue: 3,
      service: "api",
      includes: ["connection"],
      excludes: ["timeout"],
    };

    expect(matchesEvent(filters, SAMPLE_ROW)).toBe(true);
    expect(matchesEvent({ ...filters, levelValue: 4 }, SAMPLE_ROW)).toBe(false);
    expect(matchesEvent({ ...filters, excludes: ["connection"] }, SAMPLE_ROW)).toBe(false);
  });
});
