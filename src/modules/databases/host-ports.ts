// What this module needs from the module host and does not have yet.
//
// The module host's contract says what it will hand a module for each of these.
// Until it does, the module is written against the interfaces in this file, in
// the form that contract gives, and is handed stand-ins (see standins.ts).
// Each interface names the thing it stands for. When the host hands a module
// the real one on its context, the interface's users read it from the context
// and the stand-in goes.
//
// Nothing here weakens a rule of the host. A module opens no socket and starts
// no process, with these ports as without them: the host does both for it.

import type { ModuleContextV2 } from "../../host/module-contract";

// ── A person ─────────────────────────────────────────────────────────────────

/** A person signed in to this Fortress, as its console's sign-in says. */
export interface Person {
  /** The console login. */
  login: string;
  /** Lower case. Null for an account that has none. */
  email: string | null;
  role: "operator" | "readonly";
}

// ── A reach: a host and a port a person added to this module ─────────────────

export interface ReachEntry {
  name: string;
  host: string;
  port: number;
  addedBy: string;
  addedAt: string;
}

export type ReachRefusal =
  | "reach_name_invalid"
  | "reach_name_taken"
  | "reach_host_invalid"
  | "reach_port_invalid"
  | "reach_address_refused"
  | "reach_list_full"
  | "reach_not_listed";

/** The host refused to add or remove an entry of its list of hosts. */
export class ReachRefused extends Error {
  constructor(readonly rule: ReachRefusal) {
    super(`the list of hosts refused: ${rule}`);
    this.name = "ReachRefused";
  }
}

export interface ReachReader {
  list(): Promise<ReachEntry[]>;
}

/** Only an act's context has the two that change the list, so no ask can add a
 *  host this Fortress may reach. */
export interface ReachPort extends ReachReader {
  add(name: string, to: { host: string; port: number }): Promise<void>;
  remove(name: string): Promise<void>;
}

// ── A secret's name a person added to this module ────────────────────────────

export type SecretNameRefusal = "secret_name_invalid" | "secret_names_full";

export class SecretNameRefused extends Error {
  constructor(readonly rule: SecretNameRefusal) {
    super(`the list of secret names refused: ${rule}`);
    this.name = "SecretNameRefused";
  }
}

export interface SecretNamesReader {
  list(): Promise<string[]>;
}

export interface SecretNamesPort extends SecretNamesReader {
  /** Adding a name does not read the secret. Adding one twice is one entry. */
  add(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

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
  /** The statement, whole, as it was asked. */
  statement: string;
  /** The job's id, when the statement got as far as a job. */
  job?: string;
}

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

// ── All of them, for one call ────────────────────────────────────────────────

/** What every context will carry. */
export interface ContextPorts {
  reach: ReachReader;
  secretNames: SecretNamesReader;
  programs: ProgramsPort;
  queryRecords: QueryRecordsPort;
}

/** What an act's context will carry: the same, and the two lists' adders. */
export interface ActPorts extends ContextPorts {
  reach: ReachPort;
  secretNames: SecretNamesPort;
}

/**
 * Where the module gets its ports from, for the organization a call is for.
 *
 * `forContext` is for an ask, a query and anything the module does on its own.
 * `forAct` is for an act, and is the only way to the adders.
 */
export interface DatabasesHostPorts {
  forContext(ctx: ModuleContextV2): ContextPorts;
  forAct(ctx: ModuleContextV2, person: Person): ActPorts;
}
