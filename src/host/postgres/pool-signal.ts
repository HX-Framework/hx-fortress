// Process-local signal for "the hx-db pool had no connection to give".
//
// The PG layer's healer (guarded-db) could not previously observe pool
// exhaustion at all: its probe is a standalone one-connection canary, so a
// SATURATED pool answers the canary instantly while every real query times out
// in the checkout queue. That blind spot is why the 2026-08-05 ingest outage ran
// for ~13 hours with /healthz and /readyz green and no rebuild ever firing —
// the layer's own comment ("ONLY the probe feeds breach accounting: a slow RPC
// is busy, not wedged") was true for slowness and wrong for starvation.
//
// This is the missing feed. The query paths emit; guarded-db subscribes and
// folds the count into the same breach accounting the probe uses, so a hoarded
// pool now reaches the remedy that always existed for it — a rebuild, which
// force-closes the retired pool and releases the connections its abandoned
// transactions were holding.
//
// Same shape as ingest/reconcile-signal and the embed worker's signal: a single
// process-local handler, never a remote seam, and a no-op until something wires
// it (so tests and one-shot CLI paths need no setup).

type PoolExhaustedHandler = () => void;

let handler: PoolExhaustedHandler | null = null;

/** Wire the subscriber (guarded-db). Passing null unwires — used on shutdown so
 *  a late emit can't touch a stopped healer. */
export function setPoolExhaustedHandler(next: PoolExhaustedHandler | null): void {
  handler = next;
}

/** Emit: one query was rejected because every pooled connection was busy.
 *  Never throws — a broken observer must not fail the query that reported it. */
export function signalPoolExhausted(): void {
  try {
    handler?.();
  } catch {
    // observability must never become a failure path
  }
}
