// The store-write pause gate — the OUTERMOST store decorator.
//
// It composes outside GuardedStore on purpose: a refused write must not consume
// a deadline or count towards the wedge-escalation streak, and a paused fortress
// is not a wedged one. Order is gate → GuardedStore → backend.
//
// Every bucket-MUTATING method is gated, including selfTest (its probe writes an
// object). Reads stay open throughout a pause: the console, residency verify and
// the checkup all keep working while writes are held off.

import { PauseState } from "./ingest-control";
import type {
  BucketConfigFact,
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
} from "../modules/session-vault/store/types";

/** The tunnel-side wire literal, owned here.
 *
 *  It leads with `vault_offline` so the SHIPPED workbench classifier parks the
 *  job during the deploy window in which new fortresses meet old clients; the
 *  `ingest_paused:<deadline>` suffix is what a classifier that understands the
 *  pause reads. Changing this prefix breaks the belt. */
export const PAUSED_WIRE_PREFIX = "vault_offline:ingest_paused:";

export class IngestPausedError extends Error {
  constructor(readonly pausedUntil: Date) {
    super(`${PAUSED_WIRE_PREFIX}${pausedUntil.toISOString()}`);
    this.name = "IngestPausedError";
  }
}

export function isIngestPaused(err: unknown): err is IngestPausedError {
  return err instanceof IngestPausedError;
}

/** Errors a caller should retry rather than surface as a failed upload. The
 *  pause is the interesting one: it is a deliberate, time-bounded refusal, and
 *  the client's own backoff is what makes a migration invisible to users. */
export const RETRYABLE_INGEST_ERRORS: readonly string[] = [
  PAUSED_WIRE_PREFIX,
  "vault_offline",
  "postgres_not_ready",
  "store_deadline_exceeded",
];

export function isRetryableIngestError(message: string): boolean {
  return RETRYABLE_INGEST_ERRORS.some((prefix) => message.startsWith(prefix));
}

/** While a drain is armed, new staging signatures are cut to this so the quiesce
 *  barrier has a bounded floor to wait for. The default staging TTL is 15
 *  minutes; waiting that long before every swap is not a barrier, it is an
 *  outage. */
export const ARMED_PRESIGN_TTL_S = 60;

/**
 * In-flight accounting for the quiesce barrier.
 *
 * Counted at ENQUEUE, not at execution: a commit accepted one second before a
 * pause defers its metadata + artifact work, and a barrier that only saw
 * executing calls would declare quiet while that work was still queued.
 */
export class IngestQuiesce {
  private inFlight = 0;
  private signatureFloorMs = 0;

  enter(): void {
    this.inFlight += 1;
  }

  leave(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  /** Wrap an async unit of work in the counter. */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.enter();
    try {
      return await fn();
    } finally {
      this.leave();
    }
  }

  get pending(): number {
    return this.inFlight;
  }

  /** Record a signature the bucket will still honour after we stop issuing them.
   *  A presigned PUT lands directly in the bucket, invisible to this process, so
   *  the barrier cannot be counter-only. */
  noteSignature(expiresAt: Date | string): void {
    const ms = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt.getTime();
    if (Number.isFinite(ms) && ms > this.signatureFloorMs) this.signatureFloorMs = ms;
  }

  /** The earliest moment at which no outstanding signature can still write. */
  get signatureFloor(): Date {
    return new Date(this.signatureFloorMs);
  }

  /** Quiet means BOTH: nothing in flight here, and no signature outstanding. */
  isQuiesced(now: Date = new Date()): boolean {
    return this.inFlight === 0 && now.getTime() >= this.signatureFloorMs;
  }
}

/** Store methods that mutate the bucket. selfTest is included — its probe writes
 *  and deletes a real object, which is a write against a store a migration is
 *  trying to hold still. */
const GATED_METHODS: ReadonlySet<string> = new Set([
  "signStagingUpload",
  "appendChunkToCanonical",
  "writeCanonicalText",
  "writeArtifact",
  "deleteSession",
  "selfTest",
]);

export function isGatedStoreMethod(method: string): boolean {
  return GATED_METHODS.has(method);
}

/** True when this store carries the pause gate. External Postgres and tests
 *  compose the store without one, and a pre-check that assumed otherwise would
 *  crash instead of falling through. */
export function isPauseGated(store: unknown): store is PauseGatedStore {
  return typeof (store as PauseGatedStore | null)?.assertWritable === "function";
}

export interface PauseGatedStoreOptions {
  /** True while a drain is armed — new staging signatures are cut short so the
   *  barrier's floor stays bounded. */
  armed?: () => boolean;
  /** Called once per REFUSED call. The gate is the only place that knows a write
   *  was turned away — the counter it feeds is what tells an operator the pause
   *  is doing something, and published as a flat zero it says the opposite. */
  onRefused?: () => void;
  clock?: () => Date;
}

export class PauseGatedStore implements SessionStore {
  private readonly clock: () => Date;
  private readonly armed: () => boolean;
  private readonly onRefused: () => void;

