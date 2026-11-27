import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { scrubSnapshotCredentials } from "../../src/backups/scrub.ts";
import { createStorage } from "../../src/storage/index.ts";
import type { Storage } from "../../src/storage/index.ts";
import * as schema from "../../src/storage/schema.ts";
import { createTempDatabase } from "../helpers/temp.ts";
import type { TempDatabase } from "../helpers/temp.ts";

// Fake values for tests only.
const SESSION_TOKEN = "fake-session-token-0123456789abcdef";
const VERIFICATION_VALUE = "fake-verification-value-0123456789";

let temp: TempDatabase | null = null;
let storage: Storage | null = null;

afterEach(async () => {
  await storage?.close();
  storage = null;
  await temp?.cleanup();
  temp = null;
});

async function countRows(file: string, table: string): Promise<number> {
  const client = createClient({ url: `file:${file}` });

  try {
    const result = await client.execute(`SELECT count(*) AS n FROM ${table}`);

    return Number(result.rows[0]?.n);
  } finally {
    client.close();
  }
}

describe("snapshot credential scrub", () => {
  it("removes session and verification secrets from the copy, not the live database", async () => {
    temp = createTempDatabase("kinglet-backup-scrub-");
    storage = await createStorage({ kind: "sqlite", dbPath: temp.dbPath });

    const now = new Date();
    const userId = "01900000-0000-7000-8000-00000000u001";

    await storage.db.insert(schema.user).values({
      id: userId,
      name: "Scrub",
      email: "scrub@example.test",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await storage.db.insert(schema.session).values({
      id: "01900000-0000-7000-8000-00000000s001",
      expiresAt: new Date(now.getTime() + 86_400_000),
      token: SESSION_TOKEN,
      createdAt: now,
      updatedAt: now,
      userId,
    });
    await storage.db.insert(schema.verification).values({
      id: "01900000-0000-7000-8000-00000000v001",
      identifier: "reset",
      value: VERIFICATION_VALUE,
      expiresAt: new Date(now.getTime() + 86_400_000),
      createdAt: now,
      updatedAt: now,
    });

    const snapshot = path.join(temp.directory, "snapshot.db");

    await storage.client.execute(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    expect(fs.readFileSync(snapshot).includes(SESSION_TOKEN)).toBe(true);

    await scrubSnapshotCredentials(snapshot);

    const bytes = fs.readFileSync(snapshot);

    expect(bytes.includes(SESSION_TOKEN)).toBe(false);
    expect(bytes.includes(VERIFICATION_VALUE)).toBe(false);
    expect(await countRows(snapshot, "session")).toBe(0);
    expect(await countRows(snapshot, "user")).toBe(1);
    // The live database keeps its sessions.
    expect(await countRows(temp.dbPath, "session")).toBe(1);
  });
});
