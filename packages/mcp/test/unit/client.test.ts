import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { KingletApiError, KingletClient } from "../../src/client.js";
import type { McpConfig } from "../../src/config.js";

const TEST_KEY = "km_client_error_bound_not_a_real_secret";

interface FakeApi extends McpConfig {
  close(): Promise<void>;
}

/** Local type guard: `server.address()` returns a string for a pipe. */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Loopback-only API stub; no test in this suite may use a real network. */
async function startErrorServer(status: number, body: string): Promise<FakeApi> {
  const server = createServer((_request, response) => {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(body);
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
    throw new Error("MCP client suite: fake server has no port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    key: TEST_KEY,
    timeoutMs: 5_000,
    userAgent: "kinglet-mcp-test",
    close: async () => {
      server.closeAllConnections();

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

describe("KingletClient error text", () => {
  it("bounds a hostile API error body and strips line breaks", async () => {
    const hostile = `first line\nsecond line\r\n${"x".repeat(5_000)}`;
    const api = await startErrorServer(400, JSON.stringify({ error: hostile }));

    try {
      const client = new KingletClient(api);
      let thrown: Error | null = null;

      try {
        await client.searchEvents();
      } catch (cause) {
        thrown = cause instanceof Error ? cause : new Error(String(cause));
      }

      expect(thrown).toBeInstanceOf(KingletApiError);

      if (!(thrown instanceof KingletApiError)) throw new Error("expected a KingletApiError");

      const bytes = Buffer.byteLength(thrown.message, "utf8");

      expect(thrown.status).toBe(400);
      // The bound is 512 bytes including the ellipsis, not 512 plus it.
      expect(bytes).toBeLessThanOrEqual(512);
      expect(bytes).toBeGreaterThan(500);
      expect(thrown.message.endsWith("…")).toBe(true);
      expect(thrown.message).not.toContain("\n");
      expect(thrown.message).not.toContain("\r");
      expect(thrown.message.startsWith("first line second line")).toBe(true);
      expect(thrown.message).not.toContain("x".repeat(600));
    } finally {
      await api.close();
    }
  });
});
