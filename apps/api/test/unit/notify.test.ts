import { describe, expect, it } from "vitest";
import {
  discordPayload,
  isPrivateAddress,
  sanitizeNotificationText,
  slackPayload,
  validateWebhookUrl,
} from "../../src/notify.ts";
import type { AlertNotice } from "../../src/notify.ts";

function makeNotice(overrides: Partial<AlertNotice> = {}): AlertNotice {
  return {
    monitorId: "0190f5b2-7c3a-7def-8abc-0123456789ab",
    monitorName: "API errors",
    projectName: "Production",
    service: "api",
    env: "prod",
    level: "error",
    query: 'level>=error "timeout"',
    state: "fired",
    summary: "5 errors in 10 minutes",
    count: 5,
    threshold: 3,
    windowMs: 10 * 60_000,
    sampleMessage: null,
    firedAt: Date.UTC(2026, 0, 15, 12, 0, 0),
    link: "https://kinglet.example.com/projects/p1",
    ...overrides,
  };
}

function firstEmbed(payload: ReturnType<typeof discordPayload>) {
  const embed = payload.embeds[0];

  if (!embed) throw new Error("expected one Discord embed");

  return embed;
}

function firstAttachment(payload: ReturnType<typeof slackPayload>) {
  const attachment = payload.attachments[0];

  if (!attachment) throw new Error("expected one Slack attachment");

  return attachment;
}

describe("isPrivateAddress", () => {
  it("classifies RFC1918 ranges", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.255.255.255")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.254")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("192.169.1.1")).toBe(false);
  });

  it("classifies carrier-grade NAT and Tailscale addresses", () => {
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("100.127.255.254")).toBe(true);
    expect(isPrivateAddress("100.63.255.255")).toBe(false);
    expect(isPrivateAddress("100.128.0.1")).toBe(false);
  });

  it("classifies loopback, unspecified, and link-local/metadata targets", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("127.255.255.254")).toBe(true);
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("100.100.100.200")).toBe(true);
  });

  it("classifies documentation, benchmark, and multicast IPv4 ranges", () => {
    expect(isPrivateAddress("192.0.2.10")).toBe(true);
    expect(isPrivateAddress("198.18.0.1")).toBe(true);
    expect(isPrivateAddress("198.51.100.10")).toBe(true);
    expect(isPrivateAddress("203.0.113.10")).toBe(true);
    expect(isPrivateAddress("224.0.0.1")).toBe(true);
    expect(isPrivateAddress("239.255.255.250")).toBe(true);
    expect(isPrivateAddress("192.88.99.1")).toBe(true);
  });

  it("accepts public IPv4 addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });

  it("classifies loopback, ULA, and link-local IPv6 addresses", () => {
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("[::1]")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fe80::1%eth0")).toBe(true);
    expect(isPrivateAddress("fec0::1")).toBe(true);
  });

  it("classifies IPv6 multicast and special-purpose ranges", () => {
    expect(isPrivateAddress("ff02::1")).toBe(true);
    expect(isPrivateAddress("2001:db8::1")).toBe(true);
    expect(isPrivateAddress("2002::1")).toBe(true);
    expect(isPrivateAddress("100::1")).toBe(true);
    expect(isPrivateAddress("2001:0::1")).toBe(true);
    expect(isPrivateAddress("2001:2::1")).toBe(true);
    expect(isPrivateAddress("2001:10::1")).toBe(true);
    expect(isPrivateAddress("2001:20::1")).toBe(true);
  });

  it("classifies IPv4-mapped IPv6 addresses by the embedded IPv4 address", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("classifies the well-known and local-use NAT64 prefixes", () => {
    expect(isPrivateAddress("64:ff9b::1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::8.8.8.8")).toBe(true);
    expect(isPrivateAddress("64:ff9b:1::1")).toBe(true);
    expect(isPrivateAddress("64:ff9b:1:2::1")).toBe(true);
  });

  it("refuses everything outside global unicast 2000::/3", () => {
    // Unassigned space next to NAT64, the IPv4-translated form, SRv6 SIDs.
    expect(isPrivateAddress("64:ff9c::1")).toBe(true);
    expect(isPrivateAddress("::ffff:0:a9fe:a9fe")).toBe(true);
    expect(isPrivateAddress("::ffff:0:7f00:1")).toBe(true);
    expect(isPrivateAddress("5f00::1")).toBe(true);
    expect(isPrivateAddress("4000::1")).toBe(true);
  });

  it("refuses special-purpose blocks inside 2000::/3", () => {
    expect(isPrivateAddress("3fff::1")).toBe(true);
    expect(isPrivateAddress("3fff:fff::1")).toBe(true);
    // The whole ORCHID /28s, not only their first /32.
    expect(isPrivateAddress("2001:11::1")).toBe(true);
    expect(isPrivateAddress("2001:1f::1")).toBe(true);
    expect(isPrivateAddress("2001:2f::1")).toBe(true);
    expect(isPrivateAddress("2001:1ff::1")).toBe(true);
    expect(isPrivateAddress("3fff:1000::1")).toBe(false);
    expect(isPrivateAddress("2001:200::1")).toBe(false);
  });

  it("accepts public IPv6 addresses and non-IP input", () => {
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateAddress("example.com")).toBe(false);
    expect(isPrivateAddress("")).toBe(false);
    expect(isPrivateAddress("not-an-address")).toBe(false);
  });
});

