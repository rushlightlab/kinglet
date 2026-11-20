import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arrayAt, errorOf, jsonBody, objectAt, stringAt } from "../helpers/body.ts";
import { createTestHarness } from "../helpers/harness.ts";
import type { TestHarness } from "../helpers/harness.ts";
import { request } from "../helpers/request.ts";
import { seedApiKey, seedMonitor, seedProject } from "../helpers/seed.ts";
import type { SeededApiKey, SeededProject } from "../helpers/seed.ts";

interface GateFixture {
  harness: TestHarness;
  project: SeededProject;
  otherProject: SeededProject;
  writeKey: SeededApiKey;
  apiKey: SeededApiKey;
  seededMonitorId: string | null;
}

let closedGate: GateFixture | null = null;
let openGate: GateFixture | null = null;

function off(): GateFixture {
  if (closedGate === null) throw new Error("MCP gate suite: closed-gate fixture missing");

  return closedGate;
}

function on(): GateFixture {
  if (openGate === null) throw new Error("MCP gate suite: open-gate fixture missing");

  return openGate;
}

async function createFixture(allowWrites: boolean): Promise<GateFixture> {
  const harness = await createTestHarness({
    config: { mcpAllowMonitorWrites: allowWrites, allowPrivateWebhooks: true },
  });

  try {
    const project = await seedProject(harness.storage, {
      name: allowWrites ? "MCP writes on" : "MCP writes off",
      slug: allowWrites ? "mcp-writes-on" : "mcp-writes-off",
    });

    const otherProject = await seedProject(harness.storage, {
      name: allowWrites ? "MCP other on" : "MCP other off",
      slug: allowWrites ? "mcp-other-on" : "mcp-other-off",
    });

    const writeKey = await seedApiKey(harness.storage, {
      projectId: project.id,
      name: "mcp-writer",
      keyType: "mcp",
      scopes: ["logs.read", "monitors.read", "monitors.write"],
    });

    const apiKey = await seedApiKey(harness.storage, {
      projectId: project.id,
      name: "app-key",
    });

    let seededMonitorId: string | null = null;

    if (!allowWrites) {
      const monitor = await seedMonitor(harness.storage, project.id, { name: "gate-target" });

      seededMonitorId = monitor.id;
    }

    return { harness, project, otherProject, writeKey, apiKey, seededMonitorId };
  } catch (err) {
    await harness.close();
    throw err;
  }
}

beforeAll(async () => {
  closedGate = await createFixture(false);

  try {
    openGate = await createFixture(true);
  } catch (err) {
    await closedGate.harness.close();
    closedGate = null;
    throw err;
  }
});

afterAll(async () => {
  await closedGate?.harness.close();
  await openGate?.harness.close();
  closedGate = null;
  openGate = null;
});

describe("MCP monitor write gate", () => {
  it("rejects a monitors.write MCP key while the gate is off", async () => {
    const { harness, project, writeKey, seededMonitorId } = off();

    expect(seededMonitorId).not.toBe(null);

    const created = await request(harness.app, "/v1/monitors?project=" + project.id, {
      method: "POST",
      body: { name: "mcp-created", query: "level>=error", kind: "match" },
      bearer: writeKey.plaintext,
    });

    expect(created.status).toBe(403);
    expect(errorOf(await jsonBody(created))).toContain("KINGLET_MCP_ALLOW_MONITOR_WRITES=1");

    if (seededMonitorId === null) throw new Error("MCP gate suite: seeded monitor missing");

    const updated = await request(harness.app, "/v1/monitors/" + seededMonitorId, {
      method: "PATCH",
      body: { name: "mcp-renamed" },
      bearer: writeKey.plaintext,
    });

    expect(updated.status).toBe(403);
    expect(errorOf(await jsonBody(updated))).toContain("KINGLET_MCP_ALLOW_MONITOR_WRITES=1");

    const removed = await request(harness.app, "/v1/monitors/" + seededMonitorId, {
      method: "DELETE",
      bearer: writeKey.plaintext,
    });

    expect(removed.status).toBe(403);
    expect(errorOf(await jsonBody(removed))).toContain("KINGLET_MCP_ALLOW_MONITOR_WRITES=1");
  });

  it("allows a monitors.write MCP key to create, update, and delete when enabled", async () => {
    const { harness, project, writeKey } = on();

    const created = await request(harness.app, "/v1/monitors?project=" + project.id, {
      method: "POST",
      body: { name: "mcp-created", query: "level>=error", kind: "match" },
      bearer: writeKey.plaintext,
    });

    expect(created.status).toBe(201);

    const monitor = objectAt((await jsonBody(created)).monitor, "monitor");
    const id = stringAt(monitor.id, "monitor.id");

    expect(monitor.projectId).toBe(project.id);
    expect(arrayAt(monitor.channels, "channels")).toHaveLength(0);
    expect(monitor.lastError).toBe(null);

    const updated = await request(harness.app, "/v1/monitors/" + id, {
      method: "PATCH",
      body: { name: "mcp-renamed", enabled: false },
      bearer: writeKey.plaintext,
    });

    expect(updated.status).toBe(200);

    const updatedMonitor = objectAt((await jsonBody(updated)).monitor, "monitor");

    expect(updatedMonitor.name).toBe("mcp-renamed");
    expect(updatedMonitor.enabled).toBe(false);

    const removed = await request(harness.app, "/v1/monitors/" + id, {
      method: "DELETE",
      bearer: writeKey.plaintext,
    });

    expect(removed.status).toBe(200);
    expect((await jsonBody(removed)).ok).toBe(true);
  });
});

