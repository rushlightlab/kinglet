import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { E2E_DIR, SEED_PATH, SERVER_STATE_PATH } from "./support/state";

interface ServerState {
  tempDir?: string;
  apiPid?: number;
  scriptPid?: number;
}

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });

    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Playwright force-kills the webServer process on Windows, so the server
 * script cannot always run its own cleanup. Global teardown stops the API and
 * removes the temporary database directory instead.
 */
export default async function globalTeardown(): Promise<void> {
  let state: ServerState | null = null;

  try {
    const raw = fs.readFileSync(SERVER_STATE_PATH, "utf8");

    state = JSON.parse(raw);
  } catch {
    state = null;
  }

  if (state?.scriptPid !== undefined) {
    killProcessTree(state.scriptPid);
  } else if (state?.apiPid !== undefined) {
    killProcessTree(state.apiPid);
  }

  if (state?.scriptPid !== undefined) {
    await waitForExit(state.scriptPid, 5_000);
  }

  if (state?.apiPid !== undefined) {
    await waitForExit(state.apiPid, 5_000);
  }

  if (state?.tempDir !== undefined) {
    fs.rmSync(state.tempDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }

  fs.rmSync(SEED_PATH, { force: true });
  fs.rmSync(E2E_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
