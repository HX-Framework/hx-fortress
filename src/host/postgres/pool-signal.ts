// Process-local feed of pool outcomes from the real query paths to guarded-db.
//
// The healer's standalone probe cannot see either way the live write pool
// failed in production. A pool that is merely STARVED (every connection busy)
// answers the probe's own connection instantly while real queries wait — the
// 2026-08-05 shape. A pool whose reservation bookkeeping is WEDGED serves plain
// queries but never hands out another transaction — the 2026-10-13 shape (see
// the `idleTimeout` note in db.ts). Both are visible only where the work runs,
// so those paths report here and guarded-db folds the counts into its breach
// accounting: a tick with deadline misses and no completed phase is a breach,
// and consecutive breaches rebuild the pools, which is the remedy that exists
// for both (a fresh pool, and a close that fails whatever was queued).
//
// Same shape as ingest/reconcile-signal and the embed worker's signal: a single
// process-local handler, never a remote seam, and a no-op until something wires
// it (so tests and one-shot CLI paths need no setup).

export type PoolOutcome =
  /** A PG phase settled before its caller's deadline — the pool served it.
   *  A normal server error (duplicate key, session_deleted) counts: the pool
   *  handed out a connection and the statement ran. */
  | "ok"
  /** The caller's deadline passed with the PG phase still pending. Either every
   *  connection is busy or the pool can no longer serve a transaction. */
  | "deadline"
  /** The driver closed a connection under a query (a kill-class error: idle
   *  reaper, max lifetime, socket closed). Retried once by the caller. */
  | "kill";

type PoolOutcomeObserver = (outcome: PoolOutcome) => void;

let observer: PoolOutcomeObserver | null = null;

/** Wire the subscriber (guarded-db). Passing null unwires — used on shutdown so
 *  a late report can't touch a stopped healer. */
export function setPoolOutcomeObserver(next: PoolOutcomeObserver | null): void {
  observer = next;
}

/** Report one outcome. Never throws — a broken observer must not fail the
 *  query that reported it. */
export function reportPoolOutcome(outcome: PoolOutcome): void {
  try {
    observer?.(outcome);
  } catch {
    // observability must never become a failure path
  }
}
