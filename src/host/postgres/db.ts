import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";

import * as schema from "./schema";

// A Drizzle handle over Bun.SQL for the bundled hx-db. The gateway ingestion
// path uses this for typed queries/transactions; the migration runner keeps its
// own raw Bun.SQL exec (simple-query mode) and is bounded separately.
export type HxDb = BunSQLDatabase<typeof schema>;

/** The transaction handle drizzle hands to `db.transaction(tx => …)`. Helpers
 *  that run inside a commit accept this so they enlist in the same tx. */
export type HxTx = Parameters<Parameters<HxDb["transaction"]>[0]>[0];

/** Parse a millisecond env knob: unset or set-but-EMPTY means the default (an
 *  empty value in a template must never silently zero a safety bound); anything
 *  non-finite or negative also falls back. Values are truncated to integers. */
function msEnv(
  env: Record<string, string | undefined>,
  name: string,
  def: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : def;
}

/** Parse a positive-integer env knob (counts, not durations): unset,
 *  set-but-EMPTY, non-finite, or < 1 all fall back to the default. */
function countEnv(
  env: Record<string, string | undefined>,
  name: string,
  def: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : def;
}

/** Bun.SQL wants seconds for its lifecycle knobs; round up so a sub-second
 *  override still yields a bound (min 1 s) instead of 0 = disabled. */
const msToSec = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_LIFETIME_MS = 3_600_000;
const DEFAULT_POOL_MAX = 10;

// ---------------------------------------------------------------------------
// `idleTimeout` is the pool ACQUIRE timeout — read this before touching it.
//
// Bun.SQL's own typings (1.3.14, sql.d.ts):
//     idleTimeout?: number
//     "Maximum time in seconds to wait for connection to become available"
//     @default 0 (no timeout)
//
// It is NOT an idle-connection reaper. It bounds how long a query may sit in the
// pool's CHECKOUT QUEUE before being rejected with ERR_POSTGRES_IDLE_TIMEOUT.
//
// v0.17.0 set it to 60 s believing it recycled idle sockets. The real effect: on
// a saturated pool every query queued for a full minute and then failed, and
// "ERR_POSTGRES_IDLE_TIMEOUT: Idle timeout reached after 1m" became the signature
// of the 2026-08-05 ingest outage. That error means POOL EXHAUSTION — never a
// dead connection — and `pg-errors.ts` classifies it accordingly.
//
// The only correct calibration is against the caller's own deadline: the vault
// RPC abandons at FORTRESS_DB_RPC_DEADLINE_MS (default 25 s). This bound must be
// long enough to ride out a normal burst, and short enough that real exhaustion
// is rejected while the caller is still listening — a queue that outlives every
// request in it is pure waste that keeps the pool busy for the NEXT request too.
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;

// Lock-wait bound for the LIVE ingest pool (ms). The ingest transaction opens on
// `pg_advisory_xact_lock(session)`, and in Postgres a lock wait counts against
// statement_timeout. Without a separate, much shorter lock_timeout a live chunk
// queued behind a long same-session restore holds one of the pool's connections
// for the WHOLE 120 s statement budget while doing no work at all.
//
// That is the connection hoard that turned one slow commit into a pool-wide
// outage: the vault RPC gave up at 25 s but never cancels, so the blocked
// transaction kept its connection for the remaining ~95 s; the cloud then
// replayed the commit, and the replay queued behind it on the same lock. Failing
// the lock wait fast (SQLSTATE 55P03, tagged as SessionLockTimeoutError) makes
// the chunk cheap to retry and hands the connection straight back.
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

// The background pool (guarantor / reconciler) is deliberately tiny and SEPARATE.
// Its work is whole-transcript restores that hold the per-session advisory lock
// for a long time; sharing the live pool let one reconcile pass starve the write
// path. Two connections keep a restore and its title-correction pass moving while
// making it structurally impossible to spend the live ingest budget.
const DEFAULT_BG_POOL_MAX = 2;

/** Pool ACQUIRE bound for the background repair pool (ms).
 *
 *  Deliberately vastly longer than the live bound, because the two roles want
 *  opposite things. A live chunk has a caller and a tunnel deadline waiting on
 *  it, so shedding fast is correct — the cloud replays it. A guarantor repair
 *  has NOBODY waiting. Failing its checkout does not shed load, it DESTROYS
 *  work: the session stays stale, so the identical rebuild is attempted again
 *  next pass, and the pass after that, forever. Waiting is strictly cheaper
 *  than failing for this role.
 *
 *  Still finite. An unbounded queue turns a genuinely wedged pool into a pass
 *  that never returns, and the guarantor must stay observable — a pass that
 *  ends and reports is worth more than one that hangs. Five minutes is far
 *  above any healthy checkout and far below the hourly sweep interval. */
