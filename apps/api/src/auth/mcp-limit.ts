/**
 * Server-side rate limit for MCP keys.
 *
 * One token bucket per key id: capacity 10 (the burst), refilled at one token
 * per second (60 requests/minute). It lives in process memory, so it is
 * intentionally best-effort across restarts and API instances. API keys are
 * not affected; their limits stay on the existing routes.
 */

const CAPACITY = 10;
const REFILL_PER_MS = 60 / 60_000;
const IDLE_EVICT_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;

  lastSweep = now;

  for (const [keyId, bucket] of buckets) {
    if (now - bucket.updatedAt > IDLE_EVICT_MS) buckets.delete(keyId);
  }
}

export function allowMcpRequest(keyId: string, now = Date.now()): boolean {
  sweep(now);

  const bucket = buckets.get(keyId);

  if (!bucket) {
    buckets.set(keyId, { tokens: CAPACITY - 1, updatedAt: now });

    return true;
  }

  const elapsed = Math.max(0, now - bucket.updatedAt);

  bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsed * REFILL_PER_MS);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) return false;

  bucket.tokens -= 1;

  return true;
}
