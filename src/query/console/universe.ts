// Which sessions the console can see at all.
//
// The MCP tools narrow by FortressScope — an enumerated set of session
// identities the workbench resolved from consent. The console has no such input
// and must never acquire one: it is an appliance-administration surface for a
// named local user, not a delegate of anybody's consent, and reusing the scope
// machinery here would mean the console's answer depended on whatever the last
// caller happened to enumerate. So this module deliberately imports nothing from
// ../scope.
//
// What it narrows by instead is RESIDENCY. The universe is the sessions that
// live on this host for the organization this fortress is bound to, plus the
// unattributed ones (a session with no org is a local session, and hiding it
// would make the console's counts disagree with the bucket). Rows belonging to
// some OTHER organization — a fortress that served two orgs, or a bucket
// reconciled after a re-enrollment — are reduced to a labeled count and never to
// a row: their metadata is not this organization's to read, but their existence
// is a fact the operator needs, because they occupy the same bucket and the same
// database.
//
// FAIL-CLOSED, and asserted: there is no input that makes the predicate match
// everything. An unbound fortress narrows to the unattributed rows alone.

import { sql, type SQL } from "drizzle-orm";

export interface ConsoleUniverse {
  /** hx.orgs.external_id of the organization this fortress is enrolled to.
   *  Empty when the fortress is not enrolled — then only unattributed sessions
   *  are in the universe, which is exactly what such a host holds. */
  orgExternalId: string;
}

/** The org row, by external id. Its own subquery so the predicate needs no
 *  join and can be ANDed into any statement whose FROM includes hx.sessions. */
function ownOrgId(orgExternalId: string): SQL {
  return sql`(SELECT o.id FROM hx.orgs o WHERE o.external_id = ${orgExternalId} AND o.deleted_at IS NULL)`;
}

/**
 * The console's session universe, as a predicate over an aliased hx.sessions.
 *
 * Carries its OWN soft-delete term. The MCP scope predicate also filters
 * `deleted_at IS NULL`, and it would be tempting to rely on that — but nothing
 * here goes through it, and a console query that inherited the filter from a
 * module it does not call would lose it silently the day that module changed.
 */
export function consoleUniversePredicate(universe: ConsoleUniverse, alias = "s"): SQL {
  const table = sql.raw(alias);
  const live = sql`${table}.deleted_at IS NULL`;
  const org = universe.orgExternalId
    ? sql`(${table}.org_id IS NULL OR ${table}.org_id = ${ownOrgId(universe.orgExternalId)})`
    : sql`${table}.org_id IS NULL`;
  return sql`${live} AND ${org}`;
}

/** The complement: live rows attributed to some other organization. Counted,
 *  never listed. */
export function foreignOrgPredicate(universe: ConsoleUniverse, alias = "s"): SQL {
  const table = sql.raw(alias);
  const live = sql`${table}.deleted_at IS NULL`;
  return universe.orgExternalId
    ? sql`${live} AND ${table}.org_id IS NOT NULL AND ${table}.org_id <> ${ownOrgId(universe.orgExternalId)}`
    : sql`${live} AND ${table}.org_id IS NOT NULL`;
}

/** One number and its label. The console renders the pair verbatim: a count with
 *  no explanation reads as data loss, and a count with an invented explanation
 *  is worse. */
export interface ForeignOrgSummary {
  sessions: number;
  label: string;
}

export function foreignOrgCountQuery(universe: ConsoleUniverse): SQL {
  return sql`SELECT count(*)::int AS sessions FROM hx.sessions s WHERE ${foreignOrgPredicate(universe)}`;
}

export function foreignOrgLabel(count: number): string {
  if (count === 0) return "No sessions here belong to another organization.";
  return (
    `${count} session${count === 1 ? "" : "s"} on this host belong to another organization ` +
    `and are not shown. They are counted so the totals match the bucket; their metadata is not this ` +
    `organization's to read.`
  );
}

/**
 * The no-match-all assertion, callable from a test and from the boundary check.
 *
 * A predicate that reduced to `true` — through an empty org id, a stray `OR`, a
 * refactor that dropped a term — would turn the console into a cross-org reader
 * with no error anywhere. The shape is checked rather than the intent: the
 * rendered SQL must constrain org_id and must constrain deleted_at.
 */
export function universeConstrains(renderedSql: string): { org: boolean; softDelete: boolean } {
  const lowered = renderedSql.toLowerCase();
  return {
    org: lowered.includes("org_id"),
    softDelete: lowered.includes("deleted_at is null"),
  };
}
