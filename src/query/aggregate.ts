// A4 · hx_sessions_aggregate — productivity metrics over the in-scope sessions,
// computed LIVE from `hx.session_facts JOIN hx.sessions` (§10 — one source, one
// bucketing). The per-session facts rows are derived at ingest (§13-A4); this
// reads them live, scoped by the workbench-resolved identities (A6) + the live
// `hx.sessions.deleted_at IS NULL` row — the fortress evaluates no org/repo
// predicate of its own. A live JOIN (not a baked rollup), so a re-attributed or
// soft-deleted session is correct on every call. Fail-closed: an empty scope ⇒
// `scopePredicate` is `false` ⇒ zeros.

import { and, eq, ilike, isNull, sql, type SQL } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxRepos, hxSessions, hxUsers } from "../host/postgres/schema";
import { hxSessionFacts } from "../host/postgres/schema/facts";
import { dateWindowConditions } from "./date-window";
import { scopePredicate, type FortressScope } from "./scope";

export interface AggregateInput {
  scope: FortressScope;
  family?: string;
  /** Lower bound on the session's last activity (`last_activity_at`), matching
   *  hx_sessions_list + the widgets — a session is in-window iff it was last
   *  active on/after this. A bare date (YYYY-MM-DD) is a day boundary in
   *  `timezone`; a full ISO-8601 timestamp is an absolute instant (sub-day). */
  fromDate?: string;
  /** Upper bound on last activity (day-inclusive for a bare date; instant-
   *  inclusive for a timestamp). */
  toDate?: string;
  /** IANA timezone the bare-date bounds are interpreted in. Default UTC. */
  timezone?: string;
  cwdContains?: string;
  /** Also return per-bucket subtotals in `groups`: "user" = per session owner
   *  (team/org load), "repo" = per repository, "cwd" = per working directory.
   *  For "repo"/"cwd" a session with no value falls into a labeled bucket
   *  ("(unattributed)" / "(none)") rather than being dropped. */
  groupBy?: "user" | "repo" | "cwd";
}

export interface AggregateResult {
  totalSessions: number;
  activeMs: number;
  userMsgs: number;
  assistantMsgs: number;
  filesTouched: number;
  linesAdded: number;
  linesRemoved: number;
  estCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolCallsByType: Record<string, number>;
  /** Primary-day (first-activity) span of the matched sessions — DESCRIPTIVE, not
   *  the filter — the window filters on last_activity_at. So a "last 7
   *  days" aggregate can honestly report a firstDay before the window: a session
   *  that started earlier but was last active in-window. Null when scope is empty. */
  firstDay: string | null;
  lastDay: string | null;
  /** Per-bucket subtotals, present only when groupBy is set. key = the bucket:
   *  userExternalId (user) | repo slug or "(unattributed)" (repo) | cwd or
   *  "(none)" (cwd). Ordered busiest-first. */
  groups?: AggregateGroup[];
}

