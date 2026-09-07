// Component G scheduler — the guarantor's boot-drain + hourly sweep loop.
//
// Wraps reconcileOrphans() in a single-flight background scheduler:
//   • one BOOT-DRAIN pass shortly after start (drains the row-less backlog and,
//     on that first pass only, backfills existing fallback/empty titles), then
//   • an HOURLY sweep — the safety net so a canonical can never durably stay
//     row-less if a future best-effort ingest mirror silently fails.
//
// ON BY DEFAULT. The kill-switch is INVERTED (`FORTRESS_GUARANTOR_DISABLED`)
// because parseBooleanEnv is false-when-unset — so an unset/blank env means the
// guarantor runs. Set FORTRESS_GUARANTOR_DISABLED=1 to turn it off.
//
// db/store are resolved lazily (the same late-bound handles main.ts hands the
// gateway), so the scheduler is safe to construct before Postgres/the vault are
// ready; a tick that finds either not-ready simply reschedules soon.

import { sanitizeDbError } from "../host/postgres/sanitize";
import { parseBooleanEnv } from "../env";
import type { HxDb } from "../host/postgres/db";
import type { SessionStore } from "../modules/session-vault/store/types";
import { reconcileOrphans, type ReconcileOptions, type ReconcileResult } from "./reconciler";

export interface GuarantorLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export interface GuarantorConfig {
  db: () => HxDb | null;
  store: () => SessionStore | null;
  logger?: GuarantorLogger;
  /** Delay before the first (boot-drain) pass, ms. Default 30s. */
  bootDelayMs?: number;
  /** Interval between sweeps, ms. Default 1h. */
  intervalMs?: number;
  /** Retry delay when db/store aren't ready yet, ms. Default 15s. */
  notReadyRetryMs?: number;
  /** Coalesce a burst of known-failure signals into one soon-ish pass. Default 30s. */
  signalDebounceMs?: number;
  /** Ignore a failure signal within this window of the last COMPLETED pass, so a
   *  sustained failure stream can't drive a full bucket scan every debounce.
   *  The hourly sweep still bounds healing latency. Default 5m. */
  signalCooldownMs?: number;
  /** Run the one-time title corrective backfill over existing fallback/empty
   *  rows on the boot-drain. Opt-in (default false) — it re-reads every such
   *  canonical, and G's restore cascade already gives orphans their real title. */
  correctExistingTitles?: boolean;
  /** Pacing / caps handed to each reconcile pass. */
  reconcile?: Pick<
    ReconcileOptions,
    | "batchDelayMs"
    | "maxOrphans"
    | "repairStaleIndexes"
    | "staleRepairCeiling"
    | "deepVerifyPerPass"
    | "isSaturated"
    // The tail fast path's kill switch. `verifyFallbacks`' docstring names this
    // as the remedy for a mis-slicing tail path, and until now it was absent
    // here — so `opts.repairTails ?? true` was permanently true and the
    // documented escape hatch did not exist.
    | "repairTails"
  >;
  /** Test seam: stands in for reconcileOrphans so a test can prove which options
   *  each SCHEDULED pass carries. Twice an option shipped wired into a path
   *  nothing in production calls (healthSignals, then repairDuplicates on
   *  runOnce) while start()'s tick loop kept an older hand-built options object
   *  — unobservable from any test. Production wiring must always omit this. */
  reconcileImpl?: typeof reconcileOrphans;
}

/** Sweeps between duplicate-convergence scans. The oracle is a window over every
 *  turn in the corpus (87 s over 1.96M rows on the reference deployment), which is
 *  too much to pay hourly and nothing to pay daily. 24 sweeps between scans ≈ once
 *  a day at the hourly interval. */
const DUPLICATE_SCAN_EVERY = 24;

