// A4 · hx_semantic_search — SEMANTIC (vector) search over the in-scope sessions'
// conversational turns. The query TEXT is embedded INSIDE the fortress (it holds
// the OpenAI key — workbench never needs it) and ranked by cosine distance against
// hx.embeddings, with the workbench-resolved scope applied on the SESSION
// (§13-A6; embeddings carry no session or user id, so the scope is checked on the
// turn → session row each vector belongs to).
//
// TWO PLANS, chosen per call from what the scope and the window hold.
//
//   • Exact. Every embedded turn the scope (or a narrow date window) holds is
//     ranked, so nothing in scope can be missed, and the cost is those turns
//     alone. Chosen when the scope holds at most EXACT_SCOPE_MAX_TURNS turns, or
//     the date window at most EXACT_WINDOW_MAX_TURNS. Its ORDER BY calls cosine_distance(), the function, rather than the
//     `<=>` operator, so the planner cannot answer it from the HNSW index: that
//     index applies the scope AFTER an approximate scan of the whole corpus, and
//     on a small scope it can return fewer hits than exist.
//
//   • Nearest first, for everything larger. The HNSW index alone returns the N
//     turns nearest to the query in the WHOLE corpus (one table, ORDER BY `<=>`
//     LIMIT N, the plan the index exists for), and a second statement keeps the
//     ones in scope and in the window. When fewer than k survive, N grows ×4 up
//     to MAX_CANDIDATES. A scope this large is a sizeable share of the corpus, so
//     its nearest turns sit among the corpus's nearest; an in-scope turn the index
//     does not rank within the nearest MAX_CANDIDATES is no longer a close match.
//
// Why separate statements. The single-query shape (embeddings JOIN turns JOIN
// sessions WHERE <scope> ORDER BY distance LIMIT k) let the planner start from
// the scope: at a large scope it read every in-scope turn and probed its
// embedding — 456 ms warm and 675k buffers for one call, measured on production
// on 2026-08-12. Whenever those buffers were not in cache the call ran into the
// 20 s read bound and answered `semantic_query_failed`: on 2026-10-26 the hosted
// fortress answered every large-scope semantic search that way. The planner
// cannot reorder work across statements, so each plan here runs in the order
// written.
//
// FAIL-FAST (not silent degrade): when pgvector is absent (`to_regtype('vector')
// IS NULL`, or 0006 unapplied so hx.embeddings doesn't exist), no embedder is
// configured, or the query embed fails on a credential error, it returns
// `unavailable:{reason}` naming the missing/invalid dependency — the caller
// surfaces it to the user rather than silently returning worse (keyword) results.

import { sql, type SQL } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { sanitizeDbError } from "../host/postgres/sanitize";
import { EmbedAccountError, type Embedder } from "../modules/embed-worker/openai";
import { scrubSecrets } from "../modules/embed-worker/scrub";
import { dateWindowConditions } from "./date-window";
import { withReadBound } from "./read-bound";
import { resolveScopeSessionIds, type FortressScope } from "./scope";

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

/** The sizes the plan choice uses. Every field defaults to the constant of the
 *  same name below; tests pass smaller ones to reach each plan on a small corpus. */
export interface SemanticSearchTuning {
  exactScopeMaxTurns?: number;
  exactWindowMaxTurns?: number;
  minCandidates?: number;
  maxCandidates?: number;
}

/** Which plan answered. Not part of the MCP answer; tests read it. */
export type SemanticPlan = "exact_scope" | "exact_window" | "nearest_first";

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

