import { isJsonObject, isString } from "./json";
import type { JsonObject } from "./json";

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
  apiKeyId: string | null;
  ts: number;
  level: number;
  service: string | null;
  env: string | null;
  message: string;
  fields: JsonObject | null;
}

export function isKingletEvent(value: unknown): value is KingletEvent {
  if (!isJsonObject(value)) return false;

  return (
    typeof value.id === "number" &&
    Number.isFinite(value.id) &&
    (value.uid === null || isString(value.uid)) &&
    (value.apiKeyId === null || isString(value.apiKeyId)) &&
    typeof value.ts === "number" &&
    Number.isFinite(value.ts) &&
    typeof value.level === "number" &&
    Number.isFinite(value.level) &&
    (value.service === null || isString(value.service)) &&
    (value.env === null || isString(value.env)) &&
    isString(value.message) &&
    (value.fields === null || isJsonObject(value.fields))
  );
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
  id: string;
  name: string;
  query: string;
  kind: MonitorKind;
  threshold: number;
  windowMs: number;
  intervalMs: number;
  cooldownMs: number;
  enabled: boolean;
  /** Legacy inline channels. Kept for one release; prefer `channelIds`. */
  channels?: NotifyChannel[];
  /** Channel ids selected on the monitor. Preferred over legacy `channels`. */
  channelIds?: string[];
  /** Server-resolved channel summaries; never contain webhook URLs. */
  resolvedChannels?: NotificationChannelSummary[];
  createdAt: number;
  updatedAt: number;
  /** Runtime observability from the alert engine. */
  lastEvalAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface AlertRecord {
  id: string;
  monitorId: string;
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
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  canClearLogs: boolean;
  /** Present once the archive settings endpoint reports per-project state. */
  archiveEnabled?: boolean;
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

export type KeyType = "api" | "mcp";

export interface ApiKeyInfo {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  scopes: string[];
  /** Defaults to `api` when an older server omits it. */
  keyType?: KeyType;
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

// ---------- notification channels ----------

export type NotificationAction =
  | "backup.succeeded"
  | "backup.failed"
  | "backup.restore_staged"
  | "archive.succeeded"
  | "archive.failed"
  | "system.warning";

export interface NotificationChannelHealth {
  status: string;
  lastDeliveryAt: number | null;
  error?: string | null;
}

export interface NotificationChannelSummary {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  health: NotificationChannelHealth;
}

export interface NotificationChannel {
  id: string;
  name: string;
  type: ChannelType;
  /** Masked in list responses; the single-channel read returns the full URL. */
  url: string;
  enabled: boolean;
  decoration: boolean;
  actions: NotificationAction[];
  createdAt: number;
  updatedAt: number;
  lastTestAt: number | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
}

export interface NotificationChannelInput {
  name: string;
  type: ChannelType;
  url: string;
  enabled: boolean;
  decoration: boolean;
  actions: NotificationAction[];
}

export interface NotificationDelivery {
  id: string;
  channelId: string;
  scope: string;
  event: string;
  subject: string | null;
  status: string;
  error: string | null;
  createdAt: number;
}

// ---------- backups, archive, and system events ----------

export type BackupPhase = "snapshot" | "compress" | "encrypt" | "upload" | "verify" | "retention";

export type BackupTrigger = "scheduled" | "manual" | "catch-up" | "discovered";

export type BackupEncryption = "none" | "age";

export interface BackupStatus {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  phase: BackupPhase | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  nextRunAt: number | null;
  lastError: string | null;
  databaseBytes: number | null;
  /** Environment variable names only — never values. */
  setupMissing: string[];
  /** Optional server hints, tolerated when absent. */
  storage?: string;
  configState?: string;
  restoreStagedId?: string | null;
}

export interface BackupSettings {
  enabled: boolean;
  scheduleCron: string;
  scheduleTimezone: string;
  retentionCount: number;
  updatedAt: number;
}

export interface BackupSettingsInput {
  enabled: boolean;
  scheduleCron: string;
  scheduleTimezone: string;
  retentionCount: number;
}

export interface BackupSchedulePreview {
  valid: boolean;
  description?: string;
  nextRuns?: number[];
  error?: string;
}

export interface BackupCounts {
  projects: number;
  users: number;
  events: number;
  monitors: number;
}

export interface BackupSnapshot {
  id: string;
  runId: string | null;
  trigger: BackupTrigger;
  createdAt: number;
  sizeBytes: number;
  sha256: string;
  encryption: BackupEncryption;
  appVersion: string;
  schemaVersion: number;
  counts: BackupCounts;
  state: string;
  downloadedAt: number | null;
  downloadedBy: string | null;
  discovered: boolean;
}

export interface ArchiveStatus {
  enabled: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastError: string | null;
}

export interface ArchiveSettings {
  enabled: boolean;
  scheduleCron: string;
  scheduleTimezone: string;
  deleteOnFailure: boolean;
  updatedAt: number;
}

export interface SystemStatus {
  backup: BackupStatus;
  archive: ArchiveStatus;
  at: number;
}

export interface BackupProgress {
  runId: string;
  phase: BackupPhase;
  done: number | null;
  total: number | null;
  at: number;
}

export interface ArchiveProgress {
  projectId: string;
  phase: string;
  done: number | null;
  total: number | null;
  at: number;
}
