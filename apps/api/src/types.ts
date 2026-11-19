export const LEVEL_NAMES = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

/** Row shape as stored in a Kinglet store (fields is a JSON string). */
export interface StoredEvent {
  id: number;
  projectId: number;
  apiKeyId: number | null;
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
  projectId: number;
  apiKeyId: number | null;
  ts: number;
  level: number;
  service: string | null;
  env: string | null;
  message: string;
  fields: Record<string, unknown> | null;
}

export function toClientEvent(row: StoredEvent): ClientEvent {
  let fields: Record<string, unknown> | null = null;
  if (row.fields) {
    try {
      fields = JSON.parse(row.fields) as Record<string, unknown>;
    } catch {
      fields = null;
    }
  }
  return {
    id: row.id,
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
