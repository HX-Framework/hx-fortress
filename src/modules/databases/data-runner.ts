// The data runner, as this module sees it: the job it hands over, and the
// output it reads back.
//
// The data runner is a program of its own. For one job it dials one database,
// does one thing, prints one line and exits. This HX Fortress does not hold its
// source. What is here is the two shapes between them, which are public with
// HX Fortress, because a reviewer must be able to read what an HX Fortress sends
// to a database's network and what it takes back.
//
// THE MODULE HANDS OVER NO ADDRESS AND NO PASSWORD. It names a reach and the
// name of a secret. The module host looks both up and gives the program the
// host, the port and the password (see host-ports.ts). So the job this file
// builds is the program's job without three things: `server`, `reach` and
// `login.password`.
//
// THE OUTPUT IS REBUILT, NOT TRUSTED. `readOutput` builds a new value out of
// the fields it knows, each one checked. Anything else the program printed is
// dropped here. A test's findings are names and counts. A query's rows are the
// one value in this module that is not, and they leave it only through
// `onDataIsland`, to the person who asked.

import { withDeadline } from "../../host/with-deadline";
import type { CompareCounts, PullTable } from "./for-modules";
import type { ProgramOutcome, ProgramsPort } from "./host-ports";
import {
  DATA_RUNNER_PROGRAM,
  FAILURE_CODES,
  TABLE_KINDS,
  type EncryptionMode,
  type Engine,
  type FailureCode,
  type JobStep,
  type LinkEncryption,
  type TableKind,
  type TlsVersion,
} from "./manifest";

// ── Limits ───────────────────────────────────────────────────────────────────

/** A test gives up after this long, and so does a query: a person waits on it. */
export const JOB_DEADLINE_MS = 2 * 60_000;
/** How long past a job's own deadline the host waits before it ends the program. */
export const JOB_GRACE_MS = 20_000;
/** Most rows one query answers. */
export const QUERY_ROWS_MAX = 200;
/** Longest statement a query takes, in characters. */
export const QUERY_STATEMENT_MAX_CHARS = 20_000;
/** Longest value of one cell the program hands back. It cuts a value at 1,000
 *  characters of its own counting, which is at most twice as many of ours. */
const CELL_MAX_CHARS = 2_000;
/** Most columns one query's answer may have. */
const QUERY_COLUMNS_MAX = 4_096;
/** Most tables one catalog may hold, and most columns one table. */
const CATALOG_TABLES_MAX = 100_000;
const TABLE_COLUMNS_MAX = 32_768;
/** Longest name the program may hand back for a table or a column. A longer
 *  one is not a name any engine has. */
const TEXT_MAX_CHARS = 1_024;
/** Longest type. An engine's own text for a type can list every value of an
 *  enum. Only its first word is read, and none of it is kept. */
const TYPE_MAX_CHARS = 65_536;
/** Longest sentence about a failure that is kept for the person who asked. */
const MESSAGE_MAX_CHARS = 2_000;

// ── The job ──────────────────────────────────────────────────────────────────

export type JobKind = "test" | "query" | "pull" | "compare";

/** The longest a job another module has run may take: just under the 30
 *  minutes the module host gives one run of a program. */
export const STORE_JOB_MAX_MS = 30 * 60_000 - JOB_GRACE_MS;

/** The job's fields as the module hands them to the host. */
export interface DataRunnerJobInput {
  v: 1;
  /** 1 to 64 characters. It comes back in the output. */
  id: string;
  kind: JobKind;
  engine: Engine;
  database: string;
  tls: { mode: EncryptionMode; minVersion: TlsVersion; serverName?: string };
  /** The read login. This module starts no job with a login that writes. */
  login: { kind: "read"; user: string };
  /** An instant, in UTC. The program stops at it whatever it is doing. */
  deadline: string;
  /** For a query: one statement, and the most rows to answer. */
  params?: { sql: string; limit: number };
  /** For a pull or a compare: the store job the program sends its pages to. */
  store?: { gatewayUrl: string; storeId: string; jobId: string; key: string };
}

/**
 * The job as the program reads it from its standard input: the module's fields,
 * and the three things the host adds from the reach and the secret.
 */
export interface DataRunnerJob extends Omit<DataRunnerJobInput, "login"> {
  server: { host: string; port: number };
  reach: { kind: "direct"; host: string; port: number };
  login: { kind: "read"; user: string; password: string };
}

/** The field of `ProgramRun.secrets` that names the secret of the login's password. */
export const PASSWORD_FIELD = "password";

