# 👑 Kinglet

**Small. Light. King.** — a tiny self-hostable log platform. The Axiom-shaped
experience, running on your own $5 VPS: one container, one SQLite database, one
fast dark UI with a live tail.

Named after the tiny bird with the golden crown (genus _Regulus_ — "little king").

Docs and landing page: **https://kinglet.rushlightlab.com**

- **Ingest anything over HTTP** — NDJSON or JSON batches, from any language
- **Live tail** over SSE, with follow mode
- **Full-text search** — SQLite FTS5 with a trigram tokenizer, so substring
  matches (`"timeout"`) just work
- **Filter grammar** — `level>=warn service:api "connection refused" -healthcheck`
- **Monitors & alerts** — instant match, rate spikes, silence detection → webhook/Discord/Slack
- **Team-ready auth** — Better Auth email/password login with admin / member / viewer roles, cached sessions, and per-project membership
- **Multi-project** — every project owns its logs, monitors, and `kl_…` API keys with `ingest`/`query` scopes; non-admins see only projects they're assigned to
- **Volume histogram** by level, drag across it to zoom into a time range
- **Retention built in** — drop events older than N days, automatically
- **S3 backups & restore** — optional compressed (zstd), optionally age-encrypted snapshots to R2/S3/MinIO, scheduled and restorable from Settings
- **Notification channels** — reusable webhook/Discord/Slack channels with per-action subscriptions for backups, archive, and system warnings
- **Log archive** — optional per-project NDJSON export to S3 before retention deletes events, with a re-import path
- **MCP server** — query logs and manage monitors from Claude Desktop, Cursor, VS Code, Codex, and other MCP clients with a project-scoped `km_…` key
- **Zero external services** — no Postgres, no Redis, no Kafka. One process; S3 is optional.

## Quickstart (Docker)

Run the public image — no clone or build:

```bash
docker run -d --name kinglet \
  --restart unless-stopped \
  -p 8080:3000 \
  -v kinglet-data:/data \
  -e KINGLET_BASE_URL=http://localhost:8080 \
  ghcr.io/rushlightlab/kinglet:latest

# if you didn't set an admin password, read the generated one:
docker exec kinglet cat /data/admin-password.txt

# open the UI
open http://localhost:8080
```

Sign in with the admin email (default `admin@kinglet.local`) and that password.
Set `KINGLET_ADMIN_EMAIL` / `KINGLET_ADMIN_PASSWORD` on the container to choose
your own — they only apply when no administrator exists. For a public server,
set `KINGLET_BASE_URL` to your HTTPS origin and pin a release tag such as
`:0.3.0` instead of `:latest`.

Then go to **/settings → projects & keys**, create an API key (`kl_…`, scopes
`ingest` / `query`), and send your first log with it:

```bash
curl -X POST http://localhost:8080/v1/events \
  -H "Authorization: Bearer kl_…" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary '{"level":"error","message":"payment failed","service":"billing"}'
```

