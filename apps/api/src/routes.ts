import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { Config } from "./env.ts";
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
} from "./auth/apikeys.ts";
import type { KingletAuth } from "./auth/auth.ts";
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
} from "./auth/middleware.ts";
import type { AppEnv, AuthInfo } from "./auth/middleware.ts";
import {
  isKeyType,
  isRole,
  permissionsForRole,
  scopesForType,
  validateKeyScopes,
} from "./auth/roles.ts";
import type { AnyKeyScope, KeyType, Role } from "./auth/roles.ts";
import { isUuid, uuidv7 } from "./auth/ids.ts";
import { canCapability, keyCan } from "./auth/key-capabilities.ts";
import type { KeyCapability } from "./auth/key-capabilities.ts";
import type { BackupStatus } from "./backups/types.ts";
import { deleteArchivedProjectObjects } from "./archive/cleanup.ts";
import { ArchiveError } from "./archive/types.ts";
import { buildKeyContext } from "./mcp/context.ts";
import {
  DEFAULT_AGGREGATE_GROUPS,
  MAX_AGGREGATE_GROUPS,
  isAggregateGroupBy,
  toAggregateGroups,
} from "./aggregate.ts";
import { APP_VERSION } from "./version.ts";
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
} from "./auth/user-admin.ts";
import { publishEvents, subscribeEvents } from "./bus.ts";
import { passwordProblem } from "./auth/password.ts";
import { buildVocabulary } from "./field-vocabulary.ts";
import type { Vocabulary } from "./field-vocabulary.ts";
import { buildWhere, matchesEvent, parseFilters } from "./filters.ts";
import type { Normalized } from "./ingest.ts";
import { normalizeEvent } from "./ingest.ts";
import { isBoolean, isJsonObject, isString } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { validateQueryString } from "./query-validation.ts";
import { eventSizeBytes } from "./storage/events.ts";
import { projectKeyOf } from "./storage/project-keys.ts";
import type { Monitor, MonitorEngine, MonitorKind } from "./monitors.ts";
import {
  alertStateByMonitor,
  pageAlerts,
  createMonitorFromRaw,
  deleteMonitor,
  getAlert,
  getMonitor,
  listMonitors,
  resolveMonitorNotifyTargets,
  updateMonitorFromRaw,
} from "./monitors.ts";
import type { AlertListFilters, AlertRecord } from "./monitors.ts";
import { parseAlertReadFilters } from "./alerts.ts";
import { sendNotice, validateWebhookUrl } from "./notify.ts";
import type { AlertNotice } from "./notify.ts";
import { systemStatus } from "./status.ts";
import { pageList, readPageRequest } from "./paging.ts";
import * as schema from "./storage/schema.ts";
import type { Storage } from "./storage/index.ts";
import { localDbBytes, invalidateDbSizeCache } from "./storage/db-size.ts";
import { toClientEvent } from "./types.ts";

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

  // Trigger-maintained, so this is a primary-key lookup rather than a COUNT(*)
  // over every stored event in the project.
  const rows = await storage.db
    .select({ n: schema.projectUsage.events })
    .from(schema.projectUsage)
    .where(eq(schema.projectUsage.projectId, projectId))
    .limit(1);

  const value = Number(rows[0]?.n ?? 0);
  projectCountCache.set(projectId, { value, expiresAt: now + 30_000 });

  return value;
}

function bumpProjectCount(projectId: string, inserted: number): void {
  const cached = projectCountCache.get(projectId);

  if (cached) cached.value += inserted;
}

/** The UI's words for monitor kinds, so a table search finds "spike" or "silence". */
const MONITOR_KIND_WORDS: Record<MonitorKind, string> = {
  match: "instant match",
  count_above: "spike",
  count_below: "silence",
};

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

/** Autocomplete samples at most this many of the newest events. */
const FIELD_SAMPLE_EVENTS = 1_000;

const FIELD_SAMPLE_WINDOW_MS = 24 * 3_600_000;

