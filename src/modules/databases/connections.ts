// What the module keeps about an organization's connections and their jobs.
//
// One small document, in the module's own state, which the host keeps apart
// for each organization. It holds every connection and the newest jobs. It is
// read and written whole, under a lock, so a connection and the job that tests
// it never disagree on disk.
//
// A SECRET'S VALUE IS NEVER HERE. A connection holds the NAME of the secret
// that holds its login's password, and nothing else of it.

import { AskFailure, type ModuleStatePort } from "../../host/module-contract";
import { isName } from "../../host/shape";
import { isSecretName } from "../../secrets/types";
import type { JobSubject } from "./data-runner";
import {
  CONNECTION_NAME_MAX_CHARS,
  DEFAULT_MIN_TLS,
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

export interface Connection extends ConnectionFields {
  /** This module's own key for what it keeps about the connection. */
  id: string;
  addedAt: string;
  addedBy?: string;
  changedAt?: string;
  changedBy?: string;
  /** The id of its newest job. */
  job?: string;
}

export interface Book {
  v: 1;
  connections: Connection[];
  /** Newest first. */
  jobs: JobRecord[];
}

/** The state document could not be read as a book. Nothing is guessed. */
export class BookUnreadable extends Error {
  constructor() {
    super("the module's own record of its connections cannot be read");
    this.name = "BookUnreadable";
  }
}

export async function loadBook(state: ModuleStatePort): Promise<Book> {
  let stored: unknown;
  try {
    stored = await state.read<unknown>(BOOK_KEY);
  } catch {
    throw new BookUnreadable();
  }
  if (stored === null) return { v: 1, connections: [], jobs: [] };
  const book = stored as Partial<Book>;
  if (book.v !== 1 || !Array.isArray(book.connections) || !Array.isArray(book.jobs)) {
    throw new BookUnreadable();
  }
  return { v: 1, connections: book.connections, jobs: book.jobs };
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
  await state.write<Book>(BOOK_KEY, { ...book, jobs });
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

export function connectionState(book: Book, connection: Connection): ConnectionState {
  const job = newestJob(book, connection);
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

const HOST_MAX_CHARS = 128;

/** A DNS name, an IPv4 address, or an IPv6 address written without brackets. */
function isHost(value: string): boolean {
  if (value.length === 0 || value.length > HOST_MAX_CHARS) return false;
  if (value.includes(":")) return /^[0-9A-Fa-f:.]{2,45}$/.test(value);
  const labels = value.replace(/\.$/, "").split(".");
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[A-Za-z0-9_-]+$/.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-"),
  );
}

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
 * The fields of a connection, from an act's arguments. Throws `AskFailure` with
 * the word for the first field that breaks a rule.
 */
export function connectionFields(args: unknown): ConnectionFields {
  const raw = (args ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === "string" ? value : "");

  const name = text(raw.name);
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
  const database = text(raw.database);
  if (!isTidyName(database, 128)) throw new AskFailure("database_invalid");
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
  if (!isTidyName(user, 128)) throw new AskFailure("user_invalid");
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
