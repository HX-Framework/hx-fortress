// The metadata ingestion path: parse a committed session chunk and write the
// derived metadata into the bundled hx schema. Called by the gateway commit
// handlers after the bytes are composed into the canonical blob. Everything for
// one chunk lands in a single transaction; a per-chunk dedupe key on
// hx.ingest_events makes a re-committed chunk a no-op (idempotent retries).

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { HxDb, HxTx } from "../host/postgres/db";
import { tagLockTimeout } from "../host/postgres/pg-errors";
import {
  hxIngestEvents,
  hxSessionAgents,
  hxSessions,
  hxToolCalls,
  hxTurns,
  type HxIngestChannel,
  type HxSessionAgentKind,
  type HxTitleSource,
} from "../host/postgres/schema";
import { hxEmbeddings } from "../host/postgres/schema/embeddings";
import { hxSessionFacts } from "../host/postgres/schema/facts";
import { signalEmbedWork } from "../modules/embed-worker/signal";
import type { SessionKey } from "../modules/session-vault/store/types";
import { isSessionDeleted, sessionLockKey } from "./delete";
import { deriveFallbackTitle } from "./derive-title";
import { extractRealTitle } from "./real-title";
import { upsertDevice, upsertModel, upsertOrg, upsertProject, upsertRepo, upsertUser } from "./dimensions";
import { clearChunkIntent, clearSubsumedChunkIntents } from "./intents";
import { judgeAppend } from "./dedupe-guard";
import { recordIntegrityFinding } from "./findings";
import { parseChunk, type ParsedChunk, type ParsedToolCall, type ParsedTurn } from "./parse";

/** Hard-delete the embeddings owned by the given (now-deleted) turn ids, in the
 *  SAME txn as the turn delete. hx.embeddings is a POLYMORPHIC owner (owner_kind
 *  /owner_id, no FK), so a `replace` — which deletes + reinserts turns under new
 *  ids — has no cascade and would orphan the old vectors, bloating the HNSW (A7).
 *  No-op when hx.embeddings is absent (a non-pgvector fortress where 0006 was
 *  gated-skipped), so the replace path stays safe there. */
async function deleteOrphanedEmbeddings(tx: HxTx, turnIds: string[]): Promise<void> {
  if (turnIds.length === 0) return;
  // to_regclass returns NULL (never errors) when the relation is absent, so this
  // probe can't poison the surrounding transaction.
  const reg = await tx.execute(sql`SELECT to_regclass('hx.embeddings') AS rel`);
  const rows = Array.isArray(reg) ? reg : ((reg as { rows?: unknown[] }).rows ?? []);
  const present = (rows[0] as { rel?: string | null } | undefined)?.rel != null;
  if (!present) return;
  await tx
    .delete(hxEmbeddings)
    .where(and(eq(hxEmbeddings.ownerKind, "turn"), inArray(hxEmbeddings.ownerId, turnIds)));
}

// ── Per-session productivity facts (§13-A4) ──────────────────────────────────
// Derived at ingest from the session's turns + tool_calls and upserted into
// hx.session_facts in the SAME commit txn (recomputed from the LIVE post-write
// state, so `replace` — which deletes + reinserts the lane first — never
// double-counts). Scoped to the PARENT lane (agent_id IS NULL): the §10
// completeness guarantee is parent-lane.

/** Cap each inter-event gap at a fixed idle threshold (§13-A4: e.g. 5 min). */
const IDLE_CAP_MS = 5 * 60 * 1000;
/** Tools whose inputs carry a file diff (files_touched / lines_±). */
const DIFF_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** Line count of a newline-delimited string; non-string / empty ⇒ 0 (a deletion
 *  adds no lines). "a\nb" ⇒ 2. */
function lineCount(v: unknown): number {
  return typeof v === "string" && v.length > 0 ? v.split("\n").length : 0;
}

interface DiffMetrics {
  filesTouched: number;
  linesAdded: number;
  linesRemoved: number;
}

/** files_touched / lines_± from the Edit/Write/MultiEdit tool inputs (§13-A4):
 *  Write → content (added only); Edit → old_string/new_string; MultiEdit → the
 *  sum over edits[]. files_touched = distinct file_path count across all three. */
function diffMetrics(calls: { toolName: string | null; input: Record<string, unknown> | null }[]): DiffMetrics {
  const files = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const c of calls) {
    if (!c.toolName || !DIFF_TOOLS.has(c.toolName) || !c.input) continue;
    const input = c.input;
    if (typeof input.file_path === "string" && input.file_path) files.add(input.file_path);
    if (c.toolName === "Write") {
      linesAdded += lineCount(input.content);
    } else if (c.toolName === "Edit") {
      linesAdded += lineCount(input.new_string);
      linesRemoved += lineCount(input.old_string);
    } else {
      // MultiEdit — one file_path, an edits[] of { old_string, new_string }.
      const edits = Array.isArray(input.edits) ? input.edits : [];
      for (const e of edits) {
        if (e && typeof e === "object") {
          const ed = e as Record<string, unknown>;
          linesAdded += lineCount(ed.new_string);
          linesRemoved += lineCount(ed.old_string);
        }
      }
    }
  }
  return { filesTouched: files.size, linesAdded, linesRemoved };
}

/** active_ms = idle-capped sum of inter-event gaps over event_ts, applying the
 *  §10 fill rule: a null event_ts INHERITS the prior turn's work-time; a LEADING
 *  null run is seeded from the session's first known activity, and from `seedTs`
 *  (the session's first_event_at / upload time, never commit-time) when the
 *  session has no event_ts at all. Returns active_ms + the primary-day basis
 *  (min(event_ts), else the seed). `orderedEventTs` is the parent lane in seq
 *  order. */
function activeMsFromEventTs(
  orderedEventTs: (string | null)[],
  seedTs: string | null,
): { activeMs: number; basisMs: number | null } {
  const parse = (v: string | null): number | null => {
    if (v == null) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  };

  let firstKnownMs: number | null = null;
  let minMs: number | null = null;
  for (const ts of orderedEventTs) {
    const ms = parse(ts);
    if (ms == null) continue;
    if (firstKnownMs == null) firstKnownMs = ms;
    if (minMs == null || ms < minMs) minMs = ms;
  }
  const seedMs = parse(seedTs);
  // The leading null run is seeded from first known activity, else the seed.
  let prev: number | null = firstKnownMs ?? seedMs;

  let activeMs = 0;
  let last: number | null = null;
  for (const ts of orderedEventTs) {
    const ms = parse(ts);
    let cur: number;
    if (ms != null) {
      cur = ms;
      prev = ms; // a real ts becomes the basis the next null inherits
    } else if (prev != null) {
      cur = prev; // inherit the prior turn's work-time
    } else {
      continue; // no basis yet (all-null prefix, no seed) — skip
    }
    if (last != null) {
      const gap = cur - last;
      if (gap > 0) activeMs += Math.min(gap, IDLE_CAP_MS);
    }
    last = cur;
  }
  return { activeMs, basisMs: minMs ?? seedMs };
}

/** Recompute + upsert the session's hx.session_facts row from its LIVE parent-
 *  lane turns + tool_calls (§13-A4). Called in the commit txn AFTER this chunk's
 *  turns/tool_calls are written. `seedTs` = the session's first_event_at / upload
 *  time (the fill-rule seed for an all-null-ts session). */
