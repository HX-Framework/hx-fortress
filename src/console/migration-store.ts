// Where a storage migration's progress is recorded.
//
// The run row is what a resumed migration reads to know it is a resume, and the
// per-session rows are what let it skip work it has already PROVEN — proven
// meaning read back from the target and checksummed, never "we sent it".
//
// The daemon writes these; the console reads them. Neither table holds a
// credential or a bucket key: a run names its buckets and its sessions, and the
// material that binds the fortress to either lives in a 0600 file the command
// row only references.

import { sql } from "drizzle-orm";

import { sessionRef, type CopiedObject, type MigrationPhase, type MigrationResult } from "./migration";
import type { HxDb } from "../host/postgres/db";
import type { SessionKey } from "../modules/session-vault/store/types";

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

export async function startMigrationRun(
  db: HxDb,
  args: { mode: string; sourceBucket: string; targetBucket: string },
): Promise<string> {
  const result = await db.execute(
    sql`INSERT INTO hx.migration_runs (mode, source_bucket, target_bucket)
        VALUES (${args.mode}, ${args.sourceBucket}, ${args.targetBucket})
        RETURNING id`,
  );
  const id = rows<{ id: unknown }>(result)[0]?.id;
  if (typeof id !== "string") throw new Error("the fortress database accepted no migration run");
  return id;
}

/** The unfinished run for this pair of buckets, if there is one. A migration is
 *  resumed rather than restarted: the objects already in the target are the
 *  expensive part. */
export async function findResumableRun(
  db: HxDb,
  args: { sourceBucket: string; targetBucket: string },
): Promise<string | null> {
  const result = await db.execute(
    sql`SELECT id FROM hx.migration_runs
         WHERE finished_at IS NULL
           AND source_bucket = ${args.sourceBucket}
           AND target_bucket = ${args.targetBucket}
         ORDER BY started_at DESC
         LIMIT 1`,
  );
  const id = rows<{ id: unknown }>(result)[0]?.id;
  return typeof id === "string" ? id : null;
}

