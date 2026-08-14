// Classifiers for Bun.SQL / drizzle Postgres errors — the PG-layer analog of
// GuardedStore's breach taxonomy.
//
// Field layout (empirically pinned on Bun 1.3.14 + PG 18; the FORTRESS_PG_CI_DSN
// lane re-pins it against a real server so a driver upgrade fails loudly):
//   • server-raised errors:  { code: "ERR_POSTGRES_SERVER_ERROR", errno: "<SQLSTATE>" }
//     — the SQLSTATE ("57014", "55P03", "23505", …) lives in `.errno`; `.code` is
//     the same constant for EVERY server error, so reading `.code` for a SQLSTATE
//     never matches.
//   • connection-lifecycle kills: { code: "ERR_POSTGRES_CONNECTION_CLOSED" |
//     "…CONNECTION_TIMEOUT" | "…LIFETIME_TIMEOUT" } with NO errno.
//   • pool exhaustion: { code: "ERR_POSTGRES_IDLE_TIMEOUT" } with NO errno —
//     see isPoolExhaustedDbError, which is NOT a kill and NOT transient.
//
// Wrapping (also pinned): a kill through drizzle's `db.execute` arrives WRAPPED
// in DrizzleQueryError (the PostgresError on `.cause`); a kill through
// `db.transaction` re-throws the PostgresError BARE; raw Bun.SQL throws BARE.
// Every classifier therefore unwraps-if-wrapped, then reads `.code`/`.errno`
// on whichever it holds.

import { signalPoolExhausted } from "./pool-signal";

const KILL_CODES = new Set([
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "ERR_POSTGRES_LIFETIME_TIMEOUT",
]);

/** Bun raises this when a query waited longer than the pool's `idleTimeout` for
 *  a connection to become available. Despite the name it is NOT an idle socket
 *  being reaped — see the DEFAULT_ACQUIRE_TIMEOUT_MS note in db.ts. */
const POOL_EXHAUSTED_CODE = "ERR_POSTGRES_IDLE_TIMEOUT";

/** Server cancelled the statement because statement_timeout elapsed. */
const SQLSTATE_STATEMENT_TIMEOUT = "57014";
/** Server refused the lock because lock_timeout elapsed while WAITING for it. */
const SQLSTATE_LOCK_TIMEOUT = "55P03";

/** The underlying driver error beneath drizzle's query wrapper (identified
 *  structurally — `.query` string + `.params` array — never by class name,
 *  which the minified release binary rewrites), or the value itself. */
export function unwrapDbError(err: unknown): unknown {
  if (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { query?: unknown }).query === "string" &&
    Array.isArray((err as { params?: unknown }).params) &&
    (err as { cause?: unknown }).cause !== undefined
  ) {
    return (err as { cause: unknown }).cause;
  }
  return err;
}

