import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { isFiniteNumber, isJsonObject, isString } from "../../src/json.ts";
import type { JsonObject, JsonValue } from "../../src/json.ts";

/**
 * Minimal JSON-RPC client for the real `@kinglet/mcp` stdio entry point.
 *
 * The MCP SDK server writes one JSON object per line to stdout and reserves
 * stderr for audit lines. This client intentionally records any non-JSON
 * stdout line so a test can prove diagnostics never contaminate the protocol.
 * Protocol frames are decoded into named result types at this boundary.
 */

interface PendingCall {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcEnvelope {
  id: number;
  result: JsonValue;
  error: string | null;
}

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  annotations?: McpToolAnnotations;
}

export interface McpToolTextPart {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpToolTextPart[];
  isError: boolean;
}

export interface McpStdioOptions {
  url: string;
  key: string;
  cwd: string;
  cliPath: string;
}

export class McpStdioClient {
  readonly stdoutGarbage: string[] = [];
  readonly stderrLines: string[] = [];

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, PendingCall>();
  private readonly exitPromise: Promise<void>;
  private readonly stderrWaiters = new Set<() => void>();
  private nextId = 1;
  private exited = false;

  private constructor(child: ChildProcessWithoutNullStreams, ready: Promise<void>) {
    this.child = child;
    this.ready = ready;
    this.exitPromise = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });

    void this.exitPromise.then(() => {
      this.exited = true;
      this.failPending("MCP server exited before replying");

      return undefined;
    });

    // A dead child can emit EPIPE on the next write; never let it become an
    // unhandled stream error. Pending calls reject through the exit path.
    child.stdin.on("error", () => this.failPending("MCP server stdin closed"));

    const stdout = createInterface({ input: child.stdout });

    stdout.on("line", (line) => this.onStdout(line));

    const stderr = createInterface({ input: child.stderr });

    stderr.on("line", (line) => {
      if (line.trim() === "") return;

      this.stderrLines.push(line);
      this.notifyStderrWaiters();
    });
  }

  get terminated(): boolean {
    return this.exited;
  }

  static async start(options: McpStdioOptions): Promise<McpStdioClient> {
    const child = spawn(process.execPath, [options.cliPath], {
      cwd: options.cwd,
      env: {
        ...inheritedEnvironment(),
        KINGLET_URL: options.url,
        KINGLET_MCP_KEY: options.key,
        KINGLET_MCP_TIMEOUT_MS: "5000",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const ready = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const client = new McpStdioClient(child, ready);

    try {
      await ready;
    } catch (err) {
      await client.close();
      throw err;
    }

    return client;
  }

  async initialize(): Promise<JsonValue> {
    const result = await this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "kinglet-task-6-tests", version: "1.0.0" },
    });

    await this.notify("notifications/initialized");

    return result;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.call("tools/list", {});

    if (!isJsonObject(result) || !Array.isArray(result.tools)) {
      throw new Error("tools/list did not return an array");
    }

    const defs: McpToolDefinition[] = [];

    for (const entry of result.tools) {
      if (!isJsonObject(entry) || !isString(entry.name)) continue;

      defs.push({
        name: entry.name,
        description: isString(entry.description) ? entry.description : undefined,
        annotations: parseToolAnnotations(entry.annotations),
      });
    }

    return defs;
  }

  async callTool(name: string, args: JsonObject = {}): Promise<McpToolResult> {
    const result = await this.call("tools/call", { name, arguments: args });

    return parseToolResult(result);
  }

  /** Wait until stderr has at least `count` audit lines (stdio is async). */
  async waitForStderr(count: number, timeoutMs = 5_000): Promise<void> {
    if (this.stderrLines.length >= count) return;

    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;

      const check = (): void => {
        if (this.stderrLines.length < count) return;

        clearTimeout(timer);
        this.stderrWaiters.delete(check);
        resolve();
      };

      timer = setTimeout(() => {
        this.stderrWaiters.delete(check);
        reject(new Error(`timed out waiting for ${count} MCP stderr line(s)`));
      }, timeoutMs);
      this.stderrWaiters.add(check);
    });
  }

  async close(): Promise<void> {
    if (this.exited) return;

    try {
      this.child.stdin.end();
    } catch {
      // The child may already be gone.
    }

    if (await this.waitForExit(1_000)) return;

    try {
      this.child.kill();
    } catch {
      // Best effort.
    }

    if (await this.waitForExit(2_000)) return;

    try {
      this.child.kill("SIGKILL");
    } catch {
      // Best effort.
    }

    await this.waitForExit(1_000);
  }

  private call(method: string, params: JsonObject): Promise<JsonValue> {
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, 15_000);

      this.pending.set(id, { resolve, reject, timer });

      this.child.stdin.write(`${message}\n`, (err) => {
        if (!err) return;

        const call = this.pending.get(id);

        if (call === undefined) return;

        clearTimeout(call.timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  private notify(method: string, params?: JsonObject): Promise<void> {
    const message =
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };

    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private onStdout(line: string): void {
    if (line.trim() === "") return;

    const envelope = parseRpcEnvelope(line);

    if (envelope === null) {
      this.stdoutGarbage.push(line);

      return;
    }

    const call = this.pending.get(envelope.id);

    if (call === undefined) return;

    clearTimeout(call.timer);
    this.pending.delete(envelope.id);

    if (envelope.error !== null) {
      call.reject(new Error(envelope.error));

      return;
    }

    call.resolve(envelope.result);
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;

    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        this.exitPromise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private failPending(message: string): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(message));
    }

    this.pending.clear();
  }

  private notifyStderrWaiters(): void {
    for (const waiter of this.stderrWaiters) waiter();
  }
}

