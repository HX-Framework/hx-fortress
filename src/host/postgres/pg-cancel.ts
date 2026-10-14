// Deadline cancellation for the PG phase of a vault RPC.
//
// racePgPhase used to ABANDON a transaction that missed the caller's deadline:
// the promise was dropped, the statement kept running on its pooled connection
// until statement_timeout (30 s) or completion, the reindex limiter freed its
// slot while the work was still in flight, and the closure holding the chunk
// text stayed alive until the transaction finally settled — on 2026-10-13 that
// was what carried the fortress from 0.3 GB to 8.5 GB between restarts.
//
// Now the transaction learns which Postgres backend it runs on (pg_backend_pid,
// folded into the advisory-lock statement so it costs no extra round trip) and
// attaches it to the scope its caller created. When the deadline passes the
// scope cancels the backend's current statement with pg_cancel_backend from a
// dedicated one-connection client, and the transaction checks the scope between
// statements so it unwinds instead of starting the next one. The statement
// fails with SQLSTATE 57014, drizzle rolls the transaction back, the pooled
// connection is released, and the late failure is logged by the race's
// observer exactly as before.
//
// pg_cancel_backend, never pg_terminate_backend: terminating closes the pooled
// connection with a transaction open, and on Bun 1.3.14 that corrupts the
// pool's reservation counter (see the `idleTimeout` note in db.ts). Cancel
// keeps the connection and only aborts the statement.

import type { ScopedLogger } from "../types";
import { sanitizeDbError } from "./sanitize";
import { withDeadline } from "../with-deadline";

/** Cancel the current statement of one backend. Best effort, bounded, never
 *  throws into the caller's path. */
export type BackendCanceller = (pid: number) => Promise<void>;

/** Thrown by `throwIfCancelled` inside a transaction whose caller gave up, so
 *  the transaction rolls back instead of running its next statement. */
export class PgPhaseAbandonedError extends Error {
  constructor(public readonly tag: string) {
    super(`pg_phase_abandoned:${tag}`);
  }
}

export interface PgCancelScope {
  /** Register the backend a transaction is running on; returns the detach fn
   *  the transaction calls once its statements are done. A backend attached
   *  AFTER the deadline fired is cancelled on arrival. */
  attach(pid: number): () => void;
  /** True once the caller's deadline has passed. */
  cancelled(): boolean;
  /** Cooperative check between statements: throws PgPhaseAbandonedError once
   *  the deadline has passed, so the transaction unwinds (rollback) instead of
   *  starting work nobody is waiting for. */
  throwIfCancelled(): void;
  /** Cancel every attached backend's current statement. Idempotent. */
  cancel(): Promise<void>;
  /** Backends attached right now (tests, logs). */
  pids(): number[];
}

export function createPgCancelScope(
  tag: string,
  cancelBackend: BackendCanceller | null | undefined,
): PgCancelScope {
  const pids = new Set<number>();
  let cancelled = false;
  const fire = (pid: number): Promise<void> =>
    cancelBackend ? cancelBackend(pid).catch(() => {}) : Promise.resolve();
  return {
    attach(pid) {
      pids.add(pid);
      if (cancelled) void fire(pid);
      return () => {
        pids.delete(pid);
      };
    },
    cancelled: () => cancelled,
    throwIfCancelled() {
      if (cancelled) throw new PgPhaseAbandonedError(tag);
    },
    async cancel() {
      cancelled = true;
      await Promise.all([...pids].map(fire));
    },
    pids: () => [...pids],
  };
}

/** A scope that records nothing and cancels nothing — for call sites that run
 *  without a deadline (gateway HTTP ingest, repair passes). */
export const NO_CANCEL_SCOPE: PgCancelScope = {
  attach: () => () => {},
  cancelled: () => false,
  throwIfCancelled: () => {},
  cancel: async () => {},
  pids: () => [],
};

const CANCEL_STATEMENT_TIMEOUT_MS = 5_000;
const CANCEL_DEADLINE_MS = 6_000;

export interface BackendCancellerHandle {
  cancel: BackendCanceller;
  /** Detached, bounded close — call on shutdown. */
  close(): void;
}

/** A dedicated one-connection client that runs pg_cancel_backend. Its own
 *  connection, never a pool slot: the pool it cancels on behalf of may be the
 *  one that is saturated or wedged. Lazy — nothing connects until the first
 *  cancel — and bounded, so a cancel can never outlive the deadline it serves.
 *  The DSN is resolved per call because the provider may not be ready yet. */
export function createBackendCanceller(
  dsn: () => string | null,
  logger?: ScopedLogger,
  makeClient: (dsn: string) => Bun.SQL = (url) =>
    new Bun.SQL(url, {
      max: 1,
      idleTimeout: 0,
      connectionTimeout: 10,
      connection: { application_name: "hx-cancel", statement_timeout: CANCEL_STATEMENT_TIMEOUT_MS },
    }),
): BackendCancellerHandle {
  let client: Bun.SQL | null = null;
  return {
    async cancel(pid: number): Promise<void> {
      const url = dsn();
      if (!url) return;
      client ??= makeClient(url);
      try {
        const rows = (await withDeadline(
          client`select pg_cancel_backend(${pid}) as cancelled`,
          CANCEL_DEADLINE_MS,
          "pg_cancel_backend_deadline",
        )) as Array<{ cancelled: boolean }>;
        logger?.warn("pg phase cancelled at the deadline", {
          pid,
          cancelled: rows[0]?.cancelled ?? null,
        });
      } catch (err) {
        logger?.warn("pg phase cancel failed", { pid, error: sanitizeDbError(err) });
      }
    },
    close() {
      const c = client;
      client = null;
      if (c) void c.close({ timeout: 1 }).catch(() => {});
    },
  };
}
