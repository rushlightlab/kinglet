import { describe, expect, it } from "vitest";
import { ALERT_WINDOW_MS, parseAlertReadFilters } from "../../src/alerts.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

describe("parseAlertReadFilters", () => {
  it("keeps all-time behavior when no filter is supplied", () => {
    expect(parseAlertReadFilters({}, NOW)).toEqual({
      ok: true,
      filters: { monitorId: null, state: null, from: null, to: null },
    });
  });

  it("normalizes a monitor id and accepts both states", () => {
    const id = "0190F5B2-7C3A-7DEF-8ABC-0123456789AB";

    expect(parseAlertReadFilters({ monitorId: id, state: "fired" }, NOW)).toEqual({
      ok: true,
      filters: { monitorId: id.toLowerCase(), state: "fired", from: null, to: null },
    });
    expect(parseAlertReadFilters({ state: "resolved" }, NOW)).toEqual({
      ok: true,
      filters: { monitorId: null, state: "resolved", from: null, to: null },
    });
  });

  it("rejects an invalid monitor id and state", () => {
    expect(parseAlertReadFilters({ monitorId: "not-a-uuid" }, NOW)).toEqual({
      ok: false,
      error: "invalid monitor id",
    });
    expect(parseAlertReadFilters({ state: "open" }, NOW)).toEqual({
      ok: false,
      error: "state must be fired or resolved",
    });
  });

  it("accepts an ordered window inside 31 days", () => {
    const from = NOW - 2 * MINUTE;
    const to = NOW - MINUTE;

    expect(parseAlertReadFilters({ from: String(from), to: String(to) }, NOW)).toEqual({
      ok: true,
      filters: { monitorId: null, state: null, from, to },
    });
  });

  it("rejects inverted, malformed, and zero bounds", () => {
    expect(parseAlertReadFilters({ from: String(NOW), to: String(NOW - 1) }, NOW)).toEqual({
      ok: false,
      error: "from must be before to",
    });

    for (const value of ["abc", "1.5", "0", "-1"]) {
      expect(parseAlertReadFilters({ from: value }, NOW)).toEqual({
        ok: false,
        error: "from/to must be epoch milliseconds",
      });
    }

    expect(parseAlertReadFilters({ to: "not-a-number" }, NOW)).toEqual({
      ok: false,
      error: "from/to must be epoch milliseconds",
    });
  });

  it("clamps a longer range to 31 days", () => {
    const to = NOW;
    const from = NOW - 40 * 24 * 60 * MINUTE;

    expect(parseAlertReadFilters({ from: String(from), to: String(to) }, NOW)).toEqual({
      ok: true,
      filters: {
        monitorId: null,
        state: null,
        from: to - ALERT_WINDOW_MS,
        to,
      },
    });
  });

  it("clamps an old from-only bound against now", () => {
    const from = NOW - 40 * 24 * 60 * MINUTE;

    expect(parseAlertReadFilters({ from: String(from) }, NOW)).toEqual({
      ok: true,
      filters: {
        monitorId: null,
        state: null,
        from: NOW - ALERT_WINDOW_MS,
        to: NOW,
      },
    });
  });

  it("turns a to-only bound into a 31-day window ending at it", () => {
    const to = NOW - 10 * MINUTE;

    expect(parseAlertReadFilters({ to: String(to) }, NOW)).toEqual({
      ok: true,
      filters: {
        monitorId: null,
        state: null,
        from: to - ALERT_WINDOW_MS,
        to,
      },
    });
  });

  it("clamps future skew and rejects a from beyond it", () => {
    const to = NOW + 60 * MINUTE;

    expect(parseAlertReadFilters({ to: String(to) }, NOW)).toEqual({
      ok: true,
      filters: {
        monitorId: null,
        state: null,
        from: NOW + 5 * MINUTE - ALERT_WINDOW_MS,
        to: NOW + 5 * MINUTE,
      },
    });

    expect(parseAlertReadFilters({ from: String(NOW + 60 * MINUTE) }, NOW)).toEqual({
      ok: false,
      error: "from must be before to",
    });
  });
});
