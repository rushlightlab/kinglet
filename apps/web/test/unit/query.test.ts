import { describe, expect, it } from "vitest";
import {
  addTerm,
  applySuggestion,
  fieldFilterTerm,
  fieldLeaves,
  suggest,
  textScopeOf,
  withTextScope,
} from "../../src/query";
import type { Vocabulary } from "../../src/query";

describe("textScopeOf", () => {
  it("defaults to the message", () => {
    expect(textScopeOf("timeout service:api")).toBe("message");
  });

  it("uses the last in: token, like the server", () => {
    expect(textScopeOf("in:fields timeout")).toBe("fields");
    expect(textScopeOf("in:fields IN:ALL")).toBe("all");
  });
});

describe("withTextScope", () => {
  it("replaces any existing scope token", () => {
    expect(withTextScope("timeout in:fields", "all")).toBe("timeout in:all");
  });

  it("leaves the default scope implicit", () => {
    expect(withTextScope("timeout in:all", "message")).toBe("timeout");
  });
});

describe("addTerm", () => {
  it("appends a new term once", () => {
    expect(addTerm("level:error", "field.imei:1")).toBe("level:error field.imei:1");
    expect(addTerm("level:error field.imei:1", "field.imei:1")).toBe("level:error field.imei:1");
  });
});

describe("fieldFilterTerm", () => {
  it("writes scalar values as equality filters", () => {
    expect(fieldFilterTerm(["imei"], "864351050000101")).toBe("field.imei:864351050000101");
    expect(fieldFilterTerm(["savedCount"], 3)).toBe("field.savedCount:3");
    expect(fieldFilterTerm(["ack"], true)).toBe("field.ack:true");
    expect(fieldFilterTerm(["reason"], null)).toBe("field.reason:null");
  });

  it("quotes values with spaces or quotes", () => {
    expect(fieldFilterTerm(["reason"], "already saved")).toBe('field.reason:"already saved"');
    expect(fieldFilterTerm(["note"], 'say "hi"')).toBe(`field.note:'say "hi"'`);
    expect(fieldFilterTerm(["note"], `it's "x"`)).toBeNull();
  });

  it("filters objects, arrays, and empty strings by existence", () => {
    expect(fieldFilterTerm(["data"], { rss: 1 })).toBe("field.data:*");
    expect(fieldFilterTerm(["tags"], ["a"])).toBe("field.tags:*");
    expect(fieldFilterTerm(["note"], "")).toBe("field.note:*");
  });

  it("joins nested paths and rejects keys the grammar cannot express", () => {
    expect(fieldFilterTerm(["data", "rss"], 251)).toBe("field.data.rss:251");
    expect(fieldFilterTerm(["user id"], 1)).toBeNull();
    expect(fieldFilterTerm(["a", "b", "c", "d", "e"], 1)).toBeNull();
  });
});

const VOCABULARY: Vocabulary = {
  fields: [
    {
      path: "imei",
      count: 40,
      types: ["string"],
      values: [
        { value: "864351050000101", count: 30 },
        { value: "864351050000202", count: 10 },
      ],
    },
    { path: "durationMs", count: 40, types: ["number"], values: [{ value: 14, count: 3 }] },
    { path: "data.rss", count: 5, types: ["number"], values: [] },
    { path: "reason", count: 2, types: ["string"], values: [{ value: "already saved", count: 2 }] },
  ],
  services: ["http", "udp", "My Worker"],
  envs: ["production", "staging"],
};

function labels(text: string, caret = text.length): string[] {
  return suggest(text, caret, VOCABULARY)?.items.map((item) => item.label) ?? [];
}

describe("suggest", () => {
  it("offers the grammar's keywords for an empty or partial term", () => {
    expect(labels("")).toEqual([
      "level>=",
      "level:",
      "service:",
      "env:",
      "field.",
      "in:fields",
      "in:all",
    ]);
    expect(labels("ser")).toEqual(["service:"]);
  });

  it("completes levels after a level operator", () => {
    expect(labels("level>=w")).toEqual(["warn"]);
    expect(labels("level:")).toHaveLength(6);
  });

  it("completes services and environments", () => {
    expect(labels("service:u")).toEqual(["udp"]);
    expect(labels("env:")).toEqual(["production", "staging"]);
    expect(suggest("service:my", 10, VOCABULARY)?.items[0]?.insert).toBe('service:"my worker"');
  });

  it("completes field keys, then their common values", () => {
    expect(labels("field.")).toEqual([
      "field.imei",
      "field.durationMs",
      "field.data.rss",
      "field.reason",
    ]);
    expect(labels("field.d")).toEqual(["field.durationMs", "field.data.rss"]);
    expect(labels("field.imei:")).toEqual(["864351050000101", "864351050000202", "imei:*"]);
    expect(labels("field.imei:86435105000020")).toEqual(["864351050000202"]);
    expect(suggest("field.reason:", 13, VOCABULARY)?.items[0]?.insert).toBe(
      'field.reason:"already saved"',
    );
  });

  it("offers a field filter for a bare word that names a field", () => {
    expect(labels("im")).toEqual(["field.imei"]);
  });

  it("completes the term at the caret, not the end of the query", () => {
    const result = suggest("level>=w service:u", 8, VOCABULARY);

    expect(result).toMatchObject({ from: 0, to: 8 });
    expect(result?.items.map((item) => item.label)).toEqual(["warn"]);
  });

  it("has nothing to offer for finished or unknown terms", () => {
    expect(suggest("level>=warn", 11, VOCABULARY)).toBeNull();
    expect(suggest("zzz", 3, VOCABULARY)).toBeNull();
  });
});

describe("applySuggestion", () => {
  it("replaces the term and adds a space after a finished term", () => {
    const result = suggest("level>=w", 8, VOCABULARY);
    const item = result?.items[0];

    expect(result && item ? applySuggestion("level>=w", result, item) : null).toEqual({
      text: "level>=warn ",
      caret: 12,
    });
  });

  it("keeps an unfinished term open so values can follow", () => {
    const result = suggest("field.im", 8, VOCABULARY);
    const item = result?.items[0];

    expect(result && item ? applySuggestion("field.im", result, item) : null).toEqual({
      text: "field.imei:",
      caret: 11,
    });
  });

  it("keeps a negation and the rest of the query", () => {
    const text = "-field.imei:8643510500001 level>=warn";
    const result = suggest(text, 25, VOCABULARY);
    const item = result?.items[0];

    expect(result && item ? applySuggestion(text, result, item).text : null).toBe(
      "-field.imei:864351050000101 level>=warn",
    );
  });
});

describe("fieldLeaves", () => {
  it("flattens nested objects into key paths", () => {
    expect(fieldLeaves({ imei: "1", data: { rss: 251, cpu: 1 }, tags: ["x"] })).toEqual([
      { path: ["imei"], value: "1" },
      { path: ["data", "rss"], value: 251 },
      { path: ["data", "cpu"], value: 1 },
      { path: ["tags"], value: ["x"] },
    ]);
  });

  it("stops at the row limit", () => {
    expect(fieldLeaves({ a: 1, b: 2, c: 3 }, 2)).toHaveLength(2);
  });
});
