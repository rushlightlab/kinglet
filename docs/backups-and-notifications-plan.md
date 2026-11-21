# Backups, Log Archive, Notifications, MCP, and npm Packages

**Status:** implemented on `next`; docs and packaging polish in progress
**Date:** 2026-11-19
**Branch:** `next`

This is an internal implementation plan, not user-facing documentation.

---

## 1. Summary

Kinglet gains two optional S3-backed features, one notification system, and one
AI integration:

1. **Snapshots (backups)** — consistent full-database copies for disaster recovery, scheduled by cron, viewable and restorable from the UI.
2. **Log archive** — export events to S3 before age retention deletes them, optionally, per project. Not a backup: archive parts are re-importable events, not a database.
3. **Notifications** — first-class channels with per-action subscriptions (Dokploy-style), plus per-monitor channel selection.
4. **MCP server** — a local stdio server that lets AI clients search logs and manage monitors through a project-scoped `km_` key. It is a client of the HTTP API, never a second data path.

Everything is configuration-driven. If S3 is not configured, the Backups UI stays hidden and nothing runs in the background. SQLite remains the hot store; S3 is not on the ingestion path. The MCP server is optional and runs outside the API process. The plan also prepares `@kinglet/mcp` and `@kinglet/sdk-node` for npm publication.

### Principles

- One process, no sidecars, no external queue. The MCP server is an optional
  local client, not a service Kinglet must run.
- The bucket is the source of truth for snapshots; the database is a cache for the UI.
- Never delete data that has not been safely stored, when archive is enabled.
- Restore is staged and applied at boot, even when the UI presents it as one click.
- Credentials live in the environment, never in the database or the UI.
- Logs and backups are sensitive; encrypt in transit and at rest.
- AI clients are project-scoped, read by default, and never inherit a human role.

---

## 2. Goals and non-goals

### Goals

- Configure S3 once via environment variables; enable backup features in the UI.
- Cron-based schedules with presets, a custom expression, timezone, validation, and next-run previews.
- Full compressed snapshots, optional client-side encryption, retention by count.
- List, download, delete, and restore snapshots from the UI.
- Live backup progress in the UI, with in-app toasts and external notifications.
- Global notification channels with per-action toggles, reusable across features.
- Optional archive of expiring events to S3, with a re-import path.
- Let AI clients query logs and manage monitors through a project-scoped MCP key.
- Publish the MCP server and Node SDK under the `@kinglet` npm scope.
- Work on Windows and Linux dev machines and in Docker.

### Non-goals

