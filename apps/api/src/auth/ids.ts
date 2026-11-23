import { randomFillSync } from "node:crypto";

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/**
 * Pooled CSPRNG buffer: each UUID v7 consumes 10 random bytes, so a 4 KiB pool
 * serves ~409 IDs per OpenSSL syscall while preserving full cryptographic
 * randomness.
 */
const RANDOM_POOL_SIZE = 4096;
const randomPool = new Uint8Array(RANDOM_POOL_SIZE);
let randomPoolOffset = RANDOM_POOL_SIZE;

function nextRandomOffset(): number {
  if (randomPoolOffset + 10 > RANDOM_POOL_SIZE) {
    randomFillSync(randomPool);
    randomPoolOffset = 0;
  }

  const offset = randomPoolOffset;
  randomPoolOffset += 10;

  return offset;
}

/**
 * UUID v7: 48-bit Unix ms timestamp + version + 74 bits of randomness.
 * Lexicographically sortable by creation time, which is why it is a good fit
 * for public identifiers.
 */
export function uuidv7(): string {
  const ts = Date.now();
  const hi = Math.floor(ts / 0x1_0000_0000);
  const lo = ts >>> 0;
  const o = nextRandomOffset();

  const b0 = (hi >>> 8) & 0xff;
  const b1 = hi & 0xff;
  const b2 = (lo >>> 24) & 0xff;
  const b3 = (lo >>> 16) & 0xff;
  const b4 = (lo >>> 8) & 0xff;
  const b5 = lo & 0xff;
  const b6 = ((randomPool[o] ?? 0) & 0x0f) | 0x70;
  const b7 = randomPool[o + 1] ?? 0;
  const b8 = ((randomPool[o + 2] ?? 0) & 0x3f) | 0x80;
  const b9 = randomPool[o + 3] ?? 0;
  const b10 = randomPool[o + 4] ?? 0;
  const b11 = randomPool[o + 5] ?? 0;
  const b12 = randomPool[o + 6] ?? 0;
  const b13 = randomPool[o + 7] ?? 0;
  const b14 = randomPool[o + 8] ?? 0;
  const b15 = randomPool[o + 9] ?? 0;

  return (
    `${HEX[b0]}${HEX[b1]}${HEX[b2]}${HEX[b3]}-` +
    `${HEX[b4]}${HEX[b5]}-` +
    `${HEX[b6]}${HEX[b7]}-` +
    `${HEX[b8]}${HEX[b9]}-` +
    `${HEX[b10]}${HEX[b11]}${HEX[b12]}${HEX[b13]}${HEX[b14]}${HEX[b15]}`
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
