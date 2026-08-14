// One-off: fill hx.sessions.org_id where the fortress never learned an org but the
// cloud knows one.
//
// WHY THIS IS A SCRIPT AND NOT A MIGRATION. It reads public.hx_sessions, which
// exists only where the fortress shares a database with workbench. A self-hosted
// fortress has no such table, so a migration referencing it would fail on every
// boot and wedge the provider. The guard below refuses to run rather than assume.
//
// WHY IT IS NOT AN ingestCommit. There is no fortress RPC that sets org_id alone;
// the only supported write is a full commit, which would re-index and re-embed every
// affected session. A scoped UPDATE is the LESS destructive option here, unusually.
//
// THE THREE RULES, each measured against production:
//   1. Fill NULL only, never overwrite. 8 sessions hold an org that DIFFERS from the
//      cloud's, and 2 hold one the cloud does not have. A "sync from cloud" would
//      silently rewrite all 10 — attribution is not the cloud's to reassign here.
//   2. Skip an org with no hx.orgs row. org_id carries an FK; exactly 1 session
//      names an org (org-e6abc3ad-...) that has no row, and inventing one is worse
//      than leaving the session unattributed.
//   3. Idempotent. Re-running fills nothing, because the predicate is org_id IS NULL.
//
// This is a SNAPSHOT, not a cure. The cloud has three attribution paths that are
// PG-only by design and never forward to the fortress (manual assign/detach, the
// rules engine, and the retroactive reattribute sweep), so the divergence regrows
// until one of them propagates. Re-running is cheap; the propagation is the real fix.
//
// Usage:  FORTRESS_DATABASE_URL=... bun scripts/backfill-session-orgs.ts [--apply]

import { SQL } from "bun";

const dsn = process.env.FORTRESS_DATABASE_URL;
if (!dsn) {
  console.error("FORTRESS_DATABASE_URL is required");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const db = new SQL(dsn, { max: 2, idleTimeout: 300, connectionTimeout: 60 });

const [{ present }] = (await db.unsafe(`
  select count(*)::int as present
  from information_schema.tables
  where table_schema = 'public' and table_name = 'hx_sessions'
`)) as unknown as Array<{ present: number }>;
if (!Number(present)) {
  console.error(
    "public.hx_sessions is absent — this fortress does not share a database with " +
      "workbench, so there is no cloud attribution to read. Refusing.",
  );
  process.exit(2);
}

const CANDIDATES = `
  from hx.sessions f
  join public.hx_sessions c
    on c.session_id = f.session_id and c.family = f.family and c.deleted_at is null
  join hx.orgs o on o.external_id = c.org_id
  where f.deleted_at is null and f.org_id is null and c.org_id is not null
`;

const [before] = (await db.unsafe(`
  select
    (select count(*) from hx.sessions where deleted_at is null and org_id is null)::int as null_orgs,
    (select count(*) ${CANDIDATES})::int as fillable,
    (select count(distinct o.id) ${CANDIDATES})::int as distinct_orgs,
    (select count(*) from hx.sessions f
       join public.hx_sessions c on c.session_id=f.session_id and c.family=f.family
       left join hx.orgs o on o.external_id = c.org_id
     where f.deleted_at is null and f.org_id is null and c.org_id is not null
       and o.id is null)::int as skipped_no_org_row
`)) as unknown as Array<Record<string, number>>;
console.log("before:", before);

if (!apply) {
  console.log("dry run — pass --apply to write");
  await db.end();
  process.exit(0);
}

// One statement, one transaction. The correlated subquery re-resolves per row so a
// concurrent live commit that sets an org is not clobbered: the predicate still
// requires org_id IS NULL at write time.
const updated = await db.unsafe(`
  update hx.sessions f
  set org_id = o.id, updated_at = now()
  from public.hx_sessions c, hx.orgs o
  where c.session_id = f.session_id and c.family = f.family and c.deleted_at is null
    and o.external_id = c.org_id
    and f.deleted_at is null and f.org_id is null and c.org_id is not null
  returning f.id
`);
console.log("rows updated:", Array.isArray(updated) ? updated.length : 0);

const [after] = (await db.unsafe(`
  select (select count(*) from hx.sessions where deleted_at is null and org_id is null)::int as null_orgs,
         (select count(*) ${CANDIDATES})::int as still_fillable
`)) as unknown as Array<Record<string, number>>;
console.log("after:", after);
await db.end();
