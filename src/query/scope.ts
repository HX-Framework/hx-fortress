// A6 · scope enforcement — the fortress-side privacy boundary for every hx_*
// query tool.
//
// Workbench (the MCP client) resolves consent into a concrete scope and passes
// it as a tool argument; the fortress matches the ENUMERATED in-scope session
// identities on its LIVE `hx.sessions` row (plus `deleted_at IS NULL`) and
// evaluates NO org/repo/project/membership/shares predicate of its own (it
// holds no roster/shares/grants). It never re-derives attribution and never
// reads the denormalized `turns.user_id` (which would bypass attribution,
// shares, grants, and the parent's soft-delete) — keyword/read queries join
// turns -> sessions and apply the scope on the session row.
//
// Identity = the fortress natural key (userExternalId, family, sessionId):
// userExternalId resolves to hx.users.external_id, then (user, family,
// session_id) matches the hx.sessions UNIQUE natural key.
//
// FAIL-CLOSED: empty/absent identities ⇒ match-nothing (the authenticated MCP
// caller is the org's workbench, not an end user — there is no caller-own
// fallback). The owner gate is purely ADDITIVE AND-narrowing (active-member set
// so a departed owner drops); it is never a substitute for enumeration.

import { sql, type SQL } from "drizzle-orm";

import { hxSessions } from "../host/postgres/schema";
import type { HxDb } from "../host/postgres/db";

/** One enumerated in-scope session, by fortress natural key. */
export interface ScopeIdentity {
  userExternalId: string;
  family: string;
  sessionId: string;
}

/** The resolved consent scope passed on every hx_* MCP call (§13-C). */
export interface FortressScope {
  /** Enumerated in-scope session identities. Empty ⇒ match nothing. */
  identities: ScopeIdentity[];
  /** Additive AND-narrowing owner gate: a session is admitted only if its owner
   *  (userExternalId) is in this active-member set. Absent ⇒ no extra narrowing. */
  ownerGate?: { activeMemberExternalIds: string[] };
}

// M-9d · cap on the enumerated in-scope identities. Truncation only NARROWS the
// match set, so it is fail-closed-safe — an oversized scope is almost certainly
// abusive (or a bug) rather than a legitimate 10k-session consent.
const MAX_SCOPE_IDENTITIES = 10_000;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Coerce untrusted MCP JSON args into a typed scope. Anything malformed
 *  degrades to an empty identity set, so a bad payload fails closed rather than
 *  widening the result. */
export function parseScope(raw: unknown): FortressScope {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawIdentities = Array.isArray(obj.identities) ? obj.identities : [];
  const identities: ScopeIdentity[] = [];
  for (const it of rawIdentities) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const userExternalId = asString(r.userExternalId);
    const family = asString(r.family);
    const sessionId = asString(r.sessionId);
    if (userExternalId && family && sessionId) {
      identities.push({ userExternalId, family, sessionId });
    }
  }
  if (identities.length > MAX_SCOPE_IDENTITIES) {
    console.warn(
      `parseScope: truncating ${identities.length} scope identities to ${MAX_SCOPE_IDENTITIES}`,
    );
    identities.length = MAX_SCOPE_IDENTITIES;
  }
  let ownerGate: FortressScope["ownerGate"];
  if (obj.ownerGate && typeof obj.ownerGate === "object") {
    const g = obj.ownerGate as Record<string, unknown>;
    const members = Array.isArray(g.activeMemberExternalIds)
      ? g.activeMemberExternalIds.filter((m): m is string => typeof m === "string")
      : [];
    // M-9d · cap the owner-gate member list symmetric with MAX_SCOPE_IDENTITIES.
    // The gate is AND-narrowing (a session is admitted only if its owner is in the
    // set), so truncating it only NARROWS the match set — fail-closed-safe, and an
    // oversized gate is abusive rather than a legitimate 10k-owner consent.
    if (members.length > MAX_SCOPE_IDENTITIES) {
      console.warn(
        `parseScope: truncating ${members.length} owner-gate members to ${MAX_SCOPE_IDENTITIES}`,
      );
      members.length = MAX_SCOPE_IDENTITIES;
    }
    ownerGate = { activeMemberExternalIds: members };
  }
  return ownerGate ? { identities, ownerGate } : { identities };
}

