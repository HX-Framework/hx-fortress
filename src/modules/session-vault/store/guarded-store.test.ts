// GuardedStore: the per-call deadline + rebuild-after-breaches decorator born
// from the 2026-07-30 prod wedge (hung GCS pool, silent zero-ingest, twice in
// one day). The rebuild streak is WRITE-scoped: healthy reads must not absolve
// a wedged write path, and stale clients must not charge fresh ones.
import { describe, expect, it } from "bun:test";
import { GuardedStore, StoreDeadlineError, type GuardedStoreOptions } from "./guarded-store.js";
import { BUCKET_CONFIG_UNAVAILABLE } from "./types.js";
import type { SessionStore } from "./types.js";

const KEY = { userId: "u", family: "claude-cli", sessionId: "s" };

/** Stub store: per-method delays; unused methods reject loudly. */
function stubStore(delays: { read?: number; write?: number }, onBuild?: () => void): SessionStore {
  onBuild?.();
  const after = <T,>(ms: number, value: T): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms));
  const never = (): Promise<never> => Promise.reject(new Error("unused in test"));
  return {
    statCanonical: () => after(delays.read ?? 0, 1),
    selfTest: () => after(delays.write ?? 0, undefined) as Promise<void>,
    getBucketVersioning: async () => BUCKET_CONFIG_UNAVAILABLE,
    getLifecycle: async () => BUCKET_CONFIG_UNAVAILABLE,
    listAllCanonicalKeys: () => after(delays.read ?? 0, []),
    appendChunkToCanonical: () => Promise.reject(new Error("backend_says_no")),
    signStagingUpload: never,
    readChunkText: never,
    signCanonicalDownload: never,
    readCanonicalText: never,
    writeCanonicalText: never,
    writeArtifact: never,
    readArtifactText: never,
    listSessionArtifacts: never,
    listSessionMetadata: never,
    deleteSession: never,
  } as SessionStore;
}

const fast = (over: Partial<GuardedStoreOptions> = {}): GuardedStoreOptions => ({
  opTimeoutMs: 20,
  heavyOpTimeoutMs: 40,
  scanTimeoutMs: 80,
  rebuildAfter: 3,
  ...over,
});

