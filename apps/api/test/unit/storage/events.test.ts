import { describe, expect, it } from "vitest";
import type { Normalized } from "../../../src/ingest.ts";
import { eventSizeBytes } from "../../../src/storage/events.ts";

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

describe("eventSizeBytes", () => {
  it("counts the message alone when nothing else is set", () => {
    expect(eventSizeBytes(makeEvent({ message: "hello" }))).toBe(5);
    expect(eventSizeBytes(makeEvent())).toBe(0);
  });

  it("sums message, fields, service, and env", () => {
    const event = makeEvent({
      message: "hello",
      fields: '{"a":1}',
      service: "api",
      env: "prod",
    });

    expect(eventSizeBytes(event)).toBe(5 + 7 + 3 + 4);
  });

  it("uses UTF-8 byte length rather than character count", () => {
    expect(eventSizeBytes(makeEvent({ message: "é" }))).toBe(2);
    expect(eventSizeBytes(makeEvent({ message: "😀" }))).toBe(4);
    expect(eventSizeBytes(makeEvent({ message: "é😀" }))).toBe(6);
    expect(eventSizeBytes(makeEvent({ service: "café" }))).toBe(5);
  });

  it("does not count timestamps or levels", () => {
    const first = makeEvent({ message: "x", ts: 1, level: 0 });
    const second = makeEvent({ message: "x", ts: 9_999_999_999, level: 5 });

    expect(eventSizeBytes(first)).toBe(1);
    expect(eventSizeBytes(second)).toBe(1);
  });

  it("treats null optional values as empty", () => {
    expect(
      eventSizeBytes(makeEvent({ message: "x", fields: null, service: null, env: null })),
    ).toBe(1);
    expect(eventSizeBytes(makeEvent({ message: "x", fields: "", service: "", env: "" }))).toBe(1);
  });

  it("counts a multi-byte fields payload exactly", () => {
    const fields = '{"note":"café"}';

    expect(eventSizeBytes(makeEvent({ fields }))).toBe(Buffer.byteLength(fields, "utf8"));
  });
});
