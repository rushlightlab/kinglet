import { and, desc, eq, inArray } from "drizzle-orm";
import type { Storage } from "../storage/index.ts";
import * as schema from "../storage/schema.ts";
import type { AnyKeyScope, KeyType } from "./roles.ts";
import { isKeyType, validateKeyScopes } from "./roles.ts";
import { uuidv7 } from "./ids.ts";
import { randomToken, sha256hex } from "./tokens.ts";

/** Kinglet API keys: kl_… — machine credentials scoped per project. */
export const KEY_PREFIX = "kl_";

/** Kinglet MCP keys: km_… — AI client credentials with a disjoint scope set. */
export const MCP_KEY_PREFIX = "km_";

export function keyPrefixFor(keyType: KeyType): string {
  return keyType === "mcp" ? MCP_KEY_PREFIX : KEY_PREFIX;
}

export interface ApiKey {
  id: string;
  projectId: string;
  name: string;
  keyType: KeyType;
  /** Short display fragment, e.g. "kl_9f2a1c3d…" — never the full key. */
  prefix: string;
  scopes: AnyKeyScope[];
  /** User who minted the key, so admins can audit and offboard. */
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface VerifiedKey {
  id: string;
  projectId: string;
  name: string;
  keyType: KeyType;
  scopes: Set<AnyKeyScope>;
  /** The user who minted the key; null for keys with no recorded owner. */
  createdBy: string | null;
}

/** Parses stored scopes; anything invalid for the key type fails closed. */
function parseScopes(raw: string | null, keyType: KeyType): AnyKeyScope[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");

    if (!Array.isArray(parsed)) return [];

    return validateKeyScopes(keyType, parsed) ?? [];
  } catch {
    return [];
  }
}

/** Keep only the identifying head of the token, even for older long prefixes. */
function displayPrefix(stored: string): string {
  const head = stored.split("…")[0] ?? stored;

  return `${head.slice(0, 11)}…`;
}

function newPrefix(plaintext: string): string {
  return `${plaintext.slice(0, 11)}…`;
}

function rowKeyType(row: typeof schema.apiKeys.$inferSelect): KeyType | null {
  return isKeyType(row.keyType) ? row.keyType : null;
}

function toApiKey(row: typeof schema.apiKeys.$inferSelect, email: string | null): ApiKey {
  const keyType = rowKeyType(row) ?? "api";

  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    keyType,
    prefix: displayPrefix(row.prefix),
    scopes: parseScopes(row.scopes, keyType),
    createdBy: row.createdBy ?? null,
    createdByEmail: email ?? null,
    createdAt: Number(row.createdAt),
    lastUsedAt: row.lastUsedAt === null ? null : Number(row.lastUsedAt),
  };
}

export async function listApiKeys(storage: Storage, projectId: string): Promise<ApiKey[]> {
  const rows = await storage.db
    .select({ key: schema.apiKeys, email: schema.user.email })
    .from(schema.apiKeys)
    .leftJoin(schema.user, eq(schema.user.id, schema.apiKeys.createdBy))
    .where(eq(schema.apiKeys.projectId, projectId))
    // Newest first, so a key you just created is on the first page.
    .orderBy(desc(schema.apiKeys.id));

  return rows.map(({ key, email }) => toApiKey(key, email ?? null));
}

export async function getApiKey(
  storage: Storage,
  id: string,
  projectId: string,
): Promise<ApiKey | null> {
  const rows = await storage.db
    .select({ key: schema.apiKeys, email: schema.user.email })
    .from(schema.apiKeys)
    .leftJoin(schema.user, eq(schema.user.id, schema.apiKeys.createdBy))
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.projectId, projectId)))
    .limit(1);

  const row = rows[0];

  return row ? toApiKey(row.key, row.email ?? null) : null;
}

export async function createApiKey(
  storage: Storage,
  input: {
    projectId: string;
    name: string;
    keyType?: KeyType;
    scopes: readonly AnyKeyScope[];
    createdBy: string | null;
  },
): Promise<{ key: ApiKey; plaintext: string }> {
  const keyType = input.keyType ?? "api";
  const scopes = validateKeyScopes(keyType, input.scopes);

  if (!scopes) throw new Error(`invalid scopes for a ${keyType} key`);

  const plaintext = keyPrefixFor(keyType) + randomToken();
  const prefix = newPrefix(plaintext);
  const id = uuidv7();
  const now = Date.now();
  await storage.db.insert(schema.apiKeys).values({
    id,
    projectId: input.projectId,
    name: input.name,
    keyType,
    prefix,
    keyHash: sha256hex(plaintext),
    scopes: JSON.stringify(scopes),
    createdBy: input.createdBy,
    createdAt: now,
  });

  return {
    key: {
      id,
      projectId: input.projectId,
      name: input.name,
      keyType,
      prefix,
      scopes,
      createdBy: input.createdBy,
      createdByEmail: null,
      createdAt: now,
      lastUsedAt: null,
    },
    plaintext,
  };
}

export async function deleteApiKey(
  storage: Storage,
  id: string,
  projectId: string,
): Promise<boolean> {
  const result = await storage.db
    .delete(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.projectId, projectId)));

  return Number(result.rowsAffected ?? 0) > 0;
}

