import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
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
 *
 * buildWhere returns a Drizzle SQL condition (project-scoped) that both the
 * query route and the monitor engine use.
 */
export interface ParsedFilters {
  levelOp: "=" | ">" | ">=" | "<" | "<=" | null;
  levelValue: number | null;
  service: string | null;
  env: string | null;
  apiKeyId: string | null;
  includes: string[];
  excludes: string[];
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
 * Free-text terms, by search index:
 *  - substring (trigram): >= 3 chars use an FTS5 phrase, i.e. substring match.
 *  - words (unicode61): an FTS5 phrase whose last word is a prefix, so `time`
 *    finds `timeout` and `conn ref` finds `conn refused`.
 *  - off, short trigram terms, or terms with no word characters: LIKE with
 *    escaped wildcards over the project/time window.
 */
function textClause(term: string, search: SearchMode): SQL {
  const phrase = `"${term.replace(/"/g, '""')}"`;

  if (search === "substring" && term.length >= 3) {
    return sql`id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ${phrase})`;
  }

  if (search === "words" && /[\p{L}\p{N}]/u.test(term)) {
    return sql`id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ${`${phrase}*`})`;
  }

  const escaped = term.replace(/[\\%_]/g, (ch) => `\\${ch}`);

  return sql`message LIKE ${`%${escaped}%`} ESCAPE '\\'`;
}

export function buildWhere(
  f: ParsedFilters,
  range: EventRange,
  projectId: string,
  search: SearchMode,
): SQL {
  const parts: SQL[] = [
    sql`project_key = ${projectKeyOf(projectId)}`,
    sql`ts >= ${range.from}`,
    sql`ts <= ${range.to}`,
  ];

  if (f.levelOp && f.levelValue !== null) {
    // Operator is a whitelisted literal; the value stays parameterized.
    parts.push(sql`level ${sql.raw(f.levelOp)} ${f.levelValue}`);
  }

  if (f.service !== null) parts.push(sql`service = ${f.service}`);

  if (f.env !== null) parts.push(sql`env = ${f.env}`);

  if (f.apiKeyId !== null) parts.push(sql`api_key_id = ${f.apiKeyId}`);

  for (const term of f.includes) parts.push(textClause(term, search));

  for (const term of f.excludes) parts.push(sql`NOT (${textClause(term, search)})`);

  return sql.join(parts, sql` AND `);
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

/** In-memory equivalent of buildWhere, used to filter the SSE live tail. */
export function matchesEvent(
  f: ParsedFilters,
  row: {
    level: number;
    service: string | null;
    env: string | null;
    message: string;
    apiKeyId?: string | null;
  },
): boolean {
  if (f.levelOp && f.levelValue !== null && !compare(row.level, f.levelOp, f.levelValue))
    return false;

  if (f.service !== null && (row.service ?? "").toLowerCase() !== f.service) return false;

  if (f.env !== null && (row.env ?? "").toLowerCase() !== f.env) return false;

  if (f.apiKeyId !== null && (row.apiKeyId ?? null) !== f.apiKeyId) return false;
  const message = row.message.toLowerCase();

  for (const term of f.includes) {
    if (!message.includes(term)) return false;
  }

  for (const term of f.excludes) {
    if (message.includes(term)) return false;
  }

  return true;
}
