import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import {
  createMonitor,
  deleteMonitor,
  fetchAlerts,
  fetchMonitors,
  fetchNotificationChannelSummary,
  testMonitor,
  updateMonitor,
} from "../api";
import type { PageQuery } from "../api";
import { hasPermission, hasPermissionOrAdmin, useApp } from "../app-context";
import { formatRelativeTime, redactWebhookUrls } from "../format";
import type {
  AlertRecord,
  Monitor,
  MonitorKind,
  NotificationChannelHealth,
  NotificationChannelSummary,
} from "../types";
import ErrorAlert from "../components/ErrorAlert";
import PageShell from "../components/PageShell";
import SkeletonRows from "../components/SkeletonRows";
import TablePagination from "../components/TablePagination";
import TableSearch, { NoMatchesRow } from "../components/TableSearch";
import { fadeWhileLoading, useServerTable } from "../server-table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

export const Route = createFileRoute("/monitors")({
  component: MonitorsPage,
});

const KIND_LABELS: Record<MonitorKind, string> = {
  match: "instant match",
  count_above: "spike",
  count_below: "silence",
};

function fmtDur(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;

  if (ms % 60_000 === 0) return `${ms / 60_000}m`;

  return `${Math.round(ms / 1000)}s`;
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;

  if (diff < 60_000) return "just now";

  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;

  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;

  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function describe(m: Monitor): string {
  if (m.kind === "match") return "Fires the instant an event matches.";

  if (m.kind === "count_above")
    return `Fires when more than ${m.threshold} matching events land within ${fmtDur(m.windowMs)}.`;

  return `Fires when fewer than ${m.threshold} matching events land within ${fmtDur(m.windowMs)} — silence means something broke.`;
}

/** The rule in a few characters: `> 20 in 15m`. */
function ruleText(m: Monitor): string {
  if (m.kind === "match") return "every match";

  return `${m.kind === "count_above" ? ">" : "<"} ${m.threshold} in ${fmtDur(m.windowMs)}`;
}

/** Linked channel names, or a legacy monitor's inline destinations by type. */
function channelNames(m: Monitor): string[] {
  if (m.resolvedChannels !== undefined && m.resolvedChannels.length > 0) {
    return m.resolvedChannels.map((channel) => channel.name);
  }

  return (m.channels ?? []).map((channel) => channel.type);
}

/** An alert is firing until it resolves; resolved alerts are history. */
function alertState(a: AlertRecord): "firing" | "resolved" {
  return a.state === "fired" && a.resolvedAt === null ? "firing" : "resolved";
}

/** "6 monitors", or "2 matching monitors" while a search is active. */
function countLabel(total: number, activeQuery: string, noun: string): string {
  const plural = `${noun}${total === 1 ? "" : "s"}`;

  return activeQuery === "" ? `${total} ${plural}` : `${total} matching ${plural}`;
}

/**
 * A monitor from before reusable channels has inline destinations and no
 * linked channel ids. The API always returns `channelIds` as an array, so an
 * empty array plus inline channels is the legacy shape.
 */
function isLegacyMonitor(monitor: Monitor | null): boolean {
  return (
    monitor !== null &&
    (monitor.channels?.length ?? 0) > 0 &&
    (monitor.channelIds?.length ?? 0) === 0
  );
}

function channelHealthText(channel: NotificationChannelSummary): string {
  const health: NotificationChannelHealth = channel.health;
  const status = health.status.toLowerCase();

  if (status === "failed" || status === "error") {
    return health.lastDeliveryAt
      ? `last delivery failed ${formatRelativeTime(health.lastDeliveryAt)}`
      : "last delivery failed";
  }

  if (status === "ok" || status === "healthy" || status === "success" || status === "sent") {
    return health.lastDeliveryAt
      ? `last delivery ${formatRelativeTime(health.lastDeliveryAt)}`
      : "ready";
  }

  if (status === "never" || status === "none" || health.lastDeliveryAt === null) {
    return "no deliveries yet";
  }

  return `${status} ${formatRelativeTime(health.lastDeliveryAt)}`;
}

function MonitorsPage() {
  const { currentProjectId, permissions, user } = useApp();
  const canWrite = hasPermission(permissions, "monitors.write");
  const canManageChannels = hasPermissionOrAdmin(user.role, permissions, "notifications.read");
  const [channelSummary, setChannelSummary] = useState<NotificationChannelSummary[]>([]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Monitor | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMonitors = useCallback(
    async (page: PageQuery) => {
      const result = await fetchMonitors(currentProjectId, page);

      return { rows: result.monitors, total: result.total };
    },
    [currentProjectId],
  );

  const loadAlerts = useCallback(
    async (page: PageQuery) => {
      const result = await fetchAlerts(currentProjectId, page);

      return { rows: result.alerts, total: result.total };
    },
    [currentProjectId],
  );

  const monitorTable = useServerTable("monitors", loadMonitors);

  const { reload: reloadMonitors } = monitorTable;
  const alertTable = useServerTable("alerts", loadAlerts);
  const { reload: reloadAlerts } = alertTable;

  const loadSummary = useCallback(async () => {
    try {
      setChannelSummary((await fetchNotificationChannelSummary()).channels);
    } catch {
      // The channel summary is additive. Keep the previous list when the
      // endpoint is unavailable so monitors still render.
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  // Another project closes an open editor (reset while rendering).
  const [editingProjectId, setEditingProjectId] = useState(currentProjectId);

  if (editingProjectId !== currentProjectId) {
    setEditingProjectId(currentProjectId);
    setEditing(null);
  }

  const load = useCallback(async () => {
    await Promise.all([reloadMonitors(), reloadAlerts(), loadSummary()]);
  }, [reloadMonitors, reloadAlerts, loadSummary]);

  const toggleEnabled = async (m: Monitor): Promise<void> => {
    try {
      // Send only the changed field: echoing the whole monitor would replace
      // channelIds (and legacy channels) with whatever the read returned.
      await updateMonitor(currentProjectId, m.id, { enabled: !m.enabled });
      await load();
      toast.success(m.enabled ? "Monitor paused" : "Monitor enabled");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (m: Monitor): Promise<void> => {
    try {
      await deleteMonitor(currentProjectId, m.id);
      await load();
      toast.success("Monitor deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runTest = async (m: Monitor): Promise<void> => {
    try {
      const r = await testMonitor(currentProjectId, m.id);

      if (r.results.length === 0) {
        toast.info("No channels configured");

        return;
      }

      const failed = r.results.filter((x) => !x.ok);

      if (failed.length === 0) {
        toast.success(`Sent to ${r.results.length} channel${r.results.length === 1 ? "" : "s"}`);
      } else {
        toast.error(
          redactWebhookUrls(failed.map((x) => `${x.type}: ${x.error ?? "failed"}`).join(" · ")),
        );
      }
    } catch (err) {
      toast.error(redactWebhookUrls(err instanceof Error ? err.message : "test failed"));
    }
  };

  const editingMonitor =
    editing !== null && editing !== "new"
      ? (monitorTable.rows.find((m) => m.id === editing) ?? null)
      : null;

  const noMonitorsYet =
    monitorTable.loaded && monitorTable.total === 0 && monitorTable.activeQuery === "";

  const visibleError = error ?? monitorTable.error ?? alertTable.error;

  return (
    <PageShell
      wide
      kicker="monitors"
      title="Alerts on your terms."
      description="Get notified when logs match a query — or when expected logs go missing. Channels are plain webhook URLs: anything that accepts a POST works."
      headerExtra={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="chip" size="icon-xs" onClick={() => void load()} aria-label="Refresh">
              <RefreshCwIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh monitors</TooltipContent>
        </Tooltip>
      }
    >
      <div className="mt-6 flex flex-col gap-3">
        <ErrorAlert error={visibleError} />

        {noMonitorsYet ? (
          <Card className="items-center px-4 py-10 text-center">
            <p className="font-mono text-xs text-mist-dim">No monitors yet.</p>
            <p className="font-mono text-[11px] text-mist-faint">
              Watch for <span className="text-gold">level:fatal</span>, spike rates, or a cron that
              went quiet.
            </p>
            <WriteGuard allowed={canWrite}>
              <Button
                size="sm"
                className="mt-1"
                disabled={!canWrite}
                onClick={() => setEditing("new")}
              >
                <PlusIcon data-icon="inline-start" />
                Create your first monitor
              </Button>
            </WriteGuard>
          </Card>
        ) : (
          <Card className="gap-0 py-0">
            <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-3">
              <TableSearch
                label="Search monitors"
                value={monitorTable.query}
                onChange={monitorTable.setQuery}
              />
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
                {monitorTable.loaded
                  ? countLabel(monitorTable.total, monitorTable.activeQuery, "monitor")
                  : "loading monitors…"}
              </span>
              {/* Hidden while loading: an empty list swaps in its own first-monitor button. */}
              {monitorTable.loaded && (
                <WriteGuard allowed={canWrite}>
                  <Button
                    size="sm"
                    className="ml-auto"
                    disabled={!canWrite}
                    onClick={() => setEditing("new")}
                  >
                    <PlusIcon data-icon="inline-start" />
                    new monitor
                  </Button>
                </WriteGuard>
              )}
            </div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-12 pl-4">
                    <span className="sr-only">enabled</span>
                  </TableHead>
                  <TableHead>monitor</TableHead>
                  <TableHead className="hidden md:table-cell">query</TableHead>
                  <TableHead className="hidden lg:table-cell">channels</TableHead>
                  <TableHead>last alert</TableHead>
                  <TableHead className="w-10 pr-4">
                    <span className="sr-only">actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={fadeWhileLoading(monitorTable)}>
                {!monitorTable.loaded && <SkeletonRows columns={6} label="Loading monitors…" />}
                {monitorTable.rows.map((m) => {
                  const names = channelNames(m);

                  return (
                    <TableRow key={m.id} className={m.enabled ? undefined : "text-mist-faint"}>
                      <TableCell className="pl-4">
                        <WriteGuard allowed={canWrite}>
                          <Switch
                            checked={m.enabled}
                            onCheckedChange={() => void toggleEnabled(m)}
                            disabled={!canWrite}
                            aria-label={m.enabled ? `Pause ${m.name}` : `Enable ${m.name}`}
                          />
                        </WriteGuard>
                      </TableCell>
                      <TableCell className="max-w-64">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {canWrite ? (
                            <button
                              type="button"
                              onClick={() => setEditing(m.id)}
                              className={`truncate text-left font-medium hover:text-gold hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40 ${m.enabled ? "text-mist" : "text-mist-dim"}`}
                            >
                              {m.name}
                            </button>
                          ) : (
                            <span className="truncate font-medium">{m.name}</span>
                          )}
                          {!m.enabled && <Badge variant="outline">paused</Badge>}
                          {m.lastError && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="destructive">degraded</Badge>
                              </TooltipTrigger>
                              <TooltipContent>{m.lastError}</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="mt-0.5 block w-fit text-[10px] text-mist-faint">
                              {KIND_LABELS[m.kind]} · {ruleText(m)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            {describe(m)}
                            {m.kind !== "match" &&
                              ` Checked every ${fmtDur(m.intervalMs)}, cooldown ${fmtDur(m.cooldownMs)}.`}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="hidden max-w-56 md:table-cell">
                        <code className="block truncate text-[11px] text-mist-dim" title={m.query}>
                          {m.query || "(all events)"}
                        </code>
                      </TableCell>
                      <TableCell className="hidden max-w-40 lg:table-cell">
                        {names.length === 0 ? (
                          <span className="text-[10px] text-mist-faint">history only</span>
                        ) : (
                          <span
                            className="block truncate text-[11px] text-mist-dim"
                            title={names.join(", ")}
                          >
                            {names.join(", ")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {m.firing ? (
                          <Badge variant="destructive">firing</Badge>
                        ) : m.lastAlertAt ? (
                          <span className="text-[11px] text-mist-dim">
                            {relTime(m.lastAlertAt)}
                          </span>
                        ) : (
                          <span className="text-[10px] text-mist-faint">—</span>
                        )}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              disabled={!canWrite}
                              aria-label={`Actions for ${m.name}`}
                            >
                              <MoreHorizontalIcon />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => void runTest(m)}>
                              <SendIcon />
                              Send test notification
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setEditing(m.id)}>
                              <PencilIcon />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setPendingDelete(m)}
                            >
                              <Trash2Icon />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {monitorTable.loaded && monitorTable.total === 0 && (
                  <NoMatchesRow
                    columns={6}
                    query={monitorTable.activeQuery}
                    noun="monitors"
                    onClear={() => monitorTable.setQuery("")}
                  />
                )}
              </TableBody>
            </Table>
            <TablePagination table={monitorTable} noun="monitors" />
          </Card>
        )}

        <div className="mt-10">
          <div className="k-kicker">
            <span className="text-gold">/</span> alerts
          </div>
          <Card className="mt-3">
            <CardHeader>
              <CardTitle>Recent alerts</CardTitle>
              <CardDescription>
                Fired and resolved history for this project, newest first.
              </CardDescription>
              {(alertTable.total > 0 || alertTable.activeQuery !== "") && (
                <CardAction className="row-span-1 self-center">
                  <TableSearch
                    label="Search alerts"
                    value={alertTable.query}
                    onChange={alertTable.setQuery}
                  />
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>when</TableHead>
                    <TableHead>monitor</TableHead>
                    <TableHead className="w-full">summary</TableHead>
                    <TableHead className="text-right">state</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className={fadeWhileLoading(alertTable)}>
                  {alertTable.rows.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="whitespace-nowrap text-mist-faint">
                        {relTime(a.firedAt)}
                      </TableCell>
                      <TableCell className="max-w-40 truncate text-mist-dim">
                        {a.monitorName ?? "monitor"}
                      </TableCell>
                      {/* max-w-0 + w-full: the summary takes the leftover width and truncates. */}
                      <TableCell className="w-full max-w-0 text-mist">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block truncate">{a.summary}</span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm">{a.summary}</TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <span className="inline-flex items-center gap-1">
                          {a.state === "fired" && a.notifyStatus && a.notifyStatus !== "none" && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  variant={
                                    a.notifyStatus === "sent"
                                      ? "ghost"
                                      : a.notifyStatus === "partial"
                                        ? "outline"
                                        : "destructive"
                                  }
                                >
                                  {a.notifyStatus === "sent"
                                    ? "notified"
                                    : `notify ${a.notifyStatus}`}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                {a.notifyError ?? "Notification delivery"}
                              </TooltipContent>
                            </Tooltip>
                          )}
                          <Badge variant={alertState(a) === "firing" ? "destructive" : "ghost"}>
                            {alertState(a)}
                          </Badge>
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!alertTable.loaded && <SkeletonRows columns={4} label="Loading alerts…" />}
                  {alertTable.loaded && alertTable.total === 0 && alertTable.activeQuery === "" && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="py-6 text-center text-mist-faint">
                        No alerts yet. When a monitor fires, its story lands here.
                      </TableCell>
                    </TableRow>
                  )}
                  {alertTable.loaded && alertTable.total === 0 && alertTable.activeQuery !== "" && (
                    <NoMatchesRow
                      columns={4}
                      query={alertTable.activeQuery}
                      noun="alerts"
                      onClear={() => alertTable.setQuery("")}
                    />
                  )}
                </TableBody>
              </Table>
            </CardContent>
            <TablePagination table={alertTable} noun="alerts" className="-mb-4" />
          </Card>
        </div>
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name ?? "this monitor"}?</AlertDialogTitle>
            <AlertDialogDescription>
              The monitor stops checking and its alert history stays behind. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) void remove(pendingDelete);
              }}
            >
              Delete monitor
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {editing !== null && (
            <MonitorForm
              key={editing === "new" ? "new" : `edit-${editing}`}
              initial={editingMonitor}
              projectId={currentProjectId}
              channels={channelSummary}
              canManageChannels={canManageChannels}
              onDone={async () => {
                setEditing(null);
                await load();
              }}
              onCancel={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

// ---------- form ----------

interface FormState {
  name: string;
  query: string;
  kind: MonitorKind;
  threshold: number;
  windowMin: number;
  intervalSec: number;
  cooldownMin: number;
  channelIds: string[];
}

function WriteGuard({ allowed, children }: { allowed: boolean; children: ReactNode }) {
  if (allowed) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex rounded-[4px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40"
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>Requires the monitors.write permission</TooltipContent>
    </Tooltip>
  );
}

function MonitorForm({
  initial,
  projectId,
  channels,
  canManageChannels,
  onDone,
  onCancel,
}: {
  initial: Monitor | null;
  projectId: string;
  channels: NotificationChannelSummary[];
  canManageChannels: boolean;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  // A monitor that predates the channel table only has inline `channels`.
  // Keep that editor until the admin moves it to reusable channels.
  const [legacyMode, setLegacyMode] = useState(isLegacyMonitor(initial));

  const switchedFromLegacy = isLegacyMonitor(initial) && !legacyMode;

  const [form, setForm] = useState<FormState>(() => ({
    name: initial?.name ?? "",
    query: initial?.query ?? "",
    kind: initial?.kind ?? "count_above",
    threshold: initial?.threshold ?? 10,
    windowMin: initial ? Math.max(1, Math.round(initial.windowMs / 60_000)) : 5,
    intervalSec: initial ? Math.max(10, Math.round(initial.intervalMs / 1000)) : 60,
    cooldownMin: initial ? Math.max(0, Math.round(initial.cooldownMs / 60_000)) : 10,
    channelIds: initial?.channelIds ?? [],
  }));

  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleChannelId = (id: string, checked: boolean): void => {
    setForm((prev) => {
      if (checked) {
        if (prev.channelIds.includes(id)) return prev;

        return { ...prev, channelIds: [...prev.channelIds, id] };
      }

      return { ...prev, channelIds: prev.channelIds.filter((item) => item !== id) };
    });
  };

  const save = async (): Promise<void> => {
    if (!form.name.trim()) {
      setFormError("Give the monitor a name.");

      return;
    }

    setSaving(true);
    setFormError(null);

    try {
      const base = {
        name: form.name.trim(),
        query: form.query.trim(),
        kind: form.kind,
        threshold: form.threshold,
        windowMs: Math.round(form.windowMin * 60_000),
        intervalMs: Math.round(form.intervalSec * 1000),
        cooldownMs: Math.round(form.cooldownMin * 60_000),
        // Preserve the current pause state; editing must not re-enable a
        // paused monitor as a side effect.
        enabled: initial?.enabled ?? true,
      };

      // Legacy monitors keep their inline destinations when only other fields
      // change. Selecting the channel list replaces them explicitly.
      const payload = legacyMode ? base : { ...base, channelIds: form.channelIds };

      if (initial) await updateMonitor(projectId, initial.id, payload);
      else await createMonitor(projectId, payload);
      toast.success(initial ? "Monitor updated" : "Monitor created");
      await onDone();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const isCount = form.kind !== "match";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{initial ? `Edit ${initial.name}` : "New monitor"}</DialogTitle>
        <DialogDescription>
          Use the same query grammar as the log view. Channels are optional; without one, the
          monitor still records alert history. Pick channels from Settings → Notifications — raw
          webhook URLs never appear here.
        </DialogDescription>
      </DialogHeader>

      <FieldGroup className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="monitor-name">name</FieldLabel>
          <Input
            id="monitor-name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Payment failures"
          />
        </Field>

        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="monitor-query">query — same grammar as the log view</FieldLabel>
          <Input
            id="monitor-query"
            value={form.query}
            onChange={(e) => set("query", e.target.value)}
            placeholder="level:error service:checkout"
            spellCheck={false}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="monitor-kind">condition</FieldLabel>
          <Select
            value={form.kind}
            onValueChange={(value) => {
              if (value === "match" || value === "count_above" || value === "count_below") {
                set("kind", value);
              }
            }}
          >
            <SelectTrigger id="monitor-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Condition</SelectLabel>
                <SelectItem value="match">instant match — any event fires</SelectItem>
                <SelectItem value="count_above">spike — more than N in a window</SelectItem>
                <SelectItem value="count_below">silence — fewer than N in a window</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        {isCount && (
          <Field>
            <FieldLabel htmlFor="monitor-threshold">threshold</FieldLabel>
            <Input
              id="monitor-threshold"
              type="number"
              min={1}
              value={form.threshold}
              onChange={(e) =>
                set("threshold", Math.max(1, Math.trunc(Number(e.target.value)) || 1))
              }
            />
          </Field>
        )}

        {isCount && (
          <Field>
            <FieldLabel htmlFor="monitor-window">window (minutes)</FieldLabel>
            <Input
              id="monitor-window"
              type="number"
              min={1}
              value={form.windowMin}
              onChange={(e) =>
                set("windowMin", Math.max(1, Math.trunc(Number(e.target.value)) || 1))
              }
            />
          </Field>
        )}

        {isCount && (
          <Field>
            <FieldLabel htmlFor="monitor-interval">check every (seconds)</FieldLabel>
            <Input
              id="monitor-interval"
              type="number"
              min={10}
              value={form.intervalSec}
              onChange={(e) =>
                set("intervalSec", Math.max(10, Math.trunc(Number(e.target.value)) || 60))
              }
            />
          </Field>
        )}

        <Field>
          <FieldLabel htmlFor="monitor-cooldown">cooldown (minutes)</FieldLabel>
          <Input
            id="monitor-cooldown"
            type="number"
            min={0}
            value={form.cooldownMin}
            onChange={(e) =>
              set("cooldownMin", Math.max(0, Math.trunc(Number(e.target.value)) || 0))
            }
          />
        </Field>

        <div className="sm:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <FieldLabel>channels</FieldLabel>
            {canManageChannels && (
              <Button variant="link" size="xs" className="h-auto p-0 text-[10px]" asChild>
                <Link to="/settings" search={{ tab: "notifications" }}>
                  manage channels
                </Link>
              </Button>
            )}
          </div>

          {legacyMode ? (
            <div className="mt-2 flex flex-col gap-2 rounded-[4px] border border-white/[0.05] p-3">
              <p className="font-mono text-[10px] leading-relaxed text-mist-dim">
                This monitor predates reusable channels. Its inline destinations stay untouched when
                you save other changes, and their URLs stay hidden because they are bearer secrets.
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="self-start"
                onClick={() => setLegacyMode(false)}
              >
                choose reusable channels
              </Button>
            </div>
          ) : channels.length === 0 ? (
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-mist-faint">
              No reusable channels exist yet. Monitor history still records alerts without one.
              {canManageChannels && " Create one in Settings → Notifications."}
            </p>
          ) : (
            <>
              {switchedFromLegacy && (
                <p className="mt-1 font-mono text-[10px] leading-relaxed text-coral">
                  Saving replaces this monitor&apos;s legacy inline destinations with the selected
                  channels.
                </p>
              )}
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {channels.map((channel) => {
                  const failed =
                    channel.health.status === "failed" || channel.health.status === "error";

                  return (
                    <label
                      key={channel.id}
                      htmlFor={`monitor-channel-${channel.id}`}
                      className="flex items-start gap-2 rounded-[4px] border border-white/[0.05] px-2.5 py-2"
                    >
                      <Checkbox
                        id={`monitor-channel-${channel.id}`}
                        checked={form.channelIds.includes(channel.id)}
                        onCheckedChange={(checked) => toggleChannelId(channel.id, checked === true)}
                        className="mt-0.5"
                      />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate font-mono text-[11px] text-mist">
                            {channel.name}
                          </span>
                          <Badge variant="outline">{channel.type}</Badge>
                          {!channel.enabled && <Badge variant="destructive">disabled</Badge>}
                        </span>
                        <span
                          className={
                            failed
                              ? "font-mono text-[10px] text-coral"
                              : "font-mono text-[10px] text-mist-faint"
                          }
                        >
                          {channelHealthText(channel)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {formError && (
          <div className="sm:col-span-2">
            <ErrorAlert error={formError} />
          </div>
        )}
      </FieldGroup>

      <DialogFooter className="mt-5">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Spinner data-icon="inline-start" />}
          {saving ? "saving…" : initial ? "Save changes" : "Create monitor"}
        </Button>
      </DialogFooter>
    </form>
  );
}
