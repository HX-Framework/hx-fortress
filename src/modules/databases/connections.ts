// What the module keeps about an organization's connections and their jobs.
//
// One small document, in the module's own state, which the host keeps apart
// for each organization. It holds every connection and the newest jobs. It is
// read and written whole, under a lock, so a connection and the job that tests
// it never disagree on disk.
//
// A SECRET'S VALUE IS NEVER HERE. A connection holds the NAME of the secret
// that holds a login's password, and nothing else of it. It has one such name
// for its read login, and one more when it names a write login.

import { AskFailure, type ModuleStatePort } from "../../host/module-contract";
import { isName } from "../../host/shape";
import { isSecretName } from "../../secrets/types";
import type { CatalogRef } from "./catalog";
import type { JobSubject } from "./data-runner";
import { isHost } from "./host-text";
import {
  CONNECTION_NAME_MAX_CHARS,
  DEFAULT_MIN_TLS,
  WRITE_TABLES_MAX,
  ENCRYPTION_MODES,
  ENGINES,
  TLS_VERSIONS,
  type ConnectionState,
  type EncryptionMode,
  type Engine,
  type FailureCode,
  type JobOrigin,
  type JobState,
  type JobStep,
  type LinkEncryption,
  type TlsVersion,
} from "./manifest";

/** Jobs kept after they end, newest first, besides the newest job of each
 *  connection. */
export const JOBS_KEPT = 100;

const BOOK_KEY = "connections";

// ── A job ────────────────────────────────────────────────────────────────────

/** One test of one connection: how it went, and what it found. */
export interface JobRecord {
  id: string;
  /** The connection's own id, and its name when the job started. */
  connectionId: string;
  connection: string;
  origin: JobOrigin;
  /** The console login of the person who started it, when a person did. */
  by?: string;
  state: JobState;
  step: JobStep;
  startedAt: string;
  finishedAt?: string;
  code?: FailureCode;
  encryption?: LinkEncryption;
  canWrite?: boolean;
  writableTables?: number;
  tables?: number;
  columns?: number;
  leftOutTables?: number;
  leftOutColumns?: number;
  truncated?: boolean;
}

// ── A connection ─────────────────────────────────────────────────────────────

export interface ConnectionFields {
  name: string;
  engine: Engine;
  host: string;
  port: number;
  database: string;
  encryption: EncryptionMode;
  minTls: TlsVersion;
  serverName?: string;
  user: string;
  /** The name of the secret that holds the login's password. */
  keyName: string;
}

/** A table of a database: its schema and its name, as the database spells
 *  them. For MySQL the schema is the database, and for Oracle the owner. */
export interface TableName {
  schema: string;
  name: string;
}

/** Whether two names are the same table. Names are compared as they are
 *  written: the engines do not agree on which letters are the same. */
export const sameTable = (a: TableName, b: TableName): boolean => a.schema === b.schema && a.name === b.name;

/**
 * What a connection needs before anything can write through it: a login of
 * its own, and the tables a write may reach.
 *
 * The login is a second user of the same database, and the name of the secret
 * that holds its password. It is never the read login: that one has to be a
 * login that can change nothing. The tables are sorted, and none is there
 * twice. With no table, the login takes no write.
 */
export interface WriteSettings {
  user: string;
  keyName: string;
  tables: TableName[];
}

export interface Connection extends ConnectionFields {
  /** This module's own key for what it keeps about the connection. */
  id: string;
  /** Its write login and the tables a write may reach. Left out for a
   *  connection that can only be read. An operator sets it with an act of its
   *  own. A change of the connection's fields keeps it, unless the change
   *  names another database (`namesAnotherDatabase`). */
  writes?: WriteSettings;
  /**
   * The name of the entry in the list of hosts that holds this connection's
   * server and port. It is the connection's id and a count, and a name is
   * never used for a second address: when the server or the port changes, the
   * connection gets a new entry under a new name. So a record of the
   * connection as it was can never be run against the address it has now.
   */
  reach: string;
  /** How many names its entries have had. */
  reachCount: number;
  /**
   * How many databases it has named: 1 when it was added, and one more each
   * time its engine, server, port or database changed. It is the second part
   * of the id other modules know the connection by (`idForModules`). A record
   * with no count is read as 1.
   */
  databaseCount?: number;
  addedAt: string;
  addedBy?: string;
  changedAt?: string;
  changedBy?: string;
  /** The id of its newest job. */
  job?: string;
  /** Where the reading of its last test that passed is kept. */
  catalog?: CatalogRef;
  /** What its last test that passed found about its login. A query runs only
   *  when this says the login cannot write. A change drops it. */
  verified?: { at: string; canWrite: boolean };
}