const DEFAULT_BG_ACQUIRE_TIMEOUT_MS = 300_000;

/** Statement bound for the background repair pool (ms).
 *
 *  A restore replays a whole transcript in ONE transaction — that is what makes
 *  a rebuild atomic, and atomicity is the only thing stopping a half-rebuilt
 *  session from being visible as complete. For a large session that transaction
 *  is legitimately long, and killing it at the live bound does not protect
 *  anything: the work is discarded, the session stays stale, and the identical
 *  rebuild is attempted again next pass. A bound that can never be satisfied is
 *  a permanent failure loop wearing a safety knob's clothes.
 *
 *  So the background role gets a budget sized to finish. It cannot squat the
 *  live path: it is a separate two-connection pool, and its lock_timeout stays
 *  short so it can never make a live writer wait. It stays well inside
 *  maxLifetime, which would otherwise rotate the connection mid-rebuild. */
const DEFAULT_BG_STATEMENT_TIMEOUT_MS = 600_000;

/** Headroom between the background statement budget and the connection's
 *  maxLifetime, so a rebuild that fits the budget is not guillotined by a
 *  rotation that was always going to arrive first. */
const BG_LIFETIME_MARGIN_MS = 60_000;

// Server-side statement bound for the LIVE INGEST pool (ms).
//
// The shared 120 s budget is right for the read path (hx_text_occurrences is a
// deliberately uncapped corpus count) and for background restores (a whole
// transcript replayed in one transaction). It is badly wrong for live ingest,
// because the vault RPC abandons at FORTRESS_DB_RPC_DEADLINE_MS (25 s) and
// racePgPhase never cancels: a commit nobody is waiting for any more kept its
// pooled connection for up to another 95 s. That is why, once lock contention
// was removed, the dominant remaining failure in production was the pool's own
// acquire bound — connections held by transactions that had already lost their
// caller.
//
// 30 s sits just ABOVE the RPC deadline, so the caller still wins the race and
// returns a typed error, and the server then reclaims the connection ~5 s later
// instead of ~95 s. Live chunks are deltas measured in milliseconds, so this is
// enormous headroom for them. The one shape that can exceed it — a
// whole-transcript writeCanonical producer — is exactly the shape whose failure
// path is already safe: the canonical is persisted first, the RPC acks anyway,
// and the guarantor rebuilds the index on the BACKGROUND pool, which keeps the
// long budget. Fully or not at all, with the safety net doing the retry.
const DEFAULT_INGEST_STATEMENT_TIMEOUT_MS = 30_000;

/** Which workload a pool serves. The three differ in how much they may spend and
 *  how long they may block — never in what they may see. */
export type HxPoolRole = "rw" | "ro" | "bg";

/** Effective server-side statement_timeout (ms). `0` means OMIT the startup
 *  parameter entirely — the pooled-DSN escape hatch: PgBouncer-class poolers
 *  reject unknown startup parameters, so `FORTRESS_DB_STATEMENT_TIMEOUT_MS=0`
 *  must strip it from EVERY consumer (shared pools, the guarded-db probe
 *  canary, and the embed worker's own longer override). lock_timeout rides the
 *  same hatch — a pooler that rejects one startup param rejects both. */
export function statementTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return msEnv(env, "FORTRESS_DB_STATEMENT_TIMEOUT_MS", DEFAULT_STATEMENT_TIMEOUT_MS);
}

/** Pool checkout-queue bound (ms) — see the DEFAULT_ACQUIRE_TIMEOUT_MS note.
 *  `0` ⇒ default: an unbounded checkout queue is what let the outage hide. */
export function acquireTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = msEnv(env, "FORTRESS_DB_ACQUIRE_TIMEOUT_MS", DEFAULT_ACQUIRE_TIMEOUT_MS);
  return raw > 0 ? raw : DEFAULT_ACQUIRE_TIMEOUT_MS;
}

/** Live-ingest lock-wait bound (ms). `0` ⇒ OMIT lock_timeout, falling back to
 *  the statement_timeout behaviour — an explicit escape hatch for an operator
 *  who would rather wait than shed, not a value that can be blanked by accident. */
export function lockTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return msEnv(env, "FORTRESS_DB_LOCK_TIMEOUT_MS", DEFAULT_LOCK_TIMEOUT_MS);
}

