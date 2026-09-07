// Durable intent records for chunks whose bytes are composed but whose turns may
// not be indexed. See migration 0017 for the failure this closes.
//
// The contract is small on purpose:
//
//   record  — before the ack, outside any transaction, never fatal
//   clear   — inside the transaction that indexes the chunk
//   stale   — uncleared and old enough that the deferred write is not merely
//             still in flight
//
// The remedy for a stale intent is NOT a chunk replay. The canonical already
// holds the bytes, so it is enough to make the guarantor LOOK at that session;
// its whole-canonical repair does the rest. That is why nothing here stores
// chunk text and why staging objects need no retention.

import { and, eq, inArray, isNotNull, isNull, lt, lte, sql as dsql } from "drizzle-orm";

import type { HxDb, HxTx } from "../host/postgres/db";
import { hxChunkIntents } from "../host/postgres/schema/analysis";

export interface ChunkIntent {
  userExternalId: string;
  family: string;
  sessionId: string;
  /** Set for an agent-lane chunk; omit or null for a parent chunk. */
  agentExternalId?: string | null;
  chunkId: string;
  totalBytes: number;
}

/** Record that a chunk's bytes are in the canonical, before acking the client.
 *
 *  MUST NOT throw into the caller. The bytes are already durable, so failing the
 *  upload over a bookkeeping row would trade a recoverable indexing gap for an
 *  unrecoverable client-side one — strictly worse. A failure here degrades to the
 *  previous behaviour: the drop stays invisible, which is what we had before. */
export async function recordChunkIntent(db: HxDb, intent: ChunkIntent): Promise<void> {
  await db
    .insert(hxChunkIntents)
    .values({
      userExternalId: intent.userExternalId,
      family: intent.family,
      sessionId: intent.sessionId,
      agentExternalId: intent.agentExternalId ?? null,
      chunkId: intent.chunkId,
      totalBytes: intent.totalBytes,
    })
    // A retried or replayed chunk id is not an error.
    .onConflictDoNothing();
}

/** Mark a chunk indexed. Called INSIDE the ingest transaction, so "cleared"
 *  means exactly "its turns committed" — if that transaction rolls back, the
 *  intent stays open and the guarantor will act on it. */
export async function clearChunkIntent(
  tx: HxTx,
  intent: Pick<ChunkIntent, "userExternalId" | "family" | "sessionId" | "chunkId"> & {
    agentExternalId?: string | null;
  },
  now: string,
): Promise<void> {
  const agent = intent.agentExternalId ?? null;
  await tx
    .update(hxChunkIntents)
    .set({ clearedAt: now })
    .where(
      and(
        eq(hxChunkIntents.userExternalId, intent.userExternalId),
        eq(hxChunkIntents.family, intent.family),
        eq(hxChunkIntents.sessionId, intent.sessionId),
        eq(hxChunkIntents.chunkId, intent.chunkId),
        agent === null
          ? isNull(hxChunkIntents.agentExternalId)
          : eq(hxChunkIntents.agentExternalId, agent),
        isNull(hxChunkIntents.clearedAt),
      ),
    );
}

/** Sessions with an intent still open past `olderThanMs`.
 *
 *  The grace period matters: the index write is deferred by design, so a
 *  just-recorded intent is normal. Only one that outlives an ingest cycle means
 *  the write is gone rather than pending. Returns natural session identities —
 *  the guarantor turns these into repair candidates.
 *
 *  Distinct on the LANE, not the chunk: several dropped chunks of one lane need
 *  one repair, not several. The agent id is carried because a lane is a separate
 *  canonical with its own turns — forcing only its parent would repair the wrong
 *  object and leave the lane short. */
export async function staleIntentSessions(
  db: HxDb,
  olderThanMs: number,
  limit = 200,
): Promise<
  Array<{ userExternalId: string; family: string; sessionId: string; agentExternalId: string | null }>
> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  // OLDEST FIRST, and one row per lane. A LIMIT with no ORDER BY returns an arbitrary
  // subset, so an intent that can never resolve (a short-read session, a tombstoned
  // one, one whose canonical is gone) could crowd out resolvable ones
  // nondeterministically and starve the very signal this table exists to carry.
  // Migration 0017's index comment already promised this ordering; the query never did
  // it.
  //
  // GROUP BY rather than DISTINCT: Postgres rejects `select distinct … order by x`
  // unless x is in the select list, and ordering by the lane's OLDEST intent is what
  // "oldest first" actually means when a lane has several.
  const rows = await db
    .select({
      userExternalId: hxChunkIntents.userExternalId,
      family: hxChunkIntents.family,
      sessionId: hxChunkIntents.sessionId,
      agentExternalId: hxChunkIntents.agentExternalId,
      oldest: dsql<string>`min(${hxChunkIntents.createdAt})`,
    })
    .from(hxChunkIntents)
    .where(and(isNull(hxChunkIntents.clearedAt), lt(hxChunkIntents.createdAt, cutoff)))
    .groupBy(
      hxChunkIntents.userExternalId,
      hxChunkIntents.family,
      hxChunkIntents.sessionId,
      hxChunkIntents.agentExternalId,
    )
    .orderBy(dsql`min(${hxChunkIntents.createdAt}) asc`)
    .limit(limit);
  return rows.map((r) => ({
    userExternalId: r.userExternalId,
    family: r.family,
    sessionId: r.sessionId,
    agentExternalId: r.agentExternalId ?? null,
  }));
}

