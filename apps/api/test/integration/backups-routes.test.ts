import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/ids.js";
import type { AuthInfo, AppEnv } from "../../src/auth/middleware.js";
import type { Permission } from "../../src/auth/roles.js";
import type { BackupEngine } from "../../src/backups/engine.js";
import { registerBackupRoutes } from "../../src/backups/routes.js";
import type { BackupSnapshot } from "../../src/backups/types.js";
import { errorOf, jsonBody } from "../helpers/body.js";
import { createNoopBackupEngine } from "../helpers/engines.js";
import { request } from "../helpers/request.js";
import { createTestSession } from "../helpers/session.js";
import type { TestSession } from "../helpers/session.js";

interface RouteContext {
  session: TestSession;
  snapshot: BackupSnapshot;
  removed: string[];
  refreshCalls: string[];
}

let context: RouteContext | null = null;

function ctx(): RouteContext {
  if (context === null) throw new Error("backups routes suite: test context missing");

  return context;
}

function readySnapshot(id: string): BackupSnapshot {
  return {
    id,
    runId: null,
    trigger: "manual",
    createdAt: 1_750_000_000_000,
    sizeBytes: 1024,
    sha256: "a".repeat(64),
    encryption: "none",
    appVersion: "0.3.0-test",
    schemaVersion: 1,
    counts: { projects: 0, users: 0, events: 0, monitors: 0 },
    state: "ready",
    downloadedAt: null,
    downloadedBy: null,
    discovered: false,
  };
}

/**
 * Registers the production backup routes behind a fixed auth principal so a
 * permission set with `backups.read` but no `backups.write` can be exercised;
 * the built-in roles never have that combination.
 */
function routeApp(permissions: readonly Permission[], engine: BackupEngine): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const auth: AuthInfo = {
    kind: "user",
    user: {
      id: uuidv7(),
      email: "backup-route-test@example.test",
      name: "Backup Route Test",
      role: "member",
      createdAt: 0,
      updatedAt: 0,
    },
    permissions: new Set(permissions),
  };

  app.use("/v1/*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  registerBackupRoutes(app, {
    storage: ctx().session.harness.storage,
    config: ctx().session.harness.config,
    engine,
  });

  return app;
}

beforeAll(async () => {
  const snapshot = readySnapshot(uuidv7());
  const removed: string[] = [];
  const refreshCalls: string[] = [];

  const session = await createTestSession({
    engines: {
      backup: {
        list: async () => [snapshot],
        remove: async (id) => {
          removed.push(id);
        },
        refresh: async () => {
          refreshCalls.push("refresh");
        },
      },
    },
  });

  context = { session, snapshot, removed, refreshCalls };
});

afterAll(async () => {
  await context?.session.close();
  context = null;
});

describe("backup routes", () => {
  it("rejects an oversized settings body with 413", async () => {
    const { session } = ctx();

    const response = await request(session.harness.app, "/v1/backups/settings", {
      method: "PUT",
      cookies: session.adminJar,
      body: "x".repeat(300 * 1024),
    });

    expect(response.status).toBe(413);
    expect(errorOf(await jsonBody(response))).toContain("payload too large");
  });

  it("requires backups.write to refresh the bucket listing", async () => {
    const calls: string[] = [];

    const engine = createNoopBackupEngine({
      refresh: async () => {
        calls.push("refresh");
      },
    });

    const readOnly = routeApp(["backups.read"], engine);
    const list = await request(readOnly, "/v1/backups");

    expect(list.status).toBe(200);
    expect(calls).toHaveLength(0);

    const denied = await request(readOnly, "/v1/backups?refresh=1");

    expect(denied.status).toBe(403);
    expect(errorOf(await jsonBody(denied))).toBe("forbidden");
    expect(calls).toHaveLength(0);

    const writable = routeApp(["backups.read", "backups.write"], engine);
    const allowed = await request(writable, "/v1/backups?refresh=1");

    expect(allowed.status).toBe(200);
    expect(calls).toEqual(["refresh"]);
  });

  it("refreshes for an admin through the full app", async () => {
    const { session, refreshCalls } = ctx();
    const before = refreshCalls.length;

    const response = await request(session.harness.app, "/v1/backups?refresh=1", {
      cookies: session.adminJar,
    });

    expect(response.status).toBe(200);
    expect(refreshCalls).toHaveLength(before + 1);
  });

  it("guards the last ready snapshot and requires backups.restore to force a delete", async () => {
    const { snapshot } = ctx();
    const guardRemoved: string[] = [];

    const engine = createNoopBackupEngine({
      list: async () => [snapshot],
      remove: async (id) => {
        guardRemoved.push(id);
      },
    });

    const app = routeApp(["backups.read", "backups.write"], engine);
    const guarded = await request(app, `/v1/backups/${snapshot.id}`, { method: "DELETE" });

    expect(guarded.status).toBe(409);
    expect(errorOf(await jsonBody(guarded))).toContain("last ready snapshot");
    expect(guardRemoved).toHaveLength(0);

    const forced = await request(app, `/v1/backups/${snapshot.id}?force=1`, {
      method: "DELETE",
    });

    expect(forced.status).toBe(403);
    expect(errorOf(await jsonBody(forced))).toBe("force delete requires the restore permission");
    expect(guardRemoved).toHaveLength(0);
  });

  it("allows an admin with backups.restore to force-delete the last snapshot", async () => {
    const { session, snapshot, removed } = ctx();
    const before = removed.length;

    const response = await request(session.harness.app, `/v1/backups/${snapshot.id}?force=1`, {
      method: "DELETE",
      cookies: session.adminJar,
    });

    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ ok: true });
    expect(removed.slice(before)).toEqual([snapshot.id]);
  });

  it("denies backup routes to a member", async () => {
    const { session, snapshot } = ctx();

    const response = await request(session.harness.app, `/v1/backups/${snapshot.id}`, {
      method: "DELETE",
      cookies: session.memberJar,
    });

    expect(response.status).toBe(403);
  });
});