export async function recomputeSessionFacts(
  tx: HxTx,
  sessionId: string,
  userId: string,
  seedTs: string | null,
  now: string,
): Promise<void> {
  const turns = await tx
    .select({ kind: hxTurns.kind, eventTs: hxTurns.eventTs })
    .from(hxTurns)
    .where(and(eq(hxTurns.sessionId, sessionId), isNull(hxTurns.agentId)))
    .orderBy(asc(hxTurns.seq));

  const calls = await tx
    .select({ toolName: hxToolCalls.toolName, input: hxToolCalls.input })
    .from(hxToolCalls)
    .where(and(eq(hxToolCalls.sessionId, sessionId), isNull(hxToolCalls.agentId)));

  let userMsgs = 0;
  let assistantMsgs = 0;
  for (const t of turns) {
    if (t.kind === "user_text") userMsgs += 1;
    else if (t.kind === "assistant_text") assistantMsgs += 1;
  }

  const toolCallsByType: Record<string, number> = {};
  for (const c of calls) {
    if (!c.toolName) continue; // a tool_result-only row carries an empty name
    toolCallsByType[c.toolName] = (toolCallsByType[c.toolName] ?? 0) + 1;
  }

  const { activeMs, basisMs } = activeMsFromEventTs(
    turns.map((t) => t.eventTs),
    seedTs,
  );
  // primary_day = date(min(event_ts)) in UTC.
  const primaryDay = basisMs == null ? null : new Date(basisMs).toISOString().slice(0, 10);
  const { filesTouched, linesAdded, linesRemoved } = diffMetrics(calls);

  const row = {
    userId,
    primaryDay,
    activeMs,
    userMsgs,
    assistantMsgs,
    toolCallsByType,
    filesTouched,
    linesAdded,
    linesRemoved,
    updatedAt: now,
  };
  await tx
    .insert(hxSessionFacts)
    .values({ sessionId, ...row })
    .onConflictDoUpdate({ target: hxSessionFacts.sessionId, set: row });
}

/** Live parent sessions with NO facts row (B3). The per-chunk `recomputeSessionFacts`
 *  is best-effort and swallowed on failure (see its call site), so a persistent
 *  failure — or a failure on a session's LAST chunk — leaves it permanently
 *  factless, which is the source of the L2 "list ≠ aggregate" gap. The guarantor
 *  recomputes these durably. An anti-join on the facts PK (`session_facts.session_id`
 *  IS NULL), bounded and SELF-LIMITING: once a session's facts row is written it is
 *  no longer returned, so the set drains to empty and stays there in steady state.
 *  Soft-deleted sessions are excluded (their facts cascade away on hard delete and
 *  the aggregate already ignores them). */
export async function factlessSessions(
  db: HxDb,
  limit = 200,
): Promise<Array<{ sessionRowId: string; userId: string; seedTs: string | null }>> {
  const rows = await db
    .select({
      sessionRowId: hxSessions.id,
      userId: hxSessions.userId,
      seedTs: hxSessions.firstEventAt,
    })
    .from(hxSessions)
    .leftJoin(hxSessionFacts, eq(hxSessionFacts.sessionId, hxSessions.id))
    .where(and(isNull(hxSessions.deletedAt), isNull(hxSessionFacts.sessionId)))
    .limit(limit);
  return rows.map((r) => ({
    sessionRowId: r.sessionRowId,
    userId: r.userId,
    seedTs: r.seedTs ?? null,
  }));
}

// Attribution resolved upstream (the cloud over the tunnel, or the capability
// token on the direct gateway). All ids are the cloud-side "external" ids the
// hx dimension tables reconcile on; null when the upstream didn't provide one.
export interface IngestAttribution {
  orgExternalId: string | null;
  repoSlug: string | null;
  projectExternalId: string | null;
  deviceId: string | null;
}

export interface IngestCommitInput {
  attribution: IngestAttribution;
  key: SessionKey;
  /** How this session reached the fortress. REQUIRED — the residency
   *  disclosure that reads it is fail-private, so an entry point that forgot to
   *  say would silently make every session it writes ineligible. The two INSERT
   *  sites below assert it through `satisfies`, so a new call path cannot
   *  compile without choosing a value. */
  ingestChannel: HxIngestChannel;
  chunkId: string;
  chunkText: string;
  totalBytes: number;
  componentCount: number;
  replace: boolean;
  meta: Record<string, unknown> | null;
  /** Recovery write (G reconciler). FILL null attribution from the existing row
   *  instead of overwriting it, and stamp attributionSource='recovered'. Default
   *  (authoritative live/mirror/gateway writes) applies incoming attribution
   *  UNCONDITIONALLY — including an authoritative unassign-to-null — unchanged. */
  recovered?: boolean;
  /** Compare-and-swap for an incremental repair. The reconciler slices the tail
   *  to append starting at the byte count it observed, but that observation is
   *  made at scan time — minutes before the repair runs — and a live session may
   *  have committed more since. Appending from a stale offset would re-insert
   *  turns the live write already indexed, and a duplicate lane is still dense
   *  and still covers the canonical, so no verification downstream can see it.
   *
   *  Set this to the byte count the slice was taken from. It is re-checked INSIDE
   *  the transaction, under the per-session advisory lock, and a mismatch aborts
   *  with IndexAdvancedError so the caller can fall back to a full rebuild. */
  expectIndexedBytes?: number;
  /** The STORE's reported size of the object this text came from.
   *
   *  Used ONLY for chunk-intent subsumption, and deliberately NOT for `bytes_uploaded`:
   *  that watermark means "bytes of the canonical that are INDEXED", so on a short read
   *  it must stay at the smaller indexed figure and let the row read BEHIND, which is
   *  what gets it retried. Stamping the object's size there marks a partial repair
   *  complete and masks the gap forever — tried, and mc2606-reconciler's "a tail append
   *  never stamps a watermark it did not index" correctly refused it.
   *
   *  Not to be confused with `totalBytes`. On a repair that is Buffer.byteLength of the
   *  DECODED text, a different measure from the object size an intent records: an
   *  ill-formed byte decodes to U+FFFD at 3 bytes out for 1 in, so the decoded length
   *  can EXCEED the object, while a truncated read makes it smaller. Comparing an
   *  intent's object-size against a decoded length therefore either clears an intent for
   *  bytes that were never indexed (losing the only signal that catches a dropped write)
   *  or never clears at all (the forever-rebuild this mechanism exists to stop).
   *
   *  Absent ⇒ fall back to totalBytes, which is exact on the live path where the client
   *  reports both. */
  objectBytes?: number;
  /** Turn count the lane MUST already hold for this append to be valid — the
   *  parse of the canonical prefix the tail was cut from.
   *
   *  `expectIndexedBytes` alone is not enough: `bytes_uploaded` is stamped from
   *  whichever chunk committed last, so a replayed earlier chunk REGRESSES it
   *  below what the lane actually holds. The slice offset and the stored value
   *  then agree — both regressed — and the byte CAS passes while the tail
   *  re-inserts turns that are already there. Comparing the actual turn count
   *  against the prefix catches that, and catches a rewritten canonical too. */
  expectPriorTurns?: number;
  /** The reconciler has determined this row must be rebuilt (absent,
   *  content-less, or behind its canonical). Lets a recovered write materialise
   *  over an EXISTING row, which the plain recovered guard refuses so a restore
   *  can never clobber a live upload. */
  rebuild?: boolean;
}

