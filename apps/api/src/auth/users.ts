import { createHash } from "node:crypto";
import type { Storage } from "../storage/index.js";
import { randomToken } from "./passwords.js";
import type { Role } from "./roles.js";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
  updatedAt: number;
}

interface UserRow extends Record<string, unknown> {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  created_at: number;
  updated_at: number;
}

function rowToUser(row: Record<string, unknown>): AuthUser {
  return {
    id: Number(row.id),
    email: String(row.email),
    name: String(row.name ?? ""),
    role: (String(row.role) as Role) ?? "member",
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function countUsers(storage: Storage): Promise<number> {
  const rows = await storage.sql.all("SELECT COUNT(*) AS n FROM users");
  return Number(rows[0]?.n ?? 0);
}

export async function listUsers(storage: Storage): Promise<AuthUser[]> {
  const rows = await storage.sql.all("SELECT * FROM users ORDER BY id ASC");
  return rows.map(rowToUser);
}

export async function getUser(storage: Storage, id: number): Promise<AuthUser | null> {
  const rows = await storage.sql.all("SELECT * FROM users WHERE id = ?", [id]);
  const row = rows[0];
  return row ? rowToUser(row) : null;
}

export async function getUserWithHash(
  storage: Storage,
  email: string
): Promise<{ user: AuthUser; passwordHash: string } | null> {
  const rows = await storage.sql.all("SELECT * FROM users WHERE email = ?", [email.trim()]);
  const row = rows[0] as UserRow | undefined;
  if (!row) return null;
  return { user: rowToUser(row), passwordHash: String(row.password_hash) };
}

export async function createUser(
  storage: Storage,
  input: { email: string; name: string; role: Role; passwordHash: string }
): Promise<AuthUser> {
  const now = Date.now();
  const info = await storage.sql.run(
    "INSERT INTO users (email, name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.email.trim(), input.name.trim(), input.passwordHash, input.role, now, now]
  );
  const id = info.lastInsertRowid ?? 0;
  return {
    id,
    email: input.email.trim(),
    name: input.name.trim(),
    role: input.role,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateUser(
  storage: Storage,
  id: number,
  patch: { name?: string; role?: Role; passwordHash?: string }
): Promise<AuthUser | null> {
  const current = await getUser(storage, id);
  if (!current) return null;
  let passwordHash = patch.passwordHash;
  if (passwordHash === undefined) {
    const rows = await storage.sql.all("SELECT password_hash FROM users WHERE id = ?", [id]);
    passwordHash = String(rows[0]?.password_hash ?? "");
  }
  await storage.sql.run(
    "UPDATE users SET name = ?, role = ?, password_hash = ?, updated_at = ? WHERE id = ?",
    [patch.name ?? current.name, patch.role ?? current.role, passwordHash, Date.now(), id]
  );
  return getUser(storage, id);
}

export async function deleteUser(storage: Storage, id: number): Promise<boolean> {
  await storage.sql.run("DELETE FROM sessions WHERE user_id = ?", [id]);
  const info = await storage.sql.run("DELETE FROM users WHERE id = ?", [id]);
  return info.rowsAffected > 0;
}

export interface SessionInfo {
  user: AuthUser;
}

export async function createSession(
  storage: Storage,
  userId: number,
  sessionDays: number
): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await storage.sql.run(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    [sha256hex(token), userId, now, now + sessionDays * 86_400_000, now]
  );
  return token;
}

export async function getSessionUser(storage: Storage, token: string): Promise<AuthUser | null> {
  const rows = await storage.sql.all(
    "SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
    [sha256hex(token)]
  );
  const row = rows[0];
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await deleteSession(storage, token);
    return null;
  }
  return rowToUser(row);
}

export async function deleteSession(storage: Storage, token: string): Promise<void> {
  await storage.sql.run("DELETE FROM sessions WHERE token_hash = ?", [sha256hex(token)]);
}

export async function deleteExpiredSessions(storage: Storage): Promise<void> {
  await storage.sql.run("DELETE FROM sessions WHERE expires_at < ?", [Date.now()]);
}
