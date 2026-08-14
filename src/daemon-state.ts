// The ONE predicate for "is the daemon up", shared by the CLI and the console.
//
// It is the shipped triple — service state → pid match → snapshot — with one
// leg added: the AGE of the last status write. That leg is CONSOLE-ONLY. The
// `hx-fortress status` output strings are pinned by a regression test and stay
// exactly as they shipped; a second reader with a different notion of "running"
// is how two surfaces end up disagreeing about the same daemon.

import { stat } from "node:fs/promises";

import type { HostStatusSnapshot } from "./host/types";

/** Beyond this, a heartbeat-carrying snapshot is no longer evidence the daemon
 *  is alive. Three missed 5s heartbeats. */
export const STATUS_STALE_MS = 15_000;

export type DaemonState =
  /** The service is not loaded and no process is running. */
  | "stopped"
  /** Loaded by the service manager but not currently running. */
  | "loaded"
  /** A process exists but has not published a matching snapshot yet. */
  | "starting"
  /** Running, and its snapshot is fresh. */
  | "running"
  /** Running, but its snapshot carries no write timestamp — a binary from
   *  before the heartbeat shipped. Age is UNKNOWN, which is not the same as
   *  stale, and the copy has to say so. */
  | "pre-heartbeat"
  /** A process exists but has stopped writing its snapshot. */
  | "stale"
  /** The daemon reported a failed start. */
  | "failed";

export interface DaemonStateInput {
  /** What the supervisor says — or NULL when there is no supervisor to ask.
   *
   *  Under an orchestrator the daemon is a SIBLING PROCESS, not a unit: the
   *  container image runs `host` and `ui` under its own supervisor and carries
   *  no systemd, and an undrivable platform has no manager at all. Both answer
   *  "no pid" to a question they cannot answer, and believing it reported a
   *  healthy, heartbeating daemon as `stopped` — which is not cosmetic, because
   *  the console disables Run audit, the witness toggles, Acknowledge, checkup
   *  and rotation on exactly that value. */
  service: { loaded: boolean; pid: number | null } | null;
  snapshot: HostStatusSnapshot | null;
  now?: Date;
}

export function daemonState(input: DaemonStateInput): DaemonState {
  const { service, snapshot } = input;
  const now = input.now ?? new Date();
  if (service === null) {
    // The daemon's own heartbeat is the only evidence here, and it is enough:
    // a daemon that died stops writing and falls to `stale` below, which is the
    // same conclusion by a different route.
    if (!snapshot) return "starting";
  } else {
    if (service.pid === null) return service.loaded ? "loaded" : "stopped";
    if (!snapshot || snapshot.host.pid !== service.pid) return "starting";
  }
  // A daemon that shut down cleanly says so in its own last write; reporting
  // that as "stale" would send an operator hunting a crash that never happened.
  if (snapshot.host.state === "stopped") return "stopped";
  if (snapshot.host.state === "failed") return "failed";
  const writtenAt = snapshot.host.writtenAt;
  if (!writtenAt) return "pre-heartbeat";
  const ms = Date.parse(writtenAt);
  if (!Number.isFinite(ms)) return "pre-heartbeat";
  return now.getTime() - ms > STATUS_STALE_MS ? "stale" : "running";
}

/** Console copy for each state. `pre-heartbeat` deliberately reads as an
 *  unfinished upgrade rather than a fault — the daemon is running, it is simply
 *  an older binary that cannot say when it last wrote. */
export const DAEMON_STATE_COPY: Record<DaemonState, string> = {
  stopped: "stopped",
  loaded: "loaded, not running",
  starting: "starting",
  running: "running",
  "pre-heartbeat": "pre-heartbeat daemon — restart to finish the upgrade",
  stale: "not responding",
  failed: "failed to start",
};

export type RootMatch = "same" | "different" | "unknown";

/**
 * Compare two fortress roots by FILE IDENTITY (device + inode), never by
 * string: a symlinked, bind-mounted or `~`-expanded root is the same directory
 * under two spellings, and a string comparison would report a mismatch for an
 * install that is working perfectly.
 *
 * A mismatch is a BANNER, never a refusal to start — the console is still
 * useful against the daemon it found, and refusing would make a cosmetic path
 * difference an outage.
 */
export async function compareRoots(a: string | undefined, b: string | undefined): Promise<RootMatch> {
  if (!a || !b) return "unknown";
  try {
    const [left, right] = await Promise.all([stat(a), stat(b)]);
    return left.dev === right.dev && left.ino === right.ino ? "same" : "different";
  } catch {
    return "unknown";
  }
}
