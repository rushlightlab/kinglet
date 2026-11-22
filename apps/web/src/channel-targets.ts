import type { ChannelType } from "./types";

/**
 * The channel form asks for each service's own settings (bot token, chat ID,
 * recipients…) and builds the single target URL the API stores. Editing reads
 * the URL back into those fields. Formats match apps/api/src/notify-targets.ts.
 */

export interface TargetField {
  key: string;
  label: string;
  placeholder: string;
  /** Typed into a password-style field. */
  secret?: boolean;
  optional?: boolean;
  hint?: string;
  /** Pre-filled for new channels. */
  initial?: string;
}

export interface ChannelTypeInfo {
  type: ChannelType;
  label: string;
  group: "Chat" | "Push" | "Email";
  fields: TargetField[];
  /** One line under the fields: where to find the values. */
  help: string;
}

const RECIPIENTS: TargetField = {
  key: "to",
  label: "recipients",
  placeholder: "ops@example.com, oncall@example.com",
  hint: "Up to 10 addresses, separated by commas.",
};

export const CHANNEL_TYPES: readonly ChannelTypeInfo[] = [
  {
    type: "webhook",
    label: "Webhook",
    group: "Chat",
    fields: [{ key: "url", label: "url", placeholder: "https://example.com/webhooks/kinglet" }],
    help: "Kinglet POSTs JSON to this URL: n8n, Zapier, or your own script.",
  },
  {
    type: "discord",
    label: "Discord",
    group: "Chat",
    fields: [
      { key: "url", label: "webhook url", placeholder: "https://discord.com/api/webhooks/…" },
    ],
    help: "Channel settings → Integrations → Webhooks → Copy Webhook URL.",
  },
  {
    type: "slack",
    label: "Slack",
    group: "Chat",
    fields: [
      { key: "url", label: "webhook url", placeholder: "https://hooks.slack.com/services/…" },
    ],
    help: "An incoming webhook URL from a Slack app. Mattermost and Rocket.Chat accept it too.",
  },
  {
    type: "telegram",
    label: "Telegram",
    group: "Chat",
    fields: [
      {
        key: "token",
        label: "bot token",
        placeholder: "123456789:AAE…",
        secret: true,
        hint: "From @BotFather.",
      },
      {
        key: "chat",
        label: "chat ID",
        placeholder: "-1001234567890 or @channelname",
        hint: "Add the bot to the chat first; group IDs start with -100.",
      },
    ],
    help: "Messages are sent as plain text by your bot.",
  },
  {
    type: "ntfy",
    label: "ntfy",
    group: "Push",
    fields: [
      {
        key: "server",
        label: "server",
        placeholder: "https://ntfy.sh",
        initial: "https://ntfy.sh",
      },
      {
        key: "topic",
        label: "topic",
        placeholder: "kinglet-alerts-7f3k",
        hint: "Anyone who knows a public topic can read it, so make it hard to guess.",
      },
      {
        key: "token",
        label: "access token",
        placeholder: "tk_…",
        secret: true,
        optional: true,
        hint: "Only for protected topics.",
      },
    ],
    help: "Push to your phone with the ntfy app, from ntfy.sh or your own server.",
  },
  {
    type: "gotify",
    label: "Gotify",
    group: "Push",
    fields: [
      { key: "server", label: "server", placeholder: "https://gotify.example.com" },
      {
        key: "token",
        label: "app token",
        placeholder: "A…",
        secret: true,
        hint: "Apps → Create application.",
      },
    ],
    help: "Push to a self-hosted Gotify server.",
  },
  {
    type: "pushover",
    label: "Pushover",
    group: "Push",
    fields: [
      {
        key: "token",
        label: "app token",
        placeholder: "azGDORePK8gMaC0QOYAMyEEuzJnyUi",
        secret: true,
      },
      { key: "user", label: "user or group key", placeholder: "uQiRzpo4DXghDmr9QzzfQu27cmVRsG" },
    ],
    help: "Create an application at pushover.net to get an app token.",
  },
  {
    type: "email",
    label: "Email (SMTP)",
    group: "Email",
    fields: [RECIPIENTS],
    help: "Sent through the SMTP server set in the environment (KINGLET_SMTP_*).",
  },
  {
    type: "resend",
    label: "Resend",
    group: "Email",
    fields: [
      { key: "key", label: "API key", placeholder: "re_…", secret: true },
      {
        key: "from",
        label: "from",
        placeholder: "Kinglet <alerts@yourdomain.com>",
        hint: "An address on a domain verified in Resend.",
      },
      RECIPIENTS,
    ],
    help: "Email through Resend's API.",
  },
  {
    type: "plunk",
    label: "Plunk",
    group: "Email",
    fields: [
      { key: "key", label: "secret API key", placeholder: "sk_…", secret: true },
      RECIPIENTS,
    ],
    help: "Email through Plunk's API; the sender is your Plunk project's address.",
  },
];

