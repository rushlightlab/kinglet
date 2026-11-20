# Testing

Kinglet has three test layers: Vitest unit tests, Vitest integration tests, and
Playwright end-to-end tests. The suite is local-first: no test may call an
external network, a real webhook, or a real S3 bucket.

## Commands

| Command                 | Suite                                                                     | Prerequisites                         |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| `pnpm test:unit`        | Fast unit tests; no database and no sockets                               | none                                  |
| `pnpm test:integration` | API and package integration tests against real temporary SQLite databases | `pnpm build`                          |
| `pnpm test:e2e`         | Playwright against the built API and UI on loopback                       | `pnpm build`; a Playwright browser    |
| `pnpm test`             | Unit, then integration                                                    | `pnpm build` for the integration half |

`pnpm build` must run before `pnpm test:integration`: the MCP stdio contract
test spawns the built `packages/mcp/dist/cli.js` and fails with an explicit
instruction when it is missing. E2E also needs the build because
`scripts/e2e-server.mjs` serves `apps/api/dist/index.js` and `apps/web/dist`,
and its preflight exits when either artifact is absent.

The canonical full check set is:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

## Layout

- `apps/api/test/unit/` - pure unit tests for ingest, filters, auth helpers,
  scheduling, archive formats, backups, and storage accounting.
- `apps/api/test/integration/` - the app seam from `apps/api/src/app.ts` with
  real Better Auth, real routes, and a temporary SQLite database.
- `apps/api/test/helpers/` - temp database, test config, app harness, request
  helpers, deterministic seed data, loopback servers, and the MCP stdio client.
- `packages/mcp/test/unit/` - MCP config, client error-bound, and result-size
  unit tests.
- `packages/sdk-node/test/unit/` and `packages/sdk-node/test/integration/` -
  batching, retry, headers, and no-secret-leak tests with a fake `fetch` or a
  loopback fake server.
- `apps/web/test/unit/` - pure formatting and redaction helpers.
- `e2e/` - Playwright global setup/teardown, shared sign-in state, and the
  user-facing spec files.
- `scripts/e2e-server.mjs` - the Playwright `webServer` fixture: temporary data
  directory, built API process, `/healthz` readiness, and cleanup.
- `vitest.unit.config.ts`, `vitest.integration.config.ts`, `vitest.config.ts` -
  the unit, integration, and combined Vitest configs.
- `playwright.config.ts` - Playwright projects, web server, and browser
  selection.

## Test seams

Production code exposes only a few seams for tests and embedding. Do not add
another without a production need.

- `createApp` (`apps/api/src/app.ts`) accepts storage, config, auth, and engines
  and never starts timers or listens. Tests pass no-op engines and
  `staticUi: false`.
- `onRestoreStaged` is optional. Production `main()` passes a callback that
  sends `SIGTERM` after the 202 response so a supervisor restarts into the
  swap; tests and embedders leave it undefined.
- `deleteArchivedObjects` is an optional app seam for archive cleanup on project
  deletion and all-time clear. Production leaves it undefined.
- `BackupObjectStore` (`apps/api/src/backups/s3.ts`) is the storage interface.
  Restore staging accepts an optional `store` so tests can use an in-memory
  adapter; production constructs and destroys the S3 adapter. `createApp` and
  `registerRestoreRoutes` accept an optional `restoreStore` that is passed
  through to staging, so route tests exercise the real handler with an injected
  store. Production leaves it undefined.

## Isolation

- Integration tests call `createTempDatabase()` (`apps/api/test/helpers/temp.ts`),
  which creates `kinglet-test-*` under the OS temp directory. Each test file
  owns its database and removes the directory after closing storage. Tests must
  never use or write `apps/api/data`.
- `createTestHarness()` wires the production app with a temporary database and
  no-op engines. `makeTestConfig()` defaults to `backup: null` and no remote
  storage. Callers that use `makeTestConfig()` directly must override `dbPath`
  and `dataDir` with a temp directory.
- Backups use `InMemoryBackupStore` (`apps/api/test/helpers/backup-store.ts`) or
  an injected fake. No test opens an S3 or other remote connection.
- Machine-contract tests bind fake HTTP servers to loopback only. The SDK test
  uses a loopback server and the MCP stdio test spawns the built CLI against a
  loopback fake API. Child processes and servers are closed in `finally` blocks.
- E2E uses `scripts/e2e-server.mjs`, which strips inherited `KINGLET_*` and
  `BETTER_AUTH_SECRET` values before setting its own; a developer's shell cannot
  point the suite at real data, a real base URL, or a real bucket. The server
  creates a `kinglet-e2e-*` directory under the OS temp dir, sets
  `KINGLET_HOST=127.0.0.1`, and removes the database directory on shutdown.
- E2E login state and the seed key live under `.e2e/` (gitignored, created with
  mode `0700`; files are written with mode `0600` where the platform supports
  it). Global teardown removes `.e2e/` and the temporary database. A hard-killed
  run may leave a `kinglet-e2e-*` directory or `.e2e/` behind. The next server
  start removes the temp directory recorded in `.e2e/server.json` when that
  record points at a stopped run; it does not sweep arbitrary orphaned
  `kinglet-e2e-*` directories. Delete stale directories and `.e2e/` manually
  after an abort.
