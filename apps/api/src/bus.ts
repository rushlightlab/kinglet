import { EventEmitter } from "node:events";
import type { StoredEvent } from "./types.ts";

/**
 * Tiny in-process pub/sub: ingest publishes batches, SSE live-tail
 * subscribers and match monitors receive them. Project-scoped subscribers only
 * wake for batches containing their project's events.
 */
const bus = new EventEmitter();
const projectListeners = new Map<string, Set<EventsListener>>();

bus.setMaxListeners(0); // unlimited SSE subscribers

export type EventsListener = (rows: StoredEvent[]) => void;

export function publishEvents(rows: StoredEvent[]): void {
  if (rows.length === 0) return;

  bus.emit("events", rows);

  if (projectListeners.size === 0) return;

  const firstProjectId = rows[0]?.projectId;

  if (firstProjectId !== undefined && rows.every((row) => row.projectId === firstProjectId)) {
    const listeners = projectListeners.get(firstProjectId);

    if (!listeners) return;

    for (const listener of listeners) listener(rows);

    return;
  }

  const byProject = new Map<string, StoredEvent[]>();

  for (const row of rows) {
    if (!projectListeners.has(row.projectId)) continue;
    let list = byProject.get(row.projectId);

    if (!list) {
      list = [];
      byProject.set(row.projectId, list);
    }

    list.push(row);
  }

  for (const [projectId, projectRows] of byProject) {
    const listeners = projectListeners.get(projectId);

    if (!listeners) continue;

    for (const listener of listeners) listener(projectRows);
  }
}

export function subscribeEvents(listener: EventsListener): () => void {
  bus.on("events", listener);

  return () => {
    bus.off("events", listener);
  };
}

export function subscribeProjectEvents(projectId: string, listener: EventsListener): () => void {
  let listeners = projectListeners.get(projectId);

  if (!listeners) {
    listeners = new Set();
    projectListeners.set(projectId, listeners);
  }

  listeners.add(listener);

  return () => {
    const current = projectListeners.get(projectId);

    if (!current) return;
    current.delete(listener);

    if (current.size === 0) projectListeners.delete(projectId);
  };
}
