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
 * Roles: the admin plugin owns the `role` column. Kinglet uses
 * admin / member / viewer and enforces its own permission map in the API;
 * public self-signup is treated as viewer via `defaultRole`.
 */
export function createAuth(db: KingletDb, opts: { baseUrl?: string; port: number }) {
  const baseURL = opts.baseUrl ?? `http://localhost:${opts.port}`;
  const devOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];

  return betterAuth({
    baseURL,
    trustedOrigins: [baseURL, `http://localhost:${opts.port}`, `http://127.0.0.1:${opts.port}`, ...devOrigins],
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
  });
}

export type KingletAuth = ReturnType<typeof createAuth>;
