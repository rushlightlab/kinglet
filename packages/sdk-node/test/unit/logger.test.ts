import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/index.ts";
import type { LoggerOptions } from "../../src/index.ts";

const TEST_TOKEN = "kl_test_key_not_a_real_secret";
const TEST_URL = "https://logs.example.com";

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

let requests: RecordedRequest[] = [];
let responder: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;

function makeLogger(overrides: Partial<LoggerOptions> = {}) {
  return createLogger({
    url: TEST_URL,
    token: TEST_TOKEN,
    batchSize: 100,
    flushMs: 60_000,
    ...overrides,
  });
}

function bodyLines(init: RequestInit | undefined): string[] {
  return String(init?.body).split("\n");
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  requests = [];
  responder = () => Promise.resolve(new Response("ok", { status: 200 }));
  fetchMock = vi.fn((request: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(request), init });

    return responder();
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createLogger batching", () => {
  it("flushes when the batch size is reached", async () => {
    const logger = makeLogger({ batchSize: 2 });

    logger.info("first", { requestId: "r1" });
    expect(fetchMock).not.toHaveBeenCalled();
    logger.info("second", { requestId: "r2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await settle();

    const call = requests[0];

    if (!call) throw new Error("expected one ingest request");
    expect(call.url).toBe("https://logs.example.com/v1/events");

    const headers = new Headers(call.init?.headers);

    expect(headers.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
    expect(headers.get("content-type")).toBe("application/x-ndjson");
    // A redirect would replay the token to another location.
    expect(call.init?.redirect).toBe("error");

    const lines = bodyLines(call.init);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "info",
      message: "first",
      fields: { requestId: "r1" },
      ts: expect.any(Number),
    });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      level: "info",
      message: "second",
      fields: { requestId: "r2" },
    });

    await logger.close();
  });

  it("flushes on the timer when the batch is not full", async () => {
    const logger = makeLogger({ flushMs: 1_000 });

    logger.info("timed");

    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = requests[0];

    if (!call) throw new Error("expected one ingest request");
    expect(bodyLines(call.init)).toHaveLength(1);
    expect(bodyLines(call.init)[0]).toContain('"timed"');

    await logger.close();
  });

  it("does not call fetch for an empty buffer", async () => {
    const logger = makeLogger();

    await logger.flush();
    expect(fetchMock).not.toHaveBeenCalled();

    await logger.close();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flushes every level through the same batching path", async () => {
    const logger = makeLogger();

    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.fatal("f");
    await logger.flush();

    const call = requests[0];

    if (!call) throw new Error("expected one ingest request");

    const levels = bodyLines(call.init).map((line) => JSON.parse(line).level);

    expect(levels).toEqual(["trace", "debug", "info", "warn", "error", "fatal"]);

    await logger.close();
  });
});

interface ParsedEvent {
  service?: string;
  env?: string;
}

/** Parse one batch line; every line is a serialized event object. */
function parseEvent(line: string | undefined): ParsedEvent {
  // SAFETY: the SDK serializes each buffered event with JSON.stringify, so a
  // batch line is a JSON object and the fields read here are optional strings.
  return JSON.parse(line ?? "{}") as ParsedEvent;
}

describe("createLogger service and env tags", () => {
  const service = "checkout-api";
  const env = "prod";

  function expectTagged(init: RequestInit | undefined): void {
    const events = bodyLines(init).map((line) => parseEvent(line));

    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      expect(event.service).toBe(service);
      expect(event.env).toBe(env);
    }
  }

  it("attaches the configured tags to a count-driven flush", async () => {
    const logger = makeLogger({ service, env, batchSize: 2 });

    logger.info("first");
    logger.info("second");
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = requests[0];

    if (!call) throw new Error("expected one ingest request");
    expectTagged(call.init);

    await logger.close();
  });

  it("attaches the configured tags to a timer-driven flush", async () => {
    const logger = makeLogger({ service, env, flushMs: 1_000 });

    logger.info("timed");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = requests[0];

    if (!call) throw new Error("expected one ingest request");
    expectTagged(call.init);

    await logger.close();
  });

  it("attaches the configured tags to a close-driven flush", async () => {
    const logger = makeLogger({ service, env });

    logger.info("shutdown");
    await logger.close();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = requests[0];

    if (!call) throw new Error("expected one ingest request");
    expectTagged(call.init);
  });

  it("omits the tags when they are not configured", async () => {
    const logger = makeLogger();

    logger.info("plain");
    await logger.close();

    const call = requests[0];

    if (!call) throw new Error("expected one ingest request");

    const event = parseEvent(bodyLines(call.init)[0]);

    expect(event.service).toBeUndefined();
    expect(event.env).toBeUndefined();
  });
});

