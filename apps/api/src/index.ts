import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { authMiddleware } from "./auth/middleware.js";
import type { AppEnv } from "./auth/middleware.js";
import { ensureBootstrapAdmin, ensureSchemaExtras } from "./auth/setup.js";
import { loadConfig } from "./env.js";
import type { Config } from "./env.js";
import { startMonitorEngine } from "./monitors.js";
import type { MonitorEngine } from "./monitors.js";
import { startRetentionJob } from "./retention.js";
import { registerRoutes } from "./routes.js";
import { createStorage } from "./storage/index.js";
import type { Storage } from "./storage/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = await createStorage({
    kind: config.storageKind,
    dbPath: config.dbPath,
    authToken: config.dbAuthToken,
  });
  await ensureSchemaExtras(storage);
  const bootstrap = await ensureBootstrapAdmin(storage, config);

  // First boot with no KINGLET_TOKENS: keep a copy of the generated legacy
  // token next to a local database so `cat kinglet.token` always works.
  if (config.generatedToken && !isRemoteDbPath(config.dbPath)) {
    try {
      fs.writeFileSync(path.join(config.dataDir, "kinglet.token"), config.generatedToken + "\n");
    } catch (err) {
      console.warn("[kinglet] could not write kinglet.token:", err);
    }
  }

  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    const requestId = randomUUID();
    console.error(
      `[kinglet] ${c.req.method} ${c.req.path} failed (request ${requestId}):`,
      err instanceof Error ? (err.stack ?? err.message) : err
    );
    c.header("x-request-id", requestId);
    return c.json({ error: "internal server error", requestId }, 500);
  });

  app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));

  app.get("/healthz", (c) => c.json({ ok: true, name: "kinglet", version: "0.2.0" }));
  app.use("/v1/*", authMiddleware(storage, config));

  const engine: MonitorEngine = startMonitorEngine(storage, { baseUrl: config.baseUrl });
  registerRoutes(app, storage, engine, config);
  registerStaticUi(app);

  const server = serve({ fetch: app.fetch, port: config.port }, () =>
    printBanner(config, storage, bootstrap)
  );
  startRetentionJob(storage, config.retentionDays);

  const shutdown = (): void => {
    console.log("[kinglet] shutting down…");
    server.close();
    void storage.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error("");
  console.error("  ✖ Kinglet failed to start");
  console.error("");
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  console.error("");
  console.error("  If this is a database from an older Kinglet version, back it up and");
  console.error("  start Kinglet again — schema migrations run automatically on boot.");
  process.exit(1);
});

function isRemoteDbPath(dbPath: string): boolean {
  return /^(libsql:\/\/|https?:\/\/|wss?:\/\/)/i.test(dbPath);
}

/** Serves the built web UI from ../web/dist (single-container deploy). */
function registerStaticUi(app: Hono<AppEnv>): void {
  const webDist = path.resolve(__dirname, "../../web/dist");
  if (!fs.existsSync(webDist)) {
    app.get("*", (c) =>
      c.json({
        name: "kinglet",
        message: 'UI not built. Run "pnpm --filter @kinglet/web dev" for the dev UI, or build with "pnpm run build".',
      })
    );
    return;
  }
  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".txt": "text/plain; charset=utf-8",
  };
  app.get("*", (c) => {
    let pathname = "/";
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.notFound();
    }
    if (pathname.includes("..")) return c.notFound();
    let filePath = path.join(webDist, pathname.replace(/^\/+/, ""));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath)) filePath = path.join(webDist, "index.html"); // SPA fallback
    if (!fs.existsSync(filePath)) return c.notFound();
    const body = fs.readFileSync(filePath);
    return c.body(body, 200, {
      "content-type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
    });
  });
}

function printBanner(
  config: Config,
  storage: Storage,
  bootstrap: { adminEmail: string; generatedPassword: string | null } | null
): void {
  const uiBuilt = fs.existsSync(path.resolve(__dirname, "../../web/dist"));
  console.log("");
  console.log("  👑 Kinglet — small. light. king.");
  console.log("");
  console.log(`  API listening → http://localhost:${config.port}`);
  console.log(`  Ingest        → POST /v1/events   (API key or legacy token)`);
  if (uiBuilt) console.log(`  UI            → http://localhost:${config.port}`);
  else console.log(`  UI            → not built; run "pnpm --filter @kinglet/web dev"`);
  console.log(`  Storage       → ${storage.description}`);
  if (bootstrap) {
    console.log(`  Admin         → ${bootstrap.adminEmail}`);
    if (bootstrap.generatedPassword) {
      console.log(`  Admin password→ ${bootstrap.generatedPassword}`);
      if (!isRemoteDbPath(config.dbPath)) {
        console.log(`                  also written to ${path.join(config.dataDir, "admin-password.txt")}`);
      }
    }
  }
  if (config.generatedToken) {
    console.log(`  Token (legacy)→ ${config.generatedToken}`);
    if (!isRemoteDbPath(config.dbPath)) {
      console.log(`                  also written to ${path.join(config.dataDir, "kinglet.token")}`);
    }
  } else if (config.savedToken) {
    console.log(`  Token (legacy)→ ${config.savedToken}`);
    console.log(`                  restored from ${path.join(config.dataDir, "kinglet.token")}`);
  } else {
    console.log(`  Tokens        → from KINGLET_TOKENS env (legacy)`);
  }
  console.log("");
}
