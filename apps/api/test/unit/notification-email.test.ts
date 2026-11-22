import { describe, expect, it } from "vitest";
import { renderNotificationEmail } from "../../src/notification-email.tsx";
import type { PlainMessage } from "../../src/notify-targets.ts";

const MESSAGE: PlainMessage = {
  title: "🔥 Monitor fired: checkout errors",
  lines: ["6 events in 5m (more than 5)", "Query: level:error"],
  level: "alert",
  link: "https://kinglet.example.com/?q=level%3Aerror",
};

describe("notification email", () => {
  it("renders the title, details, and an Open in Kinglet button", async () => {
    const html = await renderNotificationEmail(MESSAGE);

    expect(html).toMatch(/^<!DOCTYPE html/i);
    expect(html).toContain("Monitor fired: checkout errors");
    expect(html).toContain("level:error");
    expect(html).toContain('href="https://kinglet.example.com/?q=level%3Aerror"');
    expect(html).toContain("Open in Kinglet");
  });

  it("escapes event text instead of rendering it as markup", async () => {
    const html = await renderNotificationEmail({
      ...MESSAGE,
      lines: ['<img src=x onerror="alert(1)">'],
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("only turns http(s) links into a button", async () => {
    const html = await renderNotificationEmail({ ...MESSAGE, link: "javascript:alert(1)" });

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Open in Kinglet");
  });
});
