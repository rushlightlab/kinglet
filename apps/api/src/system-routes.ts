import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { KingletAuth } from "./auth/auth.js";
import { requirePermission } from "./auth/middleware.js";
import type { AppEnv } from "./auth/middleware.js";
import { isRole, permissionsForRole } from "./auth/roles.js";
import { formatSystemEvent, subscribeSystemEvents } from "./system-events.js";
import type { SystemStatusSnapshot } from "./system-events.js";

const HEARTBEAT_MS = 15_000;
const REVALIDATE_EVERY_TICKS = 4;
const MAX_LIFETIME_MS = 30 * 60 * 1000;
const MAX_PENDING_WRITES = 50;

const EMPTY_STATUS: SystemStatusSnapshot = {
  backup: {
    configured: false,
    enabled: false,
    running: false,
    phase: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    nextRunAt: null,
  },
  archive: {
    enabled: false,
    running: false,
    lastRunAt: null,
    lastError: null,
  },
};

async function isSystemAdmin(auth: KingletAuth, headers: Headers): Promise<boolean> {
  const session = await auth.api.getSession({
    headers,
    query: { disableCookieCache: true },
  });

  if (!session?.user) return false;
  const role = isRole(session.user.role) ? session.user.role : "viewer";

  return permissionsForRole(role).includes("users.write");
}

/**
 * Admin-only SSE feed for long-running system work. The UI keeps one
 * connection at the app root and refetches page state after terminal events.
 */
export function registerSystemEventsRoute(
  app: Hono<AppEnv>,
  deps: {
    auth: KingletAuth;
    getStatus: () => Promise<SystemStatusSnapshot>;
  },
): void {
  app.get("/v1/system/events", async (c) => {
    const denied = requirePermission(c, "users.write");

    if (denied) return denied;

    c.header("x-accel-buffering", "no");

    return streamSSE(c, async (stream) => {
      let closed = false;
      let pendingWrites = 0;
      let resolveLifetime: (() => void) | null = null;

      const finish = (): void => {
        closed = true;
        resolveLifetime?.();
      };

      const send = async (frame: string): Promise<void> => {
        if (closed) return;

        if (pendingWrites >= MAX_PENDING_WRITES) {
          finish();
          void stream.close();

          return;
        }

        pendingWrites++;

        try {
          await stream.write(frame);
        } catch {
          finish();
        } finally {
          pendingWrites--;
        }
      };

      const unsubscribe = subscribeSystemEvents((event) => {
        void send(formatSystemEvent(event));
      });

      let ticks = 0;

      const heartbeat = setInterval(() => {
        ticks++;

        if (ticks % REVALIDATE_EVERY_TICKS === 0) {
          void (async () => {
            try {
              const allowed = await isSystemAdmin(deps.auth, c.req.raw.headers);

              if (!allowed) {
                finish();
                void stream.close();
              }
            } catch {
              // A revalidation failure must close the stream, not leave an
              // admin-only feed open until its lifetime cap.
              finish();
              void stream.close();
            }
          })();
        }

        void send(": ping\n\n");
      }, HEARTBEAT_MS);

      heartbeat.unref();

      const lifetime = setTimeout(() => {
        finish();
        void stream.close();
      }, MAX_LIFETIME_MS);

      lifetime.unref();

      stream.onAbort(finish);

      try {
        let status = EMPTY_STATUS;

        try {
          status = await deps.getStatus();
        } catch {
          // Keep the stream usable; pages also fetch /v1/backups/status.
        }

        await send(formatSystemEvent({ type: "system.status", data: status, at: Date.now() }));
        await new Promise<void>((resolve) => {
          resolveLifetime = resolve;
        });
      } finally {
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
      }
    });
  });
}
