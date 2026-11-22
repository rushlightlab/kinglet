import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/ids.ts";
import type { JsonObject } from "../../src/json.ts";
import * as schema from "../../src/storage/schema.ts";
import { arrayAt, errorOf, jsonBody, objectAt, stringAt } from "../helpers/body.ts";
import { request } from "../helpers/request.ts";
import { seedApiKey, seedMonitor } from "../helpers/seed.ts";
import type { SeededApiKey } from "../helpers/seed.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

interface AlertsContext {
  session: TestSession;
  monitorId: string;
  otherMonitorId: string;
  betaMonitorId: string;
  alertId: string;
  resolvedAlertId: string;
  oldAlertId: string;
  betaAlertId: string;
  noLogsKey: SeededApiKey;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SUMMARY = "4 events in 5m (more than 3)";
const SAMPLE = "database connection refused for tenant acme";
const NOTIFY_ERROR = "[ip] connection refused";
const RESOLVED_SUMMARY = "resolved condition cleared";
const BETA_SUMMARY = "beta project alert";

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

function alertIds(alerts: JsonObject[]): string[] {
  return alerts.map((alert) => stringAt(alert.id, "alert.id"));
}

function alertsPath(params: Record<string, string | number | undefined> = {}): string {
  const query = new URLSearchParams();

  query.set("project", ctx().session.data.projects.alpha.id);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }

  return `/v1/alerts?${query.toString()}`;
}

async function listFilteredAlerts(
  params: Record<string, string | number | undefined> = {},
): Promise<JsonObject[]> {
  const response = await request(ctx().session.harness.app, alertsPath(params), {
    cookies: ctx().session.adminJar,
  });

  expect(response.status).toBe(200);

  return alertList(await jsonBody(response));
}

function alertDetailPath(id: string): string {
  return `/v1/alerts/${id}?project=${ctx().session.data.projects.alpha.id}`;
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

    const otherMonitor = await seedMonitor(
      session.harness.storage,
      session.data.projects.alpha.id,
      {
        name: "resolved-source",
        query: "level>=warn",
        kind: "count_below",
        threshold: 1,
      },
    );

    const betaMonitor = await seedMonitor(session.harness.storage, session.data.projects.beta.id, {
      name: "beta-alert-source",
      query: "level>=error",
      kind: "count_above",
      threshold: 1,
    });

    const now = Date.now();
    const alertId = uuidv7();
    const resolvedAlertId = uuidv7();
    const oldAlertId = uuidv7();
    const betaAlertId = uuidv7();

    await session.harness.storage.db.insert(schema.alerts).values([
      {
        id: alertId,
        monitorId: monitor.id,
        state: "fired",
        summary: SUMMARY,
        count: 4,
        sampleMessage: SAMPLE,
        firedAt: now - MINUTE,
        notifyStatus: "failed",
        notifyError: NOTIFY_ERROR,
      },
      {
        id: resolvedAlertId,
        monitorId: otherMonitor.id,
        state: "resolved",
        summary: RESOLVED_SUMMARY,
        count: 2,
        sampleMessage: "warning sample",
        firedAt: now - 2 * HOUR,
        resolvedAt: now - HOUR,
        notifyStatus: "sent",
      },
      {
        id: oldAlertId,
        monitorId: monitor.id,
        state: "fired",
        summary: "old alert outside the window",
        count: 9,
        sampleMessage: "old sample",
        firedAt: now - 40 * DAY,
      },
      {
        id: betaAlertId,
        monitorId: betaMonitor.id,
        state: "fired",
        summary: BETA_SUMMARY,
        count: 7,
        sampleMessage: "beta sample",
        firedAt: now - MINUTE,
        notifyStatus: "failed",
        notifyError: "beta internal delivery error",
      },
    ]);

    const noLogsKey = await seedApiKey(session.harness.storage, {
      projectId: session.data.projects.alpha.id,
      name: "alerts-no-logs",
      keyType: "mcp",
      scopes: ["monitors.read"],
    });

    context = {
      session,
      monitorId: monitor.id,
      otherMonitorId: otherMonitor.id,
      betaMonitorId: betaMonitor.id,
      alertId,
      resolvedAlertId,
      oldAlertId,
      betaAlertId,
      noLogsKey,
    };
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

  it("hides delivery errors from a member that can write monitors", async () => {
    const { session } = ctx();

    const response = await request(
      session.harness.app,
      "/v1/alerts?project=" + session.data.projects.alpha.id,
      { cookies: session.memberJar },
    );

    expect(response.status).toBe(200);

    const alert = findAlert(alertList(await jsonBody(response)));

    // Members still have logs.read, so event-derived text stays visible, but
    // delivery errors are admin-only.
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
    expect(alert.notifyStatus).toBe("failed");
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
    expect(alert.notifyStatus).toBe("failed");
    expect(alert.notifyError).toBe(null);
    expect(alert.count).toBe(4);
    expect(alert.monitorName).toBe("alert-source");
    expect(stringAt(alert.monitorId, "monitorId")).toBe(ctx().monitorId);
  });

  it("does not let an MCP key without logs.read search the hidden summary", async () => {
    const { session, noLogsKey } = ctx();

    const search = async (bearer: string | undefined, q: string): Promise<number> => {
      const auth = bearer === undefined ? { cookies: session.adminJar } : { bearer };
      const response = await request(session.harness.app, alertsPath({ q }), auth);

      expect(response.status).toBe(200);

      return Number((await jsonBody(response)).total);
    };

    // The summary holds log-derived text; the total must not reveal a match.
    expect(await search(noLogsKey.plaintext, "4 events in 5m")).toBe(0);
    // Monitor names stay searchable, and readers of logs still search summaries.
    expect(await search(noLogsKey.plaintext, "alert-source")).toBeGreaterThan(0);
    expect(await search(undefined, "4 events in 5m")).toBeGreaterThan(0);
  });
});

