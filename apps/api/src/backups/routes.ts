import type { Context } from "hono";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isUuid } from "../auth/ids.js";
import { can, getAuth, requirePermission, requireUser } from "../auth/middleware.js";
import type { AppEnv } from "../auth/middleware.js";
import type { Config } from "../env.js";
import { isBoolean, isFiniteNumber, isJsonObject, isString } from "../json.js";
import type { JsonObject } from "../json.js";
import type { Storage } from "../storage/index.js";
import type { BackupEngine } from "./engine.js";
import { describeBackupError } from "./s3.js";
import { BackupError } from "./types.js";
import type { BackupSnapshot } from "./types.js";

/**
 * Admin-only snapshot routes. All responses are DTOs: credentials and bucket
 * object keys never leave the engine, and failures are sanitized.
 */

interface SettingsInput {
  enabled?: boolean;
  scheduleCron?: string;
  scheduleTimezone?: string;
  retentionCount?: number;
}

interface BackupListResponse {
  snapshots: BackupSnapshot[];
  warning?: string;
}

type ParsedBody = { ok: true; body: JsonObject } | { ok: false; error: string };

type ParsedSettings = { ok: true; input: SettingsInput } | { ok: false; error: string };

export function registerBackupRoutes(
  app: Hono<AppEnv>,
  deps: { storage: Storage; config: Config; engine: BackupEngine },
): void {
  const engine = deps.engine;

  void deps.storage;
  void deps.config;

  app.use(
    "/v1/backups/*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: "payload too large (max 256 KiB)" }, 413),
    }),
  );

  // ================= status =================

  app.get("/v1/backups/status", async (c) => {
    const denied = requirePermission(c, "backups.read");

    if (denied) return denied;

    try {
      const status = await engine.status();

      return c.json({ status });
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  // ================= list =================

  app.get("/v1/backups", async (c) => {
    const denied = requirePermission(c, "backups.read");

    if (denied) return denied;

    const refresh = c.req.query("refresh");
    let refreshWarning: string | undefined;

    if (refresh === "1" || refresh === "true") {
      // A refresh lists the bucket and may delete orphaned objects; keep that
      // side effect behind the write permission.
      const deniedWrite = requirePermission(c, "backups.write");

      if (deniedWrite) return deniedWrite;

      try {
        await engine.refresh();
      } catch (cause) {
        refreshWarning = cause instanceof BackupError ? cause.message : describeBackupError(cause);
      }
    }

    const snapshots = await engine.list();
    const status = await engine.status();
    const warning = refreshWarning ?? status.lastRefreshError ?? status.problem ?? undefined;
    const payload: BackupListResponse = { snapshots };

    if (warning !== undefined && warning !== "") payload.warning = warning;

    return c.json(payload);
  });

  // ================= manual run =================

  app.post("/v1/backups/run", async (c) => {
    const denied = requirePermission(c, "backups.write");

    if (denied) return denied;

    try {
      const result = await engine.run("manual");

      return c.json({ runId: result.runId }, 202);
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  // ================= settings =================

  app.get("/v1/backups/settings", async (c) => {
    const denied = requirePermission(c, "backups.read");

    if (denied) return denied;

    try {
      const settings = await engine.getSettings();

      return c.json({ settings });
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  app.put("/v1/backups/settings", async (c) => {
    const denied = requirePermission(c, "backups.write");

    if (denied) return denied;

    const parsedBody = await readJsonBody(c);

    if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
    const parsedSettings = parseSettingsInput(parsedBody.body);

    if (!parsedSettings.ok) return c.json({ error: parsedSettings.error }, 400);

    try {
      const settings = await engine.updateSettings(parsedSettings.input);

      const validation = engine.preview({
        cron: settings.scheduleCron,
        timezone: settings.scheduleTimezone,
      });

      return c.json({
        settings,
        nextRuns: validation.ok ? validation.nextRuns : [],
      });
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  // ================= schedule preview =================

  app.get("/v1/backups/schedule/preview", async (c) => {
    const denied = requirePermission(c, "backups.read");

    if (denied) return denied;

    try {
      const settings = await engine.getSettings();
      const cron = c.req.query("cron") ?? settings.scheduleCron;
      const timezone = c.req.query("timezone") ?? settings.scheduleTimezone;
      const result = engine.preview({ cron, timezone });

      if (result.ok) {
        return c.json({
          valid: true,
          description: result.description,
          nextRuns: result.nextRuns,
        });
      }

      return c.json({ valid: false, error: result.error });
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  // ================= S3 connection test =================

  app.post("/v1/backups/test-connection", async (c) => {
    const denied = requirePermission(c, "backups.write");

    if (denied) return denied;

    try {
      await engine.testConnection();

      return c.json({ ok: true });
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  // ================= download and delete =================

  app.get("/v1/backups/:id/download", async (c) => {
    const denied = requirePermission(c, "backups.read");

    if (denied) return denied;
    const user = requireUser(c);

    if (user instanceof Response) return user;

    const id = c.req.param("id");

    if (!isUuid(id)) return c.json({ error: "invalid snapshot id" }, 400);

    try {
      const download = await engine.download(id, user.id);

      return c.json(download);
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  app.delete("/v1/backups/:id", async (c) => {
    const denied = requirePermission(c, "backups.write");

    if (denied) return denied;

    const id = c.req.param("id");

    if (!isUuid(id)) return c.json({ error: "invalid snapshot id" }, 400);

    const force = c.req.query("force") === "1";

    if (force) {
      const authInfo = getAuth(c);

      if (!(authInfo.kind === "user" && can(authInfo, "backups.restore"))) {
        return c.json({ error: "force delete requires the restore permission" }, 403);
      }
    }

    try {
      const snapshots = await engine.list();
      const target = snapshots.find((snapshot) => snapshot.id.toLowerCase() === id.toLowerCase());
      const ready = snapshots.filter((snapshot) => snapshot.state === "ready");

      if (target?.state === "ready" && ready.length <= 1 && !force) {
        return c.json(
          {
            error:
              "refusing to delete the last ready snapshot; pass force=1 with the restore permission to confirm",
          },
          409,
        );
      }

      await engine.remove(id);

      return c.json({ ok: true });
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

function parseSettingsInput(body: JsonObject): ParsedSettings {
  const input: SettingsInput = {};
  const enabled = body.enabled;
  const scheduleCron = body.scheduleCron;
  const scheduleTimezone = body.scheduleTimezone;
  const retentionCount = body.retentionCount;

  if (enabled !== undefined) {
    if (!isBoolean(enabled)) return { ok: false, error: "enabled must be a boolean" };

    input.enabled = enabled;
  }

  if (scheduleCron !== undefined) {
    if (!isString(scheduleCron)) {
      return { ok: false, error: "scheduleCron must be a string" };
    }

    input.scheduleCron = scheduleCron;
  }

  if (scheduleTimezone !== undefined) {
    if (!isString(scheduleTimezone)) {
      return { ok: false, error: "scheduleTimezone must be a string" };
    }

    input.scheduleTimezone = scheduleTimezone;
  }

  if (retentionCount !== undefined) {
    if (!isFiniteNumber(retentionCount) || !Number.isInteger(retentionCount)) {
      return { ok: false, error: "retentionCount must be an integer" };
    }

    input.retentionCount = retentionCount;
  }

  return { ok: true, input };
}

function errorResponse(c: Context<AppEnv>, cause: unknown): Response {
  if (cause instanceof BackupError) return c.json({ error: cause.message }, cause.status);

  const message = describeBackupError(cause);

  console.warn("[kinglet] backup route failed:", message);

  return c.json({ error: "backup operation failed" }, 500);
}
