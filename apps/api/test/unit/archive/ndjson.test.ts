import { describe, expect, it } from "vitest";
import {
  archiveDateKey,
  archiveLevelIndex,
  archiveLevelName,
  eventToArchiveLine,
  parseArchiveLine,
  synthesizeArchiveUid,
} from "../../../src/archive/ndjson.js";
import type { ArchiveEventRow } from "../../../src/archive/types.js";

const PROJECT_ID = "0190f5b2-7c3a-7def-8abc-0123456789ab";
const ROW_UID = "0190f5b2-7c3a-7def-8abc-fedcba987654";

function makeRow(overrides: Partial<ArchiveEventRow> = {}): ArchiveEventRow {
  return {
    id: 42,
    uid: ROW_UID,
    ts: Date.UTC(2026, 0, 15, 12, 0, 0),
    level: 3,
    service: "api",
    env: "prod",
    message: "connection refused",
    fields: '{"requestId":"abc"}',
    ...overrides,
  };
}

interface ArchiveLineOverrides {
  v?: number | string;
  uid?: string | number;
  sourceId?: number | string;
  projectId?: string | number | null;
  ts?: number | string;
  level?: string | number;
  service?: string | number | boolean | null;
  env?: string | number | boolean | null;
  message?: string | number | null;
  fields?: string | number[] | null | { requestId: string } | { a: number };
}

function validLineJson(overrides: ArchiveLineOverrides = {}): string {
  return JSON.stringify({
    v: 1,
    uid: ROW_UID,
    sourceId: 42,
    projectId: PROJECT_ID,
    ts: Date.UTC(2026, 0, 15, 12, 0, 0),
    level: "warn",
    service: "api",
    env: "prod",
    message: "connection refused",
    fields: { requestId: "abc" },
    ...overrides,
  });
}

describe("archive level names", () => {
  it("maps level indexes to names and back", () => {
    expect([0, 1, 2, 3, 4, 5].map((level) => archiveLevelName(level))).toEqual([
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ]);
    expect(archiveLevelName(6)).toBe("info");
    expect(archiveLevelName(-1)).toBe("info");
    expect(archiveLevelIndex("warn")).toBe(3);
    expect(archiveLevelIndex(" WARN ")).toBe(3);
    expect(archiveLevelIndex("warning")).toBe(-1);
    expect(archiveLevelIndex("")).toBe(-1);
  });
});

