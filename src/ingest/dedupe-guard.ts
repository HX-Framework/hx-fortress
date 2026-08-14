// Write-path duplicate prevention (MC-2606 §7c) — refuse nothing, duplicate
// nothing: an append whose EVERY record is already indexed for its lane is a
// re-send, and the fortress answers it with a no-op success instead of
// composing the bytes again.
//
// WHY skip-only, never refuse. The one thing this path must never do is stall
// a live session's NEW records behind an error a client may not know how to
// resolve — loss outranks duplication. So the guard acts only where it is
// PROVABLY loss-free: a chunk is skipped iff every record uuid in it is
// already in the lane's index (the content exists; nothing can be lost by not
// writing it twice). A chunk with ANY new record — including a partial
// overlap from a regressed client offset — passes whole; the overlap is
// recorded as an integrity finding instead of blocked. Chunks the guard
// cannot judge (unparseable lines, uuid-less records — 5.2% of the corpus —
// empty, or oversized) FAIL OPEN and pass.
//
// WHY the same verdict must gate BOTH RPCs. Compose (appendChunkToCanonical)
// and index (ingestCommit) are separate RPCs the cloud sequences. Skipping
// only the compose while the index still ingests re-creates the duplicate in
// the index; skipping only the index while the bytes compose leaves the index
// BELOW parse(canonical) — the failed-attempt-A shape. Both callers therefore
// consult THIS predicate. The recomputation can disagree across the pair
// (fail-open on one side, a race on the other); every such asymmetry is
// transient BY CONSTRUCTION: the guarantor's sweep rebuilds any lane whose
// index disagrees with its canonical, and rebuilds carry `replace: true`,
// which bypasses this guard entirely. Nothing here can loop, and nothing here
// can make the index disagree with the canonical DURABLY.
//
// WHY record-level uuids, not hashes and not turns. A hash cannot distinguish
// a re-sent record from a legitimately identical new one; turn-level identity
// needs the per-commit block ordinal and is the oracle's business. The client
// stamps each record with its own uuid, and "is that uuid already indexed in
// this lane" is exactly the idempotency question.
//
// Kill switch: FORTRESS_DEDUPE_GUARD_DISABLED (inverted, default ON — same
// convention as FORTRESS_GUARANTOR_DISABLED).

import { sql as dsql } from "drizzle-orm";

import { parseBooleanEnv } from "../env";
import type { HxDb } from "../host/postgres/db";

export interface GuardLane {
  userExternalId: string;
  family: string;
  /** Parent session id WITHOUT the `:a:` lane suffix. */
  sessionId: string;
  /** The lane's agent external id, or null for the parent lane. */
  agentExternalId: string | null;
}

export function dedupeGuardEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !parseBooleanEnv(env.FORTRESS_DEDUPE_GUARD_DISABLED);
}

/** Bytes past which the guard stands aside rather than parse on the hot path.
 *  Ordinary appends are deltas (KBs–MBs); anything bigger is a whole-transcript
 *  shape, which arrives as `replace` and bypasses the guard anyway. */
export const MAX_GUARD_CHUNK_BYTES = 32 * 1024 * 1024;

/** Every record uuid of a JSONL chunk, in order — or null when the guard must
 *  stand aside: an unparseable line, a record without a string uuid, an empty
 *  chunk, or one past the size bound. Null means PASS, never refuse. */
export function chunkRecordUuids(chunkText: string): string[] | null {
  if (chunkText.length === 0) return null;
  if (Buffer.byteLength(chunkText) > MAX_GUARD_CHUNK_BYTES) return null;
  const uuids: string[] = [];
  for (const raw of chunkText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return null;
    }
    const uuid = (rec as { uuid?: unknown } | null)?.uuid;
    if (typeof uuid !== "string" || uuid.length === 0) return null;
    uuids.push(uuid);
  }
  return uuids.length > 0 ? uuids : null;
}

export interface JudgeOptions {
  /** Set when the passed handle is a LIVE TRANSACTION. Fail-open is not free
   *  inside one: PostgreSQL aborts the whole transaction on any statement
   *  error, so a swallowed guard failure would poison every statement after
   *  it. With this set the guard's queries run inside a SAVEPOINT and roll
   *  back to it on failure, leaving the transaction usable. */
  inTransaction?: boolean;
  /** Test override for MAX_GUARD_LANE_TURNS. */
  maxLaneTurns?: number;
}

/** Lanes holding more indexed turns than this are not probed (fail open). The
 *  membership probe unwraps raw_event per lane row, so a pathological lane
 *  would pay seconds on the hot ingest path — inside the per-session advisory
 *  lock. Real lanes sit orders of magnitude below this; the corpus's giants
 *  are the two >128 MiB sessions. The pre-count that enforces it touches only
 *  the (session_id, agent_id) index — no jsonb — so everyone else pays ~a
 *  millisecond for the ceiling. The out-of-band uuid expression index is the
 *  upgrade that would make giants cheap to probe, if that day comes. */
export const MAX_GUARD_LANE_TURNS = 100_000;

export type AppendVerdict =
  /** Compose and ingest normally. `overlap` > 0 means SOME records were already
   *  indexed (a partial re-send) — passed anyway, because blocking it could
   *  stall the chunk's NEW records, and loss outranks duplication. */
  | { verdict: "pass"; overlap: number }
  /** Every record is already indexed: answer success, write nothing. */
  | { verdict: "skip_duplicate"; records: number };

/** Judge one append against the lane's index. NEVER throws — any internal
 *  failure (db down, bad SQL, unexpected shape) returns a pass verdict. */
