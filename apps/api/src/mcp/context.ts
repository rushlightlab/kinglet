/**
 * `GET /v1/context` payload for machine credentials.
 *
 * Project isolation is structural here: the project always comes from
 * `auth.projectId` (the key's own binding), never from a query parameter. User
 * sessions get `null` so the route can return 403; the browser UI learns about
 * projects from `/v1/projects` instead.
 *
 * The response is intentionally tiny: project identity, the key's own public
 * metadata, derived capabilities, and server version/retention. It never
 * includes other projects, URLs, secrets, or server configuration.
 */

import { eq } from "drizzle-orm";
import type { Storage } from "../storage/index.ts";
import * as schema from "../storage/schema.ts";
import type { AuthInfo } from "../auth/middleware.ts";
import type { KeyType } from "../auth/roles.ts";
import { keyCan } from "../auth/key-capabilities.ts";
import { APP_VERSION } from "../version.ts";

export interface KeyCapabilities {
  "logs.read": boolean;
  "logs.write": boolean;
  "monitors.read": boolean;
  "monitors.write": boolean;
}

export interface KeyContext {
  project: { id: string; name: string; slug: string };
  key: {
    id: string;
    name: string;
    keyType: KeyType;
    scopes: string[];
  };
  capabilities: KeyCapabilities;
  server: {
    version: string;
    retentionDays: number;
  };
}

export async function buildKeyContext(
  storage: Storage,
  auth: AuthInfo,
  retentionDays: number,
): Promise<KeyContext | null> {
  if (auth.kind !== "key") return null;

  const rows = await storage.db
    .select({
      id: schema.projects.id,
      name: schema.projects.name,
      slug: schema.projects.slug,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, auth.projectId))
    .limit(1);

  const project = rows[0];

  if (!project) return null;

  return {
    project: { id: project.id, name: project.name, slug: project.slug },
    key: {
      id: auth.keyId,
      name: auth.name,
      keyType: auth.keyType,
      scopes: [...auth.scopes],
    },
    capabilities: {
      "logs.read": keyCan(auth, "logs.read"),
      "logs.write": keyCan(auth, "logs.write"),
      "monitors.read": keyCan(auth, "monitors.read"),
      "monitors.write": keyCan(auth, "monitors.write"),
    },
    server: {
      version: APP_VERSION,
      retentionDays,
    },
  };
}
