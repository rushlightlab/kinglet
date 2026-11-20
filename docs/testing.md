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
- `packages/mcp/test/unit/` - MCP config and result-size unit tests.
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
  adapter; production constructs and destroys the S3 adapter.

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
  run may leave a `kinglet-e2e-*` directory or `.e2e/` behind; the next server
  start removes stale `kinglet-e2e-*` runs, and both can be deleted manually.
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
commit SHA.

On failure the E2E job uploads `test-results/` for seven days. Traces and
screenshots can contain test-session cookies, request headers, and data
exchanged with the test server; treat the artifact as sensitive and keep access
limited. `.e2e/` (storage states and the seed key) is never uploaded.

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
- Age-encrypted successful restore staging and a full backup-engine run against
  a fake store are not covered; the rejection paths are. The production
  `BackupStore.getObjectText` size cap is not unit-tested.
- Test coverage is not measured or enforced. There are no coverage thresholds.

Task 9 and the final suite review track the remaining hardening items; do not
describe the gaps above as covered.
