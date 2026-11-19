/**
 * Roles and permissions.
 *
 * Three built-in roles for now, each mapped to a permission set. Permission
 * checks go through keys like "logs.read", so custom roles later become data
 * (a role row with its own permission list) rather than a refactor.
 *
 * API keys do NOT use roles — they are machine credentials with scopes.
 */

export const ROLES = ["admin", "member", "viewer"] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "logs.read",
  "logs.write",
  "monitors.read",
  "monitors.write",
  "keys.read",
  "keys.write",
  "projects.read",
  "projects.write",
  "users.read",
  "users.write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: [...PERMISSIONS],
  member: [
    "logs.read",
    "logs.write",
    "monitors.read",
    "monitors.write",
    "keys.read",
    "keys.write",
    "projects.read",
  ],
  viewer: ["logs.read", "monitors.read", "projects.read"],
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function permissionsForRole(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export const KEY_SCOPES = ["ingest", "query"] as const;

export type KeyScope = (typeof KEY_SCOPES)[number];

export function isKeyScope(value: unknown): value is KeyScope {
  return typeof value === "string" && (KEY_SCOPES as readonly string[]).includes(value);
}
