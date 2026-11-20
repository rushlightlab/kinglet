import { createHmac, timingSafeEqual } from "node:crypto";
import type { BackupManifest } from "./types.js";

/**
 * Manifest authentication. The manifest describes the snapshot; without a MAC
 * a bucket writer can replace it and have restore install a different database.
 * The HMAC key defaults to the S3 secret and can be overridden with a stable
 * dedicated secret.
 *
 * The signing payload is built field by field (not from object order) so a
 * harmless JSON field reorder cannot invalidate a legitimate manifest.
 */

export function manifestSigningPayload(manifest: BackupManifest): string {
  return JSON.stringify({
    format: manifest.format,
    id: manifest.id,
    createdAt: manifest.createdAt,
    appVersion: manifest.appVersion,
    schemaVersion: manifest.schemaVersion,
    object: manifest.object,
    sizeBytes: manifest.sizeBytes,
    objectBytes: manifest.objectBytes,
    sha256: manifest.sha256,
    compression: manifest.compression,
    encryption: manifest.encryption,
    storage: manifest.storage,
    counts: {
      projects: manifest.counts.projects,
      users: manifest.counts.users,
      events: manifest.counts.events,
      monitors: manifest.counts.monitors,
    },
  });
}

export function signManifest(manifest: BackupManifest, key: string): BackupManifest {
  const value = createHmac("sha256", key).update(manifestSigningPayload(manifest)).digest("hex");

  return { ...manifest, signature: { alg: "hmac-sha256", value } };
}

export function verifyManifestSignature(manifest: BackupManifest, key: string): boolean {
  const signature = manifest.signature;

  if (!signature || signature.alg !== "hmac-sha256") return false;

  const expected = createHmac("sha256", key).update(manifestSigningPayload(manifest)).digest("hex");
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(signature.value, "hex");

  return left.length === right.length && timingSafeEqual(left, right);
}
