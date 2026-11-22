import { Body } from "@react-email/body";
import { Button } from "@react-email/button";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Heading } from "@react-email/heading";
import { Hr } from "@react-email/hr";
import { Html } from "@react-email/html";
import { Preview } from "@react-email/preview";
import { render } from "@react-email/render";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import type { MessageLevel, PlainMessage } from "./notify-targets.ts";

/**
 * The HTML email for SMTP, Resend, and Plunk channels, built with React Email.
 * React escapes every text node, so untrusted event text can't add markup.
 * Light colors on purpose: many mail clients ignore dark backgrounds.
 */

const ACCENT: Record<MessageLevel, string> = {
  alert: "#e5484d",
  ok: "#2f9e6b",
  info: "#c9971b",
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Only http(s) links become buttons; anything else stays out of the email. */
function safeLink(link: string | undefined): string | null {
  if (link === undefined) return null;

  try {
    const url = new URL(link);

    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** "Label: value" lines render as a label and value; others as plain text. */
function splitLine(line: string): { label: string; value: string } | null {
  const match = /^([A-Za-z][A-Za-z ]{0,30}): (.+)$/.exec(line);

  return match ? { label: match[1] ?? "", value: match[2] ?? "" } : null;
}

export function NotificationEmail({ message }: { message: PlainMessage }) {
  const accent = ACCENT[message.level];
  const link = safeLink(message.link);

  return (
    <Html lang="en">
      <Head />
      <Preview>{message.lines[0] ?? message.title}</Preview>
      <Body style={{ backgroundColor: "#f4f4f2", fontFamily: FONT, margin: 0, padding: "24px 0" }}>
        <Container
          style={{
            backgroundColor: "#ffffff",
            borderTop: `4px solid ${accent}`,
            borderRadius: "6px",
            maxWidth: "560px",
            padding: "24px 28px",
          }}
        >
          <Text style={{ color: "#8a8f87", fontSize: "12px", letterSpacing: "0.12em", margin: 0 }}>
            KINGLET
          </Text>
          <Heading as="h1" style={{ color: "#16181a", fontSize: "20px", margin: "8px 0 16px" }}>
            {message.title}
          </Heading>
          <Section>
            {message.lines.map((line, index) => {
              const parts = splitLine(line);

              return parts ? (
                <Text key={index} style={{ color: "#2b2e30", fontSize: "14px", margin: "4px 0" }}>
                  <span style={{ color: "#8a8f87" }}>{parts.label}: </span>
                  <span style={{ fontFamily: "Menlo, Consolas, monospace" }}>{parts.value}</span>
                </Text>
              ) : (
                <Text
                  key={index}
                  style={{ color: "#16181a", fontSize: "15px", margin: "0 0 12px" }}
                >
                  {line}
                </Text>
              );
            })}
          </Section>
          {link && (
            <Section style={{ marginTop: "20px" }}>
              <Button
                href={link}
                style={{
                  backgroundColor: "#16181a",
                  borderRadius: "4px",
                  color: "#ffffff",
                  fontSize: "14px",
                  fontWeight: 600,
                  padding: "10px 16px",
                }}
              >
                Open in Kinglet
              </Button>
            </Section>
          )}
          <Hr style={{ borderColor: "#e6e6e3", margin: "24px 0 12px" }} />
          <Text style={{ color: "#8a8f87", fontSize: "12px", margin: 0 }}>
            Sent by Kinglet. Change what this channel receives under Settings → Notifications.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

/** The notification as an HTML email document. */
export function renderNotificationEmail(message: PlainMessage): Promise<string> {
  return render(<NotificationEmail message={message} />);
}
