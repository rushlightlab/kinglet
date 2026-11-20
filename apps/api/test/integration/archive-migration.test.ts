import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createTempDatabase } from "../helpers/temp.js";

const MIGRATION_PATH = new URL("../../drizzle/0009_young_the_spike.sql", import.meta.url);

/**
 * 0009 deduplicates archive_parts by object_key before adding the unique
 * index. Replaying the shipped SQL against a pre-0009 table is the only way
 * to exercise the DELETE without hand-editing a migration.
 */
describe("archive part unique-index migration", () => {
  it("keeps the first row per object key and adds the unique index", async () => {
    const scratch = createTempDatabase();
    const database = new DatabaseSync(scratch.dbPath);

    try {
      database.exec(`
        CREATE TABLE archive_parts (
          id TEXT PRIMARY KEY NOT NULL,
          object_key TEXT NOT NULL
        );
      `);

      const insert = database.prepare("INSERT INTO archive_parts (id, object_key) VALUES (?, ?)");

      insert.run("first-key-1", "kinglet/archive/key-1");
      insert.run("duplicate-key-1", "kinglet/archive/key-1");
      insert.run("first-key-2", "kinglet/archive/key-2");
      insert.run("duplicate-key-2", "kinglet/archive/key-2");
      insert.run("duplicate-key-2b", "kinglet/archive/key-2");

      const migration = fs.readFileSync(MIGRATION_PATH, "utf8");

      for (const statement of migration.split("--> statement-breakpoint")) {
        const sql = statement.trim();

        if (sql !== "") database.exec(sql);
      }

      const kept = database
        .prepare("SELECT id, object_key FROM archive_parts ORDER BY rowid")
        .all();

      expect(kept).toEqual([
        { id: "first-key-1", object_key: "kinglet/archive/key-1" },
        { id: "first-key-2", object_key: "kinglet/archive/key-2" },
      ]);

      const indexes = database.prepare("PRAGMA index_list(archive_parts)").all();

      const uniqueIndex = indexes.find(
        (row) => row.name === "uq_archive_parts_object_key" && row.unique === 1,
      );

      expect(uniqueIndex).toBeDefined();
      expect(Number(uniqueIndex?.unique)).toBe(1);

      expect(() => insert.run("late-duplicate", "kinglet/archive/key-1")).toThrow(/UNIQUE/i);
    } finally {
      database.close();
      await scratch.cleanup();
    }
  });
});