export interface IngestAgentCommitInput extends IngestCommitInput {
  agentId: string;
}

interface ResolvedDimensions {
  userId: string;
  orgId: string | null;
  projectId: string | null;
  repoId: string | null;
  deviceId: string | null;
  modelId: string | null;
}

/** The provenance stamp for a new hx.sessions row, as a `satisfies`-checked
 *  object. Spread into BOTH inserts: `.values()` treats a nullable column as
 *  optional, so nothing but an explicit assertion makes a missing channel a
 *  compile error. Stamped at FIRST write only — a later update never rewrites
 *  it, because the channel a session arrived on is a historical fact. */
function provenance(
  input: Pick<IngestCommitInput, "ingestChannel">,
): { ingestChannel: HxIngestChannel } {
  return { ingestChannel: input.ingestChannel } satisfies Required<
    Pick<IngestCommitInput, "ingestChannel">
  >;
}

/** An agent-lane commit arrived before its parent session was indexed. Typed so
 *  the cloud's durable replay can bring it back once the parent lands, instead of
 *  the lane fabricating a content-less parent row that would then mask the real
 *  parent from the guarantor forever. */
export class ParentSessionNotIndexedError extends Error {
  constructor(public readonly sessionId: string) {
    super("parent_session_not_indexed");
  }
}

/** What a commit actually DID. Every early return inside ingestCommit used to be
 *  indistinguishable from success — a dedupe hit, a recovered-write guard and a
 *  clean index all returned void. The guarantor therefore could not tell "repaired"
 *  from "silently did nothing", which is how a session stayed frozen for a week.
 *  Callers that care must branch on `applied`. */
export type IngestOutcome =
  | { applied: true; sessionRowId: string; turnsInserted: number }
  | { applied: false; reason: "no_user" | "deduped" | "recovered_skip" | "duplicate_records" };

/** The lane does not hold exactly the prefix the caller sliced its tail from, so
 *  appending would splice unrelated content onto it. Raised under the advisory
 *  lock, where the answer cannot change between check and write. */
export class LanePrefixMismatchError extends Error {
  constructor(public readonly expectedTurns: number, public readonly actualTurns: number) {
    super("lane_prefix_mismatch");
  }
}

/** A live write landed between the reconciler observing this row and the repair
 *  reaching the advisory lock, so the value the repair was planned against is no
 *  longer current. Writing anyway would append from a stale offset, or delete a
 *  lane and reinstate text that predates the live commit. */
export class IndexAdvancedError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super("index_advanced");
  }
}

function metaStr(meta: Record<string, unknown> | null, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" ? v : null;
}

function titleSourceOf(meta: Record<string, unknown> | null): HxTitleSource | null {
  const v = meta?.titleSource;
  return v === "user" || v === "ai" || v === "fallback" ? v : null;
}

/** Best-effort repo identity for when the client didn't send an explicit
 *  repoSlug (claims.repo / meta.repoSlug — the PREFERRED source). Falls back to
 *  the last path segment of the session's cwd (e.g. "/home/x/let-forge" →
 *  "let-forge"), the repo root for the common case of running at the checkout
 *  root. Returns null for an empty/root path so we never upsert a junk
 *  dimension. Heuristic — a client that sends its real slug always wins. */
function repoSlugFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const segs = cwd.split(/[/\\]+/).filter((seg) => seg && seg !== "." && seg !== "..");
  const last = segs[segs.length - 1];
  return last && last.length > 0 ? last : null;
}

function kindOf(meta: Record<string, unknown> | null): HxSessionAgentKind {
  return meta?.kind === "workflow_agent" ? "workflow_agent" : "subagent";
}

async function resolveDimensions(
  tx: HxTx,
  attribution: IngestAttribution,
  userExternalId: string,
  lastModel: string | null,
  now: string,
  cwd: string | null,
): Promise<ResolvedDimensions> {
  const userId = await upsertUser(tx, userExternalId);
  const orgId = attribution.orgExternalId ? await upsertOrg(tx, attribution.orgExternalId) : null;
  const projectId =
    orgId && attribution.projectExternalId
      ? await upsertProject(tx, orgId, attribution.projectExternalId)
      : null;
  // Prefer the client-sent repoSlug; fall back to the cwd's repo root so repo
  // attribution (and the by-repo aggregate) is populated instead of null when the
  // client omits it (see repoSlugFromCwd).
  const repoSlug = attribution.repoSlug ?? repoSlugFromCwd(cwd);
  const repoId = repoSlug ? await upsertRepo(tx, repoSlug, projectId, now) : null;
  const deviceId = attribution.deviceId ? await upsertDevice(tx, userId, attribution.deviceId, now) : null;
  const modelId = lastModel ? await upsertModel(tx, lastModel, now) : null;
  return { userId, orgId, projectId, repoId, deviceId, modelId };
}

/** True if this chunk was already ingested (its ingest event exists). */
async function alreadyIngested(tx: HxTx, dedupeKey: string): Promise<boolean> {
  const rows = await tx
    .select({ id: hxIngestEvents.id })
    .from(hxIngestEvents)
    .where(eq(hxIngestEvents.dedupeKey, dedupeKey))
    .limit(1);
  return rows.length > 0;
}

/** Insert turns for one lane (parent: agentId null), seq continuing from max+1. */
// Postgres text/jsonb both reject U+0000 (0x00). Transcripts can carry `\u0000`
// JSON escapes (e.g. in tool output) that JSON.parse decodes to a real null byte,
// which would fail the whole session's insert. Strip null bytes from every parsed
// text + deep-scrub the raw/tool JSON objects before they reach the DB.
function stripNul(s: string | null): string | null {
  // eslint-disable-next-line no-control-regex
  return typeof s === "string" && s.includes("\u0000") ? s.replace(/\u0000/g, "") : s;
}
function deepStripNul<T>(v: T): T {
  // Walk the actual object and strip real U+0000 from string VALUES only. (An
  // earlier stringify→regex→parse shortcut corrupted content that legitimately
  // contained the literal text "\\u0000" — an escaped backslash — into invalid JSON.)
  // eslint-disable-next-line no-control-regex
  if (typeof v === "string") return (v.includes("\u0000") ? v.replace(/\u0000/g, "") : v) as T;
  if (Array.isArray(v)) return v.map((x) => deepStripNul(x)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = deepStripNul(val);
    return out as T;
  }
  return v;
}
function scrubParsed(parsed: ParsedChunk): void {
  parsed.lastUserText = stripNul(parsed.lastUserText);
  parsed.lastAssistantText = stripNul(parsed.lastAssistantText);
  for (const t of parsed.turns) {
    t.text = stripNul(t.text);
    t.rawEvent = deepStripNul(t.rawEvent);
  }
  for (const c of parsed.toolCalls) {
    c.input = deepStripNul(c.input);
    c.result = deepStripNul(c.result);
  }
}

