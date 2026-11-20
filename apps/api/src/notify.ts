import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";

/**
 * Outbound notification channels for monitor alerts and system events. All of
 * them are plain HTTP POSTs — zero dependencies, and each unlocks a different
 * audience:
 *
 *   webhook → n8n, Zapier, scripts, anything that accepts JSON
 *   discord → a Discord channel via its webhook URL
 *   slack   → a Slack channel via an incoming webhook
 *
 * SSRF hardening:
 *  - non-global-unicast targets are rejected (RFC1918, CGNAT 100.64/10,
 *    loopback, link-local, documentation/benchmark ranges, multicast,
 *    IPv6 ULA/link-local/site-local, IPv4-mapped forms);
 *  - URLs are validated at creation time AND at send time;
 *  - sends resolve DNS once and connect to the vetted IP (no rebinding
 *    TOCTOU window), with the original Host/SNI preserved;
 *  - redirects are refused; requests time out after 10s.
 *
 * KINGLET_ALLOW_PRIVATE_WEBHOOKS=1 is the explicit escape hatch for
 * self-hosted internal automations.
 */

export type ChannelType = "webhook" | "discord" | "slack";

export const CHANNEL_TYPES = ["webhook", "discord", "slack"] as const;

export function isChannelType(value: unknown): value is ChannelType {
  return value === "webhook" || value === "discord" || value === "slack";
}

export interface NotifyChannel {
  type: ChannelType;
  /** Bearer secret: never log, list, or return this to non-admin callers. */
  url: string;
  /** Set for first-class notification channels (delivery logging, health). */
  id?: string;
  name?: string;
  /** Adds an emoji prefix to generic notifications. */
  decoration?: boolean;
}

export interface AlertNotice {
  monitorId: string;
  monitorName: string;
  projectName?: string;
  service?: string | null;
  env?: string | null;
  level?: string | null;
  query: string;
  state: "fired" | "resolved" | "test";
  summary: string;
  count?: number | null;
  threshold?: number | null;
  windowMs?: number | null;
  sampleMessage?: string | null;
  firedAt: number;
  link?: string;
}

