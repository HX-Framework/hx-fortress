// A4 · hx_semantic_search — SEMANTIC (vector) search over the in-scope sessions'
// conversational turns. The query TEXT is embedded INSIDE the fortress (it holds
// the OpenAI key — workbench never needs it), then an HNSW cosine scan (`<=>`)
// over hx.embeddings is JOINed embeddings → turns → the live session row, with
// the workbench-resolved scope applied on the SESSION (§13-A6; embeddings carry
// no user id, so scope is never evaluated on the vector row). Candidates are
// over-fetched (k×N) and re-ranked because the HNSW post-filters the scope WHERE.
//
// FAIL-FAST (not silent degrade): when pgvector is absent (`to_regtype('vector')
// IS NULL`, or 0006 unapplied so hx.embeddings doesn't exist), no embedder is
// configured, or the query embed fails on a credential error, it returns
// `unavailable:{reason}` naming the missing/invalid dependency — the caller
// surfaces it to the user rather than silently returning worse (keyword) results.

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { sanitizeDbError } from "../host/postgres/sanitize";
import { hxSessions, hxTurns } from "../host/postgres/schema";
import { hxEmbeddings } from "../host/postgres/schema/embeddings";
import { EmbedAccountError, type Embedder } from "../modules/embed-worker/openai";
import { scrubSecrets } from "../modules/embed-worker/scrub";
import { dateWindowConditions } from "./date-window";
import { scopePredicate, type FortressScope } from "./scope";
import { READ_STATEMENT_TIMEOUT } from "./read-bound";

export interface SemanticSearchInput {
  scope: FortressScope;
  queryText: string;
  k?: number;
  family?: string;
  /** Bare date (day boundary in `timezone`) or a full ISO-8601 instant. */
  fromDate?: string;
  toDate?: string;
  /** IANA timezone the bare-date bounds are interpreted in. Default UTC. */
  timezone?: string;
}

export interface SemanticHit {
  sessionId: string;
  seq: number;
  kind: string | null;
  snippet: string;
  /** Cosine distance (lower = nearer). */
  distance: number | null;
}

export interface SemanticSearchResult {
  hits: SemanticHit[];
  /** Set when semantic search could NOT run — a missing/invalid credential or an
   *  unprovisioned vector index. FAIL-FAST: the caller surfaces this reason to the
   *  user instead of silently returning worse (keyword) results. */
  unavailable?: { reason: string; detail?: string };
}

const DEFAULT_K = 20;
const MAX_K = 100;
// H-7 · hard length guard applied to the query text BEFORE it reaches scrubSecrets
// (defense-in-depth atop the now-linear scrub regexes) and before it egresses to
// OpenAI. A semantic query is a short natural-language phrase; anything past a few
// KB is abusive (a multi-MB query would burn scrub time and OpenAI would reject it
// on its ~8k-token cap anyway), so trim to this ceiling. Override via
// FORTRESS_MAX_QUERY_TEXT_CHARS (mirrors the other DoS caps).
const DEFAULT_MAX_QUERY_TEXT_CHARS = 8_000;
function maxQueryTextChars(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FORTRESS_MAX_QUERY_TEXT_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_QUERY_TEXT_CHARS;
}
// Over-fetch factor: the HNSW filters scope AFTER the distance scan, so pull more
// candidates than k and truncate post-filter to avoid starving a small scope.
const OVERFETCH = 5;
const SNIPPET_CHARS = 240;

function snippetOf(text: string | null): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t;
}

/** Normalize drizzle's `execute` result to a row array across driver shapes. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: unknown };
  return Array.isArray(maybe?.rows) ? (maybe.rows as T[]) : [];
}

async function vectorAvailable(db: HxDb): Promise<boolean> {
  try {
    const res = await db.execute(sql`SELECT to_regtype('vector') IS NOT NULL AS ok`);
    return rowsOf<{ ok: boolean }>(res)[0]?.ok === true;
  } catch {
    return false;
  }
}

/** FAIL-FAST: semantic search could not run. Return an explicit unavailable
 *  reason (NOT a silent keyword degrade) so the caller can tell the user which
 *  credential / dependency is missing or invalid. */
function unavailable(reason: string, detail?: string): SemanticSearchResult {
  return { hits: [], unavailable: detail ? { reason, detail } : { reason } };
}

