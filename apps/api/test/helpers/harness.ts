import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { createApp } from "../../src/app.js";
import type { AppEngines } from "../../src/app.js";
import type { AppEnv } from "../../src/auth/middleware.js";
import { createAuth } from "../../src/auth/auth.js";
import type { KingletAuth } from "../../src/auth/auth.js";
import { ensureBootstrapAdmin, ensureSchemaExtras } from "../../src/auth/setup.js";
import type { Config } from "../../src/env.js";
import { endMaintenance } from "../../src/restore/state.js";
import * as schema from "../../src/storage/schema.js";
import { createStorage } from "../../src/storage/index.js";
import type { Storage } from "../../src/storage/index.js";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, makeTestConfig } from "./config.js";
import { createNoopEngines } from "./engines.js";
import type { TestEngineOverrides } from "./engines.js";
import { createTempDatabase } from "./temp.js";

export interface TestAdmin {
  id: string;
  email: string;
  password: string;
}

export interface TestHarness {
  app: Hono<AppEnv>;
  storage: Storage;
  config: Config;
  auth: KingletAuth;
  admin: TestAdmin;
  close(): Promise<void>;
}

export interface TestHarnessOptions {
  config?: Partial<Config>;
  engines?: TestEngineOverrides;
  /** Test seam for archive cleanup; receives the harness config. */
  deleteArchivedObjects?: (config: Config, projectId: string) => Promise<number>;
}

/**
 * A complete app against a real temporary SQLite database and real Better
 * Auth. Storage, auth, bootstrap, middleware, and routes are production code;
 * only the background engines are no-ops.
 */
export async function createTestHarness(options: TestHarnessOptions = {}): Promise<TestHarness> {
  const temp = createTempDatabase();

  const config = makeTestConfig({
    ...options.config,
    dbPath: temp.dbPath,
    dataDir: temp.directory,
    storageKind: "sqlite",
    adminEmail: options.config?.adminEmail ?? TEST_ADMIN_EMAIL,
    adminPassword: options.config?.adminPassword ?? TEST_ADMIN_PASSWORD,
  });

  let storage: Storage | null = null;
  let engines: AppEngines | null = null;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    try {
      stopEngines(engines);
    } finally {
      // Maintenance is process-global. A restore test that leaves it on would
      // turn every later mutation in this worker into a 503.
      endMaintenance();

      try {
        await storage?.close();
      } finally {
        await temp.cleanup();
      }
    }
  };

  try {
    storage = await createStorage({ kind: "sqlite", dbPath: config.dbPath });

    await ensureSchemaExtras(storage, config.timezone);

    const auth = createAuth(storage.db, {
      baseUrl: config.baseUrl,
      port: config.port,
      secret: config.authSecret,
      trustedProxies: config.trustedProxies,
      sessionDays: config.sessionDays,
    });

    await ensureBootstrapAdmin(storage, config, auth);

    const adminEmail = (config.adminEmail ?? TEST_ADMIN_EMAIL).toLowerCase();

    const rows = await storage.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, adminEmail))
      .limit(1);

    const adminId = rows[0]?.id;

    if (adminId === undefined) throw new Error("test harness: bootstrap administrator missing");

    engines = createNoopEngines(options.engines);

    const app = createApp({
      storage,
      config,
      auth,
      engines,
      staticUi: false,
      deleteArchivedObjects: options.deleteArchivedObjects,
    });

    return {
      app,
      storage,
      config,
      auth,
      admin: {
        id: adminId,
        email: adminEmail,
        password: config.adminPassword ?? TEST_ADMIN_PASSWORD,
      },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

function stopEngines(engines: AppEngines | null): void {
  if (engines === null) return;

  engines.monitor.stop();
  engines.notification.stop();
  engines.backup.stop();
  engines.archive.stop();
}
