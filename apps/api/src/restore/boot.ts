import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { describeBackupError } from "../backups/s3.js";
import type { Config } from "../env.js";
import { notifyAction } from "../notifications/engine.js";
import type { Storage } from "../storage/index.js";
import * as schema from "../storage/schema.js";
import { SCHEMA_VERSION } from "../storage/schema.js";
import {
  readRestoreMarker,
  restorePaths,
  stagedDatabasePath,
  writeRestoreMarker,
} from "./marker.js";
import type { RestoreMarker } from "./marker.js";
import {
  databaseSidecarPaths,
  fileExists,
  fileSize,
  inspectDatabase,
  localDatabasePath,
  moveFileOver,
  removeFile,
} from "./util.js";
import type { DatabaseCheck, DatabaseSidecars } from "./util.js";

/**
 * Boot-time restore application.
 *
 * `preparePendingRestore` runs before the storage layer opens: it copies the
 * current database, swaps in the staged file, and moves the marker to
 * `applied.json`. `finalizePendingRestore` runs after migrations and schema
 * extras: it clears sessions, records completion, and removes the marker.
 */

export interface RestoreBootResult {
  applied: boolean;
  snapshotId: string | null;
  preRestorePath: string | null;
  restartRequired?: boolean;
}

interface AppliedRestore {
  snapshotId: string;
}

/** Lets finalize complete even if writing applied.json failed after the swap. */
let appliedInProcess: AppliedRestore | null = null;

export async function preparePendingRestore(config: Config): Promise<RestoreBootResult> {
  const paths = restorePaths(config.dataDir);
  const pending = await readRestoreMarker(paths.pendingPath);

  if (pending.kind === "missing") {
    return { applied: false, snapshotId: null, preRestorePath: null };
  }

  if (pending.kind === "invalid") {
    console.warn(
      "[kinglet] restore marker is invalid; ignoring the staged restore and keeping the current database",
    );
    await movePendingToAborted(config);

    return { applied: false, snapshotId: null, preRestorePath: null, restartRequired: false };
  }

  const marker = pending.marker;
  const stagedPath = stagedDatabasePath(config.dataDir, marker.snapshotId);

  if (!(await fileExists(stagedPath))) {
    console.warn(
      `[kinglet] restore snapshot ${marker.snapshotId} has no staged database; ` +
        "assuming the swap already happened and scheduling cleanup",
    );

    appliedInProcess = { snapshotId: marker.snapshotId };
    await recordApplied(config, marker);

    return {
      applied: true,
      snapshotId: marker.snapshotId,
      preRestorePath: null,
      restartRequired: false,
    };
  }

  const livePath = localDatabasePath(config);

  if (livePath === null) {
    console.warn(
      "[kinglet] a restore is staged but this instance uses remote libSQL/Turso; " +
        "restore is only supported for local SQLite",
    );
    await movePendingToAborted(config);

    return {
      applied: false,
      snapshotId: marker.snapshotId,
      preRestorePath: null,
      restartRequired: false,
    };
  }

  let check: DatabaseCheck;

  try {
    check = await inspectDatabase(stagedPath);
  } catch (cause) {
    console.warn(
      `[kinglet] staged snapshot ${marker.snapshotId} could not be opened:`,
      describeBackupError(cause),
    );
    await movePendingToAborted(config);

    return {
      applied: false,
      snapshotId: marker.snapshotId,
      preRestorePath: null,
      restartRequired: false,
    };
  }

  if (!check.integrityOk) {
    console.warn(`[kinglet] staged snapshot ${marker.snapshotId} failed the integrity check`);
    await removeFile(stagedPath);
    await movePendingToAborted(config);

    return {
      applied: false,
      snapshotId: marker.snapshotId,
      preRestorePath: null,
      restartRequired: false,
    };
  }

  if (check.schemaVersion !== null && check.schemaVersion > SCHEMA_VERSION) {
    console.warn(
      `[kinglet] staged snapshot ${marker.snapshotId} uses schema v${check.schemaVersion}, ` +
        `newer than this build (v${SCHEMA_VERSION}); keeping the current database`,
    );
    await movePendingToAborted(config);

    return {
      applied: false,
      snapshotId: marker.snapshotId,
      preRestorePath: null,
      restartRequired: false,
    };
  }

  const liveExists = await fileExists(livePath);
  let preRestorePath: string | null = null;

  if (liveExists) {
    // Keep the rollback copies bounded. Each one is a full database with
    // password hashes, API-key hashes, and channel URLs.
    await prunePreRestoreCopies(config.dataDir, 2);
    preRestorePath = await nextPreRestorePath(config.dataDir);
    const copied = await savePreRestoreCopy(livePath, preRestorePath);

    if (!copied) {
      console.warn(
        "[kinglet] could not copy the current database before restore; " +
          "leaving the staged restore pending and booting the current database",
      );

      return {
        applied: false,
        snapshotId: marker.snapshotId,
        preRestorePath: null,
        restartRequired: true,
      };
    }
  }

  // Remove staged WAL/SHM created by the integrity check; the snapshot itself
  // is a single self-contained database.
  const stagedSidecars = databaseSidecarPaths(stagedPath);

  await removeFile(stagedSidecars.wal);
  await removeFile(stagedSidecars.shm);

  const swapped = await swapStagedDatabase(stagedPath, livePath, liveExists);

  if (swapped !== "applied") {
    // A database that was never moved, or was put back, is left alone. Only a
    // swap that could not be rolled back falls back to the pre-restore copy.
    if (swapped === "damaged" && preRestorePath !== null) {
      await restorePreRestoreCopy(preRestorePath, livePath);
    }

    return {
      applied: false,
      snapshotId: marker.snapshotId,
      preRestorePath,
      restartRequired: true,
    };
  }

  appliedInProcess = { snapshotId: marker.snapshotId };
  await recordApplied(config, marker);

  const saved = preRestorePath === null ? "" : `; previous database saved to ${preRestorePath}`;

  console.log(`[kinglet] restored snapshot ${marker.snapshotId}${saved}`);

  return {
    applied: true,
    snapshotId: marker.snapshotId,
    preRestorePath,
    restartRequired: false,
  };
}