- Never commit databases, temp directories, `.e2e/`, `test-results/`, or
  `playwright-report/`.

## No external network

Unit and integration tests must not make outbound requests. Stub `fetch` or use
a loopback-only fake server. E2E may talk only to the local fixture; there is no
base-URL override. Do not point a test at a real webhook, Discord, Slack, S3,
Turso, or a production Kinglet instance. A test that needs a remote service is a
design bug, not a permission.

## Running one file or one test

```bash
# One unit file
pnpm exec vitest run --config vitest.unit.config.ts apps/api/test/unit/ingest.test.ts

# One integration file (run pnpm build first)
pnpm exec vitest run --config vitest.integration.config.ts \
  apps/api/test/integration/auth.test.ts

# One test name inside a suite
pnpm exec vitest run --config vitest.integration.config.ts \
  apps/api/test/integration/backups-restore.test.ts -t "tampered"

# One Playwright spec (run pnpm build first)
pnpm exec playwright test e2e/auth.spec.ts

# One Playwright test by title
pnpm exec playwright test e2e/logs.spec.ts -g "live tail"
```

Vitest watch mode is the same command without `run`. Playwright still runs the
`setup` project dependency for a single spec.

## Browsers

CI and Linux users install the bundled Chromium and its system dependencies
once:

```bash
pnpm exec playwright install --with-deps chromium
```

On a developer machine, `pnpm exec playwright install chromium` is enough.
Local runs prefer installed Google Chrome when present; `CI=true` and
`PLAYWRIGHT_CHANNEL=chromium` force the bundled Chromium. Set
`KINGLET_E2E_PORT` to move the fixture off its default loopback port `3311`.

## CI

The `build` job runs format check, lint, typecheck, build, `pnpm test:unit`, and
`pnpm test:integration` (in that order, so the MCP CLI exists). The separate
`e2e` job runs on pull requests only: frozen-lockfile install, build, Chromium
install, then `pnpm test:e2e` with `CI=true`. All GitHub Actions are pinned by
full SHA.

On failure the E2E job uploads `test-results/` for seven days. Traces and
screenshots can contain test-session cookies, request headers, and data
exchanged with the test server, including the temporary seed API key sent by
`e2e/logs.spec.ts` through `page.request`. That key is scoped to a database
deleted at teardown, this repository is public, and artifact access is not a
secret boundary; treat the artifact as sensitive and keep access limited.
`.e2e/` (storage states and its seed file) is never uploaded.

## Accepted behavior and follow-ups

These behaviors are intentional and covered only at the level stated, not silent
gaps:

- Archive import commits one part at a time. If a later part fails, parts 1..N-1
  remain committed. Re-import is idempotent by archive `uid`, so retrying the
  same range is safe and does not duplicate events. The suite does not exercise a
  multi-part import where a later part fails; that partial-progress behavior is
  accepted, not rolled back.
- `validateSpoolFile` and `insertSpoolFile` parse and re-stringify every line
  twice, once for verification and once for insertion. That CPU cost is accepted
  to keep checksum/project verification before any write and inserts bounded.
- Archive import caps decompressed NDJSON at 1 GiB per part (`MAX_SPOOL_BYTES`)
  and spools under `<dataDir>/tmp`. It does not enforce the exporter's
  10,000-event part limit, so a part with many tiny lines can still cause many
  inserts. It also does not preflight free space with `statfs`; a full data
  directory fails the spool write with a sanitized 500. The cap test injects a
  small limit instead of writing a 1 GiB fixture.
- The SDK omits `service`/`env` when the option is unset, but an empty or
  whitespace-only string is sent and the server normalizes it to null. Blank
  values are not rejected client-side.
- The SDK batches by event count, not bytes (`batchSize` is a count). A batch of
  very large events can exceed the server body limit; the resulting 413 is
  re-queued like any other failure, so that batch can retry indefinitely.
  Byte-based batching remains a product follow-up.
- Backup-engine end-to-end (a full run against a fake store) and age-encrypted
  success staging remain follow-ups. Rejection paths, staged database bytes, the
  restore route's `requestedBy`, and injected-store lifetime are covered.
  Archive-object deletion is covered with a fake store and app wiring; deleting
  archived objects against a real bucket is not.
- The production `readObjectText` cap is unit-tested without AWS. The S3 adapter,
  presigning, multipart upload, retries, and real bucket errors are not.

## Known coverage boundaries

These are intentional gaps, not claims of coverage:

- Integration tests use temporary SQLite and an in-memory backup store. They do
  not exercise a real S3-compatible endpoint, DNS resolution, or TLS. SSRF
  address classification and manifest signing are unit-tested.
- The archive unique-index test (`archive-migration.test.ts`) replays the
  shipped `0009` SQL against a pre-`0009` table so the dedupe `DELETE` runs. It
  does not run the full Drizzle migrator from an older release. Every fresh
  integration database does run the full migrator, so a broken migration still
  fails the suite; upgrading a populated database with duplicate archive rows is
  not replayed end-to-end.
- Test coverage is not measured or enforced. There are no coverage thresholds.

Do not describe the accepted behavior or boundaries above as covered.
