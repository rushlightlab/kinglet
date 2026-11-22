import { describe, expect, it } from "vitest";
import { alertMessage, validateChannelUrl } from "../../src/notify.ts";
import {
  parseChannelTarget,
  parseRecipients,
  plainNotificationText,
  requestFor,
} from "../../src/notify-targets.ts";
import type { ChannelTarget, PlainMessage } from "../../src/notify-targets.ts";
import { maskChannelUrl } from "../../src/notifications/types.ts";

// Every token below is fake and shaped only to pass format checks.
const TELEGRAM = "https://api.telegram.org/bot123456:FAKE_fake_FAKE_fake_token_00/sendMessage";
const PUSHOVER_KEY = "fakefakefakefakefakefakefake00";

function target(type: Parameters<typeof parseChannelTarget>[0], raw: string): ChannelTarget {
  const parsed = parseChannelTarget(type, raw);

  if (!parsed.ok) throw new Error(`expected ${raw} to parse: ${parsed.error}`);

  return parsed.target;
}

function errorOf(type: Parameters<typeof parseChannelTarget>[0], raw: string): string {
  const parsed = parseChannelTarget(type, raw);

  if (parsed.ok) throw new Error(`expected ${raw} to be rejected`);

  return parsed.error;
}

const MESSAGE: PlainMessage = {
  title: "🔥 Monitor fired: checkout errors",
  lines: ["6 events in 5m (more than 5)", "Query: level:error"],
  level: "alert",
  link: "https://kinglet.example.com/?q=level%3Aerror",
};

describe("ntfy targets", () => {
  it("publishes to the server root with the topic in the body", () => {
    const ntfy = target("ntfy", "https://ntfy.sh/kinglet-alerts");

    expect(ntfy).toEqual({
      type: "ntfy",
      publishUrl: "https://ntfy.sh/",
      topic: "kinglet-alerts",
      auth: null,
    });
  });

  it("keeps a self-hosted path prefix and an access token", () => {
    const ntfy = target("ntfy", "https://push.example.com/ntfy/alerts?auth=QmVhcmVyIHRrX2Zha2U");

    if (ntfy.type !== "ntfy") throw new Error("wrong type");
    const request = requestFor(ntfy, MESSAGE);

    expect(request.url).toBe("https://push.example.com/ntfy/?auth=QmVhcmVyIHRrX2Zha2U");
    expect(request.selfHosted).toBe(true);
    expect(JSON.parse(request.body)).toMatchObject({
      topic: "alerts",
      title: MESSAGE.title,
      priority: 4,
      click: MESSAGE.link,
    });
  });

  it("rejects bad topics and unknown parameters", () => {
    expect(errorOf("ntfy", "https://ntfy.sh/")).toMatch(/topic/);
    expect(errorOf("ntfy", "https://ntfy.sh/alerts?email=a@b.co")).toMatch(/unknown/);
  });
});

describe("gotify targets", () => {
  it("needs /message and an application token", () => {
    expect(target("gotify", "https://gotify.example.com/message?token=Afake.token1")).toEqual({
      type: "gotify",
      url: "https://gotify.example.com/message?token=Afake.token1",
    });
    expect(errorOf("gotify", "https://gotify.example.com/message")).toMatch(/token/);
    expect(errorOf("gotify", "https://gotify.example.com/?token=Afake.token1")).toMatch(
      /\/message/,
    );
  });
});

describe("telegram targets", () => {
  it("accepts a bot token with a numeric chat or @channel", () => {
    expect(target("telegram", `${TELEGRAM}?chat_id=-1001234567890`)).toMatchObject({
      chatId: "-1001234567890",
    });
    expect(target("telegram", `${TELEGRAM}?chat_id=@kinglet_ops`)).toMatchObject({
      chatId: "@kinglet_ops",
    });
  });

  it("only talks to the official API host", () => {
    const elsewhere = TELEGRAM.replace("api.telegram.org", "telegram.example.com");

    expect(errorOf("telegram", `${elsewhere}?chat_id=1`)).toMatch(/bot token/);
    expect(errorOf("telegram", `${TELEGRAM}?chat_id=not a chat`)).toMatch(/chat ID/);
  });

  it("sends plain text so event text can't inject markup", () => {
    const telegram = target("telegram", `${TELEGRAM}?chat_id=42`);

    if (telegram.type !== "telegram") throw new Error("wrong type");
    const body = JSON.parse(requestFor(telegram, MESSAGE).body);

    expect(body.chat_id).toBe("42");
    expect(body.parse_mode).toBeUndefined();
    expect(body.text).toContain(MESSAGE.title);
  });
});

