import { Cron } from "croner";
import cronstrue from "cronstrue";

/**
 * Shared cron helpers for backups and archive.
 *
 * Standard 5-field cron only. Seconds fields, `?`, and expressions that
 * restrict both day-of-month and day-of-week are rejected: those are the
 * inputs that surprise operators in a small self-hosted product.
 */

export const MIN_SCHEDULE_GAP_MS = 15 * 60 * 1000;

const MAX_CRON_LENGTH = 120;

const MACROS = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
} satisfies Record<string, string>;

function isMacro(value: string): value is keyof typeof MACROS {
  return value in MACROS;
}

export const CRON_PRESETS = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at 03:00", cron: "0 3 * * *" },
  { label: "Weekly, Monday 03:00", cron: "0 3 * * 1" },
  { label: "Monthly, 1st 03:00", cron: "0 3 1 * *" },
] as const;

export interface CronSchedule {
  cron: string;
  description: string;
  /** Next three run times as epoch milliseconds. */
  nextRuns: number[];
}

export type CronValidation = ({ ok: true } & CronSchedule) | { ok: false; error: string };

function normalize(raw: string): { cron: string } | { error: string } {
  const trimmed = raw.trim();

  if (!trimmed) return { error: "schedule is required" };

  if (trimmed.length > MAX_CRON_LENGTH) {
    return { error: `schedule is too long (max ${MAX_CRON_LENGTH} characters)` };
  }

  const macro = trimmed.toLowerCase();

  if (isMacro(macro)) return { cron: MACROS[macro] };

  if (trimmed.startsWith("@")) return { error: `unsupported macro ${trimmed}` };

  const parts = trimmed.split(/\s+/);

  if (parts.length !== 5) {
    return { error: "use a 5-field cron expression (minute hour day month weekday)" };
  }

  if (parts.some((part) => part === "?")) {
    return { error: 'use "*" instead of "?" in day fields' };
  }

  const [, , dayOfMonth, , dayOfWeek] = parts;

  if (dayOfMonth !== "*" && dayOfWeek !== "*") {
    return { error: "do not restrict both day-of-month and day-of-week" };
  }

  return { cron: parts.join(" ") };
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone.trim()) return false;

  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);

    return true;
  } catch {
    return false;
  }
}

export function describeCron(cron: string): string {
  try {
    const text = cronstrue.toString(cron, {
      use24HourTimeFormat: true,
      throwExceptionOnParseError: false,
    });

    return text.trim() || cron;
  } catch {
    return cron;
  }
}

export function validateCron(raw: string, timezone: string, now = Date.now()): CronValidation {
  const normalized = normalize(raw);

  if ("error" in normalized) return { ok: false, error: normalized.error };

  if (!isValidTimezone(timezone)) return { ok: false, error: "invalid timezone" };

  let runs: Date[];

  try {
    const cron = new Cron(normalized.cron, {
      timezone,
      paused: true,
      mode: "5-part",
    });

    runs = cron.nextRuns(3);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return { ok: false, error: `invalid cron expression: ${message}` };
  }

  if (runs.length === 0) return { ok: false, error: "schedule never fires" };

  const times = runs.map((date) => date.getTime());

  for (let i = 1; i < times.length; i++) {
    const previous = times[i - 1];
    const current = times[i];

    if (
      previous !== undefined &&
      current !== undefined &&
      current - previous < MIN_SCHEDULE_GAP_MS
    ) {
      return { ok: false, error: "schedule must leave at least 15 minutes between runs" };
    }
  }

  const first = times[0];

  if (first === undefined || first <= now) {
    return { ok: false, error: "schedule does not produce a future run" };
  }

  return {
    ok: true,
    cron: normalized.cron,
    description: describeCron(normalized.cron),
    nextRuns: times,
  };
}

/** Next `count` runs for an already-validated expression. */
export function nextRuns(cron: string, timezone: string, count = 3, from?: Date): number[] {
  const job = new Cron(cron, { timezone, paused: true, mode: "5-part" });

  return job.nextRuns(count, from).map((date) => date.getTime());
}

export interface CronScheduler {
  /** Next run as epoch milliseconds, or null when it cannot be computed. */
  readonly nextRunAt: number | null;
  rearm(): void;
  stop(): void;
}

const MAX_TIMER_DELAY = 2_147_483_647;

/**
 * Own setTimeout wrapper. Croner is used only for next-run math, never for its
 * own timer, so settings changes and process shutdown are fully under our
 * control. The callback is expected to do its own single-flight guard.
 */
export function createCronScheduler(options: {
  cron: string;
  timezone: string;
  onTick: () => void;
  onError?: (error: Error) => void;
}): CronScheduler {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let nextRunAt: number | null = null;

  const computeNext = (): number | null => {
    try {
      const job = new Cron(options.cron, {
        timezone: options.timezone,
        paused: true,
        mode: "5-part",
      });

      const next = job.nextRun();

      return next ? next.getTime() : null;
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));

      return null;
    }
  };

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = (): void => {
    clear();

    if (stopped) return;

    nextRunAt = computeNext();

    if (nextRunAt === null) return;

    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, nextRunAt - Date.now()));

    timer = setTimeout(() => {
      timer = null;

      if (stopped) return;

      // The timer cap can wake us early for very distant runs; arm again
      // without firing until the target instant is actually reached.
      if (nextRunAt !== null && Date.now() < nextRunAt) {
        arm();

        return;
      }

      try {
        options.onTick();
      } catch (err) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
      }

      arm();
    }, delay);
    timer.unref();
  };

  arm();

  return {
    get nextRunAt() {
      return nextRunAt;
    },
    rearm: arm,
    stop: () => {
      stopped = true;
      clear();
    },
  };
}
