// Running one query for a data island.
//
// A data island is a small page this Fortress serves, shown in a frame of the
// control plane's page. When it shows a query's rows, it asks this Fortress for
// them with two keys: the person's own sign-in at this Fortress, and a grant
// the control plane signed for exactly this person, this connection and these
// settings. The door that checks both keys is the module host's. What is here
// is what happens once both have been checked.
//
// WHAT THE STATEMENT IS. It is `settings.query`. The grant carries a hash of
// the settings, so the statement that runs is the statement the control plane
// vouched for, for this person. A statement taken from anywhere else in the
// request would not be: one grant would then run any statement at all.
//
// THE ORDER.
//
//   1. The request is for a kind of data island this module answers, names a
//      connection this organization has, and holds one statement.
//   2. The statement is one statement that only reads (read-only.ts).
//   3. The line for the audit trail is written: the person, the connection and
//      the statement's text. If it cannot be written, nothing runs.
//   4. The module host is handed one job for the data runner.
//   5. How it ended is written, and the rows go back to the caller.
//
// WHERE THE ROWS GO. To the caller, and nowhere else. Not into this module's
// state, not into the audit trail, not into a log, not into an answer to an
// ask. The record of the query holds how many rows there were.

import type { Connection } from "./connections";
import { subjectOf } from "./connections";
import {
  JOB_DEADLINE_MS,
  JOB_GRACE_MS,
  PASSWORD_FIELD,
  QUERY_ROWS_MAX,
  QUERY_STATEMENT_MAX_CHARS,
  queryJob,
  readOutput,
} from "./data-runner";
import type { ContextPorts, Person, ProgramOutcome } from "./host-ports";
import { DATA_RUNNER_PROGRAM, DATABASES_ISLAND_KINDS, type FailureCode } from "./manifest";
import { statementRefusal, type StatementRefusal } from "./read-only";

/** What the door hands the module for one read of a data island. */
export interface DataIslandRequest {
  /** The kind of data island: one of the closed list. */
  kind: string;
  /** For this module: a connection's name. */
  target: string;
  /** What the control plane keeps for the data island, and what the grant's
   *  hash covers. For this module: `{ query, rows? }`. */
  settings: unknown;
  /** What the data island itself sent. This module reads nothing from it. */
  body?: unknown;
}

export interface QueryAnswer {
  columns: { name: string; type: string }[];
  /** Every value is text, or null. */
  rows: (string | null)[][];
  /** The statement has more rows than these, or a value was cut. */
  more: boolean;
}

/** Why a query did not answer, as this module says it. */
export type QueryReason =
  | "kind_not_served"
  | "connection_unknown"
  | "statement_missing"
  | "statement_too_long"
  | "rows_invalid"
  | `statement_${StatementRefusal}`
  | "record_unavailable"
  | FailureCode;

/**
 * A query that did not answer.
 *
 * `code` is what the page around the data island is told: one of the door's
 * words, and nothing more. `reason` is this module's own word, for the record.
 * `words` is one sentence for the person, shown inside the data island. It can
 * hold the database's own words about a failure, so it goes to that person's
 * browser and nowhere else.
 */
export class QueryRefused extends Error {
  constructor(
    readonly code: "not-allowed" | "query-failed",
    readonly reason: QueryReason,
    readonly words: string,
  ) {
    super(`a query did not answer: ${reason}`);
    this.name = "QueryRefused";
  }
}

const STATEMENT_WORDS: Record<StatementRefusal, string> = {
  empty: "There is no statement to run.",
  not_a_select: "A query reads. It starts with SELECT or WITH.",
  several_statements: "A query is one statement.",
  writes:
    "This statement would change the database, so it did not run. A query only reads. A column that is named like a command is written in quotes.",
  not_closed: "A quote, a bracket or a comment in this statement is never closed.",
  backslash_quote:
    "Write a quote inside a text as two quotes. A backslash before a quote is read differently by different databases.",
  dashes_without_space: "Put a space after the two dashes of a comment.",
  hash_sign: "A # outside quotes starts a comment on some databases, so it is not taken.",
  comment_that_runs: "This statement holds a comment that some databases run, so it did not run.",
};

const FAILURE_WORDS: Partial<Record<FailureCode, string>> = {
  unreachable: "This Fortress could not reach the database's server.",
  tls: "The link to the database could not be encrypted the way this connection asks.",
  login: "The database refused this connection's login.",
  deadline: "The database took too long to answer.",
  timeout: "The database took too long to answer.",
  busy: "Too many jobs are running on this Fortress. Try again in a moment.",
  program_not_installed: "This Fortress has no data runner program installed, so it cannot reach a database.",
  reach_not_listed: "This connection's server is not on this Fortress's list of hosts.",
  secret_not_added: "This connection's login is not on this Fortress's list of secret names.",
  secret_missing: "The secret that holds this connection's login is not in the key store.",
  secret_unavailable: "The key store did not answer.",
  interrupted: "This Fortress was stopping, so the query did not run.",
};

const DID_NOT_ANSWER = "The query did not answer.";

function settingsOf(settings: unknown): { statement: unknown; rows: unknown } {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return { statement: undefined, rows: undefined };
  }
  const held = settings as Record<string, unknown>;
  return {
    statement: Object.hasOwn(held, "query") ? held.query : undefined,
    rows: Object.hasOwn(held, "rows") ? held.rows : undefined,
  };
}

