import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type StorageKindSetting = "auto" | "sqlite" | "libsql";

export type BackupSse = "AES256" | "aws:kms" | "none";

export interface BackupConfig {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  prefix: string;
  forcePathStyle: boolean;
  sse: BackupSse;
  kmsKeyId?: string;
  passphrase?: string;
  partSizeBytes: number;
}

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
  retentionDays: number;
  /** Days to keep alert history rows. */
  alertRetentionDays: number;
  /** Session lifetime for the web UI. */
  sessionDays: number;
  /** Hard cap on stored events per project; 0 disables the cap. */
  maxEventsPerProject: number;
  /** Hard cap on stored bytes per project; 0 disables the cap. */
  maxProjectBytes: number;
  /** Hard cap on the local database size in bytes; 0 disables the cap. */
  maxDbBytes: number;
  /** Optional bootstrap administrator identity (when no administrator exists). */
  adminEmail?: string;
  adminPassword?: string;
  /** Default timezone for backup and archive schedules. */
  timezone: string;
  /** S3 backup settings, or null when the feature is not configured. */
  backup: BackupConfig | null;
  /** Missing/invalid variable names when backup configuration is partial. */
  backupProblem: string | null;
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

const BACKUP_S3_VARS = [
  ["bucket", "KINGLET_BACKUP_S3_BUCKET"],
  ["endpoint", "KINGLET_BACKUP_S3_ENDPOINT"],
  ["accessKeyId", "KINGLET_BACKUP_S3_ACCESS_KEY_ID"],
  ["secretAccessKey", "KINGLET_BACKUP_S3_SECRET_ACCESS_KEY"],
] as const;

function resolveTimezone(): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const raw = process.env.KINGLET_TIMEZONE?.trim();

  if (!raw) return fallback;

  try {
    Intl.DateTimeFormat("en-US", { timeZone: raw }).format(0);

    return raw;
  } catch {
    console.warn(`[kinglet] invalid KINGLET_TIMEZONE "${raw}"; using ${fallback}`);

    return fallback;
  }
}

interface BackupConfigResolution {
  backup: BackupConfig | null;
  problem: string | null;
}

/**
 * Feature detection for S3 backups. None configured is silent; a partial set
 * returns the variable names (never values) so boot can warn exactly once.
 */
function resolveBackupConfig(): BackupConfigResolution {
  const values = {
    bucket: process.env.KINGLET_BACKUP_S3_BUCKET?.trim() ?? "",
    endpoint: process.env.KINGLET_BACKUP_S3_ENDPOINT?.trim() ?? "",
    accessKeyId: process.env.KINGLET_BACKUP_S3_ACCESS_KEY_ID?.trim() ?? "",
    secretAccessKey: process.env.KINGLET_BACKUP_S3_SECRET_ACCESS_KEY?.trim() ?? "",
  };

  if (!BACKUP_S3_VARS.some(([field]) => values[field] !== "")) {
    return { backup: null, problem: null };
  }

  const missing: string[] = [];

  for (const [field, name] of BACKUP_S3_VARS) {
    if (values[field] === "") missing.push(name);
  }

  if (missing.length > 0) {
    return { backup: null, problem: `missing ${missing.join(", ")}` };
  }

  try {
    const endpoint = new URL(values.endpoint);

    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      return { backup: null, problem: "KINGLET_BACKUP_S3_ENDPOINT must be an http(s) URL" };
    }
  } catch {
    return { backup: null, problem: "KINGLET_BACKUP_S3_ENDPOINT is not a valid URL" };
  }

  const rawSse = (process.env.KINGLET_BACKUP_S3_SSE?.trim() || "AES256").toLowerCase();

  const sse: BackupSse | null =
    rawSse === "aes256"
      ? "AES256"
      : rawSse === "aws:kms"
        ? "aws:kms"
        : rawSse === "none"
          ? "none"
          : null;

  if (sse === null) {
    return {
      backup: null,
      problem: "KINGLET_BACKUP_S3_SSE must be AES256, aws:kms, or none",
    };
  }

  const kmsKeyId = process.env.KINGLET_BACKUP_S3_KMS_KEY_ID?.trim() || undefined;

  if (sse === "aws:kms" && !kmsKeyId) {
    return {
      backup: null,
      problem: "KINGLET_BACKUP_S3_KMS_KEY_ID is required with aws:kms",
    };
  }

  const partMb = Number.parseInt(process.env.KINGLET_BACKUP_PART_SIZE_MB ?? "8", 10);

  const partSizeMb = Number.isFinite(partMb) ? Math.max(5, partMb) : 8;

  const prefix = (process.env.KINGLET_BACKUP_S3_PREFIX?.trim() || "kinglet").replace(
    /^\/+|\/+$/g,
    "",
  );

  return {
    backup: {
      bucket: values.bucket,
      endpoint: values.endpoint,
      region: process.env.KINGLET_BACKUP_S3_REGION?.trim() || "auto",
      accessKeyId: values.accessKeyId,
      secretAccessKey: values.secretAccessKey,
      sessionToken: process.env.KINGLET_BACKUP_S3_SESSION_TOKEN?.trim() || undefined,
      prefix: prefix || "kinglet",
      forcePathStyle: ["1", "true", "yes"].includes(
        (process.env.KINGLET_BACKUP_S3_FORCE_PATH_STYLE ?? "").toLowerCase(),
      ),
      sse,
      kmsKeyId,
      passphrase: process.env.KINGLET_BACKUP_PASSPHRASE?.trim() || undefined,
      partSizeBytes: partSizeMb * 1024 * 1024,
    },
    problem: null,
  };
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
        "Set BETTER_AUTH_SECRET explicitly for multi-instance or read-only data dirs.",
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
  const { backup, problem: backupProblem } = resolveBackupConfig();

  return {
    port,
    dbPath,
    storageKind: storageKindEnv(),
    dbAuthToken,
    baseUrl,
    allowPrivateWebhooks: ["1", "true", "yes"].includes(
      (process.env.KINGLET_ALLOW_PRIVATE_WEBHOOKS ?? "").toLowerCase(),
    ),
    authSecret: resolveAuthSecret(dataDir),
    trustedProxies: (process.env.KINGLET_TRUSTED_PROXIES ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    dataDir,
    retentionDays: intEnv("KINGLET_RETENTION_DAYS", 14),
    alertRetentionDays: intEnv("KINGLET_ALERT_RETENTION_DAYS", 90),
    sessionDays: intEnv("KINGLET_SESSION_DAYS", 30),
    maxEventsPerProject: nonNegativeIntEnv("KINGLET_MAX_EVENTS_PER_PROJECT", 1_000_000),
    maxProjectBytes: nonNegativeIntEnv("KINGLET_MAX_PROJECT_DB_MB", 1024) * 1024 * 1024,
    maxDbBytes: nonNegativeIntEnv("KINGLET_MAX_DB_MB", 4096) * 1024 * 1024,
    adminEmail: process.env.KINGLET_ADMIN_EMAIL?.trim() || undefined,
    adminPassword: process.env.KINGLET_ADMIN_PASSWORD?.trim() || undefined,
    timezone: resolveTimezone(),
    backup,
    backupProblem,
  };
}