export async function deleteProjectApiKeys(storage: Storage, projectId: string): Promise<void> {
  await storage.db.delete(schema.apiKeys).where(eq(schema.apiKeys.projectId, projectId));
}

/**
 * Change a key's scopes without changing the key itself. The stored key type
 * decides the vocabulary, so an MCP key can never be given ingest/query (or
 * the reverse).
 */
export async function updateApiKeyScopes(
  storage: Storage,
  id: string,
  projectId: string,
  scopes: readonly AnyKeyScope[],
): Promise<boolean> {
  const rows = await storage.db
    .select({ keyType: schema.apiKeys.keyType })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.projectId, projectId)))
    .limit(1);

  const row = rows[0];

  if (!row || !isKeyType(row.keyType)) return false;
  const validated = validateKeyScopes(row.keyType, scopes);

  if (!validated) throw new Error(`invalid scopes for a ${row.keyType} key`);

  const result = await storage.db
    .update(schema.apiKeys)
    .set({ scopes: JSON.stringify(validated) })
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.projectId, projectId)));

  return Number(result.rowsAffected ?? 0) > 0;
}

/**
 * Replace the key material; the old plaintext stops working immediately.
 * The key keeps its type, so an MCP key never rotates into a kl_ token.
 */
export async function rotateApiKey(
  storage: Storage,
  id: string,
  projectId: string,
): Promise<{ plaintext: string; prefix: string } | null> {
  const rows = await storage.db
    .select({ keyType: schema.apiKeys.keyType })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.projectId, projectId)))
    .limit(1);

  const row = rows[0];

  if (!row || !isKeyType(row.keyType)) return null;
  const plaintext = keyPrefixFor(row.keyType) + randomToken();
  const prefix = newPrefix(plaintext);

  const result = await storage.db
    .update(schema.apiKeys)
    .set({ keyHash: sha256hex(plaintext), prefix, lastUsedAt: null })
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.projectId, projectId)));

  if (Number(result.rowsAffected ?? 0) === 0) return null;

  return { plaintext, prefix };
}

/**
 * Offboarding: keys minted by a user are revoked when that user is demoted or
 * deleted. Returns how many were removed (useful for logs/audit output).
 */
export async function deleteApiKeysByOwner(storage: Storage, userId: string): Promise<number> {
  const result = await storage.db
    .delete(schema.apiKeys)
    .where(eq(schema.apiKeys.createdBy, userId));

  return Number(result.rowsAffected ?? 0);
}

/** Project-member offboarding: revoke only the keys this user minted there. */
export async function deleteApiKeysByOwnerInProject(
  storage: Storage,
  userId: string,
  projectId: string,
): Promise<number> {
  const result = await storage.db
    .delete(schema.apiKeys)
    .where(and(eq(schema.apiKeys.createdBy, userId), eq(schema.apiKeys.projectId, projectId)));

  return Number(result.rowsAffected ?? 0);
}

/** In-memory throttle so hot ingest batches don't UPDATE last_used_at constantly. */
const lastTouch = new Map<string, number>();

export async function verifyApiKey(
  storage: Storage,
  plaintext: string,
): Promise<VerifiedKey | null> {
  const isApi = plaintext.startsWith(KEY_PREFIX);
  const isMcp = plaintext.startsWith(MCP_KEY_PREFIX);

  if (!isApi && !isMcp) return null;

  const rows = await storage.db
    .select({
      key: schema.apiKeys,
      ownerId: schema.user.id,
      ownerBanned: schema.user.banned,
      ownerRole: schema.user.role,
      ownerMembership: schema.projectMembers.id,
    })
    .from(schema.apiKeys)
    .leftJoin(schema.user, eq(schema.user.id, schema.apiKeys.createdBy))
    .leftJoin(
      schema.projectMembers,
      and(
        eq(schema.projectMembers.userId, schema.apiKeys.createdBy),
        eq(schema.projectMembers.projectId, schema.apiKeys.projectId),
      ),
    )
    .where(eq(schema.apiKeys.keyHash, sha256hex(plaintext)))
    .limit(1);

  const match = rows[0];

  if (!match) return null;
  const row = match.key;
  const keyType = rowKeyType(row);

  if (!keyType) return null;

  // The prefix is presentation/format, not the lookup key: a stored type that
  // disagrees with the token shape is corrupt and must not authenticate.
  if (keyType === "mcp" ? !isMcp : !isApi) return null;

  // Keys are bound to their creator's lifecycle. Revocation on demotion is
  // explicit, but this also closes deleted-user and banned-user windows.
  if (row.createdBy && (!match.ownerId || match.ownerBanned === true)) {
    return null;
  }

  // A key never outlives its creator's authority to mint it. The offboarding
  // sweeps can be outrun by a create that was authorized just before a
  // demotion, so check the owner's current role and membership here too:
  // admins may hold keys for any project, members only for projects they
  // still belong to, and nobody else may hold keys at all.
  if (row.createdBy) {
    const role = match.ownerRole;
    const allowed = role === "admin" || (role === "member" && match.ownerMembership !== null);

    if (!allowed) return null;
  }

  const id = row.id;
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
    projectId: row.projectId,
    name: row.name,
    keyType,
    scopes: new Set(parseScopes(row.scopes, keyType)),
    createdBy: row.createdBy ?? null,
  };
}

void inArray;