function ipv4Private(address: string): boolean {
  const parts = address.split(".").map(Number);
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;

  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT / Tailscale
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Expand an IPv6 literal (including ::, zones, and trailing IPv4) to 8 groups. */
function ipv6Groups(address: string): number[] | null {
  let clean = address;
  const zone = clean.indexOf("%");

  if (zone >= 0) clean = clean.slice(0, zone);
  const v4 = clean.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);

  if (v4) {
    const parts = v4[2]?.split(".").map(Number);

    if (
      !parts ||
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return null;
    }

    const hi = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
    const lo = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
    clean = `${v4[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const halves = clean.split("::");

  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];

  if (halves.length === 1 && left.length !== 8) return null;
  const zeros = 8 - left.length - right.length;

  if (zeros < 0) return null;
  const parts = [...left, ...Array(zeros).fill("0"), ...right];

  if (parts.length !== 8) return null;
  const groups: number[] = [];

  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }

  return groups;
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();

  const family = isIP(normalized);

  if (family === 4) return ipv4Private(normalized);

  if (family !== 6) return false;
  const groups = ipv6Groups(normalized);

  if (!groups) return false;
  const g0 = groups[0] ?? 0;
  const g1 = groups[1] ?? 0;
  const g2 = groups[2] ?? 0;
  const g3 = groups[3] ?? 0;
  const g4 = groups[4] ?? 0;
  const g5 = groups[5] ?? 0;
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;

  // :: and ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 <= 1) {
    return true;
  }

  // fc00::/7 — unique local
  if ((g0 & 0xfe00) === 0xfc00) return true;

  // fe80::/10 — link local
  if ((g0 & 0xffc0) === 0xfe80) return true;

  // fec0::/10 — deprecated site local
  if ((g0 & 0xffc0) === 0xfec0) return true;

  // ff00::/8 — multicast
  if ((g0 & 0xff00) === 0xff00) return true;

  // 2001:db8::/32 — documentation
  if (g0 === 0x2001 && g1 === 0x0db8) return true;

  // 2002::/16 — 6to4
  if (g0 === 0x2002) return true;

  // 64:ff9b::/96 — well-known NAT64 prefix
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;

  // 64:ff9b:1::/48 — local-use NAT64 prefix (RFC 8215). The /48 can embed
  // private IPv4 addresses in several RFC 6052 formats, so reject the whole
  // prefix rather than trying to classify the embedded address.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) return true;

  // 100::/64 — discard-only
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;

  // 2001:0000::/32 — Teredo; 2001:2::/48 — benchmarking; 2001:10::/28 and 2001:20::/28 — ORCHID
  if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0002 || g1 === 0x0010 || g1 === 0x0020))
    return true;

  // ::ffff:0:0/96 — IPv4-mapped, recurse into the IPv4 classifier
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;

    return ipv4Private(v4);
  }

  // ::/96 IPv4-compatible (deprecated)
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    (g6 !== 0 || g7 !== 0)
  ) {
    return true;
  }

  return false;
}

/** Shape-level validation used when creating/updating monitors. */
export function validateWebhookUrl(raw: string, allowPrivate: boolean): string | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return "url is not valid";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "url must start with http:// or https://";
  }

  if (raw.length > 2048) return "url is too long";

  if (url.username || url.password) return "url must not contain credentials";

  if (!allowPrivate) {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

    if (host === "localhost" || host.endsWith(".localhost")) {
      return "loopback targets are blocked (set KINGLET_ALLOW_PRIVATE_WEBHOOKS=1 for internal webhooks)";
    }

    if (isIP(host) !== 0 && isPrivateAddress(host)) {
      return "private/metadata targets are blocked (set KINGLET_ALLOW_PRIVATE_WEBHOOKS=1 for internal webhooks)";
    }
  }

  return null;
}

async function postJson(url: URL, body: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status >= 300 && res.status < 400)
      throw new Error("channel redirected — configure its final URL");

    if (!res.ok) throw new Error(`channel returned HTTP ${res.status}`);

    return;
  }

  // Resolve once, vet every address, then connect to the pinned IP so DNS
  // cannot rebind between the check and the request.
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  let address = host;

  if (isIP(host) === 0) {
    const addresses = await lookup(host, { all: true });

    if (addresses.length === 0) throw new Error("webhook host did not resolve");

    for (const entry of addresses) {
      if (isPrivateAddress(entry.address))
        throw new Error("webhook target resolves to a private address");
    }

    address = addresses[0]?.address ?? host;
  } else if (isPrivateAddress(host)) {
    throw new Error("webhook target is a private address");
  }

  const secure = url.protocol === "https:";
  const transport = secure ? https : http;

  const requestOptions: HttpsRequestOptions = {
    hostname: address,
    port: url.port !== "" ? Number(url.port) : secure ? 443 : 80,
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      host: url.host,
    },
    timeout: 10_000,
  };

  if (secure) requestOptions.servername = url.hostname;

  await new Promise<void>((resolve, reject) => {
    let totalTimer: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (totalTimer) clearTimeout(totalTimer);
    };

    const req = transport.request(requestOptions, (res) => {
      res.on("error", (err) => {
        finish();
        reject(err);
      });
      res.resume();
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400) {
        finish();
        reject(new Error("channel redirected — configure its final URL"));

        return;
      }

      if (status < 200 || status >= 300) {
        finish();
        reject(new Error(`channel returned HTTP ${status}`));

        return;
      }

      finish();
      resolve();
    });

    req.on("timeout", () => req.destroy(new Error("channel timed out")));
    req.on("error", (err) => {
      finish();
      reject(err);
    });
    totalTimer = setTimeout(() => {
      req.destroy(new Error("channel timed out"));
    }, 10_000);
    totalTimer.unref();
    req.end(body);
  });
}

/**
 * Shared send path for every channel type. Validation happens here so a URL
 * that was accepted at creation time is still checked at send time.
 */
async function deliver(channel: NotifyChannel, body: string, allowPrivate: boolean): Promise<void> {
  const invalid = validateWebhookUrl(channel.url, allowPrivate);

  if (invalid) throw new Error(invalid);

  await postJson(new URL(channel.url), body, allowPrivate);
}

export async function sendNotice(
  channel: NotifyChannel,
  notice: AlertNotice,
  opts: { allowPrivate?: boolean } = {},
): Promise<void> {
  const allowPrivate = opts.allowPrivate ?? false;

  const body =
    channel.type === "webhook"
      ? JSON.stringify({ source: "kinglet", text: formatText(notice), ...notice })
      : channel.type === "discord"
        ? JSON.stringify(discordPayload(notice))
        : JSON.stringify(slackPayload(notice));

  await deliver(channel, body, allowPrivate);
}

/**
 * Generic notification used by backup/archive/system events. The webhook
 * payload is a stable JSON contract; Discord and Slack get the same content
 * shaped as an embed/attachment.
 */
export interface GenericNoticeField {
  name: string;
  value: string;
}

export interface GenericNotice {
  action: string;
  subject: string;
  summary: string;
  fields?: GenericNoticeField[];
  /** Epoch milliseconds. */
  at: number;
}

interface GenericActionMeta {
  emoji: string;
  label: string;
  color: number;
  hex: string;
}

function genericActionMeta(action: string): GenericActionMeta {
  switch (action) {
    case "backup.succeeded":
      return { emoji: "✅", label: "Backup succeeded", color: 0x7dd3a1, hex: "#7dd3a1" };
    case "backup.failed":
      return { emoji: "⚠️", label: "Backup failed", color: 0xff5c33, hex: "#ff5c33" };
    case "backup.restore_staged":
      return { emoji: "♻️", label: "Restore staged", color: 0xfbbf24, hex: "#fbbf24" };
    case "archive.succeeded":
      return { emoji: "✅", label: "Archive succeeded", color: 0x7dd3a1, hex: "#7dd3a1" };
    case "archive.failed":
      return { emoji: "⚠️", label: "Archive failed", color: 0xff5c33, hex: "#ff5c33" };
    case "system.warning":
      return { emoji: "⚠️", label: "Kinglet warning", color: 0xfbbf24, hex: "#fbbf24" };
    default:
      return { emoji: "🔔", label: "Kinglet notification", color: 0xfbbf24, hex: "#fbbf24" };
  }
}

function sanitizedGenericFields(
  fields: readonly GenericNoticeField[] | undefined,
): GenericNoticeField[] {
  const safe: GenericNoticeField[] = [];

  for (const field of fields ?? []) {
    const name = sanitizeNotificationText(field.name, 80);

    if (!name) continue;
    safe.push({ name, value: sanitizeNotificationText(field.value, 1000) });
  }

  return safe;
}

interface GenericWebhookPayload {
  source: "kinglet";
  action: string;
  subject: string;
  summary: string;
  fields?: GenericNoticeField[];
  at: number;
}

function genericWebhookBody(notice: GenericNotice): string {
  const payload: GenericWebhookPayload = {
    source: "kinglet",
    action: notice.action.slice(0, 120),
    subject: sanitizeNotificationText(notice.subject, 200),
    summary: sanitizeNotificationText(notice.summary, 1000),
    at: notice.at,
  };

  const fields = sanitizedGenericFields(notice.fields);

  if (fields.length > 0) payload.fields = fields;

  return JSON.stringify(payload);
}

function genericDiscordFields(notice: GenericNotice): NoticeField[] {
  const fields: NoticeField[] = [
    { name: "Action", value: notificationCode(notice.action), inline: true },
  ];

  for (const field of sanitizedGenericFields(notice.fields)) {
    fields.push({ name: field.name, value: field.value, inline: true });
  }

  // Discord caps field values at 1024 characters.
  return fields.map((field) => ({ ...field, value: truncate(field.value, 1000) }));
}

function genericDiscordPayload(notice: GenericNotice, decoration: boolean): DiscordPayload {
  const meta = genericActionMeta(notice.action);

  const embed: DiscordEmbed = {
    title: `${decoration ? `${meta.emoji} ` : ""}${meta.label}`,
    color: meta.color,
    fields: genericDiscordFields(notice),
    timestamp: new Date(notice.at).toISOString(),
    footer: { text: "Kinglet" },
  };

  if (notice.summary) embed.description = sanitizeNotificationText(notice.summary, 1000);

  return { username: "Kinglet", embeds: [embed] };
}

function genericSlackPayload(notice: GenericNotice, decoration: boolean): SlackPayload {
  const meta = genericActionMeta(notice.action);
  const textParts: string[] = [];

  if (notice.summary) textParts.push(sanitizeNotificationText(notice.summary, 1000));

  return {
    text: `${decoration ? `${meta.emoji} ` : ""}Kinglet · ${meta.label.toLowerCase()}`,
    attachments: [
      {
        color: meta.hex,
        title: `${decoration ? `${meta.emoji} ` : ""}${meta.label}`,
        text: textParts.join("\n"),
        fields: genericDiscordFields(notice).map((field) => ({
          title: field.name,
          value: field.value,
          short: field.inline,
        })),
        footer: "Kinglet",
        ts: Math.floor(notice.at / 1000),
      },
    ],
  };
}

export async function sendGeneric(
  channel: NotifyChannel,
  notice: GenericNotice,
  opts: { allowPrivate?: boolean } = {},
): Promise<void> {
  const allowPrivate = opts.allowPrivate ?? false;
  const decoration = channel.decoration === true;

  const body =
    channel.type === "webhook"
      ? genericWebhookBody(notice)
      : channel.type === "discord"
        ? JSON.stringify(genericDiscordPayload(notice, decoration))
        : JSON.stringify(genericSlackPayload(notice, decoration));

  await deliver(channel, body, allowPrivate);
}

interface NoticeField {
  name: string;
  value: string;
  inline: boolean;
}

interface DiscordEmbed {
  title: string;
  color: number;
  fields: NoticeField[];
  timestamp: string;
  footer: { text: string };
  description?: string;
}

interface DiscordPayload {
  username: string;
  embeds: DiscordEmbed[];
}

interface SlackField {
  title: string;
  value: string;
  short: boolean;
}

interface SlackAttachment {
  color: string;
  title: string;
  text: string;
  fields: SlackField[];
  footer: string;
  ts: number;
}

interface SlackPayload {
  text: string;
  attachments: SlackAttachment[];
}

const STATE_META: Record<
  AlertNotice["state"],
  { emoji: string; title: string; color: number; hex: string }
> = {
  fired: { emoji: "🔥", title: "Monitor fired", color: 0xff5c33, hex: "#ff5c33" },
  resolved: { emoji: "✅", title: "Monitor resolved", color: 0x7dd3a1, hex: "#7dd3a1" },
  test: { emoji: "🔔", title: "Test notification", color: 0xfbbf24, hex: "#fbbf24" },
};

function durationLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;

  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;

  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;

  return `${Math.round(ms / 86_400_000)}d`;
}

function codeBlock(text: string): string {
  const cleaned = text.replace(/```/g, "'''");

  return `\`\`\`\n${truncate(cleaned, 900)}\n\`\`\``;
}

