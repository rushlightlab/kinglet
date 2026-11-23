import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/ids.ts";
import type { JsonObject } from "../../src/json.ts";
import { recordDelivery } from "../../src/notifications/store.ts";
import * as schema from "../../src/storage/schema.ts";
import { arrayAt, jsonBody, numberAt, objectAt, stringAt } from "../helpers/body.ts";
import { request } from "../helpers/request.ts";
import { seedMonitor, seedNotificationChannel } from "../helpers/seed.ts";
import { createTestSession } from "../helpers/session.ts";
import type { TestSession } from "../helpers/session.ts";

interface PagingContext {
  session: TestSession;
  /** Alpha alert ids, newest first. */
  alertIds: string[];
  /** Delivery subjects, newest first. */
  subjects: string[];
}

let context: PagingContext | null = null;

function ctx(): PagingContext {
  if (context === null) throw new Error("paging suite: test context missing");

  return context;
}

interface Page {
  ids: string[];
  total: number;
}

async function getPage(path: string, listKey: "alerts" | "deliveries"): Promise<Page> {
  const response = await request(ctx().session.harness.app, path, {
    cookies: ctx().session.adminJar,
  });

  expect(response.status).toBe(200);
  const body = await jsonBody(response);
  const rows = arrayAt(body[listKey], listKey).map((row) => objectAt(row, listKey));

  return {
    ids: rows.map((row: JsonObject) =>
      stringAt(listKey === "alerts" ? row.id : row.subject, "row"),
    ),
    total: numberAt(body.total, "total"),
  };
}

function alertsPage(params: Record<string, string | number>): Promise<Page> {
  const query = new URLSearchParams({ project: ctx().session.data.projects.alpha.id });

  for (const [key, value] of Object.entries(params)) query.set(key, String(value));

  return getPage(`/v1/alerts?${query.toString()}`, "alerts");
}

function deliveriesPage(params: Record<string, string | number>): Promise<Page> {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) query.set(key, String(value));

  return getPage(`/v1/notifications/deliveries?${query.toString()}`, "deliveries");
}

beforeAll(async () => {
  const session = await createTestSession();

  try {
    const { storage } = session.harness;
    const alpha = session.data.projects.alpha.id;
    const errors = await seedMonitor(storage, alpha, { name: "checkout errors", query: "x" });
    const quiet = await seedMonitor(storage, alpha, { name: "udp gone quiet", query: "y" });

    const beta = await seedMonitor(storage, session.data.projects.beta.id, {
      name: "beta checkout",
      query: "z",
    });

    const now = Date.now();
    const alertIds = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];

    await storage.db.insert(schema.alerts).values([
      {
        id: alertIds[0] ?? "",
        monitorId: errors.id,
        state: "fired",
        summary: "6 events in 5m (more than 5)",
        firedAt: now - 1000,
        notifyStatus: "failed",
        notifyError: "hooks.example.test refused the connection",
      },
      {
        id: alertIds[1] ?? "",
        monitorId: quiet.id,
        state: "resolved",
        summary: "0 events in 10m (fewer than 1)",
        firedAt: now - 2000,
        resolvedAt: now - 500,
      },
      {
        id: alertIds[2] ?? "",
        monitorId: errors.id,
        state: "fired",
        summary: "9 events in 5m (more than 5)",
        firedAt: now - 3000,
      },
      {
        id: alertIds[3] ?? "",
        monitorId: quiet.id,
        state: "fired",
        summary: "0 events in 10m (fewer than 1)",
        firedAt: now - 4000,
      },
      {
        id: uuidv7(),
        monitorId: beta.id,
        state: "fired",
        summary: "beta only",
        firedAt: now - 1000,
      },
    ]);

    const ops = await seedNotificationChannel(storage, {
      name: "ops webhook",
      url: "https://example.test/hooks/paging-ops",
    });

    const pager = await seedNotificationChannel(storage, {
      name: "pager bridge",
      url: "https://example.test/hooks/paging-pager",
    });

    const subjects = ["delivery 3", "delivery 2", "delivery 1"];

    // Recorded oldest first; the log lists newest first.
    for (const [index, subject] of ["delivery 1", "delivery 2", "delivery 3"].entries()) {
      await recordDelivery(storage, {
        channelId: index === 1 ? pager.id : ops.id,
        scope: "monitor",
        event: "monitor.fired",
        subject,
        status: index === 0 ? "failed" : "sent",
        error: index === 0 ? "secret-host.internal timed out" : null,
      });
      await new Promise((resolve) => setTimeout(resolve, 3));
    }

    context = { session, alertIds, subjects };
  } catch (err) {
    await session.close();
    throw err;
  }
});

