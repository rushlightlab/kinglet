import { asc, eq } from "drizzle-orm";
import type { Storage } from "../storage/index.js";
import * as schema from "../storage/schema.js";
import type { KingletAuth } from "./auth.js";
import { passwordProblem } from "./password.js";
import type { Role } from "./roles.js";
import { isRole } from "./roles.js";
import { generatePassword } from "./tokens.js";

/**
 * Admin user management, backed by Better Auth (password hashing, accounts)
 * and Drizzle (reads, name updates, admin counts). Our /v1/users routes check
 * Kinglet permissions first, then call these with the caller's headers so the
 * admin plugin authorizes the operation.
 */

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

type UserRow = typeof schema.user.$inferSelect;

function toAdminUser(row: UserRow): AdminUser {
  return {
    id: String(row.id),
    email: row.email,
    name: row.name,
    role: isRole(row.role) ? row.role : "viewer",
    disabled: row.banned === true,
    createdAt: new Date(row.createdAt).getTime(),
    updatedAt: new Date(row.updatedAt).getTime(),
  };
}

export async function listUsers(storage: Storage): Promise<AdminUser[]> {
  const rows = await storage.db.select().from(schema.user).orderBy(asc(schema.user.createdAt));

  return rows.map(toAdminUser);
}

export async function getUserById(storage: Storage, id: string): Promise<AdminUser | null> {
  const rows = await storage.db.select().from(schema.user).where(eq(schema.user.id, id)).limit(1);
  const row = rows[0];

  return row ? toAdminUser(row) : null;
}

export async function countAdmins(storage: Storage): Promise<number> {
  const rows = await storage.db
    .select({ banned: schema.user.banned })
    .from(schema.user)
    .where(eq(schema.user.role, "admin"));

  // A banned administrator cannot approve releases, recover the instance, or
  // use any admin-only route. Only active admins count toward the guard.
  return rows.filter((row) => row.banned !== true).length;
}

export async function createManagedUser(
  storage: Storage,
  auth: KingletAuth,
  headers: Headers,
  input: { email: string; name: string; role: Role; password?: string },
): Promise<{ user: AdminUser; password?: string }> {
  if (input.password) {
    const problem = passwordProblem(input.password);

    if (problem) throw new Error(problem);
  }

  const password = input.password ?? generatePassword();

  const created = (await auth.api.createUser({
    body: {
      email: input.email.toLowerCase(),
      password,
      name: input.name || input.email,
      role: input.role as "admin" | "user",
    },
    headers,
  })) as unknown as { user?: { id?: string; email?: string; name?: string } };

  const userId = created.user?.id;

  if (!userId) throw new Error("better-auth did not return a user id");
  // Ensure the role is ours even if the plugin normalized it.
  await storage.db.update(schema.user).set({ role: input.role }).where(eq(schema.user.id, userId));

  const user = await getUserById(storage, userId);

  if (!user) throw new Error("created user not found");

  return { user, ...(input.password ? {} : { password }) };
}

export async function setUserRole(
  storage: Storage,
  auth: KingletAuth,
  headers: Headers,
  userId: string,
  role: Role,
): Promise<void> {
  await auth.api.setRole({
    body: { userId, role: role as "admin" | "user" },
    headers,
  });
  await storage.db.update(schema.user).set({ role }).where(eq(schema.user.id, userId));
  // A role change must take effect now, not after the signed session cookie
  // cache expires. Delete sessions directly: the admin-plugin endpoint can
  // return success without touching rows in some configurations.
  await storage.db.delete(schema.session).where(eq(schema.session.userId, userId));
}

export async function updateUserName(
  storage: Storage,
  userId: string,
  name: string,
): Promise<void> {
  await storage.db.update(schema.user).set({ name }).where(eq(schema.user.id, userId));
}

export async function removeManagedUser(
  auth: KingletAuth,
  headers: Headers,
  userId: string,
): Promise<void> {
  await auth.api.removeUser({ body: { userId }, headers });
}

export async function setManagedUserDisabled(
  storage: Storage,
  auth: KingletAuth,
  headers: Headers,
  userId: string,
  disabled: boolean,
): Promise<AdminUser> {
  if (disabled) {
    await auth.api.banUser({
      body: { userId, banReason: "Disabled by an administrator" },
      headers,
    });
  } else {
    await auth.api.unbanUser({ body: { userId }, headers });
  }

  const user = await getUserById(storage, userId);

  if (!user) throw new Error("user not found after status update");

  return user;
}

/** Generates a compliant password, sets it, and signs the user out everywhere. */
export async function resetManagedUserPassword(
  storage: Storage,
  auth: KingletAuth,
  headers: Headers,
  userId: string,
): Promise<string> {
  const password = generatePassword();
  await auth.api.setUserPassword({ body: { userId, newPassword: password }, headers });
  await storage.db.delete(schema.session).where(eq(schema.session.userId, userId));

  return password;
}