export interface JobSubject {
  engine: Engine;
  database: string;
  encryption: EncryptionMode;
  minTls: TlsVersion;
  serverName?: string;
  user: string;
}

export function testJob(id: string, subject: JobSubject, now: Date): DataRunnerJobInput {
  return {
    v: 1,
    id,
    kind: "test",
    engine: subject.engine,
    database: subject.database,
    tls: {
      mode: subject.encryption,
      minVersion: subject.minTls,
      ...(subject.serverName ? { serverName: subject.serverName } : {}),
    },
    login: { kind: "read", user: subject.user },
    deadline: new Date(now.getTime() + JOB_DEADLINE_MS).toISOString(),
  };
}

export function queryJob(
  id: string,
  subject: JobSubject,
  statement: string,
  rowCap: number,
  now: Date,
): DataRunnerJobInput {
  return { ...testJob(id, subject, now), kind: "query", params: { sql: statement, limit: rowCap } };
}

/** A pull or a compare: the connection's read login, and the store job the
 *  program works for. Its rows go from the program to the store's gateway. */
export function storeJob(
  id: string,
  subject: JobSubject,
  kind: "pull" | "compare",
  store: NonNullable<DataRunnerJobInput["store"]>,
  now: Date,
  deadlineMs: number,
): DataRunnerJobInput {
  return {
    ...testJob(id, subject, now),
    kind,
    deadline: new Date(now.getTime() + deadlineMs).toISOString(),
    store: { gatewayUrl: store.gatewayUrl, storeId: store.storeId, jobId: store.jobId, key: store.key },
  };
}

// ── The output ───────────────────────────────────────────────────────────────

export interface RunnerColumn {
  name: string;
  /** The engine's own type, as its catalog says it. */
  type: string;
  nullable: boolean;
  /** Its place in the primary key, from 1. */
  key?: number;
}

export interface RunnerTable {
  schema: string;
  name: string;
  kind: TableKind;
  rows: number | null;
  columns: RunnerColumn[];
}

export interface TestFindings {
  kind: "test";
  encryption: LinkEncryption;
  canWrite: boolean;
  writableTables: number;
  tables: RunnerTable[];
  truncated: boolean;
}

export interface QueryFindings {
  kind: "query";
  columns: { name: string; type: string }[];
  /** Every value is text, or null. */
  rows: (string | null)[][];
  /** A value was cut, or the statement has more rows than were answered. */
  more: boolean;
}

export interface PullFindings {
  kind: "pull";
  tables: PullTable[];
}

export interface CompareFindings extends CompareCounts {
  kind: "compare";
}

/** The two words the program fails a pull or a compare with that a test or a
 *  query never meets: the store's gateway refused a call, or the store reached
 *  its limit of writes. */
export type StoreFailure = "store" | "store_limit";
export type JobFailure = FailureCode | StoreFailure;

/** A job's failure as a test or a query records it. Neither works for a
 *  store, so a word about one is the program's own fault there. */
export function ownCode(code: JobFailure): FailureCode {
  return code === "store" || code === "store_limit" ? "internal" : code;
}

export type RunnerOutput =
  | { ok: true; findings: TestFindings | QueryFindings | PullFindings | CompareFindings }
  | {
      ok: false;
      code: JobFailure;
      /** The program's sentence about the failure. It can quote the database's
       *  own words, so it goes to the person who asked and nowhere else: not
       *  to a log, not to the audit trail, not into an answer to an ask. */
      message: string;
    };

