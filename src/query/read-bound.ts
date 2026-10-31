// LETAIR-175 F2 — the server-side statement bound for MCP read tools.
//
// The MCP read path has no server-side abandon: when the cloud gives up on a
// tool call (~25-30 s tunnel deadline) the Postgres statement keeps running to
// the pool-wide 120 s budget while its Bun pool slot stays checked out — the
// documented never-cancels contract (host/postgres/db.ts). A handful of such
// zombies is exactly how the 10-connection RO pool was exhausted in production
// (ERR_POSTGRES_IDLE_TIMEOUT at acquire, LETAIR-175). Bounding every read
// query at 20 s — inside the caller's own deadline — makes a zombie's hold
// 6× shorter and the exhaustion arithmetic collapse, and it cannot cut off
// work anyone can still receive: nothing legitimate on the read path outlives
// its caller today.
//
// The two reads that visit every turn holding a word (hx_session_search and
// hx_text_occurrences) take the longer WIDE_READ_STATEMENT_TIMEOUT below; this
// module's 20 s is the default for the rest.

import { sql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";

/** Transaction-local statement budget for one MCP read tool call. */
export const READ_STATEMENT_TIMEOUT = "20s";

/** Run `fn` inside a transaction whose statement_timeout is bounded. The value
 *  rides through set_config(..., is_local=true) — the PARAMETERIZABLE form of
 *  SET LOCAL (`SET LOCAL x = $1` is a syntax error; don't "simplify" it back).
 *
 *  The same transaction plans every statement for its own parameters
 *  (`plan_cache_mode = force_custom_plan`). The read tools bind the scope's
 *  session ids as one uuid[] parameter (sql-array.ts), so their statement text
 *  is the same for every scope and Bun.SQL reuses its prepared statement. After
 *  five executions Postgres may switch that statement to a generic plan, which
 *  assumes about ten ids: keyword search then walks the session index through
 *  every in-scope turn instead of the GIN index. Measured on 470k turns, a
 *  10,000-session search went from 18 ms to 65 ms on its sixth call, and a
 *  31,331-session one ran in 185 ms against 33 ms planned for its ids. */
export async function withReadBound<T>(
  db: HxDb,
  fn: (db: HxDb) => Promise<T>,
  bound: string = READ_STATEMENT_TIMEOUT,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${bound}, true), set_config('plan_cache_mode', 'force_custom_plan', true)`,
    );
    return fn(tx as unknown as HxDb);
  });
}

/** The statement budget of a WIDE read: one that visits every turn holding a
 *  word (hx_session_search, hx_text_occurrences). Inside the tunnel's 60 s MCP
 *  deadline, so the caller still receives the answer. */
export const WIDE_READ_STATEMENT_TIMEOUT = "45s";

/** `withReadBound` for a wide read, with the two settings such a read needs.
 *
 *  Measured on production on 2026-10-28 (4,972,267 turns, a 31,807-session
 *  scope, counting "release" in what was said):
 *
 *  - `work_mem` 128MB keeps the bitmap of matching turns EXACT. At the server's
 *    4MB it went lossy for 20,700 heap pages, and every row on a lossy page was
 *    rechecked against the word, which reads that row's out-of-line text: tool
 *    output, 40 GB of it in the TOAST table. 59.5 s, against 11.9–22.3 s with
 *    an exact bitmap for words never read before.
 *  - `effective_io_concurrency` 128 lets the bitmap heap scan read ahead: 75,786
 *    heap pages read with 0.1 s spent waiting. Turns that hold a word are spread
 *    over the whole table, one or two to a page.
 *
 *  Both are transaction-local (set_config(..., true)), so they end with this
 *  read and never reach another statement on the pooled connection. */
export async function withWideReadBound<T>(db: HxDb, fn: (db: HxDb) => Promise<T>): Promise<T> {
  return withReadBound(
    db,
    async (bdb) => {
      await bdb.execute(sql`SELECT set_config('work_mem', '128MB', true)`);
      // A platform without posix_fadvise (macOS before Postgres 18, where a
      // self-hosted fortress may run its own Postgres) refuses any value but 0.
      // In its own savepoint, so the refusal leaves the read running without
      // read-ahead rather than failing it.
      try {
        await bdb.transaction(async (inner) => {
          await inner.execute(sql`SELECT set_config('effective_io_concurrency', '128', true)`);
        });
      } catch {
        // Read-ahead stays at the server's setting.
      }
      return fn(bdb);
    },
    WIDE_READ_STATEMENT_TIMEOUT,
  );
}

/** Parallel workers one statement of a wide read may use. */
export const WIDE_READ_PARALLEL_WORKERS = 4;

/** Lets the rest of a wide read's transaction run its scans on parallel
 *  workers.
 *
 *  A count reads the text of every turn that may hold the word, and most of
 *  that text is out of line: one synchronous read of the TOAST table after
 *  another, in one backend. Each worker reads its own share of the heap pages
 *  and of that text. Measured on production on 2026-10-31 (5,185,697 turns, a
 *  34,040-session scope): counting a common word in what was said took 18.3 s
 *  alone and 4.3–5.4 s with four workers, for words not read before; reading
 *  the text of every turn that holds "release", in every kind, took 78 s alone
 *  and 20.8 s with four workers, both after an earlier read of the same pages.
 *
 *  The planner prices a parallel bitmap heap scan by its CPU work alone, so at
 *  the default setup and tuple costs it keeps these reads serial; both costs are
 *  zeroed here. The server's max_parallel_workers still caps how many start, and
 *  with none free the statement runs alone, as it did before. Transaction-local,
 *  like the settings above. */
export async function allowParallelWorkers(db: HxDb): Promise<void> {
  await db.execute(
    sql`SELECT set_config('max_parallel_workers_per_gather', ${String(WIDE_READ_PARALLEL_WORKERS)}, true), set_config('parallel_setup_cost', '0', true), set_config('parallel_tuple_cost', '0', true), set_config('min_parallel_table_scan_size', '0', true)`,
  );
}
