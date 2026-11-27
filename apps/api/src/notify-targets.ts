import type { JsonObject, JsonValue } from "./json.ts";

/**
 * Channel targets beyond plain webhooks: push services (ntfy, Gotify,
 * Pushover), Telegram, and email (SMTP, Resend, Plunk).
 *
 * Every channel keeps a single secret `url`, so storage, masking, duplicate
 * checks, and the admin-only reveal work the same for every type. Each type
 * has a canonical URL that carries its whole target:
 *
 *   ntfy      https://ntfy.sh/<topic>[?auth=<token>]   (self-hosted servers too)
 *   gotify    https://<server>/message?token=<app token>
 *   telegram  https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat>
 *   pushover  https://api.pushover.net/1/messages.json?token=<app>&user=<user>
 *   email     mailto:<address>[,<address>…]            (SMTP server from env)
 *   resend    https://api.resend.com/emails?key=<key>&from=<from>&to=<a,b>
 *   plunk     https://api.useplunk.com/v1/send?key=<key>&to=<a,b>
 *
 * This module only parses targets and builds requests; it never touches the
 * network. Delivery, SSRF checks, and pinned connections live in notify.ts.
 * Telegram, Pushover, Resend, and Plunk may only reach their official hosts.
 */

export const TARGET_TYPES = [
  "ntfy",
  "gotify",
  "telegram",
  "pushover",
  "email",
  "resend",
  "plunk",
] as const;

export type TargetType = (typeof TARGET_TYPES)[number];

export function isTargetType(value: string | JsonValue | undefined): value is TargetType {
  return TARGET_TYPES.some((type) => type === value);
}

export type ChannelTarget =
  | { type: "ntfy"; publishUrl: string; topic: string; auth: string | null }
  | { type: "gotify"; url: string }
  | { type: "telegram"; token: string; chatId: string }
  | { type: "pushover"; token: string; user: string }
  | { type: "email"; to: string[] }
  | { type: "resend"; key: string; from: string; to: string[] }
  | { type: "plunk"; key: string; to: string[] };

export type TargetParse = { ok: true; target: ChannelTarget } | { ok: false; error: string };

/** At most this many recipients per email channel. */
export const MAX_EMAIL_RECIPIENTS = 10;

const EMAIL = /^[^\s@<>()[\],;:"\\]{1,64}@[^\s@<>()[\],;:"\\]{1,190}\.[A-Za-z]{2,24}$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

/** `a@x.io, b@y.io` → addresses, or an error naming the first bad one. */
export function parseRecipients(
  raw: string,
): { ok: true; to: string[] } | { ok: false; error: string } {
  const to = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (to.length === 0) return { ok: false, error: "add at least one recipient" };

  if (to.length > MAX_EMAIL_RECIPIENTS) {
    return { ok: false, error: `at most ${MAX_EMAIL_RECIPIENTS} recipients` };
  }

  const bad = to.find((address) => !isEmailAddress(address));

  if (bad !== undefined) return { ok: false, error: `${bad} is not an email address` };

  return { ok: true, to: [...new Set(to.map((address) => address.toLowerCase()))] };
}

