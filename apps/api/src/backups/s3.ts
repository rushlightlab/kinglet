import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { HeadObjectCommandOutput, PutObjectCommandInput } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isUuid } from "../auth/ids.js";
import type { BackupConfig } from "../env.js";
import { isFiniteNumber, isJsonObject, isString } from "../json.js";
import {
  signManifest as signManifestWithKey,
  verifyManifestSignature as verifyManifestSignatureWithKey,
} from "./manifest-signature.js";
import { BackupError } from "./types.js";
import type { BackupEncryption, BackupManifest } from "./types.js";

/**
 * S3 access for snapshots. All object keys and user-visible errors are built
 * here so callers never handle raw credentials or SDK error headers.
 */

export const DOWNLOAD_TTL_SECONDS = 300;
const DOWNLOAD_PROGRESS_STEP_BYTES = 1_048_576;

export interface BackupObject {
  key: string;
  lastModified: number | null;
}

/** Strip empty, dot, and control-character segments from an operator prefix. */
export function sanitizePrefix(raw: string): string {
  const parts: string[] = [];

  for (const segment of raw.split("/")) {
    const clean = cleanPrefixSegment(segment);

    if (clean === "" || clean === "." || clean === "..") continue;
    parts.push(clean);
  }

  return parts.length > 0 ? parts.join("/") : "kinglet";
}

function cleanPrefixSegment(segment: string): string {
  let clean = "";

  for (const char of segment.trim().replaceAll("\\", "")) {
    const code = char.codePointAt(0) ?? 0;

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    clean += char;
  }

  return clean;
}

export function relativeObjectKey(id: string, encryption: BackupEncryption): string {
  return encryption === "age" ? `snapshots/${id}.db.zst.age` : `snapshots/${id}.db.zst`;
}

export function isBackupEncryption(value: unknown): value is BackupEncryption {
  return value === "none" || value === "age";
}

/**
 * Turn any thrown value into one short line that is safe for run rows, logs,
 * and admin UI. AWS errors are reduced to their name and HTTP status so no
 * request headers, hosts, or signed material can leak.
 */
export function describeBackupError(cause: unknown): string {
  if (cause instanceof BackupError) return cause.message;

  if (cause instanceof Error) {
    const aws = awsErrorLabel(cause);

    if (aws !== null) return aws;

    if (isNodeError(cause)) {
      if (cause.code === "ENOSPC") return "not enough disk space";

      return `system error (${cause.code})`;
    }

    return normalizeMessage(cause.message) || "backup failed";
  }

  return normalizeMessage(String(cause)) || "backup failed";
}

function normalizeMessage(message: string): string {
  return message.replaceAll(/\s+/g, " ").trim().slice(0, 300);
}

function awsErrorLabel(cause: Error): string | null {
  if (!("$metadata" in cause)) return null;
  const metadata = cause.$metadata;

  if (!isJsonObject(metadata)) return null;

  const rawName = cause.name.trim();
  const label = rawName === "" || rawName === "Error" ? "S3 request failed" : rawName;
  const status = metadata.httpStatusCode;
  const nodeCode = isNodeError(cause) ? cause.code : null;

  if (isFiniteNumber(status)) return `${label} (HTTP ${status})`;

  return nodeCode === null ? label : `${label} (${nodeCode})`;
}

function isNodeError(cause: Error): cause is Error & { code: string } {
  return "code" in cause && isString(cause.code);
}

export class BackupStore {
  readonly prefix: string;
  readonly manifestPrefix: string;
  readonly snapshotPrefix: string;

  private readonly config: BackupConfig;
  private readonly client: S3Client;

