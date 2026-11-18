DROP TABLE IF EXISTS `users`;
--> statement-breakpoint
DROP TABLE IF EXISTS `sessions`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `alerts` (
	`id` integer PRIMARY KEY NOT NULL,
	`monitor_id` integer NOT NULL,
	`state` text NOT NULL,
	`summary` text NOT NULL,
	`count` integer,
	`sample_message` text,
	`fired_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_alerts_monitor` ON `alerts` (`monitor_id`,`fired_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_keys` (
	`id` integer PRIMARY KEY NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_api_keys_project` ON `api_keys` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `events` (
	`id` integer PRIMARY KEY NOT NULL,
	`project_id` integer DEFAULT 1 NOT NULL,
	`ts` integer NOT NULL,
	`level` integer NOT NULL,
	`service` text,
	`env` text,
	`message` text NOT NULL,
	`fields` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_ts` ON `events` (`ts`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_project_ts` ON `events` (`project_id`,`ts`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_service_ts` ON `events` (`service`,`ts`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_env_ts` ON `events` (`env`,`ts`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `monitors` (
	`id` integer PRIMARY KEY NOT NULL,
	`project_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`query` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'count_above' NOT NULL,
	`threshold` integer DEFAULT 1 NOT NULL,
	`window_ms` integer DEFAULT 300000 NOT NULL,
	`interval_ms` integer DEFAULT 60000 NOT NULL,
	`cooldown_ms` integer DEFAULT 600000 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`channels` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_monitors_project` ON `monitors` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `projects` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`role` text,
	`banned` integer,
	`ban_reason` text,
	`ban_expires` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5 (
	message,
	content='events',
	content_rowid='id',
	tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
	INSERT INTO events_fts (rowid, message) VALUES (new.id, new.message);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
	INSERT INTO events_fts (events_fts, rowid, message) VALUES ('delete', old.id, old.message);
END;
