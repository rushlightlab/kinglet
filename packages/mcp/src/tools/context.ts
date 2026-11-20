import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KingletClient } from "../client.ts";
import { jsonResult, runTool } from "./result.ts";

export function registerContextTools(server: McpServer, client: KingletClient): void {
  server.registerTool(
    "get_context",
    {
      title: "Get Kinglet context",
      description:
        "Return the project, key name/type, effective capabilities, and Kinglet server version for this connection. " +
        "Call this first to learn which project the MCP key can see and what it may do. Read-only.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () =>
      runTool("get_context", async () => {
        const context = await client.getContext();

        return jsonResult({ ...context }, { structured: true });
      }),
  );
}
