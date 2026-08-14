import { describe, expect, test } from "bun:test";

import { createGuardedDb, type ProbeClient } from "../src/host/postgres/guarded-db";
import { signalPoolExhausted } from "../src/host/postgres/pool-signal";
import type { HxDb, HxPoolOptions } from "../src/host/postgres/db";

/** A controllable probe-client factory: each tick's verdict comes off the
 *  scripted queue ("ok" | "fail" | "hang"); hung queries settle when the client
 *  is closed (mirroring close({timeout}) force-rejecting in-flight queries),
 *  while hung CLOSES never settle (the black-holed-socket case). */
function makeHarness(script: () => "ok" | "fail" | "hang") {
  const probeOptions: HxPoolOptions[] = [];
  let openCloses = 0;
  const makeProbeClient = (_dsn: string, options: HxPoolOptions): ProbeClient => {
    probeOptions.push(options);
    const verdict = script();
    let rejectQuery: ((err: Error) => void) | null = null;
    return {
      selectOne: () =>
        new Promise<void>((resolve, reject) => {
          if (verdict === "ok") resolve();
          else if (verdict === "fail") reject(new Error("connection refused"));
          else rejectQuery = reject;
        }),
      close: () => {
        rejectQuery?.(Object.assign(new Error("Connection closed"), {
          code: "ERR_POSTGRES_CONNECTION_CLOSED",
        }));
        if (verdict === "hang") {
          openCloses += 1;
          return new Promise<void>(() => {}); // close's own promise hangs
        }
        return Promise.resolve();
      },
    };
  };
  let generation = 0;
  const makeDb = (): HxDb => ({ generation: ++generation } as unknown as HxDb);
  return { makeProbeClient, makeDb, probeOptions, openCloses: () => openCloses };
}

function harnessDeps(h: ReturnType<typeof makeHarness>, extra: Record<string, unknown> = {}) {
  const wedges: { hadCountedSuccess: boolean }[] = [];
  const rebuilds: number[] = [];
  const recoveries: number[] = [];
  const deps = {
    dsn: () => "postgresql://db.internal/hx",
    probeIntervalMs: 0, // ticks driven manually via probeNow()
    probeTimeoutMs: 20,
    makeDb: h.makeDb,
    makeProbeClient: h.makeProbeClient,
    onWedged: (info: { hadCountedSuccess: boolean }) => wedges.push(info),
    onRebuild: () => rebuilds.push(Date.now()),
    onRecovered: () => recoveries.push(Date.now()),
    ...extra,
  };
  return { deps, wedges, rebuilds, recoveries };
}

describe("guarded-db", () => {
  test("resolvers memoize per generation; probe success keeps them stable", async () => {
    const h = makeHarness(() => "ok");
    const { deps } = harnessDeps(h);
    const g = createGuardedDb(deps);
    const first = g.db();
    expect(first).not.toBeNull();
    expect(g.db()).toBe(first!);
    expect(g.dbRead()).not.toBe(first!); // separate RO pool
    expect(await g.probeNow()).toBe(true);
    expect(g.db()).toBe(first!);
  });

  test("probe no-ops (no accounting) while the DSN is null — pre-ready detection is the provider's job", async () => {
    const h = makeHarness(() => "fail");
    const { deps, rebuilds } = harnessDeps(h, { dsn: () => null });
    const g = createGuardedDb(deps);
    expect(await g.probeNow()).toBeNull();
    expect(await g.probeNow()).toBeNull();
    expect(rebuilds.length).toBe(0);
    expect(g.db()).toBeNull();
  });

  test("a HUNG probe query still settles the race (breach) — probing never wedges on the incident it detects", async () => {
    const h = makeHarness(() => "hang");
    const { deps } = harnessDeps(h);
    const g = createGuardedDb(deps);
    expect(await g.probeNow()).toBe(false);
  });

  test("3 consecutive breaches → rebuild swaps BOTH resolvers; a success in between resets the streak", async () => {
    const script: ("ok" | "fail")[] = ["fail", "fail", "ok", "fail", "fail", "fail"];
    const h = makeHarness(() => script.shift() ?? "ok");
    const { deps, rebuilds } = harnessDeps(h);
    const g = createGuardedDb(deps);
    const rw0 = g.db();
    const ro0 = g.dbRead();
    await g.probeNow();
    await g.probeNow();
    await g.probeNow(); // success — resets the streak
    expect(rebuilds.length).toBe(0);
    await g.probeNow();
    await g.probeNow();
    await g.probeNow(); // third consecutive breach → rebuild
    expect(rebuilds.length).toBe(1);
    expect(g.db()).not.toBe(rw0!);
    expect(g.dbRead()).not.toBe(ro0!);
  });

  test("probe client MIRRORS the pools' startup params — the param-carrying canary", async () => {
    const h = makeHarness(() => "ok");
    const { deps } = harnessDeps(h, { env: { FORTRESS_DB_STATEMENT_TIMEOUT_MS: "5000" } });
    const g = createGuardedDb(deps);
    await g.probeNow();
    // The canary mirrors the LIVE WRITE pool, lock_timeout included — a pooler
    // that rejects one startup param rejects both, and the probe must fail the
    // way the pool fails.
    expect(h.probeOptions[0]?.connection).toEqual({
      statement_timeout: 5000,
      lock_timeout: 5000,
    });
    // …and the =0 hatch strips it here too.
    const h2 = makeHarness(() => "ok");
    const { deps: deps2 } = harnessDeps(h2, { env: { FORTRESS_DB_STATEMENT_TIMEOUT_MS: "0" } });
    const g2 = createGuardedDb(deps2);
    await g2.probeNow();
    expect(h2.probeOptions[0]?.connection).toBeUndefined();
  });

  test("2 futile rebuilds → escalation ONCE per episode; futility counts ONLY guarded-db probe successes", async () => {
    const h = makeHarness(() => "fail");
    const { deps, wedges, rebuilds } = harnessDeps(h);
    const g = createGuardedDb(deps);
    for (let i = 0; i < 9; i += 1) await g.probeNow();
    expect(rebuilds.length).toBeGreaterThanOrEqual(2);
    expect(wedges).toEqual([{ hadCountedSuccess: false }]); // never answered since boot
  });

  test("escalation reports hadCountedSuccess=true when the DB answered before the outage", async () => {
    const script: ("ok" | "fail")[] = ["ok", ...Array<"fail">(9).fill("fail")];
    const h = makeHarness(() => script.shift() ?? "fail");
    const { deps, wedges } = harnessDeps(h);
    const g = createGuardedDb(deps);
    for (let i = 0; i < 10; i += 1) await g.probeNow();
    expect(wedges).toEqual([{ hadCountedSuccess: true }]);
  });

  test("first probe success after ANY rebuild fires onRecovered exactly once (urgent guarantor feed)", async () => {
    const script: ("ok" | "fail")[] = ["fail", "fail", "fail", "ok", "ok"];
    const h = makeHarness(() => script.shift() ?? "ok");
    const { deps, rebuilds, recoveries } = harnessDeps(h);
    const g = createGuardedDb(deps);
    await g.probeNow();
    await g.probeNow();
    await g.probeNow(); // → rebuild
    expect(rebuilds.length).toBe(1);
    expect(recoveries.length).toBe(0);
    await g.probeNow(); // recovery
    expect(recoveries.length).toBe(1);
    await g.probeNow(); // stable — no repeat signal
    expect(recoveries.length).toBe(1);
  });

  test("hung closes never pause probing (decoupled teardown accounting)", async () => {
    const h = makeHarness(() => "hang");
    const { deps } = harnessDeps(h);
    const g = createGuardedDb(deps);
    for (let i = 0; i < 12; i += 1) {
      expect(await g.probeNow()).toBe(false); // every tick still probes
    }
    expect(h.openCloses()).toBe(12); // bounded residual, OS-reaped in prod
  });

  test("process stays alive when probe failures reject late (rejection observers per R1)", async () => {
    const h = makeHarness(() => "hang");
    const { deps } = harnessDeps(h);
    const g = createGuardedDb(deps);
    await g.probeNow();
    await new Promise((r) => setTimeout(r, 30));
    // Reaching this line at all IS the assertion — Bun exits(1) on any
    // unhandled rejection, which would abort the whole test run.
    expect(true).toBe(true);
  });
});