export async function judgeAppend(
  db: HxDb,
  lane: GuardLane,
  chunkText: string,
  opts: JudgeOptions = {},
): Promise<AppendVerdict> {
  try {
    if (!dedupeGuardEnabled()) return { verdict: "pass", overlap: 0 };
    const uuids = chunkRecordUuids(chunkText);
    if (!uuids) return { verdict: "pass", overlap: 0 };
    const distinct = [...new Set(uuids)];
    // A pathological chunk with thousands of records is a whole-transcript
    // shape; stand aside rather than build a giant membership probe.
    if (distinct.length > 10_000) return { verdict: "pass", overlap: 0 };
    if (opts.inTransaction) await db.execute(dsql`savepoint dedupe_guard`);
    let rows: Array<{ present: number | string }>;
    try {
      // Cheap ceiling first: count the lane WITHOUT touching raw_event.
      const laneCap = opts.maxLaneTurns ?? MAX_GUARD_LANE_TURNS;
      const laneCount = (await db.execute(
        lane.agentExternalId === null
          ? dsql`
              select count(*) as n
              from hx.turns t
              join hx.sessions s on s.id = t.session_id and s.deleted_at is null
              join hx.users u on u.id = s.user_id
              where u.external_id = ${lane.userExternalId}
                and s.family = ${lane.family}
                and s.session_id = ${lane.sessionId}
                and t.agent_id is null
            `
          : dsql`
              select count(*) as n
              from hx.turns t
              join hx.sessions s on s.id = t.session_id and s.deleted_at is null
              join hx.users u on u.id = s.user_id
              join hx.session_agents a
                on a.id = t.agent_id
               and a.agent_external_id = ${lane.agentExternalId}
               and a.deleted_at is null
              where u.external_id = ${lane.userExternalId}
                and s.family = ${lane.family}
                and s.session_id = ${lane.sessionId}
            `,
      )) as unknown as Array<{ n: number | string }>;
      if (Number(laneCount?.[0]?.n ?? 0) > laneCap) {
        if (opts.inTransaction) await db.execute(dsql`release savepoint dedupe_guard`);
        return { verdict: "pass", overlap: 0 };
      }
      rows = (await db.execute(
      lane.agentExternalId === null
        ? dsql`
            select count(distinct (t.raw_event #>> '{}')::jsonb ->> 'uuid') as present
            from hx.turns t
            join hx.sessions s on s.id = t.session_id and s.deleted_at is null
            join hx.users u on u.id = s.user_id
            where u.external_id = ${lane.userExternalId}
              and s.family = ${lane.family}
              and s.session_id = ${lane.sessionId}
              and t.agent_id is null
              and (t.raw_event #>> '{}')::jsonb ->> 'uuid'
                = any(string_to_array(${distinct.join(",")}, ','))
          `
        : dsql`
            select count(distinct (t.raw_event #>> '{}')::jsonb ->> 'uuid') as present
            from hx.turns t
            join hx.sessions s on s.id = t.session_id and s.deleted_at is null
            join hx.users u on u.id = s.user_id
            join hx.session_agents a
              on a.id = t.agent_id
             and a.agent_external_id = ${lane.agentExternalId}
             and a.deleted_at is null
            where u.external_id = ${lane.userExternalId}
              and s.family = ${lane.family}
              and s.session_id = ${lane.sessionId}
              and (t.raw_event #>> '{}')::jsonb ->> 'uuid'
                = any(string_to_array(${distinct.join(",")}, ','))
          `,
      )) as unknown as Array<{ present: number | string }>;
      if (opts.inTransaction) await db.execute(dsql`release savepoint dedupe_guard`);
    } catch (err) {
      // Roll the transaction back to health before failing open, or the
      // swallowed error would abort every statement after this one.
      if (opts.inTransaction) {
        await db.execute(dsql`rollback to savepoint dedupe_guard`).catch(() => {});
      }
      throw err;
    }
    const present = Number(rows?.[0]?.present ?? 0);
    if (!Number.isFinite(present) || present <= 0) return { verdict: "pass", overlap: 0 };
    if (present >= distinct.length) return { verdict: "skip_duplicate", records: distinct.length };
    return { verdict: "pass", overlap: present };
  } catch {
    return { verdict: "pass", overlap: 0 };
  }
}

/** Parsed-turn shape the canonical-held counter needs (matches ParsedTurn:
 *  rawEvent is the parsed record OBJECT, one per block, blocks contiguous). */
export interface RawEventTurn {
  rawEvent: Record<string, unknown>;
}

/** How many record uuids appear in MORE THAN ONE run of consecutive blocks in
 *  a parsed canonical — i.e. records the OBJECT ITSELF holds at least twice
 *  (MC-2606 §7b). One record's blocks are contiguous, so a uuid that
 *  re-appears after OTHER records is a re-composed copy. An
 *  immediately-adjacent identical re-send merges into one run, so this is a
 *  LOWER BOUND — documented, and still the discriminator the overcount alone
 *  cannot provide (statefulness vs duplication). */
export function countCanonicalHeldDuplicateRecords(turns: readonly RawEventTurn[]): number {
  const runsByUuid = new Map<string, number>();
  let prevUuid: string | null = null;
  for (const t of turns) {
    const u = t.rawEvent?.uuid;
    const uuid = typeof u === "string" && u.length > 0 ? u : null;
    if (uuid === prevUuid) continue; // same record's next block (or an unjudgeable run)
    prevUuid = uuid;
    if (uuid === null) continue;
    runsByUuid.set(uuid, (runsByUuid.get(uuid) ?? 0) + 1);
  }
  let held = 0;
  for (const runs of runsByUuid.values()) if (runs > 1) held += 1;
  return held;
}