/** DELETE /v1/events: what was cleared. `q` is present for a query clear. */
interface ClearResponse {
  deleted: number;
  projectId: string;
  from?: number;
  to?: number;
  q?: string;
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
  // Inline legacy URLs are bearer secrets. Only administrators who can manage
  // shared notification channels see them; other monitor writers get the
  // same URL-free projection as machine keys.
  if (authInfo.kind === "user" && can(authInfo, "notifications.write")) return monitor;

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

function alertForAuth(
  alert: AlertRecord,
  canSeeErrors: boolean,
  canSeeSamples: boolean,
): AlertRecord {
  const projected = {
    ...alert,
    notifyError: canSeeErrors ? alert.notifyError : null,
  };

  if (!canSeeSamples) {
    projected.summary = "log content hidden";
    projected.sampleMessage = null;
  }

  return projected;
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
  services?: {
    backupStatus?: () => Promise<BackupStatus>;
    /**
     * Test/embedding seam for archive object cleanup. Production leaves this
     * undefined and uses the S3-backed implementation.
     */
    deleteArchivedObjects?: typeof deleteArchivedProjectObjects;
  },
): void {
  const deleteArchivedObjects = services?.deleteArchivedObjects ?? deleteArchivedProjectObjects;

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
    const context = await buildKeyContext(
      storage,
      getAuth(c),
      config.retentionDays,
      config.mcpAllowMonitorWrites,
    );

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

    const page = pageList(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        createdAt: Number(r.createdAt),
        canClearLogs: Boolean(r.canClearLogs),
      })),
      readPageRequest((name) => c.req.query(name)),
      (project) => [project.name, project.slug],
    );

    return c.json({ projects: page.items, total: page.total });
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

    // Archived logs live in S3, outside the database transaction. Remove them
    // before the project row so a successful delete does not leave the
    // project's log content behind in the bucket.
    try {
      await deleteArchivedObjects(config, id);
    } catch (cause) {
      if (cause instanceof ArchiveError) return c.json({ error: cause.message }, cause.status);

      console.warn("[kinglet] archived project objects could not be deleted:", String(cause));

      return c.json({ error: "archived project objects could not be deleted" }, 502);
    }

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
      await tx.delete(schema.events).where(eq(schema.events.projectKey, projectKeyOf(id)));
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

    const page = pageList(
      await listUsers(storage),
      readPageRequest((name) => c.req.query(name)),
      (u) => [u.email, u.name, u.role, u.disabled ? "disabled" : "active"],
    );

    return c.json({ users: page.items, total: page.total });
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

    if (disabled === true && userId === me.id) {
      return c.json({ error: "you cannot disable your own account" }, 400);
    }

    // Every check that can reject the request must run before the first write.
    // A combined demote+disable removes the active-admin status either way, so
    // it must not ban the target and then fail the last-admin check.
    const removesActiveAdmin =
      target.role === "admin" &&
      target.disabled === false &&
      ((role !== undefined && role !== "admin") || disabled === true);

    if (removesActiveAdmin && (await countAdmins(storage)) <= 1) {
      return c.json({ error: "cannot demote the last administrator" }, 400);
    }

    const name = isString(body.name) ? body.name.trim().slice(0, 80) : undefined;

    if (name !== undefined) await updateUserName(storage, userId, name);

    // Role changes and their key revocation run before the disable/ban block.
    // If the role change is rejected, nothing else was written; if a later
    // disable fails, the target is already a non-admin, never a banned admin.
    if (role !== undefined && role !== target.role) {
      const demotion = role === "viewer" || (role === "member" && target.role === "admin");

      // Offboarding: a demoted user must not keep machine credentials that
      // outlive their permissions. Revoke before the role change so a failed
      // key deletion leaves the old role in place and the operator can retry.
      if (demotion) {
        try {
          const revoked = await deleteApiKeysByOwner(storage, userId);

          if (revoked > 0)
            console.log(`[kinglet] revoked ${revoked} API key(s) for demoted user ${userId}`);
        } catch {
          return c.json({ error: "could not revoke owned keys; role unchanged" }, 500);
        }
      }

      try {
        await setUserRole(storage, auth, c.req.raw.headers, userId, role);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "could not change role" }, 400);
      }
    }

    if (disabled !== undefined) {
      if (disabled) {
        // Disabling is an offboarding event: keys must not come back on unban.
        // Revoke before the ban so a failed deletion leaves the account active
        // instead of banned with live keys; a failed ban can then be retried.
        try {
          const revoked = await deleteApiKeysByOwner(storage, userId);

          if (revoked > 0)
            console.log(`[kinglet] revoked ${revoked} API key(s) for disabled user ${userId}`);
        } catch {
          return c.json({ error: "could not revoke owned keys; account not disabled" }, 500);
        }
      }

      try {
        await setManagedUserDisabled(storage, auth, c.req.raw.headers, userId, disabled);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "could not update user status" },
          400,
        );
      }
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

    // `type` splits the UI's application and MCP key tables.
    const type = c.req.query("type");

    const keys = (await listApiKeys(storage, projectId)).filter(
      (key) => (type !== "api" && type !== "mcp") || key.keyType === type,
    );

    const page = pageList(
      keys,
      readPageRequest((name) => c.req.query(name)),
      (key) => [key.name, key.prefix, key.createdByEmail, ...key.scopes],
    );

    return c.json({ keys: page.items, total: page.total });
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

    const page = pageList(
      rows
        .filter((r) => r.role !== "admin")
        .map((r) => ({
          userId: String(r.userId),
          email: r.email,
          name: r.name,
          role: isRole(r.role) ? r.role : "viewer",
          canClearLogs: Boolean(r.canClearLogs),
          addedAt: Number(r.addedAt),
        })),
      readPageRequest((name) => c.req.query(name)),
      (m) => [m.email, m.name, m.role, m.canClearLogs ? "can clear logs" : null],
    );

    return c.json({ members: page.items, total: page.total });
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

    // Offboarding a project member must revoke the machine credentials that
    // member minted for this project; otherwise the key outlives the membership.
    // Revoke even when the membership row is already gone so a retry after a
    // partial failure still completes the offboarding.
    const revokedKeys = await deleteApiKeysByOwnerInProject(storage, userId, projectId);

    if (Number(result.rowsAffected ?? 0) === 0) return c.json({ error: "member not found" }, 404);

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

  /**
   * Parses and authorizes a clear-logs request (the delete and its preview):
   * a user session with clear permission on the project, an optional
   * `from`/`to` pair, and an optional Trill query `q`. Unlike reads, the
   * window is not clamped to 31 days; without one, all time.
   */
  async function clearRequest(c: Context): Promise<
    | Response
    | {
        projectId: string;
        email: string;
        range: { from: number; to: number } | undefined;
        q: string;
        filter: SQL;
      }
  > {
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

    const q = (c.req.query("q") ?? "").trim();
    const qError = validateQuery(q);

    if (qError) return c.json({ error: qError }, 400);

    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;

    if (!(await canClearProjectLogs(authInfo, storage, projectId))) {
      return c.json({ error: "forbidden" }, 403);
    }

    const filter = buildWhere(
      parseFilters(q),
      range ?? { from: 0, to: Number.MAX_SAFE_INTEGER },
      projectId,
      storage.searchMode,
    );

    return { projectId, email: authInfo.user.email, range, q, filter };
  }

  // What a clear would delete, so the UI can show it before anything goes.
  // Same parameters and permission as DELETE /v1/events.
  app.get("/v1/events/clear/preview", async (c) => {
    const request = await clearRequest(c);

    if (request instanceof Response) return request;

    const [total, byService, sample] = await Promise.all([
      storage.countEvents(request.filter),
      storage.groupEventCounts(request.filter, "service", 10),
      storage.queryEvents({
        projectId: request.projectId,
        filter: request.filter,
        limit: 5,
        cursor: null,
      }),
    ]);

    return c.json({
      projectId: request.projectId,
      ...request.range,
      q: request.q,
      total,
      services: toAggregateGroups(byService.groups),
      moreServices: byService.truncated,
      sample: sample.map(toClientEvent),
      archive: request.range === undefined && request.q === "",
    });
  });

  // Destructive and project-scoped: admins, or a member explicitly granted
  // `canClearLogs` on this project. API keys can never delete logs.
  app.delete("/v1/events", async (c) => {
    const request = await clearRequest(c);

    if (request instanceof Response) return request;
    const { projectId, range, q } = request;

    const deleted =
      q === ""
        ? await storage.deleteByProject(projectId, range)
        : await storage.deleteMatching(request.filter);

    // An unconditional all-time clear means the project's archived logs too.
    // Range and query clears leave archive parts alone: deleting whole date
    // parts would remove events outside the requested selection.
    if (range === undefined && q === "") {
      try {
        await deleteArchivedObjects(config, projectId);
      } catch (cause) {
        if (cause instanceof ArchiveError) return c.json({ error: cause.message }, cause.status);

        console.warn("[kinglet] archived project objects could not be deleted:", String(cause));

        return c.json({ error: "archived project objects could not be deleted" }, 502);
      }
    }

    projectCountCache.delete(projectId);
    invalidateDbSizeCache();
    console.log(
      `[kinglet] cleared ${deleted} event(s) from project ${projectId}` +
        (range
          ? ` between ${new Date(range.from).toISOString()} and ${new Date(range.to).toISOString()}`
          : " (all time)") +
        (q ? ` matching ${JSON.stringify(q)}` : "") +
        ` (${request.email})`,
    );

    const body: ClearResponse = {
      deleted,
      projectId,
      ...range,
    };

    if (q) body.q = q;

    return c.json(body);
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
    const filter = buildWhere(parseFilters(q), { from, to }, projectId, storage.searchMode);
    const rows = await storage.queryEvents({ projectId, filter, limit, cursor });

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

  app.get("/v1/events/:uid/context", async (c) => {
    const authInfo = getAuth(c);

    if (!canCapability(authInfo, "logs.read")) {
      return c.json({ error: readScopeError(authInfo) }, 403);
    }

    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;
    const uid = c.req.param("uid");

    if (!isUuid(uid)) return c.json({ error: "invalid event id" }, 400);
    const before = clampInt(c.req.query("before"), 5, 0, 20);
    const after = clampInt(c.req.query("after"), 5, 0, 20);
    const context = await storage.getEventContext(projectId, uid.toLowerCase(), before, after);

    if (!context) return c.json({ error: "event not found" }, 404);

    return c.json({
      event: toClientEvent(context.event),
      before: context.before.map(toClientEvent),
      after: context.after.map(toClientEvent),
    });
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
    const q = c.req.query("q") ?? "";
    const qError = validateQuery(q);

    if (qError) return c.json({ error: qError }, 400);

    // Without a query the unfiltered fast path applies; buildWhere scopes the
    // filter to this project and window.
    const filter = q.trim()
      ? buildWhere(parseFilters(q), { from, to }, projectId, storage.searchMode)
      : undefined;

    return c.json({
      from,
      to,
      bucketMs,
      points: await storage.histogramPoints(projectId, from, to, bucketMs, filter),
    });
  });

  // Query autocomplete: the field keys, types, and common values in the newest
  // events of the window (last 24 hours by default), plus services and envs.
  app.get("/v1/fields", async (c) => {
    const authInfo = getAuth(c);

    if (!canCapability(authInfo, "logs.read")) {
      return c.json({ error: readScopeError(authInfo) }, 403);
    }

    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;

    if (c.req.query("from") === undefined && c.req.query("to") === undefined) {
      const now = Date.now();

      return c.json(
        await fieldVocabulary(projectId, { from: now - FIELD_SAMPLE_WINDOW_MS, to: now }),
      );
    }

    const range = parseRange(c);

    if (range instanceof Response) return range;

    return c.json(await fieldVocabulary(projectId, range));
  });

  async function fieldVocabulary(
    projectId: string,
    range: { from: number; to: number },
  ): Promise<Vocabulary & { from: number; to: number }> {
    const rows = await storage.queryEvents({
      projectId,
      filter: buildWhere(parseFilters(""), range, projectId, storage.searchMode),
      limit: FIELD_SAMPLE_EVENTS,
      cursor: null,
    });

    return { ...range, ...buildVocabulary(rows) };
  }

  app.get("/v1/services", async (c) => {
    const authInfo = getAuth(c);

    if (!canCapability(authInfo, "logs.read")) {
      return c.json({ error: readScopeError(authInfo) }, 403);
    }

    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;

    return c.json({ services: await storage.listServices(projectId) });
  });

  app.get("/v1/aggregate", async (c) => {
    const authInfo = getAuth(c);

    if (!canCapability(authInfo, "logs.read")) {
      return c.json({ error: readScopeError(authInfo) }, 403);
    }

    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;

    const q = c.req.query("q") ?? "";
    const qError = validateQuery(q);

    if (qError) return c.json({ error: qError }, 400);

    const groupBy = c.req.query("groupBy");

    if (groupBy !== undefined && !isAggregateGroupBy(groupBy)) {
      return c.json({ error: "groupBy must be one of: service, level, env" }, 400);
    }

    const range = parseRange(c);

    if (range instanceof Response) return range;
    const { from, to } = range;
    const filter = buildWhere(parseFilters(q), { from, to }, projectId, storage.searchMode);

    // Total and grouped counts are intentionally separate reads. A concurrent
    // ingest can make `total` differ from the sum of `groups` transiently.
    const total = await storage.countEvents(filter);

    if (groupBy === undefined) return c.json({ from, to, total });

    const limit = clampInt(c.req.query("limit"), DEFAULT_AGGREGATE_GROUPS, 1, MAX_AGGREGATE_GROUPS);
    const grouped = await storage.groupEventCounts(filter, groupBy, limit);
    const groups = toAggregateGroups(grouped.groups);

    if (grouped.truncated) {
      return c.json({ from, to, total, groupBy, groups, truncated: true });
    }

    return c.json({ from, to, total, groupBy, groups });
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

  // Monitor test sends share the notification-channel cooldown: an operator
  // should not be able to turn a monitor writer into a repeated outbound
  // request loop.
  const monitorTestLocks = new Map<string, number>();
  const MONITOR_TEST_COOLDOWN_MS = 60_000;

  function monitorTestRetryAfter(key: string): number | null {
    const now = Date.now();
    const last = monitorTestLocks.get(key) ?? 0;

    if (last > 0 && now - last < MONITOR_TEST_COOLDOWN_MS) {
      return MONITOR_TEST_COOLDOWN_MS - (now - last);
    }

    monitorTestLocks.set(key, now);

    return null;
  }

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

    const retryAfterMs = monitorTestRetryAfter(`url:${type}:${url}`);

    if (retryAfterMs !== null) {
      c.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));

      return c.json({ error: "channel was tested recently", retryAfterMs }, 429);
    }

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

    const page = pageList(
      await listMonitors(storage, projectId),
      readPageRequest((name) => c.req.query(name)),
      (m) => [
        m.name,
        m.query,
        m.kind,
        MONITOR_KIND_WORDS[m.kind],
        m.enabled ? "enabled" : "paused",
        ...m.resolvedChannels.map((channel) => channel.name),
        ...m.channels.map((channel) => channel.type),
      ],
    );

    const monitors = page.items;

    const alertStates = await alertStateByMonitor(
      storage,
      monitors.map((m) => m.id),
    );

    const withAlerts = <T extends { id: string }>(m: T) => ({
      ...m,
      lastAlertAt: alertStates.get(m.id)?.lastAlertAt ?? null,
      firing: alertStates.get(m.id)?.firing ?? false,
    });

    const authInfo = getAuth(c);
    // Webhook URLs are bearer secrets and engine errors may name internal
    // hosts: only administrators who manage shared channels see them. Other
    // monitor writers and MCP keys get the URL-free projection.
    const canSeeChannels = authInfo.kind === "user" && can(authInfo, "notifications.write");

    return c.json({
      monitors: canSeeChannels
        ? monitors.map(withAlerts)
        : monitors.map((m) =>
            withAlerts({
              ...m,
              channels: m.channels.map((ch) => ({ type: ch.type, url: "hidden" })),
              resolvedChannels: m.resolvedChannels.map((channel) => ({
                ...channel,
                health: { ...channel.health, error: null },
              })),
              lastError: null,
              lastErrorAt: null,
            }),
          ),
      total: page.total,
    });
  });

  app.post("/v1/monitors", async (c) => {
    const denied = monitorGuard(c, true);

    if (denied) return denied;

    if (getAuth(c).kind === "key" && !config.mcpAllowMonitorWrites) {
      return c.json(
        {
          error:
            "MCP monitor writes are disabled; set KINGLET_MCP_ALLOW_MONITOR_WRITES=1 to enable",
        },
        403,
      );
    }

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

    const createAuth = getAuth(c);

    if (
      body.channels !== undefined &&
      !(createAuth.kind === "user" && can(createAuth, "notifications.write"))
    ) {
      return c.json(
        { error: "only administrators can configure legacy inline webhook channels" },
        403,
      );
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

    if (getAuth(c).kind === "key" && !config.mcpAllowMonitorWrites) {
      return c.json(
        {
          error:
            "MCP monitor writes are disabled; set KINGLET_MCP_ALLOW_MONITOR_WRITES=1 to enable",
        },
        403,
      );
    }

    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;
    const id = parseId(c.req.param("id"));

    if (id === null) return c.json({ error: "invalid monitor id" }, 400);
    const parsedBody = await readJsonStrict(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const body = parsedBody.body;

    const updateAuth = getAuth(c);

    if (
      body.channels !== undefined &&
      !(updateAuth.kind === "user" && can(updateAuth, "notifications.write"))
    ) {
      return c.json(
        { error: "only administrators can configure legacy inline webhook channels" },
        403,
      );
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

    if (getAuth(c).kind === "key" && !config.mcpAllowMonitorWrites) {
      return c.json(
        {
          error:
            "MCP monitor writes are disabled; set KINGLET_MCP_ALLOW_MONITOR_WRITES=1 to enable",
        },
        403,
      );
    }

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

    const retryAfterMs = monitorTestRetryAfter(`monitor:${monitor.id}`);

    if (retryAfterMs !== null) {
      c.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));

      return c.json({ error: "monitor was tested recently", retryAfterMs }, 429);
    }

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
          await sendNotice(channel, notice, {
            allowPrivate: config.allowPrivateWebhooks,
            smtp: config.smtp,
          });

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

    const parsed = parseAlertReadFilters({
      monitorId: c.req.query("monitorId"),
      state: c.req.query("state"),
      from: c.req.query("from"),
      to: c.req.query("to"),
    });

    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    if (parsed.filters.monitorId !== null) {
      const monitor = await getMonitor(storage, parsed.filters.monitorId, projectId);

      // No cross-project probing: a monitor outside this project is a 404,
      // exactly like an unknown id.
      if (!monitor) return c.json({ error: "monitor not found" }, 404);
    }

    const limit = clampInt(c.req.query("limit"), 100, 1, 500);
    const alertFilters: AlertListFilters = {};

    if (parsed.filters.monitorId !== null) alertFilters.monitorId = parsed.filters.monitorId;

    if (parsed.filters.state !== null) alertFilters.state = parsed.filters.state;

    if (parsed.filters.from !== null) alertFilters.from = parsed.filters.from;

    if (parsed.filters.to !== null) alertFilters.to = parsed.filters.to;

    // Offset paging for the UI's alert table; `q` searches monitor name,
    // summary, and state (never delivery errors).
    const offset = clampInt(c.req.query("offset"), 0, 0, 1_000_000);

    const { alerts, total } = await pageAlerts(storage, projectId, alertFilters, {
      limit,
      offset,
      q: c.req.query("q"),
    });

    const authInfo = getAuth(c);
    // Delivery errors can name internal endpoints; only administrators see even
    // the sanitized text. Monitor writers and machine keys get null.
    const canSeeErrors = authInfo.kind === "user" && can(authInfo, "users.write");
    const canSeeSamples = canCapability(authInfo, "logs.read");

    return c.json({
      alerts: alerts.map((alert) => alertForAuth(alert, canSeeErrors, canSeeSamples)),
      total,
    });
  });

  app.get("/v1/alerts/:id", async (c) => {
    const denied = monitorGuard(c, false);

    if (denied) return denied;
    const projectId = await resolveProjectId(c, storage);

    if (projectId instanceof Response) return projectId;
    const id = c.req.param("id");

    if (!isUuid(id)) return c.json({ error: "invalid alert id" }, 400);

    const alert = await getAlert(storage, id.toLowerCase(), projectId);

    if (!alert) return c.json({ error: "alert not found" }, 404);
    const authInfo = getAuth(c);
    const canSeeErrors = authInfo.kind === "user" && can(authInfo, "users.write");
    const canSeeSamples = canCapability(authInfo, "logs.read");

    return c.json({ alert: alertForAuth(alert, canSeeErrors, canSeeSamples) });
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
