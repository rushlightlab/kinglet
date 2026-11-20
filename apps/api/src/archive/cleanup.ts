import { BackupStore, describeBackupError } from "../backups/s3.js";
import type { Config } from "../env.js";
import { ArchiveError } from "./types.js";

/**
 * Delete every archived object for one project. Project deletion and an
 * explicit all-time clear must not leave logs behind in the bucket while the
 * UI says the project's logs were removed.
 */
export async function deleteArchivedProjectObjects(
  config: Config,
  projectId: string,
): Promise<number> {
  if (config.backup === null) return 0;

  const store = new BackupStore(config.backup);

  try {
    const prefix = `${store.prefix}/archive/events/project=${projectId}/`;
    const objects = await store.listObjects(prefix);

    for (const object of objects) {
      await store.deleteObject(object.key);
    }

    return objects.length;
  } catch (cause) {
    throw new ArchiveError(
      `archived objects could not be deleted: ${describeBackupError(cause)}`,
      502,
    );
  } finally {
    store.destroy();
  }
}
