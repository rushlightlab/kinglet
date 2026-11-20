import fs from "node:fs";
import { Readable } from "node:stream";
import { isUuid } from "../../src/auth/ids.js";
import { signManifest, verifyManifestSignature } from "../../src/backups/manifest-signature.js";
import { relativeObjectKey } from "../../src/backups/s3.js";
import type { BackupObject, BackupObjectStore, BackupUploadInput } from "../../src/backups/s3.js";
import { BackupError } from "../../src/backups/types.js";
import type { BackupEncryption, BackupManifest } from "../../src/backups/types.js";

/**
 * In-memory BackupStore adapter for integration tests. It mirrors the S3
 * adapter's key derivation and manifest signing rules but never opens a socket
 * or touches a bucket.
 */

interface StoredObject {
  body: Buffer;
  lastModified: number;
  metadata: Record<string, string>;
}

const DEFAULT_SIGNING_KEY = "kinglet-test-manifest-signing-key";

export class InMemoryBackupStore implements BackupObjectStore {
  readonly prefix = "kinglet-test";
  readonly manifestPrefix = `${this.prefix}/manifests/`;
  readonly snapshotPrefix = `${this.prefix}/snapshots/`;

  private readonly signingKey: string;
  private readonly objects = new Map<string, StoredObject>();

  constructor(signingKey = DEFAULT_SIGNING_KEY) {
    this.signingKey = signingKey;
  }

  manifestKey(id: string): string {
    return `${this.manifestPrefix}${id}.json`;
  }

  objectKey(id: string, encryption: BackupEncryption): string {
    return `${this.prefix}/${relativeObjectKey(id, encryption)}`;
  }

  signManifest(manifest: BackupManifest): BackupManifest {
    return signManifest(manifest, this.signingKey);
  }

  verifyManifestSignature(manifest: BackupManifest): boolean {
    return verifyManifestSignature(manifest, this.signingKey);
  }

  manifestId(key: string): string | null {
    if (!key.startsWith(this.manifestPrefix) || !key.endsWith(".json")) return null;

    const id = key.slice(this.manifestPrefix.length, -".json".length).toLowerCase();

    return isUuid(id) ? id : null;
  }

  objectId(key: string): string | null {
    if (!key.startsWith(this.snapshotPrefix)) return null;

    let name = key.slice(this.snapshotPrefix.length);

    if (name.includes("/")) return null;

    if (name.endsWith(".db.zst.age")) {
      name = name.slice(0, -".db.zst.age".length);
    } else if (name.endsWith(".db.zst")) {
      name = name.slice(0, -".db.zst".length);
    } else {
      return null;
    }

    const id = name.toLowerCase();

    return isUuid(id) ? id : null;
  }

  async listObjects(prefix: string): Promise<BackupObject[]> {
    const objects: BackupObject[] = [];

    for (const [key, object] of this.objects) {
      if (key.startsWith(prefix)) {
        objects.push({ key, lastModified: object.lastModified });
      }
    }

    return objects;
  }

  async getObjectStream(key: string): Promise<Readable> {
    const object = this.objects.get(key);

    if (object === undefined) throw new BackupError("test backup object is missing", 404);

    return Readable.from([object.body]);
  }

  async getObjectText(key: string, maxBytes: number): Promise<string> {
    const object = this.objects.get(key);

    if (object === undefined) throw new BackupError("test backup object is missing", 404);

    if (object.body.length > maxBytes) throw new BackupError("S3 manifest is too large", 502);

    return object.body.toString("utf8");
  }

  async headObject(
    key: string,
  ): Promise<{ ContentLength?: number; Metadata?: Record<string, string> }> {
    const object = this.objects.get(key);

    if (object === undefined) throw new BackupError("test backup object is missing", 404);

    return { ContentLength: object.body.length, Metadata: object.metadata };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async putManifest(key: string, body: string): Promise<void> {
    this.objects.set(key, {
      body: Buffer.from(body, "utf8"),
      lastModified: Date.now(),
      metadata: {},
    });
  }

  async uploadFile(input: BackupUploadInput): Promise<void> {
    const body = await fs.promises.readFile(input.filePath);

    if (body.length !== input.sizeBytes) {
      throw new BackupError("test upload size did not match the request", 500);
    }

    this.objects.set(input.key, {
      body,
      lastModified: Date.now(),
      metadata: { sha256: input.sha256 },
    });
    input.onProgress(body.length, body.length);
  }

  async presignDownload(
    key: string,
    filename: string,
  ): Promise<{ url: string; expiresAt: number }> {
    return {
      url: `https://backup.invalid/${encodeURIComponent(key)}?filename=${encodeURIComponent(filename)}`,
      expiresAt: Date.now() + 300_000,
    };
  }

  async testConnection(): Promise<void> {}

  destroy(): void {}

  /** Test-only seeding helpers. */
  putObject(key: string, body: Buffer | string, lastModified = Date.now()): void {
    this.objects.set(key, {
      body: Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"),
      lastModified,
      metadata: {},
    });
  }

  getObject(key: string): Buffer | null {
    return this.objects.get(key)?.body ?? null;
  }

  hasObject(key: string): boolean {
    return this.objects.has(key);
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }
}
