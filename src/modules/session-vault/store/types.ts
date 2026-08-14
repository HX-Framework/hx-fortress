// SessionStore — the storage abstraction behind hx-vision session blobs.
//
// One interface, several implementations, chosen per-org by ./index.ts:
//   • GcsStore         — Google Cloud Storage (let.ai's bucket, or a customer's)
//   • S3Store          — AWS S3 (added in P2)
//   • RemoteVaultStore — RPCs to a customer-hosted vault over the tunnel (P4)
//
// Call sites never touch a cloud SDK directly — they resolve a store and call
// these four methods. Object paths are identical across every implementation
// ({userId}/{family}/{sessionId}/…): org isolation lives at the bucket/store
// level, so a self-hosted vault's dedicated bucket needs no orgId in the path.

export interface SessionKey {
  userId: string;
  family: string;
  sessionId: string;
}

export interface SignedUpload {
  url: string;
  objectName: string;
  expiresAt: string;
}

export interface SignedDownload {
  url: string;
  expiresAt: string;
}

export interface ComposeResult {
  totalBytes: number;
  componentCount: number;
}

export interface StagingUploadOptions {
  /** Shorten the signature's lifetime. The quiesce barrier before a storage
   *  swap has to wait out every signature the bucket will still honour, so a
   *  drain cuts new ones short instead of waiting the default TTL. Clamped by
   *  the backend to its own maximum. */
  ttlSeconds?: number;
}

export interface AppendOptions {
  /** Overwrite the canonical with this chunk instead of appending. The client
   *  sends this on the first chunk of a from-zero (re)upload so a canonical
   *  that diverged from the device's source file — a wiped store, a lost
   *  client state file — converges back to the source instead of accreting
   *  duplicate or stale bytes. */
  replace?: boolean;
}

export interface SessionMetadata {
  family: string;
  sessionId: string;
  title: string | null;
  titleSource: "user" | "ai" | "fallback" | null;
  bytesUploaded: number;
  eventCount: number;
  userTextCount: number;
  assistantCount: number;
  lastActivityAt: string | null;
  firstSeenAt: string;
  updatedAt: string;
  cwd: string | null;
  gitBranch: string | null;
  sourcePath: string | null;
  repoSlug: string | null;
  deviceName: string | null;
}

export interface DeleteSessionResult {
  /** No object (or version) remains under the session's prefixes. */
  complete: boolean;
  /** Objects/versions removed by THIS call. */
  deleted: number;
}

export interface DeleteSessionOptions {
  /** Max objects/versions to remove in one call (bounded so a call always fits
   *  the tunnel RPC window; the caller re-invokes until `complete`). */
  batchLimit?: number;
}

/**
 * The one honest answer when the bucket's configuration cannot be read.
 *
 * The fortress key is provisioned for OBJECT access. Reading a bucket's
 * versioning or lifecycle policy is a bucket-level permission the customer never
 * granted, and asking for it would widen the credential to make a compliance
 * report prettier. So the report says what is true - it could not check - rather
 * than "versioning: off", which is a claim about the bucket the fortress is in
 * no position to make.
 */
export const BUCKET_CONFIG_UNAVAILABLE =
  "unavailable - the fortress key cannot read bucket configuration";

/** A provider-read bucket fact: the value, or the honest unavailable string. */
export type BucketConfigFact = string;
/** One canonical object as the store LISTS it. `bytes` is the object size the
 *  list response already carries (GCS File.metadata.size, S3 Contents[].Size), so
 *  it costs no extra round-trip — it lets the guarantor ask whether an index is
 *  COMPLETE relative to its transcript, not merely whether a row exists. Optional
 *  because a store may not report it; absent simply means "cannot judge". */
export type CanonicalEntry = SessionKey & { bytes?: number };

