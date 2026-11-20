import type { Config } from "../env.js";
import { sendGeneric } from "../notify.js";
import type { Storage } from "../storage/index.js";
import { subscribeSystemEvents } from "../system-events.js";
import type { SystemEvent } from "../system-events.js";
import { migrateLegacyMonitorChannels } from "./migrate.js";
import { channelsForAction, pruneDeliveries, recordDelivery } from "./store.js";
import type { DeliveryRecordInput } from "./store.js";
import { safeErrorMessage } from "./types.js";
import type { NotificationAction, NotificationEvent } from "./types.js";

/**
 * Global notification delivery.
 *
 * System events are mapped to URL-free notices, matched against each enabled
 * channel's action subscriptions, and delivered once per channel. Failures are
 * recorded in `notification_deliveries`; there are no automatic retries, so a
 * dead endpoint cannot build an infinite queue.
 */

export interface NotificationEngine {
  stop(): void;
  prune(): Promise<void>;
  /** Resolves after the boot migration and first delivery-log prune. */
  ready?: Promise<void>;
}

export interface NotifyActionResult {
  matched: number;
  sent: number;
  failed: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;

  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;

  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;

  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function actionScope(action: NotificationAction): string {
  const dot = action.indexOf(".");

  return dot > 0 ? action.slice(0, dot) : "system";
}

function systemEventToNotification(event: SystemEvent): NotificationEvent | null {
  switch (event.type) {
    case "backup.succeeded":
      return {
        action: "backup.succeeded",
        subject: "Backup succeeded",
        summary:
          `Snapshot ${event.data.id} created ` +
          `(${formatBytes(event.data.sizeBytes)}) in ${formatDuration(event.data.durationMs)}.`,
        fields: [
          { name: "Run", value: event.data.runId },
          { name: "Size", value: formatBytes(event.data.sizeBytes) },
          { name: "Duration", value: formatDuration(event.data.durationMs) },
        ],
        at: event.at,
      };
    case "backup.failed":
      return {
        action: "backup.failed",
        subject: "Backup failed",
        summary:
          `Backup failed during ${event.data.phase}: ` + safeErrorMessage(event.data.error, 400),
        fields: [
          { name: "Run", value: event.data.runId },
          { name: "Phase", value: event.data.phase },
        ],
        at: event.at,
      };
    case "restore.staged":
      return {
        action: "backup.restore_staged",
        subject: "Restore staged",
        summary: `Snapshot ${event.data.id} was staged for restore. Restart Kinglet to apply.`,
        fields: [{ name: "Snapshot", value: event.data.id }],
        at: event.at,
      };
    case "archive.succeeded":
      return {
        action: "archive.succeeded",
        subject: "Archive part uploaded",
        summary:
          `Project ${event.data.projectId}: ${event.data.events} event(s) ` +
          `(${formatBytes(event.data.bytes)}) archived.`,
        fields: [
          { name: "Project", value: event.data.projectId },
          { name: "Events", value: String(event.data.events) },
          { name: "Bytes", value: formatBytes(event.data.bytes) },
        ],
        at: event.at,
      };
    case "archive.failed":
      return {
        action: "archive.failed",
        subject: "Archive failed",
        summary: `Project ${event.data.projectId}: ` + safeErrorMessage(event.data.error, 400),
        fields: [{ name: "Project", value: event.data.projectId }],
        at: event.at,
      };
    default:
      return null;
  }
}

async function recordSafely(storage: Storage, input: DeliveryRecordInput): Promise<void> {
  try {
    await recordDelivery(storage, input);
  } catch (err) {
    console.warn(
      "[kinglet] could not record notification delivery:",
      safeErrorMessage(err instanceof Error ? err : String(err), 200),
    );
  }
}

/**
 * Deliver one normalized notice to every enabled channel subscribed to its
 * action. Public so system.warning and future producers can call it directly.
 */
export async function notifyAction(
  storage: Storage,
  config: Config,
  event: NotificationEvent,
): Promise<NotifyActionResult> {
  const matched = await channelsForAction(storage, event.action);

  if (matched.length === 0) return { matched: 0, sent: 0, failed: 0 };

  const notice = {
    action: event.action,
    subject: event.subject,
    summary: event.summary,
    fields: event.fields,
    at: event.at ?? Date.now(),
  };

  const subject = safeErrorMessage(event.subject, 200);
  const scope = actionScope(event.action);

  const results = await Promise.all(
    matched.map(async (channel) => {
      try {
        await sendGeneric(channel, notice, {
          allowPrivate: config.allowPrivateWebhooks,
        });
      } catch (err) {
        const message = safeErrorMessage(err instanceof Error ? err : String(err), 500);

        await recordSafely(storage, {
          channelId: channel.id,
          scope,
          event: event.action,
          subject,
          status: "failed",
          error: message,
        });

        return false;
      }

      await recordSafely(storage, {
        channelId: channel.id,
        scope,
        event: event.action,
        subject,
        status: "sent",
      });

      return true;
    }),
  );

  let failed = 0;

  for (const sent of results) {
    if (!sent) failed++;
  }

  if (failed > 0) {
    console.warn(
      `[kinglet] notifications: ${failed}/${matched.length} channel(s) failed for ${event.action}`,
    );
  }

  return { matched: matched.length, sent: matched.length - failed, failed };
}

export function startNotificationEngine(options: {
  storage: Storage;
  config: Config;
}): NotificationEngine {
  const { storage, config } = options;

  const runPrune = async (): Promise<void> => {
    try {
      await pruneDeliveries(storage);
    } catch (err) {
      console.warn(
        "[kinglet] notification delivery prune failed:",
        safeErrorMessage(err instanceof Error ? err : String(err), 300),
      );
    }
  };

  // Boot work is serialized: the migration is transactional, and the local
  // libSQL driver does not tolerate another write transaction racing it.
  const ready = (async () => {
    try {
      await migrateLegacyMonitorChannels(storage, config.allowPrivateWebhooks);
    } catch (err) {
      console.warn(
        "[kinglet] notification channel migration failed:",
        safeErrorMessage(err instanceof Error ? err : String(err), 300),
      );
    }

    await runPrune();
  })();

  const unsubscribe = subscribeSystemEvents((event) => {
    const notice = systemEventToNotification(event);

    if (!notice) return;

    void notifyAction(storage, config, notice).catch((err) => {
      console.warn(
        "[kinglet] notification delivery failed:",
        safeErrorMessage(err instanceof Error ? err : String(err), 300),
      );
    });
  });

  const pruneTimer = setInterval(
    () => {
      void runPrune();
    },
    24 * 60 * 60 * 1000,
  );

  pruneTimer.unref();

  return {
    stop() {
      unsubscribe();
      clearInterval(pruneTimer);
    },
    prune: runPrune,
    ready,
  };
}
