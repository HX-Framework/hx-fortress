// The privilege-matrix and one-way-machine acceptances, against a LIVE cluster.
//
// EMBEDDED-MODE semantics: a superuser bootstrap DSN, migrations applied by it,
// then ensureAppRoles provisioning the least-privilege login roles and the
// command-plane apparatus — exactly the sequence buildPostgresProvider runs.
//
// These do not SKIP in CI. A matrix acceptance that silently skips is a matrix
// acceptance that never ran, so the CI marker turns an absent Postgres service
// into a failure rather than a green pass.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { auditConsolePlane, ensureAppRoles, type ClusterSql } from "../../src/host/postgres/cluster";
import {
  CONSOLE_ROUTINES,
  routineSignature,
} from "../../src/host/postgres/console-plane";
import {
  containmentProbeQuery,
  containmentState,
  privilegeMatrixProbeQuery,
  privilegeMatrixViolations,
  type ContainmentProbe,
} from "../../src/host/postgres/privilege-matrix";
import { makeMigrationExec } from "../../src/host/postgres/sql-exec";
import { migrations } from "../../src/host/postgres/migrations/manifest";
import { runMigrations } from "../../src/host/postgres/migrate";
import type { RoleSecrets } from "../../src/host/postgres/roles";
import { createHxDb } from "../../src/host/postgres/db";
import { createCommandGateway } from "../../src/console/command-gateway";
import { validateCommandParams } from "../../src/console/command-params";
import { PgDialect } from "drizzle-orm/pg-core";
import { auditLastRunQuery } from "../../src/query/console/audit";
import { runBootFence, REJECT_BOOT_FENCE } from "../../src/console/commands";
import { readCurrentEpisode } from "../../src/console/ingest-control-db";
import { effectivePause, PAUSE_CAP_MS } from "../../src/console/ingest-control";

const SUPER_DSN = process.env.FORTRESS_MATRIX_DATABASE_URL;
const REQUIRED = process.env.FORTRESS_PG_MATRIX_REQUIRED === "1";

const SECRETS: RoleSecrets = {
  super: "unused",
  appRo: "ro-secret-pw",
  appRw: "rw-secret-pw",
  ui: "ui-secret-pw",
};

describe.if(REQUIRED && !SUPER_DSN)("privilege matrix (CI marker set)", () => {
  test("requires a Postgres service — a skipped matrix acceptance never ran", () => {
    expect(SUPER_DSN).toBeDefined();
  });
});

function roleDsn(base: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
}

async function query<T = Record<string, unknown>>(dsn: string, statement: string): Promise<T[]> {
  const client = new Bun.SQL(dsn);
  try {
    return (await client.unsafe(statement)) as T[];
  } finally {
    await client.end();
  }
}

