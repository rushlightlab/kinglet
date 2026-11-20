import { describe, expect, it } from "vitest";
import { isUuid, uuidv7 } from "../../src/auth/ids.js";

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
