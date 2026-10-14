// guarded-db — the PG-layer analog of GuardedStore (component 2 of the
// PG-layer resilience design), sitting at the RESOLVER layer: it owns the three
// memoized drizzle pools (rw/ro/bg) behind `db()`/`dbRead()`/`dbBackground()`
// and heals them. Two detectors feed one remedy:
//
//   canary (60 s, standalone one-connection client) → 3 consecutive breaches →
//   rebuild (swap resolvers FIRST, close old pools detached) → 2 futile
//   rebuilds (no probe success between) → wedge escalation → supervised exit(1).
//
//   live-pool detector (same tick, only while the canary answers): a transaction
//   probe on the REAL rw pool, plus the outcomes the write paths report
//   (pool-signal.ts). A tick in which the pool served NOTHING — no PG phase
//   settled — while the probe failed or callers hit their deadline is a stall;
//   2 consecutive stalls rebuild the pools.
//
// The canary alone cannot see either production outage. It holds its own
// connection, so a STARVED pool (2026-08-05: every connection busy, every real
// query rejected) and a WEDGED pool (2026-10-13: the driver's reservation
// counter drifted after connections were killed under open transactions, so
// sql.begin() queued forever while plain queries still ran — see the
// `idleTimeout` note in db.ts) both answered it perfectly for hours. The live
// detector sees both, because it asks the pool the question the callers ask:
// can you serve a transaction right now, and did you serve any since the last
// tick. The remedy is the rebuild that already existed: a fresh pool with fresh
// bookkeeping, and a close that fails every queued reservation so the abandoned
// RPC promises finally settle and release what they hold.
//
// The probe client MIRRORS the shared pools' startup params (incl. the
// statement_timeout=0 omission), so a pooler that rejects the pools' startup
// parameter also breaches the probe — the param-carrying canary. The
// provider-layer boot probe stays param-FREE by design (a pooler-fronted DSN
// must be able to reach ready before the operator sets the =0 hatch); this
// layer is what then surfaces the misconfiguration.

import { sql } from "drizzle-orm";

import { createWedgeEscalation } from "../../modules/session-vault/store";
import type { ScopedLogger } from "../types";
import {
  createHxDb,
  describePool,
  hxPoolOptionsFor,
  ignoredDriverKnobs,
  type HxDb,
  type HxPoolOptions,
  type HxPoolRole,
} from "./db";
import { createBackendCanceller, type BackendCanceller } from "./pg-cancel";
import { setPoolOutcomeObserver, type PoolOutcome } from "./pool-signal";
import { isUnsupportedStartupParamError } from "./pg-errors";
import { sanitizeDbError } from "./sanitize";

/** Minimal shape of the probe's standalone one-connection client. */
export interface ProbeClient {
  selectOne(): Promise<void>;
  /** Close whose OWN promise may hang on a black-holed socket — callers detach it. */
  close(): Promise<void>;
}

