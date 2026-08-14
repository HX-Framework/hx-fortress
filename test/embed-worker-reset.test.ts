import { describe, expect, test } from "bun:test";

import { createEmbedWorker } from "../src/modules/embed-worker";
import type { Embedder } from "../src/modules/embed-worker";

// The worker's pool handle is closure-private; its lifecycle is observed
// through the dsn() resolver call count (ensureSql resolves the DSN only when
// it has no handle) and through runOnce against an unreachable DSN.

const noopEmbedder: Embedder = {
  async embed() {
    return [];
  },
} as unknown as Embedder;

const BAD_DSN = "postgresql://hx:hx@127.0.0.1:1/never"; // nothing listens on :1

function makeWorker(overrides: Record<string, unknown> = {}) {
  const dsnCalls: number[] = [];
  const worker = createEmbedWorker({
    dsn: () => {
      dsnCalls.push(Date.now());
      return BAD_DSN;
    },
    embedder: noopEmbedder,
    dbMax: 2,
    ...overrides,
  });
  return { worker, dsnCalls };
}

describe("embed worker self-heal", () => {
  test("resetDb nulls the handle WITHOUT closing: the next pass re-resolves the DSN and rebuilds", async () => {
    const { worker, dsnCalls } = makeWorker();
    await worker.runOnce().catch(() => {});
    const afterFirst = dsnCalls.length;
    expect(afterFirst).toBe(1);
    await worker.runOnce().catch(() => {});
    expect(dsnCalls.length).toBe(1); // handle memoized — no re-resolve
    worker.resetDb();
    await worker.runOnce().catch(() => {});
    expect(dsnCalls.length).toBe(2); // rebuilt from the live DSN
    await worker.stop();
  });

  test("dsn-null retry NEVER goes dormant: after the boot burst it clamps to the dormant cadence", async () => {
    let resolves = 0;
    const worker = createEmbedWorker({
      dsn: () => {
        resolves += 1;
        return null; // external provider still re-probing — hours, potentially
      },
      embedder: noopEmbedder,
      debounceMs: 1, // the boot kick fires immediately instead of at the 5 s default
      dsnRetryMs: 5,
      dsnRetryLimit: 3,
      dormantRetryMs: 10,
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 120));
    // The 0.16.1 behavior stopped at dsnRetryLimit (+1 for the boot tick);
    // the clamp keeps ticking at dormantRetryMs forever.
    expect(resolves).toBeGreaterThan(3 + 1 + 2);
    await worker.stop();
  });
});
