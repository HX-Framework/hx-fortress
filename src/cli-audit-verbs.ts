// `hx-fortress audit` — the two terminal verbs the corrective rung depends on.
//
// Neither of them touches the database. `audit witness on|off` writes its intent
// and SIGNALS the daemon, which holds the credential and executes the fenced
// routine; `audit acks reconcile` joins the daemon's PUBLISHED acknowledgements
// against the 0600 audit spool this host already owns. Giving the CLI a database
// credential would turn hx_ui from "the console process" into "the console
// process and every shell on this host", which is the containment story the
// whole command plane rests on.
//
// Without these two verbs the corrective rung asks an operator to hand-parse
// JSONL and join it to a table they cannot query.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { fortressPaths } from "./host/paths";
import {
  readPublishedAcks,
  readPublishedAuditSettings,
  signalDaemon,
  writeWitnessIntent,
  type PublishedAck,
} from "./console/witness-signal";

export interface AuditVerbDeps {
  writeLine: (line: string) => void;
  fortressRoot?: string;
  now?: () => Date;
  /** The daemon's pid, from its own status file. */
  daemonPid?: () => Promise<number | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
}

const NO_DAEMON =
  "the daemon is not running, and it is the only thing that may write this setting. " +
  "Start it with `hx-fortress start`, then run this again.";

export async function runAuditVerb(
  args: readonly string[],
  deps: AuditVerbDeps,
): Promise<number> {
  switch (args[0]) {
    case "witness":
      return await witnessVerb(args.slice(1), deps);
    case "acks":
      return await acksVerb(args.slice(1), deps);
    default:
      throw new Error("usage: hx-fortress audit witness on|off|show | acks reconcile [--re-confirm]");
  }
}

async function daemonPidOf(deps: AuditVerbDeps): Promise<number | null> {
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

async function witnessVerb(args: readonly string[], deps: AuditVerbDeps): Promise<number> {
  const paths = fortressPaths(deps.fortressRoot);
  if (args[0] === "show") {
    const published = await readPublishedAuditSettings(paths.runtimeRoot);
    if (!published) {
      deps.writeLine("Cloud witness: unknown - the daemon has published no setting yet.");
      return 0;
    }
    deps.writeLine(`Cloud witness: ${published.cloudWitness ? "on" : "off"}`);
    deps.writeLine(
      published.cloudWitness
        ? "  Session ids of cloud-relayed sessions are sent to let.ai during an audit."
        : "  No session id leaves this host during an audit; every eligible session reports the witness as unavailable.",
    );
    deps.writeLine(`  as of ${published.writtenAt}`);
    return 0;
  }
  if (args[0] !== "on" && args[0] !== "off") {
    throw new Error("usage: hx-fortress audit witness on|off|show");
  }
  const enabled = args[0] === "on";
  const pid = await daemonPidOf(deps);
  await writeWitnessIntent(paths.runtimeRoot, {
    enabled,
    at: (deps.now ?? ((): Date => new Date()))().toISOString(),
  });
  if (!signalDaemon(pid, deps.kill as typeof process.kill | undefined)) {
    // Left on disk deliberately: the daemon applies it at its next signal, and
    // a setting that gates egress must never be reported as changed when it was
    // not.
    throw new Error(NO_DAEMON);
  }
  deps.writeLine(`Asked the fortress to turn the cloud witness ${enabled ? "on" : "off"}.`);
  deps.writeLine("Confirm it with `hx-fortress audit witness show`.");
  return 0;
}

interface SpoolLine {
  action?: string;
  params?: Record<string, unknown> | null;
}

/** Every session an acknowledgement was recorded FOR, according to the durable
 *  0600 trail this host writes. */
async function acknowledgedInSpool(dir: string): Promise<Set<string>> {
  const seen = new Set<string>();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return seen;
  }
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let record: SpoolLine;
      try {
        record = JSON.parse(line) as SpoolLine;
      } catch {
        continue;
      }
      // Either shape counts: the console records the KIND in its parameters and
      // the daemon names the act in its action. A reconcile that matched only
      // one of the two would report every acknowledgement from the other side
      // as unexplained.
      const kind = record.params?.commandKind;
      const names =
        record.action?.includes("acknowledge_finding") === true ||
        kind === "acknowledge_finding";
      if (!names) continue;
      const session = record.params?.sessionId ?? record.params?.session;
      if (typeof session === "string") seen.add(session);
    }
  }
  return seen;
}

/**
 * Acknowledgements with no record of anyone making them.
 *
 * The trail and the table are two independent media, and the corrective pass
 * reconciles in BOTH directions: a row nothing in the spool explains is exactly
 * what a forged acknowledgement looks like, and it is re-confirmed by an
 * operator rather than deleted — nothing in this system deletes an
 * acknowledgement, and a corrective pass that could would be the forgery it is
 * meant to detect.
 */
async function acksVerb(args: readonly string[], deps: AuditVerbDeps): Promise<number> {
  if (args[0] !== "reconcile") {
    throw new Error("usage: hx-fortress audit acks reconcile [--re-confirm]");
  }
  const paths = fortressPaths(deps.fortressRoot);
  const acks = await readPublishedAcks(paths.runtimeRoot);
  const spooled = await acknowledgedInSpool(paths.auditSpool);
  const unmatched = acks.filter((ack: PublishedAck) => !spooled.has(ack.sessionId));

  if (acks.length === 0) {
    deps.writeLine("The daemon has published no acknowledgements to reconcile.");
    return 0;
  }
  if (unmatched.length === 0) {
    deps.writeLine(`All ${acks.length} acknowledgements have a matching record in this host's audit trail.`);
    return 0;
  }
  deps.writeLine(`${unmatched.length} acknowledgement(s) have no matching record in this host's audit trail:`);
  for (const ack of unmatched) {
    deps.writeLine(
      `  ${ack.sessionId}  ${ack.org}  ${ack.acknowledgedAt}` +
        `${ack.acknowledgedBy ? `  by ${ack.acknowledgedBy}` : ""}` +
        `${ack.reason ? `  ${ack.reason}` : ""}`,
    );
  }
  if (!args.includes("--re-confirm")) {
    deps.writeLine("");
    deps.writeLine("Nothing was changed. Re-confirm the ones you recognize with:");
    deps.writeLine("  hx-fortress audit acks reconcile --re-confirm");
    return 0;
  }
  const pid = await daemonPidOf(deps);
  await writeWitnessIntent(paths.runtimeRoot, {
    // The witness setting is not being changed here, so it is OMITTED rather
    // than re-asserted. The published mirror only exists on a host where someone
    // ran an explicit toggle, so `?? false` was a guess — and one that switched
    // the witness off on every fortress that had never touched it.
    at: (deps.now ?? ((): Date => new Date()))().toISOString(),
    reconfirm: unmatched.map((ack) => ({
      org: ack.org,
      sessionId: ack.sessionId,
      reason: ack.reason ?? "re-confirmed from the terminal",
    })),
  });
  if (!signalDaemon(pid, deps.kill as typeof process.kill | undefined)) {
    throw new Error(NO_DAEMON);
  }
  deps.writeLine(`Asked the fortress to re-confirm ${unmatched.length} acknowledgement(s).`);
  deps.writeLine("Each one is written again through the fenced routine, and lands in this host's trail.");
  return 0;
}