async function insertTurns(
  tx: HxTx,
  sessionId: string,
  agentId: string | null,
  turns: ParsedTurn[],
  now: string,
): Promise<void> {
  if (turns.length === 0) return;
  const laneFilter = agentId
    ? and(eq(hxTurns.sessionId, sessionId), eq(hxTurns.agentId, agentId))
    : and(eq(hxTurns.sessionId, sessionId), isNull(hxTurns.agentId));
  const [{ maxSeq }] = await tx
    .select({ maxSeq: sql<number>`coalesce(max(${hxTurns.seq}), -1)` })
    .from(hxTurns)
    .where(laneFilter);
  let seq = Number(maxSeq ?? -1) + 1;
  const rows = turns.map((t) => ({
    sessionId,
    agentId,
    seq: seq++,
    role: t.role,
    kind: t.kind,
    eventTs: t.eventTs,
    text: t.text,
    rawEvent: t.rawEvent,
    createdAt: now,
    updatedAt: now,
  }));
  // Batch the insert: one multi-row INSERT binds rows×cols params and the PG wire
  // protocol caps at 65535 — a very large session (thousands of turns) would blow
  // it ("too many parameters"). ~500 rows/batch keeps params well under the cap.
  const INSERT_BATCH = 500;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await tx.insert(hxTurns).values(rows.slice(i, i + INSERT_BATCH));
  }
}

/** Upsert tool calls by (session_id, tool_use_id) — tool_use sets name/input,
 *  tool_result (a separate event) fills in result/is_error for the same id.
 *
 *  Batched: one chunk regularly carries hundreds of calls, and the
 *  per-row awaited upsert dominated the ingest transaction. Entries sharing a
 *  toolUseId (the use + its result arriving in the same chunk) merge in
 *  memory first — duplicate conflict keys inside one INSERT are a Postgres
 *  error — then a multi-row INSERT ... ON CONFLICT applies the same
 *  only-overwrite-when-present rules via COALESCE on EXCLUDED. */
async function upsertToolCalls(
  tx: HxTx,
  sessionId: string,
  agentId: string | null,
  calls: ParsedToolCall[],
  now: string,
): Promise<void> {
  const merged = new Map<string, ParsedToolCall>();
  for (const c of calls) {
    if (!c.toolUseId) continue;
    const prev = merged.get(c.toolUseId);
    if (!prev) {
      merged.set(c.toolUseId, { ...c });
      continue;
    }
    if (c.toolName !== null) prev.toolName = c.toolName;
    if (c.input !== null) prev.input = c.input;
    if (c.result !== null) {
      prev.result = c.result;
      prev.isError = c.isError;
    }
    prev.eventTs = prev.eventTs ?? c.eventTs;
  }
  if (merged.size === 0) return;

  const rows = [...merged.values()].map((c) => ({
    sessionId,
    agentId,
    toolUseId: c.toolUseId,
    toolName: c.toolName ?? "",
    input: c.input,
    result: c.result,
    isError: c.isError,
    eventTs: c.eventTs,
  }));
  // Same wire-protocol param budget reasoning as insertTurns.
  const INSERT_BATCH = 400;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await tx
      .insert(hxToolCalls)
      .values(rows.slice(i, i + INSERT_BATCH))
      .onConflictDoUpdate({
        target: [hxToolCalls.sessionId, hxToolCalls.toolUseId],
        set: {
          // '' is the values() placeholder for "name unknown" — never let it
          // clobber a real name.
          toolName: sql`coalesce(nullif(excluded.tool_name, ''), ${hxToolCalls.toolName})`,
          input: sql`coalesce(excluded.input, ${hxToolCalls.input})`,
          result: sql`coalesce(excluded.result, ${hxToolCalls.result})`,
          // isError travels with result: only a row that carries a result may
          // change it.
          isError: sql`case when excluded.result is not null then excluded.is_error else ${hxToolCalls.isError} end`,
          updatedAt: now,
        },
      });
  }
}

function ingestEventPayload(input: IngestCommitInput, sessionRowId: string, parsed: ParsedChunk) {
  return {
    chunk: {
      id: input.chunkId,
      byteCount: Buffer.byteLength(input.chunkText),
      totalBytes: input.totalBytes,
      componentCount: input.componentCount,
    },
    session: {
      rowId: sessionRowId,
      family: input.key.family,
      sessionId: input.key.sessionId,
      meta: input.meta ?? {},
    },
    transcriptIndex: {
      status: input.chunkText.trim() ? "indexed" : "skipped",
      inserted: parsed.turns.length,
    },
  };
}

/** The later of two ISO timestamps by absolute INSTANT (not lexical — event
 *  strings can carry different offsets), preserving the winning string form.
 *  Nulls drop out; both-null ⇒ null. Used to advance last_activity_at
 *  monotonically on append so an out-of-order / backfill chunk can't regress it
 *  — used here and in the gateway's session.json metadata artifact. */
