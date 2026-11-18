import type {
  AlertRecord,
  ApiKeyInfo,
  AppUser,
  ChannelTestResult,
  EventPage,
  Histogram,
  KingletEvent,
  Monitor,
  Project,
  Service,
} from "./types";
import { LEVEL_NAMES } from "./types";
import { createAuthClient } from "better-auth/react";

export class UnauthorizedError extends Error {}

const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "" : window.location.origin,
});

function withProject(path: string, projectId: number): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}project=${projectId}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      signal: AbortSignal.timeout(15_000),
      headers:
        init?.body !== undefined
          ? { "content-type": "application/json", ...(init?.headers ?? {}) }
          : init?.headers,
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
        const body = (await res.json()) as { error?: string; requestId?: string };
        if (body.error) message = body.error;
        if (body.requestId) requestId = body.requestId;
      } catch {
        // body wasn't valid JSON — keep the status message
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
  return (await res.json()) as T;
}

// ---------- auth (Better Auth) ----------

export async function login(email: string, password: string): Promise<void> {
  const { error } = await authClient.signIn.email({ email, password });
  if (error) throw new Error(error.message ?? "invalid email or password");
}

export async function logout(): Promise<void> {
  await authClient.signOut().catch(() => undefined);
}

export async function fetchMe(): Promise<{ user: AppUser; permissions: string[] }> {
  return api<{ user: AppUser; permissions: string[] }>("/v1/me");
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const { error } = await authClient.changePassword({
    currentPassword,
    newPassword,
    revokeOtherSessions: true,
  });
  if (error) throw new Error(error.message ?? "could not change password");
}

// ---------- projects ----------

export function fetchProjects(): Promise<{ projects: Project[] }> {
  return api<{ projects: Project[] }>("/v1/projects");
}

export function createProject(name: string): Promise<{ project: Project }> {
  return api<{ project: Project }>("/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function deleteProject(id: number): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/v1/projects/${id}`, { method: "DELETE" });
}

// ---------- users (admin) ----------

export function fetchUsers(): Promise<{ users: AppUser[] }> {
  return api<{ users: AppUser[] }>("/v1/users");
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

export function updateUser(
  id: string,
  patch: { name?: string; role?: string; password?: string }
): Promise<{ user: AppUser }> {
  return api<{ user: AppUser }>(`/v1/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteUser(id: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/v1/users/${id}`, { method: "DELETE" });
}

// ---------- API keys ----------

export function fetchKeys(projectId: number): Promise<{ keys: ApiKeyInfo[] }> {
  return api<{ keys: ApiKeyInfo[] }>(`/v1/projects/${projectId}/keys`);
}

export function createKey(
  projectId: number,
  input: { name: string; scopes: string[] }
): Promise<{ key: ApiKeyInfo; plaintext: string }> {
  return api<{ key: ApiKeyInfo; plaintext: string }>(`/v1/projects/${projectId}/keys`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteKey(id: number, projectId: number): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/v1/keys/${id}?project=${projectId}`, { method: "DELETE" });
}

// ---------- events ----------

export function fetchEvents(opts: {
  projectId: number;
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

export function fetchHistogram(opts: {
  projectId: number;
  from: number;
  to: number;
  buckets?: number;
}): Promise<Histogram> {
  const params = new URLSearchParams({ from: String(opts.from), to: String(opts.to) });
  if (opts.buckets) params.set("buckets", String(opts.buckets));
  return api<Histogram>(withProject(`/v1/histogram?${params.toString()}`, opts.projectId));
}

export function fetchServices(projectId: number): Promise<{ services: Service[] }> {
  return api<{ services: Service[] }>(withProject("/v1/services", projectId));
}

/** SSE live tail — session cookie auth, so no token in the URL. */
export function openStream(projectId: number, q: string): EventSource {
  const params = new URLSearchParams({ project: String(projectId) });
  if (q) params.set("q", q);
  return new EventSource(`/v1/stream?${params.toString()}`);
}

// ---------- monitors & alerts ----------

export function fetchMonitors(projectId: number): Promise<{ monitors: Monitor[] }> {
  return api<{ monitors: Monitor[] }>(withProject("/v1/monitors", projectId));
}

export function createMonitor(projectId: number, input: Partial<Monitor>): Promise<{ monitor: Monitor }> {
  return api<{ monitor: Monitor }>(withProject("/v1/monitors", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateMonitor(
  projectId: number,
  id: number,
  input: Partial<Monitor>
): Promise<{ monitor: Monitor }> {
  return api<{ monitor: Monitor }>(withProject(`/v1/monitors/${id}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteMonitor(projectId: number, id: number): Promise<{ ok: true }> {
  return api<{ ok: true }>(withProject(`/v1/monitors/${id}`, projectId), { method: "DELETE" });
}

export function testMonitor(projectId: number, id: number): Promise<{ results: ChannelTestResult[] }> {
  return api<{ results: ChannelTestResult[] }>(withProject(`/v1/monitors/${id}/test`, projectId), {
    method: "POST",
  });
}

export function fetchAlerts(projectId: number, limit = 100): Promise<{ alerts: AlertRecord[] }> {
  return api<{ alerts: AlertRecord[] }>(withProject(`/v1/alerts?limit=${limit}`, projectId));
}

// ---------- demo traffic ----------

const DEMO_TEMPLATES: { level: number; message: string }[] = [
  { level: 2, message: "user signed in" },
  { level: 2, message: "request served in 42ms" },
  { level: 2, message: "health check ok" },
  { level: 1, message: "cache miss for user:2049" },
  { level: 1, message: "connection pool resized to 12" },
  { level: 3, message: "slow query detected (812ms)" },
  { level: 3, message: "retrying background job in 2s" },
  { level: 3, message: "queue depth above target: 312 jobs" },
  { level: 4, message: "payment failed: card_declined" },
  { level: 4, message: "connection refused by upstream" },
  { level: 4, message: "rate limit exceeded for key 84f2" },
  { level: 5, message: "queue depth critical: 4096 jobs waiting" },
];

/** Generates some noisy demo traffic, spread over the last hour. */
export async function sprayDemoEvents(projectId: number, count = 80): Promise<void> {
  const services = ["api", "web", "worker", "billing"];
  const now = Date.now();
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const template = DEMO_TEMPLATES[Math.floor(Math.random() * DEMO_TEMPLATES.length)] ?? DEMO_TEMPLATES[0]!;
    lines.push(
      JSON.stringify({
        level: LEVEL_NAMES[template.level],
        message: template.message,
        service: services[Math.floor(Math.random() * services.length)] ?? "api",
        env: "demo",
        ts: now - Math.floor(Math.random() * 55 * 60_000),
        fields: {
          request_id: crypto.randomUUID(),
          region: Math.random() > 0.5 ? "eu-1" : "us-1",
          ms: Math.floor(Math.random() * 900),
        },
      })
    );
  }
  const res = await fetch(withProject("/v1/events", projectId), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/x-ndjson" },
    body: lines.join("\n"),
  });
  if (res.status === 401) throw new UnauthorizedError("unauthorized");
  if (!res.ok) {
    throw new Error(
      res.status >= 500
        ? "the Kinglet API returned an internal error — check the server terminal"
        : `spray failed: HTTP ${res.status}`
    );
  }
}
