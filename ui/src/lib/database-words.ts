// The words of the Databases page: what a connection's state reads as, the
// step a test is on, why a test failed, and what the last test found.
//
// The Databases module answers each of these as one word of a closed list.
// This file has a sentence for every word of every list, and
// test/ui-database-words.test.ts fails when the module grows a word that has
// none. A word this build does not know is shown as it is.

import { plural } from "../format";
import type { DatabaseConnectionView, DatabaseTestView } from "../api";

/** How a state shows: its word, and the colour of its pill and its dot. */
export interface StateWords {
  label: string;
  tone: "ok" | "warn" | "danger" | "off" | "busy";
}

/** The steps of a test, in the order a test takes them. */
export const STEP_WORDS: Readonly<Record<DatabaseTestView["step"], string>> = {
  start: "Starting the data runner",
  reach: "Reaching the server",
  encryption: "Checking the encryption",
  sign_in: "Signing in",
  catalog: "Reading the tables",
};

/** Why a test failed. The database's own sentence about a failure stays in
 *  the daemon, because it can quote a value: these are this console's words
 *  for the module's one word. */
export const FAILURE_WORDS: Readonly<Record<string, string>> = {
  unreachable: "The server could not be reached.",
  tls: "The encryption could not be agreed, or the server's certificate was not accepted.",
  login: "The server refused this login.",
  database: "The server has no such database, or this login may not open it.",
  deadline: "The test took too long and was stopped.",
  not_ready: "The data runner could not take this job.",
  internal: "The data runner failed.",

  program_not_declared: "This HX Fortress does not start the data runner for this module.",
  program_not_installed: "This HX Fortress has no data runner it can start.",
  reach_not_listed: "The server is not on this HX Fortress's list of hosts.",
  secret_not_added: "The secret's name is not on this HX Fortress's list of secret names.",
  secret_missing: "The key store holds no secret of this name.",
  secret_unavailable: "The key store did not answer.",
  busy: "This HX Fortress was running as many jobs as it can at once.",
  timeout: "The data runner did not finish in time.",
  program_failed: "The data runner stopped without an answer.",

  output_invalid: "The data runner's answer could not be read.",
  interrupted: "The daemon stopped while the test ran.",
  catalog_not_kept: "The test passed, and what it read could not be kept on this host's disk.",
};

/** The sentence for a test's failure. */
export function failureWords(code: string | undefined): string {
  if (code === undefined) return "The test failed.";
  return new Map(Object.entries(FAILURE_WORDS)).get(code) ?? `The test failed: ${code}`;
}

/** Whether the last test found that the login can change data. Such a
 *  connection is reachable, and no query runs on it. */
export function loginCanWrite(connection: DatabaseConnectionView): boolean {
  return connection.state === "ready" && connection.test?.canWrite === true;
}

export function stateWords(connection: DatabaseConnectionView): StateWords {
  switch (connection.state) {
    case "testing":
      return { label: "Testing", tone: "busy" };
    case "ready":
      return loginCanWrite(connection) ? { label: "Login can write", tone: "warn" } : { label: "Ready", tone: "ok" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    default:
      return { label: "Not tested", tone: "off" };
  }
}

/** One line under a connection's state: what is happening, or what happened. */
export function stateLine(connection: DatabaseConnectionView): string {
  const test = connection.test;
  switch (connection.state) {
    case "testing":
      return test ? STEP_WORDS[test.step] : "Starting the test";
    case "ready":
      return loginCanWrite(connection)
        ? "This login can change data. A query runs only with a login that can only read."
        : "The last test passed.";
    case "failed":
      return failureWords(test?.code);
    default:
      return "No test has run yet.";
  }
}

/** How the link was encrypted in the last test that got that far. */
export function linkWords(encryption: DatabaseTestView["encryption"]): string | null {
  switch (encryption) {
    case "verified":
      return "Encrypted, and the server's certificate was checked";
    case "not_verified":
      return "Encrypted, and the server's certificate was not checked";
    case "none":
      return "Not encrypted";
    default:
      return null;
  }
}

/** What the last test read: "412 tables, 5,930 columns", and what it left out. */
export function catalogWords(test: DatabaseTestView): string | null {
  if (test.tables === undefined) return null;
  const parts = [plural(test.tables, "table")];
  if (test.columns !== undefined) parts.push(plural(test.columns, "column"));
  let words = parts.join(", ");
  const leftOut: string[] = [];
  if (test.leftOutTables) leftOut.push(plural(test.leftOutTables, "table"));
  if (test.leftOutColumns) leftOut.push(plural(test.leftOutColumns, "column"));
  if (leftOut.length > 0) words += `. Left out: ${leftOut.join(" and ")}`;
  else if (test.truncated) words += ". The database has more than this HX Fortress keeps";
  return words;
}

/** Who started a test. */
export function startedByWords(test: DatabaseTestView): string {
  if (test.origin === "control_plane") return "the control plane";
  return test.by ?? "a person at this console";
}