// The exact plan reads every turn of the scope, tool turns included, to find the
// conversational ones that carry a vector; 30,000 turn rows (and the vectors of
// the few thousand conversational ones among them) stay well inside the read
// bound on a cold cache.
const EXACT_SCOPE_MAX_TURNS = 30_000;
// A narrow date window is ranked exactly from the turns it holds, found through
// the event_ts index, whatever the scope's size ("what did I say about X today").
const EXACT_WINDOW_MAX_TURNS = 20_000;
// The nearest-first pool: 1,000 → 4,000 → 16,000 candidates. One HNSW scan of
// 1,000 is a few thousand index pages; 16,000 is the most one call may read.
const MIN_CANDIDATES = 1_000;
const MAX_CANDIDATES = 16_000;
const CANDIDATE_GROWTH = 4;
// pgvector's own ceiling on hnsw.ef_search.
const MAX_EF_SEARCH = 1_000;
const SNIPPET_CHARS = 240;
// The snippet needs SNIPPET_CHARS after whitespace is collapsed; reading the head
// of the turn keeps a 40k-char turn from crossing the wire for 240 of them.
const SNIPPET_SOURCE_CHARS = 4_000;

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

/** One bound `uuid[]` parameter, however many ids. Every id here was read from
 *  a uuid column, so the array literal needs no quoting. Bun.SQL would expand a
 *  JS array into a CSV literal, and `inArray` costs one bind per id. */
function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

/** An integer LIMIT written into the statement text rather than bound. A bound
 *  LIMIT leaves a generic plan guessing the row count, and the candidate scan
 *  must keep its index plan for every N. */
function limitOf(n: number): SQL {
  return sql.raw(String(Math.max(1, Math.floor(n))));
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

interface RankedTurn {
  id: string;
  sessionId: string;
  seq: number;
  kind: string | null;
  distance: number;
}

/** The admitted session row ids, narrowed to one family when asked. Admission is
 *  `resolveScopeSessionIds` — the same subquery every scoped read runs. */
async function scopeSessionIds(db: HxDb, input: SemanticSearchInput): Promise<string[]> {
  const ids = await resolveScopeSessionIds(db, input.scope);
  if (!input.family || ids.length === 0) return ids;
  const rows = rowsOf<{ id: string }>(
    await db.execute(
      sql`SELECT s.id FROM hx.sessions s WHERE s.id = ANY(${uuidArray(ids)}) AND s.family = ${input.family}`,
    ),
  );
  return rows.map((r) => String(r.id));
}

/** The scope's turn rows — what the exact plan reads — counted up to `cap + 1`
 *  along the (session_id, seq) index, so a scope of any size costs at most that
 *  many index entries. Soft-deleted turns count too: this sizes the read, it is
 *  not an answer. */
async function scopeTurnsUpTo(db: HxDb, ids: readonly string[], cap: number): Promise<number> {
  const rows = rowsOf<{ n: unknown }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM hx.turns t
        WHERE t.session_id = ANY(${uuidArray(ids)})
        ORDER BY t.session_id, t.seq
        LIMIT ${limitOf(cap + 1)}
      ) bounded`),
  );
  return Number(rows[0]?.n ?? 0);
}

/** Turns of ANY scope inside the window, counted up to `cap + 1` along the
 *  event_ts index. The ORDER BY keeps the planner on that index: a bare LIMIT
 *  invites a sequential scan that assumes matches are spread evenly, while a
 *  recent window's turns sit at the end of the table. */
async function windowTurnsUpTo(db: HxDb, window: readonly SQL[], cap: number): Promise<number> {
  const rows = rowsOf<{ n: unknown }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM hx.turns t
        WHERE ${sql.join([...window], sql` AND `)}
        ORDER BY t.event_ts
        LIMIT ${limitOf(cap + 1)}
      ) bounded`),
  );
  return Number(rows[0]?.n ?? 0);
}

/** Exact plan over a small scope: every embedded turn of the scope's sessions. */
async function exactByScope(
  db: HxDb,
  vector: string,
  ids: readonly string[],
  window: readonly SQL[],
  k: number,
): Promise<RankedTurn[]> {
  const conditions = [
    sql`t.session_id = ANY(${uuidArray(ids)})`,
    sql`t.deleted_at IS NULL`,
    sql`e.embedding IS NOT NULL`,
    ...window,
  ];
  return rowsOf<RankedTurn>(
    await db.execute(sql`
      SELECT t.id, s.session_id AS "sessionId", t.seq, t.kind,
             cosine_distance(e.embedding, ${vector}::vector) AS distance
      FROM hx.turns t
      JOIN hx.sessions s ON s.id = t.session_id
      JOIN hx.embeddings e ON e.owner_kind = 'turn' AND e.owner_id = t.id
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY distance, t.id
      LIMIT ${limitOf(k)}`),
  );
}

