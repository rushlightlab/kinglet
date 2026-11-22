import { isBoolean, isFiniteNumber, isJsonObject, isString } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";

/**
 * The field keys, value types, and common values seen in a sample of recent
 * events: what query autocomplete suggests after `field.`. Bounded on every
 * axis so a project with wide or high-cardinality fields stays cheap.
 */
export type FieldValueType = "string" | "number" | "boolean" | "null" | "object" | "array";

export interface FieldValueCount {
  value: string | number | boolean | null;
  count: number;
}

export interface FieldVocabularyEntry {
  /** Dotted path from the top of `fields`, as written after `field.`. */
  path: string;
  /** Events in the sample that have this field. */
  count: number;
  types: FieldValueType[];
  /** Most frequent short scalar values, most common first. */
  values: FieldValueCount[];
}

export interface VocabularyInput {
  fields: string | null;
  service: string | null;
  env: string | null;
}

export interface Vocabulary {
  sampled: number;
  fields: FieldVocabularyEntry[];
  services: string[];
  envs: string[];
}

const MAX_DEPTH = 4;

const MAX_KEYS = 200;

const MAX_VALUES = 10;

/** Distinct values tracked per key before new ones stop being counted. */
const MAX_TRACKED_VALUES = 200;

const MAX_VALUE_CHARS = 64;

/** Same rule as the query grammar's `field.` keys. */
const KEY = /^[A-Za-z0-9_-]{1,64}$/;

interface KeyStats {
  count: number;
  types: Set<FieldValueType>;
  values: Map<string, FieldValueCount>;
}

function valueType(value: JsonValue): FieldValueType {
  if (value === null) return "null";

  if (isString(value)) return "string";

  if (isFiniteNumber(value)) return "number";

  if (isBoolean(value)) return "boolean";

  return Array.isArray(value) ? "array" : "object";
}

function scalar(value: JsonValue): string | number | boolean | null | undefined {
  if (value === null || isFiniteNumber(value) || isBoolean(value)) return value;

  if (isString(value) && value.length > 0 && value.length <= MAX_VALUE_CHARS) return value;

  return undefined;
}

function parseFields(raw: string | null): JsonObject | null {
  if (!raw) return null;

  try {
    const parsed: JsonValue = JSON.parse(raw);

    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function record(stats: Map<string, KeyStats>, path: string, value: JsonValue): void {
  let entry = stats.get(path);

  if (!entry) {
    if (stats.size >= MAX_KEYS) return;
    entry = { count: 0, types: new Set(), values: new Map() };
    stats.set(path, entry);
  }

  entry.count++;
  entry.types.add(valueType(value));
  const plain = scalar(value);

  if (plain === undefined) return;
  const id = JSON.stringify(plain);
  const known = entry.values.get(id);

  if (known) known.count++;
  else if (entry.values.size < MAX_TRACKED_VALUES) entry.values.set(id, { value: plain, count: 1 });
}

function walk(stats: Map<string, KeyStats>, object: JsonObject, prefix: string[]): void {
  for (const [key, value] of Object.entries(object)) {
    if (!KEY.test(key)) continue;
    const path = [...prefix, key];

    record(stats, path.join("."), value);

    if (isJsonObject(value) && path.length < MAX_DEPTH) walk(stats, value, path);
  }
}

function distinct(values: readonly (string | null)[]): string[] {
  const seen = new Set<string>();

  for (const value of values) if (value) seen.add(value);

  const sorted = [...seen];

  sorted.sort((a, b) => a.localeCompare(b));

  return sorted;
}

export function buildVocabulary(rows: readonly VocabularyInput[]): Vocabulary {
  const stats = new Map<string, KeyStats>();

  for (const row of rows) {
    const fields = parseFields(row.fields);

    if (fields) walk(stats, fields, []);
  }

  const fields: FieldVocabularyEntry[] = [];

  for (const [path, entry] of stats) {
    const types = [...entry.types];
    const values = [...entry.values.values()];

    types.sort();
    values.sort((a, b) => b.count - a.count);
    fields.push({ path, count: entry.count, types, values: values.slice(0, MAX_VALUES) });
  }

  fields.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  return {
    sampled: rows.length,
    fields,
    services: distinct(rows.map((row) => row.service)),
    envs: distinct(rows.map((row) => row.env)),
  };
}
