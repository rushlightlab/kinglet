import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMonitorFromRaw,
  getMonitor,
  resolveMonitorNotifyTargets,
} from "../../src/monitors.ts";
import { migrateLegacyMonitorChannels } from "../../src/notifications/migrate.ts";
import { readChannelTarget } from "../../src/notifications/store.ts";
import * as schema from "../../src/storage/schema.ts";
import { createTestHarness } from "../helpers/harness.ts";
import type { TestHarness } from "../helpers/harness.ts";
import { seedProject } from "../helpers/seed.ts";
import type { SeededProject } from "../helpers/seed.ts";

const EXPECTED_DEFAULT_ACTIONS = [
  "backup.failed",
  "backup.restore_staged",
  "archive.failed",
  "system.warning",
];

interface MigrationContext {
  harness: TestHarness;
  project: SeededProject;
}

let context: MigrationContext | null = null;

function ctx(): MigrationContext {
  if (context === null) throw new Error("notification migration suite: test context missing");

  return context;
}

async function createLegacyMonitor(
  projectId: string,
  name: string,
  url: string,
  enabled: boolean,
): Promise<string> {
  const result = await createMonitorFromRaw(
    ctx().harness.storage,
    projectId,
    {
      name,
      query: "level>=error",
      kind: "match",
      enabled,
      channels: [{ type: "webhook", url }],
    },
    { allowPrivateWebhooks: false },
  );

  if (!result.ok) throw new Error(`notification migration suite: ${result.error}`);

  return result.monitor.id;
}

/** Channels whose decrypted target is `url` (targets are stored encrypted). */
async function channelRows(url: string) {
  const rows = await ctx().harness.storage.db.select().from(schema.notificationChannels);

  return rows.filter((row) => readChannelTarget(row.id, row.url).url === url);
}

beforeAll(async () => {
  const harness = await createTestHarness();

  try {
    const project = await seedProject(harness.storage, { name: "Migration", slug: "migration" });

    context = { harness, project };
  } catch (err) {
    await harness.close();
    throw err;
  }
});

afterAll(async () => {
  await context?.harness.close();
  context = null;
});

describe("legacy monitor channel migration", () => {
  it("promotes enabled legacy channels once, skips disabled monitors, and never runs again", async () => {
    const { harness, project } = ctx();
    const enabledUrl = "https://example.test/hooks/migrate-enabled";
    const disabledUrl = "https://example.test/hooks/migrate-disabled";

    const enabledMonitorId = await createLegacyMonitor(
      project.id,
      "migrate-enabled",
      enabledUrl,
      true,
    );

    const disabledMonitorId = await createLegacyMonitor(
      project.id,
      "migrate-disabled",
      disabledUrl,
      false,
    );

    const first = await migrateLegacyMonitorChannels(harness.storage, false);

    expect(first).toEqual({ monitorsScanned: 1, channelsCreated: 1, linksCreated: 1 });

    const enabledChannels = await channelRows(enabledUrl);

    expect(enabledChannels).toHaveLength(1);

    const enabledChannel = enabledChannels[0];

    if (enabledChannel === undefined) throw new Error("migration suite: promoted channel missing");

    expect(enabledChannel.name).toBe("Webhook 1");
    expect(enabledChannel.type).toBe("webhook");
    // The promoted target is stored sealed, never as the plaintext URL.
    expect(enabledChannel.url.startsWith("enc:v1:")).toBe(true);
    expect(enabledChannel.targetHash).not.toBeNull();

    const actions = await harness.storage.db
      .select({ action: schema.notificationChannelActions.action })
      .from(schema.notificationChannelActions)
      .where(eq(schema.notificationChannelActions.channelId, enabledChannel.id));

    const actionSet = new Set(actions.map((row) => row.action));

    expect(actionSet).toEqual(new Set(EXPECTED_DEFAULT_ACTIONS));
    expect(actionSet.has("backup.succeeded")).toBe(false);

    const disabledChannels = await channelRows(disabledUrl);
    expect(disabledChannels).toHaveLength(0);

    const enabledLinks = await harness.storage.db
      .select({ channelId: schema.monitorChannels.channelId })
      .from(schema.monitorChannels)
      .where(eq(schema.monitorChannels.monitorId, enabledMonitorId));

    expect(enabledLinks).toEqual([{ channelId: enabledChannel.id }]);

    const disabledLinks = await harness.storage.db
      .select({ channelId: schema.monitorChannels.channelId })
      .from(schema.monitorChannels)
      .where(eq(schema.monitorChannels.monitorId, disabledMonitorId));

    expect(disabledLinks).toHaveLength(0);

    const marker = await harness.storage.db
      .select({ value: schema.appMeta.value })
      .from(schema.appMeta)
      .where(eq(schema.appMeta.key, "notification_legacy_migrated_at"));

    expect(marker).toHaveLength(1);
    expect(Number(marker[0]?.value)).toBeGreaterThan(0);

    const second = await migrateLegacyMonitorChannels(harness.storage, false);

    expect(second).toEqual({ monitorsScanned: 0, channelsCreated: 0, linksCreated: 0 });

    // A legacy URL added after the marker must not be promoted by a later run.
    const lateUrl = "https://example.test/hooks/migrate-late";
    await createLegacyMonitor(project.id, "migrate-late", lateUrl, true);

    const third = await migrateLegacyMonitorChannels(harness.storage, false);

    expect(third).toEqual({ monitorsScanned: 0, channelsCreated: 0, linksCreated: 0 });
    expect(await channelRows(lateUrl)).toHaveLength(0);
  });
});

