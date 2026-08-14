import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensureAppRoles,
  ensureAuth,
  ensureCluster,
  ensureDatabaseAndSchema,
  type ClusterSql,
} from "../src/host/postgres/cluster";
import type { RoleSecrets } from "../src/host/postgres/roles";
import type { Spawner } from "../src/host/postgres/spawn";

const SECRETS: RoleSecrets = { super: "super-pw", appRo: "ro-pw", appRw: "rw-pw", ui: "ui-pw" };

function recorder(results: Array<{ code: number }> = []): {
  spawner: Spawner;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  return {
    calls,
    spawner: {
      run: async (cmd) => {
        calls.push(cmd);
        const r = results[i++] ?? { code: 0 };
        return { code: r.code, stderr: "" };
      },
    },
  };
}

function fakeSql(
  exists: boolean | ((database: string, query: string) => boolean) = false,
  rows: () => Record<string, unknown>[] = () => [],
): { sql: ClusterSql; runs: Array<[string, string]>; batches: string[][] } {
  const runs: Array<[string, string]> = [];
  const batches: string[][] = [];
  const existsFn = typeof exists === "function" ? exists : () => exists;
  return {
    runs,
    batches,
    sql: {
      run: async (database, statement) => {
        runs.push([database, statement]);
      },
      exists: async (database, query) => existsFn(database, query),
      // ensureAppRoles issues ONE preflight read whose row carries three JSON
      // arrays; `rows` supplies the routine list a test wants to plant.
      query: async () => [{ routines: rows(), extras: [], views: [] }] as never[],
      runMany: async (_database, statements) => {
        batches.push([...statements]);
      },
    },
  };
}

describe("cluster", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-pg-cluster-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("runs initdb with scram + a pwfile when the data dir is empty", async () => {
    const { spawner, calls } = recorder();
    await ensureCluster({
      spawner,
      binDir: "/bin",
      dataDir: path.join(root, "pgdata"),
      superPassword: SECRETS.super,
    });
    expect(calls[0][0]).toBe("/bin/initdb");
    // De-superuser: scram for local + host, no more --auth=trust.
    expect(calls[0]).toContain("--auth-host=scram-sha-256");
    expect(calls[0]).toContain("--auth-local=scram-sha-256");
    expect(calls[0]).not.toContain("--auth=trust");
    expect(calls[0]).toContain("--username=fortress");
    // The superuser password is seeded from a temp --pwfile (removed after).
    expect(calls[0].some((a) => a.startsWith("--pwfile="))).toBe(true);
  });

  test("skips initdb when PG_VERSION already exists (never re-inits)", async () => {
    const dataDir = path.join(root, "pgdata");
    await Bun.write(path.join(dataDir, "PG_VERSION"), "18\n");
    const { spawner, calls } = recorder();
    await ensureCluster({ spawner, binDir: "/bin", dataDir, superPassword: SECRETS.super });
    expect(calls.length).toBe(0);
  });

  test("creates database when absent, then schema", async () => {
    const { sql, runs } = fakeSql(false);
    await ensureDatabaseAndSchema(sql);
    expect(runs[0]).toEqual(["postgres", 'CREATE DATABASE "hx-db"']);
    expect(runs[1]).toEqual(["hx-db", "CREATE SCHEMA IF NOT EXISTS hx"]);
  });

  test("skips database creation when it already exists, still ensures schema", async () => {
    const { sql, runs } = fakeSql(true);
    await ensureDatabaseAndSchema(sql);
    expect(runs.some(([, s]) => s.includes("CREATE DATABASE"))).toBe(false);
    expect(runs).toContainEqual(["hx-db", "CREATE SCHEMA IF NOT EXISTS hx"]);
  });
});