export interface QueryRun {
  ports: ContextPorts;
  /** Finds the connection a request names, in the organization's book. */
  connection: (name: string) => Promise<Connection | undefined>;
  /** Takes a place among the running jobs, or says there is none. */
  begin: () => { id: string; signal: AbortSignal; end: () => void } | null;
  clock: () => Date;
}

/**
 * Run one query for one person. Returns the rows, or throws `QueryRefused`.
 *
 * `person` has passed the door: their sign-in was checked, and the grant named
 * them, this connection and these settings.
 */
export async function runQuery(
  request: DataIslandRequest,
  person: Person,
  run: QueryRun,
): Promise<QueryAnswer> {
  const who = person.email ?? person.login;
  const { statement, rows } = settingsOf(request.settings);
  const text = typeof statement === "string" ? statement : "";
  // What the record holds of the statement: all of it, up to the longest
  // statement a query takes. A longer one is refused, and its start is kept.
  const intent = {
    person: who,
    connection: request.target,
    statement: text.slice(0, QUERY_STATEMENT_MAX_CHARS),
  };

  const refuse = async (
    code: "not-allowed" | "query-failed",
    reason: QueryReason,
    words: string,
  ): Promise<never> => {
    // A refusal is a line too. If even that cannot be written, the answer is
    // the same refusal: nothing ran either way.
    await run.ports.queryRecords.refused(intent, reason).catch(() => {});
    throw new QueryRefused(code, reason, words);
  };

  if (!(DATABASES_ISLAND_KINDS as readonly string[]).includes(request.kind)) {
    return refuse("not-allowed", "kind_not_served", "This Fortress does not show rows in this kind of piece.");
  }
  if (text.trim() === "") return refuse("query-failed", "statement_missing", STATEMENT_WORDS.empty);
  if (text.length > QUERY_STATEMENT_MAX_CHARS) {
    return refuse(
      "query-failed",
      "statement_too_long",
      `A statement is at most ${QUERY_STATEMENT_MAX_CHARS} characters.`,
    );
  }
  let rowCap = QUERY_ROWS_MAX;
  if (rows !== undefined) {
    if (typeof rows !== "number" || !Number.isInteger(rows) || rows < 1 || rows > QUERY_ROWS_MAX) {
      return refuse("query-failed", "rows_invalid", `A query answers 1 to ${QUERY_ROWS_MAX} rows.`);
    }
    rowCap = rows;
  }
  let connection: Connection | undefined;
  try {
    connection = await run.connection(request.target);
  } catch {
    // The module's own record of its connections could not be read.
    return refuse("query-failed", "internal", DID_NOT_ANSWER);
  }
  if (!connection) {
    return refuse("query-failed", "connection_unknown", "This Fortress has no connection of that name.");
  }
  const refusal = statementRefusal(text);
  if (refusal) {
    // One of a closed list of nine words, joined to a fixed prefix.
    // eslint-disable-next-line security/detect-object-injection
    return refuse("query-failed", `statement_${refusal}`, STATEMENT_WORDS[refusal]);
  }

  const place = run.begin();
  if (!place) return refuse("query-failed", "busy", FAILURE_WORDS.busy ?? DID_NOT_ANSWER);
  try {
    let record;
    try {
      record = await run.ports.queryRecords.open({ ...intent, job: place.id });
    } catch {
      // No line in the audit trail, so no query.
      throw new QueryRefused(
        "query-failed",
        "record_unavailable",
        "This Fortress could not write the query to its audit trail, so it did not run it.",
      );
    }

    let printed: unknown;
    let outputs = 0;
    let outcome: ProgramOutcome;
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      outcome = await Promise.race([
        run.ports.programs.run(DATA_RUNNER_PROGRAM, {
          reach: connection.name,
          secrets: { [PASSWORD_FIELD]: connection.keyName },
          input: queryJob(place.id, subjectOf(connection), text, rowCap, run.clock()),
          onOutput: (value) => {
            outputs += 1;
            printed = value;
          },
          timeoutMs: JOB_DEADLINE_MS + JOB_GRACE_MS,
          signal: place.signal,
        }),
        new Promise<ProgramOutcome>((resolve) => {
          guard = setTimeout(
            () => resolve({ ok: false, code: "timeout" }),
            JOB_DEADLINE_MS + 2 * JOB_GRACE_MS,
          );
          (guard as { unref?: () => void }).unref?.();
        }),
      ]);
    } catch {
      outcome = { ok: false, code: "program_failed" };
    } finally {
      if (guard) clearTimeout(guard);
    }

    const failed = async (code: FailureCode, words?: string): Promise<never> => {
      await record.close({ outcome: "failed", code });
      // Each code is one of the closed list of failure words.
      // eslint-disable-next-line security/detect-object-injection
      throw new QueryRefused("query-failed", code, words || FAILURE_WORDS[code] || DID_NOT_ANSWER);
    };
    if (place.signal.aborted) return await failed("interrupted");
    if (!outcome.ok) return await failed(outcome.code);
    if (outputs === 0) return await failed("output_invalid");
    const read = readOutput(printed, { id: place.id, kind: "query", rowCap });
    // The database's own sentence about a statement it would not run is for
    // the person who wrote the statement. It is shown to them and kept nowhere.
    if (!read.ok) return await failed(read.code, read.code === "database" ? read.message : undefined);
    if (read.findings.kind !== "query") return await failed("output_invalid");
    const { columns, rows: answered, more } = read.findings;
    await record.close({ outcome: "ran", rows: answered.length, more });
    return { columns, rows: answered, more };
  } finally {
    place.end();
  }
}
