import fs from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./e2e/support/data";
import { ADMIN_STATE_PATH, E2E_DIR } from "./e2e/support/state";

/**
 * End-to-end suite.
 *
 * Run `pnpm build` first (the server serves the built UI and API), then:
 *   pnpm test:e2e
 *
 * Local runs use the installed Google Chrome when it is present. Use the
 * bundled Chromium explicitly with `PLAYWRIGHT_CHANNEL=chromium`; CI falls
 * back to Chromium automatically. `KINGLET_E2E_PORT` overrides the loopback
 * port (default 3311).
 */

const port = Number(process.env.KINGLET_E2E_PORT ?? "3311");
const baseURL = process.env.KINGLET_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

function installedChrome(): string | undefined {
  const override = process.env.PLAYWRIGHT_CHANNEL?.trim();

  if (override === "chromium") return undefined;

  if (override) return override;

  if (process.env.CI) return undefined;

  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];

  return candidates.some((candidate) => candidate !== "" && fs.existsSync(candidate))
    ? "chrome"
    : undefined;
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        channel: installedChrome(),
        storageState: { cookies: [], origins: [] },
      },
    },
    {
      name: "chromium",
      testIgnore: /.*\.setup\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        channel: installedChrome(),
        storageState: ADMIN_STATE_PATH,
      },
    },
  ],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `${baseURL}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      KINGLET_E2E_PORT: String(port),
      KINGLET_E2E_BASE_URL: baseURL,
      KINGLET_E2E_STATE_DIR: E2E_DIR,
      KINGLET_E2E_ADMIN_EMAIL: ADMIN_EMAIL,
      KINGLET_E2E_ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
  },
});
