import { createRequire } from "node:module";
import { z } from "zod";

/**
 * Environment parsing for the stdio MCP server. A misconfigured client should
 * fail immediately with one actionable line on stderr — never with a stack
 * trace and never by printing a key.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface McpConfig {
  /** Base URL without a trailing slash, e.g. "https://logs.example.com". */
  url: string;
  /** MCP key (km_…). Kept in memory, never logged. */
  key: string;
  timeoutMs: number;
  userAgent: string;
}

const PackageMetadata = z.object({ version: z.string() });

function packageVersion(): string {
  try {
    const parsed = PackageMetadata.safeParse(createRequire(import.meta.url)("../package.json"));

    return parsed.success ? parsed.data.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const MCP_VERSION = packageVersion();

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

function parseBaseUrl(raw: string): string {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      "KINGLET_URL must be a valid http(s) URL, for example https://logs.example.com",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("KINGLET_URL must use http:// or https://");
  }

  if (url.username || url.password) {
    throw new ConfigError("KINGLET_URL must not contain credentials");
  }

  if (url.search || url.hash) {
    throw new ConfigError("KINGLET_URL must not contain a query string or fragment");
  }

  const pathname = url.pathname.replace(/\/+$/, "");

  return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(
      `KINGLET_MCP_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    );
  }

  return value;
}

function parseKey(raw: string | undefined): string {
  const key = raw?.trim() ?? "";

  if (!key) {
    throw new ConfigError("KINGLET_MCP_KEY is required (an MCP key starting with km_)");
  }

  if (key.startsWith("kl_")) {
    throw new ConfigError(
      "KINGLET_MCP_KEY looks like an API key (kl_). Create an MCP key (km_) in the Kinglet project settings",
    );
  }

  if (!key.startsWith("km_")) {
    throw new ConfigError("KINGLET_MCP_KEY must be an MCP key starting with km_");
  }

  if (/\s/.test(key)) {
    throw new ConfigError("KINGLET_MCP_KEY must not contain whitespace");
  }

  return key;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const rawUrl = env.KINGLET_URL?.trim() ?? "";

  if (!rawUrl) {
    throw new ConfigError(
      "KINGLET_URL is required (for example https://logs.example.com). " +
        "Set KINGLET_URL and KINGLET_MCP_KEY in the MCP client configuration",
    );
  }

  return {
    url: parseBaseUrl(rawUrl),
    key: parseKey(env.KINGLET_MCP_KEY),
    timeoutMs: parseTimeout(env.KINGLET_MCP_TIMEOUT_MS),
    userAgent: `kinglet-mcp/${MCP_VERSION}`,
  };
}
