-- Channel targets are encrypted at rest (random IV), so the plaintext
-- (type, url) uniqueness moves to a keyed fingerprint. Rows are sealed and
-- fingerprinted at boot once KINGLET_SECRET_KEY is set.
DROP INDEX `uq_notification_channels_type_url`;--> statement-breakpoint
ALTER TABLE `notification_channels` ADD `target_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notification_channels_target_hash` ON `notification_channels` (`target_hash`);