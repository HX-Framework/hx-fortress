// The storage-migration record, as the console renders it.
//
// A run names two buckets and counts objects. It never names a key, and it never
// holds a credential: the material that binds this fortress to either bucket
// lives in a 0600 single-use file the command row only references, which is what
// makes this table renderable at all.
//
// The console reads; the daemon writes. There is no console path to these rows
// other than the one below.

import { sql, type SQL } from "drizzle-orm";

export interface MigrationRunView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  mode: string;
  /** running | done | aborted | switched_unverified | failed. A switch that did
   *  not verify is its own word: `aborted` would say nothing was switched, on a
   *  row that carries switched_at. */
  status: string;
  phase: string;
  sourceBucket: string;
  targetBucket: string;
  sessionsTotal: number;
  sessionsCopied: number;
  bytesCopied: number;
  deltaPasses: number;
  switchedAt: string | null;
  error: string | null;
}

export function migrationRunsQuery(limit = 20): SQL {
  const n = Math.min(Math.max(1, Math.trunc(limit)), 100);
  return sql`SELECT
      r.id                AS "id",
      r.started_at        AS "startedAt",
      r.finished_at       AS "finishedAt",
      r.mode              AS "mode",
      r.status            AS "status",
      r.phase             AS "phase",
      r.source_bucket     AS "sourceBucket",
      r.target_bucket     AS "targetBucket",
      r.sessions_total    AS "sessionsTotal",
      r.sessions_copied   AS "sessionsCopied",
      r.bytes_copied      AS "bytesCopied",
      r.delta_passes      AS "deltaPasses",
      r.switched_at       AS "switchedAt",
      r.error             AS "error"
    FROM hx.migration_runs r
    ORDER BY r.started_at DESC
    LIMIT ${n}`;
}
