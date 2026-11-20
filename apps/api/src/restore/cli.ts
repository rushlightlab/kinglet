#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { BackupStore, describeBackupError } from "../backups/s3.js";
import { BackupError } from "../backups/types.js";
import { loadConfig } from "../env.js";
import { restorePaths } from "./marker.js";
import { stageLatestRestore, stageRestore } from "./stage.js";
import type { StageRestoreResult } from "./stage.js";

/**
 * Fresh-host restore entry point. Runs before the server opens the database:
 *
 *   node apps/api/dist/restore/cli.js --latest
 *   node apps/api/dist/restore/cli.js --id <snapshot-id>
 *   node apps/api/dist/restore/cli.js --key snapshots/<id>.db.zst[.age]
 *
 * It stages the snapshot exactly like the admin route; the next server boot
 * performs the swap. Output never includes bucket URLs or credentials.
 */

const USAGE =
  "Usage: node dist/restore/cli.js (--latest | --id <snapshot-id> | --key snapshots/<id>.db.zst[.age])";

async function run(): Promise<void> {
  const parsed = parseArguments();

  const { latest, id, key } = parsed.values;
  const selected = [latest === true, id !== undefined, key !== undefined].filter(Boolean).length;

  if (selected !== 1) throw new BackupError(USAGE, 400);

  const config = loadConfig();

  if (config.backup === null) {
    const problem =
      config.backupProblem === null
        ? "S3 backups are not configured"
        : `S3 backup configuration is incomplete: ${config.backupProblem}`;

    throw new BackupError(problem, 409);
  }

  let result: StageRestoreResult;

  if (latest === true) {
    result = await stageLatestRestore({ config });
  } else if (id !== undefined) {
    result = await stageRestore({ config, snapshotId: id });
  } else if (key !== undefined) {
    const store = new BackupStore(config.backup);

    try {
      result = await stageRestore({ config, snapshotId: snapshotIdFromKey(store, key) });
    } finally {
      store.destroy();
    }
  } else {
    throw new BackupError(USAGE, 400);
  }

  console.log(`Restore staged for snapshot ${result.snapshotId}.`);
  console.log("Restart Kinglet to apply it. The current database will be copied first.");
  console.log(`Marker: ${restorePaths(config.dataDir).pendingPath}`);
}

function parseArguments() {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        latest: { type: "boolean" },
        id: { type: "string" },
        key: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch {
    throw new BackupError(USAGE, 400);
  }
}

function snapshotIdFromKey(store: BackupStore, rawKey: string): string {
  const key = rawKey.trim().replaceAll("\\", "/");
  let fullKey = key;

  if (!fullKey.startsWith(store.snapshotPrefix)) {
    if (!fullKey.startsWith("snapshots/")) {
      throw new BackupError(
        "--key must be snapshots/<id>.db.zst[.age] or a full object key under the configured prefix",
        400,
      );
    }

    fullKey = `${store.prefix}/${fullKey}`;
  }

  const id = store.objectId(fullKey);

  if (id === null) throw new BackupError("--key does not name a snapshot object", 400);

  return id;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];

  if (entry === undefined) return false;

  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  }
}

if (invokedDirectly()) {
  run().catch((cause: unknown) => {
    const message = cause instanceof BackupError ? cause.message : describeBackupError(cause);

    console.error(`kinglet restore: ${message}`);
    process.exitCode = 1;
  });
}
