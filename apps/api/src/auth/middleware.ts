import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { Storage } from "../storage/index.js";
import * as schema from "../storage/schema.js";
import { verifyApiKey } from "./apikeys.js";
import type { KingletAuth } from "./auth.js";
import type { KeyScope, Permission, Role } from "./roles.js";
import { isRole, permissionsForRole } from "./roles.js";
import { isUuid } from "./ids.js";

export type AuthInfo =
  | {
      kind: "user";
      user: AuthUser;
      permissions: Set<Permission>;
    }
  | {
      kind: "key";
      keyId: string;
      name: string;
      projectId: string;
      scopes: Set<KeyScope>;
    };

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
  updatedAt: number;
}

export type AppEnv = { Variables: { auth: AuthInfo } };

interface SessionRequest {
  headers: Headers;
  query?: { disableCookieCache: boolean };
}

export function userAuth(user: AuthUser): AuthInfo {
  return { kind: "user", user, permissions: new Set(permissionsForRole(user.role)) };
}

async function resolveAuth(
  c: Context,
  storage: Storage,
  auth: KingletAuth,
  forceFreshSession: boolean,
): Promise<AuthInfo | null> {
  const header = c.req.header("authorization");
  let bearer: string | undefined;

  if (header?.toLowerCase().startsWith("bearer ")) bearer = header.slice(7).trim();

  // EventSource can't set headers; the API key query parameter is accepted
  // ONLY for the SSE route so keys don't leak into access logs elsewhere.
  if (!bearer && c.req.path === "/v1/stream") {
    bearer = c.req.query("key");
  }

  if (bearer) {
    const key = await verifyApiKey(storage, bearer);

    if (!key) return null;

    return {
      kind: "key",
      keyId: key.id,
      name: key.name,
      projectId: key.projectId,
      scopes: key.scopes,
    };
  }

  // Better Auth session — cookieCache makes this a signed-cookie read in the
  // common case, no database round trip. Mutations bypass the cache so a
  // demoted/deleted user cannot keep writing for the cache TTL.
  const sessionRequest: SessionRequest = { headers: c.req.raw.headers };

  if (forceFreshSession) {
    sessionRequest.query = { disableCookieCache: true };
  }

  const session = await auth.api.getSession(sessionRequest);

  if (!session?.user) return null;
  const role = isRole(session.user.role) ? session.user.role : "viewer";

  const createdAt =
    session.user.createdAt instanceof Date ? session.user.createdAt.getTime() : Date.now();

  const updatedAt =
    session.user.updatedAt instanceof Date ? session.user.updatedAt.getTime() : createdAt;

  return userAuth({
    id: String(session.user.id),
    email: session.user.email,
    name: session.user.name ?? "",
    role,
    createdAt,
    updatedAt,
  });
}

export function authMiddleware(storage: Storage, auth: KingletAuth): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const forceFreshSession = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const info = await resolveAuth(c, storage, auth, forceFreshSession);

    if (!info) return c.json({ error: "unauthorized" }, 401);
    c.set("auth", info);
    await next();
  };
}

export function getAuth(c: Context<AppEnv>): AuthInfo {
  return c.get("auth");
}

/** Permission check for session users; API keys never inherit a human role. */
export function can(auth: AuthInfo, permission: Permission): boolean {
  return auth.kind === "user" && auth.permissions.has(permission);
}

export function requirePermission(c: Context<AppEnv>, permission: Permission): Response | null {
  const auth = getAuth(c);

  if (can(auth, permission)) return null;

  return c.json({ error: "forbidden" }, 403);
}

/** The authenticated user for user-only routes (403 for API keys). */
export function requireUser(c: Context<AppEnv>): AuthUser | Response {
  const auth = getAuth(c);

  if (auth.kind !== "user") return c.json({ error: "user session required" }, 403);

  return auth.user;
}

export async function defaultProjectId(storage: Storage): Promise<string | null> {
  const rows = await storage.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .orderBy(schema.projects.id)
    .limit(1);

  return rows[0]?.id ?? null;
}

export async function projectExists(storage: Storage, id: string): Promise<boolean> {
  const rows = await storage.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .limit(1);

  return rows.length > 0;
}

/**
 * Project access rules:
 *  - admins: every project
 *  - API keys: only the project they were minted for
 *  - everyone else: only projects with a project_members row
 */
export async function canAccessProject(
  auth: AuthInfo,
  storage: Storage,
  projectId: string,
): Promise<boolean> {
  if (auth.kind === "key") return auth.projectId === projectId;

  if (auth.user.role === "admin") return true;

  const rows = await storage.db
    .select({ id: schema.projectMembers.id })
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.projectId, projectId),
        eq(schema.projectMembers.userId, auth.user.id),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * Deleting every event in a project is destructive and project-scoped:
 *  - admins always can
 *  - members only with the per-project `canClearLogs` grant
 *  - viewers and API keys never can
 */
export async function canClearProjectLogs(
  auth: AuthInfo,
  storage: Storage,
  projectId: string,
): Promise<boolean> {
  if (auth.kind !== "user") return false;

  if (auth.user.role === "admin") return true;

  // A member demoted to viewer must not keep the grant.
  if (auth.user.role === "viewer") return false;

  const rows = await storage.db
    .select({ canClearLogs: schema.projectMembers.canClearLogs })
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.projectId, projectId),
        eq(schema.projectMembers.userId, auth.user.id),
      ),
    )
    .limit(1);

  return rows[0]?.canClearLogs === true;
}

/**
 * Resolves the project for this request: API keys are bound to theirs;
 * sessions use ?project= only when they are a member (admins bypass), else
 * the first project assigned to them.
 */
export async function resolveProjectId(
  c: Context<AppEnv>,
  storage: Storage,
): Promise<string | Response> {
  const auth = getAuth(c);

  if (auth.kind === "key") return auth.projectId;
  const raw = c.req.query("project");

  if (raw !== undefined) {
    if (!isUuid(raw)) return c.json({ error: "invalid project id" }, 400);
    const id = raw.toLowerCase();

    if (!(await projectExists(storage, id))) return c.json({ error: "project not found" }, 404);

    // 404 (not 403) so non-members cannot probe which project ids exist.
    if (!(await canAccessProject(auth, storage, id))) {
      return c.json({ error: "project not found" }, 404);
    }

    return id;
  }

  if (auth.kind === "user" && auth.user.role !== "admin") {
    const rows = await storage.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .innerJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.projects.id))
      .where(eq(schema.projectMembers.userId, auth.user.id))
      .orderBy(schema.projects.id)
      .limit(1);

    const first = rows[0];

    if (!first) return c.json({ error: "no projects are assigned to your account" }, 409);

    return first.id;
  }

  const fallback = await defaultProjectId(storage);

  if (fallback === null) return c.json({ error: "no projects exist" }, 409);

  return fallback;
}
