import { describe, expect, test } from "bun:test";

import { createGuarantor, guarantorEnabled } from "../src/ingest/guarantor";
import type { ReconcileOptions, ReconcileResult } from "../src/ingest/reconciler";
import { setReconcileSignalHandler, signalReconcile } from "../src/ingest/reconcile-signal";
import { stripListTitle } from "../src/modules/session-vault/store/session-metadata";
import { parseCanonicalKey } from "../src/modules/session-vault/store/keys";
import type { SessionMetadata } from "../src/modules/session-vault/store/types";

// ── The guarantor kill-switch is INVERTED (default-ON) ──────────────────────
// This is the highest-leverage prerequisite in the plan: parseBooleanEnv is
// false-when-unset, so a plain flag would ship G OFF and the whole self-heal
// would silently no-op. FORTRESS_GUARANTOR_DISABLED must mean "unset ⇒ run".
describe("guarantorEnabled (inverted default-ON kill-switch)", () => {
  test("runs when the disable flag is unset / blank / falsey", () => {
    expect(guarantorEnabled({})).toBe(true);
    expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: "" })).toBe(true);
    expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: "0" })).toBe(true);
    expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: "false" })).toBe(true);
    expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: "no" })).toBe(true);
    expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: "junk" })).toBe(true);
  });

  test("is disabled only by an explicit truthy spelling", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
      expect(guarantorEnabled({ FORTRESS_GUARANTOR_DISABLED: v })).toBe(false);
    }
  });
});

describe("guarantor lifecycle guards", () => {
  test("runOnce no-ops (null) until db + store are both ready", async () => {
    expect(await createGuarantor({ db: () => null, store: () => null }).runOnce()).toBeNull();
    // store present but db still null ⇒ still not ready.
    const fakeStore = { listAllCanonicalKeys: async () => [] } as never;
    expect(await createGuarantor({ db: () => null, store: () => fakeStore }).runOnce()).toBeNull();
  });

  test("signal() and stop() never throw, before or after start", async () => {
    const g = createGuarantor({ db: () => null, store: () => null });
    expect(() => g.signal()).not.toThrow();
    g.start();
    expect(() => g.signal()).not.toThrow();
    await g.stop();
    // Signalling a stopped guarantor is a no-op, not an error.
    expect(() => g.signal()).not.toThrow();
  });
});

// ── The known-failure → guarantor nudge seam ────────────────────────────────
describe("signalReconcile", () => {
  test("fires the wired handler", () => {
    let n = 0;
    setReconcileSignalHandler(() => {
      n += 1;
    });
    signalReconcile();
    signalReconcile();
    expect(n).toBe(2);
    setReconcileSignalHandler(() => {});
  });

  test("swallows a throwing handler (never fails the upload path)", () => {
    setReconcileSignalHandler(() => {
      throw new Error("boom");
    });
    expect(() => signalReconcile()).not.toThrow();
    setReconcileSignalHandler(() => {});
  });

  test("default handler is a silent no-op", () => {
    setReconcileSignalHandler(() => {});
    expect(() => signalReconcile()).not.toThrow();
  });
});

// ── parseCanonicalKey — the whole-bucket orphan scan's object→key inverse ────
describe("parseCanonicalKey", () => {
  test("parses a parent canonical", () => {
    expect(parseCanonicalKey("u1/claude-cli/s1/log.jsonl")).toEqual({
      userId: "u1",
      family: "claude-cli",
      sessionId: "s1",
    });
  });

  test("keeps the agent-lane composite as one segment", () => {
    expect(parseCanonicalKey("u1/claude-cli/s1:a:agent-7/log.jsonl")).toEqual({
      userId: "u1",
      family: "claude-cli",
      sessionId: "s1:a:agent-7",
    });
  });

  test("rejects staging / artifact / compaction / short objects", () => {
    expect(parseCanonicalKey("u1/claude-cli/s1/.staging/c1.jsonl")).toBeNull();
    expect(parseCanonicalKey("u1/claude-cli/s1/session.json")).toBeNull();
    expect(parseCanonicalKey("u1/claude-cli/s1/.compact-123.jsonl")).toBeNull();
    // A chunk literally named "log" would still be one segment too deep.
    expect(parseCanonicalKey("u1/claude-cli/s1/.staging/log.jsonl")).toBeNull();
    expect(parseCanonicalKey("u1/claude-cli/log.jsonl")).toBeNull();
    expect(parseCanonicalKey("log.jsonl")).toBeNull();
    expect(parseCanonicalKey("u1/claude-cli/s1/log.txt")).toBeNull();
  });
});

