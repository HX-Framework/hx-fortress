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
// hx_text_occurrences keeps its own tighter 15 s bound (its docstring owns the
// reasoning); this module is the shared default for the rest.

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
