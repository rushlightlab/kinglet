import { describe, expect, it } from "vitest";
import { buildVocabulary } from "../../src/field-vocabulary.ts";
import type { VocabularyInput } from "../../src/field-vocabulary.ts";
import type { JsonObject } from "../../src/json.ts";

function row(
  fields: JsonObject | null,
  service: string | null = "udp",
  env = "prod",
): VocabularyInput {
  return { fields: fields === null ? null : JSON.stringify(fields), service, env };
}

describe("buildVocabulary", () => {
  it("lists keys by how many events have them, with their types", () => {
    const vocabulary = buildVocabulary([
      row({ imei: "1", savedCount: 3 }),
      row({ imei: "2", ack: true }),
      row(null),
    ]);

    expect(vocabulary.sampled).toBe(3);
    expect(vocabulary.fields.map((field) => [field.path, field.count, field.types])).toEqual([
      ["imei", 2, ["string"]],
      ["ack", 1, ["boolean"]],
      ["savedCount", 1, ["number"]],
    ]);
  });

  it("flattens nested objects into dotted paths", () => {
    const [data, rss] = buildVocabulary([row({ data: { rss: 251 } })]).fields;

    expect(data).toMatchObject({ path: "data", types: ["object"], values: [] });
    expect(rss).toMatchObject({ path: "data.rss", types: ["number"] });
  });

  it("keeps the most common short values, most frequent first", () => {
    const vocabulary = buildVocabulary([
      row({ protocol: "RUPTELA" }),
      row({ protocol: "RUPTELA" }),
      row({ protocol: "GOSAFE" }),
      row({ protocol: "x".repeat(200) }),
    ]);

    expect(vocabulary.fields[0]?.values).toEqual([
      { value: "RUPTELA", count: 2 },
      { value: "GOSAFE", count: 1 },
    ]);
  });

  it("skips keys the query grammar cannot express", () => {
    const vocabulary = buildVocabulary([row({ "user id": 1, ok: 1 })]);

    expect(vocabulary.fields.map((field) => field.path)).toEqual(["ok"]);
  });

  it("collects the services and envs seen, sorted and without blanks", () => {
    const vocabulary = buildVocabulary([
      row(null, "udp", "prod"),
      row(null, "http", "staging"),
      row(null, null, "prod"),
    ]);

    expect(vocabulary.services).toEqual(["http", "udp"]);
    expect(vocabulary.envs).toEqual(["prod", "staging"]);
  });

  it("ignores malformed stored fields", () => {
    expect(buildVocabulary([{ fields: "{not json", service: null, env: null }]).fields).toEqual([]);
  });
});
