import { eq } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { Config } from "../env.js";
import type { Storage } from "../storage/index.js";
import * as schema from "../storage/schema.js";
import { verifyApiKey } from "./apikeys.js";
import type { KingletAuth } from "./auth.js";
import type { KeyScope, Permission, Role } from "./roles.js";
import { isRole, permissionsForRole } from "./roles.js";
import { sha256hex } from "./tokens.js";

export type AuthInfo =
  | {
      kind: "user";
      user: AuthUser;
      permissions: Set<Permission>;
    }
  | {
      kind: "key";
      keyId: number;
      name: string;
      projectId: number;
      scopes: Set<KeyScope>;
    }
  | {
      /** Legacy KINGLET_TOKENS / kinglet.token: all projects, full access. */
      kind: "legacy";
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

export function userAuth(user: AuthUser): AuthInfo {
  return { kind: "user", user, permissions: new Set(permissionsForRole(user.role)) };
}

async function resolveAuth(
  c: Context,
  storage: Storage,
  config: Config,
  auth: KingletAuth,
  forceFreshSession: boolean
): Promise<AuthInfo | null> {
  const header = c.req.header("authorization");
  let bearer: string | undefined;
  if (header?.toLowerCase().startsWith("bearer ")) bearer = header.slice(7).trim();

  // EventSource can't set headers; query credentials are accepted ONLY for
  // the SSE route so tokens don't leak into access logs elsewhere.
  if (!bearer && c.req.path === "/v1/stream") {
    bearer = c.req.query("key") ?? c.req.query("token");
  }

  if (bearer) {
    const key = await verifyApiKey(storage, bearer);
    if (key) {
      return { kind: "key", keyId: key.id, name: key.name, projectId: key.projectId, scopes: key.scopes };
    }
    const sha = sha256hex(bearer);
    if (config.tokens.some((t) => sha256hex(t) === sha)) return { kind: "legacy" };
    return null;
  }

  // Better Auth session — cookieCache makes this a signed-cookie read in the
  // common case, no database round trip. Mutations bypass the cache so a
  // demoted/deleted user cannot keep writing for the cache TTL.
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
    ...(forceFreshSession ? { query: { disableCookieCache: true } } : {}),
  });
  if (!session?.user) return null;
  const role = isRole(session.user.role) ? session.user.role : "viewer";
  const createdAt = session.user.createdAt instanceof Date ? session.user.createdAt.getTime() : Date.now();
  const updatedAt = session.user.updatedAt instanceof Date ? session.user.updatedAt.getTime() : createdAt;
  return userAuth({
    id: String(session.user.id),
    email: session.user.email,
    name: session.user.name ?? "",
    role,
    createdAt,
    updatedAt,
  });
}

export function authMiddleware(
  storage: Storage,
  config: Config,
  auth: KingletAuth
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const forceFreshSession = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const info = await resolveAuth(c, storage, config, auth, forceFreshSession);
    if (!info) return c.json({ error: "unauthorized" }, 401);
    c.set("auth", info);
    await next();
  };
}

export function getAuth(c: Context<AppEnv>): AuthInfo {
  return c.get("auth");
}

/** Permission check for session users; legacy tokens are superusers. */
export function can(auth: AuthInfo, permission: Permission): boolean {
  if (auth.kind === "legacy") return true;
  if (auth.kind === "key") return false;
  return auth.permissions.has(permission);
}

export function requirePermission(c: Context<AppEnv>, permission: Permission): Response | null {
  const auth = getAuth(c);
  if (can(auth, permission)) return null;
  return c.json({ error: "forbidden" }, 403);
}

/** The authenticated user for user-only routes (403 for keys/legacy). */
export function requireUser(c: Context<AppEnv>): AuthUser | Response {
  const auth = getAuth(c);
  if (auth.kind !== "user") return c.json({ error: "user session required" }, 403);
  return auth.user;
}

export async function defaultProjectId(storage: Storage): Promise<number | null> {
  const rows = await storage.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .orderBy(schema.projects.id)
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function projectExists(storage: Storage, id: number): Promise<boolean> {
  const rows = await storage.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .limit(1);
  return rows.length > 0;
}

/**
 * Resolves the project for this request: API keys are bound to theirs,
 * sessions/legacy tokens use ?project= (or the default project).
 */
export async function resolveProjectId(
  c: Context<AppEnv>,
  storage: Storage
): Promise<number | Response> {
  const auth = getAuth(c);
  if (auth.kind === "key") return auth.projectId;
  const raw = c.req.query("project");
  if (raw !== undefined) {
    const id = Math.trunc(Number(raw));
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid project id" }, 400);
    if (!(await projectExists(storage, id))) return c.json({ error: "project not found" }, 404);
    return id;
  }
  const fallback = await defaultProjectId(storage);
  if (fallback === null) return c.json({ error: "no projects exist" }, 409);
  return fallback;
}

/** Unused cookie import guard: Better Auth manages its own cookie names. */
void getCookie;
