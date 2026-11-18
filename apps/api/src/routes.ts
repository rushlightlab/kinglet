import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { Config } from "./env.js";
import { createApiKey, deleteApiKey, listApiKeys } from "./auth/apikeys.js";
import {
  SESSION_COOKIE,
  can,
  getAuth,
  projectExists,
  requirePermission,
  requireUser,
  resolveProjectId,
} from "./auth/middleware.js";
import type { AppEnv } from "./auth/middleware.js";
import { generatePassword, hashPassword, verifyPassword } from "./auth/passwords.js";
import { KEY_SCOPES, isKeyScope, isRole, permissionsForRole } from "./auth/roles.js";
import type { KeyScope, Role } from "./auth/roles.js";
import {
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  deleteUser,
  getUser,
  getUserWithHash,
  listUsers,
  updateUser,
} from "./auth/users.js";
import { publishEvents, subscribeEvents } from "./bus.js";
import { buildWhere, matchesEvent, parseFilters } from "./filters.js";
import type { Normalized } from "./ingest.js";
import { normalizeEvent } from "./ingest.js";
import type { MonitorEngine } from "./monitors.js";
import {
  createMonitorFromRaw,
  deleteMonitor,
  getMonitor,
  listAlerts,
  listMonitors,
  updateMonitorFromRaw,
} from "./monitors.js";
import { sendNotice } from "./notify.js";
import type { AlertNotice } from "./notify.js";
import type { Storage } from "./storage/index.js";
import { toClientEvent } from "./types.js";

const MAX_BATCH = 10000;

// ---------- small helpers ----------

function parseTimestamp(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseId(raw: string): number | null {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isHttps(c: Context<AppEnv>): boolean {
  if (c.req.header("x-forwarded-proto") === "https") return true;
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function setSessionCookie(c: Context<AppEnv>, token: string, sessionDays: number): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: sessionDays * 86_400,
    secure: isHttps(c),
  });
}

/** Simple in-memory login throttle: 10 attempts / 5 minutes per IP. */
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
function allowLogin(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60_000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

function clientIp(c: Context<AppEnv>): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function uniqueSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "project"
  );
}

// ---------- routes ----------