describe("validateWebhookUrl", () => {
  it("accepts a normal https target", () => {
    expect(validateWebhookUrl("https://hooks.example.com/abc", false)).toBeNull();
    expect(validateWebhookUrl("http://hooks.example.com/abc", false)).toBeNull();
  });

  it("accepts query strings and fragments on webhook targets", () => {
    expect(validateWebhookUrl("https://hooks.example.com/abc?token=x", false)).toBeNull();
    expect(validateWebhookUrl("https://hooks.example.com/abc#section", false)).toBeNull();
  });

  it("rejects invalid URLs and non-http protocols", () => {
    expect(validateWebhookUrl("not a url", false)).toBe("url is not valid");
    expect(validateWebhookUrl("ftp://example.com/hook", false)).toBe(
      "url must start with http:// or https://",
    );
    expect(validateWebhookUrl("file:///etc/passwd", false)).toBe(
      "url must start with http:// or https://",
    );
  });

  it("rejects embedded credentials", () => {
    expect(validateWebhookUrl("https://user:pass@example.com/hook", false)).toBe(
      "url must not contain credentials",
    );
    expect(validateWebhookUrl("https://user@example.com/hook", false)).toBe(
      "url must not contain credentials",
    );
  });

  it("rejects localhost names unless private targets are explicitly allowed", () => {
    expect(validateWebhookUrl("http://localhost:3000/hook", false)).toContain("loopback");
    expect(validateWebhookUrl("http://api.localhost/hook", false)).toContain("loopback");
    expect(validateWebhookUrl("http://localhost:3000/hook", true)).toBeNull();
  });

  it("rejects private and metadata IP literals unless private targets are allowed", () => {
    expect(validateWebhookUrl("http://10.0.0.5/hook", false)).toContain("private/metadata");
    expect(validateWebhookUrl("http://169.254.169.254/latest/meta-data", false)).toContain(
      "private/metadata",
    );
    expect(validateWebhookUrl("http://[::1]/hook", false)).toContain("private/metadata");
    expect(validateWebhookUrl("http://10.0.0.5/hook", true)).toBeNull();
    expect(validateWebhookUrl("http://[::1]/hook", true)).toBeNull();
  });

  it("leaves hostname resolution for send time", () => {
    expect(validateWebhookUrl("http://internal.corp/hook", false)).toBeNull();
  });

  it("rejects URLs longer than 2048 characters", () => {
    const base = "https://example.com/";
    const accepted = `${base}${"a".repeat(2048 - base.length)}`;
    const rejected = `${base}${"a".repeat(2049 - base.length)}`;

    expect(accepted.length).toBe(2048);
    expect(validateWebhookUrl(accepted, false)).toBeNull();
    expect(rejected.length).toBe(2049);
    expect(validateWebhookUrl(rejected, false)).toBe("url is too long");
  });
});

