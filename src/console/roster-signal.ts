// `hx-fortress roster purge-inactive`, and why it is a signal rather than a
// database call.
//
// Same rule as the audit verbs: a terminal never holds a database credential.
// The daemon owns the connection, so the terminal writes its INTENT to a 0600
// file under the daemon's own runtime directory and signals; the daemon does the
// delete and PUBLISHES what it removed, which is what the verb then reports.
//
// The published result is what makes the verb honest. A purge that printed
// "asked" and nothing else would leave an operator unable to tell a sweep that
// removed nothing from one that never ran.

import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { writePrivateJson } from "../host/private-json";

/** The same signal the audit intents ride. One channel, several intents: the
 *  daemon applies whichever files are present when it wakes. */
export { WITNESS_SIGNAL as ROSTER_SIGNAL } from "./witness-signal";

export interface RosterPurgeIntent {
  /** Null means "whatever the daemon's configured retention is" — the terminal
   *  does not read config.json to answer a question the daemon already knows. */
  days: number | null;
  at: string;
}

export interface RosterPurgeResult {
  at: string;
  removed: number;
  days: number;
}

export function rosterPurgeIntentPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "roster-purge-intent.json");
}

export function rosterPurgeResultPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "roster-purge.json");
}

const writeJson = (file: string, value: unknown): Promise<void> => writePrivateJson(file, value);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeRosterPurgeIntent(runtimeRoot: string, intent: RosterPurgeIntent): Promise<void> {
  return writeJson(rosterPurgeIntentPath(runtimeRoot), intent);
}

export function readRosterPurgeIntent(runtimeRoot: string): Promise<RosterPurgeIntent | null> {
  return readJson<RosterPurgeIntent>(rosterPurgeIntentPath(runtimeRoot));
}

export async function clearRosterPurgeIntent(runtimeRoot: string): Promise<void> {
  await rm(rosterPurgeIntentPath(runtimeRoot), { force: true });
}

export function publishRosterPurge(runtimeRoot: string, result: RosterPurgeResult): Promise<void> {
  return writeJson(rosterPurgeResultPath(runtimeRoot), result);
}

export function readRosterPurge(runtimeRoot: string): Promise<RosterPurgeResult | null> {
  return readJson<RosterPurgeResult>(rosterPurgeResultPath(runtimeRoot));
}
