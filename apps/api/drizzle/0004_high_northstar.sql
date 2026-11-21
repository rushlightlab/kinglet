ALTER TABLE `events` ADD `api_key_id` integer;--> statement-breakpoint
CREATE INDEX `idx_events_project_key_ts` ON `events` (`project_id`,`api_key_id`,`ts`);