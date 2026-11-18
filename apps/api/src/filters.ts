import { LEVEL_NAMES } from "./db.js";
import type { StoredEvent } from "./types.js";

/**
 * The filter grammar:
 *   level:error        level equals error
 *   level>=warn        level comparisons
 *   service:api        service equals "api"
 *   env:prod           env equals "prod"
 *   "conn refused"     message contains phrase
 *   -healthcheck       message must NOT contain this
 *
 * Examples:
 *   level>=warn service:api -healthcheck
 *   "connection refused" env:prod
 */
export interface ParsedFilters {
  levelOp: "=" | ">" | ">=" | "<" | "<=" | null;
  levelValue: number | null;
  service: string | null;
  env: string | null;
  includes: string[];
  excludes: string[];
}

export interface EventRange {
  from: number;
  to: number;
}

export interface WhereClause {
  sql: string;
  params: (string | number)[];
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
  const idx = (LEVEL_NAMES as readonly string[]).indexOf(value.toLowerCase());
  return idx === -1 ? null : idx;
}

export function parseFilters(q: string): ParsedFilters {
  const f: ParsedFilters = { levelOp: null, levelValue: null, service: null, env: null, includes: [], excludes: [] };
  for (const token of tokenize(q)) {
    let t = token;
    let negative = false;
    if (t.startsWith("-") && t.length > 1) {
      negative = true;
      t = t.slice(1);
    }
    const levelMatch = /^level(>=|<=|>|<|=|:)(.+)$/i.exec(t);
    const kvMatch = /^(service|env):(.+)$/i.exec(t);
    if (!negative && levelMatch) {
      const value = levelIndex(levelMatch[2] ?? "");
      if (value !== null) {
        const op = levelMatch[1] ?? "=";
        f.levelOp = op === ":" ? "=" : (op as ParsedFilters["levelOp"]);
        f.levelValue = value;
        continue;
      }
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
 * Free-text terms: >= 3 chars go through FTS5 trigram phrase search
 * (substring semantics), shorter ones fall back to LIKE.
 */
function textClause(term: string): WhereClause {
  if (term.length >= 3) {
    const phrase = `"${term.replace(/"/g, '""')}"`;
    return {
      sql: "id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)",
      params: [phrase],
    };
  }
  return { sql: "message LIKE ?", params: [`%${term}%`] };
}

export function buildWhere(f: ParsedFilters, range: EventRange): WhereClause {
  const parts: string[] = ["ts >= ?", "ts <= ?"];
  const params: (string | number)[] = [range.from, range.to];
  if (f.levelOp && f.levelValue !== null) {
    parts.push(`level ${f.levelOp} ?`);
    params.push(f.levelValue);
  }
  if (f.service !== null) {
    parts.push("service = ?");
    params.push(f.service);
  }
  if (f.env !== null) {
    parts.push("env = ?");
    params.push(f.env);
  }
  for (const term of f.includes) {
    const clause = textClause(term);
    parts.push(clause.sql);
    params.push(...clause.params);
  }
  for (const term of f.excludes) {
    const clause = textClause(term);
    parts.push(`NOT (${clause.sql})`);
    params.push(...clause.params);
  }
  return { sql: parts.join(" AND "), params };
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case "=": return a === b;
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    default: return false;
  }
}

/** In-memory equivalent of buildWhere, used to filter the SSE live tail. */
export function matchesEvent(f: ParsedFilters, row: StoredEvent): boolean {
  if (f.levelOp && f.levelValue !== null && !compare(row.level, f.levelOp, f.levelValue)) return false;
  if (f.service !== null && (row.service ?? "").toLowerCase() !== f.service) return false;
  if (f.env !== null && (row.env ?? "").toLowerCase() !== f.env) return false;
  const message = row.message.toLowerCase();
  for (const term of f.includes) {
    if (!message.includes(term)) return false;
  }
  for (const term of f.excludes) {
    if (message.includes(term)) return false;
  }
  return true;
}
