/**
 * Minimal SSE client for `app.request` responses. Tests read one complete frame
 * at a time with a bounded wait; the timeout uses the real timer even when a
 * test fakes timers for the server's heartbeat or lifetime.
 */

export interface SseFrame {
  event: string | null;
  data: string | null;
  comment: string | null;
}

const REAL_SET_TIMEOUT = globalThis.setTimeout;
const REAL_CLEAR_TIMEOUT = globalThis.clearTimeout;

export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private closed = false;

  constructor(response: Response) {
    if (response.body === null) throw new Error("SSE response has no body");

    this.reader = response.body.getReader();
  }

  /** Next complete frame, or null once the server closes the stream. */
  async next(timeoutMs = 5_000): Promise<SseFrame | null> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");

      if (boundary >= 0) {
        const raw = this.buffer.slice(0, boundary);

        this.buffer = this.buffer.slice(boundary + 2);

        return parseFrame(raw);
      }

      if (this.closed) return null;

      const remaining = deadline - Date.now();

      if (remaining <= 0) throw new Error("timed out waiting for an SSE frame");

      const chunk = await readChunk(this.reader, remaining);

      if (chunk === null) {
        this.closed = true;
        continue;
      }

      this.buffer += this.decoder.decode(chunk, { stream: true });
    }
  }

  /**
   * Next comment line, or null once the server closes. Unlike `next()`, this
   * accepts a single trailing newline: the log stream's heartbeat writes
   * `": ping\n"` without a blank-line frame terminator. Use it only while the
   * stream has no data frames (for example a heartbeat control stream).
   */
  async nextComment(timeoutMs = 5_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const lineEnd = this.buffer.indexOf("\n");

      if (lineEnd >= 0) {
        const line = this.buffer.slice(0, lineEnd);

        this.buffer = this.buffer.slice(lineEnd + 1);

        if (!line.startsWith(":")) {
          throw new Error("expected an SSE comment line");
        }

        return line.slice(1).trim();
      }

      if (this.closed) return null;

      const remaining = deadline - Date.now();

      if (remaining <= 0) throw new Error("timed out waiting for an SSE comment");

      const chunk = await readChunk(this.reader, remaining);

      if (chunk === null) {
        this.closed = true;
        continue;
      }

      this.buffer += this.decoder.decode(chunk, { stream: true });
    }
  }

  /**
   * Cancels the client reader and waits for the cancellation contract to
   * settle. For `/v1/stream`, cancellation runs the route's `onAbort` cleanup,
   * which unsubscribes from the event bus synchronously. For
   * `/v1/system/events`, `onAbort` marks the stream closed and its `finally`
   * block unsubscribes. Awaiting cancellation replaces a fixed sleep.
   */
  async close(): Promise<void> {
    if (!this.closed) {
      try {
        await this.reader.cancel();
      } catch {
        // The server may have closed the stream first.
      }
    }

    await this.reader.closed.catch(() => undefined);
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      reader.read().then((result) => (result.done ? null : result.value)),
      new Promise<never>((_, reject) => {
        timer = REAL_SET_TIMEOUT(
          () => reject(new Error("timed out waiting for an SSE chunk")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) REAL_CLEAR_TIMEOUT(timer);
  }
}

function parseFrame(raw: string): SseFrame {
  const comments: string[] = [];
  const data: string[] = [];
  let event: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      comments.push(line.slice(1).trim());
    } else if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  return {
    event,
    data: data.length > 0 ? data.join("\n") : null,
    comment: comments.length > 0 ? comments.join("\n") : null,
  };
}
