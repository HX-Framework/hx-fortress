// What another module of HX Fortress may ask of the Databases module: a
// connection by its name, and one job of the data runner on it.
//
// This is the one file another module imports from this module. It holds types
// only, so importing it brings no code of the Databases module with it.
//
// WHY ANOTHER MODULE DOES NOT REACH A DATABASE ITSELF. The module host keeps two
// lists for each module and organization: the hosts a person added, and the
// names of secrets a person added. A module can have a program run only
// against an entry of its own list. So one module owns reaching a database:
// this one. Another module names a connection, hands over a job, and gets
// counts back, with the names of the tables they are for. It never holds a
// server's address, a user's name or the name of a secret.
//
// WHO THE CALLER IS. Code of this same binary, and nothing checks it further.
// It passes its own context, as the module host handed it. The Databases
// module reads from it which organization the call is for and which module is
// asking, and works with its own context of that same organization.
//
// WHAT THE CALLER RECORDS ITSELF. The Databases module writes a line when a job
// starts and one when it ends, with the connection, the kind of job, the store
// and the store job, and the module that asked. It does not know who or what
// started the job: a person, or a run of a program. The caller records that,
// beside the `jobId` an outcome carries. A job whose line of a start has no
// line of an end was cut by a stop of the process.

import type { ModuleContextV2 } from "../../host/module-contract";
import type { ConnectionState, Engine } from "./manifest";

/** The calling module's own context. Two things are read from it: the
 *  organization the call is for, and the id of the module that asks. */
export type CallingContext = Pick<ModuleContextV2, "organization" | "moduleId">;

/** What another module may know of a connection. No server, no login. */
export interface ConnectionView {
  /** As it was added. Names differ by more than case. */
  name: string;
  engine: Engine;
  state: ConnectionState;
  /** A job may run on it now: its last test that passed found a login that can
   *  change nothing, and no database has refused that login since. */
  runnable: boolean;
}

/** The store job the data runner sends its pages to. */
export interface StoreJobTarget {
  /**
   * Where the store's gateway answers on this machine, in one form:
   * `http://127.0.0.1:<port>` or `http://[::1]:<port>`, with the port written
   * out and an optional path of letters, digits and `. _ ~ / -`. Rows go
   * there and nowhere else, so any other address is refused.
   */
  gatewayUrl: string;
  /** One token of letters, digits and `_ . : -`, at most 128 characters. */
  storeId: string;
  /** The same form as `storeId`. */
  jobId: string;
  /** For one store job. It is handed to the program and kept nowhere by this
   *  module: not in its state, not in a record, not in a log. */
  key: string;
}

/**
 * A job another module may have run. Both kinds sign in with the connection's
 * read login, which can only read. A job that writes to a database signs in
 * with the connection's write login, and no other module can start one: it
 * needs a person's approval, which this module's own asks check.
 */
export type ModuleJob =
  | { kind: "pull"; store: StoreJobTarget }
  | { kind: "compare"; store: StoreJobTarget };

/**
 * What a pull did for one table, as counts. The rows went to the store.
 *
 * `source` and `into` are a table's name as the database and the store spell
 * it. They are not held to the alphabet of a name that an answer to a control
 * plane may hold: a caller that passes one on holds it to a shape itself.
 */
export interface PullTable {
  source: string;
  into: string;
  mode: "new" | "change";
  read: number;
  sent: number;
  removed: number;
  pages: number;
  cut: number;
}

export interface CompareCounts {
  /** Which of the store's two jobs it was, as the program says. */
  job: "push_preview" | "compare";
  read: number;
  targetRows: number;
  sent: number;
  same: number;
  otherRows: number;
}

/** The two words the data runner fails a pull or a compare with that no other
 *  job meets: the store's gateway refused a call, or the store reached its
 *  limit of writes. */
export type StoreFailure = "store" | "store_limit";

/**
 * Why a job did not run or did not end well, as one word. The database's own
 * sentence about a failure is never returned: it can quote a value.
 */
export type ModuleJobFailure =
  // ── This module's own ──
  /** The Databases module is not on for the caller's organization. */
  | "databases_off"
  | "connection_unknown"
  /** The connection has passed no test since it was added or changed. */
  | "not_tested"
  /** Its last test that passed found that its login can change the database. */
  | "login_can_write"
  /** A database refused this login. Nothing signs in with it until a person's
   *  test with it passes. */
  | "login_refused"
  /** `store.gatewayUrl` is not in the one form that names this machine. */
  | "gateway_not_local"
  /** A field of the job, or the caller's context, is not what it must be. */
  | "job_invalid"
  /** No place is free. Two jobs of other modules run at once, for the whole
   *  HX Fortress and not for each organization. Try again later. */
  | "busy"
  /** The module's own record of connections cannot be read. */
  | "state_unreadable"
  /** An operator changed or removed the connection while the job ran, and the
   *  job was stopped. */
  | "connection_changed"
  /** The caller's own signal stopped the job, or the module was stopping. The
   *  caller's signal says which. */
  | "interrupted"
  /** What the program printed could not be read as its output. */
  | "output_invalid"
  | "internal"
  /** The module host did not answer in the job's time. */
  | "timeout"
  // ── The data runner's ──
  | "unreachable"
  | "tls"
  | "login"
  | "database"
  | "deadline"
  | "not_ready"
  | StoreFailure
  // ── The module host's, when it could not run the program ──
  | "program_not_declared"
  | "program_not_installed"
  | "reach_not_listed"
  | "secret_not_added"
  | "secret_missing"
  | "secret_unavailable"
  | "program_failed";

/**
 * How a job ended. `jobId` is this module's id for the job, the one in its
 * lines of the audit trail. A refusal made before a place was taken has none.
 */
export type ModuleJobOutcome =
  | { ok: true; kind: "pull"; jobId: string; tables: PullTable[] }
  | ({ ok: true; kind: "compare"; jobId: string } & CompareCounts)
  | { ok: false; code: ModuleJobFailure; jobId?: string };

export interface ModuleJobOptions {
  /** Aborted to stop the job. */
  signal?: AbortSignal;
  /** How long the job may take, in milliseconds. The longest, and the default,
   *  is just under 30 minutes. The shortest is one second. */
  deadlineMs?: number;
}

export interface DatabasesForModules {
  /** One connection of the caller's organization, or null. Rejects with
   *  `AskFailure("state_unreadable")` when the record cannot be read. */
  connection(caller: CallingContext, name: string): Promise<ConnectionView | null>;
  /** Every connection of the caller's organization. Rejects as `connection`. */
  connections(caller: CallingContext): Promise<ConnectionView[]>;
  /** Run one job of the data runner on a connection, and wait for it. Never
   *  rejects. */
  run(
    caller: CallingContext,
    name: string,
    job: ModuleJob,
    options?: ModuleJobOptions,
  ): Promise<ModuleJobOutcome>;
}
