import { randomBytes } from "node:crypto";
import fs from "node:fs";
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
  /** Legacy global ingest tokens (KINGLET_TOKENS) — all projects, full access. */
  tokens: string[];
  /** A token newly generated on this boot (no env tokens, no saved token file). */
  generatedToken: string | null;
  /** A token restored from kinglet.token so restarts don't invalidate clients. */
  savedToken: string | null;
  retentionDays: number;
  /** Session lifetime for the web UI. */
  sessionDays: number;
  /** Optional bootstrap administrator identity (first boot only). */
  adminEmail?: string;
  adminPassword?: string;
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
  let generatedToken: string | null = null;
  let savedToken: string | null = null;
  if (tokens.length === 0) {
    // Reuse the token from a previous boot so restarts (dev or Docker) don't
    // invalidate clients that already saved it.
    const tokenFile = path.join(dataDir, "kinglet.token");
    try {
      const raw = fs.readFileSync(tokenFile, "utf8").trim();
      if (raw) savedToken = raw;
    } catch {
      // no saved token yet — generate below
    }
    if (savedToken) {
      tokens.push(savedToken);
    } else {
      generatedToken = `tok_${randomBytes(24).toString("base64url")}`;
      tokens.push(generatedToken);
    }
  }
  return {
    port,
    dbPath,
    storageKind: storageKindEnv(),
    dbAuthToken,
    baseUrl,
    dataDir,
    tokens,
    generatedToken,
    savedToken,
    retentionDays: intEnv("KINGLET_RETENTION_DAYS", 14),
    sessionDays: intEnv("KINGLET_SESSION_DAYS", 30),
    adminEmail: process.env.KINGLET_ADMIN_EMAIL?.trim() || undefined,
    adminPassword: process.env.KINGLET_ADMIN_PASSWORD?.trim() || undefined,
  };
}
