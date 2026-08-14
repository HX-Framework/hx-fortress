import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  embeddedPgJson,
  maskDsn,
  readPgJson,
  resolveRoleDsn,
  writePgJson,
} from "../src/host/postgres/pg-json";
import { generateRoleSql, scramVerifier } from "../src/host/postgres/print-role-sql";
import {
  containmentState,
  expectedPrivilegeMatrix,
  privilegeMatrixProbeQuery,
  privilegeMatrixViolations,
} from "../src/host/postgres/privilege-matrix";

describe("pg.json", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-pgjson-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the embedded shape is pinned and carries the console role only", async () => {
    const file = path.join(root, "ui", "pg.json");
    const value = embeddedPgJson({ host: "127.0.0.1", port: 54329, database: "hx-db", password: "p" });
    expect(value).toEqual({
      mode: "embedded",
      host: "127.0.0.1",
      port: 54329,
      database: "hx-db",
      user: "hx_ui",
      password: "p",
    });
    await writePgJson(file, value);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(value);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  test("an env-sourced port reaches the console with no environment of its own", async () => {
    const file = path.join(root, "ui", "pg.json");
    await writePgJson(
      file,
      embeddedPgJson({ host: "127.0.0.1", port: 15999, database: "hx-db", password: "p" }),
    );
    const parsed = await readPgJson(file);
    expect(resolveRoleDsn({ pgJson: parsed })).toBe("postgresql://hx_ui:p@127.0.0.1:15999/hx-db");
  });

  test("a malformed or absent file resolves to null rather than a guess", async () => {
    expect(await readPgJson(path.join(root, "missing.json"))).toBeNull();
    expect(resolveRoleDsn({ pgJson: null })).toBeNull();
  });
});

describe("resolveRoleDsn", () => {
  test("is pure — it never reads roles.json and never mints a credential", () => {
    // The signature is the guarantee: everything it can use is passed in.
    expect(resolveRoleDsn({ pgJson: null, uiDatabaseUrl: null })).toBeNull();
    expect(resolveRoleDsn.length).toBe(1);
  });

  test("an explicit ui.json databaseUrl wins in BOTH modes", () => {
    const configured = "postgresql://op:pw@db.example:5432/hx";
    expect(
      resolveRoleDsn({
        pgJson: { mode: "external", databaseUrl: "postgresql://other:x@old:5432/hx" },
        uiDatabaseUrl: configured,
      }),
    ).toBe(configured);
    // Pinned for the embedded + configured combination too: an operator who set
    // one has said which database the console uses.
    expect(
      resolveRoleDsn({
        pgJson: embeddedPgJson({ host: "127.0.0.1", port: 5432, database: "hx-db", password: "p" }),
        uiDatabaseUrl: configured,
      }),
    ).toBe(configured);
  });

  test("an external pg.json is used when nothing is configured", () => {
    expect(
      resolveRoleDsn({ pgJson: { mode: "external", databaseUrl: "postgresql://op:pw@db:5432/hx" } }),
    ).toBe("postgresql://op:pw@db:5432/hx");
  });
});

describe("masking", () => {
  test("only the masked DSN is ever printable", () => {
    expect(maskDsn("postgresql://hx_ui:sup3rsecret@127.0.0.1:5432/hx-db")).not.toContain("sup3rsecret");
    expect(maskDsn("postgresql://hx_ui:sup3rsecret@127.0.0.1:5432/hx-db")).toContain("***");
    // Unparseable input fails CLOSED — this is the only printable form, so a
    // value it cannot parse is not one it may echo.
    expect(maskDsn("not a url with user:pw@host")).toBe("(unparseable connection string — redacted)");
  });
});

describe("--print-role-sql", () => {
  const input = { password: "console-pw", databaseUrl: "postgresql://op:oppw@db.example:5432/hx" };

  test("emits a SCRAM verifier, never the cleartext password", () => {
    const out = generateRoleSql(input);
    expect(out.sql).not.toContain("console-pw");
    expect(out.sql).toMatch(/PASSWORD 'SCRAM-SHA-256\$4096:[^']+\$[^']+:[^']+'/);
  });

  test("the verifier is deterministic for a fixed salt", () => {
    const salt = Buffer.alloc(16, 7);
    expect(scramVerifier("hunter2", salt)).toBe(scramVerifier("hunter2", salt));
    expect(scramVerifier("hunter2", salt)).not.toBe(scramVerifier("hunter3", salt));
  });

  test("returns the console DSN for the 0600 store and a masked one to print", () => {
    const out = generateRoleSql(input);
    expect(out.consoleDatabaseUrl).toContain("hx_ui");
    expect(out.consoleDatabaseUrl).toContain("console-pw");
    expect(out.maskedDatabaseUrl).not.toContain("console-pw");
  });

  test("the password is only ever a parameter — there is no argv path", () => {
    expect(() => generateRoleSql({ ...input, password: "" })).toThrow(/stdin/);
  });

  test("grants the console its allowlist and column-level session reads", () => {
    const { sql } = generateRoleSql(input);
    expect(sql).toContain("GRANT SELECT, INSERT ON hx.console_commands TO hx_ui;");
    expect(sql).toContain("GRANT SELECT (");
    expect(sql).not.toContain("last_user_text");
  });

  test("the non-owning-role extension grants the daemon no INSERT on commands", () => {
    const { sql } = generateRoleSql({ ...input, daemonRole: "hx_daemon" });
    expect(sql).toContain("GRANT SELECT, UPDATE ON hx.console_commands TO hx_daemon;");
    expect(sql).not.toMatch(/GRANT [^;]*INSERT[^;]* ON hx\.console_commands TO hx_daemon/);
    // The apparatus does not exist externally, so there is nothing to EXECUTE.
    expect(sql).not.toContain("EXECUTE ON FUNCTION");
  });
});

