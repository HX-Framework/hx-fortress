// A4 · hx_session_search — CROSS-session keyword/substring search over the
// fortress's local `hx.turns` (text_tsv GIN + pg_trgm). The index is BROAD: it
// covers every text-bearing turn including tool_use/tool_result (logs/output/
// code), so a literal hits whether the user typed it or a tool emitted it. Each
// query INNER JOINs hx.sessions and applies the workbench-resolved scope on the
// live session row (§13-A6); never the denormalized turns.user_id.
//
// RANKING IS BOUNDED. ts_rank reads each match's whole tsvector, and a tool
// output's tsvector is stored out of line, so ranking every match of a common
// word cost one out-of-line read per match: on production on 2026-10-28,
// "release" over a 31,807-session scope matched 54,186 turns and the ranking
// read 161,615 pages in 40 s, past the bound. So the matches are found first
// from the heap alone (id and time, nothing out of line), and only the newest
// RANK_POOL of them are ranked. A word with more matches than that answers
// `truncated: true` with `dropped`, the same signal an over-budget page gives, so
// the caller narrows with a date window or a more specific term.

import { sql, type SQL } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import type { HxTurnKind } from "../host/postgres/schema/transcript";
import { dateWindowConditions } from "./date-window";
import { withWideReadBound } from "./read-bound";
import { resolveScopeSessionIds, type FortressScope } from "./scope";
import { limitOf, textArray, uuidArray } from "./sql-array";

export interface SearchInput {
  scope: FortressScope;
  query: string;
  k?: number;
  /** Restrict to these turn kinds (unknown values dropped; empty/none ⇒ all
   *  kinds). Cross-session eventTypes filtering was silently unsupported —
   *  LETAIR-176 asked for "chats where I asked", which needs user_text only. */
  kinds?: string[];
  family?: string;
  /** Bare date (day boundary in `timezone`) or a full ISO-8601 instant. */
  fromDate?: string;
  toDate?: string;
  /** IANA timezone the bare-date bounds are interpreted in. Default UTC. */
  timezone?: string;
}

export interface SearchHit {
  sessionId: string;
  seq: number;
  kind: string | null;
  snippet: string;
  rank: number;
}

export type SearchResult = {
  hits: SearchHit[];
  /** More turns matched than were ranked: the hits are the best of the newest
   *  RANK_POOL matches, and `dropped` matches were never ranked or returned. */
  truncated?: true;
  dropped?: number;
};

const DEFAULT_K = 20;
const MAX_K = 100;
// The matches a search ranks, newest first. Ranking 2,000 read about 1 s of
// out-of-line pages on production for the most common word measured.
const RANK_POOL = 2_000;

/** Normalize drizzle's `execute` result to a row array across driver shapes. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: unknown };
  return Array.isArray(maybe?.rows) ? (maybe.rows as T[]) : [];
}

// The 10-value turn taxonomy — mirrors hx_text_occurrences' validation: unknown
// values are dropped; if every value is unknown the filter is ignored (fail
// open, and the caller sees exactly what matched).
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

export async function hxSessionSearch(
  db: HxDb,
  input: SearchInput,
  /** Tests pass a small pool to reach the bounded ranking on a small corpus. */
  tuning: { rankPool?: number } = {},
): Promise<SearchResult> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { hits: [] };
  const k = Math.min(Math.max(1, input.k ?? DEFAULT_K), MAX_K);
  const rankPool = Math.max(k, tuning.rankPool ?? RANK_POOL);
  const kindSet = Array.isArray(input.kinds)
    ? (input.kinds.filter((v): v is HxTurnKind => (TURN_KINDS as readonly string[]).includes(v)))
    : [];

  // Match the generated column's config (`to_tsvector('english', text)`).
  const tsq = sql`plainto_tsquery('english', ${query})`;

  // Bounded as a WIDE read (withWideReadBound: exact bitmap, read-ahead, the
  // longer bound) and SCOPE-FIRST (LETAIR-175 F1): resolve the admitted session
  // ids once, then let the turns side use its GIN index. Inlining the scope as
  // a VALUES join flipped the planner into scanning every in-scope turn —
  // 2,439 ms vs 29 ms measured on the same production data; see
  // resolveScopeSessionIds for the full account. The ids are ONE uuid[]
  // parameter: one bind per id stops working past 65,535 of them.
  return withWideReadBound(db, async (bdb) => {
    let scopeIds = await resolveScopeSessionIds(bdb, input.scope);
    if (scopeIds.length > 0 && input.family) {
      scopeIds = rowsOf<{ id: string }>(
        await bdb.execute(
          sql`SELECT s.id FROM hx.sessions s WHERE s.id = ANY(${uuidArray(scopeIds)}) AND s.family = ${input.family}`,
        ),
      ).map((r) => String(r.id));
    }
    if (scopeIds.length === 0) return { hits: [] };

    const conditions: SQL[] = [
      sql`t.session_id = ANY(${uuidArray(scopeIds)})`,
      sql`t.text_tsv @@ ${tsq}`,
      sql`t.deleted_at IS NULL`,
    ];
    if (kindSet.length > 0) conditions.push(sql`t.kind = ANY(${textArray(kindSet)})`);
    // Search windows on each turn's own event_ts (a matching turn is what the caller
    // wants dated), via the shared timezone-aware, day-inclusive helper.
    conditions.push(...dateWindowConditions(sql`t.event_ts`, input.fromDate, input.toDate, input.timezone));

    // `matches` reads only the heap (id, event_ts): a GIN match on one or more
    // words needs no recheck against the stored tsvector, so nothing out of line
    // is read for it. `pool` keeps the newest RANK_POOL; `top` ranks them; the
    // snippet is built for the k winners alone.
    const rows = rowsOf<{
      sessionId: string;
      seq: number;
      kind: string | null;
      rank: number;
      snippet: string;
      matched: number;
    }>(
      await bdb.execute(sql`
        WITH matches AS MATERIALIZED (
          SELECT t.id, t.event_ts FROM hx.turns t
          WHERE ${sql.join(conditions, sql` AND `)}
        ),
        pool AS MATERIALIZED (
          SELECT id FROM matches ORDER BY event_ts DESC NULLS LAST, id LIMIT ${limitOf(rankPool)}
        ),
        top AS MATERIALIZED (
          SELECT t.id, ts_rank(t.text_tsv, ${tsq}) AS rank
          FROM hx.turns t
          WHERE t.id IN (SELECT id FROM pool)
          ORDER BY rank DESC, t.id
          LIMIT ${limitOf(k)}
        )
        SELECT s.session_id AS "sessionId", t.seq, t.kind, top.rank,
               ts_headline('english', coalesce(t.text, ''), ${tsq}, 'MaxFragments=1,MaxWords=20,MinWords=5,ShortWord=2') AS snippet,
               (SELECT count(*) FROM matches)::int AS matched
        FROM top
        JOIN hx.turns t ON t.id = top.id
        JOIN hx.sessions s ON s.id = t.session_id
        ORDER BY top.rank DESC, t.id`),
    );

    const hits = rows.map((r) => ({
      sessionId: r.sessionId,
      seq: Number(r.seq),
      kind: r.kind,
      snippet: r.snippet,
      rank: Number(r.rank),
    }));
    const matched = Number(rows[0]?.matched ?? 0);
    return matched > rankPool ? { hits, truncated: true as const, dropped: matched - hits.length } : { hits };
  });
}
