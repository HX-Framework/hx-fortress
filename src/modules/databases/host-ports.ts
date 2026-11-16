// What this module needs from the module host.
//
// The host hands a module a person's act with its context: a person, the list
// of hosts and the list of secret names. Those are the host's own types, and
// this file passes them on.
//
// Two things the host does not have yet: a helper program it starts for a
// module, and a record that can hold a query's text. The module host's
// contract says what it will hand a module for each. Until it does, the module
// is written against the interfaces in this file, in the form that contract
// gives. When the host hands a module the real one on its context, the
// interface's users read it from the context.
//
// Nothing here weakens a rule of the host. A module opens no socket and starts
// no process, with these ports as without them: the host does both for it.
//
// TWO KINDS OF CONTEXT.
//
//   • Every context will be able to have a program run and a query recorded
//     (`ContextPorts`). An ask's context is one of these.
//   • Only the context of an operator's act can add or remove a host this
//     HX Fortress may reach, or the name of a secret it may have read
//     (`ModuleActContext`). `onAsk` is never handed one, so no ask has a path
//     to either list.

import type { ModuleContextV2 } from "../../host/module-contract";

// ── What the host hands a person's act ───────────────────────────────────────
//
// A person, the list of hosts this HX Fortress may reach, the list of secret
// names, and the context of an act are the module host's own now. They are
// passed on from here under the names this module has always used. The two
// refusals are the classes the host throws, so an `instanceof` on one of them
// is true for what the host threw.

export {
  ReachRefused,
  SecretNameRefused,
  type ModuleActContext,
  type Person,
  type ReachEntry,
  type ReachPort,
  type ReachRefusal,
  type SecretNameRefusal,
  type SecretNamesPort,
} from "../../host/module-contract";

// ── A helper program the host starts for this module ─────────────────────────

/** Why the host could not run the program, as its contract lists them. */
export const PROGRAM_FAILURES = [
  "program_not_declared",
  "program_not_installed",
  "reach_not_listed",
  "secret_not_added",
  "secret_missing",
  "secret_unavailable",
  "busy",
  "timeout",
  "program_failed",
] as const;
export type ProgramFailure = (typeof PROGRAM_FAILURES)[number];

export interface ProgramRun {
  /** A reach's name. The host looks it up and gives the program that entry's
   *  host and port. The module cannot pass an address. */
  reach: string;
  /** A field's name to the name of a secret a person added. The host reads each
   *  value and gives it to the program. The module never holds a value. */
  secrets: Readonly<Record<string, string>>;
  /** The job's fields: everything but the address and the secrets. */
  input: unknown;
  /** Called with each JSON value the program prints. A query's rows reach the
   *  module here and nowhere else. */
  onOutput: (value: unknown) => void;
  timeoutMs?: number;
  /** Aborted to have the host end the program. */
  signal?: AbortSignal;
}

export type ProgramOutcome = { ok: true } | { ok: false; code: ProgramFailure };

export interface ProgramsPort {
  run(program: string, run: ProgramRun): Promise<ProgramOutcome>;
}

// ── The record of a query ────────────────────────────────────────────────────
//
// A module's own audit record holds names, counts and flags, and a name is at
// most 128 characters of a short alphabet. A statement is neither. So the line
// that a query leaves, with the person and the statement's text, needs a
// record of its own kind from the host.

/** What is known of a query before it runs. */
export interface QueryIntent {
  /** The person's email, or their console login when they have no email. */
  person: string;
  connection: string;
  /** The statement as it was asked, up to the longest a query takes. */
  statement: string;
  /** The job's id, when the statement got as far as a job. */
  job?: string;
}

/** How a query ended. `rule` and `code` are one word each, never a sentence. */
export type QueryOutcome =
  | { outcome: "ran"; rows: number; more: boolean }
  /** Refused before anything ran, by one of the module's rules. */
  | { outcome: "refused"; rule: string }
  /** It was started and failed. */
  | { outcome: "failed"; code: string };

export interface OpenQueryRecord {
  /** Write how it ended. Never rejects: the query has happened by now. */
  close(outcome: QueryOutcome): Promise<void>;
}

export interface QueryRecordsPort {
  /**
   * Write that this person is about to run this statement, before it runs.
   * REJECTS when the record cannot be written, and then the statement does not
   * run: a query with no line in the audit trail is the one thing this must
   * not allow.
   */
  open(intent: QueryIntent): Promise<OpenQueryRecord>;
  /** Write a statement that was refused. Rejects when it cannot be written. */
  refused(intent: QueryIntent, rule: string): Promise<void>;
}

// ── What every context will carry ────────────────────────────────────────────

export interface ContextPorts {
  programs: ProgramsPort;
  queryRecords: QueryRecordsPort;
}

/** Where the module gets a context's ports from, until the context has them. */
export interface DatabasesHostPorts {
  forContext(ctx: ModuleContextV2): ContextPorts;
}