export function maxIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** Ingest a parent session commit into the bundled hx schema. */
export async function ingestCommit(db: HxDb, input: IngestCommitInput): Promise<IngestOutcome> {
  const userExternalId = input.key.userId;
  // no user → can't satisfy the NOT NULL session FK
  if (!userExternalId) return { applied: false, reason: "no_user" };
  // Hard-deleted sessions must never come back — mirrors re-push on activity
  // and migrate-from-workbench replays whole histories; the tombstone outranks
  // every producer.
  if (await isSessionDeleted(db, userExternalId, input.key.sessionId)) {
    throw new Error("session_deleted");
  }
  const now = new Date().toISOString();
  const dedupeKey = `${userExternalId}:${input.key.family}:${input.key.sessionId}:${input.chunkId}`;
  // Set inside the transaction when the dedupe guard saw a partial overlap;
  // written to hx.integrity_findings AFTER commit (evidence, not prerequisite).
  let appendOverlap = 0;
  const parsed = parseChunk(input.chunkText);
  scrubParsed(parsed);
  // Tier-A real title, extracted from the canonical PRE-transaction (non-throwing)
  // so a parse edge can never abort ingest. Effective when chunkText is the whole
  // transcript (whole-transcript producers + C/G/corrective, which pass the full
  // canonical); a chunked delta yields null → the first-message floor, as today.
  const realTitle = extractRealTitle(input.chunkText);

  const committed = await db.transaction(async (tx) => {
    // M2: exclusive per-session advisory lock FIRST (auto-released on
    // commit/rollback), then re-check the tombstone INSIDE the lock — this plus
    // tombstone-first ordering closes the resurrect-and-re-embed race the pre-txn
    // check above only narrows. The lock WAIT counts against statement_timeout;
    // a 57014 cancelling it (a live chunk queued behind a long same-session
    // restore txn — the deploy-day shape) is tagged positionally so the caller
    // retries the whole txn once (rolled back atomically; dedupe keeps it
    // exactly-once) instead of losing the chunk.
    await tx
      .execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${sessionLockKey(userExternalId, input.key.sessionId)}, 0))`,
      )
      .catch(tagLockTimeout);
    if (await isSessionDeleted(tx, userExternalId, input.key.sessionId)) {
      throw new Error("session_deleted");
    }
    if (await alreadyIngested(tx, dedupeKey)) return { skip: "deduped" as const };

    // Dedupe guard (§7c) — the same verdict the compose side gave, re-judged
    // under this lane's advisory lock. A chunk whose EVERY record is already
    // indexed is skipped (typed, visible) — and its chunk intent is cleared
    // here, because the promise the intent records ("these bytes will be
    // indexed") is already kept; leaving it open would force a pointless
    // whole-canonical rebuild at the next sweep. A partial overlap passes
    // whole — blocking it could stall the chunk's NEW records, and loss
    // outranks duplication — recorded as an integrity finding instead.
    if (!input.replace) {
      const guardVerdict = await judgeAppend(
        tx as unknown as HxDb,
        { userExternalId, family: input.key.family, sessionId: input.key.sessionId, agentExternalId: null },
        input.chunkText,
        { inTransaction: true },
      );
      if (guardVerdict.verdict === "skip_duplicate") {
        await clearChunkIntent(
          tx,
          { userExternalId, family: input.key.family, sessionId: input.key.sessionId, chunkId: input.chunkId },
          now,
        );
        return { skip: "duplicate_records" as const };
      }
      // Recorded AFTER the transaction commits (see below): the finding is
      // evidence, never a prerequisite, and a failed insert inside the
      // transaction would abort the very ingest it describes.
      appendOverlap = guardVerdict.overlap;
    }

    const dims = await resolveDimensions(tx, input.attribution, userExternalId, parsed.lastModel, now, metaStr(input.meta, "cwd"));

    const existing = (
      await tx
        .select()
        .from(hxSessions)
        .where(
          and(
            eq(hxSessions.userId, dims.userId),
            eq(hxSessions.family, input.key.family),
            eq(hxSessions.sessionId, input.key.sessionId),
          ),
        )
        .limit(1)
    )[0];

    // A recovered write (Component G) exists only to MATERIALIZE a row-less
    // orphan. If a live upload / another actor already created the row by the
    // time we hold the lock, no-op — never rebuild it. Rebuilding would nuke a
    // concurrent live delta (replace path) or let a subsequent live append
    // double-count turns against a lane G rebuilt from a whole-canonical
    // snapshot. G's reconciler already skips existing rows; this closes the
    // check→lock race for a fresh, actively-uploading orphan (the inactive 1,531
    // backlog can never reach it).
    // …but a row with ZERO events is a content-less stub, not a live upload, so a
    // recovered write MUST be allowed to materialise over it. Without this the
    // guarantor would find the stub as an orphan (0.19.0 makes it one) and then
    // no-op on arrival, looping forever without ever repairing it.
    if (input.recovered && !input.rebuild && existing && (existing.eventCount ?? 0) > 0) {
      return { skip: "recovered_skip" as const };
    }

    // CAS: the slice is only valid if the lane is still exactly where it was when
    // the tail was cut. Checked here because this is the first point under the
    // per-session advisory lock, so nothing can move it between check and write.
    if (input.expectIndexedBytes !== undefined) {
      const actual = Number(existing?.bytesUploaded ?? 0);
      if (actual !== input.expectIndexedBytes) {
        throw new IndexAdvancedError(input.expectIndexedBytes, actual);
      }
    }

    // …and the lane must actually HOLD that prefix. The byte CAS above compares
    // two numbers that can both be wrong together (a replayed chunk regresses
    // bytes_uploaded, and the tail is then sliced from the same regressed
    // offset); this compares against the turns really present.
    if (input.expectPriorTurns !== undefined && existing) {
      const [priorAgg] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(hxTurns)
        .where(and(eq(hxTurns.sessionId, existing.id), isNull(hxTurns.agentId)));
      const actualTurns = Number(priorAgg?.n ?? 0);
      // EXACT, deliberately, and it took two wrong turns to settle here.
      //
      // parseChunk is stateful across the text, so a lane built by APPENDING
      // chunks can hold more turns than parse(prefix) yields. The tempting fix
      // is to relax this to a lower bound — but that lets a tail sliced from a
      // STALE prefix splice content the lane already holds, which is silent
      // duplication, and there is no byte check that can see it (the CAS agrees:
      // both sides are wrong in the same direction).
      //
      // The deeper reason equality is right: the canonical-faithful state of a
      // lane is `parse(whole)` — that is precisely what a `replace` produces and
      // what the post-rebuild verification checks. A count that disagrees means
      // the lane has DRIFTED from what a whole-canonical parse says, whatever
      // produced the drift. Refusing the tail and taking the full rebuild
      // converges it to the canonical; that is repair, not loss.
      if (actualTurns !== input.expectPriorTurns) {
        throw new LanePrefixMismatchError(input.expectPriorTurns, actualTurns);
      }
    }

    const prev = input.replace ? undefined : existing;
    const rollup = {
      eventCount: (prev?.eventCount ?? 0) + parsed.eventCount,
      userTextCount: (prev?.userTextCount ?? 0) + parsed.userTextCount,
      assistantCount: (prev?.assistantCount ?? 0) + parsed.assistantCount,
      toolCallCount: (prev?.toolCallCount ?? 0) + parsed.toolCallCount,
      inputTokens: (prev?.inputTokens ?? 0) + parsed.inputTokens,
      outputTokens: (prev?.outputTokens ?? 0) + parsed.outputTokens,
      cacheReadTokens: (prev?.cacheReadTokens ?? 0) + parsed.cacheReadTokens,
      cacheCreationTokens: (prev?.cacheCreationTokens ?? 0) + parsed.cacheCreationTokens,
      estCostUsd: (prev?.estCostUsd ?? 0) + parsed.costUsd,
      chunkCount: input.replace ? 1 : (existing?.chunkCount ?? 0) + 1,
    };
    // On append advance monotonically (max over existing + this chunk's
    // newest event) so an out-of-order / backfill chunk can't drag last_activity_at
    // backwards; on a `replace` the chunk is authoritative (the lane is rebuilt
    // from it), so take its value straight. `now` only when no event ts exists.
    const lastActivityAt = input.replace
      ? (parsed.lastActivityAt ?? existing?.lastActivityAt ?? now)
      : (maxIso(existing?.lastActivityAt, parsed.lastActivityAt) ?? now);
    const meta = input.meta;
    // Empty-string ('') titles count as ABSENT (a client can forward title="");
    // never let one clobber a real existing title, and let the cascade fill it.
    const metaTitleRaw = metaStr(meta, "title");
    const metaTitle = metaTitleRaw && metaTitleRaw.trim() ? metaTitleRaw : null;

    let sessionRowId: string;
    if (existing) {
      await tx
        .update(hxSessions)
        .set({
          deviceId: dims.deviceId ?? existing.deviceId,
          orgId: input.recovered ? (dims.orgId ?? existing.orgId) : dims.orgId,
          projectId: input.recovered ? (dims.projectId ?? existing.projectId) : dims.projectId,
          repoId: input.recovered ? (dims.repoId ?? existing.repoId) : dims.repoId,
          modelId: dims.modelId ?? existing.modelId,
          // PRESERVE the existing provenance. `recovered` is meant to mean "this
          // row exists because the guarantor rebuilt it from a canonical, so its
          // org/project/repo were never knowable" — the only honest discriminator
          // for that population.
          //
          // Stamping it on every repair destroyed that meaning: a healthy,
          // fully-attributed live row that a sweep merely re-indexed came out
          // labelled `recovered`, and 214 rows on the reference deployment
          // provably hold real attribution while claiming to have none. All three
          // repair paths did it, so the cohort grew as the sweep ran and any
          // monitoring keyed on the column drifted under it.
          //
          // A row that already EXISTS keeps what it was; only a row the guarantor
          // creates from nothing (the insert below) is `recovered`.
          attributionSource: existing.attributionSource ?? (input.recovered ? "recovered" : "auto"),
          title: metaTitle ?? existing.title,
          titleSource: titleSourceOf(meta) ?? existing.titleSource,
          ccdSessionId: metaStr(meta, "ccdSessionId") ?? existing.ccdSessionId,
          sourcePath: metaStr(meta, "sourcePath") ?? existing.sourcePath,
          cwd: metaStr(meta, "cwd") ?? existing.cwd,
          gitBranch: metaStr(meta, "gitBranch") ?? existing.gitBranch,
          entrypoint: metaStr(meta, "entrypoint") ?? existing.entrypoint,
          originator: metaStr(meta, "originator") ?? existing.originator,
          lastUserText: parsed.lastUserText ?? existing.lastUserText,
          lastAssistantText: parsed.lastAssistantText ?? existing.lastAssistantText,
          ...rollup,
          // A replace rebuilds the lane, so its total is the truth. An APPEND
          // must never move this backwards: totalBytes is whatever the producer
          // computed for ITS chunk, and a replayed earlier chunk carries a
          // smaller one. Letting that regress the stored value is what makes a
          // later tail repair slice from an offset the lane has already passed,
          // duplicating turns that no downstream check can see.
          bytesUploaded: input.replace
            ? input.totalBytes
            : Math.max(Number(existing.bytesUploaded ?? 0), input.totalBytes),
          lastActivityAt,
          updatedAt: now,
        })
        .where(eq(hxSessions.id, existing.id));
      sessionRowId = existing.id;
    } else {
      const [ins] = await tx
        .insert(hxSessions)
        .values({
          userId: dims.userId,
          deviceId: dims.deviceId,
          orgId: dims.orgId,
          projectId: dims.projectId,
          repoId: dims.repoId,
          modelId: dims.modelId,
          family: input.key.family,
          sessionId: input.key.sessionId,
          ccdSessionId: metaStr(meta, "ccdSessionId"),
          title: metaTitle,
          titleSource: titleSourceOf(meta),
          sourcePath: metaStr(meta, "sourcePath"),
          cwd: metaStr(meta, "cwd"),
          gitBranch: metaStr(meta, "gitBranch"),
          entrypoint: metaStr(meta, "entrypoint"),
          originator: metaStr(meta, "originator"),
          // This is the INSERT: the row did not exist, so the guarantor really is
          // creating it from a canonical and `recovered` is the truth.
          attributionSource: input.recovered ? "recovered" : "auto",
          ...provenance(input),
          lastUserText: parsed.lastUserText,
          lastAssistantText: parsed.lastAssistantText,
          ...rollup,
          bytesUploaded: input.totalBytes,
          firstEventAt: parsed.firstActivityAt ?? now,
          lastActivityAt,
        })
        .returning({ id: hxSessions.id });
      sessionRowId = ins.id;
    }

    if (input.replace) {
      // Capture the deleted turn ids (RETURNING) so their embeddings hard-delete
      // in the same txn — no FK cascade reaches the polymorphic owner (A7).
      const deleted = await tx
        .delete(hxTurns)
        .where(and(eq(hxTurns.sessionId, sessionRowId), isNull(hxTurns.agentId)))
        .returning({ id: hxTurns.id });
      await deleteOrphanedEmbeddings(
        tx,
        deleted.map((d) => d.id),
      );
      await tx
        .delete(hxToolCalls)
        .where(and(eq(hxToolCalls.sessionId, sessionRowId), isNull(hxToolCalls.agentId)));
    }

    await insertTurns(tx, sessionRowId, null, parsed.turns, now);
    await upsertToolCalls(tx, sessionRowId, null, parsed.toolCalls, now);

    // Title cascade — real client title first, first-message only as the floor.
    // #89 jumped straight to the first-message guess even when the canonical held
    // a real ai-title/custom-title; tier A (extractRealTitle over the canonical we
    // hold) recovers the correct name for resumed / older-client / orphaned
    // sessions, and deriveFallbackTitle stays as the tier-C floor so no session is
    // ever nameless. Empty-string ('') titles count as absent. The guarded UPDATE
    // (title IS NULL OR '') is idempotent and lets any real user/AI title (this
    // commit or a later one) win.
    if (!metaTitle && !(existing?.title && existing.title.trim())) {
      const titleAbsent = and(
        eq(hxSessions.id, sessionRowId),
        or(isNull(hxSessions.title), eq(hxSessions.title, "")),
      );
      if (realTitle) {
        await tx
          .update(hxSessions)
          .set({ title: realTitle.title, titleSource: realTitle.titleSource, updatedAt: now })
          .where(titleAbsent);
      } else {
        const [firstUser] = await tx
          .select({ text: hxTurns.text })
          .from(hxTurns)
          .where(
            and(
              eq(hxTurns.sessionId, sessionRowId),
              isNull(hxTurns.agentId),
              eq(hxTurns.kind, "user_text"),
            ),
          )
          .orderBy(asc(hxTurns.seq))
          .limit(1);
        const derived = deriveFallbackTitle(
          firstUser?.text ?? null,
          metaStr(meta, "cwd") ?? existing?.cwd ?? null,
          metaStr(meta, "repoSlug"),
        );
        if (derived) {
          await tx
            .update(hxSessions)
            .set({ title: derived, titleSource: "fallback", updatedAt: now })
            .where(titleAbsent);
        }
      }
    }

    // Cleared HERE, inside the transaction that commits the turns, so an open
    // intent means exactly "bytes composed, turns not indexed" — a rollback
    // leaves it open and the guarantor picks the session up.
    await clearChunkIntent(
      tx,
      {
        userExternalId,
        family: input.key.family,
        sessionId: input.key.sessionId,
        chunkId: input.chunkId,
      },
      now,
    );
    // A whole-canonical write indexes EVERY chunk whose bytes are in that canonical,
    // whatever id each arrived under. Clearing only by chunk id left the client's
    // intent open on every repair — the repair invents its own id — so the guarantor
    // re-forced the session on every pass, forever. Bounded by what was actually
    // indexed so a chunk composed after the read keeps its intent.
    if (input.replace) {
      await clearSubsumedChunkIntents(
        tx,
        { userExternalId, family: input.key.family, sessionId: input.key.sessionId },
        input.objectBytes ?? input.totalBytes,
        now,
      );
    }

    await tx.insert(hxIngestEvents).values({
      userId: dims.userId,
      eventType: "hx.session.updated",
      sessionId: sessionRowId,
      family: input.key.family,
      sessionIdExt: input.key.sessionId,
      chunkId: input.chunkId,
      dedupeKey,
      payload: ingestEventPayload(input, sessionRowId, parsed),
      status: "processed",
      processedAt: now,
    });

    return {
      sessionRowId,
      userId: dims.userId,
      factsSeed: existing?.firstEventAt ?? parsed.firstActivityAt ?? now,
      turnsInserted: parsed.turns.length,
    };
  });

  // Per-session productivity facts (§13-A4) — recomputed OUTSIDE the commit
  // transaction: the recompute re-reads the whole lane (every turn +
  // every tool call's jsonb input), and holding the ingest txn open across it
  // stretched row locks over the slowest query of the path. Post-commit it
  // reads the just-committed state — same values, own short transaction. A
  // `replace` re-indexed the lane above, so it recomputes cleanly.
  //
  // Best-effort: the ingest itself is already durable (the transaction above
  // committed the turns/tool-calls AND the dedupe event as `processed`), so a
  // recompute failure must NOT throw back out — that would make the caller
  // treat the whole ingest as failed and retry, and the retry short-circuits on
  // the dedupe key without ever re-running facts. Facts recompute on every
  // subsequent chunk of the session, so a transient failure self-heals; only a
  // persistent one leaves facts stale (recorded via the ingest-event row).
  if (committed && !("skip" in committed)) {
    try {
      await db.transaction((tx) =>
        recomputeSessionFacts(tx, committed.sessionRowId, committed.userId, committed.factsSeed, now),
      );
    } catch {
      // swallow — see above; the next chunk's commit recomputes.
    }
  }

  // Off the commit path: nudge the embed worker that new indexable turns may
  // have landed (debounced + max-wait capped). Best-effort — never throws.
  signalEmbedWork();

  if (appendOverlap > 0) {
    await recordIntegrityFinding(db, {
      userExternalId,
      family: input.key.family,
      sessionId: input.key.sessionId,
      kind: "append_overlap",
      detail: { chunkId: input.chunkId, overlap: appendOverlap },
    });
  }

  if (!committed) return { applied: false, reason: "deduped" };
  // The transaction callback returns a union, so TypeScript widens every field to
  // optional across both arms. Read it once through the union shape rather than
  // narrowing in place.
  const outcome = committed as {
    skip?: "deduped" | "recovered_skip" | "duplicate_records";
    sessionRowId?: string;
    turnsInserted?: number;
  };
  if (outcome.skip) return { applied: false, reason: outcome.skip };
  return {
    applied: true,
    sessionRowId: outcome.sessionRowId ?? "",
    turnsInserted: outcome.turnsInserted ?? 0,
  };
}

/** Ingest a child-lane (subagent / workflow-agent) commit. */
export async function ingestAgentCommit(
  db: HxDb,
  input: IngestAgentCommitInput,
): Promise<IngestOutcome> {
  const userExternalId = input.key.userId;
  if (!userExternalId || !input.agentId) return { applied: false, reason: "no_user" };
  // Cross-family by identity — child lanes can carry a stale family (see
  // isSessionDeleted); a deleted parent blocks every lane.
  if (await isSessionDeleted(db, userExternalId, input.key.sessionId)) {
    throw new Error("session_deleted");
  }
  const now = new Date().toISOString();
  const dedupeKey = `${userExternalId}:${input.key.family}:${input.key.sessionId}:a:${input.agentId}:${input.chunkId}`;
  let appendOverlap = 0; // see the parent path
  const parsed = parseChunk(input.chunkText);
  scrubParsed(parsed);

  const committed = await db.transaction(async (tx) => {
    // M2: same per-session advisory lock + in-lock tombstone re-check as the
    // parent path (keyed on the base session id, so parent + agent + purge
    // serialize together).
    await tx
      .execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${sessionLockKey(userExternalId, input.key.sessionId)}, 0))`,
      )
      .catch(tagLockTimeout);
    if (await isSessionDeleted(tx, userExternalId, input.key.sessionId)) {
      throw new Error("session_deleted");
    }
    if (await alreadyIngested(tx, dedupeKey)) return { skip: "deduped" as const };

    // Dedupe guard (§7c) — lane variant; same contract and intent-clearing
    // reasoning as the parent path above.
    if (!input.replace) {
      const guardVerdict = await judgeAppend(
        tx as unknown as HxDb,
        { userExternalId, family: input.key.family, sessionId: input.key.sessionId, agentExternalId: input.agentId },
        input.chunkText,
        { inTransaction: true },
      );
      if (guardVerdict.verdict === "skip_duplicate") {
        await clearChunkIntent(
          tx,
          {
            userExternalId,
            family: input.key.family,
            sessionId: input.key.sessionId,
            chunkId: input.chunkId,
            agentExternalId: input.agentId,
          },
          now,
        );
        return { skip: "duplicate_records" as const };
      }
      // Post-commit evidence, same reasoning as the parent path.
      appendOverlap = guardVerdict.overlap;
    }

    const dims = await resolveDimensions(tx, input.attribution, userExternalId, parsed.lastModel, now, metaStr(input.meta, "cwd"));

    // A child chunk can arrive before its parent — but it must NOT invent one.
    //
    // This used to insert a parent STUB: a real hx.sessions row with no title, no
    // turns and zero rollups. That row is indistinguishable from a real one to
    // `keyExists`, so the parent's canonical stopped counting as an orphan and the
    // guarantor never restored it — the reconciler's own comment calls that
    // permanent content loss. It is also precisely the half-indexed session the
    // ingest contract forbids: named (or worse, nameless) in the list, with none
    // of its content behind it.
    //
    // A lane is only meaningful under an indexed parent, so if the parent is not
    // there yet, index NOTHING and let the work come back: the cloud replays this
    // commit durably, and the guarantor sorts parents before lanes so a restore
    // materialises the parent first. Failing here is visible and self-healing;
    // the stub was silent and terminal.
    const parent = (
      await tx
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .where(
          and(
            eq(hxSessions.userId, dims.userId),
            eq(hxSessions.family, input.key.family),
            eq(hxSessions.sessionId, input.key.sessionId),
          ),
        )
        .limit(1)
    )[0];
    // MAIN'S RULE WINS HERE, and it supersedes what this branch did. An agent
    // lane used to INSERT a parent session when it found none, stamping it with
    // this commit's provenance. v0.19.0 removed that deliberately: the row it
    // fabricated had no content, and it then masked the real parent from the
    // guarantor forever. The lane refuses instead, and the cloud's durable
    // replay brings the commit back once the parent has genuinely landed.
    if (!parent) throw new ParentSessionNotIndexedError(input.key.sessionId);
    const sessionRowId: string = parent.id;

    const meta = input.meta;
    const existingAgent = (
      await tx
        .select()
        .from(hxSessionAgents)
        .where(
          and(eq(hxSessionAgents.sessionId, sessionRowId), eq(hxSessionAgents.agentExternalId, input.agentId)),
        )
        .limit(1)
    )[0];
    // As in ingestCommit: a recovered write only materializes a MISSING lane. If
    // the agent lane already exists under the lock, no-op rather than rebuild it
    // (which would race a concurrent live delta for the same lane). The parent
    // row here is pre-existing when the agent exists (FK), so no stub was made.
    // …but `rebuild` overrides it, exactly as on the parent path: the reconciler
    // sets that only once it has already decided this lane must be rebuilt
    // (behind its canonical, or holed). Without the override every lane repair
    // was a silent no-op on the FIRST attempt — the same shape as the constant
    // repair key, but total.
    // The eventCount clause is load-bearing and mirrors the parent guard at the
    // top of ingestCommit. Without it a CONTENT-LESS lane row (eventCount 0)
    // blocks its own repair: the reconciler reaches it via the orphan path, where
    // `rebuild` is deliberately false (an orphan restore must not be able to
    // clobber a live row), and the guard then refuses the one write that would
    // fix it — forever. The protection this guard exists for is against a
    // CONTENT-BEARING lane materialising in the window, which the clause keeps.
    if (input.recovered && !input.rebuild && existingAgent && (existingAgent.eventCount ?? 0) > 0) {
      return { skip: "recovered_skip" as const };
    }

    // Compare-and-swap, same contract as the parent lane: the sweep read this
    // lane's byte count and the canonical minutes ago, so a live commit in
    // between must abort the repair rather than write from a stale observation.
    if (input.expectIndexedBytes !== undefined) {
      const actual = Number(existingAgent?.bytesUploaded ?? 0);
      if (actual !== input.expectIndexedBytes) {
        throw new IndexAdvancedError(input.expectIndexedBytes, actual);
      }
    }
    if (input.expectPriorTurns !== undefined && existingAgent) {
      const [priorAgg] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(hxTurns)
        .where(and(eq(hxTurns.sessionId, sessionRowId), eq(hxTurns.agentId, existingAgent.id)));
      const actualTurns = Number(priorAgg?.n ?? 0);
      // EXACT, deliberately, and it took two wrong turns to settle here.
      //
      // parseChunk is stateful across the text, so a lane built by APPENDING
      // chunks can hold more turns than parse(prefix) yields. The tempting fix
      // is to relax this to a lower bound — but that lets a tail sliced from a
      // STALE prefix splice content the lane already holds, which is silent
      // duplication, and there is no byte check that can see it (the CAS agrees:
      // both sides are wrong in the same direction).
      //
      // The deeper reason equality is right: the canonical-faithful state of a
      // lane is `parse(whole)` — that is precisely what a `replace` produces and
      // what the post-rebuild verification checks. A count that disagrees means
      // the lane has DRIFTED from what a whole-canonical parse says, whatever
      // produced the drift. Refusing the tail and taking the full rebuild
      // converges it to the canonical; that is repair, not loss.
      if (actualTurns !== input.expectPriorTurns) {
        throw new LanePrefixMismatchError(input.expectPriorTurns, actualTurns);
      }
    }
    const prev = input.replace ? undefined : existingAgent;
    const agentRollup = {
      eventCount: (prev?.eventCount ?? 0) + parsed.eventCount,
      inputTokens: (prev?.inputTokens ?? 0) + parsed.inputTokens,
      outputTokens: (prev?.outputTokens ?? 0) + parsed.outputTokens,
      cacheReadTokens: (prev?.cacheReadTokens ?? 0) + parsed.cacheReadTokens,
      cacheCreationTokens: (prev?.cacheCreationTokens ?? 0) + parsed.cacheCreationTokens,
      estCostUsd: (prev?.estCostUsd ?? 0) + parsed.costUsd,
      chunkCount: input.replace ? 1 : (existingAgent?.chunkCount ?? 0) + 1,
    };
    // Monotonic on append, authoritative on replace (mirrors the parent lane).
    const agentLastActivityAt = input.replace
      ? (parsed.lastActivityAt ?? existingAgent?.lastActivityAt ?? now)
      : (maxIso(existingAgent?.lastActivityAt, parsed.lastActivityAt) ?? now);

    let agentRowId: string;
    if (existingAgent) {
      await tx
        .update(hxSessionAgents)
        .set({
          kind: kindOf(meta),
          runId: metaStr(meta, "runId") ?? existingAgent.runId,
          toolUseId: metaStr(meta, "toolUseId") ?? existingAgent.toolUseId,
          agentType: metaStr(meta, "agentType") ?? existingAgent.agentType,
          label: metaStr(meta, "label") ?? existingAgent.label,
          worktreePath: metaStr(meta, "worktreePath") ?? existingAgent.worktreePath,
          cwd: metaStr(meta, "cwd") ?? existingAgent.cwd,
          gitBranch: metaStr(meta, "gitBranch") ?? existingAgent.gitBranch,
          modelId: dims.modelId ?? existingAgent.modelId,
          ...agentRollup,
          // Monotone on append for the same reason as the parent lane: a replayed
          // earlier chunk carries a smaller total, and letting it regress the
          // stored value is what makes a later tail slice from an offset the lane
          // has already passed.
          bytesUploaded: input.replace
            ? input.totalBytes
            : Math.max(Number(existingAgent.bytesUploaded ?? 0), input.totalBytes),
          lastActivityAt: agentLastActivityAt,
          updatedAt: now,
        })
        .where(eq(hxSessionAgents.id, existingAgent.id));
      agentRowId = existingAgent.id;
    } else {
      const [ins] = await tx
        .insert(hxSessionAgents)
        .values({
          sessionId: sessionRowId,
          agentExternalId: input.agentId,
          kind: kindOf(meta),
          runId: metaStr(meta, "runId"),
          toolUseId: metaStr(meta, "toolUseId"),
          agentType: metaStr(meta, "agentType"),
          label: metaStr(meta, "label"),
          worktreePath: metaStr(meta, "worktreePath"),
          cwd: metaStr(meta, "cwd"),
          gitBranch: metaStr(meta, "gitBranch"),
          modelId: dims.modelId,
          ...agentRollup,
          bytesUploaded: input.totalBytes,
          lastActivityAt: agentLastActivityAt,
        })
        .returning({ id: hxSessionAgents.id });
      agentRowId = ins.id;
    }

    if (input.replace) {
      // Child lane: same explicit embeddings hard-delete across the agent_id lane.
      const deleted = await tx
        .delete(hxTurns)
        .where(and(eq(hxTurns.sessionId, sessionRowId), eq(hxTurns.agentId, agentRowId)))
        .returning({ id: hxTurns.id });
      await deleteOrphanedEmbeddings(
        tx,
        deleted.map((d) => d.id),
      );
      await tx
        .delete(hxToolCalls)
        .where(and(eq(hxToolCalls.sessionId, sessionRowId), eq(hxToolCalls.agentId, agentRowId)));
    }

    await insertTurns(tx, sessionRowId, agentRowId, parsed.turns, now);
    await upsertToolCalls(tx, sessionRowId, agentRowId, parsed.toolCalls, now);

    // hx.session_facts is intentionally NOT recomputed here — the §10/§13-A4
    // completeness guarantee is scoped to the parent lane (agent_id IS NULL),
    // which a child-lane commit does not touch.

    await clearChunkIntent(
      tx,
      {
        userExternalId,
        family: input.key.family,
        sessionId: input.key.sessionId,
        agentExternalId: input.agentId,
        chunkId: input.chunkId,
      },
      now,
    );
    if (input.replace) {
      await clearSubsumedChunkIntents(
        tx,
        {
          userExternalId,
          family: input.key.family,
          sessionId: input.key.sessionId,
          agentExternalId: input.agentId,
        },
        input.objectBytes ?? input.totalBytes,
        now,
      );
    }

    await tx.insert(hxIngestEvents).values({
      userId: dims.userId,
      eventType: "hx.session.agent.updated",
      sessionId: sessionRowId,
      family: input.key.family,
      sessionIdExt: input.key.sessionId,
      chunkId: input.chunkId,
      dedupeKey,
      payload: { ...ingestEventPayload(input, sessionRowId, parsed), agentId: input.agentId, agentRowId },
      status: "processed",
      processedAt: now,
    });

    return { sessionRowId, turnsInserted: parsed.turns.length };
  });

  // Off the commit path: nudge the embed worker (best-effort — never throws).
  signalEmbedWork();

  if (appendOverlap > 0) {
    await recordIntegrityFinding(db, {
      userExternalId,
      family: input.key.family,
      sessionId: input.key.sessionId,
      agentExternalId: input.agentId,
      kind: "append_overlap",
      detail: { chunkId: input.chunkId, overlap: appendOverlap },
    });
  }

  if (!committed) return { applied: false, reason: "deduped" };
  const outcome = committed as {
    skip?: "deduped" | "recovered_skip" | "duplicate_records";
    sessionRowId?: string;
    turnsInserted?: number;
  };
  if (outcome.skip) return { applied: false, reason: outcome.skip };
  return {
    applied: true,
    sessionRowId: outcome.sessionRowId ?? "",
    turnsInserted: outcome.turnsInserted ?? 0,
  };
}
