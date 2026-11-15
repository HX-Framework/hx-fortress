// The console's way to the daemon for a person's act.
//
// One function builds it, and the console uses no other. The daemon's door is
// used for nobody but the daemon that is running NOW: the door's file must
// name the process that the daemon's own status file names with a fresh
// heartbeat. The file outlives a daemon that was killed, its port is then
// free for any program on this machine to take, and a process id alone is
// given out again in time (see local-door-client.ts).

import { sendAct, type DoorCallOptions } from "../host/local-door-client";
import { liveDaemonPid } from "../host/modules-api";
import type { fortressPaths } from "../host/paths";
import type { ActDoor } from "./act-routes";

type FortressPaths = ReturnType<typeof fortressPaths>;

export function consoleActDoor(paths: FortressPaths, options: Pick<DoorCallOptions, "timeoutMs"> = {}): ActDoor {
  return (request) => sendAct(paths.localDoor, request, { ...options, daemonPid: () => liveDaemonPid(paths) });
}
