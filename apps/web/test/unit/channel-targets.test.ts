import { describe, expect, it } from "vitest";
import {
  buildTargetUrl,
  CHANNEL_TYPES,
  initialValues,
  readTargetUrl,
} from "../../src/channel-targets";
import type { TargetValues } from "../../src/channel-targets";
import type { ChannelType } from "../../src/types";

// Every token below is fake.
const CASES: { type: ChannelType; values: TargetValues; url: string }[] = [
  {
    type: "telegram",
    values: { token: "123456:FAKE_fake_FAKE_fake_token_00", chat: "-1001234567890" },
    url: "https://api.telegram.org/bot123456:FAKE_fake_FAKE_fake_token_00/sendMessage?chat_id=-1001234567890",
  },
  {
    type: "gotify",
    values: { server: "https://gotify.example.com/", token: "Afake.token1" },
    url: "https://gotify.example.com/message?token=Afake.token1",
  },
  {
    type: "pushover",
    values: { token: "fakefakefakefakefakefakefake00", user: "userfakeuserfakeuserfakeuser00" },
    url: "https://api.pushover.net/1/messages.json?token=fakefakefakefakefakefakefake00&user=userfakeuserfakeuserfakeuser00",
  },
  {
    type: "email",
    values: { to: "ops@example.com,  oncall@example.com" },
    url: "mailto:ops@example.com,oncall@example.com",
  },
  {
    type: "resend",
    values: { key: "re_fake_key_123", from: "Kinglet <alerts@example.com>", to: "ops@example.com" },
    url: "https://api.resend.com/emails?key=re_fake_key_123&from=Kinglet+%3Calerts%40example.com%3E&to=ops%40example.com",
  },
  {
    type: "plunk",
    values: { key: "sk_fake_key_123", to: "ops@example.com, oncall@example.com" },
    url: "https://api.useplunk.com/v1/send?key=sk_fake_key_123&to=ops%40example.com%2Concall%40example.com",
  },
];

describe("buildTargetUrl", () => {
  it.each(CASES)("builds the $type target", ({ type, values, url }) => {
    expect(buildTargetUrl(type, values)).toEqual({ ok: true, url });
  });

  it("asks for the first missing required field", () => {
    expect(buildTargetUrl("telegram", { token: "123:abc", chat: "" })).toEqual({
      ok: false,
      error: "Fill in the chat ID.",
    });
  });

  it("encodes an ntfy access token the way ntfy reads it", () => {
    const built = buildTargetUrl("ntfy", {
      server: "https://ntfy.sh",
      topic: "alerts",
      token: "tk_fake",
    });

    // base64url("Bearer tk_fake") without padding
    expect(built).toEqual({ ok: true, url: "https://ntfy.sh/alerts?auth=QmVhcmVyIHRrX2Zha2U" });
  });
});

describe("readTargetUrl", () => {
  it.each(CASES)("reads the $type target back into the form", ({ type, url }) => {
    const values = readTargetUrl(type, url);

    // Reading and building again lands on the same stored target.
    expect(buildTargetUrl(type, values)).toEqual({ ok: true, url });
  });

  it("splits a self-hosted ntfy server, topic, and token", () => {
    expect(
      readTargetUrl("ntfy", "https://push.example.com/ntfy/alerts?auth=QmVhcmVyIHRrX2Zha2U"),
    ).toEqual({ server: "https://push.example.com/ntfy", topic: "alerts", token: "tk_fake" });
  });
});

describe("channel types", () => {
  it("offers every type with starting values for its fields", () => {
    expect(CHANNEL_TYPES.map((info) => info.type)).toEqual([
      "webhook",
      "discord",
      "slack",
      "telegram",
      "ntfy",
      "gotify",
      "pushover",
      "email",
      "resend",
      "plunk",
    ]);
    expect(initialValues("ntfy")).toEqual({ server: "https://ntfy.sh", topic: "", token: "" });
  });
});
