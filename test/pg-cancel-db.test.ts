import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHxDb, hxPoolOptionsFor, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { createBackendCanceller, createPgCancelScope, PgPhaseAbandonedError } from "../src/host/postgres/pg-cancel";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { hxSessions } from "../src/host/postgres/schema/sessions";
import { hxUsers } from "../src/host/postgres/schema/dimensions";
import { ingestCommit } from "../src/ingest/ingest";
import { sessionLockKey } from "../src/ingest/delete";
import { handleVaultRpc } from "../src/modules/session-vault/store/rpc";
import type { SessionKey, SessionStore } from "../src/modules/session-vault/store/types";

// The deadline-cancel path exercised against a real hx schema. The unit tests
// pin the scope's contract; these pin what only Postgres can confirm: the
// ingest transaction attaches the backend it runs on, a cancelled scope makes
// it roll back BEFORE its writes, the pooled connection comes back healthy, and
// a vault RPC that misses its deadline leaves no half-indexed row behind.
const DSN = process.env.FORTRESS_DATABASE_URL;
const TS = "2026-07-01T10:00:00Z";
const ATTR = { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null };

const rec = (t: string) =>
  `${JSON.stringify({
    type: "user",
    uuid: crypto.randomUUID(),
    timestamp: TS,
    message: { content: [{ type: "text", text: t }] },
  })}\n`;

describe.skipIf(!DSN)("deadline cancel against a real hx schema", () => {
  const dsn = DSN as string;
  let db: HxDb;
  let holder: Bun.SQL;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn, { ...hxPoolOptionsFor("rw", {}), max: 2 });
    holder = new Bun.SQL(dsn, { max: 1, idleTimeout: 0, connection: { application_name: "cancel-test-holder" } });
  });
  afterAll(async () => {
    await holder?.close({ timeout: 1 }).catch(() => {});
  });

  const key = (tag: string): SessionKey => ({
    userId: `cancel-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    family: "claude-cli",
    sessionId: crypto.randomUUID(),
  });

  const sessionRow = async (k: SessionKey) => {
    const [row] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, k.userId), eq(hxSessions.sessionId, k.sessionId)))
      .limit(1);
    return row ?? null;
  };

  const input = (k: SessionKey, text: string) => ({
    attribution: ATTR,
    key: k,
    ingestChannel: "tunnel" as const,
    chunkId: `c-${Math.random().toString(36).slice(2, 8)}`,
    chunkText: rec(text),
    totalBytes: 10,
    componentCount: 1,
    replace: false,
    meta: null,
  });

  test("the transaction attaches its backend pid; a cancelled scope rolls it back before any write and the connection stays healthy", async () => {
    const cancelled: number[] = [];
    const scope = createPgCancelScope("db_unavailable:ingest_commit", async (pid) => {
      cancelled.push(pid);
    });
    await scope.cancel(); // the caller already gave up
    const k = key("abandon");
    let caught: unknown = null;
    try {
      await ingestCommit(db, { ...input(k, "never indexed"), cancelScope: scope });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PgPhaseAbandonedError);
    // The pid came from the lock statement and was cancelled on arrival.
    expect(cancelled.length).toBe(1);
    expect(cancelled[0]).toBeGreaterThan(0);
    expect(scope.pids()).toEqual([]); // detached on the way out
    // Nothing was written: the abort happened before the dimension upserts.
    expect(await sessionRow(k)).toBeNull();
    // The pooled connection is back and serves the next transaction unharmed.
    const outcome = await ingestCommit(db, input(k, "indexed afterwards"));
    expect(outcome.applied).toBe(true);
    expect(await sessionRow(k)).not.toBeNull();
  }, 20_000);

  test("a vault RPC that misses its deadline behind a held session lock leaves no row behind once the lock is released", async () => {
    // The loser used to run to completion after the caller had been told
    // db_unavailable. Now the scope is cancelled at the deadline; when the lock
    // finally clears, the transaction attaches, sees the cancel, and rolls back.
    const k = key("rpc");
    process.env.FORTRESS_DB_RPC_DEADLINE_MS = "400";
    const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logger = { warn: (msg: string, meta?: Record<string, unknown>) => warns.push({ msg, meta }) };
    const canceller = createBackendCanceller(() => dsn);
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(hashtextextended(${sessionLockKey(k.userId, k.sessionId)}, 0))`;
      const started = Date.now();
      await expect(
        handleVaultRpc(
          {} as SessionStore,
          { method: "ingestCommit", ...input(k, "deadline loser") },
          () => db,
          undefined,
          null,
          logger,
          null,
          { cancelBackend: canceller.cancel },
        ),
      ).rejects.toThrow("db_unavailable:ingest_commit");
      expect(Date.now() - started).toBeLessThan(5_000); // typed at the deadline, not at lock_timeout
      await holder`rollback`; // the loser's lock wait ends here
      // Give the loser time to attach, see the cancel, and roll back.
      for (let i = 0; i < 50 && !warns.some((w) => w.msg === "vault RPC pg phase failed after deadline"); i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const late = warns.find((w) => w.msg === "vault RPC pg phase failed after deadline");
      expect(late).toBeDefined();
      expect(String(late?.meta?.error)).toContain("pg_phase_abandoned");
      expect(await sessionRow(k)).toBeNull();
      // …and the pool is intact for the next write.
      expect((await ingestCommit(db, input(k, "after the loser"))).applied).toBe(true);
    } finally {
      delete process.env.FORTRESS_DB_RPC_DEADLINE_MS;
      canceller.close();
    }
  }, 30_000);
});
