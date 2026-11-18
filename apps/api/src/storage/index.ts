import { createLibsqlStorage } from "./libsql.js";
import { createSqliteStorage } from "./sqlite.js";
import { resolveStorageKind } from "./types.js";
import type { Storage, StorageSettings } from "./types.js";

export async function createStorage(settings: StorageSettings): Promise<Storage> {
  const kind = resolveStorageKind(settings);
  if (kind === "libsql") {
    return createLibsqlStorage({ url: settings.dbPath, authToken: settings.authToken });
  }
  return createSqliteStorage(settings.dbPath);
}

export type { Storage, StorageKind } from "./types.js";