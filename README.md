# 👑 Kinglet

**Small. Light. King.** — a tiny self-hostable log platform. The Axiom-shaped
experience, running on your own $5 VPS: one container, one SQLite file, one
fast dark UI with a live tail.

Named after the tiny bird with the golden crown (genus *Regulus* — "little king").

- **Ingest anything over HTTP** — NDJSON or JSON batches, from any language
- **Live tail** over SSE, with follow mode
- **Full-text search** — SQLite FTS5 with a trigram tokenizer, so substring
  matches (`"timeout"`) just work
- **Filter grammar** — `level>=warn service:api "connection refused" -healthcheck`
- **Monitors & alerts** — instant match, rate spikes, silence detection → webhook/Discord/Slack
- **Team-ready auth** — Better Auth email/password login with admin / member / viewer roles and cached sessions
- **Multi-project** — every project owns its logs, monitors, and `kl_…` API keys with `ingest`/`query` scopes
- **Volume histogram** by level, drag across it to zoom into a time range
- **Retention built in** — drop events older than N days, automatically
- **Zero external services** — no Postgres, no Redis, no Kafka. One process.

## Quickstart (Docker)

```bash
docker compose up -d --build

# first boot creates the administrator; if no password was configured,
# a generated one is printed in the logs and saved here:
docker compose exec kinglet cat /data/admin-password.txt

# open the UI
open http://localhost:8080
```

Sign in with the admin email (default `admin@kinglet.local`) and that password.
Set `KINGLET_ADMIN_EMAIL` / `KINGLET_ADMIN_PASSWORD` in `.env` (copy from
`.env.example`) to choose your own — they only apply when no users exist yet.

Then go to **/settings → projects & keys**, create an API key (`kl_…`, scopes
`ingest` / `query`), and send your first log with it:

```bash
curl -X POST http://localhost:8080/v1/events \
  -H "Authorization: Bearer kl_…" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary '{"level":"error","message":"payment failed","service":"billing"}'
```

No clone needed? Run the published multi-arch image (replace `your-org` with
the repository owner):

```bash
docker run -d --name kinglet -p 8080:3000 -v kinglet-data:/data \
  ghcr.io/your-org/kinglet:latest
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

```bash
pnpm add @kinglet/sdk-node   # or: npm i @kinglet/sdk-node
```

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

Auth accepts either the `kinglet_session` cookie (the web UI) or
`Authorization: Bearer kl_…` (API keys). Project-scoped routes take `?project=<id>`
(sessions/legacy tokens); API keys are bound to their project.

| Route | What it does |
| --- | --- |
| `/api/auth/*` | Better Auth endpoints (sign-in, sign-out, session, password) |
| `GET /v1/me` | Current user + permissions |
| `GET/POST /v1/projects` | List / create projects |
| `DELETE /v1/projects/:id` | Delete a project and all its data |
| `GET/POST /v1/users` | List / create users (admin) |
| `PATCH/DELETE /v1/users/:id` | Change role / delete user (admin) |
| `GET/POST /v1/projects/:id/keys` | List / create API keys for a project |
| `DELETE /v1/keys/:id?project=` | Revoke an API key |
| `POST /v1/events` | Ingest a batch (NDJSON or JSON, ≤ 10k events, ≤ 8MB) |
| `GET /v1/events` | Query. Params: `q` (filter grammar), `from`, `to` (epoch ms), `limit`, `cursor` |
| `GET /v1/histogram` | Counts per level per bucket. Params: `from`, `to`, `buckets` |
| `GET /v1/services` | Your known services and their event counts |
| `GET /v1/stream` | SSE live tail. Params: `q` (cookie auth; `?key=`/`?token=` for shippers) |
| `GET/POST /v1/monitors` | List monitors / create one |
| `PATCH/DELETE /v1/monitors/:id` | Update / delete a monitor |
| `POST /v1/monitors/:id/test` | Send a test notification through every channel |
| `GET /v1/alerts` | Alert history, latest first |
| `GET /healthz` | Health check (no auth) |

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
`?project=<id>` — API keys can't manage monitors; use the UI or a session):

| Kind | Fires when | Example |
| --- | --- | --- |
| `match` | any event matches — instantly | `level:fatal` |
| `count_above` | more than N matches within a window | `level>=error service:api` > 10 in 5m |
| `count_below` | fewer than N matches within a window (silence) | `service:cron-backup` < 1 in 30m |

Create one over HTTP, or in the UI at `/monitors`:

```bash
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
| `KINGLET_DB_PATH` | `data/kinglet.db` | Plain path → SQLite; `libsql://`/`https://`/`file:` → libSQL |
| `KINGLET_DB_AUTH_TOKEN` | — | Auth token for remote libSQL/Turso databases |
| `KINGLET_ADMIN_EMAIL` | `admin@kinglet.local` | Bootstrap administrator email (first boot only) |
| `KINGLET_ADMIN_PASSWORD` | *(generated)* | Bootstrap administrator password (first boot only) |
| `BETTER_AUTH_SECRET` | *(generated, persisted)* | Session signing secret; set explicitly for multi-instance installs |
| `KINGLET_TRUSTED_PROXIES` | — | CIDRs allowed to set `X-Forwarded-For` |
| `KINGLET_ALLOW_PRIVATE_WEBHOOKS` | — | Allow private/internal webhook targets (SSRF escape hatch) |
| `KINGLET_DISABLE_LEGACY_TOKENS` | — | Disable workspace-wide `tok_…` superuser tokens |
| `KINGLET_SESSION_DAYS` | `30` | Web session lifetime |
| `KINGLET_TOKENS` | *(auto-generate)* | **Legacy** global tokens — all projects, full access |
| `KINGLET_BASE_URL` | — | Public URL, used for deep links in alert notifications |
| `KINGLET_RETENTION_DAYS` | `14` | Delete events older than this |

On first boot with an empty users table, Kinglet creates the administrator from
`KINGLET_ADMIN_EMAIL` / `KINGLET_ADMIN_PASSWORD`. If no password is set, one is
generated, printed to the console, and written to `admin-password.txt` next to
the database. Real ingest integrations should use project API keys (`kl_…`)
created in **/settings**, not the legacy token:

