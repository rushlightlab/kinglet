import { asc, eq } from "drizzle-orm";
import { isUuid } from "../auth/ids.ts";
import { describeCron, isValidTimezone, validateCron } from "../schedule.ts";
import type { Storage } from "../storage/index.ts";
import * as schema from "../storage/schema.ts";
import { ArchiveError } from "./types.ts";
import type {
  ArchiveProjectSetting,
  ArchiveProjectToggle,
  ArchiveSettings,
  ArchiveSettingsUpdate,
} from "./types.ts";

/**
 * Archive settings live in one singleton row (`archive_settings.id = 1`) plus
 * one `project_archive_settings` row per project that has an explicit toggle.
 * Missing project rows mean "off", so upgrading never archives anything.
 */

export async function ensureArchiveSettings(
  storage: Storage,
  timezone?: string,
): Promise<ArchiveSettings> {
  const existing = await readSettingsRow(storage);

  if (existing !== null) {
    return rowToSettings(existing, await listProjectSettings(storage));
  }

  const scheduleTimezone = timezone !== undefined && isValidTimezone(timezone) ? timezone : "UTC";

  await storage.db
    .insert(schema.archiveSettings)
    .values({ id: 1, scheduleTimezone, updatedAt: Date.now() })
    .onConflictDoNothing();

  const created = await readSettingsRow(storage);

  if (created === null) throw new ArchiveError("archive settings are unavailable", 500);

  return rowToSettings(created, await listProjectSettings(storage));
}

export async function getArchiveSettings(storage: Storage): Promise<ArchiveSettings> {
  const row = await readSettingsRow(storage);

  if (row === null) {
    // Boot normally seeds the row; recover an empty table from a manual edit.
    return ensureArchiveSettings(storage);
  }

  const projects = await listProjectSettings(storage);

  return rowToSettings(row, projects);
}

export async function updateArchiveSettings(
  storage: Storage,
  input: ArchiveSettingsUpdate,
): Promise<ArchiveSettings> {
  const current = await getArchiveSettings(storage);
  let cron = current.scheduleCron;
  let timezone = current.scheduleTimezone;

  if (input.scheduleCron !== undefined || input.scheduleTimezone !== undefined) {
    const validation = validateCron(
      input.scheduleCron ?? current.scheduleCron,
      input.scheduleTimezone ?? current.scheduleTimezone,
    );

    if (!validation.ok) throw new ArchiveError(validation.error, 400);

    cron = validation.cron;
    timezone = input.scheduleTimezone ?? current.scheduleTimezone;
  }

  const toggles = await validateProjectToggles(storage, input.projects);

  await storage.db.transaction(async (tx) => {
    await tx
      .update(schema.archiveSettings)
      .set({
        enabled: input.enabled ?? current.enabled,
        scheduleCron: cron,
        scheduleTimezone: timezone,
        deleteOnFailure: input.deleteOnFailure ?? current.deleteOnFailure,
        updatedAt: Date.now(),
      })
      .where(eq(schema.archiveSettings.id, 1));

    for (const toggle of toggles) {
      await tx
        .insert(schema.projectArchiveSettings)
        .values(toggle)
        .onConflictDoUpdate({
          target: schema.projectArchiveSettings.projectId,
          set: { enabled: toggle.enabled },
        });
    }
  });

  return getArchiveSettings(storage);
}

export async function setProjectArchiveEnabled(
  storage: Storage,
  projectId: string,
  enabled: boolean,
): Promise<ArchiveProjectSetting> {
  const id = projectId.trim().toLowerCase();

  if (!isUuid(id)) throw new ArchiveError("invalid project id", 400);

  await assertProjectExists(storage, id);

  await storage.db
    .insert(schema.projectArchiveSettings)
    .values({ projectId: id, enabled })
    .onConflictDoUpdate({
      target: schema.projectArchiveSettings.projectId,
      set: { enabled },
    });

  return { projectId: id, enabled };
}

/**
 * Projects whose events the hourly retention job must skip. Returns an empty
 * list when the global toggle is off, so retention stays authoritative until
 * an admin opts in.
 */
export async function listArchiveEnabledProjectIds(storage: Storage): Promise<readonly string[]> {
  const global = await readSettingsRow(storage);

  if (global === null || !global.enabled) return [];

  const rows = await storage.db
    .select({ projectId: schema.projectArchiveSettings.projectId })
    .from(schema.projectArchiveSettings)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectArchiveSettings.projectId))
    .where(eq(schema.projectArchiveSettings.enabled, true))
    .orderBy(asc(schema.projectArchiveSettings.projectId));

  return rows.map((row) => row.projectId);
}

async function readSettingsRow(
  storage: Storage,
): Promise<typeof schema.archiveSettings.$inferSelect | null> {
  const rows = await storage.db
    .select()
    .from(schema.archiveSettings)
    .where(eq(schema.archiveSettings.id, 1))
    .limit(1);

  return rows[0] ?? null;
}

async function listProjectSettings(storage: Storage): Promise<ArchiveProjectSetting[]> {
  const rows = await storage.db
    .select({
      projectId: schema.projectArchiveSettings.projectId,
      enabled: schema.projectArchiveSettings.enabled,
    })
    .from(schema.projectArchiveSettings)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectArchiveSettings.projectId))
    .orderBy(asc(schema.projectArchiveSettings.projectId));

  return rows.map((row) => ({ projectId: row.projectId, enabled: row.enabled }));
}

async function validateProjectToggles(
  storage: Storage,
  toggles: readonly ArchiveProjectToggle[] | undefined,
): Promise<ArchiveProjectSetting[]> {
  const validated: ArchiveProjectSetting[] = [];

  if (toggles === undefined) return validated;

  for (const toggle of toggles) {
    const projectId = toggle.projectId.trim().toLowerCase();

    if (!isUuid(projectId)) throw new ArchiveError("invalid project id", 400);

    await assertProjectExists(storage, projectId);
    validated.push({ projectId, enabled: toggle.enabled });
  }

  return validated;
}

async function assertProjectExists(storage: Storage, projectId: string): Promise<void> {
  const rows = await storage.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);

  if (rows.length === 0) throw new ArchiveError("project not found", 404);
}

function rowToSettings(
  row: typeof schema.archiveSettings.$inferSelect,
  projects: ArchiveProjectSetting[],
): ArchiveSettings {
  return {
    id: Number(row.id),
    enabled: row.enabled,
    scheduleCron: row.scheduleCron,
    scheduleTimezone: row.scheduleTimezone,
    deleteOnFailure: row.deleteOnFailure,
    updatedAt: Number(row.updatedAt),
    description: describeCron(row.scheduleCron),
    projects,
  };
}