  constructor(config: BackupConfig) {
    this.config = config;
    this.prefix = sanitizePrefix(config.prefix);
    this.manifestPrefix = `${this.prefix}/manifests/`;
    this.snapshotPrefix = `${this.prefix}/snapshots/`;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        sessionToken: config.sessionToken,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  manifestKey(id: string): string {
    return `${this.manifestPrefix}${id}.json`;
  }

  objectKey(id: string, encryption: BackupEncryption): string {
    return `${this.prefix}/${relativeObjectKey(id, encryption)}`;
  }

  private manifestSigningKey(): string {
    return this.config.manifestSecret ?? this.config.secretAccessKey;
  }

  signManifest(manifest: BackupManifest): BackupManifest {
    return signManifestWithKey(manifest, this.manifestSigningKey());
  }

  verifyManifestSignature(manifest: BackupManifest): boolean {
    return verifyManifestSignatureWithKey(manifest, this.manifestSigningKey());
  }

  /** Snapshot id from a full manifest key, or null when it is unrelated. */
  manifestId(key: string): string | null {
    if (!key.startsWith(this.manifestPrefix) || !key.endsWith(".json")) return null;

    const id = key.slice(this.manifestPrefix.length, -".json".length).toLowerCase();

    return isUuid(id) ? id : null;
  }

  /** Snapshot id from a full snapshot object key, or null when unrelated. */
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
    let token: string | undefined;

    for (;;) {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ContinuationToken: token,
        }),
      );

      for (const item of page.Contents ?? []) {
        if (!isString(item.Key)) continue;
        objects.push({
          key: item.Key,
          lastModified: item.LastModified?.getTime() ?? null,
        });
      }

      if (page.IsTruncated !== true) return objects;

      if (!isString(page.NextContinuationToken)) {
        throw new BackupError("S3 listing was truncated without a continuation token", 502);
      }

      token = page.NextContinuationToken;
    }
  }

  async getObjectStream(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );

    if (!result.Body) throw new BackupError("S3 object has no body", 502);

    // SAFETY: the Node S3 runtime returns a Readable for GetObject.Body; the SDK type also covers browser streams.
    return result.Body as Readable;
  }

  async getObjectText(key: string, maxBytes: number): Promise<string> {
    const stream = await this.getObjectStream(key);
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      total += buffer.length;

      if (total > maxBytes) {
        stream.destroy();
        throw new BackupError("S3 manifest is too large", 502);
      }

      chunks.push(buffer);
    }

    return Buffer.concat(chunks).toString("utf8");
  }

  async headObject(key: string): Promise<HeadObjectCommandOutput> {
    return this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async putManifest(key: string, body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentLength: Buffer.byteLength(body),
        ContentType: "application/json",
        ...this.sseParams(),
      }),
    );
  }

  async uploadFile(input: {
    key: string;
    filePath: string;
    sizeBytes: number;
    sha256: string;
    onProgress: (done: number, total: number) => void;
  }): Promise<void> {
    const body = fs.createReadStream(input.filePath);

    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.config.bucket,
          Key: input.key,
          Body: body,
          ContentLength: input.sizeBytes,
          ContentType: "application/octet-stream",
          Metadata: { sha256: input.sha256 },
          ...this.sseParams(),
        },
        partSize: this.config.partSizeBytes,
        queueSize: 4,
      });

      upload.on("httpUploadProgress", (progress) => {
        const done = isFiniteNumber(progress.loaded) ? progress.loaded : 0;
        const total = isFiniteNumber(progress.total) ? progress.total : input.sizeBytes;

        input.onProgress(done, total);
      });

      await upload.done();
    } finally {
      body.destroy();
    }
  }

  async presignDownload(
    key: string,
    filename: string,
  ): Promise<{ url: string; expiresAt: number }> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
        ResponseContentType: "application/octet-stream",
        ResponseCacheControl: "no-store",
      }),
      { expiresIn: DOWNLOAD_TTL_SECONDS },
    );

    return { url, expiresAt: Date.now() + DOWNLOAD_TTL_SECONDS * 1000 };
  }

  /**
   * Put, read back, then delete one tiny object under `_health/`. Delete is
   * part of the test because retention needs it.
   */
  async testConnection(): Promise<void> {
    const key = `${this.prefix}/_health/probe-${randomUUID()}`;
    const body = `kinglet-backup-probe:${Date.now()}`;

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentLength: Buffer.byteLength(body),
          ContentType: "text/plain",
          ...this.sseParams(),
        }),
      );

      const roundTrip = await this.getObjectText(key, 1024);

      if (roundTrip !== body) throw new BackupError("S3 test object did not round-trip", 502);
      await this.deleteObject(key);
    } catch (cause) {
      try {
        await this.deleteObject(key);
      } catch {
        // Best-effort cleanup; the original failure is the useful one.
      }

      throw cause;
    }
  }

  destroy(): void {
    this.client.destroy();
  }

  private sseParams(): Pick<PutObjectCommandInput, "ServerSideEncryption" | "SSEKMSKeyId"> {
    if (this.config.sse === "AES256") return { ServerSideEncryption: "AES256" };

    if (this.config.sse === "aws:kms") {
      return { ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.config.kmsKeyId };
    }

    return {};
  }
}

/**
 * Stream one stored object to a local file for restore or export work. The
 * caller owns size, hash, decryption, and decompression checks — and decides
 * what to do with a partial file if the transfer fails.
 */
export async function downloadToFile(
  store: BackupStore,
  key: string,
  destinationPath: string,
  onProgress?: (bytesWritten: number) => void,
): Promise<number> {
  const source = await store.getObjectStream(key);
  let written = 0;
  let lastReported = 0;

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      written += buffer.length;

      if (written - lastReported >= DOWNLOAD_PROGRESS_STEP_BYTES) {
        lastReported = written;
        onProgress?.(written);
      }

      callback(null, buffer);
    },
  });

  await pipeline(source, meter, fs.createWriteStream(destinationPath));
  onProgress?.(written);

  return written;
}