describe("legacy fallback after migration", () => {
  it("never delivers to a managed channel's destination through the legacy copy", async () => {
    // A fresh database: the migration runs once per database.
    const harness = await createTestHarness();

    try {
      const project = await seedProject(harness.storage, { name: "Fallback" });
      const migratedUrl = "https://example.test/hooks/fallback-migrated";

      const created = await createMonitorFromRaw(
        harness.storage,
        project.id,
        {
          name: "fallback-monitor",
          query: "level>=error",
          kind: "match",
          channels: [{ type: "webhook", url: migratedUrl }],
        },
        { allowPrivateWebhooks: false },
      );

      if (!created.ok) throw new Error(`fallback suite: ${created.error}`);

      await migrateLegacyMonitorChannels(harness.storage, false);

      // An admin disables the migrated channel, then a monitor writer unlinks it.
      await harness.storage.db
        .update(schema.notificationChannels)
        .set({ enabled: false })
        .where(eq(schema.notificationChannels.type, "webhook"));
      await harness.storage.db
        .delete(schema.monitorChannels)
        .where(eq(schema.monitorChannels.monitorId, created.monitor.id));

      const monitor = await getMonitor(harness.storage, created.monitor.id);

      if (monitor === null) throw new Error("fallback suite: monitor missing");

      // The legacy copy is still on the monitor, but it is never a target.
      expect(monitor.channels.map((channel) => channel.url)).toEqual([migratedUrl]);
      expect(await resolveMonitorNotifyTargets(harness.storage, monitor)).toEqual([]);

      // A legacy destination that is not a managed channel still delivers.
      const lateUrl = "https://example.test/hooks/fallback-late";

      const late = await createMonitorFromRaw(
        harness.storage,
        project.id,
        {
          name: "fallback-late",
          query: "level>=error",
          kind: "match",
          channels: [{ type: "webhook", url: lateUrl }],
        },
        { allowPrivateWebhooks: false },
      );

      if (!late.ok) throw new Error(`fallback suite: ${late.error}`);

      const targets = await resolveMonitorNotifyTargets(harness.storage, late.monitor);

      expect(targets.map((target) => target.url)).toEqual([lateUrl]);
    } finally {
      await harness.close();
    }
  });
});
