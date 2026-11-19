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

  const text = formatText(notice);
  const body =
    channel.type === "webhook"
      ? JSON.stringify({ source: "kinglet", ...notice })
      : channel.type === "discord"
        ? JSON.stringify({ content: text, username: "Kinglet" })
        : JSON.stringify({ text });

  await postJson(new URL(channel.url), body, allowPrivate);
}

function formatText(n: AlertNotice): string {
  const emoji = n.state === "fired" ? "🔥" : n.state === "resolved" ? "✅" : "🔔";
  const lines: string[] = [
    `${emoji} Kinglet · ${n.monitorName} — ${n.state}`,
    n.query ? `Query: ${n.query}` : "Query: (all events)",
  ];
  if (n.summary) lines.push(n.summary);
  if (n.sampleMessage) lines.push(`Sample: ${truncate(n.sampleMessage, 200)}`);
  if (n.link) lines.push(n.link);
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