export interface Guarantor {
  start(): void;
  stop(): Promise<void>;
  /** Nudge a pass soon after a known ingest-mirror failure. ORDINARY variant:
   *  remote-influenceable (cloud RPCs can drive signalReconcile), so it is
   *  governed by max(debounce, cooldown-remaining) — a sustained failure
   *  stream can never drive back-to-back full bucket scans. Never dropped:
   *  a cooldown arrival is DEFERRED past the cooldown, not lost. */
  signal(): void;
  /** URGENT variant — fed ONLY by guarded-db's first probe success after a
   *  pool rebuild (internal, never remote): the orphan backlog that outage
   *  just created should heal in ~debounce, not at the next hourly sweep.
   *  Idle ⇒ schedule(debounce) IGNORING the cooldown; in-flight ⇒ latch (the
   *  pass's finally schedules debounce instead of the hourly interval). */
  signalUrgent(): void;
  /** Run one pass synchronously (tests / manual trigger); null if not ready. */
  runOnce(): Promise<ReconcileResult | null>;
}

const DEFAULT_BOOT_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/** Sweep interval override (ms): set-but-empty OR 0 ⇒ the default — the env is
 *  a tuning knob, never a disable switch (FORTRESS_GUARANTOR_DISABLED exists
 *  for that). */
export function guarantorIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FORTRESS_GUARANTOR_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_INTERVAL_MS;
}
const DEFAULT_NOT_READY_RETRY_MS = 15_000;
const DEFAULT_SIGNAL_DEBOUNCE_MS = 30_000;
const DEFAULT_SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;

/** True unless the operator set FORTRESS_GUARANTOR_DISABLED to a truthy value. */
export function guarantorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !parseBooleanEnv(env.FORTRESS_GUARANTOR_DISABLED);
}

