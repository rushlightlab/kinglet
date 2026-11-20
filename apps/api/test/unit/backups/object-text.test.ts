import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readObjectText } from "../../../src/backups/object-text.js";
import { BackupError } from "../../../src/backups/types.js";

const MAX_OBJECT_BYTES = 64 * 1024;

async function backupErrorOf(action: Promise<unknown>): Promise<BackupError> {
  try {
    await action;
  } catch (cause) {
    if (cause instanceof BackupError) return cause;

    throw cause;
  }

  throw new Error("expected the object read to fail");
}

describe("readObjectText", () => {
  it("destroys the stream and rejects with a 502 BackupError past the cap", async () => {
    const stream = Readable.from([
      Buffer.alloc(MAX_OBJECT_BYTES, "a"),
      Buffer.from("one byte over", "utf8"),
    ]);

    const closed = new Promise<void>((resolve) => stream.once("close", resolve));

    const error = await backupErrorOf(readObjectText(stream, MAX_OBJECT_BYTES));

    expect(error.status).toBe(502);
    expect(error.message).toBe("S3 manifest is too large");
    expect(stream.destroyed).toBe(true);
    await closed;
  });

  it("accepts a body exactly at the cap", async () => {
    const body = Buffer.alloc(MAX_OBJECT_BYTES, "b");

    const text = await readObjectText(Readable.from([body]), MAX_OBJECT_BYTES);

    expect(text).toHaveLength(MAX_OBJECT_BYTES);
    expect(text).toBe(body.toString("utf8"));
  });

  it("reads a multi-chunk body below the cap", async () => {
    const text = await readObjectText(
      Readable.from([Buffer.from("kinglet"), Buffer.from("-manifest")]),
      MAX_OBJECT_BYTES,
    );

    expect(text).toBe("kinglet-manifest");
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const body = Buffer.from("a😀b", "utf8");

    const text = await readObjectText(
      Readable.from([body.subarray(0, 2), body.subarray(2)]),
      MAX_OBJECT_BYTES,
    );

    expect(text).toBe("a😀b");
  });
});