afterAll(async () => {
  await context?.session.close();
  context = null;
});

describe("alert paging", () => {
  it("pages newest first and reports the total across pages", async () => {
    const { alertIds } = ctx();

    expect(await alertsPage({ limit: 2, offset: 0 })).toEqual({
      ids: alertIds.slice(0, 2),
      total: 4,
    });
    expect(await alertsPage({ limit: 2, offset: 2 })).toEqual({
      ids: alertIds.slice(2, 4),
      total: 4,
    });
    expect(await alertsPage({ limit: 2, offset: 10 })).toEqual({ ids: [], total: 4 });
  });

  it("searches monitor names, summaries, and state within the project", async () => {
    const { alertIds } = ctx();

    expect(await alertsPage({ q: "CHECKOUT" })).toEqual({
      ids: [alertIds[0], alertIds[2]],
      total: 2,
    });
    expect(await alertsPage({ q: "quiet fired" })).toEqual({ ids: [alertIds[3]], total: 1 });
    expect((await alertsPage({ q: "beta" })).total).toBe(0);
  });

  it("never matches delivery errors, and treats LIKE wildcards literally", async () => {
    expect((await alertsPage({ q: "refused" })).total).toBe(0);
    expect((await alertsPage({ q: "_" })).total).toBe(0);
    expect((await alertsPage({ q: "%" })).total).toBe(0);
  });
});

describe("delivery log paging", () => {
  it("pages newest first and reports the total", async () => {
    const { subjects } = ctx();

    expect(await deliveriesPage({ limit: 2, offset: 0 })).toEqual({
      ids: subjects.slice(0, 2),
      total: 3,
    });
    expect(await deliveriesPage({ limit: 2, offset: 2 })).toEqual({
      ids: subjects.slice(2),
      total: 3,
    });
  });

  it("searches channel names and status but not delivery errors", async () => {
    expect(await deliveriesPage({ q: "pager" })).toEqual({ ids: ["delivery 2"], total: 1 });
    expect(await deliveriesPage({ q: "failed" })).toEqual({ ids: ["delivery 1"], total: 1 });
    expect((await deliveriesPage({ q: "secret-host" })).total).toBe(0);
  });

  it("stays admin-only", async () => {
    const response = await request(
      ctx().session.harness.app,
      "/v1/notifications/deliveries?limit=5",
      { cookies: ctx().session.memberJar },
    );

    expect(response.status).toBe(403);
  });
});

async function getJson(path: string): Promise<JsonObject> {
  const response = await request(ctx().session.harness.app, path, {
    cookies: ctx().session.adminJar,
  });

  expect(response.status).toBe(200);

  return jsonBody(response);
}

describe("list endpoint paging", () => {
  it("searches monitors by the UI's words and adds each one's newest alert", async () => {
    const alpha = ctx().session.data.projects.alpha.id;
    const body = await getJson(`/v1/monitors?project=${alpha}&q=checkout&limit=20`);
    const monitors = arrayAt(body.monitors, "monitors").map((m) => objectAt(m, "monitor"));

    expect(numberAt(body.total, "total")).toBe(1);
    expect(monitors[0]?.name).toBe("checkout errors");
    expect(monitors[0]?.firing).toBe(true);

    // The quiet monitor's newest alert resolved, so it is not firing even
    // though an older alert is still open.
    const quiet = await getJson(`/v1/monitors?project=${alpha}&q=quiet`);
    const quietMonitor = objectAt(arrayAt(quiet.monitors, "monitors")[0], "monitor");

    expect(quietMonitor.firing).toBe(false);
    expect(numberAt(quietMonitor.lastAlertAt, "lastAlertAt")).toBeGreaterThan(0);
  });

  it("splits keys by type and pages them", async () => {
    const alpha = ctx().session.data.projects.alpha.id;
    const all = await getJson(`/v1/projects/${alpha}/keys`);
    const api = await getJson(`/v1/projects/${alpha}/keys?type=api&limit=1`);
    const apiKeys = arrayAt(api.keys, "keys").map((k) => objectAt(k, "key"));

    expect(apiKeys).toHaveLength(1);
    expect(apiKeys[0]?.keyType).toBe("api");
    expect(numberAt(api.total, "total")).toBeLessThanOrEqual(numberAt(all.total, "total"));
  });

  it("keeps returning every row when no limit is asked for", async () => {
    const body = await getJson("/v1/users");
    const users = arrayAt(body.users, "users");

    expect(users.length).toBe(numberAt(body.total, "total"));
    expect(numberAt((await getJson("/v1/users?q=zz-nobody")).total, "total")).toBe(0);
  });
});
