// Permanent session deletion — the fortress-side half of the cloud-initiated
// hard delete. Two responsibilities:
//
//   1. Tombstones (hx.deleted_sessions): written FIRST, before any destructive
//      step, and consulted by every ingest surface (gateway routes + the
//      ingestCommit RPCs) so a deleted session can never be re-uploaded — the
//      hx client's identity is client-reconstructible and its upload paths are
//      upsert-shaped, so without the tombstone a delete silently undoes itself.
//
//   2. Postgres purge: batched hard-delete of everything keyed to the session.
//      Most tables cascade from hx.sessions; the three that do not are handled
//      explicitly — hx.embeddings (polymorphic owner, no FK — the A7 orphan
//      hazard), hx.ingest_events and hx.analysis_facts (both ON DELETE SET
//      NULL, which would retain identifiers/excerpts).
//
// Batching: turns are deleted in bounded batches (each with its embeddings, in
// the same txn) under a soft deadline so one RPC call always fits the tunnel's
// 30 s window; the RPC is idempotent and the cloud re-calls until `complete`.

import { and, eq, inArray, sql } from "drizzle-orm";

import type { HxDb, HxTx } from "../host/postgres/db";
import { tagLockTimeout } from "../host/postgres/pg-errors";
import {
  hxAnalysisFacts,
  hxDeletedSessions,
  hxIngestEvents,
  hxSessions,
  hxTurns,
  hxUsers,
} from "../host/postgres/schema";
import { hxChunkIntents } from "../host/postgres/schema/analysis";
import { hxEmbeddings } from "../host/postgres/schema/embeddings";
import type { SessionKey } from "../modules/session-vault/store/types";

/** Base session id of a possibly agent-lane-composite id ("sid:a:agent" → "sid"). */
export function baseSessionId(sessionId: string): string {
  const i = sessionId.indexOf(":");
  return i === -1 ? sessionId : sessionId.slice(0, i);
}

/** The advisory-lock identity for a session — cross-family on the BASE session
 *  id so parent + agent lanes + the tombstone all serialize on ONE key. Fed to
 *  pg_advisory_xact_lock via hashtextextended() (M2). */
export function sessionLockKey(userExternalId: string, sessionId: string): string {
  return `${userExternalId}:${baseSessionId(sessionId)}`;
}

/** Record the tombstone. Idempotent; safe to call before the session ever
 *  existed here (a delete can arrive for a session this fortress never saw). */
