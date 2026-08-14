import type { MigrationExec } from "./migrate";

/** Migration statement bound (ms). Validated integer per the interpolation rule
 *  — the value rides inside a SET LOCAL literal (a bound param can't share the
 *  simple-query batch). README migration-author note: each single migration
 *  must fit this budget (per-migration journaling converges incrementally
 *  across attempts, one too-slow migration never does) — raise the env for
 *  backfill-class migrations. */
export function migrationTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FORTRESS_DB_MIGRATION_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 300_000;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 300_000;
}

// The migration advisory lock uses the TWO-INT form (0x6878 = "hx",
// 0x6d696772 = "migr"): pg_advisory_xact_lock(int,int) occupies objsubid=2,
// disjoint BY CONSTRUCTION from the one-arg hashtextextended(bigint) locks the
// ingest/delete paths take (objsubid=1) — zero collision, zero deadlock risk
// (every txn takes at most one advisory lock).
const MIGRATION_LOCK_KEY: readonly [number, number] = [0x6878, 0x6d696772];

/** The bounding prefix every migration batch carries. SET LOCAL (not SET)
 *  scopes the GUCs to the batch's implicit transaction — a plain SET would
 *  persist them on a transaction-mode pooler's server connection and silently
 *  re-impose timeouts an operator disabled via the =0 hatch. The xact-scoped
 *  lock serializes a zombie attempt (abandoned by the outer deadline but still
 *  running server-side) against its retry; its WAIT is bounded by lock_timeout
 *  (a clean 55P03 fails the attempt, the loop retries). statement_timeout
 *  applies per-statement within the batch on PG ≥ 13. */
export function migrationBatchPrefix(
  env: Record<string, string | undefined> = process.env,
  lockTimeoutMs = 30_000,
): string {
  const stmt = migrationTimeoutMs(env);
  const lock = Number.isInteger(lockTimeoutMs) && lockTimeoutMs > 0 ? lockTimeoutMs : 30_000;
  return (
    `SET LOCAL statement_timeout = ${stmt};\n` +
    `SET LOCAL lock_timeout = ${lock};\n` +
    `SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY[0]}, ${MIGRATION_LOCK_KEY[1]});\n`
  );
}

/** The rows of the LAST statement in a (possibly multi-statement) simple-query
 *  result. Bun's `.simple()` returns a POSITIONAL array of per-statement result
 *  sets for a batch, and the rows array itself for a single statement — the
 *  prefixed journal SELECT must index the last element or every boot re-runs
 *  migration 0 forever (journal-PK abort loop). Pinned by the
 *  FORTRESS_PG_CI_DSN lane against a real server. */
export function lastResultSet(result: unknown): unknown[] {
  if (!Array.isArray(result)) return [];
  if (result.length > 0 && result.every(Array.isArray)) {
    return result[result.length - 1] as unknown[];
  }
  return result;
}

export interface MigrationExecOptions {
  env?: Record<string, string | undefined>;
  /** Test-only: shrink the lock_timeout so a lock-hold test fails in ms. */
  lockTimeoutMs?: number;
}

/** A MigrationExec backed by Bun.SQL over a DSN. `exec` uses simple-query mode
 *  so a multi-statement migration batch runs as one implicit transaction; every
 *  batch — the tracking DDL and the journal read included — is prefixed with
 *  the SET LOCAL bounds + the migration advisory lock, so no statement in the
 *  migration path can hang unbounded or double-apply concurrently. Migration
 *  clients carry NO startup parameters (a pooler-fronted DSN must be able to
 *  migrate before the operator discovers the =0 hatch); the bounds ride
 *  in-batch instead. */
export function makeMigrationExec(dsn: string, options: MigrationExecOptions = {}): MigrationExec {
  const prefix = (): string => migrationBatchPrefix(options.env, options.lockTimeoutMs);
  return {
    async exec(statement) {
      const client = new Bun.SQL(dsn);
      try {
        await client.unsafe(`${prefix()}${statement}`).simple();
      } finally {
        await client.end();
      }
    },
    async query<T = Record<string, unknown>>(statement: string): Promise<T[]> {
      const client = new Bun.SQL(dsn);
      try {
        const result = await client.unsafe(`${prefix()}${statement}`).simple();
        return lastResultSet(result) as T[];
      } finally {
        await client.end();
      }
    },
  };
}