// ── stripListTitle — PG-authoritative list title, content-only artifact ──────
describe("stripListTitle", () => {
  const base: SessionMetadata = {
    family: "claude-cli",
    sessionId: "s1",
    title: "A stale artifact title",
    titleSource: "user",
    bytesUploaded: 10,
    eventCount: 3,
    userTextCount: 1,
    assistantCount: 1,
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    cwd: "/work",
    gitBranch: "main",
    sourcePath: "/tmp/s.jsonl",
    repoSlug: "let-ai/let-forge",
    deviceName: "Mac",
  };

  test("nulls title + titleSource, preserves every other field", () => {
    const [out] = stripListTitle([base]);
    expect(out.title).toBeNull();
    expect(out.titleSource).toBeNull();
    expect({ ...out, title: base.title, titleSource: base.titleSource }).toEqual(base);
  });

  test("leaves an already-titleless row untouched (same reference)", () => {
    const titleless: SessionMetadata = { ...base, title: null, titleSource: null };
    const [out] = stripListTitle([titleless]);
    expect(out).toBe(titleless);
  });
});

// ── The scheduler ↔ options link — every pass must carry the sweep options ───
// healthSignals and repairDuplicates each shipped wired into runOnce — which
// nothing in production calls — while start()'s tick loop kept an older
// hand-built options object, so both were unreachable dead code in the service.
// These tests observe the ACTUAL calls the scheduler makes through the
// reconcileImpl seam, so an option that exists only on a dead path can no
// longer look finished.
describe("guarantor pass options", () => {
  const fakeDb = {} as never;
  const fakeStore = { listAllCanonicalKeys: async () => [] } as never;

  /** Minimal result carrying only the fields the scheduler itself reads. */
  const passResult = (over: Partial<ReconcileResult> = {}): ReconcileResult =>
    ({ yieldedToLive: 0, scanned: 0, duplicatedSessions: null, ...over }) as ReconcileResult;

  const capture = () => {
    const calls: ReconcileOptions[] = [];
    const impl = (async (_db: unknown, _store: unknown, opts?: ReconcileOptions) => {
      calls.push(opts ?? {});
      // Mimic the real pass: the duplicate scan reports exactly when requested.
      return passResult({ duplicatedSessions: opts?.repairDuplicates ? 0 : null });
    }) as never;
    return { calls, impl };
  };

  test("the tick loop runs boot-grade first, then full sweep-grade passes", async () => {
    const { calls, impl } = capture();
    const g = createGuarantor({
      db: () => fakeDb,
      store: () => fakeStore,
      bootDelayMs: 5,
      intervalMs: 25,
      reconcileImpl: impl,
    });
    g.start();
    const deadline = Date.now() + 5_000;
    while (calls.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await g.stop();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // Boot drain: on the startup path, so no sweep-grade work.
    expect(calls[0]!.healthSignals).toBeFalsy();
    expect(calls[0]!.repairDuplicates).toBeFalsy();
    // First sweep: health signals on, duplicate scan due.
    expect(calls[1]!.healthSignals).toBe(true);
    expect(calls[1]!.repairDuplicates).toBe(true);
    // Next sweep: health signals STILL on, the scan not due again yet.
    expect(calls[2]!.healthSignals).toBe(true);
    expect(calls[2]!.repairDuplicates).toBe(false);
  });

  test("the duplicate scan re-arms after DUPLICATE_SCAN_EVERY sweeps", async () => {
    const { calls, impl } = capture();
    const g = createGuarantor({ db: () => fakeDb, store: () => fakeStore, reconcileImpl: impl });
    for (let i = 0; i < 52; i += 1) await g.runOnce();
    const at = calls.flatMap((c, i) => (c.repairDuplicates === true ? [i] : []));
    // Due on the first sweep of the process, then on a steady daily-ish cadence.
    expect(at[0]).toBe(0);
    expect(at.length).toBeGreaterThanOrEqual(3);
    expect(at[1]! - at[0]!).toBe(at[2]! - at[1]!);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(24);
  });

  test("a stood-down scan slot stays due instead of being spent", async () => {
    const calls: ReconcileOptions[] = [];
    let standDown = true;
    const impl = (async (_db: unknown, _store: unknown, opts?: ReconcileOptions) => {
      calls.push(opts ?? {});
      if (standDown) return passResult({ yieldedToLive: 1, duplicatedSessions: null });
      return passResult({ duplicatedSessions: opts?.repairDuplicates ? 0 : null });
    }) as never;
    const g = createGuarantor({ db: () => fakeDb, store: () => fakeStore, reconcileImpl: impl });
    await g.runOnce(); // requested, but the pass stood down before the scan ran
    standDown = false;
    await g.runOnce(); // must be requested AGAIN — the slot was never used
    await g.runOnce(); // ran last sweep ⇒ not due now
    expect(calls[0]!.repairDuplicates).toBe(true);
    expect(calls[1]!.repairDuplicates).toBe(true);
    expect(calls[2]!.repairDuplicates).toBe(false);
  });
});
