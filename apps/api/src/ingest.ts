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

import { isFiniteNumber, isJsonObject, isString } from "./json.ts";
import type { JsonValue } from "./json.ts";

export interface Normalized {
  ts: number;
  level: number;
  service: string | null;
  env: string | null;
  message: string;
  fields: string | null;
}

const LEVEL_MAP = new Map<string, number>([
  ["trace", 0],
  ["debug", 1],
  ["info", 2],
  ["warn", 3],
  ["warning", 3],
  ["error", 4],
  ["err", 4],
  ["fatal", 5],
  ["critical", 5],
]);

function levelFromName(name: string): number | null {
  return LEVEL_MAP.get(name) ?? null;
}

const MAX_MESSAGE = 8000;
const MAX_FIELDS = 32_768;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_PAST_MS = 31 * 24 * 3_600_000;

export type NormalizedResult = { ok: true; value: Normalized } | { ok: false; error: string };

export function normalizeEvent(raw: JsonValue): NormalizedResult {
  if (!isJsonObject(raw)) {
    return { ok: false, error: "event must be an object" };
  }

  const obj = raw;

  const rawMessage = obj.message ?? obj.msg;

  if (!isString(rawMessage) || rawMessage.trim().length === 0) {
    return { ok: false, error: "missing message" };
  }

  const message = rawMessage.length > MAX_MESSAGE ? rawMessage.slice(0, MAX_MESSAGE) : rawMessage;

  let level = 2; // info
  const rawLevel = obj.level;

  if (isFiniteNumber(rawLevel)) {
    level = Math.min(5, Math.max(0, Math.trunc(rawLevel)));
  } else if (isString(rawLevel)) {
    level = levelFromName(rawLevel.trim().toLowerCase()) ?? 2;
  }

  if (!Number.isInteger(level)) level = 2;

  let ts = Date.now();
  const rawTs = obj.ts ?? obj.time ?? obj.timestamp;

  if (isFiniteNumber(rawTs) && rawTs > 0) {
    // Auto-detect seconds vs milliseconds.
    ts = rawTs < 1e11 ? Math.trunc(rawTs * 1000) : Math.trunc(rawTs);
  } else if (isString(rawTs)) {
    const parsed = Date.parse(rawTs);

    if (!Number.isNaN(parsed)) ts = parsed;
  }

  // Clamp timestamps: future-dated events would otherwise evade retention,
  // and ancient ones pollute the index.
  const now = Date.now();
  ts = Math.min(now + MAX_FUTURE_SKEW_MS, Math.max(now - MAX_PAST_MS, ts));

  const service =
    isString(obj.service) && obj.service.trim()
      ? obj.service.trim().toLowerCase().slice(0, 128)
      : null;

  const env =
    isString(obj.env) && obj.env.trim() ? obj.env.trim().toLowerCase().slice(0, 64) : null;

  let fields: string | null = null;
  const rawFields = obj.fields;

  if (rawFields !== undefined && rawFields !== null) {
    // The documented contract is a JSON object. Arrays were accepted here but
    // dropped by the archive codec, so a later archive/restore silently lost
    // data. Reject them at the boundary instead of storing a shape the rest of
    // the pipeline cannot preserve.
    if (!isJsonObject(rawFields)) {
      return { ok: false, error: "fields must be a JSON object" };
    }

    const serialized = JSON.stringify(rawFields);
    fields =
      serialized.length > MAX_FIELDS ? JSON.stringify({ _kinglet_truncated: true }) : serialized;
  }

  return { ok: true, value: { ts, level, service, env, message, fields } };
}
