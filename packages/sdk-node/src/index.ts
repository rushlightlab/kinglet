/**
 * @kinglet/sdk-node — batching log client for Kinglet.
 *
 * Buffers events in-process and flushes them to your Kinglet server as a
 * single NDJSON batch (default: every 1000ms or 200 events, whichever comes
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
  /** Flush after this many buffered events (default 200) */
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

export function createLogger(opts: LoggerOptions): Logger {
  const batchSize = opts.batchSize ?? 200;
  const flushMs = opts.flushMs ?? 1000;
  const endpoint = opts.url.replace(/\/+$/, "") + "/v1/events";
  const maxBuffered = batchSize * 10;

  let buffer: PendingEvent[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let closing = false;
  let flushing = false;

  function schedule(): void {
    if (timer) return;
    timer = setInterval(() => void flush(), flushMs);
    // Don't keep the process alive just for log flushing.
    timer.unref?.();
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer;
    buffer = [];

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
    } catch (err) {
      // Re-queue the batch (newest wins if we overflow) and let the app live on.
      buffer = [...batch, ...buffer].slice(-maxBuffered);
      const error = err instanceof Error ? err : new Error(String(err));
      opts.onError?.(error);
    } finally {
      flushing = false;
    }
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

      if (timer) clearInterval(timer);
      await flush();
    },
  };
}
