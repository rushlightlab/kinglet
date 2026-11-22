import { describe, expect, it } from "vitest";
import { matchesEvent, parseFilters } from "../../src/filters.ts";
import type { ParsedFilters } from "../../src/filters.ts";

function emptyFilters(): ParsedFilters {
  return {
    levelOp: null,
    levelValue: null,
    service: null,
    env: null,
    apiKeyId: null,
    includes: [],
    excludes: [],
    fields: [],
    textScope: "message",
  };
}

const FIELDS_ROW = {
  level: 2,
  service: "udp",
  env: "production",
  message: "RUPTELA 864351050000101 · 3 records saved",
  apiKeyId: null,
  fields: JSON.stringify({
    imei: "864351050000101",
    savedCount: 3,
    durationMs: 1450,
    ack: true,
    reason: null,
    data: { rss: 251, protocol: "RUPTELA" },
  }),
};

function matches(q: string, row: Parameters<typeof matchesEvent>[1] = FIELDS_ROW): boolean {
  return matchesEvent(parseFilters(q), row);
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

  it("parses field equality, comparisons, existence, and negation", () => {
    expect(
      parseFilters("field.imei:8643 field.status>=500 field.error:* -field.reason:dup").fields,
    ).toEqual([
      { path: ["imei"], op: "=", value: "8643", numeric: null, negative: false },
      { path: ["status"], op: ">=", value: "500", numeric: 500, negative: false },
      { path: ["error"], op: "exists", value: "", numeric: null, negative: false },
      { path: ["reason"], op: "=", value: "dup", numeric: null, negative: true },
    ]);
  });

  it("keeps the case of field keys but lowercases compared values", () => {
    const [filter] = parseFilters("field.savedCount:ABC").fields;

    expect(filter).toMatchObject({ path: ["savedCount"], value: "abc" });
  });

  it("reads nested keys and quoted values", () => {
    expect(parseFilters('field.data.rss>250 field.reason:"already saved"').fields).toEqual([
      { path: ["data", "rss"], op: ">", value: "250", numeric: 250, negative: false },
      { path: ["reason"], op: "=", value: "already saved", numeric: null, negative: false },
    ]);
  });

  it("accepts fields. as an alias for field.", () => {
    expect(parseFilters("fields.imei:1").fields).toHaveLength(1);
  });

  it("treats malformed field tokens as free text", () => {
    const filters = parseFilters("field.status>abc field.imei: field.a.b.c.d.e:1 field.a$b:1");

    expect(filters.fields).toEqual([]);
    expect(filters.includes).toHaveLength(4);
  });

  it("sets the free-text scope, last token winning", () => {
    expect(parseFilters("timeout").textScope).toBe("message");
    expect(parseFilters("in:fields timeout").textScope).toBe("fields");
    expect(parseFilters("IN:ALL in:message").textScope).toBe("message");
    expect(parseFilters("in:all").includes).toEqual([]);
  });
});

describe("matchesEvent field filters", () => {
  it("compares strings, numbers, and booleans by their text", () => {
    expect(matches("field.imei:864351050000101")).toBe(true);
    expect(matches("field.savedCount:3")).toBe(true);
    expect(matches("field.ack:true")).toBe(true);
    expect(matches("field.reason:null")).toBe(true);
    expect(matches("field.imei:999")).toBe(false);
  });

  it("applies numeric comparisons only to numbers", () => {
    expect(matches("field.durationMs>1000")).toBe(true);
    expect(matches("field.durationMs<=1000")).toBe(false);
    expect(matches("field.imei>1")).toBe(false);
  });

  it("follows nested keys", () => {
    expect(matches("field.data.rss>=251")).toBe(true);
    expect(matches("field.data.protocol:ruptela")).toBe(true);
    expect(matches("field.data.missing:*")).toBe(false);
  });

  it("checks existence and keeps rows without the field for a negated filter", () => {
    expect(matches("field.ack:*")).toBe(true);
    expect(matches("field.error:*")).toBe(false);
    expect(matches("-field.error:boom")).toBe(true);
    expect(matches("-field.imei:864351050000101")).toBe(false);
  });

  it("never matches a field filter on an event without fields", () => {
    expect(matches("field.imei:*", { ...FIELDS_ROW, fields: null })).toBe(false);
    expect(matches("-field.imei:*", { ...FIELDS_ROW, fields: null })).toBe(true);
  });

  it("does not read inherited object properties", () => {
    expect(matches("field.constructor:*")).toBe(false);
    expect(matches("field.data.toString:*")).toBe(false);
  });

  it("searches the chosen text scope", () => {
    expect(matches("in:message ruptela")).toBe(true);
    expect(matches("in:message savedcount")).toBe(false);
    expect(matches("in:fields savedcount")).toBe(true);
    expect(matches("in:fields records")).toBe(false);
    expect(matches("in:all records savedcount")).toBe(true);
    expect(matches("in:all -savedcount")).toBe(false);
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
