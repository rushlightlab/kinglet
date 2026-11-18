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
- **Volume histogram** by level, drag across it to zoom into a time range
- **Retention built in** — drop events older than N days, automatically
- **Zero external services** — no Postgres, no Redis, no Kafka. One process.

## Quickstart (Docker)

```bash
docker compose up -d --build

# grab your ingest token
docker compose exec kinglet cat /data/kinglet.token

# open the UI
open http://localhost:8080
```

Paste the token into the UI, hit **Spray demo logs**, and watch them stream in.

Prefer fixed tokens? Set `KINGLET_TOKENS=tok_a,tok_b` in `.env` (copy from
`.env.example`) or the compose environment.

## Send logs

Anything that can make an HTTP request can log to Kinglet.

### curl / any language

```bash
curl -X POST http://localhost:8080/v1/events \
  -H "Authorization: Bearer $(docker compose exec kinglet cat /data/kinglet.token)" \
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
  token: process.env.KINGLET_TOKEN!,
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

All `/v1` routes require `Authorization: Bearer <token>`.

| Route | What it does |
| --- | --- |
| `POST /v1/events` | Ingest a batch (NDJSON or JSON, ≤ 10k events, ≤ 8MB) |
| `GET /v1/events` | Query. Params: `q` (filter grammar), `from`, `to` (epoch ms), `limit`, `cursor` |
| `GET /v1/histogram` | Counts per level per bucket. Params: `from`, `to`, `buckets` |
| `GET /v1/services` | Your known services and their event counts |
| `GET /v1/stream` | SSE live tail. Params: `q`, plus `token` (EventSource can't send headers) |
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

## Configuration

| Env var | Default | What it does |
| --- | --- | --- |
| `KINGLET_PORT` | `3000` | HTTP port |
| `KINGLET_STORAGE` | `auto` | `sqlite`, `libsql`, or `auto` (picks by db path scheme) |
| `KINGLET_DB_PATH` | `data/kinglet.db` | Plain path → SQLite; `libsql://`/`https://`/`file:` → libSQL |
| `KINGLET_DB_AUTH_TOKEN` | — | Auth token for remote libSQL/Turso databases |
| `KINGLET_TOKENS` | *(auto-generate)* | Comma-separated ingest tokens |
| `KINGLET_RETENTION_DAYS` | `14` | Delete events older than this |

When `KINGLET_TOKENS` is unset, a token is generated on first boot, printed to
the console, and written to `kinglet.token` next to the database.

## Storage backends

Storage is pluggable behind a small interface (`apps/api/src/storage/types.ts`).
The API, retention job, and live tail never know which driver is underneath.

**sqlite** *(default)* — better-sqlite3, one file, WAL mode, FTS5 trigram search.
Zero services, zero config.

**libsql** — the [libSQL](https://turso.tech) driver, for local `file:`
databases or a hosted [Turso](https://turso.tech) instance. Same container,
same API — just point it at your database:

```bash
# local libSQL file
KINGLET_STORAGE=libsql
KINGLET_DB_PATH=file:/data/kinglet.db

# Turso
KINGLET_DB_PATH=libsql://your-db.turso.io
KINGLET_DB_AUTH_TOKEN=eyJ…
```

With `KINGLET_STORAGE=auto` (the default), the driver is picked from the db
path scheme: plain paths use sqlite; `libsql://`, `https://`, `wss://`, and
`file:` URLs use libSQL. One caveat: some hosted libSQL builds lack the FTS5
trigram tokenizer — Kinglet detects that and falls back to word-prefix search
with a console warning instead of refusing to boot.

**ClickHouse** is the planned scale-out backend. It will implement the same
`Storage` interface, so the API and UI stay untouched — and if you want to
wire up Postgres or anything else in the meantime, that's the whole contract
you need to satisfy.

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

Requires Node 22+ and [pnpm](https://pnpm.io) 10+.

```bash
pnpm install
pnpm dev        # API on :3000 (tsx watch) + UI on :5173 (Vite, proxies /v1)
pnpm build      # build all packages (UI dist is served by the API after this)
pnpm typecheck
```

The dev API writes to `apps/api/data/` and prints a fresh token on first boot.

## Roadmap

- [x] v0.1 — HTTP ingest, live tail, filter grammar, histogram, retention, Docker
- [ ] Docs + landing page — Astro/Starlight site in a separate `kinglet-site` repo (HTTP API reference, self-hosting guide, SDK docs)
- [ ] v0.2 — pino transport + zero-code Node preload, PHP Monolog handler, Fluent Bit/Vector guides
- [ ] v0.3 — OTLP + syslog receivers, saved searches, shareable permalinks
- [ ] v1.0 — monitors/alerts (webhooks), ClickHouse storage profile, teams

## License

MIT — see [LICENSE](./LICENSE).
