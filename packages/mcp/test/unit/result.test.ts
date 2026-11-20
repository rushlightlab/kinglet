import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { KingletApiError } from "../../src/client.ts";
import {
  describeError,
  errorResult,
  jsonResult,
  MAX_RESPONSE_BYTES,
  runTool,
} from "../../src/tools/result.ts";

function resultText(result: CallToolResult): string {
  const block = result.content[0];

  if (!block || block.type !== "text") throw new Error("expected a text result");

  return block.text;
}

interface PagedPayload {
  items: { id: number; message: string }[];
  truncated?: true;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jsonResult", () => {
  it("serializes a small payload with pretty-printed JSON", () => {
    const outcome = jsonResult({ ok: true, items: [{ id: 1 }] });

    expect(outcome.result.isError).toBeUndefined();
    expect(resultText(outcome.result)).toBe(
      '{\n  "ok": true,\n  "items": [\n    {\n      "id": 1\n    }\n  ]\n}',
    );
    expect(outcome.rows).toBeUndefined();
  });

  it("reports the row count when a list is supplied", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const outcome = jsonResult({ items }, { list: items });

    expect(outcome.rows).toBe(3);
  });

  it("includes structured content when requested", () => {
    const outcome = jsonResult({ ok: true }, { structured: true });

    expect(outcome.result.structuredContent).toEqual({ ok: true });
  });

  it("rejects a payload over the 256 KiB cap when there is no list to trim", () => {
    expect(MAX_RESPONSE_BYTES).toBe(256 * 1024);

    const outcome = jsonResult({ blob: "x".repeat(MAX_RESPONSE_BYTES) });

    expect(outcome.result.isError).toBe(true);
    expect(resultText(outcome.result)).toBe(
      "response exceeded 256 KiB; narrow the query or time range",
    );
  });

  it("trims a list until the payload fits and marks it truncated", () => {
    const items = Array.from({ length: 1200 }, (_, index) => ({
      id: index,
      message: "x".repeat(400),
    }));

    const payload: PagedPayload = { items };
    let trims = 0;

    const outcome = jsonResult(payload, {
      list: payload.items,
      markTruncated: () => {
        payload.truncated = true;
      },
      onTrim: () => {
        trims += 1;
      },
    });

    const text = resultText(outcome.result);

    expect(outcome.result.isError).toBeUndefined();
    expect(trims).toBeGreaterThan(0);
    expect(outcome.rows).toBe(payload.items.length);
    expect(outcome.rows).toBeGreaterThan(0);
    expect(outcome.rows).toBeLessThan(1200);
    expect(payload.truncated).toBe(true);
    expect(text).toContain('"truncated": true');
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("returns an error when trimming the list to empty still exceeds the cap", () => {
    const items: { id: number }[] = [];
    const payload = { items, blob: "x".repeat(MAX_RESPONSE_BYTES) };
    const outcome = jsonResult(payload, { list: payload.items });

    expect(outcome.result.isError).toBe(true);
    expect(resultText(outcome.result)).toContain("response exceeded 256 KiB");
  });
});

describe("errorResult", () => {
  it("returns a text result marked as an error", () => {
    const result = errorResult("boom");

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe("boom");
  });
});

describe("describeError", () => {
  it("passes through a curated Kinglet API error", () => {
    expect(describeError(new KingletApiError("forbidden", 403))).toBe("forbidden");
    expect(describeError(new KingletApiError("rate limited", 429))).toBe("rate limited");
  });

  it("hides unexpected error details", () => {
    const message = describeError(new Error("ENOENT /srv/secret/config.json"));

    expect(message).toBe("unexpected error while calling Kinglet");
    expect(message).not.toContain("ENOENT");
  });
});

describe("runTool", () => {
  it("returns a successful tool result and audits only safe summary fields", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const eventContent = "secret event content that must not be audited";
    const filterText = "level>=error service=billing";
    const apiKey = "km_audit_must_never_print_this_key";
    const items = [{ id: 1, message: eventContent }];

    const outcome = await runTool("search_logs", async () =>
      jsonResult({ items, query: filterText, key: apiKey }, { list: items }),
    );

    const audit = write.mock.calls.map((call) => String(call[0])).join("");
    const text = resultText(outcome);

    expect(outcome.isError).toBeUndefined();
    expect(text).toContain('"id": 1');
    // Prove the payload really carried the sensitive values before asserting
    // that the audit line did not.
    expect(text).toContain(eventContent);
    expect(text).toContain(filterText);
    expect(text).toContain(apiKey);
    expect(audit).toContain("kinglet-mcp tool=search_logs");
    expect(audit).toContain("status=ok");
    expect(audit).toContain("rows=1");
    expect(audit).not.toContain(eventContent);
    expect(audit).not.toContain(filterText);
    expect(audit).not.toContain(apiKey);
    expect(audit.trimEnd().split("\n")).toHaveLength(1);
  });

  it("turns a Kinglet API error into an error result", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const outcome = await runTool("get_monitor", async () => {
      throw new KingletApiError("monitor not found", 404);
    });

    expect(outcome.isError).toBe(true);
    expect(resultText(outcome)).toBe("monitor not found");
  });

  it("hides unexpected error details from the result and the audit line", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const eventContent = "secret error event content";
    const apiKey = "km_error_audit_must_not_print_this_key";

    const outcome = await runTool("search_logs", async () => {
      throw new Error(`SQLITE_ERROR near SELECT ${eventContent} ${apiKey}`);
    });

    const audit = write.mock.calls.map((call) => String(call[0])).join("");

    expect(outcome.isError).toBe(true);
    expect(resultText(outcome)).toBe("unexpected error while calling Kinglet");
    expect(resultText(outcome)).not.toContain("SQLITE");
    expect(audit).toContain("status=error");
    expect(audit).toContain("rows=0");
    expect(audit).not.toContain(eventContent);
    expect(audit).not.toContain(apiKey);
  });
});
