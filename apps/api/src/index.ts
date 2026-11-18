import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { authMiddleware, sha256hex } from "./auth.js";
import { openDb } from "./db.js";
import { loadConfig } from "./env.js";
import { startRetentionJob } from "./retention.js";
import { registerRoutes } from "./routes.js";
import type { Config } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = loadConfig();
const db = openDb(config.dbPath);
const tokenHashes = new Set(config.tokens.map((t) => sha256hex(t)));

// First boot with no KINGLET_TOKENS: keep a copy of the generated token
// next to the database so `cat kinglet.token` always works.
if (config.generatedToken) {
  try {
    fs.writeFileSync(path.join(config.dataDir, "kinglet.token"), config.generatedToken + "\n");
  } catch (err) {
    console.warn("[kinglet] could not write kinglet.token:", err);
  }
}

const app = new Hono();

app.onError((err, c) => {
  console.error("[kinglet] unhandled error:", err);
  return c.json({ error: "internal server error" }, 500);
});

app.get("/healthz", (c) => c.json({ ok: true, name: "kinglet", version: "0.1.0" }));
app.use("/v1/*", authMiddleware(tokenHashes));
registerRoutes(app, db);
registerStaticUi(app);

serve({ fetch: app.fetch, port: config.port }, () => printBanner(config));
startRetentionJob(db, config.retentionDays);

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

function printBanner(config: Config): void {
  const uiBuilt = fs.existsSync(path.resolve(__dirname, "../../web/dist"));
  console.log("");
  console.log("  👑 Kinglet — small. light. king.");
  console.log("");
  console.log(`  API listening → http://localhost:${config.port}`);
  console.log(`  Ingest        → POST /v1/events   (Authorization: Bearer <token>)`);
  if (uiBuilt) console.log(`  UI            → http://localhost:${config.port}`);
  else console.log(`  UI            → not built; run "pnpm --filter @kinglet/web dev"`);
  console.log(`  Database      → ${path.resolve(config.dbPath)}`);
  if (config.generatedToken) {
    console.log(`  Token (auto)  → ${config.generatedToken}`);
    console.log(`                  also written to ${path.join(config.dataDir, "kinglet.token")}`);
  } else {
    console.log(`  Tokens        → from KINGLET_TOKENS env`);
  }
  console.log("");
}