export interface SessionStore {
  /** Mint a signed PUT URL for a staging chunk. The caller PUTs raw NDJSON bytes. */
  signStagingUpload(key: SessionKey, chunkId: string, opts?: StagingUploadOptions): Promise<SignedUpload>;
  /** Read a freshly-uploaded staging chunk as UTF-8 text (used for indexing). */
  readChunkText(key: SessionKey, chunkId: string): Promise<string>;
  /** Append a staging chunk onto the canonical session log; returns new totals.
   *  With `opts.replace` the chunk REPLACES the canonical (divergence repair). */
  appendChunkToCanonical(key: SessionKey, chunkId: string, opts?: AppendOptions): Promise<ComposeResult>;
  /** Size of the canonical log in bytes, or null when it doesn't exist. Backs
   *  the sessions/verify divergence audit. */
  statCanonical(key: SessionKey): Promise<number | null>;
  /** Mint a signed GET URL for the canonical session log. */
  signCanonicalDownload(key: SessionKey): Promise<SignedDownload>;
  /** Read the full canonical session log as UTF-8 text (server-side read for
   *  agent tools / analytics). Remote vaults prefer a signed URL and fall back
   *  to streaming bytes over the tunnel when the bucket has no public egress. */
  readCanonicalText(key: SessionKey): Promise<string>;
  /** Write the WHOLE canonical session log from text in one shot — no staging
   *  chunk, no compose. Used when the cloud already holds the complete transcript
   *  and forwards it inline (the ingest path also indexes it), so it can be
   *  persisted as the canonical in the same call rather than re-staged. Overwrites. */
  writeCanonicalText(key: SessionKey, text: string): Promise<void>;
  /** Write a small whole-file sidecar next to the session (e.g. "tasks.json",
   *  "plan.json"). Overwrites; not the chunk/compose path. */
  writeArtifact(key: SessionKey, name: string, text: string): Promise<void>;
  /** Read a sidecar artifact as UTF-8 text, or null if it doesn't exist. */
  readArtifactText(key: SessionKey, name: string): Promise<string | null>;
  /** The sidecar artifacts this session actually HAS, by name — the objects
   *  directly under its prefix, minus the canonical log and the internal
   *  `.staging/` chunks. Asked rather than assumed: `workflow-<runId>.json` is an
   *  unbounded class, so no fixed list of names describes a session's objects,
   *  and a storage migration that copied a fixed list would leave the rest in the
   *  bucket it is moving away from. */
  listSessionArtifacts(key: SessionKey): Promise<string[]>;
  /** List lightweight session metadata for one user without reading every
   *  canonical transcript. */
  listSessionMetadata(userId: string): Promise<SessionMetadata[]>;
  /** Enumerate the SessionKey of every canonical transcript in the store,
   *  name-only (no metadata read / no download) — the discovery primitive for
   *  the G reconciler's orphan anti-join. Whole-bucket scan; agent lanes appear
   *  as their `:a:` composite sessionId. */
  listAllCanonicalKeys(): Promise<SessionKey[]>;
  /** Whether the bucket keeps noncurrent versions, as the provider reports it.
   *  Read rather than assumed: the compliance report's residency line turns on
   *  it, and both provisioners enable versioning, so an assumption would be
   *  right until somebody pointed the fortress at a bucket they made by hand. */
  getBucketVersioning(): Promise<BucketConfigFact>;
  /** The bucket's lifecycle policy, as the provider reports it. Objects under an
   *  expiring rule are objects that will leave without anybody deleting them. */
  getLifecycle(): Promise<BucketConfigFact>;
  listAllCanonicalKeys(): Promise<CanonicalEntry[]>;
  /** Prove the bucket + credentials actually work: write→read→delete a
   *  throwaway probe object. Throws on any failure. Run at enroll time (so a
   *  bad bucket/permission surfaces immediately, not at the first session) and
   *  by the panel's "Send a test session". */
  selfTest(): Promise<void>;
  /** PERMANENTLY delete every object of one session — the canonical, staging
   *  chunks, sidecar artifacts AND every agent lane (`${sessionId}:a:*`, a
   *  sibling prefix), including every noncurrent VERSION and delete marker
   *  (both bucket kinds are provisioned with versioning, so a current-version
   *  delete alone leaves the bytes recoverable). Bounded per call; idempotent —
   *  the caller re-invokes until `complete`. */
  deleteSession(key: SessionKey, opts?: DeleteSessionOptions): Promise<DeleteSessionResult>;
}
