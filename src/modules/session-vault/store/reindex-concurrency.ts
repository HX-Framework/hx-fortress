// Concurrency bound for the one vault RPC that runs a WHOLE-transcript rebuild on
// the LIVE rw pool: `reindexCanonical`. Every other rw RPC (`ingestCommit`,
// `ingestAgentCommit`) is a millisecond DELTA; reindexCanonical alone reads the
// whole canonical (several× the file size in heap) and applies one big
// `ingestCommit(replace)` txn. For the 30-80 MB tail that txn runs past the 25 s
// RPC deadline and — because `racePgPhase` never cancels — keeps its rw connection
// until it truly settles. A burst of these exhausts the pool, and the millisecond
// live appends then starve with `db_unavailable:ingest_commit`. That is the
// regression this bound removes: cap how many rebuilds run at once, and the rest
// of the pool stays free for live writes.
//
// This is the interim guard. The durable fix is a bounded-memory STREAMING
// rebuild on the background pool (the guarantor already owns whole-transcript
// restores there, on its own long budget) so the live path never runs a whole
// rebuild at all. Until that lands, a simple in-process cap keeps live sessions
// working like before while large rebuilds proceed — slower, but safe.

import { poolMax } from "../../../host/postgres/db.js";

/** Bounded-concurrency runner — caps simultaneous in-process runs, FIFO queue.
 *
 *  Mirrors the embed worker's prod-proven limiter (embed-worker/worker.ts): the
 *  slot is released in a `finally`, so a run that throws (including the
 *  `racePgPhase` deadline reject) never leaks its slot. It is a soft bound, not a
 *  hard gate: a run frees its slot the instant its promise settles, so a rebuild
 *  that overruns the deadline releases at ~25 s even though its connection lingers
 *  until the txn settles — the settle-after tail can therefore hold up to ~2× the
 *  cap in flight at once. `reindexMaxConcurrency` sizes the cap with that 2×
 *  overshoot (plus the primitive's transient microtask +1) already budgeted in. */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const ceiling = Number.isFinite(max) && max >= 1 ? Math.trunc(max) : 1;
  let active = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= ceiling) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/** Max concurrent `reindexCanonical` rebuilds allowed on the live rw pool.
 *
 *  Default = `poolMax / 4` (min 1). A QUARTER, not a half, on purpose: a rebuild
 *  that overruns the 25 s deadline keeps its connection until the txn settles
 *  while the runner has already freed its slot, so the settle-after tail can hold
 *  ~2× the cap of connections at once (see `createLimiter`). A quarter keeps even
 *  that worst case at ~half the pool, leaving the other half always free for the
 *  millisecond live appends — the whole point of the bound. On the prod pool of 16
 *  that is 4 (≤ ~8 held worst case, ≥ 8 for live); on the default pool of 10 it is
 *  2 (≤ ~4 held, ≥ 6 for live).
 *
 *  `FORTRESS_REINDEX_MAX_CONCURRENCY` overrides with an absolute count (≥ 1) —
 *  set it BELOW `poolMax` (ideally ≤ poolMax/4) or the bound stops protecting the
 *  live path. A value < 1 or non-numeric falls back to the derived default. */
export function reindexMaxConcurrency(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FORTRESS_REINDEX_MAX_CONCURRENCY;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.trunc(n);
  }
  return Math.max(1, Math.floor(poolMax(env) / 4));
}

/** Process-wide singleton limiter for reindexCanonical. Lazy so the env is read
 *  after boot config is in place; memoized so every RPC in the process shares ONE
 *  bound (the bound must match the one shared rw pool). */
let limiter: (<T>(fn: () => Promise<T>) => Promise<T>) | null = null;

/** Run a reindexCanonical rebuild under the shared concurrency cap. */
export function runReindexCapped<T>(fn: () => Promise<T>): Promise<T> {
  if (limiter === null) limiter = createLimiter(reindexMaxConcurrency());
  return limiter(fn);
}

/** Test seam: drop the memoized limiter so the next run re-reads the env. */
export function resetReindexLimiterForTests(): void {
  limiter = null;
}
