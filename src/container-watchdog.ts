// The daemon's liveness, judged from outside the daemon.
//
// WHY A SECOND PROCESS HAS TO DO THIS. The daemon already exits when it proves
// itself stuck (FORTRESS_STORE_EXIT_ON_WEDGE), but that detector runs on timers
// inside the daemon's own event loop. On 2026-09-19 that event loop stopped: the
// process held 9.2 GB, kept about two cores busy, wrote no log line and sent no
// network traffic for more than three weeks, and the timers that would have made
// it exit stopped with everything else. Railway restarts a service only when its
// process exits, so it reported the fortress as running the whole time. Only a
// process with its own event loop can see a frozen one, and container-run is
// already that process.
//
// THE HEARTBEAT IS metrics.json. The daemon rewrites it every 10 s from a timer
// on its event loop (startMetricsPublisher), from early in its boot until it
// stops. The boot steps after the first write — starting Postgres, migrations,
// the tunnel dial — all wait on I/O without holding the event loop, so the file
// keeps changing through a slow boot. A frozen event loop stops it. Only the
// file's modification time is read; its contents belong to the console.
//
// A HEARTBEAT IS A CHANGE TO THE FILE, timed on this process's clock. The file is
// on the volume and survives restarts, so the copy found at boot was written by
// the previous container. That copy is the baseline, and only a rewrite after it
// counts. Comparing the file's modification time with this clock instead would
// read a wall-clock step as a stopped daemon.
//
// ONLY SILENCE THIS PROCESS WATCHED COUNTS. A gap between two reads far longer
// than the read interval means this process did not run either — a paused or
// suspended container, a host that slept — or that the clock stepped. The daemon
// could not have written during that time, so the time is not held against it.
//
// THE GRACE STARTS AT THE FIRST HEARTBEAT, never at spawn. Nothing fires before
// the daemon has written once, however long that takes, and nothing fires for the
// grace period after it, so start-up work that does hold the event loop is not
// taken for a freeze.

import { stat } from "node:fs/promises";

import { METRICS_INTERVAL_MS } from "./console/metrics";
import { parseBooleanEnv } from "./env";

/** How long the heartbeat may go unchanged before the daemon is stopped: twelve
 *  missed rewrites. */
export const DEFAULT_STALE_MS = 120_000;

/** The lowest limit accepted. Below three rewrite intervals, a healthy daemon
 *  between two rewrites would be read as frozen — and a value typed in seconds
 *  instead of milliseconds would kill the daemon every few seconds. */
export const MIN_STALE_MS = 3 * METRICS_INTERVAL_MS;

/** How long after the daemon's first heartbeat the watchdog stays disarmed. */
export const DEFAULT_GRACE_MS = 300_000;

/** How often the heartbeat file is read. */
export const HEARTBEAT_CHECK_MS = 5_000;

/** A gap between two reads longer than this is time this process did not run, or
 *  a clock step, and it is not counted as silence. Six missed reads. */
export const UNWATCHED_GAP_MS = 6 * HEARTBEAT_CHECK_MS;

/** How long a daemon asked to stop with SIGTERM has before it gets SIGKILL. A
 *  frozen event loop never runs the daemon's SIGTERM handler, so this is usually
 *  spent in full. */
export const KILL_GRACE_MS = 10_000;

/** The container's exit code after the watchdog stopped the daemon. Fixed and
 *  non-zero, whatever the daemon's own exit code was: a daemon that still managed
 *  a clean exit 0 on SIGTERM must not make the container look like it stopped on
 *  purpose, because an on-failure restart policy would then leave it stopped. */
export const HEARTBEAT_STALE_EXIT_CODE = 70;

export interface WatchdogSettings {
  /** Silence longer than this, once armed, stops the daemon. */
  staleMs: number;
  /** How long after the first heartbeat the watchdog stays disarmed. */
  graceMs: number;
}

export interface WatchdogConfig {
  /** Null when the operator turned the watchdog off. */
  settings: WatchdogSettings | null;
  /** One line for each value that was replaced, for the container log. */
  notes: string[];
}

/** Read the watchdog's settings from the environment. */
export function watchdogConfig(env: Record<string, string | undefined>): WatchdogConfig {
  if (parseBooleanEnv(env.FORTRESS_WATCHDOG_DISABLED)) return { settings: null, notes: [] };
  const notes: string[] = [];

  // `0` and blank mean the default, as on the other deadline knobs. The watchdog
  // has its own off switch, so a limit can never be the thing that disables it.
  let staleMs = DEFAULT_STALE_MS;
  const stale = readMilliseconds(env.FORTRESS_WATCHDOG_STALE_MS);
  if (stale === "invalid") {
    notes.push(
      `FORTRESS_WATCHDOG_STALE_MS=${env.FORTRESS_WATCHDOG_STALE_MS} is not a number of milliseconds; using ${DEFAULT_STALE_MS}`,
    );
  } else if (stale !== null && stale > 0) {
    if (stale < MIN_STALE_MS) {
      notes.push(`FORTRESS_WATCHDOG_STALE_MS=${stale} is below the ${MIN_STALE_MS} ms floor; using ${MIN_STALE_MS}`);
    }
    staleMs = Math.max(stale, MIN_STALE_MS);
  }

  // `0` is a real value here: arm at the first heartbeat.
  let graceMs = DEFAULT_GRACE_MS;
  const grace = readMilliseconds(env.FORTRESS_WATCHDOG_GRACE_MS);
  if (grace === "invalid") {
    notes.push(
      `FORTRESS_WATCHDOG_GRACE_MS=${env.FORTRESS_WATCHDOG_GRACE_MS} is not a number of milliseconds; using ${DEFAULT_GRACE_MS}`,
    );
  } else if (grace !== null) {
    graceMs = grace;
  }

  return { settings: { staleMs, graceMs }, notes };
}

