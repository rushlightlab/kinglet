import { count, eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../env.js";
import type { Storage } from "../storage/index.js";
import * as schema from "../storage/schema.js";
import type { KingletAuth } from "./auth.js";
import { uuidv7 } from "./ids.js";
import { generatePassword } from "./tokens.js";

/**
 * Boot-time setup: the default project and the bootstrap administrator.
 * Better Auth owns users/sessions/passwords; we only promote the first login
 * to the admin role.
 */

export interface BootstrapInfo {
  adminEmail: string;
  /** Only set when the password was generated on this boot. */
  generatedPassword: string | null;
}

export async function ensureSchemaExtras(storage: Storage, timezone: string): Promise<void> {
  const rows = await storage.db.select({ n: count() }).from(schema.projects);

  if (Number(rows[0]?.n ?? 0) === 0) {
    // onConflictDoNothing keeps two instances booting against one libSQL
    // database from racing on the unique slug.
    await storage.db
      .insert(schema.projects)
      .values({ id: uuidv7(), name: "default", slug: "default", createdAt: Date.now() })
      .onConflictDoNothing();
  }

  const now = Date.now();

  await storage.db
    .insert(schema.backupSettings)
    .values({ id: 1, scheduleTimezone: timezone, updatedAt: now })
    .onConflictDoNothing();
  await storage.db
    .insert(schema.archiveSettings)
    .values({ id: 1, scheduleTimezone: timezone, updatedAt: now })
    .onConflictDoNothing();

  const meta = await storage.db
    .select({ value: schema.appMeta.value })
    .from(schema.appMeta)
    .where(eq(schema.appMeta.key, "schema_version"))
    .limit(1);

  const stored = Number(meta[0]?.value ?? 0);

  if (Number.isFinite(stored) && stored > schema.SCHEMA_VERSION) {
    throw new Error(
      `database schema v${stored} is newer than this build (v${schema.SCHEMA_VERSION}); upgrade Kinglet before opening it`,
    );
  }

  await storage.db
    .insert(schema.appMeta)
    .values({ key: "schema_version", value: String(schema.SCHEMA_VERSION) })
    .onConflictDoUpdate({
      target: schema.appMeta.key,
      set: { value: String(schema.SCHEMA_VERSION) },
    });
}

function isRemoteDbPath(dbPath: string): boolean {
  return /^(libsql:\/\/|https?:\/\/|wss?:\/\/)/i.test(dbPath);
}

export async function ensureBootstrapAdmin(
  storage: Storage,
  config: Config,
  auth: KingletAuth,
): Promise<BootstrapInfo | null> {
  // Recover a zero-admin database too (not just a zero-user one), e.g. after
  // a manual role edit or an old admin-plugin bypass.
  const admins = await storage.db
    .select({ banned: schema.user.banned })
    .from(schema.user)
    .where(eq(schema.user.role, "admin"));

  // Recover a database whose only admins are banned as well as a zero-admin
  // database. A banned row must not suppress bootstrap recovery.
  if (admins.some((row) => row.banned !== true)) return null;

  const email = (config.adminEmail ?? "admin@kinglet.local").toLowerCase();
  const generated = config.adminPassword ? null : generatePassword();
  const password = config.adminPassword ?? generated ?? "";

  let userId: string | undefined;
  let createdNow = true;

  try {
    const result = await auth.api.signUpEmail({
      body: { email, password, name: "Administrator" },
    });

    userId = result.user?.id;
  } catch (err) {
    // Concurrent boot or a pre-existing account with this email: promote it
    // instead of failing the whole process.
    const existing = await storage.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);

    userId = existing[0]?.id;
    createdNow = false;

    if (!userId) throw err;
    console.warn(
      `[kinglet] bootstrap: promoted the existing account ${email} to administrator; ` +
        "its current password is unchanged.",
    );
  }

  if (!userId) throw new Error("bootstrap: Better Auth did not return a user id");
  await storage.db
    .update(schema.user)
    .set({ role: "admin", banned: false })
    .where(eq(schema.user.id, userId));

  if (generated && createdNow && !isRemoteDbPath(config.dbPath)) {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(config.dataDir, "admin-password.txt"), generated + "\n", {
        mode: 0o600,
      });
    } catch {
      // banner still shows it
    }
  }

  return { adminEmail: email, generatedPassword: createdNow ? generated : null };
}
