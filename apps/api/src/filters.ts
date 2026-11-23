import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { isBoolean, isFiniteNumber, isJsonObject, isString } from "./json.ts";
import type { JsonValue } from "./json.ts";
import type { KingletDb } from "./storage/db.ts";
import { projectKeyOf } from "./storage/project-keys.ts";
import { LEVEL_NAMES } from "./types.ts";
import type { SearchMode } from "./types.ts";

/**
 * The filter grammar:
 *   level:error        level equals error
 *   level>=warn        level comparisons
 *   service:api        service equals "api"
 *   env:prod           env equals "prod"
 *   key:0190f3a2-…     events ingested by that API key (UUID v7)
 *   "conn refused"     message contains phrase
 *   -healthcheck       message must NOT contain this
 *   field.imei:8643…   fields.imei equals (case-insensitive; numbers, booleans)
 *   field.status>=500  numeric comparison on a JSON number
 *   field.data.rss>250 nested key (up to 4 levels)
 *   field.error:*      the field exists
 *   -field.reason:dup  negates a field filter
 *   in:fields          free text searches the fields JSON instead of the
 *                      message; in:all searches both; in:message is the default
 *
 * buildWhere returns a Drizzle SQL condition (project-scoped) that both the
 * query route and the monitor engine use; matchesEvent is its in-memory twin
 * for the live tail and match monitors. The two must agree.
 */
export type TextScope = "message" | "fields" | "all";

export type FieldOp = "=" | ">" | ">=" | "<" | "<=" | "exists";

export interface FieldFilter {
  /** Object keys from the top of `fields`, e.g. ["data", "rss"]. */
  path: string[];
  op: FieldOp;
  /** Lowercased comparison text for "=". */
  value: string;
  /** Parsed number for the comparison operators. */
  numeric: number | null;
  negative: boolean;
}

export interface ParsedFilters {
  levelOp: "=" | ">" | ">=" | "<" | "<=" | null;
  levelValue: number | null;
  service: string | null;
  env: string | null;
  apiKeyId: string | null;
  includes: string[];
  excludes: string[];
  fields: FieldFilter[];
  textScope: TextScope;
}

/**
 * `field.<path><op><value>`. Keys are letters, digits, `_` and `-`, so a
 * path can never carry a quote into the JSON path expression.
 */
const FIELD_TOKEN =
  /^fields?\.([A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,3})(>=|<=|>|<|=|:)(.*)$/;

const SCOPE_TOKEN = /^in:(message|fields|all)$/i;

function parseFieldToken(token: string, negative: boolean): FieldFilter | null {
  const match = FIELD_TOKEN.exec(token);

  if (!match) return null;
  const path = (match[1] ?? "").split(".");
  const operator = match[2] ?? ":";
  const raw = match[3] ?? "";

  if (raw === "") return null;

  if (operator === ":" || operator === "=") {
    return raw === "*"
      ? { path, op: "exists", value: "", numeric: null, negative }
      : { path, op: "=", value: raw.toLowerCase(), numeric: null, negative };
  }

  const numeric = Number(raw);

  if (!Number.isFinite(numeric)) return null;
  const op = parseLevelOperator(operator);

  return op === null || op === "=" ? null : { path, op, value: raw, numeric, negative };
}

export interface EventRange {
  from: number;
  to: number;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const ch of input) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current) tokens.push(current);

  return tokens;
}

function parseTextScope(value: string): TextScope {
  const scope = value.toLowerCase();

  return scope === "fields" || scope === "all" ? scope : "message";
}

function levelIndex(value: string): number | null {
  const idx = LEVEL_NAMES.findIndex((name) => name === value.toLowerCase());

  return idx === -1 ? null : idx;
}

function parseLevelOperator(value: string): ParsedFilters["levelOp"] {
  switch (value) {
    case ":":
    case "=":
      return "=";
    case ">":
      return ">";
    case ">=":
      return ">=";
    case "<":
      return "<";
    case "<=":
      return "<=";
    default:
      return null;
  }
}