export async function markSessionDeleted(db: HxDb, key: SessionKey): Promise<void> {
  await db.transaction(async (tx) => {
    // M2: take the same per-session advisory lock ingest takes, so the tombstone
    // write serializes against an in-flight ingest/reconcile for this session —
    // tombstone-first ordering + the in-lock ingest re-check closes the
    // resurrect-and-re-embed window. A 57014 that cancels the lock WAIT (queued
    // behind a long same-session txn) is tagged positionally so callers can
    // park/retry it as transient rather than as a statement failure.
    await tx
      .execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${sessionLockKey(key.userId, key.sessionId)}, 0))`,
      )
      .catch(tagLockTimeout);
    await tx
      .insert(hxDeletedSessions)
      .values({
        userExternalId: key.userId,
        family: key.family,
        sessionId: baseSessionId(key.sessionId),
      })
      .onConflictDoNothing();
  });
}

/** True when (user, sessionId) is tombstoned in ANY family. Cross-family on
 *  purpose: child-lane/sidecar uploads can carry a stale family (the cloud
 *  repairs it via the session row, which no longer exists after a delete), so
 *  an exact-family match would let a stale-family upload slip past the guard. */
export async function isSessionDeleted(
  db: HxDb | HxTx,
  userExternalId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await db
    .select({ sessionId: hxDeletedSessions.sessionId })
    .from(hxDeletedSessions)
    .where(
      and(
        eq(hxDeletedSessions.userExternalId, userExternalId),
        eq(hxDeletedSessions.sessionId, baseSessionId(sessionId)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Hard-delete embeddings owned by the given turn ids (polymorphic owner — no
 *  FK cascade reaches them). Probes for the gated hx.embeddings relation so a
 *  non-pgvector fortress (0006 skipped) stays safe. Mirrors the replace-path
 *  helper in ingest.ts. */
async function deleteEmbeddingsFor(tx: HxTx, turnIds: string[]): Promise<void> {
  if (turnIds.length === 0) return;
  const reg = await tx.execute(sql`SELECT to_regclass('hx.embeddings') AS rel`);
  const rows = Array.isArray(reg) ? reg : ((reg as { rows?: unknown[] }).rows ?? []);
  const present = (rows[0] as { rel?: string | null } | undefined)?.rel != null;
  if (!present) return;
  await tx
    .delete(hxEmbeddings)
    .where(and(eq(hxEmbeddings.ownerKind, "turn"), inArray(hxEmbeddings.ownerId, turnIds)));
}

export interface PgPurgeResult {
  /** Every Postgres row for the session is gone. */
  complete: boolean;
  deletedTurns: number;
}

const TURN_BATCH = 500;

/** Batched Postgres purge of one session. Each batch is its own transaction
 *  (turns + their embeddings together); stops early at `deadlineMs` and reports
 *  `complete: false` so the caller re-invokes. The final transaction deletes
 *  ingest_events + analysis_facts (SET NULL FKs — would otherwise survive with
 *  identifiers/excerpts) and the session row itself (cascades session_agents,
 *  tool_calls, session_facts, analysis_run_sessions). */
export async function purgeSessionPg(
  db: HxDb,
  key: SessionKey,
  deadlineMs: number,
): Promise<PgPurgeResult> {
  const sid = baseSessionId(key.sessionId);
  const user = (
    await db
      .select({ id: hxUsers.id })
      .from(hxUsers)
      .where(eq(hxUsers.externalId, key.userId))
      .limit(1)
  )[0];
  // No dimension row → this fortress never ingested the user; nothing to purge.
  if (!user) return { complete: true, deletedTurns: 0 };

  const session = (
    await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .where(
        and(
          eq(hxSessions.userId, user.id),
          eq(hxSessions.family, key.family),
          eq(hxSessions.sessionId, sid),
        ),
      )
      .limit(1)
  )[0];
  if (!session) return { complete: true, deletedTurns: 0 };

  let deletedTurns = 0;
  for (;;) {
    const batch = await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(hxTurns)
        .where(
          inArray(
            hxTurns.id,
            tx
              .select({ id: hxTurns.id })
              .from(hxTurns)
              .where(eq(hxTurns.sessionId, session.id))
              .limit(TURN_BATCH),
          ),
        )
        .returning({ id: hxTurns.id });
      await deleteEmbeddingsFor(
        tx,
        deleted.map((d) => d.id),
      );
      return deleted.length;
    });
    deletedTurns += batch;
    if (batch < TURN_BATCH) break;
    if (Date.now() >= deadlineMs) return { complete: false, deletedTurns };
  }

  await db.transaction(async (tx) => {
    await tx.delete(hxIngestEvents).where(eq(hxIngestEvents.sessionId, session.id));
    // Events whose FK was already nulled (or never linked) still carry the
    // client session id string in session_id_ext — match those too.
    await tx
      .delete(hxIngestEvents)
      .where(
        and(
          eq(hxIngestEvents.userId, user.id),
          eq(hxIngestEvents.sessionIdExt, sid),
          eq(hxIngestEvents.family, key.family),
        ),
      );
    await tx.delete(hxAnalysisFacts).where(eq(hxAnalysisFacts.sessionId, session.id));
    // chunk_intents has NO FK to hx.sessions — it is keyed on the natural identity —
    // so no cascade reaches it and its rows survive the purge still carrying the
    // user's external id, the family and the session id. In a service whose
    // permanent-delete is a residency contract, that is exactly the residue this
    // function exists to remove. Not scoped to a lane: every lane's intents belong to
    // this session.
    await tx
      .delete(hxChunkIntents)
      .where(
        and(
          eq(hxChunkIntents.userExternalId, key.userId),
          eq(hxChunkIntents.family, key.family),
          eq(hxChunkIntents.sessionId, sid),
        ),
      );
    // Cascades: session_agents, turns (any stragglers), tool_calls,
    // session_facts, analysis_run_sessions.
    await tx.delete(hxSessions).where(eq(hxSessions.id, session.id));
  });
  return { complete: true, deletedTurns };
}
