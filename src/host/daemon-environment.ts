// What the running daemon's environment names, for a terminal and the console.
//
// Three processes read the settings of one HX Fortress, and they may not share
// an environment: the daemon, a terminal where a person types a command, and
// the console. Four settings are read from the environment and decide where
// the program's files come from and which key it trusts:
//
//   FORTRESS_UPDATE_URL          where a new version comes from
//   FORTRESS_CONTROL_PLANE_KEY   the key of the control plane
//   FORTRESS_PGVECTOR_URL        an address for the pgvector files alone
//   FORTRESS_PG_BINARIES_URL     where the Postgres program comes from
//
// An organization that sets one of them on the daemon's service has made a
// choice for this host. A terminal that does not have the variable must not
// act as if nobody made it. So the daemon writes down what its own environment
// names for each, in `runtime/daemon-environment.json`.
//
// THE FILE COUNTS ONLY WHILE THE DAEMON THAT WROTE IT RUNS. It holds that
// daemon's process id, and a reader is told whether that process is the
// running daemon. A file outlives its writer: after the variable was taken out
// of the service and the daemon was stopped, the file still names the old
// value. What a reader does with a file whose writer is gone is its own rule,
// and it is never "follow it".
//
// THE FILE FOLLOWS THE STATUS FILE. Which daemon runs is read from
// `runtime/status.json`, so the two files have to speak of the same process.
// The daemon therefore writes this file in two places:
//
//   - First thing when it starts, before any check that can end the start, so
//     that a start that ends early still leaves what its environment names.
//     It leaves the file alone when another daemon runs on this folder: a
//     second `hx-fortress host` typed in a terminal would otherwise replace
//     the record of the daemon that is still running with its own. With no
//     daemon running, the file is that of the LAST START on the folder,
//     whoever made it: a daemon started by hand, with a terminal's
//     environment, is from then on what the file speaks of, until the service
//     starts again.
//   - With every write of the status file, when the file is not its own. The
//     daemon that says "I run" in the status file is then the one whose
//     environment this file holds, and whatever replaced the file in between
//     is put right at the next write, a few seconds later.
//
// The file holds no secret: addresses, and public keys. Each reader checks a
// value again as it would check the variable itself, because the file is a
// file, and whoever can write this folder can write it.

import { readFile, rm } from "node:fs/promises";

import { writePrivateJson } from "./private-json";

/** What an environment says for one setting: nothing, a value, or a value
 *  that could not be understood, with the reason. */
export type Named<T> = null | { value: T } | { invalid: string };

export interface DaemonEnvironment {
  /** FORTRESS_UPDATE_URL: the base address, as the daemon checked it. */
  updateUrl: Named<unknown>;
  /** FORTRESS_CONTROL_PLANE_KEY: the keys, each `{ id, publicKey }`. */
  controlPlaneKey: Named<unknown>;
  /** FORTRESS_PGVECTOR_URL: the address, as text. Left out, it is null. */
  pgvectorUrl?: Named<unknown>;
  /** FORTRESS_PG_BINARIES_URL: the address, as text. Left out, it is null. */
  pgBinariesUrl?: Named<unknown>;
}

export interface PublishedDaemonEnvironment extends Required<DaemonEnvironment> {
  /** True when the daemon that wrote the file is the one running now. */
  running: boolean;
}

export interface DaemonEnvironmentPaths {
  daemonEnvironment: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function named(value: unknown): Named<unknown> | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (typeof value.invalid === "string") return { invalid: value.invalid };
  if (Object.hasOwn(value, "value")) return { value: value.value };
  return undefined;
}

/** The four settings as the file holds them: a setting left out is null. */
function whole(environment: DaemonEnvironment): Required<DaemonEnvironment> {
  return {
    updateUrl: environment.updateUrl,
    controlPlaneKey: environment.controlPlaneKey,
    pgvectorUrl: environment.pgvectorUrl ?? null,
    pgBinariesUrl: environment.pgBinariesUrl ?? null,
  };
}