export async function finalizePendingRestore(storage: Storage, config: Config): Promise<void> {
  const paths = restorePaths(config.dataDir);
  const applied = await readRestoreMarker(paths.appliedPath);
  let snapshotId: string | null = null;

  if (applied.kind === "ok") {
    snapshotId = applied.marker.snapshotId;
  } else if (applied.kind === "invalid") {
    console.warn(
      "[kinglet] applied restore marker is invalid; clearing sessions without a snapshot id",
    );
  } else if (appliedInProcess !== null) {
    snapshotId = appliedInProcess.snapshotId;
  } else {
    return;
  }

  // A leaked snapshot must not turn old session cookies back into logins. API
  // keys are intentionally kept: they are project-scoped and revocable.
  // Fail closed: if session clearing fails, do not serve the restored database.
  try {
    await storage.db.transaction(async (tx) => {
      await tx.delete(schema.session);
      await tx.delete(schema.verification);
    });
  } catch (cause) {
    const message = describeBackupError(cause);

    console.error(
      "[kinglet] could not clear sessions after restore; refusing to serve the restored database:",
      message,
    );

    throw new Error(`restore session clearing failed: ${message}`, { cause });
  }

  if (snapshotId !== null) {
    try {
      await setMeta(storage, "last_restore_snapshot", snapshotId);
      await setMeta(storage, "last_restore_at", String(Date.now()));
    } catch (cause) {
      console.warn("[kinglet] could not record restore completion:", describeBackupError(cause));
    }
  }

  await removeFile(paths.appliedPath);
  appliedInProcess = null;

  if (snapshotId !== null) {
    try {
      await notifyAction(storage, config, {
        action: "backup.restore_staged",
        subject: "Restore applied",
        summary: `Snapshot ${snapshotId} was applied. Existing sessions were cleared; API keys were kept.`,
        fields: [{ name: "Snapshot", value: snapshotId }],
      });
    } catch (cause) {
      console.warn("[kinglet] restore notification failed:", describeBackupError(cause));
    }
  }
}

async function recordApplied(config: Config, marker: RestoreMarker): Promise<void> {
  const paths = restorePaths(config.dataDir);
  const applied: RestoreMarker = { ...marker, appliedAt: Date.now() };

  try {
    await writeRestoreMarker(paths.appliedPath, applied);
    await removeFile(paths.pendingPath);
  } catch (cause) {
    // The in-process fallback still lets finalize clear sessions this boot; the
    // next boot re-detects a pending marker with no staged file.
    console.warn(
      "[kinglet] restore applied but the marker could not be moved:",
      describeBackupError(cause),
    );
  }
}

