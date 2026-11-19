# 👑 Kinglet

**Small. Light. King.** — a tiny self-hostable log platform. The Axiom-shaped
experience, running on your own $5 VPS: one container, one SQLite database, one
fast dark UI with a live tail.

Named after the tiny bird with the golden crown (genus *Regulus* — "little king").

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
- **Zero external services** — no Postgres, no Redis, no Kafka. One process.

## Quickstart (Docker)

From a clone of this repo:

```bash
docker compose up -d --build

# the first boot (or a database with no administrator) creates one.
# If no password was configured, the generated one is printed here:
docker compose exec kinglet cat /data/admin-password.txt

# open the UI
open http://localhost:8080
```

Sign in with the admin email (default `admin@kinglet.local`) and that password.
Set `KINGLET_ADMIN_EMAIL` / `KINGLET_ADMIN_PASSWORD` in `.env` (copy from
`.env.example`) to choose your own — they only apply when no administrator
exists.

Then go to **/settings → projects & keys**, create an API key (`kl_…`, scopes
`ingest` / `query`), and send your first log with it:

```bash
curl -X POST http://localhost:8080/v1/events \
  -H "Authorization: Bearer kl_…" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary '{"level":"error","message":"payment failed","service":"billing"}'
```

No clone needed? Run the published multi-arch image (the GHCR package must be
public, or run `docker login ghcr.io` first):

```bash
docker run -d --name kinglet -p 8080:3000 -v kinglet-data:/data \
  ghcr.io/rushlightlab/kinglet:latest
```

Legacy `tok_…` tokens (`KINGLET_TOKENS`) still work as workspace-wide
superuser tokens — handy for quick curl tests, not for production shippers.

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

| Field | Required | Notes |
| --- | --- | --- |
| `message` (or `msg`) | yes | the log line |
| `level` | no | `trace`…`fatal`, a number 0–5, defaults to `info` |
| `ts` (or `time`/`timestamp`) | no | epoch ms, epoch s (auto-detected), or ISO string |
| `service`, `env` | no | lowercase identifiers |
| `fields` | no | arbitrary JSON object (≤ 32KB serialized) |

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

> **Coming soon:** a pino transport, a zero-code `--import` preload that hooks
> `console` + uncaught errors, and a Monolog handler for PHP (Laravel,
> Symfony, WordPress all speak Monolog).

## API reference

Auth accepts either the `better-auth.session_token` cookie (the web UI) or
`Authorization: Bearer kl_…` (API keys). Project-scoped routes take `?project=<id>`
(sessions/legacy tokens); API keys are bound to their project. Cookie-authenticated
mutations must send `X-Kinglet-Request: 1`; Bearer requests are exempt.

| Route | What it does |
| --- | --- |
| `/api/auth/*` | Better Auth endpoints (sign-in, sign-out, session, password) |
| `GET /v1/me` | Current user + permissions |
| `GET/POST /v1/projects` | List assigned projects / create one (admin) |
| `DELETE /v1/projects/:id` | Delete a project and all its data (admin) |
| `GET/POST /v1/users` | List / create users (admin) |
| `PATCH/DELETE /v1/users/:id` | Change role / delete user (admin) |
| `GET/POST /v1/projects/:id/keys` | List / create API keys for a project |
| `DELETE /v1/keys/:id?project=` | Revoke an API key |
| `GET/POST /v1/projects/:id/members` | List / assign project members (admin) |
| `DELETE /v1/projects/:id/members/:userId` | Remove a project member (admin) |
| `POST /v1/events` | Ingest a batch (NDJSON or JSON, ≤ 10k events, ≤ 8MB) |
| `GET /v1/events` | Query. Params: `q` (filter grammar), `from`, `to` (epoch ms), `limit`, `cursor` |
| `GET /v1/histogram` | Counts per level per bucket. Params: `from`, `to`, `buckets` |
| `GET /v1/services` | Your known services and their event counts |
| `GET /v1/stream` | SSE live tail. Params: `q` (cookie auth; `?key=`/`?token=` for shippers) |
| `GET/POST /v1/monitors` | List monitors / create one |
| `PATCH/DELETE /v1/monitors/:id` | Update / delete a monitor |
| `POST /v1/monitors/:id/test` | Send a test notification through every channel |
| `GET /v1/alerts` | Alert history, latest first |
| `GET /v1/system/status` | Operational diagnostics (admin) |
| `GET /healthz` | Minimal health check (no auth) |

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
`?project=<id>` — `kl_` keys can't manage monitors; use the UI, a session, or a
legacy token):

| Kind | Fires when | Example |
| --- | --- | --- |
| `match` | any event matches — instantly | `level:fatal` |
| `count_above` | more than N matches within a window | `level>=error service:api` > 10 in 5m |
| `count_below` | fewer than N matches within a window (silence) | `service:cron-backup` < 1 in 30m |

Create one over HTTP, or in the UI at `/monitors`:

```bash
# Requires a session cookie or a legacy KINGLET_TOKENS token;
# project API keys cannot manage monitors.
curl -X POST http://localhost:8080/v1/monitors \
  -H "Authorization: Bearer $KINGLET_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary '{ "name": "payment errors", "query": "level>=error service:billing", "kind": "count_above", "threshold": 10, "windowMs": 300000, "channels": [ { "type": "discord", "url": "https://discord.com/api/webhooks/…" } ] }'
```

