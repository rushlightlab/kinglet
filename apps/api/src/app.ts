import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { authMiddleware } from "./auth/middleware.ts";
import type { AppEnv } from "./auth/middleware.ts";
import type { KingletAuth } from "./auth/auth.ts";
import { passwordProblem } from "./auth/password.ts";
import type { Config } from "./env.ts";
import type { ArchiveEngine } from "./archive/engine.ts";
import { registerArchiveRoutes } from "./archive/routes.ts";
import type { BackupEngine } from "./backups/engine.ts";
import { registerBackupRoutes } from "./backups/routes.ts";
import type { BackupObjectStore } from "./backups/s3.ts";
import type { MonitorEngine } from "./monitors.ts";
import type { NotificationEngine } from "./notifications/engine.ts";
import { registerNotificationRoutes } from "./notifications/routes.ts";
import { readRestoreMarker, restorePaths } from "./restore/marker.ts";
import { registerRestoreRoutes } from "./restore/routes.ts";
import { maintenanceState } from "./restore/state.ts";
import { registerSystemEventsRoute } from "./system-routes.ts";
import { registerRoutes } from "./routes.ts";
import { APP_VERSION } from "./version.ts";
import { isJsonObject, isString } from "./json.ts";
import type { JsonValue } from "./json.ts";
import * as schema from "./storage/schema.ts";
import type { Storage } from "./storage/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Long-lived engines the HTTP app delegates to. Created and owned by `main()`. */
export interface AppEngines {
  monitor: MonitorEngine;
  notification: NotificationEngine;
  backup: BackupEngine;
  archive: ArchiveEngine;
}

export interface CreateAppOptions {
  storage: Storage;
  config: Config;
  auth: KingletAuth;
  engines: AppEngines;
  /** Serve the built web UI from ../web/dist when it exists (production boot). */
  staticUi?: boolean;
  /**
   * Called after a restore is staged. Production exits so a supervisor can
   * restart into the swap; tests and embedders can leave it undefined.
   */
  onRestoreStaged?: () => void;
  /**
   * Test/embedding seam for archived-object cleanup on project deletion and
   * all-time clear. Production leaves it undefined.
   */
  deleteArchivedObjects?: (config: Config, projectId: string) => Promise<number>;
  /**
   * Test/embedding seam for restore staging. Production leaves it undefined so
   * staging constructs and destroys its own S3 adapter.
   */
  restoreStore?: BackupObjectStore;
}

/**
 * Builds the complete HTTP application without starting timers, engines, or a
 * listener. `main()` owns boot sequencing and the background engines; tests
 * pass real storage/auth with no-op engines.
 */
