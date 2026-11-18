import type { SqlExecutor } from "./types.js";

/**
 * Versioned schema migrations, tracked with SQLite's `PRAGMA user_version`.
 *
 * Rules:
 *  - Never edit a shipped migration; add a new one instead.
 *  - Migrations run BEFORE any project-aware statements are prepared, and
 *    before the API starts serving.
 *  - Both drivers (better-sqlite3 and libSQL/Turso) execute the same steps.
 *
 * This exists because hand-rolled "create index / add column" ordering broke
 * upgrades of pre-multi-project databases — a migration step keeps ordering
 * and versioning in one place.
 */

interface Migration {
  version: number;
  name: string;
  up(sql: SqlExecutor): Promise<void>;
}

async function hasColumn(sql: SqlExecutor, table: string, column: string): Promise<boolean> {
  const rows = await sql.all(`PRAGMA table_info(${table})`);
  return rows.some((row) => String(row.name) === column);
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "multi-project: project_id columns and indexes",
    async up(sql) {
      if (!(await hasColumn(sql, "events", "project_id"))) {
        await sql.run("ALTER TABLE events ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1");
      }
      if (!(await hasColumn(sql, "monitors", "project_id"))) {
        await sql.run("ALTER TABLE monitors ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1");
      }
      await sql.run("CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events (project_id, ts)");
      await sql.run("CREATE INDEX IF NOT EXISTS idx_monitors_project ON monitors (project_id)");
    },
  },
];

export async function runMigrations(sql: SqlExecutor): Promise<void> {
  let current = 0;
  try {
    const rows = await sql.all("PRAGMA user_version");
    current = Number(rows[0]?.user_version ?? 0);
  } catch {
    current = 0; // fresh database — pragma may return nothing
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    console.log(`[kinglet] migrating database → v${migration.version} (${migration.name})`);
    await migration.up(sql);
    await sql.run(`PRAGMA user_version = ${migration.version}`);
    current = migration.version;
  }
}
