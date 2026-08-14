// Reading and writing hx.ingest_control from the daemon.
//
// The daemon holds COLUMN-level INSERT/UPDATE here, excluding `row_written_at`
// — so it can arm, extend and clear a pause but cannot touch the column that
// bounds one. Every statement below names its columns explicitly for that
// reason: an unqualified INSERT would be refused, which is the point.

import { sql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import type { IngestControlRow } from "./ingest-control";

interface RawRow {
  id: string;
  paused_until: string | Date;
  resumed_at: string | Date | null;
  row_written_at: string | Date;
  reason: string | null;
}

function rows(result: unknown): RawRow[] {
  if (Array.isArray(result)) return result as RawRow[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as RawRow[]) : [];
}

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** The CURRENT pause episode — the newest row. Arming inserts a new row rather
 *  than updating in place, so "current" is the only one whose anchor is
 *  meaningful; older rows are the history of previous episodes. */
export async function readCurrentEpisode(db: HxDb): Promise<IngestControlRow | null> {
  const result = await db.execute(
    sql`SELECT id, paused_until, resumed_at, row_written_at, reason
          FROM hx.ingest_control
         ORDER BY row_written_at DESC, id DESC
         LIMIT 1`,
  );
  const row = rows(result)[0];
  if (!row) return null;
  return {
    id: String(row.id),
    pausedUntil: asDate(row.paused_until),
    resumedAt: row.resumed_at === null ? null : asDate(row.resumed_at),
    rowWrittenAt: asDate(row.row_written_at),
    reason: row.reason,
  };
}

/**
 * Arm (or EXTEND) a pause by inserting a NEW episode row.
 *
 * An extension is a new row, never a moved deadline: the clamp is anchored on
 * `row_written_at`, which only an INSERT can stamp, so extending in place would
 * ask the gate to hold past a bound it has already computed. Each extension
 * therefore costs a live daemon heartbeat, which is precisely the property a
 * Postgres-only adversary cannot forge.
 */
export async function armPause(
  db: HxDb,
  args: { until: Date; reason: string; armedBy: string },
): Promise<string> {
  const result = await db.execute(
    sql`INSERT INTO hx.ingest_control (paused_until, reason, armed_by)
        VALUES (${args.until.toISOString()}::timestamptz, ${args.reason}, ${args.armedBy})
        RETURNING id`,
  );
  // RETURNING rather than a follow-up read of "the newest row": the resume has
  // to name the episode this call created, and a second statement could name a
  // later one.
  const id = rows(result)[0]?.id;
  if (typeof id !== "string") throw new Error("the fortress database armed no pause episode");
  return id;
}

/** Clear the current episode. The caller also clears the daemon's anchor file,
 *  so the next episode anchors to itself. */
export async function resumeIngest(db: HxDb, episodeId: string): Promise<void> {
  await db.execute(
    sql`UPDATE hx.ingest_control SET resumed_at = now() WHERE id = ${episodeId}::uuid`,
  );
}
