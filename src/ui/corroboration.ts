// Whether a command outcome can be believed - the one predicate, and the four
// things the console is allowed to say about it.
//
// The daemon's Postgres authority IS the cloud-reachable write role. D13/D14
// stop that role MINTING or ALTERING a command, but the transition routines are
// EXECUTE-granted to it by necessity, so an adversary holding it can call
// complete_command or reject_command directly: report a rotation that never ran,
// or deny one that did. No SQL-layer fix exists - any nonce the routine could
// check is one the same role could rotate.
//
// So the row is not the evidence. The evidence is the daemon's own outcome
// record: a 0600 filesystem artifact, drained into a table the write role cannot
// INSERT into. The predicate below compares the two.
//
// THREE PROPERTIES, each load-bearing:
//
//   * The match is on (command id, terminal status, result digest) - NEVER on
//     existence-of-id. Under D7 the daemon writes its outcome record for work it
//     actually performed EVEN WHEN its complete_command call was refused because
//     the row was already terminal (that refusal is itself the tamper evidence),
//     so an id-only match would render a forgery as corroborated success
//     carrying the attacker's result.
//
//   * The match is ANY-MATCH, never single-record. Crash recovery legitimately
//     produces TWO records for one command - work done, crash before complete,
//     boot re-drive completes with a second result - and a single-record
//     predicate would raise a tamper alarm on an ordinary reboot.
//
//   * The input is the spool TAIL plus the already-DRAINED records. Tail-first,
//     because the drain runs at boot, at first recovery and on a 30s timer, so
//     the table alone would flag every genuine success for up to half a minute.
//     But not tail-ONLY: spool files rotate and are reclaimed while the drained
//     rows are never deleted, so a tail-only source would render every command
//     older than the retention floor as REPORTED (UNCONFIRMED) - which is
//     precisely the state that means an adversary fabricated an outcome.
//
// This function is the single source. The drain and its timer reuse it verbatim
// rather than restating the comparison, because two implementations of a tamper
// predicate are two chances to disagree about what tampering looks like.

import { createHash } from "node:crypto";

/** The action every daemon command-outcome record carries. */
export const COMMAND_OUTCOME_ACTION = "console.command.outcome";

export type TerminalStatus = "done" | "failed" | "rejected";

const TERMINAL: ReadonlySet<string> = new Set<TerminalStatus>(["done", "failed", "rejected"]);

export function isTerminalStatus(value: unknown): value is TerminalStatus {
  return typeof value === "string" && TERMINAL.has(value);
}

/** How long a terminal row may sit uncorroborated before the absence means
 *  something. It covers the gap between the routine returning and the daemon's
 *  own record reaching disk, which is the only honest reason for a delay. */
export const AWAITING_CORROBORATION_MS = 5_000;

/**
 * The digest the two sides compare.
 *
 * LENGTH-PREFIXED rather than delimiter-joined: a payload may contain any byte,
 * so any separator a caller could also type would let `{outcome:"ab",error:"c"}`
 * and `{outcome:"a",error:"bc"}` collide on one digest - and a collision here is
 * a forged outcome that corroborates.
 */
export function commandResultDigest(
  status: TerminalStatus,
  outcome: string | null,
  error: string | null,
): string {
  const result = outcome ?? "";
  const failure = error ?? "";
  return createHash("sha256")
    .update(`${status}:${result.length}:${result}:${failure.length}:${failure}`)
    .digest("hex");
}

/** What the daemon writes into the outcome record's params. Allowlisted fields
 *  only - a digest and two names, never a payload and never a credential. */
export interface CommandOutcomeParams {
  commandKind: string;
  terminalStatus: TerminalStatus;
  resultDigest: string;
}

export function commandOutcomeParams(args: {
  commandKind: string;
  status: TerminalStatus;
  outcome: string | null;
  error: string | null;
}): CommandOutcomeParams {
  return {
    commandKind: args.commandKind,
    terminalStatus: args.status,
    resultDigest: commandResultDigest(args.status, args.outcome, args.error),
  };
}

/** One comparable record, from either source. */
export interface CommandOutcomeRecord {
  commandId: string;
  terminalStatus: TerminalStatus;
  resultDigest: string;
}

/** The shape both sources present: a spool record read from the tail, and a
 *  drained admin_audit row. They carry the same fields under the same names. */
export interface OutcomeSource {
  action: string;
  kind: string;
  sessionRef: string | null;
  params: unknown;
}

/** Null for anything that is not a daemon command outcome - an intent, a
 *  sign-in, a record from a build that predates the digest. */
export function parseCommandOutcome(source: OutcomeSource): CommandOutcomeRecord | null {
  if (source.action !== COMMAND_OUTCOME_ACTION || source.kind !== "outcome") return null;
  if (!source.sessionRef) return null;
  const params = source.params;
  if (!params || typeof params !== "object") return null;
  const value = params as Record<string, unknown>;
  if (!isTerminalStatus(value.terminalStatus)) return null;
  if (typeof value.resultDigest !== "string" || value.resultDigest.length === 0) return null;
  return {
    commandId: source.sessionRef,
    terminalStatus: value.terminalStatus,
    resultDigest: value.resultDigest,
  };
}

export function parseCommandOutcomes(sources: readonly OutcomeSource[]): CommandOutcomeRecord[] {
  const out: CommandOutcomeRecord[] = [];
  for (const source of sources) {
    const parsed = parseCommandOutcome(source);
    if (parsed) out.push(parsed);
  }
  return out;
}

