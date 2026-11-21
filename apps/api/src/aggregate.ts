import type { AggregateGroupBy, AggregateGroupRow } from "./storage/types.ts";
import { LEVEL_NAMES } from "./types.ts";

/**
 * Aggregation helpers for `GET /v1/aggregate`. The group-by dimension is a
 * closed set: callers never supply a column, SQL fragment, or expression.
 */
export const AGGREGATE_GROUP_BYS = ["service", "level", "env"] as const;

export const DEFAULT_AGGREGATE_GROUPS = 50;
export const MAX_AGGREGATE_GROUPS = 200;

export interface AggregateGroup {
  key: string | null;
  count: number;
}

export function isAggregateGroupBy(value: string): value is AggregateGroupBy {
  return AGGREGATE_GROUP_BYS.some((candidate) => candidate === value);
}

function levelName(level: number): string {
  // Ingest clamps levels to 0–5; keep a readable fallback for rows written by
  // an older/manual client instead of returning a bare number.
  return LEVEL_NAMES[level] ?? "unknown";
}

/** Map storage rows to the public shape; level values become names. */
export function toAggregateGroups(rows: readonly AggregateGroupRow[]): AggregateGroup[] {
  return rows.map((row) =>
    row.dimension === "level"
      ? { key: levelName(row.key), count: row.count }
      : { key: row.key, count: row.count },
  );
}
