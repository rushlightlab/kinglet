import { describe, expect, it } from "vitest";
import { normalizeEvent } from "../../src/ingest.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_MESSAGE = 8000;
const MAX_FIELDS = 32_768;
const MAX_FUTURE_SKEW = 5 * MINUTE;
const MAX_PAST = 31 * DAY;

function expectOk(result: ReturnType<typeof normalizeEvent>) {
  expect(result.ok).toBe(true);

  if (!result.ok) throw new Error(`expected normalization to succeed: ${result.error}`);

  return result.value;
}

function expectError(result: ReturnType<typeof normalizeEvent>): string {
  expect(result.ok).toBe(false);

  if (result.ok) throw new Error("expected normalization to fail");

  return result.error;
}

describe("normalizeEvent message", () => {
  it("accepts message and msg, and rejects missing or blank text", () => {
    expect(expectOk(normalizeEvent({ message: "hello" })).message).toBe("hello");
    expect(expectOk(normalizeEvent({ msg: "hello" })).message).toBe("hello");
    expect(expectError(normalizeEvent({}))).toBe("missing message");
    expect(expectError(normalizeEvent({ message: "" }))).toBe("missing message");
    expect(expectError(normalizeEvent({ message: "   " }))).toBe("missing message");
    expect(expectError(normalizeEvent({ message: 42 }))).toBe("missing message");
  });

  it("rejects non-object events", () => {
    expect(expectError(normalizeEvent(null))).toBe("event must be an object");
    expect(expectError(normalizeEvent("hello"))).toBe("event must be an object");
    expect(expectError(normalizeEvent([{ message: "hello" }]))).toBe("event must be an object");
  });

  it("caps the message at 8000 characters", () => {
    const value = expectOk(normalizeEvent({ message: "x".repeat(9000) }));

    expect(value.message.length).toBe(MAX_MESSAGE);
    expect(value.message).toBe("x".repeat(MAX_MESSAGE));
  });

  it("keeps a message exactly at the cap", () => {
    expect(expectOk(normalizeEvent({ message: "y".repeat(MAX_MESSAGE) })).message.length).toBe(
      MAX_MESSAGE,
    );
  });
});

describe("normalizeEvent timestamps", () => {
  it("detects epoch seconds and converts to milliseconds", () => {
    const seconds = Math.floor(Date.now() / 1000) - 60;
    const value = expectOk(normalizeEvent({ message: "x", ts: seconds }));

    expect(value.ts).toBe(seconds * 1000);
  });

  it("detects epoch milliseconds", () => {
    const millis = Date.now() - 60_000;

    expect(expectOk(normalizeEvent({ message: "x", ts: millis })).ts).toBe(millis);
  });

  it("parses ISO timestamps", () => {
    const iso = new Date(Date.now() - 60_000).toISOString();

    expect(expectOk(normalizeEvent({ message: "x", ts: iso })).ts).toBe(Date.parse(iso));
  });

  it("accepts the time and timestamp aliases", () => {
    const first = Date.now() - 60_000;
    const second = Date.now() - 120_000;

    expect(expectOk(normalizeEvent({ message: "x", time: first })).ts).toBe(first);
    expect(expectOk(normalizeEvent({ message: "x", timestamp: second })).ts).toBe(second);
  });

  it("defaults to now for a missing or invalid timestamp", () => {
    const before = Date.now();
    const missing = expectOk(normalizeEvent({ message: "x" }));
    const invalid = expectOk(normalizeEvent({ message: "x", ts: "not-a-date" }));
    const after = Date.now();

    for (const value of [missing, invalid]) {
      expect(value.ts).toBeGreaterThanOrEqual(before);
      expect(value.ts).toBeLessThanOrEqual(after);
    }
  });

  it("clamps far-future timestamps to five minutes ahead", () => {
    const before = Date.now();
    const value = expectOk(normalizeEvent({ message: "x", ts: Date.now() + 10 * DAY }));
    const after = Date.now();

    expect(value.ts).toBeGreaterThanOrEqual(before + MAX_FUTURE_SKEW);
    expect(value.ts).toBeLessThanOrEqual(after + MAX_FUTURE_SKEW);
  });

  it("clamps far-past timestamps to the 31-day floor", () => {
    const before = Date.now();
    const value = expectOk(normalizeEvent({ message: "x", ts: Date.now() - 90 * DAY }));
    const after = Date.now();

    expect(value.ts).toBeGreaterThanOrEqual(before - MAX_PAST);
    expect(value.ts).toBeLessThanOrEqual(after - MAX_PAST);
  });

  it("ignores non-positive numeric timestamps", () => {
    const before = Date.now();
    const value = expectOk(normalizeEvent({ message: "x", ts: 0 }));
    const after = Date.now();

    expect(value.ts).toBeGreaterThanOrEqual(before);
    expect(value.ts).toBeLessThanOrEqual(after);
  });
});

