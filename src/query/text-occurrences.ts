// A4 · hx_text_occurrences — whole-corpus, uncapped COUNT of how often a literal
// word / phrase appears in the in-scope transcript turns. The TEXT analogue of
// hx_sessions_aggregate: an AGGREGATION (count), not a retrieval — so unlike
// hx_session_search it has NO row cap, NO ranking, and returns the exact tally in
// one SQL pass. Reads the already-stored, already-indexed per-turn text
// `hx.turns.text` (tool output projected in; capped 40k/turn at ingest) via the
// existing pg_trgm (literal) + text_tsv (lexeme) GIN indexes — no blob scan, no
// new index, no migration. Scoped by the SAME workbench-resolved scope every hx_*
// tool uses (§13-A6): no new access surface (coarser aggregates over the exact
// corpus hx_session_search already exposes). Like hx_session_search, the scope
// is resolved to its session ids FIRST (resolveScopeSessionIds): inlined as a
// VALUES join it let the planner walk every in-scope turn instead of the GIN
// indexes, and a large scope's count then ran into the statement bound.
//
// Three semantics are returned so the agent picks what "how many times" means:
//   • occurrences     — total literal matches (sum(regexp_count); repeats within a
//                       turn each count). null in `lexeme` mode.
//   • matchingTurns   — turns containing ≥1 match.
//   • matchingSessions — distinct sessions containing ≥1 match.
//
// matchMode:
//   • literal_word (default) — whole-word literal ("observer" ≠ "observers").
//   • literal_substring      — substring literal ("observ" ⊂ "observer").
//   • lexeme                 — stemmed tsvector recall (related word forms); a
//                              fallback, never a literal count (tsvector can't
//                              count repeats and it stems + drops stopwords).

import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions, hxTurns } from "../host/postgres/schema";
import type { HxTurnKind } from "../host/postgres/schema/transcript";
import { dateWindowConditions } from "./date-window";
import { allowParallelWorkers, withWideReadBound } from "./read-bound";
import { buildLiteralRegex, prefilterHasTrigram, prefilterPattern } from "./text-match";
import { resolveScopeSessionIds, type FortressScope } from "./scope";
import { uuidArray } from "./sql-array";

export type TextMatchMode = "literal_word" | "literal_substring" | "lexeme";

// The 10-value turn taxonomy (schema `HxTurnKind`) — used to validate `kinds`.
// An unknown value is dropped; if EVERY kind is unknown we fall back to counting
// ALL kinds (fail-OPEN — the echoed `kinds` + note always state what was counted).
const TURN_KINDS: readonly HxTurnKind[] = [
  "user_text",
  "assistant_text",
  "tool_use",
  "tool_result",
  "thinking",
  "system_notice",
  "attachment_notice",
  "todo_reminder",
  "image",
  "queue_enqueue",
];

export interface TextOccurrencesInput {
  scope: FortressScope;
  query: string;
  matchMode?: TextMatchMode;
  /** Restrict to these turn kinds (default: every text-bearing kind). */
  kinds?: string[];
  family?: string;
  fromDate?: string;
  toDate?: string;
  timezone?: string;
}

export interface TextOccurrencesResult {
  matchMode: TextMatchMode;
  query: string;
  /** Literal-match total (repeats counted). null in `lexeme` mode. */
  occurrences: number | null;
  matchingTurns: number;
  matchingSessions: number;
  /** Which turn kinds were counted ("all" = no kind filter). */
  kinds: HxTurnKind[] | "all";
  /** Human caveat: the counted kinds + the 40k/turn cap (+ the lexeme label). */
  note: string;
}

/** Coerce a Postgres bigint/int scalar (number | bigint | numeric-as-string) to
 *  a finite number; non-finite ⇒ 0. */
