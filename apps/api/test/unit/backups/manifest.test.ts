import { describe, expect, it } from "vitest";
import {
  buildManifest,
  countsToJson,
  emptyCounts,
  MANIFEST_FORMAT,
  parseCountsJson,
  parseManifest,
  serializeManifest,
} from "../../../src/backups/manifest.js";
import type { ManifestInput } from "../../../src/backups/manifest.js";
import {
  manifestSigningPayload,
  signManifest,
  verifyManifestSignature,
} from "../../../src/backups/manifest-signature.js";
import type { BackupManifest } from "../../../src/backups/types.js";

const SAMPLE_ID = "0190f5b2-7c3a-7def-8abc-0123456789ab";
const SHA256 = "a".repeat(64);
const SIGNING_KEY = "test-manifest-signing-key-not-a-real-secret";

/** Canonical bytes for `sampleManifest()`, pinned independently of the helper. */
const SIGNING_PAYLOAD =
  '{"format":"kinglet-backup/v1","id":"0190f5b2-7c3a-7def-8abc-0123456789ab","createdAt":1750000000000,"appVersion":"0.3.0","schemaVersion":12,"object":"snapshots/0190f5b2-7c3a-7def-8abc-0123456789ab.db.zst","sizeBytes":4096,"objectBytes":1024,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","compression":"zstd","encryption":"none","storage":"sqlite","counts":{"projects":2,"users":3,"events":100,"monitors":4}}';

/** HMAC-SHA256 of `SIGNING_PAYLOAD` under `SIGNING_KEY`. */
const SIGNING_HMAC = "1d05ff1249de4616c1103ab60861080e67feb559fa9f7be967bcfd9cdea29b1d";

function sampleManifest(overrides: Partial<ManifestInput> = {}): BackupManifest {
  return buildManifest({
    id: SAMPLE_ID,
    createdAt: 1_750_000_000_000,
    appVersion: "0.3.0",
    schemaVersion: 12,
    sizeBytes: 4096,
    objectBytes: 1024,
    sha256: SHA256,
    encryption: "none",
    counts: { projects: 2, users: 3, events: 100, monitors: 4 },
    ...overrides,
  });
}

describe("buildManifest", () => {
  it("describes a plain snapshot with the fixed format fields", () => {
    const manifest = sampleManifest();

    expect(manifest.format).toBe(MANIFEST_FORMAT);
    expect(manifest.object).toBe(`snapshots/${SAMPLE_ID}.db.zst`);
    expect(manifest.compression).toBe("zstd");
    expect(manifest.storage).toBe("sqlite");
    expect(manifest.encryption).toBe("none");
    expect(manifest.counts).toEqual({ projects: 2, users: 3, events: 100, monitors: 4 });
    expect(manifest.signature).toBeUndefined();
  });

  it("uses the age object name when the snapshot is encrypted", () => {
    const manifest = sampleManifest({ encryption: "age" });

    expect(manifest.object).toBe(`snapshots/${SAMPLE_ID}.db.zst.age`);
  });
});

