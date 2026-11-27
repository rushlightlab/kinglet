import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption at rest for secrets Kinglet must store: notification channel
 * targets (webhook URLs, bot tokens, API keys) and legacy per-monitor webhook
 * URLs.
 *
 * KINGLET_SECRET_KEY (32+ random bytes, base64 or hex) is the master key. Two
 * keys are derived from it with HKDF: one for AES-256-GCM, one for HMAC
 * fingerprints that replace the plaintext uniqueness check. Each value is
 * bound to its row with associated data, so a ciphertext can't be copied onto
 * another row. Stored form:
 *
 *   enc:v1:<key id>:<iv base64url>:<ciphertext+tag base64url>
 *
 * The key id names the key that sealed a value, so a changed or missing key is
 * reported as "locked" instead of failing deep inside delivery.
 *
 * Without a key, values that were stored before encryption existed still read
 * as plaintext, and features that would store a new secret are refused.
 */

const PREFIX = "enc:v1:";
const MIN_KEY_BYTES = 32;

interface SecretKeys {
  enc: Buffer;
  mac: Buffer;
  kid: string;
}

let keys: SecretKeys | null = null;

/**
 * Set once every plaintext secret stored before the key was configured has
 * been sealed (sealStoredSecrets). From then on an unsealed value can only be
 * a row someone wrote around Kinglet, so it is refused instead of trusted.
 */
let plaintextRetired = false;

function derive(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
}

/**
 * Decode KINGLET_SECRET_KEY: hex, or canonical base64/base64url, at least 32
 * bytes. Anything else, such as a typed passphrase that lenient base64 would
 * half-decode, is refused: the master key is used without a password KDF, so
 * it must be random bytes.
 */
export function decodeSecretKey(raw: string): Buffer | null {
  const value = raw.trim();
  let decoded: Buffer;

  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    decoded = Buffer.from(value, "hex");
  } else {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
    decoded = Buffer.from(base64, "base64");

    // Canonical only: re-encoding must give back the same characters.
    if (decoded.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) return null;
  }

  return decoded.length >= MIN_KEY_BYTES ? decoded : null;
}

/** Install the master key for this process; null turns encryption off. */
export function configureSecrets(master: Buffer | null): void {
  plaintextRetired = false;

  if (master === null) {
    keys = null;

    return;
  }

  keys = {
    enc: derive(master, "kinglet secrets v1 encryption"),
    mac: derive(master, "kinglet secrets v1 fingerprint"),
    kid: derive(master, "kinglet secrets v1 key id").subarray(0, 4).toString("hex"),
  };
}

export function secretsConfigured(): boolean {
  return keys !== null;
}

export function isSealed(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** Called once boot has sealed every plaintext secret under the current key. */
export function retirePlaintextSecrets(): void {
  if (keys !== null) plaintextRetired = true;
}

/** Associated data that binds a channel target to its row. */
export function channelContext(channelId: string): string {
  return `notification_channel:${channelId}`;
}

/** Associated data that binds a monitor's legacy destinations to its row. */
export function monitorContext(monitorId: string): string {
  return `monitor_channels:${monitorId}`;
}

/** Encrypt a secret for storage. Callers check `secretsConfigured()` first. */
export function sealSecret(plain: string, context: string): string {
  if (keys === null) throw new Error("KINGLET_SECRET_KEY is not set");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.enc, iv);

  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);

  return `${PREFIX}${keys.kid}:${iv.toString("base64url")}:${body.toString("base64url")}`;
}

export type OpenedSecret =
  | { ok: true; value: string; sealed: boolean }
  | { ok: false; reason: "no-key" | "wrong-key" | "corrupt" };

/**
 * Read a stored secret. Plaintext from before encryption reads as-is
 * (`sealed: false`) until boot has sealed it; after that, plaintext is a
 * downgrade and reads as corrupt. A sealed value needs the key that sealed it.
 */
export function openSecret(stored: string, context: string): OpenedSecret {
  if (!isSealed(stored)) {
    if (plaintextRetired) return { ok: false, reason: "corrupt" };

    return { ok: true, value: stored, sealed: false };
  }

  if (keys === null) return { ok: false, reason: "no-key" };
  const [kid, ivText, bodyText] = stored.slice(PREFIX.length).split(":");

  if (kid !== keys.kid) return { ok: false, reason: "wrong-key" };

  try {
    const iv = Buffer.from(ivText ?? "", "base64url");
    const body = Buffer.from(bodyText ?? "", "base64url");

    if (iv.length !== 12 || body.length < 16) return { ok: false, reason: "corrupt" };
    const decipher = createDecipheriv("aes-256-gcm", keys.enc, iv);

    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(body.subarray(body.length - 16));

    const plain = Buffer.concat([
      decipher.update(body.subarray(0, body.length - 16)),
      decipher.final(),
    ]);

    return { ok: true, value: plain.toString("utf8"), sealed: true };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

/** Keyed fingerprint for duplicate checks; null without a key. */
export function secretFingerprint(value: string): string | null {
  if (keys === null) return null;

  return createHmac("sha256", keys.mac).update(value, "utf8").digest("hex");
}

/** Why a stored secret can't be read, for UI text and delivery errors. */
export function lockedReason(reason: "no-key" | "wrong-key" | "corrupt"): string {
  switch (reason) {
    case "no-key":
      return "encrypted, but KINGLET_SECRET_KEY is not set";
    case "wrong-key":
      return "encrypted with a different KINGLET_SECRET_KEY; re-enter it";
    case "corrupt":
      return "the stored secret is damaged; re-enter it";
  }
}
