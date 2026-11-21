// The rows SQLite writes for a store, as it writes them: `ctx.storage.sql` with each statement's
// own count (`rowsWritten`, what Cloudflare bills, index entries included) added up. The store's
// daily write limit reads it (write-limit.ts). No imports beyond a type, so core.ts can hold one.

import type { SqlLike, StoreSqlValue, StoreSqlCursor } from "./sql.js";

/** The UTC day of a moment, `YYYY-MM-DD`. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * `ctx.storage.sql`, adding up the rows each statement writes. A statement that writes and then
 * fails throws before it hands back a cursor, so its rows are never counted here, though the
 * platform bills them; the hourly spend check (infra/scripts/cf-store-spend.mjs) sees them.
 */
export class MeteredSql implements SqlLike {
  /** Rows written since the count was last kept in `_meta`. */
  unkept = 0;
  /** The UTC day rows count on now: set when a call or an alarm starts (write-limit.ts `startWrites`). */
  day: string | null = null;
  /** The day whose old counts were last dropped. */
  prunedDay: string | null = null;
  /** The time by which an alarm keeps what waits here, when one is set (write-limit.ts `keepSoon`). */
  keepBy: number | null = null;

  constructor(readonly raw: SqlLike & { readonly databaseSize: number }) {}

  get databaseSize(): number {
    return this.raw.databaseSize;
  }

  exec<T extends Record<string, StoreSqlValue>>(query: string, ...bindings: unknown[]): StoreSqlCursor<T> {
    const cursor = this.raw.exec<T>(query, ...bindings);
    // A statement that writes does all its writing on its first step, which `exec` takes.
    const rows = Number(cursor.rowsWritten) || 0;
    if (rows > 0) this.unkept += rows;
    return cursor;
  }
}

/**
 * The statements one caller runs, through the store's meter: they count toward the day as every
 * statement does, and `rows` adds up only this caller's. A job's chunk runs its statements through
 * one, so the rows other calls write while the chunk waits on its bucket are never the job's.
 */
export class CountedSql implements SqlLike {
  rows = 0;

  constructor(private readonly meter: MeteredSql) {}

  get databaseSize(): number {
    return this.meter.databaseSize;
  }

  exec<T extends Record<string, StoreSqlValue>>(query: string, ...bindings: unknown[]): StoreSqlCursor<T> {
    const cursor = this.meter.exec<T>(query, ...bindings);
    this.rows += Number(cursor.rowsWritten) || 0;
    return cursor;
  }
}
