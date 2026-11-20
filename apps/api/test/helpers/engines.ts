import type { AppEngines } from "../../src/app.js";
import type { ArchiveEngine } from "../../src/archive/engine.js";
import type {
  ArchiveProjectSetting,
  ArchiveSettingsView,
  ArchiveStatus,
} from "../../src/archive/types.js";
import type { BackupEngine } from "../../src/backups/engine.js";
import type { BackupSettings, BackupStatus } from "../../src/backups/types.js";
import type { MonitorEngine } from "../../src/monitors.js";
import type { NotificationEngine } from "../../src/notifications/engine.js";
import { describeCron, validateCron } from "../../src/schedule.js";
import { ArchiveError } from "../../src/archive/types.js";
import { BackupError } from "../../src/backups/types.js";

/**
 * Deterministic no-op engines for the app seam. They never touch the network,
 * never start timers, and report the "not configured" state production shows
 * when S3 backups/archive are disabled. Later tasks can override any method.
 */

const DEFAULT_CRON = "0 3 * * *";

function backupUnavailable(): never {
  throw new BackupError("S3 backups are not configured", 409);
}

function archiveUnavailable(): never {
  throw new ArchiveError("S3 archive storage is not configured", 409);
}

export interface TestEngineOverrides {
  monitor?: Partial<MonitorEngine>;
  notification?: Partial<NotificationEngine>;
  backup?: Partial<BackupEngine>;
  archive?: Partial<ArchiveEngine>;
}

export function createNoopMonitorEngine(overrides: Partial<MonitorEngine> = {}): MonitorEngine {
  return {
    refresh: async () => {},
    stop: () => {},
    ...overrides,
  };
}

export function createNoopNotificationEngine(
  overrides: Partial<NotificationEngine> = {},
): NotificationEngine {
  return {
    ready: Promise.resolve(),
    prune: async () => {},
    stop: () => {},
    ...overrides,
  };
}

export function createNoopBackupEngine(overrides: Partial<BackupEngine> = {}): BackupEngine {
  let settings: BackupSettings = {
    id: 1,
    enabled: false,
    scheduleCron: DEFAULT_CRON,
    scheduleTimezone: "UTC",
    retentionCount: 7,
    updatedAt: 0,
    description: describeCron(DEFAULT_CRON),
  };

  const status = (): BackupStatus => ({
    configured: false,
    supported: true,
    storage: "sqlite",
    enabled: settings.enabled,
    running: false,
    phase: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    nextRunAt: null,
    lastError: null,
    databaseBytes: null,
    setupMissing: [],
    retentionCount: settings.retentionCount,
    snapshotCount: 0,
    scheduleCron: settings.scheduleCron,
    scheduleTimezone: settings.scheduleTimezone,
    encrypted: false,
    lastRefreshError: null,
    problem: "S3 backups are not configured",
  });

  const engine: BackupEngine = {
    configured: false,
    supported: true,
    status: async () => status(),
    getSettings: async () => ({ ...settings }),
    updateSettings: async (input) => {
      settings = {
        ...settings,
        enabled: input.enabled ?? settings.enabled,
        scheduleCron: input.scheduleCron ?? settings.scheduleCron,
        scheduleTimezone: input.scheduleTimezone ?? settings.scheduleTimezone,
        retentionCount: input.retentionCount ?? settings.retentionCount,
        updatedAt: Date.now(),
      };

      return { ...settings };
    },
    preview: (input) => validateCron(input.cron, input.timezone),
    run: async () => backupUnavailable(),
    list: async () => [],
    refresh: async () => {},
    remove: async () => backupUnavailable(),
    download: async () => backupUnavailable(),
    testConnection: async () => backupUnavailable(),
    stop: () => {},
  };

  return { ...engine, ...overrides };
}

export function createNoopArchiveEngine(overrides: Partial<ArchiveEngine> = {}): ArchiveEngine {
  let settings: ArchiveSettingsView = {
    id: 1,
    enabled: false,
    scheduleCron: DEFAULT_CRON,
    scheduleTimezone: "UTC",
    deleteOnFailure: false,
    updatedAt: 0,
    description: describeCron(DEFAULT_CRON),
    projects: [],
    configured: false,
    supported: true,
    nextRuns: [],
  };

  const status = (): ArchiveStatus => ({
    configured: false,
    supported: true,
    enabled: settings.enabled,
    running: false,
    phase: null,
    projectId: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastSkippedAt: null,
    lastError: null,
    nextRunAt: null,
    scheduleCron: settings.scheduleCron,
    scheduleTimezone: settings.scheduleTimezone,
    deleteOnFailure: settings.deleteOnFailure,
    intervalDays: 14,
    enabledProjectIds: settings.projects
      .filter((project) => project.enabled)
      .map((project) => project.projectId),
    archivedEvents: 0,
    archivedBytes: 0,
    problem: "S3 archive storage is not configured",
  });

  const engine: ArchiveEngine = {
    configured: false,
    supported: true,
    status: async () => status(),
    getSettings: async () => ({ ...settings, projects: [...settings.projects] }),
    updateSettings: async (input) => {
      const validation = validateCron(
        input.scheduleCron ?? settings.scheduleCron,
        input.scheduleTimezone ?? settings.scheduleTimezone,
      );

      settings = {
        ...settings,
        enabled: input.enabled ?? settings.enabled,
        scheduleCron: input.scheduleCron ?? settings.scheduleCron,
        scheduleTimezone: input.scheduleTimezone ?? settings.scheduleTimezone,
        deleteOnFailure: input.deleteOnFailure ?? settings.deleteOnFailure,
        projects:
          input.projects === undefined
            ? settings.projects
            : input.projects.map((project) => ({ ...project })),
        updatedAt: Date.now(),
        nextRuns: validation.ok ? validation.nextRuns : [],
      };

      return { ...settings, projects: [...settings.projects] };
    },
    setProjectEnabled: async (projectId, enabled): Promise<ArchiveProjectSetting> => {
      settings = {
        ...settings,
        projects: [
          ...settings.projects.filter((project) => project.projectId !== projectId),
          { projectId, enabled },
        ],
      };

      return { projectId, enabled };
    },
    listParts: async () => [],
    importEvents: async () => archiveUnavailable(),
    run: async () => archiveUnavailable(),
    stop: () => {},
  };

  return { ...engine, ...overrides };
}

export function createNoopEngines(overrides: TestEngineOverrides = {}): AppEngines {
  return {
    monitor: createNoopMonitorEngine(overrides.monitor),
    notification: createNoopNotificationEngine(overrides.notification),
    backup: createNoopBackupEngine(overrides.backup),
    archive: createNoopArchiveEngine(overrides.archive),
  };
}
