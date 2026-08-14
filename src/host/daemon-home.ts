// Where the daemon's HOME is, decided ONCE, at boot, by name.
//
// credentials.json lives under `$HOME/.let/session-vault/`, resolved on every
// call — deliberately, so a re-homed process writes where it was re-homed to.
// That is right for a service and wrong for exactly one situation: a container
// whose HOME moved between image versions. The file is on the volume; $HOME
// names a directory that is not.
//
// This is the only place that is allowed to answer it, and it answers by
// SETTING HOME once, before anything reads or writes a credential.
//
// WHY NOT INSIDE readVaultCredentials. Two reasons, either sufficient:
//
//   • that function is a pure read reachable from a read-class console handler,
//     and the route classes are enforced by a test that forbids a read route
//     from having an effect. Re-homing the process IS an effect;
//   • it would race applyHeadlessBootstrap. The bootstrap REBUILDS
//     credentials.json from the environment, so a walk that ran lazily — on
//     whichever read happened first — could adopt a home after the file had
//     already been written to a different one, and the boot would end with two
//     credential files and the wrong one live.
//
// So: one call, at the top of the daemon's boot, before the bootstrap runs.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The homes a container may have kept its state under, in the order they are
 * tried.
 *
 * `/data` is where the image puts it today and where the volume is mounted.
 * `/root` is what Docker hands a container that never set HOME. `/` is the one
 * that looks odd: it names `/.let`, which an image whose HOME was empty would
 * have written to.
 *
 * That last candidate RECOVERS NOTHING on a plain image upgrade. The Dockerfile's
 * VOLUME is `["/data"]`, so `/.let` lives in the container's writable layer and
 * the layer is discarded when the image is replaced. It is here for the case
 * where it is not discarded — a volume mounted at `/` or at `/.let` — and it is
 * harmless where it is: an absent file is simply not a candidate.
 */
export const CONTAINER_HOME_CANDIDATES: readonly string[] = ["/data", "/root", "/"];

/** The file whose presence makes a directory THE home. Not the directory: an
 *  empty `/data/.let` is what a volume looks like before the first enrollment,
 *  and adopting it would beat a real home later in the list. */
export function credentialsUnder(home: string): string {
  return path.join(home, ".let", "session-vault", "credentials.json");
}

export interface DaemonHomeResolution {
  home: string;
  /** Null when HOME already named a usable home and nothing moved. */
  adopted: string | null;
  /** Every candidate that was looked at, for the boot log. */
  searched: readonly string[];
}

export interface ResolveDaemonHomeOptions {
  env: Record<string, string | undefined>;
  candidates?: readonly string[];
  exists?: (file: string) => boolean;
  homedir?: () => string;
}

/**
 * Decide the daemon's HOME and return what was decided.
 *
 * PURE — it reports, and the caller applies. The one-shot discipline lives at the
 * call site, which is what keeps this testable without a process to re-home.
 *
 * An already-usable HOME wins outright: an operator who set it meant it, and a
 * fortress with credentials under the home it was given has nothing to recover.
 */
export function resolveDaemonHome(options: ResolveDaemonHomeOptions): DaemonHomeResolution {
  const exists = options.exists ?? existsSync;
  const homedir = options.homedir ?? os.homedir;
  const current = options.env.HOME?.trim() || homedir();
  const searched: string[] = [current];
  if (exists(credentialsUnder(current))) {
    return { home: current, adopted: null, searched };
  }
  // The passwd home FIRST, ahead of the container paths. Credentials live at
  // ~/.let/session-vault on every deployment (D11), and $HOME is only the first
  // guess at what ~ means: a unit or supervisor that starts the daemon with a
  // different HOME than the shell the operator enrolled from leaves the file
  // exactly here, under a directory a container-only candidate list never looks
  // at. Adopting it is what that install's own `~` already resolved to.
  for (const candidate of [homedir(), ...(options.candidates ?? CONTAINER_HOME_CANDIDATES)]) {
    if (candidate === current) continue;
    searched.push(candidate);
    if (!exists(credentialsUnder(candidate))) continue;
    return { home: candidate, adopted: candidate, searched };
  }
  // Nothing to adopt: a fresh volume has no credentials anywhere, and the
  // bootstrap is about to write the first ones under the home it was given.
  return { home: current, adopted: null, searched };
}

export interface DaemonHomeLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Resolve and APPLY, once.
 *
 * Called at the top of the daemon's boot and nowhere else. Returns the home in
 * force, so the caller can say so in a log line an operator can compare against
 * the volume they think they mounted.
 */
export function adoptDaemonHome(options: {
  env?: Record<string, string | undefined>;
  candidates?: readonly string[];
  exists?: (file: string) => boolean;
  logger?: DaemonHomeLogger;
}): DaemonHomeResolution {
  const env = options.env ?? process.env;
  const resolution = resolveDaemonHome({
    env,
    ...(options.candidates ? { candidates: options.candidates } : {}),
    ...(options.exists ? { exists: options.exists } : {}),
  });
  if (resolution.adopted) {
    env.HOME = resolution.adopted;
    options.logger?.info("adopted an existing fortress home", {
      home: resolution.adopted,
      searched: resolution.searched,
    });
  }
  return resolution;
}