async function refused(dsn: string, statement: string): Promise<string | null> {
  try {
    await query(dsn, statement);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe.if(!!SUPER_DSN)("console plane against a live cluster", () => {
  const dsn = SUPER_DSN as string;
  const sql: ClusterSql = {
    run: async (_db, statement) => {
      await query(dsn, statement);
    },
    exists: async (_db, statement) => (await query(dsn, statement)).length > 0,
    query: async <T,>(_db: string, statement: string) => query<T>(dsn, statement) as Promise<T[]>,
    runMany: async (_db, statements) => {
      const client = new Bun.SQL(dsn);
      try {
        await client.unsafe(statements.map((s) => `${s};`).join("\n")).simple();
      } finally {
        await client.end();
      }
    },
  };
  let uiDsn = "";
  let rwDsn = "";
  let roDsn = "";

  async function boot(): Promise<void> {
    await runMigrations(makeMigrationExec(dsn), migrations);
    await ensureAppRoles(sql, SECRETS);
  }

  beforeAll(async () => {
    // A FRESH cluster: no app roles, no hx schema. This is the state the very
    // first boot of a new fortress starts from.
    await sql.run("", "DROP SCHEMA IF EXISTS hx CASCADE");
    for (const role of ["hx_app_ro", "hx_app_rw", "hx_ui", "hx_cmd_owner", "hx_readonly"]) {
      await sql.run("", `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    EXECUTE 'DROP OWNED BY ${role} CASCADE';
    EXECUTE 'DROP ROLE ${role}';
  END IF;
END $$`);
    }
    await boot();
    uiDsn = roleDsn(dsn, "hx_ui", SECRETS.ui);
    rwDsn = roleDsn(dsn, "hx_app_rw", SECRETS.appRw);
    roDsn = roleDsn(dsn, "hx_app_ro", SECRETS.appRo);
  }, 120_000);

  afterAll(async () => {
    await sql.run("", "DELETE FROM hx.console_commands").catch(() => {});
  });

  test("migration 0015 applied on a cluster that had no app roles", async () => {
    const rows = await sql.query<{ name: string }>(
      "",
      "SELECT name FROM hx.schema_migrations WHERE name = '0019_console_plane'",
    );
    expect(rows.length).toBe(1);
  });

  test("re-running every 0015+ file on an already-migrated cluster is a clean no-op", async () => {
    const exec = makeMigrationExec(dsn);
    for (const migration of migrations.filter((m) => Number(m.name.slice(0, 4)) >= 15)) {
      await exec.exec(migration.sql);
    }
  });

  test("FRESH cluster, FIRST boot: the daemon role claims AND completes a row", async () => {
    // Proves the ensureAppRoles-owned EXECUTE grant, not a migration's: on a
    // fresh cluster hx_app_rw does not exist while 0015 runs.
    const [minted] = await query<{ id: string }>(
      uiDsn,
      "INSERT INTO hx.console_commands (kind, params) VALUES ('self_test', '{}') RETURNING id",
    );
    const claimed = await query<{ claimed: boolean }>(
      rwDsn,
      `SELECT hx.claim_command('${minted.id}'::uuid, 'pid:1', false) AS claimed`,
    );
    expect(claimed[0].claimed).toBe(true);
    const done = await query<{ completed: boolean }>(
      rwDsn,
      `SELECT hx.complete_command('${minted.id}'::uuid, 'done', 'ok', NULL) AS completed`,
    );
    expect(done[0].completed).toBe(true);
  });

  describe("after a SECOND boot", () => {
    beforeAll(async () => {
      // Everything the matrix asserts has to survive the blanket GRANT that
      // every boot re-issues — the REVOKE-after-GRANT ordering.
      await boot();
    }, 60_000);

    test("the whole privilege matrix holds", async () => {
      const [row] = await sql.query<Record<string, unknown>>("", privilegeMatrixProbeQuery());
      expect(privilegeMatrixViolations(row)).toEqual([]);
    });

    test("all four D14 ownership invariants hold", async () => {
      expect(await auditConsolePlane(sql)).toEqual([]);
    });

    test("search_path is pinned on ALL FIVE routines", async () => {
      const rows = await sql.query<{ proname: string; proconfig: string[] | null }>(
        "",
        `SELECT p.proname, p.proconfig FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'hx' AND p.proname IN (${CONSOLE_ROUTINES.map((r) => `'${r.name}'`).join(", ")})`,
      );
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect(row.proconfig).toContain("search_path=pg_catalog, pg_temp");
      }
    });

    test("PUBLIC holds EXECUTE on none of them", async () => {
      for (const routine of CONSOLE_ROUTINES) {
        const [row] = await sql.query<{ granted: boolean }>(
          "",
          `SELECT has_function_privilege('public', '${routineSignature(routine)}', 'EXECUTE') AS granted`,
        );
        expect(row.granted).toBe(false);
      }
    });

    test("EXECUTE is refused to the console role and to both read roles, by name", async () => {
      for (const routine of CONSOLE_ROUTINES) {
        for (const role of ["hx_ui", "hx_app_ro", "hx_readonly"]) {
          const [row] = await sql.query<{ granted: boolean }>(
            "",
            `SELECT has_function_privilege('${role}', '${routineSignature(routine)}', 'EXECUTE') AS granted`,
          );
          expect(row.granted).toBe(false);
        }
      }
    });

    test("as hx_app_rw: no INSERT and no UPDATE on the command table", async () => {
      expect(await refused(rwDsn, "INSERT INTO hx.console_commands (kind) VALUES ('self_test')")).toMatch(
        /permission denied/i,
      );
      expect(await refused(rwDsn, "UPDATE hx.console_commands SET status = 'done'")).toMatch(
        /permission denied/i,
      );
    });

    test("as hx_app_rw: admin_audit writes are refused", async () => {
      expect(
        await refused(rwDsn, "INSERT INTO hx.admin_audit (spool_file_id, seq, action, kind) VALUES ('f', 1, 'a', 'intent')"),
      ).toMatch(/permission denied/i);
      expect(await refused(rwDsn, "UPDATE hx.admin_audit SET outcome = 'x'")).toMatch(/permission denied/i);
      expect(await refused(rwDsn, "DELETE FROM hx.admin_audit")).toMatch(/permission denied/i);
    });

    test("as hx_ui: transcript columns are refused, metadata columns are not", async () => {
      expect(await refused(uiDsn, "SELECT last_user_text FROM hx.sessions LIMIT 1")).toMatch(
        /permission denied/i,
      );
      expect(await refused(uiDsn, "SELECT last_assistant_text FROM hx.sessions LIMIT 1")).toMatch(
        /permission denied/i,
      );
      expect(await refused(uiDsn, "SELECT title, ingest_channel FROM hx.sessions LIMIT 1")).toBeNull();
    });

    test("as hx_ui: the transcript view is refused and no role membership exists", async () => {
      expect(await refused(uiDsn, "SELECT text FROM hx.v_turn_search LIMIT 1")).toMatch(
        /permission denied/i,
      );
      const rows = await sql.query<{ n: number }>(
        "",
        `SELECT count(*)::int AS n FROM pg_auth_members m
          WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'hx_ui')
             OR m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'hx_ui')`,
      );
      expect(rows[0].n).toBe(0);
    });

    test("as hx_app_ro / hx_readonly: the console tables are invisible", async () => {
      for (const table of ["console_commands", "admin_audit", "audit_acks", "audit_settings", "ingest_control"]) {
        expect(await refused(roDsn, `SELECT 1 FROM hx.${table} LIMIT 1`)).toMatch(/permission denied/i);
      }
    });

    test("as hx_app_rw: ingest_control is column-writable but the anchor is not", async () => {
      // Arm through the column grant — no table-level INSERT exists.
      await query(
        rwDsn,
        "INSERT INTO hx.ingest_control (paused_until, reason, armed_by) VALUES (now() + interval '5 minutes', 'test', 'rw')",
      );
      expect(
        await refused(
          rwDsn,
          "INSERT INTO hx.ingest_control (paused_until, row_written_at) VALUES (now(), now())",
        ),
      ).toMatch(/permission denied/i);
      expect(await refused(rwDsn, "UPDATE hx.ingest_control SET row_written_at = now()")).toMatch(
        /permission denied/i,
      );
      // DELETE stays revoked permanently: delete + re-INSERT would mint a fresh
      // anchor and restore exactly the unbounded pause the clamp bounds.
      expect(await refused(rwDsn, "DELETE FROM hx.ingest_control")).toMatch(/permission denied/i);
    });

    test("a ten-year pause reopens at the cap", async () => {
      await query(
        rwDsn,
        "INSERT INTO hx.ingest_control (paused_until, reason, armed_by) VALUES (now() + interval '10 years', 'abuse', 'rw')",
      );
      const db = createHxDb(rwDsn);
      const row = await readCurrentEpisode(db);
      expect(row).not.toBeNull();
      const now = new Date();
      const pause = effectivePause({ row, firstObservedAt: now, now });
      expect(pause.capped).toBe(true);
      expect(pause.pausedUntil!.getTime()).toBeLessThanOrEqual(now.getTime() + PAUSE_CAP_MS + 1000);
    });

    test("the containment probe reports the isolated state for the console role", async () => {
      // The SHIPPED query, not a restatement of it: a hand-copy passes whatever
      // the real one does, so an invalid `containmentProbeQuery()` went unnoticed
      // by both of its own acceptances.
      const [probe] = await query<ContainmentProbe>(uiDsn, containmentProbeQuery());
      expect(containmentState(probe)).toBe("isolated");
    });
  });

  describe("the one-way machine", () => {
    async function mint(kind = "self_test", requestedAt = "now()"): Promise<string> {
      const [row] = await query<{ id: string }>(
        uiDsn,
        `INSERT INTO hx.console_commands (kind, params, requested_at)
         VALUES ('${kind}', '{}', ${requestedAt}) RETURNING id`,
      );
      return row.id;
    }

    test("params survive the driver as an OBJECT, so the validator can accept them", async () => {
      // The regression this exists for: `params` is jsonb and Bun.SQL — the
      // driver under HxDb — returns jsonb as raw JSON TEXT. The daemon's poll
      // fed that string straight to validateCommandParams, whose first test is
      // `typeof params === "object"`, so EVERY console-minted command was
      // rejected with `rejected_invalid_params: params must be an object` about
      // a value that was an object. Observed live: Run audit confirmed in the
      // console, `console_commands` holding one rejected row, `audit_runs`
      // empty, and nothing on screen — the panel reports the daemon's answer,
      // so the rejection was invisible.
      //
      // A fake gateway returning objects cannot fail this. It has to be the
      // real driver, which is why it lives in the e2e suite.
      const [row] = await query<{ id: string }>(
        uiDsn,
        `INSERT INTO hx.console_commands (kind, params)
         VALUES ('run_audit', '{"scope":"console"}'::jsonb) RETURNING id`,
      );
      const open = await createCommandGateway(createHxDb(rwDsn)).listOpen();
      const mine = open.find((c) => c.id === row.id);
      expect(mine).toBeDefined();
      expect(typeof mine?.params).toBe("object");
      expect(mine?.params).toEqual({ scope: "console" });
      expect(validateCommandParams(mine?.kind, mine?.params).ok).toBe(true);
    });

    test("a terminal row cannot be reopened under any argument shape", async () => {
      const id = await mint();
      await query(rwDsn, `SELECT hx.claim_command('${id}'::uuid, 'pid:1', false)`);
      await query(rwDsn, `SELECT hx.complete_command('${id}'::uuid, 'done', 'ok', NULL)`);
      for (const statement of [
        `SELECT hx.claim_command('${id}'::uuid, 'pid:1', false) AS r`,
        `SELECT hx.claim_command('${id}'::uuid, 'pid:1', true) AS r`,
        `SELECT hx.complete_command('${id}'::uuid, 'failed', NULL, 'no') AS r`,
        `SELECT hx.reject_command('${id}'::uuid, 'no') AS r`,
      ]) {
        const [row] = await query<{ r: boolean }>(rwDsn, statement);
        expect(row.r).toBe(false);
      }
      const [after] = await query<{ status: string }>(
        uiDsn,
        `SELECT status FROM hx.console_commands WHERE id = '${id}'`,
      );
      expect(after.status).toBe("done");
    });

    test("no call sequence can change kind, params or requested_at", async () => {
      const id = await mint("run_checkup");
      const [before] = await query<Record<string, unknown>>(
        uiDsn,
        `SELECT kind, params::text AS params, requested_at FROM hx.console_commands WHERE id = '${id}'`,
      );
      await query(rwDsn, `SELECT hx.claim_command('${id}'::uuid, 'pid:1', false)`);
      await query(rwDsn, `SELECT hx.claim_command('${id}'::uuid, 'pid:2', true)`);
      await query(rwDsn, `SELECT hx.complete_command('${id}'::uuid, 'failed', NULL, 'x')`);
      const [after] = await query<Record<string, unknown>>(
        uiDsn,
        `SELECT kind, params::text AS params, requested_at FROM hx.console_commands WHERE id = '${id}'`,
      );
      expect(after).toEqual(before);
    });

    test("a future requested_at is refused at claim", async () => {
      const id = await mint("self_test", "now() + interval '1 day'");
      const [row] = await query<{ r: boolean }>(
        rwDsn,
        `SELECT hx.claim_command('${id}'::uuid, 'pid:1', false) AS r`,
      );
      expect(row.r).toBe(false);
    });

    test("a complete_command with an invalid terminal status is refused outright", async () => {
      const id = await mint();
      await query(rwDsn, `SELECT hx.claim_command('${id}'::uuid, 'pid:1', false)`);
      expect(
        await refused(rwDsn, `SELECT hx.complete_command('${id}'::uuid, 'requested', NULL, NULL)`),
      ).toMatch(/done or failed/);
    });

    test("a CLEAN run is still reportable — the run is readable without a finding", async () => {
      // auditFindingsQuery JOINs the run to its failing rows, so a run that
      // found nothing yields zero rows and carries no timestamp with it. The
      // panel returned null on that, which made the page after a clean audit
      // byte-identical to the page before it — and made a command plane that
      // rejected every request indistinguishable from one that worked. The run
      // has to be readable on its own.
      await query(
        rwDsn,
        `INSERT INTO hx.audit_runs (id, trigger, finished_at, sessions_checked, confirmed, qualification)
           VALUES ('22222222-2222-2222-2222-222222222222', 'console', now(), 4, 4,
                   'every checked session is held here and nowhere else')`,
      );
      // No finding rows exist for it, so the findings query — which JOINs the
      // run to them — can carry neither the run nor its timestamp.
      const [run] = await query<Record<string, unknown>>(
        uiDsn,
        new PgDialect().sqlToQuery(auditLastRunQuery()).sql,
      );
      expect(run).toBeDefined();
      expect(Number(run.sessionsChecked)).toBe(4);
      expect(Number(run.confirmed)).toBe(4);
      expect(run.qualification).toBe("every checked session is held here and nowhere else");
      expect(run.startedAt).not.toBeNull();
      await query(rwDsn, "DELETE FROM hx.audit_runs WHERE id = '22222222-2222-2222-2222-222222222222'");
    });

    test("acknowledge_finding and set_cloud_witness run through the owner's grants", async () => {
      // FENCED: the routine refuses a session with no acknowledgeable finding,
      // so the row has to exist before it can be acknowledged. Seeded through the
      // rw DSN, which is what an audit run writes with.
      await query(
        rwDsn,
        `INSERT INTO hx.audit_runs (id, trigger) VALUES ('11111111-1111-1111-1111-111111111111', 'test')`,
      );
      await query(
        rwDsn,
        `INSERT INTO hx.audit_findings (run_id, org, family, session_id, verdict)
           VALUES ('11111111-1111-1111-1111-111111111111', 'org-1', 'claude', 'sess-1', 'also_at_letai')`,
      );

      // The fence itself: a session with no such finding is refused, and the
      // refusal reads as a check violation rather than a permission error — the
      // routine's owner needs its own SELECT on hx.audit_findings to see the row
      // at all, and without that grant every acknowledgement failed with 42501.
      expect(
        await refused(rwDsn, "SELECT hx.acknowledge_finding('org-1', 'no-such-session', 'denis', 'x')"),
      ).toMatch(/no acknowledgeable finding/);

      await query(rwDsn, "SELECT hx.acknowledge_finding('org-1', 'sess-1', 'denis', 'known')");
      const [ack] = await query<{ n: number }>(
        uiDsn,
        "SELECT count(*)::int AS n FROM hx.audit_acks WHERE org = 'org-1' AND session_id = 'sess-1'",
      );
      expect(ack.n).toBe(1);
      // Idempotent: a second acknowledgement updates rather than conflicting.
      await query(rwDsn, "SELECT hx.acknowledge_finding('org-1', 'sess-1', 'denis', 'again')");

      await query(rwDsn, "SELECT hx.set_cloud_witness(true)");
      const [witness] = await query<{ cloud_witness: boolean }>(
        uiDsn,
        "SELECT cloud_witness FROM hx.audit_settings",
      );
      expect(witness.cloud_witness).toBe(true);
      await query(rwDsn, "SELECT hx.set_cloud_witness(false)");
      const [off] = await query<{ cloud_witness: boolean }>(
        uiDsn,
        "SELECT cloud_witness FROM hx.audit_settings",
      );
      expect(off.cloud_witness).toBe(false);
    });
  });

  describe("the boot fence", () => {
    test("a row minted before boot is rejected and never claimed; a fresh one claims normally", async () => {
      await sql.run("", "DELETE FROM hx.console_commands");
      const [pre] = await query<{ id: string }>(
        uiDsn,
        "INSERT INTO hx.console_commands (kind, params) VALUES ('self_test', '{}') RETURNING id",
      );
      const [future] = await query<{ id: string }>(
        uiDsn,
        "INSERT INTO hx.console_commands (kind, params, requested_at) VALUES ('self_test', '{}', now() + interval '1 year') RETURNING id",
      );
      const gateway = createCommandGateway(createHxDb(rwDsn));
      const inFlightPath = `${process.env.TMPDIR ?? "/tmp"}/hx-fence-${Date.now()}.json`;
      const result = await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
      expect(new Set(result.rejected)).toEqual(new Set([pre.id, future.id]));

      const rows = await query<{ status: string; error: string }>(
        uiDsn,
        `SELECT status, error FROM hx.console_commands WHERE id IN ('${pre.id}', '${future.id}')`,
      );
      for (const row of rows) {
        expect(row.status).toBe("rejected");
        expect(row.error).toBe(REJECT_BOOT_FENCE);
      }

      // A row minted AFTER the fence claims normally.
      const [fresh] = await query<{ id: string }>(
        uiDsn,
        "INSERT INTO hx.console_commands (kind, params) VALUES ('self_test', '{}') RETURNING id",
      );
      expect(await gateway.claim(fresh.id, "pid:boot", false)).toBe(true);
    });
  });

  describe("the stale-overload sweep", () => {
    test("a planted overload is dropped at the next boot and cannot be executed", async () => {
      await sql.run(
        "",
        `CREATE OR REPLACE FUNCTION hx.set_cloud_witness(p_enabled boolean, p_extra text)
         RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
         AS $$ SELECT true $$`,
      );
      await sql.run("", "GRANT EXECUTE ON FUNCTION hx.set_cloud_witness(boolean, text) TO hx_app_rw");
      await boot();
      const rows = await sql.query<{ n: number }>(
        "",
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'hx' AND p.proname = 'set_cloud_witness'`,
      );
      expect(rows[0].n).toBe(1);
      expect(await refused(rwDsn, "SELECT hx.set_cloud_witness(true, 'x')")).toMatch(
        /does not exist/i,
      );
    }, 60_000);
  });
  // The adversarial arms that only a LIVE catalog can answer: what the two
  // declared-hostile principals can actually do to the tables the engines own,
  // and what a binary that comes back after a downgrade does about a row the
  // downgraded one let in.
  describe("as the declared-hostile principals", () => {
    test("the write role reaches the fenced tables through the routines and no other way", async () => {
      for (const statement of [
        "INSERT INTO hx.audit_acks (org, session_id, acknowledged_by) VALUES ('o', 's', 'x')",
        "UPDATE hx.audit_acks SET reason = 'x'",
        "DELETE FROM hx.audit_acks",
        "INSERT INTO hx.audit_settings (cloud_witness) VALUES (true)",
        "UPDATE hx.audit_settings SET cloud_witness = true",
        "DELETE FROM hx.audit_settings",
      ]) {
        expect([statement, await refused(rwDsn, statement)]).toMatchObject([statement, expect.stringMatching(/permission denied/i)]);
      }
      // The fence is TARGETED, not a blanket read-only: the audit engine's own
      // run record is the daemon's to write, because a run it cannot record is
      // a run that never happened.
      expect(await refused(rwDsn, "INSERT INTO hx.audit_runs (trigger) VALUES ('adversarial')")).toBeNull();
      await sql.run("", "DELETE FROM hx.audit_runs WHERE trigger = 'adversarial'");
    });

    test("the console role reads every engine table and writes none of them", async () => {
      const readOnly: Array<[string, string]> = [
        ["audit_acks", "INSERT INTO hx.audit_acks (org, session_id, acknowledged_by) VALUES ('o', 's', 'x')"],
        ["audit_settings", "UPDATE hx.audit_settings SET cloud_witness = true"],
        ["audit_runs", "INSERT INTO hx.audit_runs (trigger) VALUES ('ui')"],
        ["audit_findings", "DELETE FROM hx.audit_findings"],
        ["roster", "INSERT INTO hx.roster (external_id, display_name) VALUES ('x', 'X')"],
        ["roster_sync", "UPDATE hx.roster_sync SET members = 0"],
        ["migration_runs", "INSERT INTO hx.migration_runs (phase) VALUES ('arm')"],
        ["migration_objects", "DELETE FROM hx.migration_objects"],
        ["ingest_control", "INSERT INTO hx.ingest_control (paused_until) VALUES (now())"],
      ];
      for (const [table, statement] of readOnly) {
        expect([table, await refused(uiDsn, statement)]).toMatchObject([table, expect.stringMatching(/permission denied/i)]);
        expect([table, await refused(uiDsn, `SELECT 1 FROM hx.${table} LIMIT 1`)]).toEqual([table, null]);
      }
      // Its two writes, and only those two: a command row, and an audit record
      // the daemon's own role cannot produce.
      expect(await refused(uiDsn, "INSERT INTO hx.console_commands (kind, params) VALUES ('self_test', '{}')")).toBeNull();
      const marker = `adversarial-${Date.now().toString(36)}`;
      expect(
        await refused(
          uiDsn,
          `INSERT INTO hx.admin_audit (spool_file_id, seq, action, kind) VALUES ('${marker}', 1, 'console.probe', 'intent')`,
        ),
      ).toBeNull();
      await sql.run("", `DELETE FROM hx.admin_audit WHERE spool_file_id = '${marker}'`);
    });

    test("a row planted while an older binary held INSERT is fenced, never executed", async () => {
      await sql.run("", "DELETE FROM hx.console_commands");
      // Precisely what a downgraded binary's blanket schema grant does on its
      // first boot, and the window this fence exists for.
      await sql.run("", "GRANT INSERT ON hx.console_commands TO hx_app_rw");
      const [planted] = await query<{ id: string }>(
        rwDsn,
        "INSERT INTO hx.console_commands (kind, params) VALUES ('update_apply', '{}') RETURNING id",
      );

      // The binary that comes back takes the grant away again...
      await boot();
      expect(await refused(rwDsn, "INSERT INTO hx.console_commands (kind) VALUES ('self_test')")).toMatch(
        /permission denied/i,
      );

      // ...and closes out every row it cannot prove it was executing itself.
      const gateway = createCommandGateway(createHxDb(rwDsn));
      const inFlightPath = `${process.env.TMPDIR ?? "/tmp"}/hx-downgrade-${Date.now()}.json`;
      const result = await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
      expect(result.rejected).toContain(planted.id);
      const [row] = await query<{ status: string; error: string }>(
        uiDsn,
        `SELECT status, error FROM hx.console_commands WHERE id = '${planted.id}'`,
      );
      expect(row.status).toBe("rejected");
      expect(row.error).toBe(REJECT_BOOT_FENCE);
      // Terminal is terminal: not even the re-drive arm reopens it.
      expect(await gateway.claim(planted.id, "pid:boot", true)).toBe(false);
    }, 60_000);
  });
});
