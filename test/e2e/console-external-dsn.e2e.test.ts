// The EXTERNAL-Postgres job's own assertion set.
//
// D13 containment is embedded-only and VOID here by construction: there is no
// role split, the operator's role OWNS the tables (an owner cannot be
// constrained by REVOKE), and ensureAppRoles never runs — so the apparatus does
// not exist at all and console mutations are plain DML. Asserting the embedded
// matrix here would fail by construction, so this job asserts what is actually
// true: the migration applies, console reads work, mutations WORK through
// direct DML, and the containment probe says UNAVAILABLE rather than pretending.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { CONSOLE_ROUTINES } from "../../src/host/postgres/console-plane";
import {
  containmentProbeQuery,
  containmentState,
  type ContainmentProbe,
} from "../../src/host/postgres/privilege-matrix";
import { generateRoleSql } from "../../src/host/postgres/print-role-sql";
import { makeMigrationExec } from "../../src/host/postgres/sql-exec";
import { migrations } from "../../src/host/postgres/migrations/manifest";
import { runMigrations } from "../../src/host/postgres/migrate";
import { readPgJson, resolveRoleDsn, writePgJson } from "../../src/host/postgres/pg-json";

const SUPER_DSN = process.env.FORTRESS_MATRIX_DATABASE_URL;
const REQUIRED = process.env.FORTRESS_PG_MATRIX_REQUIRED === "1";
const EXTERNAL_DB = "hx-external-test";

describe.if(REQUIRED && !SUPER_DSN)("external-DSN job (CI marker set)", () => {
  test("requires a Postgres service", () => {
    expect(SUPER_DSN).toBeDefined();
  });
});

async function query<T = Record<string, unknown>>(dsn: string, statement: string): Promise<T[]> {
  const client = new Bun.SQL(dsn);
  try {
    return (await client.unsafe(statement)) as T[];
  } finally {
    await client.end();
  }
}

