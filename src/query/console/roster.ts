// The roster, joined to what this host actually holds.
//
// Every join here is LEFT from the roster: a member with nothing on this
// fortress is a row with zeros, not a missing row, because "rostered and silent"
// is the state the adoption page exists to make visible. The complement — a
// person sending here whom the roster does not know — has its own query and its
// own bucket on the page, and is never folded into the roster's counts.
//
// The session side is narrowed by the console universe, exactly like every other
// console query: a foreign organization's rows are not this organization's to
// read, and they must not inflate anybody's footprint here.

import { sql, type SQL } from "drizzle-orm";

import { consoleUniversePredicate, type ConsoleUniverse } from "./universe";

export interface RosterPersonRow {
  externalId: string;
  displayName: string;
  email: string | null;
  teams: string[];
  installed: number;
  lastSeenAt: string | null;
  lastUploadAt: string | null;
  syncTotal: number | null;
  syncDone: number | null;
  syncReportedAt: string | null;
  active: boolean;
  inactiveSince: string | null;
  /** From this host's own rows. */
  sessions: number;
  bytes: number;
  lastActivityAt: string | null;
}

/** The whole roster — active and departed — with each member's footprint here.
 *  Departed rows carry `active: false` and the date this host first noticed;
 *  the page counts them apart and the sweep eventually removes them. */
export function consoleRosterQuery(universe: ConsoleUniverse): SQL {
  return sql`SELECT
      r.external_id AS "externalId",
      r.display_name AS "displayName",
      r.email AS "email",
      r.teams AS "teams",
      r.installed AS "installed",
      r.last_seen_at AS "lastSeenAt",
      r.last_upload_at AS "lastUploadAt",
      r.sync_total AS "syncTotal",
      r.sync_done AS "syncDone",
      r.sync_reported_at AS "syncReportedAt",
      r.active AS "active",
      r.inactive_since AS "inactiveSince",
      coalesce(f.sessions, 0)::int AS "sessions",
      coalesce(f.bytes, 0)::bigint AS "bytes",
      f.last_activity_at AS "lastActivityAt"
    FROM hx.roster r
    LEFT JOIN LATERAL (
      SELECT count(s.id)::int AS sessions,
             coalesce(sum(s.bytes_uploaded), 0)::bigint AS bytes,
             max(s.last_activity_at) AS last_activity_at
        FROM hx.sessions s
        JOIN hx.users u ON u.id = s.user_id AND u.external_id = r.external_id
       WHERE ${consoleUniversePredicate(universe)}
    ) f ON true
    ORDER BY r.active DESC, coalesce(f.sessions, 0) DESC, r.external_id ASC`;
}

export interface UnrosteredPersonRow {
  userExternalId: string;
  displayName: string | null;
  sessions: number;
  bytes: number;
  lastActivityAt: string | null;
}

/** People sending to this fortress whom the roster does not name.
 *
 *  A separate bucket, never an adoption gap: they may be service accounts, a
 *  member added since the last sync, or somebody whose membership ended while
 *  their sessions stayed. Presenting them as un-adopted employees would be a
 *  guess about which. */
export function consoleUnrosteredQuery(universe: ConsoleUniverse): SQL {
  return sql`SELECT
      u.external_id AS "userExternalId",
      u.display_name AS "displayName",
      count(s.id)::int AS "sessions",
      coalesce(sum(s.bytes_uploaded), 0)::bigint AS "bytes",
      max(s.last_activity_at) AS "lastActivityAt"
    FROM hx.users u
    JOIN hx.sessions s ON s.user_id = u.id AND ${consoleUniversePredicate(universe)}
   WHERE u.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM hx.roster r WHERE r.external_id = u.external_id)
   GROUP BY u.id, u.external_id, u.display_name
   ORDER BY count(s.id) DESC, u.external_id ASC`;
}

export interface AdoptionCountsRow {
  rostered: number;
  installed: number;
  syncComplete: number;
  sending: number;
  active: number;
  formerMembers: number;
  unrostered: number;
}

/**
 * Every funnel number in one round trip.
 *
 * The denominator is ACTIVE members. `sending` and `active` are counted from
 * this host's session rows and nothing else; `installed` and `syncComplete` from
 * the device inventory the roster carried and nothing else. Mixing them would
 * produce a figure that agrees with neither source.
 */
export function consoleAdoptionCountsQuery(universe: ConsoleUniverse, activeDays: number): SQL {
  const window = Math.min(Math.max(1, Math.trunc(activeDays)), 400);
  const sends = sql`EXISTS (
      SELECT 1 FROM hx.sessions s
        JOIN hx.users u ON u.id = s.user_id AND u.external_id = r.external_id
       WHERE ${consoleUniversePredicate(universe)})`;
  const recent = sql`EXISTS (
      SELECT 1 FROM hx.sessions s
        JOIN hx.users u ON u.id = s.user_id AND u.external_id = r.external_id
       WHERE ${consoleUniversePredicate(universe)}
         AND s.last_activity_at >= now() - ${`${window} days`}::interval)`;
  return sql`SELECT
      (SELECT count(*)::int FROM hx.roster r WHERE r.active) AS "rostered",
      (SELECT count(*)::int FROM hx.roster r WHERE r.active AND r.installed > 0) AS "installed",
      -- A member who has never reported a backfill is NOT counted as complete:
      -- a null total is an unanswered question, not a finished one.
      (SELECT count(*)::int FROM hx.roster r
        WHERE r.active AND r.sync_total IS NOT NULL AND r.sync_done IS NOT NULL
          AND r.sync_done >= r.sync_total) AS "syncComplete",
      (SELECT count(*)::int FROM hx.roster r WHERE r.active AND ${sends}) AS "sending",
      (SELECT count(*)::int FROM hx.roster r WHERE r.active AND ${recent}) AS "active",
      (SELECT count(*)::int FROM hx.roster r WHERE NOT r.active) AS "formerMembers",
      (SELECT count(*)::int FROM hx.users u
        WHERE u.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM hx.roster r WHERE r.external_id = u.external_id)
          AND EXISTS (SELECT 1 FROM hx.sessions s
                       WHERE s.user_id = u.id AND ${consoleUniversePredicate(universe)})) AS "unrostered"`;
}