describe("machine credential boundaries", () => {
  it("never lets an MCP key ingest events or open the live stream", async () => {
    const { harness, writeKey } = off();

    const ingest = await request(harness.app, "/v1/events", {
      method: "POST",
      body: { message: "mcp ingest attempt" },
      bearer: writeKey.plaintext,
    });

    expect(ingest.status).toBe(403);
    expect(errorOf(await jsonBody(ingest))).toBe("MCP keys cannot ingest events");

    const stream = await request(harness.app, "/v1/stream", {
      bearer: writeKey.plaintext,
    });

    expect(stream.status).toBe(403);
    expect(errorOf(await jsonBody(stream))).toBe("MCP keys cannot open the live stream");

    const queryStream = await request(
      harness.app,
      "/v1/stream?key=" + encodeURIComponent(writeKey.plaintext),
      { csrf: false },
    );

    expect(queryStream.status).toBe(403);
    expect(errorOf(await jsonBody(queryStream))).toBe("MCP keys cannot open the live stream");
  });

  it("never lets an application API key manage monitors", async () => {
    const { harness, project, apiKey } = off();

    const listed = await request(harness.app, "/v1/monitors?project=" + project.id, {
      bearer: apiKey.plaintext,
    });

    expect(listed.status).toBe(403);
    expect(errorOf(await jsonBody(listed))).toBe("keys cannot manage monitors");

    const created = await request(harness.app, "/v1/monitors?project=" + project.id, {
      method: "POST",
      body: { name: "api-created", query: "level>=error", kind: "match" },
      bearer: apiKey.plaintext,
    });

    expect(created.status).toBe(403);
    expect(errorOf(await jsonBody(created))).toBe("keys cannot manage monitors");
  });

  it("keeps the MCP context bound to the key's project and ignores ?project=", async () => {
    const { harness, project, otherProject, writeKey } = on();

    const contextResponse = await request(harness.app, "/v1/context?project=" + otherProject.id, {
      bearer: writeKey.plaintext,
    });

    expect(contextResponse.status).toBe(200);

    const body = await jsonBody(contextResponse);
    const contextProject = objectAt(body.project, "project");
    const key = objectAt(body.key, "key");
    const capabilities = objectAt(body.capabilities, "capabilities");
    const responseText = JSON.stringify(body);

    expect(contextProject.id).toBe(project.id);
    expect(contextProject.id).not.toBe(otherProject.id);
    expect(responseText).not.toContain(otherProject.id);
    expect(key.keyType).toBe("mcp");
    expect(capabilities["logs.read"]).toBe(true);
    expect(capabilities["logs.write"]).toBe(false);
    expect(capabilities["monitors.read"]).toBe(true);
    expect(capabilities["monitors.write"]).toBe(true);
    expect(body.monitorWritesEnabled).toBe(true);
  });

  it("reports the monitor write gate as a boolean without the raw env value", async () => {
    const { harness, writeKey } = off();

    const response = await request(harness.app, "/v1/context", {
      bearer: writeKey.plaintext,
    });

    expect(response.status).toBe(200);

    const body = await jsonBody(response);

    expect(body.monitorWritesEnabled).toBe(false);
    expect(JSON.stringify(body)).not.toContain("KINGLET_MCP_ALLOW_MONITOR_WRITES");
  });
});
