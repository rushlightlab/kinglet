/**
 * Time windows for the log explorer. The quick-range grid mirrors the
 * familiar observability workflow: pick a relative window or fall back to
 * exact start/end times.
 */
export const DEFAULT_WINDOW_KEY = "1h";

/** Preset width in milliseconds. Keys are stable and used in component state. */
export const WINDOWS: Record<string, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "3h": 3 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "2d": 2 * 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "15d": 15 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

/** The backend clamps ranges to the last 31 days. */
export const MAX_RANGE_MS = 31 * 24 * 60 * 60_000;

export interface WindowPreset {
  key: string;
  label: string;
  gridLabel: string;
}

export const WINDOW_PRESETS: WindowPreset[] = [
  { key: "5m", label: "last 5m", gridLabel: "5 min" },
  { key: "15m", label: "last 15m", gridLabel: "15 min" },
  { key: "30m", label: "last 30m", gridLabel: "30 min" },
  { key: "1h", label: "last 1h", gridLabel: "1 hr" },
  { key: "3h", label: "last 3h", gridLabel: "3 hr" },
  { key: "6h", label: "last 6h", gridLabel: "6 hr" },
  { key: "1d", label: "last 1 day", gridLabel: "1 day" },
  { key: "2d", label: "last 2 days", gridLabel: "2 days" },
  { key: "7d", label: "last 7 days", gridLabel: "7 days" },
  { key: "15d", label: "last 15 days", gridLabel: "15 days" },
  { key: "30d", label: "last 30 days", gridLabel: "30 days" },
];

export type RefreshKey = "15s" | "1m" | "5m" | "off";

export interface RefreshOption {
  key: RefreshKey;
  label: string;
  short: string;
  ms: number | null;
}

/** A deliberate, small set instead of a cadence for every possible width. */
export const REFRESH_OPTIONS: RefreshOption[] = [
  { key: "15s", label: "15 secs", short: "15s", ms: 15_000 },
  { key: "1m", label: "1 min", short: "1m", ms: 60_000 },
  { key: "5m", label: "5 mins", short: "5m", ms: 5 * 60_000 },
  { key: "off", label: "off", short: "off", ms: null },
];

export function refreshMsFor(key: RefreshKey): number | null {
  return REFRESH_OPTIONS.find((option) => option.key === key)?.ms ?? null;
}

export function refreshLabel(key: RefreshKey): string {
  return REFRESH_OPTIONS.find((option) => option.key === key)?.short ?? "off";
}

/**
 * Default cadence follows the window the way Axiom does: a short window can
 * afford frequent re-queries, a month-long view cannot.
 */
export function recommendedRefreshKey(windowMs: number): RefreshKey {
  if (windowMs <= 15 * 60_000) return "15s";
  if (windowMs <= 6 * 60 * 60_000) return "1m";
  return "5m";
}

export function windowLabel(key: string): string {
  return WINDOW_PRESETS.find((preset) => preset.key === key)?.label ?? `last ${key}`;
}

/** Zero-pad a number for `datetime-local` formatting. */
export function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `datetime-local` expects `YYYY-MM-DDTHH:mm` in local time. */
export function toDatetimeLocal(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
