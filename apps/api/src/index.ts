import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { createAuth } from "./auth/auth.js";
import { authMiddleware } from "./auth/middleware.js";
import type { AppEnv } from "./auth/middleware.js";
import { passwordProblem } from "./auth/password.js";
import { ensureBootstrapAdmin, ensureSchemaExtras } from "./auth/setup.js";
import { loadConfig } from "./env.js";
import type { Config } from "./env.js";
import { startMonitorEngine } from "./monitors.js";
import type { MonitorEngine } from "./monitors.js";
import { startRetentionJob } from "./retention.js";
import { registerRoutes } from "./routes.js";
import * as schema from "./storage/schema.js";
import { createStorage } from "./storage/index.js";
import type { Storage } from "./storage/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Secret files (token, admin password, auth secret) and the database should
// not be world-readable by default.
process.umask(0o077);

// A stray rejected promise must never take the log platform down.
process.on("unhandledRejection", (reason) => {
  console.error("[kinglet] unhandled promise rejection:", reason);
});

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = await createStorage({
    kind: config.storageKind,
    dbPath: config.dbPath,
    authToken: config.dbAuthToken,
  });
  await ensureSchemaExtras(storage);

  const auth = createAuth(storage.db, {
    baseUrl: config.baseUrl,
    port: config.port,
    secret: config.authSecret,
    trustedProxies: config.trustedProxies,
    sessionDays: config.sessionDays,
  });
  const bootstrap = await ensureBootstrapAdmin(storage, config, auth);

  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.status >= 500) {
        console.error(`[kinglet] ${c.req.method} ${c.req.path} failed:`, err);
      }
      return c.json({ error: err.message || "request failed" }, err.status);
    }
    const requestId = randomUUID();
    console.error(
      `[kinglet] ${c.req.method} ${c.req.path} failed (request ${requestId}):`,
      err instanceof Error ? (err.stack ?? err.message) : err
    );
    c.header("x-request-id", requestId);
    return c.json({ error: "internal server error", requestId }, 500);
  });

  app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));

  // Small JSON bodies everywhere except ingest; auth endpoints are public.
  const smallJsonLimit = bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ error: "payload too large (max 256 KiB)" }, 413),
  });
  app.use("/api/auth/*", smallJsonLimit);

  // Better Auth rate limits by client IP. When no reverse proxy is trusted,
  // derive the IP from the socket ourselves so a client-supplied
  // X-Forwarded-For cannot rotate around the limit.
  if (config.trustedProxies.length === 0) {
    app.use("/api/auth/*", async (c, next) => {
      const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
      const address = env?.incoming?.socket?.remoteAddress;
      if (address) c.req.raw.headers.set("x-kinglet-client-ip", address);
      await next();
    });
  }

  // CSRF guard for cookie-authenticated mutations. Sibling subdomains are
  // same-site (SameSite=Lax does not help), so require either a Bearer token
  // or the same-origin request marker that cross-site forms cannot send.
  const allowedOrigins = (() => {
    const origins = new Set<string>();
    try {
      origins.add(new URL(config.baseUrl ?? `http://localhost:${config.port}`).origin);
    } catch {
      // ignore invalid base URL
    }
    for (const host of ["localhost", "127.0.0.1"]) {
      for (const port of [3000, 5173, 8080]) origins.add(`http://${host}:${port}`);
    }
    return origins;
  })();
  app.use("/v1/*", async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    const hasBearer = (c.req.header("authorization") ?? "").toLowerCase().startsWith("bearer ");
    if (hasBearer) return next();
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins.has(origin)) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }
    if (c.req.header("x-kinglet-request") !== "1") {
      return c.json({ error: "missing X-Kinglet-Request header (CSRF guard)" }, 403);
    }
    await next();
  });

  app.use("/v1/monitors/*", smallJsonLimit);
  app.use("/v1/users/*", smallJsonLimit);
  app.use("/v1/projects/*", smallJsonLimit);
  app.use("/v1/keys/*", smallJsonLimit);
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    c.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    const path = c.req.path;
    if (path.startsWith("/v1/") || path.startsWith("/api/auth/")) {
      c.header("cache-control", "no-store");
    }
  });

  app.get("/healthz", async (c) => {
    let databaseOk = true;
    try {
      await storage.db.select({ id: schema.projects.id }).from(schema.projects).limit(1);
    } catch {
      databaseOk = false;
    }
    // Public endpoint: minimal surface. Diagnostics live behind /v1/system/status.
    return c.json({ ok: databaseOk, version: "0.3.0" }, databaseOk ? 200 : 503);
  });

  // Better Auth owns /api/auth/* (sign-in, sign-out, session, password).
  // Public self-signup is closed: accounts are created by administrators.
  app.post("/api/auth/sign-up/*", (c) =>
    c.json({ error: "sign-up is disabled — an administrator creates accounts" }, 403)
  );
  // Better Auth enforces length; this adds the complexity rules before the
  // change-password handler consumes the body.
  app.use("/api/auth/change-password", async (c, next) => {
    if (c.req.method !== "POST") {
      await next();
      return;
    }
    const body = (await c.req.raw
      .clone()
      .json()
      .catch(() => null)) as { newPassword?: unknown } | null;
    if (body && typeof body.newPassword === "string") {
      const problem = passwordProblem(body.newPassword);
      if (problem) return c.json({ error: problem }, 400);
    }
    await next();
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.use("/v1/*", authMiddleware(storage, auth));

  const engine: MonitorEngine = startMonitorEngine(storage, {
    baseUrl: config.baseUrl,
    allowPrivateWebhooks: config.allowPrivateWebhooks,
  });
  registerRoutes(app, storage, engine, config, auth);
  registerStaticUi(app);

  const server = serve({ fetch: app.fetch, port: config.port }, () =>
    printBanner(config, storage, bootstrap)
  );
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error("");
    console.error(`  ✖ Kinglet could not listen on port ${config.port}: ${err.message}`);
    console.error("    Is another process using that port? Set KINGLET_PORT to change it.");
    console.error("");
    void storage.close().finally(() => process.exit(1));
  });
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
  const apiNotFound = (c: { json: (body: unknown, status: 404) => Response }, pathname: string): Response =>
    c.json({ error: "not found", path: pathname }, 404);

  if (!fs.existsSync(webDist)) {
    app.get("*", (c) => {
      const pathname = new URL(c.req.url).pathname;
      if (pathname === "/v1" || pathname.startsWith("/v1/")) return apiNotFound(c, pathname);
      return c.json({
        name: "kinglet",
        message: 'UI not built. Run "pnpm --filter @kinglet/web dev" for the dev UI, or build with "pnpm run build".',
      });
    });
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
    // Never let SPA fallback shadow API routes with HTML.
    if (pathname === "/v1" || pathname.startsWith("/v1/")) return apiNotFound(c, pathname);
    if (pathname.includes("..")) return c.notFound();
    let filePath = path.join(webDist, pathname.replace(/^\/+/, ""));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath)) filePath = path.join(webDist, "index.html"); // SPA fallback
    if (!fs.existsSync(filePath)) return c.notFound();
    const body = fs.readFileSync(filePath);
    const headers: Record<string, string> = {
      "content-type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
    };
    // Hashed build assets never change; the HTML entrypoint must always be
    // revalidated so a new deploy cannot keep loading an old bundle.
    if (pathname.startsWith("/assets/")) {
      headers["cache-control"] = "public, max-age=31536000, immutable";
    } else {
      headers["cache-control"] = "no-cache";
    }
    return c.body(body, 200, headers);
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
  console.log(`  Ingest        → POST /v1/events   (project API key)`);
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
  console.log("");
}
