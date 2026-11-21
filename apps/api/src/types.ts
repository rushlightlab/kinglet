import { isJsonObject } from "./json.ts";
import type { JsonObject } from "./json.ts";

/** How free-text filters are indexed; see storage/search.ts. */
export type SearchMode = "substring" | "words" | "off";

export const SEARCH_MODES: readonly SearchMode[] = ["substring", "words", "off"];

export const LEVEL_NAMES = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

/** Row shape as stored in a Kinglet store (fields is a JSON string). */
export interface StoredEvent {
  id: number;
  uid: string | null;
  projectId: string;
  apiKeyId: string | null;
  ts: number;
  level: number;
  service: string | null;
  env: string | null;
  message: string;
  fields: string | null;
}

/** Event shape as sent to clients (fields is a parsed object). */
export interface ClientEvent {
  id: number;
  uid: string | null;
  projectId: string;
  apiKeyId: string | null;
  ts: number;
  level: number;
  service: string | null;
  env: string | null;
  message: string;
  fields: JsonObject | null;
}

export function toClientEvent(row: StoredEvent): ClientEvent {
  let fields: JsonObject | null = null;

  if (row.fields) {
    try {
      const parsed: unknown = JSON.parse(row.fields);
      fields = isJsonObject(parsed) ? parsed : null;
    } catch {
      fields = null;
    }
  }

  return {
    id: row.id,
    uid: row.uid,
    projectId: row.projectId,
    apiKeyId: row.apiKeyId,
    ts: row.ts,
    level: row.level,
    service: row.service,
    env: row.env,
    message: row.message,
    fields,
  };
}
