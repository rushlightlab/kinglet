import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.ts";

const BASE_ENV = {
  KINGLET_URL: "https://logs.example.com",
  KINGLET_MCP_KEY: "km_test_key_not_real",
};

describe("loadConfig URLs", () => {
  it("normalizes the base URL and defaults the timeout", () => {
    const config = loadConfig({ ...BASE_ENV });

    expect(config.url).toBe("https://logs.example.com");
    expect(config.key).toBe("km_test_key_not_real");
    expect(config.timeoutMs).toBe(15_000);
    expect(config.userAgent).toMatch(/^kinglet-mcp\/\d+\.\d+\.\d+$/);
  });

  it("accepts http and strips a trailing slash", () => {
    expect(loadConfig({ ...BASE_ENV, KINGLET_URL: "http://localhost:3000/" }).url).toBe(
      "http://localhost:3000",
    );
    expect(loadConfig({ ...BASE_ENV, KINGLET_URL: "https://logs.example.com///" }).url).toBe(
      "https://logs.example.com",
    );
  });

  it("preserves a path prefix", () => {
    expect(loadConfig({ ...BASE_ENV, KINGLET_URL: "https://example.com/kinglet/" }).url).toBe(
      "https://example.com/kinglet",
    );
    expect(loadConfig({ ...BASE_ENV, KINGLET_URL: "https://example.com/a/b//" }).url).toBe(
      "https://example.com/a/b",
    );
  });

  it("requires a URL", () => {
    expect(() => loadConfig({ KINGLET_MCP_KEY: BASE_ENV.KINGLET_MCP_KEY })).toThrow(ConfigError);
    expect(() => loadConfig({ KINGLET_MCP_KEY: BASE_ENV.KINGLET_MCP_KEY })).toThrow(
      /KINGLET_URL is required/,
    );
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_URL: "   " })).toThrow(
      /KINGLET_URL is required/,
    );
  });

  it("refuses cleartext http to a host other than loopback unless opted in", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(loadConfig({ ...BASE_ENV, KINGLET_URL: url }).url).toBe(url);
    }

    for (const url of ["http://logs.example.com", "http://192.168.1.20:3000"]) {
      expect(() => loadConfig({ ...BASE_ENV, KINGLET_URL: url })).toThrow(/must use https/);
      expect(
        loadConfig({ ...BASE_ENV, KINGLET_URL: url, KINGLET_MCP_ALLOW_INSECURE_HTTP: "1" }).url,
      ).toBe(url);
    }
  });

  it("rejects malformed URLs and non-http protocols", () => {
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_URL: "not a url" })).toThrow(
      /must be a valid http\(s\) URL/,
    );
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_URL: "ftp://logs.example.com" })).toThrow(
      /must use http:\/\/ or https:\/\//,
    );
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_URL: "file:///srv/kinglet" })).toThrow(
      /must use http:\/\/ or https:\/\//,
    );
  });

  it("rejects embedded credentials", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KINGLET_URL: "https://user:pass@logs.example.com" }),
    ).toThrow(/must not contain credentials/);
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_URL: "https://user@logs.example.com" })).toThrow(
      /must not contain credentials/,
    );
  });

  it("rejects query strings and fragments", () => {
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_URL: "https://logs.example.com?x=1" })).toThrow(
      /must not contain a query string or fragment/,
    );
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_URL: "https://logs.example.com/#top" })).toThrow(
      /must not contain a query string or fragment/,
    );
  });
});

describe("loadConfig keys", () => {
  it("requires an MCP key", () => {
    expect(() => loadConfig({ KINGLET_URL: BASE_ENV.KINGLET_URL })).toThrow(
      /KINGLET_MCP_KEY is required/,
    );
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_MCP_KEY: "   " })).toThrow(
      /KINGLET_MCP_KEY is required/,
    );
  });

  it("rejects an explicit API key with an actionable message", () => {
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_MCP_KEY: "kl_live_abcdef" })).toThrow(
      /looks like an API key \(kl_\)/,
    );
  });

  it("rejects keys without the km_ prefix", () => {
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_MCP_KEY: "abc" })).toThrow(
      /must be an MCP key starting with km_/,
    );
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_MCP_KEY: "sk_live_123" })).toThrow(
      /must be an MCP key starting with km_/,
    );
  });

  it("rejects whitespace inside the key and trims the outside", () => {
    expect(() => loadConfig({ ...BASE_ENV, KINGLET_MCP_KEY: "km_abc def" })).toThrow(
      /must not contain whitespace/,
    );
    expect(loadConfig({ ...BASE_ENV, KINGLET_MCP_KEY: "  km_abc  " }).key).toBe("km_abc");
  });

  it("does not echo the supplied key in an error message", () => {
    const supplied = "secret-token-value";

    try {
      loadConfig({ ...BASE_ENV, KINGLET_MCP_KEY: supplied });
      throw new Error("expected loadConfig to reject the key");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);

      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain(supplied);
    }
  });
});

describe("loadConfig timeout", () => {
  it("accepts the documented bounds", () => {
    expect(loadConfig({ ...BASE_ENV, KINGLET_MCP_TIMEOUT_MS: "1000" }).timeoutMs).toBe(1_000);
    expect(loadConfig({ ...BASE_ENV, KINGLET_MCP_TIMEOUT_MS: "300000" }).timeoutMs).toBe(300_000);
    expect(loadConfig({ ...BASE_ENV, KINGLET_MCP_TIMEOUT_MS: "45000" }).timeoutMs).toBe(45_000);
  });

  it("uses the default for an empty value", () => {
    expect(loadConfig({ ...BASE_ENV, KINGLET_MCP_TIMEOUT_MS: "" }).timeoutMs).toBe(15_000);
    expect(loadConfig({ ...BASE_ENV, KINGLET_MCP_TIMEOUT_MS: "   " }).timeoutMs).toBe(15_000);
  });

  it("rejects out-of-range, fractional, and non-numeric values", () => {
    for (const value of ["999", "300001", "15000.5", "abc", "-1"]) {
      expect(() => loadConfig({ ...BASE_ENV, KINGLET_MCP_TIMEOUT_MS: value })).toThrow(
        /KINGLET_MCP_TIMEOUT_MS must be an integer between 1000 and 300000/,
      );
    }
  });
});

describe("ConfigError", () => {
  it("is a named Error subclass", () => {
    const error = new ConfigError("bad config");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConfigError");
    expect(error.message).toBe("bad config");
  });
});
