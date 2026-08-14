// Corpus health detectors: pure SQL over what the fortress already records, no
// object-store reads. Each one exists because a specific damage class is
// invisible to the guarantor's own gates, and each one is written down HERE
// rather than living in an operator's ad-hoc query, because every ad-hoc version
// of these got the scoping wrong at least once.
//
// THREE TRAPS. Every detector below observes all three; the tests assert them.
//
//  1. `hx.ingest_events` holds BOTH `hx.session.updated` (a parent commit) and
//     `hx.session.agent.updated` (an agent-lane commit). A lane's `totalBytes`
//     is ITS OWN canonical's size. Aggregating both per session compares a
//     parent's watermark against a different object entirely and invents gaps
//     that do not exist — on the reference deployment that produced a phantom
//     8.2 GB, more than the whole corpus.
//
//  2. Repair writes (`chunk_id like 'reconcile%'`) must be INCLUDED in a byte
//     sum, never filtered out. A repair is `replace: true` over the whole
//     canonical, so its `byteCount` IS the closed gap. Excluding them re-opens
//     on paper every gap the guarantor already fixed: 70 of 73 flagged sessions
//     and 97% of the flagged bytes were already repaired.
//
//  3. `payload` is a jsonb STRING scalar, not an object (see the note in
//     schema/analysis.ts). `payload -> 'chunk'` silently yields NULL; the text
//     must be unwrapped with `#>> '{}'` and re-parsed first.
//
//  5. GROUP ON THE ROW FK, never on the external session id. Session identity is
//     (user, family, session_id); the external id alone is NOT unique. On the
//     reference deployment 7 external ids are shared by two rows each; all 7 are the
//     same user with two FAMILIES, and 2 of them hold two distinct non-null orgs (5
//     if a NULL org counts as a value — which is how an earlier revision of this
//     comment reached "six", overstating it ~3x).
//     Grouping on the external id merges those sessions' byte accounting across an
//     org boundary — it corrupts the arithmetic and puts two orgs' data in one
//     finding. hx.ingest_events.session_id is the row FK and is non-null on all
//     277,518 events, so there is never a reason to group on the external id.
//
//     A caveat this makes explicit: an epoch boundary is a whole-canonical WRITE.
//     A `reconcile` repair writes only to the database and never touches the store,
//     yet records byteCount == totalBytes. Treating that as a boundary is correct
//     for GAP detection (the index does hold the whole canonical as of then) but it
//     must never be read as evidence that the OBJECT is free of duplicated records.
//
//  4. A byte sum must be scoped to the canonical's CURRENT epoch. A commit whose
//     `byteCount` equals its `totalBytes` wrote the WHOLE object (a first chunk,
//     or any `replace`), so every byteCount recorded before it belongs to an
//     object that no longer exists. Summing across that boundary makes `indexed`
//     overshoot `claimed` and the row goes BLIND — and since every repair is a
//     `replace`, the old whole-history sum got blinder each time the guarantor
//     fixed something. On the reference deployment this hid 3 damaged parents
//     holding 91.5 MB of gap, and left 34.7% of rows unjudgeable; epoch-scoping
//     brings that to 0.4%.
//
// A detector that reports nothing is not automatically right. Where a metric is
// STRUCTURALLY BLIND, it says so in its own result rather than reporting zero.