/** The output is not one this module can read. Nothing of it is kept. */
const UNREADABLE: RunnerOutput = { ok: false, code: "output_invalid", message: "" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

/** The words the program may fail with that this module passes on as they are. */
const PROGRAM_CODES: ReadonlySet<string> = new Set([
  "unreachable",
  "tls",
  "login",
  "database",
  "deadline",
  "not_ready",
  "internal",
]);

function failureCodeOf(code: unknown, kind: JobKind): JobFailure {
  if ((code === "store" || code === "store_limit") && (kind === "pull" || kind === "compare")) return code;
  // A code this build does not know, and the codes a job that dials a server
  // itself never answers, are the program's own fault as far as a reader of
  // this HX Fortress can tell.
  if (typeof code !== "string" || !PROGRAM_CODES.has(code)) return "internal";
  return (FAILURE_CODES as readonly string[]).includes(code) ? (code as FailureCode) : "internal";
}

function readTable(value: unknown): RunnerTable | null {
  if (!isRecord(value)) return null;
  const { schema, name, kind, rows, columns } = value;
  if (!isText(schema, TEXT_MAX_CHARS) || !isText(name, TEXT_MAX_CHARS)) return null;
  if (typeof kind !== "string" || !(TABLE_KINDS as readonly string[]).includes(kind)) return null;
  if (rows !== null && !isCount(rows)) return null;
  if (!Array.isArray(columns) || columns.length > TABLE_COLUMNS_MAX) return null;
  const out: RunnerColumn[] = [];
  for (const column of columns as unknown[]) {
    if (!isRecord(column)) return null;
    if (!isText(column.name, TEXT_MAX_CHARS) || !isText(column.type, TYPE_MAX_CHARS)) return null;
    if (typeof column.nullable !== "boolean") return null;
    if (column.key !== undefined && (!isCount(column.key) || column.key < 1)) return null;
    out.push({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      ...(column.key === undefined ? {} : { key: column.key }),
    });
  }
  return { schema, name, kind: kind as TableKind, rows, columns: out };
}

function readTest(result: Record<string, unknown>): TestFindings | null {
  const { encryption, write, catalog } = result;
  if (!isRecord(encryption) || !isRecord(write) || !isRecord(catalog)) return null;
  if (typeof encryption.kind !== "string" || typeof encryption.verified !== "boolean") return null;
  if (!["tls", "oracle", "none"].includes(encryption.kind)) return null;
  if (typeof write.canWrite !== "boolean" || !isCount(write.writableCount)) return null;
  if (typeof catalog.truncated !== "boolean" || !Array.isArray(catalog.tables)) return null;
  if (catalog.tables.length > CATALOG_TABLES_MAX) return null;
  const tables: RunnerTable[] = [];
  for (const table of catalog.tables as unknown[]) {
    const read = readTable(table);
    if (!read) return null;
    tables.push(read);
  }
  return {
    kind: "test",
    encryption:
      encryption.kind === "none" ? "none" : encryption.verified ? "verified" : "not_verified",
    canWrite: write.canWrite,
    writableTables: write.writableCount,
    tables,
    truncated: catalog.truncated,
  };
}

function readQuery(result: Record<string, unknown>, rowCap: number): QueryFindings | null {
  const { columns, rows, truncated } = result;
  if (typeof truncated !== "boolean") return null;
  if (!Array.isArray(columns) || columns.length > QUERY_COLUMNS_MAX) return null;
  if (!Array.isArray(rows) || rows.length > rowCap) return null;
  const outColumns: { name: string; type: string }[] = [];
  for (const column of columns as unknown[]) {
    if (!isRecord(column)) return null;
    if (!isText(column.name, TEXT_MAX_CHARS) || !isText(column.type, TYPE_MAX_CHARS)) return null;
    outColumns.push({ name: column.name, type: column.type });
  }
  const outRows: (string | null)[][] = [];
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row) || row.length !== outColumns.length) return null;
    const cells: (string | null)[] = [];
    for (const cell of row as unknown[]) {
      if (cell !== null && !isText(cell, CELL_MAX_CHARS)) return null;
      cells.push(cell);
    }
    outRows.push(cells);
  }
  return { kind: "query", columns: outColumns, rows: outRows, more: truncated };
}

function readPull(result: Record<string, unknown>): PullFindings | null {
  if (!Array.isArray(result.tables) || result.tables.length > CATALOG_TABLES_MAX) return null;
  const tables: PullTable[] = [];
  for (const table of result.tables as unknown[]) {
    if (!isRecord(table)) return null;
    const { source, into, mode, read, sent, removed, pages, cut } = table;
    if (!isText(source, TEXT_MAX_CHARS) || !isText(into, TEXT_MAX_CHARS)) return null;
    if (mode !== "new" && mode !== "change") return null;
    if (!isCount(read) || !isCount(sent) || !isCount(removed) || !isCount(pages) || !isCount(cut)) return null;
    tables.push({ source, into, mode, read, sent, removed, pages, cut });
  }
  return { kind: "pull", tables };
}

function readCompare(result: Record<string, unknown>): CompareFindings | null {
  const { job, read, targetRows, sent, same, otherRows } = result;
  if (job !== "push_preview" && job !== "compare") return null;
  if (!isCount(read) || !isCount(targetRows) || !isCount(sent) || !isCount(same) || !isCount(otherRows)) {
    return null;
  }
  return { kind: "compare", job, read, targetRows, sent, same, otherRows };
}

