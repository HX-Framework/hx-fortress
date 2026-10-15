// LOAD-BEARING real-Postgres pins for the PG-layer resilience design
// (v0.17.0). Gated on FORTRESS_PG_CI_DSN — a plain reachable Postgres DSN
// (CI: a pgvector/pgvector:pg18 service container; locally e.g.
//   docker run --rm -e POSTGRES_PASSWORD=hx -p 5498:5432 pgvector/pgvector:pg18
//   FORTRESS_PG_CI_DSN=postgresql://postgres:hx@127.0.0.1:5498/postgres bun test pg-resilience-ci
// ). These connect DIRECTLY to the DSN — deliberately NOT via the embedded
// provider (the FORTRESS_PG_E2E lane is bit-rotted: its fixtures point pgvector
// acquisition at a fake cloud URL — known-broken, repair out of scope).
//
// Every empirical claim the design rests on is re-pinned here so a Bun/driver
// upgrade fails THIS lane loudly instead of shipping a silent prod no-op:
//   • multi-statement .simple() result shape (journal read indexes the LAST
//     element — a mis-parse re-runs migration 0 forever and the fortress never
//     becomes ready);
//   • SET LOCAL binding inside the implicit batch txn (57014 / 55P03);
//   • PostgresError field layout (SQLSTATE in .errno; kill-class in .code);
//   • wrapped (db.execute) vs BARE (db.transaction / raw Bun.SQL) error shapes;
//   • startup-param statement_timeout reaching the server;
//   • .detail (not .message) carrying constraint values — the sanitizer's
//     sentinel exclusion.

import { afterAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";

import { makeMigrationExec } from "../../src/host/postgres/sql-exec";
import { runMigrations, type Migration } from "../../src/host/postgres/migrate";
import {
  dbSqlState,
  isKillClassDbError,
  isLockTimeoutDbError,
  isStatementTimeoutDbError,
  isTransientDbError,
  unwrapDbError,
} from "../../src/host/postgres/pg-errors";
import { hxPoolOptionsFor } from "../../src/host/postgres/db";
import { sanitizeDbError } from "../../src/host/postgres/sanitize";

const DSN = process.env.FORTRESS_PG_CI_DSN ?? "";

const opened: Bun.SQL[] = [];
function client(options: Record<string, unknown> = {}): Bun.SQL {
  const c = new Bun.SQL(DSN, options as never);
  opened.push(c);
  return c;
}

afterAll(async () => {
  await Promise.all(opened.map((c) => c.close({ timeout: 2 }).catch(() => {})));
});

describe.if(DSN !== "")("PG resilience pins (real Postgres)", () => {
  test("journal-read shape: the prefixed multi-statement batch's LAST result set is the rows (LOAD-BEARING)", async () => {
    const exec = makeMigrationExec(DSN);
    // Stateless against a reused local container (CI's is always fresh).
    await exec.exec(
      "CREATE SCHEMA IF NOT EXISTS hx;" +
        "CREATE TABLE IF NOT EXISTS hx.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());" +
        "DELETE FROM hx.schema_migrations WHERE name = 'ci_0001_probe';" +
        "DROP TABLE IF EXISTS hx.ci_probe;",
    );
    const migrations: Migration[] = [
      { name: "ci_0001_probe", sql: "CREATE TABLE IF NOT EXISTS hx.ci_probe(id int);" },
    ];
    const first = await runMigrations(exec, migrations);
    expect(first).toEqual(["ci_0001_probe"]);
    // Idempotence IS the shape test: a mis-parsed journal read would return []
    // applied names and re-run (then journal-PK-abort) migration 1 forever.
    const second = await runMigrations(exec, migrations);
    expect(second).toEqual([]);
    const rows = await exec.query<{ name: string }>("SELECT name FROM hx.schema_migrations");
    expect(rows.some((r) => r.name === "ci_0001_probe")).toBe(true);
  });

  test("SET LOCAL statement_timeout binds the batch's implicit txn: pg_sleep past it dies 57014 via .errno", async () => {
    const exec = makeMigrationExec(DSN, { env: { FORTRESS_DB_MIGRATION_TIMEOUT_MS: "400" } });
    let caught: unknown = null;
    try {
      await exec.exec("SELECT pg_sleep(2);");
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(isStatementTimeoutDbError(caught)).toBe(true);
    expect(dbSqlState(caught)).toBe("57014");
    // …and the bound evaporates with the batch (SET LOCAL, not SET): a fresh
    // batch on the same DSN runs unbounded again.
    await makeMigrationExec(DSN).exec("SELECT pg_sleep(0.5);");
  });

  test("a held migration advisory lock bounds the WAIT via lock_timeout (clean 55P03 — the zombie-vs-retry serializer)", async () => {
    const holder = client({ max: 1 });
    await holder.unsafe(
      "BEGIN; SELECT pg_advisory_xact_lock(26744, 1835624306);",
    ).simple();
    try {
      const exec = makeMigrationExec(DSN, { lockTimeoutMs: 300 });
      let caught: unknown = null;
      try {
        await exec.exec("SELECT 1;");
      } catch (err) {
        caught = err;
      }
      expect(dbSqlState(caught)).toBe("55P03");
    } finally {
      await holder.unsafe("ROLLBACK;").simple();
    }
  });

  test("startup-param statement_timeout reaches the server (the pools' only per-statement bound)", async () => {
    const c = client({ max: 1, connection: { statement_timeout: 250 } });
    const rows = (await c`SHOW statement_timeout`) as { statement_timeout: string }[];
    expect(rows[0]?.statement_timeout).toBe("250ms");
  });

  test("kill via db.transaction arrives BARE; via db.execute arrives WRAPPED — the classifier covers both (R5)", async () => {
    // maxLifetime hard-kills the active txn even mid-query — atomic rollback.
    const db = drizzle(client({ max: 1, maxLifetime: 1 }));
    let txnErr: unknown = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_sleep(3)`);
      });
    } catch (err) {
      txnErr = err;
    }
    expect(txnErr).not.toBeNull();
    // BARE: the txn path re-throws the PostgresError itself (cause-less).
    expect((txnErr as { query?: unknown }).query).toBeUndefined();
    expect(isKillClassDbError(txnErr)).toBe(true);

    const db2 = drizzle(client({ max: 1, maxLifetime: 1 }));
    let execErr: unknown = null;
    try {
      await db2.execute(sql`SELECT pg_sleep(3)`);
    } catch (err) {
      execErr = err;
    }
    expect(execErr).not.toBeNull();
    expect(isKillClassDbError(execErr)).toBe(true);
  }, 20_000);

  test("in-txn 57014 (startup param) is classified via .errno through the txn rethrow", async () => {
    const db = drizzle(client({ max: 1, connection: { statement_timeout: 300 } }));
    let caught: unknown = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_sleep(2)`);
      });
    } catch (err) {
      caught = err;
    }
    expect(isStatementTimeoutDbError(caught)).toBe(true);
    expect(isKillClassDbError(caught)).toBe(false); // NOT retried as a kill
  });

  // ---------------------------------------------------------------------
  // 2026-10 — the idle-reaper pins. v0.18.0 pinned the OPPOSITE claim here
  // ("idleTimeout bounds WAITING FOR A CONNECTION, not idle sockets") and
  // passed, because its fixture could not tell the two apart: a query queued
  // behind a full max:1 pool and a query whose own connection was reaped both
  // surface as ERR_POSTGRES_IDLE_TIMEOUT ~1 s in. On 2026-10-13 production
  // showed which it is. These pins hold the driver to the behaviour the fix
  // rests on, so a Bun upgrade that changes it fails here, not in prod.
  // ---------------------------------------------------------------------

  /** Server-side census of one pool's connections, from a separate client. */
  const serverStates = async (app: string): Promise<Record<string, number>> => {
    const mon = client({ max: 1 });
    try {
      const rows = (await mon`select coalesce(state, '?') as state, count(*)::int as n
        from pg_stat_activity where application_name = ${app} group by 1`) as Array<{
        state: string;
        n: number;
      }>;
      return Object.fromEntries(rows.map((r) => [r.state, r.n]));
    } finally {
      await mon.close({ timeout: 1 }).catch(() => {});
    }
  };

  test("LOAD-BEARING: idleTimeout is an inactivity reaper that kills a connection UNDER a running statement", async () => {
    // Pool of ONE, nothing queued behind it: the only thing that can fail this
    // query is its own connection being closed. A 2 s statement on a 1 s timer
    // dies at ~1 s with the code the fortress used to read as "pool exhausted",
    // and the orphaned statement keeps running server-side.
    const c = client({ max: 1, idleTimeout: 1, connection: { application_name: "pin-reaper" } });
    const started = Date.now();
    let caught: unknown = null;
    try {
      await c`select pg_sleep(2)`;
    } catch (err) {
      caught = err;
    }
    const waited = Date.now() - started;
    expect((caught as { code?: string } | null)?.code).toBe("ERR_POSTGRES_IDLE_TIMEOUT");
    expect(waited).toBeGreaterThan(500);
    expect(waited).toBeLessThan(1_800);
    // It is a KILL — the connection is gone — so it is transient and retried once.
    expect(isKillClassDbError(caught)).toBe(true);
    expect(isTransientDbError(caught)).toBe(true);
    expect((await serverStates("pin-reaper")).active ?? 0).toBeGreaterThanOrEqual(1); // orphan
  }, 20_000);

  test("LOAD-BEARING: connections killed under open transactions stop the pool from serving transactions — plain queries still run", async () => {
    // The 2026-10-13 wedge in miniature: every connection dies once with a
    // transaction open, the pool's reservation counter drifts, and sql.begin()
    // either waits until the last connection closes (and fails with the kill)
    // or never returns — while a plain select is served immediately.
    const c = client({ max: 4, idleTimeout: 1, connection: { application_name: "pin-wedge" } });
    const kills = await Promise.allSettled(
      Array.from({ length: 4 }, () => c.begin(async (t) => { await t`select pg_sleep(2)`; })),
    );
    expect(kills.every((k) => k.status === "rejected" && (k.reason as { code?: string }).code === "ERR_POSTGRES_IDLE_TIMEOUT")).toBe(true);

    const deadline = <T,>(p: Promise<T>): Promise<T | "deadline"> =>
      Promise.race([p, new Promise<"deadline">((r) => setTimeout(() => r("deadline"), 3_000))]);
    const txs = await Promise.allSettled(
      Array.from({ length: 4 }, () => deadline(c.begin(async (t) => { await t`select 1`; }).then(() => "ok" as const))),
    );
    // Not one transaction is served: each hangs past 3 s or is failed with the
    // reaper's kill when the reconnected-but-drifted connections close again.
    for (const r of txs) {
      const served = r.status === "fulfilled" && r.value === "ok";
      expect(served).toBe(false);
    }
    // …while the same pool answers a plain query at once.
    expect(await deadline(c`select 1`.then(() => "ok" as const))).toBe("ok");
  }, 30_000);

  test("the fortress pool profiles keep the reaper OFF, so a slow statement inside a transaction completes", async () => {
    // Same 2 s statement, under the real rw options: statement_timeout 30 s,
    // lock_timeout 5 s, idleTimeout 0. It completes; the connection survives;
    // the next transaction is served.
    const opts = hxPoolOptionsFor("rw", {});
    expect(opts.idleTimeout).toBe(0);
    const c = client({ ...opts, max: 2, connection: { ...opts.connection, application_name: "pin-off" } });
    await c.begin(async (t) => { await t`select pg_sleep(2)`; });
    await c.begin(async (t) => { await t`select 1`; });
    expect(await c`select 1 as one`.then((rows) => (rows as Array<{ one: number }>)[0]?.one)).toBe(1);
  }, 20_000);

  test("pg_cancel_backend from another connection aborts the statement with 57014 and KEEPS the connection serving", async () => {
    // The deadline remedy racePgPhase now uses. Cancel (not terminate): the
    // statement fails, the transaction rolls back, the pooled connection stays
    // in the pool with its bookkeeping intact — the next transaction is served.
    const c = client({ max: 1, idleTimeout: 0, connection: { application_name: "pin-cancel" } });
    const canceller = client({ max: 1 });
    const slow = c.begin(async (t) => { await t`select pg_sleep(8)`; }).then(
      () => "completed" as const,
      (err: unknown) => err,
    );
    // Wait until the server shows the statement running, then cancel it by pid.
    let pid: number | null = null;
    for (let i = 0; i < 50 && pid === null; i += 1) {
      const rows = (await canceller`select pid from pg_stat_activity where application_name = 'pin-cancel' and state = 'active' and query like '%pg_sleep%'`) as Array<{ pid: number }>;
      pid = rows[0]?.pid ?? null;
      if (pid === null) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pid).not.toBeNull();
    const started = Date.now();
    await canceller`select pg_cancel_backend(${pid})`;
    const outcome = await slow;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(isStatementTimeoutDbError(outcome)).toBe(true); // SQLSTATE 57014
    expect(isKillClassDbError(outcome)).toBe(false); // the connection was NOT closed
    await c.begin(async (t) => { await t`select 1`; }); // …and it still serves transactions
  }, 30_000);

  test("lock_timeout bounds an advisory-lock WAIT far below statement_timeout", async () => {
    // The ratchet: a live chunk queued behind a long same-session restore used
    // to hold its connection for the whole 120 s statement budget doing nothing.
    const key = 918_273_645;
    const holder = client({ max: 1 });
    await holder`begin`;
    await holder`select pg_advisory_xact_lock(${key})`;
    try {
      const waiter = client({
        max: 1,
        connection: { statement_timeout: 120_000, lock_timeout: 1_000 },
      });
      const started = Date.now();
      let caught: unknown = null;
      try {
        await waiter`select pg_advisory_xact_lock(${key})`;
      } catch (err) {
        caught = err;
      }
      const waited = Date.now() - started;

      expect(caught).not.toBeNull();
      // 55P03, cleanly — the shape tagLockTimeout now recognises.
      expect(dbSqlState(caught)).toBe("55P03");
      expect(isLockTimeoutDbError(caught)).toBe(true);
      // Bounded by lock_timeout (1 s), NOT by statement_timeout (120 s).
      expect(waited).toBeLessThan(5_000);
    } finally {
      await holder`rollback`.catch(() => {});
    }
  });

  test("the live-ingest profile really carries lock_timeout to the server", async () => {
    const opts = hxPoolOptionsFor("rw", {});
    const c = client({ max: 1, connection: opts.connection as Record<string, number> });
    const [row] = await c`show lock_timeout`;
    // 5 s default, as the profile declares — proving the startup param lands.
    expect(String((row as { lock_timeout: string }).lock_timeout)).toBe("5s");
    // The live write path is bounded near the caller deadline (25 s), not at the
    // shared 2 min read budget: an abandoned commit must hand its connection back.
    const [st] = await c`show statement_timeout`;
    expect(String((st as { statement_timeout: string }).statement_timeout)).toBe("30s");
  });

  test("the read profile carries NO lock_timeout (reads never take the session lock)", async () => {
    const opts = hxPoolOptionsFor("ro", {});
    expect(opts.connection?.lock_timeout).toBeUndefined();
    const c = client({ max: 1, connection: opts.connection as Record<string, number> });
    const [row] = await c`show lock_timeout`;
    // Postgres default — unset, so a read never sheds a lock it never takes.
    expect(String((row as { lock_timeout: string }).lock_timeout)).toBe("0");
  });

  test("sanitizer sentinel: a REAL 23505's bound value lives in .detail and NEVER survives sanitizeDbError", async () => {
    const c = client({ max: 1 });
    await c.unsafe(
      "CREATE TABLE IF NOT EXISTS ci_sentinel (k text PRIMARY KEY); DELETE FROM ci_sentinel;",
    ).simple();
    const db = drizzle(c);
    await db.execute(sql`INSERT INTO ci_sentinel (k) VALUES ('SENTINEL_SECRET_VALUE_XYZ')`);
    let caught: unknown = null;
    try {
      await db.execute(sql`INSERT INTO ci_sentinel (k) VALUES ('SENTINEL_SECRET_VALUE_XYZ')`);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    const cause = unwrapDbError(caught) as { message: string; detail?: string };
    // The empirical premise itself: values ride in .detail, never .message.
    expect(cause.message).not.toContain("SENTINEL_SECRET_VALUE_XYZ");
    expect(String(cause.detail ?? "")).toContain("SENTINEL_SECRET_VALUE_XYZ");
    const sanitized = sanitizeDbError(caught);
    expect(sanitized).toContain("23505");
    expect(sanitized).not.toContain("SENTINEL_SECRET_VALUE_XYZ");
    expect(sanitized).not.toContain("Failed query");
  });
});
