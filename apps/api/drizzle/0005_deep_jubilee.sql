ALTER TABLE `events` ADD `uid` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_events_uid` ON `events` (`uid`);