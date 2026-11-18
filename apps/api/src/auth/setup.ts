import { count, eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../env.js";
import type { Storage } from "../storage/index.js";
import * as schema from "../storage/schema.js";
import type { KingletAuth } from "./auth.js";
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

export async function ensureSchemaExtras(storage: Storage): Promise<void> {
  const rows = await storage.db.select({ n: count() }).from(schema.projects);
  if (Number(rows[0]?.n ?? 0) === 0) {
    await storage.db
      .insert(schema.projects)
      .values({ name: "default", slug: "default", createdAt: Date.now() });
  }
}

export async function ensureBootstrapAdmin(
  storage: Storage,
  config: Config,
  auth: KingletAuth
): Promise<BootstrapInfo | null> {
  const rows = await storage.db.select({ n: count() }).from(schema.user);
  if (Number(rows[0]?.n ?? 0) > 0) return null;

  const email = (config.adminEmail ?? "admin@kinglet.local").toLowerCase();
  const generated = config.adminPassword ? null : generatePassword();
  const password = config.adminPassword ?? generated ?? "";

  const result = await auth.api.signUpEmail({
    body: { email, password, name: "Administrator" },
  });
  const userId = (result as { user?: { id?: string } }).user?.id;
  if (userId) {
    await storage.db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.id, userId));
  }

  if (generated) {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(path.join(config.dataDir, "admin-password.txt"), generated + "\n");
    } catch {
      // banner still shows it
    }
  }
  return { adminEmail: email, generatedPassword: generated };
}
