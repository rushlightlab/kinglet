-- The project byte quota now charges each row's estimated on-disk size,
-- indexes included, instead of scaling raw bytes by a database-wide ratio
-- that other projects' rows could move. Backfill existing rows with the same
-- estimate as eventSizeBytes (src/storage/events.ts); the events_usage_au
-- trigger carries the change into project_usage.
UPDATE `events` SET `size_bytes` =
	192 +
	4 * length(CAST(`message` AS BLOB)) +
	(5 * length(CAST(COALESCE(`fields`, '') AS BLOB)) + 3) / 4 +
	2 * (length(CAST(COALESCE(`service`, '') AS BLOB)) + length(CAST(COALESCE(`env`, '') AS BLOB)));
