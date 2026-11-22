import { isJsonObject, isString } from "./json";
import type {
  AlertRecord,
  ApiKeyInfo,
  AppUser,
  ArchiveSettings,
  BackupSchedulePreview,
  BackupSettings,
  BackupSettingsInput,
  BackupSnapshot,
  BackupStatus,
  ChannelTestResult,
  ClearPreview,
  EventPage,
  Histogram,
  KeyType,
  Monitor,
  NotificationChannel,
  NotificationChannelInput,
  NotificationChannelSummary,
  NotificationDelivery,
  NotifyChannel,
  Project,
  ProjectMember,
  Service,
} from "./types";
import type { Vocabulary } from "./query";
import { createAuthClient } from "better-auth/react";

export class UnauthorizedError extends Error {}

const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "" : window.location.origin,
});

function withProject(path: string, projectId: string): string {
  const separator = path.includes("?") ? "&" : "?";

  return `${path}${separator}project=${projectId}`;
}

/** One page of a table: `limit` rows from `offset`, matching `q`. */
export interface PageQuery {
  limit: number;
  offset: number;
  q: string;
}

/** Adds a table page to a list path; without one, the server returns every row. */
function withPage(path: string, page: PageQuery | undefined): string {
  if (page === undefined) return path;
  const params = new URLSearchParams({ limit: String(page.limit), offset: String(page.offset) });
  const q = page.q.trim();

  if (q !== "") params.set("q", q);

  return `${path}${path.includes("?") ? "&" : "?"}${params.toString()}`;
}

async function api<T>(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  let res: Response;
  // The marker header is required by the server's CSRF guard for
  // cookie-authenticated mutations; cross-site forms cannot set it.
  const headers = new Headers(init?.headers);
  headers.set("x-kinglet-request", "1");

  if (init?.body !== undefined) headers.set("content-type", "application/json");

  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
  } catch (err) {
    throw new Error("Cannot reach the Kinglet API — is the server running?", { cause: err });
  }

  if (res.status === 401) {
    if (path !== "/v1/me") {
      window.dispatchEvent(new CustomEvent("kinglet:unauthorized"));
    }

    throw new UnauthorizedError("unauthorized");
  }

  if (!res.ok) {
    const contentType = res.headers.get("content-type") ?? "";
    let message = `request failed: HTTP ${res.status}`;
    let requestId: string | null = null;

    if (contentType.includes("application/json")) {
      try {
        const body: unknown = await res.json();

        if (isJsonObject(body)) {
          if (isString(body.error)) message = body.error;

          if (isString(body.requestId)) requestId = body.requestId;
        }
      } catch {
        // body wasn't valid JSON - keep the status message
      }
    } else if (res.status >= 500) {
      message =
        "the Kinglet API returned an internal error — the server likely crashed or hit a bug. Check its terminal output";
    }

    throw new Error(requestId ? `${message} (request ${requestId})` : message);
  }

  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error("the Kinglet API returned a non-JSON response (likely a proxy error page)");
  }

  // SAFETY: the Kinglet server owns this response contract; `T` is the
  // caller's declaration of the endpoint payload and the API version is pinned.
  return (await res.json()) as T;
}

// ---------- auth (Better Auth) ----------

export async function login(email: string, password: string): Promise<void> {
  const { error } = await authClient.signIn.email({ email, password });

  if (error) throw new Error(error.message ?? "invalid email or password");
}

export async function logout(): Promise<void> {
  const { error } = await authClient.signOut();

  if (error) throw new Error(error.message ?? "could not sign out");
}

export async function fetchMe(): Promise<{ user: AppUser; permissions: string[] }> {
  return api<{ user: AppUser; permissions: string[] }>("/v1/me");
}

