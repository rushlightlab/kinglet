import type { Context } from "hono";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isUuid } from "../auth/ids.js";
import { requirePermission } from "../auth/middleware.js";
import type { AppEnv } from "../auth/middleware.js";
import { describeBackupError } from "../backups/s3.js";
import type { Config } from "../env.js";
import { isBoolean, isFiniteNumber, isJsonObject, isString } from "../json.js";
import type { JsonObject } from "../json.js";
import type { Storage } from "../storage/index.js";
import type { ArchiveEngine } from "./engine.js";
import { ArchiveError } from "./types.js";
import type { ArchiveProjectToggle, ArchiveSettingsUpdate } from "./types.js";

/**
 * Admin-only archive routes. Responses are DTOs: bucket object keys,
 * credentials, and signed URLs never leave the engine, and failures are
 * sanitized before they reach a client.
 */

type ParsedBody = { ok: true; body: JsonObject } | { ok: false; error: string };

type ParsedOptionalBody = { ok: true; body: JsonObject | null } | { ok: false; error: string };

type ParsedSettings = { ok: true; update: ArchiveSettingsUpdate } | { ok: false; error: string };

const SMALL_JSON_LIMIT = 256 * 1024;

export function registerArchiveRoutes(
  app: Hono<AppEnv>,
  deps: { storage: Storage; config: Config; engine: ArchiveEngine },
): void {
  void deps.storage;
  void deps.config;

  const engine = deps.engine;

  app.use(
    "/v1/archive/*",
    bodyLimit({
      maxSize: SMALL_JSON_LIMIT,
      onError: (c) => c.json({ error: "payload too large (max 256 KiB)" }, 413),
    }),
  );

  // ================= settings =================

  app.get("/v1/archive/settings", async (c) => {
    const denied = requirePermission(c, "backups.read");

    if (denied) return denied;

    try {
      return c.json({ settings: await engine.getSettings() });
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  app.put("/v1/archive/settings", async (c) => {
    const denied = requirePermission(c, "backups.write");

    if (denied) return denied;

    const parsedBody = await readJsonBody(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);

    const parsedSettings = parseSettingsInput(parsedBody.body);

    if (!parsedSettings.ok) return c.json({ error: parsedSettings.error }, 400);

    try {
      const settings = await engine.updateSettings(parsedSettings.update);

      return c.json({ settings });
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  // ================= per-project toggle =================

  app.put("/v1/projects/:id/archive", async (c) => {
    const denied = requirePermission(c, "backups.write");

    if (denied) return denied;

    const id = c.req.param("id");

    if (!isUuid(id)) return c.json({ error: "invalid project id" }, 400);

    const parsedBody = await readJsonBody(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);

    const enabled = parsedBody.body.enabled;

    if (!isBoolean(enabled)) return c.json({ error: "enabled must be a boolean" }, 400);

    try {
      const setting = await engine.setProjectEnabled(id, enabled);

      return c.json({ ok: true, enabled: setting.enabled });
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  // ================= manual run =================

  app.post("/v1/archive/run", async (c) => {
    const denied = requirePermission(c, "backups.write");

    if (denied) return denied;

    const parsedBody = await readOptionalJsonBody(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);

    let projectId: string | undefined;
    const rawProjectId = parsedBody.body?.projectId;

    if (rawProjectId !== undefined) {
      if (!isString(rawProjectId) || !isUuid(rawProjectId)) {
        return c.json({ error: "projectId must be a project id" }, 400);
      }

      projectId = rawProjectId.toLowerCase();
    }

    try {
      const handle = await engine.run(projectId);

      return c.json({ runId: handle.runId }, 202);
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  // ================= parts =================

  app.get("/v1/archive/parts", async (c) => {
    const denied = requirePermission(c, "backups.read");

    if (denied) return denied;

    const projectId = c.req.query("project");

    if (projectId !== undefined && !isUuid(projectId)) {
      return c.json({ error: "invalid project id" }, 400);
    }

    const from = c.req.query("from");
    const to = c.req.query("to");
    const rawLimit = c.req.query("limit");
    let limit: number | undefined;

    if (rawLimit !== undefined) {
      const parsedLimit = Number.parseInt(rawLimit, 10);

      if (!isFiniteNumber(parsedLimit) || parsedLimit < 1) {
        return c.json({ error: "limit must be a positive integer" }, 400);
      }

      limit = parsedLimit;
    }

    try {
      const parts = await engine.listParts({ projectId, from, to, limit });

      return c.json({ parts });
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  // ================= import =================

  app.post("/v1/archive/import", async (c) => {
    const denied = requirePermission(c, "backups.restore");

    if (denied) return denied;

    const parsedBody = await readJsonBody(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);

    const body = parsedBody.body;
    const projectId = body.projectId;

    if (!isString(projectId) || !isUuid(projectId)) {
      return c.json({ error: "projectId must be a project id" }, 400);
    }

    const from = body.from;
    const to = body.to;

    if (from !== undefined && !isString(from)) {
      return c.json({ error: "from must be a YYYY-MM-DD date" }, 400);
    }

    if (to !== undefined && !isString(to)) {
      return c.json({ error: "to must be a YYYY-MM-DD date" }, 400);
    }

    try {
      const result = await engine.importEvents({
        projectId: projectId.toLowerCase(),
        from,
        to,
      });

      return c.json({ imported: result.imported, skipped: result.skipped });
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });
}

async function readJsonBody(c: Context<AppEnv>): Promise<ParsedBody> {
  let body: unknown;

  try {
    body = await c.req.json();
  } catch {
    return { ok: false, error: "invalid JSON body" };
  }

  if (!isJsonObject(body)) return { ok: false, error: "invalid JSON body" };

  return { ok: true, body };
}

async function readOptionalJsonBody(c: Context<AppEnv>): Promise<ParsedOptionalBody> {
  let text: string;

  try {
    text = await c.req.text();
  } catch {
    return { ok: false, error: "invalid JSON body" };
  }

  if (text.trim() === "") return { ok: true, body: null };

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid JSON body" };
  }

  if (!isJsonObject(parsed)) return { ok: false, error: "invalid JSON body" };

  return { ok: true, body: parsed };
}

function parseSettingsInput(body: JsonObject): ParsedSettings {
  const update: ArchiveSettingsUpdate = {};
  const enabled = body.enabled;
  const scheduleCron = body.scheduleCron;
  const scheduleTimezone = body.scheduleTimezone;
  const deleteOnFailure = body.deleteOnFailure;
  const projects = body.projects;

  if (enabled !== undefined) {
    if (!isBoolean(enabled)) return { ok: false, error: "enabled must be a boolean" };

    update.enabled = enabled;
  }

  if (scheduleCron !== undefined) {
    if (!isString(scheduleCron)) return { ok: false, error: "scheduleCron must be a string" };

    update.scheduleCron = scheduleCron;
  }

  if (scheduleTimezone !== undefined) {
    if (!isString(scheduleTimezone)) {
      return { ok: false, error: "scheduleTimezone must be a string" };
    }

    update.scheduleTimezone = scheduleTimezone;
  }

  if (deleteOnFailure !== undefined) {
    if (!isBoolean(deleteOnFailure)) {
      return { ok: false, error: "deleteOnFailure must be a boolean" };
    }

    update.deleteOnFailure = deleteOnFailure;
  }

  if (projects !== undefined) {
    if (!Array.isArray(projects)) {
      return { ok: false, error: "projects must be an array" };
    }

    const toggles: ArchiveProjectToggle[] = [];

    for (const entry of projects) {
      if (!isJsonObject(entry)) {
        return { ok: false, error: "projects entries must be objects" };
      }

      const projectId = entry.projectId;
      const projectEnabled = entry.enabled;

      if (!isString(projectId) || !isUuid(projectId)) {
        return { ok: false, error: "projects entries need a project id" };
      }

      if (!isBoolean(projectEnabled)) {
        return { ok: false, error: "projects entries need an enabled boolean" };
      }

      toggles.push({ projectId: projectId.toLowerCase(), enabled: projectEnabled });
    }

    update.projects = toggles;
  }

  return { ok: true, update };
}

function errorResponse(c: Context<AppEnv>, cause: unknown): Response {
  if (cause instanceof ArchiveError) return c.json({ error: cause.message }, cause.status);

  const message = describeBackupError(cause);

  console.warn("[kinglet] archive route failed:", message);

  return c.json({ error: "archive operation failed" }, 500);
}
