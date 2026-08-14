// The per-table privilege matrix for the console plane, as data plus the single
// query that proves it against a live cluster.
//
// Every assertion goes through has_table_privilege / has_column_privilege /
// has_function_privilege, which are INHERITANCE-AWARE: hx_app_ro is a member of
// hx_readonly, so a catalog-scan assertion would report "no direct grant" for a
// role that can in fact read the table. information_schema is used in exactly
// one place — enumerating extras to revoke — and never to assert.
//
// EMBEDDED ONLY. An external Postgres has no role split at all: both fortress
// handles resolve to the operator's DSN and the tables are owned by it, so every
// expectation below is false by construction there and the external CI job
// carries its own honest assertion set instead.

import { PG_APP_RO_ROLE, PG_APP_RW_ROLE, PG_READONLY_ROLE, PG_SCHEMA } from "./cluster-roles";
import {
  CONSOLE_ROUTINES,
  CONSOLE_TABLES,
  INGEST_CONTROL_ANCHOR_COLUMN,
  PG_UI_ROLE,
  UI_READ_TABLES,
  routineSignature,
} from "./console-plane";

const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

interface TableExpectation {
  role: string;
  table: string;
  /** Privileges expected TRUE; every other privilege in TABLE_PRIVILEGES is
   *  expected FALSE, so an accidental extra grant fails the assertion. */
  granted: readonly string[];
}

