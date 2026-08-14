import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { runMigrations } from "../../src/host/postgres/migrate";
import { migrations } from "../../src/host/postgres/migrations/manifest";
import { makeMigrationExec, startCluster, type Cluster } from "./_cluster";

// Gated like the other embedded-cluster e2e: opt in with FORTRESS_PG_E2E=1
// (first run downloads + extracts the zonky binaries).
const RUN = process.env.FORTRESS_PG_E2E === "1";

// NOTE: these tests share ONE booted cluster and run in source order. Earlier
// tests seed rows (user `u-sess`, session `s1`, a seq-0 turn) that later tests
// read and depend on — do not reorder them or insert a mutating test in the
// middle. Each behavioural feature still owns its assertion; only the fixture
// rows are shared.
describe.if(RUN)("hx schema migrations", () => {
  let cluster: Cluster;
  beforeAll(async () => {
    cluster = await startCluster();
    await runMigrations(makeMigrationExec(cluster.dsn), migrations);
  }, 180_000);
  afterAll(async () => {
    if (cluster) await cluster.stop();
  });

  test("0000 installs the core extensions", async () => {
    const db = makeMigrationExec(cluster.dsn);
    const rows = await db.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','pg_trgm','btree_gin')",
    );
    const names = rows.map((r) => r.extname).sort();
    expect(names).toEqual(["btree_gin", "pg_trgm", "pgcrypto"]);
  });

  test("migration run is idempotent", async () => {
    const applied = await runMigrations(makeMigrationExec(cluster.dsn), migrations);
    expect(applied).toEqual([]);
  });

  test("0001 creates all dimension tables in the hx schema", async () => {
    const db = makeMigrationExec(cluster.dsn);
    const rows = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'hx'",
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ["users", "orgs", "projects", "repos", "devices", "models"]) {
      expect(names).toContain(t);
    }
  });

  test("project FK rejects an org_id with no matching org", async () => {
    const db = makeMigrationExec(cluster.dsn);
    let threw = false;
    try {
      await db.exec(
        "INSERT INTO hx.projects (org_id, external_id) VALUES (gen_random_uuid(), 'p1')",
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("session natural key (user, family, session_id) is unique", async () => {
    const db = makeMigrationExec(cluster.dsn);
    await db.exec(
      "INSERT INTO hx.users (id, external_id) VALUES ('11111111-1111-7111-8111-111111111111','u-sess')",
    );
    await db.exec(
      "INSERT INTO hx.sessions (user_id, family, session_id) VALUES ('11111111-1111-7111-8111-111111111111','claude-cli','s1')",
    );
    let threw = false;
    try {
      await db.exec(
        "INSERT INTO hx.sessions (user_id, family, session_id) VALUES ('11111111-1111-7111-8111-111111111111','claude-cli','s1')",
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("session rollup counters default to 0", async () => {
    const db = makeMigrationExec(cluster.dsn);
    const rows = await db.query<{ event_count: number; bytes_uploaded: number }>(
      "SELECT event_count, bytes_uploaded FROM hx.sessions WHERE session_id = 's1'",
    );
    expect(rows[0].event_count).toBe(0);
    expect(Number(rows[0].bytes_uploaded)).toBe(0);
  });

  test("turn full-text and trigram search both work", async () => {
    const db = makeMigrationExec(cluster.dsn);
    await db.exec(
      "INSERT INTO hx.turns (session_id, seq, role, text) " +
        "SELECT id, 0, 'assistant', 'the quick brown fox' FROM hx.sessions WHERE session_id = 's1'",
    );
    const fts = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM hx.turns WHERE text_tsv @@ plainto_tsquery('english','quick fox')",
    );
    expect(fts[0].n).toBe(1);
    // Substring search — the case the gin_trgm_ops index on `text` accelerates.
    const sub = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM hx.turns WHERE text ILIKE '%brown%'",
    );
    expect(sub[0].n).toBe(1);
    // similarity() proves pg_trgm itself is wired (function is extension-provided).
    const sim = await db.query<{ ok: boolean }>(
      "SELECT similarity('the quick brown fox','quick brown fix') > 0.3 AS ok",
    );
    expect(sim[0].ok).toBe(true);
  });

  test("NULLS NOT DISTINCT blocks a duplicate parent-lane seq", async () => {
    const db = makeMigrationExec(cluster.dsn);
    let threw = false;
    try {
      await db.exec(
        "INSERT INTO hx.turns (session_id, seq, role, text) " +
          "SELECT id, 0, 'user', 'dup' FROM hx.sessions WHERE session_id = 's1'",
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("0004 creates all analysis-core tables", async () => {
    const db = makeMigrationExec(cluster.dsn);
    const rows = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'hx'",
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      "ingest_events",
      "analysis_definitions",
      "analysis_runs",
      "analysis_run_sessions",
      "analysis_facts",
      "usage_rollup",
    ]) {
      expect(names).toContain(t);
    }
  });

  test("run<->session junction enforces both FKs", async () => {
    const db = makeMigrationExec(cluster.dsn);
    let threw = false;
    try {
      await db.exec(
        "INSERT INTO hx.analysis_run_sessions (run_id, session_id) VALUES (gen_random_uuid(), gen_random_uuid())",
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("every expected hx table exists (full parity)", async () => {
    const db = makeMigrationExec(cluster.dsn);
    const rows = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'hx'",
    );
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of [
      "users", "orgs", "projects", "repos", "devices", "models",
      "sessions", "session_agents", "turns", "tool_calls",
      "ingest_events", "analysis_definitions", "analysis_runs",
      "analysis_run_sessions", "analysis_facts", "usage_rollup",
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });

  test("hx_readonly can SELECT but not INSERT", async () => {
    const db = makeMigrationExec(cluster.dsn);
    const granted = await db.query<{ has: boolean }>(
      "SELECT has_table_privilege('hx_readonly','hx.sessions','SELECT') AS has",
    );
    expect(granted[0].has).toBe(true);
    const denied = await db.query<{ has: boolean }>(
      "SELECT has_table_privilege('hx_readonly','hx.sessions','INSERT') AS has",
    );
    expect(denied[0].has).toBe(false);
  });

  test("curated views resolve and read from base tables", async () => {
    const db = makeMigrationExec(cluster.dsn);
    const overview = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM hx.v_session_overview WHERE session_id = 's1'",
    );
    expect(overview[0].n).toBe(1);
    const turns = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM hx.v_turn_search WHERE session_id IS NOT NULL",
    );
    expect(turns[0].n).toBeGreaterThanOrEqual(1);
  });

  test("gated embeddings migration is skipped on a bundle without pgvector", async () => {
    const db = makeMigrationExec(cluster.dsn);
    // The stock zonky bundle has no pgvector, so 0006 must be skipped (not
    // recorded) and the core schema must still be intact.
    const vec = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'vector'",
    );
    expect(vec[0].n).toBe(0);
    const tbl = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='hx' AND table_name='embeddings'",
    );
    expect(tbl[0].n).toBe(0);
    const recorded = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM hx.schema_migrations WHERE name='0006_embeddings'",
    );
    expect(recorded[0].n).toBe(0);
  });

  test("hx_app_rw can INSERT but cannot CREATE TABLE (DML, no DDL)", async () => {
    const rw = new Bun.SQL(cluster.rwDsn);
    try {
      await rw.unsafe(
        "INSERT INTO hx.users (id, external_id) VALUES ('22222222-2222-7222-8222-222222222222','u-rw')",
      );
      const rows = (await rw.unsafe(
        "SELECT count(*)::int AS n FROM hx.users WHERE external_id='u-rw'",
      )) as Array<{ n: number }>;
      expect(rows[0].n).toBe(1);
      // USAGE-only on schema hx → no CREATE, so DDL is denied.
      let threw = false;
      try {
        await rw.unsafe("CREATE TABLE hx.rw_should_not_exist (id int)");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      await rw.end();
    }
  });

  test("hx_app_ro can SELECT but cannot INSERT (read-only)", async () => {
    const ro = new Bun.SQL(cluster.roDsn);
    try {
      const rows = (await ro.unsafe(
        "SELECT count(*)::int AS n FROM hx.sessions",
      )) as Array<{ n: number }>;
      expect(rows[0].n).toBeGreaterThanOrEqual(0);
      let threw = false;
      try {
        await ro.unsafe("INSERT INTO hx.users (external_id) VALUES ('ro-should-fail')");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      await ro.end();
    }
  });
});
