import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AlertInfo, ChannelSummary, KingletClient } from "../client.ts";
import { DEFAULT_ROWS, MAX_ROWS } from "../client.ts";
import type { CappedPayload } from "./result.ts";
import { jsonResult, runTool } from "./result.ts";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

interface AlertsPayload extends CappedPayload {
  alerts: AlertInfo[];
}

interface ChannelsPayload extends CappedPayload {
  channels: ChannelSummary[];
}

export function registerAlertTools(server: McpServer, client: KingletClient): void {
  server.registerTool(
    "list_alerts",
    {
      title: "List alerts",
      description:
        "List recent monitor alerts for this project, newest first. Notification errors are not " +
        "returned. Default 50 rows, max 200.",
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_ROWS).optional().describe("Rows, default 50."),
      },
      annotations: readOnly,
    },
    (args) =>
      runTool("list_alerts", async () => {
        const alerts = await client.listAlerts(args.limit ?? DEFAULT_ROWS);
        const payload: AlertsPayload = { alerts };

        return jsonResult(payload, {
          list: payload.alerts,
          markTruncated: () => {
            payload.truncated = true;
          },
        });
      }),
  );

  server.registerTool(
    "list_channels",
    {
      title: "List notification channels",
      description:
        "List notification channels available to this project: id, name, type, enabled, and a " +
        "coarse health value only. URLs and delivery error details are never returned. Use the " +
        "returned ids with create_monitor/update_monitor.",
      annotations: readOnly,
    },
    () =>
      runTool("list_channels", async () => {
        const channels = await client.listChannels();
        const payload: ChannelsPayload = { channels: channels.slice(0, MAX_ROWS) };

        if (channels.length > MAX_ROWS) payload.truncated = true;

        return jsonResult(payload, {
          list: payload.channels,
          markTruncated: () => {
            payload.truncated = true;
          },
        });
      }),
  );
}