export function registerRoutes(
  app: Hono<AppEnv>,
  storage: Storage,
  engine: MonitorEngine,
  config: Config
): void {
  // ================= auth =================

  app.post("/v1/auth/login", async (c) => {
    if (!allowLogin(clientIp(c))) return c.json({ error: "too many attempts, try again later" }, 429);
    const body = await readJson(c);
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email || !password) return c.json({ error: "email and password are required" }, 400);

    const found = await getUserWithHash(storage, email);
    if (!found || !verifyPassword(password, found.passwordHash)) {
      return c.json({ error: "invalid email or password" }, 401);
    }
    if (Math.random() < 0.05) void deleteExpiredSessions(storage);
    const token = await createSession(storage, found.user.id, config.sessionDays);
    setSessionCookie(c, token, config.sessionDays);
    return c.json({
      user: found.user,
      permissions: permissionsForRole(found.user.role as Role),
    });
  });

  app.post("/v1/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(storage, token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/v1/me", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    return c.json({ user, permissions: permissionsForRole(user.role as Role) });
  });

  app.patch("/v1/me/password", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const body = await readJson(c);
    const current = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    const next = typeof body?.newPassword === "string" ? body.newPassword : "";
    if (next.length < 8) return c.json({ error: "new password must be at least 8 characters" }, 400);
    const found = await getUserWithHash(storage, user.email);
    if (!found || !verifyPassword(current, found.passwordHash)) {
      return c.json({ error: "current password is incorrect" }, 401);
    }
    await updateUser(storage, user.id, { passwordHash: hashPassword(next) });
    return c.json({ ok: true });
  });

  // ================= projects =================

  app.get("/v1/projects", async (c) => {
    const auth = getAuth(c);
    if (auth.kind === "key") return c.json({ error: "user session required" }, 403);
    const rows = await storage.sql.all("SELECT id, name, slug, created_at FROM projects ORDER BY id ASC");
    return c.json({
      projects: rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        slug: String(r.slug),
        createdAt: Number(r.created_at ?? 0),
      })),
    });
  });

  app.post("/v1/projects", async (c) => {
    const denied = requirePermission(c, "projects.write");
    if (denied) return denied;
    const body = await readJson(c);
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 64) : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    const base = uniqueSlug(name);
    let slug = base;
    for (let i = 2; ; i++) {
      const clash = await storage.sql.all("SELECT id FROM projects WHERE slug = ?", [slug]);
      if (clash.length === 0) break;
      slug = `${base}-${i}`;
    }
    const now = Date.now();
    const info = await storage.sql.run("INSERT INTO projects (name, slug, created_at) VALUES (?, ?, ?)", [
      name,
      slug,
      now,
    ]);
    return c.json({ project: { id: info.lastInsertRowid ?? 0, name, slug, createdAt: now } }, 201);
  });

  app.delete("/v1/projects/:id", async (c) => {
    const denied = requirePermission(c, "projects.write");
    if (denied) return denied;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid project id" }, 400);
    const rows = await storage.sql.all("SELECT COUNT(*) AS n FROM projects");
    if (Number(rows[0]?.n ?? 0) <= 1) return c.json({ error: "cannot delete the last project" }, 400);
    if (!(await projectExists(storage, id))) return c.json({ error: "project not found" }, 404);
    await storage.sql.run(
      "DELETE FROM alerts WHERE monitor_id IN (SELECT id FROM monitors WHERE project_id = ?)",
      [id]
    );
    await storage.sql.run("DELETE FROM monitors WHERE project_id = ?", [id]);
    await storage.sql.run("DELETE FROM events WHERE project_id = ?", [id]);
    await storage.sql.run("DELETE FROM api_keys WHERE project_id = ?", [id]);
    await storage.sql.run("DELETE FROM projects WHERE id = ?", [id]);
    await engine.refresh();
    return c.json({ ok: true });
  });

  // ================= users (admin) =================

  app.get("/v1/users", async (c) => {
    const denied = requirePermission(c, "users.read");
    if (denied) return denied;
    return c.json({ users: await listUsers(storage) });
  });

  app.post("/v1/users", async (c) => {
    const denied = requirePermission(c, "users.write");
    if (denied) return denied;
    const body = await readJson(c);
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "a valid email is required" }, 400);
    if (await getUserWithHash(storage, email)) return c.json({ error: "a user with that email already exists" }, 409);
    const role: Role = isRole(body?.role) ? body.role : "member";
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
    const provided = typeof body?.password === "string" && body.password.length > 0 ? body.password : null;
    if (provided !== null && provided.length < 8) {
      return c.json({ error: "password must be at least 8 characters" }, 400);
    }
    const password = provided ?? generatePassword();
    const user = await createUser(storage, { email, name, role, passwordHash: hashPassword(password) });
    return c.json({ user, ...(provided === null ? { password } : {}) }, 201);
  });

  app.patch("/v1/users/:id", async (c) => {
    const denied = requirePermission(c, "users.write");
    if (denied) return denied;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid user id" }, 400);
    const target = await getUser(storage, id);
    if (!target) return c.json({ error: "user not found" }, 404);
    const body = await readJson(c);

    let role: Role | undefined;
    if (body?.role !== undefined) {
      if (!isRole(body.role)) return c.json({ error: "invalid role" }, 400);
      role = body.role;
    }
    if (target.role === "admin" && role !== undefined && role !== "admin") {
      const rows = await storage.sql.all("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
      if (Number(rows[0]?.n ?? 0) <= 1) return c.json({ error: "cannot demote the last administrator" }, 400);
    }
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : undefined;
    let passwordHash: string | undefined;
    if (typeof body?.password === "string" && body.password.length > 0) {
      if (body.password.length < 8) return c.json({ error: "password must be at least 8 characters" }, 400);
      passwordHash = hashPassword(body.password);
    }
    const user = await updateUser(storage, id, { name, role, passwordHash });
    return c.json({ user });
  });

  app.delete("/v1/users/:id", async (c) => {
    const denied = requirePermission(c, "users.write");
    if (denied) return denied;
    const me = requireUser(c);
    if (me instanceof Response) return me;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid user id" }, 400);
    if (id === me.id) return c.json({ error: "you cannot delete your own account" }, 400);
    const target = await getUser(storage, id);
    if (!target) return c.json({ error: "user not found" }, 404);
    if (target.role === "admin") return c.json({ error: "administrators cannot be deleted" }, 400);
    await deleteUser(storage, id);
    return c.json({ ok: true });
  });

  // ================= API keys =================

  app.get("/v1/projects/:id/keys", async (c) => {
    const denied = requirePermission(c, "keys.read");
    if (denied) return denied;
    const projectId = parseId(c.req.param("id"));
    if (projectId === null) return c.json({ error: "invalid project id" }, 400);
    if (!(await projectExists(storage, projectId))) return c.json({ error: "project not found" }, 404);
    return c.json({ keys: await listApiKeys(storage, projectId) });
  });

  app.post("/v1/projects/:id/keys", async (c) => {
    const denied = requirePermission(c, "keys.write");
    if (denied) return denied;
    const projectId = parseId(c.req.param("id"));
    if (projectId === null) return c.json({ error: "invalid project id" }, 400);
    if (!(await projectExists(storage, projectId))) return c.json({ error: "project not found" }, 404);
    const body = await readJson(c);
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    const rawScopes = Array.isArray(body?.scopes) ? body.scopes.filter(isKeyScope) : [];
    const scopes: KeyScope[] = rawScopes.length > 0 ? [...new Set(rawScopes)] : [...KEY_SCOPES];
    const me = getAuth(c);
    const createdBy = me.kind === "user" ? me.user.id : null;
    const created = await createApiKey(storage, { projectId, name, scopes, createdBy });
    return c.json(created, 201);
  });

  app.delete("/v1/keys/:id", async (c) => {
    const denied = requirePermission(c, "keys.write");
    if (denied) return denied;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid key id" }, 400);
    const projectRaw = c.req.query("project");
    const projectId = Math.trunc(Number(projectRaw));
    if (!Number.isFinite(projectId) || projectId <= 0) return c.json({ error: "project is required" }, 400);
    const deleted = await deleteApiKey(storage, id, projectId);
    if (!deleted) return c.json({ error: "key not found" }, 404);
    return c.json({ ok: true });
  });

  // ================= events =================

  app.post("/v1/events", bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    const auth = getAuth(c);
    if (auth.kind === "key" && !auth.scopes.has("ingest")) {
      return c.json({ error: "this key cannot ingest (missing ingest scope)" }, 403);
    }
    if (auth.kind === "user" && !can(auth, "logs.write")) return c.json({ error: "forbidden" }, 403);
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;

    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    const text = await c.req.text();
    const raws: unknown[] = [];
    let parseErrors = 0;

    if (contentType.includes("ndjson")) {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          raws.push(JSON.parse(trimmed));
        } catch {
          parseErrors++;
        }
      }
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      if (Array.isArray(parsed)) raws.push(...parsed);
      else if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { events?: unknown }).events))
        raws.push(...(parsed as { events: unknown[] }).events);
      else raws.push(parsed);
    }

    const truncated = raws.length > MAX_BATCH;
    if (truncated) raws.length = MAX_BATCH;

    const normalized: Normalized[] = [];
    const errors: string[] = [];
    for (const raw of raws) {
      const result = normalizeEvent(raw);
      if (result.ok) normalized.push(result.value);
      else errors.push(result.error);
    }

    const rows = await storage.insertEvents(projectId, normalized);
    publishEvents(rows);

    return c.json({
      accepted: rows.length,
      rejected: errors.length + parseErrors,
      ...(truncated ? { truncated: true } : {}),
      ...(errors.length > 0 ? { errors: errors.slice(0, 3) } : {}),
    });
  });

  app.get("/v1/events", async (c) => {
    const auth = getAuth(c);
    if (auth.kind === "key" && !auth.scopes.has("query")) {
      return c.json({ error: "this key cannot query (missing query scope)" }, 403);
    }
    if (auth.kind === "user" && !can(auth, "logs.read")) return c.json({ error: "forbidden" }, 403);
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;

    const q = c.req.query("q") ?? "";
    const now = Date.now();
    const from = parseTimestamp(c.req.query("from"), now - 3600_000);
    const to = parseTimestamp(c.req.query("to"), now);
    const limit = clampInt(c.req.query("limit"), 200, 1, 1000);
    const cursorRaw = Number(c.req.query("cursor"));
    const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;
    const where = buildWhere(parseFilters(q), { from, to }, projectId);
    const rows = await storage.queryEvents({ where: where.sql, params: where.params, limit, cursor });
    return c.json({
      events: rows.map(toClientEvent),
      nextCursor: rows.length === limit ? rows[rows.length - 1]?.id ?? null : null,
    });
  });

  app.get("/v1/histogram", async (c) => {
    const auth = getAuth(c);
    if (auth.kind === "key" && !auth.scopes.has("query")) return c.json({ error: "forbidden" }, 403);
    if (auth.kind === "user" && !can(auth, "logs.read")) return c.json({ error: "forbidden" }, 403);
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;
    const now = Date.now();
    const from = parseTimestamp(c.req.query("from"), now - 3600_000);
    const to = parseTimestamp(c.req.query("to"), now);
    const buckets = clampInt(c.req.query("buckets"), 60, 1, 240);
    const bucketMs = Math.max(1000, Math.trunc((to - from) / buckets));
    return c.json({ from, to, bucketMs, points: await storage.histogramPoints(projectId, from, to, bucketMs) });
  });

  app.get("/v1/services", async (c) => {
    const auth = getAuth(c);
    if (auth.kind === "key" && !auth.scopes.has("query")) return c.json({ error: "forbidden" }, 403);
    if (auth.kind === "user" && !can(auth, "logs.read")) return c.json({ error: "forbidden" }, 403);
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;
    return c.json({ services: await storage.listServices(projectId) });
  });

  app.get("/v1/stream", async (c) => {
    const auth = getAuth(c);
    if (auth.kind === "key" && !auth.scopes.has("query")) return c.json({ error: "forbidden" }, 403);
    if (auth.kind === "user" && !can(auth, "logs.read")) return c.json({ error: "forbidden" }, 403);
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;

    const q = c.req.query("q") ?? "";
    const f = parseFilters(q);
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribeEvents((rows) => {
        for (const row of rows) {
          if (row.projectId !== projectId) continue;
          if (!matchesEvent(f, row)) continue;
          void stream
            .writeSSE({ data: JSON.stringify(toClientEvent(row)) })
            .catch(() => undefined);
        }
      });
      const heartbeat = setInterval(() => {
        void stream.write(": ping\n").catch(() => undefined);
      }, 15000);
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
    });
  });

  // ================= monitors =================

  const monitorGuard = (c: Context<AppEnv>, write: boolean): Response | null => {
    const auth = getAuth(c);
    if (auth.kind === "legacy") return null;
    if (auth.kind === "key") return c.json({ error: "keys cannot manage monitors" }, 403);
    return can(auth, write ? "monitors.write" : "monitors.read") ? null : c.json({ error: "forbidden" }, 403);
  };

  app.get("/v1/monitors", async (c) => {
    const denied = monitorGuard(c, false);
    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;
    return c.json({ monitors: await listMonitors(storage, projectId) });
  });

  app.post("/v1/monitors", async (c) => {
    const denied = monitorGuard(c, true);
    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;
    const body = await readJson(c);
    const result = await createMonitorFromRaw(storage, projectId, body);
    if (!result.ok) return c.json({ error: result.error }, 400);
    await engine.refresh();
    return c.json({ monitor: result.monitor }, 201);
  });

  app.patch("/v1/monitors/:id", async (c) => {
    const denied = monitorGuard(c, true);
    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid monitor id" }, 400);
    const body = await readJson(c);
    const result = await updateMonitorFromRaw(storage, id, projectId, body);
    if (!result.ok) {
      const notFound = "notFound" in result && result.notFound === true;
      return c.json({ error: result.error }, notFound ? 404 : 400);
    }
    await engine.refresh();
    return c.json({ monitor: result.monitor });
  });

  app.delete("/v1/monitors/:id", async (c) => {
    const denied = monitorGuard(c, true);
    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid monitor id" }, 400);
    const deleted = await deleteMonitor(storage, id, projectId);
    if (!deleted) return c.json({ error: "monitor not found" }, 404);
    await engine.refresh();
    return c.json({ ok: true });
  });

  app.post("/v1/monitors/:id/test", async (c) => {
    const denied = monitorGuard(c, true);
    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid monitor id" }, 400);
    const monitor = await getMonitor(storage, id, projectId);
    if (!monitor) return c.json({ error: "monitor not found" }, 404);
    const notice: AlertNotice = {
      monitorId: monitor.id,
      monitorName: monitor.name,
      query: monitor.query,
      state: "test",
      summary: "Test notification from Kinglet — your channel works.",
      firedAt: Date.now(),
    };
    const results = [];
    for (const channel of monitor.channels) {
      try {
        await sendNotice(channel, notice);
        results.push({ type: channel.type, ok: true });
      } catch (err) {
        results.push({ type: channel.type, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return c.json({ results });
  });

  app.get("/v1/alerts", async (c) => {
    const denied = monitorGuard(c, false);
    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;
    const limit = clampInt(c.req.query("limit"), 100, 1, 500);
    return c.json({ alerts: await listAlerts(storage, limit, projectId) });
  });
}