describe("createLogger failures", () => {
  it("requeues a failed batch and reports it through onError", async () => {
    let attempt = 0;

    responder = () => {
      attempt += 1;

      return Promise.resolve(new Response("unavailable", { status: attempt === 1 ? 503 : 200 }));
    };

    const errors: Error[] = [];
    const logger = makeLogger({ onError: (error) => errors.push(error) });

    logger.info("kept");

    await logger.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("kinglet ingest failed: HTTP 503");
    expect(requests).toHaveLength(1);

    await logger.flush();
    expect(requests).toHaveLength(2);
    expect(bodyLines(requests[1]?.init)[0]).toContain('"kept"');
    expect(errors).toHaveLength(1);

    await logger.close();
  });

  it("requeues after a network rejection and keeps running", async () => {
    responder = () => Promise.reject(new Error("socket closed"));

    const errors: Error[] = [];
    const logger = makeLogger({ onError: (error) => errors.push(error) });

    logger.warn("still here");

    await logger.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("socket closed");

    responder = () => Promise.resolve(new Response("ok", { status: 200 }));
    await logger.flush();
    expect(requests).toHaveLength(2);
    expect(bodyLines(requests[1]?.init)[0]).toContain('"still here"');

    await logger.close();
  });

  it("does not call onError for a successful flush", async () => {
    const errors: Error[] = [];
    const logger = makeLogger({ onError: (error) => errors.push(error) });

    logger.info("fine");
    await logger.flush();

    expect(errors).toEqual([]);

    await logger.close();
  });
});

describe("createLogger shutdown and secrets", () => {
  it("flushes pending events on close and ignores later logging", async () => {
    const logger = makeLogger();

    logger.info("shutdown");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await logger.close();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    logger.info("after close");
    await logger.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = requests[0];

    if (!call) throw new Error("expected one ingest request");
    expect(bodyLines(call.init)).toHaveLength(1);
  });

  it("strips trailing slashes from the base URL", async () => {
    const logger = makeLogger({ url: "https://logs.example.com///" });

    logger.info("x");
    await logger.close();

    expect(requests[0]?.url).toBe("https://logs.example.com/v1/events");
  });

  it("never puts the key in the URL or body and never logs events", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ].map((spy) => spy.mockImplementation(() => undefined));

    const logger = makeLogger({ onError: () => undefined });

    logger.info("hello", { note: "visible" });
    await logger.close();

    const call = requests[0];

    if (!call) throw new Error("expected one ingest request");
    expect(call.url).not.toContain(TEST_TOKEN);
    expect(String(call.init?.body)).not.toContain(TEST_TOKEN);
    expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);

    for (const spy of spies) {
      expect(spy.mock.calls).toHaveLength(0);
    }
  });

  it("does not include the key in a failure message", async () => {
    responder = () => Promise.resolve(new Response("forbidden", { status: 403 }));

    const errors: Error[] = [];
    const logger = makeLogger({ onError: (error) => errors.push(error) });

    logger.info("x");
    await logger.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).not.toContain(TEST_TOKEN);

    await logger.close();
  });
});

/** Responses that stay pending until the test releases them, in order. */
interface DeferredResponses {
  release(): void;
}

function deferredResponses(): DeferredResponses {
  const pending: (() => void)[] = [];

  responder = () =>
    new Promise((resolve) => {
      pending.push(() => resolve(new Response("ok", { status: 200 })));
    });

  return {
    release() {
      pending.shift()?.();
    },
  };
}

describe("createLogger backlog handling", () => {
  it("defaults to 1000-event batches", async () => {
    const logger = createLogger({ url: TEST_URL, token: TEST_TOKEN, flushMs: 60_000 });

    for (let i = 0; i < 999; i++) logger.info(`event ${i}`);
    expect(fetchMock).not.toHaveBeenCalled();

    logger.info("event 999");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyLines(requests[0]?.init)).toHaveLength(1_000);

    await logger.close();
  });

  it("sends a batch that filled up during an in-flight request once it succeeds", async () => {
    const responses = deferredResponses();
    const logger = makeLogger({ batchSize: 2 });

    logger.info("a");
    logger.info("b");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    logger.info("c");
    logger.info("d");
    logger.info("e");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    responses.release();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyLines(requests[1]?.init).map((line) => JSON.parse(line).message)).toEqual([
      "c",
      "d",
      "e",
    ]);

    responses.release();
    await logger.close();
  });

  it("caps a single request at 5000 events and drains the rest on close", async () => {
    const responses = deferredResponses();
    const logger = makeLogger({ batchSize: 1_000 });

    for (let i = 0; i < 1_000; i++) logger.info(`first ${i}`);

    for (let i = 0; i < 7_000; i++) logger.info(`queued ${i}`);

    responses.release();
    await settle();
    expect(bodyLines(requests[1]?.init)).toHaveLength(5_000);

    const closed = logger.close();

    responses.release();
    await settle();
    responses.release();
    await closed;

    expect(requests.map((request) => bodyLines(request.init).length)).toEqual([
      1_000, 5_000, 2_000,
    ]);
  });

  it("waits for an in-flight request before close resolves", async () => {
    const responses = deferredResponses();
    const logger = makeLogger({ batchSize: 1 });
    let closed = false;

    logger.info("in flight");

    const closing = (async () => {
      await logger.close();
      closed = true;
    })();

    await settle();
    expect(closed).toBe(false);

    responses.release();
    await closing;
    expect(closed).toBe(true);
  });

  it("bounds the buffer while the server is unreachable, keeping the newest events", async () => {
    responder = () => Promise.reject(new Error("connection refused"));
    const logger = makeLogger({ batchSize: 10, onError: () => undefined });

    logger.info("first");
    await logger.flush();

    for (let i = 0; i < 500; i++) logger.info(`event ${i}`);

    responder = () => Promise.resolve(new Response("ok", { status: 200 }));
    await logger.close();

    const delivered = requests
      .slice(1)
      .flatMap((request) => bodyLines(request.init).map((line) => JSON.parse(line).message));

    expect(delivered.length).toBeLessThanOrEqual(110);
    expect(delivered.at(-1)).toBe("event 499");
  });
});
