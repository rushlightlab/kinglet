#!/usr/bin/env node
/**
 * Playwright webServer fixture: boot the built Kinglet API against a fresh
 * temporary database on loopback, wait for /healthz, and remove the database
 * again on shutdown.
 *
 * The script never touches `apps/api/data` and never inherits KINGLET_* or
 * BETTER_AUTH_SECRET from the caller, so a developer's local configuration
 * cannot point the tests at real data or a real S3 bucket.
 *
 * Run `pnpm build` before `pnpm test:e2e`; the preflight below fails loudly
 * when the built API or UI is missing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiEntry = path.join(repoRoot, "apps", "api", "dist", "index.js");
const webIndex = path.join(repoRoot, "apps", "web", "dist", "index.html");

const port = Number(process.env.KINGLET_E2E_PORT ?? "3311");
const baseURL = `http://127.0.0.1:${port}`;
const stateDir = process.env.KINGLET_E2E_STATE_DIR ?? path.join(repoRoot, ".e2e");
const adminEmail = process.env.KINGLET_E2E_ADMIN_EMAIL;
const adminPassword = process.env.KINGLET_E2E_ADMIN_PASSWORD;

function fail(message) {
  console.error(`[e2e] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(apiEntry)) {
  fail(`Built API not found at ${apiEntry}. Run "pnpm build" before "pnpm test:e2e".`);
}

if (!fs.existsSync(webIndex)) {
  fail(`Built UI not found at ${webIndex}. Run "pnpm build" before "pnpm test:e2e".`);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail(`KINGLET_E2E_PORT must be a TCP port, received "${process.env.KINGLET_E2E_PORT}".`);
}

if (!adminEmail || !adminPassword) {
  fail("KINGLET_E2E_ADMIN_EMAIL and KINGLET_E2E_ADMIN_PASSWORD must be set.");
}

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const serverStatePath = path.join(stateDir, "server.json");

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function cleanPreviousRun() {
  let previous = null;

  try {
    previous = JSON.parse(fs.readFileSync(serverStatePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[e2e] could not read the previous server state: ${error.message}`);
    }
  }

  if (previous && (processAlive(previous.scriptPid) || processAlive(previous.apiPid))) {
    fail("another E2E server is still running; stop it or choose another KINGLET_E2E_PORT.");
  }

  if (previous && previous.tempDir && fs.existsSync(previous.tempDir)) {
    fs.rmSync(previous.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  fs.rmSync(serverStatePath, { force: true });
}

cleanPreviousRun();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kinglet-e2e-"));
const dataDir = path.join(tempDir, "data");
const dbPath = path.join(dataDir, "kinglet.db");

fs.mkdirSync(dataDir, { recursive: true });

function apiEnvironment() {
  const env = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;

    if (key.startsWith("KINGLET_")) continue;

    if (key === "BETTER_AUTH_SECRET") continue;

    env[key] = value;
  }

  Object.assign(env, {
    KINGLET_DB_PATH: dbPath,
    KINGLET_PORT: String(port),
    KINGLET_HOST: "127.0.0.1",
    KINGLET_BASE_URL: baseURL,
    KINGLET_ADMIN_EMAIL: adminEmail,
    KINGLET_ADMIN_PASSWORD: adminPassword,
    KINGLET_TIMEZONE: "UTC",
    KINGLET_RETENTION_DAYS: "14",
    KINGLET_ALERT_RETENTION_DAYS: "90",
    KINGLET_MAX_DB_MB: "256",
    KINGLET_MAX_PROJECT_DB_MB: "128",
    KINGLET_MAX_EVENTS_PER_PROJECT: "10000",
    KINGLET_SESSION_DAYS: "1",
    BETTER_AUTH_SECRET: "e2e-only-secret-not-used-in-production-000000000000",
    NODE_ENV: "test",
  });

  return env;
}

const api = spawn(process.execPath, [apiEntry], {
  cwd: repoRoot,
  env: apiEnvironment(),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

function pipeLines(stream, prefix, sink) {
  let buffered = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);

    buffered = lines.pop() ?? "";

    for (const line of lines) sink(`${prefix}${line}\n`);
  });
}

pipeLines(api.stdout, "[e2e-api] ", (line) => process.stdout.write(line));

pipeLines(api.stderr, "[e2e-api] ", (line) => process.stderr.write(line));

let shuttingDown = false;

async function waitForChildExit(timeoutMs) {
  if (api.exitCode !== null) return;

  await new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;

      settled = true;
      resolve();
    }, timeoutMs);

    timer.unref();

    api.once("exit", () => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });

  if (api.exitCode === null) api.kill("SIGKILL");
}

async function cleanup(exitCode) {
  if (shuttingDown) return;

  shuttingDown = true;

  if (api.exitCode === null) {
    api.kill();
    await waitForChildExit(5_000);
  }

  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(`[e2e] could not remove ${tempDir}: ${error.message}`);
  }

  fs.rmSync(serverStatePath, { force: true });
  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void cleanup(0);
});

process.on("SIGTERM", () => {
  void cleanup(0);
});

api.on("exit", (code, signal) => {
  if (shuttingDown) return;

  console.error(`[e2e] the API exited early (code=${code}, signal=${signal}).`);
  void cleanup(code ?? 1);
});

async function waitForHealth() {
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    if (api.exitCode !== null) {
      throw new Error(`the API exited with code ${api.exitCode} before /healthz responded`);
    }

    try {
      const response = await fetch(`${baseURL}/healthz`);

      if (response.ok) return;
    } catch {
      // Still booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("timed out waiting for /healthz");
}

try {
  await waitForHealth();
} catch (error) {
  console.error(`[e2e] ${error.message}`);
  await cleanup(1);
}

fs.writeFileSync(
  serverStatePath,
  JSON.stringify(
    {
      scriptPid: process.pid,
      apiPid: api.pid,
      tempDir,
      dbPath,
      port,
      baseURL,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);

console.log(`[e2e] Kinglet API ready at ${baseURL} (database in ${tempDir})`);