async function movePendingToAborted(config: Config): Promise<void> {
  const paths = restorePaths(config.dataDir);

  try {
    await moveFileOver(paths.pendingPath, paths.abortedPath);
  } catch (cause) {
    console.warn(
      "[kinglet] could not move the ignored restore marker:",
      describeBackupError(cause),
    );
  }
}

type SwapOutcome = "applied" | "untouched" | "rolled-back" | "damaged";

async function swapStagedDatabase(
  stagedPath: string,
  livePath: string,
  liveExists: boolean,
): Promise<SwapOutcome> {
  await fs.promises.mkdir(path.dirname(livePath), { recursive: true, mode: 0o700 });

  if (!liveExists) {
    const liveSidecars = databaseSidecarPaths(livePath);

    await removeFile(liveSidecars.wal);
    await removeFile(liveSidecars.shm);

    return (await installStagedDatabase(stagedPath, livePath)) ? "applied" : "damaged";
  }

  const asidePath = `${livePath}.restore-old-${Date.now()}`;
  const liveSidecars = databaseSidecarPaths(livePath);
  const asideSidecars = databaseSidecarPaths(asidePath);

  // Windows cannot rename over a live database. Move the old main file and its
  // sidecars aside first: if any move fails, the database is in use and the
  // staged restore must wait for the next boot instead of overwriting it.
  try {
    await fs.promises.rename(livePath, asidePath);
  } catch (cause) {
    console.warn(
      "[kinglet] live database is in use; leaving the staged restore pending:",
      describeBackupError(cause),
    );

    return "untouched";
  }

  try {
    if (await fileExists(liveSidecars.wal)) {
      await fs.promises.rename(liveSidecars.wal, asideSidecars.wal);
    }

    if (await fileExists(liveSidecars.shm)) {
      await fs.promises.rename(liveSidecars.shm, asideSidecars.shm);
    }
  } catch (cause) {
    console.warn(
      "[kinglet] could not move live WAL/SHM aside; leaving the staged restore pending:",
      describeBackupError(cause),
    );

    return (await restoreOldDatabase(asidePath, livePath, asideSidecars, liveSidecars))
      ? "rolled-back"
      : "damaged";
  }

  if (!(await installStagedDatabase(stagedPath, livePath))) {
    return (await restoreOldDatabase(asidePath, livePath, asideSidecars, liveSidecars))
      ? "rolled-back"
      : "damaged";
  }

  // The durable rollback copy is pre-restore-*.db. The moved-aside original is
  // only a temporary handle and can be removed now.
  await removeFile(asidePath);
  await removeFile(asideSidecars.wal);
  await removeFile(asideSidecars.shm);

  return "applied";
}

async function installStagedDatabase(stagedPath: string, livePath: string): Promise<boolean> {
  const stagedBytes = await fileSize(stagedPath);

  try {
    await fs.promises.rename(stagedPath, livePath);

    return true;
  } catch {
    // Cross-device moves are rare (the staged file lives under dataDir), but a
    // verified copy keeps them working.
  }

  try {
    await fs.promises.copyFile(stagedPath, livePath);

    if ((await fileSize(livePath)) !== stagedBytes) {
      console.warn("[kinglet] staged database copy was incomplete; keeping it for retry");

      return false;
    }

    await removeFile(stagedPath);

    return true;
  } catch (cause) {
    console.warn("[kinglet] could not install the staged database:", describeBackupError(cause));

    return false;
  }
}

async function restoreOldDatabase(
  asidePath: string,
  livePath: string,
  asideSidecars: DatabaseSidecars,
  liveSidecars: DatabaseSidecars,
): Promise<boolean> {
  try {
    await removeFile(livePath);
    await fs.promises.rename(asidePath, livePath);

    if (await fileExists(asideSidecars.wal)) {
      await fs.promises.rename(asideSidecars.wal, liveSidecars.wal);
    }

    if (await fileExists(asideSidecars.shm)) {
      await fs.promises.rename(asideSidecars.shm, liveSidecars.shm);
    }

    return true;
  } catch (cause) {
    console.warn(
      "[kinglet] could not put the previous database back after a failed swap:",
      describeBackupError(cause),
    );

    return false;
  }
}

