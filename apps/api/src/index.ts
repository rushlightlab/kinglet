import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { authMiddleware, sha256hex } from "./auth.js";
import { loadConfig } from "./env.js";
import type { Config } from "./env.js";
import { startMonitorEngine } from "./monitors.js";
import type { MonitorEngine } from "./monitors.js";
import { startRetentionJob } from "./retention.js";
import { registerRoutes } from "./routes.js";
import { createStorage } from "./storage/index.js";
import type { Storage } from "./storage/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = loadConfig();
const storage = await createStorage({
  kind: config.storageKind,
  dbPath: config.dbPath,
  authToken: config.dbAuthToken,
});
const tokenHashes = new Set(config.tokens.map((t) => sha256hex(t)));

// First boot with no KINGLET_TOKENS: keep a copy of the generated token next
// to a local database so `cat kinglet.token` always works. Remote stores
// (Turso) only get the console banner.
if (config.generatedToken && !isRemoteDbPath(config.dbPath)) {
  try {
    fs.writeFileSync(path.join(config.dataDir, "kinglet.token"), config.generatedToken + "\n");
  } catch (err) {
    console.warn("[kinglet] could not write kinglet.token:", err);
  }
}

function isRemoteDbPath(dbPath: string): boolean {
  return /^(libsql:\/\/|https?:\/\/|wss?:\/\/)/i.test(dbPath);
}

const app = new Hono();

app.onError((err, c) => {
  console.error("[kinglet] unhandled error:", err);
  return c.json({ error: "internal server error" }, 500);
});

app.get("/healthz", (c) => c.json({ ok: true, name: "kinglet", version: "0.1.0" }));
app.use("/v1/*", authMiddleware(tokenHashes));

const engine: MonitorEngine = startMonitorEngine(storage, { baseUrl: config.baseUrl });
registerRoutes(app, storage, engine);
registerStaticUi(app);

const server = serve({ fetch: app.fetch, port: config.port }, () => printBanner(config, storage));
startRetentionJob(storage, config.retentionDays);

const shutdown = (): void => {
  console.log("[kinglet] shutting down…");
  server.close();
  void storage.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/** Serves the built web UI from ../web/dist (single-container deploy). */
function registerStaticUi(app: Hono): void {
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

function printBanner(config: Config, storage: Storage): void {
  const uiBuilt = fs.existsSync(path.resolve(__dirname, "../../web/dist"));
  console.log("");
  console.log("  👑 Kinglet — small. light. king.");
  console.log("");
  console.log(`  API listening → http://localhost:${config.port}`);
  console.log(`  Ingest        → POST /v1/events   (Authorization: Bearer <token>)`);
  if (uiBuilt) console.log(`  UI            → http://localhost:${config.port}`);
  else console.log(`  UI            → not built; run "pnpm --filter @kinglet/web dev"`);
  console.log(`  Storage       → ${storage.description}`);
  if (config.generatedToken) {
    console.log(`  Token (auto)  → ${config.generatedToken}`);
    if (!isRemoteDbPath(config.dbPath)) {
      console.log(`                  also written to ${path.join(config.dataDir, "kinglet.token")}`);
    }
  } else {
    console.log(`  Tokens        → from KINGLET_TOKENS env`);
  }
  console.log("");
}
