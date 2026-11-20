DELETE FROM `archive_parts`
WHERE `rowid` NOT IN (
  SELECT MIN(`rowid`) FROM `archive_parts` GROUP BY `object_key`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_archive_parts_object_key` ON `archive_parts` (`object_key`);
