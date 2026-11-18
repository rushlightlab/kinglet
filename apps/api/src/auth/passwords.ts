import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** Hash a password with scrypt (built-in, no native deps). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4] ?? "", "base64url");
    const expected = Buffer.from(parts[5] ?? "", "base64url");
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A short random password for admin-generated accounts (shown once). */
export function generatePassword(): string {
  return randomBytes(12).toString("base64url");
}

/** A long random token (session ids, API key material). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
