import { useCallback, useEffect, useState } from "react";
import {
  BellIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  createNotificationChannel,
  deleteNotificationChannel,
  fetchNotificationChannel,
  fetchNotificationChannelSummary,
  fetchNotificationChannels,
  fetchNotificationDeliveries,
  testNotificationChannel,
  updateNotificationChannel,
} from "../../api";
import type { PageQuery } from "../../api";
import { hasPermissionOrAdmin, useApp } from "../../app-context";
import { formatRelativeTime, maskWebhookUrl, redactWebhookUrls } from "../../format";
import type {
  ChannelType,
  NotificationAction,
  NotificationChannel,
  NotificationChannelHealth,
  NotificationChannelInput,
  NotificationChannelSummary,
  NotificationDelivery,
} from "../../types";
import ErrorAlert from "../ErrorAlert";
import SkeletonRows from "../SkeletonRows";
import TablePagination from "../TablePagination";
import TableSearch, { NoMatchesRow } from "../TableSearch";
import { fadeWhileLoading, useServerTable } from "../../server-table";
import type { TablePage } from "../../server-table";
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

const CHANNEL_ICONS: Record<ChannelType, typeof WebhookIcon> = {
  webhook: WebhookIcon,
  discord: MessageCircleIcon,
  slack: MessageSquareIcon,
};

const CHANNEL_PLACEHOLDERS: Record<ChannelType, string> = {
  webhook: "https://example.com/webhooks/kinglet",
  discord: "https://discord.com/api/webhooks/…",
  slack: "https://hooks.slack.com/services/…",
};

interface ActionOption {
  value: NotificationAction;
  label: string;
  description: string;
}

const ACTION_OPTIONS: ActionOption[] = [
  {
    value: "backup.succeeded",
    label: "Backup succeeded",
    description: "A scheduled or manual snapshot finished.",
  },
  {
    value: "backup.failed",
    label: "Backup failed",
    description: "Any snapshot phase failed.",
  },
  {
    value: "backup.restore_staged",
    label: "Restore staged",
    description: "An admin staged a restore; a restart applies it.",
  },
  {
    value: "archive.succeeded",
    label: "Archive succeeded",
    description: "An archive part was uploaded.",
  },
  {
    value: "archive.failed",
    label: "Archive failed",
    description: "An archive export could not complete.",
  },
  {
    value: "system.warning",
    label: "System warning",
    description: "Retention failures, a database near its cap, or scheduler errors.",
  },
];

// Failure and restore actions on; success actions off.
const DEFAULT_ACTIONS: NotificationAction[] = [
  "backup.failed",
  "backup.restore_staged",
  "archive.failed",
  "system.warning",
];

function findHealth(
  channels: NotificationChannelSummary[],
  id: string,
): NotificationChannelHealth | null {
  const match = channels.find((channel) => channel.id === id);

  return match?.health ?? null;
}

function healthVariant(health: NotificationChannelHealth): "ghost" | "outline" | "destructive" {
  const status = health.status.toLowerCase();

  if (status === "ok" || status === "healthy" || status === "success" || status === "sent") {
    return "ghost";
  }

  if (status === "failed" || status === "error") return "destructive";

  return "outline";
}

function healthLabel(health: NotificationChannelHealth): string {
  const status = health.status.toLowerCase();

  if (status === "ok" || status === "healthy" || status === "success" || status === "sent") {
    return health.lastDeliveryAt
      ? `delivered ${formatRelativeTime(health.lastDeliveryAt)}`
      : "ready";
  }

  if (status === "failed" || status === "error") {
    return health.lastDeliveryAt ? `failed ${formatRelativeTime(health.lastDeliveryAt)}` : "failed";
  }

  if (!health.lastDeliveryAt) return "none yet";

  return `${status} ${formatRelativeTime(health.lastDeliveryAt)}`;
}

function actionLabel(action: NotificationAction): string {
  return ACTION_OPTIONS.find((option) => option.value === action)?.label ?? action;
}

function testText(channel: NotificationChannel): string {
  if (!channel.lastTestAt) return "Never tested. Send a test from the row menu.";
  const status = channel.lastTestStatus ?? "unknown";
  const error = channel.lastTestError ? ` — ${redactWebhookUrls(channel.lastTestError)}` : "";

  return `Last test ${formatRelativeTime(channel.lastTestAt)}: ${status}${error}`;
}

