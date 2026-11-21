import { describe, expect, it } from "vitest";
import { MAX_SPOOL_BYTES, resolveMaxSpoolBytes } from "../../../src/archive/spool.ts";

describe("MAX_SPOOL_BYTES", () => {
  it("is 1 GiB", () => {
    expect(MAX_SPOOL_BYTES).toBe(1_073_741_824);
  });
});

describe("resolveMaxSpoolBytes", () => {
  it("returns the production cap when no limit is supplied", () => {
    expect(resolveMaxSpoolBytes()).toBe(1_073_741_824);
  });

  it("returns a supplied positive limit unchanged", () => {
    expect(resolveMaxSpoolBytes(4_096)).toBe(4_096);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the invalid limit %s",
    (limit) => {
      expect(() => resolveMaxSpoolBytes(limit)).toThrow(RangeError);
    },
  );
});
