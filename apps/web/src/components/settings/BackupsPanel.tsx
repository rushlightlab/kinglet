import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ClockIcon,
  CloudIcon,
  DatabaseIcon,
  DownloadIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  deleteBackup,
  downloadBackup,
  fetchArchiveSettings,
  fetchBackupSettings,
  fetchBackupStatus,
  fetchBackups,
  fetchNotificationChannels,
  previewBackupSchedule,
  restoreBackup,
  runBackup,
  setProjectArchive,
  testBackupConnection,
  updateArchiveSettings,
  updateBackupSettings,
} from "../../api";
import { hasPermissionOrAdmin, useApp } from "../../app-context";
import {
  formatBytes,
  formatCoverage,
  formatDateTime,
  formatRelativeTime,
  redactWebhookUrls,
} from "../../format";
import { isJsonObject, isString } from "../../json";
import type { JsonValue } from "../../json";
import { useSystemEvents } from "../../system-events";
import type {
  ArchiveSettings,
  BackupPhase,
  BackupSchedulePreview,
  BackupSettings,
  BackupSnapshot,
  BackupStatus,
  BackupTrigger,
  NotificationChannel,
} from "../../types";
import ErrorAlert from "../ErrorAlert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const REQUIRED_ENV = [
  "KINGLET_BACKUP_S3_BUCKET",
  "KINGLET_BACKUP_S3_ENDPOINT",
  "KINGLET_BACKUP_S3_ACCESS_KEY_ID",
  "KINGLET_BACKUP_S3_SECRET_ACCESS_KEY",
];

const OPTIONAL_ENV = [
  "KINGLET_BACKUP_S3_REGION",
  "KINGLET_BACKUP_S3_PREFIX",
  "KINGLET_BACKUP_S3_FORCE_PATH_STYLE",
  "KINGLET_BACKUP_S3_SSE",
  "KINGLET_BACKUP_PASSPHRASE",
];

const CRON_PRESETS = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at 03:00", cron: "0 3 * * *" },
  { label: "Weekly, Monday 03:00", cron: "0 3 * * 1" },
  { label: "Monthly, 1st 03:00", cron: "0 3 1 * *" },
];

const PHASE_ORDER: BackupPhase[] = [
  "snapshot",
  "compress",
  "encrypt",
  "upload",
  "verify",
  "retention",
];

const TRIGGER_LABELS: Record<BackupTrigger, string> = {
  scheduled: "scheduled",
  manual: "manual",
  "catch-up": "catch-up",
  discovered: "discovered",
};

const STAGED_KEY = "kinglet.restore.staged";

const MY_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function supportedTimezones(): string[] {
  try {
    const zones = Intl.supportedValuesOf("timeZone");

    if (!zones.includes(MY_TIMEZONE)) return [MY_TIMEZONE, ...zones];

    return zones;
  } catch {
    return [MY_TIMEZONE];
  }
}

const TIMEZONES = supportedTimezones();

interface StagedRestore {
  id: string;
  at: number;
}

function isFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readStagedRestore(): StagedRestore | null {
  try {
    const raw = window.localStorage.getItem(STAGED_KEY);

    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);

    if (!isJsonObject(parsed) || !isString(parsed.id) || !isFiniteNumber(parsed.at)) return null;

    return { id: parsed.id, at: parsed.at };
  } catch {
    return null;
  }
}

function writeStagedRestore(value: StagedRestore | null): void {
  try {
    if (value) window.localStorage.setItem(STAGED_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(STAGED_KEY);
  } catch {
    // Private browsing modes may reject storage; the banner is best-effort.
  }
}

function reasonText(reason: Error | string): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isSnapshotAvailable(snapshot: BackupSnapshot): boolean {
  const state = snapshot.state.toLowerCase();

  return state !== "missing" && state !== "deleted" && state !== "invalid";
}

function snapshotContents(snapshot: BackupSnapshot): string {
  const counts = snapshot.counts;

  if (!counts) return "—";

  return `${counts.events.toLocaleString()} events · ${counts.projects}p · ${counts.users}u · ${counts.monitors}m`;
}

function SnapshotStateBadge({ snapshot }: { snapshot: BackupSnapshot }) {
  const state = snapshot.state.toLowerCase();

  const variant =
    state === "available" || state === "ok"
      ? "ghost"
      : state === "missing"
        ? "destructive"
        : "outline";

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant={variant}>{snapshot.state}</Badge>
      {snapshot.discovered && <Badge variant="outline">discovered</Badge>}
    </div>
  );
}

