import { EventEmitter } from "node:events";
import type { StoredEvent } from "./types.js";

/**
 * Tiny in-process pub/sub: ingest publishes batches, SSE live-tail
 * subscribers receive them. One process, so an EventEmitter is all we need.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0); // unlimited SSE subscribers

export type EventsListener = (rows: StoredEvent[]) => void;

export function publishEvents(rows: StoredEvent[]): void {
  if (rows.length > 0) bus.emit("events", rows);
}

export function subscribeEvents(listener: EventsListener): () => void {
  bus.on("events", listener);
  return () => {
    bus.off("events", listener);
  };
}
