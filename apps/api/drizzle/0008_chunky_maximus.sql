CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `archive_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`date` text NOT NULL,
	`first_id` integer NOT NULL,
	`last_id` integer NOT NULL,
	`event_count` integer NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_archive_parts_project_date` ON `archive_parts` (`project_id`,`date`);--> statement-breakpoint
CREATE TABLE `archive_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`schedule_cron` text DEFAULT '0 3 * * *' NOT NULL,
	`schedule_timezone` text DEFAULT 'UTC' NOT NULL,
	`delete_on_failure` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`phase` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`size_bytes` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_backup_runs_started` ON `backup_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `backup_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`schedule_cron` text DEFAULT '0 3 * * *' NOT NULL,
	`schedule_timezone` text DEFAULT 'UTC' NOT NULL,
	`retention_count` integer DEFAULT 7 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`trigger` text DEFAULT 'scheduled' NOT NULL,
	`manifest_key` text NOT NULL,
	`object_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`encryption` text DEFAULT 'none' NOT NULL,
	`app_version` text NOT NULL,
	`schema_version` integer NOT NULL,
	`counts_json` text DEFAULT '{}' NOT NULL,
	`state` text DEFAULT 'ready' NOT NULL,
	`downloaded_at` integer,
	`downloaded_by` text,
	`discovered` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_backup_snapshots_created` ON `backup_snapshots` (`created_at`);--> statement-breakpoint
CREATE TABLE `monitor_channels` (
	`monitor_id` text NOT NULL,
	`channel_id` text NOT NULL,
	PRIMARY KEY(`monitor_id`, `channel_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_monitor_channels_channel` ON `monitor_channels` (`channel_id`);--> statement-breakpoint
CREATE TABLE `notification_channel_actions` (
	`channel_id` text NOT NULL,
	`action` text NOT NULL,
	PRIMARY KEY(`channel_id`, `action`)
);
--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`decoration` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_test_at` integer,
	`last_test_status` text,
	`last_test_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notification_channels_type_url` ON `notification_channels` (`type`,`url`);--> statement-breakpoint
CREATE INDEX `idx_notification_channels_created` ON `notification_channels` (`created_at`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`scope` text NOT NULL,
	`event` text NOT NULL,
	`subject` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_created` ON `notification_deliveries` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_channel` ON `notification_deliveries` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_archive_settings` (
	`project_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE `api_keys` ADD `key_type` text DEFAULT 'api' NOT NULL;