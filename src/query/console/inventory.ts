// People, devices, growth and the database's own facts.
//
// Every figure here is a count over metadata. There is no query in this file
// that opens a transcript, and none that could: hx.turns and hx.tool_calls are
// denied to the console at the privilege layer, so a statement naming them would
// fail against a real cluster rather than quietly succeed against a mock.
//
// The embedding facts read coverage — how many owners are embedded, under which
// model — and never the vector. The column grant withholds it; this file does
// not ask for it either, so the boundary holds in both places.

import { sql, type SQL } from "drizzle-orm";

import { consoleUniversePredicate, type ConsoleUniverse } from "./universe";

export interface ConsolePersonRow {
  userExternalId: string;
  displayName: string | null;
  sessions: number;
  bytes: number;
  devices: number;
  lastActivityAt: string | null;
  lastUploadAt: string | null;
}

/** One row per person with something on this host. Somebody the roster knows
 *  but who has never uploaded is absent here and present in the roster — the
 *  funnel's job is to show that difference, not to hide it. */
export function consolePeopleQuery(universe: ConsoleUniverse): SQL {
  return sql`SELECT
      u.external_id AS "userExternalId",
      u.display_name AS "displayName",
      count(s.id)::int AS "sessions",
      coalesce(sum(s.bytes_uploaded), 0)::bigint AS "bytes",
      (SELECT count(*)::int FROM hx.devices dv WHERE dv.user_id = u.id AND dv.deleted_at IS NULL) AS "devices",
      max(s.last_activity_at) AS "lastActivityAt",
      (SELECT max(dv.last_upload_at) FROM hx.devices dv WHERE dv.user_id = u.id AND dv.deleted_at IS NULL) AS "lastUploadAt"
    FROM hx.users u
    JOIN hx.sessions s ON s.user_id = u.id AND ${consoleUniversePredicate(universe)}
    WHERE u.deleted_at IS NULL
    GROUP BY u.id, u.external_id, u.display_name
    ORDER BY count(s.id) DESC, u.external_id ASC`;
}

export interface ConsoleDeviceRow {
  userExternalId: string;
  deviceId: string;
  name: string | null;
  os: string | null;
  arch: string | null;
  lastSeenAt: string | null;
  lastUploadAt: string | null;
  syncTotal: number | null;
  syncDone: number | null;
  syncReportedAt: string | null;
}

/** Devices as the fortress observed them. Nulls stay null: a machine that has
 *  never reported is a different fact from one that reported zero, and rendering
 *  both as 0 would put an install that is silently broken next to one that is
 *  merely idle.
 *
 *  hx.devices and hx.users carry no org_id, so residency has to be reached
 *  THROUGH the sessions: a person is in this console's universe when they have a
 *  session in it, which is the same rule the people panel applies by joining.
 *  Without the term, a host that ever served a second organization hands every
 *  signed-in local user — readonly included — that organization's external ids,
 *  machine names, operating systems and upload times. */
export function consoleDevicesQuery(universe: ConsoleUniverse): SQL {
  return sql`SELECT
      u.external_id AS "userExternalId",
      d.device_id AS "deviceId",
      d.name AS "name",
      d.os AS "os",
      d.arch AS "arch",
      d.last_seen_at AS "lastSeenAt",
      d.last_upload_at AS "lastUploadAt",
      d.sync_total AS "syncTotal",
      d.sync_done AS "syncDone",
      d.sync_reported_at AS "syncReportedAt"
    FROM hx.devices d
    JOIN hx.users u ON u.id = d.user_id
    WHERE d.deleted_at IS NULL AND u.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM hx.sessions s WHERE s.user_id = u.id AND ${consoleUniversePredicate(universe)})
    ORDER BY u.external_id ASC, d.device_id ASC`;
}

export interface ConsoleGrowthRow {
  day: string;
  sessions: number;
  bytes: number;
}

/** Sessions and bytes per day, bucketed on last activity in UTC. Bounded by the
 *  caller's window rather than open-ended: an unbounded group-by over a large
 *  index is the kind of query a poll turns into a load problem. */
export function consoleGrowthQuery(universe: ConsoleUniverse, days: number): SQL {
  const window = Math.min(Math.max(1, Math.trunc(days)), 400);
  return sql`SELECT
      to_char(date_trunc('day', s.last_activity_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "day",
      count(*)::int AS "sessions",
      coalesce(sum(s.bytes_uploaded), 0)::bigint AS "bytes"
    FROM hx.sessions s
    WHERE ${consoleUniversePredicate(universe)}
      AND s.last_activity_at IS NOT NULL
      AND s.last_activity_at >= now() - ${`${window} days`}::interval
    GROUP BY 1
    ORDER BY 1 ASC`;
}

export interface ConsoleEmbeddingFacts {
  embedded: number;
  models: number;
  newestAt: string | null;
}

export function consoleEmbeddingFactsQuery(): SQL {
  return sql`SELECT
      count(*)::int AS "embedded",
      count(DISTINCT e.model)::int AS "models",
      max(e.created_at) AS "newestAt"
    FROM hx.embeddings e
    WHERE e.deleted_at IS NULL`;
}

export interface ConsolePostgresFacts {
  databaseBytes: number;
  sessions: number;
  people: number;
  tombstones: number;
}

/** What the Postgres panel states. `pg_database_size` needs only CONNECT, which
 *  the console role has by definition — it is connected. */
export function consolePostgresFactsQuery(universe: ConsoleUniverse): SQL {
  return sql`SELECT
      pg_catalog.pg_database_size(pg_catalog.current_database())::bigint AS "databaseBytes",
      (SELECT count(*)::int FROM hx.sessions s WHERE ${consoleUniversePredicate(universe)}) AS "sessions",
      (SELECT count(*)::int FROM hx.users u WHERE u.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM hx.sessions s WHERE s.user_id = u.id AND ${consoleUniversePredicate(universe)}))
        AS "people",
      (SELECT count(*)::int FROM hx.deleted_sessions) AS "tombstones"`;
}
