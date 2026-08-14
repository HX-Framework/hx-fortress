// S3Store — a SessionStore backed by AWS S3 (or any S3-compatible store).
//
// S3 has no server-side Compose like GCS, but the SessionStore contract is a
// SINGLE canonical object (signCanonicalDownload returns one URL the browser
// downloads directly), so the manifest-of-parts model would break that
// contract. Instead we keep one canonical object and "append" the S3 way:
//
//   • canonical < 5 MiB → read-modify-write (download + concat + put). Cheap
//     while the object is small.
//   • canonical ≥ 5 MiB → multipart upload, part 1 = existing canonical (copy),
//     part 2 = the new chunk (copy). S3 requires every non-last part to be
//     ≥ 5 MiB; part 1 is the existing canonical, which the branch guarantees is
//     already ≥ 5 MiB, and the chunk is the last part (any size).
//
// Config is injected so the same class serves a let.ai S3 bucket AND a
// customer's bucket inside a self-hosted vault.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  type S3ClientConfig,
  GetBucketVersioningCommand,
  GetBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BUCKET_CONFIG_UNAVAILABLE } from "./types.js";
import type {
  BucketConfigFact,
  CanonicalEntry,
  AppendOptions,
  ComposeResult,
  DeleteSessionOptions,
  DeleteSessionResult,
  SessionKey,
  SessionMetadata,
  SessionStore,
  SignedDownload,
  SignedUpload,
  StagingUploadOptions,
} from "./types.js";
import {
  metadataFromCanonicalObjectName,
  parseSessionMetadata,
  SESSION_METADATA_ARTIFACT,
} from "./session-metadata.js";
import {
  artifactObject,
  canonicalObject,
  listPrefix,
  parseCanonicalKey,
  sessionArtifactNames,
  sessionDeletePrefixes,
  sessionPrefix,
  stagingObject,
} from "./keys.js";
import { clampStagingTtl, maxCanonicalBytes } from "./limits.js";
import { randomUUID } from "node:crypto";

export interface S3StoreConfig {
  region: string;
  bucketName: string;
  /** Static credentials. Omit to use the default AWS credential chain. */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Custom endpoint for S3-compatible stores (MinIO, R2, …). */
  endpoint?: string;
  /** Path-style addressing — required by most S3-compatible endpoints. */
  forcePathStyle?: boolean;
}

const CANONICAL_GET_TTL_S = 5 * 60;
const MULTIPART_MIN_PART = 5 * 1024 * 1024; // S3: non-last parts must be ≥ 5 MiB
const NDJSON = "application/x-ndjson";

