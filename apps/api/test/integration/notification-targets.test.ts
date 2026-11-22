import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isString } from "../../src/json.ts";
import { arrayAt, errorOf, jsonBody, objectAt, stringAt } from "../helpers/body.ts";
import { request } from "../helpers/request.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

/** One HTTP request a push server received. */
interface Received {
  path: string;
  body: string;
}

/** One message the fake SMTP server accepted. */
interface Mail {
  from: string;
  to: string[];
  data: string;
}

interface TargetsContext {
  session: TestSession;
  http: http.Server;
  smtp: net.Server;
  httpPort: number;
  received: Received[];
  mail: Mail[];
}

let context: TargetsContext | null = null;

function ctx(): TargetsContext {
  if (context === null) throw new Error("targets suite: test context missing");

  return context;
}

async function listen(server: net.Server | http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || isString(address)) throw new Error("no port");

  return address.port;
}

/**
 * Just enough SMTP for nodemailer: greet, accept one envelope, read DATA up
 * to the lone dot, and record it. No TLS or auth, so the client must not
 * require either.
 */
function fakeSmtp(mail: Mail[]): net.Server {
  return net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current: Mail = { from: "", to: [], data: "" };

    socket.write("220 fake.smtp ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");

          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          mail.push(current);
          current = { from: "", to: [], data: "" };
          socket.write("250 queued\r\n");
          continue;
        }

        const lineEnd = buffer.indexOf("\r\n");

        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd);

        buffer = buffer.slice(lineEnd + 2);
        const verb = line.slice(0, 4).toUpperCase();

        if (verb === "EHLO" || verb === "HELO") socket.write("250 fake.smtp\r\n");
        else if (verb === "MAIL") {
          current.from = line;
          socket.write("250 ok\r\n");
        } else if (verb === "RCPT") {
          current.to.push(line.replace(/^RCPT TO:\s*<?([^>]*)>?.*$/i, "$1"));
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("250 ok\r\n");
      }
    });
  });
}

async function createChannel(type: string, url: string, name: string): Promise<Response> {
  return request(ctx().session.harness.app, "/v1/notifications/channels", {
    cookies: ctx().session.adminJar,
    body: { name, type, url, actions: [] },
  });
}

async function createdId(response: Response): Promise<string> {
  expect(response.status).toBe(201);

  return stringAt(objectAt((await jsonBody(response)).channel, "channel").id, "channel.id");
}

async function sendTest(id: string): Promise<void> {
  const response = await request(
    ctx().session.harness.app,
    `/v1/notifications/channels/${id}/test`,
    { cookies: ctx().session.adminJar, method: "POST" },
  );

  const body = await jsonBody(response);

  // A failed delivery answers 502 with the (sanitized) reason.
  expect(body).toEqual({ ok: true });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  const received: Received[] = [];
  const mail: Mail[] = [];

  const server = http.createServer((req, res) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ path: req.url ?? "", body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });

  const smtp = fakeSmtp(mail);
  const httpPort = await listen(server);
  const smtpPort = await listen(smtp);

  const session = await createTestSession({
    config: {
      // Loopback push servers stand in for self-hosted ntfy and Gotify.
      allowPrivateWebhooks: true,
      smtp: {
        host: "127.0.0.1",
        port: smtpPort,
        secure: false,
        requireTLS: false,
        from: "kinglet@example.test",
      },
    },
  });

  context = { session, http: server, smtp, httpPort, received, mail };
});

afterAll(async () => {
  await context?.session.close();
  context?.http.close();
  context?.smtp.close();
  context = null;
});

describe("notification capabilities", () => {
  it("tells the channel form that email can be sent", async () => {
    const response = await request(ctx().session.harness.app, "/v1/notifications/capabilities", {
      cookies: ctx().session.adminJar,
    });

    expect(await jsonBody(response)).toEqual({
      email: { configured: true, from: "kinglet@example.test" },
      secrets: { configured: true },
    });
  });
});

describe("push and email channels", () => {
  it("publishes to a self-hosted ntfy server", async () => {
    const id = await createdId(
      await createChannel("ntfy", `http://127.0.0.1:${ctx().httpPort}/ntfy/alerts`, "ntfy"),
    );

    await sendTest(id);
    const publish = ctx().received.find((entry) => entry.path === "/ntfy/");

    expect(publish).toBeDefined();
    expect(JSON.parse(publish?.body ?? "{}")).toMatchObject({ topic: "alerts", priority: 3 });
  });

  it("posts to a Gotify server with its app token", async () => {
    const id = await createdId(
      await createChannel(
        "gotify",
        `http://127.0.0.1:${ctx().httpPort}/message?token=Afake.token1`,
        "gotify",
      ),
    );

    await sendTest(id);
    const message = ctx().received.find((entry) => entry.path === "/message?token=Afake.token1");

    expect(JSON.parse(message?.body ?? "{}")).toMatchObject({ title: "🔔 Kinglet notification" });
  });

  it("emails every recipient through the configured SMTP server", async () => {
    const id = await createdId(
      await createChannel("email", "mailto:ops@example.test,oncall@example.test", "on-call email"),
    );

    await sendTest(id);
    const sent = ctx().mail.at(-1);

    expect(sent?.to).toEqual(["ops@example.test", "oncall@example.test"]);
    expect(sent?.from).toContain("kinglet@example.test");
    // Headers are MIME-encoded (the subject has an emoji) and the body is
    // quoted-printable, so check the header exists and read the joined body.
    expect(sent?.data).toMatch(/^Subject: /m);
    expect(sent?.data.replace(/=\r\n/g, "")).toContain("Test notification from Kinglet");
    // React Email renders an HTML part next to the plain text.
    expect(sent?.data).toMatch(/Content-Type: text\/html/i);
  });

  it("masks email recipients in the channel list", async () => {
    const response = await request(ctx().session.harness.app, "/v1/notifications/channels", {
      cookies: ctx().session.adminJar,
    });

    const channels = arrayAt((await jsonBody(response)).channels, "channels").map((entry) =>
      objectAt(entry, "channel"),
    );

    const email = channels.find((channel) => channel.name === "on-call email");

    expect(email?.url).toBe("email · 2 recipients");
  });

  it("refuses Telegram targets that leave the official API host", async () => {
    const response = await createChannel(
      "telegram",
      "https://telegram.example.com/bot123456:FAKE_fake_FAKE_fake_token_00/sendMessage?chat_id=1",
      "fake telegram",
    );

    expect(response.status).toBe(400);
    expect(errorOf(await jsonBody(response))).toMatch(/bot token/);
  });
});