export interface GuardedDbDeps {
  /** Role-aware DSN, null until the provider is ready (probe no-ops then). */
  dsn: (role?: "ro" | "rw") => string | null;
  logger?: ScopedLogger;
  /** First probe success after ANY rebuild — main.ts wires this to the
   *  guarantor's urgent signal (internal-only; never a remote seam). */
  onRecovered?: () => void;
  /** Every rebuild — main.ts wires this to the embed worker's resetDb(). */
  onRebuild?: () => void;
  /** Stops the embedded postmaster before a wedge exit (same hook the store's
   *  escalation takes — launchd has no cgroup kill). */
  stopEmbeddedPostgres?: () => Promise<void>;
  env?: Record<string, string | undefined>;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  breachThreshold?: number;
  futileRebuildThreshold?: number;
  /** Consecutive stalled ticks — nothing served while the live transaction
   *  probe failed or callers missed their deadline — before the pools are
   *  rebuilt to release the connections and reservations they are stuck on. */
  stallBreachThreshold?: number;
  /** Deadline misses within ONE tick that make the tick count as "callers
   *  waiting" for the stall rule. */
  deadlineMissesPerTick?: number;
  /** Test seams. */
  makeDb?: (dsn: string, options: HxPoolOptions) => HxDb;
  makeProbeClient?: (dsn: string, options: HxPoolOptions) => ProbeClient;
  /** Stands in for the live transaction probe (`db.transaction(select 1)`). */
  txProbe?: (db: HxDb) => Promise<void>;
  /** Stands in for the dedicated pg_cancel_backend client. */
  cancelBackend?: BackendCanceller;
  onWedged?: (info: { hadCountedSuccess: boolean }) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface GuardedDb {
  /** RW (DML) resolver — memoized until a rebuild swaps the generation. */
  db(): HxDb | null;
  /** SELECT-only RO resolver. */
  dbRead(): HxDb | null;
  /** Background (guarantor / reconciler) resolver — its own small pool, so a
   *  reconcile pass of whole-transcript restores can never spend the live
   *  ingest budget. Same RW credentials, separate allocation. */
  dbBackground(): HxDb | null;
  /** True while the live detector sees the write pool stalled: nothing served
   *  for a tick while callers waited or the transaction probe failed. Surfaced
   *  on /readyz so a starved or wedged fortress stops reporting itself
   *  perfectly healthy the way it did for ~13 hours on 2026-08-05 and for every
   *  restart window on 2026-10-13; the reconciler stands down on it. */
  saturated(): boolean;
  /** Cancel the current statement of one Postgres backend — racePgPhase's
   *  deadline remedy. Runs on a dedicated one-connection client, never a pool
   *  slot (the pool it cancels for may be the one that is stuck). */
  cancelBackend(pid: number): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  /** One probe cycle now (tests). Resolves to the probe verdict, or null when
   *  the DSN isn't ready (no accounting happened). */
  probeNow(): Promise<boolean | null>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_BREACH_THRESHOLD = 3;
const DEFAULT_FUTILE_REBUILD_THRESHOLD = 2;
const HUNG_CLOSE_GAUGE_WARN = 8;
const DEFAULT_STALL_BREACH_THRESHOLD = 2;
const DEFAULT_DEADLINE_MISSES_PER_TICK = 1;

/** Probe cadence (ms): set-but-empty ⇒ default 60 000; an explicit 0 disables
 *  (store-probe precedent — probing is detection, not a data path). */
export function probeIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FORTRESS_DB_PROBE_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 60_000;
}

function defaultProbeClient(dsn: string, options: HxPoolOptions): ProbeClient {
  const client = new Bun.SQL(dsn, {
    max: 1,
    connectionTimeout: options.connectionTimeout,
    // MIRROR the pools' startup params — the canary must fail the way the
    // pools fail (incl. a pooler rejecting statement_timeout).
    ...(options.connection ? { connection: options.connection } : {}),
  });
  return {
    selectOne: async () => {
      await client`SELECT 1`;
    },
    close: () => client.close({ timeout: 1 }),
  };
}

/** The live transaction probe: the exact call shape every ingest write makes
 *  (reserve a connection, BEGIN, one statement, COMMIT), on the real rw pool. A
 *  pool whose reservation bookkeeping has drifted answers plain queries and
 *  never completes this. */
function defaultTxProbe(db: HxDb): Promise<void> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1`);
  });
}

export function createGuardedDb(deps: GuardedDbDeps): GuardedDb {
  const env = deps.env ?? process.env;
  const logger = deps.logger;
  const intervalMs = deps.probeIntervalMs ?? probeIntervalMs(env);
  const probeTimeout = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const breachThreshold = deps.breachThreshold ?? DEFAULT_BREACH_THRESHOLD;
  const futileThreshold = deps.futileRebuildThreshold ?? DEFAULT_FUTILE_REBUILD_THRESHOLD;
  const stallBreaches = deps.stallBreachThreshold ?? DEFAULT_STALL_BREACH_THRESHOLD;
  const deadlineMissesPerTick = deps.deadlineMissesPerTick ?? DEFAULT_DEADLINE_MISSES_PER_TICK;
  const makeDb = deps.makeDb ?? createHxDb;
  const makeProbe = deps.makeProbeClient ?? defaultProbeClient;
  const txProbe = deps.txProbe ?? defaultTxProbe;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const canceller = deps.cancelBackend
    ? { cancel: deps.cancelBackend, close: (): void => {} }
    : createBackendCanceller(() => deps.dsn("rw"), logger);
  const escalate =
    deps.onWedged ??
    createWedgeEscalation({
      logger,
      beforeExit: deps.stopEmbeddedPostgres,
      subject: "database",
      neverWorkedHint: "DSN/credentials/pooler misconfiguration",
    });

  let rw: HxDb | null = null;
  let ro: HxDb | null = null;
  let bg: HxDb | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let probeBusy = false;
  let breachStreak = 0;
  let rebuildsSinceProbeSuccess = 0;
  let hadProbeSuccess = false;
  let escalatedThisEpisode = false;
  let awaitingRecoverySignal = false;
  let rotating = false;
  let rebuiltThisTick = false;
  let hungCloses = 0;
  let hungCloseWarned = false;
  let poolerMisconfigWarned = false;
  let bootLineLogged = false;
  let bgLineLogged = false;
  let roLineLogged = false;
  // Live-pool detector state: outcomes reported since the last tick, and the
  // streak of stalled ticks.
  let servedSinceTick = 0;
  let deadlinesSinceTick = 0;
  let killsSinceTick = 0;
  let stallStreak = 0;

  // The canary mirrors the LIVE WRITE pool: that is the pool whose startup
  // params (statement_timeout, and now lock_timeout) a pooler would reject.
  const options = (): HxPoolOptions => hxPoolOptionsFor("rw", env);

  const resolve = (role: HxPoolRole): HxDb | null => {
    const current = role === "rw" ? rw : role === "ro" ? ro : bg;
    if (current) return current;
    // "bg" is not a credential role — it is the RW role with a smaller, isolated
    // allocation, so it resolves the RW DSN.
    const dsn = deps.dsn(role === "bg" ? "rw" : role);
    if (!dsn) return null;
    const opts = hxPoolOptionsFor(role, env);
    const built = makeDb(dsn, opts);
    if (role === "rw") {
      rw = built;
      if (!bootLineLogged) {
        bootLineLogged = true;
        logger?.info("hx-db pool options", describePool(dsn, opts));
      }
    } else if (role === "ro") {
      ro = built;
      if (!roLineLogged) {
        roLineLogged = true;
        logger?.info("hx-db read pool options", describePool(dsn, opts));
      }
    } else {
      bg = built;
      if (!bgLineLogged) {
        bgLineLogged = true;
        logger?.info("hx-db background pool options", describePool(dsn, opts));
      }
    }
    return built;
  };

  /** Detached, bounded close of a retired drizzle pool: swap happened FIRST, so
   *  this only drains stragglers. close({timeout:5}) force-rejects in-flight
   *  queries AND every reservation still queued on the old pool; its own
   *  promise can hang on a black-holed socket — race it for bookkeeping only,
   *  observers attached (Bun exits on unhandled rejections). */
  const closeRetired = (handle: HxDb | null): void => {
    if (!handle) return;
    const client = (handle as unknown as { $client?: { close?: (o?: { timeout?: number }) => Promise<void> } })
      .$client;
    if (!client?.close) return;
    const closing = client.close({ timeout: 5 }).catch((err: unknown) => {
      logger?.warn("retired hx-db pool close failed", { error: sanitizeDbError(err) });
    });
    void Promise.race([closing, sleep(10_000)]);
  };

  const rebuild = (reason = "consecutive probe breaches"): void => {
    if (rotating) return; // rotation mutex — one swap per breach episode step
    rotating = true;
    try {
      const oldRw = rw;
      const oldRo = ro;
      const oldBg = bg;
      // Swap FIRST: the very next resolver call builds fresh pools; nothing
      // ever awaits the old pool's teardown.
      rw = null;
      ro = null;
      bg = null;
      // close({timeout:5}) force-rejects whatever is still in flight or queued,
      // which is precisely the remedy for a pool whose connections are held by
      // transactions their callers abandoned long ago, and for one whose
      // reservation queue can no longer drain.
      closeRetired(oldRw);
      closeRetired(oldRo);
      closeRetired(oldBg);
      rebuildsSinceProbeSuccess += 1;
      awaitingRecoverySignal = true;
      rebuiltThisTick = true;
      stallStreak = 0;
      deps.onRebuild?.();
      logger?.error("hx-db pools rebuilt after " + reason, {
        rebuildsSinceProbeSuccess,
      });
      if (rebuildsSinceProbeSuccess >= futileThreshold && !escalatedThisEpisode) {
        escalatedThisEpisode = true;
        // Futility counts ONLY guarded-db-layer probe successes: a pooler
        // misconfiguration that never let a pool connect must degrade with the
        // remedy log, not supervisor-crash-loop the fortress.
        if (!hadProbeSuccess && poolerMisconfigWarned) emitPoolerRemedy();
        escalate({ hadCountedSuccess: hadProbeSuccess });
      }
    } finally {
      rotating = false;
    }
  };

  /** One outcome from a write path. Counted, never acted on immediately: a
   *  single deadline miss is a slow statement, a tick of them with nothing
   *  served is a pool that stopped working. */
  const noteOutcome = (outcome: PoolOutcome): void => {
    if (outcome === "ok") servedSinceTick += 1;
    else if (outcome === "deadline") deadlinesSinceTick += 1;
    else killsSinceTick += 1;
  };

  /** The live-pool rule, run on every tick the canary answered. Independent of
   *  the probe verdict by design: during both production stalls the canary
   *  answered perfectly (it holds its own connection) while the pool served no
   *  transaction for hours. When the canary FAILS the server itself is away,
   *  the canary's own breach accounting owns the remedy, and the counters are
   *  dropped so an outage is not double-counted as a stall. */
  const evaluateLivePool = async (canaryOk: boolean): Promise<void> => {
    const served = servedSinceTick;
    const deadlines = deadlinesSinceTick;
    const kills = killsSinceTick;
    servedSinceTick = 0;
    deadlinesSinceTick = 0;
    killsSinceTick = 0;
    if (!canaryOk) {
      stallStreak = 0;
      return;
    }
    // Probe the REAL rw pool only once something built it: a pool nobody has
    // asked for cannot be stalled, and building one here would be the probe
    // creating the thing it measures. A tick that already rebuilt skips the
    // probe — the new pool has not been asked for anything yet.
    const pool = rw;
    let txOk: boolean | null = null;
    if (pool && !rebuiltThisTick) {
      txOk = await Promise.race([
        txProbe(pool).then(
          () => true,
          () => false,
        ),
        sleep(probeTimeout).then(() => false),
      ]);
    }
    const callersWaiting = deadlines >= deadlineMissesPerTick;
    // Served > 0 is the discriminator between BUSY and STALLED: a pool whose
    // every connection is running a legitimate 25 s insert still completes
    // some of them within a tick, and must not be rebuilt under them.
    const stalled = served === 0 && (txOk === false || callersWaiting);
    if (!stalled) {
      if (stallStreak > 0) {
        logger?.info("hx-db live pool serving again", { served, deadlineMisses: deadlines, kills });
      }
      stallStreak = 0;
      return;
    }
    stallStreak += 1;
    logger?.error("hx-db live pool stalled — nothing served this tick", {
      served,
      deadlineMisses: deadlines,
      kills,
      txProbe: txOk === null ? "skipped" : txOk ? "ok" : "failed",
      stallStreak,
    });
    if (stallStreak >= stallBreaches) {
      rebuild("live pool stall (no transaction served while callers waited)");
    }
  };

  const emitPoolerRemedy = (): void => {
    logger?.error(
      "the DSN's pooler rejects the statement_timeout startup parameter — set " +
        "FORTRESS_DB_STATEMENT_TIMEOUT_MS=0 to omit it (see README, pooled-DSN escape hatch)",
    );
  };

  const classifyProbeFailure = (err: unknown): void => {
    // Connection-class surface only: this is the probe's own connect/query
    // rejection, never free-text over arbitrary RPC errors.
    if (isUnsupportedStartupParamError(err) && !poolerMisconfigWarned) {
      poolerMisconfigWarned = true;
      emitPoolerRemedy();
    }
  };

  const probeTick = async (): Promise<boolean | null> => {
    if (stopped || probeBusy) return null;
    const dsn = deps.dsn("rw");
    if (!dsn) return null; // provider not ready — detection is the provider's job
    probeBusy = true;
    rebuiltThisTick = false;
    let ok = false;
    try {
      const client = makeProbe(dsn, options());
      let failure: unknown = null;
      const query = client.selectOne().then(
        () => true,
        (err) => {
          failure = err;
          return false;
        },
      );
      ok = await Promise.race([query, sleep(probeTimeout).then(() => false)]);
      // Teardown is DECOUPLED from probe accounting: probing never pauses on a
      // hung close. Bounded residual: ≤1 hung socket per probe interval,
      // OS-reaped in ~15-30 min (tcp_retries2) — the gauge below makes an
      // accumulation visible without changing behavior.
      hungCloses += 1;
      void client
        .close()
        .catch(() => {})
        .finally(() => {
          hungCloses -= 1;
          if (hungCloses <= HUNG_CLOSE_GAUGE_WARN) hungCloseWarned = false;
        });
      if (hungCloses > HUNG_CLOSE_GAUGE_WARN && !hungCloseWarned) {
        hungCloseWarned = true;
        logger?.warn("hx-db probe teardowns accumulating (black-holed sockets?)", {
          outstanding: hungCloses,
        });
      }
      if (ok) {
        breachStreak = 0;
        hadProbeSuccess = true;
        rebuildsSinceProbeSuccess = 0;
        escalatedThisEpisode = false;
        if (awaitingRecoverySignal) {
          awaitingRecoverySignal = false;
          logger?.info("hx-db probe recovered after rebuild — nudging reconcile");
          deps.onRecovered?.();
        }
        return true;
      }
      breachStreak += 1;
      if (failure !== null) classifyProbeFailure(failure);
      logger?.error("hx-db probe breached", {
        breachStreak,
        error: failure === null ? `no response in ${probeTimeout}ms` : sanitizeDbError(failure),
      });
      if (breachStreak >= breachThreshold) {
        breachStreak = 0;
        rebuild();
      }
      return false;
    } finally {
      await evaluateLivePool(ok);
      probeBusy = false;
    }
  };

  return {
    db: () => resolve("rw"),
    dbRead: () => resolve("ro"),
    dbBackground: () => resolve("bg"),
    saturated: () => stallStreak > 0,
    cancelBackend: (pid) => canceller.cancel(pid),
    start() {
      stopped = false;
      // Subscribe to the write paths. Stall accounting rides the probe tick, so
      // disabling the probe disables this detection too — the warning below is
      // the one place that is stated.
      setPoolOutcomeObserver(noteOutcome);
      const ignored = ignoredDriverKnobs(env);
      if (ignored.length > 0) {
        logger?.warn(
          "these env knobs no longer reach the database driver (its idleTimeout was never a checkout bound; see db.ts)",
          { ignored },
        );
      }
      if (intervalMs <= 0) {
        logger?.warn(
          "hx-db probe disabled (FORTRESS_DB_PROBE_INTERVAL_MS=0) — live-pool stall detection is off with it",
        );
        return;
      }
      timer = setInterval(() => {
        void probeTick();
      }, intervalMs);
      (timer as { unref?: () => void }).unref?.();
    },
    async stop() {
      stopped = true;
      // Unwire before teardown so a late report cannot touch a stopped healer.
      setPoolOutcomeObserver(null);
      if (timer) clearInterval(timer);
      timer = null;
      canceller.close();
      const oldRw = rw;
      const oldRo = ro;
      const oldBg = bg;
      rw = null;
      ro = null;
      bg = null;
      closeRetired(oldRw);
      closeRetired(oldRo);
      closeRetired(oldBg);
    },
    probeNow: () => probeTick(),
  };
}
