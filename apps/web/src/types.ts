export const LEVEL_NAMES = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
/* Kinglet palette: faint greys for quiet levels, crown gold for warn,
   coral for error/fatal. */
export const LEVEL_COLORS = [
  "#4d5650",
  "#6b756c",
  "#b8c2c9",
  "#fcd34d",
  "#ff7a59",
  "#ff5c33",
] as const;

export interface KingletEvent {
  id: number;
  uid: string | null;
  apiKeyId: number | null;
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

export type MonitorKind = "match" | "count_above" | "count_below";

export type ChannelType = "webhook" | "discord" | "slack";

export interface NotifyChannel {
  type: ChannelType;
  url: string;
}

export interface Monitor {
  id: number;
  name: string;
  query: string;
  kind: MonitorKind;
  threshold: number;
  windowMs: number;
  intervalMs: number;
  cooldownMs: number;
  enabled: boolean;
  channels: NotifyChannel[];
  createdAt: number;
  updatedAt: number;
  /** Runtime observability from the alert engine. */
  lastEvalAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface AlertRecord {
  id: number;
  monitorId: number;
  monitorName: string | null;
  state: "fired" | "resolved";
  summary: string;
  count: number | null;
  sampleMessage: string | null;
  firedAt: number;
  resolvedAt: number | null;
  /** Delivery outcome of the "fired" notification. */
  notifyStatus: "sent" | "partial" | "failed" | "none" | null;
  notifyError: string | null;
}

export interface ChannelTestResult {
  type: string;
  ok: boolean;
  error?: string;
}

export interface Project {
  id: number;
  name: string;
  slug: string;
  createdAt: number;
  canClearLogs: boolean;
}

export interface ProjectMember {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  canClearLogs: boolean;
  addedAt: number;
}

export type UserRole = "admin" | "member" | "viewer";

export interface AppUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ApiKeyInfo {
  id: number;
  projectId: number;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}
