# End-to-end tests

Playwright drives the built Kinglet UI against a real API process with a
temporary SQLite database.

## Commands

```bash
pnpm build          # required first: the server serves apps/api/dist + apps/web/dist
pnpm test:e2e
```

`pnpm test:e2e` fails immediately with a build instruction when either the
built API or the built UI is missing. The suite starts the API itself on
`127.0.0.1:3311` (override with `KINGLET_E2E_PORT`) and removes its temporary
database when the run finishes. The server is explicitly bound to loopback with
`KINGLET_HOST=127.0.0.1`; there is no base-URL override, so the suite cannot be
pointed at a non-loopback host.

## Browser

Local runs use the installed Google Chrome when it is present and otherwise
fall back to Playwright's Chromium. To force one explicitly:

```bash
PLAYWRIGHT_CHANNEL=chromium pnpm test:e2e
PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e
```

CI uses the bundled Chromium (`CI=true`) and must install it once:

```bash
pnpm exec playwright install --with-deps chromium
```

On a Linux runner the full sequence is `pnpm install --frozen-lockfile`,
`pnpm build`, the browser install above, then `pnpm test:e2e`.

## Layout

- `playwright.config.ts` — projects, web server, global setup/teardown.
- `scripts/e2e-server.mjs` — temporary data directory, built API, `/healthz`
  readiness, cleanup.
- `e2e/global-setup.ts` — seeds projects, a `kl_` key, events, a disabled
  legacy monitor, a member, and a viewer through the public HTTP API.
- `e2e/*.setup.ts` — one UI sign-in per shared `storageState` (kept under
  `.e2e/`, which is gitignored).
- `e2e/*.spec.ts` — the user-facing flows.

Tests run serially against one server fixture. Created monitors, channels,
and MCP keys use per-run names and are removed by the test that creates them;
the server fixture discards the rest with the temporary database.

## State and cleanup

`.e2e/` holds the shared session cookies and the test-only seed key. It is
created with mode `0700`; `seed.json` and the two storage-state files are
written with mode `0600`, and the directory is gitignored. Global teardown
removes `.e2e/` and the temporary database directory.

A hard-killed run (for example, a force-closed terminal) can leave `.e2e/` or
a `kinglet-e2e-*` directory under the OS temp folder. The next server start
removes the temp directory recorded in `.e2e/server.json` when that record
points at a stopped run; it does not sweep arbitrary orphaned `kinglet-e2e-*`
directories. Global setup deletes/recreates its state files, but you can also
delete both manually after an abort. The seed key in a stale `.e2e/seed.json`
is useless once its temporary database is gone.