/**
 * Read the one value the program printed for a job.
 *
 * `rowCap` is the most rows the job asked for: a query's answer with more is
 * not an answer to this job. The id must be the job's, and the kind of result
 * must be the job's kind.
 */
export function readOutput(
  value: unknown,
  job: { id: string; kind: JobKind; rowCap?: number },
): RunnerOutput {
  if (!isRecord(value) || value.v !== 1 || typeof value.ok !== "boolean") return UNREADABLE;
  if (value.ok === false) {
    const error = value.error;
    if (!isRecord(error)) return UNREADABLE;
    // A job the program could not read at all comes back with no id.
    if (value.id !== job.id && value.id !== "") return UNREADABLE;
    return {
      ok: false,
      code: failureCodeOf(error.code, job.kind),
      message: typeof error.message === "string" ? error.message.slice(0, MESSAGE_MAX_CHARS) : "",
    };
  }
  if (value.id !== job.id) return UNREADABLE;
  const result = value.result;
  if (!isRecord(result) || result.kind !== job.kind) return UNREADABLE;
  const findings =
    job.kind === "test"
      ? readTest(result)
      : job.kind === "query"
        ? readQuery(result, job.rowCap ?? QUERY_ROWS_MAX)
        : job.kind === "pull"
          ? readPull(result)
          : readCompare(result);
  return findings ? { ok: true, findings } : UNREADABLE;
}

/** The step a failed job stopped at, from the word it failed with. */
export function stepOfFailure(code: FailureCode): JobStep {
  switch (code) {
    case "unreachable":
      return "reach";
    case "tls":
      return "encryption";
    case "login":
      return "sign_in";
    case "database":
    case "catalog_not_kept":
      return "catalog";
    default:
      // The program was not started, was stopped, or could not say.
      return "start";
  }
}

// ── Running one job ──────────────────────────────────────────────────────────

/** What a job is run against: a reach's name, and the name of the secret that
 *  holds the login's password. Never an address, never a value. */
export interface JobTarget {
  reach: string;
  keyName: string;
}

/** The host did not answer within the job's time and its grace. */
class HostSilent extends Error {}

const failed = (code: FailureCode): RunnerOutput => ({ ok: false, code, message: "" });

/**
 * Hand the host one job for the data runner, wait for it, and read what the
 * program printed. Never rejects.
 *
 * `abort` is the job's own: aborting it has the host end the program. When the
 * host itself does not answer in the job's time, this aborts it too, so that a
 * job which is given up on is also told to stop.
 *
 * What the program printed is held here and nowhere else: only the value
 * rebuilt by `readOutput` is returned.
 */
export async function runJob(
  programs: ProgramsPort,
  job: DataRunnerJobInput,
  target: JobTarget,
  abort: AbortController,
  options: {
    /** How long the job itself may take. A test's and a query's two minutes
     *  when left out. */
    deadlineMs?: number;
    silentAfterMs?: number;
    onThrown?: (thrown: unknown) => void;
  } = {},
): Promise<RunnerOutput> {
  const deadlineMs = options.deadlineMs ?? JOB_DEADLINE_MS;
  let printed: unknown;
  let outputs = 0;
  let outcome: ProgramOutcome;
  try {
    outcome = await withDeadline(
      programs.run(DATA_RUNNER_PROGRAM, {
        reach: target.reach,
        secrets: { [PASSWORD_FIELD]: target.keyName },
        input: job,
        onOutput: (value) => {
          outputs += 1;
          printed = value;
        },
        timeoutMs: deadlineMs + JOB_GRACE_MS,
        signal: abort.signal,
      }),
      options.silentAfterMs ?? deadlineMs + 2 * JOB_GRACE_MS,
      "the host did not answer",
      { error: () => new HostSilent(), unref: true },
    );
  } catch (thrown) {
    if (thrown instanceof HostSilent) {
      abort.abort();
      return failed("timeout");
    }
    // What was thrown is another component's text. The caller may log its
    // kind. It is no part of how the job ended.
    options.onThrown?.(thrown);
    outcome = { ok: false, code: "program_failed" };
  }
  if (abort.signal.aborted) return failed("interrupted");
  if (!outcome.ok) return failed(outcome.code);
  // The program prints one line. Were there more, the last is its output.
  if (outputs === 0) return failed("output_invalid");
  return readOutput(printed, {
    id: job.id,
    kind: job.kind,
    ...(job.params === undefined ? {} : { rowCap: job.params.limit }),
  });
}