function ProgressBar({
  done,
  total,
  label,
}: {
  done: number | null;
  total: number | null;
  label: string;
}) {
  const percent =
    done !== null && total !== null && total > 0
      ? Math.min(100, Math.max(0, Math.round((done / total) * 100)))
      : null;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={percent === null ? "working" : `${percent}%`}
      className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]"
    >
      <div
        className={
          percent === null
            ? "h-full w-1/3 animate-pulse rounded-full bg-gold"
            : "h-full rounded-full bg-gold transition-[width] duration-300"
        }
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
        {label}
      </span>
      <span className="truncate font-mono text-[11px] text-mist">{children}</span>
    </div>
  );
}

export default function BackupsPanel() {
  const { user, permissions, projects } = useApp();
  const events = useSystemEvents();

  const canWrite = hasPermissionOrAdmin(user.role, permissions, "backups.write");
  const canRestore = hasPermissionOrAdmin(user.role, permissions, "backups.restore");

  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [snapshots, setSnapshots] = useState<BackupSnapshot[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [draftEnabled, setDraftEnabled] = useState(true);
  const [draftCron, setDraftCron] = useState("0 3 * * *");
  const [draftTimezone, setDraftTimezone] = useState(MY_TIMEZONE);
  const [draftRetention, setDraftRetention] = useState("7");
  const [preview, setPreview] = useState<BackupSchedulePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [savingRetention, setSavingRetention] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [stagedLocal, setStagedLocal] = useState<StagedRestore | null>(() => readStagedRestore());
  const [pendingDelete, setPendingDelete] = useState<BackupSnapshot | null>(null);
  const [pendingRestore, setPendingRestore] = useState<BackupSnapshot | null>(null);

  const [archiveSettings, setArchiveSettings] = useState<ArchiveSettings | null>(null);
  const [archiveAvailable, setArchiveAvailable] = useState(false);
  const [projectArchive, setProjectArchiveState] = useState<Record<string, boolean>>({});
  const [archiveBusy, setArchiveBusy] = useState<string | null>(null);

  const load = useCallback(async (refreshBucket = false) => {
    if (refreshBucket) setRefreshing(true);

    try {
      const [statusResult, settingsResult, listResult, channelResult, archiveResult] =
        await Promise.allSettled([
          fetchBackupStatus(),
          fetchBackupSettings(),
          fetchBackups(refreshBucket),
          fetchNotificationChannels(),
          fetchArchiveSettings(),
        ]);

      let failure: string | null = null;

      if (statusResult.status === "fulfilled") {
        setStatus(statusResult.value.status);
      } else {
        failure = reasonText(statusResult.reason);
      }

      if (settingsResult.status === "fulfilled") {
        setSettings(settingsResult.value.settings);
      } else if (failure === null) {
        failure = reasonText(settingsResult.reason);
      }

      if (listResult.status === "fulfilled") {
        setSnapshots(listResult.value.snapshots);
        setWarning(listResult.value.warning ?? null);
      } else if (failure === null) {
        failure = reasonText(listResult.reason);
      }

      if (channelResult.status === "fulfilled") setChannels(channelResult.value.channels);

      if (archiveResult.status === "fulfilled") {
        setArchiveSettings(archiveResult.value.settings);
        setArchiveAvailable(true);
      } else {
        setArchiveAvailable(false);
      }

      setError(failure === null ? null : redactWebhookUrls(failure));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const lastEpochRef = useRef(0);
  const lastRefreshRef = useRef(0);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (events.reconnectEpoch === lastEpochRef.current) return;

    lastEpochRef.current = events.reconnectEpoch;
    void load(true);
  }, [events.reconnectEpoch, load]);

  useEffect(() => {
    if (events.refreshToken === lastRefreshRef.current) return;

    lastRefreshRef.current = events.refreshToken;
    void load(true);
  }, [events.refreshToken, load]);

  useEffect(() => {
    if (!settings) return;

    setDraftEnabled(settings.enabled);
    setDraftCron(settings.scheduleCron);
    setDraftTimezone(settings.scheduleTimezone);
    setDraftRetention(String(settings.retentionCount));
  }, [settings]);

  useEffect(() => {
    if (!settings) {
      setPreview(null);

      return;
    }

    const cron = draftCron.trim();

    if (!cron || !draftTimezone) {
      setPreview(null);

      return;
    }

    let cancelled = false;

    const timer = window.setTimeout(() => {
      setPreviewBusy(true);

      const validate = async (): Promise<void> => {
        try {
          const result = await previewBackupSchedule(cron, draftTimezone);

          if (!cancelled) setPreview(result);
        } catch (err) {
          if (!cancelled) {
            setPreview({
              valid: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } finally {
          if (!cancelled) setPreviewBusy(false);
        }
      };

      void validate();
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draftCron, draftTimezone, settings]);

  useEffect(() => {
    if (!archiveAvailable) return;

    const next: Record<string, boolean> = {};

    for (const project of projects) next[project.id] = project.archiveEnabled === true;

    setProjectArchiveState(next);
  }, [archiveAvailable, projects]);

  const liveBackup = events.status?.backup ?? status;
  const liveArchive = events.status?.archive ?? null;
  const configured = liveBackup?.configured === true;

  const missingEnv =
    liveBackup !== null && Array.isArray(liveBackup.setupMissing) ? liveBackup.setupMissing : [];

  const remoteLibsql =
    liveBackup?.configState === "remote-libsql" || liveBackup?.storage === "remote-libsql";

  const running = liveBackup?.running === true || events.backupProgress !== null;
  const phase = events.backupProgress?.phase ?? liveBackup?.phase ?? null;
  const stagedId = events.restoreStagedId ?? stagedLocal?.id ?? null;

  const retentionCount = useMemo(() => {
    const parsed = Number.parseInt(draftRetention, 10);

    if (!Number.isFinite(parsed)) return 7;

    return Math.min(365, Math.max(2, parsed));
  }, [draftRetention]);

  const intervalMs = useMemo(() => {
    const runs = preview?.nextRuns;

    if (!runs) return null;

    const first = runs[0];
    const second = runs[1];

    if (first === undefined || second === undefined) return null;

    return second - first;
  }, [preview]);

  const timezoneOptions = useMemo(() => {
    if (TIMEZONES.includes(draftTimezone)) return TIMEZONES;

    return [draftTimezone, ...TIMEZONES];
  }, [draftTimezone]);

  const subscribedChannels = useMemo(() => {
    const matched: NotificationChannel[] = [];

    for (const channel of channels) {
      if (!channel.enabled) continue;

      if (
        channel.actions.includes("backup.succeeded") ||
        channel.actions.includes("backup.failed") ||
        channel.actions.includes("backup.restore_staged") ||
        channel.actions.includes("system.warning")
      ) {
        matched.push(channel);
      }
    }

    return matched;
  }, [channels]);

  const runNow = async (): Promise<void> => {
    setBusyAction("run");
    setError(null);

    try {
      await runBackup();
      toast.success("Backup queued", {
        description: "Progress appears here and as an in-app toast.",
      });
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusyAction(null);
    }
  };

  const testConnection = async (): Promise<void> => {
    setBusyAction("test");
    setError(null);

    try {
      await testBackupConnection();
      toast.success("Bucket connection OK", {
        description: "Write, read, and delete round trip succeeded.",
      });
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusyAction(null);
    }
  };

  const saveSchedule = async (): Promise<void> => {
    if (!settings) return;

    setSavingSchedule(true);
    setError(null);

    try {
      const result = await updateBackupSettings({
        enabled: draftEnabled,
        scheduleCron: draftCron.trim(),
        scheduleTimezone: draftTimezone,
        retentionCount: settings.retentionCount,
      });

      setSettings(result.settings);
      toast.success("Backup schedule saved", {
        description: result.nextRuns[0]
          ? `Next run ${formatDateTime(result.nextRuns[0])}`
          : undefined,
      });
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setSavingSchedule(false);
    }
  };

  const saveRetention = async (): Promise<void> => {
    if (!settings) return;

    setSavingRetention(true);
    setError(null);

    try {
      const result = await updateBackupSettings({
        enabled: settings.enabled,
        scheduleCron: settings.scheduleCron,
        scheduleTimezone: settings.scheduleTimezone,
        retentionCount,
      });

      setSettings(result.settings);
      toast.success("Retention saved");
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setSavingRetention(false);
    }
  };

  const downloadSnapshot = async (snapshot: BackupSnapshot): Promise<void> => {
    setBusyAction(`download-${snapshot.id}`);
    setError(null);

    try {
      const result = await downloadBackup(snapshot.id);
      const anchor = document.createElement("a");

      anchor.href = result.url;
      anchor.target = "_blank";
      anchor.rel = "noopener";
      anchor.click();
      toast.success("Download link opened", {
        description: `${result.filename} — the link expires shortly.`,
      });
      await load();
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusyAction(null);
    }
  };

  const confirmRestore = async (): Promise<void> => {
    if (!pendingRestore) return;

    const snapshot = pendingRestore;

    setBusyAction(`restore-${snapshot.id}`);
    setError(null);

    try {
      await restoreBackup(snapshot.id);

      const staged: StagedRestore = { id: snapshot.id, at: Date.now() };

      setStagedLocal(staged);
      writeStagedRestore(staged);
      setPendingRestore(null);
      toast.warning("Restore staged", {
        description: "Restart Kinglet to apply the restored database.",
        duration: Number.POSITIVE_INFINITY,
      });
      await load();
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusyAction(null);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;

    const snapshot = pendingDelete;

    setBusyAction(`delete-${snapshot.id}`);
    setError(null);

    try {
      await deleteBackup(snapshot.id);
      setPendingDelete(null);
      await load();
      toast.success("Snapshot deleted");
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
      setPendingDelete(null);
    } finally {
      setBusyAction(null);
    }
  };

  const toggleArchive = async (enabled: boolean): Promise<void> => {
    if (!archiveSettings) return;

    setArchiveBusy("global");
    setError(null);

    try {
      const result = await updateArchiveSettings({ enabled });

      setArchiveSettings(result.settings);
      toast.success(enabled ? "Archive enabled" : "Archive disabled");
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setArchiveBusy(null);
    }
  };

  const toggleProjectArchive = async (projectId: string, enabled: boolean): Promise<void> => {
    setArchiveBusy(projectId);
    setError(null);

    try {
      await setProjectArchive(projectId, enabled);
      setProjectArchiveState((prev) => ({ ...prev, [projectId]: enabled }));
      toast.success(enabled ? "Project archive enabled" : "Project archive disabled");
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setArchiveBusy(null);
    }
  };

  const importExample = `node apps/api/dist/archive/cli.js --project ${
    projects[0]?.id ?? "<project-id>"
  } --from 2026-11-01 --to 2026-11-20`;

  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={error} />

      {stagedId && (
        <Alert variant="gold">
          <TriangleAlertIcon />
          <AlertTitle>Restore staged — restart Kinglet to apply</AlertTitle>
          <AlertDescription>
            <p>
              Snapshot <code className="break-all text-mist">{stagedId}</code> is staged. Stop and
              start the Kinglet process (Docker: <code>docker compose restart</code>) to swap the
              database. Sessions are cleared on boot; API keys stay valid.
            </p>
            <p className="mt-1">
              A pre-restore copy of the current database is kept for rollback.
              {stagedId === stagedLocal?.id && (
                <Button
                  variant="link"
                  size="xs"
                  className="ml-2 h-auto p-0 text-[10px]"
                  onClick={() => {
                    setStagedLocal(null);
                    writeStagedRestore(null);
                  }}
                >
                  dismiss
                </Button>
              )}
            </p>
          </AlertDescription>
        </Alert>
      )}

      {loading && (
        <div className="flex items-center gap-2 py-6 font-mono text-[11px] text-mist-faint">
          <Spinner />
          loading backup state…
        </div>
      )}

      {!loading && !configured && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CloudIcon className="size-4 text-gold/80" />
              <CardTitle>Connect a bucket</CardTitle>
            </div>
            <CardDescription>
              Snapshots stay off until the S3 settings below exist in the server environment.
              Credentials are read from the environment and never returned by the API.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {remoteLibsql ? (
              <Alert variant="gold">
                <DatabaseIcon />
                <AlertTitle>Remote libSQL storage</AlertTitle>
                <AlertDescription>
                  Snapshots are disabled for remote libSQL/Turso databases. Use your provider&apos;s
                  point-in-time recovery instead.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
                    required
                  </p>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {REQUIRED_ENV.map((name) => (
                      <li key={name}>
                        <code className="font-mono text-[10px] text-mist-dim">{name}</code>
                      </li>
                    ))}
                  </ul>
                </div>
                {missingEnv.length > 0 && (
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-coral">
                      missing right now
                    </p>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {missingEnv.map((name) => (
                        <li key={name}>
                          <code className="font-mono text-[10px] text-coral">{name}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
                    optional
                  </p>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {OPTIONAL_ENV.map((name) => (
                      <code key={name} className="font-mono text-[10px] text-mist-faint">
                        {name}
                      </code>
                    ))}
                  </p>
                </div>
                <p className="font-mono text-[10px] leading-relaxed text-mist-faint">
                  Add the variables and restart the API. This page can then test the round trip and
                  create the first snapshot.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {!loading && configured && liveBackup && (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <DatabaseIcon className="size-4 text-gold/80" />
                    <CardTitle>Backup status</CardTitle>
                    <Badge variant={liveBackup.enabled ? "ghost" : "outline"}>
                      {liveBackup.enabled ? "scheduled" : "schedule off"}
                    </Badge>
                    {running && <Badge>running</Badge>}
                  </div>
                  <CardDescription>
                    Compressed full-database snapshots stored in the private bucket. The bucket is
                    the source of truth; this list is a cache.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canWrite || busyAction !== null}
                    onClick={() => void testConnection()}
                  >
                    {busyAction === "test" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <CloudIcon data-icon="inline-start" />
                    )}
                    test connection
                  </Button>
                  <Button
                    size="sm"
                    disabled={!canWrite || running || busyAction !== null}
                    onClick={() => void runNow()}
                  >
                    {busyAction === "run" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <RotateCcwIcon data-icon="inline-start" />
                    )}
                    back up now
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {running && (
                <div className="flex flex-col gap-2 rounded-[5px] border border-gold/20 bg-gold/[0.03] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-gold">
                      {phase ? `phase: ${phase}` : "starting"}
                    </span>
                    <span className="font-mono text-[10px] text-mist-faint">
                      {events.backupProgress?.done !== null &&
                      events.backupProgress?.done !== undefined &&
                      events.backupProgress.total !== null &&
                      events.backupProgress.total !== undefined
                        ? `${formatBytes(events.backupProgress.done)} / ${formatBytes(events.backupProgress.total)}`
                        : "progress is reported by the server"}
                    </span>
                  </div>
                  <ProgressBar
                    done={events.backupProgress?.done ?? null}
                    total={events.backupProgress?.total ?? null}
                    label="Backup progress"
                  />
                  <div className="flex flex-wrap gap-2">
                    {PHASE_ORDER.map((item) => (
                      <span
                        key={item}
                        className={
                          item === phase
                            ? "font-mono text-[10px] text-gold"
                            : "font-mono text-[10px] text-mist-faint"
                        }
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {liveBackup.lastError && (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle>Last run error</AlertTitle>
                  <AlertDescription>{liveBackup.lastError}</AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="last success">
                  {liveBackup.lastSuccessAt
                    ? formatRelativeTime(liveBackup.lastSuccessAt)
                    : "never"}
                </Metric>
                <Metric label="last failure">
                  {liveBackup.lastFailureAt ? formatRelativeTime(liveBackup.lastFailureAt) : "none"}
                </Metric>
                <Metric label="next run">
                  {liveBackup.nextRunAt ? formatDateTime(liveBackup.nextRunAt) : "not scheduled"}
                </Metric>
                <Metric label="database">{formatBytes(liveBackup.databaseBytes)}</Metric>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <ClockIcon className="size-4 text-gold/80" />
                <CardTitle>Schedule</CardTitle>
              </div>
              <CardDescription>
                Standard 5-field cron in the selected timezone. Runs closer than 15 minutes apart
                are rejected.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <label className="flex items-center justify-between gap-3" htmlFor="backup-enabled">
                <span className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs text-mist">scheduled backups</span>
                  <span className="font-mono text-[10px] text-mist-faint">
                    Manual runs stay available when the schedule is off.
                  </span>
                </span>
                <Switch
                  id="backup-enabled"
                  checked={draftEnabled}
                  onCheckedChange={setDraftEnabled}
                  disabled={!canWrite}
                  aria-label="Enable scheduled backups"
                />
              </label>

              <div className="flex flex-wrap gap-1.5">
                {CRON_PRESETS.map((preset) => (
                  <Button
                    key={preset.cron}
                    type="button"
                    variant={draftCron === preset.cron ? "soft" : "chip"}
                    size="xs"
                    disabled={!canWrite}
                    onClick={() => setDraftCron(preset.cron)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>

              <FieldGroup className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="backup-cron">cron expression</FieldLabel>
                  <Input
                    id="backup-cron"
                    value={draftCron}
                    onChange={(event) => setDraftCron(event.target.value)}
                    placeholder="0 3 * * *"
                    spellCheck={false}
                    disabled={!canWrite}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backup-timezone">timezone</FieldLabel>
                  <Select
                    value={draftTimezone}
                    onValueChange={setDraftTimezone}
                    disabled={!canWrite}
                  >
                    <SelectTrigger id="backup-timezone" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Timezone</SelectLabel>
                        {timezoneOptions.map((zone) => (
                          <SelectItem key={zone} value={zone}>
                            {zone}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto p-0 text-[10px]"
                      onClick={() => setDraftTimezone(MY_TIMEZONE)}
                      disabled={!canWrite}
                    >
                      use my timezone ({MY_TIMEZONE})
                    </Button>
                  </FieldDescription>
                </Field>
              </FieldGroup>

              <div className="min-h-12 rounded-[5px] border border-white/[0.06] px-3 py-2">
                {previewBusy ? (
                  <span className="flex items-center gap-2 font-mono text-[10px] text-mist-faint">
                    <Spinner />
                    validating…
                  </span>
                ) : preview?.valid ? (
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[11px] text-mist">
                      {preview.description ?? "valid schedule"}
                    </span>
                    <span className="font-mono text-[10px] text-mist-faint">
                      next: {(preview.nextRuns ?? []).map((run) => formatDateTime(run)).join(" · ")}
                    </span>
                  </div>
                ) : (
                  <span className="font-mono text-[10px] text-coral">
                    {preview?.error ?? "enter a cron expression to preview the next runs"}
                  </span>
                )}
              </div>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!canWrite || savingSchedule || preview?.valid !== true}
                  onClick={() => void saveSchedule()}
                >
                  {savingSchedule ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <SaveIcon data-icon="inline-start" />
                  )}
                  save schedule
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <ArchiveIcon className="size-4 text-gold/80" />
                <CardTitle>Retention</CardTitle>
              </div>
              <CardDescription>
                Keep the last N successful snapshots. The newest snapshot is always kept, even when
                this is lowered.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="backup-retention">keep last</FieldLabel>
                  <Input
                    id="backup-retention"
                    type="number"
                    min={2}
                    max={365}
                    value={draftRetention}
                    onChange={(event) => setDraftRetention(event.target.value)}
                    disabled={!canWrite}
                  />
                  <FieldDescription>2–365 snapshots.</FieldDescription>
                </Field>
                <Metric label="coverage">{formatCoverage(retentionCount, intervalMs)}</Metric>
                <Metric label="estimated storage">
                  {liveBackup.databaseBytes === null
                    ? "unknown"
                    : formatBytes(liveBackup.databaseBytes * retentionCount)}
                </Metric>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-[10px] text-mist-faint">
                  Estimate uses the current database size; real snapshots compress.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canWrite || savingRetention}
                  onClick={() => void saveRetention()}
                >
                  {savingRetention ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <SaveIcon data-icon="inline-start" />
                  )}
                  save retention
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <ShieldCheckIcon className="size-4 text-gold/80" />
                <CardTitle>Notifications</CardTitle>
              </div>
              <CardDescription>
                Channels subscribed to backup or warning events. Monitor alerts are selected per
                monitor.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              {subscribedChannels.length === 0 ? (
                <span className="font-mono text-[10px] text-mist-faint">
                  No channel subscribes to backup events yet.
                </span>
              ) : (
                subscribedChannels.map((channel) => (
                  <Badge key={channel.id} variant="outline">
                    {channel.name}
                  </Badge>
                ))
              )}
              <Button variant="link" size="sm" className="ml-auto" asChild>
                <Link to="/settings" search={{ tab: "notifications" }}>
                  manage channels
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <DatabaseIcon className="size-4 text-gold/80" />
                    <CardTitle>Snapshots</CardTitle>
                  </div>
                  <CardDescription>
                    Created timestamps, sizes, and contents come from each manifest. Refresh
                    reconciles local state with the bucket.
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={refreshing}
                  onClick={() => void load(true)}
                >
                  {refreshing ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RefreshCwIcon data-icon="inline-start" />
                  )}
                  refresh from bucket
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {warning && (
                <Alert variant="gold">
                  <TriangleAlertIcon />
                  <AlertTitle>Bucket warning</AlertTitle>
                  <AlertDescription>{warning}</AlertDescription>
                </Alert>
              )}

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>created</TableHead>
                    <TableHead>trigger</TableHead>
                    <TableHead>size</TableHead>
                    <TableHead className="hidden sm:table-cell">contents</TableHead>
                    <TableHead>enc.</TableHead>
                    <TableHead>state</TableHead>
                    <TableHead className="text-right">actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshots.map((snapshot) => {
                    const available = isSnapshotAvailable(snapshot);
                    const busy = busyAction !== null && busyAction.endsWith(snapshot.id);

                    return (
                      <TableRow key={snapshot.id}>
                        <TableCell className="whitespace-nowrap text-mist-dim">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>{formatDateTime(snapshot.createdAt)}</span>
                            </TooltipTrigger>
                            <TooltipContent className="font-mono">
                              {formatRelativeTime(snapshot.createdAt)} · v{snapshot.appVersion} ·
                              schema {snapshot.schemaVersion}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-mist-faint">
                          {TRIGGER_LABELS[snapshot.trigger] ?? snapshot.trigger}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-mist">
                          {formatBytes(snapshot.sizeBytes)}
                        </TableCell>
                        <TableCell className="hidden whitespace-nowrap text-[10px] text-mist-faint sm:table-cell">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>{snapshotContents(snapshot)}</span>
                            </TooltipTrigger>
                            <TooltipContent className="font-mono">
                              {snapshotContents(snapshot)}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <Badge variant={snapshot.encryption === "age" ? "outline" : "ghost"}>
                            {snapshot.encryption}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <SnapshotStateBadge snapshot={snapshot} />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="chip"
                                  size="icon-xs"
                                  aria-label={`Restore ${snapshot.id}`}
                                  disabled={!canRestore || !available || busy || running}
                                  onClick={() => setPendingRestore(snapshot)}
                                >
                                  <RotateCcwIcon />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Restore (staged)</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="chip"
                                  size="icon-xs"
                                  aria-label={`Download ${snapshot.id}`}
                                  disabled={!available || busy}
                                  onClick={() => void downloadSnapshot(snapshot)}
                                >
                                  <DownloadIcon />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Download a presigned copy</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="chip"
                                  size="icon-xs"
                                  aria-label={`Delete ${snapshot.id}`}
                                  disabled={!canWrite || busy}
                                  onClick={() => setPendingDelete(snapshot)}
                                >
                                  <Trash2Icon />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Delete snapshot</TooltipContent>
                            </Tooltip>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {snapshots.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-6 text-center text-mist-faint">
                        No snapshots yet. Run one now or wait for the next scheduled run.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>

              {snapshots.length > 0 && (
                <p className="font-mono text-[10px] text-mist-faint">
                  Download links are presigned, short-lived, and admin-only. Encrypted snapshots
                  download as <code>.age</code> and need the passphrase.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <ArchiveIcon className="size-4 text-gold/80" />
                <CardTitle>Log archive</CardTitle>
                <Badge variant={liveArchive?.enabled ? "ghost" : "outline"}>
                  {liveArchive?.enabled ? "enabled" : "off"}
                </Badge>
                {liveArchive?.running && <Badge>running</Badge>}
              </div>
              <CardDescription>
                Archives expiring events to S3 before retention deletes them. This is not a backup:
                archive parts are re-importable NDJSON, not a database.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {events.archiveProgress && (
                <div className="flex flex-col gap-2 rounded-[5px] border border-gold/20 bg-gold/[0.03] p-3">
                  <span className="font-mono text-[11px] text-gold">
                    project {events.archiveProgress.projectId} · {events.archiveProgress.phase}
                  </span>
                  <ProgressBar
                    done={events.archiveProgress.done}
                    total={events.archiveProgress.total}
                    label="Archive progress"
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <Metric label="last run">
                  {liveArchive?.lastRunAt ? formatRelativeTime(liveArchive.lastRunAt) : "never"}
                </Metric>
                <Metric label="state">
                  {liveArchive?.running
                    ? "running"
                    : liveArchive?.enabled
                      ? "waiting for the schedule"
                      : "off"}
                </Metric>
              </div>

              {liveArchive?.lastError && (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle>Archive error</AlertTitle>
                  <AlertDescription>{liveArchive.lastError}</AlertDescription>
                </Alert>
              )}

              {archiveAvailable && archiveSettings ? (
                <div className="flex flex-col gap-3">
                  <label
                    className="flex items-center justify-between gap-3"
                    htmlFor="archive-enabled"
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="font-mono text-xs text-mist">global archive</span>
                      <span className="font-mono text-[10px] text-mist-faint">
                        Opt each project in below. Off by default.
                      </span>
                    </span>
                    <Switch
                      id="archive-enabled"
                      checked={archiveSettings.enabled}
                      disabled={!canWrite || archiveBusy !== null}
                      onCheckedChange={(checked) => void toggleArchive(checked)}
                      aria-label="Enable log archive"
                    />
                  </label>

                  <div className="flex flex-col gap-1.5">
                    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
                      projects
                    </p>
                    {projects.map((project) => (
                      <label
                        key={project.id}
                        className="flex items-center justify-between gap-3 rounded-[4px] border border-white/[0.05] px-2.5 py-2"
                        htmlFor={`archive-${project.id}`}
                      >
                        <span className="truncate font-mono text-[11px] text-mist">
                          {project.name}
                        </span>
                        <Switch
                          id={`archive-${project.id}`}
                          checked={projectArchive[project.id] === true}
                          disabled={!canWrite || archiveBusy !== null}
                          onCheckedChange={(checked) =>
                            void toggleProjectArchive(project.id, checked)
                          }
                          aria-label={`Archive ${project.name}`}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <Alert variant="gold">
                  <ArchiveIcon />
                  <AlertTitle>Archive settings not exposed yet</AlertTitle>
                  <AlertDescription>
                    This API build does not expose archive toggles. Configure archive on the server;
                    parts remain importable from the CLI.
                  </AlertDescription>
                </Alert>
              )}

              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
                  import archived events
                </p>
                <code className="mt-1 block overflow-x-auto rounded-[3px] border border-white/[0.08] bg-ink-900 px-2 py-1.5 font-mono text-[10px] text-mist-dim">
                  {importExample}
                </code>
                <p className="mt-1 font-mono text-[10px] text-mist-faint">
                  Import is a CLI operation: it runs before the server opens the database on a fresh
                  host.
                </p>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <AlertDialog
        open={pendingRestore !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRestore(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this snapshot?</AlertDialogTitle>
            <AlertDialogDescription>
              Snapshot <code className="break-all">{pendingRestore?.id}</code> from{" "}
              {pendingRestore ? formatDateTime(pendingRestore.createdAt) : "an unknown time"} will
              be downloaded, verified, and staged. Restart Kinglet to apply it. The current database
              is copied first for rollback, and sessions are cleared on boot.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction !== null}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => void confirmRestore()}
            >
              {busyAction === `restore-${pendingRestore?.id}` && (
                <Spinner data-icon="inline-start" />
              )}
              Stage restore
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this snapshot?</AlertDialogTitle>
            <AlertDialogDescription>
              The manifest and object for <code className="break-all">{pendingDelete?.id}</code> are
              removed from the bucket. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction !== null}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => void confirmDelete()}
            >
              {busyAction === `delete-${pendingDelete?.id}` && <Spinner data-icon="inline-start" />}
              Delete snapshot
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
