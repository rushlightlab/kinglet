import { describe, expect, it } from "vitest";
import {
  CRON_PRESETS,
  isValidTimezone,
  MIN_SCHEDULE_GAP_MS,
  nextRuns,
  validateCron,
} from "../../src/schedule.js";

const MINUTE = 60_000;

function failure(raw: string, timezone = "UTC"): string {
  const result = validateCron(raw, timezone);

  if (result.ok) throw new Error(`expected ${raw} to fail validation`);

  return result.error;
}

describe("validateCron", () => {
  it("accepts a standard 5-field expression and returns three future runs", () => {
    const before = Date.now();
    const result = validateCron("0 3 * * *", "UTC");

    expect(result.ok).toBe(true);

    if (!result.ok) throw new Error(result.error);
    expect(result.cron).toBe("0 3 * * *");
    expect(result.description.length).toBeGreaterThan(0);
    expect(result.nextRuns).toHaveLength(3);

    let previous = before;

    for (const run of result.nextRuns) {
      expect(run).toBeGreaterThan(previous);
      previous = run;
    }
  });

  it("normalizes supported macros", () => {
    const cases = [
      ["@hourly", "0 * * * *"],
      ["@daily", "0 0 * * *"],
      ["@DAILY", "0 0 * * *"],
      ["@weekly", "0 0 * * 0"],
      ["@monthly", "0 0 1 * *"],
    ] as const;

    for (const [macro, cron] of cases) {
      const result = validateCron(macro, "UTC");

      expect(result.ok).toBe(true);

      if (!result.ok) throw new Error(result.error);
      expect(result.cron).toBe(cron);
    }
  });

  it("rejects unsupported macros", () => {
    expect(failure("@yearly")).toContain("unsupported macro");
    expect(failure("@every 5m")).toContain("unsupported macro");
  });

  it("requires a schedule", () => {
    expect(failure("")).toBe("schedule is required");
    expect(failure("   ")).toBe("schedule is required");
  });

  it("rejects overly long expressions", () => {
    expect(failure(`0 0 ${"1".repeat(200)} * *`)).toContain("schedule is too long");
  });

  it("requires exactly five fields", () => {
    expect(failure("0 3 * *")).toBe(
      "use a 5-field cron expression (minute hour day month weekday)",
    );
    expect(failure("0 0 3 * * *")).toBe(
      "use a 5-field cron expression (minute hour day month weekday)",
    );
  });

  it("rejects question marks in day fields", () => {
    expect(failure("0 3 ? * *")).toBe('use "*" instead of "?" in day fields');
    expect(failure("0 3 * * ?")).toBe('use "*" instead of "?" in day fields');
  });

  it("rejects restricting both day-of-month and day-of-week", () => {
    expect(failure("0 3 1 * 1")).toBe("do not restrict both day-of-month and day-of-week");
    expect(validateCron("0 3 1 * *", "UTC").ok).toBe(true);
    expect(validateCron("0 3 * * 1", "UTC").ok).toBe(true);
  });

  it("rejects invalid cron expressions", () => {
    expect(failure("0 99 * * *")).toContain("invalid cron expression");
    expect(failure("0 3 * * nope")).toContain("invalid cron expression");
  });

  it("rejects a schedule that never fires", () => {
    expect(failure("0 0 31 2 *")).toBe("schedule never fires");
  });

  it("rejects invalid timezones", () => {
    expect(failure("0 3 * * *", "Mars/Phobos")).toBe("invalid timezone");
    expect(failure("0 3 * * *", "")).toBe("invalid timezone");
    expect(validateCron("0 3 * * *", "America/New_York").ok).toBe(true);
  });

  it("applies the timezone when computing runs", () => {
    const runs = nextRuns("0 3 * * *", "America/New_York", 2, new Date("2026-01-01T00:00:00Z"));

    expect(runs[0]).toBe(Date.UTC(2026, 0, 1, 8, 0, 0));
    expect(runs[1]).toBe(Date.UTC(2026, 0, 2, 8, 0, 0));
  });

  it("requires at least 15 minutes between runs", () => {
    expect(MIN_SCHEDULE_GAP_MS).toBe(15 * MINUTE);
    expect(failure("*/10 * * * *")).toBe("schedule must leave at least 15 minutes between runs");
    expect(validateCron("*/15 * * * *", "UTC").ok).toBe(true);
  });

  it("accepts every shipped preset", () => {
    for (const preset of CRON_PRESETS) {
      expect(validateCron(preset.cron, "UTC").ok).toBe(true);
    }
  });

  it("uses the now seam only for the future-run guard", () => {
    // Croner computes runs from the wall clock; `now` only decides whether the
    // first computed run counts as future. These values make that decision
    // deterministic without changing the schedule itself.
    const accepted = validateCron("0 3 * * *", "UTC", 0);

    expect(accepted.ok).toBe(true);

    if (accepted.ok) expect(accepted.nextRuns).toHaveLength(3);

    const stale = validateCron("0 3 * * *", "UTC", Number.MAX_SAFE_INTEGER);

    expect(stale.ok).toBe(false);

    if (!stale.ok) expect(stale.error).toBe("schedule does not produce a future run");
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA names and rejects empty or unknown zones", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("Mars/Phobos")).toBe(false);
    expect(isValidTimezone("UTC+2")).toBe(false);
  });
});

describe("nextRuns", () => {
  it("computes runs from a supplied start date", () => {
    expect(nextRuns("0 3 * * *", "UTC", 3, new Date("2026-01-01T00:00:00Z"))).toEqual([
      Date.UTC(2026, 0, 1, 3, 0, 0),
      Date.UTC(2026, 0, 2, 3, 0, 0),
      Date.UTC(2026, 0, 3, 3, 0, 0),
    ]);
  });

  it("respects the requested count", () => {
    const runs = nextRuns("0 * * * *", "UTC", 1, new Date("2026-01-01T00:00:00Z"));

    expect(runs).toHaveLength(1);
    expect(runs[0]).toBe(Date.UTC(2026, 0, 1, 1, 0, 0));
  });
});