/** `ops@x.io` or `Kinglet <ops@x.io>`; display names are plain text only. */
function isSender(value: string): boolean {
  const named = /^([^<>"\r\n]{1,64}) <([^<>]+)>$/.exec(value);

  return named ? isEmailAddress(named[2] ?? "") : isEmailAddress(value);
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Only the listed query parameters may appear, so nothing rides along unseen. */
function onlyParams(url: URL, allowed: readonly string[]): boolean {
  return [...url.searchParams.keys()].every((key) => allowed.includes(key));
}

function officialHost(url: URL, host: string, path: RegExp): boolean {
  return (
    url.protocol === "https:" && url.hostname === host && url.port === "" && path.test(url.pathname)
  );
}

function parseNtfy(url: URL): TargetParse {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "ntfy needs an http(s) server URL" };
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const topic = segments.at(-1) ?? "";

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
    return { ok: false, error: "ntfy topic must be 1-64 letters, digits, - or _" };
  }

  if (!onlyParams(url, ["auth"])) return { ok: false, error: "ntfy URL has unknown parameters" };
  const auth = url.searchParams.get("auth");

  if (auth !== null && !/^[A-Za-z0-9+/=_-]{8,512}$/.test(auth)) {
    return { ok: false, error: "ntfy access token is not valid" };
  }

  // JSON publishing posts to the server root (or the path it is served under).
  const prefix = segments.slice(0, -1).join("/");

  return {
    ok: true,
    target: {
      type: "ntfy",
      publishUrl: `${url.origin}/${prefix ? `${prefix}/` : ""}`,
      topic,
      auth,
    },
  };
}

function parseGotify(url: URL): TargetParse {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Gotify needs an http(s) server URL" };
  }

  if (!url.pathname.endsWith("/message")) {
    return { ok: false, error: "Gotify URL must end in /message" };
  }

  const token = url.searchParams.get("token") ?? "";

  if (!/^[A-Za-z0-9._-]{8,128}$/.test(token) || !onlyParams(url, ["token"])) {
    return { ok: false, error: "Gotify needs an application token" };
  }

  return { ok: true, target: { type: "gotify", url: url.toString() } };
}

function parseTelegram(url: URL): TargetParse {
  const path = /^\/bot(\d{1,20}:[A-Za-z0-9_-]{20,64})\/sendMessage$/;

  if (!officialHost(url, "api.telegram.org", path)) {
    return { ok: false, error: "Telegram needs a bot token" };
  }

  const token = path.exec(url.pathname)?.[1] ?? "";
  const chatId = url.searchParams.get("chat_id") ?? "";

  if (!/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(chatId) || !onlyParams(url, ["chat_id"])) {
    return { ok: false, error: "Telegram chat ID must be a number or @channelname" };
  }

  return { ok: true, target: { type: "telegram", token, chatId } };
}

function parsePushover(url: URL): TargetParse {
  if (!officialHost(url, "api.pushover.net", /^\/1\/messages\.json$/)) {
    return { ok: false, error: "Pushover URL is not valid" };
  }

  const token = url.searchParams.get("token") ?? "";
  const user = url.searchParams.get("user") ?? "";
  const key = /^[A-Za-z0-9]{20,40}$/;

  if (!key.test(token)) return { ok: false, error: "Pushover needs an application token" };

  if (!key.test(user)) return { ok: false, error: "Pushover needs a user or group key" };

  if (!onlyParams(url, ["token", "user"])) {
    return { ok: false, error: "Pushover URL has unknown parameters" };
  }

  return { ok: true, target: { type: "pushover", token, user } };
}

function parseEmail(raw: string): TargetParse {
  if (!raw.toLowerCase().startsWith("mailto:")) {
    return { ok: false, error: "email target must be mailto:addresses" };
  }

  let list: string;

  try {
    list = decodeURIComponent(raw.slice("mailto:".length));
  } catch {
    return { ok: false, error: "email recipients are not valid" };
  }

  const recipients = parseRecipients(list);

  return recipients.ok ? { ok: true, target: { type: "email", to: recipients.to } } : recipients;
}

function parseResend(url: URL): TargetParse {
  if (!officialHost(url, "api.resend.com", /^\/emails$/)) {
    return { ok: false, error: "Resend URL is not valid" };
  }

  const key = url.searchParams.get("key") ?? "";
  const from = url.searchParams.get("from") ?? "";

  if (!/^re_[A-Za-z0-9_]{8,128}$/.test(key)) {
    return { ok: false, error: "Resend needs an API key (re_…)" };
  }

  if (!isSender(from)) return { ok: false, error: "Resend needs a from address" };
  const recipients = parseRecipients(url.searchParams.get("to") ?? "");

  if (!recipients.ok) return recipients;

  if (!onlyParams(url, ["key", "from", "to"])) {
    return { ok: false, error: "Resend URL has unknown parameters" };
  }

  return { ok: true, target: { type: "resend", key, from, to: recipients.to } };
}

