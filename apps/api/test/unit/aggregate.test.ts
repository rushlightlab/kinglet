import { describe, expect, it } from "vitest";
import {
  AGGREGATE_GROUP_BYS,
  DEFAULT_AGGREGATE_GROUPS,
  MAX_AGGREGATE_GROUPS,
  isAggregateGroupBy,
  toAggregateGroups,
} from "../../src/aggregate.ts";

describe("isAggregateGroupBy", () => {
  it("accepts exactly the three supported dimensions", () => {
    expect(AGGREGATE_GROUP_BYS).toEqual(["service", "level", "env"]);

    for (const value of AGGREGATE_GROUP_BYS) {
      expect(isAggregateGroupBy(value)).toBe(true);
    }
  });

  it("rejects arbitrary columns, expressions, and casing", () => {
    for (const value of ["message", "fields", "levelName", "SERVICE", "", "service,level"]) {
      expect(isAggregateGroupBy(value)).toBe(false);
    }
  });

  it("keeps the public group limits stable", () => {
    expect(DEFAULT_AGGREGATE_GROUPS).toBe(50);
    expect(MAX_AGGREGATE_GROUPS).toBe(200);
  });
});

describe("toAggregateGroups", () => {
  it("maps level numbers to names", () => {
    const groups = toAggregateGroups([
      { dimension: "level", key: 0, count: 1 },
      { dimension: "level", key: 1, count: 2 },
      { dimension: "level", key: 2, count: 3 },
      { dimension: "level", key: 3, count: 4 },
      { dimension: "level", key: 4, count: 5 },
      { dimension: "level", key: 5, count: 6 },
    ]);

    expect(groups).toEqual([
      { key: "trace", count: 1 },
      { key: "debug", count: 2 },
      { key: "info", count: 3 },
      { key: "warn", count: 4 },
      { key: "error", count: 5 },
      { key: "fatal", count: 6 },
    ]);
  });

  it("keeps null groups for service and env", () => {
    expect(
      toAggregateGroups([
        { dimension: "service", key: "api", count: 7 },
        { dimension: "service", key: null, count: 2 },
      ]),
    ).toEqual([
      { key: "api", count: 7 },
      { key: null, count: 2 },
    ]);

    expect(toAggregateGroups([{ dimension: "env", key: null, count: 1 }])).toEqual([
      { key: null, count: 1 },
    ]);
  });

  it("returns a readable fallback for out-of-range level rows", () => {
    expect(
      toAggregateGroups([
        { dimension: "level", key: 6, count: 1 },
        { dimension: "level", key: -1, count: 2 },
        { dimension: "level", key: 1.5, count: 3 },
      ]),
    ).toEqual([
      { key: "unknown", count: 1 },
      { key: "unknown", count: 2 },
      { key: "unknown", count: 3 },
    ]);
  });

  it("preserves counts and order", () => {
    expect(
      toAggregateGroups([
        { dimension: "service", key: "web", count: 9 },
        { dimension: "service", key: "api", count: 4 },
      ]),
    ).toEqual([
      { key: "web", count: 9 },
      { key: "api", count: 4 },
    ]);
  });
});
