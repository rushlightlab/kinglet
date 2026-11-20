import { and, count, eq, inArray, sql } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { Config } from "./env.js";
import {
  createApiKey,
  deleteApiKey,
  deleteApiKeysByOwner,
  deleteApiKeysByOwnerInProject,
  getApiKey,
  listApiKeys,
  rotateApiKey,
  updateApiKeyScopes,
  verifyApiKey,
} from "./auth/apikeys.js";
import type { KingletAuth } from "./auth/auth.js";
import {
  can,
  canAccessProject,
  canClearProjectLogs,
  getAuth,
  projectExists,
  requirePermission,
  requireUser,
  resolveProjectId,
  userAuth,
} from "./auth/middleware.js";
import type { AppEnv, AuthInfo } from "./auth/middleware.js";
import {
  isKeyType,
  isRole,
  permissionsForRole,
  scopesForType,
  validateKeyScopes,
} from "./auth/roles.js";
import type { AnyKeyScope, KeyType, Role } from "./auth/roles.js";
import { isUuid, uuidv7 } from "./auth/ids.js";
import { canCapability, keyCan } from "./auth/key-capabilities.js";
import type { KeyCapability } from "./auth/key-capabilities.js";
import type { BackupStatus } from "./backups/types.js";
import { buildKeyContext } from "./mcp/context.js";
import { APP_VERSION } from "./version.js";
import {
  countAdmins,
  createManagedUser,
  getUserById,
  listUsers,
  removeManagedUser,
  resetManagedUserPassword,
  setManagedUserDisabled,
  setUserRole,
  updateUserName,
} from "./auth/user-admin.js";
import { publishEvents, subscribeEvents } from "./bus.js";
import { passwordProblem } from "./auth/password.js";
import { buildWhere, matchesEvent, parseFilters } from "./filters.js";
import type { Normalized } from "./ingest.js";
import { normalizeEvent } from "./ingest.js";
import { isBoolean, isJsonObject, isString } from "./json.js";
import type { JsonObject, JsonValue } from "./json.js";
import { validateQueryString } from "./query-validation.js";
import { eventSizeBytes } from "./storage/events.js";
import type { Monitor, MonitorEngine } from "./monitors.js";
import {
  createMonitorFromRaw,
  deleteMonitor,
  getMonitor,
  listAlerts,
  listMonitors,
  resolveMonitorNotifyTargets,
  updateMonitorFromRaw,
} from "./monitors.js";
import { sendNotice, validateWebhookUrl } from "./notify.js";
import type { AlertNotice } from "./notify.js";
import { systemStatus } from "./status.js";
import * as schema from "./storage/schema.js";
import type { Storage } from "./storage/index.js";
import { localDbBytes, invalidateDbSizeCache } from "./storage/db-size.js";
import { toClientEvent } from "./types.js";

const MAX_BATCH = 10000;
const MAX_STREAMS = 200;
const MAX_STREAMS_PER_IDENTITY = 10;
const MAX_STREAMS_PER_PROJECT = 100;
const MAX_PENDING_WRITES = 500;
const MAX_PENDING_BYTES = 1_000_000;
let activeStreams = 0;
const streamsByIdentity = new Map<string, number>();
const streamsByProject = new Map<string, number>();

function streamIdentity(auth: AuthInfo): string {
  return auth.kind === "key" ? `key:${auth.keyId}` : `user:${auth.user.id}`;
}

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
  return validateQueryString(q);
}

/** Per-identity ingest rate limit: 600 batches / minute. */
const ingestWindows = new Map<string, { count: number; resetAt: number }>();