export function createGuarantor(cfg: GuarantorConfig): Guarantor {
  const bootDelay = cfg.bootDelayMs ?? DEFAULT_BOOT_DELAY_MS;
  const interval = cfg.intervalMs ?? guarantorIntervalMs();
  const notReadyRetry = cfg.notReadyRetryMs ?? DEFAULT_NOT_READY_RETRY_MS;
  const signalDebounce = cfg.signalDebounceMs ?? DEFAULT_SIGNAL_DEBOUNCE_MS;
  const signalCooldown = cfg.signalCooldownMs ?? DEFAULT_SIGNAL_COOLDOWN_MS;
  const correctTitles = cfg.correctExistingTitles ?? false;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDueAt = Infinity;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  // Set when a failure signal has already armed a soon pass — so a burst of
  // signals collapses to one pass instead of continually resetting the timer.
  let signalPending = false;
  // Urgent latch: a guarded-db recovery signal that arrived while a pass was
  // in flight — consumed by that pass's finally (debounce instead of interval)
  // and cleared when the next pass starts.
  let urgentLatch = false;
  // When the last pass completed, so a signal cooldown can bound full-bucket
  // scans under a sustained failure stream (0 = no pass has finished yet).
  let lastPassEndAt = 0;
  // The title-correction backfill is a one-time job (new rows get their title at
  // ingest time), so run it on the boot-drain pass only — not every hourly sweep.
  let firstPass = true;
  // Sweeps since the duplicate-convergence scan last RAN, driving the cadence in
  // passOptions below. Starts at Infinity so the first sweep of every process is
  // due — a restart only means the corpus is re-proven clean soon, which is the
  // cheap direction.
  let sweepsSinceDuplicateScan = Infinity;

  // ONE options builder for every pass the scheduler can run. The tick loop and
  // runOnce used to hand-build separate options objects, and they drifted:
  // healthSignals and repairDuplicates were added to runOnce — which nothing in
  // production calls — while start()'s tick kept the old set, so both shipped
  // unreachable. An option exists here or it does not exist at all.
  //
  // "boot" is the boot-drain pass, on the startup path: it skips sweep-grade
  // work (the ~4 s health-signal SQL and the duplicate oracle's full-corpus
  // window). Every other pass — hourly, signal-driven, manual — is a "sweep".
  const passOptions = (kind: "boot" | "sweep"): ReconcileOptions => ({
    batchDelayMs: cfg.reconcile?.batchDelayMs,
    maxOrphans: cfg.reconcile?.maxOrphans,
    repairStaleIndexes: cfg.reconcile?.repairStaleIndexes,
    staleRepairCeiling: cfg.reconcile?.staleRepairCeiling,
    deepVerifyPerPass: cfg.reconcile?.deepVerifyPerPass,
    repairTails: cfg.reconcile?.repairTails,
    isSaturated: cfg.reconcile?.isSaturated,
    correctExistingTitles: firstPass && correctTitles,
    logger: cfg.logger,
    // Sweeps only: ~4 s of full-corpus SQL — too slow for the startup path, and
    // the only reason the dropped-write class is visible at all.
    healthSignals: kind === "sweep",
    // Duplicate convergence runs on a CADENCE, not behind a switch — a fix that
    // only happens when someone remembers to set a variable is not a fix (the
    // immutable release channel sat sixteen versions behind for exactly that
    // reason). The first sweep of the process is always due, converging the
    // corpus shortly after boot; after that, one scan a day proves nothing new
    // has appeared.
    repairDuplicates: kind === "sweep" && sweepsSinceDuplicateScan >= DUPLICATE_SCAN_EVERY,
    // B3: heal factless sessions on the SAME periodic cadence as the duplicate
    // scan (an anti-join, self-limiting, not per-pass) — a fix on a cadence, not
    // behind a switch someone must remember, for the same reason.
    recomputeFactlessFacts:
      kind === "sweep" && sweepsSinceDuplicateScan >= DUPLICATE_SCAN_EVERY,
  });

  // Advance the cadence from what the pass REPORTED, not what was requested:
  // duplicatedSessions comes back non-null exactly when the scan ran, and a
  // requested scan the pass never reached (stood down for load, or the query
  // failed) must stay due for the next sweep instead of silently spending its
  // once-a-day slot.
  const noteDuplicateScan = (kind: "boot" | "sweep", res: ReconcileResult): void => {
    if (res.duplicatedSessions !== null) {
      sweepsSinceDuplicateScan = 0;
    } else if (kind === "sweep" && Number.isFinite(sweepsSinceDuplicateScan)) {
      sweepsSinceDuplicateScan += 1;
    }
  };

  // The seam exists for tests; production always resolves to the real thing.
  const reconcile = cfg.reconcileImpl ?? reconcileOrphans;

  // Min-wins arming: never replace an armed SOONER pass with a later one (the
  // old unconditional clearTimeout let an hourly reschedule silently push out
  // an already-armed urgent debounce).
  const schedule = (ms: number): void => {
    if (stopped) return;
    const dueAt = Date.now() + ms;
    if (timer && timerDueAt <= dueAt) return;
    if (timer) clearTimeout(timer);
    timerDueAt = dueAt;
    timer = setTimeout(() => {
      timer = null;
      timerDueAt = Infinity;
      void tick();
    }, ms);
  };

  // Set when the last pass yielded to live ingest, so the next one is armed at
  // the debounce rather than the full interval — a 60-second saturation window
  // should not cost an hour of repair.
  let stoodDown = false;

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    signalPending = false; // this pass consumes any armed signal.
    urgentLatch = false; // …and any armed urgent one.
    const db = cfg.db();
    const store = cfg.store();
    if (!db || !store) {
      schedule(notReadyRetry); // Postgres / the vault isn't up yet — retry soon.
      return;
    }
    inFlight = (async () => {
      try {
        const kind = firstPass ? "boot" : "sweep";
        const res = await reconcile(db, store, passOptions(kind));
        // A pass that stood down for load did no work, so it must not consume
        // the one-shot boot drain (the title corrective backfill runs on the
        // first pass only). The drain fires 30 s after start — exactly when a
        // fortress restarting from a pool incident is most likely saturated.
        if (res.yieldedToLive === 0) firstPass = false;
        noteDuplicateScan(kind, res);
        // Re-arm early ONLY for a stand-down at the door. A pass that yielded
        // mid-flight has already paid for the bulk gate and the store listing;
        // retrying it in 30 s would hammer a database the fortress has just
        // declared starved, and `saturated()` flaps between probe ticks so half
        // those retries would run the whole expensive scan again.
        stoodDown = res.yieldedToLive > 0 && res.scanned === 0;
        cfg.logger?.info?.("guarantor: reconcile pass complete", { ...res });
        // D4 tripwire (LETAIR "months without issues"): once the write/read paths
        // are perfect the guarantor is a backstop that should HEAL NOTHING. A
        // SWEEP (not the boot pass, which legitimately drains a restart's backlog)
        // that restored an orphan or repaired a lane means the live forward AND its
        // durable sync-retry both missed. A BURST is EXPECTED right after a deploy
        // that widens the guarantor's reach (e.g. the repair cap-raise finally
        // healing the 155/304/453 MB sessions) — the signal is the TREND: this must
        // fall to zero and STAY there. A persistent or rising non-zero is the
        // regression. Detection-only floors (oversizedUnindexed, tooLargeToJudge,
        // deepVerifyFloor) are NOT tripwires — they are the honest "cannot judge
        // this" report, not work the write path owed.
        const healed = res.restored + res.repairedFull + (res.byteGapRows ?? 0);
        if (kind === "sweep" && healed > 0) {
          cfg.logger?.warn?.(
            "guarantor: healed work on a sweep — the live write path did not. Expected as a post-deploy backlog drains; a persistent non-zero means the write path regressed.",
            {
              restored: res.restored,
              repairedFull: res.repairedFull,
              byteGapRows: res.byteGapRows ?? 0,
            },
          );
        }
      } catch (err) {
        // reconcileOrphans is non-throwing per session; this catches only a
        // whole-pass failure (e.g. the store enumeration threw). Retry next tick.
        cfg.logger?.warn?.("guarantor: reconcile pass failed", { err: sanitizeDbError(err) });
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
      lastPassEndAt = Date.now();
      // An urgent signal that arrived mid-pass pulls the next pass to the
      // debounce window (the outage's backlog is already known); otherwise
      // the ordinary sweep cadence resumes.
      schedule(urgentLatch || stoodDown ? signalDebounce : interval);
    }
  }

  return {
    start() {
      stopped = false;
      schedule(bootDelay);
    },
    signal() {
      // Pull the next pass in. Ignore while a pass is in flight (it'll observe
      // the new orphan) or one is already armed (no reset-storm under a burst
      // of failures). A cooldown arrival is DEFERRED past the cooldown rather
      // than dropped — max(debounce, cooldown-remaining) governs all ordinary
      // consumption, so a signal is never lost while full-bucket scans stay
      // bounded under a sustained failure stream.
      if (stopped || inFlight || signalPending) return;
      const cooldownRemaining =
        lastPassEndAt > 0 ? Math.max(0, signalCooldown - (Date.now() - lastPassEndAt)) : 0;
      signalPending = true;
      schedule(Math.max(signalDebounce, cooldownRemaining));
    },
    signalUrgent() {
      // Internal-only (guarded-db recovery): the cooldown exists to bound
      // REMOTE-drivable scan pressure, so a local recovery signal ignores it.
      if (stopped) return;
      if (inFlight) {
        urgentLatch = true;
        return;
      }
      schedule(signalDebounce);
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      timerDueAt = Infinity;
      // Let an in-flight pass finish rather than tearing the DB handle out from
      // under a live ingest transaction.
      if (inFlight) await inFlight.catch(() => {});
    },
    async runOnce() {
      const db = cfg.db();
      const store = cfg.store();
      if (!db || !store) return null;
      const res = await reconcile(db, store, passOptions("sweep"));
      firstPass = false;
      noteDuplicateScan("sweep", res);
      return res;
    },
  };
}
