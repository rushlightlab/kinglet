import { useCallback, useEffect, useRef, useState } from "react";
import { UnauthorizedError } from "./api";
import type { PageQuery } from "./api";

export const PAGE_SIZES = [5, 20, 50, 100] as const;

export type PageSize = (typeof PAGE_SIZES)[number];

const DEFAULT_PAGE_SIZE: PageSize = 5;
const SEARCH_DEBOUNCE_MS = 250;

/** What a table's loader returns: one page of rows and the matching total. */
export interface TablePage<T> {
  rows: T[];
  total: number;
}

export interface ServerTable<T> {
  rows: T[];
  /** Rows matching the active search, across every page. */
  total: number;
  /** The first page for this source has arrived (success or error). */
  loaded: boolean;
  /** A request is in flight. */
  loading: boolean;
  error: string | null;
  /** What's typed in the search box. */
  query: string;
  setQuery: (query: string) => void;
  /** The search the shown rows match; lags \`query\` by the debounce. */
  activeQuery: string;
  /** Zero-based. */
  page: number;
  setPage: (page: number) => void;
  pageSize: PageSize;
  setPageSize: (size: PageSize) => void;
  /** Refetch the current page, e.g. after a change. */
  reload: () => Promise<void>;
}

export function isPageSize(value: number): value is PageSize {
  return PAGE_SIZES.some((size) => size === value);
}

function pageSizeKey(tableKey: string): string {
  return `kinglet.pageSize.${tableKey}`;
}

function readPageSize(tableKey: string): PageSize {
  try {
    const stored = Number(localStorage.getItem(pageSizeKey(tableKey)));

    return isPageSize(stored) ? stored : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

function writePageSize(tableKey: string, size: PageSize): void {
  try {
    localStorage.setItem(pageSizeKey(tableKey), String(size));
  } catch {
    // Storage can be blocked; the size still applies for this visit.
  }
}

/** "21–40 of 134": the 1-based span of rows on a page, and how many pages there are. */
export interface PageSpanInfo {
  from: number;
  to: number;
  pages: number;
}

export function pageSpan(page: number, pageSize: number, total: number): PageSpanInfo {
  const pages = Math.max(1, Math.ceil(total / pageSize));

  if (total === 0) return { from: 0, to: 0, pages };

  return { from: page * pageSize + 1, to: Math.min(total, (page + 1) * pageSize), pages };
}

/**
 * A table whose search and paging run on the server. \`load\` fetches one page;
 * when it changes (say, another project), the table starts over at page one.
 * \`tableKey\` remembers the chosen page size per table.
 */
export function useServerTable<T>(
  tableKey: string,
  load: (page: PageQuery) => Promise<TablePage<T>>,
): ServerTable<T> {
  const [query, setQueryText] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSizeState] = useState<PageSize>(() => readPageSize(tableKey));
  const [result, setResult] = useState<TablePage<T>>({ rows: [], total: 0 });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may update the table.
  const requestSeq = useRef(0);

  // A new source starts from placeholders, not the previous source's rows.
  const [source, setSource] = useState(() => load);

  if (source !== load) {
    setSource(() => load);
    setPage(0);
    setLoaded(false);
    setResult({ rows: [], total: 0 });
  }

  // Apply the typed search after a pause, back on page one.
  useEffect(() => {
    if (query === activeQuery) return;

    const timer = setTimeout(() => {
      setActiveQuery(query);
      setPage(0);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, activeQuery]);

  const fetchPage = useCallback(async () => {
    const seq = ++requestSeq.current;

    setLoading(true);

    try {
      const next = await load({ limit: pageSize, offset: page * pageSize, q: activeQuery });

      if (seq !== requestSeq.current) return;
      const lastPage = Math.max(0, Math.ceil(next.total / pageSize) - 1);

      // Deleting the last row of the last page: step back to the new last page.
      if (page > lastPage) {
        setPage(lastPage);

        return;
      }

      setResult(next);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current || err instanceof UnauthorizedError) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [load, page, pageSize, activeQuery]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  const setQuery = useCallback((next: string) => {
    setQueryText(next);

    // Clearing applies at once; typing waits for the debounce.
    if (next.trim() === "") {
      setActiveQuery("");
      setPage(0);
    }
  }, []);

  const setPageSize = useCallback(
    (size: PageSize) => {
      writePageSize(tableKey, size);
      setPageSizeState(size);
      setPage(0);
    },
    [tableKey],
  );

  return {
    rows: result.rows,
    total: result.total,
    loaded,
    loading,
    error,
    query,
    setQuery,
    activeQuery,
    page,
    setPage,
    pageSize,
    setPageSize,
    reload: fetchPage,
  };
}

/** Rows already on screen fade while the next page or search loads. */
export function fadeWhileLoading(table: { loaded: boolean; loading: boolean }): string {
  return table.loaded && table.loading ? "opacity-50 transition-opacity" : "transition-opacity";
}
