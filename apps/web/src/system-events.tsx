import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { openSystemEvents } from "./api";
import { formatBytes, formatDuration, redactWebhookUrls } from "./format";
import { isJsonObject, isString } from "./json";
import type { JsonObject, JsonValue } from "./json";
import type {
  ArchiveProgress,
  BackupPhase,
  BackupProgress,
  BackupTrigger,
  SystemStatus,
} from "./types";

/**
 * One admin-only SSE connection for the whole app.
 *
 * The server sends named SSE events (`event: backup.progress`), so every
 * listener below is attached with addEventListener. onmessage would only ever
 * see unnamed frames. Reconnects are explicit: the browser's automatic retry
 * would hide an auth failure, so we close and back off ourselves.
 */

const BACKUP_PHASES: readonly string[] = [
  "snapshot",
  "compress",
  "encrypt",
  "upload",
  "verify",
  "retention",
];

const BACKUP_TRIGGERS: readonly string[] = ["scheduled", "manual", "catch-up"];

function isFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBackupPhase(value: JsonValue | undefined): value is BackupPhase {
  return isString(value) && BACKUP_PHASES.includes(value);
}

function isBackupTrigger(value: JsonValue | undefined): value is BackupTrigger {
  return isString(value) && BACKUP_TRIGGERS.includes(value);
}

function readNumber(obj: JsonObject, key: string): number | null {
  const value = obj[key];

  return isFiniteNumber(value) ? value : null;
}

function readString(obj: JsonObject, key: string): string | null {
  const value = obj[key];

  return isString(value) ? value : null;
}

function readStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];

  const values: string[] = [];

  for (const item of value) {
    if (isString(item)) values.push(item);
  }

  return values;
}

function parseJsonObject(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text);

    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readMessage(event: Event): JsonObject | null {
  if (!(event instanceof MessageEvent)) return null;

  if (!isString(event.data)) return null;

  return parseJsonObject(event.data);
}

function parseSystemStatus(data: JsonObject): SystemStatus | null {
  const backup = data.backup;
  const archive = data.archive;

  if (!isJsonObject(backup) || !isJsonObject(archive)) return null;

  return {
    backup: {
      configured: backup.configured === true,
      enabled: backup.enabled === true,
      running: backup.running === true,
      phase: isBackupPhase(backup.phase) ? backup.phase : null,
      lastSuccessAt: readNumber(backup, "lastSuccessAt"),
      lastFailureAt: readNumber(backup, "lastFailureAt"),
      nextRunAt: readNumber(backup, "nextRunAt"),
      lastError: readString(backup, "lastError"),
      databaseBytes: readNumber(backup, "databaseBytes"),
      setupMissing: readStringArray(backup.setupMissing),
      storage: readString(backup, "storage") ?? undefined,
      configState: readString(backup, "configState") ?? undefined,
      restoreStagedId: readString(backup, "restoreStagedId"),
    },
    archive: {
      enabled: archive.enabled === true,
      running: archive.running === true,
      lastRunAt: readNumber(archive, "lastRunAt"),
      lastError: readString(archive, "lastError"),
    },
    at: readNumber(data, "at") ?? Date.now(),
  };
}

function parseBackupProgress(data: JsonObject): BackupProgress | null {
  const runId = readString(data, "runId");
  const phase = data.phase;

  if (!runId || !isBackupPhase(phase)) return null;

  return {
    runId,
    phase,
    done: readNumber(data, "done"),
    total: readNumber(data, "total"),
    at: readNumber(data, "at") ?? Date.now(),
  };
}

function parseArchiveProgress(data: JsonObject): ArchiveProgress | null {
  const projectId = readString(data, "projectId");
  const phase = readString(data, "phase");

  if (!projectId || !phase) return null;

  return {
    projectId,
    phase,
    done: readNumber(data, "done"),
    total: readNumber(data, "total"),
    at: readNumber(data, "at") ?? Date.now(),
  };
}

