import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { Hono } from "hono";
import type { AppEnv } from "../../src/auth/middleware.js";
import { isString } from "../../src/json.js";

/**
 * Small HTTP server that adapts real `node:http` requests to `app.fetch`.
 * Used by machine-contract tests that must exercise an actual local socket
 * (the MCP child process cannot call `app.request`). Binds 127.0.0.1 only.
 */
export interface LoopbackAppServer {
  url: string;
  close(): Promise<void>;
}

export async function startLoopbackApp(app: Hono<AppEnv>): Promise<LoopbackAppServer> {
  let origin = "http://127.0.0.1";

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];

        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        const method = request.method ?? "GET";

        const body =
          method === "GET" || method === "HEAD" || chunks.length === 0
            ? undefined
            : Buffer.concat(chunks);

        const headers = requestHeaders(request.headers);
        const url = new URL(request.url ?? "/", origin);

        const result = await app.fetch(
          new Request(url, {
            method,
            headers,
            body,
          }),
        );

        const bytes = Buffer.from(await result.arrayBuffer());

        response.statusCode = result.status;

        for (const [name, value] of result.headers) {
          if (name.toLowerCase() === "set-cookie") continue;

          response.setHeader(name, value);
        }

        const cookies = result.headers.getSetCookie();

        if (cookies.length > 0) response.setHeader("set-cookie", cookies);
        response.end(bytes);
      } catch {
        response.statusCode = 500;
        response.end("loopback app adapter failed");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || isString(address)) {
    await closeServer(server);
    throw new Error("loopback app server did not expose a TCP port");
  }

  origin = `http://127.0.0.1:${address.port}`;

  return {
    url: origin,
    close: () => closeServer(server),
  };
}

/**
 * Reserves an ephemeral loopback port, then closes the listener. A connection
 * to the returned port is refused immediately without depending on a fixed
 * port that another process might own.
 */
export async function reserveClosedLoopbackPort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || isString(address)) {
    await closeServer(server);
    throw new Error("loopback port reservation did not expose a TCP port");
  }

  const port = address.port;

  await closeServer(server);

  return port;
}

const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requestHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;

    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }

  return headers;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();

  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
