#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ensureSchemaExtras } from "../auth/setup.ts";
import { isUuid } from "../auth/ids.ts";
import { BackupStore } from "../backups/s3.ts";
import { loadConfig } from "../env.ts";
import { createStorage } from "../storage/index.ts";
import { importArchive } from "./import.ts";

/**
 * Import archived NDJSON parts back into a project. Run this while the API is
 * stopped, or accept that concurrent ingest and the importer both write:
 *
 *   node apps/api/dist/archive/cli.js --project <id> --from 2026-11-01 --to 2026-11-20
 */

function usage(): void {
  process.stderr.write(
    "usage: kinglet-archive-import --project <project-id> [--from YYYY-MM-DD] [--to YYYY-MM-DD]\n",
  );
}

function parseCliArgs(): { project?: string; from?: string; to?: string; help?: boolean } | null {
  try {
    const parsed = parseArgs({
      options: {
        project: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });

    return parsed.values;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    usage();
    process.exitCode = 1;

    return null;
  }
}

async function main(): Promise<void> {
  const values = parseCliArgs();

  if (values === null) return;

  if (values.help === true) {
    usage();

    return;
  }

  const projectId = values.project?.trim().toLowerCase() ?? "";

  if (!isUuid(projectId)) {
    process.stderr.write("--project must be a project UUID\n");
    usage();
    process.exitCode = 1;

    return;
  }

  const config = loadConfig();

  if (config.backup === null) {
    process.stderr.write("S3 backups are not configured; set the KINGLET_BACKUP_S3_* variables\n");
    process.exitCode = 1;

    return;
  }

  const storage = await createStorage({
    kind: config.storageKind,
    dbPath: config.dbPath,
    authToken: config.dbAuthToken,
  });

  const store = new BackupStore(config.backup);

  try {
    await ensureSchemaExtras(storage, config.timezone);

    const result = await importArchive(storage, {
      projectId,
      from: values.from,
      to: values.to,
      dataDir: config.dataDir,
      passphrase: config.backup.passphrase,
      allowUnencrypted: config.backup.allowUnencryptedSnapshots,
      s3: store,
    });

    process.stdout.write(
      `imported ${result.imported} event(s), skipped ${result.skipped} duplicate(s)\n`,
    );
  } finally {
    store.destroy();
    await storage.close();
  }
}

main().catch((err) => {
  process.stderr.write(
    `archive import failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