export interface SystemEventsValue {
  status: SystemStatus | null;
  backupProgress: BackupProgress | null;
  archiveProgress: ArchiveProgress | null;
  /** Snapshot id staged for the next boot, when the server reports one. */
  restoreStagedId: string | null;
  connected: boolean;
  /** Increments on every successful (re)connect; consumers refetch on change. */
  reconnectEpoch: number;
  /** Increments after terminal events so open tables can refetch. */
  refreshToken: number;
  reconnect: () => void;
}

const IDLE_SYSTEM_EVENTS: SystemEventsValue = {
  status: null,
  backupProgress: null,
  archiveProgress: null,
  restoreStagedId: null,
  connected: false,
  reconnectEpoch: 0,
  refreshToken: 0,
  reconnect: () => {},
};

const SystemEventsContext = createContext<SystemEventsValue | null>(null);

/**
 * Panels fall back to their own fetches when no provider is mounted. The
 * provider is admin-only, and a permission granted mid-upgrade must not crash
 * a page before the root reloads /v1/me.
 */
export function useSystemEvents(): SystemEventsValue {
  return useContext(SystemEventsContext) ?? IDLE_SYSTEM_EVENTS;
}

export function SystemEventsProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [archiveProgress, setArchiveProgress] = useState<ArchiveProgress | null>(null);
  const [restoreStagedId, setRestoreStagedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const attemptRef = useRef(0);
  const reconnectRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let retryTimer: number | null = null;

    const bumpRefresh = (): void => {
      setRefreshToken((value) => value + 1);
    };

    // The server reports success, then runs retention cleanup and sends one
    // more progress event for the same run. A finished run must stay finished,
    // or the page shows "running" until the next backup.
    const finishedRuns = new Set<string>();

    const connect = (): void => {
      if (disposed) return;

      const events = openSystemEvents();
      source = events;

      events.addEventListener("open", () => {
        if (disposed) return;
        attemptRef.current = 0;
        setConnected(true);
        setReconnectEpoch((value) => value + 1);
      });

      events.addEventListener("error", () => {
        if (disposed) return;
        setConnected(false);
        events.close();

        if (source === events) source = null;

        attemptRef.current += 1;
        const delay = Math.min(30_000, 2_000 * 2 ** Math.min(attemptRef.current - 1, 4));

        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          connect();
        }, delay);
      });

      events.addEventListener("system.status", (event) => {
        const data = readMessage(event);

        if (!data) return;

        const next = parseSystemStatus(data);

        if (next) {
          setStatus(next);

          setRestoreStagedId(next.backup.restoreStagedId ?? null);
        }
      });

      events.addEventListener("backup.queued", (event) => {
        const data = readMessage(event);

        if (!data) return;

        const runId = readString(data, "runId");
        const trigger = data.trigger;

        if (!runId) return;

        setBackupProgress({
          runId,
          phase: "snapshot",
          done: null,
          total: null,
          at: readNumber(data, "at") ?? Date.now(),
        });

        if (isBackupTrigger(trigger)) {
          toast.info(trigger === "manual" ? "Backup queued" : "Scheduled backup queued", {
            id: `backup-${runId}`,
            description: "The run starts as soon as the backup slot is free.",
          });
        }
      });

      events.addEventListener("backup.started", (event) => {
        const data = readMessage(event);

        if (!data) return;

        const progress = parseBackupProgress(data);

        if (progress && !finishedRuns.has(progress.runId)) setBackupProgress(progress);
      });

      events.addEventListener("backup.progress", (event) => {
        const data = readMessage(event);

        if (!data) return;

        const progress = parseBackupProgress(data);

        if (progress && !finishedRuns.has(progress.runId)) setBackupProgress(progress);
      });

      events.addEventListener("backup.succeeded", (event) => {
        const data = readMessage(event);

        if (!data) return;

        const runId = readString(data, "runId");

        if (!runId) return;

        const sizeBytes = readNumber(data, "sizeBytes");
        const durationMs = readNumber(data, "durationMs");

        finishedRuns.add(runId);
        setBackupProgress(null);
        bumpRefresh();
        toast.success("Backup complete", {
          id: `backup-${runId}`,
          description: [
            sizeBytes === null ? null : formatBytes(sizeBytes),
            durationMs === null ? null : formatDuration(durationMs),
          ]
            .filter((part): part is string => part !== null)
            .join(" · "),
        });
      });

      events.addEventListener("backup.failed", (event) => {
        const data = readMessage(event);

        if (!data) return;

        const runId = readString(data, "runId");
        const error = readString(data, "error") ?? "unknown error";
        const phase = readString(data, "phase");

        if (runId) {
          finishedRuns.add(runId);
          setBackupProgress(null);
          toast.error("Backup failed", {
            id: `backup-${runId}`,
            description: redactWebhookUrls(phase ? `${phase}: ${error}` : error),
          });
        }

        bumpRefresh();
      });

      events.addEventListener("backup.deleted", (event) => {
        const data = readMessage(event);

        if (!data) return;

        const id = readString(data, "id");
        const reason = readString(data, "reason");

        bumpRefresh();

        if (id && reason !== "retention") {
          toast.info("Snapshot deleted", {
            id: `backup-deleted-${id}`,
            description: reason === null ? undefined : redactWebhookUrls(reason),
          });
        }
      });

      events.addEventListener("restore.staged", (event) => {
        const data = readMessage(event);

        if (!data) return;

        const id = readString(data, "id");

        if (id) setRestoreStagedId(id);
        bumpRefresh();
        toast.warning("Restore staged", {
          id: `restore-${id ?? "pending"}`,
          description: "Restart Kinglet to apply the restored database.",
          duration: Number.POSITIVE_INFINITY,
        });
      });

      events.addEventListener("archive.progress", (event) => {
        const data = readMessage(event);

        if (!data) return;

        const progress = parseArchiveProgress(data);

        if (progress) setArchiveProgress(progress);
      });

      events.addEventListener("archive.succeeded", (event) => {
        const data = readMessage(event);

        if (!data) return;

        const projectId = readString(data, "projectId");
        const count = readNumber(data, "events");
        const bytes = readNumber(data, "bytes");

        setArchiveProgress(null);
        bumpRefresh();
        toast.success("Archive part uploaded", {
          id: `archive-${projectId ?? "unknown"}`,
          description: [
            projectId ? `project ${projectId}` : null,
            count === null ? null : `${count} events`,
            bytes === null ? null : formatBytes(bytes),
          ]
            .filter((part): part is string => part !== null)
            .join(" · "),
        });
      });

      events.addEventListener("archive.failed", (event) => {
        const data = readMessage(event);

        if (!data) return;

        const projectId = readString(data, "projectId");
        const error = readString(data, "error") ?? "unknown error";

        setArchiveProgress(null);
        bumpRefresh();
        toast.error("Archive failed", {
          id: `archive-${projectId ?? "unknown"}`,
          description: redactWebhookUrls(error),
        });
      });
    };

    reconnectRef.current = () => {
      if (disposed) return;

      source?.close();
      source = null;

      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }

      attemptRef.current = 0;
      connect();
    };

    connect();

    return () => {
      disposed = true;
      source?.close();
      source = null;

      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }

      setConnected(false);
    };
  }, []);

  const reconnect = useCallback(() => {
    reconnectRef.current();
  }, []);

  const value = useMemo<SystemEventsValue>(
    () => ({
      status,
      backupProgress,
      archiveProgress,
      restoreStagedId,
      connected,
      reconnectEpoch,
      refreshToken,
      reconnect,
    }),
    [
      status,
      backupProgress,
      archiveProgress,
      restoreStagedId,
      connected,
      reconnectEpoch,
      refreshToken,
      reconnect,
    ],
  );

  return <SystemEventsContext.Provider value={value}>{children}</SystemEventsContext.Provider>;
}
