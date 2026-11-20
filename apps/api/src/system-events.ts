/**
 * In-process event feed for long-running admin work (backups, restore, archive).
 * Unlike the ingest bus, subscribers are authenticated admins and events are
 * low-volume. Progress is throttled so a fast upload cannot flood the UI.
 */

export type BackupTrigger = "scheduled" | "manual" | "catch-up";

export type BackupPhase = "snapshot" | "compress" | "encrypt" | "upload" | "verify" | "retention";

export interface SystemStatusSnapshot {
  backup: {
    configured: boolean;
    enabled: boolean;
    running: boolean;
    phase: BackupPhase | null;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    nextRunAt: number | null;
    lastError?: string | null;
    databaseBytes?: number | null;
    setupMissing?: string[];
    /** Snapshot id when a restore is staged and waiting for restart. */
    restoreStagedId?: string | null;
  };
  archive: {
    enabled: boolean;
    running: boolean;
    lastRunAt: number | null;
    lastError: string | null;
  };
}

export type SystemEventInput =
  | { type: "system.status"; data: SystemStatusSnapshot }
  | { type: "backup.queued"; data: { runId: string; trigger: BackupTrigger } }
  | { type: "backup.started"; data: { runId: string; trigger: BackupTrigger } }
  | {
      type: "backup.progress";
      data: { runId: string; phase: BackupPhase; done?: number; total?: number };
    }
  | {
      type: "backup.succeeded";
      data: { runId: string; id: string; sizeBytes: number; durationMs: number };
    }
  | { type: "backup.failed"; data: { runId: string; phase: BackupPhase; error: string } }
  | { type: "backup.deleted"; data: { id: string; reason: string } }
  | { type: "restore.staged"; data: { id: string } }
  | {
      type: "archive.progress";
      data: { projectId: string; phase: string; done?: number; total?: number };
    }
  | { type: "archive.succeeded"; data: { projectId: string; events: number; bytes: number } }
  | { type: "archive.failed"; data: { projectId: string; error: string } };

export type SystemEvent = SystemEventInput & { at: number };

export type SystemEventListener = (event: SystemEvent) => void;

const listeners = new Set<SystemEventListener>();

const THROTTLE_MS = 250;

interface ThrottleState {
  lastSentAt: number;
  timer: NodeJS.Timeout | null;
  pending: SystemEvent | null;
}

const throttles = new Map<string, ThrottleState>();

function emit(event: SystemEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      // One broken SSE client must not stop the others.
      console.warn(
        "[kinglet] system event listener failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

function throttleKey(event: SystemEvent): string | null {
  if (event.type === "backup.progress") {
    return `backup:${event.data.runId}:${event.data.phase}`;
  }

  if (event.type === "archive.progress") return `archive:${event.data.projectId}`;

  return null;
}

function dropThrottles(prefix: string): void {
  for (const [key, state] of throttles) {
    if (!key.startsWith(prefix)) continue;

    if (state.timer) clearTimeout(state.timer);
    throttles.delete(key);
  }
}

/** Publish an event immediately, or coalesce progress to ~4 per second. */
export function publishSystemEvent(input: SystemEventInput): void {
  const event: SystemEvent = { ...input, at: Date.now() };

  if (event.type === "backup.succeeded" || event.type === "backup.failed") {
    dropThrottles(`backup:${event.data.runId}:`);
  } else if (event.type === "archive.succeeded" || event.type === "archive.failed") {
    dropThrottles(`archive:${event.data.projectId}`);
  }

  const key = throttleKey(event);

  if (key === null) {
    emit(event);

    return;
  }

  const now = Date.now();
  const state = throttles.get(key);

  if (!state) {
    throttles.set(key, { lastSentAt: now, timer: null, pending: null });
    emit(event);

    return;
  }

  state.pending = event;

  if (now - state.lastSentAt >= THROTTLE_MS) {
    state.lastSentAt = now;
    const pending = state.pending;
    state.pending = null;

    if (pending) emit(pending);

    return;
  }

  if (state.timer) return;
  state.timer = setTimeout(
    () => {
      state.timer = null;
      const pending = state.pending;
      state.pending = null;

      if (pending) {
        state.lastSentAt = Date.now();
        emit(pending);
      }
    },
    Math.max(0, THROTTLE_MS - (now - state.lastSentAt)),
  );
  state.timer.unref();
}

export function subscribeSystemEvents(listener: SystemEventListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** SSE frame for one event. `type` is the SSE event name. */
export function formatSystemEvent(event: SystemEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify({ ...event.data, at: event.at })}\n\n`;
}
