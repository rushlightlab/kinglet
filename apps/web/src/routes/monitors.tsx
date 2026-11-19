import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { PencilIcon, PlusIcon, RefreshCwIcon, SendIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  createMonitor,
  deleteMonitor,
  fetchAlerts,
  fetchMonitors,
  testChannel,
  testMonitor,
  updateMonitor,
} from "../api";
import { hasPermission, useApp } from "../app-context";
import type { AlertRecord, Monitor, MonitorKind, NotifyChannel } from "../types";
import ErrorAlert from "../components/ErrorAlert";
import PageShell from "../components/PageShell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

const CHANNEL_PLACEHOLDERS: Record<NotifyChannel["type"], string> = {
  webhook: "https://example.com/webhooks/kinglet",
  discord: "https://discord.com/api/webhooks/…",
  slack: "https://hooks.slack.com/services/…",
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

function MonitorsPage() {
  const { currentProjectId, permissions } = useApp();
  const canWrite = hasPermission(permissions, "monitors.write");
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, a] = await Promise.all([
        fetchMonitors(currentProjectId),
        fetchAlerts(currentProjectId, 50),
      ]);
      setMonitors(m.monitors);
      setAlerts(a.alerts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentProjectId]);

  useEffect(() => {
    setEditing(null);
    void load();
  }, [load]);

  const toggleEnabled = async (m: Monitor): Promise<void> => {
    try {
      await updateMonitor(currentProjectId, m.id, { ...m, enabled: !m.enabled });
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
          failed.map((x) => `${x.type}: ${x.error ?? "failed"}`).join(" · ")
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "test failed");
    }
  };

  const editingMonitor =
    editing !== null && editing !== "new" ? monitors.find((m) => m.id === editing) ?? null : null;

  return (
    <PageShell
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
        <ErrorAlert error={error} />

        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
            {monitors.length} monitor{monitors.length === 1 ? "" : "s"}
          </span>
          <Button
            size="sm"
            disabled={!canWrite}
            title={canWrite ? undefined : "Requires the monitors.write permission"}
            onClick={() => setEditing("new")}
          >
            <PlusIcon data-icon="inline-start" />
            new monitor
          </Button>
        </div>

        <div className="flex flex-col gap-3">
          {monitors.map((m) => (
            <Card key={m.id} className={m.enabled ? undefined : "opacity-60"}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="truncate">{m.name}</CardTitle>
                      <Badge>{KIND_LABELS[m.kind]}</Badge>
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
                    <CardDescription>{describe(m)}</CardDescription>
                  </div>
                  <Switch
                    checked={m.enabled}
                    onCheckedChange={() => void toggleEnabled(m)}
                    disabled={!canWrite}
                    title={
                      canWrite
                        ? m.enabled
                          ? "Pause monitor"
                          : "Enable monitor"
                        : "Requires the monitors.write permission"
                    }
                    aria-label={m.enabled ? "Pause monitor" : "Enable monitor"}
                  />
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <code className="inline-block max-w-full truncate rounded-[3px] border border-white/[0.08] bg-ink-850 px-2 py-1 font-mono text-[11px] text-mist">
                  {m.query || "(all events)"}
                </code>
                <p className="font-mono text-[10px] text-mist-faint">
                  checked every {fmtDur(m.kind === "match" ? 0 : m.intervalMs)}
                  {m.kind !== "match" && ` · cooldown ${fmtDur(m.cooldownMs)}`} ·{" "}
                  {m.channels.length === 0
                    ? "no channels (history only)"
                    : `${m.channels.length} channel${m.channels.length === 1 ? "" : "s"}`}
                </p>
              </CardContent>
              <CardFooter className="gap-2">
                <Button
                  variant="chip"
                  size="xs"
                  onClick={() => void runTest(m)}
                  disabled={!canWrite}
                  title={canWrite ? undefined : "Requires the monitors.write permission"}
                >
                  <SendIcon data-icon="inline-start" />
                  test
                </Button>
                <Button
                  variant="chip"
                  size="xs"
                  onClick={() => setEditing(m.id)}
                  disabled={!canWrite}
                  title={canWrite ? undefined : "Requires the monitors.write permission"}
                >
                  <PencilIcon data-icon="inline-start" />
                  edit
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="destructive"
                      size="xs"
                      className="ml-auto"
                      disabled={!canWrite}
                      title={canWrite ? undefined : "Requires the monitors.write permission"}
                    >
                      <Trash2Icon data-icon="inline-start" />
                      delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {m.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The monitor stops checking and its alert history stays behind. This cannot be
                        undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => void remove(m)}>
                        Delete monitor
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardFooter>
            </Card>
          ))}

          {monitors.length === 0 && (
            <Card className="items-center px-4 py-10 text-center">
              <p className="font-mono text-xs text-mist-dim">No monitors yet.</p>
              <p className="font-mono text-[11px] text-mist-faint">
                Watch for <span className="text-gold">level:fatal</span>, spike rates, or a cron
                that went quiet.
              </p>
              <Button
                size="sm"
                className="mt-1"
                disabled={!canWrite}
                title={canWrite ? undefined : "Requires the monitors.write permission"}
                onClick={() => setEditing("new")}
              >
                <PlusIcon data-icon="inline-start" />
                Create your first monitor
              </Button>
            </Card>
          )}
        </div>

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
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>when</TableHead>
                    <TableHead>monitor</TableHead>
                    <TableHead>summary</TableHead>
                    <TableHead className="hidden sm:table-cell">notify</TableHead>
                    <TableHead className="text-right">state</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {alerts.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="whitespace-nowrap text-mist-faint">
                        {relTime(a.firedAt)}
                      </TableCell>
                      <TableCell className="max-w-36 truncate text-mist-dim">
                        {a.monitorName ?? "monitor"}
                      </TableCell>
                      <TableCell
                        className="max-w-[24rem] truncate text-mist"
                        title={a.summary}
                      >
                        {a.summary}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {a.state === "fired" &&
                        a.notifyStatus &&
                        a.notifyStatus !== "none" ? (
                          <Badge
                            variant={
                              a.notifyStatus === "sent"
                                ? "ghost"
                                : a.notifyStatus === "partial"
                                  ? "outline"
                                  : "destructive"
                            }
                            title={a.notifyError ?? "Notification delivery"}
                          >
                            {a.notifyStatus}
                          </Badge>
                        ) : (
                          <span className="text-[10px] text-mist-faint">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {a.state === "fired" && a.resolvedAt === null ? (
                          <Badge variant="destructive">fired</Badge>
                        ) : (
                          <Badge variant="ghost">resolved</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {alerts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-6 text-center text-mist-faint">
                        No alerts yet. When a monitor fires, its story lands here.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>

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
  channels: NotifyChannel[];
}

function MonitorForm({
  initial,
  projectId,
  onDone,
  onCancel,
}: {
  initial: Monitor | null;
  projectId: string;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => ({
    name: initial?.name ?? "",
    query: initial?.query ?? "",
    kind: initial?.kind ?? "count_above",
    threshold: initial?.threshold ?? 10,
    windowMin: initial ? Math.max(1, Math.round(initial.windowMs / 60_000)) : 5,
    intervalSec: initial ? Math.max(10, Math.round(initial.intervalMs / 1000)) : 60,
    cooldownMin: initial ? Math.max(0, Math.round(initial.cooldownMs / 60_000)) : 10,
    channels: initial?.channels ?? [],
  }));
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingChannel, setTestingChannel] = useState<number | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const setChannel = (index: number, patch: Partial<NotifyChannel>): void => {
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  };

  const testRow = async (channel: NotifyChannel, index: number): Promise<void> => {
    setTestingChannel(index);
    try {
      await testChannel(projectId, channel);
      toast.success(`Test sent to ${channel.type}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "test failed");
    } finally {
      setTestingChannel(null);
    }
  };

  const save = async (): Promise<void> => {
    if (!form.name.trim()) {
      setFormError("Give the monitor a name.");
      return;
    }
    const channels = form.channels.filter((c) => c.url.trim());
    if (channels.some((c) => !/^https?:\/\//i.test(c.url.trim()))) {
      setFormError("Channel URLs must start with http:// or https://");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        name: form.name.trim(),
        query: form.query.trim(),
        kind: form.kind,
        threshold: form.threshold,
        windowMs: Math.round(form.windowMin * 60_000),
        intervalMs: Math.round(form.intervalSec * 1000),
        cooldownMs: Math.round(form.cooldownMin * 60_000),
        enabled: true,
        channels,
      };
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
          monitor still records alert history.
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
            autoFocus
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
            onValueChange={(value) => set("kind", value as MonitorKind)}
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
          <FieldLabel>channels</FieldLabel>
          <div className="mt-2 flex flex-col gap-2">
            {form.channels.map((c, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <Select
                  value={c.type}
                  onValueChange={(value) =>
                    setChannel(i, { type: value as NotifyChannel["type"] })
                  }
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Channel type</SelectLabel>
                      <SelectItem value="webhook">webhook</SelectItem>
                      <SelectItem value="discord">discord</SelectItem>
                      <SelectItem value="slack">slack</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Input
                  value={c.url}
                  onChange={(e) => setChannel(i, { url: e.target.value })}
                  placeholder={CHANNEL_PLACEHOLDERS[c.type]}
                  spellCheck={false}
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  variant="chip"
                  size="sm"
                  className="h-9"
                  disabled={testingChannel !== null || !c.url.trim()}
                  onClick={() => void testRow(c, i)}
                  title="Send a test notification to this channel"
                >
                  {testingChannel === i ? (
                    <Spinner />
                  ) : (
                    <SendIcon data-icon="inline-start" />
                  )}
                  {testingChannel === i ? "sending" : "test"}
                </Button>
                <Button
                  type="button"
                  variant="chip"
                  size="icon"
                  aria-label="Remove channel"
                  onClick={() => set("channels", form.channels.filter((_, j) => j !== i))}
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="chip"
              size="xs"
              className="self-start"
              onClick={() => set("channels", [...form.channels, { type: "webhook", url: "" }])}
            >
              <PlusIcon data-icon="inline-start" />
              channel
            </Button>
          </div>
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