export async function recordCopiedObject(
  db: HxDb,
  runId: string,
  object: CopiedObject,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO hx.migration_objects (run_id, user_id, family, session_id, checksum, bytes)
        VALUES (${runId}::uuid, ${object.key.userId}, ${object.key.family}, ${object.key.sessionId},
                ${object.checksum}, ${object.bytes})
        ON CONFLICT (run_id, user_id, family, session_id) DO UPDATE
           SET checksum = EXCLUDED.checksum,
               bytes = EXCLUDED.bytes,
               copied_at = now()`,
  );
}

/** Sessions a previous attempt of THIS run proved. The engine still asks the
 *  target before trusting one: a record whose object is gone is a record about a
 *  bucket somebody emptied. */
export async function copiedSessions(db: HxDb, runId: string): Promise<Set<string>> {
  const result = await db.execute(
    sql`SELECT user_id AS "userId", family, session_id AS "sessionId"
          FROM hx.migration_objects WHERE run_id = ${runId}::uuid`,
  );
  return new Set(
    rows<{ userId: string; family: string; sessionId: string }>(result).map((row) =>
      sessionRef({ userId: row.userId, family: row.family, sessionId: row.sessionId }),
    ),
  );
}

export async function noteMigrationPhase(
  db: HxDb,
  runId: string,
  phase: MigrationPhase,
): Promise<void> {
  await db.execute(sql`UPDATE hx.migration_runs SET phase = ${phase} WHERE id = ${runId}::uuid`);
}

/**
 * Write what a run reached.
 *
 * `finished` is what makes the row invisible to findResumableRun, so only a
 * command that reached a terminal answer sets it: a copy that stopped before
 * the cut, and a swap that refused or threw, all leave the run OPEN. The
 * objects already in the target are the expensive part of a migration, and a
 * row closed early is a resume that starts from the first object again.
 *
 * `switched_at` and the counters are PRESERVED rather than rewritten whenever
 * the caller has nothing newer to say: a run that THREW reports no totals, and
 * a row that zeroed them would erase the progress the resume is about to use.
 */
export async function saveMigrationRun(
  db: HxDb,
  runId: string,
  args: { result: MigrationResult | null; error: string | null; finished: boolean },
): Promise<void> {
  const result = args.result;
  await db.execute(
    sql`UPDATE hx.migration_runs
           SET finished_at = ${args.finished ? sql`now()` : sql`finished_at`},
               status = ${
                 args.error
                   ? "failed"
                   : // A run that CUT OVER and then failed its verification is
                     // not aborted: `aborted` says nothing was switched, and the
                     // row would carry that word beside its own switched_at. It
                     // is a switch nobody has proven, and the name says which.
                     result?.switched && result.aborted
                     ? "switched_unverified"
                     : result?.aborted
                       ? "aborted"
                       : args.finished
                         ? "done"
                         : "running"
               },
               phase = ${result ? result.phase : sql`phase`},
               sessions_total = ${result ? result.sessionsTotal : sql`sessions_total`},
               sessions_copied = ${result ? result.sessionsCopied : sql`sessions_copied`},
               bytes_copied = ${result ? result.bytesCopied : sql`bytes_copied`},
               delta_passes = ${result ? result.deltaPasses : sql`delta_passes`},
               switched_at = ${result?.switched ? sql`now()` : sql`switched_at`},
               error = ${args.error ?? result?.aborted ?? result?.resumeFailed ?? null}
         WHERE id = ${runId}::uuid`,
  );
}

/**
 * Forget that these sessions were copied, so a RESUMED run carries them again.
 *
 * Not a delta pass — those decide from the live stores (`targetIsCurrent`) and
 * never read this table. The record is loaded once, into the `done` set at the
 * start of a run, and consulted by `copyMissing`; clearing it is what makes a
 * resumed run re-copy a session whose sidecar changed under it.
 *
 * A parked-artifact replay is the one writer that changes a sidecar without
 * appending the canonical, and every delta pass but the last decides what to
 * re-copy by comparing canonical length. Without this a session whose
 * `session.json` was replayed after its copy is skipped by those passes and,
 * on a run resumed under the same id, is never carried at all — invisibly,
 * because verification after the cut checks sidecars for presence (the target
 * is live by then, so it cannot compare their bytes). Within a single run the
 * replay is suppressed and the final in-pause pass hashes every sidecar; this
 * covers the resume.
 *
 * Across every run, not just the one in flight: the replay does not know which
 * run copied the session, and a stale record left behind for a run that is
 * resumed later is the same defect deferred.
 */
export async function forgetCopiedSessions(db: HxDb, keys: readonly SessionKey[]): Promise<number> {
  // Deduped first: the park holds one entry per COMMIT, so a busy session
  // contributes many identical keys, and each would otherwise be its own scan.
  const unique = new Map<string, SessionKey>();
  for (const key of keys) unique.set(sessionRef(key), key);
  if (unique.size === 0) return 0;

  // One statement rather than one per session. The predicate omits run_id, which
  // is the primary key's leading column, so every one of these is a sequential
  // scan — doing it once matters more than the statement being tidy.
  const tuples = [...unique.values()].map(
    (k) => sql`(${k.userId}, ${k.family}, ${k.sessionId})`,
  );
  const result = await db.execute(
    sql`DELETE FROM hx.migration_objects
         WHERE (user_id, family, session_id) IN (${sql.join(tuples, sql`, `)})`,
  );
  return affectedRows(result);
}

/** Rows Postgres reports as changed, across the shapes the driver returns. */
function affectedRows(result: unknown): number {
  const r = result as { rowCount?: unknown; count?: unknown } | null;
  if (typeof r?.rowCount === "number") return r.rowCount;
  if (typeof r?.count === "number") return r.count;
  return 0;
}
