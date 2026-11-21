-- Store a compact integer project key on events instead of the 36-byte UUID.
-- Every existing project and every project id still present on events (even
-- one whose project row is gone) gets a key, so no event row is dropped.
CREATE TABLE `project_keys` (
	`project_id` text PRIMARY KEY NOT NULL,
	`key` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `project_keys_key_unique` ON `project_keys` (`key`);--> statement-breakpoint
INSERT INTO `project_keys` (`project_id`, `key`)
	SELECT `project_id`, row_number() OVER (ORDER BY `project_id`)
	FROM (SELECT `id` AS `project_id` FROM `projects` UNION SELECT DISTINCT `project_id` FROM `events`);--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` integer PRIMARY KEY,
	`uid` text,
	`project_key` integer NOT NULL,
	`api_key_id` text,
	`ts` integer NOT NULL,
	`level` integer NOT NULL,
	`service` text,
	`env` text,
	`message` text NOT NULL,
	`fields` text,
	`size_bytes` integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
-- Row ids are preserved: they are the public cursor and the FTS5 rowid.
INSERT INTO `__new_events` (`id`, `uid`, `project_key`, `api_key_id`, `ts`, `level`, `service`, `env`, `message`, `fields`, `size_bytes`)
	SELECT e.`id`, e.`uid`, k.`key`, e.`api_key_id`, e.`ts`, e.`level`, e.`service`, e.`env`, e.`message`, e.`fields`, e.`size_bytes`
	FROM `events` e JOIN `project_keys` k ON k.`project_id` = e.`project_id`;--> statement-breakpoint
-- Dropping the table also drops its triggers. The usage triggers are
-- recreated below; the full-text triggers depend on KINGLET_SEARCH and are
-- restored at boot after migrations.
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
CREATE INDEX `idx_events_ts` ON `events` (`ts`);--> statement-breakpoint
CREATE INDEX `idx_events_project_ts` ON `events` (`project_key`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_events_project_level_ts` ON `events` (`project_key`,`level`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_events_project_service_ts` ON `events` (`project_key`,`service`,`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_events_uid` ON `events` (`uid`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS events_usage_ai AFTER INSERT ON events BEGIN
	INSERT OR IGNORE INTO project_usage (project_id, bytes, events)
		SELECT project_id, 0, 0 FROM project_keys WHERE key = new.project_key;
	UPDATE project_usage SET bytes = bytes + new.size_bytes, events = events + 1
		WHERE project_id = (SELECT project_id FROM project_keys WHERE key = new.project_key);
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS events_usage_ad AFTER DELETE ON events BEGIN
	UPDATE project_usage
		SET bytes = MAX(0, bytes - old.size_bytes), events = MAX(0, events - 1)
		WHERE project_id = (SELECT project_id FROM project_keys WHERE key = old.project_key);
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS events_usage_au AFTER UPDATE OF size_bytes, project_key ON events BEGIN
	UPDATE project_usage
		SET bytes = MAX(0, bytes - old.size_bytes), events = MAX(0, events - 1)
		WHERE project_id = (SELECT project_id FROM project_keys WHERE key = old.project_key);
	INSERT OR IGNORE INTO project_usage (project_id, bytes, events)
		SELECT project_id, 0, 0 FROM project_keys WHERE key = new.project_key;
	UPDATE project_usage SET bytes = bytes + new.size_bytes, events = events + 1
		WHERE project_id = (SELECT project_id FROM project_keys WHERE key = new.project_key);
END;
