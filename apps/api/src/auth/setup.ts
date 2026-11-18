import fs from "node:fs";
import path from "node:path";
import type { Config } from "../env.js";
import type { Storage } from "../storage/index.js";
import { generatePassword, hashPassword } from "./passwords.js";
import { countUsers, createUser } from "./users.js";

/**
 * Boot-time setup that the shared schema can't express: the default project
 * and the bootstrap administrator. Project columns/indexes are handled by the
 * storage drivers (ensureProjectColumns) before statements are prepared.
 */

export interface BootstrapInfo {
  adminEmail: string;
  /** Only set when the password was generated on this boot. */
  generatedPassword: string | null;
}

export async function ensureSchemaExtras(storage: Storage): Promise<void> {
  const rows = await storage.sql.all("SELECT COUNT(*) AS n FROM projects");
  if (Number(rows[0]?.n ?? 0) === 0) {
    await storage.sql.run("INSERT INTO projects (name, slug, created_at) VALUES (?, ?, ?)", [
      "default",
      "default",
      Date.now(),
    ]);
  }
}

export async function ensureBootstrapAdmin(
  storage: Storage,
  config: Config
): Promise<BootstrapInfo | null> {
  if ((await countUsers(storage)) > 0) return null;

  const email = config.adminEmail ?? "admin@kinglet.local";
  const generated = config.adminPassword ? null : generatePassword();
  const password = config.adminPassword ?? generated ?? "";
  await createUser(storage, {
    email,
    name: "Administrator",
    role: "admin",
    passwordHash: hashPassword(password),
  });

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
