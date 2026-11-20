import { describe, expect, it } from "vitest";
import { isUuid, uuidv7 } from "../../src/auth/ids.js";

describe("uuidv7", () => {
  it("produces a version 7 UUID with the RFC 4122 variant", () => {
    const value = uuidv7();

    expect(isUuid(value)).toBe(true);
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is unique across calls", () => {
    const values = new Set(Array.from({ length: 200 }, () => uuidv7()));

    expect(values.size).toBe(200);
  });
});

describe("isUuid", () => {
  it("accepts UUID v7 values", () => {
    expect(isUuid(uuidv7())).toBe(true);
    expect(isUuid("0190f5b2-7c3a-7def-8abc-0123456789ab")).toBe(true);
  });

  it("rejects other UUID versions and malformed input", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("0190f5b2-7c3a-4def-8abc-0123456789ab")).toBe(false);
    expect(isUuid("0190f5b2-7c3a-7def-0abc-0123456789ab")).toBe(false);
    expect(isUuid("0190f5b2-7c3a-7def-8abc-0123456789a")).toBe(false);
  });
});