/**
 * Signs out the other sessions. With `revokeApiKeys` the server also deletes
 * the API and MCP keys this user created, so a key minted from a stolen
 * session cannot outlive the change.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
  revokeApiKeys: boolean,
): Promise<void> {
  const { error } = await authClient.$fetch<unknown>("/change-password", {
    method: "POST",
    body: { currentPassword, newPassword, revokeOtherSessions: true, revokeApiKeys },
  });

  if (error) throw new Error(error.message ?? "could not change password");
}

// ---------- projects ----------

export function fetchProjects(page?: PageQuery): Promise<{ projects: Project[]; total: number }> {
  return api<{ projects: Project[]; total: number }>(withPage("/v1/projects", page));
}

export function createProject(name: string): Promise<{ project: Project }> {
  return api<{ project: Project }>("/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function deleteProject(id: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/v1/projects/${id}`, { method: "DELETE" });
}

export function renameProject(id: string, name: string): Promise<{ project: Project }> {
  return api<{ project: Project }>(`/v1/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

// ---------- project members (admin) ----------

export function fetchProjectMembers(
  projectId: string,
  page?: PageQuery,
): Promise<{ members: ProjectMember[]; total: number }> {
  return api<{ members: ProjectMember[]; total: number }>(
    withPage(`/v1/projects/${projectId}/members`, page),
  );
}

export function addProjectMember(projectId: string, userId: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/v1/projects/${projectId}/members`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

export function removeProjectMember(projectId: string, userId: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/v1/projects/${projectId}/members/${userId}`, {
    method: "DELETE",
  });
}

export function updateProjectMember(
  projectId: string,
  userId: string,
  body: { canClearLogs: boolean },
): Promise<{ ok: true; canClearLogs: boolean }> {
  return api<{ ok: true; canClearLogs: boolean }>(`/v1/projects/${projectId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ---------- users (admin) ----------

export function fetchUsers(page?: PageQuery): Promise<{ users: AppUser[]; total: number }> {
  return api<{ users: AppUser[]; total: number }>(withPage("/v1/users", page));
}

export function createUser(input: {
  email: string;
  name: string;
  role: string;
  password?: string;
}): Promise<{ user: AppUser; password?: string }> {
  return api<{ user: AppUser; password?: string }>("/v1/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** The fields an administrator can change on a user. */
export interface UserPatch {
  name?: string;
  role?: string;
  disabled?: boolean;
}

export function updateUser(id: string, patch: UserPatch): Promise<{ user: AppUser }> {
  return api<{ user: AppUser }>(`/v1/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function resetUserPassword(id: string): Promise<{ password: string }> {
  return api<{ password: string }>(`/v1/users/${id}/reset-password`, { method: "POST" });
}

export function deleteUser(id: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/v1/users/${id}`, { method: "DELETE" });
}

// ---------- API keys ----------

export function fetchKeys(
  projectId: string,
  type?: KeyType,
  page?: PageQuery,
): Promise<{ keys: ApiKeyInfo[]; total: number }> {
  const path = `/v1/projects/${projectId}/keys${type ? `?type=${type}` : ""}`;

  return api<{ keys: ApiKeyInfo[]; total: number }>(withPage(path, page));
}

export function createKey(
  projectId: string,
  input: { name: string; scopes: string[]; keyType?: KeyType },
): Promise<{ key: ApiKeyInfo; plaintext: string }> {
  return api<{ key: ApiKeyInfo; plaintext: string }>(`/v1/projects/${projectId}/keys`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteKey(id: string, projectId: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/v1/keys/${id}?project=${projectId}`, { method: "DELETE" });
}

export function updateKeyScopes(
  id: string,
  projectId: string,
  scopes: string[],
): Promise<{ ok: true; scopes: string[] }> {
  return api<{ ok: true; scopes: string[] }>(`/v1/keys/${id}?project=${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ scopes }),
  });
}

export function rotateKey(
  id: string,
  projectId: string,
): Promise<{ plaintext: string; prefix: string }> {
  return api<{ plaintext: string; prefix: string }>(`/v1/keys/${id}/rotate?project=${projectId}`, {
    method: "POST",
  });
}

// ---------- events ----------

export function fetchEvents(opts: {
  projectId: string;
  q?: string;
  from?: number;
  to?: number;
  limit?: number;
}): Promise<EventPage> {
  const params = new URLSearchParams();

  if (opts.q) params.set("q", opts.q);

  if (opts.from) params.set("from", String(opts.from));

  if (opts.to) params.set("to", String(opts.to));

  if (opts.limit) params.set("limit", String(opts.limit));

  return api<EventPage>(withProject(`/v1/events?${params.toString()}`, opts.projectId));
}

/** Deletes events in the project, optionally within an epoch-ms range. */
/** What to clear: an optional time range and an optional Trill query. */
export interface ClearSelection {
  range?: { from: number; to: number };
  q?: string;
}

function clearParams(projectId: string, selection: ClearSelection): URLSearchParams {
  const params = new URLSearchParams({ project: String(projectId) });

  if (selection.range) {
    params.set("from", String(selection.range.from));
    params.set("to", String(selection.range.to));
  }

  if (selection.q?.trim()) params.set("q", selection.q.trim());

  return params;
}

