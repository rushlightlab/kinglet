import { BackupStore, describeBackupError } from "../backups/s3.js";
import type { BackupObjectStore } from "../backups/s3.js";
import type { Config } from "../env.js";
import { ArchiveError } from "./types.js";

/**
 * Delete every archived object for one project. Project deletion and an
 * explicit all-time clear must not leave logs behind in the bucket while the
 * UI says the project's logs were removed.
 *
 * `store` is a test/embedding seam: an injected store is used as-is and is not
 * destroyed, because its owner controls the lifecycle. Production constructs
 * and destroys the S3 adapter exactly as before.
 */
export async function deleteArchivedProjectObjects(
  config: Config,
  projectId: string,
  store?: BackupObjectStore,
): Promise<number> {
  const ownsStore = store === undefined;
  const active = store ?? (config.backup === null ? null : new BackupStore(config.backup));

  if (active === null) return 0;

  try {
    const prefix = `${active.prefix}/archive/events/project=${projectId}/`;
    const objects = await active.listObjects(prefix);

    for (const object of objects) {
      await active.deleteObject(object.key);
    }

    return objects.length;
  } catch (cause) {
    throw new ArchiveError(
      `archived objects could not be deleted: ${describeBackupError(cause)}`,
      502,
    );
  } finally {
    if (ownsStore) active.destroy();
  }
}
