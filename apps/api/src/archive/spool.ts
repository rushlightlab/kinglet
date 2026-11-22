/**
 * Decompressed spool cap for one archive part.
 *
 * The exporter writes at most 10,000 ingest-valid lines per part. A message is
 * capped at 8,000 characters, and escaping every one of them as a `\uXXXX`
 * control sequence is 48 KiB. Add the 32 KiB fields cap and ~1 KiB of line
 * metadata and a part can reach about 790 MiB, past the earlier 512 MiB guess.
 * 1 GiB covers that bound without letting a hostile bucket object spool without
 * limit; a legitimate part is orders of magnitude smaller.
 */
export const MAX_SPOOL_BYTES = 1024 * 1024 * 1024;

/**
 * Longest NDJSON line import accepts. By the bound above a legitimate line is
 * about 81 KiB; readline holds each line as one string, so without a cap a
 * single line could grow toward the spool cap and past V8's string limit.
 */
export const MAX_LINE_BYTES = 256 * 1024;

/**
 * Resolve the optional spool cap. Production passes no value and gets the
 * default. A supplied zero, negative, or non-finite value would silently
 * disable the bound, so reject it loudly instead.
 */
export function resolveMaxSpoolBytes(limit?: number): number {
  if (limit === undefined) return MAX_SPOOL_BYTES;

  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError("maxSpoolBytes must be a positive finite number");
  }

  return limit;
}