describe("sanitizeNotificationText", () => {
  it("flattens CRLF and bare newlines", () => {
    expect(sanitizeNotificationText("one\r\ntwo\nthree\rfour", 200)).toBe("one two three four");
  });

  it("strips C1 controls and bidi overrides that could break lines or reorder text", () => {
    expect(sanitizeNotificationText("a\u0085b\u2028c\u2029d", 200)).toBe("a b c d");
    expect(sanitizeNotificationText("x\u009by\u202ez\u2066w\u200f", 200)).toBe("xyzw");
  });

  it("strips control characters", () => {
    expect(sanitizeNotificationText("a\u0000b\u0007c\u000bd\u001fe\u007ff", 200)).toBe("abcdef");
  });

  it("neutralizes @everyone and @here case-insensitively", () => {
    expect(sanitizeNotificationText("@everyone @Here @EVERYONE", 200)).toBe(
      "@\u200beveryone @\u200bhere @\u200beveryone",
    );
    expect(sanitizeNotificationText("@everyone", 200)).not.toContain("@everyone");
  });

  it("replaces angle brackets so chat clients cannot render HTML", () => {
    expect(sanitizeNotificationText("<b>bold</b>", 200)).toBe("‹b›bold‹/b›");
  });

  it("escapes markdown control characters", () => {
    const escapes = [
      ["*", "\\*"],
      ["_", "\\_"],
      ["~", "\\~"],
      ["`", "\\`"],
      ["|", "\\|"],
    ] as const;

    for (const [character, escaped] of escapes) {
      expect(sanitizeNotificationText(`x${character}y`, 200)).toBe(`x${escaped}y`);
    }
  });

  it("doubles existing backslashes before escaping brackets", () => {
    const sanitized = sanitizeNotificationText("\\[click\\]", 200);

    expect(sanitized).toBe(String.raw`\\\[click\\\]`);
    expect(sanitizeNotificationText("a\\b", 200)).toBe(String.raw`a\\b`);
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeNotificationText("  a   b\tc  ", 200)).toBe("a b c");
  });

  it("truncates to the limit with an ellipsis", () => {
    const sanitized = sanitizeNotificationText("abcdefghij", 5);

    expect(sanitized).toBe("abcde…");
    expect(sanitized.length).toBe(6);
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeNotificationText("", 100)).toBe("");
    expect(sanitizeNotificationText(" \r\n\t ", 100)).toBe("");
  });
});

describe("discordPayload", () => {
  it("builds the fired embed with sanitized fields", () => {
    const embed = firstEmbed(discordPayload(makeNotice()));

    expect(embed.title).toBe("🔥 Monitor fired");
    expect(embed.color).toBe(0xff5c33);
    expect(embed.footer.text).toBe("Kinglet");
    expect(embed.timestamp).toBe(new Date(Date.UTC(2026, 0, 15, 12, 0, 0)).toISOString());
    expect(embed.description).toBe("5 errors in 10 minutes");

    const names = embed.fields.map((field) => field.name);

    expect(names).toEqual([
      "Project",
      "Service",
      "Env",
      "Monitor",
      "Level",
      "Query",
      "Count",
      "Threshold",
      "Window",
      "Link",
    ]);
  });

  it("uses the resolved and test presentation", () => {
    const resolved = firstEmbed(discordPayload(makeNotice({ state: "resolved", count: null })));

    const test = firstEmbed(
      discordPayload(makeNotice({ state: "test", monitorName: "", projectName: undefined })),
    );

    expect(resolved.title).toBe("✅ Monitor resolved");
    expect(resolved.color).toBe(0x7dd3a1);
    expect(resolved.fields.map((field) => field.name)).not.toContain("Count");
    expect(test.title).toBe("🔔 Test notification");
    expect(test.color).toBe(0xfbbf24);
    expect(test.fields.find((field) => field.name === "Monitor")?.value).toBe("—");
  });

  it("sanitizes untrusted summary, monitor, and query text", () => {
    const notice = makeNotice({
      summary: "boom <b>@everyone</b>\nnext",
      monitorName: "api_errors *prod*",
      query: "",
    });

    const embed = firstEmbed(discordPayload(notice));

    expect(embed.description).toBe("boom ‹b›@\u200beveryone‹/b› next");
    expect(embed.fields.find((field) => field.name === "Monitor")?.value).toBe(
      "api\\_errors \\*prod\\*",
    );
    expect(embed.fields.find((field) => field.name === "Query")?.value).toBe("all events");
  });

  it("includes a bounded code block for the sample and orders it before the link", () => {
    const embed = firstEmbed(
      discordPayload(makeNotice({ sampleMessage: "line one\nline two ``` end" })),
    );

    const names = embed.fields.map((field) => field.name);
    const sample = embed.fields.find((field) => field.name === "Sample");
    const linkIndex = names.indexOf("Link");
    const sampleIndex = names.indexOf("Sample");

    expect(names).toContain("Sample");
    expect(sampleIndex).toBeGreaterThan(-1);
    expect(sampleIndex).toBeLessThan(linkIndex);
    expect(sample?.value.startsWith("```\n")).toBe(true);
    expect(sample?.value.endsWith("\n```")).toBe(true);
    expect(sample?.value).toContain("line one");
    expect(sample?.value).toContain("'''");
  });

  it("truncates long text and keeps every field within the Discord cap", () => {
    const embed = firstEmbed(
      discordPayload(
        makeNotice({
          summary: "s".repeat(1500),
          monitorName: "m".repeat(500),
          sampleMessage: "x".repeat(2000),
        }),
      ),
    );

    expect(embed.description?.length).toBe(1001);
    expect(embed.description?.endsWith("…")).toBe(true);
    expect(embed.fields.find((field) => field.name === "Monitor")?.value.length).toBe(201);
    expect(embed.fields.find((field) => field.name === "Sample")?.value.length).toBeLessThanOrEqual(
      1006,
    );

    for (const field of embed.fields) {
      expect(field.value.length).toBeLessThanOrEqual(1000);
    }
  });

  it("keeps a zero count because zero is a real measurement", () => {
    const embed = firstEmbed(discordPayload(makeNotice({ count: 0 })));

    expect(embed.fields.find((field) => field.name === "Count")?.value).toBe("0");
  });
});

