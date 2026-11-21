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
  "backups.read",
  "backups.write",
  "backups.restore",
  "notifications.read",
  "notifications.write",
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

const ROLE_SET = new Set<string>(ROLES);

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLE_SET.has(value);
}

export function permissionsForRole(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export const KEY_TYPES = ["api", "mcp"] as const;

export type KeyType = (typeof KEY_TYPES)[number];

const KEY_TYPE_SET = new Set<string>(KEY_TYPES);

export function isKeyType(value: unknown): value is KeyType {
  return typeof value === "string" && KEY_TYPE_SET.has(value);
}

/** Standard API keys (kl_) — services that ingest or query. */
export const KEY_SCOPES = ["ingest", "query"] as const;

export type KeyScope = (typeof KEY_SCOPES)[number];

const KEY_SCOPE_SET = new Set<string>(KEY_SCOPES);

export function isKeyScope(value: unknown): value is KeyScope {
  return typeof value === "string" && KEY_SCOPE_SET.has(value);
}

/** MCP keys (km_) — AI clients; disjoint from API key scopes by design. */
export const MCP_KEY_SCOPES = ["logs.read", "monitors.read", "monitors.write"] as const;

export type McpKeyScope = (typeof MCP_KEY_SCOPES)[number];

const MCP_KEY_SCOPE_SET = new Set<string>(MCP_KEY_SCOPES);

export function isMcpKeyScope(value: unknown): value is McpKeyScope {
  return typeof value === "string" && MCP_KEY_SCOPE_SET.has(value);
}

export type AnyKeyScope = KeyScope | McpKeyScope;

function isAnyKeyScope(value: unknown): value is AnyKeyScope {
  return isKeyScope(value) || isMcpKeyScope(value);
}

export function scopesForType(type: KeyType): readonly AnyKeyScope[] {
  return type === "mcp" ? MCP_KEY_SCOPES : KEY_SCOPES;
}

/** Validates a scope list for a key type; returns null when any entry is invalid. */
export function validateKeyScopes(type: KeyType, values: readonly unknown[]): AnyKeyScope[] | null {
  const allowed = new Set<string>(scopesForType(type));
  const scopes: AnyKeyScope[] = [];

  for (const value of values) {
    if (!isAnyKeyScope(value) || !allowed.has(value)) return null;

    if (!scopes.includes(value)) scopes.push(value);
  }

  if (type === "mcp" && scopes.includes("monitors.write") && !scopes.includes("monitors.read")) {
    scopes.push("monitors.read");
  }

  return scopes;
}
