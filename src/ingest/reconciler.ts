// Component G — the fortress-side guarantor + full-restore engine (MC-2606).
//
// Scans the store for canonical transcripts that have NO hx.sessions row (the
// row-less state that caused the title incident) and re-runs the FULL ingest
// over each — rebuilding the row, turn/FTS indexes, tool_calls, session_facts,
// dimensions, embeddings (async, via signalEmbedWork), and the real title (the
// tier-A cascade). It also runs the title corrective pass over existing
// fallback/empty-title rows. This makes "canonical-without-row" a state the
// fortress cannot durably remain in, and — with Component C (which restores the
// known set WITH attribution first) — restores the existing backlog.
//
// Re-ingest uses `replace: true` (a complete lane rebuild from the whole
// canonical, never an append) and `recovered: true` (org attribution is unknown
// here → left null / never demotes a real org). Paced, single-flight is the
// caller's responsibility (the scheduler), non-throwing per session.

import { sanitizeDbError } from "../host/postgres/sanitize";
import { and, eq, gt, isNotNull, isNull, sql as dsql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessionAgents, hxSessions } from "../host/postgres/schema/sessions";
import { hxTurns } from "../host/postgres/schema/transcript";
import { hxUsers } from "../host/postgres/schema/dimensions";
import type { CanonicalEntry, SessionKey, SessionStore } from "../modules/session-vault/store/types";
import { correctTitles } from "./correct-titles";
import { isSessionDeleted } from "./delete";
import {
  IndexAdvancedError,
  LanePrefixMismatchError,
  ingestAgentCommit,
  ingestCommit,
} from "./ingest";
import { pruneClearedChunkIntents, staleIntentSessions } from "./intents";
import type { HxIngestChannel } from "../host/postgres/schema/sessions";

/** Provenance for a row the reconciler recovered — never 'tunnel', which would
 *  make an unverified session eligible for raw-id residency disclosure. */
const RECONCILED_CHANNEL: HxIngestChannel = "reconciled";
import { parseChunk } from "./parse";
import { maxCanonicalBytes, maxRepairBytes } from "../modules/session-vault/store/limits";
import {
  AGENT_LANE,
  detectByteGaps,
  detectUncompactedCanonicals,
  duplicatedSessionKeys,
} from "./health";
import { countCanonicalHeldDuplicateRecords } from "./dedupe-guard";
import { recordIntegrityFinding } from "./findings";

