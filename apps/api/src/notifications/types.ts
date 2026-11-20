import type { ChannelType } from "../notify.ts";

export type { ChannelType } from "../notify.ts";

/**
 * Global notification channels.
 *
 * A channel owns its action subscriptions (Dokploy-style); monitor alerts are
 * routed separately through `monitor_channels`, because a global "monitor"
 * subscription would fan every project's alerts into one destination.
 *
 * Webhook URLs are bearer secrets. They are masked in list responses and only
 * returned in the admin-only detail/edit response.
 */

export const NOTIFICATION_ACTIONS = [
  "backup.succeeded",
  "backup.failed",
  "backup.restore_staged",
  "archive.succeeded",
  "archive.failed",
  "system.warning",
] as const;

export type NotificationAction = (typeof NOTIFICATION_ACTIONS)[number];

const NOTIFICATION_ACTION_SET = new Set<string>(NOTIFICATION_ACTIONS);

export function isNotificationAction(value: unknown): value is NotificationAction {
  return typeof value === "string" && NOTIFICATION_ACTION_SET.has(value);
}

/**
 * New channels default to failures plus staged restores. Successful backups
 * stay silent unless an operator opts in.
 */
export const DEFAULT_NOTIFICATION_ACTIONS: readonly NotificationAction[] = [
  "backup.failed",
  "backup.restore_staged",
  "archive.failed",
  "system.warning",
];

export type NotificationTestStatus = "ok" | "failed";

export type NotificationDeliveryStatus = "sent" | "failed";

export type NotificationHealthStatus = "ok" | "failed" | "unknown";

export interface NotificationChannelHealth {
  status: NotificationHealthStatus;
  lastDeliveryAt: number | null;
  error?: string | null;
}

export interface NotificationChannel {
  id: string;
  name: string;
  type: ChannelType;
  /** Masked in list responses; the full URL only appears in detail/edit. */
  url: string;
  enabled: boolean;
  decoration: boolean;
  actions: NotificationAction[];
  createdAt: number;
  updatedAt: number;
  lastTestAt: number | null;
  lastTestStatus: NotificationTestStatus | null;
  lastTestError: string | null;
}

/** Safe channel projection for monitor editors: never contains a URL. */
export interface NotificationChannelSummary {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  health: NotificationChannelHealth;
}

/** Alias used on monitor responses (`resolvedChannels`). */
export type MonitorChannelSummary = NotificationChannelSummary;

export interface NotificationDelivery {
  id: string;
  channelId: string;
  channelName?: string | null;
  scope: string;
  event: string;
  subject: string;
  status: NotificationDeliveryStatus;
  error: string | null;
  createdAt: number;
}

/** A normalized, URL-free notification handed to `notifyAction`. */
export interface NotificationField {
  name: string;
  value: string;
}

export interface NotificationEvent {
  action: NotificationAction;
  subject: string;
  summary: string;
  fields?: NotificationField[];
  /** Epoch milliseconds; defaults to now. */
  at?: number;
}

/**
 * Mask a webhook URL for list responses: host plus the tail of the final path
 * segment. Query strings and credentials are always dropped.
 */
export function maskChannelUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    const last = segments[segments.length - 1] ?? "";

    if (!last) return url.origin;
    const tail = last.length > 4 ? `…${last.slice(-4)}` : "…";

    return `${url.origin}/${tail}`;
  } catch {
    return "hidden";
  }
}

/**
 * Sanitized error text for storage, delivery logs, and system-event summaries.
 * URLs are redacted because they may carry tokens, and error pages sometimes
 * echo the target back.
 */
export function safeErrorMessage(error: Error | string, max = 500): string {
  const raw = error instanceof Error ? error.message : error;

  const redacted = raw
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[url]")
    // Bare addresses can name an internal host even when the URL was redacted.
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, "[ip]")
    .replace(/\[[0-9a-f:.]+\](?::\d{1,5})?/gi, "[ip]")
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{0,4}\b/gi, "[ip]")
    .replace(/\b::1?\b/g, "[ip]")
    // Control characters are stripped from untrusted error text.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}