/** Connection ceiling for the live rw/ro pools. */
export function poolMax(env: Record<string, string | undefined> = process.env): number {
  return countEnv(env, "FORTRESS_DB_POOL_MAX", DEFAULT_POOL_MAX);
}

/** Server-side statement_timeout (ms) for the live ingest pool. Falls back to
 *  the shared statement timeout when set to 0 or when the shared one is disabled
 *  (=0 pooler hatch), so a single knob still strips every startup parameter. */
export function ingestStatementTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = msEnv(env, "FORTRESS_DB_INGEST_STATEMENT_TIMEOUT_MS", DEFAULT_INGEST_STATEMENT_TIMEOUT_MS);
  return raw > 0 ? raw : DEFAULT_INGEST_STATEMENT_TIMEOUT_MS;
}

/** Lock-wait bound for the BACKGROUND pool (ms). Longer than the live one — a
 *  restore is worth queueing for — but bounded, so a repair blocked behind live
 *  ingest sheds and retries on the next sweep instead of holding a connection
 *  the sweep needs. `0` omits it (unbounded), the pre-fix behaviour. */
export function backgroundLockTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return msEnv(env, "FORTRESS_DB_BG_LOCK_TIMEOUT_MS", 15_000);
}

/** Connection ceiling for the background (guarantor) pool. */
/** Acquire bound for the background pool — see DEFAULT_BG_ACQUIRE_TIMEOUT_MS.
 *  0 ⇒ default: a background sweep may wait a long time, never forever. */
export function backgroundAcquireTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = msEnv(env, "FORTRESS_DB_BG_ACQUIRE_TIMEOUT_MS", DEFAULT_BG_ACQUIRE_TIMEOUT_MS);
  return raw > 0 ? raw : DEFAULT_BG_ACQUIRE_TIMEOUT_MS;
}

/** Statement bound for background repair — see DEFAULT_BG_STATEMENT_TIMEOUT_MS.
 *  The =0 pooler hatch still wins: when the shared bound is disabled, no startup
 *  parameters are sent at all and this is not consulted. */
/** The effective maxLifetime (ms) — the same resolution hxPoolOptions performs,
 *  exposed so the background budget can be clamped under it. */
function lifetimeMsFor(env: Record<string, string | undefined>): number {
  const raw = msEnv(env, "FORTRESS_DB_MAX_LIFETIME_MS", DEFAULT_MAX_LIFETIME_MS);
  return raw > 0 ? raw : DEFAULT_MAX_LIFETIME_MS;
}

export function backgroundStatementTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = msEnv(env, "FORTRESS_DB_BG_STATEMENT_TIMEOUT_MS", DEFAULT_BG_STATEMENT_TIMEOUT_MS);
  return raw > 0 ? raw : DEFAULT_BG_STATEMENT_TIMEOUT_MS;
}

export function backgroundPoolMax(
  env: Record<string, string | undefined> = process.env,
): number {
  return countEnv(env, "FORTRESS_DB_BG_POOL_MAX", DEFAULT_BG_POOL_MAX);
}

/** Postgres startup parameters — millisecond GUCs, passed verbatim to Bun.SQL.
 *  An open record (not a closed interface) because Bun types this slot as
 *  `Record<string, string | number | boolean>`; the two keys the fortress sets
 *  are `statement_timeout` (always) and `lock_timeout` (live ingest pool only —
 *  absent means lock waits stay bounded by statement_timeout, the pre-fix
 *  behaviour that let one blocked chunk hold a connection for two minutes). */
export type HxStartupParams = Record<string, number>;

export interface HxPoolOptions {
  /** Seconds — Bun.SQL's unit for the three lifecycle knobs. */
  connectionTimeout: number;
  /** Seconds. Bun's name for the pool ACQUIRE timeout, NOT an idle reaper —
   *  see the DEFAULT_ACQUIRE_TIMEOUT_MS note above before changing it. */
  idleTimeout: number;
  /** Hard rotation: Bun kills a connection (mid-query included — the txn rolls
   *  back atomically) once it reaches this age, which is what heals a poisoned
   *  pool against a healthy server even if nothing else fires. */
  maxLifetime: number;
  max: number;
  /** Startup parameters. statement_timeout (ms) bounds every statement
   *  server-side — the only per-query bound Bun.SQL offers (it has no client
   *  per-query timeout); lock_timeout bounds just the lock waits inside it.
   *  Absent entirely when the =0 escape hatch is set. */
  connection?: HxStartupParams;
}

