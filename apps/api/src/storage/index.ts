import path from "node:path";
import { openDatabase, toLibsqlUrl } from "./db.js";
import * as eventsRepo from "./events.js";
import { resolveStorageKind } from "./types.js";
import type { Storage, StorageSettings } from "./types.js";

export async function createStorage(settings: StorageSettings): Promise<Storage> {
  const kind = resolveStorageKind(settings);
  const url = toLibsqlUrl(settings.dbPath);
  const { db, client } = await openDatabase({ url, authToken: settings.authToken });

  const description =
    kind === "libsql"
      ? `libsql · ${settings.dbPath}`
      : `sqlite · ${path.resolve(url.toLowerCase().startsWith("file:") ? url.slice(5) : url)}`;

  return {
    kind,
    description,
    db,
    client,
    insertEvents: (projectId, events, apiKeyId) =>
      eventsRepo.insertEvents(db, projectId, events, apiKeyId),
    queryEvents: (opts) => eventsRepo.queryEvents(db, opts),
    getEventByUid: (projectId, uid) => eventsRepo.getEventByUid(db, projectId, uid),
    histogramPoints: (projectId, from, to, bucketMs) =>
      eventsRepo.histogramPoints(db, projectId, from, to, bucketMs),
    listServices: (projectId) => eventsRepo.listServices(db, projectId),
    deleteOlderThan: (ts, excludeProjectIds) =>
      eventsRepo.deleteOlderThan(db, ts, excludeProjectIds),
    deleteAlertsOlderThan: (ts) => eventsRepo.deleteAlertsOlderThan(db, ts),
    deleteByProject: (projectId, range) => eventsRepo.deleteByProject(db, projectId, range),
    runMaintenance: async () => {
      // Local WAL files grow; SQLite reuses pages automatically. A full
      // VACUUM on a live log store costs more than it frees — skip.
    },
    close: async () => {
      client.close();
    },
  };
}

export type { Storage, StorageKind } from "./types.js";
