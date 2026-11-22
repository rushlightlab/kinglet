import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/env.ts";

const ENV_KEYS = ["KINGLET_HOST", "BETTER_AUTH_SECRET", "KINGLET_AUTH_SECRET"] as const;

type EnvKey = (typeof ENV_KEYS)[number];

let saved: Record<EnvKey, string | undefined>;

beforeEach(() => {
  saved = {
    KINGLET_HOST: process.env.KINGLET_HOST,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    KINGLET_AUTH_SECRET: process.env.KINGLET_AUTH_SECRET,
  };

  // Keep loadConfig from generating and persisting a secret file.
  process.env.BETTER_AUTH_SECRET = "kinglet-env-test-secret-0123456789abcdef";
  delete process.env.KINGLET_AUTH_SECRET;
  delete process.env.KINGLET_HOST;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];

    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("KINGLET_HOST", () => {
  it("leaves the listener host undefined when the variable is unset", () => {
    expect(loadConfig().host).toBeUndefined();
  });

  it("uses an explicit loopback bind address", () => {
    process.env.KINGLET_HOST = "127.0.0.1";

    expect(loadConfig().host).toBe("127.0.0.1");
  });

  it("treats empty and whitespace-only values as unset", () => {
    process.env.KINGLET_HOST = "";
    expect(loadConfig().host).toBeUndefined();

    process.env.KINGLET_HOST = " \t ";
    expect(loadConfig().host).toBeUndefined();
  });

  it("trims a configured bind address", () => {
    process.env.KINGLET_HOST = "  127.0.0.1  ";

    expect(loadConfig().host).toBe("127.0.0.1");
  });
});

describe("BETTER_AUTH_SECRET with a remote database", () => {
  let dbPath: string | undefined;

  beforeEach(() => {
    dbPath = process.env.KINGLET_DB_PATH;
    process.env.KINGLET_DB_PATH = "libsql://kinglet-test.turso.io";
  });

  afterEach(() => {
    if (dbPath === undefined) delete process.env.KINGLET_DB_PATH;
    else process.env.KINGLET_DB_PATH = dbPath;
  });

  it("stops boot instead of generating a secret that can't be kept", () => {
    delete process.env.BETTER_AUTH_SECRET;

    expect(() => loadConfig()).toThrow(/BETTER_AUTH_SECRET is required with a remote database/);
  });

  it("uses an explicit secret", () => {
    expect(loadConfig().authSecret).toBe("kinglet-env-test-secret-0123456789abcdef");
  });

  it("accepts the older KINGLET_AUTH_SECRET name", () => {
    delete process.env.BETTER_AUTH_SECRET;
    process.env.KINGLET_AUTH_SECRET = "kinglet-env-test-legacy-secret-0123456789";

    expect(loadConfig().authSecret).toBe("kinglet-env-test-legacy-secret-0123456789");
  });
});