export interface Book {
  v: 1;
  connections: Connection[];
  /** Newest first. */
  jobs: JobRecord[];
  /**
   * Logins a database refused, as `loginKey` writes them. The control plane
   * can start no test that signs in with one of these: a wrong password tried
   * again and again locks a login. A person's test that passes takes the login
   * off the list.
   */
  refusedLogins?: string[];
}

/** The names of the secrets a connection's logins use, each once. */
export function keyNamesOf(connection: Pick<Connection, "keyName" | "writes">): string[] {
  const write = connection.writes?.keyName;
  return write === undefined || write === connection.keyName ? [connection.keyName] : [connection.keyName, write];
}

/**
 * The id other modules know a connection by: the connection's own id, a dot,
 * and the count of the databases it has named.
 *
 * It names one connection to one database. A connection that is removed and
 * added again under the same name has another id, and so has a connection
 * whose engine, server, port or database changed. So what another module
 * keeps under this id, such as rows it read or a write it prepared, can be
 * told apart from what belongs to another database of the same name.
 */
export function idForModules(connection: Pick<Connection, "id" | "databaseCount">): string {
  return `${connection.id}.${connection.databaseCount ?? 1}`;
}

/** A login as a database counts it: one user at one server. */
export function loginKey(connection: ConnectionFields): string {
  return `${connection.host.toLowerCase()} ${connection.port} ${connection.user}`;
}

/** The state document could not be read as a book. Nothing is guessed. */
export class BookUnreadable extends Error {
  /** `cause` is what the read failed with: for this host's log, which says its
   *  kind and never its message. */
  constructor(cause?: unknown) {
    super("the module's own record of its connections cannot be read", { cause });
    this.name = "BookUnreadable";
  }
}

export async function loadBook(state: ModuleStatePort): Promise<Book> {
  let stored: unknown;
  try {
    stored = await state.read<unknown>(BOOK_KEY);
  } catch (thrown) {
    throw new BookUnreadable(thrown);
  }
  if (stored === null) return { v: 1, connections: [], jobs: [], refusedLogins: [] };
  const book = stored as Partial<Book>;
  if (book.v !== 1 || !Array.isArray(book.connections) || !Array.isArray(book.jobs)) {
    throw new BookUnreadable();
  }
  return {
    v: 1,
    connections: book.connections,
    jobs: book.jobs,
    refusedLogins: Array.isArray(book.refusedLogins) ? book.refusedLogins : [],
  };
}

export async function saveBook(state: ModuleStatePort, book: Book): Promise<void> {
  // The newest jobs are kept, and so is the newest job of every connection
  // however old it is: it is what says where that connection stands.
  const newest = new Set(book.connections.map((connection) => connection.job));
  let kept = 0;
  const jobs = book.jobs.filter((job) => {
    if (newest.has(job.id)) return true;
    kept += 1;
    return kept <= JOBS_KEPT;
  });
  // A refused login is kept only while a connection still signs in with it.
  const logins = new Set(book.connections.map(loginKey));
  const refusedLogins = (book.refusedLogins ?? []).filter((login) => logins.has(login));
  await state.write<Book>(BOOK_KEY, { ...book, jobs, refusedLogins });
}

/** Two names are the same connection when they differ only by case. */
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function findConnection(book: Book, name: string): Connection | undefined {
  return book.connections.find((connection) => sameName(connection.name, name));
}

export function findJob(book: Book, id: string): JobRecord | undefined {
  return book.jobs.find((job) => job.id === id);
}