export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const { storage, config, auth, engines } = options;
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
      err instanceof Error ? (err.stack ?? err.message) : err,
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
      const address = remoteAddressFromEnv(c.env);

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
        "connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    const requestPath = c.req.path;

    if (requestPath.startsWith("/v1/") || requestPath.startsWith("/api/auth/")) {
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
    return c.json({ ok: databaseOk, version: APP_VERSION }, databaseOk ? 200 : 503);
  });

  // Better Auth owns /api/auth/* (sign-in, sign-out, session, password).
  // Public self-signup is closed: accounts are created by administrators.
  app.post("/api/auth/sign-up/*", (c) =>
    c.json({ error: "sign-up is disabled — an administrator creates accounts" }, 403),
  );
  // Better Auth enforces length; this adds the complexity rules before the
  // change-password handler consumes the body.
  app.use("/api/auth/change-password", async (c, next) => {
    if (c.req.method !== "POST") {
      await next();

      return;
    }

    const body = await c.req.raw
      .clone()
      .json()
      .catch(() => null);

    if (isJsonObject(body) && isString(body.newPassword)) {
      const problem = passwordProblem(body.newPassword);

      if (problem) return c.json({ error: problem }, 400);
    }

    await next();
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.use("/v1/*", authMiddleware(storage, auth));
  app.use("/v1/*", async (c, next) => {
    const maintenance = maintenanceState();
    const method = c.req.method;

    if (maintenance.active && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      c.header("retry-after", "30");

      return c.json({ error: "restore staged — restart Kinglet to apply" }, 503);
    }

    await next();
  });

  registerRoutes(app, storage, engines.monitor, config, auth, {
    backupStatus: () => engines.backup.status(),
    deleteArchivedObjects: options.deleteArchivedObjects,
  });
  registerNotificationRoutes(app, {
    storage,
    config,
    engine: engines.notification,
    refreshMonitors: () => engines.monitor.refresh(),
  });
  registerBackupRoutes(app, { storage, config, engine: engines.backup });
  registerArchiveRoutes(app, { storage, config, engine: engines.archive });
  registerRestoreRoutes(app, {
    storage,
    config,
    onStaged: options.onRestoreStaged,
    restoreStore: options.restoreStore,
  });
  registerSystemEventsRoute(app, {
    auth,
    getStatus: async () => {
      const [status, archive, pendingRestore] = await Promise.all([
        engines.backup.status(),
        engines.archive.status(),
        readRestoreMarker(restorePaths(config.dataDir).pendingPath),
      ]);

      return {
        backup: {
          configured: status.configured,
          enabled: status.enabled,
          running: status.running,
          phase: status.phase,
          lastSuccessAt: status.lastSuccessAt,
          lastFailureAt: status.lastFailureAt,
          nextRunAt: status.nextRunAt,
          lastError: status.lastError,
          databaseBytes: status.databaseBytes,
          setupMissing: status.setupMissing,
          restoreStagedId: pendingRestore.kind === "ok" ? pendingRestore.marker.snapshotId : null,
        },
        archive: {
          enabled: archive.enabled,
          running: archive.running,
          lastRunAt: archive.lastRunAt,
          lastError: archive.lastError,
        },
      };
    },
  });

  if (options.staticUi !== false) registerStaticUi(app);

  return app;
}

function remoteAddressFromEnv<T>(env: T): string | undefined {
  if (!isJsonObject(env)) return undefined;

  const incoming = env.incoming;

  if (!isJsonObject(incoming)) return undefined;

  const socket = incoming.socket;

  if (!isJsonObject(socket)) return undefined;

  return isString(socket.remoteAddress) ? socket.remoteAddress : undefined;
}

function apiNotFound(
  c: { json: (body: JsonValue, status: 404) => Response },
  pathname: string,
): Response {
  return c.json({ error: "not found", path: pathname }, 404);
}

/** Serves the built web UI from ../web/dist (single-container deploy). */
function registerStaticUi(app: Hono<AppEnv>): void {
  const webDist = path.resolve(__dirname, "../../web/dist");

  if (!fs.existsSync(webDist)) {
    app.get("*", (c) => {
      const pathname = new URL(c.req.url).pathname;

      if (pathname === "/v1" || pathname.startsWith("/v1/")) return apiNotFound(c, pathname);

      return c.json({
        name: "kinglet",
        message:
          'UI not built. Run "pnpm --filter @kinglet/web dev" for the dev UI, or build with "pnpm run build".',
      });
    });

    return;
  }

  const mimeTypes = new Map<string, string>([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".json", "application/json"],
    [".png", "image/png"],
    [".ico", "image/x-icon"],
    [".map", "application/json"],
    [".woff2", "font/woff2"],
    [".woff", "font/woff"],
    [".txt", "text/plain; charset=utf-8"],
  ]);

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

    c.header("content-type", mimeTypes.get(path.extname(filePath)) ?? "application/octet-stream");

    // Hashed build assets never change; the HTML entrypoint must always be
    // revalidated so a new deploy cannot keep loading an old bundle.
    if (pathname.startsWith("/assets/")) {
      c.header("cache-control", "public, max-age=31536000, immutable");
    } else {
      c.header("cache-control", "no-cache");
    }

    return c.body(body);
  });
}