## Storage backends

One engine for both modes: the **libSQL client** opens a local SQLite file by
default or connects to a hosted [Turso](https://turso.tech) database with the
same code. Schema and queries are defined with **Drizzle ORM**; migrations live
in `apps/api/drizzle` and run automatically on boot.

**sqlite** *(default)* — one local file, WAL mode, FTS5 trigram search:

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

- **Resources**: ~150–250MB RAM. Millions of events/day fit comfortably on a
  2 vCPU / 2GB VPS; ~300–500MB of disk per million retained events.
- **Backups**: the whole store is one file — point
  [Litestream](https://litestream.io/) at `data/kinglet.db` for continuous
  S3 replication.
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

The dev API writes to `apps/api/data/`. On first boot it creates the
administrator and prints the credentials (password also saved to
`apps/api/data/admin-password.txt` — set `KINGLET_ADMIN_EMAIL` /
`KINGLET_ADMIN_PASSWORD` before the first run to choose your own). Sign in at
`http://localhost:5173`.

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
GHCR: pushes to `main` publish `:latest` / `:main` / `:sha-…`, and `v*` tags
publish `:X.Y.Z` and `:X.Y`.

```bash
git tag v0.1.0 -m "Kinglet v0.1.0"
git push origin v0.1.0
```

After the first publish, make the package public (GitHub → Packages → kinglet
→ Package settings → Change visibility) if you want anonymous pulls.

## Roadmap

- [x] v0.1 — HTTP ingest, live tail, filter grammar, histogram, retention, Docker
- [x] Auth & multi-project — email login, admin/member/viewer roles, per-project `kl_` keys with scopes
- [x] Drizzle ORM + Better Auth — typed schema, generated migrations, cached sessions, JSON error contract
- [x] Monitors & alerts — instant match, spike, silence → webhook/Discord/Slack with cooldown + auto-resolve
- [x] UI polish — URL-synced views, shareable permalinks, saved searches, keyboard navigation, Kinglet design language
- [x] Docs + landing page — Astro/Starlight site in a separate `kinglet-site` repo (HTTP API reference, self-hosting guide, SDK docs)
- [ ] v0.2 — pino transport + zero-code Node preload, PHP Monolog handler, Fluent Bit/Vector guides
- [ ] v0.3 — OTLP + syslog receivers
- [ ] v1.0 — ClickHouse storage profile, teams

## License

MIT — see [LICENSE](./LICENSE).
