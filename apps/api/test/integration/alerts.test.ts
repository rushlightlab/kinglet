import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/ids.js";
import type { JsonObject } from "../../src/json.js";
import * as schema from "../../src/storage/schema.js";
import { arrayAt, jsonBody, objectAt, stringAt } from "../helpers/body.js";
import { request } from "../helpers/request.js";
import { seedApiKey, seedMonitor } from "../helpers/seed.js";
import type { SeededApiKey } from "../helpers/seed.js";
import { createTestSession } from "../helpers/session.js";
import type { TestSession } from "../helpers/session.js";

interface AlertsContext {
  session: TestSession;
  monitorId: string;
  alertId: string;
  noLogsKey: SeededApiKey;
}

const SUMMARY = "4 events in 5m (more than 3)";
const SAMPLE = "database connection refused for tenant acme";
const NOTIFY_ERROR = "[ip] connection refused";

let context: AlertsContext | null = null;

function ctx(): AlertsContext {
  if (context === null) throw new Error("alerts suite: test context missing");

  return context;
}

function alertList(body: JsonObject): JsonObject[] {
  return arrayAt(body.alerts, "alerts").map((entry) => objectAt(entry, "alert"));
}

function findAlert(alerts: JsonObject[]): JsonObject {
  const id = ctx().alertId;

  for (const alert of alerts) {
    if (alert.id === id) return alert;
  }

  throw new Error(`alerts suite: alert ${id} missing from response`);
}

beforeAll(async () => {
  const session = await createTestSession();

  try {
    const monitor = await seedMonitor(session.harness.storage, session.data.projects.alpha.id, {
      name: "alert-source",
      query: "level>=error",
      kind: "count_above",
      threshold: 3,
    });

    const alertId = uuidv7();

    await session.harness.storage.db.insert(schema.alerts).values({
      id: alertId,
      monitorId: monitor.id,
      state: "fired",
      summary: SUMMARY,
      count: 4,
      sampleMessage: SAMPLE,
      firedAt: Date.now(),
      notifyStatus: "failed",
      notifyError: NOTIFY_ERROR,
    });

    const noLogsKey = await seedApiKey(session.harness.storage, {
      projectId: session.data.projects.alpha.id,
      name: "alerts-no-logs",
      keyType: "mcp",
      scopes: ["monitors.read"],
    });

    context = { session, monitorId: monitor.id, alertId, noLogsKey };
  } catch (err) {
    await session.close();
    throw err;
  }
});

afterAll(async () => {
  await context?.session.close();
  context = null;
});

describe("alert list projection", () => {
  it("returns summaries, samples, and delivery errors to an admin", async () => {
    const { session } = ctx();

    const response = await request(
      session.harness.app,
      "/v1/alerts?project=" + session.data.projects.alpha.id,
      { cookies: session.adminJar },
    );

    expect(response.status).toBe(200);

    const alert = findAlert(alertList(await jsonBody(response)));

    expect(alert.summary).toBe(SUMMARY);
    expect(alert.sampleMessage).toBe(SAMPLE);
    expect(alert.notifyStatus).toBe("failed");
    expect(alert.notifyError).toBe(NOTIFY_ERROR);
    expect(alert.count).toBe(4);
  });

  it("hides delivery errors from a viewer that cannot write monitors", async () => {
    const { session } = ctx();

    const response = await request(
      session.harness.app,
      "/v1/alerts?project=" + session.data.projects.alpha.id,
      { cookies: session.viewerJar },
    );

    expect(response.status).toBe(200);

    const alert = findAlert(alertList(await jsonBody(response)));

    // Viewers still have logs.read, so event-derived text stays visible.
    expect(alert.summary).toBe(SUMMARY);
    expect(alert.sampleMessage).toBe(SAMPLE);
    expect(alert.notifyStatus).toBe("failed");
    expect(alert.notifyError).toBe(null);
  });

  it("returns log text to an MCP key with logs.read but never delivery errors", async () => {
    const { session } = ctx();

    const response = await request(session.harness.app, "/v1/alerts", {
      bearer: session.data.keys.mcp.plaintext,
    });

    expect(response.status).toBe(200);

    const alert = findAlert(alertList(await jsonBody(response)));

    expect(alert.summary).toBe(SUMMARY);
    expect(alert.sampleMessage).toBe(SAMPLE);
    expect(alert.notifyError).toBe(null);
  });

  it("redacts summaries and samples for an MCP key without logs.read", async () => {
    const { session, noLogsKey } = ctx();

    const response = await request(session.harness.app, "/v1/alerts", {
      bearer: noLogsKey.plaintext,
    });

    expect(response.status).toBe(200);

    const alert = findAlert(alertList(await jsonBody(response)));

    expect(alert.summary).toBe("log content hidden");
    expect(alert.sampleMessage).toBe(null);
    expect(alert.notifyError).toBe(null);
    expect(alert.count).toBe(4);
    expect(alert.monitorName).toBe("alert-source");
    expect(stringAt(alert.monitorId, "monitorId")).toBe(ctx().monitorId);
  });
});
