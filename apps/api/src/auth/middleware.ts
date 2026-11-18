import { getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { Config } from "../env.js";
import type { Storage } from "../storage/index.js";
import { verifyApiKey } from "./apikeys.js";
import type { KeyScope, Permission, Role } from "./roles.js";
import { permissionsForRole } from "./roles.js";
import { getSessionUser, sha256hex } from "./users.js";
import type { AuthUser } from "./users.js";

export const SESSION_COOKIE = "kinglet_session";

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

export type AppEnv = { Variables: { auth: AuthInfo } };

export function userAuth(user: AuthUser): AuthInfo {
  return { kind: "user", user, permissions: new Set(permissionsForRole(user.role as Role)) };
}

async function resolveAuth(c: Context, storage: Storage, config: Config): Promise<AuthInfo | null> {
  const header = c.req.header("authorization");
  let bearer: string | undefined;
  if (header?.toLowerCase().startsWith("bearer ")) bearer = header.slice(7).trim();

  // EventSource can't set headers; allow ?key=/?token= as fallbacks.
  if (!bearer) bearer = c.req.query("key") ?? c.req.query("token");

  if (bearer) {
    const key = await verifyApiKey(storage, bearer);
    if (key) {
      return { kind: "key", keyId: key.id, name: key.name, projectId: key.projectId, scopes: key.scopes };
    }
    const sha = sha256hex(bearer);
    if (config.tokens.some((t) => sha256hex(t) === sha)) return { kind: "legacy" };
    return null;
  }

  const session = getCookie(c, SESSION_COOKIE);
  if (session) {
    const user = await getSessionUser(storage, session);
    if (user) return userAuth(user);
  }
  return null;
}

const PUBLIC_PATHS = new Set(["/v1/auth/login", "/v1/auth/logout"]);

export function authMiddleware(storage: Storage, config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const auth = await resolveAuth(c, storage, config);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    c.set("auth", auth);
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
  const rows = await storage.sql.all("SELECT id FROM projects ORDER BY id ASC LIMIT 1");
  const row = rows[0];
  return row ? Number(row.id) : null;
}

export async function projectExists(storage: Storage, id: number): Promise<boolean> {
  const rows = await storage.sql.all("SELECT id FROM projects WHERE id = ?", [id]);
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