describe("ensureAuth (in-place trust→scram conversion)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-pg-auth-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("sets the super password, writes a scram HBA, then reloads (in that order)", async () => {
    const { sql, runs } = fakeSql(false);
    let hbaAtReload: string | null = null;
    let reloads = 0;
    const reload = async (): Promise<void> => {
      reloads += 1;
      // The HBA must already be rewritten before the reload fires.
      hbaAtReload = await readFile(path.join(root, "pg_hba.conf"), "utf8").catch(() => null);
    };
    await ensureAuth(sql, root, SECRETS, reload);

    // ALTER ROLE runs on the always-present `postgres` db (hx-db may not exist yet).
    expect(runs).toContainEqual(["postgres", "ALTER ROLE fortress WITH PASSWORD 'super-pw'"]);
    expect(reloads).toBe(1);

    const hba = await readFile(path.join(root, "pg_hba.conf"), "utf8");
    expect(hba).toContain("scram-sha-256");
    expect(hba).toContain("127.0.0.1/32");
    expect(hba).toContain("0.0.0.0/0       reject");
    expect(hba).toContain("::/0            reject");
    // No trust anywhere in the managed ruleset.
    expect(hba).not.toContain("trust");
    // The HBA was already on disk when reload fired (rewrite precedes reload).
    expect(hbaAtReload ?? "").toContain("scram-sha-256");
  });
});

