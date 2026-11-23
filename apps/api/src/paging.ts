import { tableSearchWords } from "./table-search.ts";

/**
 * `?limit=&offset=&q=` for the UI's tables. Without `limit` a list endpoint
 * returns every row, as it always has, so existing callers are unaffected.
 */
export interface PageRequest {
  limit: number | null;
  offset: number;
  q: string | undefined;
}

export const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 1_000_000;

function boundedInt(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Math.trunc(Number(raw));

  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}

export function readPageRequest(query: (name: string) => string | undefined): PageRequest {
  return {
    limit: boundedInt(query("limit"), 1, MAX_PAGE_SIZE),
    offset: boundedInt(query("offset"), 0, MAX_OFFSET) ?? 0,
    q: query("q"),
  };
}

type Searchable = string | number | null | undefined;

/** One page of a list, and how many rows matched across every page. */
export interface ListPage<T> {
  items: T[];
  total: number;
}

/** Every search word appears somewhere in the row's text, in any order and case. */
export function matchesTableSearch(q: string | undefined, values: readonly Searchable[]): boolean {
  const words = tableSearchWords(q);

  if (words.length === 0) return true;

  const text = values
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();

  return words.every((word) => text.includes(word));
}

/**
 * Search and page a list the handler already holds. For lists that stay small
 * (users, projects, keys, members, monitors, channels, snapshots); growing
 * histories page in SQL instead.
 */
export function pageList<T>(
  items: readonly T[],
  page: PageRequest,
  text: (item: T) => readonly Searchable[],
): ListPage<T> {
  const matching = items.filter((item) => matchesTableSearch(page.q, text(item)));
  const start = Math.min(page.offset, matching.length);
  const end = page.limit === null ? matching.length : start + page.limit;

  return { items: matching.slice(start, end), total: matching.length };
}
