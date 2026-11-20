import fs from "node:fs";
import path from "node:path";
import { isUuid } from "../auth/ids.js";
import { isFiniteNumber, isJsonObject, isString } from "../json.js";
import { fileExists, writeFileAtomic } from "./util.js";

/**
 * Restore markers live under `<dataDir>/restore/`:
 *
 *   pending.json  a staged snapshot is ready to be applied at next boot
 *   applied.json  the swap happened; sessions still need clearing
 *
 * A marker contains only the snapshot id, where the request came from, and
 * timestamps. Never put bucket names, object keys, credentials, or signed URLs
 * in a marker: it survives on disk and is copied around by operators.
 */

export const RESTORE_MARKER_FORMAT = "kinglet-restore/v1";

export type RestoreSource = "snapshot" | "latest";

export interface RestoreMarker {
  format: typeof RESTORE_MARKER_FORMAT;
  snapshotId: string;
  source: RestoreSource;
  /** Epoch milliseconds when the snapshot finished staging. */
  stagedAt: number;
  /** Epoch milliseconds when the boot swap completed. */
  appliedAt?: number;
}

export interface RestorePaths {
  restoreDir: string;
  pendingPath: string;
  appliedPath: string;
  abortedPath: string;
}

export type RestoreMarkerRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ok"; marker: RestoreMarker };

export function restorePaths(dataDir: string): RestorePaths {
  const restoreDir = path.join(dataDir, "restore");

  return {
    restoreDir,
    pendingPath: path.join(restoreDir, "pending.json"),
    appliedPath: path.join(restoreDir, "applied.json"),
    abortedPath: path.join(restoreDir, "aborted.json"),
  };
}

/** Staged database name is derived from the validated snapshot id only. */
export function stagedDatabasePath(dataDir: string, snapshotId: string): string {
  return path.join(restorePaths(dataDir).restoreDir, `kinglet-${snapshotId}.db`);
}

export function isRestoreMarker(value: unknown): value is RestoreMarker {
  if (!isJsonObject(value)) return false;

  if (value.format !== RESTORE_MARKER_FORMAT) return false;

  if (!isString(value.snapshotId) || !isUuid(value.snapshotId)) return false;

  if (value.source !== "snapshot" && value.source !== "latest") return false;

  if (!isTimestamp(value.stagedAt)) return false;

  if (value.appliedAt !== undefined && !isTimestamp(value.appliedAt)) return false;

  return true;
}

export async function readRestoreMarker(filePath: string): Promise<RestoreMarkerRead> {
  if (!(await fileExists(filePath))) return { kind: "missing" };

  let raw: string;

  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch {
    return { kind: "invalid" };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }

  if (!isRestoreMarker(parsed)) return { kind: "invalid" };

  return { kind: "ok", marker: parsed };
}

export async function writeRestoreMarker(filePath: string, marker: RestoreMarker): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(marker)}\n`);
}

function isTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value > 0;
}