describe("ensureAppRoles (idempotent least-privilege roles + command plane)", () => {
  async function batchOf(): Promise<string[]> {
    const { sql, batches } = fakeSql(false);
    await ensureAppRoles(sql, SECRETS);
    expect(batches.length).toBe(1); // ONE transaction, never statement-per-connection
    return batches[0];
  }

  test("provisions every role and grant in a single batch", async () => {
    const stmts = await batchOf();

    expect(stmts.some((s) => s.includes("CREATE ROLE hx_app_ro LOGIN IN ROLE hx_readonly"))).toBe(true);
    expect(stmts.some((s) => s.includes("CREATE ROLE hx_app_rw LOGIN"))).toBe(true);
    expect(stmts.some((s) => s.includes("CREATE ROLE hx_cmd_owner NOLOGIN"))).toBe(true);
    expect(stmts.some((s) => s.includes("CREATE ROLE hx_ui LOGIN"))).toBe(true);
    expect(stmts).toContain("ALTER ROLE hx_app_ro WITH PASSWORD 'ro-pw'");
    expect(stmts).toContain("ALTER ROLE hx_app_rw WITH PASSWORD 'rw-pw'");
    expect(stmts).toContain("ALTER ROLE hx_ui WITH PASSWORD 'ui-pw'");
    expect(stmts).toContain("GRANT hx_readonly TO hx_app_ro");
    expect(stmts).toContain("GRANT USAGE ON SCHEMA hx TO hx_app_rw");
    expect(
      stmts.some((s) => s.includes("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hx TO hx_app_rw")),
    ).toBe(true);
    expect(stmts.some((s) => s.includes("GRANT USAGE ON ALL SEQUENCES IN SCHEMA hx TO hx_app_rw"))).toBe(true);
    expect(stmts.some((s) => s.startsWith("ALTER DEFAULT PRIVILEGES IN SCHEMA hx"))).toBe(true);
    expect(
      stmts.some((s) => /REVOKE INSERT, UPDATE, DELETE ON hx\.schema_migrations FROM hx_app_rw/.test(s)),
    ).toBe(true);
    // hx_app_rw never gets DDL/superuser via this path.
    expect(stmts.some((s) => /CREATE TABLE|SUPERUSER\b|CREATEDB\b/.test(s.replace(/NOSUPERUSER|NOCREATEDB/g, "")))).toBe(false);
  });

  test("every transition routine is created, de-PUBLICed, re-owned and granted, in that order", async () => {
    const stmts = await batchOf();
    for (const name of [
      "claim_command",
      "complete_command",
      "reject_command",
      "acknowledge_finding",
      "set_cloud_witness",
    ]) {
      const create = stmts.findIndex((s) => s.includes(`CREATE OR REPLACE FUNCTION hx.${name}(`));
      const revoke = stmts.findIndex((s) => s.startsWith(`REVOKE EXECUTE ON FUNCTION hx.${name}(`));
      const owner = stmts.findIndex((s) => s.startsWith(`ALTER FUNCTION hx.${name}(`));
      const grant = stmts.findIndex((s) => s.startsWith(`GRANT EXECUTE ON FUNCTION hx.${name}(`));
      expect(create).toBeGreaterThanOrEqual(0);
      // Postgres grants EXECUTE to PUBLIC by default, so the REVOKE has to be
      // the very next thing after the CREATE.
      expect(revoke).toBe(create + 1);
      expect(owner).toBeGreaterThan(revoke);
      expect(grant).toBeGreaterThan(owner);
      expect(stmts[create]).toContain("SECURITY DEFINER");
      expect(stmts[create]).toContain("SET search_path = pg_catalog, pg_temp");
    }
  });

  test("phases are ordered: blanket GRANTs, then table REVOKEs, then COLUMN GRANTs", async () => {
    const stmts = await batchOf();
    const blanket = stmts.findIndex((s) =>
      s.includes("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hx TO hx_app_rw"),
    );
    const revoke = stmts.findIndex((s) =>
      s.startsWith("REVOKE INSERT, UPDATE, DELETE ON hx.ingest_control FROM hx_app_rw"),
    );
    const columnGrant = stmts.findIndex((s) => s.startsWith("GRANT INSERT (paused_until"));
    expect(blanket).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeGreaterThan(blanket);
    // A table REVOKE also drops that table's COLUMN privileges, so the column
    // grants have to come last or the daemon cannot arm a pause at all.
    expect(columnGrant).toBeGreaterThan(revoke);
    expect(stmts[columnGrant]).not.toContain("row_written_at");
  });

  test("the console role gets column-level SELECT on sessions, never the transcript text", async () => {
    const stmts = await batchOf();
    const grant = stmts.find((s) => s.startsWith("GRANT SELECT (") && s.includes("hx.sessions TO hx_ui"));
    expect(grant).toBeDefined();
    expect(grant).toContain("title");
    expect(grant).toContain("ingest_channel");
    expect(grant).not.toContain("last_user_text");
    expect(grant).not.toContain("last_assistant_text");
    // Any table-level grant would include the excluded columns.
    expect(stmts).toContain("REVOKE ALL ON hx.sessions FROM hx_ui");
  });

  test("the write role can neither mint commands nor write the audit tables", async () => {
    const stmts = await batchOf();
    expect(stmts).toContain("REVOKE INSERT, UPDATE, DELETE ON hx.console_commands FROM hx_app_rw");
    expect(stmts).toContain("REVOKE INSERT, UPDATE, DELETE ON hx.admin_audit FROM hx_app_rw");
    expect(stmts).toContain("REVOKE INSERT, UPDATE, DELETE ON hx.audit_acks FROM hx_app_rw");
    expect(stmts).toContain("REVOKE INSERT, UPDATE, DELETE ON hx.audit_settings FROM hx_app_rw");
    // The cloud-served read DSN sees nothing the console owns.
    for (const role of ["hx_readonly", "hx_app_ro"]) {
      expect(stmts).toContain(`REVOKE ALL ON hx.console_commands FROM ${role}`);
      expect(stmts).toContain(`REVOKE ALL ON hx.admin_audit FROM ${role}`);
    }
    // The routine owner holds exactly its pinned set — no INSERT on commands.
    expect(stmts).toContain("GRANT SELECT, UPDATE ON hx.console_commands TO hx_cmd_owner");
    expect(stmts.some((s) => /GRANT [^;]*INSERT[^;]* ON hx\.console_commands TO hx_cmd_owner/.test(s))).toBe(false);
  });

  test("a stale overload left by a widened signature is dropped before the CREATEs", async () => {
    const { sql, batches } = fakeSql(false, () => [
      { name: "claim_command", args: "uuid, text", rettype: "boolean" },
    ]);
    await ensureAppRoles(sql, SECRETS);
    const stmts = batches[0];
    const drop = stmts.findIndex((s) => s.startsWith("DROP FUNCTION IF EXISTS hx.claim_command("));
    const create = stmts.findIndex((s) => s.includes("CREATE OR REPLACE FUNCTION hx.claim_command("));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(create);
  });

  test("the pinned signature is never dropped", async () => {
    const { sql, batches } = fakeSql(false, () => [
      { name: "set_cloud_witness", args: "boolean", rettype: "boolean" },
    ]);
    await ensureAppRoles(sql, SECRETS);
    expect(batches[0].some((s) => s.startsWith("DROP FUNCTION"))).toBe(false);
  });
});