export function clearProjectLogs(
  projectId: string,
  selection: ClearSelection = {},
): Promise<{ deleted: number; projectId: string; from?: number; to?: number; q?: string }> {
  return api<{ deleted: number; projectId: string; from?: number; to?: number; q?: string }>(
    `/v1/events?${clearParams(projectId, selection).toString()}`,
    { method: "DELETE" },
  );
}

/** Count, per-service breakdown, and newest examples of what a clear would delete. */
export function fetchClearPreview(
  projectId: string,
  selection: ClearSelection = {},
): Promise<ClearPreview> {
  return api<ClearPreview>(
    `/v1/events/clear/preview?${clearParams(projectId, selection).toString()}`,
  );
}

export function fetchHistogram(opts: {
  projectId: string;
  from: number;
  to: number;
  buckets?: number;
  q?: string;
}): Promise<Histogram> {
  const params = new URLSearchParams({ from: String(opts.from), to: String(opts.to) });

  if (opts.buckets) params.set("buckets", String(opts.buckets));

  if (opts.q?.trim()) params.set("q", opts.q);

  return api<Histogram>(withProject(`/v1/histogram?${params.toString()}`, opts.projectId));
}

/** Field keys, types, and common values from recent events, for query autocomplete. */
export function fetchFieldVocabulary(projectId: string): Promise<Vocabulary> {
  return api<Vocabulary>(withProject("/v1/fields", projectId));
}

export function fetchServices(projectId: string): Promise<{ services: Service[] }> {
  return api<{ services: Service[] }>(withProject("/v1/services", projectId));
}

/** SSE live tail — session cookie auth, so no token in the URL. */
export function openStream(projectId: string, q: string): EventSource {
  const params = new URLSearchParams({ project: String(projectId) });

  if (q) params.set("q", q);

  return new EventSource(`/v1/stream?${params.toString()}`);
}

// ---------- monitors & alerts ----------

export function fetchMonitors(
  projectId: string,
  page?: PageQuery,
): Promise<{ monitors: Monitor[]; total: number }> {
  return api<{ monitors: Monitor[]; total: number }>(
    withPage(withProject("/v1/monitors", projectId), page),
  );
}

