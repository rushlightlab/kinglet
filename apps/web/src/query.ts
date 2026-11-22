import { isJsonObject, isString } from "./json";
import type { JsonObject, JsonValue } from "./json";

/** Where free-text terms look: the message (default), the fields JSON, or both. */
export type TextScope = "message" | "fields" | "all";

export const TEXT_SCOPES: readonly { scope: TextScope; label: string; hint: string }[] = [
  { scope: "message", label: "message", hint: "Text matches the message (indexed, fastest)" },
  { scope: "fields", label: "fields", hint: "Text matches any field key or value" },
  { scope: "all", label: "both", hint: "Text matches the message or any field" },
];

const SCOPE_TOKEN = /^in:(message|fields|all)$/i;

/** Field keys the server accepts in a `field.` filter; see the API grammar. */
const FIELD_KEY = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_FIELD_DEPTH = 4;

function terms(q: string): string[] {
  return q.split(/\s+/).filter(Boolean);
}

/** The scope the query asks for; the last `in:` token wins, as on the server. */
export function textScopeOf(q: string): TextScope {
  let scope: TextScope = "message";

  for (const term of terms(q)) {
    const match = SCOPE_TOKEN.exec(term);
    const value = match?.[1]?.toLowerCase();

    if (value === "fields" || value === "all" || value === "message") scope = value;
  }

  return scope;
}

/** The query with its scope set; `message` is the default, so it is left implicit. */
export function withTextScope(q: string, scope: TextScope): string {
  const rest = terms(q).filter((term) => !SCOPE_TOKEN.test(term));

  return (scope === "message" ? rest : [...rest, `in:${scope}`]).join(" ");
}

/**
 * Whether the last term is still being typed: a key or operator with no value
 * yet (`level>=`, `service:`, `field.status>`, `in:`) or a field path without
 * an operator (`field.`, `field.imei`). Searching these mid-typing would run a
 * literal text search and flash an empty table, so the search box waits.
 * A trailing space means the term is finished.
 */
export function isIncompleteQuery(q: string): boolean {
  if (q === "" || /\s$/.test(q)) return false;
  const last = (terms(q).at(-1) ?? "").replace(/^-/, "");

  if (/^fields?\.[A-Za-z0-9_.-]*$/.test(last)) return true;

  return /^(level|service|env|key|api_key|in|fields?\.[A-Za-z0-9_.-]+)(:|=|>=|<=|>|<)$/i.test(last);
}

/** Adds a term unless the query already has it. */
export function addTerm(q: string, term: string): string {
  const parts = terms(q);

  return parts.includes(term) ? q : [...parts, term].join(" ");
}

