import { afterEach, describe, expect, it } from "vitest";
import {
  channelContext,
  configureSecrets,
  decodeSecretKey,
  isSealed,
  openSecret,
  retirePlaintextSecrets,
  sealSecret,
  secretFingerprint,
  secretsConfigured,
} from "../../src/secrets.ts";

// Fake keys for tests only.
const KEY_A = Buffer.alloc(32, 7);
const KEY_B = Buffer.alloc(32, 9);

const TARGET =
  "https://api.telegram.org/bot123456:FAKE_fake_FAKE_fake_token_00/sendMessage?chat_id=1";

afterEach(() => configureSecrets(null));

describe("decodeSecretKey", () => {
  it("accepts 32+ bytes as base64, base64url, or hex", () => {
    expect(decodeSecretKey(KEY_A.toString("base64"))?.length).toBe(32);
    expect(decodeSecretKey(KEY_A.toString("base64url"))?.length).toBe(32);
    expect(decodeSecretKey(KEY_A.toString("hex"))?.length).toBe(32);
  });

  it("rejects short keys", () => {
    expect(decodeSecretKey(Buffer.alloc(16, 1).toString("base64"))).toBeNull();
    expect(decodeSecretKey("password")).toBeNull();
  });

  it("rejects a passphrase that lenient base64 would half-decode", () => {
    // 47 characters with spaces: lenient decoding used to yield 35 key bytes.
    expect(decodeSecretKey("correct horse battery staple and more words too")).toBeNull();
    expect(decodeSecretKey("correcthorsebatterystapleandmorewordstoo1234567")).toBeNull();
  });
});

describe("plaintext secrets", () => {
  it("read as-is until boot has sealed them, then read as corrupt", () => {
    configureSecrets(KEY_A);

    expect(openSecret(TARGET, channelContext("c1"))).toEqual({
      ok: true,
      value: TARGET,
      sealed: false,
    });

    retirePlaintextSecrets();

    expect(openSecret(TARGET, channelContext("c1"))).toEqual({ ok: false, reason: "corrupt" });

    const sealed = sealSecret(TARGET, channelContext("c1"));

    expect(openSecret(sealed, channelContext("c1"))).toMatchObject({ ok: true, value: TARGET });
  });

  it("stay readable without a key, which cannot retire them", () => {
    configureSecrets(null);
    retirePlaintextSecrets();

    expect(openSecret(TARGET, channelContext("c1"))).toMatchObject({ ok: true, sealed: false });
  });
});

describe("sealing", () => {
  it("round-trips a secret and never stores it in the clear", () => {
    configureSecrets(KEY_A);
    const sealed = sealSecret(TARGET, channelContext("c1"));

    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain("FAKE");
    expect(openSecret(sealed, channelContext("c1"))).toEqual({
      ok: true,
      value: TARGET,
      sealed: true,
    });
  });

  it("uses a fresh IV, so equal secrets don't look equal", () => {
    configureSecrets(KEY_A);

    expect(sealSecret(TARGET, channelContext("c1"))).not.toBe(
      sealSecret(TARGET, channelContext("c1")),
    );
  });

  it("binds a value to its row: copying it onto another row fails", () => {
    configureSecrets(KEY_A);
    const sealed = sealSecret(TARGET, channelContext("c1"));

    expect(openSecret(sealed, channelContext("c2"))).toEqual({ ok: false, reason: "corrupt" });
  });

  it("detects tampering", () => {
    configureSecrets(KEY_A);
    const sealed = sealSecret(TARGET, channelContext("c1"));
    // Flip one character well inside the ciphertext (not trailing padding bits).
    const at = sealed.length - 10;
    const tampered = `${sealed.slice(0, at)}${sealed[at] === "A" ? "B" : "A"}${sealed.slice(at + 1)}`;

    expect(openSecret(tampered, channelContext("c1"))).toEqual({ ok: false, reason: "corrupt" });
  });

  it("reports a value sealed with another key, or with no key set", () => {
    configureSecrets(KEY_A);
    const sealed = sealSecret(TARGET, channelContext("c1"));

    configureSecrets(KEY_B);
    expect(openSecret(sealed, channelContext("c1"))).toEqual({ ok: false, reason: "wrong-key" });

    configureSecrets(null);
    expect(openSecret(sealed, channelContext("c1"))).toEqual({ ok: false, reason: "no-key" });
  });

  it("reads plaintext from before encryption as-is", () => {
    expect(openSecret(TARGET, channelContext("c1"))).toEqual({
      ok: true,
      value: TARGET,
      sealed: false,
    });
  });

  it("refuses to seal without a key", () => {
    expect(secretsConfigured()).toBe(false);
    expect(() => sealSecret(TARGET, channelContext("c1"))).toThrow(/KINGLET_SECRET_KEY/);
  });
});

describe("fingerprints", () => {
  it("are stable for one key and differ between keys", () => {
    expect(secretFingerprint(TARGET)).toBeNull();

    configureSecrets(KEY_A);
    const a = secretFingerprint(TARGET);

    expect(secretFingerprint(TARGET)).toBe(a);

    configureSecrets(KEY_B);
    expect(secretFingerprint(TARGET)).not.toBe(a);
  });
});
