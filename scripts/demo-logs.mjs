#!/usr/bin/env node
/**
 * Streams demo logs into a Kinglet instance so you can watch the live tail,
 * histogram, filters, and monitors do their thing.
 *
 * Usage:
 *   pnpm demo:logs                      # dev API on :3000
 *   pnpm demo:logs --once               # backfill 40 events, then exit
 *   KINGLET_URL=http://localhost:8080 KINGLET_KEY=kl_... pnpm demo:logs
 *
 * The key is resolved from (in order): argv or KINGLET_KEY. It must be a
 * project API key with the ingest scope.
 */
function resolveKey(explicit) {
  if (explicit) return explicit;

  if (process.env.KINGLET_KEY) return process.env.KINGLET_KEY;
  console.error(
    "No API key. Create a project API key with the ingest scope in the UI, " +
      "then pass it as an argument or set KINGLET_KEY.",
  );
  process.exit(1);
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const once = process.argv.includes("--once");
const url = positional[0] ?? process.env.KINGLET_URL ?? "http://localhost:3000";
const key = resolveKey(positional[1]);
const endpoint = url.replace(/\/+$/, "") + "/v1/events";

const SERVICES = ["api", "web", "worker", "billing"];
const LEVELS = ["debug", "info", "info", "info", "info", "warn", "warn", "error", "fatal"];

const MESSAGES = [
  "user signed in",
  "request served in 42ms",
  "cache miss for user:2049",
  "health check ok",
  "connection pool resized to 12",
  "slow query detected (812ms)",
  "retrying background job in 2s",
  "queue depth above target: 312 jobs",
  "payment failed: card_declined",
  "connection refused by upstream",
  "rate limit exceeded for key 84f2",
  "queue depth critical: 4096 jobs waiting",
  "job completed",
  "password reset email sent",
  "webhook delivered in 88ms",
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function event(ts = Date.now()) {
  return JSON.stringify({
    level: pick(LEVELS),
    message: pick(MESSAGES),
    service: pick(SERVICES),
    env: "dev",
    ts,
    fields: {
      request_id: crypto.randomUUID(),
      region: Math.random() > 0.5 ? "eu-1" : "us-1",
      ms: Math.floor(Math.random() * 900),
    },
  });
}

async function send(lines) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-ndjson" },
    body: lines.join("\n"),
  });

  if (!res.ok) throw new Error(`ingest failed: HTTP ${res.status} ${await res.text()}`);
}

// Backfill ~40 events over the last hour so the histogram has real shape.
const now = Date.now();
const burst = Array.from({ length: 40 }, (_, i) => event(now - Math.floor((i / 40) * 55 * 60_000)));

await send(burst);

console.log(`→ ${endpoint} · backfilled 40 events over the last hour`);

if (once) process.exit(0);

// Continuous stream: one event every ~1.5s.
let count = 0;

setInterval(async () => {
  try {
    await send([event()]);
    count++;

    if (count % 10 === 0) console.log(`→ sent ${count} events (Ctrl+C to stop)`);
  } catch (err) {
    console.error(String(err));
  }
}, 1500);
