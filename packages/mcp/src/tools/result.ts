/**
 * Shared tool plumbing: response caps, structured errors, and the one-line
 * audit record on stderr.
 *
 * stdout belongs to the MCP protocol. Audit lines never include tool
 * arguments, filters, event contents, or the key — only tool, duration,
 * status, and row count.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { KingletApiError } from "../client.js";

export const MAX_RESPONSE_BYTES = 256 * 1024;

export interface CappedPayload {
  /** Set when rows or event content were shortened to meet the cap. */
  truncated?: true;
}

export interface ToolOutcome {
  result: CallToolResult;
  /** Rows returned by list-shaped tools; omitted for single-object tools. */
  rows?: number;
}

export interface JsonResultOptions {
  /** The top-level array to trim when the payload is too large. */
  list?: object[];
  /** Marks the payload as truncated after the helper trims rows. */
  markTruncated?: () => void;
  /** Called after a trim so the tool can move its cursor. */
  onTrim?: () => void;
  /** Include the payload as MCP structured content as well as text. */
  structured?: boolean;
}

function textResult(text: string, isError: boolean): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };

  if (isError) result.isError = true;

  return result;
}

export function errorResult(message: string): CallToolResult {
  return textResult(message, true);
}

function serializedBytes<T>(payload: T): number {
  const text = JSON.stringify(payload, null, 2) ?? "null";

  return Buffer.byteLength(text, "utf8");
}

export function jsonResult<T>(payload: T, options: JsonResultOptions = {}): ToolOutcome {
  let text = JSON.stringify(payload, null, 2) ?? "null";
  const list = options.list;

  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES && list) {
    while (list.length > 0 && serializedBytes(payload) > MAX_RESPONSE_BYTES) {
      const keep = Math.floor(list.length * 0.8);

      list.splice(keep === list.length ? list.length - 1 : keep);
      options.markTruncated?.();
      options.onTrim?.();
      text = JSON.stringify(payload, null, 2) ?? "null";
    }
  }

  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    return { result: errorResult("response exceeded 256 KiB; narrow the query or time range") };
  }

  const result = textResult(text, false);

  if (options.structured) result.structuredContent = JSON.parse(text);

  return { result, rows: list?.length };
}

export function describeError(err: Error): string {
  if (err instanceof KingletApiError) return err.message;

  return "unexpected error while calling Kinglet";
}

function audit(name: string, status: "ok" | "error", rows: number, durationMs: number): void {
  process.stderr.write(
    `kinglet-mcp tool=${name} duration=${durationMs}ms status=${status} rows=${rows}\n`,
  );
}

export async function runTool(
  name: string,
  fn: () => Promise<ToolOutcome>,
): Promise<CallToolResult> {
  const started = Date.now();

  try {
    const outcome = await fn();
    const failed = outcome.result.isError === true;

    audit(name, failed ? "error" : "ok", failed ? 0 : (outcome.rows ?? 0), Date.now() - started);

    return outcome.result;
  } catch (err) {
    audit(name, "error", 0, Date.now() - started);

    const message = err instanceof Error ? describeError(err) : "unexpected error";

    return errorResult(message);
  }
}
