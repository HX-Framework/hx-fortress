// A4 · hx_session_search — CROSS-session keyword/substring search over the
// fortress's local `hx.turns` (text_tsv GIN + pg_trgm). The index is BROAD: it
// covers every text-bearing turn including tool_use/tool_result (logs/output/
// code), so a literal hits whether the user typed it or a tool emitted it. Each
// query INNER JOINs hx.sessions and applies the workbench-resolved scope on the
// live session row (§13-A6); never the denormalized turns.user_id.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions, hxTurns } from "../host/postgres/schema";
import type { HxTurnKind } from "../host/postgres/schema/transcript";
import { dateWindowConditions } from "./date-window";
import { withReadBound } from "./read-bound";
import { resolveScopeSessionIds, type FortressScope } from "./scope";

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

const DEFAULT_K = 20;
const MAX_K = 100;

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

export async function hxSessionSearch(db: HxDb, input: SearchInput): Promise<{ hits: SearchHit[] }> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { hits: [] };
  const k = Math.min(Math.max(1, input.k ?? DEFAULT_K), MAX_K);
  const kindSet = Array.isArray(input.kinds)
    ? (input.kinds.filter((v): v is HxTurnKind => (TURN_KINDS as readonly string[]).includes(v)))
    : [];

  // Match the generated column's config (`to_tsvector('english', text)`).
  const tsq = sql`plainto_tsquery('english', ${query})`;
  const rank = sql<number>`ts_rank(${hxTurns.textTsv}, ${tsq})`;

  // Bounded (LETAIR-175 F2) and SCOPE-FIRST (F1): resolve the admitted session
  // ids once, then let the turns side use its GIN index. Inlining the scope as
  // a VALUES join flipped the planner into scanning every in-scope turn —
  // 2,439 ms vs 29 ms measured on the same production data; see
  // resolveScopeSessionIds for the full account.
  return withReadBound(db, async (bdb) => {
    const scopeIds = await resolveScopeSessionIds(bdb, input.scope);
    if (scopeIds.length === 0) return { hits: [] };

    const conditions = [
      inArray(hxTurns.sessionId, scopeIds),
      sql`${hxTurns.textTsv} @@ ${tsq}`,
      isNull(hxTurns.deletedAt),
    ];
    if (kindSet.length > 0) conditions.push(inArray(hxTurns.kind, kindSet));
    if (input.family) conditions.push(eq(hxSessions.family, input.family));
    // Search windows on each turn's own event_ts (a matching turn is what the caller
    // wants dated), via the shared timezone-aware, day-inclusive helper.
    conditions.push(...dateWindowConditions(hxTurns.eventTs, input.fromDate, input.toDate, input.timezone));

    const rows = await bdb
      .select({
        sessionId: hxSessions.sessionId,
        seq: hxTurns.seq,
        kind: hxTurns.kind,
        rank,
        snippet: sql<string>`ts_headline('english', coalesce(${hxTurns.text}, ''), ${tsq}, 'MaxFragments=1,MaxWords=20,MinWords=5,ShortWord=2')`,
      })
      .from(hxTurns)
      .innerJoin(hxSessions, eq(hxSessions.id, hxTurns.sessionId))
      .where(and(...conditions))
      .orderBy(desc(rank))
      .limit(k);

    return {
      hits: rows.map((r) => ({
        sessionId: r.sessionId,
        seq: r.seq,
        kind: r.kind,
        snippet: r.snippet,
        rank: Number(r.rank),
      })),
    };
  });
}
