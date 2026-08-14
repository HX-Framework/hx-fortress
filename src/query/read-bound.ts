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
 *  SET LOCAL (`SET LOCAL x = $1` is a syntax error; don't "simplify" it back). */
export async function withReadBound<T>(
  db: HxDb,
  fn: (db: HxDb) => Promise<T>,
  bound: string = READ_STATEMENT_TIMEOUT,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${bound}, true)`);
    return fn(tx as unknown as HxDb);
  });
}