describe("manifest serialization", () => {
  it("round-trips a signed manifest through serialize and parse", () => {
    const signed = signManifest(sampleManifest(), SIGNING_KEY);
    const parsed = parseManifest(serializeManifest(signed));

    expect(parsed).toEqual(signed);

    if (!parsed) throw new Error("expected the signed manifest to parse");
    expect(verifyManifestSignature(parsed, SIGNING_KEY)).toBe(true);
  });

  it("ends the serialized manifest with a newline", () => {
    const raw = serializeManifest(sampleManifest());

    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().endsWith("}")).toBe(true);
  });

  it("parses an unsigned manifest and leaves the signature absent", () => {
    const parsed = parseManifest(serializeManifest(sampleManifest()));

    expect(parsed?.signature).toBeUndefined();
  });

  it("rejects malformed JSON and non-object payloads", () => {
    expect(parseManifest("{not json")).toBeNull();
    expect(parseManifest("[]")).toBeNull();
    expect(parseManifest("null")).toBeNull();
    expect(parseManifest('"manifest"')).toBeNull();
  });

  it("rejects an unknown manifest format", () => {
    const raw = JSON.stringify({ ...sampleManifest(), format: "kinglet-backup/v2" });

    expect(parseManifest(raw)).toBeNull();
  });

  it("rejects ids that are not UUID v7 values", () => {
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), id: "not-a-uuid" }))).toBeNull();
    expect(
      parseManifest(
        JSON.stringify({
          ...sampleManifest(),
          id: "0190f5b2-7c3a-4def-8abc-0123456789ab",
        }),
      ),
    ).toBeNull();
  });

  it("rejects impossible or missing timestamps", () => {
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), createdAt: 0 }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), createdAt: -1 }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), createdAt: 1.5 }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), createdAt: "1" }))).toBeNull();
  });

  it("rejects empty or oversized app versions", () => {
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), appVersion: "" }))).toBeNull();
    expect(
      parseManifest(JSON.stringify({ ...sampleManifest(), appVersion: "v".repeat(65) })),
    ).toBeNull();
    expect(
      parseManifest(JSON.stringify({ ...sampleManifest(), appVersion: "v".repeat(64) })),
    ).not.toBeNull();
  });

  it("rejects non-positive schema and byte counts", () => {
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), schemaVersion: 0 }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), schemaVersion: 1.5 }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), objectBytes: 0 }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), objectBytes: -1 }))).toBeNull();
  });

  it("rejects sizeBytes=0 so the decoded-size check cannot be disabled", () => {
    const unsigned = sampleManifest();
    const raw = JSON.stringify({ ...unsigned, sizeBytes: 0 });

    expect(parseManifest(raw)).toBeNull();
  });

  it("rejects malformed sha256 digests", () => {
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), sha256: "abc" }))).toBeNull();
    expect(
      parseManifest(JSON.stringify({ ...sampleManifest(), sha256: "A".repeat(64) })),
    ).toBeNull();
    expect(
      parseManifest(JSON.stringify({ ...sampleManifest(), sha256: "a".repeat(63) })),
    ).toBeNull();
  });

  it("rejects unsupported compression, storage, and encryption values", () => {
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), compression: "gzip" }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), storage: "postgres" }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), encryption: "gpg" }))).toBeNull();
  });

  it("rejects an object path that does not match the id and encryption", () => {
    const plain = sampleManifest();

    expect(
      parseManifest(JSON.stringify({ ...plain, object: `snapshots/${SAMPLE_ID}.db.zst.age` })),
    ).toBeNull();
    expect(
      parseManifest(JSON.stringify({ ...plain, object: "snapshots/other.db.zst" })),
    ).toBeNull();
    expect(
      parseManifest(
        JSON.stringify({
          ...sampleManifest({ encryption: "age" }),
          object: `snapshots/${SAMPLE_ID}.db.zst`,
        }),
      ),
    ).toBeNull();
  });

  it("defaults missing or invalid counts to zero", () => {
    const parsed = parseManifest(
      JSON.stringify({
        ...sampleManifest(),
        counts: { projects: 1, users: -2, events: 3.5 },
      }),
    );

    expect(parsed?.counts).toEqual({ projects: 1, users: 0, events: 0, monitors: 0 });
  });

  it("rejects a non-object counts field", () => {
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), counts: null }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), counts: [] }))).toBeNull();
  });

  it("rejects a malformed signature block", () => {
    expect(
      parseManifest(
        JSON.stringify({ ...sampleManifest(), signature: { alg: "hmac-sha256", value: "abc" } }),
      ),
    ).toBeNull();
    expect(
      parseManifest(
        JSON.stringify({
          ...sampleManifest(),
          signature: { alg: "sha256", value: SHA256 },
        }),
      ),
    ).toBeNull();
    expect(parseManifest(JSON.stringify({ ...sampleManifest(), signature: "signed" }))).toBeNull();
  });
});

