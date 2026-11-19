import { createHash, randomBytes } from "node:crypto";

/** SHA-256 hex used for API key hashes. */
export function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A short random password for admin-created accounts (shown once). */
export function generatePassword(): string {
  return randomBytes(12).toString("base64url");
}

/** A long random token (API key material). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
