// How the console reaches Postgres, and what it says when it cannot.
//
// The DSN comes from pg.json and ui.json ONLY, through resolveRoleDsn - never
// from roles.json, which holds the daemon's secrets including the superuser's,
// and never minted here. On embedded Postgres that means the console connects as
// hx_ui, whose grants are the console's whole reach. On an external database
// there is no role split at all: the operator's single DSN is what the daemon
// uses and what the console gets, and both containment fences are void there.
//
// The DEGRADED states are three distinct facts that a naive implementation
// collapses into one "database unavailable":
//
//   * the console role is not provisioned - the daemon has not run a boot new
//     enough to create hx_ui, so the fix is to restart the daemon;
//   * Postgres is stopped - nothing is listening, so the fix is to start it;
//   * no coordinates at all - pg.json has never been written.
//
// Telling an operator "database unavailable" when the answer is "your daemon is
// on an older binary" costs an afternoon.

import { maskDsn, resolveRoleDsn, type PgJson } from "../host/postgres/pg-json";
import { PG_UI_ROLE } from "../host/postgres/console-plane";
import { redactedMessage } from "./redact";

/** Every console query runs under this. A console page must not be able to hold
 *  a connection open behind a bad plan: the panel would hang, the poll behind it
 *  would stack, and the operator would see a spinner instead of a state. */
export const CONSOLE_STATEMENT_TIMEOUT_MS = 5_000;

export type ConsoleDbState =
  | { kind: "ready"; mode: "embedded" | "external"; dsn: string }
  | { kind: "not-configured" }
  | { kind: "role-not-provisioned"; detail: string }
  | { kind: "postgres-stopped"; detail: string }
  | { kind: "unavailable"; detail: string };

/** Add libpq's `options` parameter so the timeout is set by the SERVER for the
 *  whole session. A per-query `SET statement_timeout` would be one more round
 *  trip and would be missed by any path that forgot it. */
export function withStatementTimeout(dsn: string, ms = CONSOLE_STATEMENT_TIMEOUT_MS): string {
  try {
    const url = new URL(dsn);
    const existing = url.searchParams.get("options");
    const option = `-c statement_timeout=${Math.max(1, Math.trunc(ms))}`;
    url.searchParams.set("options", existing ? `${existing} ${option}` : option);
    return url.toString();
  } catch {
    // An unparseable DSN is the operator's to fix; handing it back unchanged
    // means the connect error names the real problem rather than this function.
    return dsn;
  }
}

export interface ConsoleDbInputs {
  pgJson: PgJson | null;
  uiDatabaseUrl: string | null;
}

export function resolveConsoleDb(inputs: ConsoleDbInputs): ConsoleDbState {
  const dsn = resolveRoleDsn({ pgJson: inputs.pgJson, uiDatabaseUrl: inputs.uiDatabaseUrl });
  if (!dsn) return { kind: "not-configured" };
  const external = inputs.uiDatabaseUrl?.trim()
    ? inputs.pgJson?.mode !== "embedded"
    : inputs.pgJson?.mode === "external";
  return { kind: "ready", mode: external ? "external" : "embedded", dsn: withStatementTimeout(dsn) };
}

/** SQLSTATEs that mean the login role is not there (or its password is not what
 *  pg.json says), as opposed to a server that is not there. */
const AUTH_CODES = new Set(["28000", "28P01", "3D000"]);
const DOWN_CODES = new Set(["57P03", "08001", "08006", "08004"]);

function codeOf(err: unknown): string {
  const value = err as { code?: unknown; errno?: unknown } | null;
  if (typeof value?.code === "string") return value.code;
  if (typeof value?.errno === "string") return value.errno;
  return "";
}

/**
 * Turn a connect failure into a state a panel can render.
 *
 * The message is redacted before it is kept: a driver quotes the whole
 * connection string in its failure, password included, and that string would
 * otherwise reach a rendered page through code nobody wrote.
 */
export function classifyConnectError(err: unknown): ConsoleDbState {
  const detail = redactedMessage(err);
  const code = codeOf(err);
  if (AUTH_CODES.has(code) || /password authentication failed|role .* does not exist/i.test(detail)) {
    return { kind: "role-not-provisioned", detail };
  }
  if (DOWN_CODES.has(code) || /ECONNREFUSED|ENOENT|connection refused|not accepting/i.test(detail)) {
    return { kind: "postgres-stopped", detail };
  }
  return { kind: "unavailable", detail };
}

/** What each degraded state says, and what to do about it. */
export function consoleDbCopy(state: ConsoleDbState): string {
  switch (state.kind) {
    case "ready":
      return state.mode === "external"
        ? "connected to an external Postgres"
        : "connected to the embedded Postgres";
    case "not-configured":
      return (
        "no database coordinates yet - the daemon writes them on its first boot with a console-capable " +
        "binary. Start the fortress daemon, then reload."
      );
    case "role-not-provisioned":
      return (
        `the ${PG_UI_ROLE} database role is not provisioned. It is created by the daemon on every boot, ` +
        "so the fix is to restart the fortress daemon - not to create the role by hand."
      );
    case "postgres-stopped":
      return "Postgres is not accepting connections. The daemon owns it; start the fortress daemon.";
    case "unavailable":
      return "the database is not answering.";
  }
}

/**
 * The external-Postgres banner. It states BOTH voids, because they are
 * different guarantees and an operator who reads only the first will assume the
 * second still holds.
 */
export function externalContainmentBanner(): string[] {
  return [
    "This fortress uses an external Postgres. Two containment properties do not hold here.",
    "The command fence is void: the daemon connects as the role that OWNS the console tables, and a " +
      "table owner cannot be constrained by REVOKE - it can INSERT and UPDATE hx.console_commands " +
      "directly, bypassing the transition routines that make the command machine one-way.",
    "The audit tamper fence is void for the same reason: that role can INSERT, amend or delete rows " +
      "in hx.admin_audit, so a drained record is no longer evidence a Postgres-level adversary could " +
      "not have produced.",
    "And the command plane is not installed at all: the five routines it drives are created only on the " +
      "embedded Postgres, so start, stop, update, rotate and migrate are terminal-only here. Everything " +
      "this console READS works. A command submitted from it is never claimed and never expires either — " +
      "nothing polls it, so it does not even reach its deadline.",
    "To restore both, run the daemon under a role that does not own the tables, and give the console " +
      "its own limited-role DSN with `hx-fortress ui config set databaseUrl --stdin`.",
  ];
}

/** The printable form of the resolved DSN. There is no other. */
export function printableConsoleDsn(state: ConsoleDbState): string {
  return state.kind === "ready" ? maskDsn(state.dsn) : "(not configured)";
}
