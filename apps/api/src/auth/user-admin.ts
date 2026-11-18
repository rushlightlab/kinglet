import { asc, count, eq } from "drizzle-orm";
import type { Storage } from "../storage/index.js";
import * as schema from "../storage/schema.js";
import type { KingletAuth } from "./auth.js";
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
  const rows = await storage.db.select({ n: count() }).from(schema.user).where(eq(schema.user.role, "admin"));
  return Number(rows[0]?.n ?? 0);
}

export async function createManagedUser(
  storage: Storage,
  auth: KingletAuth,
  headers: Headers,
  input: { email: string; name: string; role: Role; password?: string }
): Promise<{ user: AdminUser; password?: string }> {
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
  role: Role
): Promise<void> {
  await auth.api.setRole({
    body: { userId, role: role as "admin" | "user" },
    headers,
  });
  await storage.db.update(schema.user).set({ role }).where(eq(schema.user.id, userId));
}

export async function updateUserName(storage: Storage, userId: string, name: string): Promise<void> {
  await storage.db.update(schema.user).set({ name }).where(eq(schema.user.id, userId));
}

export async function removeManagedUser(
  auth: KingletAuth,
  headers: Headers,
  userId: string
): Promise<void> {
  await auth.api.removeUser({ body: { userId }, headers });
}
