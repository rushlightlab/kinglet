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
database when the run finishes.

## Browser

Local runs use the installed Google Chrome when it is present and otherwise
fall back to Playwright's Chromium. To force one explicitly:

```bash
PLAYWRIGHT_CHANNEL=chromium pnpm test:e2e
PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e
```

CI uses the bundled Chromium and must install it once:

```bash
pnpm exec playwright install --with-deps chromium
```

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