export interface ReconcileOptions {
  /** Delay between orphan re-ingests, ms — paces store I/O + the embed queue. */
  batchDelayMs?: number;
  /** Cap on orphans re-ingested this pass (0/undefined = no cap). */
  maxOrphans?: number;
  /** True while the LIVE pool is starved. Repair is the lower-priority workload
   *  by definition — nobody is waiting on it — so when live ingest is struggling
   *  the guarantor stands down for the rest of the pass and picks up on the next
   *  one rather than adding its own load to a database already short of
   *  connections. Waiting an hour costs nothing; competing costs live chunks. */
  isSaturated?: () => boolean;
  /** How long a chunk intent may stay open before the guarantor treats it as a
   *  lost index write, ms. The index write is deferred by design, so a
   *  just-recorded intent is normal; only one that outlives an ingest cycle is
   *  evidence. `0` disables the check. */
  intentGraceMs?: number;
  /** Sessions the count sweep proves per pass (0 disables it).
   *
   *  The sweep costs ONE canonical read per session, which is why it is capped
   *  and incremental rather than a whole-corpus scan: it works oldest-verified
   *  first and rotates through the corpus over many passes. */
  deepVerifyPerPass?: number;
  /** Run the corpus health detectors at the end of the pass and report their
   *  findings on the result. Measured at ~4s over a 6k-session / 277k-event
   *  corpus, so it is per-pass affordable — but OFF by default because
   *  reconcileOrphans is shared and a caller that never asked for a full-corpus
   *  scan must not silently pay for one. */
  healthSignals?: boolean;
  /** Force parent sessions and agent lanes holding cross-commit duplicates
   *  through a whole-canonical rebuild. Requested by the guarantor on a cadence
   *  (first sweep after boot, then roughly daily), never per-pass: the oracle is
   *  a window over every turn in the corpus (87 s on the reference deployment)
   *  and a rebuild re-embeds the lanes it touches. Convergence is one-shot per
   *  lane — a rebuild re-inserts all turns under one created_at, so even a
   *  canonical that genuinely repeats a record stops being flagged after its one
   *  rebuild. Nothing on the write path prevents NEW duplicates yet, so this
   *  scan's cadence is also what bounds a fresh one's lifetime. */
  repairDuplicates?: boolean;
  /** Also run the title corrective pass (default true). */
  correctExistingTitles?: boolean;
  /** Re-ingest sessions whose indexed byte count no longer matches their
   *  canonical. Default TRUE — a session the fortress holds but has only half
   *  indexed is exactly what the guarantor exists to repair. The pass counts them
   *  either way, so turning this off leaves detection intact. */
  repairStaleIndexes?: boolean;
  /** Append only the missing tail instead of rebuilding the whole session, when
   *  the index is cleanly behind its canonical. Default true. Every tail repair
   *  is VERIFIED and escalated to a full rebuild if it did not land perfectly, so
   *  turning this off is a performance choice, never a correctness one. */
  repairTails?: boolean;
  /** Refuse to repair when the stale fraction exceeds this share of the corpus
   *  (default 0.25). A correct byte comparison flags a minority; a BROKEN one
   *  flags nearly everything, and mass re-ingest is the one outcome that must
   *  never happen by accident. The pass logs and reports instead. */
  staleRepairCeiling?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: {
    warn?(message: string, fields?: Record<string, unknown>): void;
    info?(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface ReconcileResult {
  scanned: number;
  /** Canonicals examined this pass with no indexed row — NOT a damage count.
   *  It includes empty canonicals re-examined every pass (subtract
   *  `emptyCanonicals`) and failed restores that will retry. Alert on
   *  `noOpRepairs` / `integrityFailures` / `restored`, never on this. */
  orphans: number;
  restored: number;
  skippedTombstoned: number;
  /** Agent lanes deferred this pass because their parent re-ingest threw — they
   *  retry on the next sweep. A persistently-nonzero value flags a parent that
   *  never re-ingests (e.g. an unreadable canonical). */
  deferred: number;
  errors: number;
  titlesCorrected: number;
  /** Repairs that appended only the missing tail. */
  repairedTail: number;
  /** Repairs that rebuilt the whole session from the canonical. */
  repairedFull: number;
  /** Tail repairs whose post-repair verification failed AND which could not be
   *  explained as parser statefulness (that case is `laneDrift`). Escalated to a
   *  full rebuild — unless the canonical grew mid-iteration, where the
   *  escalation is DEFERRED instead (a paired `liveRaces` says so), because
   *  rebuilding from pre-growth text would delete content.
   *
   *  A persistently non-zero value means the incremental path really is
   *  mis-slicing. Disable it with the `repairTails` reconcile option. */
  verifyFallbacks: number;
  /** Sessions STILL not fully indexed after a full rebuild — the only outcome
   *  that leaves damage behind. Each one is logged with its id at error level. */
  integrityFailures: number;
  /** Rebuilds that indexed EVERY byte the store handed back, densely, while the
   *  store's own stat still reports a larger object. The index is complete with
   *  respect to the read; the read and the stat disagree.
   *
   *  Two known producers. A canonical holding bytes that are not valid UTF-8:
   *  `readCanonicalText` decodes to a JS string and the rebuild records
   *  `Buffer.byteLength` of the RE-ENCODED text, which for a lossy round-trip
   *  differs from the object size `statCanonical` reports. And a read that
   *  returns short (a truncated or capped download).
   *
   *  Kept apart from `integrityFailures` because no rebuild can ever clear it —
   *  scoring it as damage buries the real signal under a permanent floor, and
   *  every pass would spend another full rebuild proving the same thing. A
   *  non-zero value means investigate the STORE, not the indexer. */
  shortReads: number;
  /** Times this pass stood down because the LIVE pool was saturated. Not an
   *  error — the guarantor yielding to the workload that has a caller waiting.
   *  Persistently non-zero means live ingest is under sustained pressure. */
  yieldedToLive: number;
  /** Sessions whose record count was PROVEN against their canonical this pass
   *  (the count sweep). Progress, not damage — it is the denominator for the
   *  three counters below. */
  deepVerified: number;
  /** Sessions holding FEWER turns than their canonical parses to — records that
   *  are genuinely missing, which the byte gate cannot see because the lane is
   *  still seq-dense and byte-covering.
   *
   *  Scope, stated precisely because the weaker claim is the true one: this is a
   *  LOWER-BOUND check. parseChunk is stateful across the text, so an
   *  append-built lane legally holds MORE than parse(whole) and that direction
   *  proves nothing. It therefore detects missing records; it does NOT detect
   *  duplication (that lands in `deepOvercount`, unactioned) and it does NOT
   *  detect a watermark stamped larger than what was indexed when the turns
   *  themselves are intact. Those need their own oracles. */
  deepMismatched: number;
  /** Deep-verify mismatches that a rebuild then made whole (count now exact). */
  deepRepaired: number;
  /** Mismatches DETECTED but deliberately not repaired this pass (ceiling or
   *  budget). Reported separately because a refusal must never read as a clean
   *  pass: the 2026-08-10 starvation was invisible precisely because
   *  `deepMismatched` and `deepRepaired` could disagree with nothing naming it. */
  deepRefused: number;
  /** Deep verifications that could not be completed (unreadable canonical,
   *  transient DB error). NOT stamped, so they are retried next pass. */
  deepErrors: number;
  /** Sessions selected because a chunk intent stayed OPEN past the grace period —
   *  its bytes reached the canonical and its turns never reached the index.
   *
   *  This is the only signal for that class: the damage is invisible to every
   *  other gate, because the next chunk stamps the full byte watermark and
   *  continues `seq` from max+1, leaving the lane byte-covering AND seq-dense. A
   *  non-zero value means deferred index writes are being lost — look for a
   *  Postgres incident or a restart during ingest. */
  staleIntents: number;
  /** Rows the sweep declined to judge because their canonical is AHEAD of the
   *  index — the byte-staleness gate's business, not the sweep's. Not damage,
   *  but it is why a backlog can sit still: without this counter a stuck
   *  backlog has no visible cause in the pass log. */
  skippedBehind: number;
  /** Tail repairs that landed EXACTLY (prefix + tail, dense, byte-covering) yet
   *  still differ from a whole-canonical parse, because parseChunk suppresses
   *  more when it sees the text in one piece. Expected and benign on collapsing
   *  families (Codex, essentially every assistant turn) — recorded so the
   *  divergence between the search index and the whole-parse read view stays
   *  visible rather than silent. */
  laneDrift: number;
  /** Lanes holding MORE turns than parse(whole) yields. Reported, never acted
   *  on: parseChunk is stateful across the text, so an append-built lane legally
   *  holds the SUM of per-chunk parses, which is >= parse(whole). This counter
   *  is therefore expected to be non-zero on a healthy corpus and is NOT a
   *  damage signal — detecting genuine duplication needs its own oracle. */
  deepOvercount: number;
  /** Sessions + lanes not yet CHECKED against their canonical's record count, or
   *  `null` when this pass did not measure it (sweep disabled, stood down for
   *  load, or the count query failed).
   *
   *  What zero does and does not mean. Zero means every live row has been
   *  checked and none was found short of the records its canonical parses to.
   *  It does NOT mean "provably whole": the check is a lower bound, so a row
   *  holding the right COUNT of the wrong content, or duplicated content, passes
   *  it. Read it as "nothing observed missing", which is a real and previously
   *  unavailable guarantee, not as a proof of wholeness.
   *
   *  Nullable deliberately — "not measured" must never render as `0`, because a
   *  saturated pass printing `0` would read as the strongest possible claim
   *  after having checked nothing at all. It rises again as new sessions
   *  arrive: they are unchecked until checked. */
  deepVerifyBacklog: number | null;
  /** The part of `deepVerifyBacklog` that can NEVER be verified, because the
   *  canonical exceeds the read cap. `backlog - floor` is the convergeable work;
   *  a backlog that stalls AT the floor is finished, not stuck. `null` when the
   *  backlog was not measured. */
  deepVerifyFloor: number | null;
  /** Corpus byte-gap signal, or null when the pass did not ask for it. Rows whose
   *  canonical provably holds bytes that were never parsed — the ONLY cheap
   *  detector for the dropped-write class, which is byte-covering and seq-dense
   *  and therefore invisible to every other gate. */
  byteGapRows: number | null;
  byteGapBytes: number | null;
  /** Rows the gap metric cannot judge. Reported so "0 gaps" is never mistaken for
   *  "0 gaps over the whole corpus". */
  byteGapBlind: number | null;
  /** Canonicals whose compose component count ran past the compaction threshold.
   *  Not damage — a ceiling and cost risk that was completely unreported. */
  uncompactedCanonicals: number | null;
  /** Cleared intents deleted this pass, or null when the pass did not ask. */
  intentsPruned: number | null;
  /** Rebuild candidates — parent sessions and agent lanes — forced because they
   *  hold cross-commit duplicates, or null when the pass did not ask. */
  duplicatedSessions: number | null;
  /** Lanes whose CANONICAL OBJECT itself holds a record in more than one
   *  block-run (§7b) — measured during a whole-canonical rebuild, the only
   *  moment the parse is in hand. A lower bound (an immediately-adjacent
   *  re-send merges into one run). Facts about the object: recorded to
   *  hx.integrity_findings, never "fixed" — canonicals are not rewritten. */
  canonicalHeldDuplicates: number;
  /** Orphaned turn-embeddings deleted this pass (hx.embeddings has no FK, so
   *  every rebuild strands the replaced turns' rows), or null when the pass
   *  did not run sweep-grade hygiene or the table is absent (no pgvector). */
  embeddingsPruned: number | null;
  /** Repairs the no-clobber guard REFUSED because a live row was already there —
   *  the guard working as intended, not a defect. Counted apart from noOpRepairs
   *  so the bug signal stays a bug signal. */
  protectedSkips: number;
  /** Canonicals that genuinely contain no events, already restored, left alone.
   *  Neither damage nor work — recorded so an unexpected volume is visible. */
  emptyCanonicals: number;
  /** Repairs whose commit reported it did NOT apply — a dedupe hit or a guard.
   *  This is the counter that would have surfaced the constant-repair-key freeze
   *  on its first pass instead of a week later; a non-zero value means the
   *  guarantor believes it repaired something and did nothing. */
  noOpRepairs: number;
  /** Tail repairs refused because the lane did not hold the prefix the slice was
   *  cut from — a regressed byte count or a rewritten canonical. Escalates to a
   *  full rebuild, which is canonical-faithful by construction. */
  prefixMismatches: number;
  /** Existing sessions whose canonical size the store did not report, so
   *  completeness could not be judged at all. Counted so "we checked nothing"
   *  can never read as "we found nothing". */
  unjudgeable: number;
  /** Canonicals the sweep refused to read because they exceed
   *  `maxCanonicalBytes()`. Kept SEPARATE from `unjudgeable`, which means "the
   *  store did not report a size at all" — the two are different conditions with
   *  different remedies (raise the cap vs investigate the store), and folding
   *  them made the same physical state count under two different names depending
   *  on which loop observed it.
   *
   *  A non-zero value means some sessions have NO completeness oracle. They are
   *  deliberately excluded from the backlog rather than stamped, because a
   *  stamped over-cap session is a session hidden forever. */
  tooLargeToJudge: number;
  /** Canonicals refused by the repair read bound that have NO row at all — i.e. never
   *  indexed, permanently, because the repair path is the only thing that would have
   *  indexed them. Kept separate from tooLargeToJudge, which means the far milder
   *  "indexed already, just not re-verified this pass". */
  oversizedUnindexed: number;
  /** Tail repairs abandoned because a live commit advanced the lane while the
   *  sweep was working. Not damage and not an error — the live write is the more
   *  current truth, and the next pass re-checks. */
  liveRaces: number;
  /** Sessions whose PARENT lane has a hole in its seq — turns missing from the
   *  MIDDLE, which a byte comparison cannot see (bytes_uploaded still matches the
   *  canonical). Counted and repaired by full rebuild; a hole cannot be appended
   *  away. */
  gappedLanes: number;
  /** Sessions whose row exists but whose indexed byte count differs from the
   *  canonical the store holds — an index that is BEHIND its transcript, which
   *  the existence-only scan cannot see. Counted always; repaired only when
   *  repairStaleIndexes is on. */
  staleIndexes: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A repair's dedupe key must be UNIQUE per attempt.
 *
 *  A constant chunkId ("reconcile") made `alreadyIngested` match on the second
 *  attempt, so ingestCommit returned without doing anything and the guarantor
 *  could repair a given session exactly once, ever — one session sat frozen for
 *  a week and 2,202 more had the key already burned. Content-addressing does not
 *  fix it either: any damage that leaves the canonical unchanged (a lane wiped by
 *  a racing rebuild, a seq hole, manual surgery) hashes the same and freezes
 *  again.
 *
 *  Dedupe carries no correctness here: the reconciler never retries inside a
 *  pass, its own detection is the idempotency gate, `replace` is idempotent, and
 *  the tail is guarded by two compare-and-swaps under the advisory lock. Live
 *  chunk dedupe — where exactly-once genuinely matters — is untouched. */
const repairChunkId = (kind: "full" | "tail" | "count"): string =>
  `reconcile-${kind}:${crypto.randomUUID()}`;

/** The row's byte count right now — used to re-anchor a compare-and-swap after
 *  an earlier write in the same iteration moved it. */
async function currentBytes(db: HxDb, key: SessionKey): Promise<number | undefined> {
  const [row] = await db
    .select({ bytes: hxSessions.bytesUploaded })
    .from(hxSessions)
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(
      and(
        eq(hxUsers.externalId, key.userId),
        eq(hxSessions.family, key.family),
        eq(hxSessions.sessionId, key.sessionId),
        isNull(hxSessions.deletedAt),
      ),
    )
    .limit(1);
  return row ? Number(row.bytes ?? 0) : undefined;
}

/** Proof that a session's PARENT lane is whole, not merely present.
 *
 *  Two independent facts, because either alone can be satisfied by damaged data:
 *  the row must claim the canonical's full byte count, AND the lane's seq must be
 *  dense (insertTurns assigns 0,1,2… after max(seq), so count === max+1 exactly
 *  when nothing is missing in the middle). A tail repair that mis-sliced shows up
 *  as a byte mismatch; turns deleted from a lane show up as a seq hole.
 *
 *  KNOWN GAP: neither fact sees a lost CHUNK. insertTurns numbers from
 *  max(seq)+1, so a chunk whose commit failed while the next one succeeded
 *  leaves the lane DENSE, and that next chunk carries the full totalBytes, so it
 *  is also byte-COVERING. Reproduced: a 9-record canonical indexed as 6 turns
 *  (records 3-5 absent) passes both checks and every detector in this file. Only
 *  a whole-canonical record count would catch it. */
async function verifyLane(
  db: HxDb,
  key: SessionKey,
  canonicalBytes: number | null,
  store?: SessionStore,
  /** Agent lane to verify. Omitted / null = the parent lane. */
  agentId?: string | null,
  /** How to compare `expectedTurns`. `exact` only after a replace, where the
   *  lane was built from precisely this text; `atLeast` everywhere else. */
  countMode?: "exact" | "atLeast",
  /** Records the canonical PARSES to for this lane — the only ground truth for
   *  completeness. Bytes and density both miss a lost middle record (a 9-record
   *  canonical indexed as 6 is still seq-dense and can still be byte-covering)
   *  and both miss duplication. Omit only when the count is genuinely unknown.
   *
   *  Must be the count from parsing the WHOLE canonical: parseChunk is stateful
   *  across the text (cross-record dedup, retroactive filtering), so
   *  parse(prefix) + parse(tail) does not equal parse(whole). */
  expectedTurns?: number | null,
  /** Canonical object to re-measure. For a lane this is the `sid:a:agentId`
   *  composite, NOT the parent key used to find the row — statting the parent
   *  compares a lane against the wrong object entirely, and with a median parent
   *  of one turn that comparison passes trivially. */
  statKey?: SessionKey,
): Promise<{
  ok: boolean;
  bytes: number;
  turns: number;
  dense: boolean;
  /** The size actually compared against — the FRESH stat when one was available,
   *  otherwise the scan-time size. Callers diff this against the size they
   *  rebuilt from to tell live growth apart from real damage. */
  canonical: number | null;
  /** Records the canonical was expected to yield, echoed back for logging.
   *  null when the caller could not supply one. */
  expected: number | null;
}> {
  // Re-measure the canonical NOW. The size read at scan time can be minutes old,
  // and for a live session it is already wrong by the time a repair finishes.
  if (store) {
    try {
      const fresh = await store.statCanonical(statKey ?? key);
      if (fresh != null) canonicalBytes = fresh;
    } catch {
      // keep the scan-time size — a stat failure must not fail the verification
    }
  }
  const [row] = await db
    .select({ id: hxSessions.id, bytes: hxSessions.bytesUploaded })
    .from(hxSessions)
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(
      and(
        eq(hxUsers.externalId, key.userId),
        eq(hxSessions.family, key.family),
        eq(hxSessions.sessionId, key.sessionId),
        isNull(hxSessions.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, bytes: 0, turns: 0, dense: false, canonical: canonicalBytes, expected: expectedTurns ?? null };
  // hx.turns.agent_id holds the lane ROW id, not the external agent id — resolve
  // it before counting, and read the lane's OWN byte count while we are here.
  let bytes = Number(row.bytes ?? 0);
  let laneRowId: string | null = null;
  if (agentId) {
    const [laneRow] = await db
      .select({ id: hxSessionAgents.id, bytes: hxSessionAgents.bytesUploaded })
      .from(hxSessionAgents)
      .where(
        and(
          eq(hxSessionAgents.sessionId, row.id),
          eq(hxSessionAgents.agentExternalId, agentId),
          isNull(hxSessionAgents.deletedAt),
        ),
      )
      .limit(1);
    if (!laneRow) return { ok: false, bytes: 0, turns: 0, dense: false, canonical: canonicalBytes, expected: expectedTurns ?? null };
    laneRowId = laneRow.id;
    bytes = Number(laneRow.bytes ?? 0);
  }
  const [agg] = await db
    .select({
      n: dsql<number>`count(*)::int`,
      maxSeq: dsql<number>`coalesce(max(${hxTurns.seq}), -1)::int`,
    })
    .from(hxTurns)
    .where(
      and(
        eq(hxTurns.sessionId, row.id),
        laneRowId ? eq(hxTurns.agentId, laneRowId) : isNull(hxTurns.agentId),
      ),
    );
  const turns = Number(agg?.n ?? 0);
  const dense = turns === Number(agg?.maxSeq ?? -1) + 1;
  // A session that is still being written grows UNDER the sweep: a live chunk can
  // land between the repair and this check, leaving the row legitimately AHEAD of
  // whatever the canonical measured when the pass started. Complete means "covers
  // the canonical", not "equals a number captured minutes ago" — so >= passes, and
  // only genuinely BEHIND counts as incomplete.
  const bytesOk = canonicalBytes == null || bytes >= canonicalBytes;
  // The count is the authority. Bytes prove we reached the end of the object;
  // density proves the seq column has no holes. Neither can see that a record
  // in the MIDDLE never landed, nor that one landed twice — only comparing the
  // canonical's own record count to what is indexed can. When the caller can
  // supply that count it decides the verdict, with bytes/density kept as the
  // cheap corroborating checks.
  // EXACT on every repair path. The canonical-faithful state of a lane is
  // `parse(whole)` — that is what a `replace` produces — so a repaired lane
  // whose count differs has DRIFTED from the canonical and must be rebuilt, not
  // accepted. (parseChunk is stateful across the text, so an incrementally
  // appended lane can legitimately differ; that drift is exactly what the
  // rebuild converges. `atLeast` exists for callers that can only establish a
  // lower bound, and no repair path is one of them.)
  const countOk =
    expectedTurns == null ||
    ((countMode ?? "exact") === "exact" ? turns === expectedTurns : turns >= expectedTurns);
  return {
    ok: bytesOk && dense && countOk,
    bytes,
    turns,
    dense,
    canonical: canonicalBytes,
    expected: expectedTurns ?? null,
  };
}

/** Why a post-rebuild verification came back short.
 *
 *  `damage`     — a hole, or fewer bytes indexed than the text we actually read.
 *                 The rebuild genuinely failed; this is the alert.
 *  `grew`       — everything we read is indexed and the canonical has grown SINCE
 *                 the pass listed it. A live session; the tail lands next pass.
 *  `shortRead`  — everything we read is indexed, the canonical has not grown, yet
 *                 the stat still reports more bytes than the read returned. No
 *                 rebuild can close that; the store is the thing to look at.
 *
 *  Splitting the last two out of `integrityFailures` is what keeps that counter
 *  meaning "the guarantor could not make this session whole". On a busy fortress
 *  every actively-written session trips `grew`, and a single non-UTF-8 canonical
 *  trips `shortRead` on every pass forever — conflating either one puts a
 *  permanent floor under the alert. */
type ShortfallKind = "damage" | "grew" | "shortRead";

function classifyShortfall(
  v: { bytes: number; dense: boolean; canonical: number | null; turns: number; expected: number | null },
  /** Bytes the rebuild actually indexed — `Buffer.byteLength` of the text read. */
  readBytes: number,
  /** Object size when the pass listed this canonical, for the growth comparison. */
  scanBytes: number | null,
): ShortfallKind {
  const grew = scanBytes != null && v.canonical != null && v.canonical > scanBytes;
  // Structural damage decides FIRST and unconditionally. A hole, or fewer bytes
  // than the text we read, is damage whatever the counts or the store say —
  // letting the count branch run first meant a genuinely holed lane whose
  // canonical happened to grow was reported as a harmless live race.
  if (!v.dense || v.bytes < readBytes) return "damage";
  // Count as a LOWER bound only. parseChunk is stateful across the text, so an
  // append-built lane legally holds MORE turns than parse(whole) yields; that
  // direction proves nothing. Fewer turns than records means records are
  // genuinely missing — unless the canonical grew under us, where our expected
  // count came from a stale read.
  if (v.expected != null && v.turns < v.expected && !grew) return "damage";
  if (v.canonical == null) return "damage";
  if (grew) return "grew";
  return "shortRead";
}

/** Grace period before an open chunk intent counts as a lost index write.
 *  Comfortably longer than a deferred ingest takes, short enough that a real loss
 *  is caught inside one sweep. */
/** How long a CLEARED intent is kept before pruning. Long enough to stay useful when
 *  reconstructing an incident, short enough that the table does not grow without
 *  bound. */
const CLEARED_INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_INTENT_GRACE_MS = 10 * 60 * 1000;

/** Internal signal: the sweep stood down for load, which is not a failure. */
class SweepSkipped extends Error {}

/** Below this many stale sessions the ceiling never applies: a handful of rows
 *  is a repair job, not a stampede, and refusing it would strand small fortresses
 *  permanently. */
const STALE_CEILING_MIN_COUNT = 50;

/** A parent row with ZERO events carries no content: it is either a stub minted
 *  by a pre-0.19.0 agent-lane commit that arrived before its parent, or a restore
 *  that never completed. Such a row must NOT count as "indexed" — otherwise it
 *  masks its own canonical from the orphan scan and the session stays content-less
 *  forever (the permanent-loss shape). Re-ingesting is idempotent (replace: true
 *  rebuilds the lane from the whole canonical), so treating it as an orphan is
 *  always safe: a genuinely empty canonical simply rebuilds to the same nothing. */
const INDEXED = gt(hxSessions.eventCount, 0);
/** The lane equivalent — a zero-event lane row carries no content either. */
const LANE_INDEXED = gt(hxSessionAgents.eventCount, 0);

/** The natural key a canonical maps to. Parent lanes key on hx.sessions; agent
 *  lanes (`baseSid:a:agentId`) key on hx.session_agents under their parent, so an
 *  already-indexed lane isn't mistaken for an orphan and re-ingested every sweep. */
async function keyExists(db: HxDb, key: SessionKey): Promise<boolean> {
  const laneIdx = key.sessionId.indexOf(AGENT_LANE);
  if (laneIdx < 0) {
    const [row] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(
        and(
          eq(hxUsers.externalId, key.userId),
          eq(hxSessions.family, key.family),
          eq(hxSessions.sessionId, key.sessionId),
          isNull(hxSessions.deletedAt),
          INDEXED,
        ),
      )
      .limit(1);
    return row != null;
  }
  const baseSid = key.sessionId.slice(0, laneIdx);
  const agentId = key.sessionId.slice(laneIdx + AGENT_LANE.length);
  const [row] = await db
    .select({ id: hxSessionAgents.id })
    .from(hxSessionAgents)
    .innerJoin(hxSessions, eq(hxSessions.id, hxSessionAgents.sessionId))
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(
      and(
        eq(hxUsers.externalId, key.userId),
        eq(hxSessions.family, key.family),
        eq(hxSessions.sessionId, baseSid),
        eq(hxSessionAgents.agentExternalId, agentId),
        isNull(hxSessions.deletedAt),
        isNull(hxSessionAgents.deletedAt),
        // Same gate as the bulk query: a content-less lane must not veto the
        // restore of the canonical it is masking.
        LANE_INDEXED,
      ),
    )
    .limit(1);
  return row != null;
}

/**
 * One reconcile pass: re-index every row-less canonical, then correct existing
 * fallback/empty titles. Never throws (per-session failures are counted +
 * logged). Returns per-pass stats.
 */
export async function reconcileOrphans(
  db: HxDb,
  store: SessionStore,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const delay = opts.batchDelayMs ?? 200;
  const res: ReconcileResult = {
    scanned: 0,
    orphans: 0,
    restored: 0,
    skippedTombstoned: 0,
    deferred: 0,
    errors: 0,
    titlesCorrected: 0,
    staleIndexes: 0,
    gappedLanes: 0,
    liveRaces: 0,
    noOpRepairs: 0,
    protectedSkips: 0,
    emptyCanonicals: 0,
    prefixMismatches: 0,
    unjudgeable: 0,
    tooLargeToJudge: 0,
    oversizedUnindexed: 0,
    repairedTail: 0,
    repairedFull: 0,
    verifyFallbacks: 0,
    integrityFailures: 0,
    shortReads: 0,
    yieldedToLive: 0,
    deepVerified: 0,
    deepMismatched: 0,
    deepRepaired: 0,
    deepRefused: 0,
    deepErrors: 0,
    staleIntents: 0,
    skippedBehind: 0,
    laneDrift: 0,
    deepOvercount: 0,
    deepVerifyBacklog: null,
    deepVerifyFloor: null,
    byteGapRows: null,
    byteGapBytes: null,
    byteGapBlind: null,
    uncompactedCanonicals: null,
    intentsPruned: null,
    duplicatedSessions: null,
    canonicalHeldDuplicates: 0,
    embeddingsPruned: null,
  };

  // Stand down before ANY of the pass's work. What follows is the most expensive
  // thing the guarantor does — a full scan of hx.sessions, two grouped
  // aggregates over hx.turns (14 GB with two GIN indexes on the reference
  // deployment), further scans, and a whole-bucket listing from object storage.
  // A check placed after the bulk gate protects nothing: the database has
  // already paid. Repair has no caller waiting on it, so on a starved database
  // the correct move is to do nothing at all and return.
  if (opts.isSaturated?.()) {
    res.yieldedToLive += 1;
    opts.logger?.info?.("reconciler: live pool saturated — pass stood down before any work");
    return res;
  }

  // LIST THE STORE FIRST, then snapshot the database.
  //
  // The two are read seconds-to-minutes apart (the snapshot below is a full scan
  // of hx.sessions plus grouped aggregates over a multi-GB hx.turns). Whichever
  // is read LAST is the fresher view, and the gate flags a session whose
  // canonical looks ahead of its row.
  //
  // Snapshotting the DB first therefore mislabels every session written during
  // the gap: the row is stale-by-comparison purely because it was read earlier.
  // Each one costs a whole-canonical download and a repair attempt; most abort
  // on the CAS, but a session whose indexing is still queued behind the
  // gateway's deferred commit does NOT abort, and ends up duplicated.
  //
  // Reading the store first inverts it: a session that advances in the gap looks
  // AHEAD of its canonical, which the gate already ignores.
  const keys: CanonicalEntry[] = await store.listAllCanonicalKeys();

  // Sessions with a chunk intent still open past the grace period: their bytes
  // are in the canonical and their turns may not be in the index, and NOTHING
  // else can select them — the watermark covers and the seq is dense. Folded in
  // as forced candidates so the ordinary whole-canonical repair below fixes them.
  const forcedIntent = new Set<string>();
  if (opts.intentGraceMs !== 0) {
    try {
      const stale = await staleIntentSessions(db, opts.intentGraceMs ?? DEFAULT_INTENT_GRACE_MS);
      for (const k of stale) {
        // Match the natural key the loop below builds: a lane carries the
        // `:a:agentId` suffix, a parent does not.
        const sid = k.agentExternalId
          ? `${k.sessionId}${AGENT_LANE}${k.agentExternalId}`
          : k.sessionId;
        forcedIntent.add(`${k.userExternalId}/${k.family}/${sid}`);
      }
      res.staleIntents = forcedIntent.size;
      if (forcedIntent.size > 0) {
        opts.logger?.warn?.(
          "reconciler: chunk intents left open — bytes composed, turns not indexed",
          { sessions: forcedIntent.size },
        );
      }
    } catch (err) {
      // An extra signal, not a prerequisite: never fail the pass over it.
      opts.logger?.warn?.("reconciler: could not read chunk intents", {
        err: sanitizeDbError(err),
      });
    }
  }

  // Fast bulk gate: the natural keys the fortress already has a row for — parent
  // sessions and agent lanes alike, so neither is re-ingested once indexed.
  const parents = await db
    .select({
      ext: hxUsers.externalId,
      family: hxSessions.family,
      sessionId: hxSessions.sessionId,
      bytesUploaded: hxSessions.bytesUploaded,
    })
    .from(hxSessions)
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(and(isNull(hxSessions.deletedAt), INDEXED));
  const have = new Set(parents.map((r) => `${r.ext}/${r.family}/${r.sessionId}`));
  // What each indexed PARENT was built from, so a canonical that has grown past
  // its index can be recognised. Lanes stay existence-only for now.
  const indexedBytes = new Map(
    parents.map((r) => [`${r.ext}/${r.family}/${r.sessionId}`, Number(r.bytesUploaded ?? 0)]),
  );

  // Turns missing from the MIDDLE of a lane are invisible to the byte
  // comparison: bytes_uploaded still matches the canonical, so the session looks
  // complete while it is not. insertTurns assigns seq densely from 0, so
  // count <> max(seq)+1 is exactly a hole. One grouped aggregate over the unique
  // (session_id, agent_id, seq) index answers it for the whole corpus.
  const gapped = new Set<string>();
  try {
    const holes = await db
      .select({ ext: hxUsers.externalId, family: hxSessions.family, sessionId: hxSessions.sessionId })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .innerJoin(hxTurns, and(eq(hxTurns.sessionId, hxSessions.id), isNull(hxTurns.agentId)))
      .where(
      and(
        isNull(hxSessions.deletedAt),
        // Over-cap rows can never converge — no read is allowed, so no record count
        // exists — and they are reported separately as deepVerifyFloor. Leaving them in
        // the rotation costs a stat each pass and, worse, sets a config trap: lower
        // deepVerifyPerPass to at or below their count and the sweep spends every pass
        // re-statting the same rows and proving nothing. They also drift to the HEAD of
        // the queue, because the order is `deep_attempted_at nulls first` and they stop
        // being stamped.
        dsql`${hxSessions.bytesUploaded} <= ${maxCanonicalBytes()}`,
      ),
    )
      .groupBy(hxUsers.externalId, hxSessions.family, hxSessions.sessionId)
      .having(dsql`count(*) <> max(${hxTurns.seq}) + 1`);
    for (const h of holes) gapped.add(`${h.ext}/${h.family}/${h.sessionId}`);
    // …and the same question per agent lane. Lanes are ~a third of all indexed
    // content and were previously existence-only, so a holed lane was invisible.
    const laneHoles = await db
      .select({
        ext: hxUsers.externalId,
        family: hxSessions.family,
        sessionId: hxSessions.sessionId,
        agentId: hxSessionAgents.agentExternalId,
      })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .innerJoin(hxTurns, eq(hxTurns.sessionId, hxSessions.id))
      // turns carry the lane ROW id; the sweep keys on the EXTERNAL id.
      .innerJoin(hxSessionAgents, eq(hxSessionAgents.id, hxTurns.agentId))
      .where(
        and(
          isNull(hxSessions.deletedAt),
          isNull(hxSessionAgents.deletedAt),
          isNotNull(hxTurns.agentId),
        ),
      )
      .groupBy(hxUsers.externalId, hxSessions.family, hxSessions.sessionId, hxSessionAgents.agentExternalId)
      .having(dsql`count(*) <> max(${hxTurns.seq}) + 1`);
    for (const h of laneHoles) {
      gapped.add(`${h.ext}/${h.family}/${h.sessionId}${AGENT_LANE}${h.agentId}`);
    }
  } catch (err) {
    // Never let the integrity sweep take the whole pass down with it.
    opts.logger?.warn?.("reconciler: seq-gap scan failed", { err: sanitizeDbError(err) });
  }

  // Duplicated parents and lanes join the SAME forced-candidate set as holed
  // ones, because they want the same remedy: a whole-canonical rebuild of the
  // affected lane. Neither is visible to the byte gate (both are byte-covering)
  // and duplicates are invisible to the count sweep too, whose oracle treats
  // actual >= expected as healthy — so without this they are detected forever
  // and repaired never.
  if (opts.repairDuplicates) {
    try {
      const dups = await duplicatedSessionKeys(db);
      res.duplicatedSessions = dups.length;
      for (const d of dups) gapped.add(`${d.userExternalId}/${d.family}/${d.sessionId}`);
      if (dups.length > 0) {
        opts.logger?.warn?.("reconciler: forcing rebuild of sessions holding duplicates", {
          candidates: dups.length,
          lanes: dups.filter((d) => d.sessionId.includes(AGENT_LANE)).length,
        });
      }
    } catch (err) {
      opts.logger?.warn?.("reconciler: duplicate scan failed", { err: sanitizeDbError(err) });
    }
  }
  const agents = await db
    .select({
      ext: hxUsers.externalId,
      family: hxSessions.family,
      sessionId: hxSessions.sessionId,
      agentId: hxSessionAgents.agentExternalId,
      bytesUploaded: hxSessionAgents.bytesUploaded,
    })
    .from(hxSessionAgents)
    .innerJoin(hxSessions, eq(hxSessions.id, hxSessionAgents.sessionId))
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    // A lane with zero events carries no content, exactly like a parent stub, and
    // must not mask its own canonical from the orphan scan.
    .where(
      and(
        isNull(hxSessions.deletedAt),
        isNull(hxSessionAgents.deletedAt),
        gt(hxSessionAgents.eventCount, 0),
      ),
    );
  // Lanes hold ~a third of all indexed content, so they get the same byte-level
  // completeness check as parents — keyed on their OWN bytes_uploaded.
  // Every parent row, gate or no gate. A canonical that parses to nothing leaves
  // a zero-event row which the INDEXED gate excludes — without this it looks
  // orphaned again on every pass, forever.
  const anyRowBytes = new Map<string, number>(
    (
      await db
        .select({
          ext: hxUsers.externalId,
          family: hxSessions.family,
          sessionId: hxSessions.sessionId,
          bytesUploaded: hxSessions.bytesUploaded,
        })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(isNull(hxSessions.deletedAt))
    ).map((r) => [`${r.ext}/${r.family}/${r.sessionId}`, Number(r.bytesUploaded ?? 0)]),
  );
  const anyLaneBytes = new Map<string, number>(
    (
      await db
        .select({
          ext: hxUsers.externalId,
          family: hxSessions.family,
          sessionId: hxSessions.sessionId,
          agentId: hxSessionAgents.agentExternalId,
          bytesUploaded: hxSessionAgents.bytesUploaded,
        })
        .from(hxSessionAgents)
        .innerJoin(hxSessions, eq(hxSessions.id, hxSessionAgents.sessionId))
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(isNull(hxSessions.deletedAt), isNull(hxSessionAgents.deletedAt)))
    ).map((r) => [
      `${r.ext}/${r.family}/${r.sessionId}${AGENT_LANE}${r.agentId}`,
      Number(r.bytesUploaded ?? 0),
    ]),
  );
  const laneBytes = new Map<string, number>();
  for (const r of agents) {
    const k = `${r.ext}/${r.family}/${r.sessionId}${AGENT_LANE}${r.agentId}`;
    have.add(k);
    laneBytes.set(k, Number(r.bytesUploaded ?? 0));
  }

  // Decide ONCE, before touching anything, whether stale repair runs this pass.
  // The comparison is cheap (both sides are already in memory), and knowing the
  // total up front is what makes the ceiling meaningful: a byte comparison that
  // regresses flags nearly the whole corpus, and re-ingesting all of it would be
  // far worse than the damage being repaired.
  const staleTotal = keys.reduce((n, k) => {
    if (k.bytes == null) return n;
    const nat = `${k.userId}/${k.family}/${k.sessionId}`;
    if (!have.has(nat)) return n;
    const m = k.sessionId.includes(AGENT_LANE) ? laneBytes : indexedBytes;
    return (m.get(nat) ?? 0) < k.bytes ? n + 1 : n;
  }, 0);
  const ceiling = opts.staleRepairCeiling ?? 0.25;
  const wantRepair = opts.repairStaleIndexes ?? true;
  // The ceiling guards against ONE thing: a byte comparison that regressed and
  // now flags the whole corpus, where repairing would re-ingest everything. A
  // ratio alone cannot express that — on a small fortress two stale sessions out
  // of three read as 67% and would be refused forever, leaving exactly the
  // sessions the guarantor exists to fix. So the ratio only applies once the
  // absolute count is large enough for "mass re-ingest" to mean anything.
  const repairStale =
    wantRepair &&
    (staleTotal < STALE_CEILING_MIN_COUNT ||
      keys.length === 0 ||
      staleTotal / keys.length <= ceiling);
  if (wantRepair && !repairStale) {
    opts.logger?.warn?.("reconciler: stale-index repair SKIPPED — implausible share of the corpus", {
      staleTotal,
      scanned: keys.length,
      ceiling,
    });
  }
  // A parent (`baseSid`) sorts before its lanes (`baseSid:a:…`), so when both are
  // orphaned the parent is fully re-ingested (turns + real title) before a lane's
  // ingestAgentCommit would create a title-less parent stub that shadows it.
  keys.sort((a, b) => {
    const ka = `${a.userId}/${a.family}/${a.sessionId}`;
    const kb = `${b.userId}/${b.family}/${b.sessionId}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  // Base session keys whose PARENT re-ingest threw this pass. ingestAgentCommit
  // inserts a title/turn-less parent stub when the parent row is absent, and that
  // stub would then enter the `have`/keyExists gate and block the parent's real
  // re-ingest forever. ingestAgentCommit now throws ParentSessionNotIndexedError
  // instead of minting one, but the ordering still matters: a lane is only
  // meaningful under an indexed parent, so if a parent failed this pass, defer
  // its agent lanes — the parent (still orphaned) retries next sweep first.
  const failedParents = new Set<string>();
  for (const key of keys) {
    res.scanned += 1;
    if (opts.maxOrphans != null && opts.maxOrphans > 0 && res.restored >= opts.maxOrphans) break;
    const natural = `${key.userId}/${key.family}/${key.sessionId}`;
    // Set when this entry is being rebuilt because its index is BEHIND its
    // canonical rather than missing. The row exists by definition in that case,
    // so the ingest-time existence re-check below must not veto the repair.
    let staleRepair = false;
    let alreadyIndexedBytes = 0;
    // What the row held when this pass started — the value every compare-and-swap
    // below is anchored to. Distinct from the tail offset, which is forced to 0
    // for a holed lane so it takes the full rebuild.
    let scanBytes: number | undefined;
    if (have.has(natural)) {
      // The row exists — but does it cover the whole transcript? An index that is
      // BEHIND its canonical (a chunk whose commit failed while earlier ones
      // landed) is invisible to an existence check, and no sweep would ever find
      // it. Byte counts are only compared when the store reported one.
      const canonicalBytes = key.bytes ?? null;
      if (canonicalBytes == null) res.unjudgeable += 1;
      const isLane = key.sessionId.includes(AGENT_LANE);
      const holed = gapped.has(natural);
      if (holed) res.gappedLanes += 1;
      // Only BEHIND is damage. A live session can legitimately run ahead of the
      // size captured when this pass started, and rebuilding it for that would
      // re-index a healthy session every sweep — churn that looks like repair.
      const indexedNow = (isLane ? laneBytes : indexedBytes).get(natural) ?? 0;
      const behind = canonicalBytes != null && indexedNow < canonicalBytes;
      // A forced candidate has an OPEN chunk intent: bytes composed, turns
      // possibly not indexed. It is exactly the case that looks covered — the
      // next chunk stamped the full watermark and continued seq — so the
      // ordinary checks must not be allowed to skip it.
      const forcedHere = forcedIntent.has(natural);
      if (!holed && !behind && !forcedHere) continue;
      if (behind) res.staleIndexes += 1;
      // The documented brake stops stale-index repair. It does NOT stop an open
      // intent: that is a chunk the fortress promised to index and did not, and
      // leaving it is the loss the whole mechanism exists to prevent.
      if (!repairStale && !forcedHere) continue;
      staleRepair = true;
      scanBytes = indexedNow;
      // A hole in the middle cannot be appended away — force the full rebuild.
      alreadyIndexedBytes = holed ? 0 : scanBytes;
    }
    const laneIdx = key.sessionId.indexOf(AGENT_LANE);
    const baseSid = laneIdx >= 0 ? key.sessionId.slice(0, laneIdx) : key.sessionId;
    const baseKey = `${key.userId}/${key.family}/${baseSid}`;
    if (laneIdx >= 0 && failedParents.has(baseKey)) {
      res.deferred += 1; // parent failed this pass → defer the lane to the next sweep
      continue;
    }
    // A canonical that parses to NOTHING restores to a zero-event row, which the
    // INDEXED gate then excludes from `have` — so it looks orphaned again on the
    // very next pass, forever. Under the old constant repair key that loop was
    // free (iteration 2+ deduped to a no-op); with unique keys every iteration is
    // a real replace txn, a fresh ingest-event row, and a slot of the per-pass
    // cap. So such a row is a CANDIDATE to leave alone.
    //
    // But covering bytes are NOT proof the canonical is empty. A chunk that
    // parsed to no events can commit carrying a totalBytes spanning content whose
    // own commits never landed, leaving a zero-event row over a content-BEARING
    // canonical. Skipping that would permanently ignore real content the pre-fix
    // code would have restored — trading an hourly wasted write for silent data
    // loss, which is the wrong way round.
    //
    // Hence: zero bytes cannot hold an event and is free to skip; an UNKNOWN size
    // never skips (that is what `unjudgeable` records); anything else must be read
    // and PARSED before we are allowed to ignore it — decided below, where the
    // canonical is already in hand.
    const coveredByRow = (() => {
      if (staleRepair) return false;
      const isLane = key.sessionId.includes(AGENT_LANE);
      const m = isLane ? anyLaneBytes : anyRowBytes;
      if (!m.has(natural)) return false;
      if (gapped.has(natural)) return false;
      if (key.bytes == null) return false;
      return (m.get(natural) ?? 0) >= key.bytes;
    })();
    if (coveredByRow && key.bytes === 0) {
      res.emptyCanonicals += 1;
      continue;
    }
    // The repair read had NO bound. readCanonicalText holds the Buffer and its utf8
    // string at once and the rebuild then parses the same text again, so an
    // unbounded read of the corpus's largest object (453 MB) is a multi-GiB spike
    // inside the live ingest process. Refuse it here rather than discover the limit
    // as an OOM that takes ingest down with it. Counted as tooLargeToJudge — the
    // same class as the sweep's over-cap rows, because it is the same fact about the
    // same object, and a streaming record counter is what lifts both at once.
    if (key.bytes != null && key.bytes > maxRepairBytes()) {
      // These two outcomes are NOT the same fact and must not share a counter. With a
      // row, the session is indexed and merely not re-verified this pass. WITHOUT one,
      // the bound means this canonical is never indexed AT ALL, permanently — the
      // repair path is the only thing that would have indexed it. Reporting both as
      // tooLargeToJudge hides a session that has no rows anywhere behind a number that
      // reads as "already fine, just unproven".
      const indexed = have.has(natural);
      if (indexed) res.tooLargeToJudge += 1;
      else res.oversizedUnindexed += 1;
      opts.logger?.warn?.("reconciler: canonical exceeds the repair read bound — skipped", {
        sessionId: key.sessionId,
        family: key.family,
        bytes: key.bytes,
        bound: maxRepairBytes(),
        indexed,
        permanentlyUnindexed: !indexed,
      });
      continue;
    }
    if (opts.isSaturated?.()) {
      res.yieldedToLive += 1;
      opts.logger?.info?.("reconciler: live pool saturated — standing down for this pass", {
        restoredSoFar: res.restored,
      });
      break;
    }
    res.orphans += 1;
    try {
      // Re-check at ingest time so we don't redundantly rebuild a row that
      // Component C or a live upload created since the bulk gate was read
      // (idempotent, avoids wasted re-embeds). A stale repair is the one case
      // where the row is SUPPOSED to be there — skipping the check is the point.
      if (!staleRepair && (await keyExists(db, key))) continue;
      if (await isSessionDeleted(db, key.userId, key.sessionId)) {
        res.skippedTombstoned += 1;
        continue;
      }
      const chunkText = await store.readCanonicalText(key);
      // Parse the WHOLE canonical once. Its record count is the completeness
      // authority for this lane — bytes only prove we reached the end of the
      // object and density only proves seq has no holes, so neither can see a
      // record that never landed in the MIDDLE, nor one that landed twice.
      // It must come from parsing the whole text: parseChunk is stateful across
      // the text, so parse(prefix) + parse(tail) != parse(whole).
      const parsedCanonical = parseChunk(chunkText);
      const expectedTurns = parsedCanonical.turns.length;
      // §7b — the object's own duplicate residue, measured while the parse is
      // in hand (the only moment it ever is): after any rebuild the
      // cross-commit oracle goes blind to these (the whole batch shares one
      // created_at), so this instrument is the only residue meter. Recorded,
      // never rewritten — canonicals are read-only facts.
      const heldDuplicates = countCanonicalHeldDuplicateRecords(parsedCanonical.turns);
      if (heldDuplicates > 0) {
        res.canonicalHeldDuplicates += 1;
        opts.logger?.warn?.("reconciler: canonical itself holds duplicated records", {
          sessionId: key.sessionId,
          family: key.family,
          records: heldDuplicates,
        });
        await recordIntegrityFinding(db, {
          userExternalId: key.userId,
          family: key.family,
          sessionId: laneIdx >= 0 ? baseSid : key.sessionId,
          agentExternalId: laneIdx >= 0 ? key.sessionId.slice(laneIdx + AGENT_LANE.length) : null,
          kind: "canonical_held_duplicates",
          detail: { records: heldDuplicates, canonicalRecords: expectedTurns },
        });
      }
      // The candidate from above, decided on CONTENT rather than on bytes.
      // Parsing to anything at all means this is masked damage, not an empty
      // canonical — fall through and restore it.
      if (coveredByRow && parsedCanonical.eventCount === 0) {
        res.emptyCanonicals += 1;
        if (delay > 0) await sleep(delay);
        continue;
      }
      const base = {
        chunkId: repairChunkId("full"),
        replace: true as const,
        chunkText,
        totalBytes: Buffer.byteLength(chunkText),
        // The store's own size, kept distinct from the decoded length above — see
        // IngestCommitInput.objectBytes for why conflating them breaks intent
        // subsumption in both directions.
        ...(key.bytes != null ? { objectBytes: key.bytes } : {}),
        componentCount: 1,
        meta: null,
        attribution: {
          orgExternalId: null,
          projectExternalId: null,
          repoSlug: null,
          deviceId: null,
        },
        recovered: true as const,
        // The reconciler rebuilds a row from bytes already in the bucket, so it
        // cannot know which entry point originally wrote them — a DISTINCT
        // value, sharing the unknown-provenance bucket with NULL rather than
        // claiming a channel it did not observe.
        ingestChannel: RECONCILED_CHANNEL,
        // Only a repair of an EXISTING row needs the no-clobber guard lifted. An
        // orphan restore has nothing to override, and passing it there would
        // strip the protection against a live row materialising between the
        // existence re-check and the advisory lock.
        rebuild: staleRepair,
      };
      if (laneIdx >= 0) {
        // Agent lane → the parent session key + the agentId. Lanes get the same
        // contract as parents now: compare-and-swap against what the sweep saw,
        // then PROVE the result rather than assume it. A lane is rebuilt whole —
        // there is no tail path for lanes until the parent one has proven itself
        // in production.
        const agentId = key.sessionId.slice(laneIdx + AGENT_LANE.length);
        const laneKey = { userId: key.userId, family: key.family, sessionId: baseSid };
        let laneOutcome: Awaited<ReturnType<typeof ingestAgentCommit>>;
        try {
          laneOutcome = await ingestAgentCommit(db, {
            ...base,
            key: laneKey,
            agentId,
            ...(scanBytes !== undefined ? { expectIndexedBytes: scanBytes } : {}),
          });
        } catch (err) {
          if (!(err instanceof IndexAdvancedError)) throw err;
          res.liveRaces += 1;
          opts.logger?.info?.("reconciler: lane advanced under the sweep — deferring to the live write", {
            sessionId: baseSid, agentId, family: key.family,
            expected: err.expected, nowIndexed: err.actual,
          });
          if (delay > 0) await sleep(delay);
          continue;
        }
        if (!laneOutcome.applied) {
          if (laneOutcome.reason === "recovered_skip") {
            // The guard refused because a live lane is already there: working as
            // intended, not the "believed it repaired something" bug signal.
            res.protectedSkips += 1;
            opts.logger?.info?.("reconciler: lane already live — restore stood down", {
              sessionId: baseSid, agentId, family: key.family,
            });
          } else {
            res.noOpRepairs += 1;
            opts.logger?.warn?.("reconciler: lane repair reported NO-OP", {
              sessionId: baseSid, agentId, family: key.family, reason: laneOutcome.reason,
            });
          }
        } else {
          const v = await verifyLane(db, laneKey, key.bytes ?? null, store, agentId, "exact", expectedTurns, key);
          if (v.ok) {
            res.repairedFull += 1;
          } else {
            const why = classifyShortfall(v, base.totalBytes, key.bytes ?? null);
            if (why === "grew") {
              res.liveRaces += 1;
              opts.logger?.info?.("reconciler: lane grew during its rebuild — tail lands next pass", {
                sessionId: baseSid, agentId, family: key.family,
                indexedBytes: v.bytes, readBytes: base.totalBytes, nowBytes: v.canonical,
                turns: v.turns,
              });
            } else if (why === "shortRead") {
              res.shortReads += 1;
              opts.logger?.warn?.("reconciler: lane stat exceeds what the read returned — index is complete for the bytes we got", {
                sessionId: baseSid, agentId, family: key.family,
                indexedBytes: v.bytes, readBytes: base.totalBytes, statBytes: v.canonical,
                shortfall: (v.canonical ?? 0) - base.totalBytes, turns: v.turns,
              });
            } else {
              res.integrityFailures += 1;
              opts.logger?.warn?.("reconciler: LANE STILL INCOMPLETE after a full rebuild", {
                sessionId: baseSid, agentId, family: key.family,
                indexedBytes: v.bytes, readBytes: base.totalBytes,
                canonicalBytes: v.canonical ?? key.bytes ?? null,
                turns: v.turns, dense: v.dense,
              });
            }
          }
          res.restored += 1;
        }
      } else {
        const canonicalBytes = key.bytes ?? Buffer.byteLength(chunkText);

        // FAST PATH — append just the missing tail. Only when the index is
        // cleanly behind: a positive prefix, strictly shorter than the canonical,
        // ending exactly on a record boundary. JSONL means a prefix that does not
        // end at a newline would slice a record in half, and half a record is the
        // gap this must never create — so that case takes the slow path instead.
        let landed = false;
        let tailApplied = false;
        const buf = Buffer.from(chunkText, "utf8");
        const canAppendTail =
          (opts.repairTails ?? true) &&
          staleRepair &&
          alreadyIndexedBytes > 0 &&
          alreadyIndexedBytes < buf.length &&
          buf[alreadyIndexedBytes - 1] === 0x0a;

        if (canAppendTail) {
          // Parse the prefix OUTSIDE the transaction (pure CPU) and assert the
          // count INSIDE it, under the advisory lock: the lane must hold exactly
          // the prefix this tail was cut from, or appending splices unrelated
          // content onto it.
          const expectPriorTurns = parseChunk(
            buf.subarray(0, alreadyIndexedBytes).toString("utf8"),
          ).turns.length;
          const tailText = buf.subarray(alreadyIndexedBytes).toString("utf8");
          // What the lane MUST hold if this append lands exactly as intended.
          // It is not `parse(whole)`: parseChunk is stateful across the text, so
          // the sum of the two pieces legitimately exceeds a whole parse. That
          // difference is the discriminator below.
          const expectAfterAppend = expectPriorTurns + parseChunk(tailText).turns.length;
          let outcome: Awaited<ReturnType<typeof ingestCommit>> | null = null;
          try {
            outcome = await ingestCommit(db, {
              ...base,
              key,
              chunkId: repairChunkId("tail"),
              replace: false,
              chunkText: tailText,
              // The bytes this append actually indexes — NEVER the size the store
              // claims. `canonicalBytes` is the LISTED/stat size; when the read
              // comes back shorter (a non-UTF-8 canonical, a truncated download)
              // stamping it here marks a partial session complete: the row reads
              // as fully covered, the staleness gate stops selecting it, and the
              // shortfall is never revisited. The full-rebuild path below already
              // records `Buffer.byteLength(chunkText)` for exactly this reason.
              totalBytes: buf.length,
              expectIndexedBytes: alreadyIndexedBytes,
              expectPriorTurns,
            });
          } catch (err) {
            if (err instanceof IndexAdvancedError) {
              // A live commit beat us to it. The live write is the more current
              // truth; re-check next pass rather than writing from a stale slice.
              res.liveRaces += 1;
              opts.logger?.info?.("reconciler: session advanced under the sweep — deferring to the live write", {
                sessionId: key.sessionId, family: key.family,
                slicedFrom: err.expected, nowIndexed: err.actual,
              });
              if (delay > 0) await sleep(delay);
              continue;
            }
            if (!(err instanceof LanePrefixMismatchError)) throw err;
            // The lane does not hold the prefix — a byte count that regressed
            // under a replayed chunk, or a canonical that was rewritten rather
            // than appended. Both are repaired correctly by a full rebuild.
            res.prefixMismatches += 1;
            opts.logger?.warn?.("reconciler: lane does not hold the sliced prefix — rebuilding in full", {
              sessionId: key.sessionId, family: key.family,
              expectedTurns: err.expectedTurns, actualTurns: err.actualTurns,
              slicedFrom: alreadyIndexedBytes,
            });
          }

          if (outcome && !outcome.applied) {
            // The commit reported it did nothing. Never treat that as repaired.
            res.noOpRepairs += 1;
            opts.logger?.warn?.("reconciler: tail repair reported NO-OP", {
              sessionId: key.sessionId, family: key.family, reason: outcome.reason,
            });
          } else if (outcome) {
            tailApplied = true;
            const v = await verifyLane(db, key, canonicalBytes, store, null, "exact", expectedTurns);
            if (v.ok) {
              landed = true;
              res.repairedTail += 1;
            } else if (
              v.dense &&
              v.bytes >= buf.length &&
              // …and we are not merely BEHIND a canonical that grew under us.
              // Without this the acceptance below would swallow the growth case,
              // which has its own handling (re-stat and defer) and must keep it.
              v.canonical != null &&
              v.bytes >= v.canonical &&
              v.turns === expectAfterAppend &&
              // …and the divergence is in the collapsing direction. For a
              // newline-aligned split `sum >= whole` always holds (every state
              // mechanism in classifyChunk only ever suppresses MORE with more
              // context), and `sum == whole` would already have satisfied v.ok
              // above — so this conjunct guards that invariant rather than
              // adding a new check.
              //
              // Stated plainly, because it would be easy to read as more:
              // `expectPriorTurns` is a COUNT compare-and-swap, not a content
              // check. A lane whose prefix content is stale but whose count
              // happens to match is still accepted here. Closing that needs the
              // prefix hashed, which this is not.
              expectAfterAppend > expectedTurns
            ) {
              // The append landed EXACTLY: prefix + tail, densely, covering every
              // byte. The only reason it differs from `parse(whole)` is that
              // parseChunk suppresses more when it sees the text in one piece —
              // for Codex that happens on essentially every assistant turn.
              //
              // Escalating here would rebuild a session that is exactly what we
              // asked for, delete its embeddings, and do it again on the next
              // pass, forever: the tail fast path would be dead for the whole
              // collapsing family and every stale repair would be a full
              // rebuild. Accept it, and record the divergence from the whole
              // parse so it stays visible.
              landed = true;
              res.repairedTail += 1;
              res.laneDrift += 1;
              opts.logger?.info?.("reconciler: tail landed exactly; lane holds more than a whole parse", {
                sessionId: key.sessionId, family: key.family,
                turns: v.turns, wholeParse: expectedTurns,
              });
            } else {
              res.verifyFallbacks += 1;
              opts.logger?.warn?.("reconciler: tail repair did not verify — rebuilding in full", {
                sessionId: key.sessionId, family: key.family,
                indexedBytes: v.bytes, canonicalBytes, turns: v.turns, dense: v.dense,
              });
            }
          }
        }

        // SLOW PATH — rebuild the whole lane from the canonical.
        //
        // If a tail APPLIED and then failed verification, the row's byte count is
        // no longer what the sweep observed — the tail moved it. Anchoring this
        // CAS to the stale scan value could never match, so the escalation always
        // aborted as a phantom live race and the promised rebuild never ran.
        if (!landed) {
          // The text in hand was read before any of this iteration's writes. If
          // the canonical has GROWN since, rebuilding from that text deletes the
          // lane and reinstates a prefix — a real, if self-healing, wipe. A
          // verify-triggered escalation is precisely the "canonical grew" case,
          // so re-stat and defer rather than rebuild from something stale.
          if (tailApplied && canonicalBytes != null) {
            let freshBytes: number | null = null;
            try {
              freshBytes = await store.statCanonical(key);
            } catch {
              // unreadable — fall through and let the CAS decide
            }
            if (freshBytes != null && freshBytes > canonicalBytes) {
              res.liveRaces += 1;
              opts.logger?.info?.("reconciler: canonical grew mid-repair — deferring the rebuild", {
                sessionId: key.sessionId, family: key.family,
                readAt: canonicalBytes, nowBytes: freshBytes,
              });
              if (delay > 0) await sleep(delay);
              continue;
            }
          }
          const rebuildAnchor = tailApplied ? await currentBytes(db, key) : scanBytes;
          let full: Awaited<ReturnType<typeof ingestCommit>>;
          try {
            full = await ingestCommit(db, {
              ...base,
              key,
              // A rebuild DELETES the lane and reinserts from text read before
              // the lock was taken. Without this CAS a chunk that committed in
              // that window is deleted and never restored — the guarantor
              // destroying data that was fine. Only meaningful when the row
              // already existed; an orphan restore has nothing to compare.
              ...(rebuildAnchor !== undefined ? { expectIndexedBytes: rebuildAnchor } : {}),
            });
          } catch (err) {
            if (!(err instanceof IndexAdvancedError)) throw err;
            res.liveRaces += 1;
            opts.logger?.info?.("reconciler: session advanced before its rebuild — deferring to the live write", {
              sessionId: key.sessionId, family: key.family,
              expected: err.expected, nowIndexed: err.actual,
            });
            if (delay > 0) await sleep(delay);
            continue;
          }

          if (!full.applied) {
            // A no-op is not a repair. Counting it toward `restored` would also
            // spend a slot of the per-pass cap on work that did nothing.
            if (full.reason === "recovered_skip") {
              res.protectedSkips += 1;
              opts.logger?.info?.("reconciler: session already live — restore stood down", {
                sessionId: key.sessionId, family: key.family,
              });
            } else {
              res.noOpRepairs += 1;
              opts.logger?.warn?.("reconciler: full rebuild reported NO-OP", {
                sessionId: key.sessionId, family: key.family, reason: full.reason,
              });
            }
          } else {
            res.restored += 1;
            const v = await verifyLane(db, key, canonicalBytes, store, null, "exact", expectedTurns);
            if (v.ok) {
              res.repairedFull += 1;
            } else {
              const why = classifyShortfall(v, base.totalBytes, canonicalBytes);
              if (why === "grew") {
                res.liveRaces += 1;
                opts.logger?.info?.("reconciler: session grew during its rebuild — tail lands next pass", {
                  sessionId: key.sessionId, family: key.family,
                  indexedBytes: v.bytes, readBytes: base.totalBytes, nowBytes: v.canonical,
                  turns: v.turns,
                });
              } else if (why === "shortRead") {
                res.shortReads += 1;
                opts.logger?.warn?.("reconciler: store stat exceeds what the read returned — index is complete for the bytes we got", {
                  sessionId: key.sessionId, family: key.family,
                  indexedBytes: v.bytes, readBytes: base.totalBytes, statBytes: v.canonical,
                  shortfall: (v.canonical ?? 0) - base.totalBytes, turns: v.turns,
                });
              } else {
                res.integrityFailures += 1;
                opts.logger?.warn?.("reconciler: SESSION STILL INCOMPLETE after a full rebuild", {
                  sessionId: key.sessionId, family: key.family,
                  indexedBytes: v.bytes, readBytes: base.totalBytes,
                  canonicalBytes: v.canonical ?? canonicalBytes,
                  turns: v.turns, dense: v.dense,
                });
              }
            }
          }
        } else {
          res.restored += 1; // the tail landed and verified
        }
      }
    } catch (err) {
      // A parse failure, a missing canonical, or a transient DB/store error must
      // never abort the pass — the session is retried on the next scan.
      res.errors += 1;
      if (laneIdx < 0) failedParents.add(baseKey); // parent threw → defer its lanes this pass
      opts.logger?.warn?.("reconciler: skipped one orphan", {
        err: sanitizeDbError(err),
        sessionId: key.sessionId,
        family: key.family,
      });
    }
    if (delay > 0) await sleep(delay);
  }

  // COUNT SWEEP — finds records missing from sessions the byte gate calls fine.
  //
  // Everything above is reached through the staleness gate, which selects a
  // session only when its byte watermark is BEHIND the canonical. That gate is
  // blind by construction to every failure that leaves the byte count looking
  // right: records lost from the MIDDLE of a canonical, where the lane stays
  // seq-dense AND byte-covering. Such a session reads as healthy, is never
  // selected, and so is never re-examined by anything.
  //
  // What it does NOT cover, stated so the counter is not over-read: the oracle
  // is a LOWER bound (parseChunk is stateful, so an append-built lane legally
  // holds more than parse(whole)), which means duplication and an over-stamped
  // watermark with intact turns both pass it. Those need their own detectors.
  //
  // The canonical's own record count is the only detector, and it costs one
  // object read per session — far too much for the whole corpus every pass. So
  // this is incremental: prove the least-recently-verified rows, stamp them,
  // and rotate. A failure never stamps, so it is retried rather than skipped.
  try {
    if (opts.isSaturated?.()) {
      // Already counted if the orphan loop stood down for the same reason —
      // one stand-down is one event, not two.
      if (res.yieldedToLive === 0) res.yieldedToLive += 1;
      opts.logger?.info?.("reconciler: live pool saturated — skipping the count sweep this pass");
      throw new SweepSkipped();
    }
    await deepVerifySweep(db, store, opts, res, sleep, delay);
    await deepVerifyLanes(db, store, opts, res, sleep, delay, opts.deepVerifyPerPass ?? 0);
    // How much of the corpus has still never been proven. Reported every pass so
    // convergence is observable rather than assumed.
    if ((opts.deepVerifyPerPass ?? 0) <= 0) throw new SweepSkipped();
    const [pending] = await db
      .select({ n: dsql<number>`count(*)::int` })
      .from(hxSessions)
      .where(and(isNull(hxSessions.deletedAt), isNull(hxSessions.deepVerifiedAt)));
    const [pendingLanes] = await db
      .select({ n: dsql<number>`count(*)::int` })
      .from(hxSessionAgents)
      .where(and(isNull(hxSessionAgents.deletedAt), isNull(hxSessionAgents.deepVerifiedAt)));
    res.deepVerifyBacklog = Number(pending?.n ?? 0) + Number(pendingLanes?.n ?? 0);
    // How much of that backlog can NEVER converge, because the canonical exceeds
    // the read cap. Reported separately so the two are not confused: a backlog
    // that stops falling is either work remaining or a permanent floor, and an
    // operator cannot tell which from one number.
    //
    // `bytes_uploaded` is a proxy for the object size — cheap (no store call) and
    // sound in the direction that matters: a row already holding more than the
    // cap certainly has an over-cap canonical.
    const cap = maxCanonicalBytes();
    const [floorS] = await db
      .select({ n: dsql<number>`count(*)::int` })
      .from(hxSessions)
      .where(
        and(
          isNull(hxSessions.deletedAt),
          isNull(hxSessions.deepVerifiedAt),
          dsql`${hxSessions.bytesUploaded} > ${cap}`,
        ),
      );
    const [floorL] = await db
      .select({ n: dsql<number>`count(*)::int` })
      .from(hxSessionAgents)
      .where(
        and(
          isNull(hxSessionAgents.deletedAt),
          isNull(hxSessionAgents.deepVerifiedAt),
          dsql`${hxSessionAgents.bytesUploaded} > ${cap}`,
        ),
      );
    res.deepVerifyFloor = Number(floorS?.n ?? 0) + Number(floorL?.n ?? 0);
  } catch (err) {
    // Never discard the repair stats already gathered. A stand-down is not a
    // failure and must not be logged as one.
    if (!(err instanceof SweepSkipped)) {
      opts.logger?.warn?.("reconciler: count sweep failed", { err: sanitizeDbError(err) });
    }
  }

  // Not after a stand-down. correctTitles is an unbounded scan with one object
  // GET per candidate row, which is exactly the load the pass just declined to
  // impose — running it here would make "stood down for load" a lie.
  if (opts.correctExistingTitles !== false && res.yieldedToLive === 0) {
    // A failure here must not discard the orphan-restore stats already gathered.
    try {
      const tc = await correctTitles(db, store, { sleep, logger: opts.logger });
      res.titlesCorrected = tc.corrected;
    } catch (err) {
      opts.logger?.warn?.("reconciler: title correction pass failed", { err: sanitizeDbError(err) });
    }
  }

  // Detection that no repair path covers. These ran NOWHERE before: the
  // detectors shipped with tests and no caller, so the corpus damage they exist
  // to name was never actually looked for in production. An instrument that is
  // not installed measures nothing.
  if (opts.healthSignals) {
    // Sweep-grade hygiene first: rebuilds and session deletes strand
    // turn-embeddings (hx.embeddings carries no FK), and nothing else deletes
    // them. Bounded batch per pass; on a bundle without pgvector the table is
    // absent and the catch leaves the counter null like every optional signal.
    try {
      const pruned = (await db.execute(dsql`
        delete from hx.embeddings
        where owner_kind = 'turn'
          and id in (
            select e2.id
            from hx.embeddings e2
            left join hx.turns t on t.id = e2.owner_id
            where e2.owner_kind = 'turn' and t.id is null
            limit 5000
          )
        returning id
      `)) as unknown as unknown[];
      res.embeddingsPruned = Array.isArray(pruned) ? pruned.length : 0;
      if (res.embeddingsPruned > 0) {
        opts.logger?.info?.("reconciler: pruned orphaned turn embeddings", {
          pruned: res.embeddingsPruned,
        });
      }
    } catch (err) {
      opts.logger?.warn?.("reconciler: embeddings prune skipped", { err: sanitizeDbError(err) });
    }
    try {
      const gaps = await detectByteGaps(db);
      res.byteGapRows = gaps.rows.length;
      res.byteGapBytes = gaps.totalUnindexedBytes;
      res.byteGapBlind = gaps.blindSessions;
      if (gaps.rows.length > 0) {
        // A count is not actionable; the ids are. Bounded so one bad day cannot
        // flood the log.
        opts.logger?.warn?.("reconciler: canonical bytes were never indexed", {
          rows: gaps.rows.length,
          bytes: gaps.totalUnindexedBytes,
          blind: gaps.blindSessions,
          worst: gaps.rows.slice(0, 12).map((r) => ({
            sessionId: r.sessionId,
            agentId: r.agentId,
            bytes: r.unindexedBytes,
          })),
        });
      }
      // 2x the store's own compaction threshold: at 1x, a count briefly above it
      // is just concurrent appends racing a compaction that is about to run.
      const uncompacted = await detectUncompactedCanonicals(db, 1600);
      res.uncompactedCanonicals = uncompacted.length;
      if (uncompacted.length > 0) {
        opts.logger?.warn?.("reconciler: canonicals never compacted", {
          rows: uncompacted.length,
          worst: uncompacted.slice(0, 8),
        });
      }
      // Cleared intents are history; keeping them forever grows the table at
      // 9,844-20,547 rows/day, each holding a user external id, a family and a session
      // id. Pruned here rather than left to a function nobody calls — an instrument
      // that is not installed measures nothing, and one that is never run cleans
      // nothing.
      res.intentsPruned = await pruneClearedChunkIntents(
        db,
        CLEARED_INTENT_RETENTION_MS,
        Date.now(),
      );
    } catch (err) {
      opts.logger?.warn?.("reconciler: health signals failed", { err: sanitizeDbError(err) });
    }
  }

  return res;
}


/** Above this share of deep-verified sessions coming back mismatched, the sweep
 *  stops REPAIRING (it keeps detecting and reporting). A corpus does not rot at
 *  that rate; a comparison bug does. */
const DEEP_MISMATCH_CEILING_RATIO = 0.5;
/** …but never below this many, so a genuinely damaged handful is always
 *  repaired rather than stranded by a ratio computed on tiny numbers. */
const DEEP_MISMATCH_CEILING_MIN_COUNT = 10;

/** Hard bound on how many rows ONE pass may rebuild. The ratio ceiling answers
 *  "is the comparison broken?"; this answers "how much can a wrong answer cost
 *  before a human sees it?" — the two are different questions and a ratio cannot
 *  express the second. A repair rebuilds from the canonical, which IS the source
 *  of truth, so a false positive converges rather than destroys; the bound exists
 *  to keep the write volume of a bad pass reviewable, not to prevent loss. */
const DEEP_REPAIR_MAX_PER_PASS = 40;

/** Prove the least-recently-verified sessions against their canonical's record
 *  count, and rebuild the ones that do not match.
 *
 *  Agent lanes are swept too, and they must be: a lane is a SEPARATE canonical
 *  object (`sid:a:agentId`) with its own row and its own turns, so rebuilding
 *  the parent does not re-derive a single byte of it. A sweep that skipped
 *  lanes would leave every agent transcript unverifiable — the same blind spot
 *  this exists to close, just moved one level down. */
async function deepVerifySweep(
  db: HxDb,
  store: SessionStore,
  opts: ReconcileOptions,
  res: ReconcileResult,
  sleep: (ms: number) => Promise<void>,
  delay: number,
): Promise<void> {
  // Default OFF here on purpose. reconcileOrphans is shared, and a sweep that
  // silently reads a canonical per session would change the cost and the
  // behaviour of every caller that never asked for it. The fortress opts in
  // (see main.ts); callers that want it pass the cap.
  const limit = opts.deepVerifyPerPass ?? 0;
  if (limit <= 0) return;

  // Oldest-verified first; NULLS FIRST means a corpus that has never been swept
  // is worked through from the beginning before anything is revisited.
  const candidates = await db
    .select({
      rowId: hxSessions.id,
      sessionId: hxSessions.sessionId,
      family: hxSessions.family,
      userId: hxUsers.externalId,
    })
    .from(hxSessions)
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(isNull(hxSessions.deletedAt))
    // Tiebreaker on id: NULLS FIRST alone leaves the never-verified rows in an
    // arbitrary order, so successive passes could revisit an overlapping subset
    // instead of walking the corpus. Stamping guarantees forward progress
    // either way, but a deterministic order makes the rotation predictable.
    .orderBy(dsql`${hxSessions.deepAttemptedAt} asc nulls first`, hxSessions.id)
    .limit(limit);

  // Pass-scoped ceiling state. The denominator MUST be the whole pass, never the
  // rows judged so far: `res.deepVerified` grows with each judgement, so on a
  // contiguous damaged cluster `mismatched > verified * RATIO` is already true at
  // the FIRST row and MIN_COUNT becomes the only brake — exactly (MIN_COUNT - 1)
  // repairs per pass, observed in production as a flat 9 for three days.
  //
  // LOCAL, not on `res`, for the second half of the same bug: the lane sweep runs
  // after the parent sweep and shares `res`, so it used to inherit a ceiling that
  // was already armed and repaired ZERO lanes for the count sweep's entire life.
  const passSize = candidates.length;
  let passMismatched = 0;
  let passRepaired = 0;
  for (const row of candidates) {
    // Yield mid-flight, not only at the door. Checking saturation just once
    // before the sweep starts still lets it issue up to a hundred canonical
    // reads and 40-115 s rebuilds however starved live ingest becomes.
    if (opts.isSaturated?.()) {
      if (res.yieldedToLive === 0) res.yieldedToLive += 1;
      opts.logger?.info?.("reconciler: live pool saturated — count sweep stopping mid-pass");
      return;
    }
    const key: SessionKey = {
      userId: row.userId,
      family: row.family,
      sessionId: row.sessionId,
    };
    try {
      if (await isSessionDeleted(db, key.userId, key.sessionId)) {
        // Tombstoned between selection and now. Advance the cursor so it leaves
        // the queue, but never claim it was PROVEN — nothing was read. If a
        // purge is abandoned half-way the row survives, and a false proof on it
        // would be permanent.
        await stampAttempted(db, row.rowId);
        continue;
      }
      // CAS anchor sampled BEFORE the read. The window that matters is between
      // reading the canonical and committing the rebuild; an anchor taken after
      // the read cannot see a commit that landed during it, and the rebuild
      // would then delete that commit's turns and reinstate stale text.
      const anchor = await currentBytes(db, key);
      // Stat FIRST, and read only once the stat has cleared three gates. It
      // decides whether the row is judgeable at all, whether it is merely BEHIND
      // (someone else's job), and whether it is safe to pull into memory.
      let statBytes: number | null = null;
      try {
        statBytes = await store.statCanonical(key);
      } catch {
        // leave null — handled as "cannot judge" immediately below
      }
      // No stat means no corroboration, and without it a truncated read is
      // indistinguishable from a smaller canonical: `expected` comes out short,
      // the session looks fine, and it gets stamped as checked. That is a
      // PERMANENT false clean — the backlog counts only rows whose stamp is
      // NULL, so it never comes off.
      if (statBytes == null) {
        res.deepErrors += 1;
        opts.logger?.warn?.("reconciler: count sweep could not stat the canonical — cannot judge", {
          sessionId: key.sessionId, family: key.family,
        });
        await stampAttempted(db, row.rowId);
        if (delay > 0) await sleep(delay);
        continue;
      }
      // THE SWEEP ONLY JUDGES BYTE-COVERING ROWS. Its damage class is "seq-dense
      // AND byte-covering"; a lane merely BEHIND its canonical belongs to the
      // byte-staleness gate, which repairs it by APPENDING the tail.
      //
      // Judging one here is not just useless, it is destructive. The gateway
      // acks a chunk once the canonical is composed and DEFERS the indexing, so
      // there is a real window where the canonical holds records the index has
      // not seen. In that window `actual < expected` is indistinguishable from
      // missing records, and the sweep answers with `replace: true`: it deletes
      // the lane and its embeddings, the deferred commit then lands and
      // re-appends its chunk, and the session ends up DUPLICATED — and stamped.
      if (anchor !== undefined && statBytes > anchor) {
        res.skippedBehind += 1;
        await stampAttempted(db, row.rowId);
        if (delay > 0) await sleep(delay);
        continue;
      }
      // Size gate before the read. This is the one read path with no cap, and
      // unlike a real repair it runs for rotation-chosen rows every pass:
      // parseChunk retains every parsed record before filtering, so a 100 MB
      // transcript materialises on the order of a gigabyte of heap inside the
      // live-ingest process.
      if (statBytes > maxCanonicalBytes()) {
        // NOT stamped — deliberately. Stamping advances the rotation, which for a
        // permanently over-cap canonical means the session is skipped once and
        // then never looked at again: it drops out of the backlog while never
        // having been judged, so the corpus reads as converging while the largest
        // sessions in it have no oracle at all. On the reference deployment that
        // silently covered the 12 biggest sessions, one of them 475 MB with a
        // measured byte gap.
        //
        // Leaving it unstamped costs one stat per pass (cheap — no read, no
        // parse) and keeps the session visibly unproven, which is the truth.
        res.tooLargeToJudge += 1;
        opts.logger?.warn?.("reconciler: canonical exceeds the read cap — no completeness oracle for this session", {
          sessionId: key.sessionId, family: key.family, statBytes, cap: maxCanonicalBytes(),
        });
        if (delay > 0) await sleep(delay);
        continue;
      }

      const text = await store.readCanonicalText(key);
      const readBytes = Buffer.byteLength(text);

      // Decide the byte question BEFORE parsing: neither arm below needs the
      // parse, and on the deferral paths it would allocate the decoded string
      // plus a multiple of it in retained records, only to throw it away.
      //
      // A read that disagrees with the stat has TWO possible causes and they
      // demand opposite handling, so the length alone cannot decide:
      //
      //   the canonical GREW between the stat and the read — the text is newer
      //   than the watermark we would judge it against, so judging it reports
      //   false damage and rebuilds a healthy session, which the gateway's
      //   deferred commit then duplicates. Must defer.
      //
      //   the DECODE inflated — `readCanonicalText` is `buf.toString("utf8")`,
      //   and each ill-formed byte becomes U+FFFD, which re-encodes to three.
      //   So a canonical holding non-UTF-8 bytes always reads LARGER than its
      //   object. That is permanent, not transient: deferring it retires the
      //   session from the only detector that can see a missing middle record,
      //   forever, filed under a counter that says "transient".
      //
      // Only a re-stat separates them. It costs one HEAD, and only on the rare
      // path where the two lengths already disagree.
      if (readBytes !== statBytes) {
        let statAfter: number | null = null;
        try {
          statAfter = await store.statCanonical(key);
        } catch {
          // unknowable — treat as growth and re-judge next pass
        }
        if (statAfter === null || statAfter > statBytes) {
          res.liveRaces += 1;
          opts.logger?.info?.("reconciler: canonical grew between stat and read — re-judging next pass", {
            sessionId: key.sessionId, family: key.family, readBytes, statBytes, statAfter,
          });
          await stampAttempted(db, row.rowId);
          if (delay > 0) await sleep(delay);
          continue;
        }
        // Object unchanged and the read came back LARGER: a lossy decode. U+FFFD
        // substitution never touches a newline (0x0A is valid ASCII), so the
        // record count is unaffected and this text is still a sound oracle.
        // Fall through and judge it.
      }

      // Reading SMALLER than an unchanged object means the read was truncated,
      // and no rebuild can fix that — it is the store's problem.
      if (readBytes < statBytes) {
        res.shortReads += 1;
        opts.logger?.warn?.("reconciler: count sweep read short of the canonical — cannot judge", {
          sessionId: key.sessionId, family: key.family, readBytes, statBytes,
        });
        await stampAttempted(db, row.rowId);
        if (delay > 0) await sleep(delay);
        continue;
      }

      const expected = parseChunk(text).turns.length;
      const actual = await countLaneTurns(db, row.rowId, null);

      // Counted only once the row is judgeable — an unjudgeable row is not
      // evidence, and this is also the systematic-bug ceiling's denominator.
      res.deepVerified += 1;

      // THE ORACLE, and its exact strength. parseChunk is stateful across the
      // whole text, so a lane BUILT by appending chunks holds the SUM of
      // per-chunk parses, which is >= parse(whole) — measured: a Codex lane
      // appended as 3 turns parses whole to 1.
      //
      //   actual <  expected  -> records are definitely missing. Repairable.
      //   actual >= expected  -> proves nothing. Either that statefulness (the
      //                          common case) or genuine duplication, and this
      //                          oracle cannot tell them apart. Acting on it
      //                          would rewrite healthy sessions corpus-wide and
      //                          destroy their embeddings, every rotation.
      if (actual >= expected) {
        if (actual > expected) {
          res.deepOvercount += 1;
          // NAME the overcount, do not just count it. The bare counter could say how
          // many rows hold more turns than their canonical parses to, never WHICH or
          // BY HOW MUCH — and that is the one fact that decides what to do about the
          // 22,301 duplicate turns across 54 sessions.
          //
          //   actual > expected  -> the index holds MORE than the object. The object is
          //                         clean, the index is inflated, and a `replace`
          //                         rebuild fixes it permanently.
          //   actual = expected  -> the object itself holds the record twice. No rebuild
          //                         can help; only a client re-upload corrects it.
          //
          // Both readings were argued during this work and neither could be settled,
          // because the number that separates them was never written down. It is
          // bounded by the per-pass rotation (at most deepVerifyPerPass lines), and
          // overcount is EXPECTED to be non-zero on a healthy corpus — parseChunk is
          // stateful, so an append-built lane legally exceeds parse(whole). So this is
          // info, not a warning: evidence, not an alarm.
          opts.logger?.info?.(
            "reconciler: session holds MORE turns than its canonical parses to",
            {
            sessionId: key.sessionId,
            family: key.family,
            indexedTurns: actual,
            canonicalRecords: expected,
            excess: actual - expected,
            kind: "overcount",
            },
          );
          await recordIntegrityFinding(db, {
            userExternalId: key.userId,
            family: key.family,
            sessionId: key.sessionId,
            kind: "overcount",
            detail: { indexedTurns: actual, canonicalRecords: expected, excess: actual - expected },
          });
        }
        await stampDeepVerified(db, row.rowId);
        if (delay > 0) await sleep(delay);
        continue;
      }
      res.deepMismatched += 1;
      passMismatched += 1;
      opts.logger?.warn?.("reconciler: count sweep found records missing from a session the byte gate calls healthy", {
        sessionId: key.sessionId,
        family: key.family,
        indexedTurns: actual,
        canonicalRecords: expected,
        kind: "missing_records",
      });

      // FORTRESS_GUARANTOR_REPAIR_STALE=false is documented as "detection keeps
      // running, acting stops". It must brake THIS repair too, or an operator
      // reaching for it to stop a guarantor that is damaging data finds it does
      // nothing.
      if (!(opts.repairStaleIndexes ?? true)) {
        await stampAttempted(db, row.rowId);
        if (delay > 0) await sleep(delay);
        continue;
      }

      // Systematic-bug ceiling. If MOST of what we prove comes back mismatched,
      // the likelier explanation is that the comparison itself is wrong — a
      // parser change, a counting change — not that the corpus rotted. Repairing
      // on a broken comparison would rewrite healthy sessions corpus-wide, which
      // is far worse than leaving damage in place for one pass. Detection keeps
      // running and keeps reporting; only the WRITES stand down.
      const systematic =
        passMismatched >= DEEP_MISMATCH_CEILING_MIN_COUNT &&
        passMismatched > passSize * DEEP_MISMATCH_CEILING_RATIO;
      const budgetSpent = passRepaired >= DEEP_REPAIR_MAX_PER_PASS;
      if (systematic || budgetSpent) {
        res.deepRefused += 1;
        opts.logger?.warn?.("reconciler: count-sweep repair stood down", {
          reason: systematic ? "implausible mismatch rate" : "per-pass repair budget spent",
          mismatched: passMismatched,
          passSize,
          repairedThisPass: passRepaired,
        });
        await stampAttempted(db, row.rowId);
        if (delay > 0) await sleep(delay);
        continue;
      }

      // Rebuild from the text we just read, CAS-anchored to the byte count taken
      // BEFORE that read (above), so any commit landing in the meantime aborts
      // the rebuild instead of being deleted by it.
      let outcome: Awaited<ReturnType<typeof ingestCommit>>;
      try {
        outcome = await ingestCommit(db, {
          key,
          chunkId: repairChunkId("count"),
          replace: true,
          ingestChannel: RECONCILED_CHANNEL,
          chunkText: text,
          totalBytes: Buffer.byteLength(text),
          objectBytes: statBytes,
          componentCount: 1,
          meta: null,
          attribution: {
            orgExternalId: null,
            projectExternalId: null,
            repoSlug: null,
            deviceId: null,
          },
          recovered: true,
          rebuild: true,
          ...(anchor !== undefined ? { expectIndexedBytes: anchor } : {}),
        });
      } catch (err) {
        if (!(err instanceof IndexAdvancedError)) throw err;
        // A live write beat us to it. Leave UNSTAMPED so the next pass judges
        // the newer content rather than recording a verdict about old content.
        res.liveRaces += 1;
        opts.logger?.info?.("reconciler: session advanced before its count repair — deferring", {
          sessionId: key.sessionId, family: key.family,
          expected: err.expected, nowIndexed: err.actual,
        });
        await stampAttempted(db, row.rowId);
        if (delay > 0) await sleep(delay);
        continue;
      }

      if (!outcome.applied) {
        res.noOpRepairs += 1;
        opts.logger?.warn?.("reconciler: count repair reported NO-OP", {
          sessionId: key.sessionId, family: key.family, reason: outcome.reason,
        });
        await stampAttempted(db, row.rowId);
        if (delay > 0) await sleep(delay);
        continue;
      }

      // Re-count rather than assume. A repair that did not actually make the
      // count exact must NOT be stamped — stamping it would retire the session
      // from the sweep while still damaged, which is the precise failure this
      // whole mechanism exists to prevent.
      const after = await countLaneTurns(db, row.rowId, null);
      if (after === expected) {
        res.deepRepaired += 1;
        passRepaired += 1;
        await stampDeepVerified(db, row.rowId);
      } else if (after > expected) {
        // A live append landed between the rebuild and this count. The repair
        // paths route exactly this through `grew`; treating it as damage here
        // would raise `integrityFailures` — "the only outcome that leaves damage
        // behind" — on a healthy session. Never stamped: re-judged next pass.
        res.liveRaces += 1;
        opts.logger?.info?.("reconciler: session grew during its count repair — re-judging next pass", {
          sessionId: key.sessionId, family: key.family, indexedTurns: after, canonicalRecords: expected,
        });
        await stampAttempted(db, row.rowId);
      } else {
        res.integrityFailures += 1;
        opts.logger?.warn?.("reconciler: count repair did not reach the canonical's record count", {
          sessionId: key.sessionId, family: key.family,
          indexedTurns: after, canonicalRecords: expected,
        });
        await stampAttempted(db, row.rowId);
      }
    } catch (err) {
      // Never stamp PROVEN on failure — but do advance the rotation cursor, or
      // a permanently unreadable canonical parks itself at the head of the queue
      // and, once there are as many such rows as the per-pass cap, the sweep
      // never reaches another row again.
      res.deepErrors += 1;
      opts.logger?.warn?.("reconciler: count sweep skipped one session", {
        err: sanitizeDbError(err),
        sessionId: key.sessionId,
        family: key.family,
      });
      await stampAttempted(db, row.rowId).catch(() => {});
    }
    if (delay > 0) await sleep(delay);
  }
}

/** Prove the least-recently-verified AGENT LANES the same way. A lane carries
 *  its own canonical and its own turns, so it needs its own count. */
async function deepVerifyLanes(
  db: HxDb,
  store: SessionStore,
  opts: ReconcileOptions,
  res: ReconcileResult,
  sleep: (ms: number) => Promise<void>,
  delay: number,
  limit: number,
): Promise<void> {
  if (limit <= 0) return;
  const candidates = await db
    .select({
      laneRowId: hxSessionAgents.id,
      agentId: hxSessionAgents.agentExternalId,
      sessionRowId: hxSessions.id,
      sessionId: hxSessions.sessionId,
      family: hxSessions.family,
      userId: hxUsers.externalId,
    })
    .from(hxSessionAgents)
    .innerJoin(hxSessions, eq(hxSessions.id, hxSessionAgents.sessionId))
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(and(isNull(hxSessionAgents.deletedAt), isNull(hxSessions.deletedAt)))
    .orderBy(dsql`${hxSessionAgents.deepAttemptedAt} asc nulls first`, hxSessionAgents.id)
    .limit(limit);

  // Pass-scoped ceiling state. The denominator MUST be the whole pass, never the
  // rows judged so far: `res.deepVerified` grows with each judgement, so on a
  // contiguous damaged cluster `mismatched > verified * RATIO` is already true at
  // the FIRST row and MIN_COUNT becomes the only brake — exactly (MIN_COUNT - 1)
  // repairs per pass, observed in production as a flat 9 for three days.
  //
  // LOCAL, not on `res`, for the second half of the same bug: the lane sweep runs
  // after the parent sweep and shares `res`, so it used to inherit a ceiling that
  // was already armed and repaired ZERO lanes for the count sweep's entire life.
  const passSize = candidates.length;
  let passMismatched = 0;
  let passRepaired = 0;
  for (const row of candidates) {
    if (opts.isSaturated?.()) {
      if (res.yieldedToLive === 0) res.yieldedToLive += 1;
      opts.logger?.info?.("reconciler: live pool saturated — lane sweep stopping mid-pass");
      return;
    }
    // Two different keys, and confusing them is a silent content mix-up. The
    // STORE key carries the `:a:agentId` suffix — that composite IS the lane's
    // own canonical object, and reading the parent would compare a lane against
    // entirely the wrong content. The COMMIT key is the bare session id, because
    // ingestAgentCommit takes the parent identity plus `agentId` separately.
    const storeKey: SessionKey = {
      userId: row.userId,
      family: row.family,
      sessionId: `${row.sessionId}${AGENT_LANE}${row.agentId}`,
    };
    const commitKey: SessionKey = {
      userId: row.userId,
      family: row.family,
      sessionId: row.sessionId,
    };
    try {
      if (await isSessionDeleted(db, commitKey.userId, row.sessionId)) {
        // Advance the cursor, never claim proof — see the parent path.
        await stampLaneAttempted(db, row.laneRowId);
        continue;
      }
      // CAS anchor BEFORE the read, same reasoning as the parent path: the
      // window that matters is the read itself. The lane path previously passed
      // no anchor at all, so a live lane commit that landed while the sweep held
      // the text was deleted by the rebuild and the lane then stamped verified.
      const laneAnchor = await currentLaneBytes(db, row.laneRowId);
      // Stat first, read last — same three gates as the parent path.
      let statBytes: number | null = null;
      try {
        statBytes = await store.statCanonical(storeKey);
      } catch {
        // leave null — handled as "cannot judge" immediately below
      }
      if (statBytes == null) {
        res.deepErrors += 1;
        opts.logger?.warn?.("reconciler: count sweep could not stat a lane canonical — cannot judge", {
          sessionId: row.sessionId, agentId: row.agentId,
        });
        await stampLaneAttempted(db, row.laneRowId);
        if (delay > 0) await sleep(delay);
        continue;
      }
      // Merely BEHIND its canonical is the byte gate's job. Judging it here
      // deletes a healthy lane and lets a deferred commit duplicate it — see the
      // parent path for the full sequence.
      if (laneAnchor !== undefined && statBytes > laneAnchor) {
        res.skippedBehind += 1;
        await stampLaneAttempted(db, row.laneRowId);
        if (delay > 0) await sleep(delay);
        continue;
      }
      if (statBytes > maxCanonicalBytes()) {
        // Unstamped for the same reason as the parent path.
        res.tooLargeToJudge += 1;
        opts.logger?.warn?.("reconciler: lane canonical exceeds the read cap — no completeness oracle", {
          sessionId: row.sessionId, agentId: row.agentId, statBytes, cap: maxCanonicalBytes(),
        });
        if (delay > 0) await sleep(delay);
        continue;
      }

      const text = await store.readCanonicalText(storeKey);
      const readBytes = Buffer.byteLength(text);

      // Re-stat to tell GROWTH (defer) from a LOSSY DECODE (judgeable, and
      // permanent if deferred) — see the parent path for the full reasoning.
      // Decided before the parse so a deferral costs one string, not a parse.
      if (readBytes !== statBytes) {
        let statAfter: number | null = null;
        try {
          statAfter = await store.statCanonical(storeKey);
        } catch {
          // unknowable — treat as growth and re-judge next pass
        }
        if (statAfter === null || statAfter > statBytes) {
          res.liveRaces += 1;
          opts.logger?.info?.("reconciler: lane canonical grew between stat and read — re-judging next pass", {
            sessionId: row.sessionId, agentId: row.agentId, readBytes, statBytes, statAfter,
          });
          await stampLaneAttempted(db, row.laneRowId);
          if (delay > 0) await sleep(delay);
          continue;
        }
        // Unchanged object, larger read: lossy decode. Record count unaffected.
      }

      if (readBytes < statBytes) {
        res.shortReads += 1;
        opts.logger?.warn?.("reconciler: count sweep read a lane short of its canonical — cannot judge", {
          sessionId: row.sessionId, agentId: row.agentId, readBytes, statBytes,
        });
        await stampLaneAttempted(db, row.laneRowId);
        if (delay > 0) await sleep(delay);
        continue;
      }

      const expected = parseChunk(text).turns.length;
      const actual = await countLaneTurns(db, row.sessionRowId, row.laneRowId);

      res.deepVerified += 1;

      // Lower bound only — see the parent sweep for why parse(whole) cannot be
      // an equality oracle against an append-built lane.
      if (actual >= expected) {
        if (actual > expected) {
          res.deepOvercount += 1;
          // Same question, per lane — see the parent sweep.
          opts.logger?.info?.("reconciler: lane holds MORE turns than its canonical parses to", {
            sessionId: row.sessionId,
            agentId: row.agentId,
            indexedTurns: actual,
            canonicalRecords: expected,
            excess: actual - expected,
            kind: "overcount",
          });
          await recordIntegrityFinding(db, {
            userExternalId: storeKey.userId,
            family: row.family,
            sessionId: row.sessionId,
            agentExternalId: row.agentId,
            kind: "overcount",
            detail: { indexedTurns: actual, canonicalRecords: expected, excess: actual - expected },
          });
        }
        await stampLaneVerified(db, row.laneRowId);
        if (delay > 0) await sleep(delay);
        continue;
      }
      res.deepMismatched += 1;
      passMismatched += 1;
      opts.logger?.warn?.("reconciler: count sweep found records missing from an agent lane", {
        sessionId: row.sessionId, agentId: row.agentId, family: row.family,
        indexedTurns: actual, canonicalRecords: expected,
        kind: "missing_records",
      });

      if (!(opts.repairStaleIndexes ?? true)) {
        await stampLaneAttempted(db, row.laneRowId);
        if (delay > 0) await sleep(delay);
        continue;
      }

      const systematic =
        passMismatched >= DEEP_MISMATCH_CEILING_MIN_COUNT &&
        passMismatched > passSize * DEEP_MISMATCH_CEILING_RATIO;
      const budgetSpent = passRepaired >= DEEP_REPAIR_MAX_PER_PASS;
      if (systematic || budgetSpent) {
        res.deepRefused += 1;
        opts.logger?.warn?.("reconciler: count-sweep repair stood down", {
          reason: systematic ? "implausible mismatch rate" : "per-pass repair budget spent",
          mismatched: passMismatched,
          passSize,
          repairedThisPass: passRepaired,
        });
        // Advance the cursor even here. The counters are pass-LOCAL now, so the lane
        // loop can no longer inherit a ceiling the parent sweep already armed — but a
        // lane refused on its own merits still must not stay unstamped, or the
        // rotation pins itself to the same lanes forever.
        await stampLaneAttempted(db, row.laneRowId);
        if (delay > 0) await sleep(delay);
        continue;
      }

      let outcome: Awaited<ReturnType<typeof ingestAgentCommit>>;
      try {
        outcome = await ingestAgentCommit(db, {
          key: commitKey,
          agentId: row.agentId,
          chunkId: repairChunkId("count"),
          replace: true,
          ingestChannel: RECONCILED_CHANNEL,
          chunkText: text,
          totalBytes: Buffer.byteLength(text),
          objectBytes: statBytes,
          componentCount: 1,
          meta: null,
          attribution: {
            orgExternalId: null,
            projectExternalId: null,
            repoSlug: null,
            deviceId: null,
          },
          recovered: true,
          rebuild: true,
          ...(laneAnchor !== undefined ? { expectIndexedBytes: laneAnchor } : {}),
        });
      } catch (err) {
        if (!(err instanceof IndexAdvancedError)) throw err;
        res.liveRaces += 1;
        opts.logger?.info?.("reconciler: lane advanced before its count repair — deferring", {
          sessionId: row.sessionId, agentId: row.agentId,
          expected: err.expected, nowIndexed: err.actual,
        });
        await stampLaneAttempted(db, row.laneRowId);
        if (delay > 0) await sleep(delay);
        continue;
      }

      if (!outcome.applied) {
        res.noOpRepairs += 1;
        opts.logger?.warn?.("reconciler: lane count repair reported NO-OP", {
          sessionId: row.sessionId, agentId: row.agentId, reason: outcome.reason,
        });
        await stampLaneAttempted(db, row.laneRowId);
        if (delay > 0) await sleep(delay);
        continue;
      }

      // Re-count, never assume — and only stamp on an exact match.
      const after = await countLaneTurns(db, row.sessionRowId, row.laneRowId);
      if (after === expected) {
        res.deepRepaired += 1;
        passRepaired += 1;
        await stampLaneVerified(db, row.laneRowId);
      } else if (after > expected) {
        res.liveRaces += 1;
        opts.logger?.info?.("reconciler: lane grew during its count repair — re-judging next pass", {
          sessionId: row.sessionId, agentId: row.agentId, indexedTurns: after, canonicalRecords: expected,
        });
        await stampLaneAttempted(db, row.laneRowId);
      } else {
        res.integrityFailures += 1;
        opts.logger?.warn?.("reconciler: lane count repair did not reach the canonical's record count", {
          sessionId: row.sessionId, agentId: row.agentId,
          indexedTurns: after, canonicalRecords: expected,
        });
        await stampLaneAttempted(db, row.laneRowId);
      }
    } catch (err) {
      res.deepErrors += 1;
      opts.logger?.warn?.("reconciler: count sweep skipped one agent lane", {
        err: sanitizeDbError(err),
        sessionId: row.sessionId, agentId: row.agentId,
      });
      await stampLaneAttempted(db, row.laneRowId).catch(() => {});
    }
    if (delay > 0) await sleep(delay);
  }
}

async function stampLaneVerified(db: HxDb, laneRowId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(hxSessionAgents)
    .set({ deepVerifiedAt: now, deepAttemptedAt: now })
    .where(eq(hxSessionAgents.id, laneRowId));
}

async function stampLaneAttempted(db: HxDb, laneRowId: string): Promise<void> {
  await db
    .update(hxSessionAgents)
    .set({ deepAttemptedAt: new Date().toISOString() })
    .where(eq(hxSessionAgents.id, laneRowId));
}

/** The lane row's byte count right now, for the rebuild CAS. */
async function currentLaneBytes(db: HxDb, laneRowId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ bytes: hxSessionAgents.bytesUploaded })
    .from(hxSessionAgents)
    .where(eq(hxSessionAgents.id, laneRowId))
    .limit(1);
  return row ? Number(row.bytes ?? 0) : undefined;
}

/** Turns indexed for one lane of a session row (null agent = the parent). */
async function countLaneTurns(db: HxDb, sessionRowId: string, agentRowId: string | null): Promise<number> {
  const [agg] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(hxTurns)
    .where(
      and(
        eq(hxTurns.sessionId, sessionRowId),
        agentRowId ? eq(hxTurns.agentId, agentRowId) : isNull(hxTurns.agentId),
      ),
    );
  return Number(agg?.n ?? 0);
}

/** Record that this row's count was proven NOW. Only ever called after an exact
 *  match — never after a repair that failed to reach the expected count. */
async function stampDeepVerified(db: HxDb, sessionRowId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(hxSessions)
    .set({ deepVerifiedAt: now, deepAttemptedAt: now })
    .where(eq(hxSessions.id, sessionRowId));
}

/** Record that the sweep LOOKED at this row without proving it. Advances the
 *  rotation so an unprovable row cannot sit at the head of the queue forever,
 *  while leaving `deep_verified_at` NULL so the backlog stays truthful. */
async function stampAttempted(db: HxDb, sessionRowId: string): Promise<void> {
  await db
    .update(hxSessions)
    .set({ deepAttemptedAt: new Date().toISOString() })
    .where(eq(hxSessions.id, sessionRowId));
}
