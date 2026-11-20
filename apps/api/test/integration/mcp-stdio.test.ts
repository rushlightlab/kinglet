import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/ids.ts";
import { isJsonObject, isString } from "../../src/json.ts";
import type { JsonObject } from "../../src/json.ts";
import * as schema from "../../src/storage/schema.ts";
import { startLoopbackApp } from "../helpers/loopback.ts";
import type { LoopbackAppServer } from "../helpers/loopback.ts";
import { McpStdioClient, parseToolJson, toolFailed, toolText } from "../helpers/mcp-stdio.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";
import { seedApiKey, seedMonitor, seedNotificationChannel } from "../helpers/seed.ts";

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
  countClient: McpStdioClient;
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
  let countClient: McpStdioClient | null = null;
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

    const countKey = await seedApiKey(storage, {
      projectId: alpha.id,
      name: "mcp-contract-count",
      keyType: "mcp",
      scopes: ["logs.read"],
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
        {
          ts: Date.now() - 3_000,
          level: 3,
          service: "api",
          env: "test",
          message: "alpha warning",
          fields: null,
        },
        {
          ts: Date.now() - 4_000,
          level: 2,
          service: "web",
          env: "prod",
          message: "alpha web info",
          fields: null,
        },
        {
          ts: Date.now() - 5_000,
          level: 2,
          service: null,
          env: null,
          message: "alpha unattributed",
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
        {
          ts: Date.now() - 3_000,
          level: 3,
          service: "beta-only-svc",
          env: "prod",
          message: "beta second event",
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

    // A second key keeps count_events calls out of the main client's 60/min
    // bucket, which the established contract tests already approach.
    countClient = await McpStdioClient.start({
      url: server.url,
      key: countKey.plaintext,
      cwd,
      cliPath: CLI_PATH,
    });
    await countClient.initialize();

    fixture = {
      session,
      server,
      client,
      countClient,
      cwd,
      writeKey: writeKey.plaintext,
      alertId,
    };
  } catch (err) {
    const cleanupSteps = [
      async () => countClient?.close(),
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
    await closing.countClient.close();
    expect(closing.countClient.terminated).toBe(true);
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

    expect(names).toHaveLength(13);

    for (const name of [
      "count_events",
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

    const count = tools.find((tool) => tool.name === "count_events");

    expect(count?.annotations?.readOnlyHint).toBe(true);
    expect(count?.annotations?.destructiveHint).toBe(false);
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

  it("counts and groups only the MCP key's project", async () => {
    const test = current();
    const client = test.countClient;

    const ungrouped = await client.callTool("count_events", {});

    expect(toolFailed(ungrouped)).toBe(false);

    const ungroupedBody = parseToolJson(toolText(ungrouped));

    if (ungroupedBody === null) throw new Error("count_events did not return an object");

    expect(ungroupedBody.total).toBe(4);
    expect(ungroupedBody.groups).toBeUndefined();
    expect(ungroupedBody.truncated).toBeUndefined();

    const grouped = await client.callTool("count_events", { groupBy: "service" });
    const groupedText = toolText(grouped);
    const groupedBody = parseToolJson(groupedText);

    expect(toolFailed(grouped)).toBe(false);

    if (groupedBody === null) throw new Error("count_events did not return an object");

    expect(groupedBody.total).toBe(4);

    const groups = groupedBody.groups;

    if (!Array.isArray(groups)) throw new Error("count_events did not return groups");

    const counts = new Map<string, number>();

    for (const entry of groups) {
      if (!isJsonObject(entry)) throw new Error("count_events group is not an object");

      const key = entry.key === null ? "null" : String(entry.key);
      const count = Number(entry.count);

      counts.set(key, count);
    }

    expect(counts).toEqual(
      new Map([
        ["api", 2],
        ["web", 1],
        ["null", 1],
      ]),
    );
    expect(groupedText).not.toContain("beta-only-svc");
    expect(groupedText).not.toContain("beta-only-marker");
    expect(groupedText).not.toContain(test.writeKey);

    const limited = await client.callTool("count_events", {
      groupBy: "service",
      limit: 1,
    });

    const limitedBody = parseToolJson(toolText(limited));

    if (limitedBody === null) throw new Error("count_events did not return an object");

    if (!Array.isArray(limitedBody.groups)) throw new Error("count_events did not return groups");

    expect(limitedBody.groups).toHaveLength(1);
    expect(limitedBody.truncated).toBe(true);

    const byLevel = await client.callTool("count_events", { groupBy: "level" });
    const byLevelBody = parseToolJson(toolText(byLevel));

    if (byLevelBody === null) throw new Error("count_events did not return an object");

    if (!Array.isArray(byLevelBody.groups)) throw new Error("count_events did not return groups");

    const levelKeys = byLevelBody.groups.flatMap((entry) =>
      isJsonObject(entry) && isString(entry.key) ? [entry.key] : [],
    );

    expect(levelKeys).toHaveLength(3);
    expect(levelKeys).toContain("error");
    expect(levelKeys).toContain("info");
    expect(levelKeys).toContain("warn");

    const filtered = await client.callTool("count_events", { q: "level>=error" });
    const filteredBody = parseToolJson(toolText(filtered));

    if (filteredBody === null) throw new Error("count_events did not return an object");

    expect(filteredBody.total).toBe(1);
    expect(client.stdoutGarbage).toEqual([]);
  });

  it("rejects invalid count_events arguments at the schema boundary", async () => {
    const client = current().countClient;

    const invalidArguments: JsonObject[] = [
      { groupBy: "message" },
      { groupBy: "service", limit: 0 },
      { groupBy: "service", limit: 201 },
      { q: "a".repeat(501) },
    ];

    for (const args of invalidArguments) {
      const result = await client.callTool("count_events", args);

      expect(toolFailed(result)).toBe(true);
      expect(toolText(result)).toContain("Input validation error");
      expect(toolText(result)).not.toContain(current().writeKey);
    }
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

    const counts = toolText(
      await test.countClient.callTool("count_events", { groupBy: "service" }),
    );

    const combined = [monitors, channels, alerts, counts].join("\n");

    expect(monitors).toContain("leak-monitor");
    expect(channels).toContain("secret-channel");
    expect(alerts).toContain(test.alertId);
    expect(counts).toContain("api");

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
