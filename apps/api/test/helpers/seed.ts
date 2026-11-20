import { eq } from "drizzle-orm";
import type { KingletAuth } from "../../src/auth/auth.ts";
import { createApiKey } from "../../src/auth/apikeys.ts";
import type { ApiKey } from "../../src/auth/apikeys.ts";
import { uuidv7 } from "../../src/auth/ids.ts";
import { scopesForType } from "../../src/auth/roles.ts";
import type { AnyKeyScope, KeyType, Role } from "../../src/auth/roles.ts";
import { createMonitorFromRaw } from "../../src/monitors.ts";
import type { Monitor, MonitorKind } from "../../src/monitors.ts";
import type { ChannelType } from "../../src/notify.ts";
import { getChannelRecord } from "../../src/notifications/store.ts";
import { DEFAULT_NOTIFICATION_ACTIONS } from "../../src/notifications/types.ts";
import type { NotificationAction, NotificationChannel } from "../../src/notifications/types.ts";
import * as schema from "../../src/storage/schema.ts";
import type { Storage } from "../../src/storage/index.ts";

/**
 * Deterministic fixtures for integration tests. Users go through Better Auth
 * (real password hashes and accounts); projects/memberships use Drizzle because
 * the create-project route is the only project factory. Keys, monitors, and
 * channels reuse the production helpers where they exist.
 */

export const TEST_USER_PASSWORD = "TestPass123!";

export interface SeedUserInput {
  email: string;
  name?: string;
  role?: Role;
  password?: string;
}

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  role: Role;
}

export interface SeedProjectInput {
  name: string;
  slug?: string;
  memberIds?: readonly string[];
}

export interface SeededProject {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
}

export interface SeedApiKeyInput {
  projectId: string;
  name: string;
  keyType?: KeyType;
  scopes?: readonly AnyKeyScope[];
  createdBy?: string | null;
}

export interface SeededApiKey {
  key: ApiKey;
  plaintext: string;
}

export interface SeedNotificationChannelInput {
  name?: string;
  type?: ChannelType;
  url?: string;
  actions?: readonly NotificationAction[];
  enabled?: boolean;
  decoration?: boolean;
}

export interface SeedMonitorInput {
  name?: string;
  query?: string;
  kind?: MonitorKind;
  threshold?: number;
  windowMs?: number;
  intervalMs?: number;
  cooldownMs?: number;
  enabled?: boolean;
  channelIds?: readonly string[];
}

export interface SeededTestData {
  member: SeededUser;
  viewer: SeededUser;
  projects: {
    alpha: SeededProject;
    beta: SeededProject;
  };
  keys: {
    alpha: SeededApiKey;
    beta: SeededApiKey;
    mcp: SeededApiKey;
  };
  channel: NotificationChannel;
  monitor: Monitor;
}

export async function seedUser(
  auth: KingletAuth,
  storage: Storage,
  input: SeedUserInput,
): Promise<SeededUser> {
  const email = input.email.toLowerCase();
  const password = input.password ?? TEST_USER_PASSWORD;
  const role = input.role ?? "viewer";

  const created = await auth.api.signUpEmail({
    body: { email, password, name: input.name ?? email },
  });

  const userId = created.user?.id;

  if (userId === undefined) throw new Error(`seedUser: Better Auth did not create ${email}`);

  await storage.db
    .update(schema.user)
    .set({ role, banned: false })
    .where(eq(schema.user.id, userId));

  return { id: userId, email, password, role };
}

export async function seedProject(
  storage: Storage,
  input: SeedProjectInput,
): Promise<SeededProject> {
  const id = uuidv7();
  const slug = input.slug ?? slugify(input.name);
  const createdAt = Date.now();

  await storage.db.insert(schema.projects).values({ id, name: input.name, slug, createdAt });

  for (const userId of input.memberIds ?? []) {
    await storage.db
      .insert(schema.projectMembers)
      .values({ id: uuidv7(), projectId: id, userId, createdAt })
      .onConflictDoNothing();
  }

  return { id, name: input.name, slug, createdAt };
}

