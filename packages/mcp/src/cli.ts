#!/usr/bin/env node
/**
 * stdio entry point. Nothing may be written to stdout except MCP protocol
 * frames; diagnostics go to stderr only.
 */

import { KingletClient } from "./client.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new KingletClient(config);

  await startServer(client);
}

main().catch((err) => {
  const message =
    err instanceof ConfigError
      ? err.message
      : err instanceof Error
        ? err.message
        : "unknown startup error";

  process.stderr.write(`kinglet-mcp: ${message}\n`);
  process.exitCode = 1;
});
