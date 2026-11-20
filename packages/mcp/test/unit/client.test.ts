import { describe, expect, it, vi } from "vitest";
import { KingletApiError, KingletClient } from "../../src/client.ts";
import type { McpConfig } from "../../src/config.ts";

const TEST_KEY = "km_client_error_bound_not_a_real_secret";

const TEST_CONFIG: McpConfig = {
  url: "http://kinglet.test",
  key: TEST_KEY,
  timeoutMs: 5_000,
  userAgent: "kinglet-mcp-test",
};

describe("KingletClient.aggregateEvents", () => {
  it("bounds the group limit and preserves null group keys", async () => {
    let requested = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        requested = String(input);

        return new Response(
          JSON.stringify({
            from: 1_000,
            to: 2_000,
            total: 7,
            groupBy: "level",
            groups: [
              { key: "error", count: 7 },
              { key: null, count: 0 },
            ],
            truncated: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    try {
      const client = new KingletClient(TEST_CONFIG);

      const result = await client.aggregateEvents({
        q: "level>=error",
        from: 1_000,
        to: 2_000,
        groupBy: "level",
        limit: 500,
      });

      const url = new URL(requested);

      expect(url.pathname).toBe("/v1/aggregate");
      expect(url.searchParams.get("q")).toBe("level>=error");
      expect(url.searchParams.get("from")).toBe("1000");
      expect(url.searchParams.get("to")).toBe("2000");
      expect(url.searchParams.get("groupBy")).toBe("level");
      expect(url.searchParams.get("limit")).toBe("200");
      expect(result).toEqual({
        from: 1_000,
        to: 2_000,
        total: 7,
        groupBy: "level",
        groups: [
          { key: "error", count: 7 },
          { key: null, count: 0 },
        ],
        truncated: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omits group fields for an ungrouped response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Response(JSON.stringify({ from: 1_000, to: 2_000, total: 3 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    try {
      const result = await new KingletClient(TEST_CONFIG).aggregateEvents();

      expect(result).toEqual({ from: 1_000, to: 2_000, total: 3 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("KingletClient alerts", () => {
  it("sends every alert filter and bounds the limit", async () => {
    let requested = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        requested = String(input);

        return new Response(
          JSON.stringify({
            alerts: [
              {
                id: "0190f5b2-7c3a-7def-8abc-0123456789ab",
                monitorId: "0190f5b2-8d10-7f3b-9c4a-1e2d3f4a5b6c",
                state: "resolved",
                summary: "summary",
                firedAt: 1_000,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    try {
      const alerts = await new KingletClient(TEST_CONFIG).listAlerts({
        limit: 500,
        monitorId: "0190f5b2-8d10-7f3b-9c4a-1e2d3f4a5b6c",
        state: "resolved",
        from: 1_000,
        to: 2_000,
      });

      const url = new URL(requested);

      expect(url.pathname).toBe("/v1/alerts");
      expect(url.searchParams.get("limit")).toBe("200");
      expect(url.searchParams.get("monitorId")).toBe("0190f5b2-8d10-7f3b-9c4a-1e2d3f4a5b6c");
      expect(url.searchParams.get("state")).toBe("resolved");
      expect(url.searchParams.get("from")).toBe("1000");
      expect(url.searchParams.get("to")).toBe("2000");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.state).toBe("resolved");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps a missing alert to null", async () => {
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify({ error: "alert not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    try {
      const alert = await new KingletClient(TEST_CONFIG).getAlert(
        "0190f5b2-7c3a-7def-8abc-0123456789ab",
      );

      expect(alert).toBe(null);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("KingletClient context", () => {
  it("defaults monitorWritesEnabled to false for an older server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              project: { id: "project-id", name: "Project", slug: "project" },
              key: { id: "key-id", name: "Key", keyType: "mcp", scopes: ["logs.read"] },
              capabilities: {
                "logs.read": true,
                "logs.write": false,
                "monitors.read": true,
                "monitors.write": false,
              },
              server: { version: "0.2.0", retentionDays: 14 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    try {
      const context = await new KingletClient(TEST_CONFIG).getContext();

      expect(context.monitorWritesEnabled).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

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
