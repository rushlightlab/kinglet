import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    scopes: text("scopes").notNull().default("[]"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [index("idx_api_keys_project").on(table.projectId)]
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
  },
  (table) => [
    index("idx_events_ts").on(table.ts),
    index("idx_events_project_ts").on(table.projectId, table.ts),
    index("idx_events_project_key_ts").on(table.projectId, table.apiKeyId, table.ts),
    index("idx_events_service_ts").on(table.service, table.ts),
    index("idx_events_env_ts").on(table.env, table.ts),
    uniqueIndex("uq_events_uid").on(table.uid),
  ]
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
  (table) => [index("idx_monitors_project").on(table.projectId)]
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
  (table) => [index("idx_alerts_monitor").on(table.monitorId, table.firedAt)]
);

export type EventRow = typeof events.$inferSelect;
export type MonitorRow = typeof monitors.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;

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
  (table) => [index("session_user_id_idx").on(table.userId)]
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
  (table) => [index("account_user_id_idx").on(table.userId)]
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
  (table) => [index("verification_identifier_idx").on(table.identifier)]
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
  ]
);

export type AuthUserRow = typeof user.$inferSelect;
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
