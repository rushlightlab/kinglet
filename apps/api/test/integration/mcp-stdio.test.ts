import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/ids.js";
import { isJsonObject } from "../../src/json.js";
import * as schema from "../../src/storage/schema.js";
import { startLoopbackApp } from "../helpers/loopback.js";
import type { LoopbackAppServer } from "../helpers/loopback.js";
import { McpStdioClient, parseToolJson, toolFailed, toolText } from "../helpers/mcp-stdio.js";
import { createTestSession } from "../helpers/session.js";
import type { TestSession } from "../helpers/session.js";
import { seedApiKey, seedMonitor, seedNotificationChannel } from "../helpers/seed.js";

const CLI_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/mcp/dist/cli.js",
);

const SECRET_CHANNEL_URL = "https://internal.example.test/hooks/very-secret-token";
const RAW_MONITOR_ERROR = "dial tcp 10.20.30.40:443: connection refused";

interface McpFixture {
  session: TestSession;
  server: LoopbackAppServer;
  client: McpStdioClient;
  cwd: string;
  writeKey: string;
  alertId: string;
}

let fixture: McpFixture | null = null;

beforeAll(async () => {
  if (!fs.existsSync(CLI_PATH)) {
    throw new Error(
      `MCP CLI is not built at ${CLI_PATH}; run pnpm build before the integration suite`,
    );
  }

  let session: TestSession | null = null;
  let server: LoopbackAppServer | null = null;
  let client: McpStdioClient | null = null;
  let cwd: string | null = null;

  try {
    session = await createTestSession({ config: { mcpAllowMonitorWrites: false } });

    const storage = session.harness.storage;
    const alpha = session.data.projects.alpha;
    const beta = session.data.projects.beta;

    const writeKey = await seedApiKey(storage, {
      projectId: alpha.id,
      name: "mcp-contract-write",
      keyType: "mcp",
      scopes: ["logs.read", "monitors.read", "monitors.write"],
    });

    await storage.insertEvents(
      alpha.id,
      [
        {
          ts: Date.now() - 2_000,
          level: 4,
          service: "api",
          env: "test",
          message: "alpha-only-marker",
          fields: null,
        },
      ],
      null,
    );
    await storage.insertEvents(
      beta.id,
      [
        {
          ts: Date.now() - 2_000,
          level: 4,
          service: "api",
          env: "test",
          message: "beta-only-marker",
          fields: null,
        },
      ],
      null,
    );

    const channel = await seedNotificationChannel(storage, {
      name: "secret-channel",
      url: SECRET_CHANNEL_URL,
    });

    const monitor = await seedMonitor(storage, alpha.id, {
      name: "leak-monitor",
      query: "level>=error",
      kind: "count_above",
      threshold: 2,
      channelIds: [channel.id],
    });

    await storage.db
      .update(schema.monitors)
      .set({ lastError: RAW_MONITOR_ERROR, lastErrorAt: Date.now() })
      .where(eq(schema.monitors.id, monitor.id));

    const alertId = uuidv7();

    await storage.db.insert(schema.alerts).values({
      id: alertId,
      monitorId: monitor.id,
      state: "fired",
      summary: "Leak monitor fired",
      count: 3,
      sampleMessage: "secret sample content",
      firedAt: Date.now(),
      resolvedAt: null,
      notifyStatus: "failed",
      notifyError: `webhook ${SECRET_CHANNEL_URL} failed`,
    });

    server = await startLoopbackApp(session.harness.app);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kinglet-mcp-cwd-"));

    client = await McpStdioClient.start({
      url: server.url,
      key: writeKey.plaintext,
      cwd,
      cliPath: CLI_PATH,
    });
    await client.initialize();

    fixture = {
      session,
      server,
      client,
      cwd,
      writeKey: writeKey.plaintext,
      alertId,
    };
  } catch (err) {
    const cleanupSteps = [
      async () => client?.close(),
      async () => {
        if (server !== null) await server.close();
      },
      async () => {
        if (session !== null) await session.close();
      },
      async () => {
        if (cwd !== null) await fs.promises.rm(cwd, { recursive: true, force: true });
      },
    ];

    for (const step of cleanupSteps) {
      try {
        await step();
      } catch {
        // Preserve the setup failure; cleanup is best-effort.
      }
    }

    throw err;
  }
});

afterAll(async () => {
  const closing = fixture;

  fixture = null;

  if (closing === null) return;

  try {
    await closing.client.close();
    expect(closing.client.terminated).toBe(true);
  } finally {
    try {
      await closing.server.close();
    } finally {
      try {
        await closing.session.close();
      } finally {
        await fs.promises.rm(closing.cwd, { recursive: true, force: true });
      }
    }
  }
});

function current(): McpFixture {
  if (fixture === null) throw new Error("MCP stdio suite: fixture missing");

  return fixture;
}

function auditCount(client: McpStdioClient, tool: string): number {
  return client.stderrLines.filter((line) => line.includes(`tool=${tool} `)).length;
}

async function waitForAudit(
  client: McpStdioClient,
  tool: string,
  minimum: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (auditCount(client, tool) >= minimum) return;

    try {
      await client.waitForStderr(client.stderrLines.length + 1, 200);
    } catch {
      // Keep polling until the deadline; later lines may still be in flight.
    }
  }

  throw new Error(`timed out waiting for ${minimum} ${tool} audit line(s)`);
}