describe("alert filters", () => {
  it("filters by monitor id inside the project", async () => {
    const alerts = await listFilteredAlerts({ monitorId: ctx().otherMonitorId });

    expect(alertIds(alerts)).toEqual([ctx().resolvedAlertId]);
    expect(alertIds(alerts)).not.toContain(ctx().alertId);
  });

  it("filters by state", async () => {
    const fired = await listFilteredAlerts({ monitorId: ctx().monitorId, state: "fired" });
    const resolved = await listFilteredAlerts({ state: "resolved" });

    expect(alertIds(fired)).toContain(ctx().alertId);
    expect(alertIds(fired)).not.toContain(ctx().resolvedAlertId);
    expect(alertIds(resolved)).toEqual([ctx().resolvedAlertId]);

    for (const alert of fired) expect(alert.state).toBe("fired");

    for (const alert of resolved) expect(alert.state).toBe("resolved");
  });

  it("filters by firedAt and clamps an old range to 31 days", async () => {
    const now = Date.now();
    const recent = await listFilteredAlerts({ from: now - HOUR, to: now + 5 * MINUTE });
    const oldRange = await listFilteredAlerts({ from: now - 40 * DAY, to: now });

    expect(alertIds(recent)).toContain(ctx().alertId);
    expect(alertIds(recent)).not.toContain(ctx().resolvedAlertId);
    expect(alertIds(recent)).not.toContain(ctx().oldAlertId);
    expect(alertIds(recent)).not.toContain(ctx().betaAlertId);

    // The 40-day request is clamped to 31 days, so the 40-day-old alert is out.
    expect(alertIds(oldRange)).not.toContain(ctx().oldAlertId);
    expect(alertIds(oldRange)).toContain(ctx().alertId);
  });

  it("keeps all-time history when no time bounds are supplied", async () => {
    const alerts = await listFilteredAlerts();

    expect(alertIds(alerts)).toContain(ctx().oldAlertId);
  });

  it("rejects invalid filters and cross-project monitor ids", async () => {
    const { session, betaMonitorId, betaAlertId } = ctx();
    const now = Date.now();

    for (const [query, expected] of [
      ["monitorId=not-a-uuid", "invalid monitor id"],
      ["state=open", "state must be fired or resolved"],
      ["from=abc", "from/to must be epoch milliseconds"],
      [`from=${now}&to=${now - 1}`, "from must be before to"],
    ] as const) {
      const response = await request(session.harness.app, `/v1/alerts?${query}`, {
        cookies: session.adminJar,
      });

      expect(response.status).toBe(400);

      const body = await jsonBody(response);

      expect(errorOf(body)).toBe(expected);
    }

    const crossProject = await request(
      session.harness.app,
      alertsPath({ monitorId: betaMonitorId }),
      { cookies: session.adminJar },
    );

    expect(crossProject.status).toBe(404);
    expect(errorOf(await jsonBody(crossProject))).toBe("monitor not found");

    const betaDetail = await request(session.harness.app, alertDetailPath(betaAlertId), {
      cookies: session.adminJar,
    });

    expect(betaDetail.status).toBe(404);
  });
});

