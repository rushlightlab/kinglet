/**
 * Ingest normalizer. This is the hot path — deliberately hand-written
 * instead of a schema validator, so a few thousand events cost microseconds.
 *
 * Accepts per event:
 *   message | msg   (required string)
 *   level            trace|debug|info|warn|warning|error|err|fatal|critical
 *                     or a number 0-5; unknown levels default to info
 *   ts | time | timestamp   epoch ms, epoch s (auto-detected), or ISO string
 *   service, env     lowercased identifiers
 *   fields           arbitrary JSON object (<= 32KB serialized)
 */

export interface Normalized {
  ts: number;
  level: number;
  service: string | null;
  env: string | null;
  message: string;
  fields: string | null;
}

const LEVEL_MAP: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  warning: 3,
  error: 4,
  err: 4,
  fatal: 5,
  critical: 5,
};

function levelFromName(name: string): number | null {
  return Object.hasOwn(LEVEL_MAP, name) ? (LEVEL_MAP[name] ?? null) : null;
}

const MAX_MESSAGE = 8000;
const MAX_FIELDS = 32_768;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_PAST_MS = 31 * 24 * 3_600_000;

export type NormalizedResult = { ok: true; value: Normalized } | { ok: false; error: string };

export function normalizeEvent(raw: unknown): NormalizedResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "event must be an object" };
  }

  const obj = raw as Record<string, unknown>;

  const rawMessage = obj.message ?? obj.msg;

  if (typeof rawMessage !== "string" || rawMessage.trim().length === 0) {
    return { ok: false, error: "missing message" };
  }

  const message = rawMessage.length > MAX_MESSAGE ? rawMessage.slice(0, MAX_MESSAGE) : rawMessage;

  let level = 2; // info
  const rawLevel = obj.level;

  if (typeof rawLevel === "number" && Number.isFinite(rawLevel)) {
    level = Math.min(5, Math.max(0, Math.trunc(rawLevel)));
  } else if (typeof rawLevel === "string") {
    level = levelFromName(rawLevel.trim().toLowerCase()) ?? 2;
  }

  if (!Number.isInteger(level)) level = 2;

  let ts = Date.now();
  const rawTs = obj.ts ?? obj.time ?? obj.timestamp;

  if (typeof rawTs === "number" && Number.isFinite(rawTs) && rawTs > 0) {
    // Auto-detect seconds vs milliseconds.
    ts = rawTs < 1e11 ? Math.trunc(rawTs * 1000) : Math.trunc(rawTs);
  } else if (typeof rawTs === "string") {
    const parsed = Date.parse(rawTs);

    if (!Number.isNaN(parsed)) ts = parsed;
  }

  // Clamp timestamps: future-dated events would otherwise evade retention,
  // and ancient ones pollute the index.
  const now = Date.now();
  ts = Math.min(now + MAX_FUTURE_SKEW_MS, Math.max(now - MAX_PAST_MS, ts));

  const service =
    typeof obj.service === "string" && obj.service.trim()
      ? obj.service.trim().toLowerCase().slice(0, 128)
      : null;

  const env =
    typeof obj.env === "string" && obj.env.trim()
      ? obj.env.trim().toLowerCase().slice(0, 64)
      : null;

  let fields: string | null = null;

  if (obj.fields !== undefined && obj.fields !== null && typeof obj.fields === "object") {
    const serialized = JSON.stringify(obj.fields);
    fields =
      serialized.length > MAX_FIELDS ? JSON.stringify({ _kinglet_truncated: true }) : serialized;
  }

  return { ok: true, value: { ts, level, service, env, message, fields } };
}
