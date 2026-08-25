import { describe, expect, test } from "bun:test";

import { handleVaultRpc, type VaultRpcRequest } from "../src/modules/session-vault/store/rpc";
import type { HxDb } from "../src/host/postgres/db";
import type { SessionKey, SessionStore } from "../src/modules/session-vault/store/types";
import { FORTRESS_VERSION, compareStableSemver, parseStableSemver } from "../src/version";

// LETAIR-300 · bytes-free re-index handler. These pin the guards that run BEFORE
// the ingest transaction — the ones that keep a missing/empty/oversized canonical
// from WIPING an indexed lane (a `replace` over empty text deletes the lane's turns
// + tool-calls and inserts nothing). They need no Postgres: every guard returns or
// throws before the handler ever resolves a db handle, so a spy `db` thunk that
// counts its calls is a faithful "did we reach the index write?" probe — it must
// stay 0 on every skip path. The applied/deduped index outcomes are covered by the
// db-gated integration tests.

const KEY: SessionKey = { userId: "u1", family: "claude", sessionId: "s1" };
const ATTR = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};
const CAP = 128 * 1024 * 1024; // maxCanonicalBytes() default (128 MiB)

function makeStore(opts: { stat: number | null; text?: string }): {
  store: SessionStore;
  statKeys: string[];
  readKeys: string[];
} {
  const statKeys: string[] = [];
  const readKeys: string[] = [];
  const store = {
    statCanonical: async (k: SessionKey) => {
      statKeys.push(k.sessionId);
      return opts.stat;
    },
    readCanonicalText: async (k: SessionKey) => {
      readKeys.push(k.sessionId);
      return opts.text ?? "";
    },
  } as unknown as SessionStore;
  return { store, statKeys, readKeys };
}

function reindexReq(over: Partial<Extract<VaultRpcRequest, { method: "reindexCanonical" }>> = {}) {
  return {
    method: "reindexCanonical",
    key: KEY,
    chunkId: "c1",
    replace: true,
    componentCount: 1,
    meta: null,
    attribution: ATTR,
    ...over,
  } as VaultRpcRequest;
}

// A db thunk that counts how many times the handler tried to resolve a handle.
// Returns null (no handle) — but for the skip paths it must never be consulted.
function spyDb(): { db: () => HxDb | null; calls: () => number } {
  let n = 0;
  return { db: () => (n++, null), calls: () => n };
}

describe("reindexCanonical guards (no wipe, correct addressing)", () => {
  test("missing canonical (stat=null) → superseded, never read, never indexed", async () => {
    const { store, statKeys, readKeys } = makeStore({ stat: null });
    const { db, calls } = spyDb();
    const res = await handleVaultRpc(store, reindexReq(), db);
    expect(res).toEqual({
      method: "reindexCanonical",
      value: { outcome: "superseded", coveredEnd: 0 },
    });
    expect(statKeys).toEqual(["s1"]); // parent object addressed
    expect(readKeys).toEqual([]); // a missing object read would THROW — must not read
    expect(calls()).toBe(0); // never reached the ingest phase → no wipe
  });

  test("over-cap canonical → throws typed, gated on the stat BEFORE the read", async () => {
    const { store, statKeys, readKeys } = makeStore({ stat: CAP + 1 });
    const { db, calls } = spyDb();
    await expect(handleVaultRpc(store, reindexReq(), db)).rejects.toThrow(
      "canonical_too_large_to_reindex",
    );
    expect(statKeys).toEqual(["s1"]);
    expect(readKeys).toEqual([]); // cap-gate must precede the uncapped whole-object read
    expect(calls()).toBe(0);
  });

  test("exactly-at-cap canonical is NOT over-cap (boundary is strict >)", async () => {
    // stat === cap must be allowed through to the read (then treated as empty here,
    // so it stops at the emptiness guard without a db — proves the cap boundary only).
    const { store, readKeys } = makeStore({ stat: CAP, text: "" });
    const { db, calls } = spyDb();
    const res = await handleVaultRpc(store, reindexReq(), db);
    expect(res).toEqual({
      method: "reindexCanonical",
      value: { outcome: "superseded", coveredEnd: 0 },
    });
    expect(readKeys).toEqual(["s1"]); // it read (not rejected by the cap)
    expect(calls()).toBe(0);
  });

  test("empty/whitespace canonical → superseded, read but NOT indexed (no wipe)", async () => {
    const { store, readKeys } = makeStore({ stat: 10, text: "  \n\t  " });
    const { db, calls } = spyDb();
    const res = await handleVaultRpc(store, reindexReq(), db);
    expect(res).toEqual({
      method: "reindexCanonical",
      value: { outcome: "superseded", coveredEnd: 0 },
    });
    expect(readKeys).toEqual(["s1"]); // it DID read
    expect(calls()).toBe(0); // but did NOT reach the ingest write → the lane is untouched
  });

  test("non-empty canonical that PARSES to zero events → superseded, NOT indexed (no wipe)", async () => {
    // Corrupt/truncated JSONL: non-empty (passes the trim guard) but parseChunk
    // yields eventCount 0 — a replace over it would DELETE the lane's turns and
    // insert nothing. The parse-empty guard must supersede before the ingest write.
    const { store, readKeys } = makeStore({ stat: 42, text: "not valid json — a truncated line\n" });
    const { db, calls } = spyDb();
    const res = await handleVaultRpc(store, reindexReq(), db);
    expect(res).toEqual({
      method: "reindexCanonical",
      value: { outcome: "superseded", coveredEnd: 0 },
    });
    expect(readKeys).toEqual(["s1"]); // it read the (non-empty) text
    expect(calls()).toBe(0); // but did NOT reach the ingest write → no wipe
  });

  test("agent re-index reads the LANE object <sessionId>:a:<agentId>, not the parent", async () => {
    const { store, statKeys } = makeStore({ stat: null }); // stop early after addressing
    const { db } = spyDb();
    await handleVaultRpc(store, reindexReq({ agentId: "agentX" }), db);
    expect(statKeys).toEqual(["s1:a:agentX"]); // the lane's own canonical
  });

  test("empty agentId falls back to the parent object", async () => {
    const { store, statKeys } = makeStore({ stat: null });
    const { db } = spyDb();
    await handleVaultRpc(store, reindexReq({ agentId: "" }), db);
    expect(statKeys).toEqual(["s1"]); // treated as the parent, not "s1:a:"
  });
});

describe("reindexCanonical version floor", () => {
  test("FORTRESS_VERSION is at/above 0.34.0, where reindexCanonical ships", () => {
    // The workbench gates bytes-free re-index on the advertised fortress version
    // >= MIN_FORTRESS_REINDEX_VERSION (0.34.0). If this binary served
    // reindexCanonical but advertised a LOWER version, the gate would fail-closed
    // for every org and the whole LETAIR-300 fix would ship INERT (the workbench
    // would keep sending the oversized inline frame). This pins the floor so the
    // version can never regress below the RPC it now serves.
    const v = parseStableSemver(FORTRESS_VERSION);
    expect(v).not.toBeNull();
    expect(
      compareStableSemver(v!, { major: 0, minor: 34, patch: 0, raw: "0.34.0" }),
    ).toBeGreaterThanOrEqual(0);
  });
});
