CREATE TABLE `project_members` (
	`id` integer PRIMARY KEY NOT NULL,
	`project_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_project_members_project` ON `project_members` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_members_user` ON `project_members` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_project_members` ON `project_members` (`project_id`,`user_id`);--> statement-breakpoint
-- Upgrade safety: an installation that predates memberships keeps its current
-- behavior. Admins can prune these assignments afterwards.
INSERT OR IGNORE INTO `project_members` (`project_id`, `user_id`, `created_at`)
SELECT p.`id`, u.`id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `projects` p CROSS JOIN `user` u;