DROP INDEX `idx_events_project_key_ts`;--> statement-breakpoint
DROP INDEX `idx_events_service_ts`;--> statement-breakpoint
DROP INDEX `idx_events_env_ts`;--> statement-breakpoint
CREATE INDEX `idx_events_project_level_ts` ON `events` (`project_id`,`level`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_events_project_service_ts` ON `events` (`project_id`,`service`,`ts`);