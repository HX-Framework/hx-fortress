import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  apparatusStatements,
  columnGrantStatements,
  ownershipProbeQuery,
  ownershipViolations,
  preflightQuery,
  quoteLiteral,
  revokeStatements,
  staleOverloadDrops,
  uiRoleStatements,
  type OwnershipProbe,
  type Preflight,
} from "./console-plane";
import type { RoleSecrets } from "./roles";
import type { Spawner } from "./spawn";

export {
  PG_APP_RO_ROLE,
  PG_APP_RW_ROLE,
  PG_DATABASE,
  PG_READONLY_ROLE,
  PG_ROLE,
  PG_SCHEMA,
} from "./cluster-roles";
import {
  PG_APP_RO_ROLE,
  PG_APP_RW_ROLE,
  PG_DATABASE,
  PG_READONLY_ROLE,
  PG_ROLE,
  PG_SCHEMA,
} from "./cluster-roles";

export interface ClusterDeps {
  spawner: Spawner;
  binDir: string;
  dataDir: string;
  /** Password for the `fortress` superuser, set at initdb time via --pwfile. */
  superPassword: string;
}

/**
 * Initialize the data directory if it has not been initialized yet.
 *
 * NEVER re-initializes an existing cluster: the `PG_VERSION` guard means a data
 * dir created by an older `--auth=trust` build is left intact (no data loss) and
 * converted in place later by `ensureAuth`. A fresh cluster is created with
 * scram-sha-256 for both local + host and the fortress superuser password seeded
 * from a 0600 temp pwfile (removed in `finally`).
 */
export async function ensureCluster(deps: ClusterDeps): Promise<void> {
  if (existsSync(path.join(deps.dataDir, "PG_VERSION"))) return;
  const pwDir = await mkdtemp(path.join(os.tmpdir(), "hx-pg-initpw-"));
  const pwFile = path.join(pwDir, "pw");
  try {
    await writeFile(pwFile, deps.superPassword, { mode: 0o600 });
    await chmod(pwFile, 0o600);
    const { code, stderr } = await deps.spawner.run([
      path.join(deps.binDir, "initdb"),
      "-D",
      deps.dataDir,
      "--encoding=UTF8",
      "--auth-local=scram-sha-256",
      "--auth-host=scram-sha-256",
      `--username=${PG_ROLE}`,
      `--pwfile=${pwFile}`,
    ]);
    if (code !== 0) throw new Error(`initdb failed: ${stderr.trim()}`);
  } finally {
    await rm(pwDir, { recursive: true, force: true });
  }
}

/** A minimal SQL surface against a running cluster. `run` executes a statement
 *  on `database`; `exists` reports whether a query returns at least one row;
 *  `query` returns rows; `runMany` executes an ORDERED batch on ONE connection
 *  as a single implicit transaction. The zonky binaries ship no `psql`, so this
 *  is backed by Bun's SQL client. */
export interface ClusterSql {
  run(database: string, statement: string): Promise<void>;
  exists(database: string, query: string): Promise<boolean>;
  query<T = Record<string, unknown>>(database: string, sql: string): Promise<T[]>;
  runMany(database: string, statements: readonly string[]): Promise<void>;
}

// The managed pg_hba.conf: loopback-only, scram-sha-256 for every role, and an
// explicit reject for any non-loopback address (defense-in-depth — the server
// also binds 127.0.0.1 only). Rewritten idempotently on every boot; the first
// hardened boot over an --auth=trust cluster is what converts it in place.
const MANAGED_PG_HBA = [
  "# Managed by hx-fortress — do not edit; rewritten idempotently on every boot.",
  "# Loopback-only + scram-sha-256 for all roles (de-superuser least-privilege).",
  "local   all   all                   scram-sha-256",
  "host    all   all   127.0.0.1/32    scram-sha-256",
  "host    all   all   ::1/128         scram-sha-256",
  "host    all   all   0.0.0.0/0       reject",
  "host    all   all   ::/0            reject",
  "",
].join("\n");

