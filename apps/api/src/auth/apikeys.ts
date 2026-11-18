import type { Storage } from "../storage/index.js";
import { randomToken } from "./passwords.js";
import { isKeyScope } from "./roles.js";
import type { KeyScope } from "./roles.js";
import { sha256hex } from "./users.js";

/** Kinglet API keys: kl_… — machine credentials scoped per project. */
export const KEY_PREFIX = "kl_";

export interface ApiKey {
  id: number;
  projectId: number;
  name: string;
  /** Display fragment, e.g. "kl_9f2a…c81d" — never the full key. */
  prefix: string;
  scopes: KeyScope[];
  createdAt: number;
  lastUsedAt: number | null;
}

export interface VerifiedKey {
  id: number;
  projectId: number;
  name: string;
  scopes: Set<KeyScope>;
}

function parseScopes(raw: unknown): KeyScope[] {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter(isKeyScope) : [];
  } catch {
    return [];
  }
}

function rowToApiKey(row: Record<string, unknown>): ApiKey {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    name: String(row.name ?? ""),
    prefix: String(row.prefix ?? ""),
    scopes: parseScopes(row.scopes),
    createdAt: Number(row.created_at ?? 0),
    lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
  };
}

export async function listApiKeys(storage: Storage, projectId: number): Promise<ApiKey[]> {
  const rows = await storage.sql.all(
    "SELECT * FROM api_keys WHERE project_id = ? ORDER BY id ASC",
    [projectId]
  );
  return rows.map(rowToApiKey);
}

export async function createApiKey(
  storage: Storage,
  input: { projectId: number; name: string; scopes: KeyScope[]; createdBy: number | null }
): Promise<{ key: ApiKey; plaintext: string }> {
  const plaintext = KEY_PREFIX + randomToken();
  const prefix = `${plaintext.slice(0, 11)}…${plaintext.slice(-4)}`;
  const now = Date.now();
  const info = await storage.sql.run(
    "INSERT INTO api_keys (project_id, name, prefix, key_hash, scopes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [input.projectId, input.name, prefix, sha256hex(plaintext), JSON.stringify(input.scopes), input.createdBy, now]
  );
  return {
    key: {
      id: info.lastInsertRowid ?? 0,
      projectId: input.projectId,
      name: input.name,
      prefix,
      scopes: input.scopes,
      createdAt: now,
      lastUsedAt: null,
    },
    plaintext,
  };
}

export async function deleteApiKey(storage: Storage, id: number, projectId: number): Promise<boolean> {
  const info = await storage.sql.run("DELETE FROM api_keys WHERE id = ? AND project_id = ?", [
    id,
    projectId,
  ]);
  return info.rowsAffected > 0;
}

/** In-memory throttle so hot ingest batches don't UPDATE last_used_at constantly. */
const lastTouch = new Map<number, number>();

export async function verifyApiKey(storage: Storage, plaintext: string): Promise<VerifiedKey | null> {
  if (!plaintext.startsWith(KEY_PREFIX)) return null;
  const rows = await storage.sql.all("SELECT * FROM api_keys WHERE key_hash = ?", [sha256hex(plaintext)]);
  const row = rows[0];
  if (!row) return null;
  const id = Number(row.id);
  const now = Date.now();
  if (now - (lastTouch.get(id) ?? 0) > 60_000) {
    lastTouch.set(id, now);
    void storage.sql.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [now, id]).catch(() => undefined);
  }
  return {
    id,
    projectId: Number(row.project_id),
    name: String(row.name ?? ""),
    scopes: new Set(parseScopes(row.scopes)),
  };
}
