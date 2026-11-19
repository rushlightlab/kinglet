import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * Notification channels for monitor alerts. All of them are plain HTTP
 * POSTs — zero dependencies, and each unlocks a different audience:
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

export interface NotifyChannel {
  type: ChannelType;
  url: string;
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

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    const c = parts[2] ?? 0;
    return (
      a === 0 ||
      a === 10 ||
      a === 100 && b >= 64 && b <= 127 || // CGNAT / Tailscale
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
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fec0")) return true;
  if (lower.startsWith("64:ff9b")) return true;
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
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
    const host = url.hostname.toLowerCase();
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
    if (res.status >= 300 && res.status < 400) throw new Error("channel redirected — configure its final URL");
    if (!res.ok) throw new Error(`channel returned HTTP ${res.status}`);
    return;
  }

  // Resolve once, vet every address, then connect to the pinned IP so DNS
  // cannot rebind between the check and the request.
  const host = url.hostname;
  let address = host;
  if (isIP(host) === 0) {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) throw new Error("webhook host did not resolve");
    for (const entry of addresses) {
      if (isPrivateAddress(entry.address)) throw new Error("webhook target resolves to a private address");
    }
    address = addresses[0]?.address ?? host;
  } else if (isPrivateAddress(host)) {
    throw new Error("webhook target is a private address");
  }

  const secure = url.protocol === "https:";
  const transport = secure ? https : http;
  await new Promise<void>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: address,
        port: url.port !== "" ? Number(url.port) : secure ? 443 : 80,
        path: url.pathname + url.search,
        method: "POST",
        ...(secure ? { servername: url.hostname } : {}),
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          host: url.host,
        },
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          reject(new Error("channel redirected — configure its final URL"));
          return;
        }
        if (status < 200 || status >= 300) {
          reject(new Error(`channel returned HTTP ${status}`));
          return;
        }
        resolve();
      }
    );
    req.on("timeout", () => req.destroy(new Error("channel timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

export async function sendNotice(
  channel: NotifyChannel,
  notice: AlertNotice,
  opts: { allowPrivate?: boolean } = {}
): Promise<void> {
  const allowPrivate = opts.allowPrivate ?? false;
  const invalid = validateWebhookUrl(channel.url, allowPrivate);
  if (invalid) throw new Error(invalid);

  const body =
    channel.type === "webhook"
      ? JSON.stringify({ source: "kinglet", text: formatText(notice), ...notice })
      : channel.type === "discord"
        ? JSON.stringify(discordPayload(notice))
        : JSON.stringify(slackPayload(notice));

  await postJson(new URL(channel.url), body, allowPrivate);
}

interface NoticeField {
  name: string;
  value: string;
  inline: boolean;
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

function noticeFields(
  n: AlertNotice,
  formatLink: (url: string) => string
): NoticeField[] {
  const fields: NoticeField[] = [];
  if (n.projectName) fields.push({ name: "Project", value: n.projectName, inline: true });
  if (n.service) fields.push({ name: "Service", value: n.service, inline: true });
  if (n.env) fields.push({ name: "Env", value: n.env, inline: true });
  fields.push({ name: "Monitor", value: n.monitorName || "—", inline: true });
  if (n.level) fields.push({ name: "Level", value: n.level, inline: true });
  fields.push({
    name: "Query",
    value: n.query ? `\`${n.query}\`` : "all events",
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

export function discordPayload(n: AlertNotice): Record<string, unknown> {
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
  const embed: Record<string, unknown> = {
    title: `${meta.emoji} ${meta.title}`,
    color: meta.color,
    fields,
    timestamp: new Date(n.firedAt).toISOString(),
    footer: { text: "Kinglet" },
  };
  if (n.summary) embed.description = truncate(n.summary, 1000);
  return { username: "Kinglet", embeds: [embed] };
}

export function slackPayload(n: AlertNotice): Record<string, unknown> {
  const meta = STATE_META[n.state];
  const textParts: string[] = [];
  if (n.summary) textParts.push(n.summary);
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
  if (n.projectName) lines.push(`Project: ${n.projectName}`);
  lines.push(`Monitor: ${n.monitorName || "—"}`);
  if (n.service) lines.push(`Service: ${n.service}`);
  if (n.env) lines.push(`Env: ${n.env}`);
  if (n.level) lines.push(`Level: ${n.level}`);
  lines.push(n.query ? `Query: ${n.query}` : "Query: all events");
  if (n.summary) lines.push(n.summary);
  if (n.count !== undefined && n.count !== null) lines.push(`Count: ${n.count}`);
  if (n.threshold !== undefined && n.threshold !== null) {
    lines.push(`Threshold: ${n.threshold}`);
  }
  if (n.windowMs !== undefined && n.windowMs !== null) {
    lines.push(`Window: ${durationLabel(n.windowMs)}`);
  }
  if (n.sampleMessage) lines.push(`Sample: ${truncate(n.sampleMessage, 300)}`);
  if (n.link) lines.push(n.link);
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
