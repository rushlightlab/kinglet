import { describe, expect, it } from "vitest";
import { isPageSize, PAGE_SIZES, pageSpan } from "../../src/server-table";

describe("pageSpan", () => {
  it("names the 1-based rows on a page and the page count", () => {
    expect(pageSpan(0, 20, 134)).toEqual({ from: 1, to: 20, pages: 7 });
    expect(pageSpan(6, 20, 134)).toEqual({ from: 121, to: 134, pages: 7 });
  });

  it("has one empty page when nothing matches", () => {
    expect(pageSpan(0, 20, 0)).toEqual({ from: 0, to: 0, pages: 1 });
  });
});

describe("isPageSize", () => {
  it("accepts only the offered row counts", () => {
    expect(PAGE_SIZES).toEqual([5, 20, 50, 100]);
    expect(isPageSize(50)).toBe(true);
    expect(isPageSize(25)).toBe(false);
  });
});
