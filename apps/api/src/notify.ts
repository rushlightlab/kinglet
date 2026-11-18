/**
 * Notification channels for monitor alerts. All of them are plain HTTP
 * POSTs — zero dependencies, and each unlocks a different audience:
 *
 *   webhook → n8n, Zapier, scripts, anything that accepts JSON
 *   discord → a Discord channel via its webhook URL
 *   slack   → a Slack channel via an incoming webhook
 */

export type ChannelType = "webhook" | "discord" | "slack";

export interface NotifyChannel {
  type: ChannelType;
  url: string;
}

export interface AlertNotice {
  monitorId: number;
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

export async function sendNotice(channel: NotifyChannel, notice: AlertNotice): Promise<void> {
  const text = formatText(notice);
  const body =
    channel.type === "webhook"
      ? JSON.stringify({ source: "kinglet", ...notice })
      : channel.type === "discord"
        ? JSON.stringify({ content: text, username: "Kinglet" })
        : JSON.stringify({ text });
  const res = await fetch(channel.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${channel.type} channel returned HTTP ${res.status}`);
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
