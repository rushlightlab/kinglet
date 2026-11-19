CREATE TABLE `project_usage` (
	`project_id` text PRIMARY KEY NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`events` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `events` ADD `size_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `events` SET `size_bytes` =
	length(CAST(`message` AS BLOB)) +
	length(CAST(COALESCE(`fields`, '') AS BLOB)) +
	length(CAST(COALESCE(`service`, '') AS BLOB)) +
	length(CAST(COALESCE(`env`, '') AS BLOB));--> statement-breakpoint
INSERT OR REPLACE INTO `project_usage` (`project_id`, `bytes`, `events`)
	SELECT `project_id`, SUM(`size_bytes`), COUNT(*) FROM `events` GROUP BY `project_id`;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS events_usage_ai AFTER INSERT ON events BEGIN
	INSERT OR IGNORE INTO project_usage (project_id, bytes, events) VALUES (new.project_id, 0, 0);
	UPDATE project_usage SET bytes = bytes + new.size_bytes, events = events + 1 WHERE project_id = new.project_id;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS events_usage_ad AFTER DELETE ON events BEGIN
	UPDATE project_usage
		SET bytes = MAX(0, bytes - old.size_bytes), events = MAX(0, events - 1)
		WHERE project_id = old.project_id;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS events_usage_au AFTER UPDATE OF size_bytes, project_id ON events BEGIN
	UPDATE project_usage
		SET bytes = MAX(0, bytes - old.size_bytes), events = MAX(0, events - 1)
		WHERE project_id = old.project_id;
	INSERT OR IGNORE INTO project_usage (project_id, bytes, events) VALUES (new.project_id, 0, 0);
	UPDATE project_usage SET bytes = bytes + new.size_bytes, events = events + 1 WHERE project_id = new.project_id;
END;--> statement-breakpoint
CREATE INDEX `idx_alerts_fired` ON `alerts` (`fired_at`);