Channels are plain HTTP POSTs — **webhook** (JSON payload; n8n, Zapier, scripts),
**discord**, and **slack**. Each monitor has a cooldown; count monitors
auto-resolve when the condition clears and say so. `POST /v1/monitors/:id/test`
sends a test notification, so wiring a channel is verifiable in one click.
Webhook targets are SSRF-checked: loopback/private/metadata addresses are
blocked unless `KINGLET_ALLOW_PRIVATE_WEBHOOKS=1` is set.

Set `KINGLET_BASE_URL` and every notification carries a deep link back into
your UI with the query and time range pre-filled.

## Configuration

| Env var | Default | What it does |
| --- | --- | --- |
| `KINGLET_PORT` | `3000` | HTTP port |
| `KINGLET_STORAGE` | `auto` | `sqlite`, `libsql`, or `auto` (picks by db path scheme) |
| `KINGLET_DB_PATH` | `data/kinglet.db` (image: `/data/kinglet.db`) | Plain path → SQLite; `libsql://`/`https://`/`file:` → libSQL |
| `KINGLET_DB_AUTH_TOKEN` | — | Auth token for remote libSQL/Turso databases |
| `KINGLET_ADMIN_EMAIL` | `admin@kinglet.local` | Bootstrap administrator email (when no administrator exists) |
| `KINGLET_ADMIN_PASSWORD` | *(generated)* | Bootstrap administrator password (when no administrator exists) |
| `BETTER_AUTH_SECRET` | *(generated, persisted)* | Session signing secret; set explicitly for multi-instance installs |
| `KINGLET_TRUSTED_PROXIES` | — | CIDRs allowed to set `X-Forwarded-For` |
| `KINGLET_ALLOW_PRIVATE_WEBHOOKS` | — | Allow private/internal webhook targets (SSRF escape hatch) |
| `KINGLET_DISABLE_LEGACY_TOKENS` | — | Disable workspace-wide `tok_…` superuser tokens |
| `KINGLET_SESSION_DAYS` | `30` | Web session lifetime |
| `KINGLET_TOKENS` | *(auto-generate)* | **Legacy** global tokens — all projects, full access |
| `KINGLET_BASE_URL` | — | Public URL, used for deep links in alert notifications |
| `KINGLET_RETENTION_DAYS` | `14` | Delete events older than this |
| `KINGLET_MAX_EVENTS_PER_PROJECT` | `1000000` | Hard cap on retained events per project (`0` = unlimited) |
| `KINGLET_MAX_DB_MB` | `4096` | Hard cap on local database size in MB (`0` = unlimited) |

On first boot, or if the database has no administrator, Kinglet creates one from
`KINGLET_ADMIN_EMAIL` / `KINGLET_ADMIN_PASSWORD`. If no password is set, one is
generated and printed to the console; for a local database it is also written to
`admin-password.txt` next to the database. If an account with that email already
exists, it is promoted and keeps its current password. Real ingest integrations
should use project API keys (`kl_…`) created in **/settings**, not the legacy
token.

## Storage backends

One engine for both modes: the **libSQL client** opens a local SQLite file by
default or connects to a hosted [Turso](https://turso.tech) database with the
same code. Schema and queries are defined with **Drizzle ORM**; migrations live
in `apps/api/drizzle` and run automatically on boot.

**sqlite** *(default)* — one local database file (plus WAL/SHM sidecars while running), WAL mode, FTS5 trigram search:

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
```

The dev API writes to `apps/api/data/`. On first boot, or whenever no
administrator exists, it creates one and prints the credentials (the password is
also saved to `apps/api/data/admin-password.txt` for a local database — set
`KINGLET_ADMIN_EMAIL` / `KINGLET_ADMIN_PASSWORD` before the first run to choose
your own). Sign in at `http://localhost:5173`.

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
pnpm demo:logs          # backfills an hour of events, then streams ~1 event/1.5s
pnpm demo:logs --once   # backfill only, then exit
```

(`demo:logs` authenticates with the legacy dev token from
`apps/api/data/kinglet.token`, so it works without creating a key; for a custom
port run `KINGLET_URL=http://localhost:3100 pnpm demo:logs` — or in PowerShell,
`$env:KINGLET_URL = "http://localhost:3100"; pnpm demo:logs`.)

Testing alert channels without Discord or Slack:

```bash
pnpm demo:webhook       # pretty-prints any POST on http://localhost:3999
```

Then in `/monitors`, point a channel at `http://localhost:3999/hook` and hit
**test** — the payload shows up in the catcher's console.

### Releasing images

`.github/workflows/docker.yml` publishes multi-arch images (amd64 + arm64) to
GHCR: pushes to `main` publish `:latest` and `:main`, and `v*` tags publish
`:X.Y.Z` and `:X.Y`.

```bash
git tag v0.3.0 -m "Kinglet v0.3.0"
git push origin v0.3.0
```

After the first publish, make the package public (GitHub → Packages → kinglet
→ Package settings → Change visibility) if you want anonymous pulls.

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