describe("normalizeEvent levels", () => {
  it.each([
    ["trace", 0],
    ["debug", 1],
    ["info", 2],
    ["warn", 3],
    ["warning", 3],
    ["error", 4],
    ["err", 4],
    ["fatal", 5],
    ["critical", 5],
    [" WARN ", 3],
    ["ERROR", 4],
  ])("maps %s to level %i", (level, expected) => {
    expect(expectOk(normalizeEvent({ message: "x", level })).level).toBe(expected);
  });

  it("defaults unknown level names to info", () => {
    expect(expectOk(normalizeEvent({ message: "x", level: "verbose" })).level).toBe(2);
    expect(expectOk(normalizeEvent({ message: "x", level: "4" })).level).toBe(2);
    expect(expectOk(normalizeEvent({ message: "x", level: true })).level).toBe(2);
  });

  it("maps numeric levels into the 0-5 range", () => {
    expect(expectOk(normalizeEvent({ message: "x", level: 0 })).level).toBe(0);
    expect(expectOk(normalizeEvent({ message: "x", level: 3 })).level).toBe(3);
    expect(expectOk(normalizeEvent({ message: "x", level: 3.9 })).level).toBe(3);
    expect(expectOk(normalizeEvent({ message: "x", level: 9 })).level).toBe(5);
    expect(expectOk(normalizeEvent({ message: "x", level: -2 })).level).toBe(0);
  });

  it("defaults a missing level to info", () => {
    expect(expectOk(normalizeEvent({ message: "x" })).level).toBe(2);
  });
});

describe("normalizeEvent service and env", () => {
  it("trims, lowercases, and caps identifiers", () => {
    const value = expectOk(
      normalizeEvent({
        message: "x",
        service: `  ${"S".repeat(200)}  `,
        env: `  ${"E".repeat(100)}  `,
      }),
    );

    expect(value.service).toBe("s".repeat(128));
    expect(value.env).toBe("e".repeat(64));
    expect(expectOk(normalizeEvent({ message: "x", service: "  API  " })).service).toBe("api");
    expect(expectOk(normalizeEvent({ message: "x", env: "  Prod  " })).env).toBe("prod");
  });

  it("uses null for blank or non-string identifiers", () => {
    const value = expectOk(normalizeEvent({ message: "x", service: "   ", env: 42 }));

    expect(value.service).toBeNull();
    expect(value.env).toBeNull();
  });
});

describe("normalizeEvent fields", () => {
  it("serializes a JSON object", () => {
    const value = expectOk(normalizeEvent({ message: "x", fields: { a: 1, nested: { b: true } } }));

    expect(value.fields).toBe('{"a":1,"nested":{"b":true}}');
    expect(JSON.parse(value.fields ?? "{}")).toEqual({ a: 1, nested: { b: true } });
  });

  it("treats null and undefined fields as absent", () => {
    expect(expectOk(normalizeEvent({ message: "x", fields: null })).fields).toBeNull();
    expect(expectOk(normalizeEvent({ message: "x" })).fields).toBeNull();
  });

  it("rejects array fields instead of silently dropping them later", () => {
    expect(expectError(normalizeEvent({ message: "x", fields: [] }))).toBe(
      "fields must be a JSON object",
    );
    expect(expectError(normalizeEvent({ message: "x", fields: [1, 2] }))).toBe(
      "fields must be a JSON object",
    );
  });

  it("rejects scalar fields", () => {
    expect(expectError(normalizeEvent({ message: "x", fields: "text" }))).toBe(
      "fields must be a JSON object",
    );
    expect(expectError(normalizeEvent({ message: "x", fields: 42 }))).toBe(
      "fields must be a JSON object",
    );
  });

  it("replaces oversized fields with the truncation marker", () => {
    const value = expectOk(
      normalizeEvent({ message: "x", fields: { blob: "x".repeat(MAX_FIELDS) } }),
    );

    expect(value.fields).toBe('{"_kinglet_truncated":true}');
  });

  it("keeps fields at or under the cap", () => {
    const value = expectOk(normalizeEvent({ message: "x", fields: { a: "b" } }));

    expect(value.fields).toBe('{"a":"b"}');
  });
});
