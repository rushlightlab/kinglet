#!/usr/bin/env node
/**
 * Local ingest/query benchmark for Kinglet.
 *
 * This creates a project API key and writes throwaway events. Point it at a
 * disposable local instance only. By default it refuses non-loopback URLs.
 *
 * Usage:
 *   KINGLET_BENCH_URL=http://localhost:8080 \
 *   KINGLET_BENCH_EMAIL=admin@kinglet.local \
 *   KINGLET_BENCH_PASSWORD=... pnpm bench
 *
 * Optional:
 *   KINGLET_BENCH_INGEST_SECONDS=8
 *   KINGLET_BENCH_QUERY_SECONDS=5
 *   KINGLET_BENCH_CONCURRENCY=4
 *   KINGLET_BENCH_ALLOW_REMOTE=1   # explicitly allow a non-loopback URL
 */

const base = (process.env.KINGLET_BENCH_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const email = process.env.KINGLET_BENCH_EMAIL;
const password = process.env.KINGLET_BENCH_PASSWORD;
const ingestSeconds = Number(process.env.KINGLET_BENCH_INGEST_SECONDS ?? 8);
const querySeconds = Number(process.env.KINGLET_BENCH_QUERY_SECONDS ?? 5);
const concurrency = Number(process.env.KINGLET_BENCH_CONCURRENCY ?? 4);

if (!email || !password) {
  console.error("Set KINGLET_BENCH_EMAIL and KINGLET_BENCH_PASSWORD.");
  process.exit(1);
}

const host = new URL(base).hostname;
const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";

if (!loopback && process.env.KINGLET_BENCH_ALLOW_REMOTE !== "1") {
  console.error(
    "Refusing a non-loopback benchmark URL. Set KINGLET_BENCH_ALLOW_REMOTE=1 to override.",
  );
  process.exit(1);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);

  return sorted[index];
}

async function signIn() {
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  const cookies = response.headers.getSetCookie();

  if (cookies.length === 0) throw new Error("sign-in returned no cookies");

  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function api(path, cookie, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      cookie,
      origin: base,
      "x-kinglet-request": "1",
      ...options.headers,
    },
  });

  const text = await response.text();
  let body = null;

  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text.slice(0, 200)}`);

  return body;
}

function makeEvents(count, start, padding) {
  const ts = Date.now();
  const events = [];

  for (let i = 0; i < count; i++) {
    events.push({
      ts: ts + i,
      level: i % 20 === 0 ? "error" : "info",
      service: i % 3 === 0 ? "api" : "web",
      env: "bench",
      message: `bench-${start + i}-${"x".repeat(padding)}`,
      fields: { seq: start + i, ok: true },
    });
  }

  return events;
}

async function ingestBatch(key, count, start, padding) {
  const events = makeEvents(count, start, padding);
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  const started = performance.now();

  const response = await fetch(`${base}/v1/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-ndjson",
    },
    body,
  });

  const latency = performance.now() - started;
  const text = await response.text();

  if (!response.ok) throw new Error(`ingest failed: ${response.status} ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text);

  return { accepted: parsed.accepted, truncated: parsed.truncated === true, latency };
}

async function main() {
  const cookie = await signIn();
  const projects = await api("/v1/projects", cookie);
  const project = projects.projects[0];

  if (!project) throw new Error("no project found");

  const created = await api(`/v1/projects/${project.id}/keys`, cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `bench-${Date.now()}`, scopes: ["ingest", "query"] }),
  });

  const key = created.plaintext;

  let seq = 0;
  const maxBatch = await ingestBatch(key, 10_000, seq, 40);
  seq += 10_000;
  const overflow = await ingestBatch(key, 10_001, seq, 40);
  seq += 10_001;

  const ingestLatencies = [];
  let ingestAccepted = 0;
  let ingestErrors = 0;
  const ingestStarted = performance.now();
  const ingestDeadline = ingestStarted + ingestSeconds * 1_000;

  async function ingestWorker() {
    while (performance.now() < ingestDeadline) {
      try {
        const result = await ingestBatch(key, 1_000, seq, 40);
        seq += 1_000;
        ingestAccepted += result.accepted;
        ingestLatencies.push(result.latency);
      } catch {
        ingestErrors++;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => ingestWorker()));
  const ingestElapsed = performance.now() - ingestStarted;

  const queryLatencies = [];
  let queryErrors = 0;
  const queryStarted = performance.now();
  const queryDeadline = queryStarted + querySeconds * 1_000;

  async function queryWorker() {
    while (performance.now() < queryDeadline) {
      const started = performance.now();

      try {
        const response = await fetch(`${base}/v1/events?q=bench&limit=100`, {
          headers: { authorization: `Bearer ${key}` },
        });

        if (!response.ok) throw new Error(String(response.status));
        await response.arrayBuffer();
        queryLatencies.push(performance.now() - started);
      } catch {
        queryErrors++;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => queryWorker()));
  const queryElapsed = performance.now() - queryStarted;

  console.log(
    JSON.stringify(
      {
        url: base,
        maxBatch: {
          accepted: maxBatch.accepted,
          truncated: maxBatch.truncated,
          latencyMs: Math.round(maxBatch.latency),
        },
        overflow: { accepted: overflow.accepted, truncated: overflow.truncated },
        ingest: {
          accepted: ingestAccepted,
          errors: ingestErrors,
          requests: ingestLatencies.length,
          elapsedMs: Math.round(ingestElapsed),
          eventsPerSecond: Math.round((ingestAccepted / ingestElapsed) * 1000),
          requestsPerSecond: Number(((ingestLatencies.length / ingestElapsed) * 1000).toFixed(1)),
          p50Ms: Math.round(percentile(ingestLatencies, 50) ?? 0),
          p95Ms: Math.round(percentile(ingestLatencies, 95) ?? 0),
        },
        query: {
          requests: queryLatencies.length,
          errors: queryErrors,
          elapsedMs: Math.round(queryElapsed),
          requestsPerSecond: Number(((queryLatencies.length / queryElapsed) * 1000).toFixed(1)),
          p50Ms: Math.round(percentile(queryLatencies, 50) ?? 0),
          p95Ms: Math.round(percentile(queryLatencies, 95) ?? 0),
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
