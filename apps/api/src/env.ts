import { randomBytes } from "node:crypto";
import path from "node:path";

export type StorageKindSetting = "auto" | "sqlite" | "libsql";

export interface Config {
  port: number;
  dbPath: string;
  storageKind: StorageKindSetting;
  dbAuthToken?: string;
  /** Public URL, used in alert notification links (e.g. http://logs.example.com). */
  baseUrl?: string;
  /** Directory holding the database file (local stores only). */
  dataDir: string;
  tokens: string[];
  /** Set when no KINGLET_TOKENS were provided: a token generated on first boot. */
  generatedToken: string | null;
  retentionDays: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function storageKindEnv(): StorageKindSetting {
  const raw = process.env.KINGLET_STORAGE?.trim().toLowerCase();
  return raw === "sqlite" || raw === "libsql" ? raw : "auto";
}

export function loadConfig(): Config {
  const port = intEnv("KINGLET_PORT", 3000);
  const dbPath = process.env.KINGLET_DB_PATH?.trim() || "data/kinglet.db";
  const localPath = dbPath.toLowerCase().startsWith("file:") ? dbPath.slice(5) : dbPath;
  const dataDir = path.dirname(path.resolve(localPath));
  const dbAuthToken = process.env.KINGLET_DB_AUTH_TOKEN?.trim() || undefined;
  const baseUrl = process.env.KINGLET_BASE_URL?.trim() || undefined;
  const tokens = (process.env.KINGLET_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const generatedToken = tokens.length === 0 ? `tok_${randomBytes(24).toString("base64url")}` : null;
  if (generatedToken) tokens.push(generatedToken);
  return {
    port,
    dbPath,
    storageKind: storageKindEnv(),
    dbAuthToken,
    baseUrl,
    dataDir,
    tokens,
    generatedToken,
    retentionDays: intEnv("KINGLET_RETENTION_DAYS", 14),
  };
}