/** The newest job of a connection, when the book still holds it. */
export function newestJob(book: Book, connection: Connection): JobRecord | undefined {
  return connection.job === undefined ? undefined : findJob(book, connection.job);
}

export function stateOf(job: JobRecord | undefined): ConnectionState {
  if (!job) return "not_tested";
  if (job.state === "running") return "testing";
  return job.state === "done" ? "ready" : "failed";
}

export function subjectOf(connection: Connection): JobSubject {
  return {
    engine: connection.engine,
    database: connection.database,
    encryption: connection.encryption,
    minTls: connection.minTls,
    ...(connection.serverName ? { serverName: connection.serverName } : {}),
    user: connection.user,
  };
}

// ── What a person typed, checked ─────────────────────────────────────────────
//
// The act door has already held each field to its shape: a name is at most 128
// characters of letters, digits, space and `_ . : / @ -`. These are the rules
// a shape cannot state. A field that breaks one fails the act with one word
// that says which field.

/** A name a person reads: no space at either end, and no two in a row. */
function isTidyName(value: string, max: number): boolean {
  return (
    value.length >= 1 &&
    value.length <= max &&
    isName(value) &&
    value === value.trim() &&
    !value.includes("  ")
  );
}

/**
 * True for a text that holds an address with a login in it: `scheme://…`,
 * `user:password@host`, `user/password@host`. Every such text holds an `@`
 * after a colon or a slash, or `://`.
 */
export function holdsLogin(text: string): boolean {
  return text.includes("://") || /[:/][^@]*@/.test(text);
}

/**
 * The fields of a connection, from an act's arguments. Throws `AskFailure` with
 * the word for the first field that breaks a rule.
 */
export function connectionFields(args: unknown): ConnectionFields {
  const raw = (args ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === "string" ? value : "");

  const name = text(raw.name);
  // A name is shown to every signed-in person, written into the audit trail
  // and told to the control plane. An address with a login in it is no name:
  // somebody pasted a connection string into the wrong field. This is asked
  // first, so that such a name gets this word whatever else is wrong with it.
  if (holdsLogin(name)) throw new AskFailure("name_holds_login");
  // A connection's name is what a person and a grant know it by. It starts and
  // ends with a letter or a digit.
  if (!isTidyName(name, CONNECTION_NAME_MAX_CHARS) || !/^[A-Za-z0-9]/.test(name) || !/[A-Za-z0-9]$/.test(name)) {
    throw new AskFailure("name_invalid");
  }
  if (typeof raw.engine !== "string" || !(ENGINES as readonly string[]).includes(raw.engine)) {
    throw new AskFailure("engine_invalid");
  }
  const engine = raw.engine as Engine;
  const host = text(raw.host);
  if (!isHost(host)) throw new AskFailure("host_invalid");
  const port = raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AskFailure("port_invalid");
  }
  // A database's name and a user's name take no `:` and no `/`, and a
  // database's name no `@`: whatever builds an address from these fields must
  // not find a second address inside one of them.
  const database = text(raw.database);
  if (!isTidyName(database, 128) || /[:/@]/.test(database)) throw new AskFailure("database_invalid");
  if (
    typeof raw.encryption !== "string" ||
    !(ENCRYPTION_MODES as readonly string[]).includes(raw.encryption)
  ) {
    throw new AskFailure("encryption_invalid");
  }
  const encryption = raw.encryption as EncryptionMode;
  // TDS 8 is SQL Server's. The data runner refuses it for any other engine.
  if (encryption === "strict" && engine !== "sqlserver") {
    throw new AskFailure("encryption_not_for_engine");
  }
  const minTls = raw.minTls === undefined ? DEFAULT_MIN_TLS : raw.minTls;
  if (typeof minTls !== "string" || !(TLS_VERSIONS as readonly string[]).includes(minTls)) {
    throw new AskFailure("min_tls_invalid");
  }
  const serverName = raw.serverName === undefined ? undefined : text(raw.serverName);
  if (serverName !== undefined && !isHost(serverName)) throw new AskFailure("server_name_invalid");
  const user = text(raw.user);
  if (!isTidyName(user, 128) || /[:/]/.test(user)) throw new AskFailure("user_invalid");
  const keyName = text(raw.keyName);
  if (!isSecretName(keyName)) throw new AskFailure("key_name_invalid");

  return {
    name,
    engine,
    host,
    port,
    database,
    encryption,
    minTls: minTls as TlsVersion,
    ...(serverName === undefined ? {} : { serverName }),
    user,
    keyName,
  };
}

