import { describe, expect, it } from "vitest";
import { formatBytes, formatCoverage, maskWebhookUrl, redactWebhookUrls } from "../../src/format";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("formatBytes", () => {
  it("formats small and zero byte counts", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("steps through binary units with one decimal below ten", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(421888)).toBe("412 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("keeps the largest unit for very large values", () => {
    expect(formatBytes(1024 ** 5)).toBe("1.0 PB");
    expect(formatBytes(1024 ** 6)).toBe("1024 PB");
  });

  it("shows a dash for missing, negative, or non-finite input", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatCoverage", () => {
  it("reports when there are no snapshots", () => {
    expect(formatCoverage(0, HOUR)).toBe("no snapshots");
    expect(formatCoverage(-1, HOUR)).toBe("no snapshots");
  });

  it("reports a bare count when the interval is unknown", () => {
    expect(formatCoverage(1, null)).toBe("1 snapshot");
    expect(formatCoverage(3, null)).toBe("3 snapshots");
    expect(formatCoverage(3, 0)).toBe("3 snapshots");
    expect(formatCoverage(3, Number.NaN)).toBe("3 snapshots");
  });

  it("multiplies the interval by the snapshot count", () => {
    expect(formatCoverage(1, HOUR)).toBe("1 snapshot × 1h ≈ 1h");
    expect(formatCoverage(2, 24 * HOUR)).toBe("2 snapshots × 1d ≈ 2d");
    expect(formatCoverage(3, 12 * HOUR)).toBe("3 snapshots × 12h ≈ 1d 12h");
  });
});

describe("maskWebhookUrl", () => {
  it("keeps only the origin of a configured endpoint", () => {
    expect(maskWebhookUrl("https://discord.com/api/webhooks/123/secret-token")).toBe(
      "https://discord.com/…",
    );
    expect(maskWebhookUrl("http://localhost:3999/hook?token=abc#fragment")).toBe(
      "http://localhost:3999/…",
    );
  });

  it("handles missing and invalid values", () => {
    expect(maskWebhookUrl("")).toBe("not configured");
    expect(maskWebhookUrl("not a url")).toBe("endpoint configured");
  });
});

describe("redactWebhookUrls", () => {
  it("replaces every absolute URL with its masked origin", () => {
    const text =
      "delivery to https://hooks.slack.com/services/T/B/X failed; retried https://discord.com/api/webhooks/1/2";

    expect(redactWebhookUrls(text)).toBe(
      "delivery to https://hooks.slack.com/… failed; retried https://discord.com/…",
    );
  });

  it("leaves text without http URLs unchanged", () => {
    expect(redactWebhookUrls("channel returned HTTP 500")).toBe("channel returned HTTP 500");
    expect(redactWebhookUrls("ftp://example.com/file")).toBe("ftp://example.com/file");
    expect(redactWebhookUrls("")).toBe("");
  });

  it("redacts a URL followed by whitespace", () => {
    expect(redactWebhookUrls("failed https://hooks.example.com/a?b=1\nretrying")).toBe(
      "failed https://hooks.example.com/…\nretrying",
    );
  });
});
