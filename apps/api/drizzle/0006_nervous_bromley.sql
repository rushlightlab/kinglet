PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "name", "slug", "created_at")
SELECT COALESCE(m.new_id, CAST(p.id AS TEXT)), p.name, p.slug, p.created_at
FROM `projects` p LEFT JOIN `__uuid_projects` m ON m.old_id = p.id;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `__new_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_api_keys`("id", "project_id", "name", "prefix", "key_hash", "scopes", "created_by", "created_at", "last_used_at")
SELECT
	COALESCE(km.new_id, CAST(k.id AS TEXT)),
	COALESCE(pm.new_id, CAST(k.project_id AS TEXT)),
	k.name, k.prefix, k.key_hash, k.scopes, k.created_by, k.created_at, k.last_used_at
FROM `api_keys` k
LEFT JOIN `__uuid_api_keys` km ON km.old_id = k.id
LEFT JOIN `__uuid_projects` pm ON pm.old_id = k.project_id;--> statement-breakpoint
DROP TABLE `api_keys`;--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_project` ON `api_keys` (`project_id`);--> statement-breakpoint
CREATE TABLE `__new_monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
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
	`updated_at` integer NOT NULL,
	`last_eval_at` integer,
	`last_error` text,
	`last_error_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_monitors`("id", "project_id", "name", "query", "kind", "threshold", "window_ms", "interval_ms", "cooldown_ms", "enabled", "channels", "created_at", "updated_at", "last_eval_at", "last_error", "last_error_at")
SELECT
	COALESCE(mm.new_id, CAST(m.id AS TEXT)),
	COALESCE(pm.new_id, CAST(m.project_id AS TEXT)),
	m.name, m.query, m.kind, m.threshold, m.window_ms, m.interval_ms, m.cooldown_ms,
	m.enabled, m.channels, m.created_at, m.updated_at, m.last_eval_at, m.last_error, m.last_error_at
FROM `monitors` m
LEFT JOIN `__uuid_monitors` mm ON mm.old_id = m.id
LEFT JOIN `__uuid_projects` pm ON pm.old_id = m.project_id;--> statement-breakpoint
DROP TABLE `monitors`;--> statement-breakpoint
ALTER TABLE `__new_monitors` RENAME TO `monitors`;--> statement-breakpoint
CREATE INDEX `idx_monitors_project` ON `monitors` (`project_id`);--> statement-breakpoint
CREATE TABLE `__new_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`state` text NOT NULL,
	`summary` text NOT NULL,
	`count` integer,
	`sample_message` text,
	`fired_at` integer NOT NULL,
	`resolved_at` integer,
	`notify_status` text,
	`notify_error` text
);
--> statement-breakpoint
INSERT INTO `__new_alerts`("id", "monitor_id", "state", "summary", "count", "sample_message", "fired_at", "resolved_at", "notify_status", "notify_error")
SELECT
	COALESCE(am.new_id, CAST(a.id AS TEXT)),
	COALESCE(mm.new_id, CAST(a.monitor_id AS TEXT)),
	a.state, a.summary, a.count, a.sample_message, a.fired_at, a.resolved_at,
	a.notify_status, a.notify_error
FROM `alerts` a
LEFT JOIN `__uuid_alerts` am ON am.old_id = a.id
LEFT JOIN `__uuid_monitors` mm ON mm.old_id = a.monitor_id;--> statement-breakpoint
DROP TABLE `alerts`;--> statement-breakpoint
ALTER TABLE `__new_alerts` RENAME TO `alerts`;--> statement-breakpoint
CREATE INDEX `idx_alerts_monitor` ON `alerts` (`monitor_id`,`fired_at`);--> statement-breakpoint
CREATE TABLE `__new_project_members` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`can_clear_logs` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_project_members`("id", "project_id", "user_id", "can_clear_logs", "created_at")
SELECT
	COALESCE(pmm.new_id, CAST(pm.id AS TEXT)),
	COALESCE(prm.new_id, CAST(pm.project_id AS TEXT)),
	pm.user_id, pm.can_clear_logs, pm.created_at
FROM `project_members` pm
LEFT JOIN `__uuid_project_members` pmm ON pmm.old_id = pm.id
LEFT JOIN `__uuid_projects` prm ON prm.old_id = pm.project_id;--> statement-breakpoint
DROP TABLE `project_members`;--> statement-breakpoint
ALTER TABLE `__new_project_members` RENAME TO `project_members`;--> statement-breakpoint
CREATE INDEX `idx_project_members_project` ON `project_members` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_members_user` ON `project_members` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_project_members` ON `project_members` (`project_id`,`user_id`);--> statement-breakpoint
UPDATE `events`
SET `project_id` = COALESCE(
	(SELECT new_id FROM `__uuid_projects` WHERE old_id = `events`.`project_id`),
	CAST(`events`.`project_id` AS TEXT)
);--> statement-breakpoint
UPDATE `events`
SET `api_key_id` = (SELECT new_id FROM `__uuid_api_keys` WHERE old_id = `events`.`api_key_id`)
WHERE `api_key_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE IF EXISTS `__uuid_projects`;--> statement-breakpoint
DROP TABLE IF EXISTS `__uuid_api_keys`;--> statement-breakpoint
DROP TABLE IF EXISTS `__uuid_monitors`;--> statement-breakpoint
DROP TABLE IF EXISTS `__uuid_alerts`;--> statement-breakpoint
DROP TABLE IF EXISTS `__uuid_project_members`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
