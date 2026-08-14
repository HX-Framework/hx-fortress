import { describe, expect, test } from "bun:test";

import { createGuarantor } from "../src/ingest/guarantor";
import type { HxDb } from "../src/host/postgres/db";
import type { SessionStore } from "../src/modules/session-vault/store/types";

// The scheduler is exercised through reconcileOrphans' store enumeration seam:
// a store whose listing hangs models an in-flight pass; counting listing calls
// counts passes. Timings are tiny (ms) — the latch semantics are timing-shaped.

function passCounter(): { store: () => SessionStore; passes: () => number; release: () => void } {
  let count = 0;
  let releases: (() => void)[] = [];
  const store = {
    listAllCanonicalKeys: async () => {
      count += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return [];
    },
  } as unknown as SessionStore;
  return {
    store: () => store,
    passes: () => count,
    release: () => {
      const rs = releases;
      releases = [];
      for (const r of rs) r();
    },
  };
}

// The reconciler's bulk gate runs two select().from().innerJoin().where()
// queries before touching the store — stub them to empty result sets.
function stubDb(): HxDb {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => Promise.resolve([]),
  } as unknown as { from: () => unknown };
  return { select: () => chain } as unknown as HxDb;
}
const db = (): HxDb => stubDb();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("guarantor two-variant latch", () => {
  test("urgent while idle schedules at the debounce, IGNORING the cooldown", async () => {
    const pc = passCounter();
    const g = createGuarantor({
      db,
      store: pc.store,
      bootDelayMs: 5,
      intervalMs: 60_000,
      signalDebounceMs: 10,
      signalCooldownMs: 60_000, // a cooldown that would swallow an ordinary signal
    });
    g.start();
    await sleep(15);
    pc.release(); // boot pass completes → cooldown window opens
    await sleep(5);
    expect(pc.passes()).toBe(1);
    g.signalUrgent();
    await sleep(20);
    expect(pc.passes()).toBe(2); // ran at ~debounce despite the 60 s cooldown
    pc.release();
    await g.stop();
  });

  test("ordinary signal inside the cooldown is DEFERRED (max(debounce, cooldown-remaining)) — never dropped", async () => {
    const pc = passCounter();
    const g = createGuarantor({
      db,
      store: pc.store,
      bootDelayMs: 5,
      intervalMs: 60_000,
      signalDebounceMs: 5,
      signalCooldownMs: 60, // remaining ≈ 60 ms at signal time
    });
    g.start();
    await sleep(10);
    pc.release();
    await sleep(5);
    expect(pc.passes()).toBe(1);
    g.signal(); // inside the cooldown — the OLD behavior dropped this entirely
    await sleep(25);
    expect(pc.passes()).toBe(1); // still deferred…
    await sleep(60);
    expect(pc.passes()).toBe(2); // …and consumed once the cooldown elapsed
    pc.release();
    await g.stop();
  });

  test("urgent while IN-FLIGHT latches: the pass's finally schedules the debounce instead of the hourly interval", async () => {
    const pc = passCounter();
    const g = createGuarantor({
      db,
      store: pc.store,
      bootDelayMs: 5,
      intervalMs: 60_000,
      signalDebounceMs: 10,
      signalCooldownMs: 60_000,
    });
    g.start();
    await sleep(10); // boot pass now in flight (listing hung)
    expect(pc.passes()).toBe(1);
    g.signalUrgent(); // arrives mid-pass → latch
    pc.release(); // pass completes; finally must schedule ~debounce, not ~1 h
    await sleep(25);
    expect(pc.passes()).toBe(2);
    pc.release();
    await g.stop();
  });

  test("min-wins arming: a later reschedule never delays an armed SOONER pass", async () => {
    const pc = passCounter();
    const g = createGuarantor({
      db,
      store: pc.store,
      bootDelayMs: 5,
      intervalMs: 60_000,
      signalDebounceMs: 10,
      signalCooldownMs: 100_000,
    });
    g.start();
    await sleep(10);
    pc.release();
    await sleep(5); // idle, cooldown armed
    g.signalUrgent(); // arms a pass at ~10 ms
    g.signal(); // ordinary: max(debounce, cooldown-remaining) ≈ 100 s — must NOT replace the sooner timer
    await sleep(25);
    expect(pc.passes()).toBe(2);
    pc.release();
    await g.stop();
  });
});
