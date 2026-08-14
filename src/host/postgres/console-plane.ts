// The D13/D14/D16 command-plane apparatus: the one-way console_commands state
// machine, its NOLOGIN owner role, the console login role, and the per-table
// privilege matrix that makes the machine unbypassable.
//
// EMBEDDED POSTGRES ONLY. On an external DSN both fortress roles resolve to the
// operator's single URL, which OWNS the tables — an owner cannot be constrained
// by REVOKE and bypasses any SECURITY DEFINER routine with direct DML — so the
// apparatus is never created there and console mutations run as plain DML.
//
// Everything here is emitted as STATEMENT TEXT rather than executed: the whole
// ordered block runs as ONE simple-query batch (one implicit transaction), so a
// crash can never leave `PUBLIC` holding EXECUTE on a transition routine, nor
// the cloud-reachable write role holding the INSERT the REVOKE was about to
// take away.

import { PG_APP_RO_ROLE, PG_APP_RW_ROLE, PG_READONLY_ROLE, PG_SCHEMA } from "./cluster-roles";

/** NOLOGIN, non-superuser owner of the five transition routines. Deliberately
 *  NOT the initdb superuser: a SECURITY DEFINER routine runs with its owner's
 *  rights, and a superuser-owned one would turn any body defect into a
 *  full-cluster escalation. Holds nothing beyond the grant set below, and is
 *  never GRANTed to anyone (asserted: pg_auth_members carries no row for it). */
export const PG_CMD_OWNER_ROLE = "hx_cmd_owner";

/** LOGIN role the console process authenticates as. The ONLY role that may mint
 *  console_commands rows and the only one that may write admin_audit. */
export const PG_UI_ROLE = "hx_ui";

/** The console command kinds — FINAL and complete: every kind already has its
 *  named executor. Consuming tasks USE this allowlist; none extends it.
 *
 *  `revoke_session` is deliberately NOT here: session revocation is in-process
 *  plus the users.json global epoch, never a command row (a row would make
 *  revocation depend on a Postgres the console must survive losing). */
export const CONSOLE_COMMAND_KINDS = [
  "update_apply",
  "rotate_credentials",
  "run_migration",
  "run_checkup",
  "self_test",
  "run_audit",
  "witness_toggle",
  "acknowledge_finding",
] as const;