/** The error a statement raises, or null when it succeeded. */
async function refused(dsn: string, statement: string): Promise<string | null> {
  try {
    await query(dsn, statement);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Run a whole script the way an operator would paste it into psql — one
 *  simple-query batch, so a DO $$ … $$ block survives intact. */
async function execBatch(dsn: string, script: string): Promise<void> {
  const client = new Bun.SQL(dsn);
  try {
    await client.unsafe(script).simple();
  } finally {
    await client.end();
  }
}

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

describe.if(!!SUPER_DSN)("an external Postgres", () => {
  // Resolved in beforeAll, not at describe scope: bun evaluates a skipped
  // describe's body, so parsing an absent DSN here would error the whole run
  // on a machine with no Postgres.
  let adminDsn = "";
  let externalDsn = "";
  const OPERATOR_ROLE = "hx_ext_daemon";
  const UI_PASSWORD = "external-console-pw";

  beforeAll(async () => {
    adminDsn = withDatabase(SUPER_DSN as string, "postgres");
    await query(adminDsn, `DROP DATABASE IF EXISTS "${EXTERNAL_DB}"`);
    await query(adminDsn, `CREATE DATABASE "${EXTERNAL_DB}"`);
    externalDsn = withDatabase(SUPER_DSN as string, EXTERNAL_DB);
    // External mode runs migrations ONLY — no ensureAppRoles, so no apparatus.
    await runMigrations(makeMigrationExec(externalDsn), migrations);
  }, 120_000);

  afterAll(async () => {
    for (const role of [OPERATOR_ROLE, "hx_ui"]) {
      await query(externalDsn, `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    EXECUTE 'DROP OWNED BY ${role} CASCADE';
  END IF;
END $$`).catch(() => {});
    }
    await query(adminDsn, `DROP DATABASE IF EXISTS "${EXTERNAL_DB}"`).catch(() => {});
    await query(adminDsn, `DROP ROLE IF EXISTS ${OPERATOR_ROLE}`).catch(() => {});
  });

  test("0015 applies against an external DSN — the role guards hold with no app roles", async () => {
    const rows = await query<{ name: string }>(
      externalDsn,
      "SELECT name FROM hx.schema_migrations WHERE name = '0019_console_plane'",
    );
    expect(rows.length).toBe(1);
  });

  test("the apparatus was never created here", async () => {
    const [row] = await query<{ n: number }>(
      externalDsn,
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'hx' AND p.proname IN (${CONSOLE_ROUTINES.map((r) => `'${r.name}'`).join(", ")})`,
    );
    expect(row.n).toBe(0);
  });

  test("the containment probe reports UNAVAILABLE rather than pretending", async () => {
    // The shipped query itself — see its twin in console-plane.e2e.
    const [probe] = await query<ContainmentProbe>(externalDsn, containmentProbeQuery());
    expect(containmentState(probe)).toBe("unavailable");
  });

  test("single-role shape: a command is claimed AND completed end-to-end by direct DML", async () => {
    const [row] = await query<{ id: string }>(
      externalDsn,
      "INSERT INTO hx.console_commands (kind, params) VALUES ('self_test', '{}') RETURNING id",
    );
    await query(
      externalDsn,
      `UPDATE hx.console_commands SET status = 'running', claimed_by = 'op', claimed_at = now() WHERE id = '${row.id}'`,
    );
    await query(
      externalDsn,
      `UPDATE hx.console_commands SET status = 'done', outcome = 'ok', completed_at = now() WHERE id = '${row.id}'`,
    );
    const [after] = await query<{ status: string }>(
      externalDsn,
      `SELECT status FROM hx.console_commands WHERE id = '${row.id}'`,
    );
    expect(after.status).toBe("done");
  });

  test("non-owning-role shape: the emitted SQL restores isolation and still completes a command", async () => {
    await query(externalDsn, `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OPERATOR_ROLE}') THEN
    CREATE ROLE ${OPERATOR_ROLE} LOGIN PASSWORD 'daemon-pw';
  END IF;
END $$`);
    const emitted = generateRoleSql({
      password: UI_PASSWORD,
      databaseUrl: externalDsn,
      daemonRole: OPERATOR_ROLE,
    });
    // The emitted script is meant to be pasted: it must carry no cleartext.
    expect(emitted.sql).not.toContain(UI_PASSWORD);
    await execBatch(externalDsn, emitted.sql);

    const uiDsn = emitted.consoleDatabaseUrl;
    // The console mints…
    const [minted] = await query<{ id: string }>(
      uiDsn,
      "INSERT INTO hx.console_commands (kind, params) VALUES ('run_checkup', '{}') RETURNING id",
    );
    const daemonDsn = (() => {
      const url = new URL(externalDsn);
      url.username = OPERATOR_ROLE;
      url.password = "daemon-pw";
      return url.toString();
    })();
    // …the daemon role claims and completes with SELECT + UPDATE only…
    await query(
      daemonDsn,
      `UPDATE hx.console_commands SET status = 'running', claimed_at = now() WHERE id = '${minted.id}'`,
    );
    await query(
      daemonDsn,
      `UPDATE hx.console_commands SET status = 'done', outcome = 'ok' WHERE id = '${minted.id}'`,
    );
    const [after] = await query<{ status: string }>(
      uiDsn,
      `SELECT status FROM hx.console_commands WHERE id = '${minted.id}'`,
    );
    expect(after.status).toBe("done");

    // …and it may NEVER mint: granting the daemon role INSERT would re-open the
    // exact hole inside the remedy that closes it.
    let insertRefused = "";
    try {
      await query(daemonDsn, "INSERT INTO hx.console_commands (kind) VALUES ('self_test')");
    } catch (err) {
      insertRefused = err instanceof Error ? err.message : String(err);
    }
    expect(insertRefused).toMatch(/permission denied/i);
  });

  test("console reads work through the emitted grants, transcript text does not", async () => {
    const emitted = generateRoleSql({ password: UI_PASSWORD, databaseUrl: externalDsn });
    await execBatch(externalDsn, emitted.sql);
    const uiDsn = emitted.consoleDatabaseUrl;
    await query(uiDsn, "SELECT title, ingest_channel FROM hx.sessions LIMIT 1");
    let refused = "";
    try {
      await query(uiDsn, "SELECT last_user_text FROM hx.sessions LIMIT 1");
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    expect(refused).toMatch(/permission denied/i);
  });

  test("the five SECURITY DEFINER routines do NOT exist here — which is the whole point", async () => {
    // `ensureAppRoles` installs them and is wired into the embedded branch
    // alone. Everything the daemon does through them has to have a path that
    // works without them, or it silently fails on this plane.
    const [{ n }] = await query<{ n: number }>(
      externalDsn,
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'hx' AND p.proname IN (${CONSOLE_ROUTINES.map((r) => `'${r.name}'`).join(", ")})`,
    );
    expect(n).toBe(0);
  });

  test("the cloud witness can be turned OFF here — 0022 seeds it ON", async () => {
    // The failure this covers: 0022 seeds `cloud_witness = true`, its only
    // writer is `hx.set_cloud_witness`, and that routine does not exist on this
    // plane — so an external-DSN fortress came up with outbound session-id
    // disclosure enabled and every attempt to disable it raised 42883.
    const [seeded] = await query<{ cloud_witness: boolean }>(
      externalDsn,
      "SELECT cloud_witness FROM hx.audit_settings",
    );
    expect(seeded.cloud_witness).toBe(true);

    // The daemon's external-plane path, verbatim.
    await query(
      externalDsn,
      "UPDATE hx.audit_settings SET cloud_witness = false, changed_at = now(), changed_by = session_user",
    );
    const [off] = await query<{ cloud_witness: boolean; changed_by: string | null }>(
      externalDsn,
      "SELECT cloud_witness, changed_by FROM hx.audit_settings",
    );
    expect(off.cloud_witness).toBe(false);
    // The stamp is the compensating control, and it survives on this plane too.
    expect(off.changed_by).not.toBeNull();

    // …and 0027's singleton is what keeps a second flip from forking the row.
    const [{ n }] = await query<{ n: number }>(
      externalDsn,
      "SELECT count(*)::int AS n FROM hx.audit_settings",
    );
    expect(n).toBe(1);
    await query(
      externalDsn,
      "UPDATE hx.audit_settings SET cloud_witness = true, changed_at = now(), changed_by = session_user",
    );
  });

  test("0027 constrained the singleton, and a second row cannot be inserted", async () => {
    expect(
      await refused(externalDsn, "INSERT INTO hx.audit_settings (cloud_witness) VALUES (false)"),
    ).toMatch(/duplicate key|unique/i);
  });

  test("acknowledging with no finding is REFUSED on this plane too", async () => {
    // The fallback DML keeps the fence's rule; without RETURNING it kept the
    // rule and lost the refusal, so a command that acknowledged nothing
    // completed reporting success on a compliance surface.
    const acked = await query<{ org: string }>(
      externalDsn,
      `INSERT INTO hx.audit_acks (org, session_id, acknowledged_by, reason)
       SELECT 'org-x', 'sess-x', 'terminal operator', 'no finding exists'
        WHERE EXISTS (SELECT 1 FROM hx.audit_findings f
                       WHERE f.org = 'org-x' AND f.session_id = 'sess-x'
                         AND f.verdict = 'also_at_letai')
           ON CONFLICT (org, session_id)
           DO UPDATE SET acknowledged_at = now()
        RETURNING org`,
    );
    expect(acked.length).toBe(0);
  });

  test("pg.json carries the effective DSN and an external marker", async () => {
    const file = `${process.env.TMPDIR ?? "/tmp"}/hx-ext-pg-${Date.now()}.json`;
    await writePgJson(file, { mode: "external", databaseUrl: externalDsn });
    const parsed = await readPgJson(file);
    expect(parsed?.mode).toBe("external");
    expect(resolveRoleDsn({ pgJson: parsed })).toBe(externalDsn);
  });
});