/**
 * Whether two user names are taken for one login. Names that differ only by
 * case are: with their usual settings SQL Server and Oracle read them as one
 * login, and this module does not ask the database which it is. Where a
 * database does tell such names apart, this refuses a pair it could have
 * taken, which is the safe side.
 */
export const sameUser = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * A connection's write settings, from an act's arguments. `readUser` is the
 * connection's read login. Throws `AskFailure` with the word for the first
 * thing that breaks a rule.
 */
export function writeSettings(args: unknown, readUser: string): WriteSettings {
  const raw = (args ?? {}) as Record<string, unknown>;
  const user = typeof raw.user === "string" ? raw.user : "";
  if (!isTidyName(user, 128) || /[:/]/.test(user)) throw new AskFailure("write_user_invalid");
  // The read login is the one a query runs with, and a query runs only with a
  // login that can change nothing. A login that writes is another login.
  if (sameUser(user, readUser)) throw new AskFailure("write_user_is_read_user");
  const keyName = typeof raw.keyName === "string" ? raw.keyName : "";
  if (!isSecretName(keyName)) throw new AskFailure("write_key_name_invalid");
  return { user, keyName, tables: writeTables(raw.tables) };
}

/**
 * The tables a write may reach, from an act's arguments: each a schema and a
 * name, in one order. Throws `AskFailure("write_tables_invalid")` for a list
 * that is too long, an entry that is no table's name, and a table that is
 * there twice.
 */
function writeTables(given: unknown): TableName[] {
  if (given === undefined) return [];
  if (!Array.isArray(given) || given.length > WRITE_TABLES_MAX) throw new AskFailure("write_tables_invalid");
  const tables: TableName[] = [];
  for (const entry of given as unknown[]) {
    const { schema, name } = (entry ?? {}) as Record<string, unknown>;
    if (typeof schema !== "string" || typeof name !== "string") throw new AskFailure("write_tables_invalid");
    if (!isTidyName(schema, 128) || !isTidyName(name, 128)) throw new AskFailure("write_tables_invalid");
    const table = { schema, name };
    if (tables.some((other) => sameTable(other, table))) throw new AskFailure("write_tables_invalid");
    tables.push(table);
  }
  // One order, whatever order they were typed in: a list that only changed its
  // order is no change.
  const text = (table: TableName): string => JSON.stringify([table.schema, table.name]);
  return tables.sort((a, b) => (text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0));
}

/** Whether two write settings are the same. Both lists of tables are in the
 *  one order `writeSettings` gives. */
export function sameWrites(a: WriteSettings | undefined, b: WriteSettings | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.user === b.user &&
    a.keyName === b.keyName &&
    a.tables.length === b.tables.length &&
    a.tables.every((table, at) => sameTable(table, b.tables.at(at) as TableName))
  );
}

/**
 * Whether new fields name another database than a connection did: another
 * engine, server, port or database. A server's name is the same name in any
 * case. A database's name is compared as it is spelled: whether its case
 * counts is the database server's to say, and this module does not ask it.
 */
export function namesAnotherDatabase(before: ConnectionFields, after: ConnectionFields): boolean {
  return (
    before.engine !== after.engine ||
    before.host.toLowerCase() !== after.host.toLowerCase() ||
    before.port !== after.port ||
    before.database !== after.database
  );
}

/** The names of the fields that differ between a connection and new fields. */
export function changedFields(before: ConnectionFields, after: ConnectionFields): string[] {
  const names: (keyof ConnectionFields)[] = [
    "engine",
    "host",
    "port",
    "database",
    "encryption",
    "minTls",
    "serverName",
    "user",
    "keyName",
  ];
  // Each name is one of the list above.
  // eslint-disable-next-line security/detect-object-injection
  return names.filter((field) => before[field] !== after[field]);
}