export type ConsoleCommandKind = (typeof CONSOLE_COMMAND_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(CONSOLE_COMMAND_KINDS);

export function isConsoleCommandKind(value: unknown): value is ConsoleCommandKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/** Every relation the console plane owns. The privilege matrix is asserted over
 *  exactly these, and each one a later migration adds joins the list here: the
 *  cloud-served read roles are REVOKEd from all of them, so a table left off is
 *  a table 0005's default privileges quietly hand to hx_readonly. */
export const CONSOLE_TABLES = [
  "console_commands",
  "ingest_control",
  "admin_audit",
  "audit_acks",
  "audit_settings",
  "audit_runs",
  "audit_findings",
  "roster",
  "roster_sync",
  "migration_runs",
  "migration_objects",
] as const;

/** ingest_control columns hx_app_rw may write. `row_written_at` is EXCLUDED:
 *  it is the clamp anchor that bounds how long a pause can hold the store-write
 *  gate closed, so the role that arms a pause must not be able to set it. */
export const INGEST_CONTROL_INSERT_COLUMNS = ["paused_until", "reason", "armed_by"] as const;
export const INGEST_CONTROL_UPDATE_COLUMNS = ["paused_until", "reason", "resumed_at"] as const;
/** The anchor column, named for the assertions that must prove it unreachable. */
export const INGEST_CONTROL_ANCHOR_COLUMN = "row_written_at";

/** hx.sessions columns the console may read. Transcript text
 *  (last_user_text / last_assistant_text) is EXCLUDED: the console renders
 *  metadata and counts, and a console compromise must not become a transcript
 *  disclosure. Granted at COLUMN level — a table-level SELECT would include the
 *  two excluded columns. */
export const UI_SESSION_COLUMNS = [
  "id",
  "user_id",
  "device_id",
  "org_id",
  "project_id",
  "repo_id",
  "model_id",
  "family",
  "session_id",
  "ccd_session_id",
  "title",
  "title_source",
  "source_path",
  "cwd",
  "git_branch",
  "entrypoint",
  "originator",
  "session_origin",
  "attribution_source",
  "ingest_channel",
  "assigned_at",
  "assigned_by",
  "event_count",
  "user_text_count",
  "assistant_count",
  "tool_call_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "est_cost_usd",
  "bytes_uploaded",
  "chunk_count",
  "first_event_at",
  "last_activity_at",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

/** hx.embeddings columns the console may read. The VECTOR is excluded, and so
 *  is `content_hash`: an embedding is a lossy encoding of the transcript it was
 *  computed from, and a hash of that text is a membership oracle over it. The
 *  console renders coverage — how many turns are embedded, under which model —
 *  and coverage needs neither. */
export const UI_EMBEDDING_COLUMNS = [
  "id",
  "owner_kind",
  "owner_id",
  "model",
  "dim",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

/** The dimension and fact tables the console reads whole. Every one of them is
 *  metadata by construction — names, ids, counts, timestamps — so a table-level
 *  SELECT discloses nothing a column grant would withhold. hx.turns,
 *  hx.tool_calls and hx.session_agents are absent, and stay absent: those ARE
 *  the transcript. */
export const UI_READ_TABLES = [
  "users",
  "orgs",
  "projects",
  "repos",
  "devices",
  "models",
  "session_facts",
  "deleted_sessions",
] as const;

/** Views hx_ui may read. EMPTY by construction: hx.v_turn_search is an
 *  owner-rights view over transcript turns, which would hand the console
 *  exactly the text the column-level grant above withholds. Any future view
 *  over sessions/turns stays denied unless it is added here deliberately. */
export const UI_VIEW_ALLOWLIST: readonly string[] = [];

/** The table-level grants hx_ui holds, enumerated so extras can be detected and
 *  revoked. hx.sessions is absent on purpose — it is column-level only. */
export const UI_TABLE_GRANTS: ReadonlyArray<{ table: string; privileges: readonly string[] }> = [
  // Minting a command is the console's one write into the machine; the daemon
  // may only transition rows, through the routines.
  { table: "console_commands", privileges: ["SELECT", "INSERT"] },
  // The audit drain runs as hx_ui — including the daemon's own origin:system
  // records, which reach Postgres through the 0600 spool rather than a grant.
  { table: "admin_audit", privileges: ["SELECT", "INSERT"] },
  { table: "ingest_control", privileges: ["SELECT"] },
  { table: "audit_acks", privileges: ["SELECT"] },
  { table: "audit_settings", privileges: ["SELECT"] },
  // The audit engine's own record. The console renders the history and every
  // finding in it; the daemon writes both, so hx_ui reads and never writes.
  { table: "audit_runs", privileges: ["SELECT"] },
  { table: "audit_findings", privileges: ["SELECT"] },
  // The organization's people, as let.ai reports them. The daemon receives the
  // sync and writes it; the console renders adoption and never edits a roster —
  // a roster this host could edit would be a directory that disagrees with the
  // organization's own.
  { table: "roster", privileges: ["SELECT"] },
  { table: "roster_sync", privileges: ["SELECT"] },
  // The storage migration's record. The daemon runs the move and writes both;
  // the console renders the run and its progress.
  { table: "migration_runs", privileges: ["SELECT"] },
  { table: "migration_objects", privileges: ["SELECT"] },
  // The console's own read surface: sessions are column-level (below), and
  // everything the session rows point AT is metadata the console renders by
  // name — a person, a device, a repository, a project.
  ...UI_READ_TABLES.map((table) => ({ table, privileges: ["SELECT"] as readonly string[] })),
];

// ── The five SECURITY DEFINER routines ───────────────────────────────────────

export interface ConsoleRoutine {
  name: string;
  /** Argument types exactly as pg_get_function_identity_arguments renders them —
   *  the key CREATE OR REPLACE is matched on, and therefore the signature the
   *  stale-overload sweep pins. */
  identityArguments: string;
  returnType: string;
  createSql: string;
}

const CLAIM_COMMAND = `
CREATE OR REPLACE FUNCTION hx.claim_command(p_id uuid, p_claimed_by text, p_redrive boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $claim_command$
DECLARE
  v_rows integer;
BEGIN
  -- requested -> running, or a re-drive of a row this daemon already had in
  -- flight when it died. The caller ASSERTS the re-drive; which running rows
  -- qualify is decided by a daemon-only file SQL cannot see, so no id-string
  -- predicate here could be trusted. A future requested_at is refused at claim,
  -- so a row minted with a distant timestamp is never picked up early.
  UPDATE hx.console_commands
     SET status = 'running',
         claimed_by = p_claimed_by,
         claimed_at = pg_catalog.now()
   WHERE id = p_id
     AND requested_at <= pg_catalog.now()
     AND (status = 'requested' OR (status = 'running' AND p_redrive IS TRUE));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$claim_command$;`;

const COMPLETE_COMMAND = `
CREATE OR REPLACE FUNCTION hx.complete_command(p_id uuid, p_status text, p_outcome text, p_error text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $complete_command$
DECLARE
  v_rows integer;
BEGIN
  IF p_status IS DISTINCT FROM 'done' AND p_status IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'console command terminal status must be done or failed';
  END IF;
  -- running -> terminal only. A terminal row is final: no argument shape can
  -- move it anywhere, which is what makes an outcome durable evidence.
  UPDATE hx.console_commands
     SET status = p_status,
         outcome = p_outcome,
         error = p_error,
         completed_at = pg_catalog.now()
   WHERE id = p_id
     AND status = 'running';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$complete_command$;`;

const REJECT_COMMAND = `
CREATE OR REPLACE FUNCTION hx.reject_command(p_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $reject_command$
DECLARE
  v_rows integer;
BEGIN
  -- Non-terminal -> rejected. The boot fence drives this for every row the
  -- daemon cannot prove it was executing, so it must accept both requested and
  -- running; it must still refuse to reopen anything already terminal.
  UPDATE hx.console_commands
     SET status = 'rejected',
         error = p_reason,
         completed_at = pg_catalog.now()
   WHERE id = p_id
     AND (status = 'requested' OR status = 'running');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$reject_command$;`;

const ACKNOWLEDGE_FINDING = `
CREATE OR REPLACE FUNCTION hx.acknowledge_finding(p_org text, p_session_id text, p_by text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $acknowledge_finding$
BEGIN
  -- FENCED on a real finding. Without this the routine is a bulk-acknowledge
  -- primitive for anyone holding the hx_app_rw DSN: one
  -- SELECT hx.acknowledge_finding(...) FROM hx.sessions clears every present
  -- and future also_at_letai in the organization, with no hx.admin_audit row,
  -- because the trail is written by the daemon's own spool and not by this
  -- function. That is the outcome the console's own comment says is prevented.
  --
  -- Only also_at_letai is acknowledgeable — the TypeScript already says so, in
  -- acknowledgeable() — and this is that rule where the privilege boundary
  -- can enforce it: a session with no such finding cannot be acknowledged at
  -- all, so the blast radius is what an audit actually found rather than the
  -- whole session table.
  IF NOT EXISTS (
    SELECT 1
      FROM hx.audit_findings f
     WHERE f.org = p_org
       AND f.session_id = p_session_id
       AND f.verdict = 'also_at_letai'
  ) THEN
    RAISE EXCEPTION 'no acknowledgeable finding for % / %', p_org, p_session_id
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO hx.audit_acks (org, session_id, acknowledged_at, acknowledged_by, reason)
  VALUES (p_org, p_session_id, pg_catalog.now(), p_by, p_reason)
  ON CONFLICT (org, session_id) DO UPDATE
     SET acknowledged_at = pg_catalog.now(),
         acknowledged_by = p_by,
         reason = p_reason;
  RETURN true;
END;
$acknowledge_finding$;`;

const SET_CLOUD_WITNESS = `
CREATE OR REPLACE FUNCTION hx.set_cloud_witness(p_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $set_cloud_witness$
BEGIN
  -- Stamped, so a flip is visible. This routine cannot tell the daemon from
  -- anything else holding the same DSN — both are hx_app_rw — so prevention is
  -- not available here; what is available is that turning outbound disclosure
  -- back on for an operator who switched it off can no longer happen without a
  -- trace the console reads.
  -- ONE statement, on the singleton key 0027 added. The read-modify-write this
  -- replaces (UPDATE, then INSERT if it matched nothing) had no uniqueness
  -- underneath it, so two concurrent flips left two rows with different stamps
  -- and the reader picks one at random with its unordered LIMIT 1 — destroying
  -- the very accountability the paragraph above says is the whole control.
  INSERT INTO hx.audit_settings (singleton, cloud_witness, changed_at, changed_by)
  VALUES (true, p_enabled, pg_catalog.now(), session_user)
      ON CONFLICT (singleton) DO UPDATE
     SET cloud_witness = EXCLUDED.cloud_witness,
         changed_at = EXCLUDED.changed_at,
         changed_by = EXCLUDED.changed_by;
  RETURN p_enabled;
END;
$set_cloud_witness$;`;

/** The five routines, in creation order. ALL of them live here rather than in a
 *  migration: a routine created by a migration would abort the upgrade on an
 *  external Postgres (its OWNER TO needs a membership a limited operator role
 *  lacks) and, because the journal is name-keyed, could never be corrected. */
export const CONSOLE_ROUTINES: readonly ConsoleRoutine[] = [
  {
    name: "claim_command",
    identityArguments: "p_id uuid, p_claimed_by text, p_redrive boolean",
    returnType: "boolean",
    createSql: CLAIM_COMMAND,
  },
  {
    name: "complete_command",
    identityArguments: "p_id uuid, p_status text, p_outcome text, p_error text",
    returnType: "boolean",
    createSql: COMPLETE_COMMAND,
  },
  {
    name: "reject_command",
    identityArguments: "p_id uuid, p_reason text",
    returnType: "boolean",
    createSql: REJECT_COMMAND,
  },
  {
    name: "acknowledge_finding",
    identityArguments: "p_org text, p_session_id text, p_by text, p_reason text",
    returnType: "boolean",
    createSql: ACKNOWLEDGE_FINDING,
  },
  {
    name: "set_cloud_witness",
    identityArguments: "p_enabled boolean",
    returnType: "boolean",
    createSql: SET_CLOUD_WITNESS,
  },
];

/** `hx.name(argtypes)` — the form DROP FUNCTION and has_function_privilege take. */
export function routineSignature(routine: ConsoleRoutine): string {
  const types = routine.identityArguments
    .split(",")
    .map((a) => a.trim().split(/\s+/).slice(1).join(" "))
    .join(", ");
  return `${PG_SCHEMA}.${routine.name}(${types})`;
}

// ── Phase 1 · the apparatus ──────────────────────────────────────────────────

/**
 * CREATE ROLE (DO-guarded) → CREATE OR REPLACE FUNCTION ×5 → OWNER TO →
 * REVOKE EXECUTE FROM PUBLIC → GRANT EXECUTE TO the daemon role → the owner's
 * schema USAGE and table DML.
 *
 * The REVOKE follows each CREATE immediately because Postgres grants EXECUTE to
 * PUBLIC by default: without it hx_ui and the cloud-served read role could drive
 * the machine and fabricate a completed rotation.
 *
 * The `GRANT EXECUTE … TO hx_app_rw` is issued HERE, every boot, and never by a
 * migration: migrate() runs first, so on a fresh cluster the role does not exist
 * yet, and a name-keyed journal would never re-apply the statement afterwards —
 * a failure invisible on any environment that reached this code as an upgrade.
 */
export function apparatusStatements(): string[] {
  const out: string[] = [
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_CMD_OWNER_ROLE}') THEN
    CREATE ROLE ${PG_CMD_OWNER_ROLE} NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
  END IF;
END $$`,
  ];
  for (const routine of CONSOLE_ROUTINES) {
    const signature = routineSignature(routine);
    out.push(routine.createSql.trim().replace(/;$/, ""));
    // Immediately, in the same transaction as the CREATE.
    out.push(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC`);
    out.push(`ALTER FUNCTION ${signature} OWNER TO ${PG_CMD_OWNER_ROLE}`);
    out.push(`GRANT EXECUTE ON FUNCTION ${signature} TO ${PG_APP_RW_ROLE}`);
  }
  // Exhaustive, and pinned by a boot assertion. Without the schema USAGE every
  // SECURITY DEFINER body fails "permission denied for schema hx" — schema
  // access is granted per-role explicitly here, never inherited.
  out.push(
    `GRANT USAGE ON SCHEMA ${PG_SCHEMA} TO ${PG_CMD_OWNER_ROLE}`,
    // No INSERT on console_commands: minting stays with the console alone.
    `GRANT SELECT, UPDATE ON ${PG_SCHEMA}.console_commands TO ${PG_CMD_OWNER_ROLE}`,
    // SELECT is not optional on either fenced table: both routines are
    // read-modify-write, and Postgres requires SELECT for a nontrivial UPDATE.
    // audit_findings below is a third table, read by the acknowledge fence.
    `GRANT SELECT, INSERT, UPDATE ON ${PG_SCHEMA}.audit_acks TO ${PG_CMD_OWNER_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE ON ${PG_SCHEMA}.audit_settings TO ${PG_CMD_OWNER_ROLE}`,
    // And SELECT on audit_findings, because the acknowledge fence READS it: an
    // acknowledgement is refused unless a matching also_at_letai finding exists,
    // which is what stops the routine being a bulk-acknowledge primitive. The
    // owner is NOLOGIN with no memberships, so nothing supplies this implicitly
    // and every acknowledgement raised 42501 without it.
    `GRANT SELECT ON ${PG_SCHEMA}.audit_findings TO ${PG_CMD_OWNER_ROLE}`,
  );
  return out;
}

/** The exhaustive hx_cmd_owner table grants, for the D14 assertion. */
export const CMD_OWNER_TABLE_GRANTS: ReadonlyArray<{ table: string; privileges: readonly string[] }> = [
  { table: "console_commands", privileges: ["SELECT", "UPDATE"] },
  { table: "audit_acks", privileges: ["SELECT", "INSERT", "UPDATE"] },
  { table: "audit_settings", privileges: ["SELECT", "INSERT", "UPDATE"] },
  { table: "audit_findings", privileges: ["SELECT"] },
];

/** hx_ui provisioning: LOGIN, no memberships, no default privileges, and only
 *  the enumerated table grants. Membership is withheld deliberately — hx_app_ro
 *  is `IN ROLE hx_readonly`, so "the catalog has no membership rows" is false by
 *  construction and the assertion has to be hx_ui-specific. */
export function uiRoleStatements(password: string): string[] {
  return [
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_UI_ROLE}') THEN
    CREATE ROLE ${PG_UI_ROLE} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
  END IF;
END $$`,
    `ALTER ROLE ${PG_UI_ROLE} WITH PASSWORD ${quoteLiteral(password)}`,
    `GRANT USAGE ON SCHEMA ${PG_SCHEMA} TO ${PG_UI_ROLE}`,
    ...UI_TABLE_GRANTS.map(
      (g) => `GRANT ${g.privileges.join(", ")} ON ${PG_SCHEMA}.${g.table} TO ${PG_UI_ROLE}`,
    ),
  ];
}

/**
 * Wrap a statement so it runs only where `hx.embeddings` exists.
 *
 * That table is pgvector-gated: migration 0006 declares `requires: "vector"`,
 * and the runner SKIPS it — deliberately, retrying on a later boot — on a
 * cluster whose bundle does not package the extension. The whole ensureAppRoles
 * block is ONE simple-query batch and therefore ONE transaction, so a bare
 * statement naming the missing table does not just fail itself: it aborts role
 * provisioning entirely, and the fortress comes up with no login roles at all.
 */
function whereEmbeddingsExist(statement: string): string {
  return `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = '${PG_SCHEMA}' AND c.relname = 'embeddings'
  ) THEN
    EXECUTE ${quoteLiteral(statement)};
  END IF;
END $$`;
}

// ── Phase 2 · table-level REVOKEs ────────────────────────────────────────────

/**
 * Everything the every-boot blanket `GRANT … ON ALL TABLES` and 0005's
 * `ALTER DEFAULT PRIVILEGES` hand out that the console plane must take back.
 * Privileges in Postgres are ADDITIVE: a column-level grant cannot subtract
 * from a table-level one, so the table-level REVOKE has to happen before the
 * column grants — and it has to happen after the blanket GRANT, or the next
 * boot's GRANT simply restores it.
 */
export function revokeStatements(uiExtras: readonly string[] = [], views: readonly string[] = []): string[] {
  const out: string[] = [];
  // The cloud-reachable write role must not mint commands or forge audit rows.
  out.push(
    `REVOKE INSERT, UPDATE, DELETE ON ${PG_SCHEMA}.console_commands FROM ${PG_APP_RW_ROLE}`,
    `REVOKE INSERT, UPDATE, DELETE ON ${PG_SCHEMA}.admin_audit FROM ${PG_APP_RW_ROLE}`,
    `REVOKE INSERT, UPDATE, DELETE ON ${PG_SCHEMA}.audit_acks FROM ${PG_APP_RW_ROLE}`,
    `REVOKE INSERT, UPDATE, DELETE ON ${PG_SCHEMA}.audit_settings FROM ${PG_APP_RW_ROLE}`,
  );
  // DELETE stays revoked on ingest_control permanently: delete + re-INSERT would
  // mint a fresh anchor and restore exactly the unbounded pause the clamp bounds.
  out.push(`REVOKE INSERT, UPDATE, DELETE ON ${PG_SCHEMA}.ingest_control FROM ${PG_APP_RW_ROLE}`);
  for (const role of [PG_READONLY_ROLE, PG_APP_RO_ROLE]) {
    for (const table of CONSOLE_TABLES) {
      out.push(`REVOKE ALL ON ${PG_SCHEMA}.${table} FROM ${role}`);
    }
  }
  // Clear any table-level SELECT on hx.sessions before the column grants below —
  // a table-level grant would include the two transcript-text columns. Same for
  // hx.embeddings, whose vector column encodes the text those columns hold.
  out.push(`REVOKE ALL ON ${PG_SCHEMA}.sessions FROM ${PG_UI_ROLE}`);
  out.push(whereEmbeddingsExist(`REVOKE ALL ON ${PG_SCHEMA}.embeddings FROM ${PG_UI_ROLE}`));
  // Views are owner-rights and can read straight past a column grant, so the
  // console is denied every one that is not deliberately allowlisted.
  for (const view of views) {
    if (UI_VIEW_ALLOWLIST.includes(view)) continue;
    out.push(`REVOKE ALL ON ${PG_SCHEMA}.${quoteIdentifier(view)} FROM ${PG_UI_ROLE}`);
  }
  // Anything hx_ui holds beyond the allowlist, enumerated from the catalog.
  for (const relation of uiExtras) {
    out.push(`REVOKE ALL ON ${PG_SCHEMA}.${quoteIdentifier(relation)} FROM ${PG_UI_ROLE}`);
  }
  return out;
}

// ── Phase 3 · column-level GRANTs ───────────────────────────────────────────

/** Issued LAST. A REVOKE on a table automatically revokes that table's COLUMN
 *  privileges, so a column grant emitted before phase 2 is wiped and the daemon
 *  ends the boot unable to arm, extend or clear a pause at all. */
export function columnGrantStatements(): string[] {
  return [
    `GRANT INSERT (${INGEST_CONTROL_INSERT_COLUMNS.join(", ")}) ON ${PG_SCHEMA}.ingest_control TO ${PG_APP_RW_ROLE}`,
    `GRANT UPDATE (${INGEST_CONTROL_UPDATE_COLUMNS.join(", ")}) ON ${PG_SCHEMA}.ingest_control TO ${PG_APP_RW_ROLE}`,
    `GRANT SELECT (${UI_SESSION_COLUMNS.join(", ")}) ON ${PG_SCHEMA}.sessions TO ${PG_UI_ROLE}`,
    whereEmbeddingsExist(
      `GRANT SELECT (${UI_EMBEDDING_COLUMNS.join(", ")}) ON ${PG_SCHEMA}.embeddings TO ${PG_UI_ROLE}`,
    ),
  ];
}

// ── Stale-overload sweep ─────────────────────────────────────────────────────

/** CREATE OR REPLACE is keyed on name + argument types, so widening a signature
 *  leaves the OLD overload alive — still owned, still EXECUTE-granted, still
 *  enforcing the previous state machine, and invisible to a by-name ownership
 *  assertion. Enumerate ALL FIVE names; a four-name sweep leaves a stale
 *  set_cloud_witness overload behind, which is the same hazard. */
export function staleOverloadQuery(): string {
  const names = CONSOLE_ROUTINES.map((r) => `'${r.name}'`).join(", ");
  return `SELECT p.proname AS name,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
       pg_catalog.format_type(p.prorettype, NULL) AS rettype
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = '${PG_SCHEMA}' AND p.proname IN (${names})`;
}

export interface CatalogRoutine {
  name: string;
  args: string;
  rettype: string;
}

/** DROP for every enumerated routine whose signature is not the pinned one. A
 *  differing RETURN type counts too: CREATE OR REPLACE cannot change it, so
 *  leaving such a function in place would fail the next boot's whole batch. */
export function staleOverloadDrops(found: readonly CatalogRoutine[]): string[] {
  const pinned = new Map(
    CONSOLE_ROUTINES.map((r) => [r.name, { args: identityTypes(r.identityArguments), ret: r.returnType }]),
  );
  const drops: string[] = [];
  for (const row of found) {
    const want = pinned.get(row.name);
    if (!want) continue;
    const args = normalizeArgs(row.args);
    if (args === want.args && row.rettype === want.ret) continue;
    // Catalog-sourced, but keep the interpolation provably inert.
    if (!/^[a-z0-9_ ,[\]"]*$/i.test(row.args)) continue;
    drops.push(`DROP FUNCTION IF EXISTS ${PG_SCHEMA}.${row.name}(${row.args})`);
  }
  return drops;
}

function identityTypes(identityArguments: string): string {
  return normalizeArgs(
    identityArguments
      .split(",")
      .map((a) => a.trim().split(/\s+/).slice(1).join(" "))
      .join(", "),
  );
}

function normalizeArgs(args: string): string {
  return args
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
    .join(",");
}

/**
 * Everything ensureAppRoles has to read BEFORE it can build its batch, in ONE
 * round trip: the boot budget for role provisioning is a second, and the batch
 * itself is already one connection — three separate catalog reads in front of
 * it would be three more connect/auth cycles for no reason.
 */
export function preflightQuery(): string {
  return `SELECT
  (SELECT coalesce(json_agg(r), '[]'::json) FROM (${staleOverloadQuery()}) r) AS routines,
  (SELECT coalesce(json_agg(e), '[]'::json) FROM (${uiExtraGrantsQuery()}) e) AS extras,
  (SELECT coalesce(json_agg(v), '[]'::json) FROM (${schemaViewsQuery()}) v) AS views`;
}

export interface Preflight {
  routines: CatalogRoutine[];
  extras: { name: string }[];
  views: { name: string }[];
}

/** Relations (tables + views) hx_ui holds a privilege on that the allowlist does
 *  not cover — the enumerate-extras-to-revoke sweep. information_schema is used
 *  ONLY here; every assertion uses the inheritance-aware has_*_privilege(). */
export function uiExtraGrantsQuery(): string {
  const allowed = [...UI_TABLE_GRANTS.map((g) => g.table), "sessions", "embeddings"]
    .map((t) => `'${t}'`)
    .join(", ");
  return `SELECT DISTINCT table_name AS name
  FROM information_schema.table_privileges
 WHERE grantee = '${PG_UI_ROLE}' AND table_schema = '${PG_SCHEMA}'
   AND table_name NOT IN (${allowed})
UNION
SELECT DISTINCT table_name AS name
  FROM information_schema.column_privileges
 WHERE grantee = '${PG_UI_ROLE}' AND table_schema = '${PG_SCHEMA}'
   AND table_name NOT IN (${allowed})`;
}

/** Every view in the hx schema — the deny sweep's input. */
export function schemaViewsQuery(): string {
  return `SELECT table_name AS name FROM information_schema.views WHERE table_schema = '${PG_SCHEMA}'`;
}

// ── D14 ownership invariants ────────────────────────────────────────────────

export interface OwnershipProbe {
  routinesOwnedByCmdOwner: number;
  routineCount: number;
  ownerIsSafe: boolean;
  ownerMembershipRows: number;
  cmdOwnerGrantsMatch: boolean;
  uiMembershipRows: number;
  publicExecuteCount: number;
  searchPathPinned: number;
}

/** One round trip that proves every D14 invariant at once: the five routines are
 *  owned by hx_cmd_owner, that role is NOLOGIN/NOSUPERUSER/NOCREATEROLE/
 *  NOBYPASSRLS, nothing is a member of it (and it is a member of nothing),
 *  hx_ui holds no membership at all, PUBLIC holds no EXECUTE, and every routine
 *  pins its search_path. */
export function ownershipProbeQuery(): string {
  const names = CONSOLE_ROUTINES.map((r) => `'${r.name}'`).join(", ");
  // Built as VALUES rows directly: a routine signature contains ", " itself,
  // so splitting a joined string back apart would tear the argument lists.
  const signatureRows = CONSOLE_ROUTINES.map((r) => `('${routineSignature(r)}')`).join(", ");
  const grantChecks = CMD_OWNER_TABLE_GRANTS.flatMap((g) =>
    ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].map((p) => {
      const expected = g.privileges.includes(p) ? "true" : "false";
      return `pg_catalog.has_table_privilege('${PG_CMD_OWNER_ROLE}', '${PG_SCHEMA}.${g.table}', '${p}') = ${expected}`;
    }),
  ).join(" AND ");
  return `SELECT
  (SELECT count(*)::int FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = '${PG_SCHEMA}' AND p.proname IN (${names})
      AND pg_catalog.pg_get_userbyid(p.proowner) = '${PG_CMD_OWNER_ROLE}') AS "routinesOwnedByCmdOwner",
  (SELECT count(*)::int FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = '${PG_SCHEMA}' AND p.proname IN (${names})) AS "routineCount",
  (SELECT coalesce(bool_and(NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolbypassrls), false)
     FROM pg_catalog.pg_roles WHERE rolname = '${PG_CMD_OWNER_ROLE}') AS "ownerIsSafe",
  (SELECT count(*)::int FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${PG_CMD_OWNER_ROLE}')
       OR m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${PG_CMD_OWNER_ROLE}')) AS "ownerMembershipRows",
  (SELECT ${grantChecks}) AS "cmdOwnerGrantsMatch",
  (SELECT count(*)::int FROM pg_catalog.pg_auth_members m
    WHERE m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${PG_UI_ROLE}')
       OR m.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${PG_UI_ROLE}')) AS "uiMembershipRows",
  (SELECT count(*)::int FROM (VALUES ${signatureRows}) AS s(sig)
    WHERE pg_catalog.has_function_privilege('public', s.sig, 'EXECUTE')) AS "publicExecuteCount",
  (SELECT count(*)::int FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = '${PG_SCHEMA}' AND p.proname IN (${names})
      AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) AS "searchPathPinned"`;
}

/** Human-readable violations of the ownership probe, or [] when it all holds. */
export function ownershipViolations(probe: OwnershipProbe): string[] {
  const bad: string[] = [];
  const expected = CONSOLE_ROUTINES.length;
  if (probe.routineCount !== expected) bad.push(`expected ${expected} transition routines, found ${probe.routineCount}`);
  if (probe.routinesOwnedByCmdOwner !== expected) {
    bad.push(`only ${probe.routinesOwnedByCmdOwner}/${expected} routines are owned by ${PG_CMD_OWNER_ROLE}`);
  }
  if (!probe.ownerIsSafe) bad.push(`${PG_CMD_OWNER_ROLE} is not NOLOGIN/NOSUPERUSER/NOCREATEROLE/NOBYPASSRLS`);
  if (probe.ownerMembershipRows !== 0) bad.push(`${PG_CMD_OWNER_ROLE} appears in pg_auth_members`);
  if (!probe.cmdOwnerGrantsMatch) bad.push(`${PG_CMD_OWNER_ROLE} table grants differ from the pinned set`);
  if (probe.uiMembershipRows !== 0) bad.push(`${PG_UI_ROLE} holds a role membership`);
  if (probe.publicExecuteCount !== 0) bad.push(`PUBLIC holds EXECUTE on ${probe.publicExecuteCount} transition routine(s)`);
  if (probe.searchPathPinned !== expected) bad.push(`only ${probe.searchPathPinned}/${expected} routines pin search_path`);
  return bad;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Single-quote doubling for a SQL string literal. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Double-quote doubling for a SQL identifier taken from the catalog. */
export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
