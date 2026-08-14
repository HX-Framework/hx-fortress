// `ui config --print-role-sql` — the SQL an operator runs against an EXTERNAL
// Postgres to create the console's login role, plus the optional extension that
// restores daemon/console isolation there.
//
// Two properties this generator exists to hold:
//
//   • the password is accepted ONLY as a parameter of this function (the caller
//     reads it from stdin/TTY), never from argv — argv is visible in
//     /proc/<pid>/cmdline, `ps` and shell history, and the emitted SQL is
//     printed precisely so the operator can paste it somewhere;
//   • the emitted SQL carries a locally-computed SCRAM-SHA-256 VERIFIER, never
//     the cleartext password, so the text is safe for psql history and for a
//     server running log_statement=all.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

import {
  PG_UI_ROLE,
  UI_SESSION_COLUMNS,
  UI_TABLE_GRANTS,
  quoteLiteral,
} from "./console-plane";
import { PG_SCHEMA } from "./cluster-roles";
import { maskDsn } from "./pg-json";

/** Postgres's default SCRAM iteration count. */
const SCRAM_ITERATIONS = 4096;

/**
 * The `PASSWORD 'SCRAM-SHA-256$…'` verifier Postgres stores for a role.
 *
 * SASLprep is approximated by NFKC normalization, which is exact for the ASCII
 * and Latin passwords an operator types; a password whose SASLprep form differs
 * would authenticate only against this verifier, never against one the server
 * computed, so the interactive `\password hx_ui` alternative stays documented.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const normalized = password.normalize("NFKC");
  const saltedPassword = pbkdf2Sync(normalized, salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export interface PrintRoleSqlInput {
  /** Read from stdin/TTY by the caller. NEVER sourced from argv. */
  password: string;
  /** The operator's Postgres DSN, used only to derive the console DSN that gets
   *  written to ui.json — the returned value is masked. */
  databaseUrl: string;
  /** Also emit the non-owning-role extension for the daemon's role. */
  daemonRole?: string;
}

export interface PrintRoleSqlOutput {
  /** The full script to run as the operator. Contains no cleartext password. */
  sql: string;
  /** The DSN to persist as ui.json.databaseUrl — password included; it goes
   *  through the config store's 0600 door and is never printed. */
  consoleDatabaseUrl: string;
  /** The only form safe to show the operator. */
  maskedDatabaseUrl: string;
}

/** Rewrite a DSN's user/password to the console role's. */
function consoleDsn(databaseUrl: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = PG_UI_ROLE;
  url.password = password;
  return url.toString();
}

export function generateRoleSql(input: PrintRoleSqlInput): PrintRoleSqlOutput {
  if (!input.password) throw new Error("a password is required (read it from stdin, never argv)");
  const verifier = scramVerifier(input.password);
  const lines: string[] = [
    "-- hx-fortress console role. Run this as a Postgres superuser (or a role that",
    "-- can create roles and grant on the hx schema). The PASSWORD below is a",
    "-- SCRAM-SHA-256 verifier, not your password: it is safe in psql history and",
    "-- in a server log. `\\password hx_ui` in psql is the interactive alternative.",
    "DO $$",
    "BEGIN",
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_UI_ROLE}') THEN`,
    `    CREATE ROLE ${PG_UI_ROLE} LOGIN PASSWORD ${quoteLiteral(verifier)};`,
    "  ELSE",
    `    ALTER ROLE ${PG_UI_ROLE} WITH LOGIN PASSWORD ${quoteLiteral(verifier)};`,
    "  END IF;",
    "END $$;",
    "",
    `GRANT USAGE ON SCHEMA ${PG_SCHEMA} TO ${PG_UI_ROLE};`,
  ];
  for (const grant of UI_TABLE_GRANTS) {
    lines.push(
      `GRANT ${grant.privileges.join(", ")} ON ${PG_SCHEMA}.${grant.table} TO ${PG_UI_ROLE};`,
    );
  }
  lines.push(
    "",
    "-- Column-level, deliberately: a table-level SELECT would include the",
    "-- transcript-text columns the console has no reason to read.",
    `GRANT SELECT (${UI_SESSION_COLUMNS.join(", ")})`,
    `  ON ${PG_SCHEMA}.sessions TO ${PG_UI_ROLE};`,
  );

  if (input.daemonRole) {
    const role = input.daemonRole;
    lines.push(
      "",
      "-- OPTIONAL · run the fortress daemon under a NON-OWNING role to restore the",
      "-- containment an external Postgres otherwise has none of. The table owner",
      "-- bypasses every REVOKE, so isolation here means the daemon must not own",
      "-- these tables. No function grants appear below: the SECURITY DEFINER",
      "-- transition routines are embedded-only and do not exist on this server.",
      `GRANT USAGE ON SCHEMA ${PG_SCHEMA} TO ${role};`,
      // NEVER INSERT: claim/complete need only SELECT + UPDATE, minting stays
      // with hx_ui (which this same script creates), and granting the daemon
      // role INSERT would re-open the mint hole inside the very remedy that
      // closes it.
      `GRANT SELECT, UPDATE ON ${PG_SCHEMA}.console_commands TO ${role};`,
      `GRANT SELECT, INSERT, UPDATE ON ${PG_SCHEMA}.ingest_control TO ${role};`,
      `GRANT SELECT ON ${PG_SCHEMA}.admin_audit TO ${role};`,
      `GRANT SELECT ON ${PG_SCHEMA}.audit_acks TO ${role};`,
      `GRANT SELECT ON ${PG_SCHEMA}.audit_settings TO ${role};`,
    );
  }

  const url = consoleDsn(input.databaseUrl, input.password);
  return {
    sql: `${lines.join("\n")}\n`,
    consoleDatabaseUrl: url,
    maskedDatabaseUrl: maskDsn(url),
  };
}

/** The per-table grants the external banner reports as missing. Kept next to the
 *  generator so the banner copy and the emitted script can never drift. */
export function externalConsoleGrantExpectations(): ReadonlyArray<{
  table: string;
  privileges: readonly string[];
}> {
  return UI_TABLE_GRANTS;
}