/** The shared pool options every fortress Bun.SQL client derives from
 *  (component 1 of the PG-layer resilience design). Constructor-only — the DSN
 *  itself is never mutated.
 *
 *  Env knobs (ms; set-but-empty ⇒ default): FORTRESS_DB_CONNECT_TIMEOUT_MS
 *  (default 10 000; 0 ⇒ default — a connect bound may never be disabled),
 *  FORTRESS_DB_STATEMENT_TIMEOUT_MS (default 120 000; 0 ⇒ omit the startup
 *  params — pooler escape hatch), FORTRESS_DB_MAX_LIFETIME_MS (default
 *  3 600 000 — one hour: rotation is the last-resort healer behind the probe's
 *  ~3 min rebuild path, and a guarantor RESTORE of a giant session replays the
 *  whole transcript in one transaction, which must fit inside one connection
 *  lifetime (a 106 MB session hit the old 10 min wall on day one);
 *  0 ⇒ default — never disableable), FORTRESS_DB_ACQUIRE_TIMEOUT_MS (default
 *  10 000; 0 ⇒ default — an unbounded checkout queue is never correct),
 *  FORTRESS_DB_LOCK_TIMEOUT_MS (default 5 000; 0 ⇒ omit lock_timeout),
 *  FORTRESS_DB_POOL_MAX (default 10), FORTRESS_DB_BG_POOL_MAX (default 2). */
