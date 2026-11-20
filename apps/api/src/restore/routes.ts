import type { Context } from "hono";
import type { Hono } from "hono";
import { isUuid } from "../auth/ids.js";
import { requirePermission, requireUser } from "../auth/middleware.js";
import type { AppEnv } from "../auth/middleware.js";
import { describeBackupError } from "../backups/s3.js";
import type { BackupObjectStore } from "../backups/s3.js";
import { BackupError } from "../backups/types.js";
import type { Config } from "../env.js";
import type { Storage } from "../storage/index.js";
import { publishSystemEvent } from "../system-events.js";
import { stageRestore } from "./stage.js";

/**
 * Restore staging route. The handler returns 202 after the snapshot is staged;
 * it never exits the process. `onStaged` is scheduled for the next tick so the
 * response can flush, and the main server decides how to restart.
 */
export function registerRestoreRoutes(
  app: Hono<AppEnv>,
  deps: {
    storage: Storage;
    config: Config;
    onStaged?: () => void;
    /** Test/embedding override; production omits it and staging owns the store. */
    restoreStore?: BackupObjectStore;
  },
): void {
  app.post("/v1/backups/:id/restore", async (c) => {
    const denied = requirePermission(c, "backups.restore");

    if (denied) return denied;
    const user = requireUser(c);

    if (user instanceof Response) return user;

    const id = c.req.param("id");

    if (!isUuid(id)) return c.json({ error: "invalid snapshot id" }, 400);

    try {
      const result = await stageRestore({
        config: deps.config,
        snapshotId: id,
        userId: user.id,
        store: deps.restoreStore,
      });

      try {
        publishSystemEvent({ type: "restore.staged", data: { id: result.snapshotId } });
      } catch {
        // SSE is best-effort; the staged restore is already durable on disk.
      }

      if (deps.onStaged) {
        setImmediate(() => {
          try {
            deps.onStaged?.();
          } catch (cause) {
            console.warn("[kinglet] restore onStaged callback failed:", describeBackupError(cause));
          }
        });
      }

      return c.json(
        {
          ok: true,
          staged: true,
          restartRequired: result.restartRequired,
          snapshotId: result.snapshotId,
        },
        202,
      );
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });
}

function errorResponse(c: Context<AppEnv>, cause: unknown): Response {
  if (cause instanceof BackupError) return c.json({ error: cause.message }, cause.status);

  const message = describeBackupError(cause);

  console.warn("[kinglet] restore route failed:", message);

  return c.json({ error: "restore could not be staged" }, 500);
}
