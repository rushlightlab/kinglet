/**
 * Shared filter-complexity guard for ad-hoc queries and stored monitor
 * queries. Keeping this in one place prevents the monitor path from accepting
 * a query that the HTTP query routes reject.
 */
export function validateQueryString(q: string): string | null {
  if (q.length > 500) return "filter is too long (max 500 characters)";

  if (q.split(/\s+/).filter(Boolean).length > 32) return "too many filter terms (max 32)";

  return null;
}