describe("GuardedStore", () => {
  it("turns a hung call into a StoreDeadlineError instead of waiting forever", async () => {
    const store = new GuardedStore(() => stubStore({ read: 1_000 }), fast());
    await expect(store.statCanonical(KEY)).rejects.toBeInstanceOf(StoreDeadlineError);
  });

  it("rebuilds after consecutive WRITE breaches, and the rebuilt client serves", async () => {
    let builds = 0;
    const store = new GuardedStore(
      () => stubStore({ write: builds === 0 ? 1_000 : 0 }, () => (builds += 1)),
      fast(),
    );
    for (let i = 0; i < 3; i += 1) {
      await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    }
    expect(builds).toBe(2);
    await store.selfTest(); // rebuilt client is healthy
  });

  it("a WRITE success resets the streak", async () => {
    let builds = 0;
    let writeDelay = 1_000;
    const store = new GuardedStore(() => {
      builds += 1;
      return {
        ...stubStore({}),
        selfTest: () => new Promise<void>((resolve) => setTimeout(resolve, writeDelay)),
      } as SessionStore;
    }, fast());
    await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    writeDelay = 0;
    await store.selfTest(); // streak resets here
    writeDelay = 1_000;
    await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    writeDelay = 0;
    await store.selfTest();
    expect(builds).toBe(1); // never reached 3 consecutive — no rebuild
  });

  it("READ breaches neither count toward nor reset the write streak", async () => {
    let builds = 0;
    const store = new GuardedStore(
      () => stubStore({ read: 1_000, write: 1_000 }, () => (builds += 1)),
      fast(),
    );
    // Five read breaches: never a rebuild.
    for (let i = 0; i < 5; i += 1) {
      await expect(store.statCanonical(KEY)).rejects.toBeInstanceOf(StoreDeadlineError);
    }
    expect(builds).toBe(1);
    // Two write breaches + an interleaved read breach + a third write breach:
    // the read must not have reset the write streak — rebuild fires.
    await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    await expect(store.statCanonical(KEY)).rejects.toBeInstanceOf(StoreDeadlineError);
    await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(builds).toBe(2);
  });

  it("stale-client breaches do not charge the fresh client", async () => {
    let builds = 0;
    const store = new GuardedStore(
      () => stubStore({ write: builds === 0 ? 300 : 0 }, () => (builds += 1)),
      fast({ opTimeoutMs: 30 }),
    );
    // Four concurrent writes on the wedged first client: the first three
    // breaches rebuild once; the fourth is stale and must not count.
    const results = await Promise.allSettled([
      store.selfTest(),
      store.selfTest(),
      store.selfTest(),
      store.selfTest(),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(builds).toBe(2);
    // Two fresh breaches on the new client must NOT trigger a rebuild yet —
    // the stale fourth breach didn't pre-charge the streak.
    let flip = 1_000;
    const wedgy = store as unknown as { inner: SessionStore };
    wedgy.inner = {
      ...stubStore({}),
      selfTest: () => new Promise<void>((resolve) => setTimeout(resolve, flip)),
    } as SessionStore;
    await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(builds).toBe(2);
    flip = 0;
    await store.selfTest();
  });

  it("escalates once per episode when rebuilds prove futile, and recovery resets it", async () => {
    let builds = 0;
    let wedged = 0;
    let healthy = false;
    const store = new GuardedStore(
      () => {
        builds += 1;
        return {
          ...stubStore({}),
          // Reads `healthy` at CALL time, so a rebuild mid-episode stays
          // wedged until the test flips the flag.
          selfTest: () =>
            new Promise<void>((resolve) => {
              if (healthy) resolve();
              else setTimeout(resolve, 1_000);
            }),
        } as SessionStore;
      },
      fast({ rebuildAfter: 2, exhaustAfterRebuilds: 2, onWedgedBeyondRecovery: () => (wedged += 1) }),
    );
    // 2 breaches -> rebuild #1; 2 more -> rebuild #2 -> escalation fires once.
    for (let i = 0; i < 4; i += 1) {
      await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    }
    expect(builds).toBe(3);
    expect(wedged).toBe(1);
    // A STILL-wedged store re-escalates only after two MORE rebuilds (the
    // degraded-mode scream cadence), not on every subsequent rebuild.
    for (let i = 0; i < 3; i += 1) {
      await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    }
    expect(wedged).toBe(1);
    await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(wedged).toBe(2);
    // A counted success starts a fresh episode: the next futile cycle must
    // reach TWO rebuilds again before escalating again.
    healthy = true;
    await store.selfTest();
    healthy = false;
    for (let i = 0; i < 4; i += 1) {
      await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    }
    expect(wedged).toBe(3);
  });

  it("reports whether the write path EVER succeeded, for the restart-futility gate", async () => {
    const seen: boolean[] = [];
    let healthy = false;
    const store = new GuardedStore(
      () =>
        ({
          ...stubStore({}),
          selfTest: () =>
            new Promise<void>((resolve) => {
              if (healthy) resolve();
              else setTimeout(resolve, 1_000);
            }),
        }) as SessionStore,
      fast({
        rebuildAfter: 1,
        exhaustAfterRebuilds: 1,
        onWedgedBeyondRecovery: ({ hadCountedSuccess }) => seen.push(hadCountedSuccess),
      }),
    );
    await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(seen).toEqual([false]); // never worked: restart is known-futile
    healthy = true;
    await store.selfTest();
    healthy = false;
    await expect(store.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(seen).toEqual([false, true]); // worked once: restart can cure pool state
  });

  it("presign successes cannot starve the rebuild streak or arm the futility gate", async () => {
    // The 2026-07-30 daytime shape: every chunk presigns (local crypto,
    // instant) before its write breaches. Presign must neither reset the
    // streak nor count as the write success that legitimizes a restart.
    let builds = 0;
    const seen: boolean[] = [];
    const counting = new GuardedStore(
      () => {
        builds += 1;
        return {
          ...stubStore({ write: 1_000 }),
          signStagingUpload: () =>
            Promise.resolve({ url: "u", objectName: "o", expiresAt: "e" }),
        } as SessionStore;
      },
      fast({
        rebuildAfter: 2,
        exhaustAfterRebuilds: 2,
        onWedgedBeyondRecovery: ({ hadCountedSuccess }) => seen.push(hadCountedSuccess),
      }),
    );
    for (let i = 0; i < 4; i += 1) {
      await counting.signStagingUpload(KEY, "c" + i); // interleaved presigns
      await expect(counting.selfTest()).rejects.toBeInstanceOf(StoreDeadlineError);
    }
    expect(builds).toBe(3); // streak reached rebuild twice despite presigns
    expect(seen).toEqual([false]); // presign success never armed the gate
  });

  it("backend errors pass through unchanged and never count as breaches", async () => {
    let builds = 0;
    const store = new GuardedStore(() => stubStore({}, () => (builds += 1)), fast({ rebuildAfter: 1 }));
    for (let i = 0; i < 3; i += 1) {
      await expect(store.appendChunkToCanonical(KEY, "c1")).rejects.toThrow("backend_says_no");
    }
    expect(builds).toBe(1);
  });

  it("the whole-bucket scan gets its own larger budget", async () => {
    const store = new GuardedStore(() => stubStore({ read: 50 }), fast());
    await expect(store.statCanonical(KEY)).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(await store.listAllCanonicalKeys()).toEqual([]);
  });
});
