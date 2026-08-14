// GuardedStore — a SessionStore decorator that gives every storage call a hard
// deadline and rebuilds the inner store (fresh SDK client + HTTP agent pool)
// after consecutive breaches.
//
// Exists because of the 2026-07-30 prod incident: one GCS 500 left the
// client's keep-alive pool holding hung requests; with no per-call deadline
// every later write waited forever behind them, the cloud's 30 s tunnel RPC
// timeout abandoned each call unanswered, and ingest sat at zero for three
// hours while Postgres-backed reads stayed green and this process logged
// nothing. A deadline turns a hung call into a loud, retryable error; the
// rebuild evicts the poisoned pool; together they make the write path
// self-healing instead of restart-dependent.
//
// A losing call cannot be cancelled (the storage SDKs expose no abort seam) —
// it is detached with a swallow-handler and its client discarded by the
// rebuild; its eventual settle is neither observed nor trusted.

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
import type { ScopedLogger } from "../../../host/types.js";

export class StoreDeadlineError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`store_deadline_exceeded: ${method} after ${timeoutMs}ms`);
    this.name = "StoreDeadlineError";
  }
}

export interface GuardedStoreOptions {
  /** Deadline for ordinary single-round-trip calls (signing, stat, small
   *  reads/writes, the self-test probe). */
  opTimeoutMs?: number;
  /** Deadline for calls that legitimately move lots of data (whole-canonical
   *  read/write, metadata list, one bounded delete batch). */
  heavyOpTimeoutMs?: number;
  /** Deadline for the whole-bucket key scan — the G reconciler walks every
   *  canonical (12k keys took ~3 minutes on prod). */
  scanTimeoutMs?: number;
  /** Consecutive deadline breaches before the inner store is rebuilt. */
  rebuildAfter?: number;
  /** Consecutive FUTILE rebuilds (no counted success in between) before
   *  `onWedgedBeyondRecovery` fires. Under Bun a rebuild sheds SDK/auth state
   *  but CANNOT shed the process-global native-fetch socket pool — when
   *  rebuilds don't help, only a process restart does. */
  exhaustAfterRebuilds?: number;
  /** Invoked once per wedge episode when rebuilds have proven futile. The
   *  store keeps operating (and breaching) after the call — the callback owns
   *  the escalation (typically a supervised process exit).
   *  `hadCountedSuccess` = at least one write-class call succeeded since boot:
   *  false means a fresh process never worked either, so a restart is
   *  known-futile (bad credentials / deleted bucket / regional outage) and the
   *  callback must NOT crash-loop the supervisor. */
  onWedgedBeyondRecovery?: (info: { hadCountedSuccess: boolean }) => void;
  logger?: ScopedLogger;
}

export class GuardedStore implements SessionStore {
  /** Methods whose hang signature matches the write-path wedge class; ONLY
   *  these drive (and reset) the rebuild streak. Read traffic staying healthy
   *  must not mask a write-only wedge — 2026-07-30 had exactly that shape:
   *  Postgres and JSON-API reads green, every upload hung.
   *
   *  signStagingUpload is deliberately EXCLUDED: in every deployed credential
   *  config a presign is pure local crypto — no network, instant success —
   *  so counting it would let daytime chunk traffic (each chunk presigns
   *  first) reset the streak forever and starve rebuild+escalation during the
   *  exact incident this class exists for; and its network-free "success"
   *  must never arm the restart-futility gate. The 60s selfTest probe is the
   *  legitimate reset source (and damps slow-link false breaches from long
   *  purges). */
  private static readonly BREACH_METHODS = new Set([
    "appendChunkToCanonical",
    "writeCanonicalText",
    "writeArtifact",
    "deleteSession",
    "selfTest",
  ]);

  private inner: SessionStore;
  private breaches = 0;
  private rebuildsWithoutRecovery = 0;
  private hadCountedSuccess = false;
  private readonly opTimeoutMs: number;
  private readonly heavyOpTimeoutMs: number;
  private readonly scanTimeoutMs: number;
  private readonly rebuildAfter: number;
  private readonly exhaustAfterRebuilds: number;
  private readonly onWedgedBeyondRecovery?: (info: { hadCountedSuccess: boolean }) => void;
  private readonly logger?: ScopedLogger;

  constructor(
    private readonly factory: () => SessionStore,
    opts: GuardedStoreOptions = {},
  ) {
    this.opTimeoutMs = opts.opTimeoutMs ?? 20_000;
    this.heavyOpTimeoutMs = opts.heavyOpTimeoutMs ?? 120_000;
    this.scanTimeoutMs = opts.scanTimeoutMs ?? 600_000;
    this.rebuildAfter = opts.rebuildAfter ?? 3;
    this.exhaustAfterRebuilds = opts.exhaustAfterRebuilds ?? 2;
    this.onWedgedBeyondRecovery = opts.onWedgedBeyondRecovery;
    this.logger = opts.logger;
    this.inner = this.factory();
  }

