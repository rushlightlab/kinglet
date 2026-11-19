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

const REFRESH_MS: Record<string, number> = {
  "5m": 5_000,
  "15m": 10_000,
  "30m": 15_000,
  "1h": 15_000,
  "3h": 30_000,
  "6h": 30_000,
  "1d": 60_000,
  "2d": 2 * 60_000,
  "7d": 5 * 60_000,
  "15d": 10 * 60_000,
  "30d": 15 * 60_000,
};

/**
 * Live refresh cadence. Wide windows change slowly, so polling hard only
 * burns CPU; narrow windows need a faster tick to stay useful.
 */
export function refreshIntervalForWindow(key: string): number {
  return REFRESH_MS[key] ?? 15_000;
}

export function refreshIntervalForRange(from: number, to: number): number {
  const width = Math.max(0, to - from);
  if (width <= 10 * 60_000) return 5_000;
  if (width <= 60 * 60_000) return 15_000;
  if (width <= 6 * 60 * 60_000) return 30_000;
  if (width <= 24 * 60 * 60_000) return 60_000;
  if (width <= 7 * 24 * 60 * 60_000) return 5 * 60_000;
  return 15 * 60_000;
}

export function formatRefresh(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

export function windowLabel(key: string): string {
  return WINDOW_PRESETS.find((preset) => preset.key === key)?.label ?? `last ${key}`;
}

/** `datetime-local` expects `YYYY-MM-DDTHH:mm` in local time. */
export function toDatetimeLocal(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}
