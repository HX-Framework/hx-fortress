// Collection telemetry the Fortress reports to the hub (MC-2368): counts of what it
// has collected, read from its own hx Postgres. Recency ("last ingest") is
// signalled separately over the tunnel via hxInvalidate; liveness via heartbeat.
//
// Raw SQL (not the drizzle query builder) keeps this self-contained. sessions is an
// exact count(*). turns and embeddings are the planner's row estimates
// (pg_class.reltuples): an exact count reads the whole table, the report runs about
// once a minute, and on a large fortress hx.turns is tens of GB. The estimate is one
// catalog row, kept current by autovacuum's ANALYZE. It includes soft-deleted rows
// (reltuples knows nothing of deleted_at) and reads 0 until the table's first
// ANALYZE (reltuples is -1 before it). The hub keeps these counts as a display
// snapshot only. embeddings is null-not-0 on a non-pgvector fortress (the table is
// absent), probed with to_regclass so the missing relation can't error.

import { sql } from "drizzle-orm";
import type { HxDb } from "../host/postgres/db";
import type { CollectionStats } from "../protocol";

function rowsOf(res: unknown): unknown[] {
  return Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? []);
}

function scalarInt(res: unknown): number {
  const r = rowsOf(res)[0] as { n?: number | string } | undefined;
  return Number(r?.n ?? 0);
}

export async function computeCollectionStats(db: HxDb): Promise<CollectionStats> {
  const sessions = scalarInt(
    await db.execute(sql`SELECT count(*)::bigint AS n FROM hx.sessions WHERE deleted_at IS NULL`),
  );
  const turns = scalarInt(
    await db.execute(
      sql`SELECT greatest(reltuples, 0)::bigint AS n FROM pg_class WHERE oid = 'hx.turns'::regclass`,
    ),
  );

  // to_regclass returns NULL (never errors) when hx.embeddings is absent, so the
  // probe is safe on a non-pgvector fortress; null then flows through as "no index".
  let embeddings: number | null = null;
  const reg = rowsOf(await db.execute(sql`SELECT to_regclass('hx.embeddings') AS rel`));
  const present = (reg[0] as { rel?: string | null } | undefined)?.rel != null;
  if (present) {
    embeddings = scalarInt(
      await db.execute(
        sql`SELECT greatest(reltuples, 0)::bigint AS n FROM pg_class WHERE oid = 'hx.embeddings'::regclass`,
      ),
    );
  }

  return { sessions, turns, embeddings };
}
