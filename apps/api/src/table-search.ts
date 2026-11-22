import { and, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

/** Bounds on a table search so one request can't build an unbounded query. */
export const TABLE_SEARCH_MAX_LENGTH = 200;
export const TABLE_SEARCH_MAX_WORDS = 8;

/** The search's words, lowercased, capped in length and count. */
export function tableSearchWords(q: string | undefined): string[] {
  if (q === undefined) return [];

  return q
    .slice(0, TABLE_SEARCH_MAX_LENGTH)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, TABLE_SEARCH_MAX_WORDS);
}

/** `%word%` with LIKE's wildcards escaped, for use with `ESCAPE '\'`. */
export function containsPattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Every word must appear in at least one of the columns, in any order and
 * case — the same rule as the UI's table search. Undefined for a blank search.
 */
export function tableSearchCondition(
  q: string | undefined,
  columns: readonly SQLWrapper[],
): SQL | undefined {
  const words = tableSearchWords(q);

  if (words.length === 0) return undefined;

  return and(
    ...words.map((word) => {
      const pattern = containsPattern(word);

      return or(...columns.map((column) => sql`lower(${column}) LIKE ${pattern} ESCAPE '\\'`));
    }),
  );
}
