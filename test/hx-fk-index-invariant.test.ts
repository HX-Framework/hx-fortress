import { beforeAll, describe, expect, test } from "bun:test";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { sql as dsql } from "drizzle-orm";

// An unindexed foreign key is a latent outage, not a style question. Postgres
// enforces a cascade (and a restrict/no-action check) by looking up referencing
// rows ONCE PER AFFECTED PARENT ROW; with no covering index each lookup is a
// sequential scan of the whole child table.
//
// On prod that arithmetic was: hx.tool_calls.turn_id had no index, so a
// guarantor rebuild deleting ~2,000 turns from hx.turns ran ~2,000 sequential
// scans of a 546 MB table. Every rebuild ran until the 120 s statement_timeout
// killed it, holding a background connection the whole time, which starved the
// 2-connection pool and failed ~80% of all repair work.
//
// EXPLAIN cannot warn you: cascade work is trigger work, so the delete's own
// plan looks like a cheap Index Scan. Only the catalog shows it. Hence this
// test — it is the only thing standing between the next FK and a repeat.
const DSN = process.env.FORTRESS_DATABASE_URL;

describe.skipIf(!DSN)("hx schema — every foreign key is index-covered", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  test("no foreign key in schema hx lacks a covering index", async () => {
    // A covering index is one whose LEADING columns are exactly the FK columns.
    // Trailing columns are fine (a composite index serves its prefix), which is
    // why hx.turns(session_id, agent_id, seq) covers an FK on session_id but NOT
    // one on agent_id.
    const rows = (await db.execute(dsql`
      select
        n.nspname || '.' || child.relname as child_table,
        c.conname as constraint_name,
        (select string_agg(a.attname, ',' order by k.ord)
           from unnest(c.conkey) with ordinality k(att, ord)
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as fk_columns,
        pg_relation_size(c.conrelid) as child_bytes
      from pg_constraint c
      join pg_class child on child.oid = c.conrelid
      join pg_namespace n on n.oid = child.relnamespace
      where c.contype = 'f'
        and n.nspname = 'hx'
        and not exists (
          select 1 from pg_index i
          where i.indrelid = c.conrelid
            and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] = c.conkey
            -- A PARTIAL index cannot serve an FK check: the referential
            -- integrity lookup has no idea about the predicate, so rows outside
            -- it are invisible and Postgres falls back to a scan.
            and i.indpred is null
            -- An index left behind by a failed CREATE INDEX CONCURRENTLY is
            -- present under its name but IGNORED by the planner. Counting it as
            -- cover is how a "fixed" cascade silently stays broken — and this
            -- repo builds these indexes CONCURRENTLY out-of-band on prod, so it
            -- is a live possibility, not a hypothetical.
            and i.indisvalid
            and i.indisready
        )
      order by pg_relation_size(c.conrelid) desc
    `)) as unknown as Array<Record<string, unknown>>;

    const uncovered = (Array.isArray(rows) ? rows : []).map(
      (r) => `${String(r.child_table)}(${String(r.fk_columns)}) [${String(r.constraint_name)}]`,
    );

    expect(uncovered).toEqual([]);
  });
});
