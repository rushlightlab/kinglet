import { randomBytes } from "node:crypto";
import path from "node:path";

export interface Config {
  port: number;
  dbPath: string;
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

export function loadConfig(): Config {
  const port = intEnv("KINGLET_PORT", 3000);
  const dbPath = process.env.KINGLET_DB_PATH?.trim() || "data/kinglet.db";
  const dataDir = path.dirname(path.resolve(dbPath));
  const tokens = (process.env.KINGLET_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const generatedToken = tokens.length === 0 ? `tok_${randomBytes(24).toString("base64url")}` : null;
  if (generatedToken) tokens.push(generatedToken);
  const retentionDays = intEnv("KINGLET_RETENTION_DAYS", 14);
  return { port, dbPath, dataDir, tokens, generatedToken, retentionDays };
}