/** The EXPECTED per-table posture for the five relations this task creates. */
const TABLE_EXPECTATIONS: readonly TableExpectation[] = [
  // The daemon's write role is the cloud-reachable one. It reads the command
  // queue and transitions rows through the routines; it can neither mint a
  // command nor forge an audit row, and it holds NO table-level write on
  // ingest_control (its arm/extend/clear grants are column-level).
  { role: PG_APP_RW_ROLE, table: "console_commands", granted: ["SELECT"] },
  { role: PG_APP_RW_ROLE, table: "admin_audit", granted: ["SELECT"] },
  { role: PG_APP_RW_ROLE, table: "audit_acks", granted: ["SELECT"] },
  { role: PG_APP_RW_ROLE, table: "audit_settings", granted: ["SELECT"] },
  { role: PG_APP_RW_ROLE, table: "ingest_control", granted: ["SELECT"] },
  // The audit engine's own record and the roster ARE the daemon's to write: a
  // run it cannot record is a run that never happened, and the roster arrives on
  // the daemon's own connection. Neither is re-derivable from an operator
  // decision, so neither is fenced — they are re-derivable from the world.
  { role: PG_APP_RW_ROLE, table: "audit_runs", granted: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
  { role: PG_APP_RW_ROLE, table: "audit_findings", granted: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
  { role: PG_APP_RW_ROLE, table: "roster", granted: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
  { role: PG_APP_RW_ROLE, table: "roster_sync", granted: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
  { role: PG_APP_RW_ROLE, table: "migration_runs", granted: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
  { role: PG_APP_RW_ROLE, table: "migration_objects", granted: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
  // The console mints commands and drains the audit spool; it never transitions
  // a command and never writes the audit tables the engine owns.
  { role: PG_UI_ROLE, table: "console_commands", granted: ["SELECT", "INSERT"] },
  { role: PG_UI_ROLE, table: "admin_audit", granted: ["SELECT", "INSERT"] },
  { role: PG_UI_ROLE, table: "ingest_control", granted: ["SELECT"] },
  { role: PG_UI_ROLE, table: "audit_acks", granted: ["SELECT"] },
  { role: PG_UI_ROLE, table: "audit_settings", granted: ["SELECT"] },
  { role: PG_UI_ROLE, table: "audit_runs", granted: ["SELECT"] },
  { role: PG_UI_ROLE, table: "audit_findings", granted: ["SELECT"] },
  { role: PG_UI_ROLE, table: "roster", granted: ["SELECT"] },
  { role: PG_UI_ROLE, table: "roster_sync", granted: ["SELECT"] },
  { role: PG_UI_ROLE, table: "migration_runs", granted: ["SELECT"] },
  { role: PG_UI_ROLE, table: "migration_objects", granted: ["SELECT"] },
  // The cloud-served read DSN sees nothing the console owns.
  ...[PG_READONLY_ROLE, PG_APP_RO_ROLE].flatMap((role) =>
    CONSOLE_TABLES.map((table) => ({ role, table, granted: [] as readonly string[] })),
  ),
  // Transcript text is column-level for the console, so the TABLE grant is
  // absent — has_table_privilege returns FALSE for a column-only grant. Same
  // for embeddings, whose vector encodes that text.
  { role: PG_UI_ROLE, table: "sessions", granted: [] },
  { role: PG_UI_ROLE, table: "embeddings", granted: [] },
  // Read-only, and only read: the console renders these, it never writes them.
  ...UI_READ_TABLES.map((table) => ({ role: PG_UI_ROLE, table, granted: ["SELECT"] as readonly string[] })),
  // The transcript itself, at every spelling. The extras sweep would revoke a
  // stray grant; asserting it means a boot that failed to sweep says so.
  ...["turns", "tool_calls", "session_agents"].map((table) => ({
    role: PG_UI_ROLE,
    table,
    granted: [] as readonly string[],
  })),
];

interface ColumnExpectation {
  role: string;
  table: string;
  column: string;
  privilege: string;
  expected: boolean;
}

const COLUMN_EXPECTATIONS: readonly ColumnExpectation[] = [
  // The arm/extend/clear grants, asserted at COLUMN level: has_table_privilege
  // returns FALSE for a column-only grant and would fail a correct build.
  { role: PG_APP_RW_ROLE, table: "ingest_control", column: "paused_until", privilege: "INSERT", expected: true },
  { role: PG_APP_RW_ROLE, table: "ingest_control", column: "paused_until", privilege: "UPDATE", expected: true },
  { role: PG_APP_RW_ROLE, table: "ingest_control", column: "resumed_at", privilege: "UPDATE", expected: true },
  // The clamp anchor. If the write role could set it, a pause could anchor
  // itself arbitrarily far in the future and hold the store-write gate closed
  // past the cap — which is what the cap exists to prevent.
  { role: PG_APP_RW_ROLE, table: "ingest_control", column: INGEST_CONTROL_ANCHOR_COLUMN, privilege: "INSERT", expected: false },
  { role: PG_APP_RW_ROLE, table: "ingest_control", column: INGEST_CONTROL_ANCHOR_COLUMN, privilege: "UPDATE", expected: false },
  { role: PG_UI_ROLE, table: "sessions", column: "title", privilege: "SELECT", expected: true },
  { role: PG_UI_ROLE, table: "sessions", column: "ingest_channel", privilege: "SELECT", expected: true },
  { role: PG_UI_ROLE, table: "sessions", column: "last_user_text", privilege: "SELECT", expected: false },
  { role: PG_UI_ROLE, table: "sessions", column: "last_assistant_text", privilege: "SELECT", expected: false },
  // Coverage is countable; the vector and the content hash are not readable.
  { role: PG_UI_ROLE, table: "embeddings", column: "owner_kind", privilege: "SELECT", expected: true },
  { role: PG_UI_ROLE, table: "embeddings", column: "model", privilege: "SELECT", expected: true },
  { role: PG_UI_ROLE, table: "embeddings", column: "embedding", privilege: "SELECT", expected: false },
  { role: PG_UI_ROLE, table: "embeddings", column: "content_hash", privilege: "SELECT", expected: false },
];

/** EXECUTE on the transition routines: the daemon by necessity (it IS the
 *  machine's only driver), nobody else — least of all the cloud-served read DSN,
 *  which could otherwise fabricate a completed rotation. Enumerated by NAME,
 *  never by an `hx.*_command` glob: a glob excludes acknowledge_finding and
 *  set_cloud_witness and would silently under-assert. */
const EXECUTE_ROLES: ReadonlyArray<{ role: string; expected: boolean }> = [
  { role: PG_APP_RW_ROLE, expected: true },
  { role: PG_UI_ROLE, expected: false },
  { role: PG_APP_RO_ROLE, expected: false },
  { role: PG_READONLY_ROLE, expected: false },
  { role: "public", expected: false },
];

function tableKey(role: string, table: string, privilege: string): string {
  return `t:${role}:${table}:${privilege}`;
}
function columnKey(role: string, table: string, column: string, privilege: string): string {
  return `c:${role}:${table}:${column}:${privilege}`;
}
function functionKey(role: string, signature: string): string {
  return `f:${role}:${signature}`;
}

/** Everything the matrix expects, as key → boolean. */
export function expectedPrivilegeMatrix(): Record<string, boolean> {
  const expected: Record<string, boolean> = {};
  for (const item of TABLE_EXPECTATIONS) {
    for (const privilege of TABLE_PRIVILEGES) {
      expected[tableKey(item.role, item.table, privilege)] = item.granted.includes(privilege);
    }
  }
  for (const item of COLUMN_EXPECTATIONS) {
    expected[columnKey(item.role, item.table, item.column, item.privilege)] = item.expected;
  }
  for (const { role, expected: value } of EXECUTE_ROLES) {
    for (const routine of CONSOLE_ROUTINES) {
      expected[functionKey(role, routineSignature(routine))] = value;
    }
  }
  return expected;
}

/** One round trip returning every value the matrix asserts, aliased by key. */
export function privilegeMatrixProbeQuery(): string {
  const selects: string[] = [];
  for (const item of TABLE_EXPECTATIONS) {
    for (const privilege of TABLE_PRIVILEGES) {
      selects.push(
        `pg_catalog.has_table_privilege('${item.role}', '${PG_SCHEMA}.${item.table}', '${privilege}') AS "${tableKey(item.role, item.table, privilege)}"`,
      );
    }
  }
  for (const item of COLUMN_EXPECTATIONS) {
    selects.push(
      `pg_catalog.has_column_privilege('${item.role}', '${PG_SCHEMA}.${item.table}', '${item.column}', '${item.privilege}') AS "${columnKey(item.role, item.table, item.column, item.privilege)}"`,
    );
  }
  for (const { role } of EXECUTE_ROLES) {
    for (const routine of CONSOLE_ROUTINES) {
      const signature = routineSignature(routine);
      selects.push(
        `pg_catalog.has_function_privilege('${role}', '${signature}', 'EXECUTE') AS "${functionKey(role, signature)}"`,
      );
    }
  }
  return `SELECT ${selects.join(",\n       ")}`;
}

/** Human-readable differences between the observed row and the expectation. */
export function privilegeMatrixViolations(actual: Record<string, unknown>): string[] {
  const expected = expectedPrivilegeMatrix();
  const bad: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key];
    if (got !== want) bad.push(`${key}: expected ${want}, got ${String(got)}`);
  }
  return bad;
}

/**
 * The containment ORACLE, and what it is for.
 *
 * It reports which role a connection is actually made as and whether the
 * transition routines exist, and it collapses that to one of two words:
 *
 *   • `isolated`    — connected as hx_ui with the apparatus present;
 *   • `unavailable` — anything else (an external Postgres has no apparatus at
 *                     all, and running as the daemon role means the caller could
 *                     bypass the machine with direct DML).
 *
 * NOT WIRED INTO THE CONSOLE, deliberately. The banner the console renders is
 * decided by the resolved DSN's mode, which it already knows without a query;
 * this exists so the two live-cluster suites can PROVE the property against a
 * real Postgres rather than restate the intent — embedded must answer
 * `isolated`, an external DSN must answer `unavailable`. Wiring it to the banner
 * would make a per-poll catalog query out of a fact the console already holds.
 */
export function containmentProbeQuery(): string {
  const names = CONSOLE_ROUTINES.map((r) => `'${r.name}'`).join(", ");
  // `current_user` is a reserved VALUE EXPRESSION, not a function, so
  // `pg_catalog.current_user` parses as a column of a table named pg_catalog and
  // raises 42P01 on every server — the same defect class just removed from
  // hx.set_cloud_witness. It survived because both live-cluster suites restated
  // this SQL by hand instead of calling this function, so the shipped query was
  // never executed. They call it now.
  return `SELECT current_user::text AS "currentUser",
       (SELECT count(*)::int FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = '${PG_SCHEMA}' AND p.proname IN (${names})) AS "routineCount",
       pg_catalog.has_table_privilege('${PG_SCHEMA}.console_commands', 'UPDATE') AS "canUpdateCommands"`;
}

export interface ContainmentProbe {
  currentUser: string;
  routineCount: number;
  canUpdateCommands: boolean;
}

export type ContainmentState = "isolated" | "unavailable";

export function containmentState(probe: ContainmentProbe): ContainmentState {
  const complete = probe.routineCount === CONSOLE_ROUTINES.length;
  // Direct UPDATE on the command table means the connected role can drive
  // transitions without the machine — containment is not in force, whatever
  // else is true.
  return complete && probe.currentUser === PG_UI_ROLE && !probe.canUpdateCommands
    ? "isolated"
    : "unavailable";
}
