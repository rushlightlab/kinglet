import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KingletClient, MonitorInfo, MonitorInput } from "../client.js";
import { MAX_ROWS } from "../client.js";
import type { CappedPayload } from "./result.js";
import { errorResult, jsonResult, runTool } from "./result.js";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const channelIds = z
  .array(
    z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "channel ids are UUIDs; URLs are never accepted",
      ),
  )
  .max(8)
  .optional()
  .describe("Notification channel ids from list_channels. Never URLs.");

const monitorDetails = {
  query: z
    .string()
    .max(500)
    .refine((value) => !/[\r\n]/.test(value), "query must be a single line")
    .optional()
    .describe("Kinglet filter expression."),
  threshold: z.number().int().min(1).max(1_000_000).optional().describe("Match count threshold."),
  windowMs: z
    .number()
    .int()
    .min(60_000)
    .max(2_592_000_000)
    .optional()
    .describe("Evaluation window in milliseconds (min 1 minute)."),
  intervalMs: z
    .number()
    .int()
    .min(10_000)
    .max(86_400_000)
    .optional()
    .describe("Evaluation interval in milliseconds (min 10 seconds)."),
  cooldownMs: z
    .number()
    .int()
    .min(0)
    .max(604_800_000)
    .optional()
    .describe("Minimum time between notifications in milliseconds."),
  enabled: z.boolean().optional().describe("Whether the monitor runs."),
  channelIds,
};

const monitorEdits = {
  name: z.string().min(1).max(128).optional().describe("Monitor name."),
  kind: z
    .enum(["match", "count_above", "count_below"])
    .optional()
    .describe("match, count_above, or count_below."),
  ...monitorDetails,
};

interface MonitorsPayload extends CappedPayload {
  monitors: MonitorInfo[];
}

interface MonitorPayload extends CappedPayload {
  monitor: MonitorInfo;
}

function hasEdits(patch: MonitorInput): boolean {
  return (
    patch.name !== undefined ||
    patch.query !== undefined ||
    patch.kind !== undefined ||
    patch.threshold !== undefined ||
    patch.windowMs !== undefined ||
    patch.intervalMs !== undefined ||
    patch.cooldownMs !== undefined ||
    patch.enabled !== undefined ||
    patch.channelIds !== undefined
  );
}

export function registerMonitorTools(server: McpServer, client: KingletClient): void {
  server.registerTool(
    "list_monitors",
    {
      title: "List monitors",
      description:
        "List monitors in this project with config, enabled state, last evaluation, and channel " +
        "summaries. Channel URLs and raw engine errors are never returned. Capped at 100 rows.",
      annotations: readOnly,
    },
    () =>
      runTool("list_monitors", async () => {
        const monitors = await client.listMonitors();
        const payload: MonitorsPayload = { monitors: monitors.slice(0, MAX_ROWS) };

        if (monitors.length > MAX_ROWS) payload.truncated = true;

        return jsonResult(payload, {
          list: payload.monitors,
          markTruncated: () => {
            payload.truncated = true;
          },
        });
      }),
  );

  server.registerTool(
    "get_monitor",
    {
      title: "Get one monitor",
      description:
        "Return one monitor by id. Channel URLs and raw engine errors are never returned.",
      inputSchema: {
        id: z.string().min(1).max(64).describe("Monitor id."),
      },
      annotations: readOnly,
    },
    (args) =>
      runTool("get_monitor", async () => {
        const monitor = await client.getMonitor(args.id);

        if (!monitor) return { result: errorResult("monitor not found") };

        return jsonResult({ monitor });
      }),
  );

  server.registerTool(
    "create_monitor",
    {
      title: "Create monitor",
      description:
        "Create a monitor in this project. Requires the monitors.write scope. Attach existing " +
        "notification channels by id with channelIds — URLs are never accepted. Enabled channels " +
        "can make the Kinglet server send notifications to external services when the monitor fires. " +
        "Writes update the monitor's updatedAt, matching the audit level of a human edit.",
      inputSchema: {
        name: z.string().min(1).max(128).describe("Monitor name."),
        kind: z.enum(["match", "count_above", "count_below"]).describe("Monitor kind."),
        ...monitorDetails,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) =>
      runTool("create_monitor", async () => {
        const monitor = await client.createMonitor(args);
        const payload: MonitorPayload = { monitor };

        return jsonResult(payload);
      }),
  );

  server.registerTool(
    "update_monitor",
    {
      title: "Update monitor",
      description:
        "Partially update a monitor by id. Only supplied fields change. Requires the " +
        "monitors.write scope. Attach channels by id with channelIds — URLs are never accepted.",
      inputSchema: {
        id: z.string().min(1).max(64).describe("Monitor id."),
        ...monitorEdits,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) =>
      runTool("update_monitor", async () => {
        const { id, ...patch } = args;

        if (!hasEdits(patch))
          return { result: errorResult("provide at least one field to update") };

        const monitor = await client.updateMonitor(id, patch);
        const payload: MonitorPayload = { monitor };

        return jsonResult(payload);
      }),
  );

  server.registerTool(
    "delete_monitor",
    {
      title: "Delete monitor",
      description:
        "Delete a monitor and its alert history by id. Destructive and irreversible; the client " +
        "should ask the user before calling this. Requires the monitors.write scope.",
      inputSchema: {
        id: z.string().min(1).max(64).describe("Monitor id."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) =>
      runTool("delete_monitor", async () => {
        await client.deleteMonitor(args.id);

        return jsonResult({ deleted: true, id: args.id });
      }),
  );
}