function parseToolAnnotations(value: JsonValue | undefined): McpToolAnnotations | undefined {
  if (!isJsonObject(value)) return undefined;

  return {
    readOnlyHint: value.readOnlyHint === true,
    destructiveHint: value.destructiveHint === true,
    idempotentHint: value.idempotentHint === true,
    openWorldHint: value.openWorldHint === true,
  };
}

/** Decode one stdout line. Non-response frames (notifications) are ignored. */
function parseRpcEnvelope(line: string): RpcEnvelope | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isJsonObject(parsed) || !isFiniteNumber(parsed.id)) return null;

  const result = parsed.result ?? null;
  const errorObject = isJsonObject(parsed.error) ? parsed.error : null;

  const error = errorObject !== null && isString(errorObject.message) ? errorObject.message : null;

  return { id: parsed.id, result, error };
}

/** Shape `CallToolResult` at the stdio boundary. */
function parseToolResult(value: JsonValue): McpToolResult {
  if (!isJsonObject(value) || !Array.isArray(value.content)) {
    throw new Error("tool result did not contain content");
  }

  const content: McpToolTextPart[] = [];

  for (const entry of value.content) {
    if (isJsonObject(entry) && entry.type === "text" && isString(entry.text)) {
      content.push({ type: "text", text: entry.text });
    }
  }

  return { content, isError: value.isError === true };
}

/** Parse a JSON object returned by the server inside a text tool result. */
export function parseToolJson(text: string): JsonObject | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  return isJsonObject(parsed) ? parsed : null;
}

/** Concatenate text content from one `tools/call` result. */
export function toolText(result: McpToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

export function toolFailed(result: McpToolResult): boolean {
  return result.isError;
}

/** `NodeJS.ProcessEnv` subset needed to launch Node on each supported OS. */
function inheritedEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "APPDATA",
    "COMSPEC",
    "HOME",
    "LOCALAPPDATA",
    "LOGNAME",
    "NUMBER_OF_PROCESSORS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROGRAMFILES",
    "SHELL",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "USER",
    "USERNAME",
    "USERPROFILE",
  ];

  const env: NodeJS.ProcessEnv = {};

  for (const name of names) {
    const value = process.env[name];

    if (value !== undefined) env[name] = value;
  }

  return env;
}