import { sql as dsql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";

/** One chunk's byte accounting, as the fortress recorded it. */
const CHUNK = dsql`
  select
    e.session_id as sid,
    -- Lane identity: ingestAgentCommit spreads agentId onto the payload's TOP
    -- level, and a parent commit has none. PARTITIONING on it is what closes
    -- trap 1. The first version closed that trap by FILTERING lanes out instead,
    -- which quietly made every agent transcript unjudgeable -- 9,334 rows, and
    -- six of them hold real deficits nothing else detects.
    coalesce(((e.payload #>> '{}')::jsonb ->> 'agentId'), '') as lane,
    e.created_at as at,
    ((e.payload #>> '{}')::jsonb -> 'chunk' ->> 'byteCount')::bigint  as byte_count,
    ((e.payload #>> '{}')::jsonb -> 'chunk' ->> 'totalBytes')::bigint as total_bytes
  from hx.ingest_events e
  where e.event_type in ('hx.session.updated', 'hx.session.agent.updated')
`;

/** Per-lane byte accounting, scoped to the canonical's current epoch (trap 4). */
const SCOPED = dsql`
  with ev as (${CHUNK}),
  marked as (
    select ev.*, max(case when byte_count = total_bytes then at end)
                   over (partition by sid, lane) as epoch_at
    from ev
  )
  select sid, lane, max(total_bytes) as claimed, sum(byte_count) as indexed
  from marked
  where epoch_at is null or at >= epoch_at
  group by sid, lane
`;

export interface ByteGapRow {
  /** hx.sessions.id — the ROW id. Not the client's external session id, which is
   *  not unique and whose duplicates span orgs (trap 5). */
  sessionId: string;
  /** The agent lane, or null for the parent transcript. A lane is a SEPARATE
   *  canonical object with its own row and its own turns, so a lane gap is its
   *  own repair — rebuilding the parent re-derives none of it. */
  agentId: string | null;
  /** Canonical bytes the fortress never handed to the parser. */
  unindexedBytes: number;
}

export interface ByteGapReport {
  /** Sessions where the canonical provably holds bytes that were never parsed. */
  rows: ByteGapRow[];
  totalUnindexedBytes: number;
  /** Rows this metric CANNOT judge: the byte sum still overshoots the canonical
   *  inside the current epoch, so a gap can never show. Reported because "0 gaps"
   *  over a blind majority is not a clean bill of health. Epoch-scoping took this
   *  from ~35% of the corpus to 0.4%; what remains is clients that re-send
   *  overlapping ranges under fresh chunk ids. */
  blindSessions: number;
}

/** Sessions whose canonical grew by more than the chunks that were indexed.
 *
 *  This is the ONLY cheap detector for the dropped-write class: the gateway acks
 *  once the canonical is composed and defers the Postgres write, so a dropped
 *  write leaves the bytes in object storage and nothing in the database. The
 *  next chunk then stamps the full watermark and numbers seq from max+1, leaving
 *  the lane byte-covering AND seq-dense — invisible to the orphan scan, the byte
 *  gate and the gap scan alike. */
export async function detectByteGaps(db: HxDb, limit = 200): Promise<ByteGapReport> {
  // ONE statement, so the SCOPED CTE is evaluated once. Running the rows query and
  // the blind count separately cost two full evaluations — ~5.1 s each — which is most
  // of why a pass with health signals on cost 13-18 s, not the ~4 s first claimed.
  const [agg] = (await db.execute(dsql`
    with agg as (${SCOPED})
    select
      (select count(*)::int from agg where indexed > claimed) as blind,
      coalesce(
        (select json_agg(row_to_json(g)) from (
          select sid, lane, (claimed - indexed)::bigint as gap
          from agg
          where claimed is not null and indexed is not null and claimed > indexed
          order by (claimed - indexed) desc
          limit ${limit}
        ) g),
        '[]'::json
      ) as rows
  `)) as unknown as Array<{
    blind: number;
    rows: Array<{ sid: string; lane: string; gap: string | number }> | null;
  }>;
  const rows = agg?.rows ?? [];

  const out = (Array.isArray(rows) ? rows : []).map((r) => ({
    sessionId: String(r.sid),
    agentId: r.lane ? String(r.lane) : null,
    unindexedBytes: Number(r.gap),
  }));
  return {
    rows: out,
    totalUnindexedBytes: out.reduce((n, r) => n + r.unindexedBytes, 0),
    blindSessions: Number(agg?.blind ?? 0),
  };
}

export interface DuplicateRow {
  sessionId: string;
  /** Turns beyond one copy of each source record. */
  extraTurns: number;
}

/** Sessions holding the same source record indexed by MORE THAN ONE commit.
 *
 *  The count sweep cannot see this: its oracle is a lower bound, so it treats
 *  `actual >= expected` as healthy and stamps such a session VERIFIED.
 *
 *  Identity is the source record's own `uuid`, not a content hash. A content
 *  hash is wrong twice over: `classify.ts` gives every content block of a record
 *  the same `raw`, so a k-block record legitimately yields k identical rows; and
 *  it projects distinct blocks (attachment notices, images with NULL text) to
 *  the same literal string, so genuinely different events collide.
 *
 *  Copies written by ONE commit are excluded: `ingestCommit` stamps a single
 *  `now` on every row it writes, so a shared `created_at` means one commit, and
 *  a record legitimately repeated inside one chunk is the canonical's content,
 *  not an indexing fault.
 *
 *  Identity carries a BLOCK ORDINAL, derived per commit from `seq`. Without it a
 *  k-block record re-sent once counts 2k-1 excess rows instead of k: the i-th
 *  block is only ever comparable with the i-th block of another commit. That
 *  ordinal is also why no schema change is needed to make this exact.
 *
 *  Lanes are INCLUDED (`agent_id` is part of the partition, not a filter): an
 *  agent transcript duplicates exactly the same way, and the earlier
 *  parents-only form could not see it. */
export async function detectCrossCommitDuplicates(db: HxDb, limit = 200): Promise<DuplicateRow[]> {
  const rows = (await db.execute(dsql`
    with ord as (
      select
        t.session_id,
        t.agent_id,
        (t.raw_event #>> '{}')::jsonb ->> 'uuid' as uid,
        t.created_at,
        row_number() over (
          partition by t.session_id, t.agent_id,
                       (t.raw_event #>> '{}')::jsonb ->> 'uuid', t.created_at
          order by t.seq
        ) as blk
      from hx.turns t
    ),
    rec as (
      select session_id, agent_id, uid, blk,
             count(distinct created_at) as commits,
             count(*) as copies
      from ord
      where uid is not null
      group by 1, 2, 3, 4
    )
    select session_id, sum(copies - 1)::int as extra
    from rec
    where copies > 1 and commits > 1
    group by 1
    order by sum(copies - 1) desc
    limit ${limit}
  `)) as unknown as Array<{ session_id: string; extra: number }>;
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    sessionId: String(r.session_id),
    extraTurns: Number(r.extra),
  }));
}