/** Exact plan over a narrow window: the window's turns first (MATERIALIZED, so
 *  the planner reaches them through the event_ts index rather than through a
 *  scope that may hold far more turns than the window does), then the scope. */
async function exactByWindow(
  db: HxDb,
  vector: string,
  ids: readonly string[],
  window: readonly SQL[],
  k: number,
): Promise<RankedTurn[]> {
  return rowsOf<RankedTurn>(
    await db.execute(sql`
      WITH win AS MATERIALIZED (
        SELECT t.id, t.session_id, t.seq, t.kind FROM hx.turns t
        WHERE ${sql.join([...window, sql`t.deleted_at IS NULL`], sql` AND `)}
      )
      SELECT w.id, s.session_id AS "sessionId", w.seq, w.kind,
             cosine_distance(e.embedding, ${vector}::vector) AS distance
      FROM win w
      JOIN hx.sessions s ON s.id = w.session_id
      JOIN hx.embeddings e ON e.owner_kind = 'turn' AND e.owner_id = w.id
      WHERE w.session_id = ANY(${uuidArray(ids)}) AND e.embedding IS NOT NULL
      ORDER BY distance, w.id
      LIMIT ${limitOf(k)}`),
  );
}

/** The candidate statement of the nearest-first plan: one table, ordered by the
 *  `<=>` operator, limited — the shape the HNSW index answers. Exported for the
 *  test that checks the index still answers it. */
export function nearestCandidatesSql(vector: string, n: number): SQL {
  return sql`
    SELECT e.owner_id AS "ownerId", e.embedding <=> ${vector}::vector AS distance
    FROM hx.embeddings e
    WHERE e.owner_kind = 'turn'
    ORDER BY e.embedding <=> ${vector}::vector
    LIMIT ${limitOf(n)}`;
}

/** Let one HNSW scan return `n` rows. Without an iterative scan the index stops at
 *  hnsw.ef_search rows (40 by default) whatever the LIMIT; the iterative-scan
 *  settings exist only on pgvector ≥ 0.8, so each is set in its own savepoint and
 *  an older pgvector keeps ef_search alone (up to 1,000 candidates). */
async function sizeIndexScan(db: HxDb, n: number): Promise<void> {
  await db.execute(sql`SELECT set_config('hnsw.ef_search', ${String(Math.min(MAX_EF_SEARCH, Math.max(40, n)))}, true)`);
  for (const setting of [
    sql`SET LOCAL hnsw.iterative_scan = relaxed_order`,
    sql`SELECT set_config('hnsw.max_scan_tuples', ${String(Math.max(20_000, n * 4))}, true)`,
    sql`SET LOCAL hnsw.scan_mem_multiplier = 4`,
  ]) {
    try {
      await db.transaction(async (inner) => {
        await inner.execute(setting);
      });
    } catch {
      // pgvector < 0.8 — the setting does not exist; ef_search carries the scan.
    }
  }
}

/** Nearest-first plan: the corpus's nearest N turns from the index alone, then
 *  the ones in scope and in the window, growing N until k survive. */
