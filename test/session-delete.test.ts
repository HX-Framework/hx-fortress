import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql as dsql } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { baseSessionId, isSessionDeleted, markSessionDeleted, purgeSessionPg } from "../src/ingest/delete";
import { ingestCommit, ingestAgentCommit, type IngestAttribution } from "../src/ingest/ingest";
import { recordChunkIntent } from "../src/ingest/intents";
import { sessionDeletePrefixes } from "../src/modules/session-vault/store/keys";
import {
  handleVaultRpc,
  isVaultWriteMethod,
  vaultRpcPurpose,
} from "../src/modules/session-vault/store/rpc";
import type { SessionKey, SessionStore } from "../src/modules/session-vault/store/types";

const DSN = process.env.FORTRESS_DATABASE_URL;

// ── Pure units (always run) ──────────────────────────────────────────────────

describe("session delete — units", () => {
  test("sessionDeletePrefixes covers the session dir AND its agent lanes, exact-segment", () => {
    const key = { userId: "u1", family: "claude-cli", sessionId: "sid-1" };
    expect(sessionDeletePrefixes(key)).toEqual(["u1/claude-cli/sid-1/", "u1/claude-cli/sid-1:a:"]);
    // A composite (agent-lane) id must be rejected — callers pass the base id.
    expect(() =>
      sessionDeletePrefixes({ ...key, sessionId: "sid-1:a:agent" }),
    ).toThrow("base session id");
  });

  test("baseSessionId strips the agent-lane composite", () => {
    expect(baseSessionId("sid-1")).toBe("sid-1");
    expect(baseSessionId("sid-1:a:agent-9")).toBe("sid-1");
  });

  test("deleteSession is a WRITE method (ingest-purpose grant + principal binding)", () => {
    expect(isVaultWriteMethod("deleteSession")).toBe(true);
    expect(vaultRpcPurpose("deleteSession")).toBe("ingest");
  });

  test("deleteSession RPC without Postgres fails typed (postgres_not_ready)", async () => {
    const store = { deleteSession: async () => ({ complete: true, deleted: 0 }) } as unknown as SessionStore;
    await expect(
      handleVaultRpc(store, {
        method: "deleteSession",
        key: { userId: "u1", family: "claude-cli", sessionId: "sid-1" },
      }),
    ).rejects.toThrow("postgres_not_ready");
  });

  test("deleteSession RPC is principal-bound (key.userId must equal authz.sub)", async () => {
    const store = { deleteSession: async () => ({ complete: true, deleted: 0 }) } as unknown as SessionStore;
    await expect(
      handleVaultRpc(
        store,
        { method: "deleteSession", key: { userId: "u-victim", family: "claude-cli", sessionId: "s" } },
        null,
        { sub: "u-attacker" },
      ),
    ).rejects.toThrow("principal_object_mismatch");
  });
});

// ── Postgres-backed (runs against a real fortress PG when DSN is set) ────────

const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SESSION_ID = `sess-del-${SUFFIX}`;
const USER_ID = `user-del-${SUFFIX}`;
const KEY: SessionKey = { userId: USER_ID, family: "claude-cli", sessionId: SESSION_ID };
const TS = "2026-07-23T10:00:00Z";

