/**
 * @kinglet/sdk-node — batching log client for Kinglet.
 *
 * Buffers events in-process and flushes them to your Kinglet server as a
 * single NDJSON batch (default: every 1000ms or 1000 events, whichever comes
 * first). Never blocks your app: on failure the batch is re-queued (with a
 * cap) and reported through `onError`.
 */

export interface LoggerOptions {
  /** Kinglet base URL, e.g. "https://logs.example.com" */
  url: string;
  /**
   * Project API key (`kl_…`) with the ingest scope. The key is bound to a
   * project on the server, so this also selects where events are stored.
   */
  token: string;
  /** Tag every event with a service name */
  service?: string;
  /** Tag every event with an environment */
  env?: string;
  /**
   * Flush after this many buffered events (default 1000, max 5000). Low-volume
   * apps flush on the timer long before this; it matters when an app logs
   * hundreds of events per second.
   */
  batchSize?: number;
  /** Flush at least this often, in ms (default 1000) */
  flushMs?: number;
  /** Called when a flush fails; the app keeps running */
  onError?: (error: Error) => void;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type LogFields = JsonObject;

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  /** Flush whatever is buffered now */
  flush(): Promise<void>;
  /** Flush and stop the timer — call this in your shutdown handler */
  close(): Promise<void>;
}

interface PendingEvent {
  level: string;
  message: string;
  fields?: LogFields;
  ts: number;
  service?: string;
  env?: string;
}

/**
 * Events per request. The server accepts up to 10,000 per batch; staying at
 * half keeps a backlog drain well under that and the 8 MB body limit for
 * typical events.
 */
const MAX_EVENTS_PER_REQUEST = 5_000;

export function createLogger(opts: LoggerOptions): Logger {
  const batchSize = Math.min(
    Math.max(1, Math.trunc(opts.batchSize ?? 1_000)),
    MAX_EVENTS_PER_REQUEST,
  );

  const flushMs = opts.flushMs ?? 1000;
  const endpoint = opts.url.replace(/\/+$/, "") + "/v1/events";
  const maxBuffered = batchSize * 10;

  let buffer: PendingEvent[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let closing = false;
  let inFlight: Promise<void> | null = null;

  function schedule(): void {
    if (timer) return;
    timer = setInterval(() => void flush(), flushMs);
    // Don't keep the process alive just for log flushing.
    timer.unref?.();
  }

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** One request. Returns false (after re-queueing) when it fails. */
  async function send(): Promise<boolean> {
    // A backlog that built up during a slow request ships in bounded chunks;
    // the server would otherwise truncate an oversized batch.
    const batch = buffer.splice(0, MAX_EVENTS_PER_REQUEST);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.token}`,
          "content-type": "application/x-ndjson",
        },
        body: batch.map((e) => JSON.stringify(e)).join("\n"),
      });

      if (!res.ok) throw new Error(`kinglet ingest failed: HTTP ${res.status}`);

      return true;
    } catch (err) {
      // Re-queue the batch (newest wins if we overflow) and let the app live on.
      buffer = [...batch, ...buffer].slice(-maxBuffered);
      const error = err instanceof Error ? err : new Error(String(err));
      opts.onError?.(error);

      return false;
    }
  }

  /** Send what is buffered; joins a request that is already in flight. */
  function flush(): Promise<void> {
    stopTimer();

    if (inFlight) return inFlight;

    if (buffer.length === 0) return Promise.resolve();

    const request = sendAndContinue();

    inFlight = request;

    return request;
  }

  async function sendAndContinue(): Promise<void> {
    const delivered = await send();

    inFlight = null;

    // Events logged while the request was in flight have no pending trigger.
    // Drain a full batch right away after a success; otherwise (including
    // after a failure) let the timer retry instead of hammering the server.
    if (closing || buffer.length === 0) return;

    if (delivered && buffer.length >= batchSize) void flush();
    else schedule();
  }

  function enqueue(level: string, message: string, fields?: LogFields): void {
    if (closing) return;

    const event: PendingEvent = {
      level,
      message,
      fields,
      ts: Date.now(),
    };

    // `service` and `env` are top-level event fields, like the ingest
    // normalizer expects. Leave them out entirely when unset.
    if (opts.service !== undefined) event.service = opts.service;

    if (opts.env !== undefined) event.env = opts.env;

    buffer.push(event);

    // Bound memory while the server is slow or down: newest events win, as
    // with a re-queued batch. Trim in steps so this is not O(n) per event.
    if (buffer.length > maxBuffered + batchSize) buffer.splice(0, buffer.length - maxBuffered);

    if (buffer.length >= batchSize) void flush();
    else schedule();
  }

  return {
    trace: (m, f) => enqueue("trace", m, f),
    debug: (m, f) => enqueue("debug", m, f),
    info: (m, f) => enqueue("info", m, f),
    warn: (m, f) => enqueue("warn", m, f),
    error: (m, f) => enqueue("error", m, f),
    fatal: (m, f) => enqueue("fatal", m, f),
    flush,
    async close(): Promise<void> {
      closing = true;
      stopTimer();

      // Wait out a request in flight, then drain the rest in bounded chunks.
      // Stop at the first failure: the batch is re-queued, so no progress.
      if (inFlight) await inFlight;

      while (buffer.length > 0) {
        const before = buffer.length;

        await flush();

        if (buffer.length >= before) return;
      }
    },
  };
}
