import { describe, expect, test } from "bun:test";

import { appRoleStatements } from "../src/host/postgres/cluster";
import {
  CMD_OWNER_TABLE_GRANTS,
  CONSOLE_COMMAND_KINDS,
  CONSOLE_ROUTINES,
  UI_SESSION_COLUMNS,
  UI_VIEW_ALLOWLIST,
  isConsoleCommandKind,
  ownershipProbeQuery,
  ownershipViolations,
  routineSignature,
  staleOverloadDrops,
  staleOverloadQuery,
} from "../src/host/postgres/console-plane";
import { migrations } from "../src/host/postgres/migrations/manifest";
import type { RoleSecrets } from "../src/host/postgres/roles";

const SECRETS: RoleSecrets = { super: "s", appRo: "ro", appRw: "rw", ui: "ui" };

/** The EXECUTABLE part of a migration. The rule is about statements, and these
 *  files explain in prose exactly which statements they are forbidden. */
function statementsOnly(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

function batch(): string[] {
  return appRoleStatements({ secrets: SECRETS, staleDrops: [], uiExtras: [], views: [] });
}

describe("migrations 0015+", () => {
  const consolePlane = migrations.find((m) => m.name === "0019_console_plane");

  test("0015 is registered in the manifest", () => {
    expect(consolePlane).toBeDefined();
  });

  test("0015-0018 carry no CREATE ROLE, CREATE FUNCTION or OWNER TO", () => {
    // The whole command-plane apparatus lives in ensureAppRoles instead: a
    // migration could not GRANT to a role that does not exist yet on a fresh
    // cluster, could never be corrected once applied (name-keyed journal), and
    // its OWNER TO aborts the upgrade on an external Postgres.
    const later = migrations.filter((m) => Number(m.name.slice(0, 4)) >= 15);
    expect(later.length).toBeGreaterThan(0);
    for (const migration of later) {
      const sql = statementsOnly(migration.sql);
      expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
      expect(sql).not.toMatch(/\bCREATE\s+ROLE\b/i);
      expect(sql).not.toMatch(/\bOWNER\s+TO\b/i);
    }
  });

  test("0015 creates all five tables the privilege matrix covers", () => {
    const sql = consolePlane?.sql ?? "";
    for (const table of [
      "console_commands",
      "ingest_control",
      "admin_audit",
      "audit_acks",
      "audit_settings",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "hx"."${table}"`);
    }
  });

  test("0015 re-runs as a clean no-op", () => {
    // The runner is append-only and a restored journal replays applied files.
    const sql = consolePlane?.sql ?? "";
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (!/^(CREATE|ALTER)/im.test(trimmed)) continue;
      for (const line of trimmed.split("\n")) {
        if (/^\s*(CREATE TABLE|CREATE INDEX|ALTER TABLE)/i.test(line)) {
          expect(line).toMatch(/IF NOT EXISTS/i);
        }
      }
    }
  });

  test("the fence REVOKEs are role-guarded so a fresh/external cluster applies cleanly", () => {
    const sql = consolePlane?.sql ?? "";
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'hx_app_rw'\)/);
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'hx_readonly'\)/);
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE ON hx.audit_acks FROM hx_app_rw");
    expect(sql).toContain("REVOKE ALL ON hx.audit_settings FROM hx_readonly");
  });

  test("audit_acks and audit_settings carry the shapes the routines write", () => {
    const sql = consolePlane?.sql ?? "";
    expect(sql).toMatch(/"hx"\."audit_acks"[\s\S]*"org" text[\s\S]*"session_id" text/);
    expect(sql).toMatch(/PRIMARY KEY \("org", "session_id"\)/);
    expect(sql).toMatch(/"hx"\."audit_settings"[\s\S]*"cloud_witness" boolean/);
    // Sequence-free by construction — the routine owner needs no sequence USAGE.
    expect(sql).not.toMatch(/audit_acks[\s\S]{0,400}(serial|GENERATED .* AS IDENTITY)/i);
  });
});

describe("the command allowlist", () => {
  test("is final, complete, and excludes session revocation", () => {
    expect([...CONSOLE_COMMAND_KINDS].sort()).toEqual([
      "acknowledge_finding",
      "rotate_credentials",
      "run_audit",
      "run_checkup",
      "run_migration",
      "self_test",
      "update_apply",
      "witness_toggle",
    ]);
    // Revocation is in-process plus the users.json epoch — never a command row.
    expect(isConsoleCommandKind("revoke_session")).toBe(false);
  });
});

describe("the D16 apparatus", () => {
  test("declares exactly five routines and sweeps all five by name", () => {
    expect(CONSOLE_ROUTINES.map((r) => r.name).sort()).toEqual([
      "acknowledge_finding",
      "claim_command",
      "complete_command",
      "reject_command",
      "set_cloud_witness",
    ]);
    const query = staleOverloadQuery();
    for (const routine of CONSOLE_ROUTINES) expect(query).toContain(`'${routine.name}'`);
  });

  test("every body is SECURITY DEFINER, pins search_path and is schema-qualified", () => {
    for (const routine of CONSOLE_ROUTINES) {
      expect(routine.createSql).toContain("SECURITY DEFINER");
      expect(routine.createSql).toContain("SET search_path = pg_catalog, pg_temp");
      // With search_path pinned to pg_catalog only, an unqualified hx table
      // would not resolve at all.
      expect(routine.createSql).not.toMatch(/(FROM|INTO|UPDATE)\s+(?!hx\.)[a-z_]*console_commands/);
      expect(routine.createSql).toMatch(/hx\.(console_commands|audit_acks|audit_settings|audit_findings)/);
    }
  });

  test("the routine owner holds exactly its pinned grant set", () => {
    expect(CMD_OWNER_TABLE_GRANTS.map((g) => g.table).sort()).toEqual([
      "audit_acks",
      // READ-ONLY, and only because the acknowledge fence reads it: an
      // acknowledgement is refused unless a matching also_at_letai finding
      // exists. Without the grant every acknowledgement raised 42501, because
      // this owner is NOLOGIN with no memberships and inherits nothing.
      "audit_findings",
      "audit_settings",
      "console_commands",
    ]);
    const commands = CMD_OWNER_TABLE_GRANTS.find((g) => g.table === "console_commands");
    // Minting stays with the console alone.
    expect(commands?.privileges).not.toContain("INSERT");
    // Both routines are read-modify-write; Postgres needs SELECT for those.
    for (const table of ["audit_acks", "audit_settings"]) {
      expect(CMD_OWNER_TABLE_GRANTS.find((g) => g.table === table)?.privileges).toContain("SELECT");
    }
  });

  test("a widened signature drops the old overload; the pinned one survives", () => {
    const drops = staleOverloadDrops([
      { name: "claim_command", args: "uuid, text", rettype: "boolean" },
      { name: "claim_command", args: "uuid, text, boolean", rettype: "boolean" },
      // A same-argument routine whose RETURN type changed cannot be replaced in
      // place, so it has to be dropped too or the next boot's batch fails.
      { name: "set_cloud_witness", args: "boolean", rettype: "void" },
    ]);
    expect(drops).toContain("DROP FUNCTION IF EXISTS hx.claim_command(uuid, text)");
    expect(drops).toContain("DROP FUNCTION IF EXISTS hx.set_cloud_witness(boolean)");
    expect(drops.some((d) => d.includes("uuid, text, boolean"))).toBe(false);
  });

  test("signatures render in the form DROP and has_function_privilege take", () => {
    expect(routineSignature(CONSOLE_ROUTINES[0])).toBe("hx.claim_command(uuid, text, boolean)");
  });

  test("the ownership probe asserts all four D14 invariants", () => {
    const query = ownershipProbeQuery();
    expect(query).toContain("pg_get_userbyid(p.proowner)");
    expect(query).toContain("rolcanlogin");
    expect(query).toContain("pg_auth_members");
    expect(query).toContain("has_table_privilege('hx_cmd_owner'");
    expect(query).toContain("proconfig @> ARRAY['search_path=pg_catalog, pg_temp']");
  });

  test("the probe reports each invariant it fails", () => {
    expect(
      ownershipViolations({
        routinesOwnedByCmdOwner: 5,
        routineCount: 5,
        ownerIsSafe: true,
        ownerMembershipRows: 0,
        cmdOwnerGrantsMatch: true,
        uiMembershipRows: 0,
        publicExecuteCount: 0,
        searchPathPinned: 5,
      }),
    ).toEqual([]);
    const bad = ownershipViolations({
      routinesOwnedByCmdOwner: 4,
      routineCount: 5,
      ownerIsSafe: false,
      ownerMembershipRows: 1,
      cmdOwnerGrantsMatch: false,
      uiMembershipRows: 2,
      publicExecuteCount: 3,
      searchPathPinned: 1,
    });
    expect(bad.length).toBe(7);
  });
});

describe("the boot batch", () => {
  test("no view is allowlisted for the console, so the deny sweep covers them all", () => {
    expect(UI_VIEW_ALLOWLIST).toEqual([]);
    const stmts = appRoleStatements({
      secrets: SECRETS,
      staleDrops: [],
      uiExtras: [],
      views: ["v_turn_search", "v_session_overview"],
    });
    // v_turn_search is an owner-rights view over transcript turns — the exact
    // text the column-level sessions grant withholds.
    expect(stmts).toContain('REVOKE ALL ON hx."v_turn_search" FROM hx_ui');
    expect(stmts).toContain('REVOKE ALL ON hx."v_session_overview" FROM hx_ui');
  });

  test("extras found in the catalog are revoked from the console role", () => {
    const stmts = appRoleStatements({
      secrets: SECRETS,
      staleDrops: [],
      uiExtras: ["turns"],
      views: [],
    });
    expect(stmts).toContain('REVOKE ALL ON hx."turns" FROM hx_ui');
  });

  test("the sessions column grant excludes transcript text", () => {
    expect(UI_SESSION_COLUMNS).not.toContain("last_user_text");
    expect(UI_SESSION_COLUMNS).not.toContain("last_assistant_text");
  });

  test("every statement naming the pgvector-gated table is guarded", () => {
    // hx.embeddings exists only where the `vector` extension does — migration
    // 0006 declares `requires: "vector"` and the runner SKIPS it otherwise. The
    // whole batch is one transaction, so a bare statement naming the missing
    // table aborts role provisioning entirely and the fortress comes up with no
    // login roles at all.
    const naming = batch().filter((statement) => statement.includes("hx.embeddings"));
    expect(naming.length).toBeGreaterThan(0);
    for (const statement of naming) {
      expect(statement.startsWith("DO $$")).toBe(true);
      expect(statement).toContain("relname = 'embeddings'");
    }
  });

  test("carries no cleartext beyond the role passwords it must set", () => {
    const stmts = batch();
    const passwordStatements = stmts.filter((s) => s.includes("PASSWORD"));
    expect(passwordStatements.length).toBe(3);
    for (const statement of passwordStatements) expect(statement).toMatch(/^ALTER ROLE /);
  });
});
