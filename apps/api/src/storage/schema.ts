import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Bump when a migration changes the on-disk contract (restore uses this). */
export const SCHEMA_VERSION = 9;

/**
 * Kinglet's schema in Drizzle.
 *
 * Notes:
 *  - ids are plain INTEGER PRIMARY KEY (SQLite rowid aliases), matching the
 *    original hand-written schema — no AUTOINCREMENT.
 *  - The events FTS5 virtual table and its triggers are not expressible in
 *    Drizzle; they live in the baseline SQL migration (drizzle/0000_init.sql)
 *    and are referenced from raw SQL fragments in the query code.
 *  - Emails are normalized to lowercase in application code (collation-free
 *    so both local and Turso behave identically).
 */

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

// NOTE: the user/session/account/verification tables are managed by Better
// Auth and defined at the bottom of this file.

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    /** "api" (kl_) or "mcp" (km_). Scope vocabularies are disjoint. */
    keyType: text("key_type").notNull().default("api"),
    scopes: text("scopes").notNull().default("[]"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [index("idx_api_keys_project").on(table.projectId)],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey(),
    // Public, time-sortable identifier for single-event lookups. The integer
    // id stays the rowid so FTS5 external content and pagination keep working.
    uid: text("uid"),
    projectId: text("project_id").notNull(),
    apiKeyId: text("api_key_id"),
    ts: integer("ts").notNull(),
    level: integer("level").notNull(),
    service: text("service"),
    env: text("env"),
    message: text("message").notNull(),
    fields: text("fields"),
    /** UTF-8 bytes of the stored payload; maintained on insert. */
    sizeBytes: integer("size_bytes").notNull().default(0),
  },
  (table) => [
    index("idx_events_ts").on(table.ts),
    index("idx_events_project_ts").on(table.projectId, table.ts),
    index("idx_events_project_key_ts").on(table.projectId, table.apiKeyId, table.ts),
    index("idx_events_service_ts").on(table.service, table.ts),
    index("idx_events_env_ts").on(table.env, table.ts),
    uniqueIndex("uq_events_uid").on(table.uid),
  ],
);

/**
 * Per-project event/byte accounting, maintained by triggers on `events`.
 * The global database cap prevents disk exhaustion; this keeps one tenant from
 * consuming the shared store and denying ingest to everyone else.
 */
export const projectUsage = sqliteTable("project_usage", {
  projectId: text("project_id").primaryKey(),
  bytes: integer("bytes").notNull().default(0),
  events: integer("events").notNull().default(0),
});

