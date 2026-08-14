// Collection telemetry the Fortress reports to the hub (MC-2368): pure counts of
// what it has collected, read from its own hx Postgres. Recency ("last ingest") is
// signalled separately over the tunnel via hxInvalidate; liveness via heartbeat.
//
// Raw SQL (not the drizzle query builder) keeps this self-contained — just cheap
// count(*) scans. embeddings is null-not-0 on a non-pgvector fortress (the table is
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
    await db.execute(sql`SELECT count(*)::bigint AS n FROM hx.turns WHERE deleted_at IS NULL`),
  );

  // to_regclass returns NULL (never errors) when hx.embeddings is absent, so the
  // probe is safe on a non-pgvector fortress; null then flows through as "no index".
  let embeddings: number | null = null;
  const reg = rowsOf(await db.execute(sql`SELECT to_regclass('hx.embeddings') AS rel`));
  const present = (reg[0] as { rel?: string | null } | undefined)?.rel != null;
  if (present) {
    embeddings = scalarInt(
      await db.execute(sql`SELECT count(*)::bigint AS n FROM hx.embeddings WHERE deleted_at IS NULL`),
    );
  }

  return { sessions, turns, embeddings };
}
