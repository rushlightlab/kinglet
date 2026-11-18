ALTER TABLE `alerts` ADD `notify_status` text;--> statement-breakpoint
ALTER TABLE `alerts` ADD `notify_error` text;--> statement-breakpoint
ALTER TABLE `monitors` ADD `last_eval_at` integer;--> statement-breakpoint
ALTER TABLE `monitors` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `monitors` ADD `last_error_at` integer;