export interface AggregateGroup {
  key: string;
  totalSessions: number;
  activeMs: number;
  userMsgs: number;
  assistantMsgs: number;
  filesTouched: number;
  linesAdded: number;
  linesRemoved: number;
  estCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Coerce a Postgres aggregate scalar (number | bigint | numeric-as-string) to a
 *  finite number; non-finite ⇒ 0. */
function num(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export async function hxSessionsAggregate(db: HxDb, input: AggregateInput): Promise<AggregateResult> {
  const conditions: SQL[] = [scopePredicate(input.scope), isNull(hxSessions.deletedAt)];
  if (input.family) conditions.push(eq(hxSessions.family, input.family));
  // Window on last activity (`last_activity_at`), NOT the facts row's
  // primary_day (first-activity day) — a long-running or multi-day session that
  // was active in-window must be counted, matching hx_sessions_list + the widgets.
  // hx.sessions is innerJoin'd below, so lastActivityAt is in scope. Timezone- and
  // datetime-aware bounds via the shared helper (day-inclusive upper bound).
  conditions.push(
    ...dateWindowConditions(hxSessions.lastActivityAt, input.fromDate, input.toDate, input.timezone),
  );
  if (input.cwdContains) conditions.push(ilike(hxSessions.cwd, `%${input.cwdContains}%`));
  const where = and(...conditions);

  // Scalar sums in SQL (one row even when nothing matches — count 0, sums coalesced).
  const [agg] = await db
    .select({
      totalSessions: sql<number>`count(*)::int`,
      activeMs: sql<string>`coalesce(sum(${hxSessionFacts.activeMs}), 0)::bigint`,
      userMsgs: sql<number>`coalesce(sum(${hxSessionFacts.userMsgs}), 0)::int`,
      assistantMsgs: sql<number>`coalesce(sum(${hxSessionFacts.assistantMsgs}), 0)::int`,
      filesTouched: sql<number>`coalesce(sum(${hxSessionFacts.filesTouched}), 0)::int`,
      linesAdded: sql<number>`coalesce(sum(${hxSessionFacts.linesAdded}), 0)::int`,
      linesRemoved: sql<number>`coalesce(sum(${hxSessionFacts.linesRemoved}), 0)::int`,
      estCostUsd: sql<number>`coalesce(sum(${hxSessions.estCostUsd}), 0)::double precision`,
      inputTokens: sql<string>`coalesce(sum(${hxSessions.inputTokens}), 0)::bigint`,
      outputTokens: sql<string>`coalesce(sum(${hxSessions.outputTokens}), 0)::bigint`,
      cacheReadTokens: sql<string>`coalesce(sum(${hxSessions.cacheReadTokens}), 0)::bigint`,
      cacheCreationTokens: sql<string>`coalesce(sum(${hxSessions.cacheCreationTokens}), 0)::bigint`,
      firstDay: sql<string | null>`to_char(min(${hxSessionFacts.primaryDay}), 'YYYY-MM-DD')`,
      lastDay: sql<string | null>`to_char(max(${hxSessionFacts.primaryDay}), 'YYYY-MM-DD')`,
    })
    .from(hxSessionFacts)
    .innerJoin(hxSessions, eq(hxSessions.id, hxSessionFacts.sessionId))
    .where(where);

  // tool_calls_by_type is a jsonb map per session — merge the maps over the SAME
  // scope (facts rows are per-session, far below a turn scan, per §10).
  const typeRows = await db
    .select({ toolCallsByType: hxSessionFacts.toolCallsByType })
    .from(hxSessionFacts)
    .innerJoin(hxSessions, eq(hxSessions.id, hxSessionFacts.sessionId))
    .where(where);

  const toolCallsByType: Record<string, number> = {};
  for (const r of typeRows) {
    for (const [name, count] of Object.entries(r.toolCallsByType ?? {})) {
      toolCallsByType[name] = (toolCallsByType[name] ?? 0) + num(count);
    }
  }

  // Per-bucket subtotals (team/org boards: "how is work spread", "is anyone
  // working too much", "which repo/directory gets the deepest effort"). Same
  // scope + filters; GROUP BY the requested dimension. Ordered busiest-first.
  // The key expression + joins depend on the dimension; hxUsers/hxRepos are
  // 1:(0..1) FK joins off the session, so they never multiply the fact rows.
  // For repo/cwd a null value coalesces to a labeled bucket (never dropped), so
  // the caller sees the HONEST distribution — including "sessions aren't tagged".
  let groups: AggregateGroup[] | undefined;
  if (input.groupBy) {
    const keyExpr =
      input.groupBy === "user"
        ? sql<string>`${hxUsers.externalId}`
        : input.groupBy === "repo"
          ? sql<string>`coalesce(${hxRepos.slug}, '(unattributed)')`
          : sql<string>`coalesce(${hxSessions.cwd}, '(none)')`;
    const grpRows = await db
      .select({
        key: keyExpr,
        totalSessions: sql<number>`count(*)::int`,
        activeMs: sql<string>`coalesce(sum(${hxSessionFacts.activeMs}), 0)::bigint`,
        userMsgs: sql<number>`coalesce(sum(${hxSessionFacts.userMsgs}), 0)::int`,
        assistantMsgs: sql<number>`coalesce(sum(${hxSessionFacts.assistantMsgs}), 0)::int`,
        filesTouched: sql<number>`coalesce(sum(${hxSessionFacts.filesTouched}), 0)::int`,
        linesAdded: sql<number>`coalesce(sum(${hxSessionFacts.linesAdded}), 0)::int`,
        linesRemoved: sql<number>`coalesce(sum(${hxSessionFacts.linesRemoved}), 0)::int`,
        estCostUsd: sql<number>`coalesce(sum(${hxSessions.estCostUsd}), 0)::double precision`,
        inputTokens: sql<string>`coalesce(sum(${hxSessions.inputTokens}), 0)::bigint`,
        outputTokens: sql<string>`coalesce(sum(${hxSessions.outputTokens}), 0)::bigint`,
        cacheReadTokens: sql<string>`coalesce(sum(${hxSessions.cacheReadTokens}), 0)::bigint`,
        cacheCreationTokens: sql<string>`coalesce(sum(${hxSessions.cacheCreationTokens}), 0)::bigint`,
      })
      .from(hxSessionFacts)
      .innerJoin(hxSessions, eq(hxSessions.id, hxSessionFacts.sessionId))
      .leftJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .leftJoin(hxRepos, eq(hxRepos.id, hxSessions.repoId))
      .where(where)
      .groupBy(keyExpr)
      .orderBy(sql`count(*) DESC`);
    groups = grpRows.map((g) => ({
      key: g.key,
      totalSessions: num(g.totalSessions),
      activeMs: num(g.activeMs),
      userMsgs: num(g.userMsgs),
      assistantMsgs: num(g.assistantMsgs),
      filesTouched: num(g.filesTouched),
      linesAdded: num(g.linesAdded),
      linesRemoved: num(g.linesRemoved),
      estCostUsd: num(g.estCostUsd),
      inputTokens: num(g.inputTokens),
      outputTokens: num(g.outputTokens),
      cacheReadTokens: num(g.cacheReadTokens),
      cacheCreationTokens: num(g.cacheCreationTokens),
    }));
  }

  return {
    totalSessions: num(agg?.totalSessions),
    activeMs: num(agg?.activeMs),
    userMsgs: num(agg?.userMsgs),
    assistantMsgs: num(agg?.assistantMsgs),
    filesTouched: num(agg?.filesTouched),
    linesAdded: num(agg?.linesAdded),
    linesRemoved: num(agg?.linesRemoved),
    estCostUsd: num(agg?.estCostUsd),
    inputTokens: num(agg?.inputTokens),
    outputTokens: num(agg?.outputTokens),
    cacheReadTokens: num(agg?.cacheReadTokens),
    cacheCreationTokens: num(agg?.cacheCreationTokens),
    toolCallsByType,
    firstDay: agg?.firstDay ?? null,
    lastDay: agg?.lastDay ?? null,
    ...(groups ? { groups } : {}),
  };
}
