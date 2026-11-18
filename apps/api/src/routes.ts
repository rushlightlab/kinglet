import { and, count, eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { Config } from "./env.js";
import { createApiKey, deleteApiKey, listApiKeys } from "./auth/apikeys.js";
import type { KingletAuth } from "./auth/auth.js";
import {
  can,
  getAuth,
  projectExists,
  requirePermission,
  requireUser,
  resolveProjectId,
} from "./auth/middleware.js";
import type { AppEnv } from "./auth/middleware.js";
import { KEY_SCOPES, isKeyScope, isRole, permissionsForRole } from "./auth/roles.js";
import type { KeyScope, Role } from "./auth/roles.js";
import {
  countAdmins,
  createManagedUser,
  getUserById,
  listUsers,
  removeManagedUser,
  setUserRole,
  updateUserName,
} from "./auth/user-admin.js";
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
import * as schema from "./storage/schema.js";
import type { Storage } from "./storage/index.js";
import { toClientEvent } from "./types.js";

const MAX_BATCH = 10000;

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

/** Strict body parser for mutations: distinguishes malformed JSON from bad fields. */
async function readJsonStrict(
  c: Context<AppEnv>
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const body = await readJson(c);
  if (!body) return { ok: false, error: "invalid JSON body" };
  return { ok: true, body };
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

export function registerRoutes(
  app: Hono<AppEnv>,
  storage: Storage,
  engine: MonitorEngine,
  config: Config,
  auth: KingletAuth
): void {
  void config;

  // ================= current user =================

  app.get("/v1/me", async (c) => {
    const authInfo = getAuth(c);
    if (authInfo.kind !== "user") return c.json({ error: "user session required" }, 403);
    const user = await getUserById(storage, authInfo.user.id);
    if (!user) return c.json({ error: "user not found" }, 404);
    return c.json({ user, permissions: permissionsForRole(user.role) });
  });

  // ================= projects =================

  app.get("/v1/projects", async (c) => {
    const authInfo = getAuth(c);
    if (authInfo.kind === "key") return c.json({ error: "user session required" }, 403);
    const rows = await storage.db.select().from(schema.projects).orderBy(schema.projects.id);
    return c.json({
      projects: rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        slug: r.slug,
        createdAt: Number(r.createdAt),
      })),
    });
  });

  app.post("/v1/projects", async (c) => {
    const denied = requirePermission(c, "projects.write");
    if (denied) return denied;
    const parsedBody = await readJsonStrict(c);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 64) : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    const base = uniqueSlug(name);
    let slug = base;
    for (let i = 2; ; i++) {
      const clash = await storage.db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.slug, slug))
        .limit(1);
      if (clash.length === 0) break;
      slug = `${base}-${i}`;
    }
    const now = Date.now();
    const rows = await storage.db
      .insert(schema.projects)
      .values({ name, slug, createdAt: now })
      .returning();
    const row = rows[0];
    return c.json(
      { project: { id: Number(row?.id ?? 0), name, slug, createdAt: now } },
      201
    );
  });

  app.delete("/v1/projects/:id", async (c) => {
    const denied = requirePermission(c, "projects.write");
    if (denied) return denied;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid project id" }, 400);
    const totals = await storage.db.select({ n: count() }).from(schema.projects);
    if (Number(totals[0]?.n ?? 0) <= 1) return c.json({ error: "cannot delete the last project" }, 400);
    if (!(await projectExists(storage, id))) return c.json({ error: "project not found" }, 404);

    const monitorIds = storage.db
      .select({ id: schema.monitors.id })
      .from(schema.monitors)
      .where(eq(schema.monitors.projectId, id));
    await storage.db.transaction(async (tx) => {
      await tx.delete(schema.alerts).where(inArray(schema.alerts.monitorId, monitorIds));
      await tx.delete(schema.monitors).where(eq(schema.monitors.projectId, id));
      await tx.delete(schema.events).where(eq(schema.events.projectId, id));
      await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.projectId, id));
      await tx.delete(schema.projects).where(eq(schema.projects.id, id));
    });
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
    const parsedBody = await readJsonStrict(c);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "a valid email is required" }, 400);
    const role: Role = isRole(body?.role) ? body.role : "member";
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
    const password = typeof body?.password === "string" && body.password.length > 0 ? body.password : undefined;
    if (password !== undefined && password.length < 8) {
      return c.json({ error: "password must be at least 8 characters" }, 400);
    }
    try {
      const result = await createManagedUser(storage, auth, c.req.raw.headers, {
        email,
        name: name || email,
        role,
        password,
      });
      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not create user" }, 400);
    }
  });

  app.patch("/v1/users/:id", async (c) => {
    const denied = requirePermission(c, "users.write");
    if (denied) return denied;
    const me = requireUser(c);
    if (me instanceof Response) return me;
    const userId = c.req.param("id");
    if (!userId) return c.json({ error: "invalid user id" }, 400);
    const target = await getUserById(storage, userId);
    if (!target) return c.json({ error: "user not found" }, 404);
    const parsedBody = await readJsonStrict(c);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;

    let role: Role | undefined;
    if (body?.role !== undefined) {
      if (!isRole(body.role)) return c.json({ error: "invalid role" }, 400);
      role = body.role;
    }
    if (target.role === "admin" && role !== undefined && role !== "admin") {
      if ((await countAdmins(storage)) <= 1) {
        return c.json({ error: "cannot demote the last administrator" }, 400);
      }
    }
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : undefined;
    if (name !== undefined) await updateUserName(storage, userId, name);
    if (role !== undefined) {
      try {
        await setUserRole(storage, auth, c.req.raw.headers, userId, role);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "could not change role" }, 400);
      }
    }
    const updated = await getUserById(storage, userId);
    return c.json({ user: updated });
  });

  app.delete("/v1/users/:id", async (c) => {
    const denied = requirePermission(c, "users.write");
    if (denied) return denied;
    const me = requireUser(c);
    if (me instanceof Response) return me;
    const userId = c.req.param("id");
    if (!userId) return c.json({ error: "invalid user id" }, 400);
    if (userId === me.id) return c.json({ error: "you cannot delete your own account" }, 400);
    const target = await getUserById(storage, userId);
    if (!target) return c.json({ error: "user not found" }, 404);
    if (target.role === "admin") return c.json({ error: "administrators cannot be deleted" }, 400);
    try {
      await removeManagedUser(auth, c.req.raw.headers, userId);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not delete user" }, 400);
    }
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
    const parsedBody = await readJsonStrict(c);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;
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
    const authInfo = getAuth(c);
    if (authInfo.kind === "key" && !authInfo.scopes.has("ingest")) {
      return c.json({ error: "this key cannot ingest (missing ingest scope)" }, 403);
    }
    if (authInfo.kind === "user" && !can(authInfo, "logs.write")) return c.json({ error: "forbidden" }, 403);
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

    if (rows.length === 0 && errors.length + parseErrors > 0) {
      return c.json(
        { accepted: 0, rejected: errors.length + parseErrors, errors: errors.slice(0, 3) },
        422
      );
    }

    return c.json({
      accepted: rows.length,
      rejected: errors.length + parseErrors,
      ...(truncated ? { truncated: true } : {}),
      ...(errors.length > 0 ? { errors: errors.slice(0, 3) } : {}),
    });
  });

  app.get("/v1/events", async (c) => {
    const authInfo = getAuth(c);
    if (authInfo.kind === "key" && !authInfo.scopes.has("query")) {
      return c.json({ error: "this key cannot query (missing query scope)" }, 403);
    }
    if (authInfo.kind === "user" && !can(authInfo, "logs.read")) return c.json({ error: "forbidden" }, 403);
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;

    const q = c.req.query("q") ?? "";
    const now = Date.now();
    const from = parseTimestamp(c.req.query("from"), now - 3600_000);
    const to = parseTimestamp(c.req.query("to"), now);
    const limit = clampInt(c.req.query("limit"), 200, 1, 1000);
    const cursorRaw = Number(c.req.query("cursor"));
    const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;
    const filter = buildWhere(parseFilters(q), { from, to }, projectId);
    const rows = await storage.queryEvents({ filter, limit, cursor });
    return c.json({
      events: rows.map(toClientEvent),
      nextCursor: rows.length === limit ? rows[rows.length - 1]?.id ?? null : null,
    });
  });

  app.get("/v1/histogram", async (c) => {
    const authInfo = getAuth(c);
    if (authInfo.kind === "key" && !authInfo.scopes.has("query")) return c.json({ error: "forbidden" }, 403);
    if (authInfo.kind === "user" && !can(authInfo, "logs.read")) return c.json({ error: "forbidden" }, 403);
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
    const authInfo = getAuth(c);
    if (authInfo.kind === "key" && !authInfo.scopes.has("query")) return c.json({ error: "forbidden" }, 403);
    if (authInfo.kind === "user" && !can(authInfo, "logs.read")) return c.json({ error: "forbidden" }, 403);
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;
    return c.json({ services: await storage.listServices(projectId) });
  });

  app.get("/v1/stream", async (c) => {
    const authInfo = getAuth(c);
    if (authInfo.kind === "key" && !authInfo.scopes.has("query")) return c.json({ error: "forbidden" }, 403);
    if (authInfo.kind === "user" && !can(authInfo, "logs.read")) return c.json({ error: "forbidden" }, 403);
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;

    const q = c.req.query("q") ?? "";
    const f = parseFilters(q);
    return streamSSE(c, async (stream) => {
      let closed = false;
      const cleanup = (): void => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      const fail = (err: unknown): void => {
        console.warn("[kinglet] SSE write failed:", err instanceof Error ? err.message : err);
        cleanup();
        void stream.close().catch(() => undefined);
      };
      const unsubscribe = subscribeEvents((rows) => {
        if (closed) return;
        for (const row of rows) {
          if (row.projectId !== projectId) continue;
          if (!matchesEvent(f, row)) continue;
          void stream
            .writeSSE({ data: JSON.stringify(toClientEvent(row)) })
            .catch(fail);
        }
      });
      const heartbeat = setInterval(() => {
        if (closed) return;
        void stream.write(": ping\n").catch(fail);
      }, 15000);
      stream.onAbort(cleanup);
      // Flush headers immediately so the client sees the stream open.
      await stream.write(": connected\n\n");
      await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
    });
  });

  // ================= monitors =================

  const monitorGuard = (c: Context<AppEnv>, write: boolean): Response | null => {
    const authInfo = getAuth(c);
    if (authInfo.kind === "legacy") return null;
    if (authInfo.kind === "key") return c.json({ error: "keys cannot manage monitors" }, 403);
    return can(authInfo, write ? "monitors.write" : "monitors.read") ? null : c.json({ error: "forbidden" }, 403);
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
    const parsedBody = await readJsonStrict(c);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;
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
    const parsedBody = await readJsonStrict(c);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;
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