describe("slackPayload", () => {
  it("builds the attachment structure", () => {
    const payload = slackPayload(makeNotice());
    const attachment = firstAttachment(payload);

    expect(payload.text).toBe("🔥 Kinglet · monitor fired");
    expect(attachment.color).toBe("#ff5c33");
    expect(attachment.title).toBe("🔥 Monitor fired");
    expect(attachment.footer).toBe("Kinglet");
    expect(attachment.ts).toBe(Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000));
    expect(attachment.fields.find((field) => field.title === "Count")).toEqual({
      title: "Count",
      value: "5",
      short: true,
    });
    expect(attachment.fields.find((field) => field.title === "Link")?.value).toBe(
      "<https://kinglet.example.com/projects/p1|Open in Kinglet>",
    );
  });

  it("includes the summary and sample in the attachment text", () => {
    const attachment = firstAttachment(
      slackPayload(makeNotice({ sampleMessage: "stack line\nsecond" })),
    );

    expect(attachment.text.startsWith("5 errors in 10 minutes\n```\n")).toBe(true);
    expect(attachment.text).toContain("stack line\nsecond");
  });

  it("escapes ampersands in event-derived text so entities stay literal", () => {
    const attachment = firstAttachment(
      slackPayload(makeNotice({ summary: "&lt;!here&gt; now", service: "a&b" })),
    );

    expect(attachment.text).toBe("&amp;lt;!here&amp;gt; now");
    expect(attachment.fields.find((field) => field.title === "Service")?.value).toBe("a&amp;b");
  });

  it("escapes Slack control sequences in the sample code block", () => {
    const attachment = firstAttachment(
      slackPayload(
        makeNotice({
          sampleMessage: "<!here> <https://lure.example.test/x|Open in Kinglet> <@U0FAKE01> & done",
        }),
      ),
    );

    expect(attachment.text).toContain(
      "&lt;!here&gt; &lt;https://lure.example.test/x|Open in Kinglet&gt; &lt;@U0FAKE01&gt; &amp; done",
    );
    expect(attachment.text).not.toContain("<!here>");
  });

  it("truncates long field values", () => {
    const attachment = firstAttachment(slackPayload(makeNotice({ monitorName: "m".repeat(500) })));

    for (const field of attachment.fields) {
      expect(field.value.length).toBeLessThanOrEqual(1000);
      expect(field.short).toBe(field.title !== "Link");
    }
  });
});