async function nearestFirst(
  db: HxDb,
  vector: string,
  ids: readonly string[],
  window: readonly SQL[],
  k: number,
  minCandidates: number,
  maxCandidates: number,
): Promise<RankedTurn[]> {
  let n = Math.min(minCandidates, maxCandidates);
  for (;;) {
    await sizeIndexScan(db, n);
    const candidates = rowsOf<{ ownerId: string; distance: number }>(
      await db.execute(nearestCandidatesSql(vector, n)),
    );
    const distanceOf = new Map(candidates.map((c) => [String(c.ownerId), Number(c.distance)]));
    const inScope =
      candidates.length === 0
        ? []
        : rowsOf<Omit<RankedTurn, "distance">>(
            await db.execute(sql`
              SELECT t.id, s.session_id AS "sessionId", t.seq, t.kind
              FROM hx.turns t
              JOIN hx.sessions s ON s.id = t.session_id
              WHERE ${sql.join(
                [
                  sql`t.id = ANY(${uuidArray([...distanceOf.keys()])})`,
                  sql`t.session_id = ANY(${uuidArray(ids)})`,
                  sql`t.deleted_at IS NULL`,
                  ...window,
                ],
                sql` AND `,
              )}`),
          );
    const ranked = inScope
      .map((r) => ({ ...r, id: String(r.id), distance: distanceOf.get(String(r.id)) ?? Number.POSITIVE_INFINITY }))
      // relaxed_order lets an iterative scan hand rows back slightly out of
      // distance order; the final order is decided here, by the exact distance.
      .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Done when k survived, when the index had no more to give, or at the cap.
    if (ranked.length >= k || candidates.length < n || n >= maxCandidates) return ranked.slice(0, k);
    n = Math.min(maxCandidates, n * CANDIDATE_GROWTH);
  }
}

/** The ranked turns' snippets, read for the k winners only. */
async function withSnippets(db: HxDb, ranked: readonly RankedTurn[]): Promise<SemanticHit[]> {
  if (ranked.length === 0) return [];
  const rows = rowsOf<{ id: string; text: string | null }>(
    await db.execute(sql`
      SELECT t.id, left(t.text, ${SNIPPET_SOURCE_CHARS}) AS text
      FROM hx.turns t
      WHERE t.id = ANY(${uuidArray(ranked.map((r) => r.id))})`),
  );
  const textOf = new Map(rows.map((r) => [String(r.id), r.text]));
  return ranked.map((r) => ({
    sessionId: r.sessionId,
    seq: r.seq,
    kind: r.kind,
    snippet: snippetOf(textOf.get(String(r.id)) ?? null),
    distance: Number(r.distance),
  }));
}

export async function hxSemanticSearch(
  db: HxDb,
  embedder: Embedder | null,
  input: SemanticSearchInput,
  tuning: SemanticSearchTuning = {},
  /** Told which plan answered; tests only. */
  onPlan?: (plan: SemanticPlan) => void,
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
  const vector = `[${queryVec.join(",")}]`;

  const exactScopeMaxTurns = tuning.exactScopeMaxTurns ?? EXACT_SCOPE_MAX_TURNS;
  const exactWindowMaxTurns = tuning.exactWindowMaxTurns ?? EXACT_WINDOW_MAX_TURNS;
  // Semantic search windows on each turn's own event_ts (a matching turn is what
  // the caller wants dated), via the shared timezone-aware, day-inclusive helper.
  const window = dateWindowConditions(sql`t.event_ts`, input.fromDate, input.toDate, input.timezone);

  try {
    // Every statement inside runs under the 20 s read bound (LETAIR-175 F2).
    return await withReadBound(db, async (bdb) => {
      const ids = await scopeSessionIds(bdb, input);
      if (ids.length === 0) return { hits: [] };

      let plan: SemanticPlan = "nearest_first";
      if ((await scopeTurnsUpTo(bdb, ids, Math.max(0, exactScopeMaxTurns))) <= exactScopeMaxTurns) plan = "exact_scope";
      else if (window.length > 0 && (await windowTurnsUpTo(bdb, window, exactWindowMaxTurns)) <= exactWindowMaxTurns)
        plan = "exact_window";
      onPlan?.(plan);

      const ranked =
        plan === "exact_scope"
          ? await exactByScope(bdb, vector, ids, window, k)
          : plan === "exact_window"
            ? await exactByWindow(bdb, vector, ids, window, k)
            : await nearestFirst(
                bdb,
                vector,
                ids,
                window,
                k,
                tuning.minCandidates ?? MIN_CANDIDATES,
                tuning.maxCandidates ?? MAX_CANDIDATES,
              );
      return { hits: await withSnippets(bdb, ranked) };
    });
  } catch (err) {
    // hx.embeddings missing (0006 unapplied), a statement over the read bound, or
    // any vector fault → fail-fast. The detail crosses to the agent, so redact any
    // DSN a driver error could carry.
    return unavailable("semantic_query_failed", sanitizeDbError(err));
  }
}
