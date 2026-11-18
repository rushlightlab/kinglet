import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import type { KingletDb } from "../storage/db.js";
import * as schema from "../storage/schema.js";

/**
 * Better Auth, tuned per the official performance guide:
 *  - `better-auth/minimal` — Drizzle adapter means Kysely is not bundled.
 *  - session cookie cache — signed session cookie (5 min) so getSession does
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
  opts: { baseUrl?: string; port: number; secret: string; trustedProxies?: string[] }
) {
  const rawBase = opts.baseUrl ?? `http://localhost:${opts.port}`;
  let baseOrigin = rawBase;
  try {
    baseOrigin = new URL(rawBase).origin;
  } catch {
    // keep the raw value if it isn't a URL
  }
  const localOrigins = ["localhost", "127.0.0.1"].flatMap((host) =>
    [3000, 5173, 8080].map((port) => `http://${host}:${port}`)
  );
  const trustedProxies = opts.trustedProxies ?? [];

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
      minPasswordLength: 8,
    },
    session: {
      // Performance guide: avoid a database round trip per request.
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    plugins: [admin({ defaultRole: "viewer" })],
    rateLimit: {
      enabled: true,
      window: 60,
      max: 300,
      customRules: {
        "/sign-in/email": { window: 60, max: 20 },
      },
    },
    ...(trustedProxies.length > 0
      ? { advanced: { ipAddress: { trustedProxies } } }
      : {}),
  });
}

export type KingletAuth = ReturnType<typeof createAuth>;
