import type { EventPage, Histogram, KingletEvent, Service } from "./types";
import { LEVEL_NAMES } from "./types";

const TOKEN_KEY = "kinglet.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class UnauthorizedError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${getToken() ?? ""}` },
  });
  if (res.status === 401) throw new UnauthorizedError("token rejected");
  if (!res.ok) throw new Error(`request failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function fetchEvents(opts: { q?: string; from?: number; to?: number; limit?: number }): Promise<EventPage> {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.from) params.set("from", String(opts.from));
  if (opts.to) params.set("to", String(opts.to));
  if (opts.limit) params.set("limit", String(opts.limit));
  return api<EventPage>(`/v1/events?${params.toString()}`);
}

export function fetchHistogram(opts: { from: number; to: number; buckets?: number }): Promise<Histogram> {
  const params = new URLSearchParams({ from: String(opts.from), to: String(opts.to) });
  if (opts.buckets) params.set("buckets", String(opts.buckets));
  return api<Histogram>(`/v1/histogram?${params.toString()}`);
}

export function fetchServices(): Promise<{ services: Service[] }> {
  return api<{ services: Service[] }>("/v1/services");
}

/** SSE live tail. EventSource can't send headers, so the token rides as a query param. */
export function openStream(q: string): EventSource {
  const params = new URLSearchParams({ token: getToken() ?? "" });
  if (q) params.set("q", q);
  return new EventSource(`/v1/stream?${params.toString()}`);
}

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
export async function sprayDemoEvents(count = 80): Promise<void> {
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
  const res = await fetch("/v1/events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${getToken() ?? ""}`,
      "content-type": "application/x-ndjson",
    },
    body: lines.join("\n"),
  });
  if (!res.ok) {
    if (res.status === 401) throw new UnauthorizedError("token rejected");
    throw new Error(`spray failed: HTTP ${res.status}`);
  }
}