export async function seedApiKey(storage: Storage, input: SeedApiKeyInput): Promise<SeededApiKey> {
  const keyType = input.keyType ?? "api";

  return createApiKey(storage, {
    projectId: input.projectId,
    name: input.name,
    keyType,
    scopes: input.scopes ?? scopesForType(keyType),
    createdBy: input.createdBy ?? null,
  });
}

export async function seedNotificationChannel(
  storage: Storage,
  input: SeedNotificationChannelInput = {},
): Promise<NotificationChannel> {
  const id = uuidv7();
  const now = Date.now();
  const type = input.type ?? "webhook";
  const url = input.url ?? "https://example.test/hooks/alpha";
  const actions = input.actions ?? DEFAULT_NOTIFICATION_ACTIONS;

  await storage.db.insert(schema.notificationChannels).values({
    id,
    name: input.name ?? "alpha-webhook",
    type,
    url,
    enabled: input.enabled ?? true,
    decoration: input.decoration ?? false,
    createdAt: now,
    updatedAt: now,
  });

  if (actions.length > 0) {
    await storage.db
      .insert(schema.notificationChannelActions)
      .values(actions.map((action) => ({ channelId: id, action })));
  }

  const channel = await getChannelRecord(storage, id);

  if (channel === null) throw new Error("seedNotificationChannel: channel was not stored");

  return channel;
}

export async function seedMonitor(
  storage: Storage,
  projectId: string,
  input: SeedMonitorInput = {},
): Promise<Monitor> {
  const result = await createMonitorFromRaw(
    storage,
    projectId,
    {
      name: input.name ?? "Alpha errors",
      query: input.query ?? "level>=error",
      kind: input.kind ?? "count_above",
      threshold: input.threshold ?? 5,
      windowMs: input.windowMs ?? 300_000,
      intervalMs: input.intervalMs ?? 60_000,
      cooldownMs: input.cooldownMs ?? 600_000,
      enabled: input.enabled ?? true,
      channelIds: [...(input.channelIds ?? [])],
    },
    { allowPrivateWebhooks: false },
  );

  if (!result.ok) throw new Error(`seedMonitor: ${result.error}`);

  return result.monitor;
}

/** Baseline fixture: two users, two projects, three keys, one channel/monitor. */
export async function seedTestData(storage: Storage, auth: KingletAuth): Promise<SeededTestData> {
  const member = await seedUser(auth, storage, {
    email: "member@example.test",
    name: "Member",
    role: "member",
  });

  const viewer = await seedUser(auth, storage, {
    email: "viewer@example.test",
    name: "Viewer",
    role: "viewer",
  });

  const alpha = await seedProject(storage, {
    name: "Alpha",
    slug: "alpha",
    memberIds: [member.id, viewer.id],
  });

  const beta = await seedProject(storage, { name: "Beta", slug: "beta" });

  return {
    member,
    viewer,
    projects: { alpha, beta },
    keys: {
      alpha: await seedApiKey(storage, {
        projectId: alpha.id,
        name: "alpha-ingest",
        createdBy: member.id,
      }),
      beta: await seedApiKey(storage, {
        projectId: beta.id,
        name: "beta-ingest",
        createdBy: null,
      }),
      mcp: await seedApiKey(storage, {
        projectId: alpha.id,
        name: "alpha-mcp",
        keyType: "mcp",
        scopes: ["logs.read", "monitors.read"],
        createdBy: member.id,
      }),
    },
    channel: await seedNotificationChannel(storage, {
      name: "alpha-webhook",
      url: "https://example.test/hooks/alpha",
    }),
    monitor: await seedMonitor(storage, alpha.id, {
      name: "Alpha errors",
      query: "level>=error",
      kind: "count_above",
      threshold: 5,
    }),
  };
}

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

  return slug === "" ? "project" : slug;
}