/** Null when unset or blank; "invalid" for anything that is not a non-negative
 *  whole number. */
function readMilliseconds(raw: string | undefined): number | null | "invalid" {
  const text = raw?.trim() ?? "";
  if (text === "") return null;
  if (!/^\d+$/.test(text)) return "invalid";
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : "invalid";
}

/** The heartbeat file's modification time in milliseconds, or null when it is
 *  absent or cannot be read. */
export type HeartbeatMark = number | null;

export async function readHeartbeatMark(file: string): Promise<HeartbeatMark> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

export type WatchVerdict =
  /** No heartbeat from this daemon yet. Never fires, however long it lasts. */
  | { state: "waiting" }
  /** Heartbeating, inside the grace period. */
  | { state: "grace" }
  | { state: "alive" }
  /** Armed, and silent for longer than the limit. */
  | { state: "stale"; silentMs: number };

/**
 * The watchdog's decision, kept free of timers and files so it can be driven with
 * a fake clock: feed it each read of the heartbeat file and the time of the read.
 */
export class HeartbeatWatch {
  private last: HeartbeatMark;
  private firstBeatAt: number | null = null;
  private lastBeatAt = 0;
  private lastReadAt: number | null = null;

  /** `baseline` is the mark read before the daemon was started. */
  constructor(
    private readonly settings: WatchdogSettings,
    baseline: HeartbeatMark,
  ) {
    this.last = baseline;
  }

  /** True once this daemon has written a heartbeat. */
  get beating(): boolean {
    return this.firstBeatAt !== null;
  }

  /** The modification time of the last heartbeat seen, for the log line. */
  get lastMark(): HeartbeatMark {
    return this.last;
  }

  observe(now: number, mark: HeartbeatMark): WatchVerdict {
    if (this.lastReadAt !== null && this.firstBeatAt !== null) {
      const gap = now - this.lastReadAt;
      // Unwatched time, or a clock step: move the reference points by the gap, so
      // the gap counts as no time at all — neither silence nor grace.
      if (gap < 0 || gap > UNWATCHED_GAP_MS) {
        this.firstBeatAt += gap;
        this.lastBeatAt += gap;
      }
    }
    this.lastReadAt = now;

    // An absent file is no heartbeat: the daemon recreates it on every rewrite.
    if (mark !== null && mark !== this.last) {
      this.last = mark;
      this.firstBeatAt ??= now;
      this.lastBeatAt = now;
    }

    if (this.firstBeatAt === null) return { state: "waiting" };
    if (now - this.firstBeatAt < this.settings.graceMs) return { state: "grace" };
    const silentMs = now - this.lastBeatAt;
    return silentMs > this.settings.staleMs ? { state: "stale", silentMs } : { state: "alive" };
  }
}

/** The line written once this daemon's first heartbeat is seen: it says the
 *  watchdog is watching, and with which settings. */
export function watchingLine(file: string, settings: WatchdogSettings): string {
  const from = settings.graceMs > 0 ? `From ${seconds(settings.graceMs)} after it` : "From now on";
  return (
    `liveness watchdog: first daemon heartbeat seen in ${file}. ` +
    `${from}, ${seconds(settings.staleMs)} without a new one ` +
    `stops the daemon and exits the container with code ${HEARTBEAT_STALE_EXIT_CODE}`
  );
}

/**
 * The one line that says why the container is about to exit.
 *
 * "More than the limit" rather than a measured duration: the watchdog fires on
 * the first read past the limit, so a rounded duration would read as equal to
 * it. The statement is always true, because the time this process watched is
 * never longer than the real time since the write. The write's own timestamp
 * gives the rest.
 */
export function staleLine(args: {
  file: string;
  lastMark: HeartbeatMark;
  settings: WatchdogSettings;
  pid: number | null;
}): string {
  // Guarded: toISOString throws on an invalid date, and this line must not.
  const written =
    args.lastMark === null || !Number.isFinite(args.lastMark)
      ? ""
      : ` (last written ${new Date(args.lastMark).toISOString()})`;
  const target = args.pid === null ? "the daemon" : `the daemon (pid ${args.pid})`;
  return (
    `daemon heartbeat is stale: ${args.file} has not been rewritten for more than ` +
    `${seconds(args.settings.staleMs)}${written}; ` +
    `stopping ${target} and exiting with code ${HEARTBEAT_STALE_EXIT_CODE} so the container is restarted`
  );
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}