  constructor(
    private readonly inner: SessionStore,
    private readonly state: PauseState,
    readonly quiesce: IngestQuiesce = new IngestQuiesce(),
    options: PauseGatedStoreOptions = {},
  ) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.armed = options.armed ?? ((): boolean => false);
    this.onRefused = options.onRefused ?? ((): void => {});
  }

  /** Refuse BEFORE the call reaches GuardedStore, so a paused write consumes no
   *  deadline and never charges the rebuild streak.
   *
   *  Public because of ONE enumerated exception: the deleteSession RPC
   *  tombstones the identity and purges Postgres BEFORE it reaches the store,
   *  so its gate has to sit ahead of both — a purge that ran while writes were
   *  quiesced would cut a hole in the very snapshot a migration is copying. */
  assertWritable(): void {
    const until = this.state.pausedUntil(this.clock());
    if (!until) return;
    // Counted HERE, where the refusal actually happens — every entry point goes
    // through this one line, so no caller has to remember to count.
    this.onRefused();
    throw new IngestPausedError(until);
  }

  private gated<T>(fn: () => Promise<T>): Promise<T> {
    try {
      this.assertWritable();
    } catch (err) {
      // A REJECTED promise, never a synchronous throw: the store interface is
      // promise-returning, and a caller that only wrote `.catch()` would see an
      // unhandled exception instead of the refusal.
      return Promise.reject(err);
    }
    return this.quiesce.track(fn);
  }

  async signStagingUpload(
    key: SessionKey,
    chunkId: string,
    opts?: StagingUploadOptions,
  ): Promise<SignedUpload> {
    const ttl = this.armed() ? ARMED_PRESIGN_TTL_S : opts?.ttlSeconds;
    const signed = await this.gated(() =>
      this.inner.signStagingUpload(key, chunkId, ttl ? { ttlSeconds: ttl } : opts),
    );
    this.quiesce.noteSignature(signed.expiresAt);
    return signed;
  }
  readChunkText(key: SessionKey, chunkId: string): Promise<string> {
    return this.inner.readChunkText(key, chunkId);
  }
  appendChunkToCanonical(key: SessionKey, chunkId: string, opts?: AppendOptions): Promise<ComposeResult> {
    return this.gated(() => this.inner.appendChunkToCanonical(key, chunkId, opts));
  }
  statCanonical(key: SessionKey): Promise<number | null> {
    return this.inner.statCanonical(key);
  }
  signCanonicalDownload(key: SessionKey): Promise<SignedDownload> {
    return this.inner.signCanonicalDownload(key);
  }
  readCanonicalText(key: SessionKey): Promise<string> {
    return this.inner.readCanonicalText(key);
  }
  writeCanonicalText(key: SessionKey, text: string): Promise<void> {
    return this.gated(() => this.inner.writeCanonicalText(key, text));
  }
  writeArtifact(key: SessionKey, name: string, text: string): Promise<void> {
    return this.gated(() => this.inner.writeArtifact(key, name, text));
  }
  readArtifactText(key: SessionKey, name: string): Promise<string | null> {
    return this.inner.readArtifactText(key, name);
  }
  listSessionArtifacts(key: SessionKey): Promise<string[]> {
    return this.inner.listSessionArtifacts(key);
  }
  // Bucket-configuration reads. Ungated on purpose: the pause exists to hold the
  // OBJECT SET still while a migration copies it, and reading a policy neither
  // moves an object nor lengthens the barrier.
  getBucketVersioning(): Promise<BucketConfigFact> {
    return this.inner.getBucketVersioning();
  }
  getLifecycle(): Promise<BucketConfigFact> {
    return this.inner.getLifecycle();
  }
  listSessionMetadata(userId: string): Promise<SessionMetadata[]> {
    return this.inner.listSessionMetadata(userId);
  }
  listAllCanonicalKeys(): Promise<SessionKey[]> {
    return this.inner.listAllCanonicalKeys();
  }
  selfTest(): Promise<void> {
    return this.gated(() => this.inner.selfTest());
  }
  deleteSession(key: SessionKey, opts?: DeleteSessionOptions): Promise<DeleteSessionResult> {
    return this.gated(() => this.inner.deleteSession(key, opts));
  }
}

/**
 * Wait until the store is quiet enough to swap under, or the deadline lapses.
 *
 * `flush` drains the deferred post-commit chains: a commit accepted just before
 * the pause has queued metadata + artifact work that must either land or park
 * before the swap, never be lost between them.
 */
export async function awaitQuiesced(args: {
  quiesce: IngestQuiesce;
  deadline: Date;
  flush?: () => Promise<void>;
  /** Called on every poll. The pause is held in short episodes, and a barrier
   *  that ran longer than one of them would be measuring quiet after the gate
   *  had already reopened. */
  heartbeat?: () => Promise<void>;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}): Promise<boolean> {
  const clock = args.clock ?? ((): Date => new Date());
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = args.pollMs ?? 250;
  if (args.flush) await args.flush();
  while (clock().getTime() < args.deadline.getTime()) {
    if (args.quiesce.isQuiesced(clock())) return true;
    await sleep(pollMs);
    if (args.heartbeat) await args.heartbeat();
    if (args.flush) await args.flush();
  }
  // A lapsed deadline ABORTS the swap: proceeding would cut over a store that
  // still has writes landing behind us.
  return args.quiesce.isQuiesced(clock());
}