/** Live rows the count sweep can never prove, because their canonical exceeds
 *  the read cap. Not damage — but a corpus is not "verified" while these exist,
 *  and they are deliberately left unstamped so they stay visible. */
export async function countUnjudgeableBySize(db: HxDb, capBytes: number): Promise<number> {
  const [r] = (await db.execute(dsql`
    select count(*)::int as n from hx.sessions
    where deleted_at is null and bytes_uploaded > ${capBytes}
  `)) as unknown as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}

export interface UncompactedRow {
  sessionId: string;
  agentId: string | null;
  /** Highest compose componentCount the fortress ever recorded for this object. */
  componentCount: number;
}

/** Canonicals whose GCS compose component count ran away from the compaction
 *  threshold.
 *
 *  GcsStore rewrites in place at COMPACT_THRESHOLD (800) so the counter resets,
 *  and the code's own header states compose caps out at 1024 — so a count far
 *  above the threshold means compaction did not happen, and the object is walking
 *  toward a ceiling where compose starts failing outright.
 *
 *  This is NOT a data-loss detector: on the reference deployment all 18 such rows
 *  were byte-intact (13 provably clean, 1 with a separately-tracked 16 KB gap, 4
 *  unjudgeable). It exists because SIX lanes reached 2,938 — 3.7x the threshold,
 *  strictly +1 per append with no reset in the object's whole life — and nothing
 *  reported it for weeks. An un-compacted canonical must never again be silent.
 *
 *  Reads the count the STORE returned, as recorded per commit, so it observes
 *  whatever actually wrote the object rather than assuming which implementation
 *  did. */
