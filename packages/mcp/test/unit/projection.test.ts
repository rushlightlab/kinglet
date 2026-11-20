import { describe, expect, it } from "vitest";
import type { ClientEvent } from "../../src/client.ts";
import { eventIdAtOrBefore, projectEvent } from "../../src/projection.ts";

function makeEvent(overrides: Partial<ClientEvent> = {}): ClientEvent {
  return {
    id: 42,
    uid: "0190f5b2-7c3a-7def-8abc-0123456789ab",
    ts: 1_800_000_000_000,
    level: 4,
    levelName: "error",
    service: "api",
    env: "prod",
    message: "upstream timeout",
    fields: { requestId: "req-1" },
    ...overrides,
  };
}

describe("projectEvent", () => {
  it("returns the full event unchanged when no projection is requested", () => {
    const event = makeEvent();

    expect(projectEvent(event, undefined)).toBe(event);
  });

  it("returns exactly the requested keys", () => {
    const event = makeEvent();
    const projected = projectEvent(event, ["message", "id"]);

    expect(projected).toEqual({ message: "upstream timeout", id: 42 });
    expect(Object.keys(projected)).toEqual(["message", "id"]);
  });

  it("supports every projected field and drops derived metadata", () => {
    const event = makeEvent();

    const projected = projectEvent(event, [
      "id",
      "uid",
      "ts",
      "level",
      "service",
      "env",
      "message",
      "fields",
    ]);

    expect(projected).toEqual({
      id: 42,
      uid: "0190f5b2-7c3a-7def-8abc-0123456789ab",
      ts: 1_800_000_000_000,
      level: 4,
      service: "api",
      env: "prod",
      message: "upstream timeout",
      fields: { requestId: "req-1" },
    });
    expect(projected).not.toHaveProperty("levelName");
    expect(projected).not.toHaveProperty("truncated");
  });

  it("keeps null fields when they are requested", () => {
    const event = makeEvent({ service: null, env: null, fields: null, id: null });

    expect(projectEvent(event, ["id", "service", "env", "fields"])).toEqual({
      id: null,
      service: null,
      env: null,
      fields: null,
    });
  });

  it("returns an empty object for an empty projection", () => {
    expect(projectEvent(makeEvent(), [])).toEqual({});
  });
});

describe("eventIdAtOrBefore", () => {
  it("walks back to the nearest non-null id", () => {
    const events = [makeEvent({ id: 10 }), makeEvent({ id: null }), makeEvent({ id: 12 })];

    expect(eventIdAtOrBefore(events, 2)).toBe(12);
    expect(eventIdAtOrBefore(events, 1)).toBe(10);
    expect(eventIdAtOrBefore(events, 0)).toBe(10);
  });

  it("returns null when no earlier id exists", () => {
    expect(eventIdAtOrBefore([], 0)).toBe(null);
    expect(eventIdAtOrBefore([makeEvent({ id: null })], 0)).toBe(null);
    expect(eventIdAtOrBefore([makeEvent({ id: 4 })], -1)).toBe(null);
  });

  it("clamps an index beyond the list", () => {
    const events = [makeEvent({ id: 4 }), makeEvent({ id: 5 })];

    expect(eventIdAtOrBefore(events, 99)).toBe(5);
  });
});
