// What another module of HX Fortress may ask of the Databases module: a
// connection by its name, and one job of the data runner on it.
//
// This is the one file another module imports from this module.
//
// WHY ANOTHER MODULE DOES NOT REACH A DATABASE ITSELF. The module host keeps two
// lists for each module and organization: the hosts a person added, and the
// names of secrets a person added. A module can have a program run only
// against an entry of its own list. So one module owns reaching a database:
// this one. Another module names a connection, hands over a job, and gets
// counts back. It never holds a server's address, a user's name or the name of
// a secret.
//
// The caller is code of this same binary. It passes the organization of its
// own context, and the Databases module works with its own context of that
// same organization.

import type { Organization } from "../../host/organization-id";
import type { ConnectionState, Engine } from "./manifest";

/** What another module may know of a connection. No server, no login. */
export interface ConnectionView {
  /** As it was added. Names differ by more than case. */
  name: string;
  engine: Engine;
  state: ConnectionState;
  /** A job may run on it now: its last test that passed found a login that can
   *  change nothing. */
  runnable: boolean;
}

/** The store job the data runner sends its pages to. */
export interface StoreJobTarget {
  /** Where the store's gateway answers, on this machine. */
  gatewayUrl: string;
  storeId: string;
  jobId: string;
  /** For one store job. It is handed to the program and kept nowhere. */
  key: string;
}

/**
 * A job another module may have run. Both kinds sign in with the connection's
 * one login, which can only read. A job that writes to a database needs a
 * second login and is not built.
 */
export type ModuleJob =
  | { kind: "pull"; store: StoreJobTarget }
  | { kind: "compare"; store: StoreJobTarget };

/** What a pull did for one table, as counts. The rows went to the store. */
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
  job: "push_preview" | "compare";
  read: number;
  targetRows: number;
  sent: number;
  same: number;
  otherRows: number;
}

/**
 * Why a job did not run or did not end well, as one word. The words this
 * module adds to the data runner's and the host's own:
 *
 *   databases_off       the Databases module is not on for the organization
 *   connection_unknown  no connection of that name
 *   not_tested          the connection has passed no test since it was added
 *                       or changed
 *   login_can_write     its last test found that its login can change the
 *                       database
 *   gateway_not_local   the store's gateway is not on this machine
 *   job_invalid         a field of the job is not what it must be
 *   busy                no place is free
 *   state_unreadable    the module's own record of connections cannot be read
 *
 * The database's own sentence about a failure is never returned: it can quote
 * a value.
 */
export type ModuleJobOutcome =
  | { ok: true; kind: "pull"; tables: PullTable[] }
  | ({ ok: true; kind: "compare" } & CompareCounts)
  | { ok: false; code: string };

export interface ModuleJobOptions {
  /** The calling module's id, for the line in the audit trail. */
  by: string;
  /** Aborted to stop the job. */
  signal?: AbortSignal;
  /** How long the job may take. The longest, and the default, is just under
   *  30 minutes. */
  deadlineMs?: number;
}

export interface DatabasesForModules {
  /** One connection of the organization, or null. */
  connection(organization: Organization, name: string): Promise<ConnectionView | null>;
  /** Every connection of the organization. */
  connections(organization: Organization): Promise<ConnectionView[]>;
  /** Run one job of the data runner on a connection, and wait for it. Never
   *  rejects. */
  run(
    organization: Organization,
    name: string,
    job: ModuleJob,
    options: ModuleJobOptions,
  ): Promise<ModuleJobOutcome>;
}
