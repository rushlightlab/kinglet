# AGENTS.md

Instructions for AI coding agents working in the Kinglet repository. Read this
file and [`README.md`](./README.md) before changing code. If an instruction here
conflicts with an explicit request from the user, ask first.

## TL;DR

- Node **26+**, pnpm **12.21.0** (see `package.json`).
- Never push, merge, tag, deploy, change GitHub settings, or rotate secrets
  without explicit user approval. This repository is intentionally local-first
  during pre-release work.
- Never commit secrets, `apps/api/data`, databases, `dist`, or generated files.
- Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`,
  `pnpm test:unit`, and `pnpm test:integration` before declaring work complete.
  Run `pnpm test:e2e` for UI, auth, routing, or boot-path changes.
- Security-sensitive changes need a targeted runtime check, not just a build.

## What Kinglet is

Kinglet is a small, self-hostable log platform: one process, one SQLite/libSQL
database, one dark UI with a live tail. It is designed for a small trusted team,
not an open multi-tenant SaaS.

- Repository: <https://github.com/rushlightlab/kinglet>
- Public docs and landing page: <https://kinglet.rushlightlab.com>
- Docs repository: `rushlightlab/kinglet-site` (separate checkout)
- License: MIT

Core features: HTTP ingest, live tail over SSE, filter grammar, FTS5 substring
search, volume histogram, monitors/alerts, reusable notification channels,
retention, multi-project auth, scoped `kl_` API keys and `km_` MCP keys, the
zero-dependency Node SDK, optional S3 snapshots/restore and log archive, and the
stdio MCP server.

## Repository map

| Path                               | Purpose                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `apps/api/`                        | Hono API, Better Auth, Drizzle schema/migrations, ingest, monitors, retention |
| `apps/web/`                        | React UI (TanStack Router, TanStack Virtual, Vite, Tailwind, shadcn/Radix)    |
| `packages/config/`                 | Shared TypeScript config                                                      |
| `packages/sdk-node/`               | `@kinglet/sdk-node`, the batching Node client                                 |
| `packages/mcp/`                    | `@kinglet/mcp`, the stdio MCP server for AI clients                           |
| `scripts/`                         | Local demos and the Playwright server fixture (`e2e-server.mjs`)              |
| `e2e/`                             | Playwright end-to-end specs, setup/teardown, and fixtures                     |
| `deploy/`                          | Caddy and Docker Compose TLS examples                                         |
| `tools/oxlint/anti-slop/`          | Vendored Oxlint plugin and its provenance                                     |
| `.github/workflows/`               | CI, Docker release, and docs-release trigger                                  |
| `Dockerfile`, `docker-compose.yml` | Container build and local Compose setup                                       |

## Stack

- TypeScript 7, ESM, Node 26+.
- API: Hono 4, Better Auth, Drizzle ORM, `@libsql/client` (SQLite + Turso), SSE.
- Web: React 19, TanStack Router/Virtual, Vite 8, Tailwind 4, shadcn/Radix.
- Tooling: pnpm 12, Turbo, oxlint, oxfmt, anti-slop lint rules.
- Versions in each `package.json` are authoritative; do not guess upgrades.
- Node TypeScript packages (`apps/api`, `packages/mcp`, `packages/sdk-node`)
  use `.ts` relative import specifiers; `tsc` rewrites them to `.js` in `dist`.
  The web app and Playwright E2E keep bundler-style extensionless imports.
- Emitted `.d.ts` files may retain `.ts` specifiers until a postbuild rewrite;
  add one before exposing a `types` or `exports` entrypoint.

## Local development

```bash
pnpm install
pnpm dev        # API :3000 + UI :5173
pnpm build
pnpm typecheck
pnpm lint       # oxlint --deny-warnings
pnpm format
pnpm format:check
```

The dev API writes to `apps/api/data/`. On first boot (or when no administrator
exists) it creates one and prints credentials; a local database also writes
`apps/api/data/admin-password.txt`. Set `KINGLET_ADMIN_EMAIL` and
`KINGLET_ADMIN_PASSWORD` before first boot to choose them.

Useful demos:

```bash
KINGLET_KEY=kl_... pnpm demo:logs
KINGLET_KEY=kl_... pnpm demo:logs --once
pnpm demo:webhook   # listens on http://localhost:3999
```

Configuration reference: `.env.example` and the README config table. Never copy
a real `.env` into Git or an image.

## Testing

Vitest unit and integration suites live in `apps/api/test`, `packages/*/test`,
and `apps/web/test`; Playwright E2E lives in `e2e/`. The root scripts are
authoritative:

```bash
pnpm test:unit          # no database or network
pnpm test:integration   # temporary SQLite; run pnpm build first
pnpm test:e2e           # built UI/API on loopback; run pnpm build first
pnpm test               # unit, then integration
```

The integration suite spawns `packages/mcp/dist/cli.js`, so `pnpm build` must
precede it. E2E needs the built API/UI and a browser; install Chromium with
`pnpm exec playwright install chromium` locally (CI/Linux uses
`pnpm exec playwright install --with-deps chromium`; local runs prefer installed
Chrome). Tests use temporary directories, an in-memory backup store, and
loopback-only servers. Never point tests at `apps/api/data`, a real S3 bucket,
or an external network. See `docs/testing.md` for the layout, isolation rules,
and known coverage boundaries.

Do not claim a suite passed unless you ran it. The suite does not cover every
route or every hosted-libSQL variant.

## Definition of done

For code changes:

1. `pnpm lint` passes with no warnings.
2. `pnpm format:check` passes.
3. `pnpm typecheck` passes.
4. `pnpm build` passes.
5. `pnpm test:unit` and `pnpm test:integration` pass.
6. `pnpm test:e2e` passes locally for UI, auth, routing, or boot-path changes.
7. Runtime-sensitive changes get a live smoke test against a temporary database.
8. Public behavior, configuration, or security changes are reflected in the
   docs repository.

New behavior needs a test in the matching suite. Keep unit tests database-free
and integration tests on temporary storage; CI runs both. E2E runs on pull
requests. Do not weaken a test to make a product bug pass, and do not claim a
suite passed when it was skipped or did not run.

## How Kinglet works

### Ingest

`POST /v1/events` accepts NDJSON, a JSON array, `{ "events": [...] }`, or a single
event object. Limits are enforced server-side (roughly 10k events / 8 MB per
batch). Each event requires `message`/`msg`; `level`, `ts`/`time`/`timestamp`,
`service`, `env`, and `fields` are normalized in `apps/api/src/ingest.ts`.
Timestamps are auto-detected (seconds vs milliseconds vs ISO) and clamped;
`fields` are JSON with a size cap. Never move these checks to the client.

### Query and search

`GET /v1/events` uses the filter grammar (`level>=warn service:api "text"
-healthcheck`), cursor pagination, and a 31-day range clamp. SQLite uses FTS5 with
a trigram tokenizer; some remote libSQL backends fall back to word-prefix search
with a console warning. `GET /v1/histogram` and `GET /v1/services` feed the UI.

### Live tail

`GET /v1/stream` is SSE. Cookie auth is normal; headerless clients may use
`?key=`. Credentials are revalidated at least once a minute, slow consumers are
dropped, and the stream has a bounded lifetime. Ingest publishes through the
in-process bus in `apps/api/src/bus.ts`; there is no external queue.

### Monitors and alerts

The monitor engine runs in-process and refreshes from storage after CRUD.
Kinds: `match`, `count_above`, `count_below`. Each monitor has a cooldown;
count monitors auto-resolve when the condition clears. Channels are webhook,
Discord, or Slack. Alerts are stored in `alerts`; retention is separate from
event retention. `POST /v1/monitors/:id/test` sends a test notification.

### Auth, projects, and keys

- Better Auth email/password sessions; roles are `admin`, `member`, `viewer`.
- Projects are the tenant boundary. Admins see all projects; members and viewers
  need project membership. API keys are bound to one project.
- Keys are `kl_...`, hashed at rest, and scoped `ingest` and/or `query`. A key
  never inherits a human role.
- Cookie-authenticated mutations require `X-Kinglet-Request: 1`; Bearer requests
  are exempt. Mutations bypass the cookie cache; read-only requests may use a
  signed cache for up to 60 seconds.

### Storage and retention

Drizzle schema is in `apps/api/src/storage/schema.ts`; migrations live in
`apps/api/drizzle` and run on boot. Local SQLite is the default; `libsql://`,
`https://`, and `wss://` paths use remote libSQL/Turso. Retention, per-project
event/byte caps, and the local database cap are enforced by the API/retention
jobs. Do not bypass them in a route.

### Backups and archive

Optional S3 snapshots live in `apps/api/src/backups/`; they are enabled only when
`KINGLET_BACKUP_S3_*` is complete and storage is local SQLite. The bucket is the
source of truth; `backup_snapshots` is a cache. Snapshots are `VACUUM INTO` →
zstd → optional age → multipart upload → HEAD verify → manifest last. Restores
are staged under `data/restore/` and applied at boot before the database opens;
the pre-restore copy is kept for rollback and sessions are cleared. Log archive
(M4) exports expiring events to deterministic NDJSON parts before retention
deletes them; retention must skip archive-enabled projects when the global
archive is enabled.

### MCP

`packages/mcp/` is the stdio MCP server (`@kinglet/mcp`). It authenticates with
`km_` MCP keys and calls the public HTTP API; it never opens the database. MCP
scopes are `logs.read`, `monitors.read`, and `monitors.write`; API keys keep
`ingest`/`query`. Neither key type inherits a human role. Monitor read responses
to MCP clients must never include webhook URLs or raw engine errors.

### Web UI

File routes live in `apps/web/src/routes`; `routeTree.gen.ts` is generated by
TanStack Router. The UI uses URL search state, SSE for live tail, a virtualized
log table, and shadcn/Radix components. Reuse existing UI primitives rather than
adding a parallel component system.

### Node SDK

`packages/sdk-node` buffers events and POSTs NDJSON batches. It is zero-dependency,
requeues failed batches with a cap, and exposes `onError`. `LogFields` is a JSON
object type; do not widen it back to `unknown`.

## Common change recipes

### Add or change an API route

1. Add it inside `registerRoutes` in `apps/api/src/routes.ts`.
2. Use the existing auth/permission helpers; resolve and enforce the project
   boundary before reading or writing data.
3. Parse request bodies with `readJsonStrict` or the relevant parser. Do not trust
   raw fields or API keys.
4. If it is public, update the README API table and the docs `api.mdx` page.
5. Run the checks and a live request against a temporary database.

### Change the database schema

1. Edit `apps/api/src/storage/schema.ts`.
2. Run `pnpm --filter @kinglet/api db:generate` and review the generated SQL.
3. Never rewrite an already-applied migration; add a new one.
4. Update storage queries and `Storage` types as needed.
5. Test boot on a fresh temporary database, and on an existing database when the
   migration is non-trivial.

### Add or change configuration

1. Add the field to `Config`/`loadConfig` in `apps/api/src/env.ts` with a safe
   default.
2. Update `.env.example`, the README config table, and the relevant docs page
   (`self-hosting.mdx`, `security.mdx`, or both).
3. Keep enforcement server-side; do not expose a config flag that disables a
   security invariant without an explicit escape-hatch name and documentation.

### Change monitors or notifications

1. Update `apps/api/src/monitors.ts` and/or `apps/api/src/notify.ts`.
2. Preserve cooldowns, auto-resolve behavior, alert retention, SSRF checks, and
   notification sanitization.
3. Verify with `pnpm demo:webhook` or the monitor test endpoint.

### Change the web UI

1. Add or edit a file route under `apps/web/src/routes`; `routeTree.gen.ts` is
   generated by TanStack Router.
2. Reuse existing shadcn/Radix primitives and keep shareable state in the URL.
3. Run `pnpm build` and check the affected interaction in a browser. Preserve
   keyboard behavior and the existing dark visual language.

### Update dependencies

1. Use pnpm, not npm or yarn. Keep `packageManager`, `pnpm-lock.yaml`, and the
   Dockerfile pnpm bootstrap version in sync.
2. Run lint, format check, typecheck, and build.
3. If the runtime or base image changed, build and smoke-test the Docker image.
4. Review pnpm 12 build-script/agent-skill approval requests; do not auto-approve
   them.

### Prepare a release

1. Align workspace versions, update the docs, and merge `next` to `main`.
2. Create `vX.Y.Z` only with explicit user approval.
3. Let the tag workflow run the build/typecheck and wait for the `release`
   environment approval.
4. Publish the GitHub Release with operator-facing release notes; the docs
   changelog is generated from that body.

## Security invariants

Treat a change to any of these as security-sensitive and call it out explicitly.

### Authentication and sessions

- Preserve Better Auth session handling. Do not add ad-hoc auth cookies.
- Mutations bypass the session cookie cache; SSE revalidation must not be
  weakened.
- Password reset, account disable/delete, and role demotion must revoke sessions
  and owned keys as the existing code does.

### Authorization and project isolation

- Use `requirePermission`, `requireUser`, `canAccessProject`, `resolveProjectId`,
  `getAuth`, and `can` rather than duplicating checks.
- Every project-scoped read/write must filter by project ID. API keys must never
  cross project boundaries.
- Keep the last-active-admin invariant: no demoting/deleting the final admin,
  and banned admins do not count toward the guard.

### API keys

- Keys are hashed at rest, scoped, bound to a project, and managed only by their
  creator or an admin.
- Do not log plaintext keys. `?key=` on SSE is a compatibility path; do not add
  more query-string credential paths.

### CSRF and proxy trust

- Cookie mutations must keep the `X-Kinglet-Request: 1` guard and allowed-origin
  checks. Do not exclude new mutation routes.
- `KINGLET_TRUSTED_PROXIES` is a list of **proxies**, not client networks. Never
  broaden it to private ranges by default. `X-Forwarded-For` is only trusted
  from configured proxy hops.

### Ingest and resource limits

- Treat event input as untrusted. Keep normalization, body/event limits, rate
  limits, timestamp clamping, field-size checks, and quotas server-side.
- A project quota must not become a shared-database denial of service for other
  projects.

### Webhooks and notifications

- Webhook targets are SSRF-checked; DNS is resolved once and the connection is
  pinned to the vetted IP. Do not bypass this. Private targets require the
  explicit `KINGLET_ALLOW_PRIVATE_WEBHOOKS=1` escape hatch.
- Notification text is untrusted. Keep sanitization/truncation for webhooks,
  Discord, and Slack; never include secrets in payloads or logs.
- The test-notification endpoint must not leak internal network details to
  non-admin callers.
- Shared notification channel URLs are admin-only secrets: list responses mask
  them, monitor editors get id/name/type/health only, and delivery errors are
  sanitized.

### Backups, restore, and MCP

- S3 credentials and the age passphrase are env-only. Never store, log, or
  return them; manifests and notification payloads contain no secrets.
- Snapshots require local SQLite. Remote libSQL/Turso uses provider PITR.
- Restore is staged, applied before the database opens, keeps a pre-restore
  copy, refuses a newer schema, and clears sessions afterward. API keys remain.
- MCP keys are project-bound (`km_`), use a disjoint scope vocabulary, never
  act as a human role, and can only manage monitors. Never expose webhook URLs,
  admin routes, backups, restore, archive, or arbitrary SQL/shell through MCP.

### Secrets

- `BETTER_AUTH_SECRET`, bootstrap passwords, `KINGLET_DB_AUTH_TOKEN`, API/MCP
  keys, `KINGLET_BACKUP_S3_SECRET_ACCESS_KEY`, and
  `KINGLET_BACKUP_PASSPHRASE` are secrets. Never commit, print, or send them to
  logs.
- Data directories contain the database, auth secret, and bootstrap password.
  Keep them out of Git and image layers.

### Release and supply chain

- GitHub Actions are pinned by SHA; release publishing uses the `release`
  environment with required approval. Do not weaken these controls.
- `pnpm-lock.yaml` is authoritative. Use pnpm; do not hand-edit the lockfile.
- pnpm 12 build-script and agent-skill approvals (`allowBuilds`, `pnpm approve`)
  are supply-chain decisions. Do not auto-approve new entries without the user.

Security-sensitive files include `apps/api/src/auth/**`, `apps/api/src/routes.ts`,
`apps/api/src/ingest.ts`, `apps/api/src/monitors.ts`, `apps/api/src/notify.ts`,
`apps/api/src/retention.ts`, `apps/api/src/storage/**`, `apps/web/src/api.ts`,
the Dockerfiles, and `.github/workflows/**`.

## Generated files and artifacts

Do not hand-edit:

- `apps/web/src/routeTree.gen.ts` (TanStack Router generates it).
- `apps/api/drizzle/**` (Drizzle migrations; regenerate with
  `pnpm --filter @kinglet/api db:generate` and review the migration).
- `apps/api/data/**`, `*.db`, `*.db-wal`, `*.db-shm`, `admin-password.txt`,
  `auth-secret.txt`.
- `dist/**`, `.turbo/**`, `apps/web/dist/**`, `apps/api/dist/**`.
- `tools/oxlint/anti-slop/**` is vendored. Update it through the install/update
  procedure and keep `UPSTREAM.md`/licenses intact rather than reformatting it.
- `pnpm-lock.yaml` is generated; use `pnpm add`, `pnpm remove`, or `pnpm up`.

## Branches and releases

### Branches

- `main` - release-ready. Tags are cut from a release commit on `main`.
- `next` - permanent integration branch. Feature/fix branches PR into `next`.
  When it is ready for release, `next` PRs into `main`.
- `feature/*`, `fix/*`, `docs/*` - short-lived work branches for review. Prefer
  these for PR-bound changes. Local commits on `next` are fine when that is the
  user's working branch, but do not rewrite shared history or bypass the branch
  rulesets.

`next` is protected by a ruleset requiring a pull request and the `build` check,
with force-pushes and deletion blocked. Do not modify or bypass the ruleset.

### Release flow

1. Land changes on `next` through focused PRs; CI runs format check, lint,
   typecheck, and build.
2. Open `next` -> `main`, merge only after CI is green and review is complete.
3. Keep workspace versions aligned (`package.json` files) and update the
   changelog via GitHub Releases, not hand-edited docs.
4. Create a strict `vX.Y.Z` tag from `main` only when the user explicitly asks.
5. The Docker workflow verifies the tag, builds/typechecks, waits for approval in
   the `release` environment, then publishes multi-arch GHCR images
   (`X.Y.Z`, `X.Y`, `latest`). Main pushes never publish images.
6. A published GitHub Release feeds the docs changelog and landing version badge.
   The docs repo is promoted separately (`docs/pre-release` -> `main`).

Release tags are protected by the `Release Tags` ruleset; release immutability is
enabled. Never create/move/delete tags or modify release settings without
explicit approval.

## CI, Docker, and dependencies

- CI runs on `main`, `next`, and pull requests: install with
  `--frozen-lockfile`, format check, lint, typecheck, build. Docker build runs on
  PRs only; image publishing runs from tags only.
- Use the `Dockerfile` as-is unless the task is Docker-related. It uses exact
  base tags, a manifest-only install layer, BuildKit pnpm/Turbo cache mounts, and
  a non-root runtime on port 3000. The database lives in `/data`.
- Test Docker changes with `docker build -t kinglet:local .` and a container
  health/UI smoke test. Do not change the pnpm bootstrap version without also
  checking `packageManager`, the lockfile, and Turbo task spawning.
- The docs site is a separate repository. Public API, configuration, security, or
  behavior changes should be reflected there in the same effort.
- pnpm 12 may report packages awaiting build-script or agent-skill approval. Treat
  that as a security review item and ask the user before approving.

## Working rules for agents

- Keep changes scoped. Do not reformat unrelated files or perform broad
  refactors unless the user asks.
- Prefer existing helpers and UI components. Do not add dependencies without a
  concrete need; this project deliberately stays small.
- Do not disable lint rules, add broad ignore patterns, weaken severities, or
  mechanically launder types to make checks pass. Anti-slop rules are errors.
  `pnpm lint:fix` is for spacing fixes; if a rule is wrong, discuss a scoped
  configuration change and document it.
- For runtime changes, start the API with a temporary database and exercise the
  affected flow (sign-in, project/key, ingest, query, SSE, monitor, or alert).
  Never point verification at production data.
- For security changes, state the invariant you are preserving and test the
  boundary (unauthorized, wrong project, revoked key, private webhook, last
  admin, etc.).
- Update `README.md`, `.env.example`, and the public docs when configuration or
  behavior changes. Update this file if the workflow changes.
- If a requirement is ambiguous, especially around security, releases, or data
  deletion, stop and ask.

## Where to look

- Product and operator guide: `README.md`.
- Security guidance: the docs site `/security/` page
  (`kinglet-site/src/content/docs/security.mdx`).
- Auth and permissions: `apps/api/src/auth/`.
- Routes and quotas: `apps/api/src/routes.ts`.
- Ingest normalization: `apps/api/src/ingest.ts`.
- Monitors and alerts: `apps/api/src/monitors.ts`.
- Webhooks/SSRF/sanitization: `apps/api/src/notify.ts`.
- Notification channels and delivery: `apps/api/src/notifications/`.
- Snapshots, archive, and restore: `apps/api/src/backups/`, `archive/`, `restore/`.
- MCP server and machine keys: `packages/mcp/`, `apps/api/src/auth/apikeys.ts`.
- Storage/schema/migrations: `apps/api/src/storage/` and `apps/api/drizzle/`.
- CI/release: `.github/workflows/`, `Dockerfile`, `docker-compose.yml`, `deploy/`.