function parsePlunk(url: URL): TargetParse {
  if (!officialHost(url, "api.useplunk.com", /^\/v1\/send$/)) {
    return { ok: false, error: "Plunk URL is not valid" };
  }

  const key = url.searchParams.get("key") ?? "";

  if (!/^sk_[A-Za-z0-9_]{8,128}$/.test(key)) {
    return { ok: false, error: "Plunk needs a secret API key (sk_…)" };
  }

  const recipients = parseRecipients(url.searchParams.get("to") ?? "");

  if (!recipients.ok) return recipients;

  if (!onlyParams(url, ["key", "to"])) {
    return { ok: false, error: "Plunk URL has unknown parameters" };
  }

  return { ok: true, target: { type: "plunk", key, to: recipients.to } };
}

/** Parse a stored channel URL into its target. Pure: no DNS, no network. */
export function parseChannelTarget(type: TargetType, raw: string): TargetParse {
  if (raw.length > 2048) return { ok: false, error: "target is too long" };

  if (type === "email") return parseEmail(raw);
  const url = parseUrl(raw);

  if (url === null) return { ok: false, error: "url is not valid" };

  if (url.username || url.password) return { ok: false, error: "url must not contain credentials" };

  switch (type) {
    case "ntfy":
      return parseNtfy(url);
    case "gotify":
      return parseGotify(url);
    case "telegram":
      return parseTelegram(url);
    case "pushover":
      return parsePushover(url);
    case "resend":
      return parseResend(url);
    case "plunk":
      return parsePlunk(url);
  }
}

// ---------- messages ----------

export type MessageLevel = "alert" | "ok" | "info";

/** A notification as plain text, before it is shaped for one service. */
export interface PlainMessage {
  title: string;
  /** Lines of body text, already sanitized. */
  lines: string[];
  level: MessageLevel;
  /** A link back to Kinglet, when one exists. */
  link?: string;
}

/**
 * Event text is untrusted. These channels render plain text, so strip control
 * characters and flatten whitespace; no chat markup escaping is needed.
 */
export function plainNotificationText(value: string, max: number): string {
  const flattened = value
    // Control characters are stripped from untrusted event text.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    // Bidi overrides would reorder how the text is displayed.
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened;
}

function bodyText(message: PlainMessage, max: number): string {
  const text = [...message.lines, ...(message.link ? [message.link] : [])].join("\n");

  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** An HTTP POST the delivery layer sends (after its SSRF checks). */
export interface TargetRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  /** Self-hosted servers (ntfy, Gotify) may be private when explicitly allowed. */
  selfHosted: boolean;
}

/** An email for the SMTP channel; the sender address comes from the server config. */
export interface TargetEmail {
  to: string[];
  subject: string;
  text: string;
}

const JSON_HEADERS = { "content-type": "application/json" };
const NTFY_PRIORITY: Record<MessageLevel, number> = { alert: 4, ok: 3, info: 3 };

const NTFY_TAGS: Record<MessageLevel, string> = {
  alert: "rotating_light",
  ok: "white_check_mark",
  info: "bell",
};

const GOTIFY_PRIORITY: Record<MessageLevel, number> = { alert: 8, ok: 5, info: 4 };
const PUSHOVER_PRIORITY: Record<MessageLevel, number> = { alert: 1, ok: 0, info: 0 };

export function emailFor(
  target: ChannelTarget & { type: "email" },
  message: PlainMessage,
): TargetEmail {
  return { to: target.to, subject: message.title, text: bodyText(message, 10_000) };
}