function allowIngest(auth: AuthInfo): boolean {
  const id = auth.kind === "key" ? `key:${auth.keyId}` : `user:${auth.user.id}`;
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
const projectCountCache = new Map<string, { value: number; expiresAt: number }>();

async function projectEventCount(storage: Storage, projectId: string): Promise<number> {
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

function bumpProjectCount(projectId: string, inserted: number): void {
  const cached = projectCountCache.get(projectId);

  if (cached) cached.value += inserted;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Math.trunc(Number(value));

  if (!Number.isFinite(n)) return fallback;

  return Math.min(max, Math.max(min, n));
}

function parseId(raw: string): string | null {
  return isUuid(raw) ? raw.toLowerCase() : null;
}

/** Project ids are UUID v7 in the `?project=` query parameter. */
function parseProjectQuery(raw: string | undefined): string | null {
  if (raw === undefined) return null;

  return parseId(raw);
}

async function readJson(c: Context<AppEnv>): Promise<JsonObject | null> {
  try {
    const body: unknown = await c.req.json();

    return isJsonObject(body) ? body : null;
  } catch {
    return null;
  }
}

/** Strict body parser for mutations: distinguishes malformed JSON from bad fields. */
async function readJsonStrict(
  c: Context<AppEnv>,
): Promise<{ ok: true; body: JsonObject } | { ok: false; error: string }> {
  const body = await readJson(c);

  if (!body) return { ok: false, error: "invalid JSON body" };

  return { ok: true, body };
}

interface IngestResponse {
  accepted: number;
  rejected: number;
  truncated?: true;
  errors?: string[];
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

function canManageApiKey(info: AuthInfo, key: { createdBy: string | null }): boolean {
  return info.kind === "user" && (info.user.role === "admin" || key.createdBy === info.user.id);
}

function readScopeError(authInfo: AuthInfo): string {
  if (authInfo.kind !== "key") return "forbidden";

  return authInfo.keyType === "mcp"
    ? "this MCP key is missing the logs.read scope"
    : "this key cannot query (missing query scope)";
}

function monitorForAuth(authInfo: AuthInfo, monitor: Monitor): Monitor {
  if (authInfo.kind === "user" && can(authInfo, "monitors.write")) return monitor;

  return {
    ...monitor,
    channels: monitor.channels.map((channel) => ({ type: channel.type, url: "hidden" })),
    resolvedChannels: monitor.resolvedChannels.map((channel) => ({
      ...channel,
      health: { ...channel.health, error: null },
    })),
    lastError: null,
    lastErrorAt: null,
  };
}

function monitorGuard(c: Context<AppEnv>, write: boolean): Response | null {
  const authInfo = getAuth(c);
  const capability: KeyCapability = write ? "monitors.write" : "monitors.read";

  if (authInfo.kind === "key") {
    // Invariant: application keys never manage monitors, whatever their scopes.
    if (authInfo.keyType === "api") {
      return c.json({ error: "keys cannot manage monitors" }, 403);
    }

    return keyCan(authInfo, capability)
      ? null
      : c.json({ error: `this MCP key is missing the ${capability} scope` }, 403);
  }

  return can(authInfo, capability) ? null : c.json({ error: "forbidden" }, 403);
}

export function registerRoutes(
  app: Hono<AppEnv>,
  storage: Storage,
  engine: MonitorEngine,
  config: Config,
  auth: KingletAuth,
  services?: { backupStatus?: () => Promise<BackupStatus> },
): void {
  // ================= current user =================

  app.get("/v1/me", async (c) => {
    const authInfo = getAuth(c);

    if (authInfo.kind !== "user") return c.json({ error: "user session required" }, 403);
    const user = await getUserById(storage, authInfo.user.id);

    if (!user) return c.json({ error: "user not found" }, 404);

    return c.json({ user, permissions: permissionsForRole(user.role) });
  });

  // Machine-credential context for MCP and SDK clients. Never reads ?project=.
  app.get("/v1/context", async (c) => {
    const context = await buildKeyContext(storage, getAuth(c), config.retentionDays);

    if (!context) return c.json({ error: "API key required" }, 403);

    return c.json(context);
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
              canClearLogs: schema.projectMembers.canClearLogs,
            })
            .from(schema.projects)
            .innerJoin(
              schema.projectMembers,
              eq(schema.projectMembers.projectId, schema.projects.id),
            )
            .where(eq(schema.projectMembers.userId, authInfo.user.id))
            .orderBy(schema.projects.id)
        : await storage.db
            .select({
              id: schema.projects.id,
              name: schema.projects.name,
              slug: schema.projects.slug,
              createdAt: schema.projects.createdAt,
              canClearLogs: sql<number>`1`,
            })
            .from(schema.projects)
            .orderBy(schema.projects.id);

    return c.json({
      projects: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        createdAt: Number(r.createdAt),
        canClearLogs: Boolean(r.canClearLogs),
      })),
    });
  });

  app.post("/v1/projects", async (c) => {
    const denied = requirePermission(c, "projects.write");

    if (denied) return denied;
    const parsedBody = await readJsonStrict(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;
    const name = isString(body.name) ? body.name.trim().slice(0, 64) : "";

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
      .values({ id: uuidv7(), name, slug, createdAt: now })
      .returning();

    const row = rows[0];

    // Give the creator explicit membership too, so a later demotion from
    // admin does not silently remove access to a project they created.
    if (row && getAuth(c).kind === "user") {
      const authInfo = getAuth(c);

      if (authInfo.kind === "user") {
        await storage.db
          .insert(schema.projectMembers)
          .values({ id: uuidv7(), projectId: row.id, userId: authInfo.user.id, createdAt: now })
          .onConflictDoNothing();
      }
    }

    return c.json({ project: { id: row?.id ?? "", name, slug, createdAt: now } }, 201);
  });

  app.patch("/v1/projects/:id", async (c) => {
    const denied = requirePermission(c, "projects.write");

    if (denied) return denied;
    const id = parseId(c.req.param("id"));

    if (id === null) return c.json({ error: "invalid project id" }, 400);
    const parsedBody = await readJsonStrict(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);

    const name = isString(parsedBody.body.name) ? parsedBody.body.name.trim().slice(0, 64) : "";

    if (!name) return c.json({ error: "name is required" }, 400);

    const existing = await storage.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .limit(1);

    const row = existing[0];

    if (!row) return c.json({ error: "project not found" }, 404);
    await storage.db.update(schema.projects).set({ name }).where(eq(schema.projects.id, id));
    await engine.refresh();

    return c.json({
      project: {
        id,
        name,
        slug: row.slug,
        createdAt: Number(row.createdAt),
        canClearLogs: true,
      },
    });
  });

  app.delete("/v1/projects/:id", async (c) => {
    const denied = requirePermission(c, "projects.write");

    if (denied) return denied;
    const id = parseId(c.req.param("id"));

    if (id === null) return c.json({ error: "invalid project id" }, 400);
    const totals = await storage.db.select({ n: count() }).from(schema.projects);

    if (Number(totals[0]?.n ?? 0) <= 1)
      return c.json({ error: "cannot delete the only project" }, 400);

    if (!(await projectExists(storage, id))) return c.json({ error: "project not found" }, 404);

    const monitorIds = storage.db
      .select({ id: schema.monitors.id })
      .from(schema.monitors)
      .where(eq(schema.monitors.projectId, id));

    await storage.db.transaction(async (tx) => {
      await tx.delete(schema.alerts).where(inArray(schema.alerts.monitorId, monitorIds));
      await tx
        .delete(schema.monitorChannels)
        .where(inArray(schema.monitorChannels.monitorId, monitorIds));
      await tx.delete(schema.monitors).where(eq(schema.monitors.projectId, id));
      await tx.delete(schema.events).where(eq(schema.events.projectId, id));
      await tx.delete(schema.projectUsage).where(eq(schema.projectUsage.projectId, id));
      await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.projectId, id));
      await tx.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, id));
      await tx
        .delete(schema.projectArchiveSettings)
        .where(eq(schema.projectArchiveSettings.projectId, id));
      await tx.delete(schema.archiveParts).where(eq(schema.archiveParts.projectId, id));
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
    const email = isString(body.email) ? body.email.trim() : "";

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return c.json({ error: "a valid email is required" }, 400);
    const role: Role = isRole(body.role) ? body.role : "member";
    const name = isString(body.name) ? body.name.trim().slice(0, 80) : "";

    const password =
      isString(body.password) && body.password.length > 0 ? body.password : undefined;

    if (password !== undefined) {
      const problem = passwordProblem(password);

      if (problem) return c.json({ error: problem }, 400);
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

    const disabled = isBoolean(body.disabled) ? body.disabled : undefined;
    let role: Role | undefined;

    if (body?.role !== undefined) {
      if (!isRole(body.role)) return c.json({ error: "invalid role" }, 400);
      role = body.role;
    }

    // Validate the final state, not the pre-change role. A combined
    // { disabled: true, role: "admin" } must not create a banned administrator.
    const finalRole = role ?? target.role;

    if (disabled === true && finalRole === "admin") {
      return c.json({ error: "administrators cannot be disabled" }, 400);
    }

    if (disabled !== undefined) {
      if (disabled && userId === me.id) {
        return c.json({ error: "you cannot disable your own account" }, 400);
      }

      try {
        await setManagedUserDisabled(storage, auth, c.req.raw.headers, userId, disabled);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "could not update user status" },
          400,
        );
      }

      if (disabled) {
        // Disabling is an offboarding event: keys must not come back on unban.
        const revoked = await deleteApiKeysByOwner(storage, userId);

        if (revoked > 0)
          console.log(`[kinglet] revoked ${revoked} API key(s) for disabled user ${userId}`);
      }
    }

    if (
      target.role === "admin" &&
      target.disabled === false &&
      role !== undefined &&
      role !== "admin"
    ) {
      if ((await countAdmins(storage)) <= 1) {
        return c.json({ error: "cannot demote the last administrator" }, 400);
      }
    }

    const name = isString(body.name) ? body.name.trim().slice(0, 80) : undefined;

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

      if (revoked > 0)
        console.log(`[kinglet] revoked ${revoked} API key(s) for demoted user ${userId}`);
    }

    const updated = await getUserById(storage, userId);

    return c.json({ user: updated });
  });

  app.post("/v1/users/:id/reset-password", async (c) => {
    const denied = requirePermission(c, "users.write");

    if (denied) return denied;
    const me = requireUser(c);

    if (me instanceof Response) return me;
    const userId = c.req.param("id");

    if (!userId) return c.json({ error: "invalid user id" }, 400);

    if (userId === me.id) {
      return c.json({ error: "use the account page to change your own password" }, 400);
    }

    const target = await getUserById(storage, userId);

    if (!target) return c.json({ error: "user not found" }, 404);

    try {
      const password = await resetManagedUserPassword(storage, auth, c.req.raw.headers, userId);
      // Account recovery is a full credential rotation: keys minted during a
      // stolen session must not survive the password reset.
      const revokedKeys = await deleteApiKeysByOwner(storage, userId);

      if (revokedKeys > 0)
        console.log(
          `[kinglet] revoked ${revokedKeys} API key(s) after password reset for ${userId}`,
        );

      return c.json({ password, revokedKeys });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "could not reset password" },
        400,
      );
    }
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

    if (revoked > 0)
      console.log(`[kinglet] revoked ${revoked} API key(s) for deleted user ${userId}`);
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

    if (!(await projectExists(storage, projectId)))
      return c.json({ error: "project not found" }, 404);

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

    if (!(await projectExists(storage, projectId)))
      return c.json({ error: "project not found" }, 404);

    if (!(await canAccessProject(getAuth(c), storage, projectId))) {
      return c.json({ error: "project not found" }, 404);
    }

    const parsedBody = await readJsonStrict(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;
    const name = isString(body.name) ? body.name.trim().slice(0, 80) : "";

    if (!name) return c.json({ error: "name is required" }, 400);

    if (body.keyType !== undefined && !isKeyType(body.keyType)) {
      return c.json({ error: "keyType must be api or mcp" }, 400);
    }

    const keyType: KeyType = isKeyType(body.keyType) ? body.keyType : "api";
    const rawScopes = body.scopes;
    let scopes: AnyKeyScope[];

    if (rawScopes === undefined) {
      // Least privilege: app keys ship; MCP keys get read-only diagnostics.
      scopes = keyType === "mcp" ? ["logs.read", "monitors.read"] : ["ingest"];
    } else if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
      return c.json(
        { error: `scopes must be a non-empty array of: ${scopesForType(keyType).join(", ")}` },
        400,
      );
    } else {
      const validated = validateKeyScopes(keyType, rawScopes);

      if (!validated) {
        return c.json(
          {
            error: `invalid scope(s) for a ${keyType} key — use ${scopesForType(keyType).join(", ")}`,
          },
          400,
        );
      }

      scopes = validated;
    }

    const me = getAuth(c);
    const createdBy = me.kind === "user" ? me.user.id : null;
    const created = await createApiKey(storage, { projectId, name, keyType, scopes, createdBy });

    return c.json(created, 201);
  });

  app.delete("/v1/keys/:id", async (c) => {
    const denied = requirePermission(c, "keys.write");

    if (denied) return denied;
    const id = parseId(c.req.param("id"));

    if (id === null) return c.json({ error: "invalid key id" }, 400);
    const projectId = parseProjectQuery(c.req.query("project"));

    if (projectId === null) return c.json({ error: "project is required" }, 400);

    if (!(await canAccessProject(getAuth(c), storage, projectId))) {
      return c.json({ error: "project not found" }, 404);
    }

    const key = await getApiKey(storage, id, projectId);

    if (!key) return c.json({ error: "key not found" }, 404);

    if (!canManageApiKey(getAuth(c), key)) {
      return c.json({ error: "only the key creator or an administrator can revoke this key" }, 403);
    }

    const deleted = await deleteApiKey(storage, id, projectId);

    if (!deleted) return c.json({ error: "key not found" }, 404);

    return c.json({ ok: true });
  });

  app.patch("/v1/keys/:id", async (c) => {
    const denied = requirePermission(c, "keys.write");

    if (denied) return denied;
    const id = parseId(c.req.param("id"));

    if (id === null) return c.json({ error: "invalid key id" }, 400);
    const projectId = parseProjectQuery(c.req.query("project"));

    if (projectId === null) {
      return c.json({ error: "project is required" }, 400);
    }

    if (!(await canAccessProject(getAuth(c), storage, projectId))) {
      return c.json({ error: "project not found" }, 404);
    }

    const key = await getApiKey(storage, id, projectId);

    if (!key) return c.json({ error: "key not found" }, 404);

    if (!canManageApiKey(getAuth(c), key)) {
      return c.json({ error: "only the key creator or an administrator can change this key" }, 403);
    }

    const parsedBody = await readJsonStrict(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const rawScopes = parsedBody.body.scopes;

    if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
      return c.json(
        { error: `scopes must be a non-empty array of: ${scopesForType(key.keyType).join(", ")}` },
        400,
      );
    }

    const scopes = validateKeyScopes(key.keyType, rawScopes);

    if (!scopes) {
      return c.json(
        {
          error: `invalid scope(s) for a ${key.keyType} key — use ${scopesForType(key.keyType).join(", ")}`,
        },
        400,
      );
    }

    const updated = await updateApiKeyScopes(storage, id, projectId, scopes);

    if (!updated) return c.json({ error: "key not found" }, 404);

    return c.json({ ok: true, scopes });
  });

  app.post("/v1/keys/:id/rotate", async (c) => {
    const denied = requirePermission(c, "keys.write");

    if (denied) return denied;
    const id = parseId(c.req.param("id"));

    if (id === null) return c.json({ error: "invalid key id" }, 400);
    const projectId = parseProjectQuery(c.req.query("project"));

    if (projectId === null) {
      return c.json({ error: "project is required" }, 400);
    }

    if (!(await canAccessProject(getAuth(c), storage, projectId))) {
      return c.json({ error: "project not found" }, 404);
    }

    const key = await getApiKey(storage, id, projectId);

    if (!key) return c.json({ error: "key not found" }, 404);

    if (!canManageApiKey(getAuth(c), key)) {
      return c.json({ error: "only the key creator or an administrator can rotate this key" }, 403);
    }

    const rotated = await rotateApiKey(storage, id, projectId);

    if (!rotated) return c.json({ error: "key not found" }, 404);

    return c.json(rotated);
  });

  // ================= project members =================

  app.get("/v1/projects/:id/members", async (c) => {
    const denied = requirePermission(c, "projects.write");

    if (denied) return denied;
    const projectId = parseId(c.req.param("id"));

    if (projectId === null) return c.json({ error: "invalid project id" }, 400);

    if (!(await projectExists(storage, projectId)))
      return c.json({ error: "project not found" }, 404);

    const rows = await storage.db
      .select({
        userId: schema.user.id,
        email: schema.user.email,
        name: schema.user.name,
        role: schema.user.role,
        canClearLogs: schema.projectMembers.canClearLogs,
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
          canClearLogs: Boolean(r.canClearLogs),
          addedAt: Number(r.addedAt),
        })),
    });
  });

  app.post("/v1/projects/:id/members", async (c) => {
    const denied = requirePermission(c, "projects.write");

    if (denied) return denied;
    const projectId = parseId(c.req.param("id"));

    if (projectId === null) return c.json({ error: "invalid project id" }, 400);

    if (!(await projectExists(storage, projectId)))
      return c.json({ error: "project not found" }, 404);
    const parsedBody = await readJsonStrict(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const userId = isString(parsedBody.body.userId) ? parsedBody.body.userId : "";

    if (!userId) return c.json({ error: "userId is required" }, 400);
    const target = await getUserById(storage, userId);

    if (!target) return c.json({ error: "user not found" }, 404);
    await storage.db
      .insert(schema.projectMembers)
      .values({ id: uuidv7(), projectId, userId, createdAt: Date.now() })
      .onConflictDoNothing();

    return c.json(
      {
        ok: true,
        member: {
          userId,
          email: target.email,
          name: target.name,
          role: target.role,
          canClearLogs: false,
        },
      },
      201,
    );
  });

  app.patch("/v1/projects/:id/members/:userId", async (c) => {
    const denied = requirePermission(c, "projects.write");

    if (denied) return denied;
    const projectId = parseId(c.req.param("id"));

    if (projectId === null) return c.json({ error: "invalid project id" }, 400);
    const userId = c.req.param("userId");

    if (!userId) return c.json({ error: "invalid user id" }, 400);
    const parsedBody = await readJsonStrict(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);

    if (!isBoolean(parsedBody.body.canClearLogs)) {
      return c.json({ error: "canClearLogs must be a boolean" }, 400);
    }

    const canClearLogs = parsedBody.body.canClearLogs;
    const target = await getUserById(storage, userId);

    if (!target) return c.json({ error: "user not found" }, 404);

    if (canClearLogs && target.role === "viewer") {
      return c.json({ error: "viewers cannot be granted clear logs" }, 400);
    }

    const result = await storage.db
      .update(schema.projectMembers)
      .set({ canClearLogs })
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.userId, userId),
        ),
      );

    if (Number(result.rowsAffected ?? 0) === 0) return c.json({ error: "member not found" }, 404);

    return c.json({ ok: true, canClearLogs });
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
          eq(schema.projectMembers.userId, userId),
        ),
      );

    if (Number(result.rowsAffected ?? 0) === 0) return c.json({ error: "member not found" }, 404);
    // Offboarding a project member must revoke the machine credentials that
    // member minted for this project; otherwise the key outlives the membership.
    const revokedKeys = await deleteApiKeysByOwnerInProject(storage, userId, projectId);

    return c.json({ ok: true, revokedKeys });
  });

  // ================= events =================

  app.post("/v1/events", bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    const authInfo = getAuth(c);

    if (authInfo.kind === "key" && authInfo.keyType === "mcp") {
      return c.json({ error: "MCP keys cannot ingest events" }, 403);
    }

    if (!canCapability(authInfo, "logs.write")) {
      return c.json(
        {
          error:
            authInfo.kind === "key" ? "this key cannot ingest (missing ingest scope)" : "forbidden",
        },
        403,
      );
    }

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
              "delete old data or raise KINGLET_MAX_DB_MB",
          },
          507,
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
          429,
        );
      }
    }

    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    const text = await c.req.text();
    const raws: JsonValue[] = [];
    let parseErrors = 0;
    let truncated = false;

    const pushRaw = (value: JsonValue): void => {
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
      let parsed: JsonValue;

      try {
        parsed = JSON.parse(text);
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }

      if (Array.isArray(parsed)) {
        truncated = parsed.length > MAX_BATCH;

        for (let i = 0; i < Math.min(parsed.length, MAX_BATCH); i++) {
          const value = parsed[i];

          if (value !== undefined) pushRaw(value);
        }
      } else if (isJsonObject(parsed) && Array.isArray(parsed.events)) {
        const list = parsed.events;
        truncated = list.length > MAX_BATCH;

        for (let i = 0; i < Math.min(list.length, MAX_BATCH); i++) {
          const value = list[i];

          if (value !== undefined) pushRaw(value);
        }
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

    if (config.maxProjectBytes > 0 && normalized.length > 0) {
      const incomingBytes = normalized.reduce((sum, event) => sum + eventSizeBytes(event), 0);

      const usage = await storage.db
        .select({ bytes: schema.projectUsage.bytes })
        .from(schema.projectUsage)
        .where(eq(schema.projectUsage.projectId, projectId))
        .limit(1);

      const storedBytes = Number(usage[0]?.bytes ?? 0);

      if (storedBytes + incomingBytes > config.maxProjectBytes) {
        return c.json(
          {
            error:
              `project storage limit reached (${Math.round(config.maxProjectBytes / 1_048_576)} MB) - ` +
              "delete old events or raise KINGLET_MAX_PROJECT_DB_MB",
          },
          507,
        );
      }
    }

    const rows = await storage.insertEvents(
      projectId,
      normalized,
      authInfo.kind === "key" ? authInfo.keyId : null,
    );

    bumpProjectCount(projectId, rows.length);
    publishEvents(rows);

    if (rows.length === 0 && errors.length + parseErrors > 0) {
      return c.json(
        { accepted: 0, rejected: errors.length + parseErrors, errors: errors.slice(0, 3) },
        422,
      );
    }

    const response: IngestResponse = {
      accepted: rows.length,
      rejected: errors.length + parseErrors,
    };

    if (truncated) response.truncated = true;

    if (errors.length > 0) response.errors = errors.slice(0, 3);

    return c.json(response);
  });

  // Destructive and project-scoped: admins, or a member explicitly granted
  // `canClearLogs` on this project. API keys can never delete logs.
  app.delete("/v1/events", async (c) => {
    const authInfo = getAuth(c);

    if (authInfo.kind !== "user") return c.json({ error: "user session required" }, 403);

    if (!c.req.query("project")) return c.json({ error: "project is required" }, 400);
    const fromRaw = c.req.query("from");
    const toRaw = c.req.query("to");

    if ((fromRaw === undefined) !== (toRaw === undefined)) {
      return c.json({ error: "from and to must be provided together" }, 400);
    }

    let range: { from: number; to: number } | undefined;

    if (fromRaw !== undefined && toRaw !== undefined) {
      const from = Number(fromRaw);
      const to = Number(toRaw);

      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0 || from > to) {
        return c.json({ error: "invalid time range" }, 400);
      }

      range = { from: Math.trunc(from), to: Math.trunc(to) };
    }

    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;

    if (!(await canClearProjectLogs(authInfo, storage, projectId))) {
      return c.json({ error: "forbidden" }, 403);
    }

    const deleted = await storage.deleteByProject(projectId, range);
    projectCountCache.delete(projectId);
    invalidateDbSizeCache();
    console.log(
      `[kinglet] cleared ${deleted} event(s) from project ${projectId}` +
        (range
          ? ` between ${new Date(range.from).toISOString()} and ${new Date(range.to).toISOString()}`
          : " (all time)") +
        ` (${authInfo.user.email})`,
    );

    return c.json({ deleted, projectId, ...range });
  });

  app.get("/v1/events", async (c) => {
    const authInfo = getAuth(c);

    if (!canCapability(authInfo, "logs.read")) {
      return c.json({ error: readScopeError(authInfo) }, 403);
    }

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
      nextCursor: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
    });
  });

  app.get("/v1/events/:uid", async (c) => {
    const authInfo = getAuth(c);

    if (!canCapability(authInfo, "logs.read")) {
      return c.json({ error: readScopeError(authInfo) }, 403);
    }

    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;
    const uid = c.req.param("uid");

    if (!isUuid(uid)) return c.json({ error: "invalid event id" }, 400);
    const row = await storage.getEventByUid(projectId, uid.toLowerCase());

    if (!row) return c.json({ error: "event not found" }, 404);

    return c.json({ event: toClientEvent(row) });
  });

  app.get("/v1/histogram", async (c) => {
    const authInfo = getAuth(c);

    if (!canCapability(authInfo, "logs.read")) {
      return c.json({ error: readScopeError(authInfo) }, 403);
    }

    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;
    const range = parseRange(c);

    if (range instanceof Response) return range;
    const { from, to } = range;
    const buckets = clampInt(c.req.query("buckets"), 60, 1, 240);
    const bucketMs = Math.max(1000, Math.trunc((to - from) / buckets));

    return c.json({
      from,
      to,
      bucketMs,
      points: await storage.histogramPoints(projectId, from, to, bucketMs),
    });
  });

  app.get("/v1/services", async (c) => {
    const authInfo = getAuth(c);

    if (!canCapability(authInfo, "logs.read")) {
      return c.json({ error: readScopeError(authInfo) }, 403);
    }

    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;

    return c.json({ services: await storage.listServices(projectId) });
  });

  app.get("/v1/stream", async (c) => {
    const authInfo = getAuth(c);

    // The live tail keeps ?key= compatibility for app keys only. MCP clients
    // use request-scoped tools and must not put credentials in a URL.
    if (authInfo.kind === "key" && authInfo.keyType === "mcp") {
      return c.json({ error: "MCP keys cannot open the live stream" }, 403);
    }

    if (!canCapability(authInfo, "logs.read")) {
      return c.json({ error: readScopeError(authInfo) }, 403);
    }

    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;

    const q = c.req.query("q") ?? "";
    const qError = validateQuery(q);

    if (qError) return c.json({ error: qError }, 400);

    if (activeStreams >= MAX_STREAMS) {
      return c.json({ error: "too many live streams — close one and retry" }, 429);
    }

    const identity = streamIdentity(authInfo);

    if ((streamsByIdentity.get(identity) ?? 0) >= MAX_STREAMS_PER_IDENTITY) {
      return c.json({ error: "too many live streams for this account — close one and retry" }, 429);
    }

    if ((streamsByProject.get(projectId) ?? 0) >= MAX_STREAMS_PER_PROJECT) {
      return c.json({ error: "too many live streams for this project — close one and retry" }, 429);
    }

    const f = parseFilters(q);
    const bearerRaw = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const streamKey = bearerRaw || c.req.query("key");

    return streamSSE(c, async (stream) => {
      let closed = false;
      let counted = true;
      let pending = 0;
      let pendingBytes = 0;
      let ticks = 0;
      activeStreams++;
      streamsByIdentity.set(identity, (streamsByIdentity.get(identity) ?? 0) + 1);
      streamsByProject.set(projectId, (streamsByProject.get(projectId) ?? 0) + 1);

      const cleanup = (): void => {
        if (closed) return;
        closed = true;

        if (counted) {
          activeStreams--;
          const identityCount = (streamsByIdentity.get(identity) ?? 1) - 1;

          if (identityCount <= 0) streamsByIdentity.delete(identity);
          else streamsByIdentity.set(identity, identityCount);
          const projectCount = (streamsByProject.get(projectId) ?? 1) - 1;

          if (projectCount <= 0) streamsByProject.delete(projectId);
          else streamsByProject.set(projectId, projectCount);
          counted = false;
        }

        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
      };

      const fail = (err: Error | string): void => {
        if (closed) return;
        console.warn("[kinglet] SSE closed:", err instanceof Error ? err.message : err);
        cleanup();
        // oxlint-disable-next-line promise/no-promise-in-callback
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

          if (!session?.user) return false;
          const role = isRole(session.user.role) ? session.user.role : "viewer";

          const createdAt =
            session.user.createdAt instanceof Date ? session.user.createdAt.getTime() : Date.now();

          const updatedAt =
            session.user.updatedAt instanceof Date ? session.user.updatedAt.getTime() : createdAt;

          const current = userAuth({
            id: String(session.user.id),
            email: session.user.email,
            name: session.user.name ?? "",
            role,
            createdAt,
            updatedAt,
          });

          return can(current, "logs.read") && (await canAccessProject(current, storage, projectId));
        }

        if (authInfo.kind === "key") {
          if (!streamKey) return false;
          const verified = await verifyApiKey(storage, streamKey);

          return Boolean(
            verified &&
            verified.id === authInfo.keyId &&
            verified.keyType === "api" &&
            verified.projectId === projectId &&
            verified.scopes.has("query"),
          );
        }

        return false;
      };

      const unsubscribe = subscribeEvents((rows) => {
        if (closed) return;

        for (const row of rows) {
          if (closed) return;

          if (row.projectId !== projectId) continue;

          if (!matchesEvent(f, row)) continue;

          if (pending >= MAX_PENDING_WRITES || pendingBytes >= MAX_PENDING_BYTES) {
            fail(new Error("slow consumer — stream dropped"));

            return;
          }

          const payload = JSON.stringify(toClientEvent(row));
          const bytes = Buffer.byteLength(payload);

          if (pendingBytes + bytes > MAX_PENDING_BYTES) {
            fail(new Error("slow consumer — stream dropped"));

            return;
          }

          pending++;
          pendingBytes += bytes;
          void stream
            .writeSSE({ data: payload })
            .catch(fail)
            .finally(() => {
              pending--;
              pendingBytes -= bytes;
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

  app.post("/v1/monitors/test-channel", async (c) => {
    // Outbound test sends are user-only: an AI credential must not turn the
    // server into a URL fetcher, even with SSRF checks.
    if (getAuth(c).kind !== "user") return c.json({ error: "user session required" }, 403);

    const denied = monitorGuard(c, true);

    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;
    const parsedBody = await readJsonStrict(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;
    const type = body.type;
    const url = isString(body.url) ? body.url.trim() : "";

    if (type !== "webhook" && type !== "discord" && type !== "slack") {
      return c.json({ error: "type must be webhook, discord, or slack" }, 400);
    }

    const urlError = validateWebhookUrl(url, config.allowPrivateWebhooks);

    if (urlError) return c.json({ error: urlError }, 400);

    const project = await storage.db
      .select({ name: schema.projects.name })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);

    try {
      await sendNotice(
        { type, url },
        {
          monitorId: "test",
          monitorName: "Test channel",
          projectName: project[0]?.name,
          query: "",
          state: "test",
          summary: "Test notification from Kinglet — your channel works.",
          firedAt: Date.now(),
        },
        { allowPrivate: config.allowPrivateWebhooks },
      );

      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[kinglet] test channel failed (${type}):`, message);
      // Internal reachability details stay admin-only, matching monitor tests.
      const authInfo = getAuth(c);
      const detailed = authInfo.kind === "user" && authInfo.user.role === "admin";

      return c.json({ error: detailed ? message : "channel test failed" }, 502);
    }
  });

  app.get("/v1/monitors", async (c) => {
    const denied = monitorGuard(c, false);

    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;
    const monitors = await listMonitors(storage, projectId);
    const authInfo = getAuth(c);
    // Webhook URLs are bearer secrets and engine errors may name internal
    // hosts: only human monitor writers see them. MCP keys never do.
    const canSeeChannels = authInfo.kind === "user" && can(authInfo, "monitors.write");

    return c.json({
      monitors: canSeeChannels
        ? monitors
        : monitors.map((m) => ({
            ...m,
            channels: m.channels.map((ch) => ({ type: ch.type, url: "hidden" })),
            resolvedChannels: m.resolvedChannels.map((channel) => ({
              ...channel,
              health: { ...channel.health, error: null },
            })),
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

    if (getAuth(c).kind === "key" && body.channels !== undefined) {
      return c.json({ error: "MCP monitor writes must use channelIds, not webhook URLs" }, 400);
    }

    const result = await createMonitorFromRaw(storage, projectId, body, {
      allowPrivateWebhooks: config.allowPrivateWebhooks,
    });

    if (!result.ok) return c.json({ error: result.error }, 400);
    await engine.refresh();

    return c.json({ monitor: monitorForAuth(getAuth(c), result.monitor) }, 201);
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

    if (getAuth(c).kind === "key" && body.channels !== undefined) {
      return c.json({ error: "MCP monitor writes must use channelIds, not webhook URLs" }, 400);
    }

    const result = await updateMonitorFromRaw(storage, id, projectId, body, {
      allowPrivateWebhooks: config.allowPrivateWebhooks,
    });

    if (!result.ok) {
      const notFound = "notFound" in result && result.notFound === true;

      return c.json({ error: result.error }, notFound ? 404 : 400);
    }

    await engine.refresh();

    return c.json({ monitor: monitorForAuth(getAuth(c), result.monitor) });
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
    if (getAuth(c).kind !== "user") return c.json({ error: "user session required" }, 403);

    const denied = monitorGuard(c, true);

    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;
    const id = parseId(c.req.param("id"));

    if (id === null) return c.json({ error: "invalid monitor id" }, 400);
    const monitor = await getMonitor(storage, id, projectId);

    if (!monitor) return c.json({ error: "monitor not found" }, 404);

    const project = await storage.db
      .select({ name: schema.projects.name })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);

    const notice: AlertNotice = {
      monitorId: monitor.id,
      monitorName: monitor.name,
      projectName: project[0]?.name,
      query: monitor.query,
      state: "test",
      summary: "Test notification from Kinglet — your channel works.",
      firedAt: Date.now(),
    };

    const authInfo = getAuth(c);
    const detailed = authInfo.kind === "user" && authInfo.user.role === "admin";
    const targets = await resolveMonitorNotifyTargets(storage, monitor);

    const results = await Promise.all(
      targets.map(async (channel) => {
        try {
          await sendNotice(channel, notice, { allowPrivate: config.allowPrivateWebhooks });

          return { type: channel.type, ok: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Internal reachability details are admin-only.
          console.warn(`[kinglet] test notification failed (${channel.type}):`, message);

          return detailed
            ? { type: channel.type, ok: false, error: message }
            : { type: channel.type, ok: false };
        }
      }),
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
    const canSeeErrors = authInfo.kind === "user" && can(authInfo, "monitors.write");

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

    const backup = services?.backupStatus ? await services.backupStatus() : null;

    return c.json({
      ok: true,
      name: "kinglet",
      version: APP_VERSION,
      uptimeMs: Date.now() - systemStatus.startedAt,
      counts: {
        projects: Number(projects[0]?.n ?? 0),
        users: Number(users[0]?.n ?? 0),
        monitors: Number(monitors[0]?.n ?? 0),
        alerts: Number(alerts[0]?.n ?? 0),
        apiKeys: Number(keys[0]?.n ?? 0),
      },
      backup,
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