function mockChunk(): string {
  return [
    JSON.stringify({
      type: "user",
      timestamp: TS,
      message: { content: [{ type: "text", text: "delete-me marker DELQX" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: TS,
      message: {
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "acknowledged" }],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    }),
  ].join("\n");
}

describe.if(!!DSN)("session delete — Postgres purge + tombstone guards", () => {
  const dsn = DSN as string;
  const sql = makeMigrationExec(dsn);
  let db: HxDb;

  beforeAll(async () => {
    await runMigrations(sql, migrations);
    db = createHxDb(dsn);
    await ingestCommit(db, {
      ingestChannel: "tunnel",
      attribution: ATTR,
      key: KEY,
      chunkId: "c1",
      replace: false,
      chunkText: mockChunk(),
      totalBytes: 128,
      componentCount: 1,
      meta: { title: "Delete me" },
    });
    await ingestAgentCommit(db, {
      ingestChannel: "tunnel",
      attribution: ATTR,
      key: KEY,
      agentId: "agent-1",
      chunkId: "ac1",
      replace: false,
      chunkText: mockChunk(),
      totalBytes: 64,
      componentCount: 1,
      meta: null,
    });
  }, 60_000);

  afterAll(async () => {
    if (!DSN) return;
    await sql.exec(`DELETE FROM hx.ingest_events WHERE session_id_ext = '${SESSION_ID}'`);
    await sql.exec(`DELETE FROM hx.sessions WHERE session_id = '${SESSION_ID}'`);
    await sql.exec(`DELETE FROM hx.deleted_sessions WHERE session_id = '${SESSION_ID}'`);
  });

  const count = async (q: string): Promise<number> => {
    const [{ n }] = await sql.query<{ n: number }>(q);
    return Number(n);
  };

  test("purge removes the session row, all lanes' turns, and the ingest audit trail", async () => {
    expect(
      await count(`SELECT count(*)::int n FROM hx.sessions WHERE session_id = '${SESSION_ID}'`),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int n FROM hx.turns WHERE session_id IN (SELECT id FROM hx.sessions WHERE session_id = '${SESSION_ID}')`,
      ),
    ).toBeGreaterThan(0);

    await markSessionDeleted(db, KEY);
    const res = await purgeSessionPg(db, KEY, Date.now() + 20_000);
    expect(res.complete).toBe(true);
    expect(res.deletedTurns).toBeGreaterThan(0);

    expect(
      await count(`SELECT count(*)::int n FROM hx.sessions WHERE session_id = '${SESSION_ID}'`),
    ).toBe(0);
    // SET-NULL FK tables must not retain identifier/excerpt rows.
    expect(
      await count(
        `SELECT count(*)::int n FROM hx.ingest_events WHERE session_id_ext = '${SESSION_ID}'`,
      ),
    ).toBe(0);
  });

  test("purge is idempotent (second call is a clean no-op)", async () => {
    const res = await purgeSessionPg(db, KEY, Date.now() + 5_000);
    expect(res).toEqual({ complete: true, deletedTurns: 0 });
  });

  test("re-ingest of a tombstoned session is refused — parent, and agent lane cross-family", async () => {
    await expect(
      ingestCommit(db, {
        ingestChannel: "tunnel",
        attribution: ATTR,
        key: KEY,
        chunkId: "c2",
        replace: true,
        chunkText: mockChunk(),
        totalBytes: 128,
        componentCount: 1,
        meta: { title: "Zombie" },
      }),
    ).rejects.toThrow("session_deleted");
    // Stale-family child upload: guard matches on (user, sessionId) across families.
    await expect(
      ingestAgentCommit(db, {
        ingestChannel: "tunnel",
        attribution: ATTR,
        key: { ...KEY, family: "claude-desktop" },
        agentId: "agent-2",
        chunkId: "ac2",
        replace: false,
        chunkText: mockChunk(),
        totalBytes: 64,
        componentCount: 1,
        meta: null,
      }),
    ).rejects.toThrow("session_deleted");
    expect(await isSessionDeleted(db, USER_ID, SESSION_ID)).toBe(true);
    expect(await isSessionDeleted(db, USER_ID, `${SESSION_ID}:a:agent-2`)).toBe(true);
  });

  test("deleteSession RPC converges: tombstone + PG purge + store purge with the base key", async () => {
    const calls: Array<{ key: SessionKey; batchLimit?: number }> = [];
    const store = {
      deleteSession: async (key: SessionKey, opts?: { batchLimit?: number }) => {
        calls.push({ key, batchLimit: opts?.batchLimit });
        return { complete: true, deleted: 3 };
      },
    } as unknown as SessionStore;

    const res = await handleVaultRpc(
      store,
      { method: "deleteSession", key: { ...KEY, sessionId: `${SESSION_ID}:a:agent-1` } },
      () => db,
      { sub: USER_ID },
    );
    expect(res).toEqual({ method: "deleteSession", value: { complete: true, deleted: 3 } });
    // The RPC strips the agent-lane composite to the base id before purging.
    expect(calls).toHaveLength(1);
    expect(calls[0].key.sessionId).toBe(SESSION_ID);
    expect(calls[0].batchLimit).toBe(500);
  });
});

describe.skipIf(!process.env.FORTRESS_DATABASE_URL)("purge leaves no chunk_intents residue", () => {
  const dsn = process.env.FORTRESS_DATABASE_URL as string;
  let db2: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db2 = createHxDb(dsn);
  });

  test("a permanent delete removes the session's intents too", async () => {
    // chunk_intents has NO FK to hx.sessions, so no cascade reaches it. Rows left
    // behind still carry the user's external id, the family and the session id — in a
    // service whose permanent-delete is a residency contract, that is residue.
    const key: SessionKey = {
      userId: `purgeintent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const text = `${JSON.stringify({ type: "user", uuid: crypto.randomUUID(), timestamp: "2026-07-01T10:00:00Z", message: { content: [{ type: "text", text: "hi" }] } })}\n`;
    await ingestCommit(db2, {
      key, chunkId: "p1", replace: false, chunkText: text,
      totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null,
      attribution: { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null },
      ingestChannel: "tunnel" as const,
    });
    await recordChunkIntent(db2, {
      userExternalId: key.userId, family: key.family, sessionId: key.sessionId,
      chunkId: "p2-open", totalBytes: 999_999,
    });
    const countIntents = async (): Promise<number> => {
      const r = (await db2.execute(dsql`
        select count(*)::int as n from hx.chunk_intents
        where user_external_id = ${key.userId} and session_id = ${key.sessionId}
      `)) as unknown as Array<{ n: number }>;
      return Number(r[0]?.n ?? 0);
    };
    expect(await countIntents()).toBe(1);

    await markSessionDeleted(db2, key);
    const res = await purgeSessionPg(db2, key, Date.now() + 30_000);
    expect(res.complete).toBe(true);
    expect(await countIntents()).toBe(0);
  }, 60_000);
});
