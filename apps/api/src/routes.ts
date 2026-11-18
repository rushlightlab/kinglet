import { and, count, eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { Config } from "./env.js";
import { createApiKey, deleteApiKey, deleteApiKeysByOwner, listApiKeys, verifyApiKey } from "./auth/apikeys.js";
import type { KingletAuth } from "./auth/auth.js";
import {
  can,
  canAccessProject,
  getAuth,
  projectExists,
  requirePermission,
  requireUser,
  resolveProjectId,
} from "./auth/middleware.js";
import type { AppEnv } from "./auth/middleware.js";
import { isKeyScope, isRole, permissionsForRole } from "./auth/roles.js";
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
import { systemStatus } from "./status.js";
import * as schema from "./storage/schema.js";
import type { Storage } from "./storage/index.js";
import { toClientEvent } from "./types.js";

const MAX_BATCH = 10000;
const MAX_STREAMS = 200;
let activeStreams = 0;

/**
 * Validates the from/to query parameters. Rejects unsafe/non-integer values,
 * inverted ranges, and clamps to a sane window. This is also what prevents
 * the histogram bucket loop from ever seeing an astronomically large value.
 */
function parseRange(c: Context<AppEnv>): { from: number; to: number } | Response {
  const now = Date.now();
  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");
  const from = fromRaw === undefined ? now - 3_600_000 : Number(fromRaw);
  const to = toRaw === undefined ? now : Number(toRaw);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to <= 0) {
    return c.json({ error: "from/to must be epoch milliseconds" }, 400);
  }
  if (from > to) return c.json({ error: "from must be before to" }, 400);
  return { from: Math.max(from, to - 31 * 24 * 3_600_000), to: Math.min(to, now + 5 * 60_000) };
}

function validateQuery(q: string): string | null {
  if (q.length > 500) return "filter is too long (max 500 characters)";
  if (q.split(/\s+/).filter(Boolean).length > 32) return "too many filter terms (max 32)";
  return null;
}

