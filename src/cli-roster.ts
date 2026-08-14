// `hx-fortress roster` — the terminal half of roster retention.
//
// The sweep runs daily inside the daemon; this verb is the "now, and tell me
// what it removed" form of the same thing. It asks and then WAITS for the
// daemon's published result, because the useful answer is a number of rows and
// the daemon is the only process that can produce it.

import { readFile } from "node:fs/promises";

import { fortressPaths } from "./host/paths";
import { signalDaemon } from "./console/witness-signal";
import {
  readRosterPurge,
  writeRosterPurgeIntent,
  type RosterPurgeResult,
} from "./console/roster-signal";

export interface RosterVerbDeps {
  writeLine: (line: string) => void;
  fortressRoot?: string;
  now?: () => Date;
  daemonPid?: () => Promise<number | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  /** How long to wait for the daemon's answer, and how often to look. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const NO_DAEMON =
  "the daemon is not running, and it is the only thing that may write the roster. " +
  "Start it with `hx-fortress start`, then run this again.";

export async function runRosterVerb(args: readonly string[], deps: RosterVerbDeps): Promise<number> {
  if (args[0] !== "purge-inactive") {
    throw new Error("usage: hx-fortress roster purge-inactive [--days <n>]");
  }
  const days = parseDays(args.slice(1));
  const paths = fortressPaths(deps.fortressRoot);
  const now = deps.now ?? ((): Date => new Date());
  const requestedAt = now().toISOString();

  const before = await readRosterPurge(paths.runtimeRoot);
  await writeRosterPurgeIntent(paths.runtimeRoot, { days, at: requestedAt });
  const pid = await daemonPidOf(deps);
  if (!signalDaemon(pid, deps.kill as typeof process.kill | undefined)) {
    throw new Error(NO_DAEMON);
  }

  const result = await awaitResult(paths.runtimeRoot, before, deps);
  if (!result) {
    deps.writeLine("Asked the fortress to purge departed roster members.");
    deps.writeLine("It has not reported back yet — check `hx-fortress logs` for the sweep.");
    return 0;
  }
  deps.writeLine(
    `Purged ${result.removed} roster row(s) for members who left more than ${result.days} days ago.`,
  );
  // Said explicitly, because it is the property that makes the sweep safe to
  // run: the sessions those people uploaded are unaffected by it.
  deps.writeLine("Their sessions on this fortress are untouched — this removes directory rows only.");
  return 0;
}

function parseDays(args: readonly string[]): number | null {
  const at = args.indexOf("--days");
  if (at === -1) return null;
  const raw = args[at + 1];
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    throw new Error("--days takes a whole number of days between 0 and 3650");
  }
  return days;
}

async function daemonPidOf(deps: RosterVerbDeps): Promise<number | null> {
  if (deps.daemonPid) return await deps.daemonPid();
  const paths = fortressPaths(deps.fortressRoot);
  try {
    const raw: unknown = JSON.parse(await readFile(paths.status, "utf8"));
    const pid = (raw as { host?: { pid?: unknown } }).host?.pid;
    return typeof pid === "number" && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The daemon's answer to THIS request. A result the previous sweep left behind
 *  is not one: the verb would report someone else's number as its own. */
async function awaitResult(
  runtimeRoot: string,
  before: RosterPurgeResult | null,
  deps: RosterVerbDeps,
): Promise<RosterPurgeResult | null> {
  const waitMs = deps.waitMs ?? 10_000;
  const pollMs = deps.pollMs ?? 250;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; waited <= waitMs; waited += pollMs) {
    const result = await readRosterPurge(runtimeRoot);
    if (result && result.at !== before?.at) return result;
    if (waited + pollMs > waitMs) break;
    await sleep(pollMs);
  }
  return null;
}