  private async guard<T>(
    method: string,
    timeoutMs: number,
    call: (s: SessionStore) => Promise<T>,
  ): Promise<T> {
    const s = this.inner;
    const counted = GuardedStore.BREACH_METHODS.has(method);
    const attempt = call(s);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        attempt,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StoreDeadlineError(method, timeoutMs)), timeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      // Only a WRITE-class success on the CURRENT client resets the streak: a
      // healthy read must not absolve a wedged write path, and a stale success
      // from a discarded client must not vouch for the fresh one.
      if (counted && this.inner === s) {
        this.breaches = 0;
        this.rebuildsWithoutRecovery = 0;
        this.hadCountedSuccess = true;
      }
      return result;
    } catch (err) {
      if (err instanceof StoreDeadlineError) {
        // Detach the hung call: its settle must not become an unhandled
        // rejection, and its result must never be trusted after we gave up.
        attempt.catch(() => {});
        const stale = this.inner !== s;
        this.logger?.error("store call exceeded deadline", {
          method,
          timeoutMs,
          counted,
          stale,
          consecutive: counted && !stale ? this.breaches + 1 : this.breaches,
        });
        // Breaches from calls in flight on a DISCARDED client must not charge
        // the fresh one (they'd rebuild it right after recovery).
        if (counted && !stale) {
          this.breaches += 1;
          if (this.breaches >= this.rebuildAfter) {
            this.inner = this.factory();
            this.breaches = 0;
            this.rebuildsWithoutRecovery += 1;
            this.logger?.error("storage client rebuilt after consecutive deadline breaches", {
              method,
              rebuildsWithoutRecovery: this.rebuildsWithoutRecovery,
            });
            if (this.rebuildsWithoutRecovery >= this.exhaustAfterRebuilds) {
              // Rebuilding demonstrably does not help: under Bun the hung
              // sockets live in the process-global native-fetch pool, which no
              // amount of client rebuilding can reach. Hand the decision to
              // the escalation callback and start a fresh episode either way.
              this.rebuildsWithoutRecovery = 0;
              this.onWedgedBeyondRecovery?.({ hadCountedSuccess: this.hadCountedSuccess });
            }
          }
        }
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  signStagingUpload(key: SessionKey, chunkId: string, opts?: StagingUploadOptions): Promise<SignedUpload> {
    return this.guard("signStagingUpload", this.opTimeoutMs, (s) => s.signStagingUpload(key, chunkId, opts));
  }
  readChunkText(key: SessionKey, chunkId: string): Promise<string> {
    return this.guard("readChunkText", this.heavyOpTimeoutMs, (s) => s.readChunkText(key, chunkId));
  }
  appendChunkToCanonical(key: SessionKey, chunkId: string, opts?: AppendOptions): Promise<ComposeResult> {
    // Heavy class: a compose is up to 8 sequential round trips (exists +
    // combine + delete + stat, plus every-800th compaction), and the guard
    // must never be the TIGHTEST abandonment on this call — an abandoned
    // compose that lands late is the ".staging 404"/double-append window. The
    // cloud tunnel's 30s still gates tunnel callers.
    return this.guard("appendChunkToCanonical", this.heavyOpTimeoutMs, (s) => s.appendChunkToCanonical(key, chunkId, opts));
  }
  statCanonical(key: SessionKey): Promise<number | null> {
    return this.guard("statCanonical", this.opTimeoutMs, (s) => s.statCanonical(key));
  }
  signCanonicalDownload(key: SessionKey): Promise<SignedDownload> {
    return this.guard("signCanonicalDownload", this.opTimeoutMs, (s) => s.signCanonicalDownload(key));
  }
  readCanonicalText(key: SessionKey): Promise<string> {
    return this.guard("readCanonicalText", this.heavyOpTimeoutMs, (s) => s.readCanonicalText(key));
  }
  writeCanonicalText(key: SessionKey, text: string): Promise<void> {
    return this.guard("writeCanonicalText", this.heavyOpTimeoutMs, (s) => s.writeCanonicalText(key, text));
  }
  writeArtifact(key: SessionKey, name: string, text: string): Promise<void> {
    return this.guard("writeArtifact", this.opTimeoutMs, (s) => s.writeArtifact(key, name, text));
  }
  readArtifactText(key: SessionKey, name: string): Promise<string | null> {
    return this.guard("readArtifactText", this.opTimeoutMs, (s) => s.readArtifactText(key, name));
  }
  listSessionArtifacts(key: SessionKey): Promise<string[]> {
    return this.guard("listSessionArtifacts", this.opTimeoutMs, (s) => s.listSessionArtifacts(key));
  }
  listSessionMetadata(userId: string): Promise<SessionMetadata[]> {
    // Scan class: one sequential metadata read per session — a few thousand
    // sessions on a direct-gateway list legitimately exceeds the heavy budget.
    return this.guard("listSessionMetadata", this.scanTimeoutMs, (s) => s.listSessionMetadata(userId));
  }
  listAllCanonicalKeys(): Promise<CanonicalEntry[]> {
    return this.guard("listAllCanonicalKeys", this.scanTimeoutMs, (s) => s.listAllCanonicalKeys());
  }
  getBucketVersioning(): Promise<BucketConfigFact> {
    return this.guard("getBucketVersioning", this.opTimeoutMs, (s) => s.getBucketVersioning());
  }
  getLifecycle(): Promise<BucketConfigFact> {
    return this.guard("getLifecycle", this.opTimeoutMs, (s) => s.getLifecycle());
  }
  selfTest(): Promise<void> {
    return this.guard("selfTest", this.opTimeoutMs, (s) => s.selfTest());
  }
  deleteSession(key: SessionKey, opts?: DeleteSessionOptions): Promise<DeleteSessionResult> {
    return this.guard("deleteSession", this.heavyOpTimeoutMs, (s) => s.deleteSession(key, opts));
  }
}