/** Per-identity ingest rate limit: 600 batches / minute. */
const ingestWindows = new Map<string, { count: number; resetAt: number }>();
function allowIngest(auth: { kind: string; keyId?: number; user?: { id: string } }): boolean {
  const id =
    auth.kind === "key" ? `key:${auth.keyId ?? 0}` : auth.kind === "user" ? `user:${auth.user?.id ?? ""}` : "legacy";
  const now = Date.now();
  const window = ingestWindows.get(id);
  if (!window || now > window.resetAt) {
    ingestWindows.set(id, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (window.count >= 600) return false;
  window.count++;
  return true;
}

/**
 * Stored-event counts are cached for 30s so per-batch quota checks do not run
 * a COUNT on the hot ingest path every time.
 */
const projectCountCache = new Map<number, { value: number; expiresAt: number }>();
async function projectEventCount(storage: Storage, projectId: number): Promise<number> {
  const now = Date.now();
  const cached = projectCountCache.get(projectId);
  if (cached && cached.expiresAt > now) return cached.value;
  const rows = await storage.db
    .select({ n: count() })
    .from(schema.events)
    .where(eq(schema.events.projectId, projectId));
  const value = Number(rows[0]?.n ?? 0);
  projectCountCache.set(projectId, { value, expiresAt: now + 30_000 });
  return value;
}

function bumpProjectCount(projectId: number, inserted: number): void {
  const cached = projectCountCache.get(projectId);
  if (cached) cached.value += inserted;
}

let dbSizeCache: { bytes: number | null; checkedAt: number } = { bytes: null, checkedAt: 0 };

/** Size of a local libSQL store, WAL included; null for remote stores. */
function localDbBytes(dbPath: string): number | null {
  const local = dbPath.toLowerCase().startsWith("file:") ? dbPath.slice(5) : dbPath;
  if (/^(libsql:\/\/|https?:\/\/|wss?:\/\/)/i.test(local)) return null;
  const now = Date.now();
  if (now - dbSizeCache.checkedAt < 30_000) return dbSizeCache.bytes;
  let bytes: number | null = null;
  try {
    const resolved = path.resolve(local);
    bytes = fs.statSync(resolved).size;
    for (const suffix of ["-wal", "-shm"]) {
      try {
        bytes += fs.statSync(resolved + suffix).size;
      } catch {
        // file may not exist
      }
    }
  } catch {
    bytes = null;
  }
  dbSizeCache = { bytes, checkedAt: now };
  return bytes;
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
    const rows =
      authInfo.kind === "user" && authInfo.user.role !== "admin"
        ? await storage.db
            .select({
              id: schema.projects.id,
              name: schema.projects.name,
              slug: schema.projects.slug,
              createdAt: schema.projects.createdAt,
            })
            .from(schema.projects)
            .innerJoin(
              schema.projectMembers,
              eq(schema.projectMembers.projectId, schema.projects.id)
            )
            .where(eq(schema.projectMembers.userId, authInfo.user.id))
            .orderBy(schema.projects.id)
        : await storage.db.select().from(schema.projects).orderBy(schema.projects.id);
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
    // Give the creator explicit membership too, so a later demotion from
    // admin does not silently remove access to a project they created.
    if (row && getAuth(c).kind === "user") {
      const authInfo = getAuth(c);
      if (authInfo.kind === "user") {
        await storage.db
          .insert(schema.projectMembers)
          .values({ projectId: Number(row.id), userId: authInfo.user.id, createdAt: now })
          .onConflictDoNothing();
      }
    }
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
      await tx.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, id));
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
    if (role !== undefined && role !== target.role) {
      try {
        await setUserRole(storage, auth, c.req.raw.headers, userId, role);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "could not change role" }, 400);
      }
      // Offboarding: a demoted user must not keep machine credentials that
      // outlive their permissions.
      const revoked = await deleteApiKeysByOwner(storage, userId);
      if (revoked > 0) console.log(`[kinglet] revoked ${revoked} API key(s) for demoted user ${userId}`);
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
    const revoked = await deleteApiKeysByOwner(storage, userId);
    if (revoked > 0) console.log(`[kinglet] revoked ${revoked} API key(s) for deleted user ${userId}`);
    // Belt and braces: removeManagedUser normally drops sessions, but a
    // deleted account must never keep a live cookie.
    await storage.db.delete(schema.session).where(eq(schema.session.userId, userId));
    return c.json({ ok: true });
  });

  // ================= API keys =================

  app.get("/v1/projects/:id/keys", async (c) => {
    const denied = requirePermission(c, "keys.read");
    if (denied) return denied;
    const projectId = parseId(c.req.param("id"));
    if (projectId === null) return c.json({ error: "invalid project id" }, 400);
    if (!(await projectExists(storage, projectId))) return c.json({ error: "project not found" }, 404);
    if (!(await canAccessProject(getAuth(c), storage, projectId))) {
      return c.json({ error: "project not found" }, 404);
    }
    return c.json({ keys: await listApiKeys(storage, projectId) });
  });

  app.post("/v1/projects/:id/keys", async (c) => {
    const denied = requirePermission(c, "keys.write");
    if (denied) return denied;
    const projectId = parseId(c.req.param("id"));
    if (projectId === null) return c.json({ error: "invalid project id" }, 400);
    if (!(await projectExists(storage, projectId))) return c.json({ error: "project not found" }, 404);
    if (!(await canAccessProject(getAuth(c), storage, projectId))) {
      return c.json({ error: "project not found" }, 404);
    }
    const parsedBody = await readJsonStrict(c);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    const rawScopes: unknown = body?.scopes;
    let scopes: KeyScope[];
    if (rawScopes === undefined) {
      // Least privilege: a key created without explicit scopes can only ship.
      scopes = ["ingest"];
    } else if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
      return c.json({ error: "scopes must be a non-empty array of: ingest, query" }, 400);
    } else {
      const unknown = rawScopes.filter((s) => !isKeyScope(s));
      if (unknown.length > 0) {
        return c.json({ error: `unknown scope(s): ${unknown.join(", ")} — use ingest and/or query` }, 400);
      }
      scopes = [...new Set(rawScopes as KeyScope[])];
    }
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
    if (!(await canAccessProject(getAuth(c), storage, projectId))) {
      return c.json({ error: "project not found" }, 404);
    }
    const deleted = await deleteApiKey(storage, id, projectId);
    if (!deleted) return c.json({ error: "key not found" }, 404);
    return c.json({ ok: true });
  });

  // ================= project members =================

  app.get("/v1/projects/:id/members", async (c) => {
    const denied = requirePermission(c, "projects.write");
    if (denied) return denied;
    const projectId = parseId(c.req.param("id"));
    if (projectId === null) return c.json({ error: "invalid project id" }, 400);
    if (!(await projectExists(storage, projectId))) return c.json({ error: "project not found" }, 404);
    const rows = await storage.db
      .select({
        userId: schema.user.id,
        email: schema.user.email,
        name: schema.user.name,
        role: schema.user.role,
        addedAt: schema.projectMembers.createdAt,
      })
      .from(schema.projectMembers)
      .innerJoin(schema.user, eq(schema.user.id, schema.projectMembers.userId))
      .where(eq(schema.projectMembers.projectId, projectId))
      .orderBy(schema.user.email);
    return c.json({
      members: rows
        .filter((r) => r.role !== "admin")
        .map((r) => ({
          userId: String(r.userId),
          email: r.email,
          name: r.name,
          role: isRole(r.role) ? r.role : "viewer",
          addedAt: Number(r.addedAt),
        })),
    });
  });

  app.post("/v1/projects/:id/members", async (c) => {
    const denied = requirePermission(c, "projects.write");
    if (denied) return denied;
    const projectId = parseId(c.req.param("id"));
    if (projectId === null) return c.json({ error: "invalid project id" }, 400);
    if (!(await projectExists(storage, projectId))) return c.json({ error: "project not found" }, 404);
    const parsedBody = await readJsonStrict(c);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const userId = typeof parsedBody.body?.userId === "string" ? parsedBody.body.userId : "";
    if (!userId) return c.json({ error: "userId is required" }, 400);
    const target = await getUserById(storage, userId);
    if (!target) return c.json({ error: "user not found" }, 404);
    await storage.db
      .insert(schema.projectMembers)
      .values({ projectId, userId, createdAt: Date.now() })
      .onConflictDoNothing();
    return c.json({ ok: true, member: { userId, email: target.email, name: target.name, role: target.role } }, 201);
  });

  app.delete("/v1/projects/:id/members/:userId", async (c) => {
    const denied = requirePermission(c, "projects.write");
    if (denied) return denied;
    const projectId = parseId(c.req.param("id"));
    if (projectId === null) return c.json({ error: "invalid project id" }, 400);
    const userId = c.req.param("userId");
    if (!userId) return c.json({ error: "invalid user id" }, 400);
    const result = await storage.db
      .delete(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.userId, userId)
        )
      );
    if (Number(result.rowsAffected ?? 0) === 0) return c.json({ error: "member not found" }, 404);
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
    if (!allowIngest(authInfo)) {
      return c.json({ error: "ingest rate limit exceeded (600 batches/minute)" }, 429);
    }
    if (config.maxDbBytes > 0) {
      const bytes = localDbBytes(config.dbPath);
      if (bytes !== null && bytes >= config.maxDbBytes) {
        return c.json(
          {
            error:
              `database size limit reached (${Math.round(config.maxDbBytes / 1_048_576)} MB) — ` +
              "shorten KINGLET_RETENTION_DAYS or raise KINGLET_MAX_DB_MB",
          },
          507
        );
      }
    }
    if (config.maxEventsPerProject > 0) {
      const stored = await projectEventCount(storage, projectId);
      if (stored >= config.maxEventsPerProject) {
        return c.json(
          {
            error:
              `project event limit reached (${config.maxEventsPerProject.toLocaleString()}) — ` +
              "raise KINGLET_MAX_EVENTS_PER_PROJECT or shorten retention",
          },
          429
        );
      }
    }

    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    const text = await c.req.text();
    const raws: unknown[] = [];
    let parseErrors = 0;
    let truncated = false;

    const pushRaw = (value: unknown): void => {
      if (raws.length < MAX_BATCH) raws.push(value);
      else truncated = true;
    };

    if (contentType.includes("ndjson")) {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (raws.length >= MAX_BATCH) {
          truncated = true;
          break;
        }
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
      if (Array.isArray(parsed)) {
        truncated = parsed.length > MAX_BATCH;
        for (let i = 0; i < Math.min(parsed.length, MAX_BATCH); i++) pushRaw(parsed[i]);
      } else if (
        parsed !== null &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { events?: unknown }).events)
      ) {
        const list = (parsed as { events: unknown[] }).events;
        truncated = list.length > MAX_BATCH;
        for (let i = 0; i < Math.min(list.length, MAX_BATCH); i++) pushRaw(list[i]);
      } else {
        pushRaw(parsed);
      }
    }

    const normalized: Normalized[] = [];
    const errors: string[] = [];
    for (const raw of raws) {
      const result = normalizeEvent(raw);
      if (result.ok) normalized.push(result.value);
      else errors.push(result.error);
    }

    const rows = await storage.insertEvents(projectId, normalized);
    bumpProjectCount(projectId, rows.length);
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
    const qError = validateQuery(q);
    if (qError) return c.json({ error: qError }, 400);
    const range = parseRange(c);
    if (range instanceof Response) return range;
    const { from, to } = range;
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
    const range = parseRange(c);
    if (range instanceof Response) return range;
    const { from, to } = range;
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
    const qError = validateQuery(q);
    if (qError) return c.json({ error: qError }, 400);
    if (activeStreams >= MAX_STREAMS) {
      return c.json({ error: "too many live streams — close one and retry" }, 429);
    }
    const f = parseFilters(q);
    const bearerRaw = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const streamKey = bearerRaw || c.req.query("key") || c.req.query("token");
    return streamSSE(c, async (stream) => {
      let closed = false;
      let counted = true;
      let pending = 0;
      let ticks = 0;
      activeStreams++;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (counted) {
          activeStreams--;
          counted = false;
        }
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
      };
      const fail = (err: unknown): void => {
        if (closed) return;
        console.warn("[kinglet] SSE closed:", err instanceof Error ? err.message : err);
        cleanup();
        void stream.close().catch(() => undefined);
      };
      // Revalidate credentials at least once a minute: a revoked key or a
      // deleted/demoted user must not keep receiving live logs. The cookie
      // cache is bypassed for this check.
      const revalidate = async (): Promise<boolean> => {
        if (authInfo.kind === "user") {
          const session = await auth.api.getSession({
            headers: c.req.raw.headers,
            query: { disableCookieCache: true },
          });
          return Boolean(session?.user);
        }
        if (authInfo.kind === "key") {
          if (!streamKey) return false;
          return Boolean(await verifyApiKey(storage, streamKey));
        }
        return true; // legacy tokens are env-bound and rotate on restart
      };
      const unsubscribe = subscribeEvents((rows) => {
        if (closed) return;
        if (pending > 500) {
          fail(new Error("slow consumer — stream dropped"));
          return;
        }
        for (const row of rows) {
          if (row.projectId !== projectId) continue;
          if (!matchesEvent(f, row)) continue;
          pending++;
          void stream
            .writeSSE({ data: JSON.stringify(toClientEvent(row)) })
            .catch(fail)
            .finally(() => {
              pending--;
            });
        }
      });
      const heartbeat = setInterval(() => {
        if (closed) return;
        ticks++;
        if (ticks % 4 === 0) {
          void revalidate()
            .then((ok) => {
              if (!ok) {
                fail(new Error("session or key revoked"));
                return;
              }
              return stream.write(": ping\n");
            })
            .catch(fail);
          return;
        }
        void stream.write(": ping\n").catch(fail);
      }, 15000);
      // EventSource reconnects automatically; bounding lifetime limits the
      // damage from abandoned sockets and forces re-authentication.
      const lifetime = setTimeout(() => fail(new Error("stream lifetime exceeded")), 30 * 60_000);
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
    const monitors = await listMonitors(storage, projectId);
    const authInfo = getAuth(c);
    // Webhook URLs are bearer secrets and engine errors may name internal
    // hosts: non-writers get the channel type only.
    const canSeeChannels = authInfo.kind !== "user" || can(authInfo, "monitors.write");
    return c.json({
      monitors: canSeeChannels
        ? monitors
        : monitors.map((m) => ({
            ...m,
            channels: m.channels.map((ch) => ({ type: ch.type, url: "hidden" })),
            lastError: null,
            lastErrorAt: null,
          })),
    });
  });

  app.post("/v1/monitors", async (c) => {
    const denied = monitorGuard(c, true);
    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;
    const totals = await storage.db
      .select({ n: count() })
      .from(schema.monitors)
      .where(eq(schema.monitors.projectId, projectId));
    if (Number(totals[0]?.n ?? 0) >= 100) {
      return c.json({ error: "monitor limit reached (100 per project)" }, 400);
    }
    const parsedBody = await readJsonStrict(c);
    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;
    const result = await createMonitorFromRaw(storage, projectId, body, {
      allowPrivateWebhooks: config.allowPrivateWebhooks,
    });
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
    const result = await updateMonitorFromRaw(storage, id, projectId, body, {
      allowPrivateWebhooks: config.allowPrivateWebhooks,
    });
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
    const authInfo = getAuth(c);
    const detailed = authInfo.kind !== "user" || authInfo.user.role === "admin";
    const results = await Promise.all(
      monitor.channels.map(async (channel) => {
        try {
          await sendNotice(channel, notice, { allowPrivate: config.allowPrivateWebhooks });
          return { type: channel.type, ok: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Internal reachability details are admin-only.
          console.warn(`[kinglet] test notification failed (${channel.type}):`, message);
          return { type: channel.type, ok: false, ...(detailed ? { error: message } : {}) };
        }
      })
    );
    return c.json({ results });
  });

  app.get("/v1/alerts", async (c) => {
    const denied = monitorGuard(c, false);
    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);
    if (projectId instanceof Response) return projectId;
    const limit = clampInt(c.req.query("limit"), 100, 1, 500);
    const alerts = await listAlerts(storage, limit, projectId);
    const authInfo = getAuth(c);
    const canSeeErrors = authInfo.kind !== "user" || can(authInfo, "monitors.write");
    return c.json({
      alerts: canSeeErrors ? alerts : alerts.map((a) => ({ ...a, notifyError: null })),
    });
  });

  // ================= diagnostics =================

  app.get("/v1/system/status", async (c) => {
    // Admin-only: retention/engine errors can contain paths or hosts, and
    // table counts are operational data.
    const denied = requirePermission(c, "users.write");
    if (denied) return denied;
    const [projects, users, monitors, alerts, keys] = await Promise.all([
      storage.db.select({ n: count() }).from(schema.projects),
      storage.db.select({ n: count() }).from(schema.user),
      storage.db.select({ n: count() }).from(schema.monitors),
      storage.db.select({ n: count() }).from(schema.alerts),
      storage.db.select({ n: count() }).from(schema.apiKeys),
    ]);
    return c.json({
      ok: true,
      name: "kinglet",
      version: "0.3.0",
      uptimeMs: Date.now() - systemStatus.startedAt,
      counts: {
        projects: Number(projects[0]?.n ?? 0),
        users: Number(users[0]?.n ?? 0),
        monitors: Number(monitors[0]?.n ?? 0),
        alerts: Number(alerts[0]?.n ?? 0),
        apiKeys: Number(keys[0]?.n ?? 0),
      },
      retention: {
        lastRunAt: systemStatus.retentionLastRunAt,
        lastError: systemStatus.retentionLastError,
      },
      monitors: {
        refreshedAt: systemStatus.monitorRefreshAt,
        refreshError: systemStatus.monitorRefreshError,
      },
      config: {
        retentionDays: config.retentionDays,
        sessionDays: config.sessionDays,
        baseUrl: config.baseUrl ?? null,
        trustedProxyCount: config.trustedProxies.length,
        allowPrivateWebhooks: config.allowPrivateWebhooks,
      },
    });
  });
}
