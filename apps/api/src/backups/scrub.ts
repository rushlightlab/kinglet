import { createClient } from "@libsql/client";

/**
 * Remove live credentials from a snapshot copy before it leaves the machine.
 * Restore signs everyone out anyway, so session and verification rows are
 * useless in a backup, but anyone who can read the bucket or a downloaded
 * snapshot could replay them. `secure_delete` overwrites the freed cells, so
 * the token values are gone from the file, not just unlinked.
 */
export async function scrubSnapshotCredentials(snapshotPath: string): Promise<void> {
  const client = createClient({ url: `file:${snapshotPath}` });

  try {
    // A plain rollback journal keeps the copy a single self-contained file.
    await client.execute("PRAGMA journal_mode = DELETE");
    await client.execute("PRAGMA secure_delete = ON");
    await client.batch(["DELETE FROM session", "DELETE FROM verification"], "write");
  } finally {
    client.close();
  }
}