/**
 * Idempotent in-place auth hardening, run AFTER `startServer` and BEFORE
 * `ensureDbSchema`. Converts an existing `--auth=trust` cluster to scram with
 * ZERO re-init:
 *
 *   1. `ALTER ROLE fortress WITH PASSWORD …` — lands even on a still-trust
 *      cluster (the password is ignored at connect time under trust) and is a
 *      harmless re-set once scram is already in force. MUST precede the HBA
 *      rewrite so the next scram connection can authenticate.
 *   2. Overwrite `pg_hba.conf` with the managed loopback-only scram ruleset.
 *   3. Reload so the new HBA takes effect.
 *
 * A crash between (2) and (3) self-heals: both steps are idempotent and re-run
 * on the next boot, and every DSN carries the super password so a connection
 * succeeds whether the running HBA is still trust or already scram.
 */
export async function ensureAuth(
  sql: ClusterSql,
  dataDir: string,
  secrets: RoleSecrets,
  reload: () => Promise<void>,
): Promise<void> {
  // Use the always-present `postgres` database: hx-db may not exist yet (this
  // runs before ensureDbSchema), and ALTER ROLE is cluster-global regardless.
  await sql.run("postgres", `ALTER ROLE ${PG_ROLE} WITH PASSWORD ${quoteLiteral(secrets.super)}`);
  await writeFile(path.join(dataDir, "pg_hba.conf"), MANAGED_PG_HBA, { mode: 0o600 });
  await reload();
}

/** Create the hx-db database (if absent) and the hx schema (idempotent). */
export async function ensureDatabaseAndSchema(sql: ClusterSql): Promise<void> {
  const present = await sql.exists(
    "postgres",
    `SELECT 1 FROM pg_database WHERE datname = '${PG_DATABASE}'`,
  );
  if (!present) {
    await sql.run("postgres", `CREATE DATABASE "${PG_DATABASE}"`);
  }
  await sql.run(PG_DATABASE, `CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`);
}

/**
 * Build the ORDERED ensureAppRoles batch. Three phases, and the order between
 * them is load-bearing:
 *
 *   1. blanket GRANTs (roles, passwords, schema-wide DML, the command-plane
 *      apparatus) — must come first so a table created by this boot's
 *      migrations is covered;
 *   2. table-level REVOKEs — must come after (1), because a REVOKE issued
 *      before the blanket GRANT is simply re-granted a statement later;
 *   3. COLUMN-level GRANTs — must come after (2), because a Postgres REVOKE on
 *      a table AUTOMATICALLY revokes that table's column privileges, so a
 *      column grant issued earlier is wiped and the daemon ends the boot unable
 *      to arm, extend or clear an ingest pause at all.
 *
 * Exported for tests: the phase order, and the absence of any statement that
 * would be illegal here, are assertable without a live cluster.
 */