/**
 * Put the previous database back after a failed swap so boot continues on the
 * last known-good data. The pre-restore copy either has no sidecars (VACUUM
 * INTO) or was copied together with them.
 */
async function restorePreRestoreCopy(preRestorePath: string, livePath: string): Promise<void> {
  console.warn("[kinglet] restoring the previous database after a failed swap");

  try {
    const liveSidecars = databaseSidecarPaths(livePath);

    await removeFile(livePath);
    await removeFile(liveSidecars.wal);
    await removeFile(liveSidecars.shm);
    await fs.promises.copyFile(preRestorePath, livePath);

    const sidecars = databaseSidecarPaths(preRestorePath);

    if (await fileExists(sidecars.wal)) {
      await fs.promises.copyFile(sidecars.wal, liveSidecars.wal);
    }

    if (await fileExists(sidecars.shm)) {
      await fs.promises.copyFile(sidecars.shm, liveSidecars.shm);
    }
  } catch (cause) {
    console.warn(
      "[kinglet] could not restore the previous database; the pre-restore copy is still available:",
      describeBackupError(cause),
    );
  }
}

async function savePreRestoreCopy(livePath: string, destinationPath: string): Promise<boolean> {
  await removeFile(destinationPath);

  const escaped = destinationPath.replaceAll("'", "''");

  try {
    const database = new DatabaseSync(livePath, { timeout: 5000 });

    try {
      database.exec(`VACUUM INTO '${escaped}'`);
    } finally {
      database.close();
    }

    if ((await fileSize(destinationPath)) > 0) return true;
  } catch (cause) {
    console.warn(
      "[kinglet] VACUUM INTO pre-restore copy failed; falling back to a file copy:",
      describeBackupError(cause),
    );
  }

  // A raw copy must include the WAL and SHM sidecars; copying only the main file
  // can silently lose committed transactions.
  await removeFile(destinationPath);
  await removeFile(`${destinationPath}-wal`);
  await removeFile(`${destinationPath}-shm`);

  try {
    await fs.promises.copyFile(livePath, destinationPath);

    const sidecars = databaseSidecarPaths(livePath);

    if (await fileExists(sidecars.wal)) {
      await fs.promises.copyFile(sidecars.wal, `${destinationPath}-wal`);
    }

    if (await fileExists(sidecars.shm)) {
      await fs.promises.copyFile(sidecars.shm, `${destinationPath}-shm`);
    }

    return (await fileSize(destinationPath)) > 0;
  } catch (cause) {
    console.warn("[kinglet] pre-restore copy failed:", describeBackupError(cause));

    return false;
  }
}

async function prunePreRestoreCopies(dataDir: string, keep: number): Promise<void> {
  let names: string[];

  try {
    names = await fs.promises.readdir(dataDir);
  } catch {
    return;
  }

  const candidates: Array<{ filePath: string; mtime: number }> = [];

  for (const name of names) {
    if (!name.startsWith("pre-restore-") || !name.endsWith(".db")) continue;

    const filePath = path.join(dataDir, name);

    try {
      const stat = await fs.promises.stat(filePath);

      if (stat.isFile()) candidates.push({ filePath, mtime: stat.mtimeMs });
    } catch {
      // A copy that disappeared is already pruned.
    }
  }

  candidates.sort((left, right) => right.mtime - left.mtime);

  for (const old of candidates.slice(keep)) {
    const sidecars = databaseSidecarPaths(old.filePath);

    await removeFile(old.filePath);
    await removeFile(sidecars.wal);
    await removeFile(sidecars.shm);
  }
}

async function nextPreRestorePath(dataDir: string): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  let candidate = path.join(dataDir, `pre-restore-${stamp}.db`);
  let suffix = 1;

  while (await fileExists(candidate)) {
    candidate = path.join(dataDir, `pre-restore-${stamp}-${suffix}.db`);
    suffix++;
  }

  return candidate;
}

async function setMeta(storage: Storage, key: string, value: string): Promise<void> {
  await storage.db.insert(schema.appMeta).values({ key, value }).onConflictDoUpdate({
    target: schema.appMeta.key,
    set: { value },
  });
}
