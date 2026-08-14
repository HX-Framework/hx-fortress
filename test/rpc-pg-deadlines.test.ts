import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { handleVaultRpc } from "../src/modules/session-vault/store/rpc";
import type { SessionStore } from "../src/modules/session-vault/store/types";
import type { HxDb } from "../src/host/postgres/db";
import type { IngestAttribution } from "../src/ingest/ingest";

// The PG-phase races run at 25 s in prod (under the cloud's 30 s abandon) —
// the hidden per-call override shrinks them for tests.
beforeEach(() => {
  process.env.FORTRESS_DB_RPC_DEADLINE_MS = "60";
});
afterEach(() => {
  delete process.env.FORTRESS_DB_RPC_DEADLINE_MS;
});

const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

const KEY = { userId: "u1", family: "claude-cli", sessionId: "s1" };

function ingestReq(overrides: Record<string, unknown> = {}) {
  return {
    method: "ingestCommit" as const,
    key: KEY,
    chunkId: "c1",
    replace: false,
    chunkText: "",
    totalBytes: 0,
    componentCount: 0,
    meta: null,
    attribution: ATTR,
    ...overrides,
  };
}

/** A fake HxDb whose transaction/select behavior is scripted per call. The
 *  ingest/delete helpers drive everything through db.transaction (and two
 *  drizzle select chains in purgeSessionPg), so a small stub suffices. */
function fakeDb(behavior: () => Promise<void>): HxDb {
  return {
    transaction: async () => {
      await behavior();
      // A resolved txn presents as a dedupe-style no-op commit (null) — the
      // real helpers' post-commit phases all skip on it, so the fake never has
      // to model drizzle's full chain surface.
      return null;
    },
    select: () => selectChain([]),
  } as unknown as HxDb;
}

function selectChain(rows: unknown[]): unknown {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
    orderBy: () => chain,
  };
  return chain;
}

const noopStore = {} as SessionStore;

function killError(code: string): Error {
  return Object.assign(new Error(`kill ${code}`), { code });
}

function statementTimeout(): Error {
  return Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "57014",
  });
}

describe("PG-phase deadlines (typed, snake_case — no literal RPC method names)", () => {
  test("a HUNG chunked ingest yields db_unavailable:ingest_commit at the deadline (never a silent hang)", async () => {
    const db = fakeDb(() => new Promise<never>(() => {}));
    await expect(
      handleVaultRpc(noopStore, ingestReq(), () => db),
    ).rejects.toThrow("db_unavailable:ingest_commit");
  });

  test("a HUNG agent ingest yields db_unavailable:agent_commit", async () => {
    const db = fakeDb(() => new Promise<never>(() => {}));
    await expect(
      handleVaultRpc(noopStore, { ...ingestReq(), method: "ingestAgentCommit", agentId: "a1" }, () => db),
    ).rejects.toThrow("db_unavailable:agent_commit");
  });

  test("a HUNG listSessions yields db_unavailable:list_sessions — which must NOT match the cloud's /unknown_vault_method|listSessions/ fallback", async () => {
    // A black-hole handle: every property/call returns itself; awaiting it
    // never settles — shape-proof against the query builder's exact chain.
    const hole: unknown = new Proxy(function () {} as unknown as object, {
      get: (_t, prop) => (prop === "then" ? () => {} : hole),
      apply: () => hole,
    });
    const db = hole as HxDb;
    const message = await handleVaultRpc(noopStore, { method: "listSessions", userId: "u1" }, () => db).then(
      () => "resolved",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(message).toBe("db_unavailable:list_sessions");
    // The cross-repo contract this string exists for: propagation ⇒ the cloud
    // shows the org OFFLINE; matching the fallback regex would silently serve
    // a title-stripped blob list (the MC-2606 symptom).
    expect(/unknown_vault_method|listSessions/.test(message)).toBe(false);
  });

  test("the deadline loser's late failure is LOG-then-swallowed (57014 stays observable, process stays alive)", async () => {
    let rejectLate: ((err: Error) => void) | null = null;
    const db = fakeDb(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectLate = reject as (err: Error) => void;
        }),
    );
    const warns: Record<string, unknown>[] = [];
    const logger = { warn: (_m: string, meta?: Record<string, unknown>) => warns.push(meta ?? {}) };
    await expect(handleVaultRpc(noopStore, ingestReq(), () => db, undefined, null, logger)).rejects.toThrow(
      "db_unavailable:ingest_commit",
    );
    rejectLate!(statementTimeout());
    await new Promise((r) => setTimeout(r, 10));
    expect(warns.some((w) => w.sqlState === "57014")).toBe(true);
  });
});

