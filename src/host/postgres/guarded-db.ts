// guarded-db — the PG-layer analog of GuardedStore (component 2 of the
// PG-layer resilience design), sitting at the RESOLVER layer: it owns the two
// memoized drizzle pools (rw/ro) behind `db()`/`dbRead()` and heals them.
//
//   probe (60 s, standalone canary) → 3 consecutive breaches → rebuild (swap
//   resolvers FIRST, close old pools detached) → 2 futile rebuilds (no probe
//   success between) → wedge escalation → supervised exit(1).
//
// ONLY the probe feeds breach accounting: a slow RPC is busy, not wedged. The
// probe client MIRRORS the shared pools' startup params (incl. the
// statement_timeout=0 omission), so a pooler that rejects the pools' startup
// parameter also breaches the probe — the param-carrying canary. The
// provider-layer boot probe stays param-FREE by design (a pooler-fronted DSN
// must be able to reach ready before the operator sets the =0 hatch); this
// layer is what then surfaces the misconfiguration.

import { createWedgeEscalation } from "../../modules/session-vault/store";
import type { ScopedLogger } from "../types";
import {
  createHxDb,
  describePool,
  hxPoolOptionsFor,
  type HxDb,
  type HxPoolOptions,
  type HxPoolRole,
} from "./db";
import { setPoolExhaustedHandler } from "./pool-signal";
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
  /** Pool-exhaustion rejections within ONE probe interval that make the tick
   *  count as a saturation breach. */
  saturationPerTickThreshold?: number;
  /** Consecutive saturated ticks before the pools are rebuilt to release the
   *  connections that abandoned transactions are still holding. */
  saturationBreachThreshold?: number;
  /** Test seams. */
  makeDb?: (dsn: string, options: HxPoolOptions) => HxDb;
  makeProbeClient?: (dsn: string, options: HxPoolOptions) => ProbeClient;
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
  /** True while the live pool is rejecting queries for want of a connection.
   *  Surfaced on /readyz so a starved fortress stops reporting itself perfectly
   *  healthy the way it did for ~13 hours on 2026-08-05. */
  saturated(): boolean;
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
const DEFAULT_SATURATION_PER_TICK = 5;
const DEFAULT_SATURATION_BREACH_THRESHOLD = 2;

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

export function createGuardedDb(deps: GuardedDbDeps): GuardedDb {
  const env = deps.env ?? process.env;
  const logger = deps.logger;
  const intervalMs = deps.probeIntervalMs ?? probeIntervalMs(env);
  const probeTimeout = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const breachThreshold = deps.breachThreshold ?? DEFAULT_BREACH_THRESHOLD;
  const futileThreshold = deps.futileRebuildThreshold ?? DEFAULT_FUTILE_REBUILD_THRESHOLD;
  const makeDb = deps.makeDb ?? createHxDb;
  const makeProbe = deps.makeProbeClient ?? defaultProbeClient;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
  let hungCloses = 0;
  let hungCloseWarned = false;
  let poolerMisconfigWarned = false;
  let bootLineLogged = false;
  let bgLineLogged = false;
  let exhaustedSinceTick = 0;
  let saturationStreak = 0;
  const saturationPerTick = deps.saturationPerTickThreshold ?? DEFAULT_SATURATION_PER_TICK;
  const saturationBreaches = deps.saturationBreachThreshold ?? DEFAULT_SATURATION_BREACH_THRESHOLD;

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
   *  queries; its own promise can hang on a black-holed socket — race it for
   *  bookkeeping only, observers attached (Bun exits on unhandled rejections). */
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
      // close({timeout:5}) force-rejects whatever is still in flight, which is
      // precisely the remedy for a pool whose connections are held by
      // transactions their callers abandoned long ago.
      closeRetired(oldRw);
      closeRetired(oldRo);
      closeRetired(oldBg);
      rebuildsSinceProbeSuccess += 1;
      awaitingRecoverySignal = true;
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

  /** One query was rejected by the checkout queue. Counted, never acted on
   *  immediately: a single rejection is a burst, a sustained rate is starvation. */
  const notePoolExhausted = (): void => {
    exhaustedSinceTick += 1;
  };

  /** Fold the tick window into breach accounting. Runs on EVERY probe tick,
   *  independent of the probe verdict — during starvation the canary answers
   *  perfectly (it holds its own connection), so the probe alone would report
   *  health right through the outage.
   *
   *  The remedy is the rebuild that already exists: swapping the pools
   *  force-closes the retired ones, releasing the connections held by
   *  transactions whose callers gave up at the RPC deadline. */
  const evaluateSaturation = (): void => {
    const rejected = exhaustedSinceTick;
    exhaustedSinceTick = 0;
    if (rejected < saturationPerTick) {
      saturationStreak = 0;
      return;
    }
    saturationStreak += 1;
    logger?.error("hx-db pool saturated — queries rejected waiting for a connection", {
      rejected,
      saturationStreak,
    });
    if (saturationStreak >= saturationBreaches) {
      saturationStreak = 0;
      rebuild("sustained pool saturation");
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
      const ok = await Promise.race([query, sleep(probeTimeout).then(() => false)]);
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
      evaluateSaturation();
      probeBusy = false;
    }
  };

  return {
    db: () => resolve("rw"),
    dbRead: () => resolve("ro"),
    dbBackground: () => resolve("bg"),
    saturated: () => saturationStreak > 0,
    start() {
      stopped = false;
      // Subscribe to the query paths. Saturation accounting rides the probe
      // tick, so disabling the probe disables this detection too — the warning
      // below is the one place that is stated.
      setPoolExhaustedHandler(notePoolExhausted);
      if (intervalMs <= 0) {
        logger?.warn(
          "hx-db probe disabled (FORTRESS_DB_PROBE_INTERVAL_MS=0) — pool-saturation detection is off with it",
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
      // Unwire before teardown so a late emit cannot touch a stopped healer.
      setPoolExhaustedHandler(null);
      if (timer) clearInterval(timer);
      timer = null;
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
