import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const LEVEL_NAMES = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type DatabaseType = Database.Database;

/**
 * Opens (and if needed creates) the Kinglet database.
 *
 * Storage is deliberately boring: one SQLite file, WAL mode so readers never
 * block the single writer, FTS5 with a trigram tokenizer so plain substring
 * search ("timeout") works without exact-word matching.
 */
export function openDb(dbPath: string): DatabaseType {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  // Takes effect on fresh databases; keeps retention deletes cheap later.
  db.pragma("auto_vacuum = INCREMENTAL");
  migrate(db);
  return db;
}

function migrate(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      level INTEGER NOT NULL,
      service TEXT,
      env TEXT,
      message TEXT NOT NULL,
      fields BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
    CREATE INDEX IF NOT EXISTS idx_events_service_ts ON events (service, ts);
    CREATE INDEX IF NOT EXISTS idx_events_env_ts ON events (env, ts);
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5 (
      message,
      content='events',
      content_rowid='id',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts (rowid, message) VALUES (new.id, new.message);
    END;
    CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts (events_fts, rowid, message) VALUES ('delete', old.id, old.message);
    END;
  `);
}