describe("transient-class retry at the RPC sites", () => {
  test("a kill-class first attempt re-resolves and succeeds (chunked ingest)", async () => {
    let calls = 0;
    const db = fakeDb(async () => {
      calls += 1;
      if (calls === 1) throw killError("ERR_POSTGRES_CONNECTION_CLOSED");
      // Second attempt: the txn resolves (a dedupe-style no-op commit).
    });
    const res = await handleVaultRpc(noopStore, ingestReq(), () => db);
    expect(res).toEqual({ method: "ingestCommit", value: { ok: true } });
    expect(calls).toBe(2);
  });

  test("a mid-RPC resolver null on the retry fails TYPED (chunked)", async () => {
    let resolves = 0;
    const dying = fakeDb(async () => {
      throw killError("ERR_POSTGRES_LIFETIME_TIMEOUT");
    });
    const resolver = (): HxDb | null => {
      resolves += 1;
      return resolves <= 2 ? dying : null; // null by the retry's re-resolve
    };
    await expect(handleVaultRpc(noopStore, ingestReq(), resolver)).rejects.toThrow(
      "db_unavailable:ingest_commit",
    );
  });
});

describe("the writeCanonical durability contract", () => {
  function canonicalStore(): { store: SessionStore; writes: string[] } {
    const writes: string[] = [];
    const store = {
      writeCanonicalText: async (_key: unknown, text: string) => {
        writes.push(text);
      },
    } as unknown as SessionStore;
    return { store, writes };
  }

  test("indexing failure after the canonical persisted still ACKS ok (+ warns sanitized)", async () => {
    const { store, writes } = canonicalStore();
    const db = fakeDb(async () => {
      throw Object.assign(new Error("Failed query: insert…\nparams: SECRET_TRANSCRIPT"), {
        query: "insert…",
        params: ["SECRET_TRANSCRIPT"],
        cause: statementTimeout(),
      });
    });
    const warns: Record<string, unknown>[] = [];
    const logger = { warn: (_m: string, meta?: Record<string, unknown>) => warns.push(meta ?? {}) };
    const res = await handleVaultRpc(
      noopStore && store,
      ingestReq({ writeCanonical: true, chunkText: "whole transcript" }),
      () => db,
      undefined,
      null,
      logger,
    );
    expect(res).toEqual({ method: "ingestCommit", value: { ok: true } });
    expect(writes).toEqual(["whole transcript"]);
    const logged = JSON.stringify(warns);
    expect(logged).toContain("57014");
    expect(logged).not.toContain("SECRET_TRANSCRIPT");
  });

  test("a DEADLINE loss after the canonical persisted still ACKS ok", async () => {
    const { store, writes } = canonicalStore();
    const db = fakeDb(() => new Promise<never>(() => {}));
    const res = await handleVaultRpc(
      store,
      ingestReq({ writeCanonical: true, chunkText: "t" }),
      () => db,
    );
    expect(res).toEqual({ method: "ingestCommit", value: { ok: true } });
    expect(writes.length).toBe(1);
  });

  test("resolver null at entry: canonical persists, ack + skip-index warn (unchanged contract)", async () => {
    const { store, writes } = canonicalStore();
    const res = await handleVaultRpc(store, ingestReq({ writeCanonical: true, chunkText: "t" }), () => null);
    expect(res).toEqual({ method: "ingestCommit", value: { ok: true } });
    expect(writes.length).toBe(1);
  });
});

describe("deleteSession park mapping (the cloud PARKS on postgres_not_ready — never dead_letter burns)", () => {
  const delStore = {
    deleteSession: async () => ({ complete: true, deleted: 0 }),
  } as unknown as SessionStore;

  test("kill-class after the one retry maps to postgres_not_ready", async () => {
    const db = fakeDb(async () => {
      throw killError("ERR_POSTGRES_CONNECTION_CLOSED");
    });
    let message = "";
    try {
      await handleVaultRpc(delStore, { method: "deleteSession", key: KEY }, () => db);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe("postgres_not_ready");
  });

  test("a 57014 maps to postgres_not_ready:statement_timeout (substring-parks, truthful label)", async () => {
    const db = fakeDb(async () => {
      throw statementTimeout();
    });
    let message = "";
    try {
      await handleVaultRpc(delStore, { method: "deleteSession", key: KEY }, () => db);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe("postgres_not_ready:statement_timeout");
    // The cloud's park regex is unanchored — the suffix must substring-match.
    expect(/vault_offline|vault_rpc_timeout|postgres_not_ready|not.?connected/i.test(message)).toBe(true);
  });

  test("genuine SQL failures propagate RAW → dead_letter (operator eyes) — the mapping is narrow", async () => {
    const db = fakeDb(async () => {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "23505",
      });
    });
    await expect(
      handleVaultRpc(delStore, { method: "deleteSession", key: KEY }, () => db),
    ).rejects.toThrow("duplicate key");
  });

  test("purgeDsn wired but null ⇒ postgres_not_ready (parks)", async () => {
    // markSessionDeleted succeeds on the stub txn; the purge seam then resolves null.
    const db = fakeDb(async () => {});
    await expect(
      handleVaultRpc(delStore, { method: "deleteSession", key: KEY }, () => db, undefined, null, undefined, () => null),
    ).rejects.toThrow("postgres_not_ready");
  });
});