describe("manifest signatures", () => {
  it("verifies a round-tripped signature", () => {
    const signed = signManifest(sampleManifest(), SIGNING_KEY);

    expect(signed.signature?.alg).toBe("hmac-sha256");
    expect(verifyManifestSignature(signed, SIGNING_KEY)).toBe(true);
  });

  it("rejects the wrong key", () => {
    const signed = signManifest(sampleManifest(), SIGNING_KEY);

    expect(verifyManifestSignature(signed, "a-different-key")).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifyManifestSignature(sampleManifest(), SIGNING_KEY)).toBe(false);
  });

  it("rejects a malformed signature value or algorithm", () => {
    const signed = signManifest(sampleManifest(), SIGNING_KEY);
    const value = signed.signature?.value ?? "";

    expect(
      verifyManifestSignature(
        { ...signed, signature: { alg: "hmac-sha256", value: "not-hex" } },
        SIGNING_KEY,
      ),
    ).toBe(false);
    expect(
      verifyManifestSignature(
        { ...signed, signature: { alg: "hmac-sha256", value: value.slice(0, -1) } },
        SIGNING_KEY,
      ),
    ).toBe(false);
  });

  it("rejects tampering with signed fields", () => {
    const signed = signManifest(sampleManifest(), SIGNING_KEY);

    expect(
      verifyManifestSignature({ ...signed, sizeBytes: signed.sizeBytes + 1 }, SIGNING_KEY),
    ).toBe(false);
    expect(
      verifyManifestSignature({ ...signed, objectBytes: signed.objectBytes + 1 }, SIGNING_KEY),
    ).toBe(false);
    expect(verifyManifestSignature({ ...signed, sha256: "b".repeat(64) }, SIGNING_KEY)).toBe(false);
    expect(
      verifyManifestSignature(
        { ...signed, counts: { ...signed.counts, events: signed.counts.events + 1 } },
        SIGNING_KEY,
      ),
    ).toBe(false);
    expect(
      verifyManifestSignature({ ...signed, createdAt: signed.createdAt + 1 }, SIGNING_KEY),
    ).toBe(false);
    expect(verifyManifestSignature({ ...signed, encryption: "age" }, SIGNING_KEY)).toBe(false);
    expect(verifyManifestSignature({ ...signed, schemaVersion: 13 }, SIGNING_KEY)).toBe(false);
  });

  it("verifies even when JSON fields are reordered", () => {
    const signed = signManifest(sampleManifest(), SIGNING_KEY);

    const reordered: BackupManifest = {
      counts: signed.counts,
      storage: signed.storage,
      signature: signed.signature,
      encryption: signed.encryption,
      compression: signed.compression,
      sha256: signed.sha256,
      objectBytes: signed.objectBytes,
      sizeBytes: signed.sizeBytes,
      object: signed.object,
      schemaVersion: signed.schemaVersion,
      appVersion: signed.appVersion,
      createdAt: signed.createdAt,
      id: signed.id,
      format: signed.format,
    };

    expect(verifyManifestSignature(reordered, SIGNING_KEY)).toBe(true);
  });

  it("does not include the signature itself in the signing payload", () => {
    const signed = signManifest(sampleManifest(), SIGNING_KEY);
    const payload = manifestSigningPayload(signed);

    expect(payload).not.toContain("signature");
    expect(payload).toContain(SAMPLE_ID);
    expect(manifestSigningPayload(signed)).toBe(payload);
  });
});

describe("manifest signing payload", () => {
  it("serializes the canonical manifest bytes", () => {
    const payload = manifestSigningPayload(sampleManifest());

    expect(payload).toBe(SIGNING_PAYLOAD);
    expect(Buffer.byteLength(payload, "utf8")).toBe(437);
  });

  it("signs those exact bytes with HMAC-SHA256", () => {
    const signed = signManifest(sampleManifest(), SIGNING_KEY);

    expect(signed.signature).toEqual({ alg: "hmac-sha256", value: SIGNING_HMAC });
  });

  it("is independent of object field order", () => {
    const manifest = sampleManifest();

    const reordered: BackupManifest = {
      counts: {
        monitors: manifest.counts.monitors,
        events: manifest.counts.events,
        users: manifest.counts.users,
        projects: manifest.counts.projects,
      },
      storage: manifest.storage,
      encryption: manifest.encryption,
      compression: manifest.compression,
      sha256: manifest.sha256,
      objectBytes: manifest.objectBytes,
      sizeBytes: manifest.sizeBytes,
      object: manifest.object,
      schemaVersion: manifest.schemaVersion,
      appVersion: manifest.appVersion,
      createdAt: manifest.createdAt,
      id: manifest.id,
      format: manifest.format,
    };

    expect(manifestSigningPayload(reordered)).toBe(SIGNING_PAYLOAD);
  });
});

describe("counts helpers", () => {
  it("parses stored counts and defaults invalid values", () => {
    expect(parseCountsJson('{"projects":1,"users":2,"events":3,"monitors":4}')).toEqual({
      projects: 1,
      users: 2,
      events: 3,
      monitors: 4,
    });
    expect(parseCountsJson('{"projects":1}')).toEqual({
      projects: 1,
      users: 0,
      events: 0,
      monitors: 0,
    });
    expect(parseCountsJson('{"events":-1,"monitors":1.5}')).toEqual(emptyCounts());
    expect(parseCountsJson("not json")).toEqual(emptyCounts());
    expect(parseCountsJson("[]")).toEqual(emptyCounts());
  });

  it("round-trips counts JSON", () => {
    const counts = { projects: 2, users: 4, events: 500, monitors: 3 };

    expect(JSON.parse(countsToJson(counts))).toEqual(counts);
    expect(emptyCounts()).toEqual({ projects: 0, users: 0, events: 0, monitors: 0 });
  });
});