/**
 * Small key/value metadata table. `schema_version` is written after migrations
 * so a restored snapshot can be refused when it is newer than this build.
 */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const backupSettings = sqliteTable("backup_settings", {
  id: integer("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  scheduleCron: text("schedule_cron").notNull().default("0 3 * * *"),
  scheduleTimezone: text("schedule_timezone").notNull().default("UTC"),
  retentionCount: integer("retention_count").notNull().default(7),
  updatedAt: integer("updated_at").notNull(),
});

export const backupRuns = sqliteTable(
  "backup_runs",
  {
    id: text("id").primaryKey(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    phase: text("phase"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    sizeBytes: integer("size_bytes"),
    error: text("error"),
  },
  (table) => [index("idx_backup_runs_started").on(table.startedAt)],
);

export const backupSnapshots = sqliteTable(
  "backup_snapshots",
  {
    id: text("id").primaryKey(),
    /** Run that produced this snapshot; null for rows discovered from the bucket. */
    runId: text("run_id"),
    trigger: text("trigger").notNull().default("scheduled"),
    manifestKey: text("manifest_key").notNull(),
    objectKey: text("object_key").notNull(),
    createdAt: integer("created_at").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    encryption: text("encryption").notNull().default("none"),
    appVersion: text("app_version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    countsJson: text("counts_json").notNull().default("{}"),
    state: text("state").notNull().default("ready"),
    downloadedAt: integer("downloaded_at"),
    downloadedBy: text("downloaded_by"),
    discovered: integer("discovered", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("idx_backup_snapshots_created").on(table.createdAt)],
);

export const notificationChannels = sqliteTable(
  "notification_channels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    url: text("url").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    decoration: integer("decoration", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastTestAt: integer("last_test_at"),
    lastTestStatus: text("last_test_status"),
    lastTestError: text("last_test_error"),
  },
  (table) => [
    uniqueIndex("uq_notification_channels_type_url").on(table.type, table.url),
    index("idx_notification_channels_created").on(table.createdAt),
  ],
);

export const notificationChannelActions = sqliteTable(
  "notification_channel_actions",
  {
    channelId: text("channel_id").notNull(),
    action: text("action").notNull(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.action] })],
);

export const monitorChannels = sqliteTable(
  "monitor_channels",
  {
    monitorId: text("monitor_id").notNull(),
    channelId: text("channel_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.channelId] }),
    index("idx_monitor_channels_channel").on(table.channelId),
  ],
);

export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull(),
    scope: text("scope").notNull(),
    event: text("event").notNull(),
    subject: text("subject").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_notification_deliveries_created").on(table.createdAt),
    index("idx_notification_deliveries_channel").on(table.channelId, table.createdAt),
  ],
);

export const archiveSettings = sqliteTable("archive_settings", {
  id: integer("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  scheduleCron: text("schedule_cron").notNull().default("0 3 * * *"),
  scheduleTimezone: text("schedule_timezone").notNull().default("UTC"),
  deleteOnFailure: integer("delete_on_failure", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull(),
});

export const projectArchiveSettings = sqliteTable("project_archive_settings", {
  projectId: text("project_id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
});

export const archiveParts = sqliteTable(
  "archive_parts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    date: text("date").notNull(),
    firstId: integer("first_id").notNull(),
    lastId: integer("last_id").notNull(),
    eventCount: integer("event_count").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_archive_parts_project_date").on(table.projectId, table.date),
    uniqueIndex("uq_archive_parts_object_key").on(table.objectKey),
  ],
);

export const monitors = sqliteTable(
  "monitors",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    query: text("query").notNull().default(""),
    kind: text("kind").notNull().default("count_above"),
    threshold: integer("threshold").notNull().default(1),
    windowMs: integer("window_ms").notNull().default(300_000),
    intervalMs: integer("interval_ms").notNull().default(60_000),
    cooldownMs: integer("cooldown_ms").notNull().default(600_000),
    enabled: integer("enabled").notNull().default(1),
    channels: text("channels").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // runtime observability (written by the alert engine)
    lastEvalAt: integer("last_eval_at"),
    lastError: text("last_error"),
    lastErrorAt: integer("last_error_at"),
  },
  (table) => [index("idx_monitors_project").on(table.projectId)],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    monitorId: text("monitor_id").notNull(),
    state: text("state").notNull(),
    summary: text("summary").notNull(),
    count: integer("count"),
    sampleMessage: text("sample_message"),
    firedAt: integer("fired_at").notNull(),
    resolvedAt: integer("resolved_at"),
    // delivery outcome of the "fired" notification
    notifyStatus: text("notify_status"),
    notifyError: text("notify_error"),
  },
  (table) => [
    index("idx_alerts_monitor").on(table.monitorId, table.firedAt),
    index("idx_alerts_fired").on(table.firedAt),
  ],
);

export type EventRow = typeof events.$inferSelect;

export type MonitorRow = typeof monitors.$inferSelect;

export type AlertRow = typeof alerts.$inferSelect;

export type ProjectRow = typeof projects.$inferSelect;

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export type ProjectUsageRow = typeof projectUsage.$inferSelect;

export type BackupRunRow = typeof backupRuns.$inferSelect;

export type BackupSnapshotRow = typeof backupSnapshots.$inferSelect;

export type NotificationChannelRow = typeof notificationChannels.$inferSelect;

export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;

export type ArchivePartRow = typeof archiveParts.$inferSelect;

// ---------------------------------------------------------------------------
// Better Auth tables (drizzle adapter). Table exports must be named exactly
// user / session / account / verification. Indexes follow the official
// performance guide: users.email, sessions.userId+token, accounts.userId,
// verifications.identifier.
// ---------------------------------------------------------------------------

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  // admin plugin
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" }),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/**
 * Per-project access for non-admin users. Admins bypass membership and can
 * see every project. Existing installations are backfilled to grant every
 * user access to every project, so upgrading does not silently lock anyone
 * out; admins can then prune assignments.
 */
export const projectMembers = sqliteTable(
  "project_members",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    canClearLogs: integer("can_clear_logs", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_project_members_project").on(table.projectId),
    index("idx_project_members_user").on(table.userId),
    uniqueIndex("uq_project_members").on(table.projectId, table.userId),
  ],
);

export type AuthUserRow = typeof user.$inferSelect;

export type ProjectMemberRow = typeof projectMembers.$inferSelect;