export type CorroborationState =
  /** Some record of the daemon's own agrees with the row. */
  | "confirmed"
  /** Terminal for less than the bound, with nothing matching yet. Neutral. */
  | "awaiting"
  /** Past the bound, and no record exists at all. */
  | "reported-unconfirmed"
  /** Past the bound, a record exists, and it disagrees. The tamper signal. */
  | "disputed";

/** Which way the disagreement runs. Both are integrity errors; the remediation
 *  is the same, and the operator's first question is always which one it is. */
export type DisputedArm = "fabricated" | "denied";

export interface Corroboration {
  state: CorroborationState;
  /** Present only for `disputed`. */
  arm?: DisputedArm;
  /** The digest the row's own payload produces - what a record must match. */
  expectedDigest: string;
  /** How many of the daemon's records mention this command at all. */
  records: number;
}

export interface CorroborationInput {
  commandId: string;
  status: TerminalStatus;
  outcome: string | null;
  error: string | null;
  /** When the row went terminal. Absent means treated as just now, so a row with
   *  no timestamp is never accused on the strength of a missing field. */
  completedAt?: string | Date | null;
  /** Spool tail PLUS already-drained records. Order is irrelevant - the
   *  predicate is ANY-MATCH. */
  records: readonly CommandOutcomeRecord[];
  now?: Date;
}

/**
 * The predicate.
 *
 * Order of the arms is the argument. A MATCH wins over everything, including a
 * stale disagreeing record from a crash the daemon already recovered from. The
 * AWAITING bound is checked BEFORE the disputed arm, not only before the
 * unconfirmed one: during the window between complete_command returning and the
 * daemon's record reaching disk, the only record present may be the stale one
 * from the crashed attempt - and raising a loud integrity error on an ordinary
 * reboot is exactly what ANY-MATCH exists to prevent.
 */
export function corroborationOf(input: CorroborationInput): Corroboration {
  const expectedDigest = commandResultDigest(input.status, input.outcome, input.error);
  const mine = input.records.filter((r) => r.commandId === input.commandId);
  const matched = mine.some(
    (r) => r.terminalStatus === input.status && r.resultDigest === expectedDigest,
  );
  if (matched) return { state: "confirmed", expectedDigest, records: mine.length };

  const now = (input.now ?? new Date()).getTime();
  const completedAt = input.completedAt ? new Date(input.completedAt).getTime() : now;
  const age = Number.isFinite(completedAt) ? now - completedAt : 0;
  if (age < AWAITING_CORROBORATION_MS) {
    return { state: "awaiting", expectedDigest, records: mine.length };
  }
  if (mine.length === 0) {
    return { state: "reported-unconfirmed", expectedDigest, records: 0 };
  }
  return {
    state: "disputed",
    // A row reporting SUCCESS the daemon never produced is a fabrication; a row
    // reporting failure or refusal against the daemon's own record is a denial.
    arm: input.status === "done" ? "fabricated" : "denied",
    expectedDigest,
    records: mine.length,
  };
}

// -- Copy --------------------------------------------------------------------

/** The neutral three. Each says what is true and nothing more; `reported` in
 *  particular must never read as success, because it is the state that means an
 *  outcome nobody can corroborate. */
export const CORROBORATION_COPY: Record<Exclude<CorroborationState, "disputed">, string> = {
  confirmed: "confirmed - the fortress daemon's own record matches this outcome",
  awaiting: "awaiting corroboration",
  "reported-unconfirmed":
    "reported (unconfirmed) - this outcome carries no record from the fortress daemon. " +
    "The daemon's database role can report an outcome it did not produce, so an outcome with no " +
    "matching record is reported, never confirmed.",
};

export interface DisputedContext {
  commandId: string;
  commandKind: string;
  arm: DisputedArm;
  /** Where the trail entry for this command lives, for the operator to open. */
  auditLink: string;
  /** True on an external Postgres, where the fence does not exist at all. */
  externalPostgres: boolean;
}

/**
 * The loud one.
 *
 * DISPUTED is the only console state that means a Postgres-role adversary
 * fabricated or denied an outcome, and until this string existed it was the only
 * state with behaviour and no words. It names the command, says which arm,
 * points at the trail entry, and gives the remediation - because an integrity
 * error whose next step the reader has to guess is an integrity error nobody
 * acts on.
 */
export function disputedCopy(ctx: DisputedContext): string[] {
  const lines = [
    `Integrity error on command ${ctx.commandId} (${ctx.commandKind}).`,
    ctx.arm === "fabricated"
      ? "This outcome was recorded as a success, and the fortress daemon has no record of producing it."
      : "This outcome was recorded as a failure or a refusal, and the fortress daemon's own record disagrees.",
    "The recorded outcome was not produced by this fortress daemon.",
    `Audit trail entry: ${ctx.auditLink}`,
    // Named by its heading rather than by an internal label: the operator
    // reading this has to be able to find the section by searching for what it
    // says, not for what a ledger somewhere calls it.
    "Remediation: rotate the hx_app_rw database credential - the only authority that can report an " +
      'outcome it did not produce - and read "Command outcomes are corroborated, not trusted" in ' +
      "SECURITY.md for what that role can and cannot do.",
  ];
  if (ctx.externalPostgres) {
    lines.push(
      "This fortress uses an external Postgres, where the daemon connects as the role that OWNS the " +
        "console tables: a table owner cannot be constrained by REVOKE and bypasses the transition " +
        "routines with direct DML, so neither the command fence nor the audit tamper fence is in " +
        "force here. Run the daemon under a non-owning role to restore them.",
    );
  }
  return lines;
}