function deliveryVariant(status: string): "ghost" | "outline" | "destructive" {
  if (status === "sent" || status === "ok" || status === "delivered") return "ghost";

  if (status === "failed" || status === "error") return "destructive";

  return "outline";
}

async function loadChannelPage(page: PageQuery): Promise<TablePage<NotificationChannel>> {
  const result = await fetchNotificationChannels(page);

  return { rows: result.channels, total: result.total };
}

async function loadDeliveryPage(page: PageQuery): Promise<TablePage<NotificationDelivery>> {
  const result = await fetchNotificationDeliveries(page);

  return { rows: result.deliveries, total: result.total };
}

export default function NotificationsPanel() {
  const { user, permissions } = useApp();
  const canWrite = hasPermissionOrAdmin(user.role, permissions, "notifications.write");

  const [summary, setSummary] = useState<NotificationChannelSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<NotificationChannel | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NotificationChannel | null>(null);

  const channelTable = useServerTable("channels", loadChannelPage);

  const { reload: reloadChannels } = channelTable;
  const deliveryTable = useServerTable("deliveries", loadDeliveryPage);
  const { reload: reloadDeliveries } = deliveryTable;

  // Health is secondary; an unavailable endpoint leaves the column blank.
  const loadSummary = useCallback(async () => {
    const health = await fetchNotificationChannelSummary().catch(() => ({ channels: [] }));

    setSummary(health.channels);
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const load = useCallback(async () => {
    await Promise.all([reloadChannels(), reloadDeliveries(), loadSummary()]);
  }, [reloadChannels, reloadDeliveries, loadSummary]);

  const toggleChannel = async (channel: NotificationChannel, enabled: boolean): Promise<void> => {
    setBusyId(channel.id);

    try {
      await updateNotificationChannel(channel.id, { enabled });
      await reloadChannels();
      toast.success(enabled ? "Channel enabled" : "Channel disabled", {
        description: channel.name,
      });
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusyId(null);
    }
  };

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = async (channel: NotificationChannel): Promise<void> => {
    setBusyId(channel.id);

    try {
      // The list response masks URLs; the admin-only single read returns the
      // full value for the edit dialog.
      const full = await fetchNotificationChannel(channel.id);

      setEditing(full.channel);
      setDialogOpen(true);
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusyId(null);
    }
  };

  const runTest = async (channel: NotificationChannel): Promise<void> => {
    setBusyId(channel.id);

    try {
      await testNotificationChannel(channel.id);
      toast.success("Test notification sent", { description: `Check ${channel.name}.` });
      await load();
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (): Promise<void> => {
    if (!pendingDelete) return;

    const target = pendingDelete;

    setBusyId(target.id);

    try {
      await deleteNotificationChannel(target.id);
      setPendingDelete(null);
      await load();
      toast.success("Channel deleted", { description: target.name });
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
      setPendingDelete(null);
    } finally {
      setBusyId(null);
    }
  };

  const noChannelsYet =
    channelTable.loaded && channelTable.total === 0 && channelTable.activeQuery === "";

  const loading = !channelTable.loaded;

  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={error ?? channelTable.error} />

      {noChannelsYet ? (
        <Card className="items-center px-4 py-10 text-center">
          <BellIcon className="size-5 text-gold/70" />
          <p className="mt-2 font-mono text-xs text-mist-dim">No notification channels yet.</p>
          <p className="mt-1 max-w-md font-mono text-[11px] leading-relaxed text-mist-faint">
            Channels are reused by monitors, backups, and system events. Add a webhook, Discord, or
            Slack destination once and subscribe it to the events you care about.
          </p>
          {canWrite && (
            <Button size="sm" className="mt-3" onClick={openCreate}>
              <PlusIcon data-icon="inline-start" />
              add your first channel
            </Button>
          )}
        </Card>
      ) : (
        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-3">
            <TableSearch
              label="Search channels"
              value={channelTable.query}
              onChange={channelTable.setQuery}
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
              {loading
                ? "loading channels…"
                : `${channelTable.total} ${channelTable.activeQuery === "" ? "" : "matching "}channel${channelTable.total === 1 ? "" : "s"}`}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="chip"
                    size="icon-xs"
                    onClick={() => void load()}
                    aria-label="Refresh"
                  >
                    <RefreshCwIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh channels and deliveries</TooltipContent>
              </Tooltip>
              {/* Hidden while loading: an empty list swaps in its own first-channel button. */}
              {canWrite && !loading && (
                <Button size="sm" onClick={openCreate}>
                  <PlusIcon data-icon="inline-start" />
                  new channel
                </Button>
              )}
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-12 pl-4">
                  <span className="sr-only">enabled</span>
                </TableHead>
                <TableHead>channel</TableHead>
                <TableHead className="hidden md:table-cell">destination</TableHead>
                <TableHead className="hidden lg:table-cell">sends</TableHead>
                <TableHead>last delivery</TableHead>
                <TableHead className="w-10 pr-4">
                  <span className="sr-only">actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={fadeWhileLoading(channelTable)}>
              {loading && <SkeletonRows columns={6} label="Loading channels…" />}
              {channelTable.rows.map((channel) => {
                const Icon = CHANNEL_ICONS[channel.type];
                const health = findHealth(summary, channel.id);
                const busy = busyId === channel.id;

                return (
                  <TableRow
                    key={channel.id}
                    className={channel.enabled ? undefined : "text-mist-faint"}
                  >
                    <TableCell className="pl-4">
                      <Switch
                        checked={channel.enabled}
                        disabled={!canWrite || busy}
                        onCheckedChange={(checked) => void toggleChannel(channel, checked)}
                        aria-label={
                          channel.enabled ? `Disable ${channel.name}` : `Enable ${channel.name}`
                        }
                      />
                    </TableCell>
                    <TableCell className="max-w-56">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Icon className="size-3.5 shrink-0 text-gold/80" aria-hidden="true" />
                        {canWrite ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void openEdit(channel)}
                            className={`truncate text-left font-medium hover:text-gold hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/40 ${channel.enabled ? "text-mist" : "text-mist-dim"}`}
                          >
                            {channel.name}
                          </button>
                        ) : (
                          <span className="truncate font-medium">{channel.name}</span>
                        )}
                        {!channel.enabled && <Badge variant="outline">disabled</Badge>}
                      </div>
                      <span className="mt-0.5 block text-[10px] text-mist-faint">
                        {channel.type}
                      </span>
                    </TableCell>
                    <TableCell className="hidden max-w-52 md:table-cell">
                      <span className="block truncate text-[11px] text-mist-dim">
                        {maskWebhookUrl(channel.url)}
                      </span>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap lg:table-cell">
                      {channel.actions.length === 0 ? (
                        <span className="text-[11px] text-mist-faint">monitor alerts</span>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-[11px] text-mist-dim underline decoration-dotted underline-offset-2">
                              alerts + {channel.actions.length} event
                              {channel.actions.length === 1 ? "" : "s"}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            Monitor alerts, plus: {channel.actions.map(actionLabel).join(", ")}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {health ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant={healthVariant(health)}>{healthLabel(health)}</Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">{testText(channel)}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-[10px] text-mist-faint">—</span>
                      )}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {busy ? (
                        <Spinner className="ml-auto" />
                      ) : (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              disabled={!canWrite}
                              aria-label={`Actions for ${channel.name}`}
                            >
                              <MoreHorizontalIcon />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => void runTest(channel)}>
                              <SendIcon />
                              Send test notification
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void openEdit(channel)}>
                              <PencilIcon />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setPendingDelete(channel)}
                            >
                              <Trash2Icon />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!loading && channelTable.total === 0 && (
                <NoMatchesRow
                  columns={6}
                  query={channelTable.activeQuery}
                  noun="channels"
                  onClear={() => channelTable.setQuery("")}
                />
              )}
            </TableBody>
          </Table>
          <TablePagination table={channelTable} noun="channels" />
        </Card>
      )}

      {!noChannelsYet && (
        <div className="mt-8">
          <div className="k-kicker">
            <span className="text-gold">/</span> recent deliveries
          </div>
          <Card className="mt-3">
            <CardHeader>
              <CardTitle>Delivery history</CardTitle>
              <CardDescription>
                Every attempt across every channel, newest first. Failed deliveries are not retried.
              </CardDescription>
              {(deliveryTable.total > 0 || deliveryTable.activeQuery !== "") && (
                <CardAction className="row-span-1 self-center">
                  <TableSearch
                    label="Search deliveries"
                    value={deliveryTable.query}
                    onChange={deliveryTable.setQuery}
                  />
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>when</TableHead>
                    <TableHead>channel</TableHead>
                    <TableHead>event</TableHead>
                    <TableHead>status</TableHead>
                    <TableHead className="hidden w-full md:table-cell">error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className={fadeWhileLoading(deliveryTable)}>
                  {!deliveryTable.loaded && (
                    <SkeletonRows columns={5} label="Loading deliveries…" />
                  )}
                  {deliveryTable.rows.map((delivery) => (
                    <TableRow key={delivery.id}>
                      <TableCell className="whitespace-nowrap text-mist-faint">
                        {formatRelativeTime(delivery.createdAt)}
                      </TableCell>
                      <TableCell className="max-w-32 truncate text-mist-dim">
                        {delivery.channelName ?? `channel ${delivery.channelId.slice(0, 8)}`}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-mist-dim">
                        {delivery.event}
                      </TableCell>
                      <TableCell>
                        <Badge variant={deliveryVariant(delivery.status)}>{delivery.status}</Badge>
                      </TableCell>
                      <TableCell className="hidden w-full max-w-0 md:table-cell">
                        {delivery.error ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block truncate font-mono text-[10px] text-coral">
                                {redactWebhookUrls(delivery.error)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm">
                              {redactWebhookUrls(delivery.error)}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-[10px] text-mist-faint">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {deliveryTable.loaded &&
                    deliveryTable.total === 0 &&
                    deliveryTable.activeQuery === "" && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={5} className="py-6 text-center text-mist-faint">
                          No deliveries yet. Test a channel to see one here.
                        </TableCell>
                      </TableRow>
                    )}
                  {deliveryTable.loaded &&
                    deliveryTable.total === 0 &&
                    deliveryTable.activeQuery !== "" && (
                      <NoMatchesRow
                        columns={5}
                        query={deliveryTable.activeQuery}
                        noun="deliveries"
                        onClear={() => deliveryTable.setQuery("")}
                      />
                    )}
                </TableBody>
              </Table>
            </CardContent>
            <TablePagination table={deliveryTable} noun="deliveries" className="-mb-4" />
          </Card>
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) setDialogOpen(false);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          {dialogOpen && (
            <ChannelForm
              key={editing?.id ?? "new"}
              channel={editing}
              canWrite={canWrite}
              onCancel={() => setDialogOpen(false)}
              onSaved={async () => {
                setDialogOpen(false);
                await load();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name ?? "this channel"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Monitors that reference it lose this destination, and its delivery history stays
              behind. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              disabled={busyId !== null}
              onClick={() => void remove()}
            >
              {busyId !== null && <Spinner data-icon="inline-start" />}
              Delete channel
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------- channel form ----------

function ChannelForm({
  channel,
  canWrite,
  onCancel,
  onSaved,
}: {
  channel: NotificationChannel | null;
  canWrite: boolean;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(channel?.name ?? "");
  const [url, setUrl] = useState(channel?.url ?? "");
  const [type, setType] = useState<ChannelType>(channel?.type ?? "webhook");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [decoration, setDecoration] = useState(channel?.decoration ?? true);
  const [actions, setActions] = useState<NotificationAction[]>(channel?.actions ?? DEFAULT_ACTIONS);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const toggleAction = (action: NotificationAction, checked: boolean): void => {
    setActions((prev) => {
      if (checked) {
        if (prev.includes(action)) return prev;

        return [...prev, action];
      }

      return prev.filter((item) => item !== action);
    });
  };

  const save = async (): Promise<void> => {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();

    if (!trimmedName) {
      setError("Give the channel a name.");

      return;
    }

    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setError("Channel URLs must start with http:// or https://");

      return;
    }

    const input: NotificationChannelInput = {
      name: trimmedName,
      url: trimmedUrl,
      type,
      enabled,
      decoration,
      actions,
    };

    setSaving(true);
    setError(null);

    try {
      if (channel) await updateNotificationChannel(channel.id, input);
      else await createNotificationChannel(input);

      toast.success(channel ? "Channel updated" : "Channel created", {
        description: trimmedName,
      });
      await onSaved();
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (): Promise<void> => {
    if (!channel) return;

    setTesting(true);
    setError(null);

    try {
      await testNotificationChannel(channel.id);
      toast.success("Test notification sent", { description: channel.name });
    } catch (err) {
      setError(redactWebhookUrls(err instanceof Error ? err.message : String(err)));
    } finally {
      setTesting(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{channel ? `Edit ${channel.name}` : "New notification channel"}</DialogTitle>
        <DialogDescription>
          Webhook URLs are bearer secrets: they stay masked in lists and are only shown here.
        </DialogDescription>
      </DialogHeader>

      <FieldGroup className="mt-4">
        <Field>
          <FieldLabel htmlFor="channel-name">name</FieldLabel>
          <Input
            id="channel-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ops Discord"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="channel-type">type</FieldLabel>
          <Select
            value={type}
            onValueChange={(value) => {
              if (value === "webhook" || value === "discord" || value === "slack") setType(value);
            }}
          >
            <SelectTrigger id="channel-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Destination</SelectLabel>
                <SelectItem value="webhook">webhook</SelectItem>
                <SelectItem value="discord">discord</SelectItem>
                <SelectItem value="slack">slack</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor="channel-url">url</FieldLabel>
          <Input
            id="channel-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={CHANNEL_PLACEHOLDERS[type]}
            spellCheck={false}
            autoComplete="off"
          />
          <FieldDescription>
            Sent with SSRF protection. Private targets require the server-side escape hatch.
          </FieldDescription>
        </Field>

        <div className="grid gap-3 rounded-[5px] border border-white/[0.06] p-3 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-3" htmlFor="channel-enabled">
            <span className="flex flex-col gap-0.5">
              <span className="font-mono text-xs text-mist">enabled</span>
              <span className="font-mono text-[10px] text-mist-faint">
                Disabled channels keep their settings but send nothing.
              </span>
            </span>
            <Switch
              id="channel-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enable channel"
            />
          </label>
          <label className="flex items-center justify-between gap-3" htmlFor="channel-decoration">
            <span className="flex flex-col gap-0.5">
              <span className="font-mono text-xs text-mist">decoration</span>
              <span className="font-mono text-[10px] text-mist-faint">
                Add Kinglet context to the message.
              </span>
            </span>
            <Switch
              id="channel-decoration"
              checked={decoration}
              onCheckedChange={setDecoration}
              aria-label="Decorate notifications"
            />
          </label>
        </div>

        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-mist-faint">
            system events
          </p>
          <div className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {ACTION_OPTIONS.map((option) => (
              <label
                key={option.value}
                htmlFor={`action-${option.value}`}
                className="flex items-start justify-between gap-3 rounded-[4px] border border-white/[0.05] px-2.5 py-2"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-[11px] text-mist">{option.label}</span>
                  <span className="font-mono text-[10px] leading-relaxed text-mist-faint">
                    {option.description}
                  </span>
                </span>
                <Switch
                  id={`action-${option.value}`}
                  checked={actions.includes(option.value)}
                  onCheckedChange={(checked) => toggleAction(option.value, checked)}
                  aria-label={option.label}
                />
              </label>
            ))}
          </div>
          <p className="mt-2 font-mono text-[10px] text-mist-faint">
            Monitor alerts are selected per monitor, not here.
          </p>
        </div>

        {error && <ErrorAlert error={error} />}
      </FieldGroup>

      <DialogFooter className="mt-5">
        {channel && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canWrite || testing || saving}
            onClick={() => void runTest()}
          >
            {testing && <Spinner data-icon="inline-start" />}
            {testing ? "sending…" : "test notification"}
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canWrite || saving}>
          {saving && <Spinner data-icon="inline-start" />}
          {saving ? "saving…" : channel ? "Save changes" : "Create channel"}
        </Button>
      </DialogFooter>
    </form>
  );
}
