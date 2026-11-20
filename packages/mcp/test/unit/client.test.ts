import { describe, expect, it, vi } from "vitest";
import { KingletApiError, KingletClient } from "../../src/client.js";
import type { McpConfig } from "../../src/config.js";

const TEST_KEY = "km_client_error_bound_not_a_real_secret";

const TEST_CONFIG: McpConfig = {
  url: "http://kinglet.test",
  key: TEST_KEY,
  timeoutMs: 5_000,
  userAgent: "kinglet-mcp-test",
};

describe("KingletClient error text", () => {
  it("bounds a hostile API error body and strips line breaks", async () => {
    const hostile = `first line\nsecond line\r\n${"x".repeat(5_000)}`;

    // A stubbed fetch keeps this a unit test: no socket, no port.
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify({ error: hostile }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = new KingletClient(TEST_CONFIG);
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
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