/** Wait for a line from a specific tool, not just any line at a count. */
async function waitForAuditLine(
  client: McpStdioClient,
  tool: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (client.stderrLines.some((line) => line.includes(`tool=${tool} `))) return;

    try {
      await client.waitForStderr(client.stderrLines.length + 1, 200);
    } catch {
      // Keep polling until the deadline; stderr delivery is asynchronous.
    }
  }

  throw new Error(`timed out waiting for a ${tool} audit line`);
}

describe("MCP stdio contract", () => {
  it("exposes the complete tool list over a real stdio session", async () => {
    const tools = await current().client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toHaveLength(12);

    for (const name of [
      "create_monitor",
      "delete_monitor",
      "get_context",
      "get_event",
      "get_histogram",
      "get_monitor",
      "list_alerts",
      "list_channels",
      "list_monitors",
      "list_services",
      "search_events",
      "update_monitor",
    ]) {
      expect(names).toContain(name);
    }

    expect(tools.every((tool) => (tool.description ?? "").length > 0)).toBe(true);
  });

  it("returns the key's project context without exposing another project", async () => {
    const test = current();
    const result = await test.client.callTool("get_context");

    expect(toolFailed(result)).toBe(false);

    const context = parseToolJson(toolText(result));

    if (context === null) throw new Error("get_context did not return an object");

    const project = context.project;
    const key = context.key;
    const capabilities = context.capabilities;
    const serialized = JSON.stringify(context);

    expect(isJsonObject(project) ? project.id : null).toBe(test.session.data.projects.alpha.id);
    expect(isJsonObject(project) ? project.name : null).toBe(test.session.data.projects.alpha.name);
    expect(serialized).not.toContain(test.session.data.projects.beta.id);
    expect(serialized).not.toContain(test.writeKey);
    expect(isJsonObject(key) ? key.keyType : null).toBe("mcp");
    expect(isJsonObject(capabilities) ? capabilities["logs.read"] : null).toBe(true);
    expect(isJsonObject(capabilities) ? capabilities["logs.write"] : null).toBe(false);
    expect(isJsonObject(capabilities) ? capabilities["monitors.write"] : null).toBe(true);
  });

  it("searches only the MCP key's project", async () => {
    const result = await current().client.callTool("search_events", { limit: 200 });
    const text = toolText(result);

    expect(toolFailed(result)).toBe(false);
    expect(text).toContain("alpha-only-marker");
    expect(text).not.toContain("beta-only-marker");
    expect(text).not.toContain(current().session.data.projects.beta.id);
  });

  it("returns the monitor-write gate rejection without creating a monitor", async () => {
    const test = current();

    const created = await test.client.callTool("create_monitor", {
      name: "gate-probe",
      kind: "match",
      query: "level>=error",
    });

    expect(toolFailed(created)).toBe(true);
    expect(toolText(created)).toContain("KINGLET_MCP_ALLOW_MONITOR_WRITES=1");

    const listed = await test.client.callTool("list_monitors");
    const text = toolText(listed);

    expect(text).toContain("leak-monitor");
    expect(text).not.toContain("gate-probe");
  });

  it("never returns channel URLs, delivery errors, or raw monitor errors", async () => {
    const test = current();
    const monitors = toolText(await test.client.callTool("list_monitors"));
    const channels = toolText(await test.client.callTool("list_channels"));
    const alerts = toolText(await test.client.callTool("list_alerts", { limit: 50 }));
    const combined = [monitors, channels, alerts].join("\n");

    expect(monitors).toContain("leak-monitor");
    expect(channels).toContain("secret-channel");
    expect(alerts).toContain(test.alertId);

    for (const secret of [
      SECRET_CHANNEL_URL,
      "internal.example.test",
      "very-secret-token",
      "10.20.30.40",
      "connection refused",
      "notifyError",
      test.writeKey,
    ]) {
      expect(combined).not.toContain(secret);
    }

    const alertList = parseToolJson(alerts);
    const alertsArray = alertList?.alerts;

    if (!Array.isArray(alertsArray) || alertsArray.length === 0) {
      throw new Error("list_alerts returned no alerts");
    }

    expect(alertsArray[0]).not.toHaveProperty("notifyError");
  });

  it("keeps stdout protocol-only and audits the later tool calls without the key", async () => {
    const test = current();

    // Drain stderr before taking the baseline. `list_services` is not called
    // by any earlier test, and stderr is ordered, so its audit line proves
    // every earlier line has arrived rather than landing in the count below.
    expect(toolFailed(await test.client.callTool("list_services"))).toBe(false);
    await waitForAuditLine(test.client, "list_services");

    const expectedAudits: Array<[string, number]> = [
      ["search_events", auditCount(test.client, "search_events") + 1],
      ["list_monitors", auditCount(test.client, "list_monitors") + 1],
      ["list_alerts", auditCount(test.client, "list_alerts") + 1],
      ["list_channels", auditCount(test.client, "list_channels") + 1],
    ];

    await test.client.callTool("search_events", { limit: 1 });
    await test.client.callTool("list_monitors");
    await test.client.callTool("list_alerts", { limit: 1 });
    await test.client.callTool("list_channels");

    for (const [tool, minimum] of expectedAudits) {
      await waitForAudit(test.client, tool, minimum);
    }

    expect(test.client.stdoutGarbage).toEqual([]);
    expect(test.client.stderrLines.length).toBeGreaterThan(0);

    for (const line of test.client.stderrLines) {
      expect(line).toMatch(/^kinglet-mcp tool=\S+ duration=\d+ms status=(ok|error) rows=\d+$/);
    }

    expect(test.client.stderrLines.join("\n")).not.toContain(test.writeKey);
    expect(fs.readdirSync(test.cwd)).toEqual([]);
  });
});