function num(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/** Normalize drizzle's `execute` result to a row array across driver shapes. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: unknown };
  return Array.isArray(maybe?.rows) ? (maybe.rows as T[]) : [];
}

/** The literal count over the turns `conditions` admit (they may name
 *  hx.turns and hx.sessions). Exported for its statement-shape test.
 *
 *  The trigram-accelerated ILIKE prefilter (a proven superset) narrows rows, and
 *  regexp_count counts the exact matches in each turn that survives it; a turn
 *  with none counts toward none of the three numbers. OFFSET 0 keeps the inner
 *  query whole, so each parallel worker counts the matches in its own turns and
 *  the leader only adds up numbers. Flattened, the leader would read the text of
 *  every matching turn again for the aggregates.
 *
 *  The pattern reaches the planner through a one-row subquery, which the
 *  planner estimates at its default selectivity (0.5% of turns) instead of from
 *  the column statistics. Those hold about 100 sample texts, each under 1 kB,
 *  and when none of them contains the word the planner assumes 0.01%. On
 *  production on 2026-10-31 that put "release" at 397 turns; it is in 169,875.
 *  The plan then left the kind index out of the bitmap, so the out-of-line text
 *  of every matching turn of every kind was read before the kind filter ran:
 *  132,720 heap pages and 199,274 TOAST pages, 170 s. At the default estimate
 *  the kind index is in the bitmap and only turns of the asked kinds are read:
 *  with its pages read before, the same count took 78 s on the old plan and
 *  3.5 s on this one.
 *
 *  A pattern without a trigram stays a bound value: the planner must see that
 *  the trigram index would return every row for it. */
export function literalCountStatement(
  conditions: SQL[],
  query: string,
  matchMode: Exclude<TextMatchMode, "lexeme">,
): SQL {
  const re = buildLiteralRegex(query, matchMode);
  const prefilter = prefilterPattern(query);
  const prefiltered = prefilterHasTrigram(query)
    ? sql`${hxTurns.text} ILIKE (SELECT ${prefilter}::text)`
    : sql`${hxTurns.text} ILIKE ${prefilter}`;
  return sql`
    SELECT count(*) FILTER (WHERE m.n > 0)::int AS "matchingTurns",
           count(DISTINCT m.session_id) FILTER (WHERE m.n > 0)::int AS "matchingSessions",
           coalesce(sum(m.n), 0)::bigint AS occurrences
    FROM (
      SELECT ${hxTurns.sessionId} AS session_id, regexp_count(${hxTurns.text}, ${re}, 1, 'i') AS n
      FROM ${hxTurns}
      INNER JOIN ${hxSessions} ON ${hxSessions.id} = ${hxTurns.sessionId}
      WHERE ${and(...conditions, prefiltered)}
      OFFSET 0
    ) m`;
}

/** Keep only recognized turn kinds; empty/none ⇒ null ("count all kinds"). */
function normalizeKinds(kinds: string[] | undefined): HxTurnKind[] | null {
  if (!Array.isArray(kinds) || kinds.length === 0) return null;
  const known = new Set<HxTurnKind>();
  for (const k of kinds) {
    if ((TURN_KINDS as readonly string[]).includes(k)) known.add(k as HxTurnKind);
  }
  return known.size > 0 ? [...known] : null;
}

const CAP_NOTE =
  "Counts the indexed per-turn text (capped 40k chars/turn at ingest; matches beyond that within a single turn — only ever a giant tool dump, never conversational text — are not counted).";

function noteFor(matchMode: TextMatchMode, kinds: HxTurnKind[] | null): string {
  const kindNote = kinds
    ? `Counted turn kinds: ${kinds.join(", ")}.`
    : "Counted ALL text-bearing turn kinds (including tool output/code).";
  if (matchMode === "lexeme") {
    return `${kindNote} lexeme mode matches RELATED WORD FORMS (stemmed, stopwords dropped, phrase words not adjacency-checked) — it returns matchingTurns/matchingSessions only, NOT a literal occurrence count. ${CAP_NOTE}`;
  }
  return `${kindNote} ${CAP_NOTE}`;
}

export async function hxTextOccurrences(
  db: HxDb,
  input: TextOccurrencesInput,
): Promise<TextOccurrencesResult> {
  const rawMode = input.matchMode;
  const matchMode: TextMatchMode =
    rawMode === "literal_substring" || rawMode === "lexeme" ? rawMode : "literal_word";
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const kinds = normalizeKinds(input.kinds);
  const kindsEcho: HxTurnKind[] | "all" = kinds ?? "all";
  const note = noteFor(matchMode, kinds);

  // Empty query ⇒ zeros (occurrences null in lexeme mode — no literal count there).
  if (!query) {
    return {
      matchMode,
      query,
      occurrences: matchMode === "lexeme" ? null : 0,
      matchingTurns: 0,
      matchingSessions: 0,
      kinds: kindsEcho,
      note,
    };
  }

  // A WIDE read: a common word over a large scope visits every turn that holds
  // it, so the read runs with an exact bitmap, read-ahead and the longer bound
  // (withWideReadBound has the production measurements), and the literal count
  // on parallel workers (allowParallelWorkers). A term with no trigram cannot use
  // the trigram prefilter, so the regex reads every in-scope turn of the asked
  // kinds, and may run into that bound.
  const rows = await withWideReadBound(db, async (tx) => {
    // Shared filters: the scope's admitted session ids (the live, non-deleted
    // session row + owner gate, resolved once), both soft-delete flags explicitly,
    // optional kinds / family, and the shared timezone-aware date window (same
    // helper as search / aggregate, so the tools can never disagree on which
    // instants a range covers).
    const scopeIds = await resolveScopeSessionIds(tx, input.scope);
    if (scopeIds.length === 0) return [];
    const baseConditions: SQL[] = [
      sql`${hxTurns.sessionId} = ANY(${uuidArray(scopeIds)})`,
      isNull(hxTurns.deletedAt),
      isNull(hxSessions.deletedAt),
    ];
    if (kinds) baseConditions.push(inArray(hxTurns.kind, kinds));
    if (input.family) baseConditions.push(eq(hxSessions.family, input.family));
    baseConditions.push(
      ...dateWindowConditions(hxTurns.eventTs, input.fromDate, input.toDate, input.timezone),
    );

    if (matchMode === "lexeme") {
      // Stemmed tsvector recall. A tsvector match is boolean per turn, so there
      // is no occurrence count — turns / sessions only.
      const tsq = sql`plainto_tsquery('english', ${query})`;
      return await tx
        .select({
          matchingTurns: sql<number>`count(*)::int`,
          matchingSessions: sql<number>`count(DISTINCT ${hxTurns.sessionId})::int`,
          occurrences: sql<string | null>`NULL`,
        })
        .from(hxTurns)
        .innerJoin(hxSessions, eq(hxSessions.id, hxTurns.sessionId))
        .where(and(...baseConditions, sql`${hxTurns.textTsv} @@ ${tsq}`));
    }

    // Literal path: one regexp_count per turn decides all three numbers
    // (literalCountStatement has the plan and its production measurements).
    await allowParallelWorkers(tx);
    return rowsOf<{ matchingTurns: number; matchingSessions: number; occurrences: string }>(
      await tx.execute(literalCountStatement(baseConditions, query, matchMode)),
    );
  });

  const row = rows[0];
  return {
    matchMode,
    query,
    occurrences: matchMode === "lexeme" ? null : num(row?.occurrences),
    matchingTurns: num(row?.matchingTurns),
    matchingSessions: num(row?.matchingSessions),
    kinds: kindsEcho,
    note,
  };
}
