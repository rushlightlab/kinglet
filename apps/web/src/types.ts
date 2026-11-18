export const LEVEL_NAMES = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export const LEVEL_COLORS = [
  "#475569",
  "#64748b",
  "#38bdf8",
  "#fbbf24",
  "#f87171",
  "#ef4444",
] as const;

export interface KingletEvent {
  id: number;
  ts: number;
  level: number;
  service: string | null;
  env: string | null;
  message: string;
  fields: Record<string, unknown> | null;
}

export interface Service {
  name: string;
  count: number;
}

export interface HistogramPoint {
  ts: number;
  counts: number[];
}

export interface Histogram {
  from: number;
  to: number;
  bucketMs: number;
  points: HistogramPoint[];
}

export interface EventPage {
  events: KingletEvent[];
  nextCursor: number | null;
}