describe("pushover targets", () => {
  it("sends token, user, priority, and the link", () => {
    const pushover = target(
      "pushover",
      `https://api.pushover.net/1/messages.json?token=${PUSHOVER_KEY}&user=${PUSHOVER_KEY}`,
    );

    if (pushover.type !== "pushover") throw new Error("wrong type");
    const request = requestFor(pushover, MESSAGE);

    expect(request.url).toBe("https://api.pushover.net/1/messages.json");
    expect(JSON.parse(request.body)).toMatchObject({
      token: PUSHOVER_KEY,
      user: PUSHOVER_KEY,
      priority: 1,
      url: MESSAGE.link,
    });
  });

  it("rejects other hosts and short keys", () => {
    expect(
      errorOf("pushover", `https://pushover.example.com/1/messages.json?token=${PUSHOVER_KEY}`),
    ).toMatch(/not valid/);
    expect(
      errorOf("pushover", `https://api.pushover.net/1/messages.json?token=short&user=short`),
    ).toMatch(/token/);
  });
});

describe("email targets", () => {
  it("reads mailto recipients, lowercased and deduplicated", () => {
    expect(target("email", "mailto:Ops@Example.com,oncall@example.com,ops@example.com")).toEqual({
      type: "email",
      to: ["ops@example.com", "oncall@example.com"],
    });
  });

  it("caps recipients and rejects bad addresses", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `u${i}@example.com`).join(",");

    expect(parseRecipients(eleven)).toEqual({ ok: false, error: "at most 10 recipients" });
    expect(errorOf("email", "mailto:not-an-address")).toMatch(/not an email/);
  });

  it("needs an SMTP server before an email channel can be saved", () => {
    const check = { allowPrivate: false, smtpConfigured: false };

    expect(validateChannelUrl("email", "mailto:ops@example.com", check)).toMatch(/SMTP/);
    expect(
      validateChannelUrl("email", "mailto:ops@example.com", { ...check, smtpConfigured: true }),
    ).toBeNull();
  });
});

describe("resend and plunk targets", () => {
  it("sends Resend mail with the key as a bearer token", () => {
    const resend = target(
      "resend",
      "https://api.resend.com/emails?key=re_fake_key_123&from=Kinglet%20%3Calerts%40example.com%3E&to=ops@example.com",
    );

    if (resend.type !== "resend") throw new Error("wrong type");
    const request = requestFor(resend, MESSAGE);

    expect(request.headers.authorization).toBe("Bearer re_fake_key_123");
    expect(JSON.parse(request.body)).toMatchObject({
      from: "Kinglet <alerts@example.com>",
      to: ["ops@example.com"],
      subject: MESSAGE.title,
    });
  });

  it("escapes HTML in Plunk bodies", () => {
    const plunk = target(
      "plunk",
      "https://api.useplunk.com/v1/send?key=sk_fake_key_123&to=ops@example.com",
    );

    if (plunk.type !== "plunk") throw new Error("wrong type");

    const body = JSON.parse(
      requestFor(plunk, { ...MESSAGE, lines: ['<img src=x onerror="alert(1)">'] }).body,
    );

    expect(body.to).toBe("ops@example.com");
    expect(body.body).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(body.body).not.toContain("<img");
  });

  it("rejects keys of the wrong kind", () => {
    expect(
      errorOf("plunk", "https://api.useplunk.com/v1/send?key=pk_public_key&to=ops@example.com"),
    ).toMatch(/sk_/);
  });
});

describe("self-hosted push servers and SSRF", () => {
  it("blocks private ntfy and Gotify servers unless explicitly allowed", () => {
    const check = { allowPrivate: false, smtpConfigured: false };

    expect(validateChannelUrl("ntfy", "http://10.0.0.5/alerts", check)).toMatch(/private/);
    expect(
      validateChannelUrl("ntfy", "http://10.0.0.5/alerts", { ...check, allowPrivate: true }),
    ).toBeNull();
  });
});

describe("plain-text messages", () => {
  it("strips control characters and flattens whitespace", () => {
    expect(plainNotificationText("a\u0000b\n\n c\t d", 100)).toBe("a b c d");
  });

  it("titles an alert with its state and monitor", () => {
    const message = alertMessage({
      monitorId: "m1",
      monitorName: "checkout errors",
      query: "level:error",
      state: "resolved",
      summary: "condition cleared",
      firedAt: 0,
    });

    expect(message.title).toBe("✅ Monitor resolved: checkout errors");
    expect(message.level).toBe("ok");
  });
});

describe("masking", () => {
  it("shows only how many recipients an email channel has", () => {
    expect(maskChannelUrl("mailto:a@example.com,b@example.com")).toBe("email · 2 recipients");
    expect(maskChannelUrl(`${TELEGRAM}?chat_id=42`)).not.toContain("FAKE");
  });
});
