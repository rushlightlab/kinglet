import type { ClientEvent } from "./client.ts";

/**
 * Search-result projection. Only these event fields may be returned; the
 * underlying query and cursor identity are unchanged.
 */
export const EVENT_FIELDS = [
  "id",
  "uid",
  "ts",
  "level",
  "service",
  "env",
  "message",
  "fields",
] as const;

export type EventField = (typeof EVENT_FIELDS)[number];

export type ProjectedEvent = Partial<Pick<ClientEvent, EventField>>;

/** Keep only the requested fields; `undefined` preserves the full event. */
export function projectEvent(
  event: ClientEvent,
  fields: readonly EventField[] | undefined,
): ClientEvent | ProjectedEvent {
  if (fields === undefined) return event;

  const projected: ProjectedEvent = {};

  for (const field of fields) {
    switch (field) {
      case "id":
        projected.id = event.id;
        break;
      case "uid":
        projected.uid = event.uid;
        break;
      case "ts":
        projected.ts = event.ts;
        break;
      case "level":
        projected.level = event.level;
        break;
      case "service":
        projected.service = event.service;
        break;
      case "env":
        projected.env = event.env;
        break;
      case "message":
        projected.message = event.message;
        break;
      case "fields":
        projected.fields = event.fields;
        break;
    }
  }

  return projected;
}

/**
 * Cursor for a trimmed list. The index follows the original fetched events so
 * it stays correct even when `id` was projected away.
 */
export function eventIdAtOrBefore(events: readonly ClientEvent[], index: number): number | null {
  for (let i = Math.min(index, events.length - 1); i >= 0; i--) {
    const id = events[i]?.id;

    if (id !== null && id !== undefined) return id;
  }

  return null;
}