export function createMonitor(
  projectId: string,
  input: Partial<Monitor>,
): Promise<{ monitor: Monitor }> {
  return api<{ monitor: Monitor }>(withProject("/v1/monitors", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateMonitor(
  projectId: string,
  id: string,
  input: Partial<Monitor>,
): Promise<{ monitor: Monitor }> {
  return api<{ monitor: Monitor }>(withProject(`/v1/monitors/${id}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteMonitor(projectId: string, id: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(withProject(`/v1/monitors/${id}`, projectId), { method: "DELETE" });
}

export function testMonitor(
  projectId: string,
  id: string,
): Promise<{ results: ChannelTestResult[] }> {
  return api<{ results: ChannelTestResult[] }>(withProject(`/v1/monitors/${id}/test`, projectId), {
    method: "POST",
  });
}

/** Test an unsaved channel from the monitor form. */
export function testChannel(projectId: string, channel: NotifyChannel): Promise<{ ok: true }> {
  return api<{ ok: true }>(withProject("/v1/monitors/test-channel", projectId), {
    method: "POST",
    body: JSON.stringify(channel),
  });
}

export function fetchAlerts(
  projectId: string,
  page?: PageQuery,
): Promise<{ alerts: AlertRecord[]; total: number }> {
  return api<{ alerts: AlertRecord[]; total: number }>(
    withPage(withProject("/v1/alerts", projectId), page),
  );
}

// ---------- system events (SSE) ----------

/**
 * Admin SSE feed for backup, restore, and archive work. Cookie auth, so no
 * token in the URL. Listeners must use addEventListener(eventName), the
 * server sends named events rather than the default `message`.
 */
export function openSystemEvents(): EventSource {
  return new EventSource("/v1/system/events");
}

// ---------- backups ----------

export function fetchBackupStatus(): Promise<{ status: BackupStatus }> {
  return api<{ status: BackupStatus }>("/v1/backups/status");
}

export function fetchBackups(
  refresh = false,
  page?: PageQuery,
): Promise<{
  snapshots: BackupSnapshot[];
  total: number;
  warning?: string;
}> {
  return api<{ snapshots: BackupSnapshot[]; total: number; warning?: string }>(
    withPage(refresh ? "/v1/backups?refresh=1" : "/v1/backups", page),
  );
}

export function fetchBackupSettings(): Promise<{ settings: BackupSettings }> {
  return api<{ settings: BackupSettings }>("/v1/backups/settings");
}

export function updateBackupSettings(
  input: BackupSettingsInput,
): Promise<{ settings: BackupSettings; nextRuns: number[] }> {
  return api<{ settings: BackupSettings; nextRuns: number[] }>("/v1/backups/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function previewBackupSchedule(
  cron: string,
  timezone: string,
): Promise<BackupSchedulePreview> {
  const params = new URLSearchParams({ cron, timezone });

  return api<BackupSchedulePreview>(`/v1/backups/schedule/preview?${params.toString()}`);
}

export function runBackup(): Promise<{ runId: string }> {
  return api<{ runId: string }>("/v1/backups/run", { method: "POST" });
}

/** A bucket round trip can outlive the default request timeout. */
export function testBackupConnection(): Promise<{ ok: true }> {
  return api<{ ok: true }>("/v1/backups/test-connection", { method: "POST" }, 30_000);
}

export function downloadBackup(
  id: string,
): Promise<{ url: string; filename: string; expiresAt: number }> {
  return api<{ url: string; filename: string; expiresAt: number }>(`/v1/backups/${id}/download`);
}

/** Stages a restore; the server applies it at the next boot. */
export function restoreBackup(
  id: string,
): Promise<{ ok: true; id?: string; restartRequired?: boolean }> {
  return api<{ ok: true; id?: string; restartRequired?: boolean }>(
    `/v1/backups/${id}/restore`,
    { method: "POST" },
    60_000,
  );
}

export function deleteBackup(id: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/v1/backups/${id}`, { method: "DELETE" });
}

// ---------- archive ----------

export function fetchArchiveSettings(): Promise<{ settings: ArchiveSettings }> {
  return api<{ settings: ArchiveSettings }>("/v1/archive/settings");
}

export function updateArchiveSettings(
  input: Partial<ArchiveSettings>,
): Promise<{ settings: ArchiveSettings }> {
  return api<{ settings: ArchiveSettings }>("/v1/archive/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function setProjectArchive(
  projectId: string,
  enabled: boolean,
): Promise<{ ok: true; enabled: boolean }> {
  return api<{ ok: true; enabled: boolean }>(`/v1/projects/${projectId}/archive`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

// ---------- notification channels ----------

export function fetchNotificationChannels(
  page?: PageQuery,
): Promise<{ channels: NotificationChannel[]; total: number }> {
  return api<{ channels: NotificationChannel[]; total: number }>(
    withPage("/v1/notifications/channels", page),
  );
}

/** What the channel form can offer: email needs an SMTP server in the env. */
/** What the channel form can offer: email needs SMTP, every channel needs KINGLET_SECRET_KEY. */
export interface NotificationCapabilities {
  email: { configured: boolean; from: string | null };
  secrets: { configured: boolean };
}

export function fetchNotificationCapabilities(): Promise<NotificationCapabilities> {
  return api<NotificationCapabilities>("/v1/notifications/capabilities");
}

/** Admin-only read that returns the unmasked URL for the edit dialog. */
export function fetchNotificationChannel(id: string): Promise<{ channel: NotificationChannel }> {
  return api<{ channel: NotificationChannel }>(`/v1/notifications/channels/${id}`);
}

export function createNotificationChannel(
  input: NotificationChannelInput,
): Promise<{ channel: NotificationChannel }> {
  return api<{ channel: NotificationChannel }>("/v1/notifications/channels", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateNotificationChannel(
  id: string,
  patch: Partial<NotificationChannelInput>,
): Promise<{ channel: NotificationChannel }> {
  return api<{ channel: NotificationChannel }>(`/v1/notifications/channels/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteNotificationChannel(id: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/v1/notifications/channels/${id}`, { method: "DELETE" });
}

export function testNotificationChannel(id: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/v1/notifications/channels/${id}/test`, { method: "POST" }, 30_000);
}

/** Monitor editors use this: id, name, type, enabled, and health only. */
export function fetchNotificationChannelSummary(): Promise<{
  channels: NotificationChannelSummary[];
}> {
  return api<{ channels: NotificationChannelSummary[] }>("/v1/notifications/channels/summary");
}

export function fetchNotificationDeliveries(
  page?: PageQuery,
): Promise<{ deliveries: NotificationDelivery[]; total: number }> {
  return api<{ deliveries: NotificationDelivery[]; total: number }>(
    withPage("/v1/notifications/deliveries", page),
  );
}
