# Task 7 report — Playwright end-to-end suite

## Status

Complete. All acceptance checks pass, including the suite on the installed
Chrome and on Playwright's bundled Chromium (the CI path).

## Commit

- `1bfe7fe` — Add Playwright end-to-end suite with a temporary server fixture
  (branch `tests`, based on `486db4b`).
- This report is a follow-up documentation commit; no production behavior was
  changed.

## Files

Added:

- `playwright.config.ts` — setup + browser projects, shared `storageState`,
  Chrome/Chromium selection, global setup/teardown, `webServer`.
- `scripts/e2e-server.mjs` — preflight build check, temporary data dir/database,
  scrubbed environment, built API child process on loopback, `/healthz`
  readiness, stale-run cleanup, SIGINT/SIGTERM cleanup.
- `tsconfig.e2e.json` — typechecks `e2e/**` and `playwright.config.ts`.
- `e2e/global-setup.ts` — seeds the fresh database through the public HTTP API.
- `e2e/global-teardown.ts` — stops the webServer tree and removes the temp DB
  directory (needed because Playwright cannot gracefully stop a webServer on
  Windows).
- `e2e/auth.setup.ts`, `e2e/member.setup.ts` — one UI sign-in each, saved as
  shared storage states.
- `e2e/auth.spec.ts`, `e2e/logs.spec.ts`, `e2e/projects.spec.ts`,
  `e2e/monitors.spec.ts`, `e2e/backups.spec.ts`, `e2e/notifications.spec.ts`,
  `e2e/mcp-keys.spec.ts`, `e2e/member.spec.ts`, `e2e/account.spec.ts`.
- `e2e/support/data.ts`, `e2e/support/state.ts`, `e2e/support/api.ts`,
  `e2e/support/ui.ts` — deterministic fixtures, shared state paths, API and UI
  helpers.
- `e2e/README.md` — commands, browser selection, layout, isolation rules.

Changed:

- `package.json` — root `test:e2e`; root `typecheck` now also runs
  `typecheck:e2e`.
- `.gitignore` — `.e2e/`, `test-results/`, `playwright-report/`,
  `blob-report/`.

## Coverage

| Required flow | Where |
| --- | --- |
| Admin login/logout (and sign back in) | `auth.setup.ts`, `auth.spec.ts` |
| Project switch | `projects.spec.ts` |
| Log search, filter, event drawer, live tail | `logs.spec.ts` (3 tests) |
| Monitor create, pause, resume (and cleanup delete) | `monitors.spec.ts` |
| Settings backups setup state (unconfigured S3) | `backups.spec.ts` |
| Notification create, masked list, edit reveal, delete | `notifications.spec.ts` |
| MCP key one-time secret and pinned `@kinglet/mcp@0.3.0` config | `mcp-keys.spec.ts` |
| Member view of legacy URL masking | `member.spec.ts` |
| Account password change and re-sign-in | `account.spec.ts` |

## Fixture design

- The server always uses a fresh `mkdtemp` directory under the OS temp dir and
  `KINGLET_DB_PATH` inside it. It never reads or writes `apps/api/data`.
- `scripts/e2e-server.mjs` strips inherited `KINGLET_*` and
  `BETTER_AUTH_SECRET` values before setting its own, so a local shell cannot
  point the suite at real data, a real base URL, or a real S3 bucket.
- The API is the built `apps/api/dist/index.js`; the UI is served from
  `apps/web/dist`, so `pnpm build` is required first. The preflight prints an
  explicit instruction and exits 1 when either artifact is missing.
- Global setup signs in as the bootstrap admin and seeds through the real
  routes: two projects (`default`, `staging`), a `kl_` ingest/query key, five
  default-project events, one staging event, a disabled legacy monitor with an
  inline dummy webhook, a member, and a viewer. The monitor is disabled so the
  engine never attempts an outbound request.
- The plaintext seed key is kept in memory and written only to
  `.e2e/seed.json` (gitignored, removed by global teardown). It is never
  printed, and failure messages include status codes only.
- Setup tests perform exactly one UI sign-in each. The suite is serial
  (`workers: 1`, `fullyParallel: false`), and total sign-ins per run stay well
  under Better Auth's 20/minute `/sign-in/email` limit.
- Tests that create data use per-run or per-test names and delete their own
  monitor, notification channel, and MCP key. The temp database discards any
  residue from a failed test.