/**
 * Write the file. False when it could not be written: the caller says so in
 * the daemon's log, because a terminal then cannot follow what this daemon
 * runs with.
 *
 * A file that could not be replaced is removed, as far as that works. A
 * process id is used again, in a container at every start, and an earlier
 * daemon's file with this daemon's id would read as this daemon's.
 */
export async function publishDaemonEnvironment(
  paths: DaemonEnvironmentPaths,
  environment: DaemonEnvironment,
  options: { pid?: number; now?: Date } = {},
): Promise<boolean> {
  return writePrivateJson(paths.daemonEnvironment, {
    schemaVersion: 1,
    pid: options.pid ?? process.pid,
    writtenAt: (options.now ?? new Date()).toISOString(),
    ...whole(environment),
  }).then(
    () => true,
    async () => {
      // The file of this same folder's daemon.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await rm(paths.daemonEnvironment, { force: true }).catch(() => {});
      return false;
    },
  );
}

/** The file as it is: its writer's process id and what it holds. Null: there
 *  is no file, or it is not one this build wrote. */
async function readRecord(
  paths: DaemonEnvironmentPaths,
): Promise<{ pid: number; environment: Required<DaemonEnvironment> } | null> {
  let raw: unknown;
  try {
    // The file the daemon of this same folder wrote.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    raw = JSON.parse(await readFile(paths.daemonEnvironment, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.pid !== "number") return null;
  const updateUrl = named(raw.updateUrl);
  const controlPlaneKey = named(raw.controlPlaneKey);
  // A setting the file does not hold was not named.
  const pgvectorUrl = named(raw.pgvectorUrl ?? null);
  const pgBinariesUrl = named(raw.pgBinariesUrl ?? null);
  if (
    updateUrl === undefined ||
    controlPlaneKey === undefined ||
    pgvectorUrl === undefined ||
    pgBinariesUrl === undefined
  ) {
    return null;
  }
  return { pid: raw.pid, environment: { updateUrl, controlPlaneKey, pgvectorUrl, pgBinariesUrl } };
}

/**
 * What a daemon wrote, and whether that daemon is the one running now.
 * `daemonPid` is the process id of the daemon that runs now, or null when none
 * does. Null: there is no file, or it is not one this build wrote.
 */
export async function readDaemonEnvironment(
  paths: DaemonEnvironmentPaths,
  daemonPid: number | null,
): Promise<PublishedDaemonEnvironment | null> {
  const record = await readRecord(paths);
  if (!record) return null;
  return { running: daemonPid !== null && daemonPid === record.pid, ...record.environment };
}

/**
 * A daemon's first step when it starts.
 *
 * `anotherDaemon` is the process id of another daemon that runs on this folder
 * now, or null. With one running, the file is left as it is: it is that
 * daemon's, and this start either ends at a later check or takes the folder
 * over, and then its first write of the status file writes this file too
 * (`keepDaemonEnvironment`).
 */
export async function recordDaemonEnvironmentAtStart(
  paths: DaemonEnvironmentPaths,
  environment: DaemonEnvironment,
  options: { anotherDaemon: number | null; pid?: number; now?: Date },
): Promise<"written" | "left" | "failed"> {
  const pid = options.pid ?? process.pid;
  if (options.anotherDaemon !== null && options.anotherDaemon !== pid) return "left";
  const written = await publishDaemonEnvironment(paths, environment, {
    pid,
    ...(options.now ? { now: options.now } : {}),
  });
  return written ? "written" : "failed";
}

/**
 * Make sure that the file is this daemon's. The daemon calls it with every
 * write of the status file, so the process that the status file names is the
 * one whose environment this file holds. It writes only when the file is not
 * there, is another process's, or holds other values. True when the file is
 * this daemon's afterwards. It never throws.
 */
export async function keepDaemonEnvironment(
  paths: DaemonEnvironmentPaths,
  environment: DaemonEnvironment,
  options: { pid?: number; now?: Date } = {},
): Promise<boolean> {
  const pid = options.pid ?? process.pid;
  const record = await readRecord(paths);
  if (record && record.pid === pid && JSON.stringify(record.environment) === JSON.stringify(whole(environment))) {
    return true;
  }
  return publishDaemonEnvironment(paths, environment, { pid, ...(options.now ? { now: options.now } : {}) });
}