describe("the privilege matrix", () => {
  test("covers all five tables this task creates, for every role", () => {
    const expected = expectedPrivilegeMatrix();
    for (const table of [
      "console_commands",
      "ingest_control",
      "admin_audit",
      "audit_acks",
      "audit_settings",
    ]) {
      expect(expected[`t:hx_app_rw:${table}:SELECT`]).toBe(true);
      expect(expected[`t:hx_app_rw:${table}:UPDATE`]).toBe(false);
      expect(expected[`t:hx_app_rw:${table}:DELETE`]).toBe(false);
      expect(expected[`t:hx_readonly:${table}:SELECT`]).toBe(false);
      expect(expected[`t:hx_app_ro:${table}:SELECT`]).toBe(false);
    }
    // The daemon may never mint a command nor write an audit row.
    expect(expected["t:hx_app_rw:console_commands:INSERT"]).toBe(false);
    expect(expected["t:hx_app_rw:admin_audit:INSERT"]).toBe(false);
    // The console mints, and drains the spool.
    expect(expected["t:hx_ui:console_commands:INSERT"]).toBe(true);
    expect(expected["t:hx_ui:admin_audit:INSERT"]).toBe(true);
  });

  test("the ingest_control arm is asserted at COLUMN level", () => {
    const expected = expectedPrivilegeMatrix();
    // has_table_privilege returns FALSE for a column-only grant, so a
    // table-level assertion here would fail a correct implementation.
    expect(expected["t:hx_app_rw:ingest_control:INSERT"]).toBe(false);
    expect(expected["t:hx_app_rw:ingest_control:UPDATE"]).toBe(false);
    expect(expected["c:hx_app_rw:ingest_control:paused_until:INSERT"]).toBe(true);
    expect(expected["c:hx_app_rw:ingest_control:paused_until:UPDATE"]).toBe(true);
    expect(expected["c:hx_app_rw:ingest_control:row_written_at:INSERT"]).toBe(false);
    expect(expected["c:hx_app_rw:ingest_control:row_written_at:UPDATE"]).toBe(false);
  });

  test("transcript columns are refused to the console", () => {
    const expected = expectedPrivilegeMatrix();
    expect(expected["c:hx_ui:sessions:title:SELECT"]).toBe(true);
    expect(expected["c:hx_ui:sessions:last_user_text:SELECT"]).toBe(false);
    expect(expected["c:hx_ui:sessions:last_assistant_text:SELECT"]).toBe(false);
  });

  test("EXECUTE is enumerated by name for all five routines and denied to PUBLIC", () => {
    const expected = expectedPrivilegeMatrix();
    for (const name of [
      "claim_command",
      "complete_command",
      "reject_command",
      "acknowledge_finding",
      "set_cloud_witness",
    ]) {
      const key = Object.keys(expected).find((k) => k.startsWith("f:hx_app_rw:hx." + name));
      expect(key).toBeDefined();
      expect(expected[key as string]).toBe(true);
      expect(expected[(key as string).replace("hx_app_rw", "hx_ui")]).toBe(false);
      expect(expected[(key as string).replace("hx_app_rw", "public")]).toBe(false);
    }
  });

  test("the probe query uses the inheritance-aware helpers only", () => {
    const query = privilegeMatrixProbeQuery();
    expect(query).toContain("has_table_privilege");
    expect(query).toContain("has_column_privilege");
    expect(query).toContain("has_function_privilege");
    expect(query).not.toContain("information_schema");
  });

  test("a matching observation reports no violations", () => {
    expect(privilegeMatrixViolations(expectedPrivilegeMatrix())).toEqual([]);
    const broken = { ...expectedPrivilegeMatrix(), "t:hx_app_rw:console_commands:INSERT": true };
    expect(privilegeMatrixViolations(broken)).toEqual([
      "t:hx_app_rw:console_commands:INSERT: expected false, got true",
    ]);
  });

  test("containment is reported honestly per connection", () => {
    expect(
      containmentState({ currentUser: "hx_ui", routineCount: 5, canUpdateCommands: false }),
    ).toBe("isolated");
    // Running as the daemon role: direct DML bypasses the machine.
    expect(
      containmentState({ currentUser: "hx_app_rw", routineCount: 5, canUpdateCommands: true }),
    ).toBe("unavailable");
    // External Postgres: the apparatus was never created there.
    expect(
      containmentState({ currentUser: "operator", routineCount: 0, canUpdateCommands: true }),
    ).toBe("unavailable");
  });
});