- The account-password test uses a dedicated viewer account, changes the
  password, changes it back in a `finally`, then signs out and back in with the
  original. It opts out of retries because a retry after a half-finished
  password change could not authenticate.

## Commands and results

Run from the worktree root on Windows with Node `v26.13.0` and pnpm `12.21.0`:

| Command | Result |
| --- | --- |
| `pnpm build` | Pass (4 tasks; API/MCP/SDK cached, web built) |
| `pnpm test:e2e` (installed Chrome) | Pass — 13 tests, 40.8s |
| `pnpm exec playwright install chromium` | Installed Chromium 1255 + headless shell (removed unused 1243 builds) |
| `PLAYWRIGHT_CHANNEL=chromium pnpm test:e2e` | Pass — 13 tests, 36.1s |
| `pnpm test:unit` | Pass — 251 tests in 15 files |
| `pnpm test:integration` | Pass — 119 tests in 21 files |
| `pnpm lint` | Pass (`oxlint --deny-warnings`) |
| `pnpm format:check` | Pass |
| `pnpm typecheck` | Pass (Turbo + `tsc` over `tsconfig.e2e.json`) |

Cleanup was verified after a run: `.e2e/` is gone and no `kinglet-e2e-*`
directory remains under `%TEMP%`.

## Deviations and notes

1. **Fixed default port.** The fixture uses `127.0.0.1:3311` with
   `KINGLET_E2E_PORT` as an override. Playwright's `webServer` and
   `use.baseURL` must agree before the server starts, so a config-time free-port
   probe would add complexity; a fixed port with an explicit override and a
   clear "already used" error is simpler and CI-friendly.
2. **Chrome vs Chromium.** Non-CI runs use the installed Google Chrome when one
   of the known paths exists; `PLAYWRIGHT_CHANNEL=chromium` forces bundled
   Chromium, and CI does so automatically. Chromium 1255 was installed locally
   to verify that path; both paths pass.
3. **Root typecheck expanded.** `pnpm typecheck` now runs
   `typecheck:e2e` after Turbo. It invokes the API workspace's `tsc` and points
   `typeRoots` at the API workspace's `@types/node`, so no new dependency was
   added. `tsconfig.e2e.json` uses bundler resolution because Playwright
   transpiles the extensionless test imports at runtime.
4. **Windows teardown.** Playwright force-kills `webServer` on Windows, so the
   server script's own signal cleanup cannot run there. `global-teardown.ts`
   kills the server process tree, waits for the API to exit, and removes the
   temporary directory. The server script also cleans up on SIGINT/SIGTERM and
   removes a stale run's temp directory at startup.
5. **No production changes.** The suite only exercises existing public
   behavior. `pnpm build`, unit, integration, lint, format, and typecheck all
   remain green.
6. **Pre-existing legacy-editor observation (not a test failure, no change
   made).** `MonitorForm`'s `legacyMode` branch checks
   `initial.channelIds === undefined`, but the API's `rowToMonitor` always
   returns an array (empty when there are no linked channels). A legacy monitor
   therefore renders the "No reusable channels exist yet" state rather than the
   "inline destinations stay hidden" notice. The API still masks legacy URLs
   (`url: "hidden"`), and the member test verifies that boundary plus the
   absence of the URL from the DOM. This should be triaged separately if the
   legacy editor text is expected behavior.

## Task 8: CI wiring recommendation

Add a separate E2E job (do not fold it into the unit/integration job) with:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm build
- run: pnpm exec playwright install --with-deps chromium
- run: pnpm test:e2e
  env:
    CI: "true"
```

Notes for that job:

- `CI=true` makes the config use bundled Chromium and enables the single CI
  retry; `PLAYWRIGHT_CHANNEL=chromium` is not required but can be set for
  explicitness.
- The built API and UI must exist before `test:e2e`; the job must run `build`
  first. The script fails with a clear message if either is missing.
- Upload `test-results/` (traces and failure screenshots) when the job fails.
- Cache Playwright browsers keyed on the `@playwright/test` version or
  `pnpm-lock.yaml` to avoid downloading Chromium on every run.
- `pnpm typecheck` already covers `playwright.config.ts` and `e2e/**`, so the
  existing typecheck job will catch type errors without an extra step.
- If the project chooses to keep E2E local-only for now, document that
  `pnpm build && pnpm test:e2e` is the required local command and keep the job
  disabled rather than claiming CI coverage.
