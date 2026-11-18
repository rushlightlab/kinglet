import { and, eq, inArray } from "drizzle-orm";
import type { Storage } from "../storage/index.js";
import * as schema from "../storage/schema.js";
import type { KeyScope } from "./roles.js";
import { isKeyScope } from "./roles.js";
import { randomToken, sha256hex } from "./tokens.js";

/** Kinglet API keys: kl_… — machine credentials scoped per project. */
export const KEY_PREFIX = "kl_";

export interface ApiKey {
  id: number;
  projectId: number;
  name: string;
  /** Display fragment, e.g. "kl_9f2a…c81d" — never the full key. */
  prefix: string;
  scopes: KeyScope[];
  /** User who minted the key, so admins can audit and offboard. */
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface VerifiedKey {
  id: number;
  projectId: number;
  name: string;
  scopes: Set<KeyScope>;
}

function parseScopes(raw: string | null): KeyScope[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isKeyScope) : [];
  } catch {
    return [];
  }
}

export async function listApiKeys(storage: Storage, projectId: number): Promise<ApiKey[]> {
  const rows = await storage.db
    .select({ key: schema.apiKeys, email: schema.user.email })
    .from(schema.apiKeys)
    .leftJoin(schema.user, eq(schema.user.id, schema.apiKeys.createdBy))
    .where(eq(schema.apiKeys.projectId, projectId))
    .orderBy(schema.apiKeys.id);
  return rows.map(({ key: row, email }) => ({
    id: Number(row.id),
    projectId: Number(row.projectId),
    name: row.name,
    prefix: row.prefix,
    scopes: parseScopes(row.scopes),
    createdBy: row.createdBy ?? null,
    createdByEmail: email ?? null,
    createdAt: Number(row.createdAt),
    lastUsedAt: row.lastUsedAt === null ? null : Number(row.lastUsedAt),
  }));
}

export async function createApiKey(
  storage: Storage,
  input: { projectId: number; name: string; scopes: KeyScope[]; createdBy: string | null }
): Promise<{ key: ApiKey; plaintext: string }> {
  const plaintext = KEY_PREFIX + randomToken();
  const prefix = `${plaintext.slice(0, 11)}…${plaintext.slice(-4)}`;
  const now = Date.now();
  const inserted = await storage.db
    .insert(schema.apiKeys)
    .values({
      projectId: input.projectId,
      name: input.name,
      prefix,
      keyHash: sha256hex(plaintext),
      scopes: JSON.stringify(input.scopes),
      createdBy: input.createdBy,
      createdAt: now,
    })
    .returning({ id: schema.apiKeys.id });
  return {
    key: {
      id: Number(inserted[0]?.id ?? 0),
      projectId: input.projectId,
      name: input.name,
      prefix,
      scopes: input.scopes,
      createdBy: input.createdBy,
      createdByEmail: null,
      createdAt: now,
      lastUsedAt: null,
    },
    plaintext,
  };
}

export async function deleteApiKey(storage: Storage, id: number, projectId: number): Promise<boolean> {
  const result = await storage.db
    .delete(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.projectId, projectId)));
  return Number(result.rowsAffected ?? 0) > 0;
}

export async function deleteProjectApiKeys(storage: Storage, projectId: number): Promise<void> {
  await storage.db.delete(schema.apiKeys).where(eq(schema.apiKeys.projectId, projectId));
}

/**
 * Offboarding: keys minted by a user are revoked when that user is demoted or
 * deleted. Returns how many were removed (useful for logs/audit output).
 */
export async function deleteApiKeysByOwner(storage: Storage, userId: string): Promise<number> {
  const result = await storage.db.delete(schema.apiKeys).where(eq(schema.apiKeys.createdBy, userId));
  return Number(result.rowsAffected ?? 0);
}

/** In-memory throttle so hot ingest batches don't UPDATE last_used_at constantly. */
const lastTouch = new Map<number, number>();

export async function verifyApiKey(storage: Storage, plaintext: string): Promise<VerifiedKey | null> {
  if (!plaintext.startsWith(KEY_PREFIX)) return null;
  const rows = await storage.db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.keyHash, sha256hex(plaintext)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Keys are bound to their creator's lifecycle. Revocation on demotion is
  // explicit, but this also closes deleted-user and banned-user windows.
  if (row.createdBy) {
    const owners = await storage.db
      .select({ id: schema.user.id, banned: schema.user.banned })
      .from(schema.user)
      .where(eq(schema.user.id, row.createdBy))
      .limit(1);
    const owner = owners[0];
    if (!owner || owner.banned === true) return null;
  }
  const id = Number(row.id);
  const now = Date.now();
  if (now - (lastTouch.get(id) ?? 0) > 60_000) {
    lastTouch.set(id, now);
    void storage.db
      .update(schema.apiKeys)
      .set({ lastUsedAt: now })
      .where(eq(schema.apiKeys.id, id))
      .catch(() => undefined);
  }
  return {
    id,
    projectId: Number(row.projectId),
    name: row.name,
    scopes: new Set(parseScopes(row.scopes)),
  };
}

void inArray;