describe("alert detail", () => {
  it("returns one alert with the admin projection", async () => {
    const { session } = ctx();

    const response = await request(session.harness.app, alertDetailPath(ctx().alertId), {
      cookies: session.adminJar,
    });

    expect(response.status).toBe(200);

    const alert = objectAt((await jsonBody(response)).alert, "alert");

    expect(alert.monitorName).toBe("alert-source");
    expect(alert.summary).toBe(SUMMARY);
    expect(alert.sampleMessage).toBe(SAMPLE);
    expect(alert.notifyStatus).toBe("failed");
    expect(alert.notifyError).toBe(NOTIFY_ERROR);
    expect(alert.count).toBe(4);
  });

  it("masks delivery errors for members, viewers, and MCP keys", async () => {
    const { session } = ctx();

    const auths = [
      { cookies: session.memberJar },
      { cookies: session.viewerJar },
      { bearer: session.data.keys.mcp.plaintext },
    ];

    for (const auth of auths) {
      const response = await request(session.harness.app, alertDetailPath(ctx().alertId), auth);

      expect(response.status).toBe(200);

      const alert = objectAt((await jsonBody(response)).alert, "alert");

      expect(alert.summary).toBe(SUMMARY);
      expect(alert.sampleMessage).toBe(SAMPLE);
      expect(alert.notifyError).toBe(null);
    }
  });

  it("hides log text from an MCP key without logs.read", async () => {
    const { session, noLogsKey } = ctx();

    const response = await request(session.harness.app, alertDetailPath(ctx().alertId), {
      bearer: noLogsKey.plaintext,
    });

    expect(response.status).toBe(200);

    const alert = objectAt((await jsonBody(response)).alert, "alert");

    expect(alert.summary).toBe("log content hidden");
    expect(alert.sampleMessage).toBe(null);
    expect(alert.notifyError).toBe(null);
    expect(alert.count).toBe(4);
  });

  it("returns 404 outside the project and 400 for a malformed id", async () => {
    const { session, betaAlertId } = ctx();

    for (const id of [betaAlertId, uuidv7()]) {
      const response = await request(session.harness.app, alertDetailPath(id), {
        cookies: session.adminJar,
      });

      expect(response.status).toBe(404);

      const body = await jsonBody(response);

      expect(errorOf(body)).toBe("alert not found");
    }

    const malformed = await request(session.harness.app, alertDetailPath("not-a-uuid"), {
      cookies: session.adminJar,
    });

    expect(malformed.status).toBe(400);
    expect(errorOf(await jsonBody(malformed))).toBe("invalid alert id");
  });
});
