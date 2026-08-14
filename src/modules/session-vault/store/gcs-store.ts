// GcsStore — a SessionStore backed by Google Cloud Storage.
//
// Two storage tricks the ingestion path relies on:
//   1. A V4 signed PUT URL lets hx-client upload a chunk directly to the bucket
//      without bytes ever flowing through workbench.
//   2. GCS Compose appends a freshly-uploaded staging chunk onto the canonical
//      session log server-side. Compose accumulates a componentCount capped at
//      1024; we rewrite-in-place at 800 so the counter resets — cheap on small
//      objects, and it never hits the wall.
//
// Config is injected (not read from env) so the same class serves let.ai's
// bucket AND a customer's bucket inside a self-hosted vault.

import {
  IdempotencyStrategy,
  Storage,
  type StorageOptions,
  type Bucket,
} from "@google-cloud/storage";
import { BUCKET_CONFIG_UNAVAILABLE } from "./types.js";
import type {
  AppendOptions,
  BucketConfigFact,
  CanonicalEntry,
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

export interface GcsStoreConfig {
  projectId: string;
  bucketName: string;
  /** Path to a service-account keyfile JSON. */
  keyFilename?: string;
  /** Inline service-account credentials (parsed JSON). */
  credentials?: StorageOptions["credentials"];
  /**
   * An alternate GCS API root — the emulator seam (fake-gcs-server).
   *
   * It is a CONFIG field rather than an env read so the emulator can never be
   * reached by a deployed fortress that happens to inherit STORAGE_EMULATOR_HOST
   * from its environment: something must pass it here, deliberately.
   */
  apiEndpoint?: string;
}

/** Rewrite-in-place once a composed object reaches this many components. */
const COMPACT_THRESHOLD = 800;

/** How many times an append re-reads the canonical and retries after losing a
 *  generation race. Bounded: under real contention one retry almost always wins,
 *  and an unbounded loop would turn a hot session into a spin. */
const APPEND_ATTEMPTS = 4;

/** Did OUR compose already land?
 *
 *  Setting ifGenerationMatch makes the SDK RETRY compose — Bucket#combine computes its
 *  own maxRetries and zeroes it ONLY when no generation precondition is present
 *  (bucket.js:1133-1142), and nodejs-common/util.js then overrides both `retries` and
 *  `noResponseRetries` from that per-request value (util.js:585-588), after and
 *  regardless of the autoRetry gate. So `noResponseRetries = 3`: a compose that lands
 *  server-side but whose RESPONSE is lost gets retried, GCS answers 412 because the
 *  generation moved — moved by our own first attempt — and reading that as "someone
 *  else won the race" composes the same staging object a second time. Those bytes then
 *  sit in the source of truth, where every rebuild faithfully reproduces them.
 *
 *  So a 412 must be interrogated, not assumed. If the object grew by exactly the
 *  staging size off the generation we read, our append is the one that landed and the
 *  correct move is to accept it. A different writer appending a coincidentally
 *  identical number of bytes would be misread as ours, which drops this chunk — but a
 *  dropped chunk leaves the canonical SHORTER than the client's claim and is caught by
 *  the byte gate and the chunk intent, whereas a duplicate is silent. Erring toward
 *  "already landed" therefore errs toward the detectable failure. */
function landedAlready(
  meta: { size?: string | number | null; generation?: string | number | null },
  builtOn: { bytes: number; generation: number },
  stagingBytes: number,
): boolean {
  const size = Number(meta.size ?? -1);
  const generation = Number(meta.generation ?? 0);
  return generation !== builtOn.generation && size === builtOn.bytes + stagingBytes;
}

/** GCS answers a failed ifGenerationMatch with 412. */
function isPreconditionFailure(err: unknown): boolean {
  const code = (err as { code?: number | string }).code;
  return code === 412 || code === "412";
}

export class GcsStore implements SessionStore {
  private readonly storage: Storage;
  private readonly bucketName: string;
  private _bucket: Bucket | null = null;

  constructor(cfg: GcsStoreConfig) {
    const opts: StorageOptions = {
      projectId: cfg.projectId,
      // retryOptions bound the SDK's JS-level RETRY loop (real under any
      // runtime). `timeout` reaches the transport only on Node, where
      // node-fetch is real; the shipped Bun binary swaps in Bun's native
      // fetch, which ignores it — there, GuardedStore's per-call deadline is
      // the ONLY effective bound (2026-07-30 incident; verified empirically).
      // Kept as defense for Node-run deployments of this module.
      timeout: 15_000,
      retryOptions: {
        autoRetry: true,
        maxRetries: 3,
        totalTimeout: 45,
        maxRetryDelay: 10,
        // COMPOSE MUST NOT BE RETRIED BY THE SDK. A compose is not idempotent from the
        // client's side: a retry after a lost response re-appends bytes that already
        // landed. Bucket#combine only zeroes its retries when NO generation
        // precondition is set, so adding one — which we must, to close the
        // read-modify-write race — silently switched compose from never-retried to
        // retried 3x, including noResponseRetries. RetryNever restores maxRetries = 0
        // for compose (bucket.js:1133-1142) and leaves OUR generation-conditioned loop
        // as the only retry, which is the one that re-reads state before acting.
        idempotencyStrategy: IdempotencyStrategy.RetryNever,
      },
    };
    if (cfg.keyFilename) {
      opts.keyFilename = cfg.keyFilename;
    } else if (cfg.credentials) {
      opts.credentials = cfg.credentials;
    }
    if (cfg.apiEndpoint) opts.apiEndpoint = cfg.apiEndpoint;
    this.storage = new Storage(opts);
    this.bucketName = cfg.bucketName;
  }

  private bucket(): Bucket {
    if (!this._bucket) this._bucket = this.storage.bucket(this.bucketName);
    return this._bucket;
  }

  async signStagingUpload(
    key: SessionKey,
    chunkId: string,
    opts?: StagingUploadOptions,
  ): Promise<SignedUpload> {
    const objectName = stagingObject(key, chunkId);
    // Shorter only — see the S3 store: the quiesce barrier before a storage
    // swap has to wait out every signature that is still valid.
    const expiresMs = Date.now() + clampStagingTtl(opts?.ttlSeconds) * 1000;
    const [url] = await this.bucket()
      .file(objectName)
      .getSignedUrl({
        version: "v4",
        action: "write",
        expires: expiresMs,
        contentType: "application/x-ndjson",
      });
    return { url, objectName, expiresAt: new Date(expiresMs).toISOString() };
  }

  async readChunkText(key: SessionKey, chunkId: string): Promise<string> {
    const file = this.bucket().file(stagingObject(key, chunkId));
    // M-9c · reject an oversized chunk from its metadata size BEFORE downloading it
    // (a hostile / buggy signed-URL upload could be arbitrarily large → OOM on the
    // download + re-parse). Fail-closed.
    const [meta] = await file.getMetadata();
    if (Number(meta.size ?? 0) > maxCanonicalBytes()) throw new Error("chunk_too_large");
    const [buf] = await file.download();
    return buf.toString("utf8");
  }

  async appendChunkToCanonical(
    key: SessionKey,
    chunkId: string,
    opts?: AppendOptions,
  ): Promise<ComposeResult> {
    const b = this.bucket();
    const canonical = b.file(canonicalObject(key));
    const staging = b.file(stagingObject(key, chunkId));

    // Compose is a READ-MODIFY-WRITE on a mutable object, so every write below is
    // conditioned on the exact generation it was built from. Without that, two
    // commits that both observe generation N both compose onto N: the loser's
    // bytes are acked to its client and then overwritten. The bucket is
    // versioned, so the orphaned generation survives and the canonical still
    // resolves — the loss is silent, and no byte gate can see it because the
    // watermark advanced. 412 means someone else moved the object; the whole
    // append is retried against the new generation, which is why `staging` is
    // deleted only after a write actually lands.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
      const head = await this.canonicalHead(canonical);
      const current = head?.generation ?? null;
      try {
        // Replace (divergence repair) takes the same promote-staging path as a
        // first chunk — copy overwrites whatever the canonical held.
        if (current === null || opts?.replace) {
          // ifGenerationMatch: 0 means "only if the object does not exist", so a
          // racing first chunk cannot clobber the winner's canonical.
          await staging.copy(canonical, {
            preconditionOpts: { ifGenerationMatch: current === null ? 0 : current },
          });
          await staging.delete().catch(() => {});
          const [meta] = await canonical.getMetadata();
          return {
            totalBytes: Number(meta.size ?? 0),
            componentCount: Number(meta.componentCount ?? 1),
          };
        }

        await b.combine([canonical, staging], canonical, { ifGenerationMatch: current });
      } catch (err) {
        if (isPreconditionFailure(err)) {
          // Interrogate the 412 before believing it. See landedAlready: our own
          // completed-but-unacked compose produces one, and retrying THAT duplicates
          // the chunk in the canonical.
          const [after] = await canonical.getMetadata().catch(() => [null]);
          const stagingSize = await staging
            .getMetadata()
            .then(([m]) => Number(m.size ?? 0))
            .catch(() => 0);
          if (
            after &&
            stagingSize > 0 &&
            head &&
            landedAlready(after, head, stagingSize)
          ) {
            await staging.delete().catch(() => {});
            return {
              totalBytes: Number(after.size ?? 0),
              componentCount: Number(after.componentCount ?? 1),
            };
          }
          if (attempt < APPEND_ATTEMPTS - 1) {
            lastErr = err;
            continue; // a different writer really did move it — rebuild on that
          }
        }
        throw err;
      }
      await staging.delete().catch(() => {});

      let [meta] = await canonical.getMetadata();
      const componentCount = Number(meta.componentCount ?? 1);

      if (componentCount >= COMPACT_THRESHOLD) {
        // Rewrite-in-place so the compose counter resets. Two things this must
        // never do: fail the append (the bytes are already durable and already
        // acked — a throw here makes the client retry a chunk the canonical
        // holds, appending it twice), or overwrite appends that landed while the
        // snapshot was being taken. Hence conditioned on the post-compose
        // generation, and isolated.
        try {
          const generation = Number(meta.generation ?? 0);
          const tmpName = `${sessionPrefix(key)}/.compact-${chunkId}.jsonl`;
          const tmp = b.file(tmpName);
          await canonical.copy(tmp);
          await tmp.copy(canonical, { preconditionOpts: { ifGenerationMatch: generation } });
          await tmp.delete().catch(() => {});
          [meta] = await canonical.getMetadata();
          return {
            totalBytes: Number(meta.size ?? 0),
            componentCount: Number(meta.componentCount ?? 1),
          };
        } catch {
          // Un-compacted is a cost and a ceiling risk, not data loss. The
          // component count rides out on the result and lands in
          // hx.ingest_events, where detectUncompactedCanonicals reports it — six
          // lanes on the reference deployment reached 2,938 against a threshold
          // of 800 with no compaction ever, and nothing named it for weeks.
          return { totalBytes: Number(meta.size ?? 0), componentCount };
        }
      }

      return { totalBytes: Number(meta.size ?? 0), componentCount };
    }
    throw (lastErr ?? new Error("append_precondition_exhausted"));
  }

  /** The canonical's current generation, or null when it does not exist. */
  /** The canonical's size AND generation, or null when it does not exist. Both, in one
   *  round trip: the generation conditions the write, and the size is what tells a 412
   *  apart from a genuine race (see landedAlready). */
  private async canonicalHead(
    canonical: ReturnType<Bucket["file"]>,
  ): Promise<{ bytes: number; generation: number } | null> {
    try {
      const [meta] = await canonical.getMetadata();
      const generation = Number(meta.generation ?? 0);
      if (!Number.isFinite(generation) || generation <= 0) return null;
      return { bytes: Number(meta.size ?? 0), generation };
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async statCanonical(key: SessionKey): Promise<number | null> {
    try {
      const [meta] = await this.bucket().file(canonicalObject(key)).getMetadata();
      return Number(meta.size ?? 0);
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async signCanonicalDownload(key: SessionKey): Promise<SignedDownload> {
    const objectName = canonicalObject(key);
    const expiresMs = Date.now() + 5 * 60 * 1000;
    const [url] = await this.bucket()
      .file(objectName)
      .getSignedUrl({
        version: "v4",
        action: "read",
        expires: expiresMs,
      });
    return { url, expiresAt: new Date(expiresMs).toISOString() };
  }

  async readCanonicalText(key: SessionKey): Promise<string> {
    const [buf] = await this.bucket().file(canonicalObject(key)).download();
    return buf.toString("utf8");
  }

  async writeCanonicalText(key: SessionKey, text: string): Promise<void> {
    // Per-call timeout: on Node runtimes simple uploads honor only the
    // per-call value (client-level timeout does not reach file.save), and
    // node-fetch's timeout spans the whole request body — hence the generous
    // budget. Under the shipped Bun binary this knob is inert (native fetch
    // ignores it) and GuardedStore's heavy deadline is the effective bound.
    await this.bucket()
      .file(canonicalObject(key))
      .save(text, { contentType: "application/x-ndjson", resumable: false, timeout: 120_000 });
  }

  async writeArtifact(key: SessionKey, name: string, text: string): Promise<void> {
    await this.bucket()
      .file(artifactObject(key, name))
      .save(text, { contentType: "application/json", resumable: false, timeout: 15_000 });
  }

  async readArtifactText(key: SessionKey, name: string): Promise<string | null> {
    try {
      const [buf] = await this.bucket().file(artifactObject(key, name)).download();
      return buf.toString("utf8");
    } catch {
      return null;
    }
  }

  async listSessionMetadata(userId: string): Promise<SessionMetadata[]> {
    const [files] = await this.bucket().getFiles({ prefix: listPrefix(userId) });
    const out: SessionMetadata[] = [];
    const seen = new Set<string>();
    const canonicalFallbacks: SessionMetadata[] = [];
    for (const file of files) {
      if (file.name.endsWith(`/${SESSION_METADATA_ARTIFACT}`)) {
        const raw = await file.download().catch(() => null);
        if (!raw) continue;
        const parsed = parseSessionMetadata(JSON.parse(raw[0].toString("utf8")));
        if (parsed) {
          seen.add(`${parsed.family}/${parsed.sessionId}`);
          out.push(parsed);
        }
        continue;
      }
      const [metadata] = await file.getMetadata().catch(() => []);
      const updatedAt =
        typeof metadata?.updated === "string" ? metadata.updated : new Date().toISOString();
      const fallback = metadataFromCanonicalObjectName(
        userId,
        file.name,
        Number(metadata?.size ?? 0),
        updatedAt,
      );
      if (fallback) canonicalFallbacks.push(fallback);
    }
    for (const fallback of canonicalFallbacks) {
      if (!seen.has(`${fallback.family}/${fallback.sessionId}`)) out.push(fallback);
    }
    return out;
  }

  async listSessionArtifacts(key: SessionKey): Promise<string[]> {
    const prefix = `${sessionPrefix(key)}/`;
    const [files] = await this.bucket().getFiles({ prefix });
    return sessionArtifactNames(
      files.map((file) => file.name),
      prefix,
    );
  }

  async listAllCanonicalKeys(): Promise<CanonicalEntry[]> {
    const out: CanonicalEntry[] = [];
    const bucket = this.bucket();
    // Name-only whole-bucket scan (no getMetadata / no download), paginated.
    let query: Record<string, unknown> | null = { autoPaginate: false, maxResults: 1000 };
    while (query) {
      const res = (await bucket.getFiles(query as never)) as unknown as [
        Array<{ name: string; metadata?: { size?: string | number } }>,
        Record<string, unknown> | null,
        unknown,
      ];
      for (const file of res[0]) {
        const key = parseCanonicalKey(file.name);
        // The list response already carries size — still no getMetadata, no
        // download; we just stop throwing the field away.
        if (key) {
          const size = Number(file.metadata?.size);
          out.push(Number.isFinite(size) ? { ...key, bytes: size } : key);
        }
      }
      query = res[1] ?? null;
    }
    return out;
  }

  async deleteSession(key: SessionKey, opts?: DeleteSessionOptions): Promise<DeleteSessionResult> {
    const limit = Math.max(1, opts?.batchLimit ?? 800);
    let deleted = 0;
    for (const prefix of sessionDeletePrefixes(key)) {
      for (;;) {
        if (deleted >= limit) return { complete: false, deleted };
        // versions:true — the bucket is provisioned with versioning, so each
        // noncurrent generation must be deleted explicitly (a plain delete
        // leaves prior generations recoverable). Generation-pinned deletes make
        // the removal permanent (bucket-level soft-delete retention, if
        // configured, expires on the provider's clock — ≤7 days).
        const [files] = await this.bucket().getFiles({
          prefix,
          versions: true,
          maxResults: Math.min(1000, limit - deleted),
          autoPaginate: false,
        });
        if (files.length === 0) break;
        for (const f of files) {
          const generation = Number(f.metadata?.generation ?? 0);
          const target = generation
            ? this.bucket().file(f.name, { generation })
            : this.bucket().file(f.name);
          // 404 = a concurrent delete won the race — fine; anything else must
          // surface so the purge job retries instead of reporting complete.
          await target.delete().catch((err) => {
            if ((err as { code?: number }).code !== 404) throw err;
          });
          deleted += 1;
        }
      }
    }
    return { complete: true, deleted };
  }

  /** storage.buckets.get. Refused for an object-scoped key, which is the
   *  common case and an answer in itself. */
  async getBucketVersioning(): Promise<BucketConfigFact> {
    try {
      const [metadata] = await this.bucket().getMetadata();
      return metadata.versioning?.enabled ? "Enabled" : "Unversioned";
    } catch {
      return BUCKET_CONFIG_UNAVAILABLE;
    }
  }

  /** The bucket's lifecycle rules, as the provider reports them. An empty rule
   *  set IS distinguishable here, unlike on S3, so it is reported as such. */
  async getLifecycle(): Promise<BucketConfigFact> {
    try {
      const [metadata] = await this.bucket().getMetadata();
      const rules = metadata.lifecycle?.rule ?? [];
      if (rules.length === 0) return "no lifecycle rules";
      return rules
        .map((r) => `${r.action?.type ?? "unknown"} after ${r.condition?.age ?? "?"} days`)
        .join("; ");
    } catch {
      return BUCKET_CONFIG_UNAVAILABLE;
    }
  }

  async selfTest(): Promise<void> {
    // Per-CALL name: the daemon probe, the cloud's test-connection RPC and the
    // enroll wizard can all run selfTest concurrently in/across processes — a
    // shared key lets one caller's delete land inside another's save→read
    // window and report a spurious failure on a healthy store. Stranded
    // objects from failed deletes (and versioned-bucket accrual) are owned by
    // the provisioned `.session-vault/` lifecycle rules, not by naming.
    const file = this.bucket().file(`.session-vault/selftest-${randomUUID().slice(0, 12)}.txt`);
    await file.save("ok", { contentType: "text/plain", resumable: false, timeout: 15_000 });
    const [buf] = await file.download();
    if (buf.toString("utf8") !== "ok") throw new Error("self-test readback mismatch");
    await file.delete().catch(() => {});
  }
}