/** How many intents are open past the grace period — the operator-facing number.
 *  Non-zero means chunks reached object storage and their turns did not. */
export async function countStaleIntents(db: HxDb, olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const [r] = (await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(hxChunkIntents)
    .where(and(isNull(hxChunkIntents.clearedAt), lt(hxChunkIntents.createdAt, cutoff)))) as Array<{
    n: number;
  }>;
  return Number(r?.n ?? 0);
}

/** Clear every open intent for a lane that a whole-canonical write SUBSUMES.
 *
 *  THE BUG THIS FIXES. clearChunkIntent matches on chunk_id, and every repair path
 *  invents its own (`reconcile-full:`, `reconcile-tail:`, `reconcile-count:`). So a
 *  repair cleared an intent that never existed and left the CLIENT's intent open —
 *  the very intent that selected the session. `staleIntentSessions` then returned it
 *  on every pass, forever: a whole-canonical read, a hard delete of every turn, a
 *  re-insert and a full re-embed, hourly, for a session that was already correct.
 *  Nothing else pruned the table, and the forced-repair path is deliberately exempt
 *  from FORTRESS_GUARANTOR_REPAIR_STALE, so an operator had no way to stop it.
 *
 *  Bounded by `indexedTotalBytes` rather than clearing everything, because a chunk
 *  composed AFTER the guarantor read the canonical is genuinely not in what was just
 *  indexed. Its intent carries a larger total_bytes and must stay open — otherwise
 *  this fix would erase the one signal that catches a dropped write. */
export async function clearSubsumedChunkIntents(
  tx: HxTx,
  intent: Pick<ChunkIntent, "userExternalId" | "family" | "sessionId"> & {
    agentExternalId?: string | null;
  },
  indexedTotalBytes: number,
  now: string,
): Promise<number> {
  const agent = intent.agentExternalId ?? null;
  const rows = await tx
    .update(hxChunkIntents)
    .set({ clearedAt: now })
    .where(
      and(
        eq(hxChunkIntents.userExternalId, intent.userExternalId),
        eq(hxChunkIntents.family, intent.family),
        eq(hxChunkIntents.sessionId, intent.sessionId),
        agent === null
          ? isNull(hxChunkIntents.agentExternalId)
          : eq(hxChunkIntents.agentExternalId, agent),
        isNull(hxChunkIntents.clearedAt),
        lte(hxChunkIntents.totalBytes, indexedTotalBytes),
      ),
    )
    .returning({ id: hxChunkIntents.id });
  return Array.isArray(rows) ? rows.length : 0;
}

/** Close every OPEN intent for a lane whose index can NEVER land (D3) — distinct
 *  from clear/subsume, which mean "indexed". This means "will never index, so stop
 *  grinding": a tombstoned session, a canonical confirmed ABSENT (never uploaded /
 *  lost — the 79c37445 parent-durability bug), or an agent lane whose PARENT
 *  canonical is confirmed absent. Marked with a terminal `clearedAt` so
 *  pruneClearedChunkIntents GCs it and staleIntentSessions stops returning it.
 *
 *  The caller MUST have proven the terminal condition POSITIVELY (a `statCanonical`
 *  → null, a tombstone row) — NEVER inferred from a transient store/list failure,
 *  or this erases the one signal that catches a dropped write. Bounded to the lane. */
export async function closeTerminalChunkIntents(
  db: HxDb,
  lane: {
    userExternalId: string;
    family: string;
    sessionId: string;
    agentExternalId: string | null;
  },
  now: string,
): Promise<number> {
  const rows = await db
    .update(hxChunkIntents)
    .set({ clearedAt: now })
    .where(
      and(
        eq(hxChunkIntents.userExternalId, lane.userExternalId),
        eq(hxChunkIntents.family, lane.family),
        eq(hxChunkIntents.sessionId, lane.sessionId),
        lane.agentExternalId === null
          ? isNull(hxChunkIntents.agentExternalId)
          : eq(hxChunkIntents.agentExternalId, lane.agentExternalId),
        isNull(hxChunkIntents.clearedAt),
      ),
    )
    .returning({ id: hxChunkIntents.id });
  return Array.isArray(rows) ? rows.length : 0;
}

/** Drop cleared intents older than `olderThanMs`.
 *
 *  The table had no DELETE anywhere in src/ or scripts/, so it grew forever at
 *  9,844-20,547 commits/day (~5M rows/year), each holding a user external id, a
 *  family and a session id. In a service whose permanent-delete is a residency
 *  contract, that is identifiers surviving a purge. */
export async function pruneClearedChunkIntents(
  db: HxDb,
  olderThanMs: number,
  nowMs: number,
  batch = 5_000,
): Promise<number> {
  const cutoff = new Date(nowMs - olderThanMs).toISOString();
  // Bounded per call: an unbounded DELETE over a table that grows at
  // 9,844-20,547 rows/day becomes one very large transaction the first time it runs.
  // The pass is hourly, so a batch this size drains a year of backlog in days without
  // ever holding a long write.
  const rows = await db
    .delete(hxChunkIntents)
    .where(
      inArray(
        hxChunkIntents.id,
        db
          .select({ id: hxChunkIntents.id })
          .from(hxChunkIntents)
          .where(and(isNotNull(hxChunkIntents.clearedAt), lt(hxChunkIntents.clearedAt, cutoff)))
          .limit(batch),
      ),
    )
    .returning({ id: hxChunkIntents.id });
  return Array.isArray(rows) ? rows.length : 0;
}