function errCode(err: unknown): string | null {
  const code = (unwrapDbError(err) as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Connection-lifecycle kill: the pool closed/rotated/timed out under the query.
 *  The statement may or may not have committed server-side, which is exactly-once
 *  safe here (in-txn dedupe + per-session advisory lock), so ONE retry is sound.
 *  57014 (a server-side statement_timeout cancel) is DELIBERATELY not kill-class:
 *  retrying a statement the server just proved too slow doubles the damage.
 *  ERR_POSTGRES_IDLE_TIMEOUT is likewise excluded — it means the POOL had nothing
 *  to give, and retrying into a full pool is the same mistake in a new costume. */
export function isKillClassDbError(err: unknown): boolean {
  const code = errCode(err);
  return code !== null && KILL_CODES.has(code);
}

/** The pool's checkout queue rejected this query: every connection was busy for
 *  longer than the acquire bound. This is CAPACITY, not a broken connection.
 *
 *  It must never be retried in-process (that adds load to a pool already proven
 *  to have none to spare — the 2026-08-05 outage was this exact amplifier: the
 *  code called it a kill, retried immediately, and every failure doubled the
 *  offered load). Surface it typed so the caller sheds and the cloud's durable
 *  replay picks the work up once there is capacity again. */
export function isPoolExhaustedDbError(err: unknown): boolean {
  return errCode(err) === POOL_EXHAUSTED_CODE;
}

/** SQLSTATE of a (possibly wrapped) server error, or null for anything else. */
export function dbSqlState(err: unknown): string | null {
  const errno = (unwrapDbError(err) as { errno?: unknown } | null)?.errno;
  if (typeof errno === "string" && errno) return errno;
  if (typeof errno === "number") return String(errno);
  return null;
}

/** Server cancelled the statement via statement_timeout (SQLSTATE 57014). */
export function isStatementTimeoutDbError(err: unknown): boolean {
  return dbSqlState(err) === SQLSTATE_STATEMENT_TIMEOUT;
}

/** Server refused a lock because lock_timeout elapsed (SQLSTATE 55P03). Raised
 *  only while WAITING — the statement never ran, so a retry is always sound. */
export function isLockTimeoutDbError(err: unknown): boolean {
  return dbSqlState(err) === SQLSTATE_LOCK_TIMEOUT;
}

/** PgBouncer-class poolers reject unknown startup parameters with this literal
 *  (genuine Postgres says "unrecognized configuration parameter" — no overlap).
 *  Other pooler families may phrase it differently; the README =0 row is the
 *  backstop. Callers apply this only to connection-class error paths (a probe /
 *  first-query-per-connection rejection), never as free-text over arbitrary
 *  RPC errors. */
export function isUnsupportedStartupParamError(err: unknown): boolean {
  const e = unwrapDbError(err);
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /unsupported startup parameter/i.test(msg);
}

/** Positional marker: the per-session advisory-lock ACQUISITION (the first
 *  statement of an ingest/tombstone txn) failed while WAITING for the lock —
 *  e.g. a live chunk queued behind a long same-session restore txn. Two server
 *  shapes reach here: 55P03 (lock_timeout — the bound the live pool now sets)
 *  and 57014 (statement_timeout, when the lock_timeout hatch is disengaged).
 *  Tagging at the await site is shape-proof (no `.query` sniffing); the txn
 *  rolled back atomically, so retrying it once is exactly-once safe. */
export class SessionLockTimeoutError extends Error {
  constructor(public readonly cause: unknown) {
    super("session_lock_timeout");
  }
}

/** Re-throw `err` as a SessionLockTimeoutError when the lock WAIT was bounded
 *  out — used by the try/catch that wraps ONLY the advisory-lock statement. */
export function tagLockTimeout(err: unknown): never {
  if (isLockTimeoutDbError(err) || isStatementTimeoutDbError(err)) {
    throw new SessionLockTimeoutError(err);
  }
  throw err;
}

/** True for the transient classes worth exactly one whole-operation retry: a
 *  connection-lifecycle kill, or ANY bounded-out lock WAIT.
 *
 *  55P03 is transient wherever in the transaction it fires, not only on the
 *  advisory lock the positional tag covers. lock_timeout is raised strictly
 *  while WAITING, so the statement never ran and the transaction rolled back
 *  atomically — a retry is sound by construction. This matters because the
 *  advisory lock is NOT the contended statement in practice: every concurrent
 *  ingest upserts the same user/org/project/repo dimension rows, and under load
 *  that row-lock contention is what trips the bound. Tagging only the advisory
 *  lock left those surfacing raw and un-retried, which held the post-deploy
 *  failure rate near 37% until this was widened.
 *
 *  A plain 57014 on a working statement is still NOT transient — the server
 *  proved that statement too slow, and retrying doubles the damage. Pool
 *  exhaustion is not transient either: the pool is the resource being retried
 *  FOR, so an immediate retry can only make it scarcer. */
export function isTransientDbError(err: unknown): boolean {
  if (isPoolExhaustedDbError(err)) return false;
  if (isLockTimeoutDbError(err)) return true;
  return isKillClassDbError(err) || err instanceof SessionLockTimeoutError;
}

/** Run `fn`; on a transient-class failure run it EXACTLY once more. `fn` must
 *  re-resolve its db handle itself so the retry lands on a post-rotation pool.
 *  Exactly-once holds at every call site via the in-txn dedupe key + the
 *  per-session advisory lock (a killed txn rolled back atomically). */
export async function retryOnceOnTransientDbError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // Report starvation before deciding: this is the only place every ingest
    // write path funnels through, and the healer cannot see the checkout queue
    // any other way (its probe holds its own connection).
    if (isPoolExhaustedDbError(err)) {
      signalPoolExhausted();
      throw err;
    }
    if (!isTransientDbError(err)) throw err;
    return await fn();
  }
}