export function appRoleStatements(args: {
  secrets: RoleSecrets;
  staleDrops: readonly string[];
  uiExtras: readonly string[];
  views: readonly string[];
}): string[] {
  const { secrets } = args;
  return [
    // Phase 0 — retire any overload left behind by a widened signature before
    // the CREATEs run, so the pinned set is the only one that survives.
    ...args.staleDrops,

    // ── Phase 1 · blanket GRANTs ──────────────────────────────────────────
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_APP_RO_ROLE}') THEN
    CREATE ROLE ${PG_APP_RO_ROLE} LOGIN IN ROLE ${PG_READONLY_ROLE};
  END IF;
END $$`,
    `ALTER ROLE ${PG_APP_RO_ROLE} WITH PASSWORD ${quoteLiteral(secrets.appRo)}`,
    // Idempotent even if the role pre-existed without the membership.
    `GRANT ${PG_READONLY_ROLE} TO ${PG_APP_RO_ROLE}`,
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_APP_RW_ROLE}') THEN
    CREATE ROLE ${PG_APP_RW_ROLE} LOGIN;
  END IF;
END $$`,
    `ALTER ROLE ${PG_APP_RW_ROLE} WITH PASSWORD ${quoteLiteral(secrets.appRw)}`,
    `GRANT USAGE ON SCHEMA ${PG_SCHEMA} TO ${PG_APP_RW_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PG_SCHEMA} TO ${PG_APP_RW_ROLE}`,
    `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${PG_SCHEMA} TO ${PG_APP_RW_ROLE}`,
    // Future tables/sequences created by later migrations (which run as fortress)
    // inherit the same grants.
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${PG_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${PG_APP_RW_ROLE}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${PG_SCHEMA} GRANT USAGE ON SEQUENCES TO ${PG_APP_RW_ROLE}`,
    ...apparatusStatements(),
    ...uiRoleStatements(secrets.ui),

    // ── Phase 2 · table-level REVOKEs ─────────────────────────────────────
    // The migration journal is the migration runner's ledger (written only by
    // the superuser DSN), so the app DML role has no business writing it. The
    // blanket ALL-TABLES grant above covers it, so take the writes back.
    `REVOKE INSERT, UPDATE, DELETE ON ${PG_SCHEMA}.schema_migrations FROM ${PG_APP_RW_ROLE}`,
    ...revokeStatements(args.uiExtras, args.views),

    // ── Phase 3 · column-level GRANTs ─────────────────────────────────────
    ...columnGrantStatements(),
  ];
}

/**
 * Idempotently provision the login roles and the command-plane apparatus, run
 * AFTER `migrate` (so the blanket schema grants cover every table this boot
 * created):
 *
 *   • hx_app_ro    — LOGIN, member of hx_readonly (schema-wide SELECT from 0005).
 *   • hx_app_rw    — LOGIN, schema DML, no DDL, no superuser; the daemon's only
 *                    write role and the one reachable from the cloud, so it is
 *                    fenced out of the console tables.
 *   • hx_cmd_owner — NOLOGIN owner of the transition routines.
 *   • hx_ui        — LOGIN console role; the only minter of commands.
 *
 * The WHOLE ordered block runs on ONE connection as ONE simple-query batch, so
 * it is one implicit transaction: statement-per-connection autocommit would let
 * a crash between a CREATE FUNCTION and its `REVOKE EXECUTE … FROM PUBLIC`
 * leave PUBLIC durably able to drive the machine, or a crash between the
 * blanket GRANT and the console REVOKEs leave the cloud-reachable role able to
 * mint command rows until the next boot. Bun.SQL rejects explicit BEGIN/COMMIT
 * on a pooled connection, so the batch path is the only way to get atomicity.
 */
export async function ensureAppRoles(sql: ClusterSql, secrets: RoleSecrets): Promise<void> {
  // ONE catalog read, then ONE batch — the reads decide which statements the
  // batch carries, and boot has a second for the whole of role provisioning.
  const [preflight] = await sql.query<Preflight>(PG_DATABASE, preflightQuery());
  await sql.runMany(
    PG_DATABASE,
    appRoleStatements({
      secrets,
      staleDrops: staleOverloadDrops(preflight?.routines ?? []),
      uiExtras: (preflight?.extras ?? []).map((r) => r.name),
      views: (preflight?.views ?? []).map((r) => r.name),
    }),
  );
}

/** Verify the D14 ownership invariants after provisioning. Reported rather than
 *  thrown: the apparatus has just been re-applied, so a violation here means
 *  something is actively rewriting the catalog underneath us, and bricking the
 *  boot would take ingest down with it. */
export async function auditConsolePlane(sql: ClusterSql): Promise<string[]> {
  const rows = await sql.query<OwnershipProbe>(PG_DATABASE, ownershipProbeQuery());
  const probe = rows[0];
  if (!probe) return ["ownership probe returned no rows"];
  return ownershipViolations(probe);
}
