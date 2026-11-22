/**
 * Token bucket for monitor alert sends, keyed by project and channel.
 *
 * Monitor writers choose their own cooldowns (zero included) and may link any
 * admin-configured channel, so without a budget one project's monitors could
 * turn every ingest batch into a send to a paid or rate-limited destination.
 * Keying by project as well keeps one project's flood from using up another
 * project's alerts on the same channel.
 */

export const SEND_BUDGET_PER_MINUTE = 30;

/** Idle buckets are forgotten after this long; a full bucket is the default. */
const IDLE_MS = 10 * 60_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
  /** Sends skipped since the last recorded suppression notice. */
  suppressed: number;
}

export type BudgetDecision = "send" | "suppress-and-record" | "suppress";

export interface SendBudget {
  take(key: string, now?: number): BudgetDecision;
}

export function createSendBudget(perMinute = SEND_BUDGET_PER_MINUTE): SendBudget {
  const refill = perMinute / 60_000;
  const buckets = new Map<string, Bucket>();
  let lastSweep = 0;

  function sweep(now: number): void {
    if (now - lastSweep < IDLE_MS) return;
    lastSweep = now;

    for (const [key, bucket] of buckets) {
      if (now - bucket.updatedAt >= IDLE_MS) buckets.delete(key);
    }
  }

  return {
    take(key, now = Date.now()) {
      sweep(now);

      const bucket = buckets.get(key) ?? { tokens: perMinute, updatedAt: now, suppressed: 0 };

      bucket.tokens = Math.min(perMinute, bucket.tokens + (now - bucket.updatedAt) * refill);
      bucket.updatedAt = now;
      buckets.set(key, bucket);

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        bucket.suppressed = 0;

        return "send";
      }

      bucket.suppressed += 1;

      // Record the first skipped send of each run so the delivery log shows
      // why alerts stopped, without writing a row per suppressed send.
      return bucket.suppressed === 1 ? "suppress-and-record" : "suppress";
    },
  };
}