/**
 * Event text is untrusted. Flatten line breaks and neutralize chat markup and
 * mention syntax before it reaches Discord, Slack, or a line-oriented webhook.
 */
export function sanitizeNotificationText(value: string, max: number): string {
  const flattened = value
    .replace(/[\r\n]+/g, " ")
    // Control characters are stripped from untrusted event text.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    // Escape existing backslashes before adding markdown escapes below.
    // Otherwise an attacker-supplied "\[" becomes "\\[", where the doubled
    // backslash is consumed as a literal and the bracket becomes active.
    .replace(/\\/g, "\\\\")
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/([*_~`|])/g, "\\$1")
    .replace(/\s+/g, " ")
    .trim();

  return truncate(flattened, max);
}

function notificationCode(value: string): string {
  return `\`${sanitizeNotificationText(value, 120)}\``;
}

function noticeFields(n: AlertNotice, formatLink: (url: string) => string): NoticeField[] {
  const fields: NoticeField[] = [];

  if (n.projectName)
    fields.push({
      name: "Project",
      value: sanitizeNotificationText(n.projectName, 200),
      inline: true,
    });

  if (n.service)
    fields.push({ name: "Service", value: sanitizeNotificationText(n.service, 200), inline: true });

  if (n.env)
    fields.push({ name: "Env", value: sanitizeNotificationText(n.env, 200), inline: true });
  fields.push({
    name: "Monitor",
    value: sanitizeNotificationText(n.monitorName || "—", 200),
    inline: true,
  });

  if (n.level)
    fields.push({ name: "Level", value: sanitizeNotificationText(n.level, 40), inline: true });
  fields.push({
    name: "Query",
    value: n.query ? `\`${sanitizeNotificationText(n.query, 400)}\`` : "all events",
    inline: true,
  });

  if (n.state === "fired") {
    if (n.count !== undefined && n.count !== null) {
      fields.push({ name: "Count", value: String(n.count), inline: true });
    }

    if (n.threshold !== undefined && n.threshold !== null) {
      fields.push({ name: "Threshold", value: String(n.threshold), inline: true });
    }

    if (n.windowMs !== undefined && n.windowMs !== null) {
      fields.push({ name: "Window", value: durationLabel(n.windowMs), inline: true });
    }
  }

  if (n.link) {
    fields.push({ name: "Link", value: formatLink(n.link), inline: false });
  }

  // Discord caps field values at 1024 characters.
  return fields.map((field) => ({ ...field, value: truncate(field.value, 1000) }));
}

export function discordPayload(n: AlertNotice): DiscordPayload {
  const meta = STATE_META[n.state];
  const fields = noticeFields(n, (url) => `[Open in Kinglet](${url})`);

  if (n.sampleMessage) {
    const linkIndex = fields.findIndex((field) => field.name === "Link");

    const sample = {
      name: "Sample",
      value: codeBlock(n.sampleMessage),
      inline: false,
    };

    if (linkIndex >= 0) fields.splice(linkIndex, 0, sample);
    else fields.push(sample);
  }

  const embed: DiscordEmbed = {
    title: `${meta.emoji} ${meta.title}`,
    color: meta.color,
    fields,
    timestamp: new Date(n.firedAt).toISOString(),
    footer: { text: "Kinglet" },
  };

  if (n.summary) embed.description = sanitizeNotificationText(n.summary, 1000);

  return { username: "Kinglet", embeds: [embed] };
}

export function slackPayload(n: AlertNotice): SlackPayload {
  const meta = STATE_META[n.state];
  const textParts: string[] = [];

  if (n.summary) textParts.push(sanitizeNotificationText(n.summary, 1000));

  if (n.sampleMessage) textParts.push(codeBlock(n.sampleMessage));

  return {
    text: `${meta.emoji} Kinglet · ${meta.title.toLowerCase()}`,
    attachments: [
      {
        color: meta.hex,
        title: `${meta.emoji} ${meta.title}`,
        text: textParts.join("\n"),
        fields: noticeFields(n, (url) => `<${url}|Open in Kinglet>`).map((field) => ({
          title: field.name,
          value: field.value,
          short: field.inline,
        })),
        footer: "Kinglet",
        ts: Math.floor(n.firedAt / 1000),
      },
    ],
  };
}

function formatText(n: AlertNotice): string {
  const meta = STATE_META[n.state];
  const lines: string[] = [`${meta.emoji} Kinglet · ${meta.title.toLowerCase()}`];

  if (n.projectName) lines.push(`Project: ${sanitizeNotificationText(n.projectName, 200)}`);
  lines.push(`Monitor: ${sanitizeNotificationText(n.monitorName || "—", 200)}`);

  if (n.service) lines.push(`Service: ${sanitizeNotificationText(n.service, 200)}`);

  if (n.env) lines.push(`Env: ${sanitizeNotificationText(n.env, 200)}`);

  if (n.level) lines.push(`Level: ${sanitizeNotificationText(n.level, 40)}`);
  lines.push(n.query ? `Query: ${sanitizeNotificationText(n.query, 400)}` : "Query: all events");

  if (n.summary) lines.push(sanitizeNotificationText(n.summary, 1000));

  if (n.count !== undefined && n.count !== null) lines.push(`Count: ${n.count}`);

  if (n.threshold !== undefined && n.threshold !== null) {
    lines.push(`Threshold: ${n.threshold}`);
  }

  if (n.windowMs !== undefined && n.windowMs !== null) {
    lines.push(`Window: ${durationLabel(n.windowMs)}`);
  }

  if (n.sampleMessage) lines.push(`Sample: ${sanitizeNotificationText(n.sampleMessage, 300)}`);

  if (n.link) lines.push(n.link);

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
