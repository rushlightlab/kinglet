import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { PASSWORD_MIN_LENGTH } from "./password.ts";
import type { KingletDb } from "../storage/db.ts";
import * as schema from "../storage/schema.ts";

/**
 * Better Auth, tuned per the official performance guide:
 *  - `better-auth/minimal` — Drizzle adapter means Kysely is not bundled.
 *  - session cookie cache — signed session cookie (60s) so getSession does
 *    not hit the database on every request.
 *  - indexes — users.email, sessions.userId + token, accounts.userId,
 *    verifications.identifier are created in the Drizzle schema.
 *
 * Security:
 *  - a real signing secret is always supplied (env override or a persisted
 *    0600 random secret — never Better Auth's public default);
 *  - rate limiting is enabled explicitly (not only when NODE_ENV=production);
 *  - trustedOrigins covers the configured base URL (normalized) and the
 *    documented local ports; X-Forwarded-For is trusted only for the CIDRs
 *    listed in KINGLET_TRUSTED_PROXIES.
 *
 * Roles: the admin plugin owns the `role` column. Kinglet uses
 * admin / member / viewer and enforces its own permission map in the API.
 */
export function createAuth(
  db: KingletDb,
  opts: {
    baseUrl?: string;
    port: number;
    secret: string;
    trustedProxies?: string[];
    sessionDays?: number;
  },
) {
  const rawBase = opts.baseUrl ?? `http://localhost:${opts.port}`;
  let baseOrigin = rawBase;
  let baseHost = "";

  try {
    const parsed = new URL(rawBase);
    baseOrigin = parsed.origin;
    baseHost = parsed.hostname;
  } catch {
    // keep the raw value if it isn't a URL
  }

  // Local origins are only trusted for local base URLs (dev + local Docker),
  // never on a production deployment with a real hostname.
  const localOrigins =
    baseHost === "localhost" || baseHost === "127.0.0.1"
      ? ["localhost", "127.0.0.1"].flatMap((host) =>
          [3000, 5173, 8080].map((port) => `http://${host}:${port}`),
        )
      : [];

  const trustedProxies = opts.trustedProxies ?? [];
  const sessionDays = opts.sessionDays ?? 30;

  return betterAuth({
    baseURL: baseOrigin,
    secret: opts.secret,
    trustedOrigins: [baseOrigin, ...localOrigins],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
    },
    session: {
      expiresIn: sessionDays * 86_400,
      // Short cookie cache: fewer DB hits than no cache, but revocation and
      // role changes take effect quickly.
      cookieCache: {
        enabled: true,
        maxAge: 60,
      },
    },
    plugins: [admin({ defaultRole: "viewer" })],
    // HTTP admin endpoints are unused by Kinglet (we call the server API with
    // explicit permission checks); disabling them removes bypass routes.
    disabledPaths: [
      "/admin/set-role",
      "/admin/create-user",
      "/admin/remove-user",
      "/admin/ban-user",
      "/admin/unban-user",
      "/admin/impersonate-user",
      "/admin/stop-impersonating",
      "/admin/list-users",
      "/admin/update-user",
      "/admin/set-user-password",
      "/admin/revoke-user-sessions",
    ],
    rateLimit: {
      enabled: true,
      window: 60,
      max: 300,
      customRules: {
        "/sign-in/email": { window: 60, max: 20 },
      },
    },
    advanced:
      trustedProxies.length > 0
        ? { ipAddress: { trustedProxies } }
        : { ipAddress: { ipAddressHeaders: ["x-kinglet-client-ip"] } },
  });
}

export type KingletAuth = ReturnType<typeof createAuth>;
