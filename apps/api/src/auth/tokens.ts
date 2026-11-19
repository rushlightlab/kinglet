import { createHash, randomBytes, randomInt } from "node:crypto";

/** SHA-256 hex used for API key hashes. */
export function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Avoid ambiguous glyphs so a copied password is hard to mistype.
const PASSWORD_LOWER = "abcdefghijkmnopqrstuvwxyz";
const PASSWORD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PASSWORD_DIGITS = "23456789";
const PASSWORD_ALL = PASSWORD_LOWER + PASSWORD_UPPER + PASSWORD_DIGITS;

function pick(chars: string): string {
  return chars[randomInt(0, chars.length)]!;
}

/**
 * A generated password for admin-created accounts (shown once).
 *
 * Always 16 characters and guaranteed to satisfy the same policy as
 * user-set passwords: 12+ chars with lower, upper, and a number.
 */
export function generatePassword(): string {
  const chars = [pick(PASSWORD_LOWER), pick(PASSWORD_UPPER), pick(PASSWORD_DIGITS)];
  while (chars.length < 16) chars.push(pick(PASSWORD_ALL));

  // Fisher-Yates so the guaranteed characters are not stuck at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }
  return chars.join("");
}

/** A long random token (API key material). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
