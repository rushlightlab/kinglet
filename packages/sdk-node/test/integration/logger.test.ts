import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/index.js";

const TEST_TOKEN = "kl_sdk_integration_key_not_a_real_secret";

interface CapturedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  status: number;
}

interface Reply {
  status: number;
  body?: string;
}

type Responder = (index: number) => Reply;

class FakeIngestServer {
  readonly requests: CapturedRequest[] = [];
  responder: Responder = () => ({ status: 200 });

  private readonly server: Server;
  private readonly waiters = new Set<() => void>();

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<FakeIngestServer> {
    const fake = new FakeIngestServer(createServer());

    fake.server.on("request", (request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        const index = fake.requests.length;
        const reply = fake.responder(index);

        const captured: CapturedRequest = {
          method: request.method ?? "GET",
          path: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          status: reply.status,
        };

        fake.requests.push(captured);
        fake.notify();

        response.statusCode = reply.status;
        response.setHeader("content-type", "text/plain");
        response.end(reply.body ?? "");
      })();
    });

    await new Promise<void>((resolve, reject) => {
      fake.server.once("error", reject);
      fake.server.listen(0, "127.0.0.1", () => {
        fake.server.off("error", reject);
        resolve();
      });
    });

    return fake;
  }

  get url(): string {
    const address = this.server.address();

    if (address === null || isString(address)) {
      throw new Error("SDK integration suite: fake server has no port");
    }

    return `http://127.0.0.1:${address.port}`;
  }

  waitForRequests(count: number, timeoutMs = 5_000): Promise<void> {
    if (this.requests.length >= count) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out waiting for ${count} ingest request(s)`));
      }, timeoutMs);

      const check = (): void => {
        if (this.requests.length < count) return;

        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };

      this.waiters.add(check);
    });
  }

  async close(): Promise<void> {
    const waiters = [...this.waiters];

    this.waiters.clear();

    for (const waiter of waiters) waiter();
    this.server.closeAllConnections();

    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private notify(): void {
    for (const waiter of this.waiters) waiter();
  }
}

function bodyLines(request: CapturedRequest): string[] {
  return request.body.split("\n").filter((line) => line !== "");
}

/** Local type guard: `server.address()` returns a string for a pipe. */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

describe("SDK ingest integration", () => {
  it("sends count-batched NDJSON with the expected headers", async () => {
    const server = await FakeIngestServer.start();

    const logger = createLogger({
      url: `${server.url}/`,
      token: TEST_TOKEN,
      batchSize: 2,
      flushMs: 60_000,
    });

    try {
      logger.info("first", { requestId: "r1" });
      logger.info("second", { requestId: "r2" });

      await server.waitForRequests(1);

      const request = server.requests[0];

      if (request === undefined) throw new Error("ingest request missing");

      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v1/events");
      expect(request.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
      expect(request.headers["content-type"]).toBe("application/x-ndjson");

      const lines = bodyLines(request);

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        level: "info",
        message: "first",
        fields: { requestId: "r1" },
        ts: expect.any(Number),
      });
      expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
        level: "info",
        message: "second",
        fields: { requestId: "r2" },
      });
    } finally {
      await logger.close();
      await server.close();
    }
  });

  it("flushes a partial batch on the timer against a real socket", async () => {
    const server = await FakeIngestServer.start();

    const logger = createLogger({
      url: server.url,
      token: TEST_TOKEN,
      batchSize: 100,
      flushMs: 40,
    });

    try {
      logger.warn("timed event");

      await server.waitForRequests(1);

      const request = server.requests[0];

      if (request === undefined) throw new Error("timer flush request missing");

      const lines = bodyLines(request);

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ level: "warn", message: "timed event" });
    } finally {
      await logger.close();
      await server.close();
    }
  });

  it("requeues a failed batch and delivers it on the next flush", async () => {
    const server = await FakeIngestServer.start();
    const errors: Error[] = [];
    let resolveFirstError: (() => void) | null = null;

    const firstError = new Promise<void>((resolve) => {
      resolveFirstError = resolve;
    });

    server.responder = (index) => (index === 0 ? { status: 503 } : { status: 200 });

    const logger = createLogger({
      url: server.url,
      token: TEST_TOKEN,
      batchSize: 1,
      flushMs: 60_000,
      onError: (error) => {
        errors.push(error);
        resolveFirstError?.();
      },
    });

    try {
      logger.error("kept after retry");

      await firstError;
      await server.waitForRequests(1);

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("kinglet ingest failed: HTTP 503");
      expect(server.requests[0]?.status).toBe(503);

      await logger.flush();
      await server.waitForRequests(2);

      const retry = server.requests[1];

      if (retry === undefined) throw new Error("retry request missing");

      expect(retry.status).toBe(200);
      expect(bodyLines(retry)).toHaveLength(1);
      expect(JSON.parse(bodyLines(retry)[0] ?? "{}")).toMatchObject({
        level: "error",
        message: "kept after retry",
      });
    } finally {
      await logger.close();
      await server.close();
    }
  });

  it("keeps the key out of the URL and body and only in the Authorization header", async () => {
    const server = await FakeIngestServer.start();

    const logger = createLogger({
      url: server.url,
      token: TEST_TOKEN,
      batchSize: 10,
      flushMs: 60_000,
    });

    try {
      logger.info("secretless", { note: "visible" });
      await logger.close();
      await server.waitForRequests(1);

      const request = server.requests[0];

      if (request === undefined) throw new Error("secretless request missing");

      expect(request.path).toBe("/v1/events");
      expect(request.path).not.toContain(TEST_TOKEN);
      expect(request.body).not.toContain(TEST_TOKEN);
      expect(request.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    } finally {
      await logger.close();
      await server.close();
    }
  });
});