- Chunked page-level deduplication of snapshots.
- WAL streaming, point-in-time recovery, or reimplementing Litestream.
- Browsing or querying archived logs from the UI.
- Email, web push, or per-user notification preferences.
- Backup/restore for remote libSQL/Turso databases (use the provider's PITR).
- S3 Object Lock, bucket versioning management, or cross-region replication.
- GFS (daily/weekly/monthly) snapshot tiers.
- Remote/hosted MCP transport, OAuth 2.1, or user-bound AI credentials in v1.
- MCP access to admin or destructive operations: backups, restore, archive, users, keys, projects, clear logs.
- Arbitrary SQL, shell, or outbound fetch tools for MCP clients.

---

## 3. Terminology

| Term              | Meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| Snapshot / backup | Compressed full SQLite database copy for disaster recovery                  |
| Manifest          | Small JSON object describing a snapshot; written last                       |
| Run               | One backup attempt, including failures                                      |
| Restore           | Replace the live database with a snapshot at next boot                      |
| Archive           | Compressed NDJSON export of events removed by retention                     |
| Archive part      | One immutable archive object covering an event ID range                     |
| Channel           | A notification destination (webhook, Discord, Slack)                        |
| Action            | A global event a channel can subscribe to                                   |
| MCP key           | Project-scoped `km_…` credential for AI clients; separate scope vocabulary  |
| MCP server        | Local stdio process (`@kinglet/mcp`) speaking MCP over the Kinglet HTTP API |

Never call the archive a backup in UI copy. They have different restore semantics.

---

## 4. Configuration

### Environment variables

| Variable                              | Required | Default   | Notes                              |
| ------------------------------------- | -------- | --------- | ---------------------------------- |
| `KINGLET_BACKUP_S3_BUCKET`            | yes      | —         | Private bucket                     |
| `KINGLET_BACKUP_S3_ENDPOINT`          | yes      | —         | R2 / MinIO / B2 endpoint           |
| `KINGLET_BACKUP_S3_REGION`            | no       | `auto`    | `auto` for R2                      |
| `KINGLET_BACKUP_S3_ACCESS_KEY_ID`     | yes      | —         | Least-privilege token              |
| `KINGLET_BACKUP_S3_SECRET_ACCESS_KEY` | yes      | —         |                                    |
| `KINGLET_BACKUP_S3_SESSION_TOKEN`     | no       | —         | Temporary credentials              |
| `KINGLET_BACKUP_S3_PREFIX`            | no       | `kinglet` | All objects live under this prefix |
| `KINGLET_BACKUP_S3_FORCE_PATH_STYLE`  | no       | `false`   | `true` for most MinIO setups       |
| `KINGLET_BACKUP_S3_SSE`               | no       | `AES256`  | `AES256`, `aws:kms`, or `none`     |
| `KINGLET_BACKUP_S3_KMS_KEY_ID`        | no       | —         | Required with `aws:kms`            |
| `KINGLET_BACKUP_PASSPHRASE`           | no       | —         | Enables client-side age encryption |
| `KINGLET_BACKUP_PART_SIZE_MB`         | no       | `8`       | Multipart part size, minimum 5     |
| `KINGLET_TIMEZONE`                    | no       | system TZ | Default timezone for schedules     |

Feature detection: the Backups tab and scheduler are enabled when the bucket, endpoint, and credentials are present. Partial configuration logs one warning at boot (names only, no values) and shows a setup state in Settings.

Credentials are never returned by any API, never written to the database, and never included in manifests or notification payloads.

### R2 specifics

- `region: "auto"`, custom endpoint `https://<account-id>.r2.cloudflarestorage.com`.
- Token scope: Object Read & Write on the one bucket and prefix.
- AWS SDK v3 sends integrity checksums by default; configure `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"` so one client works across R2, AWS, B2, and MinIO.
- Multipart part size 8 MiB (5 MiB minimum).
- R2 is the primary test target. AWS S3, Backblaze B2, and MinIO are supported by the same client but less tested.

### Litestream

Not implemented. Document as the advanced continuous-replication option with a Compose example and restore instructions. The UI may later show "external continuous replication detected" but does not manage it.

---

## 5. Object layout

```text
<prefix>/
  manifests/<snapshot-id>.json
  snapshots/<snapshot-id>.db.zst
  snapshots/<snapshot-id>.db.zst.age
  archive/events/project=<project-id>/date=<YYYY-MM-DD>/part-<firstId>-<lastId>-<count>-<hash>.ndjson.zst[.age]
```

- `<snapshot-id>` is a UUIDv7 (time-sortable).
- The manifest is uploaded last; a snapshot without a manifest is considered invalid.
- Orphan snapshot objects without manifests older than 24 h are removed by cleanup.
- Archive parts are immutable and never overwritten with different content.

### Manifest

```json
{
  "format": "kinglet-backup/v1",
  "id": "019a8f2e-...",
  "createdAt": 1790000000000,
  "appVersion": "0.3.0",
  "schemaVersion": 8,
  "object": "snapshots/019a8f2e-....db.zst",
  "sizeBytes": 421888,
  "objectBytes": 90312,
  "sha256": "…",
  "compression": "zstd",
  "encryption": "none",
  "storage": "sqlite",
  "counts": {
    "projects": 1,
    "users": 2,
    "events": 12345,
    "monitors": 3
  }
}
```

No secrets, no URLs, no credentials. `schemaVersion` comes from a dedicated `app_meta` row updated by the migration runner.

---

## 6. Snapshot pipeline

### Creation

1. Acquire the single-flight run lock; record a `backup_runs` row (`running`).
2. Verify local SQLite storage (snapshots are disabled for remote libSQL).
3. Check free disk space against the current database size plus a margin.
4. `VACUUM INTO '<dataDir>/tmp/kinglet-<id>.db'` through the libSQL connection.
   - Consistent snapshot, compacted, no `-wal`/`-shm`.
   - No progress reporting; emit an indeterminate phase.
5. zstd-compress with `node:zlib` (`createZstdCompress`).
6. Optionally age-encrypt the compressed stream (passphrase from env).
7. Compute SHA-256 of the final (possibly encrypted) object bytes while streaming.
8. Upload with `@aws-sdk/lib-storage` (multipart, progress events).
9. HEAD the object and compare size and `x-amz-meta-sha256`.
10. Upload the manifest last.
11. Insert `backup_snapshots`, finish the run, emit `backup.succeeded`.
12. Apply retention.
13. Delete temp files in a `finally` block.

### Retention

- Keep the last `N` successful snapshots (`backup_settings.retention_count`).
- Never delete the most recent successful snapshot, even if `N` is reduced to 0.
- Delete the manifest first, then the object. Orphaned objects are cleaned later.
- Coverage is shown in the UI: `7 snapshots × 6h ≈ 42h`.
- Defaults: 7; minimum 2; maximum 365.

### Listing and reconciliation

- `backup_snapshots` caches bucket contents for fast page loads.
- Automatic sync when the cache is empty or older than 60 s, plus a manual "Refresh from bucket".
- Sync lists `manifests/`, fetches manifests not already cached, upserts rows, and marks cached rows missing when their manifest is gone.
- Listing works while S3 is temporarily unreachable (last known state, with a warning).
- After a disaster with an empty database, the first sync discovers existing backups from the bucket.

### Failure semantics

- Any failure records the run as `failed`, emits `backup.failed`, notifies subscribed channels, and leaves no partial snapshot visible.
- Retries: +5 min, +15 min, +1 h (3 attempts), then wait for the next cron tick. The schedule itself never shifts.

---

## 7. Scheduling

### Settings

```text
backup_settings (singleton, id = 1)
  enabled           integer
  schedule_cron     text     default '0 3 * * *'
  schedule_timezone text
  retention_count   integer  default 7
  updated_at        integer
```

### Cron rules

- Standard 5-field cron only; reject a 6th seconds field.
- Accept `@hourly`, `@daily`, `@weekly`, `@monthly`; normalize before saving.
- Reject expressions that never fire.
- Reject expressions that restrict both day-of-month and day-of-week (standard cron ORs them, which surprises users).
- Enforce a minimum gap of 15 minutes between the next three runs.
- Maximum expression length 120 characters.
- Validate the timezone with `Intl.DateTimeFormat`.
- Reject expressions producing fewer than one run.

### Presets (UI writes cron strings)

| Preset               | Cron          |
| -------------------- | ------------- |
| Hourly               | `0 * * * *`   |
| Every 6 hours        | `0 */6 * * *` |
| Daily at 03:00       | `0 3 * * *`   |
| Weekly, Monday 03:00 | `0 3 * * 1`   |
| Monthly, 1st 03:00   | `0 3 1 * *`   |
| Custom               | user-supplied |

### Library

- **croner** for parsing, timezone-aware `nextRun()` / `nextRuns()`.
- Own `setTimeout(...).unref()` re-armed after each tick. No long-lived library timer.
- **cronstrue** server-side for the human description; the web bundle stays lean.
- Timezone defaults to `KINGLET_TIMEZONE` or the server TZ; the UI offers a picker using `Intl.supportedValuesOf("timeZone")` and a "use my timezone" shortcut.

### Runtime behavior

- Re-arm immediately when settings change.
- On boot: if enabled and the last successful run predates the previous scheduled slot, run once (catch-up once, never replay every missed slot).
- Single-flight: skip a tick if a run is active; record `skipped`.
- No jitter; one process is expected. If multi-instance support is added later, use a `locked_until` lease.

---

## 8. Restore

The UI action is one click. The implementation is staged.

### Flow

1. Admin clicks Restore and confirms.
2. Server downloads the snapshot, verifies size/SHA-256, decrypts (passphrase required if encrypted), decompresses.
3. Run `PRAGMA integrity_check` on a temporary copy.
4. Refuse if the backup's `schemaVersion` is newer than the running app.
5. Write `data/restore/pending.json` (snapshot id, source, timestamp) and the staged database at `data/restore/kinglet-<id>.db`.
6. Enter maintenance mode: ingest and background jobs return 503, monitors pause.
7. Respond `202`, flush, and exit gracefully.

### Boot

1. Before opening the database, detect the marker.
2. Copy the current database to `data/pre-restore-<timestamp>.db`.
3. Remove `-wal` and `-shm` files.
4. Atomically rename the staged file over the live database.
5. Open normally and run migrations.
6. Delete `session` rows (leaked backups must not become logins). API keys remain valid unless the admin revokes them.
7. Delete the marker, record the completion, and emit a notification.

If no supervisor restart policy is present, the UI says "Restore staged — restart Kinglet to apply". Docker docs recommend `restart: unless-stopped`. A CLI fallback covers fresh hosts:

```bash
kinglet restore --latest
kinglet restore --key snapshots/<id>.db.zst
```

The CLI runs before the server and is the only path on a host with no running database.

### Notes

- Remote libSQL/Turso: disabled; use provider PITR.
- Cookie-cache sessions may survive briefly after restore until their cache TTL; document this. Clearing the `session` table is the default safeguard.
- Keep the pre-restore copy until the next successful boot; surface its path in the restore result.

---

## 9. Download and delete

- **Download:** presigned GET URL, admin-only, 5-minute TTL, `Content-Disposition: attachment`, filename `kinglet-<id>.db.zst[.age]`.
- Record `downloaded_at` and `downloaded_by` on the snapshot.
- HTTPS is required in production.
- Encrypted backups download as `.age`; the UI warns that the passphrase is required.
- **Delete:** admin-only, confirmation dialog, deletes manifest then object, removes the cache row. Retention deletions do not notify.

---

## 10. Live progress

### Transport

```text
GET /v1/system/events   (SSE, admin)
```

- Cookie-authenticated, same-origin through the Vite proxy in dev.
- Sends `system.status` on connect, then backup/restore/archive events.
- Heartbeat every 15 s; connection lifetime 30 min; client reconnects and refetches state.
- Throttle progress events to ~4 per second.
- One root-level `EventSource` in the web app; not one per page.

### Events

```text
system.status      { backup: {...}, archive: {...} }
backup.queued      { runId, trigger }
backup.started     { runId, trigger }
backup.progress    { runId, phase, done?, total? }
backup.succeeded   { runId, id, sizeBytes, durationMs }
backup.failed      { runId, phase, error }
backup.deleted     { id, reason }
restore.staged     { id }
archive.progress   { projectId, phase, done?, total? }
archive.succeeded  { projectId, events, bytes }
archive.failed     { projectId, error }
```

Phases: `snapshot → compress → encrypt → upload → verify → retention`. Snapshot is indeterminate; compress/encrypt count bytes; upload uses `httpUploadProgress`.

### UI

- Status card: idle / running / last success / last failure, next run, "Back up now".
- Phase stepper and progress bar during a run.
- Terminal events trigger one history refetch and an in-app toast for admins.
- Backups page also reacts to `system.status` while open.

---

## 11. Notifications

### Model

```text
notification_channels
  id, name, type (webhook|discord|slack), url, enabled, decoration,
  created_at, updated_at, last_test_at, last_test_status, last_test_error

notification_channel_actions
  channel_id, action, primary key (channel_id, action)

monitor_channels
  monitor_id, channel_id, primary key (monitor_id, channel_id)

notification_deliveries
  id, channel_id, scope, event, subject, status, error, created_at
```

### Actions (per channel, Dokploy-style)

| Action                  | Trigger                                         |
| ----------------------- | ----------------------------------------------- |
| `backup.succeeded`      | Scheduled or manual snapshot finished           |
| `backup.failed`         | Any phase failed                                |
| `backup.restore_staged` | Admin staged a restore                          |
| `archive.succeeded`     | Archive part uploaded                           |
| `archive.failed`        | Archive export/upload failed                    |
| `system.warning`        | Retention failure, DB near cap, scheduler error |

Defaults: failure actions on, success actions off, restore on. All toggles live on the channel; the Backups page shows a read-only summary of subscribed channels and links to Settings → Notifications.

### Monitor alerts stay per-monitor

Monitor channels are selected on the monitor, not on the channel. A channel subscribed to "monitor alerts" would otherwise receive every project's alerts, which is noisy and leaks project names across tenants.

### Channel management UI

- Settings → Notifications.
- Channel cards: type icon, name, masked URL, enabled toggle, last test status, Test / Edit / Delete.
- Edit dialog: name, URL, decoration toggle, action switches in a two-column grid, Test Notification, Save.
- Recent deliveries table (last 100 attempts), with status and error.

### Migration from inline channels

Today `monitors.channels` stores `[{ type, url }]`. Migration:

1. Read every monitor's legacy channels.
2. Deduplicate by `(type, url)` into `notification_channels` with generated names.
3. Insert `monitor_channels` links.
4. Run once at boot, idempotently, inside a transaction; log created/linked counts.
5. New monitor writes use `channelIds: string[]`. Legacy `channels` input may be accepted for one release.

### Delivery log

- One row per channel per event.
- Pruned to 30 days and a hard cap of 1,000 rows by the retention job.
- Never log full webhook URLs; log host and status.
- The Notifications page shows the last 100.

### Security

- Channels are admin-only (`notifications.read` / `notifications.write`).
- Monitor editors with `monitors.read` can call a summary endpoint returning id, name, type, enabled, and health — never URLs.
- Reuse `validateWebhookUrl` SSRF protection at creation and send time.
- Mask URLs in list responses; admins see the full URL only in the edit dialog.
- Rate-limit channel tests to once per minute.

---

## 12. Log archive (phase 2)

### Behavior

- Optional, per project, default off.
- Runs on its own daily cron (default `0 3 * * *`, same schedule machinery).
- When enabled for a project, the hourly age-retention job skips that project; the archive job owns its lifecycle.
- Exports events older than `KINGLET_RETENTION_DAYS`, then deletes them.

### Pipeline

1. Select expired events for an archive-enabled project, up to 10,000 rows ordered by `id`.
2. Group by `(project_id, UTC date)` so every part has one date partition.
3. Write NDJSON to a temp file; compute SHA-256 while writing.
4. zstd-compress; optionally age-encrypt.
5. Upload to the deterministic object key; HEAD-verify size and hash metadata.
6. Insert an `archive_parts` row.
7. Delete the exported event IDs.
8. Repeat until the time budget or no expired rows remain.

### Guarantee

If archive is enabled and any step fails, **the rows are not deleted**. The project stalls at its current size and a notification fires. An explicit escape hatch, "delete even if archive fails", defaults off.

### Object keys

```text
archive/events/project=<id>/date=<YYYY-MM-DD>/
  part-<firstId>-<lastId>-<count>-<hash>.ndjson.zst[.age]
```

- Internal `id` range addresses the deleted batch.
- `count` and the first 12 hex characters of the SHA-256 of the **uncompressed NDJSON** make the key content-aware.
- Same rows → same key → safe overwrite after a crash. Different content with a reused ID range → different key, no silent loss.
- Archive parts are never used as identity; `uid` is.

### NDJSON format

One JSON object per line:

```json
{
  "v": 1,
  "uid": "019a8f...",
  "sourceId": 10456,
  "projectId": "prj_123",
  "ts": 1790000000000,
  "level": "error",
  "service": "api",
  "env": "prod",
  "message": "payment failed",
  "fields": { "orderId": "ord_1" }
}
```

- `level` is the level name, not the integer.
- `sourceId` is traceability only.
- Every line has a stable `uid`; legacy null uids are synthesized deterministically from project + source ID at export time.

### Import

- CLI first: `kinglet archive import --project prj_123 --from 2026-11-01 --to 2026-11-20`.
- Stream decompress/decrypt, parse, insert in chunks with `INSERT OR IGNORE` on `uid`.
- Never insert `sourceId`; SQLite assigns fresh rowids. There is no autoincrement counter to break.
- Normal insert triggers update FTS5 and `project_usage`.
- Report inserted and skipped counts.
- UI import can follow later.

### Storage math

1M events/day at ~500 B average ≈ 500 MB/day raw. zstd-compressed NDJSON realistically lands at 50–100 MB/day. Archive retention is managed by S3 lifecycle rules, documented; the app does not add another retention timer.

### Out of scope

- Searching archived logs.
- Parquet or external query engines.
- Archive on "clear logs" (unless an "archive before clear" option is added later).

---

## 13. MCP server

An MCP (Model Context Protocol) server lets AI clients — Claude Desktop, Cursor,
VS Code, Codex, and similar — search logs and manage monitors in a project
conversationally. It is a client of the existing HTTP API, not a second data
path: authentication, project isolation, query validation, quotas, and
sanitization stay exactly where they are.

### Credential model

MCP clients authenticate with a dedicated **MCP key** (`km_…`). MCP keys share
the `api_keys` table, hashing, rotation, and owner-offboarding path with API
keys, but carry `key_type = 'mcp'` and a separate scope vocabulary.

|               | API key (`kl_…`)                  | MCP key (`km_…`)                               |
| ------------- | --------------------------------- | ---------------------------------------------- |
| Purpose       | Services that ingest or query     | AI clients                                     |
| Bound to      | One project                       | One project                                    |
| Scopes        | `ingest`, `query`                 | `logs.read`, `monitors.read`, `monitors.write` |
| Defaults      | `ingest` + `query`                | `logs.read` + `monitors.read`                  |
| Human role    | Never                             | Never                                          |
| Cross-project | No                                | No                                             |
| Admin actions | No                                | No                                             |
| Lifecycle     | Delete, rotate, owner offboarding | Same                                           |

Naming: the column is `key_type` (`keyType` in TypeScript), values
`'api' | 'mcp'`. The explicit name avoids overloading bare `type`, which stays
reserved for protocol/format values such as notification channel `type`. The
domain interfaces carry `keyType`; `AuthInfo.kind` still distinguishes `user`
from `key`, and its key branch adds `keyType` alongside `keyId` and `scopes`.
UI copy may say "Key type" (Application / MCP).

The prefix is presentation and format validation, not a lookup key — verification
still hashes the whole token. `verifyApiKey` accepts both `kl_` and `km_`,
returns `keyType`, and keeps the existing owner/banned check.

Why not one key type for both:

- A production service's ingest/query key must never be able to change
  monitors. Disjoint scope vocabularies make that impossible by construction,
  not by remembering not to tick a box.
- A separate `key_type` makes AI credentials visible in the UI: which client
  uses it, when it was last used, and one-click revocation without touching app
  keys.
- Two tables would duplicate verification, rotation, and offboarding for no
  gain. One table with `key_type` keeps one code path.

Why not user-bound keys or OAuth first:

- A user-bound credential would inherit the user's role, including admin access
  to every project. That is a much larger blast radius than an AI client needs.
- The MCP authorization profile requires an OAuth 2.1 authorization server
  (metadata discovery, PKCE, dynamic client registration, consent). That is a
  separate project and only matters for remote/hosted clients. stdio plus a
  bearer key covers desktop clients today.

### Scope enforcement

| Scope            | Grants                                                     |
| ---------------- | ---------------------------------------------------------- |
| `logs.read`      | Search/read events, histogram, services                    |
| `monitors.read`  | List/get monitors and alerts; channel type and health only |
| `monitors.write` | Create/update/delete monitors; requires `monitors.read`    |

- Route checks move behind one helper, `keyCan(auth, capability)`, with
  capabilities `logs.read`, `logs.write`, `monitors.read`, and
  `monitors.write`. API keys map `query` → `logs.read` and `ingest` →
  `logs.write`; MCP keys map directly. Routes stop testing raw scope strings.
- `POST /v1/events` rejects `keyType = 'mcp'` regardless of stored scopes.
- MCP keys cannot reach projects, users, keys, system status, backups, archive,
  notifications, or settings routes. Those remain user-session only.
- `monitorGuard` gains one branch: an MCP key passes only with the matching
  scope; API keys keep the current "keys cannot manage monitors" 403.
- Channel URLs are bearer secrets. Change the existing visibility check to
  `kind === 'user' && can('monitors.write')`, so MCP callers always receive
  channel type and health — never URLs or raw engine errors. Monitor writes
  take `channelIds` (after M2).
- Neither key type ever counts as a human role. `can()` and
  `requirePermission()` keep their user-only meaning; MCP routes use an
  explicit scope check.

### Transport and packaging

v1 is a local stdio server; remote HTTP is deferred.

| Phase | Transport                   | Deployment                                                         |
| ----- | --------------------------- | ------------------------------------------------------------------ |
| v1    | stdio                       | `packages/mcp`, published as `@kinglet/mcp`; `npx -y @kinglet/mcp` |
| later | Streamable HTTP (stateless) | `POST /mcp` behind HTTPS with a `km_` bearer token; opt-in         |

The stdio server:

- Reads `KINGLET_URL` and `KINGLET_MCP_KEY` from the environment; refuses to
  start when either is missing, the URL is not http(s), or the key is not
  `km_` (a pasted `kl_` key fails with a pointer to MCP keys).
- Never opens the database. Every tool calls the public HTTP API, so there is
  one write path and one authorization model.
- Uses `@modelcontextprotocol/sdk` and `zod`; no other runtime dependencies.
- Writes one line per tool call to stderr: tool, duration, status, row count.
  Never arguments, filters, event contents, or the key. stdout is reserved for
  protocol traffic.
- Sends a `User-Agent` with the package version.

Remote HTTP is deferred because it needs HTTPS, Origin validation against DNS
rebinding, and OAuth for hosted clients. None of that is required for desktop
clients, and embedding an MCP server in the API process expands its attack
surface for no v1 benefit. The tool registry stays transport-independent.

Location: `packages/mcp` in the Kinglet monorepo, published as `@kinglet/mcp`,
next to `packages/sdk-node`. The root workspace already includes `packages/*`,
so Turbo builds and typechecks it with everything else. It is not imported by
the API and not copied into the Docker image. A separate repository (Dokploy's
layout) would add version skew and cross-repo PRs for no benefit at this size.

### Tools

Read tools (available with `logs.read` / `monitors.read`):

| Tool            | Returns                                                          |
| --------------- | ---------------------------------------------------------------- |
| `get_context`   | Project id/name/slug, retention days, server version, key scopes |
| `search_events` | Events for a filter and range; default 50, max 200, cursor       |
| `get_event`     | One event by `uid`                                               |
| `get_histogram` | Bucket counts for a filter and range                             |
| `list_services` | Services with counts and last-seen timestamps                    |
| `list_monitors` | Monitor config, state, last eval; no channel URLs                |
| `get_monitor`   | One monitor                                                      |
| `list_alerts`   | Recent alerts for the project                                    |
| `list_channels` | id, name, type, enabled, health; no URLs (after M2)              |

Write tools (require `monitors.write`):

| Tool             | Notes                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| `create_monitor` | Name, kind, query, threshold, windows, cooldowns, enabled, channelIds |
| `update_monitor` | Partial update by id                                                  |
| `delete_monitor` | Destructive annotation; client confirmation                           |

Deliberately absent: ingest, clear logs, project/user/key management, backups,
restore, archive, notification channels, settings, arbitrary SQL, shell, and
outbound fetch. An AI client cannot delete data or change access.

Every tool declares a JSON input schema and MCP annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`). Responses are capped at 256 KiB; event
messages at 4 KiB and fields at 8 KiB each, with `truncated: true` and a cursor
when more rows exist. `search_events` reuses the filter grammar and the 31-day
range clamp; the existing 500-character / 32-term filter limits apply.

### Limits and audit

- 60 tool calls per minute per key with a burst of 10; at most 4 concurrent
  calls. Enforced server-side on MCP-key requests, not only in the client.
- No automatic retries. A failed tool returns a structured error and the model
  decides whether to try again.
- `api_keys.last_used_at` uses the existing 60-second throttle.
- Tool calls are not stored in a new table. The MCP process logs them to stderr;
  monitor writes update the monitor's `updatedAt`, matching the existing audit
  level for human edits.

### Client setup

```json
{
  "mcpServers": {
    "kinglet": {
      "command": "npx",
      "args": ["-y", "@kinglet/mcp"],
      "env": {
        "KINGLET_URL": "https://logs.example.com",
        "KINGLET_MCP_KEY": "km_..."
      }
    }
  }
}
```

The one-time key dialog shows this snippet with the instance URL prefilled and
the secret value visible once. The docs page (`/mcp/`) covers Claude Desktop,
Claude Code, Cursor, VS Code, and Codex CLI with tested snippets; Windsurf, Zed,
and OpenCode as config-only; a generic stdio section; and a note that remote-only
clients (Claude web, ChatGPT connectors) need the deferred `/mcp` endpoint.
Client config shapes are verified at implementation time; they change often.
The page uses headings per client (not tabs) so deep links and search work, and
it states the Windows `cmd /c npx` wrapper up front.

### Package layout

```text
packages/mcp/
  package.json        @kinglet/mcp; bin kinglet-mcp -> dist/cli.js
  tsconfig.json       extends @kinglet/config/tsconfig.node.json
  src/cli.ts          stdio entry point
  src/server.ts       tool registry and annotations
  src/client.ts       typed Kinglet HTTP client
  src/tools/          one module per tool group
  src/config.ts       env parsing and validation
```

Publishing is a separate release action; see §14. Until `@kinglet/mcp` is
published, docs use a local workspace invocation or a packed tarball, mirroring
the Node SDK's "not on npm yet" note.

---

## 14. npm packages

Two workspace packages ship to npm under the `@kinglet` scope. The MCP server is
specified in §13; the Node SDK already lives in `packages/sdk-node`. This
section is release preparation, not runtime behavior.

### Packages

| Package             | Path                | Shape                    | First release |
| ------------------- | ------------------- | ------------------------ | ------------- |
| `@kinglet/mcp`      | `packages/mcp`      | CLI (`bin: kinglet-mcp`) | M5            |
| `@kinglet/sdk-node` | `packages/sdk-node` | library (`exports`)      | M6, with docs |

`@kinglet/config` stays `private: true` and is never published. Publish with
explicit `--filter` flags; never run a blanket recursive publish.

The `kinglet` npm org owns the scope. `@rushlightlab` is also owned but unused;
do not publish the same package under both scopes.

### Shared metadata

Both packages need:

- `license: "MIT"` plus a package-level `LICENSE` file. npm does not copy the
  monorepo root into the tarball.
- `repository` with `directory` (`packages/mcp`, `packages/sdk-node`), plus
  `homepage` and `bugs` pointing at the docs site and GitHub issues.
- `publishConfig.access: "public"`; scoped packages default to restricted.
- `files: ["dist"]` and `prepublishOnly: "pnpm build"`.
- A package `README.md` with install and configuration examples.
- No `"private": true`.
- A version aligned with the Kinglet release (currently `0.3.0`). A package may
  move to independent semver later if it diverges.
- `pnpm publish`, not `npm publish`: pnpm rewrites `workspace:*` devDependencies
  to real versions.

Package specifics:

- **MCP:** `bin: { "kinglet-mcp": "./dist/cli.js" }`; the entry point starts with
  `#!/usr/bin/env node`. Runtime dependencies are `@modelcontextprotocol/sdk`
  and `zod`; it must not depend on API workspace code.
- **SDK:** `main`, `types`, and `exports` already point at `dist`; zero runtime
  dependencies. `sideEffects: false` is safe and helps bundlers.
- **Engines:** the repo is Node 26, but `engines` is consumer-facing. Pick and
  test a floor (`>=22` is plausible for both), then keep README and docs in sync.
  Do not claim a floor that has not been exercised.

### Verification before publishing

1. Build the package.
2. `pnpm --filter <pkg> pack` and inspect the tarball: only `dist/`,
   `README.md`, `LICENSE`, and `package.json`.
3. Install the tarball into a clean temp directory:
   - MCP: set `KINGLET_URL` + `KINGLET_MCP_KEY`, then run MCP Inspector.
   - SDK: import `createLogger` and send a batch to a local instance.
4. After publishing: `npm view @kinglet/<pkg>` and `npm dist-tag ls`.

### First publish

Manual, with 2FA, from a clean tree:

```bash
pnpm --filter @kinglet/sdk-node build
pnpm --filter @kinglet/sdk-node publish --access public

pnpm --filter @kinglet/mcp build
pnpm --filter @kinglet/mcp publish --access public
```

- Use `--tag next` with a `-next.N` version for prereleases so `latest` stays on
  a tested build.
- Published versions are immutable. Fix with a new version; use
  `npm deprecate` after the 72-hour unpublish window.

### CI publishing

Publish from a tag or manual dispatch, never on every push.

- `environment: release` for approval, matching the Docker release.
- `permissions: contents: read` and `id-token: write`.
- Preferred auth: npm trusted publishing (OIDC), configured per package for
  `rushlightlab/kinglet`; no long-lived token.
- `pnpm publish --access public --provenance`.
- Fallback: a granular `@kinglet` token stored in the `release` environment as
  `NPM_TOKEN`; never commit `.npmrc` with a token.

npm is restricting 2FA-bypass tokens for direct publishing from January 2027,
so trusted publishing is the durable path. The first publish must be manual
because trusted publishing is configured on the package page after it exists.

### Docs when packages go live

- `/mcp/`: replace the "not on npm yet" caveat with `npx -y @kinglet/mcp`.
- `node-sdk.mdx`: remove the "Not on npm yet" aside and the workspace build;
  install with `pnpm add @kinglet/sdk-node`.
- Update both package READMEs in the same change.
- Note in the release or self-hosting docs that the Docker image does not include
  the MCP package; it runs on the client machine.

---

## 15. Data model additions

One Drizzle migration (`0008`), plus a boot-time data migration for legacy monitor channels.

`api_keys` gains `key_type text not null default 'api'` (`'api'` | `'mcp'`).
Existing rows backfill as API keys; per-type scope validation lives in
application code, not a database constraint. MCP keys need no other tables:
`last_used_at`, rotation, and owner offboarding already exist.

```text
app_meta(key, value)                       -- schema_version for restore checks

backup_settings(id=1, enabled, schedule_cron, schedule_timezone,
                retention_count, updated_at)

backup_runs(id, trigger, status, phase, started_at, finished_at,
            size_bytes, error)

backup_snapshots(id, manifest_key, object_key, created_at, size_bytes,
                 sha256, encryption, app_version, schema_version,
                 counts_json, state, downloaded_at, downloaded_by,
                 discovered)

notification_channels(id, name, type, url, enabled, decoration,
                      created_at, updated_at, last_test_at,
                      last_test_status, last_test_error)

notification_channel_actions(channel_id, action)

monitor_channels(monitor_id, channel_id)

notification_deliveries(id, channel_id, scope, event, subject,
                        status, error, created_at)

archive_settings(id=1, enabled, schedule_cron, schedule_timezone,
                 delete_on_failure, updated_at)

project_archive_settings(project_id, enabled)

archive_parts(id, project_id, date, first_id, last_id, event_count,
              object_key, sha256, size_bytes, created_at)
```

Indexes:

- `backup_snapshots(created_at desc)`
- `backup_runs(started_at desc)`
- `notification_deliveries(created_at desc)`
- `notification_deliveries(channel_id, created_at desc)`
- `archive_parts(project_id, date)`
- `monitor_channels(channel_id)`

Permissions:

```text
backups.read      view snapshots, settings, status
backups.write     run backup, change schedule/retention, delete
backups.restore   stage a restore (destructive)
notifications.read / notifications.write
```

All default to admin.

---

## 16. API surface

### Backups

| Method | Path                           | Permission        | Notes                             |
| ------ | ------------------------------ | ----------------- | --------------------------------- |
| GET    | `/v1/backups/status`           | `backups.read`    | Last run, next run, live phase    |
| GET    | `/v1/backups?refresh=1`        | `backups.read`    | Cached list, optional bucket sync |
| POST   | `/v1/backups/run`              | `backups.write`   | 202 + run id                      |
| GET    | `/v1/backups/settings`         | `backups.read`    |                                   |
| PUT    | `/v1/backups/settings`         | `backups.write`   | Validates cron, returns next runs |
| GET    | `/v1/backups/schedule/preview` | `backups.read`    | Query: cron, timezone             |
| POST   | `/v1/backups/test-connection`  | `backups.write`   | put/get/delete under `_health/`   |
| POST   | `/v1/backups/:id/restore`      | `backups.restore` | Stages, then 202                  |
| GET    | `/v1/backups/:id/download`     | `backups.read`    | Presigned URL                     |
| DELETE | `/v1/backups/:id`              | `backups.write`   | Manifest + object                 |

### Notifications

| Method       | Path                                  | Permission                     |
| ------------ | ------------------------------------- | ------------------------------ |
| GET/POST     | `/v1/notifications/channels`          | `notifications.read` / `write` |
| PATCH/DELETE | `/v1/notifications/channels/:id`      | `notifications.write`          |
| POST         | `/v1/notifications/channels/:id/test` | `notifications.write`          |
| GET          | `/v1/notifications/channels/summary`  | `monitors.read`                |
| GET          | `/v1/notifications/deliveries`        | `notifications.read`           |

### Archive

| Method  | Path                       | Permission               |
| ------- | -------------------------- | ------------------------ |
| GET/PUT | `/v1/archive/settings`     | `backups.read` / `write` |
| PUT     | `/v1/projects/:id/archive` | `backups.write`          |
| POST    | `/v1/archive/run`          | `backups.write`          |
| GET     | `/v1/archive/parts`        | `backups.read`           |
| POST    | `/v1/archive/import`       | `backups.restore`        |

### System

| Method | Path                | Permission                  |
| ------ | ------------------- | --------------------------- |
| GET    | `/v1/system/events` | admin (SSE)                 |
| GET    | `/v1/system/status` | existing, add backup fields |

### Keys and MCP

Key routes gain `keyType` (`api` default, `mcp`) with per-type scope validation;
list, rotate, and revoke keep their current shape.

| Method   | Path                    | Permission                 | Notes                                                                                |
| -------- | ----------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| GET      | `/v1/context`           | any API/MCP key            | Project id/name/slug, retention, version, key type and scopes; 403 for user sessions |
| GET/POST | `/v1/projects/:id/keys` | `keys.read` / `keys.write` | `keyType` on create; list returns it                                                 |
| PATCH    | `/v1/keys/:id`          | `keys.write`               | Validates scopes for that key type                                                   |

Monitor read/write routes accept MCP keys with `monitors.read` /
`monitors.write`; API keys keep the existing 403. No other `/v1` route accepts an
MCP key.

Monitor write payload changes from `channels: [{type,url}]` to `channelIds: string[]`. Read responses include resolved channel summaries and health.

---

## 17. UI

### Navigation

Unchanged: `/logs`, `/monitors`, `/settings`.

### Settings tabs

Projects · Users · Backups · Notifications

Backups and Notifications are rendered only for admins.

### Backups page

1. **Status card** — enabled state, current phase/progress, last success/failure, next run, "Back up now".
2. **Schedule card** — preset chips, custom cron input with inline validation, timezone picker, human description, next three runs, min-gap error.
3. **Retention card** — count, coverage estimate, storage estimate from current database size.
4. **Snapshots table** — created, trigger, size, contents, encryption, state, actions (Restore / Download / Delete). Refresh from bucket.
5. **Notifications summary** — subscribed channel chips, link to Settings → Notifications.
6. **Log archive card** — phase 2: global toggle, per-project toggles, last run, archived events/bytes, import action.
7. **S3 setup state** — when unconfigured, show required env names and a link to docs. Never show values.

### Notifications page

- Channel cards and add/edit dialog with action switches.
- Recent deliveries table.
- Empty state explaining that channels are reused by monitors, backups, and system events.

### Project keys

The existing Keys card splits into **Application keys** (`kl_`) and **MCP keys**
(`km_`), with a type badge on every row. Creating an MCP key offers three
switches — Read logs, Read monitors, Manage monitors — with both reads on and
manage off by default. The one-time secret dialog shows the value once plus a
copyable client config block with the instance URL prefilled.

MCP keys use the same rotate/revoke menus; revocation takes effect on the next
request. The list shows last use, so an unused AI credential is obvious.

### Monitor editor

- Multi-select of channels with inline health ("last delivery failed 12m ago").
- "Manage channels" link to Settings → Notifications.
- No URL fields.

### Toasts

- Global admin SSE provider shows terminal backup/restore/archive events anywhere in the app.
- No notification center in phase 1.

---

## 18. Security

- Credentials are env-only and redacted from logs, API responses, manifests, and notifications.
- Private bucket; least-privilege token scoped to the prefix.
- TLS required except localhost dev.
- SSE at rest by default; optional age passphrase encryption.
- Passphrase loss is unrecoverable; the UI states this before enabling.
- Presigned download URLs are short-lived and admin-only.
- Restore clears sessions; pre-restore copy retained for rollback.
- Webhook SSRF protections are reused unchanged.
- Webhook URLs are treated as secrets: masked in lists, admin-only, never in delivery errors.
- Backup and archive payloads contain user data and event contents; access is admin-only.
- Notification test sends are rate-limited.
- No bucket credentials or signed URLs are ever written to the database.
- MCP keys are project-bound and never admin. No MCP tool can restore a backup,
  delete a project, clear logs, mint keys, manage users, or change settings.
- Tool output contains untrusted log text. Responses stay structured and capped;
  the server never acts on instructions found in events.
- Channel URLs and raw engine errors are never returned to MCP clients. Monitor
  tools take channel ids and return type/health only.
- MCP requests are rate-limited per key server-side and revoked by the same
  delete/rotate/owner-offboarding path as API keys.
- The MCP process logs tool name, duration, status, and row count — never keys,
  arguments, filters, or event contents.

---

## 19. Failure modes

| Scenario                                   | Behavior                                                   |
| ------------------------------------------ | ---------------------------------------------------------- |
| S3 unreachable during backup               | Run fails, retries 3×, notifies, no partial snapshot       |
| Disk full during `VACUUM INTO`             | Run fails before upload; temp files cleaned                |
| Crash after upload before manifest         | Object is an orphan; cleanup removes it after 24 h         |
| Crash after manifest before retention      | Snapshot valid; retention catches up next run              |
| Restore download/decrypt fails             | No marker written; live database untouched                 |
| Corrupt snapshot / integrity check fails   | Restore aborted, staged file removed                       |
| Backup schema newer than app               | Restore refused during staging                             |
| Process killed after restore marker        | Boot applies the staged swap; pre-restore copy exists      |
| No restart policy                          | UI reports "staged — restart required"; CLI available      |
| Remote libSQL storage                      | Snapshot features disabled with an explanation             |
| Archive upload fails                       | Rows kept, project stalls, notification; optional override |
| Duplicate archive import                   | `INSERT OR IGNORE` on `uid`; reported as skipped           |
| SSE disconnect                             | Client reconnects, refetches status                        |
| Notification endpoint down                 | Delivery logged as failed; no infinite retries             |
| Retention count set to 0                   | Clamped; always keep at least the latest snapshot          |
| MCP client cannot reach the API            | Tool error names the configured URL; no retry storm        |
| MCP key revoked or rotated                 | 401 on the next tool call; immediate                       |
| Missing MCP scope                          | 403 naming the required scope                              |
| MCP result exceeds the cap                 | Truncated with `truncated: true` and a cursor              |
| AI requests an admin or destructive action | No such tool exists                                        |

---

## 20. Testing

### Unit (node:test, no new runner dependency)

- Cron validation: presets, macros, impossible expressions, dual DOM/DOW, min gap, timezone.
- Object key generation and content hash stability.
- Manifest parse/serialize and schema-version comparison.
- NDJSON archive writer and importer (round trip, duplicate uid, legacy null uid).
- Notification payload formatting for webhook, Discord, Slack.
- Channel action matching.
- MCP scope validation per key type and `kl_`/`km_` prefix handling.
- MCP tool input schemas, result truncation, and the stderr audit shape.

### Integration (local MinIO or R2 test bucket)

- Snapshot → compress → encrypt → upload → manifest → list → download.
- Retention deletes the oldest, keeps the newest.
- Crash simulation: upload without manifest; orphan cleanup.
- Restore staging and boot swap against a disposable data directory.
- Archive export → delete → import round trip; verify FTS and usage counts.
- Notification delivery to a local webhook catcher, including failures and delivery log pruning.
- MCP stdio handshake and tool calls against a temp database: search, get, histogram, cursor.
- MCP tenant isolation: a project A key cannot read or write project B.
- MCP revoked key, missing scope, and rate limit all fail closed.
- MCP monitor writes need `monitors.write`; channel URLs never appear in responses.

### Manual

- R2 credentials in env; test connection, backup now, live progress, toast.
- Restore a backup end to end with Docker `restart: unless-stopped`.
- Discord/Slack action toggles receive only subscribed events.
- Monitor channel migration from an existing seeded database.
- Claude Desktop and Cursor configs against a local instance; revoke the key mid-session.
- Pack both npm packages, install the tarballs in a clean directory, run MCP
  Inspector, and send an SDK batch to a local instance.

### Acceptance criteria

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build` pass.
- A snapshot created on R2 restores into a fresh container.
- Restore invalidates sessions and keeps API keys.
- Backup failures produce a notification and a visible run history entry.
- Enabling archive prevents deletion of unarchived rows through a forced S3 outage.
- No credentials appear in API responses, logs, or manifests.
- An MCP key cannot reach another project or any admin route; API keys still cannot manage monitors.
- Both npm tarballs contain only `dist/`, `README.md`, `LICENSE`, and `package.json`, and install cleanly outside the workspace.

---

## 21. Milestones

### M1 — Snapshot core

- Env config, S3 client, schema/migration, manifests.
- Snapshot pipeline, scheduler, retention, run history.
- Settings → Backups: status, schedule, retention, list, download, delete, manual run.
- SSE progress.

Exit: snapshot to R2, visible in UI, downloadable, retention works.

### M2 — Notifications

- Channel model, actions, delivery log, summary endpoint.
- Legacy monitor channel migration.
- Settings → Notifications UI and monitor channel picker.
- Wire backup and system events.

Exit: Discord receives only subscribed actions; monitor alerts unchanged.

### M3 — Restore

- Staging, boot swap, marker, pre-restore copy, session clearing.
- CLI restore for fresh hosts.
- Restore UI with confirmation and staged/restart messaging.

Exit: full restore exercised on a disposable instance.

### M4 — Log archive

- Settings, per-project opt-in, export pipeline, deterministic parts.
- Retention integration and failure guard.
- Import CLI, archive UI card.

Exit: export→delete→import round trip is lossless and idempotent.

### M5 — MCP server

- `api_keys.key_type`, `km_` prefix, MCP scopes, `keyCan` helper, per-key limits.
- `packages/mcp`: stdio server, tool registry, HTTP client, config validation.
- Keys UI split, one-time setup snippet, `/v1/context`.
- Tool annotations and result caps.
- MCP package metadata, `LICENSE`, tarball test, first npm publish.

Exit: `npx @kinglet/mcp` against a local instance searches logs, reads
monitors, creates a monitor with `monitors.write`, and a revoked key fails.

### M6 — Docs, packages, and hardening

- Docs site: S3/R2 setup, schedule, restore, archive, Litestream recipe, env reference.
- Docs site: new Integrations sidebar group with an `/mcp/` page — Claude Desktop,
  Claude Code, Cursor, VS Code, and Codex CLI tested snippets; Windsurf, Zed, and
  OpenCode configs; a generic stdio section; remote-only clients marked deferred.
- Package prep: shared npm metadata, SDK `LICENSE`/`repository`/`publishConfig`,
  tarball verification, trusted publishing; publish `@kinglet/sdk-node` when its
  docs are updated.
- Failure injection, mobile layout, accessibility, copy polish.
- Update README feature list and `.env.example`.

Exit: both packages install cleanly from their tarballs; published versions are
verifiable with `npm view`, and the docs no longer say "not on npm yet".

---

## 22. Open defaults

These are the agreed defaults unless changed later:

- Minimum schedule gap: 15 minutes.
- Catch-up: run once on boot when a slot was missed.
- Success notifications: off; failure and restore: on.
- Delivery log: 30 days, 1,000 rows, last 100 shown.
- Snapshot retention: 7, minimum 2, maximum 365.
- Schedule timezone: explicit picker, defaults to instance TZ.
- Archive: off by default, per-project opt-in, daily at 03:00.
- Archive failure: keep rows unless the admin enables the override.
- S3 prefix: `kinglet`; multipart part size 8 MiB.
- Snapshot support: local SQLite only.
- Litestream: documented, not managed.
- MCP transport: stdio via `@kinglet/mcp`; remote HTTP deferred.
- MCP key scopes: `logs.read` + `monitors.read` on, `monitors.write` off.
- MCP limits: 50 rows default / 200 max, 256 KiB response cap, 60 calls/min per key.
- MCP key prefix: `km_`.
- npm scope: `@kinglet`; MCP and SDK are public, `@kinglet/config` stays private.
- npm versions follow the Kinglet release until a package needs independent semver.
- npm publishing: manual first publish with 2FA, then trusted publishing (OIDC)
  under the `release` environment with provenance.

---

## 23. Resolved decisions

| Topic                   | Decision                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| Placement               | Settings → Backups and Settings → Notifications; nav unchanged              |
| Providers               | R2 tested first; generic S3 API for AWS/B2/MinIO                            |
| Continuous backup       | Litestream documented, not implemented                                      |
| Restore UX              | One click, staged + restart under the hood                                  |
| Encryption              | SSE always, optional client-side age passphrase                             |
| Snapshot retention      | Last N                                                                      |
| Archive                 | Separate feature, whole-event export, re-import only                        |
| Notification routing    | Actions on the channel; monitor alerts per monitor                          |
| Download                | Presigned URL, 5 minutes, admin-only                                        |
| Live progress           | SSE at `/v1/system/events`                                                  |
| Archive keys            | Internal ID range + count + content hash                                    |
| Archive import identity | `uid`, never the internal ID                                                |
| MCP credential          | Separate `key_type` on `api_keys`, `km_` prefix, project-bound, never admin |
| MCP scopes              | `logs.read`, `monitors.read`, `monitors.write`; no ingest                   |
| MCP transport           | stdio (`@kinglet/mcp`) first; Streamable HTTP + OAuth later                 |
| MCP writes              | Monitors only; `channelIds`, never URLs                                     |
| MCP data path           | HTTP API only; no direct database access                                    |
| npm packages            | `@kinglet/mcp` and `@kinglet/sdk-node` public; `@kinglet/config` private    |
| npm auth                | First publish manual with 2FA; CI uses trusted publishing + provenance      |
