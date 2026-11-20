import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isJsonObject, isString } from "../../src/json.ts";
import { startLoopbackApp } from "../helpers/loopback.ts";
import type { LoopbackAppServer } from "../helpers/loopback.ts";
import { reserveClosedLoopbackPort } from "../helpers/loopback.ts";
import { McpStdioClient, parseToolJson, toolFailed, toolText } from "../helpers/mcp-stdio.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";
import { seedApiKey } from "../helpers/seed.ts";

const CLI_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/mcp/dist/cli.js",
);

const WRITE_TOOLS = ["create_monitor", "update_monitor", "delete_monitor"];

interface GateFixture {
  session: TestSession;
  server: LoopbackAppServer;
  writeClient: McpStdioClient;
  readClient: McpStdioClient;
  cwd: string;
  writeKey: string;
  readKey: string;
}

let fixture: GateFixture | null = null;

function current(): GateFixture {
  if (fixture === null) throw new Error("MCP tool gate suite: fixture missing");

  return fixture;
}

function toolNames(tools: Array<{ name: string }>): string[] {
  return tools.map((tool) => tool.name);
}

beforeAll(async () => {
  let session: TestSession | null = null;
  let server: LoopbackAppServer | null = null;
  let writeClient: McpStdioClient | null = null;
  let readClient: McpStdioClient | null = null;
  let cwd: string | null = null;

  try {
    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(`MCP CLI is not built at ${CLI_PATH}; run pnpm build first`);
    }

    session = await createTestSession({ config: { mcpAllowMonitorWrites: true } });

    const writeKey = await seedApiKey(session.harness.storage, {
      projectId: session.data.projects.alpha.id,
      name: "mcp-tool-gate-write",
      keyType: "mcp",
      scopes: ["logs.read", "monitors.read", "monitors.write"],
    });

    const readKey = await seedApiKey(session.harness.storage, {
      projectId: session.data.projects.alpha.id,
      name: "mcp-tool-gate-read",
      keyType: "mcp",
      scopes: ["logs.read", "monitors.read"],
    });

    server = await startLoopbackApp(session.harness.app);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kinglet-mcp-gate-cwd-"));

    writeClient = await McpStdioClient.start({
      url: server.url,
      key: writeKey.plaintext,
      cwd,
      cliPath: CLI_PATH,
    });
    await writeClient.initialize();

    readClient = await McpStdioClient.start({
      url: server.url,
      key: readKey.plaintext,
      cwd,
      cliPath: CLI_PATH,
    });
    await readClient.initialize();

    fixture = {
      session,
      server,
      writeClient,
      readClient,
      cwd,
      writeKey: writeKey.plaintext,
      readKey: readKey.plaintext,
    };
  } catch (err) {
    const cleanupSteps = [
      async () => readClient?.close(),
      async () => writeClient?.close(),
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
    await closing.readClient.close();
    expect(closing.readClient.terminated).toBe(true);
    await closing.writeClient.close();
    expect(closing.writeClient.terminated).toBe(true);
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

describe("MCP conditional monitor write tools", () => {
  it("advertises all 15 tools only to a monitors.write key when the gate is on", async () => {
    const test = current();
    const writeTools = toolNames(await test.writeClient.listTools());
    const readTools = toolNames(await test.readClient.listTools());

    expect(writeTools).toHaveLength(15);

    for (const name of WRITE_TOOLS) expect(writeTools).toContain(name);

    expect(readTools).toHaveLength(12);

    for (const name of WRITE_TOOLS) expect(readTools).not.toContain(name);

    const readContext = parseToolJson(toolText(await test.readClient.callTool("get_context")));
    const writeContext = parseToolJson(toolText(await test.writeClient.callTool("get_context")));

    if (readContext === null || writeContext === null) {
      throw new Error("get_context did not return an object");
    }

    expect(readContext.monitorWritesEnabled).toBe(true);
    expect(writeContext.monitorWritesEnabled).toBe(true);

    const readCapabilities = readContext.capabilities;

    if (!isJsonObject(readCapabilities)) throw new Error("read capabilities missing");

    expect(readCapabilities["monitors.write"]).toBe(false);
  });

  it("creates and deletes a monitor through the write tools when the gate is on", async () => {
    const test = current();

    const created = await test.writeClient.callTool("create_monitor", {
      name: "mcp-gate-created",
      kind: "match",
      query: "level>=error",
    });

    expect(toolFailed(created)).toBe(false);

    const createdBody = parseToolJson(toolText(created));

    if (createdBody === null) throw new Error("create_monitor did not return an object");

    const monitor = createdBody.monitor;

    if (!isJsonObject(monitor) || !isString(monitor.id)) {
      throw new Error("create_monitor did not return an id");
    }

    const listed = toolText(await test.writeClient.callTool("list_monitors"));

    expect(listed).toContain("mcp-gate-created");

    const deleted = await test.writeClient.callTool("delete_monitor", { id: monitor.id });

    expect(toolFailed(deleted)).toBe(false);

    const afterDelete = toolText(await test.writeClient.callTool("list_monitors"));

    expect(afterDelete).not.toContain("mcp-gate-created");
    expect(test.writeClient.stderrLines.join("\n")).not.toContain(test.writeKey);
    expect(test.readClient.stderrLines.join("\n")).not.toContain(test.readKey);
  });

  it("starts read-only when the startup context request fails", async () => {
    const port = await reserveClosedLoopbackPort();
    const key = "km_task15_context_failure_not_a_real_secret";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kinglet-mcp-fallback-cwd-"));
    let client: McpStdioClient | null = null;

    try {
      client = await McpStdioClient.start({
        url: `http://127.0.0.1:${port}`,
        key,
        cwd,
        cliPath: CLI_PATH,
      });
      await client.initialize();
      await client.waitForStderr(1);

      const names = toolNames(await client.listTools());
      const stderr = client.stderrLines.join("\n");

      expect(names).toHaveLength(12);

      for (const name of WRITE_TOOLS) expect(names).not.toContain(name);

      expect(names).toContain("get_context");
      expect(stderr).toContain("context request failed; starting with read-only tools");
      expect(stderr).not.toContain(key);
      expect(client.stdoutGarbage).toEqual([]);
    } finally {
      await client?.close();
      await fs.promises.rm(cwd, { recursive: true, force: true });
    }
  });
});
