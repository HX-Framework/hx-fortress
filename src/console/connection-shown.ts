// How the connection to the control plane stands, as a page shows it.
//
// The daemon writes its own status file, and this reads the part of it about
// the connection. How the connection stands (`state`) is read only while the
// file says the daemon is running and was written in the last few heartbeats.
// Otherwise it is `unknown`: a file that a daemon left behind is not how the
// connection stands now, and one that says "connected" must not be believed.
//
// A REFUSAL IS READ WHATEVER THE FILE'S AGE. When the control plane refuses
// the first connection of a start, the start fails, and the daemon's last
// write says `failed` (or the next start never gets past `starting`) with the
// refusal in its connection part. That refusal is the last thing a daemon
// knew about the connection, and it is what a new install id is asked for. A
// later start rewrites the file, so a refusal that no longer holds does not
// stay in it.
//
// Nothing here decides anything: it reports the daemon's words. The daemon
// gives a reason in three cases only: when it names no control plane
// (`NO_CONTROL_PLANE`), when the control plane refused the connection (its
// `fatal` frame, in src/cloud/connection.ts), and when the control plane
// enrolled it for another organization (`ORGANIZATION_CHANGED`, in the same
// file). So a daemon that is offline with any word but the first was refused.
//
// Beside it: whether a new one-time install id waits for the next start, for
// the control plane this HX Fortress names. That is the pending enrollment's
// file, read as the daemon reads it at a start.

import { FilePendingEnrollmentStore } from "../cloud/credentials";
import { refusalReason } from "../cloud/refusal-reason";
import { readStatusObject, statusIsLive } from "../daemon-state";
import { NO_CONTROL_PLANE } from "../host/runtime";
import type { fortressPaths } from "../host/paths";
import { sameControlPlane } from "../setup/control-plane";
import type { ConnectionShown } from "../ui/settings-wire";

export type { ConnectionShown };

type FortressPaths = ReturnType<typeof fortressPaths>;

export const ConsoleStatusUnavailable: ConnectionShown = {
  state: "unknown",
  reason: null,
  refused: false,
  idWaiting: false,
};

/** A state a page may show: letters, digits and "_", at most 64 of them. */
function stateWord(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : null;
}

/** A reason as the daemon writes one: a word by its own rule, or nothing. */
function reasonWord(value: unknown): string | null {
  return typeof value === "string" && refusalReason(value) === value ? value : null;
}

/**
 * The connection's part of the daemon's status file, or nothing known.
 *
 * Its state counts only from the file of a daemon that runs now
 * (`statusIsLive`): one that a daemon left when it stopped or died would say
 * "connected" for a connection that is not there. A refusal, and the reason it
 * gives, count from any file: see the top of this file.
 */
async function statusPart(paths: FortressPaths, now: Date): Promise<Omit<ConnectionShown, "idWaiting">> {
  const raw = await readStatusObject(paths.status);
  const connection = raw?.connection as Record<string, unknown> | undefined;
  if (!raw || !connection || typeof connection !== "object") return ConsoleStatusUnavailable;
  const written = stateWord(connection.state);
  const said = reasonWord(connection.reason);
  const refused = written === "offline" && said !== null && said !== NO_CONTROL_PLANE;
  const live = statusIsLive(raw, now);
  return {
    state: live ? (written ?? "unknown") : "unknown",
    reason: live || refused ? said : null,
    refused,
  };
}

/** True when a one-time install id waits in the pending enrollment's file for
 *  this control plane. A file that cannot be read holds none. */
async function idWaitingFor(paths: FortressPaths, controlPlane: string | null): Promise<boolean> {
  if (!controlPlane) return false;
  const pending = await new FilePendingEnrollmentStore(paths.pendingEnrollment).load().catch(() => null);
  return pending !== null && sameControlPlane(pending.cloudUrl, controlPlane);
}

/**
 * How the connection stands, and whether an install id waits.
 *
 * `controlPlane` is the connection address of the control plane this
 * HX Fortress names, or null when it names none: an id that waits for another
 * control plane is not this one's. An id waits for a start, so it is said
 * whether the daemon runs or not.
 */
export async function readConsoleStatus(
  paths: FortressPaths,
  options: { controlPlane?: string | null; now?: Date } = {},
): Promise<ConnectionShown> {
  const [part, idWaiting] = await Promise.all([
    statusPart(paths, options.now ?? new Date()),
    idWaitingFor(paths, options.controlPlane ?? null),
  ]);
  return { state: part.state, reason: part.reason, refused: part.refused, idWaiting };
}
