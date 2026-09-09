// The reindex concurrency cap is the interim guard that keeps a burst of
// whole-transcript rebuilds from exhausting the live rw pool and starving the
// millisecond appends. Two properties matter: the runner never lets more than the
// cap run at once, and it NEVER leaks a slot when a run throws (the rebuild's
// `racePgPhase` deadline reject is the common throw). The cap size must leave the
// live path room even for the settle-after tail.
import { describe, expect, it } from "bun:test";
import {
  createLimiter,
  reindexMaxConcurrency,
  resetReindexLimiterForTests,
  runReindexCapped,
} from "./reindex-concurrency.js";

/** A promise plus its resolver, so a test can hold a run open and release it. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createLimiter", () => {
  it("never runs more than `max` at once, and drains every queued run", async () => {
    const limiter = createLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;
    let completed = 0;

    const runs = gates.map((gate) =>
      limiter(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        completed += 1;
      }),
    );

    // Let the first batch reach their gates; only `max` may be inside at once.
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(2);

    // Release one at a time; each release admits exactly one queued run.
    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(runs);

    expect(peak).toBe(2); // the cap was actually reached, not just never exceeded
    expect(completed).toBe(5); // nothing dropped
  });

  it("releases the slot when a run throws — a rejecting run does not wedge the cap", async () => {
    const limiter = createLimiter(1);
    await expect(limiter(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    // If the throw leaked the single slot, this second run would hang forever.
    const ran = await limiter(async () => "ok");
    expect(ran).toBe("ok");
  });

  it("treats a non-positive or non-finite max as 1", async () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const limiter = createLimiter(bad);
      const gates = [deferred(), deferred()];
      let active = 0;
      let peak = 0;
      const runs = gates.map((gate) =>
        limiter(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await gate.promise;
          active -= 1;
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(peak).toBe(1);
      gates.forEach((g) => g.resolve());
      await Promise.all(runs);
    }
  });
});

describe("reindexMaxConcurrency", () => {
  it("defaults to a QUARTER of the pool (min 1), so the settle-after tail stays clear of the live half", () => {
    expect(reindexMaxConcurrency({ FORTRESS_DB_POOL_MAX: "16" })).toBe(4); // prod pool
    expect(reindexMaxConcurrency({ FORTRESS_DB_POOL_MAX: "10" })).toBe(2); // default pool
    expect(reindexMaxConcurrency({})).toBe(2); // DEFAULT_POOL_MAX = 10 → 2
    expect(reindexMaxConcurrency({ FORTRESS_DB_POOL_MAX: "4" })).toBe(1);
    expect(reindexMaxConcurrency({ FORTRESS_DB_POOL_MAX: "1" })).toBe(1); // floor(0.25)→min 1
  });

  it("honours an explicit absolute override, and ignores a junk one", () => {
    expect(reindexMaxConcurrency({ FORTRESS_DB_POOL_MAX: "16", FORTRESS_REINDEX_MAX_CONCURRENCY: "3" })).toBe(3);
    expect(reindexMaxConcurrency({ FORTRESS_DB_POOL_MAX: "16", FORTRESS_REINDEX_MAX_CONCURRENCY: "8" })).toBe(8);
    // < 1, non-numeric, or empty ⇒ fall back to the derived default (poolMax/4).
    for (const bad of ["0", "-2", "nope", "", "   "]) {
      expect(
        reindexMaxConcurrency({ FORTRESS_DB_POOL_MAX: "16", FORTRESS_REINDEX_MAX_CONCURRENCY: bad }),
      ).toBe(4);
    }
  });
});

describe("runReindexCapped", () => {
  it("shares one memoized bound across calls, and the test reset re-reads it", async () => {
    resetReindexLimiterForTests();
    // Two quick runs succeed under the shared limiter.
    expect(await runReindexCapped(async () => 1)).toBe(1);
    expect(await runReindexCapped(async () => 2)).toBe(2);
    resetReindexLimiterForTests();
    expect(await runReindexCapped(async () => 3)).toBe(3);
  });
});
