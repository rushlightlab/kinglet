import type { Client } from "@libsql/client";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Events store a small integer project key (see `project_keys`), while the
 * API, auth, and every other table use the project UUID.
 *
 * Reads resolve the key inside the query: an uncorrelated scalar subquery that
 * SQLite evaluates once and still uses for index seeks. An unknown project
 * yields NULL and therefore no rows, which is the correct answer.
 */
export function projectKeyOf(projectId: string): SQL {
  return sql`(SELECT key FROM project_keys WHERE project_id = ${projectId})`;
}

/** Keys for several projects, for `IN` / `NOT IN` filters. */
export function projectKeysOf(projectIds: readonly string[]): SQL {
  const ids = sql.join(
    projectIds.map((id) => sql`${id}`),
    sql`, `,
  );

  return sql`(SELECT key FROM project_keys WHERE project_id IN (${ids}))`;
}

// Keys are assigned once and never changed or reused, so a per-connection
// cache can never serve a stale value.
const cache = new WeakMap<Client, Map<string, number>>();

/** Cached read of a project's integer key, or null if it has never stored events. */
export async function lookupProjectKey(client: Client, projectId: string): Promise<number | null> {
  let keys = cache.get(client);

  if (!keys) {
    keys = new Map();
    cache.set(client, keys);
  }

  const cached = keys.get(projectId);

  if (cached !== undefined) return cached;

  const result = await client.execute({
    sql: "SELECT key FROM project_keys WHERE project_id = ?",
    args: [projectId],
  });

  const key = Number(result.rows[0]?.key);

  if (Number.isSafeInteger(key) && key > 0) {
    keys.set(projectId, key);

    return key;
  }

  return null;
}

/** The key for a project, assigning the next one on its first write. */
export async function ensureProjectKey(client: Client, projectId: string): Promise<number> {
  let keys = cache.get(client);

  if (!keys) {
    keys = new Map();
    cache.set(client, keys);
  }

  const cached = keys.get(projectId);

  if (cached !== undefined) return cached;

  // Two writers on a remote database can race for the same next key; the
  // loser's insert is ignored on the unique key and it simply tries again.
  for (let attempt = 0; attempt < 5; attempt++) {
    await client.execute({
      sql: "INSERT OR IGNORE INTO project_keys (project_id, key) SELECT ?, coalesce(max(key), 0) + 1 FROM project_keys",
      args: [projectId],
    });

    const result = await client.execute({
      sql: "SELECT key FROM project_keys WHERE project_id = ?",
      args: [projectId],
    });

    const key = Number(result.rows[0]?.key);

    if (Number.isSafeInteger(key) && key > 0) {
      keys.set(projectId, key);

      return key;
    }
  }

  throw new Error("could not assign a storage key for the project");
}