export async function detectUncompactedCanonicals(
  db: HxDb,
  threshold: number,
  limit = 200,
): Promise<UncompactedRow[]> {
  const rows = (await db.execute(dsql`
    with ev as (
      select
        e.session_id as sid,
        coalesce(((e.payload #>> '{}')::jsonb ->> 'agentId'), '') as lane,
        ((e.payload #>> '{}')::jsonb -> 'chunk' ->> 'componentCount')::bigint as cc
      from hx.ingest_events e
      where e.chunk_id not like 'reconcile%'
    )
    select sid, lane, max(cc) as cc
    from ev
    where cc is not null
    group by sid, lane
    having max(cc) >= ${threshold}
    order by max(cc) desc
    limit ${limit}
  `)) as unknown as Array<{ sid: string; lane: string; cc: string | number }>;
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    sessionId: String(r.sid),
    agentId: r.lane ? String(r.lane) : null,
    componentCount: Number(r.cc),
  }));
}

/** The lane separator inside a composite natural key (`sid` vs
 *  `sid:a:agentExternalId`). Defined here — the lowest module that emits such
 *  keys — and imported by the reconciler, so the two can never disagree. */
export const AGENT_LANE = ":a:";

export interface DuplicatedSessionKey {
  userExternalId: string;
  family: string;
  /** Parent form `sid`, or lane form `sid:a:agentExternalId` when the duplicates
   *  live in that agent lane — the same shape the store listing and the
   *  reconciler's forced-candidate set use, so a lane's duplicates force THAT
   *  LANE's rebuild. Keying lanes by their parent looks converged in a test and
   *  does nothing real: a parent rebuild never touches lane rows, so the lane
   *  would stay flagged on every scan forever (2,356 of the 22,301 excess turns
   *  on the reference deployment are lane-held). */
  sessionId: string;
}

/** The NATURAL keys of parent sessions and agent lanes holding cross-commit
 *  duplicates, for the reconciler to force through a whole-canonical rebuild.
 *
 *  Same oracle as detectCrossCommitDuplicates — block-ordinal identity, lanes
 *  included — but keyed the way the repair path addresses a canonical rather
 *  than by row id.
 *
 *  A rebuild converges the index to parse(whole canonical), which is correct in
 *  BOTH cases and is why this is safe to force: where the canonical is clean the
 *  duplicate turns disappear for good, and where the OBJECT itself repeats the
 *  record the rebuild re-indexes it identically — and, because a rebuild
 *  re-inserts every turn under one created_at, the cross-commit oracle stops
 *  flagging that lane after its one rebuild instead of churning it daily.
 *  (Nothing on the write path prevents NEW duplicates yet; until that guard
 *  exists, this scan's cadence also bounds a fresh one's lifetime.) What a
 *  rebuild must never do is leave the index BELOW parse(canonical): the count
 *  sweep reads that as missing records and would rebuild every hour forever.
 *  Converging to the parse is precisely what avoids that. */
export async function duplicatedSessionKeys(
  db: HxDb,
  limit = 500,
): Promise<DuplicatedSessionKey[]> {
  const rows = (await db.execute(dsql`
    with ord as (
      select
        t.session_id,
        t.agent_id,
        (t.raw_event #>> '{}')::jsonb ->> 'uuid' as uid,
        t.created_at,
        row_number() over (
          partition by t.session_id, t.agent_id,
                       (t.raw_event #>> '{}')::jsonb ->> 'uuid', t.created_at
          order by t.seq
        ) as blk
      from hx.turns t
    ),
    rec as (
      select session_id, agent_id, uid, blk,
             count(distinct created_at) as commits, count(*) as copies
      from ord where uid is not null group by 1, 2, 3, 4
    ),
    dup as (
      select distinct session_id, agent_id from rec where copies > 1 and commits > 1
    )
    select u.external_id as ext, s.family as family,
           case when dup.agent_id is null then s.session_id
                else s.session_id || ${AGENT_LANE} || a.agent_external_id end as sid
    from dup
    join hx.sessions s on s.id = dup.session_id
    join hx.users u on u.id = s.user_id
    left join hx.session_agents a
      on a.id = dup.agent_id and a.deleted_at is null
    where s.deleted_at is null
      and (dup.agent_id is null or a.id is not null)
    limit ${limit}
  `)) as unknown as Array<{ ext: string; family: string; sid: string }>;
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    userExternalId: String(r.ext),
    family: String(r.family),
    sessionId: String(r.sid),
  }));
}
