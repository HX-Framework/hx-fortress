// A4 · hx_text_occurrences — whole-corpus, uncapped COUNT of how often a literal
// word / phrase appears in the in-scope transcript turns. The TEXT analogue of
// hx_sessions_aggregate: an AGGREGATION (count), not a retrieval — so unlike
// hx_session_search it has NO row cap, NO ranking, and returns the exact tally in
// one SQL pass. Reads the already-stored, already-indexed per-turn text
// `hx.turns.text` (tool output projected in; capped 40k/turn at ingest) via the
// existing pg_trgm (literal) + text_tsv (lexeme) GIN indexes — no blob scan, no
// new index, no migration. Scoped by the SAME workbench-resolved scopePredicate
// every hx_* tool uses (§13-A6): no new access surface (coarser aggregates over
// the exact corpus hx_session_search already exposes).
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

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions, hxTurns } from "../host/postgres/schema";
import type { HxTurnKind } from "../host/postgres/schema/transcript";
import { dateWindowConditions } from "./date-window";
import { buildLiteralRegex, prefilterPattern } from "./text-match";
import { scopePredicate, type FortressScope } from "./scope";

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

// Bound the scan: a very common or sub-3-char term can't use the trigram
// prefilter, so the regex scans the in-scope turns — correct but potentially
// heavy. SET LOCAL scopes this to the tool's own transaction.
const STATEMENT_TIMEOUT = "15s";

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

  // Shared filters: scope (which already gates on the live, non-deleted session
  // row + owner gate), plus both soft-delete flags explicitly, optional kinds /
  // family, and the shared timezone-aware date window (same helper as search /
  // aggregate, so the tools can never disagree on which instants a range covers).
  const baseConditions = [
    scopePredicate(input.scope),
    isNull(hxTurns.deletedAt),
    isNull(hxSessions.deletedAt),
  ];
  if (kinds) baseConditions.push(inArray(hxTurns.kind, kinds));
  if (input.family) baseConditions.push(eq(hxSessions.family, input.family));
  baseConditions.push(
    ...dateWindowConditions(hxTurns.eventTs, input.fromDate, input.toDate, input.timezone),
  );

  const rows = await db.transaction(async (tx) => {
    // Transaction-local statement timeout via set_config(..., is_local=true): the
    // PARAMETERIZABLE form of SET LOCAL. `SET LOCAL statement_timeout = $1` is a
    // syntax error — the SET grammar takes no bind params — so the value must ride
    // through set_config (don't "simplify" this back to a parameterized SET LOCAL).
    await tx.execute(sql`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`);

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

    // Literal path: the trigram-accelerated ILIKE prefilter (a proven superset)
    // narrows rows; the exact `~*` regex then decides each match in the FILTER,
    // and regexp_count tallies repeats within the surviving turns. Both the
    // FILTER and regexp_count use the SAME regex, so the three counts agree.
    const re = buildLiteralRegex(query, matchMode);
    const prefilter = prefilterPattern(query);
    return await tx
      .select({
        matchingTurns: sql<number>`count(*) FILTER (WHERE ${hxTurns.text} ~* ${re})::int`,
        matchingSessions: sql<number>`count(DISTINCT ${hxTurns.sessionId}) FILTER (WHERE ${hxTurns.text} ~* ${re})::int`,
        occurrences: sql<string>`coalesce(sum(regexp_count(${hxTurns.text}, ${re}, 1, 'i')), 0)::bigint`,
      })
      .from(hxTurns)
      .innerJoin(hxSessions, eq(hxSessions.id, hxTurns.sessionId))
      .where(and(...baseConditions, sql`${hxTurns.text} ILIKE ${prefilter}`));
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
