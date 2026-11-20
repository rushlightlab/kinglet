import { createHash } from "node:crypto";
import { isFiniteNumber, isJsonObject, isString } from "../json.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { LEVEL_NAMES } from "../types.ts";
import type { ArchiveEventRow, ArchiveLine } from "./types.ts";

/**
 * NDJSON archive codec, shared by export (`engine.ts`) and import
 * (`import.ts`).
 *
 * The line format is part of the on-disk contract:
 *   {v,uid,sourceId,projectId,ts,level,service,env,message,fields}
 * `level` is a level name. `sourceId` is traceability only; on import SQLite
 * assigns fresh rowids and `uid` is the conflict key.
 */

const LEVEL_NAMES_LIST: readonly string[] = LEVEL_NAMES;

export function archiveLevelName(level: number): string {
  return LEVEL_NAMES_LIST[level] ?? "info";
}

/** Index in LEVEL_NAMES, or -1 for an unknown name. */
export function archiveLevelIndex(name: string): number {
  return LEVEL_NAMES_LIST.indexOf(name.trim().toLowerCase());
}

/**
 * Deterministic UUID-v5-shaped identifier for legacy rows with a null uid.
 *
 * The input is the project id plus the internal source id, so the same archived
 * row always produces the same uid. This makes a crash-and-retry export
 * idempotent and lets an older part be re-imported without duplicating rows.
 * It is not a real RFC 4122 namespace UUID; only stability matters here.
 */
export function synthesizeArchiveUid(projectId: string, sourceId: number): string {
  const hash = createHash("sha1")
    .update(`kinglet-archive-uid:${projectId}:${sourceId}`, "utf8")
    .digest();

  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;

  const hex = hash.toString("hex").slice(0, 32);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

/** UTC date partition for an event timestamp. */
export function archiveDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function eventToArchiveLine(row: ArchiveEventRow, projectId: string): ArchiveLine {
  const uid =
    isString(row.uid) && row.uid.length > 0 ? row.uid : synthesizeArchiveUid(projectId, row.id);

  return {
    v: 1,
    uid,
    sourceId: row.id,
    projectId,
    ts: row.ts,
    level: archiveLevelName(row.level),
    service: row.service,
    env: row.env,
    message: row.message,
    fields: parseFieldsJson(row.fields),
  };
}

/**
 * Parse one line back into the archive contract. Returns null for malformed or
 * unknown-version lines; the importer counts those as skipped instead of
 * aborting a recovery over one damaged line.
 */
export function parseArchiveLine(raw: string): ArchiveLine | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isJsonObject(parsed)) return null;

  if (parsed.v !== 1) return null;

  const uid = parsed.uid;

  if (!isString(uid) || uid.trim() === "") return null;

  const projectId = parsed.projectId;

  if (!isString(projectId) || projectId.trim() === "") return null;

  const sourceId = parsed.sourceId;

  if (!isFiniteNumber(sourceId) || !Number.isSafeInteger(sourceId)) return null;

  const ts = parsed.ts;

  if (!isFiniteNumber(ts) || !Number.isSafeInteger(ts) || ts <= 0) return null;

  const level = parsed.level;

  if (!isString(level) || archiveLevelIndex(level) < 0) return null;

  const message = parsed.message;

  if (!isString(message)) return null;

  const service = nullableString(parsed.service);

  if (service === undefined) return null;

  const env = nullableString(parsed.env);

  if (env === undefined) return null;

  const fields = isJsonObject(parsed.fields) ? parsed.fields : null;

  return {
    v: 1,
    uid,
    sourceId,
    projectId,
    ts,
    level,
    service,
    env,
    message,
    fields,
  };
}

/** undefined = wrong type, null = absent/explicit null. */
function nullableString(value: JsonValue | undefined): string | null | undefined {
  if (value === undefined || value === null) return null;

  return isString(value) ? value : undefined;
}

function parseFieldsJson(raw: string | null): JsonObject | null {
  if (raw === null || raw === "") return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isJsonObject(parsed) ? parsed : null;
}
