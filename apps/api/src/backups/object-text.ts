import type { Readable } from "node:stream";
import { BackupError } from "./types.js";

/**
 * Read a bounded UTF-8 object body from a stream. The cap is enforced while
 * reading, and an oversized object destroys the stream before its remaining
 * bytes are buffered. Keep this pure so the size bound is unit-testable without
 * an S3 client.
 */
export async function readObjectText(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    total += buffer.length;

    if (total > maxBytes) {
      stream.destroy();
      throw new BackupError("S3 manifest is too large", 502);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}