export function channelTypeInfo(type: ChannelType): ChannelTypeInfo {
  const info = CHANNEL_TYPES.find((entry) => entry.type === type);

  // Every ChannelType has an entry above; a miss is a programming error.
  if (!info) throw new Error(`unknown channel type: ${type}`);

  return info;
}

/** The form's text for each of a type's fields, by field key. */
export interface TargetValues {
  [fieldKey: string]: string;
}

/** Starting values for a new channel of this type. */
export function initialValues(type: ChannelType): TargetValues {
  const values: TargetValues = {};

  for (const field of channelTypeInfo(type).fields) values[field.key] = field.initial ?? "";

  return values;
}

function trimServer(server: string): string {
  return server.trim().replace(/\/+$/, "");
}

function recipients(raw: string): string {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(",");
}

/** ntfy's `auth` parameter: the Authorization header value, base64url without padding. */
function ntfyAuth(token: string): string {
  return btoa(`Bearer ${token}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function ntfyToken(auth: string): string {
  try {
    const decoded = atob(auth.replace(/-/g, "+").replace(/_/g, "/"));

    return decoded.replace(/^Bearer /, "");
  } catch {
    return "";
  }
}

export type TargetBuild = { ok: true; url: string } | { ok: false; error: string };

/**
 * The stored target URL for the form's values. Checks only that required
 * fields are filled; the API validates the formats.
 */
export function buildTargetUrl(type: ChannelType, values: TargetValues): TargetBuild {
  const value = (key: string): string => (values[key] ?? "").trim();

  const missing = channelTypeInfo(type).fields.find(
    (field) => !field.optional && value(field.key) === "",
  );

  if (missing) return { ok: false, error: `Fill in the ${missing.label}.` };

  switch (type) {
    case "webhook":
    case "discord":
    case "slack":
      return { ok: true, url: value("url") };
    case "ntfy": {
      const token = value("token");
      const base = `${trimServer(value("server"))}/${value("topic")}`;

      return { ok: true, url: token ? `${base}?auth=${ntfyAuth(token)}` : base };
    }

    case "gotify":
      return {
        ok: true,
        url: `${trimServer(value("server"))}/message?token=${encodeURIComponent(value("token"))}`,
      };
    case "telegram":
      return {
        ok: true,
        url: `https://api.telegram.org/bot${value("token")}/sendMessage?chat_id=${encodeURIComponent(value("chat"))}`,
      };
    case "pushover":
      return {
        ok: true,
        url: `https://api.pushover.net/1/messages.json?${new URLSearchParams({ token: value("token"), user: value("user") }).toString()}`,
      };
    case "email":
      return { ok: true, url: `mailto:${recipients(value("to"))}` };
    case "resend":
      return {
        ok: true,
        url: `https://api.resend.com/emails?${new URLSearchParams({ key: value("key"), from: value("from"), to: recipients(value("to")) }).toString()}`,
      };
    case "plunk":
      return {
        ok: true,
        url: `https://api.useplunk.com/v1/send?${new URLSearchParams({ key: value("key"), to: recipients(value("to")) }).toString()}`,
      };
  }
}

/** The form's values for a stored target URL (editing). Unknown shapes fall back to blanks. */
export function readTargetUrl(type: ChannelType, raw: string): TargetValues {
  const values = initialValues(type);

  if (type === "webhook" || type === "discord" || type === "slack") return { url: raw };

  if (type === "email") {
    return {
      to: raw
        .replace(/^mailto:/i, "")
        .split(",")
        .join(", "),
    };
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return values;
  }

  const param = (key: string): string => url.searchParams.get(key) ?? "";

  switch (type) {
    case "ntfy": {
      const segments = url.pathname.split("/").filter(Boolean);
      const topic = segments.pop() ?? "";
      const auth = param("auth");

      return {
        server: `${url.origin}${segments.length > 0 ? `/${segments.join("/")}` : ""}`,
        topic,
        token: auth ? ntfyToken(auth) : "",
      };
    }

    case "gotify":
      return {
        server: `${url.origin}${url.pathname.replace(/\/message$/, "")}`,
        token: param("token"),
      };
    case "telegram":
      return {
        token: /^\/bot([^/]+)\/sendMessage$/.exec(url.pathname)?.[1] ?? "",
        chat: param("chat_id"),
      };
    case "pushover":
      return { token: param("token"), user: param("user") };
    case "resend":
      return { key: param("key"), from: param("from"), to: param("to").split(",").join(", ") };
    case "plunk":
      return { key: param("key"), to: param("to").split(",").join(", ") };
  }
}
