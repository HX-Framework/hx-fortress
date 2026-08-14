// The roster as this fortress keeps it: what one sync does to the table, and
// what ages out of it afterwards.
//
// THE REPLACE IS ONE TRANSACTION. A reader mid-sync sees the roster it had or
// the roster it is getting, never a half of each — the adoption funnel divides
// by the member count, and a denominator observed between two statements is a
// coverage figure nobody can reproduce.
//
// A DEPARTURE IS AN ABSENCE. The wire carries active members only, so this is
// where "not in the payload" becomes `active = false` with the date it was first
// noticed. The row stays: the sessions this host holds for that person did not
// leave with them, and the retention sweep — not the sync — is what eventually
// removes it.

import { sql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import type { RosterMember, RosterSyncPayload } from "../protocol";

/** How long a departed member's row is kept before the sweep removes it.
 *  Operator-tunable as `roster.inactivePurgeDays`; the workbench disclosure
 *  quotes this same default to the members it describes. */
export const DEFAULT_ROSTER_INACTIVE_PURGE_DAYS = 90;

export interface RosterSyncState {
  /** The hub's own clock for the roster it computed. */
  asOf: string;
  /** When this host received it. Different from asOf, and both are rendered. */
  receivedAt: string;
  members: number;
}

export interface RosterApplyResult {
  received: number;
  deactivated: number;
  /** True when the snapshot was older than the one already applied and nothing
   *  was written. The caller reports it; it is not an error. */
  stale?: boolean;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

/** A member as the wire delivers it, with every timestamp normalized. The hub
 *  sends ISO strings; a hub that sends something else must not become a NULL
 *  that reads as "never uploaded". */
function normalize(member: RosterMember): RosterMember {
  return {
    ...member,
    devices: {
      installed: Number.isFinite(member.devices.installed) ? Math.trunc(member.devices.installed) : 0,
      lastSeenAt: iso(member.devices.lastSeenAt),
      lastUploadAt: iso(member.devices.lastUploadAt),
      syncTotal: member.devices.syncTotal ?? null,
      syncDone: member.devices.syncDone ?? null,
      syncReportedAt: iso(member.devices.syncReportedAt),
    },
  };
}

/**
 * Apply one rosterSync.
 *
 * Idempotent: the same payload applied twice leaves the same table, so a
 * reconnect that re-delivers a sync costs nothing.
 */
export async function replaceRoster(
  db: HxDb,
  payload: RosterSyncPayload,
): Promise<RosterApplyResult> {
  const members = (payload.members ?? []).filter((m) => typeof m.externalId === "string" && m.externalId.length > 0);
  const asOf = iso(payload.asOf) ?? new Date().toISOString();
  const ids = members.map((m) => m.externalId);

  return await db.transaction(async (tx) => {
    // `asOf` is the protocol's ordering handle, and this is the receiver the rule
    // is written for: a snapshot not strictly newer than the one already applied
    // is dropped whole. Pushes are fire-and-forget and each one awaits an async
    // build before it is sent, so two of them can reach the wire in the opposite
    // order to which they were computed. Applying the older one would resurrect
    // a departed member as active with a cleared purge clock — a full-replacement
    // payload has no way to express "this is out of date" except by not landing.
    const priorRows = rows<{ asOf: unknown }>(
      // FOR UPDATE: the gate and the write have to be one critical section. Two
      // pushes racing both read the old marker, both pass, and the OLDER
      // payload's member rows commit last — resurrecting a departed member as
      // active with a cleared purge clock, while the marker upsert (correctly
      // guarded) keeps the NEWER as_of, so the console reports the roster as
      // current. The hub produces exactly that: eleven call sites nudge with no
      // debounce, and this receiver dispatches frames concurrently.
      await tx.execute(sql`SELECT as_of AS "asOf" FROM hx.roster_sync WHERE singleton FOR UPDATE`),
    );
    const prior = iso(priorRows[0]?.asOf);
    if (prior !== null && asOf <= prior) {
      return { received: 0, deactivated: 0, stale: true };
    }

    for (const raw of members) {
      const member = normalize(raw);
      await tx.execute(
        sql`INSERT INTO hx.roster (
              external_id, display_name, email, teams, installed,
              last_seen_at, last_upload_at, sync_total, sync_done, sync_reported_at,
              active, synced_at, inactive_since)
            VALUES (
              ${member.externalId}, ${member.displayName}, ${member.email ?? null},
              ${JSON.stringify(member.teams ?? [])}::jsonb, ${member.devices.installed},
              ${member.devices.lastSeenAt}, ${member.devices.lastUploadAt},
              ${member.devices.syncTotal}, ${member.devices.syncDone}, ${member.devices.syncReportedAt},
              true, now(), NULL)
            ON CONFLICT (external_id) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              email = EXCLUDED.email,
              teams = EXCLUDED.teams,
              installed = EXCLUDED.installed,
              last_seen_at = EXCLUDED.last_seen_at,
              last_upload_at = EXCLUDED.last_upload_at,
              sync_total = EXCLUDED.sync_total,
              sync_done = EXCLUDED.sync_done,
              sync_reported_at = EXCLUDED.sync_reported_at,
              -- A returning member is active again, and the clock that would
              -- have purged them is cleared rather than left ticking.
              active = true,
              inactive_since = NULL,
              synced_at = now()`,
      );
    }
    // Everyone still active here who was not in this payload has left. The
    // `inactive_since` stamp is taken ONCE — re-stamping it on every sync would
    // keep a departed member permanently one day away from purging.
    const stillHere =
      ids.length > 0
        ? sql` AND external_id NOT IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
        : sql``;
    const deactivated = await tx.execute(
      sql`UPDATE hx.roster
             SET active = false,
                 inactive_since = coalesce(inactive_since, now())
           WHERE active${stillHere}`,
    );
    await tx.execute(
      sql`INSERT INTO hx.roster_sync (singleton, as_of, received_at, members)
          VALUES (true, ${asOf}, now(), ${members.length})
          ON CONFLICT (singleton) DO UPDATE SET
            as_of = EXCLUDED.as_of,
            received_at = EXCLUDED.received_at,
            members = EXCLUDED.members
          WHERE EXCLUDED.as_of > hx.roster_sync.as_of`,
    );
    return {
      received: members.length,
      deactivated: affected(deactivated),
    };
  });
}

/** Rows Postgres reports as changed, across the shapes the driver returns. */
function affected(result: unknown): number {
  if (typeof result === "number") return result;
  const value = result as { count?: unknown; rowCount?: unknown; affectedRows?: unknown } | null;
  for (const key of ["count", "rowCount", "affectedRows"] as const) {
    const n = value?.[key];
    if (typeof n === "number") return n;
  }
  return 0;
}

/** Null when no sync has EVER landed — which is not the same as a sync that
 *  reported nobody, and the console renders the two differently. */
export async function readRosterSyncState(db: HxDb): Promise<RosterSyncState | null> {
  const result = await db.execute(
    sql`SELECT as_of AS "asOf", received_at AS "receivedAt", members AS "members"
          FROM hx.roster_sync WHERE singleton`,
  );
  const row = rows<{ asOf: unknown; receivedAt: unknown; members: unknown }>(result)[0];
  if (!row) return null;
  return {
    asOf: iso(row.asOf) ?? "",
    receivedAt: iso(row.receivedAt) ?? "",
    members: Number(row.members ?? 0),
  };
}

/**
 * Remove departed members whose retention has run out.
 *
 * Only INACTIVE rows are ever eligible, and only by the date this host first
 * noticed the absence — never by anything the hub sends, which would let a
 * remote clock decide when local records disappear.
 */
export async function purgeInactiveRoster(
  db: HxDb,
  days: number = DEFAULT_ROSTER_INACTIVE_PURGE_DAYS,
): Promise<number> {
  const window = Math.max(0, Math.trunc(days));
  const result = await db.execute(
    sql`DELETE FROM hx.roster
         WHERE active = false
           AND inactive_since IS NOT NULL
           AND inactive_since < now() - ${`${window} days`}::interval`,
  );
  return affected(result);
}
