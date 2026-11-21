import { describe, expect, it } from "vitest";
import { ArchiveError, isArchiveDate } from "../../../src/archive/types.ts";

describe("isArchiveDate", () => {
  it("accepts real calendar dates", () => {
    expect(isArchiveDate("2026-01-01")).toBe(true);
    expect(isArchiveDate("2026-12-31")).toBe(true);
    expect(isArchiveDate("2024-02-29")).toBe(true);
  });

  it("rejects rolled-over dates", () => {
    expect(isArchiveDate("2026-02-31")).toBe(false);
    expect(isArchiveDate("2025-02-29")).toBe(false);
    expect(isArchiveDate("2026-04-31")).toBe(false);
    expect(isArchiveDate("2026-13-01")).toBe(false);
    expect(isArchiveDate("2026-00-10")).toBe(false);
    expect(isArchiveDate("2026-01-00")).toBe(false);
  });

  it("rejects malformed formats", () => {
    expect(isArchiveDate("2026-1-01")).toBe(false);
    expect(isArchiveDate("2026-01-1")).toBe(false);
    expect(isArchiveDate("2026/01/01")).toBe(false);
    expect(isArchiveDate("2026-01-01T00:00:00Z")).toBe(false);
    expect(isArchiveDate("")).toBe(false);
    expect(isArchiveDate("not-a-date")).toBe(false);
  });
});

describe("ArchiveError", () => {
  it("defaults to a server error", () => {
    const error = new ArchiveError("archive failed");

    expect(error.name).toBe("ArchiveError");
    expect(error.message).toBe("archive failed");
    expect(error.status).toBe(500);
    expect(error).toBeInstanceOf(Error);
  });

  it("keeps an explicit status", () => {
    expect(new ArchiveError("not found", 404).status).toBe(404);
    expect(new ArchiveError("conflict", 409).status).toBe(409);
    expect(new ArchiveError("bad request", 400).status).toBe(400);
  });
});