describe("synthesizeArchiveUid", () => {
  it("is deterministic for the same project and source id", () => {
    expect(synthesizeArchiveUid(PROJECT_ID, 42)).toBe(synthesizeArchiveUid(PROJECT_ID, 42));
  });

  it("changes with the project or source id", () => {
    const base = synthesizeArchiveUid(PROJECT_ID, 42);

    expect(synthesizeArchiveUid(PROJECT_ID, 43)).not.toBe(base);
    expect(synthesizeArchiveUid("another-project", 42)).not.toBe(base);
  });

  it("produces a UUID-v5-shaped identifier", () => {
    const uid = synthesizeArchiveUid(PROJECT_ID, 42);

    expect(uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("archiveDateKey", () => {
  it("partitions by UTC date", () => {
    expect(archiveDateKey(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01");
    expect(archiveDateKey(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31");
    expect(archiveDateKey(Date.UTC(2026, 0, 1, 0, 30, 0))).toBe("2026-01-01");
    expect(archiveDateKey(Date.UTC(2025, 11, 31, 23, 30, 0))).toBe("2025-12-31");
  });
});

describe("eventToArchiveLine", () => {
  it("exports a stored row with a parsed fields object", () => {
    const line = eventToArchiveLine(makeRow(), PROJECT_ID);

    expect(line).toEqual({
      v: 1,
      uid: ROW_UID,
      sourceId: 42,
      projectId: PROJECT_ID,
      ts: Date.UTC(2026, 0, 15, 12, 0, 0),
      level: "warn",
      service: "api",
      env: "prod",
      message: "connection refused",
      fields: { requestId: "abc" },
    });
  });

  it("synthesizes a stable uid when the stored uid is absent or empty", () => {
    const expected = synthesizeArchiveUid(PROJECT_ID, 42);

    expect(eventToArchiveLine(makeRow({ uid: null }), PROJECT_ID).uid).toBe(expected);
    expect(eventToArchiveLine(makeRow({ uid: "" }), PROJECT_ID).uid).toBe(expected);
  });

  it("drops malformed or non-object fields", () => {
    expect(eventToArchiveLine(makeRow({ fields: "not json" }), PROJECT_ID).fields).toBeNull();
    expect(eventToArchiveLine(makeRow({ fields: "[1,2]" }), PROJECT_ID).fields).toBeNull();
    expect(eventToArchiveLine(makeRow({ fields: null }), PROJECT_ID).fields).toBeNull();
    expect(eventToArchiveLine(makeRow({ fields: "" }), PROJECT_ID).fields).toBeNull();
  });

  it("round-trips through JSON and parseArchiveLine", () => {
    const line = eventToArchiveLine(makeRow(), PROJECT_ID);
    const parsed = parseArchiveLine(JSON.stringify(line));

    expect(parsed).toEqual(line);
  });
});

describe("parseArchiveLine", () => {
  it("parses a valid line", () => {
    const parsed = parseArchiveLine(validLineJson());

    expect(parsed).toEqual({
      v: 1,
      uid: ROW_UID,
      sourceId: 42,
      projectId: PROJECT_ID,
      ts: Date.UTC(2026, 0, 15, 12, 0, 0),
      level: "warn",
      service: "api",
      env: "prod",
      message: "connection refused",
      fields: { requestId: "abc" },
    });
  });

  it("rejects malformed JSON and non-object lines", () => {
    expect(parseArchiveLine("{not json")).toBeNull();
    expect(parseArchiveLine("[]")).toBeNull();
    expect(parseArchiveLine("null")).toBeNull();
    expect(parseArchiveLine('"line"')).toBeNull();
  });

  it("rejects unknown versions", () => {
    expect(parseArchiveLine(validLineJson({ v: 2 }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ v: "1" }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ v: undefined }))).toBeNull();
  });

  it("rejects missing or blank identity fields", () => {
    expect(parseArchiveLine(validLineJson({ uid: "" }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ uid: "   " }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ uid: 42 }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ projectId: "" }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ projectId: null }))).toBeNull();
  });

  it("rejects non-integer source ids and timestamps", () => {
    expect(parseArchiveLine(validLineJson({ sourceId: 1.5 }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ sourceId: "42" }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ ts: 0 }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ ts: -1 }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ ts: 1.5 }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ ts: "1700000000000" }))).toBeNull();
  });

  it("rejects unknown level names", () => {
    expect(parseArchiveLine(validLineJson({ level: "warning" }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ level: 3 }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ level: "" }))).toBeNull();
  });

  it("preserves the level spelling from the line", () => {
    expect(parseArchiveLine(validLineJson({ level: "WARN" }))?.level).toBe("WARN");
  });

  it("rejects non-string messages", () => {
    expect(parseArchiveLine(validLineJson({ message: null }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ message: 42 }))).toBeNull();
  });

  it("requires service and env to be strings or null", () => {
    expect(parseArchiveLine(validLineJson({ service: null }))?.service).toBeNull();
    expect(parseArchiveLine(validLineJson({ env: null }))?.env).toBeNull();
    expect(parseArchiveLine(validLineJson({ service: 42 }))).toBeNull();
    expect(parseArchiveLine(validLineJson({ env: false }))).toBeNull();
  });

  it("treats array fields as absent instead of failing the whole line", () => {
    const parsed = parseArchiveLine(validLineJson({ fields: [1, 2] }));

    expect(parsed?.fields).toBeNull();
    expect(parsed?.message).toBe("connection refused");
  });

  it("treats string or missing fields as absent", () => {
    expect(parseArchiveLine(validLineJson({ fields: '{"a":1}' }))?.fields).toBeNull();
    expect(parseArchiveLine(validLineJson({ fields: null }))?.fields).toBeNull();
    expect(parseArchiveLine(validLineJson({ fields: undefined }))?.fields).toBeNull();
  });
});
