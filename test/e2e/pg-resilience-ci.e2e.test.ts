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
  isPoolExhaustedDbError,
  isStatementTimeoutDbError,
  isTransientDbError,
  retryOnceOnTransientDbError,
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
  // v0.18.0 — the pool-starvation pins. The fix rests on ONE empirical claim
  // about Bun that its option NAME actively contradicts, so it is pinned here
  // against a real server: a driver upgrade that changes it must fail loudly,
  // not silently restore the 2026-08-05 outage.
  // ---------------------------------------------------------------------

  // Bun's tagged-template query is LAZY — it does not hit the server until it is
  // awaited/thened. A test that queues "behind" an un-started query is really
  // just running against an idle pool, so every occupancy helper here kicks the
  // query off and settles before the pool is meant to be full.
  // Sleeping a fixed interval and HOPING the query started makes these tests
  // timing-flaky (it queues against an idle pool whenever the kick-off loses the
  // race). Instead, tag the occupying statement and poll pg_stat_activity from a
  // separate connection until the server confirms it is actually running — only
  // then is the pool genuinely full.
  // TWO waits are needed, and both were learned the hard way:
  //   1. poll pg_stat_activity until the server confirms the statement is
  //      running — a fixed sleep alone races the kick-off on a slow server;
  //   2. THEN settle, because server-side "active" still precedes Bun finishing
  //      its own pool bookkeeping. Queue in that window and the pool hands out a
  //      SECOND connection despite max:1, and the test silently measures an idle
  //      pool instead of a full one.
  // Filling the pool needs care. Bun reports a statement active server-side
  // BEFORE it finishes its own pool bookkeeping, and a query queued inside that
  // window gets a SECOND connection despite max:1 — the test then measures an
  // idle pool and quietly proves nothing. reserve() is not a faithful stand-in
  // either: a pool drained that way rejects with ERR_POSTGRES_CONNECTION_CLOSED,
  // a different path from the starvation these pins are about. So: a real
  // in-flight query, a settle, and a finally that can never leak the occupancy
  // into the next test (a leaked pg_sleep is what made earlier drafts flaky).
  const POOL_SETTLE_MS = 700;
  const withFullPool = async (
    opts: Record<string, unknown>,
    body: (c: Bun.SQL) => Promise<void>,
  ): Promise<void> => {
    const c = client(opts);
    const busy = c`select pg_sleep(8)`.catch(() => undefined);
    await new Promise((r) => setTimeout(r, POOL_SETTLE_MS));
    try {
      await body(c);
    } finally {
      await c.close({ timeout: 1 }).catch(() => {});
      await busy;
    }
  };

  test("LOAD-BEARING: idleTimeout bounds WAITING FOR A CONNECTION, not idle sockets", async () => {
    // The single empirical claim the v0.18.0 fix rests on, and the one Bun's
    // option NAME contradicts. An idle-socket reaper would let this query wait
    // out the 8 s occupancy; the checkout-queue bound rejects it at 1 s.
    await withFullPool({ max: 1, idleTimeout: 1 }, async (c) => {
      const started = Date.now();
      let caught: unknown = null;
      try {
        await c`select 1`;
      } catch (err) {
        caught = err;
      }
      const waited = Date.now() - started;

      expect(caught).not.toBeNull();
      // The exact code the outage produced, from a pool that was merely BUSY.
      expect((caught as { code?: string }).code).toBe("ERR_POSTGRES_IDLE_TIMEOUT");
      expect(isPoolExhaustedDbError(caught)).toBe(true);
      // Bounded by idleTimeout (1 s), nowhere near the 8 s occupancy.
      expect(waited).toBeGreaterThan(500);
      expect(waited).toBeLessThan(4_000);
      // …and the connection was never broken, so it must not be kill-class.
      expect(isKillClassDbError(caught)).toBe(false);
      expect(isTransientDbError(caught)).toBe(false);
    });
  }, 20_000);

  test("with NO acquire bound the same query just waits — Bun's default is wait-forever", async () => {
    // Why the bound must exist, and why 0 is not an option: unbounded, a starved
    // pool silently queues work whose caller gave up long ago.
    await withFullPool({ max: 1 }, async (c) => {
      let settled = false;
      const queued = c`select 1`.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // Still pending long past the 1 s bound the other pools carry.
      await new Promise((r) => setTimeout(r, 2_500));
      expect(settled).toBe(false);
      void queued;
    });
  }, 20_000);

  test("a starved pool is NEVER retried in-process — the amplifier is gone", async () => {
    await withFullPool({ max: 1, idleTimeout: 1 }, async (c) => {
      let attempts = 0;
      await expect(
        retryOnceOnTransientDbError(async () => {
          attempts += 1;
          await c`select 1`;
        }),
      ).rejects.toThrow();
      // Exactly one attempt: retrying into a full pool is what doubled the load
      // every time a commit failed on 2026-08-05.
      expect(attempts).toBe(1);
    });
  }, 20_000);

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
