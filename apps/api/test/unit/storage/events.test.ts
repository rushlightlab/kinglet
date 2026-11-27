import { describe, expect, it } from "vitest";
import type { Normalized } from "../../../src/ingest.ts";
import { EVENT_ROW_OVERHEAD_BYTES, eventSizeBytes } from "../../../src/storage/events.ts";

function makeEvent(overrides: Partial<Normalized> = {}): Normalized {
  return {
    ts: 1_750_000_000_000,
    level: 2,
    service: null,
    env: null,
    message: "",
    fields: null,
    ...overrides,
  };
}

// The estimate weights each column by its on-disk cost: message text x4 (the
// search index), fields x1.25 rounded up, service and env x2 (indexed).
const ROW = EVENT_ROW_OVERHEAD_BYTES;

describe("eventSizeBytes", () => {
  it("charges a fixed per-row overhead even for an empty event", () => {
    expect(eventSizeBytes(makeEvent())).toBe(ROW);
  });

  it("weights message bytes for the search index", () => {
    expect(eventSizeBytes(makeEvent({ message: "hello" }))).toBe(ROW + 20);
  });

  it("sums the weighted message, fields, service, and env", () => {
    const event = makeEvent({
      message: "hello",
      fields: '{"a":1}',
      service: "api",
      env: "prod",
    });

    // 5 message bytes x4, 7 field bytes x1.25 rounded up, 7 service+env bytes x2.
    expect(eventSizeBytes(event)).toBe(ROW + 20 + 9 + 14);
  });

  it("uses UTF-8 byte length rather than character count", () => {
    expect(eventSizeBytes(makeEvent({ message: "é" }))).toBe(ROW + 8);
    expect(eventSizeBytes(makeEvent({ message: "😀" }))).toBe(ROW + 16);
    expect(eventSizeBytes(makeEvent({ message: "é😀" }))).toBe(ROW + 24);
    expect(eventSizeBytes(makeEvent({ service: "café" }))).toBe(ROW + 10);
  });

  it("does not count timestamps or levels", () => {
    const first = makeEvent({ message: "x", ts: 1, level: 0 });
    const second = makeEvent({ message: "x", ts: 9_999_999_999, level: 5 });

    expect(eventSizeBytes(first)).toBe(eventSizeBytes(second));
  });

  it("treats null and empty optional values alike", () => {
    expect(
      eventSizeBytes(makeEvent({ message: "x", fields: null, service: null, env: null })),
    ).toBe(eventSizeBytes(makeEvent({ message: "x", fields: "", service: "", env: "" })));
  });

  it("counts a multi-byte fields payload by its UTF-8 length", () => {
    const fields = '{"note":"café"}';

    // 16 bytes x1.25.
    expect(eventSizeBytes(makeEvent({ fields }))).toBe(ROW + 20);
  });
});