export function hxPoolOptions(
  env: Record<string, string | undefined> = process.env,
  overrides: {
    max?: number;
    statementTimeoutMs?: number;
    /** Set lock_timeout on this pool (live ingest only). */
    lockTimeoutMs?: number;
    /** Override the checkout bound (background repair waits far longer). */
    acquireTimeoutMs?: number;
  } = {},
): HxPoolOptions {
  const connectRaw = msEnv(env, "FORTRESS_DB_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS);
  const connectMs = connectRaw > 0 ? connectRaw : DEFAULT_CONNECT_TIMEOUT_MS;
  const lifetimeRaw = msEnv(env, "FORTRESS_DB_MAX_LIFETIME_MS", DEFAULT_MAX_LIFETIME_MS);
  const lifetimeMs = lifetimeRaw > 0 ? lifetimeRaw : DEFAULT_MAX_LIFETIME_MS;
  const baseStatementMs = statementTimeoutMs(env);
  // =0 omits the params for EVERY consumer — an override (the embed worker's
  // 300 s) applies only while the hatch is not engaged.
  const effectiveStatementMs =
    baseStatementMs === 0 ? 0 : Math.trunc(overrides.statementTimeoutMs ?? baseStatementMs);
  const options: HxPoolOptions = {
    connectionTimeout: msToSec(connectMs),
    idleTimeout: msToSec(overrides.acquireTimeoutMs ?? acquireTimeoutMs(env)),
    maxLifetime: msToSec(lifetimeMs),
    max: overrides.max ?? poolMax(env),
  };
  if (effectiveStatementMs > 0 && Number.isInteger(effectiveStatementMs)) {
    const connection: HxStartupParams = { statement_timeout: effectiveStatementMs };
    // lock_timeout rides the same =0 hatch: it is a startup parameter too, so a
    // pooler that rejects statement_timeout rejects this one identically.
    const lockMs = Math.trunc(overrides.lockTimeoutMs ?? 0);
    if (lockMs > 0 && Number.isInteger(lockMs)) connection.lock_timeout = lockMs;
    options.connection = connection;
  }
  return options;
}

/** Pool options for one workload. The live write path sheds lock waits fast; the
 *  read path never takes the per-session advisory lock so it needs no
 *  lock_timeout; the background pool is small, so a reconcile pass can queue on
 *  itself but never on the write path's connections. */
export function hxPoolOptionsFor(
  role: HxPoolRole,
  env: Record<string, string | undefined> = process.env,
): HxPoolOptions {
  // Background repair needs a lock bound too. It HOLDS the per-session advisory
  // lock while rebuilding, which is why it gets a longer statement budget — but
  // it also WAITS for that lock whenever live ingest holds the same session, and
  // unbounded that wait squats one of only a couple of connections for the whole
  // statement budget. Two such waits exhaust the pool and the sweep starves
  // itself: exactly the "Idle timeout reached after 10s" that stalled the first
  // stale-repair pass in production. Longer than the live bound (a restore is
  // worth waiting for) but nowhere near the statement budget.
  if (role === "bg") {
    return hxPoolOptions(env, {
      max: backgroundPoolMax(env),
      lockTimeoutMs: backgroundLockTimeoutMs(env),
      // A repair has no caller and no deadline. Shedding its checkout does not
      // relieve pressure, it throws the work away and guarantees the identical
      // attempt next pass — see DEFAULT_BG_ACQUIRE_TIMEOUT_MS.
      acquireTimeoutMs: backgroundAcquireTimeoutMs(env),
      // Sized to FINISH a large single-transaction rebuild rather than kill it
      // (see DEFAULT_BG_STATEMENT_TIMEOUT_MS) — but an operator who LOWERS the
      // fortress-wide bound is protecting a shared Postgres, and background
      // repair must not be quietly exempt from that. So the background budget
      // applies only while it is the more permissive reading of a default
      // shared bound; an explicitly lowered shared bound wins.
      // …and never above what a connection can survive. maxLifetime is measured
      // from ESTABLISHMENT, not from statement start, and Bun kills the
      // connection mid-query when it elapses — so a statement budget larger than
      // the connection lifetime guarantees that some rebuilds are guillotined
      // part-way regardless. Clamping keeps the budget honest when an operator
      // shortens maxLifetime.
      statementTimeoutMs: Math.min(
        statementTimeoutMs(env) < DEFAULT_STATEMENT_TIMEOUT_MS
          ? statementTimeoutMs(env)
          : backgroundStatementTimeoutMs(env),
        // Never below what the LIVE path gets. `Math.max(1, …)` avoided a zero
        // (which would omit the parameter entirely) but produced something
        // worse: a 60 s maxLifetime yielded a 1 ms budget, so every background
        // statement died instantly with 57014 and all repair stopped, silently.
        // A short connection lifetime is a reason to cap the budget, never a
        // reason to make repair impossible.
        Math.max(ingestStatementTimeoutMs(env), lifetimeMsFor(env) - BG_LIFETIME_MARGIN_MS),
      ),
    });
  }
  if (role === "ro") return hxPoolOptions(env);
  // Live ingest: bound the statement near the caller's own deadline so an
  // abandoned commit stops occupying a connection, and bound the lock wait well
  // under that so a blocked chunk is cheap to retry.
  //
  // The ingest bound only ever TIGHTENS the shared one, never loosens it: an
  // operator who lowers FORTRESS_DB_STATEMENT_TIMEOUT_MS is bounding the whole
  // fortress and must not find the write path quietly exempt, and the =0 pooler
  // hatch must still strip every startup parameter.
  const shared = statementTimeoutMs(env);
  return hxPoolOptions(env, {
    lockTimeoutMs: lockTimeoutMs(env),
    statementTimeoutMs: shared === 0 ? 0 : Math.min(shared, ingestStatementTimeoutMs(env)),
  });
}

/** One DSN-free log line describing an effective pool (boot diagnostics): the
 *  host only (never userinfo/path), plus the knobs that matter in an incident. */
export function describePool(dsn: string, options: HxPoolOptions): Record<string, unknown> {
  let host = "unparseable";
  try {
    host = new URL(dsn).hostname;
  } catch {
    // keep the placeholder — the DSN itself must never reach a log line
  }
  return {
    host,
    connectionTimeoutS: options.connectionTimeout,
    // Named for what it does, not for Bun's misleading option name.
    acquireTimeoutS: options.idleTimeout,
    maxLifetimeS: options.maxLifetime,
    max: options.max,
    statementTimeoutMs: options.connection?.statement_timeout ?? "omitted",
    lockTimeoutMs: options.connection?.lock_timeout ?? "omitted",
  };
}

export function createHxDb(dsn: string, options: HxPoolOptions = hxPoolOptions()): HxDb {
  return drizzle(new Bun.SQL(dsn, options), { schema });
}

export interface PurgeDb {
  db: HxDb;
  /** Detached, bounded, rejection-observed close — call in `finally`. */
  close: () => void;
}

/** Dedicated short-lived client for one purge invocation: NO statement_timeout
 *  startup param and NO maxLifetime, deliberately. An oversized purge statement
 *  must be allowed to finish server-side even after the cloud abandons the RPC
 *  at 30 s (zombie-convergence: the next parked retry finds `complete: true`);
 *  the shared pools' statement timeout / hard rotation would convert that into a
 *  never-converging park loop that re-burns the same delete work every 2 min. */
export function createPurgeDb(dsn: string): PurgeDb {
  const client = new Bun.SQL(dsn, { max: 1, connectionTimeout: 10 });
  return {
    db: drizzle(client, { schema }),
    close: () => {
      void client.close({ timeout: 5 }).catch(() => {});
    },
  };
}