function ntfyRequest(
  target: ChannelTarget & { type: "ntfy" },
  message: PlainMessage,
): TargetRequest {
  const payload: JsonObject = {
    topic: target.topic,
    title: message.title,
    message: bodyText(message, 4000),
    priority: NTFY_PRIORITY[message.level],
    tags: [NTFY_TAGS[message.level]],
  };

  if (message.link) payload.click = message.link;

  return {
    url: target.auth
      ? `${target.publishUrl}?auth=${encodeURIComponent(target.auth)}`
      : target.publishUrl,
    headers: JSON_HEADERS,
    selfHosted: true,
    body: JSON.stringify(payload),
  };
}

function gotifyRequest(
  target: ChannelTarget & { type: "gotify" },
  message: PlainMessage,
): TargetRequest {
  const payload: JsonObject = {
    title: message.title,
    message: bodyText(message, 4000),
    priority: GOTIFY_PRIORITY[message.level],
  };

  if (message.link) {
    payload.extras = { "client::notification": { click: { url: message.link } } };
  }

  return {
    url: target.url,
    headers: JSON_HEADERS,
    selfHosted: true,
    body: JSON.stringify(payload),
  };
}

function pushoverRequest(
  target: ChannelTarget & { type: "pushover" },
  message: PlainMessage,
): TargetRequest {
  const payload: JsonObject = {
    token: target.token,
    user: target.user,
    title: message.title.slice(0, 250),
    message: bodyText(message, 1000),
    priority: PUSHOVER_PRIORITY[message.level],
  };

  if (message.link) {
    payload.url = message.link;
    payload.url_title = "Open in Kinglet";
  }

  return {
    url: "https://api.pushover.net/1/messages.json",
    headers: JSON_HEADERS,
    selfHosted: false,
    body: JSON.stringify(payload),
  };
}

function resendRequest(
  target: ChannelTarget & { type: "resend" },
  message: PlainMessage,
  html: string | null,
): TargetRequest {
  const payload: JsonObject = {
    from: target.from,
    to: target.to,
    subject: message.title,
    text: bodyText(message, 10_000),
  };

  if (html !== null) payload.html = html;

  return {
    url: "https://api.resend.com/emails",
    headers: { ...JSON_HEADERS, authorization: `Bearer ${target.key}` },
    selfHosted: false,
    body: JSON.stringify(payload),
  };
}

/**
 * The request for an HTTP-delivered target. Email over SMTP has no request.
 * `html` is the rendered email for Resend and Plunk, when there is one.
 */
export function requestFor(
  target: Exclude<ChannelTarget, { type: "email" }>,
  message: PlainMessage,
  html: string | null = null,
): TargetRequest {
  switch (target.type) {
    case "ntfy":
      return ntfyRequest(target, message);
    case "gotify":
      return gotifyRequest(target, message);
    case "pushover":
      return pushoverRequest(target, message);
    case "telegram":
      return {
        url: `https://api.telegram.org/bot${target.token}/sendMessage`,
        headers: JSON_HEADERS,
        selfHosted: false,
        // No parse_mode: the text is sent as-is, so event text can't inject markup.
        body: JSON.stringify({
          chat_id: target.chatId,
          text: `${message.title}\n\n${bodyText(message, 3800)}`,
          disable_web_page_preview: true,
        }),
      };
    case "resend":
      return resendRequest(target, message, html);
    case "plunk":
      return {
        url: "https://api.useplunk.com/v1/send",
        headers: { ...JSON_HEADERS, authorization: `Bearer ${target.key}` },
        selfHosted: false,
        // Plunk renders the body as HTML: the rendered email, or escaped text.
        body: JSON.stringify({
          to: target.to.length === 1 ? target.to[0] : target.to,
          subject: message.title,
          body: html ?? bodyText(message, 10_000).split("\n").map(escapeHtml).join("<br>"),
        }),
      };
  }
}
