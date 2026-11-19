import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type StorageKindSetting = "auto" | "sqlite" | "libsql";

export interface Config {
  port: number;
  dbPath: string;
  storageKind: StorageKindSetting;
  dbAuthToken?: string;
  /** Public URL, used in alert notification links and Better Auth origin checks. */
  baseUrl?: string;
  /** Allow webhook channels that point at private/loopback addresses. */
  allowPrivateWebhooks: boolean;
  /** Secret used to sign sessions/cookies — env override or persisted file. */
  authSecret: string;
  /** Reverse-proxy CIDRs allowed to supply X-Forwarded-For. */
  trustedProxies: string[];
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
  /** Hard cap on stored events per project; 0 disables the cap. */
  maxEventsPerProject: number;
  /** Hard cap on the local database size in bytes; 0 disables the cap. */
  maxDbBytes: number;
  /** Optional bootstrap administrator identity (when no administrator exists). */
  adminEmail?: string;
  adminPassword?: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Like intEnv, but 0 is meaningful (disable the limit). */
function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function storageKindEnv(): StorageKindSetting {
  const raw = process.env.KINGLET_STORAGE?.trim().toLowerCase();
  return raw === "sqlite" || raw === "libsql" ? raw : "auto";
}

/**
 * Better Auth signing secret. Never falls back to a public constant: env
 * override first, then a persisted random secret next to the database
 * (created 0600), so cookie-cache sessions stay valid across restarts.
 */
function resolveAuthSecret(dataDir: string): string {
  const explicit = (process.env.BETTER_AUTH_SECRET ?? process.env.KINGLET_AUTH_SECRET ?? "").trim();
  if (explicit) return explicit;
  const secretFile = path.join(dataDir, "auth-secret.txt");
  try {
    const saved = fs.readFileSync(secretFile, "utf8").trim();
    if (saved) return saved;
  } catch {
    // generate below
  }
  const secret = randomBytes(32).toString("base64url");
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretFile, secret + "\n", { mode: 0o600 });
  } catch (err) {
    console.warn(
      "[kinglet] could not persist the auth secret — sessions will not survive restarts. " +
        "Set BETTER_AUTH_SECRET explicitly for multi-instance or read-only data dirs."
    );
    if (err instanceof Error) console.warn("[kinglet]", err.message);
  }
  return secret;
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
  const legacyDisabled = ["1", "true", "yes"].includes(
    (process.env.KINGLET_DISABLE_LEGACY_TOKENS ?? "").toLowerCase()
  );
  let generatedToken: string | null = null;
  let savedToken: string | null = null;
  if (legacyDisabled) {
    // Machine access must go through scoped kl_ keys; the workspace-wide
    // superuser token is opt-out.
    tokens.length = 0;
  } else if (tokens.length === 0) {
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
    allowPrivateWebhooks: ["1", "true", "yes"].includes((process.env.KINGLET_ALLOW_PRIVATE_WEBHOOKS ?? "").toLowerCase()),
    authSecret: resolveAuthSecret(dataDir),
    trustedProxies: (process.env.KINGLET_TRUSTED_PROXIES ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    dataDir,
    tokens,
    generatedToken,
    savedToken,
    retentionDays: intEnv("KINGLET_RETENTION_DAYS", 14),
    sessionDays: intEnv("KINGLET_SESSION_DAYS", 30),
    maxEventsPerProject: nonNegativeIntEnv("KINGLET_MAX_EVENTS_PER_PROJECT", 1_000_000),
    maxDbBytes: nonNegativeIntEnv("KINGLET_MAX_DB_MB", 4096) * 1024 * 1024,
    adminEmail: process.env.KINGLET_ADMIN_EMAIL?.trim() || undefined,
    adminPassword: process.env.KINGLET_ADMIN_PASSWORD?.trim() || undefined,
  };
}