Prefer Compose, Coolify, or Dokploy? The
[self-hosting guide](https://kinglet.rushlightlab.com/self-hosting/) has all
three paths, TLS, backups, and configuration.

## Send logs

Anything that can make an HTTP request can log to Kinglet.

### curl / any language

```bash
curl -X POST http://localhost:8080/v1/events \
  -H "Authorization: Bearer kl_…" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary '{"level":"error","message":"payment failed","service":"billing","fields":{"order":1234}}
{"level":"info","message":"retry scheduled","service":"billing","fields":{"delay":2}}'
```

Each line (or each item in a JSON `{"events":[...]}` array) is one event:

| Field                        | Required | Notes                                             |
| ---------------------------- | -------- | ------------------------------------------------- |
| `message` (or `msg`)         | yes      | the log line                                      |
| `level`                      | no       | `trace`…`fatal`, a number 0–5, defaults to `info` |
| `ts` (or `time`/`timestamp`) | no       | epoch ms, epoch s (auto-detected), or ISO string  |
| `service`, `env`             | no       | lowercase identifiers                             |
| `fields`                     | no       | arbitrary JSON object (≤ 32KB serialized)         |

### Node.js

> **Not on npm yet.** `@kinglet/sdk-node` lives in this repo
> (`packages/sdk-node`). Until it is published, use the HTTP examples above or
> build it from a checkout:
>
> ```bash
> pnpm --filter @kinglet/sdk-node build
> ```

The package exposes a zero-dependency batching client:

```ts
import { createLogger } from "@kinglet/sdk-node";

const log = createLogger({
  url: "http://localhost:8080",
  token: process.env.KINGLET_KEY!, // API key with the ingest scope (kl_…)
  service: "my-app",
  env: "prod",
});

log.info("user signed in", { userId: 42 });
log.error("payment failed", { orderId: 1234, code: "card_declined" });

await log.close(); // best-effort flush on shutdown
```

Events buffer in-process and ship as one NDJSON batch (200 events or every
1000ms by default). Failed batches are re-queued and reported via `onError` —
your app never blocks on logging.

### AI clients (MCP)

`@kinglet/mcp` is a local stdio MCP server for Claude Desktop, Claude Code,
Cursor, VS Code, Codex, and other MCP clients. It calls the normal HTTP API; it
never opens the database.

> **Prepared for npm, not published yet.** Until it is on npm, build it from a
> checkout with `pnpm --filter @kinglet/mcp build`, then point clients at
> `node packages/mcp/dist/cli.js`.

Create an **MCP key** (`km_…`) in **Settings → Projects → open project → MCP
keys**. Keys are project-bound and default to `logs.read` + `monitors.read`;
enable `monitors.write` only if the AI should create or change monitors.

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

The full client setup, tool list, and security notes are in the docs site at
`/mcp/`. Log contents are sent to your AI provider; treat them as untrusted data.

> **Coming soon:** a pino transport, a zero-code `--import` preload that hooks
> `console` + uncaught errors, and a Monolog handler for PHP (Laravel,
> Symfony, WordPress all speak Monolog).

## API reference

Auth accepts either the `better-auth.session_token` cookie (the web UI) or
`Authorization: Bearer kl_…` (API keys) / `km_…` (MCP keys). Project-scoped
routes take `?project=<id>` (sessions); machine keys are bound to their project.
Cookie-authenticated mutations must send `X-Kinglet-Request: 1`; Bearer requests
are exempt. MCP keys can read logs (`logs.read`), read monitors and alerts
(`monitors.read`), and optionally manage monitors (`monitors.write`). They can
never ingest, manage keys/users/projects, or change backups and settings.

| Route                                         | What it does                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| `/api/auth/*`                                 | Better Auth endpoints (sign-in, sign-out, session, password)                    |
| `GET /v1/me`                                  | Current user + permissions                                                      |
| `GET/POST /v1/projects`                       | List assigned projects / create one (admin)                                     |
| `DELETE /v1/projects/:id`                     | Delete a project and all its data (admin)                                       |
| `GET/POST /v1/users`                          | List / create users (admin)                                                     |
| `PATCH/DELETE /v1/users/:id`                  | Change role / delete user (admin)                                               |
| `GET/POST /v1/projects/:id/keys`              | List / create API keys for a project                                            |
| `DELETE /v1/keys/:id?project=`                | Revoke an API key                                                               |
| `GET/POST /v1/projects/:id/members`           | List / assign project members (admin)                                           |
| `DELETE /v1/projects/:id/members/:userId`     | Remove a project member (admin)                                                 |
| `POST /v1/events`                             | Ingest a batch (NDJSON or JSON, ≤ 10k events, ≤ 8MB)                            |
| `GET /v1/events`                              | Query. Params: `q` (filter grammar), `from`, `to` (epoch ms), `limit`, `cursor` |
| `GET /v1/histogram`                           | Counts per level per bucket. Params: `from`, `to`, `buckets`                    |
| `GET /v1/services`                            | Your known services and their event counts                                      |
| `GET /v1/stream`                              | SSE live tail. Params: `q` (cookie auth; `?key=` for headerless clients)        |
| `GET/POST /v1/monitors`                       | List monitors / create one                                                      |
| `PATCH/DELETE /v1/monitors/:id`               | Update / delete a monitor                                                       |
| `POST /v1/monitors/:id/test`                  | Send a test notification through every channel                                  |
| `GET /v1/alerts`                              | Alert history, latest first                                                     |
| `GET /v1/context`                             | Project, key scopes, capabilities, and version for a `kl_`/`km_` key            |
| `GET /v1/backups/status`                      | Backup setup, last run, next run, and live progress (admin)                     |
| `GET /v1/backups`                             | Cached snapshots; `?refresh=1` reconciles the bucket (admin)                    |
| `POST /v1/backups/run`                        | Start a snapshot now (admin)                                                    |
| `GET/PUT /v1/backups/settings`                | Schedule, timezone, retention (admin)                                           |
| `GET /v1/backups/schedule/preview`            | Validate a cron expression and preview the next runs (admin)                    |
| `POST /v1/backups/test-connection`            | Put/get/delete a probe object in the bucket (admin)                             |
| `GET /v1/backups/:id/download`                | Short-lived presigned download URL (admin)                                      |
| `POST /v1/backups/:id/restore`                | Stage a restore; apply at next boot (admin)                                     |
| `DELETE /v1/backups/:id`                      | Delete a snapshot manifest and object (admin)                                   |
| `GET/POST /v1/notifications/channels`         | List masked channels / create one (admin)                                       |
| `PATCH/DELETE /v1/notifications/channels/:id` | Edit or delete a channel (admin)                                                |
| `POST /v1/notifications/channels/:id/test`    | Send a test notification (admin, once/minute)                                   |
| `GET /v1/notifications/channels/summary`      | Channel names and health for monitor editors; never URLs                        |
| `GET /v1/notifications/deliveries`            | Recent delivery log, newest first (admin)                                       |
| `GET/PUT /v1/archive/settings`                | Global archive schedule and failure policy (admin)                              |
| `PUT /v1/projects/:id/archive`                | Enable or disable archive for one project (admin)                               |
| `POST /v1/archive/run`                        | Run archive now (admin)                                                         |
| `GET /v1/archive/parts`                       | Exported archive parts (admin)                                                  |
| `POST /v1/archive/import`                     | Re-import archived events for a project and date range (admin)                  |
| `GET /v1/system/events`                       | SSE backup/restore/archive progress (admin, cookie auth)                        |
| `GET /v1/system/status`                       | Operational diagnostics (admin)                                                 |
| `GET /healthz`                                | Minimal health check (no auth)                                                  |

Ingest is rate-limited to 600 batches/minute per identity. Filters are capped at
500 characters / 32 terms, `limit` at 1000, `buckets` at 240, alerts at 500, and
monitors at 100 per project. `from`/`to` are clamped to the last 31 days and
5 minutes of future skew. Per-project event and database caps are configurable
(see below).

### Filter grammar

```
level:error            level is error
level>=warn            level comparisons
service:api env:prod   exact field matches
"conn refused"         message contains phrase
-healthcheck           message must NOT contain this
```

Combine freely: `level>=warn service:api -healthcheck`

## Alerts & monitors

Monitors are standing queries evaluated against a project's stream (add
`?project=<id>` — `kl_` keys can't manage monitors; use the UI or a session):

| Kind          | Fires when                                     | Example                               |
| ------------- | ---------------------------------------------- | ------------------------------------- |
| `match`       | any event matches — instantly                  | `level:fatal`                         |
| `count_above` | more than N matches within a window            | `level>=error service:api` > 10 in 5m |
| `count_below` | fewer than N matches within a window (silence) | `service:cron-backup` < 1 in 30m      |

Create one over HTTP, or in the UI at `/monitors`:

```bash
# Use the session cookie from a signed-in browser; kl_ keys can't manage monitors.
curl -X POST http://localhost:8080/v1/monitors \
  -H "Cookie: better-auth.session_token=…" \
  -H "X-Kinglet-Request: 1" \
  -H "Content-Type: application/json" \
  --data-binary '{ "name": "payment errors", "query": "level>=error service:billing", "kind": "count_above", "threshold": 10, "windowMs": 300000, "channelIds": ["<channel-id>"] }'
```

Channels are reusable destinations — **webhook** (JSON payload; n8n, Zapier,
scripts), **discord**, and **slack** — managed in **Settings → Notifications**
and subscribed to actions such as `backup.failed`, `backup.restore_staged`,
`archive.failed`, and `system.warning`. Attach them to a monitor by id with
`channelIds`; legacy inline `channels` are still accepted for one release. Each
monitor has a cooldown; count monitors auto-resolve when the condition clears
and say so. `POST /v1/monitors/:id/test` sends a test notification, so wiring a
channel is verifiable in one click. Webhook targets are SSRF-checked:
loopback/private/metadata addresses are blocked unless
`KINGLET_ALLOW_PRIVATE_WEBHOOKS=1` is set.

Set `KINGLET_BASE_URL` and every notification carries a deep link back into
your UI with the query and time range pre-filled.

## Backups, restore, and archive

Backups are optional and use an S3-compatible bucket (Cloudflare R2, AWS S3,
Backblaze B2, MinIO). Set the `KINGLET_BACKUP_S3_*` variables (see below); the
Backups tab and scheduler stay hidden until all four required values are
present. Snapshots require **local SQLite** — remote libSQL/Turso users should
use the provider's point-in-time recovery instead.

- Snapshots are compressed with zstd, optionally encrypted with an age
  passphrase, hashed, uploaded, and recorded in a manifest written last.
- Schedules are standard 5-field cron with a timezone and a 15-minute minimum
  gap; retention keeps the last N successful snapshots.
- Downloads are short-lived presigned URLs. Restore is staged: Kinglet verifies
  the snapshot, stages it, and applies it at the next boot, keeping a
  pre-restore copy and clearing sessions. API keys survive; sessions do not.
- Log archive is opt-in per project. When enabled, retention leaves that
  project's expiring events for the archive job, which writes compressed NDJSON
  parts to S3 before deleting them. If an archive upload fails, rows are kept.

Fresh-host restore (before the server starts):

```bash
node apps/api/dist/restore/cli.js --latest
node apps/api/dist/restore/cli.js --id <snapshot-id>
```

Import archived events for a project/date range:

```bash
node apps/api/dist/archive/cli.js --project <project-id> --from 2026-11-01 --to 2026-11-20
```

S3 credentials and the passphrase are environment-only; they never appear in
the database, manifests, logs, or API responses.

## Configuration

| Env var                                      | Default                                       | What it does                                                                          |
| -------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `KINGLET_PORT`                               | `3000`                                        | HTTP port                                                                             |
| `KINGLET_HOST`                               | _(all interfaces)_                            | Bind address; set `127.0.0.1` for a loopback-only listener                            |
| `KINGLET_STORAGE`                            | `auto`                                        | `sqlite`, `libsql`, or `auto` (picks by db path scheme)                               |
| `KINGLET_DB_PATH`                            | `data/kinglet.db` (image: `/data/kinglet.db`) | Plain path → SQLite; `libsql://`/`https://`/`file:` → libSQL                          |
| `KINGLET_DB_AUTH_TOKEN`                      | —                                             | Auth token for remote libSQL/Turso databases                                          |
| `KINGLET_ADMIN_EMAIL`                        | `admin@kinglet.local`                         | Bootstrap administrator email (when no administrator exists)                          |
| `KINGLET_ADMIN_PASSWORD`                     | _(generated)_                                 | Bootstrap administrator password (when no administrator exists)                       |
| `BETTER_AUTH_SECRET`                         | _(generated, persisted)_                      | Session signing secret; set explicitly for multi-instance installs                    |
| `KINGLET_TRUSTED_PROXIES`                    | —                                             | CIDRs allowed to set `X-Forwarded-For`                                                |
| `KINGLET_ALLOW_PRIVATE_WEBHOOKS`             | —                                             | Allow private/internal webhook targets (SSRF escape hatch)                            |
| `KINGLET_MCP_ALLOW_MONITOR_WRITES`           | —                                             | Allow MCP keys to create/update/delete monitors; off by default                       |
| `KINGLET_SESSION_DAYS`                       | `30`                                          | Web session lifetime                                                                  |
| `KINGLET_BASE_URL`                           | —                                             | Public URL, used for deep links in alert notifications                                |
| `KINGLET_TIMEZONE`                           | system TZ                                     | Default timezone for backup and archive schedules                                     |
| `KINGLET_BACKUP_S3_BUCKET`                   | —                                             | Bucket for snapshots; backups are enabled when this and the next three are set        |
| `KINGLET_BACKUP_S3_ENDPOINT`                 | —                                             | S3-compatible endpoint (R2/MinIO/B2); HTTPS required except loopback                  |
| `KINGLET_BACKUP_S3_REGION`                   | `auto`                                        | Region; `auto` for Cloudflare R2                                                      |
| `KINGLET_BACKUP_S3_ACCESS_KEY_ID`            | —                                             | Least-privilege access key                                                            |
| `KINGLET_BACKUP_S3_SECRET_ACCESS_KEY`        | —                                             | Secret key (never stored in the database)                                             |
| `KINGLET_BACKUP_S3_SESSION_TOKEN`            | —                                             | Optional temporary credential token                                                   |
| `KINGLET_BACKUP_S3_PREFIX`                   | `kinglet`                                     | Object prefix inside the bucket                                                       |
| `KINGLET_BACKUP_S3_FORCE_PATH_STYLE`         | `false`                                       | `true` for most MinIO setups                                                          |
| `KINGLET_BACKUP_S3_SSE`                      | `AES256`                                      | Server-side encryption: `AES256`, `aws:kms`, or `none`                                |
| `KINGLET_BACKUP_S3_KMS_KEY_ID`               | —                                             | Required when `KINGLET_BACKUP_S3_SSE=aws:kms`                                         |
| `KINGLET_BACKUP_PASSPHRASE`                  | —                                             | Optional age passphrase; when set, restores require age-encrypted snapshots           |
| `KINGLET_BACKUP_MANIFEST_SECRET`             | S3 secret                                     | Stable HMAC key for snapshot manifests; set a dedicated value for credential rotation |
| `KINGLET_BACKUP_ALLOW_UNSIGNED_MANIFESTS`    | `0`                                           | Legacy compatibility for manifests written before signing; leave off for new setups   |
| `KINGLET_BACKUP_ALLOW_UNENCRYPTED_SNAPSHOTS` | `0`                                           | Legacy compatibility for unencrypted snapshots while a passphrase is configured       |
| `KINGLET_BACKUP_MAX_SNAPSHOT_MB`             | `8192`                                        | Absolute restore size cap in MiB; larger snapshots are rejected before download       |
| `KINGLET_BACKUP_PART_SIZE_MB`                | `8`                                           | Multipart part size in MiB (minimum 5)                                                |
| `KINGLET_RETENTION_DAYS`                     | `14`                                          | Delete events older than this                                                         |
| `KINGLET_ALERT_RETENTION_DAYS`               | `90`                                          | Delete alert history older than this                                                  |
| `KINGLET_MAX_EVENTS_PER_PROJECT`             | `1000000`                                     | Hard cap on retained events per project (`0` = unlimited)                             |
| `KINGLET_MAX_PROJECT_DB_MB`                  | `1024`                                        | Hard cap on retained event bytes per project (`0` = unlimited)                        |
| `KINGLET_MAX_DB_MB`                          | `4096`                                        | Hard cap on local database size in MB (`0` = unlimited)                               |

On first boot, or if the database has no administrator, Kinglet creates one from
`KINGLET_ADMIN_EMAIL` / `KINGLET_ADMIN_PASSWORD`. If no password is set, one is
generated and printed to the console; for a local database it is also written to
`admin-password.txt` next to the database. If an account with that email already
exists, it is promoted and keeps its current password. Real ingest integrations
should use project API keys (`kl_…`) created in **/settings**.

## Storage backends

One engine for both modes: the **libSQL client** opens a local SQLite file by
default or connects to a hosted [Turso](https://turso.tech) database with the
same code. Schema and queries are defined with **Drizzle ORM**; migrations live
in `apps/api/drizzle` and run automatically on boot.

**sqlite** _(default)_ — one local database file (plus WAL/SHM sidecars while running), WAL mode, FTS5 trigram search:

```bash
KINGLET_DB_PATH=/data/kinglet.db
```

**Turso** — same code, remote transport:

```bash
KINGLET_DB_PATH=libsql://your-db.turso.io
KINGLET_DB_AUTH_TOKEN=eyJ…
```

With `KINGLET_STORAGE=auto` (the default), the driver is picked from the db
path scheme: plain paths use the local file; `libsql://`, `https://`, `wss://`,
and `file:` URLs use the libSQL transport. One caveat: some hosted libSQL
builds lack the FTS5 trigram tokenizer — Kinglet detects that and falls back to
word-prefix search with a console warning. Schema edits:

```bash
pnpm --filter @kinglet/api db:generate   # drizzle-kit migration from schema.ts
```

**ClickHouse** is the planned scale-out backend for the event path. It will
implement the same `Storage` interface, so the API and UI stay untouched.

## Self-hosting notes

- **Resources**: ~150–250MB RAM; designed for a 2 vCPU / 2GB VPS. Throughput
  and disk depend on event size, fields, and retention (roughly a few hundred MB
  per million retained events).
- **Backups**: the store is one SQLite database (`kinglet.db` plus `-wal`/`-shm`
  while running). Use [Litestream](https://litestream.io/) or `sqlite3 .backup`;
  don't copy only the `.db` from a live WAL store.
- **Scale ceiling**: SQLite/libSQL are the right engines for single-node
  self-hosting. Storage sits behind a driver interface — Turso for managed
  hosting today, ClickHouse as the planned scale-out backend tomorrow.

## Development

Requires Node 26+ and [pnpm](https://pnpm.io) 10+.

```bash
pnpm install
pnpm dev        # API on :3000 (tsx watch) + UI on :5173 (Vite, proxies /v1)
pnpm build      # build all packages (UI dist is served by the API after this)
pnpm typecheck
pnpm lint       # oxlint
pnpm format     # oxfmt, writes files
pnpm format:check
```

The dev API writes to `apps/api/data/`. On first boot, or whenever no
administrator exists, it creates one and prints the credentials (the password is
also saved to `apps/api/data/admin-password.txt` for a local database — set
`KINGLET_ADMIN_EMAIL` / `KINGLET_ADMIN_PASSWORD` before the first run to choose
your own). Sign in at `http://localhost:5173`.

### Tests

```bash
pnpm test:unit          # fast Vitest unit suites; no database or network
pnpm test:integration   # temporary SQLite databases and in-memory backups
pnpm test:e2e           # Playwright against the built UI/API on loopback
pnpm test               # unit, then integration
```

Run `pnpm build` before `pnpm test:integration` (the MCP stdio test spawns
`packages/mcp/dist/cli.js`) and before `pnpm test:e2e` (the fixture serves the
built API and UI). Install Chromium once with
`pnpm exec playwright install chromium` (`--with-deps chromium` on Linux/CI to
add the system libraries); local runs use Google Chrome when present, and
`PLAYWRIGHT_CHANNEL=chromium` forces the bundled browser.
Integration tests never touch `apps/api/data`, S3, or an external network. See
[docs/testing.md](./docs/testing.md) for the layout, single-file commands, and
known coverage boundaries.

Port 3000 already taken by another app? Point both dev servers elsewhere:

```bash
# bash / zsh
KINGLET_PORT=3100 KINGLET_API_URL=http://localhost:3100 pnpm dev
```

```powershell
# PowerShell (Windows)
$env:KINGLET_PORT = "3100"; $env:KINGLET_API_URL = "http://localhost:3100"; pnpm dev
```

See logs move — in a second terminal:

```bash
KINGLET_KEY=kl_… pnpm demo:logs          # backfills an hour, then streams ~1 event/1.5s
KINGLET_KEY=kl_… pnpm demo:logs --once   # backfill only, then exit
```

`demo:logs` needs a project API key with the **ingest** scope — create one in
**/settings → projects & keys**. For a custom port also set
`KINGLET_URL=http://localhost:3100` (PowerShell:
`$env:KINGLET_KEY = "kl_…"; $env:KINGLET_URL = "http://localhost:3100"; pnpm demo:logs`).

Testing alert channels without Discord or Slack:

```bash
pnpm demo:webhook       # pretty-prints any POST on http://localhost:3999
```

Then in `/monitors`, point a channel at `http://localhost:3999/hook` and hit
**test** — the payload shows up in the catcher's console.

### Releasing images

`.github/workflows/docker.yml` publishes multi-arch images (amd64 + arm64) to
GHCR from `vX.Y.Z` tags only: `:X.Y.Z`, `:X.Y`, and `:latest`. It does not
publish from `main`. The workflow verifies the tag, runs the build and typecheck,
and waits for approval from the `release` environment before pushing.

```bash
git tag v0.3.0 -m "Kinglet v0.3.0"
git push origin v0.3.0
```

The docs changelog and landing version badge are generated from GitHub
Releases. Publishing a release updates them on the next docs build; to trigger
that build automatically, add a Cloudflare deploy hook as the
`CLOUDFLARE_DOCS_DEPLOY_HOOK` Actions secret in this repository.

## Roadmap

- [x] v0.1 — HTTP ingest, live tail, filter grammar, histogram, retention, Docker
- [x] v0.2 — auth & multi-project (Better Auth + Drizzle), monitors/alerts, UI polish (URL state, saved searches, permalinks, keyboard nav)
- [x] v0.3 — per-project memberships, quotas, security hardening, docs/landing site
- [ ] Next — pino transport + zero-code Node preload, PHP Monolog handler, Fluent Bit guide
- [ ] Later — OTLP + syslog receivers
- [ ] v1.0 — ClickHouse storage profile, workspace teams

## License

MIT — see [LICENSE](./LICENSE).