export function parseFilters(q: string): ParsedFilters {
  const f: ParsedFilters = {
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

  for (const token of tokenize(q)) {
    let t = token;
    let negative = false;

    if (t.startsWith("-") && t.length > 1) {
      negative = true;
      t = t.slice(1);
    }

    const levelMatch = /^level(>=|<=|>|<|=|:)(.+)$/i.exec(t);
    const kvMatch = /^(service|env):(.+)$/i.exec(t);

    const keyMatch =
      /^(?:key|api_key):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(t);

    if (!negative && levelMatch) {
      const value = levelIndex(levelMatch[2] ?? "");

      if (value !== null) {
        const op = parseLevelOperator(levelMatch[1] ?? "=");

        if (op === null) continue;
        f.levelOp = op;
        f.levelValue = value;
        continue;
      }
    }

    if (!negative && keyMatch) {
      f.apiKeyId = (keyMatch[1] ?? "").toLowerCase();
      continue;
    }

    const fieldFilter = parseFieldToken(t, negative);

    if (fieldFilter) {
      f.fields.push(fieldFilter);
      continue;
    }

    const scopeMatch = SCOPE_TOKEN.exec(t);

    if (!negative && scopeMatch) {
      f.textScope = parseTextScope(scopeMatch[1] ?? "");
      continue;
    }

    if (!negative && kvMatch) {
      const key = (kvMatch[1] ?? "").toLowerCase();
      const value = (kvMatch[2] ?? "").toLowerCase();

      if (key === "service") f.service = value;
      else f.env = value;
      continue;
    }

    if (negative) f.excludes.push(t.toLowerCase());
    else f.includes.push(t.toLowerCase());
  }

  return f;
}

/**
 * How free-text terms reach the database:
 *  - "index": the FTS5 index. Its MATCH runs over every project's messages
 *    before the project filter applies, so all eligible terms are combined
 *    into one MATCH (one pass over the index, not one per term).
 *  - "scan": LIKE over the caller's own project and time window, so the cost
 *    depends only on the caller's own data. chooseTextPlan picks it in
 *    substring mode when that window is small, where FTS work would mostly be
 *    spent on other projects' rows.
 */
export type TextPlan = "index" | "scan";

/** Own-window rows at or below which substring search scans instead of using the index. */
export const TEXT_SCAN_MAX_ROWS = 10_000;

/**
 * Terms the FTS index can answer:
 *  - substring (trigram): >= 3 chars, i.e. substring match.
 *  - words (unicode61): a phrase whose last word is a prefix, so `time`
 *    finds `timeout` and `conn ref` finds `conn refused`.
 * Everything else (off, short trigram terms, terms with no word characters)
 * is matched with LIKE over the project/time window.
 */
function ftsPhrase(term: string, search: SearchMode): string | null {
  const phrase = `"${term.replace(/"/g, '""')}"`;

  if (search === "substring" && term.length >= 3) return phrase;

  if (search === "words" && /[\p{L}\p{N}]/u.test(term)) return `${phrase}*`;

  return null;
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function messageLikeClause(term: string): SQL {
  return sql`message LIKE ${likePattern(term)} ESCAPE '\\'`;
}

/** Free text against the stored fields JSON (keys and values). */
function fieldsTextClause(term: string): SQL {
  return sql`coalesce(fields, '') LIKE ${likePattern(term)} ESCAPE '\\'`;
}

function ftsMatchClause(expression: string): SQL {
  return sql`id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ${expression})`;
}

/**
 * Include and exclude clauses for the free-text terms. Index-backed message
 * terms are folded into at most one MATCH for the includes (AND) and one for
 * the excludes (OR); other terms are per-row LIKEs.
 */
function textClauses(f: ParsedFilters, search: SearchMode, plan: TextPlan): SQL[] {
  if (f.textScope === "fields") {
    return [
      ...f.includes.map(fieldsTextClause),
      ...f.excludes.map((term) => sql`NOT (${fieldsTextClause(term)})`),
    ];
  }

  const useIndex = plan === "index" && search !== "off";

  if (f.textScope === "all") {
    // Each term may match the message or the fields, which one MATCH cannot
    // express; in words mode the index is still used per term, otherwise rows
    // are scanned within the caller's window.
    const clause = (term: string): SQL => {
      const phrase = useIndex && search === "words" ? ftsPhrase(term, search) : null;
      const message = phrase === null ? messageLikeClause(term) : ftsMatchClause(phrase);

      return sql`(${message} OR ${fieldsTextClause(term)})`;
    };

    return [...f.includes.map(clause), ...f.excludes.map((term) => sql`NOT (${clause(term)})`)];
  }

  const parts: SQL[] = [];
  const includePhrases: string[] = [];
  const excludePhrases: string[] = [];

  for (const term of f.includes) {
    const phrase = useIndex ? ftsPhrase(term, search) : null;

    if (phrase === null) parts.push(messageLikeClause(term));
    else includePhrases.push(phrase);
  }

  for (const term of f.excludes) {
    const phrase = useIndex ? ftsPhrase(term, search) : null;

    if (phrase === null) parts.push(sql`NOT (${messageLikeClause(term)})`);
    else excludePhrases.push(phrase);
  }

  if (includePhrases.length > 0) parts.push(ftsMatchClause(includePhrases.join(" AND ")));

  if (excludePhrases.length > 0) {
    parts.push(sql`NOT (${ftsMatchClause(excludePhrases.join(" OR "))})`);
  }

  return parts;
}

/** `$."data"."rss"`; keys are pre-validated by FIELD_TOKEN. */
function jsonPath(path: readonly string[]): string {
  return "$" + path.map((key) => `."${key}"`).join("");
}

/**
 * One field filter. Equality compares the value's text form, lowercased, with
 * JSON booleans and null spelled out; comparisons only match JSON numbers.
 * Missing fields never match, and a negated filter keeps rows without the
 * field.
 */
function fieldClause(filter: FieldFilter): SQL {
  const path = jsonPath(filter.path);
  let clause: SQL;

  if (filter.op === "exists") {
    clause = sql`json_type(fields, ${path}) IS NOT NULL`;
  } else if (filter.op === "=") {
    clause = sql`(CASE json_type(fields, ${path}) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null' ELSE lower(CAST(json_extract(fields, ${path}) AS TEXT)) END) = ${filter.value}`;
  } else {
    // Operator is a whitelisted literal; the value stays parameterized.
    clause = sql`(json_type(fields, ${path}) IN ('integer', 'real') AND json_extract(fields, ${path}) ${sql.raw(filter.op)} ${filter.numeric})`;
  }

  return filter.negative ? sql`NOT coalesce(${clause}, 0)` : sql`coalesce(${clause}, 0)`;
}

export function buildWhere(
  f: ParsedFilters,
  range: EventRange,
  projectId: string,
  search: SearchMode,
  plan: TextPlan = "index",
): SQL {
  const parts: SQL[] = windowClauses(range, projectId);

  if (f.levelOp && f.levelValue !== null) {
    // Operator is a whitelisted literal; the value stays parameterized.
    parts.push(sql`level ${sql.raw(f.levelOp)} ${f.levelValue}`);
  }

  if (f.service !== null) parts.push(sql`service = ${f.service}`);

  if (f.env !== null) parts.push(sql`env = ${f.env}`);

  if (f.apiKeyId !== null) parts.push(sql`api_key_id = ${f.apiKeyId}`);

  parts.push(...textClauses(f, search, plan));

  for (const filter of f.fields) parts.push(fieldClause(filter));

  return sql.join(parts, sql` AND `);
}

function windowClauses(range: EventRange, projectId: string): SQL[] {
  return [
    sql`project_key = ${projectKeyOf(projectId)}`,
    sql`ts >= ${range.from}`,
    sql`ts <= ${range.to}`,
  ];
}

/**
 * The text plan for a query: "scan" when substring search would otherwise
 * use the shared index for a project window small enough to read directly.
 * The count stops at the threshold, so it costs at most that many index rows.
 */
export async function chooseTextPlan(
  db: KingletDb,
  f: ParsedFilters,
  range: EventRange,
  projectId: string,
  search: SearchMode,
): Promise<TextPlan> {
  if (search !== "substring" || f.textScope === "fields") return "index";

  const indexed = [...f.includes, ...f.excludes].some((term) => ftsPhrase(term, search) !== null);

  if (!indexed) return "index";

  const window = sql.join(windowClauses(range, projectId), sql` AND `);

  const rows = await db.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM (SELECT 1 FROM events WHERE ${window} LIMIT ${TEXT_SCAN_MAX_ROWS + 1})`,
  );

  return Number(rows[0]?.n ?? 0) <= TEXT_SCAN_MAX_ROWS ? "scan" : "index";
}

/** Parses `q` and builds the project-scoped condition with the right text plan. */
export async function buildQueryWhere(
  db: KingletDb,
  q: string,
  range: EventRange,
  projectId: string,
  search: SearchMode,
): Promise<SQL> {
  const f = parseFilters(q);
  const plan = await chooseTextPlan(db, f, range, projectId, search);

  return buildWhere(f, range, projectId, search, plan);
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case "=":
      return a === b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    default:
      return false;
  }
}

interface FieldLookup {
  found: boolean;
  value: JsonValue;
}

function lookupField(root: JsonValue, path: readonly string[]): FieldLookup {
  let current: JsonValue = root;

  for (const key of path) {
    if (!isJsonObject(current) || !Object.hasOwn(current, key)) {
      return { found: false, value: null };
    }

    current = current[key] ?? null;
  }

  return { found: true, value: current };
}

/** Same text form as the SQL CASE in fieldClause. */
function fieldText(value: JsonValue): string {
  if (value === null) return "null";

  if (isString(value)) return value.toLowerCase();

  if (isBoolean(value) || isFiniteNumber(value)) return String(value);

  return JSON.stringify(value).toLowerCase();
}

function fieldMatches(filter: FieldFilter, root: JsonValue): boolean {
  const { found, value } = lookupField(root, filter.path);
  let matched: boolean;

  if (!found) matched = false;
  else if (filter.op === "exists") matched = true;
  else if (filter.op === "=") matched = fieldText(value) === filter.value;
  else
    matched =
      isFiniteNumber(value) && filter.numeric !== null && compare(value, filter.op, filter.numeric);

  return filter.negative ? !matched : matched;
}

function parseStoredFields(raw: string | null | undefined): JsonValue {
  if (!raw) return null;

  try {
    const parsed: JsonValue = JSON.parse(raw);

    return parsed;
  } catch {
    return null;
  }
}

/** In-memory equivalent of buildWhere, used to filter the SSE live tail. */
export function matchesEvent(
  f: ParsedFilters,
  row: {
    level: number;
    service: string | null;
    env: string | null;
    message: string;
    apiKeyId?: string | null;
    /** The stored fields JSON, needed only by field filters and in:fields. */
    fields?: string | null;
  },
): boolean {
  if (f.levelOp && f.levelValue !== null && !compare(row.level, f.levelOp, f.levelValue))
    return false;

  if (f.service !== null && (row.service ?? "").toLowerCase() !== f.service) return false;

  if (f.env !== null && (row.env ?? "").toLowerCase() !== f.env) return false;

  if (f.apiKeyId !== null && (row.apiKeyId ?? null) !== f.apiKeyId) return false;

  if (f.includes.length > 0 || f.excludes.length > 0) {
    const message = f.textScope === "fields" ? "" : row.message.toLowerCase();
    const fieldsText = f.textScope === "message" ? "" : (row.fields ?? "").toLowerCase();

    const containsTerm = (term: string): boolean => {
      if (f.textScope === "fields") return fieldsText.includes(term);

      if (f.textScope === "all") return message.includes(term) || fieldsText.includes(term);

      return message.includes(term);
    };

    for (const term of f.includes) {
      if (!containsTerm(term)) return false;
    }

    for (const term of f.excludes) {
      if (containsTerm(term)) return false;
    }
  }

  if (f.fields.length === 0) return true;
  const root = parseStoredFields(row.fields);

  return f.fields.every((filter) => fieldMatches(filter, root));
}