describe("pool saturation — the failure mode the probe structurally cannot see", () => {
  test("background pool is a SEPARATE handle from the live write pool", () => {
    const h = makeHarness(() => "ok");
    const { deps } = harnessDeps(h);
    const g = createGuardedDb(deps);
    const rw = g.db();
    const ro = g.dbRead();
    const bg = g.dbBackground();
    expect(rw).not.toBe(bg);
    expect(ro).not.toBe(bg);
    // …and each memoizes independently.
    expect(g.dbBackground()).toBe(bg);
    expect(g.db()).toBe(rw);
  });

  test("sustained starvation rebuilds the pools EVEN WHILE THE PROBE SUCCEEDS", async () => {
    // This is the 2026-08-05 shape exactly: the canary holds its own connection,
    // so it answers instantly while every real query times out in the queue.
    const h = makeHarness(() => "ok");
    const { deps, rebuilds } = harnessDeps(h, {
      saturationPerTickThreshold: 3,
      saturationBreachThreshold: 2,
    });
    const g = createGuardedDb(deps);
    g.start();
    try {
      for (let i = 0; i < 3; i += 1) signalPoolExhausted();
      expect(await g.probeNow()).toBe(true); // probe is HEALTHY
      expect(rebuilds.length).toBe(0); // one bad tick is a burst
      expect(g.saturated()).toBe(true); // …but it is already visible

      for (let i = 0; i < 3; i += 1) signalPoolExhausted();
      expect(await g.probeNow()).toBe(true);
      expect(rebuilds.length).toBe(1); // second consecutive tick → release
    } finally {
      await g.stop();
    }
  });

  test("a burst under the threshold never rebuilds, and clears the streak", async () => {
    const h = makeHarness(() => "ok");
    const { deps, rebuilds } = harnessDeps(h, {
      saturationPerTickThreshold: 3,
      saturationBreachThreshold: 2,
    });
    const g = createGuardedDb(deps);
    g.start();
    try {
      for (let i = 0; i < 3; i += 1) signalPoolExhausted();
      await g.probeNow();
      expect(g.saturated()).toBe(true);

      signalPoolExhausted(); // below threshold — a quiet tick
      await g.probeNow();
      expect(g.saturated()).toBe(false);
      expect(rebuilds.length).toBe(0);

      for (let i = 0; i < 3; i += 1) signalPoolExhausted();
      await g.probeNow();
      expect(rebuilds.length).toBe(0); // streak restarted, not resumed
    } finally {
      await g.stop();
    }
  });

  test("stop() unwires the feed — a late emit cannot touch a stopped healer", async () => {
    const h = makeHarness(() => "ok");
    const { deps } = harnessDeps(h, { saturationPerTickThreshold: 1 });
    const g = createGuardedDb(deps);
    g.start();
    await g.stop();
    signalPoolExhausted(); // must not throw, must not count
    await g.probeNow();
    expect(g.saturated()).toBe(false);
  });
});