/** A SQL predicate selecting the live `hx.sessions` rows admitted by the scope.
 *  AND this into any query whose FROM/JOIN includes `hx.sessions`. Fail-closed:
 *  an empty identity set yields `false` (match nothing).
 *
 *  Carries the identities as a self-contained VALUES join (never a single
 *  `IN (…)` — Postgres' ~65 535-parameter ceiling), matching §13-C. */
export function scopePredicate(scope: FortressScope): SQL {
  const sub = scopeIdsSubquery(scope);
  return sub ? sql`${hxSessions.id} IN (${sub})` : sql`false`;
}

/** The scope's admitted hx.sessions ROW IDS as a subquery — the single source
 *  both scopePredicate (inline) and resolveScopeSessionIds (two-step) run, so
 *  the two shapes can never admit different rows. */
function scopeIdsSubquery(scope: FortressScope): SQL | null {
  const identities = Array.isArray(scope?.identities) ? scope.identities : [];
  if (identities.length === 0) return null;

  const tuples = identities.map(
    (i) => sql`(${i.userExternalId}::text, ${i.family}::text, ${i.sessionId}::text)`,
  );
  const values = sql.join(tuples, sql`, `);

  // Owner gate: admit an identity only if its owner is an active member. An
  // empty active-member set admits nothing (a gate with no members).
  let gate: SQL = sql``;
  if (scope.ownerGate) {
    const members = Array.isArray(scope.ownerGate.activeMemberExternalIds)
      ? scope.ownerGate.activeMemberExternalIds
      : [];
    gate =
      members.length === 0
        ? sql` AND false`
        : sql` AND scope_ids.user_external_id IN (${sql.join(
            members.map((m) => sql`${m}`),
            sql`, `,
          )})`;
  }

  return sql`SELECT s2.id FROM hx.sessions s2
    JOIN hx.users u2 ON u2.id = s2.user_id
    JOIN (VALUES ${values}) AS scope_ids(user_external_id, family, session_id)
      ON u2.external_id = scope_ids.user_external_id
     AND s2.family = scope_ids.family
     AND s2.session_id = scope_ids.session_id
    WHERE s2.deleted_at IS NULL${gate}`;
}

/** Resolve the scope to its admitted session row ids — ONCE, cheaply, on the
 *  scope-side indexes — so downstream queries can filter `session_id IN (ids)`
 *  instead of inlining the VALUES join.
 *
 *  WHY (LETAIR-175, measured on production): at large scopes (~1,600 live
 *  sessions ⇒ ~10k bind params) the inline VALUES join flips the planner off
 *  the turns GIN indexes into a per-session filter scan of EVERY in-scope turn
 *  — 246,639 buffers / 2,439 ms warm for a query that runs in 29 ms with a
 *  pre-resolved id set (84×). Cold cache puts the flipped shape in the 5-30 s
 *  class, and those are the queries that exhausted the RO pool. This resolver
 *  measured 5.2 ms for that same scope.
 *
 *  Access-control parity is BY CONSTRUCTION: this executes the identical
 *  subquery scopePredicate inlines (scopeIdsSubquery), owner gate included. */
export async function resolveScopeSessionIds(db: HxDb, scope: FortressScope): Promise<string[]> {
  const sub = scopeIdsSubquery(scope);
  if (!sub) return [];
  const rows = (await db.execute(sub)) as unknown as Array<{ id: string }>;
  return (Array.isArray(rows) ? rows : []).map((r) => String(r.id));
}