function quoted(text: string): string | null {
  if (!/[\s"']/.test(text)) return text;

  if (!text.includes('"')) return `"${text}"`;

  return text.includes("'") ? null : `'${text}'`;
}

/**
 * `field.imei:864351050000101` for a scalar value, `field.data:*` (exists) for
 * an object or array. Null when the path cannot be written in the grammar.
 */
export function fieldFilterTerm(path: readonly string[], value: JsonValue): string | null {
  if (path.length === 0 || path.length > MAX_FIELD_DEPTH) return null;

  if (!path.every((key) => FIELD_KEY.test(key))) return null;
  const prefix = `field.${path.join(".")}`;

  if (Array.isArray(value) || isJsonObject(value)) return `${prefix}:*`;
  const text = value === null ? "null" : isString(value) ? value : String(value);

  if (text === "") return `${prefix}:*`;
  const written = quoted(text);

  return written === null ? null : `${prefix}:${written}`;
}

// ---------- autocomplete ----------

/** GET /v1/fields: what recent events contain, for suggestions. */
export interface FieldVocabularyEntry {
  path: string;
  count: number;
  types: string[];
  values: { value: string | number | boolean | null; count: number }[];
}

export interface Vocabulary {
  fields: FieldVocabularyEntry[];
  services: string[];
  envs: string[];
}

export const EMPTY_VOCABULARY: Vocabulary = { fields: [], services: [], envs: [] };

export interface Suggestion {
  /** What the menu shows. */
  label: string;
  /** Replaces the term being typed (a leading `-` is kept). */
  insert: string;
  detail: string;
  /** The term isn't finished yet (`field.imei:`), so suggestions continue. */
  continues: boolean;
}

export interface Suggestions {
  /** The span of the term being completed. */
  from: number;
  to: number;
  items: Suggestion[];
}

const MAX_SUGGESTIONS = 8;

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

const KEYWORDS: readonly Suggestion[] = [
  { label: "level>=", insert: "level>=", detail: "this level or worse", continues: true },
  { label: "level:", insert: "level:", detail: "exactly this level", continues: true },
  { label: "service:", insert: "service:", detail: "one service", continues: true },
  { label: "env:", insert: "env:", detail: "one environment", continues: true },
  { label: "field.", insert: "field.", detail: "a key in the event's fields", continues: true },
  { label: "in:fields", insert: "in:fields", detail: "text searches the fields", continues: false },
  {
    label: "in:all",
    insert: "in:all",
    detail: "text searches message and fields",
    continues: false,
  },
];

function startsWith(candidate: string, typed: string): boolean {
  return candidate.toLowerCase().startsWith(typed.toLowerCase());
}

function serviceSuggestion(prefix: string, name: string): Suggestion {
  const written = quoted(name.toLowerCase()) ?? name.toLowerCase();

  return {
    label: name,
    insert: `${prefix}${written}`,
    detail: prefix.slice(0, -1),
    continues: false,
  };
}

function fieldDetail(entry: FieldVocabularyEntry): string {
  return `${entry.types.join(" | ")} · in ${entry.count} recent events`;
}

function valueLabel(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

function fieldKeySuggestion(field: FieldVocabularyEntry): Suggestion {
  return {
    label: `field.${field.path}`,
    insert: `field.${field.path}:`,
    detail: fieldDetail(field),
    continues: true,
  };
}

function fieldSuggestions(typed: string, vocabulary: Vocabulary): Suggestion[] {
  const valueMatch = /^fields?\.([A-Za-z0-9_.-]+)(:|=)(.*)$/.exec(typed);

  if (valueMatch) {
    const path = valueMatch[1] ?? "";
    const partial = valueMatch[3] ?? "";
    const entry = vocabulary.fields.find((field) => field.path === path);
    const keyPath = path.split(".");

    const values = (entry?.values ?? []).flatMap((value): Suggestion[] => {
      const term = fieldFilterTerm(keyPath, value.value);
      const label = valueLabel(value.value);

      if (term === null || !startsWith(label, partial.replace(/^["']/, ""))) return [];

      return [{ label, insert: term, detail: `${value.count} recent events`, continues: false }];
    });

    const exists: Suggestion = {
      label: `${path}:*`,
      insert: `field.${path}:*`,
      detail: "the field exists",
      continues: false,
    };

    return partial === "" || partial === "*" ? [...values, exists] : values;
  }

  const keyMatch = /^fields?\.([A-Za-z0-9_.-]*)$/.exec(typed);

  if (!keyMatch) return [];
  const partialPath = keyMatch[1] ?? "";

  return vocabulary.fields.flatMap((field) =>
    startsWith(field.path, partialPath) ? [fieldKeySuggestion(field)] : [],
  );
}

function termSuggestions(typed: string, vocabulary: Vocabulary): Suggestion[] {
  const level = /^level(>=|<=|>|<|=|:)(\w*)$/i.exec(typed);

  if (level) {
    const op = level[1] ?? ":";

    return LEVELS.flatMap((name) =>
      startsWith(name, level[2] ?? "")
        ? [{ label: name, insert: `level${op}${name}`, detail: "level", continues: false }]
        : [],
    );
  }

  for (const [key, names] of [
    ["service", vocabulary.services],
    ["env", vocabulary.envs],
  ] as const) {
    const match = new RegExp(`^${key}:(.*)$`, "i").exec(typed);

    if (match) {
      const partial = (match[1] ?? "").replace(/^["']/, "").toLowerCase();

      return names.flatMap((name) =>
        name.toLowerCase().includes(partial) ? [serviceSuggestion(`${key}:`, name)] : [],
      );
    }
  }

  const scope = /^in:(\w*)$/i.exec(typed);

  if (scope) {
    return TEXT_SCOPES.flatMap(({ scope: option, hint }) =>
      startsWith(option, scope[1] ?? "")
        ? [{ label: `in:${option}`, insert: `in:${option}`, detail: hint, continues: false }]
        : [],
    );
  }

  if (/^fields?\./.test(typed)) return fieldSuggestions(typed, vocabulary);

  const keywords = KEYWORDS.filter((keyword) => startsWith(keyword.insert, typed));

  // Typing a bare word that names a field offers the field filter.
  const fields =
    typed.length >= 2
      ? vocabulary.fields.flatMap((field) =>
          field.path.toLowerCase().includes(typed.toLowerCase()) ? [fieldKeySuggestion(field)] : [],
        )
      : [];

  return [...keywords, ...fields];
}

/**
 * Suggestions for the term at the caret: keywords, levels, services, envs,
 * field keys, and a field's common values. Null when there is nothing to offer.
 */
export function suggest(text: string, caret: number, vocabulary: Vocabulary): Suggestions | null {
  const before = text.slice(0, caret);
  const from = before.search(/\S*$/);
  const after = text.slice(caret).search(/\s|$/);
  const to = caret + after;
  const term = text.slice(from, caret);
  const negative = term.startsWith("-");
  const typed = negative ? term.slice(1) : term;

  const items = termSuggestions(typed, vocabulary)
    .filter((item) => item.insert !== typed)
    .slice(0, MAX_SUGGESTIONS);

  return items.length === 0 ? null : { from, to, items };
}

export interface AppliedSuggestion {
  text: string;
  caret: number;
}

/** The query and caret after accepting a suggestion. */
export function applySuggestion(
  text: string,
  suggestions: Suggestions,
  item: Suggestion,
): AppliedSuggestion {
  const negative = text.slice(suggestions.from, suggestions.to).startsWith("-");
  const replacement = `${negative ? "-" : ""}${item.insert}`;
  const rest = text.slice(suggestions.to);
  const spacer = item.continues || rest.startsWith(" ") ? "" : " ";
  const next = `${text.slice(0, suggestions.from)}${replacement}${spacer}${rest}`;

  return { text: next, caret: suggestions.from + replacement.length + spacer.length };
}

export interface FieldLeaf {
  path: string[];
  value: JsonValue;
}

/** Leaf values of an event's fields, nested objects flattened up to 4 levels. */
export function fieldLeaves(fields: JsonObject, limit = 100): FieldLeaf[] {
  const leaves: FieldLeaf[] = [];

  const walk = (object: JsonObject, path: string[]): void => {
    for (const [key, value] of Object.entries(object)) {
      if (leaves.length >= limit) return;
      const next = [...path, key];

      if (isJsonObject(value) && next.length < MAX_FIELD_DEPTH && Object.keys(value).length > 0) {
        walk(value, next);
      } else {
        leaves.push({ path: next, value });
      }
    }
  };

  walk(fields, []);

  return leaves;
}