export async function hxSemanticSearch(
  db: HxDb,
  embedder: Embedder | null,
  input: SemanticSearchInput,
): Promise<SemanticSearchResult> {
  const queryText = typeof input.queryText === "string" ? input.queryText.trim() : "";
  if (!queryText) return { hits: [] };
  // FAIL-FAST on a missing credential or unprovisioned infra — surface a clear
  // reason rather than silently degrading to keyword; the agent relays it.
  if (!embedder) return unavailable("openai_credential_missing");
  if (!(await vectorAvailable(db))) return unavailable("vector_index_unavailable");

  const k = Math.min(Math.max(1, input.k ?? DEFAULT_K), MAX_K);

  let queryVec: number[] | null | undefined;
  try {
    // Cap the query length BEFORE scrub + egress (H-7 DoS guard), then scrub any
    // secret/PII shapes out of it before it leaves the fortress for OpenAI.
    const cap = maxQueryTextChars();
    const capped = queryText.length > cap ? queryText.slice(0, cap) : queryText;
    [queryVec] = await embedder.embed([scrubSecrets(capped)]);
  } catch (err) {
    // An account-level error (unfunded / invalid key) is a CREDENTIAL problem —
    // name it so the operator/user knows to fix the key; anything else is transient.
    return unavailable(
      err instanceof EmbedAccountError ? "openai_credential_invalid_or_unfunded" : "openai_temporarily_unavailable",
      sanitizeDbError(err),
    );
  }
  if (!queryVec || queryVec.length === 0) return unavailable("openai_temporarily_unavailable");
  const literal = `[${queryVec.join(",")}]`;

  const distance = sql<number>`${hxEmbeddings.embedding} <=> ${literal}::vector`;

  // Scope stays the INLINE predicate here — deliberately NOT the resolved-ids
  // shape hx_session_search moved to. Measured on production (LETAIR-175
  // review): with `session_id = ANY(ids)` the planner abandons the HNSW index
  // for a seq-scan + hash-join + full sort (1,029 ms / 460k buffers), while
  // the inline shape keeps the scope as a per-candidate check. The inline
  // shape is itself scope-driven at large scopes (456 ms warm / 675k buffers
  // measured — a real cost the 20 s bound below now caps); fixing THAT needs
  // a recall-aware KNN-first design, not a scope swap — follow-up in the
  // LETAIR-175/176 analysis doc.
  const conditions = [
    scopePredicate(input.scope),
    eq(hxEmbeddings.ownerKind, "turn"),
    // The embedding column is nullable; exclude null-embedding rows so the JS
    // distance re-sort can't surface Number(null)===0 as a false nearest hit.
    isNotNull(hxEmbeddings.embedding),
    isNull(hxTurns.deletedAt),
  ];
  if (input.family) conditions.push(eq(hxSessions.family, input.family));
  // Semantic search windows on each turn's own event_ts (a matching turn is what
  // the caller wants dated), via the shared timezone-aware, day-inclusive helper.
  conditions.push(...dateWindowConditions(hxTurns.eventTs, input.fromDate, input.toDate, input.timezone));

  try {
    // Selective-scope recall: the HNSW index applies the scope WHERE only AFTER
    // its approximate distance scan, so on a narrow scope pgvector's default
    // hnsw.ef_search (40) can surface fewer than k in-scope rows — or none.
    // Raise the candidate pool and, on pgvector ≥ 0.8, let iterative scan keep
    // probing until k post-filter rows are found. Both are SET LOCAL inside one
    // transaction so they scope to THIS query alone and never leak to other
    // pooled queries; k×OVERFETCH stays as a backstop cap.
    const rows = await db.transaction(async (tx) => {
      // LETAIR-175 F2: bound the statement inside the caller's own deadline so
      // an abandoned call can never squat a pool slot for the 120 s default.
      await tx.execute(sql`SELECT set_config('statement_timeout', ${READ_STATEMENT_TIMEOUT}, true)`);
      await tx.execute(sql`SET LOCAL hnsw.ef_search = 200`);
      // hnsw.iterative_scan exists only on pgvector ≥ 0.8; on older builds it is
      // an unknown GUC that errors. Isolate the SET in a savepoint so that error
      // rolls back only the savepoint and never poisons the outer transaction.
      try {
        await tx.transaction(async (inner) => {
          await inner.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
        });
      } catch {
        // pgvector < 0.8 — no iterative scan; ef_search + OVERFETCH carry recall.
      }
      return tx
        .select({
          sessionId: hxSessions.sessionId,
          seq: hxTurns.seq,
          kind: hxTurns.kind,
          text: hxTurns.text,
          distance,
        })
        .from(hxEmbeddings)
        .innerJoin(hxTurns, eq(hxTurns.id, hxEmbeddings.ownerId))
        .innerJoin(hxSessions, eq(hxSessions.id, hxTurns.sessionId))
        .where(and(...conditions))
        .orderBy(distance)
        .limit(k * OVERFETCH);
    });

    // relaxed_order (iterative scan) can return candidates slightly out of
    // distance order, so re-sort the over-fetched pool by the exact computed
    // distance before taking the k nearest — strict final ordering, cheap on the
    // k×OVERFETCH pool, and not recoverable downstream once a nearer row is dropped.
    const hits = [...rows]
      .sort((a, b) => Number(a.distance) - Number(b.distance))
      .slice(0, k)
      .map((r) => ({
        sessionId: r.sessionId,
        seq: r.seq,
        kind: r.kind,
        snippet: snippetOf(r.text),
        distance: Number(r.distance),
      }));
    return { hits };
  } catch (err) {
    // hx.embeddings missing (0006 unapplied) or any vector fault → fail-fast. The
    // detail crosses to the agent, so redact any DSN a driver error could carry.
    return unavailable("semantic_query_failed", sanitizeDbError(err));
  }
}