/** Encode `bucket/key` for a CopySource, preserving the `/` separators. */
function copySource(bucket: string, keyName: string): string {
  return [bucket, ...keyName.split("/")].map(encodeURIComponent).join("/");
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

export class S3Store implements SessionStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3StoreConfig) {
    const clientCfg: S3ClientConfig = { region: cfg.region };
    if (cfg.credentials) clientCfg.credentials = cfg.credentials;
    if (cfg.endpoint) clientCfg.endpoint = cfg.endpoint;
    if (cfg.forcePathStyle) clientCfg.forcePathStyle = true;
    this.s3 = new S3Client(clientCfg);
    this.bucket = cfg.bucketName;
  }

  async signStagingUpload(
    key: SessionKey,
    chunkId: string,
    opts?: StagingUploadOptions,
  ): Promise<SignedUpload> {
    const objectName = stagingObject(key, chunkId);
    // A caller may shorten the signature but never extend it: the quiesce
    // barrier waits out every signature still outstanding, so a longer one
    // would push a storage swap arbitrarily far into the future.
    const ttl = clampStagingTtl(opts?.ttlSeconds);
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: objectName, ContentType: NDJSON }),
      { expiresIn: ttl },
    );
    return {
      url,
      objectName,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  async readChunkText(key: SessionKey, chunkId: string): Promise<string> {
    const r = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: stagingObject(key, chunkId) }),
    );
    // M-9c · reject an oversized chunk from the response's ContentLength BEFORE
    // materializing it into a string (a hostile / buggy signed-URL upload could be
    // arbitrarily large → OOM on read + re-parse). Fail-closed, no extra round trip.
    if ((r.ContentLength ?? 0) > maxCanonicalBytes()) throw new Error("chunk_too_large");
    return r.Body ? r.Body.transformToString("utf-8") : "";
  }

  async appendChunkToCanonical(
    key: SessionKey,
    chunkId: string,
    opts?: AppendOptions,
  ): Promise<ComposeResult> {
    const staging = stagingObject(key, chunkId);
    const canonical = canonicalObject(key);
    const currentSize = await this.objectSize(canonical);

    if (currentSize === null || opts?.replace) {
      // First chunk (or divergence repair): promote staging straight to canonical.
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          CopySource: copySource(this.bucket, staging),
          Key: canonical,
          ContentType: NDJSON,
          MetadataDirective: "REPLACE",
        }),
      );
      await this.deleteQuietly(staging);
      return { totalBytes: (await this.objectSize(canonical)) ?? 0, componentCount: 1 };
    }

    if (currentSize >= MULTIPART_MIN_PART) {
      // Server-side multipart copy — no bytes materialize in the fortress here.
      await this.multipartAppend(canonical, staging);
    } else {
      const [cur, chunk] = await Promise.all([this.getBytes(canonical), this.getBytes(staging)]);
      // M-9c · this read-modify-write is the only path that loads canonical+chunk
      // into memory; cap the combined size (fail-closed) so a giant staged chunk
      // can't OOM the fortress. (The multipart branch above never loads bytes.)
      if (cur.length + chunk.length > maxCanonicalBytes()) throw new Error("canonical_too_large");
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: canonical,
          Body: Buffer.concat([cur, chunk]),
          ContentType: NDJSON,
        }),
      );
    }
    await this.deleteQuietly(staging);
    // componentCount is a GCS-Compose concept; on S3 the canonical is always a
    // single object, so we report 1.
    return { totalBytes: (await this.objectSize(canonical)) ?? 0, componentCount: 1 };
  }

  async statCanonical(key: SessionKey): Promise<number | null> {
    return this.objectSize(canonicalObject(key));
  }

  async signCanonicalDownload(key: SessionKey): Promise<SignedDownload> {
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: canonicalObject(key) }),
      { expiresIn: CANONICAL_GET_TTL_S },
    );
    return { url, expiresAt: new Date(Date.now() + CANONICAL_GET_TTL_S * 1000).toISOString() };
  }

  async readCanonicalText(key: SessionKey): Promise<string> {
    return (await this.getBytes(canonicalObject(key))).toString("utf8");
  }

  async writeCanonicalText(key: SessionKey, text: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: canonicalObject(key),
        Body: text,
        ContentType: NDJSON,
      }),
    );
  }

  async writeArtifact(key: SessionKey, name: string, text: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: artifactObject(key, name),
        Body: text,
        ContentType: "application/json",
      }),
    );
  }

  async readArtifactText(key: SessionKey, name: string): Promise<string | null> {
    try {
      const r = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: artifactObject(key, name) }),
      );
      return r.Body ? await r.Body.transformToString("utf-8") : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listSessionMetadata(userId: string): Promise<SessionMetadata[]> {
    const out: SessionMetadata[] = [];
    const seen = new Set<string>();
    const canonicalFallbacks: SessionMetadata[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: listPrefix(userId),
          ContinuationToken: token,
        }),
      );
      for (const obj of page.Contents ?? []) {
        const key = obj.Key ?? "";
        if (key.endsWith(`/${SESSION_METADATA_ARTIFACT}`)) {
          const raw = await this.getBytes(key).catch(() => null);
          if (!raw) continue;
          const parsed = parseSessionMetadata(JSON.parse(raw.toString("utf8")));
          if (parsed) {
            seen.add(`${parsed.family}/${parsed.sessionId}`);
            out.push(parsed);
          }
          continue;
        }
        const fallback = metadataFromCanonicalObjectName(
          userId,
          key,
          Number(obj.Size ?? 0),
          (obj.LastModified ?? new Date()).toISOString(),
        );
        if (fallback) canonicalFallbacks.push(fallback);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    for (const fallback of canonicalFallbacks) {
      if (!seen.has(`${fallback.family}/${fallback.sessionId}`)) out.push(fallback);
    }
    return out;
  }

  async listSessionArtifacts(key: SessionKey): Promise<string[]> {
    const prefix = `${sessionPrefix(key)}/`;
    const names: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of page.Contents ?? []) names.push(obj.Key ?? "");
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return sessionArtifactNames(names, prefix);
  }

  async listAllCanonicalKeys(): Promise<CanonicalEntry[]> {
    const out: CanonicalEntry[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: token }),
      );
      for (const obj of page.Contents ?? []) {
        const key = parseCanonicalKey(obj.Key ?? "");
        if (key) out.push(typeof obj.Size === "number" ? { ...key, bytes: obj.Size } : key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async deleteSession(key: SessionKey, opts?: DeleteSessionOptions): Promise<DeleteSessionResult> {
    const limit = Math.max(1, opts?.batchLimit ?? 800);
    let deleted = 0;
    for (const prefix of sessionDeletePrefixes(key)) {
      for (;;) {
        if (deleted >= limit) return { complete: false, deleted };
        // ListObjectVersions (not ListObjectsV2): the bucket is versioned, so a
        // plain delete only writes a delete marker and every noncurrent version
        // survives. Enumerate versions AND delete markers and remove each by
        // VersionId — that is what makes the delete permanent.
        const page = await this.s3.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            Prefix: prefix,
            MaxKeys: Math.min(1000, limit - deleted),
          }),
        );
        const entries = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
          .filter((v) => typeof v.Key === "string" && v.Key.length > 0)
          .map((v) => (v.VersionId ? { Key: v.Key as string, VersionId: v.VersionId } : { Key: v.Key as string }));
        if (entries.length === 0) break;
        const res = await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: entries, Quiet: true },
          }),
        );
        // A partial failure must surface (the purge job retries) — silently
        // reporting `complete` would leave bytes behind forever.
        if (res.Errors && res.Errors.length > 0) {
          throw new Error(`session_delete_failed:${res.Errors[0]?.Code ?? "unknown"}`);
        }
        deleted += entries.length;
      }
    }
    return { complete: true, deleted };
  }

  /** Release the SDK client's sockets so a GuardedStore rebuild cannot leak
   *  the old pool (S3Client owns its handler, unlike GCS's shared agent). */
  destroyClient(): void {
    this.s3.destroy();
  }

  /** s3:GetBucketVersioning. The fortress key is provisioned for objects, so
   *  this is expected to be refused on most deployments - which is a fact the
   *  report states rather than a failure it hides. */
  async getBucketVersioning(): Promise<BucketConfigFact> {
    try {
      const res = await this.s3.send(new GetBucketVersioningCommand({ Bucket: this.bucket }));
      return res.Status ?? "Unversioned";
    } catch {
      return BUCKET_CONFIG_UNAVAILABLE;
    }
  }

  /** s3:GetLifecycleConfiguration. A bucket with no rules answers with an error
   *  rather than an empty list, so "none" cannot be distinguished from "not
   *  permitted" here - and claiming either would be an invention. */
  async getLifecycle(): Promise<BucketConfigFact> {
    try {
      const res = await this.s3.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
      );
      const rules = res.Rules ?? [];
      if (rules.length === 0) return "no lifecycle rules";
      return rules
        .map((r) => `${r.ID ?? "(unnamed)"}: ${r.Status ?? "unknown"}`)
        .join("; ");
    } catch {
      return BUCKET_CONFIG_UNAVAILABLE;
    }
  }

  async selfTest(): Promise<void> {
    // Per-call name — see GcsStore.selfTest for the rationale.
    const keyName = `.session-vault/selftest-${randomUUID().slice(0, 12)}.txt`;
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: keyName, Body: "ok", ContentType: "text/plain" }),
    );
    const got = (await this.getBytes(keyName)).toString("utf8");
    if (got !== "ok") throw new Error("self-test readback mismatch");
    await this.deleteQuietly(keyName);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async multipartAppend(canonical: string, staging: string): Promise<void> {
    const created = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: canonical,
        ContentType: NDJSON,
      }),
    );
    const uploadId = created.UploadId;
    try {
      const p1 = await this.s3.send(
        new UploadPartCopyCommand({
          Bucket: this.bucket,
          Key: canonical,
          UploadId: uploadId,
          PartNumber: 1,
          CopySource: copySource(this.bucket, canonical),
        }),
      );
      const p2 = await this.s3.send(
        new UploadPartCopyCommand({
          Bucket: this.bucket,
          Key: canonical,
          UploadId: uploadId,
          PartNumber: 2,
          CopySource: copySource(this.bucket, staging),
        }),
      );
      await this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: canonical,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [
              { PartNumber: 1, ETag: p1.CopyPartResult?.ETag },
              { PartNumber: 2, ETag: p2.CopyPartResult?.ETag },
            ],
          },
        }),
      );
    } catch (err) {
      await this.s3
        .send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: canonical,
            UploadId: uploadId,
          }),
        )
        .catch(() => {});
      throw err;
    }
  }

  private async objectSize(keyName: string): Promise<number | null> {
    try {
      const h = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: keyName }));
      return h.ContentLength ?? 0;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  private async getBytes(keyName: string): Promise<Buffer> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: keyName }));
    if (!r.Body) return Buffer.alloc(0);
    return Buffer.from(await r.Body.transformToByteArray());
  }

  private async deleteQuietly(keyName: string): Promise<void> {
    await this.s3
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: keyName }))
      .catch(() => {});
  }
}
