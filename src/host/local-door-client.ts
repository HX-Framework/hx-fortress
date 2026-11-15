// The console's side of the daemon's door on this machine (local-door.ts).
//
// NOT `fetch`, AND NOT `node:http`. Under Bun both send a request for
// `127.0.0.1` through the proxy that `HTTP_PROXY` names, with every header of
// the request, and one call cannot opt out (measured on Bun 1.3.14). An
// organization that reaches the internet through a proxy sets that variable
// for its HX Fortress. The door's secret and a person's request would then go
// to the proxy. So this file opens the socket itself, to this machine's own
// address, and speaks the small part of HTTP/1.1 that the door answers with:
// one request, one answer with its length, and the connection is closed.

// The one path this file opens is `runtime/local-door.json` of this
// HX Fortress's own folder.
/* eslint-disable security/detect-non-literal-fs-filename */

import { readFile } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";

import { DOOR_ACT_PATH, DOOR_REQUEST_MAX_BYTES, LOCAL_DOOR_HOST, type LocalDoorFile } from "./local-door";
import type { ActAnswer } from "./module-contract";

/** How long the console waits for the daemon's answer. Above the time one act
 *  may run, so the daemon's own `failed:timeout` arrives first. */
export const DOOR_CALL_TIMEOUT_MS = 30_000;
/** The largest answer read from the door: a reply of at most 256 KiB, and the
 *  little that is around it. */
const DOOR_ANSWER_MAX_BYTES = 512 * 1024;
const DOOR_FILE_MAX_BYTES = 4096;

/** What the console is told when the act did not reach the daemon. Nothing of
 *  it was carried out. */
export const DAEMON_UNREACHABLE = "daemon_unreachable";
/** What the console is told when the daemon took the act and the answer never
 *  came whole: the daemon stopped, or its door closed. The act may have been
 *  carried out. It is not sent again. */
export const ACT_INTERRUPTED = "failed:interrupted";

export type DoorAnswer = ActAnswer | { ok: false; error: typeof DAEMON_UNREACHABLE };

const UNREACHABLE: DoorAnswer = { ok: false, error: DAEMON_UNREACHABLE };

/** One request of the console: an act of a person, and who the person is. */
export interface ActRequest {
  v: 1;
  person: { login: string; email: string | null; role: "operator" | "readonly" };
  /** The console's own id for the person's sign-in. */
  session: string | null;
  module: string;
  act: string;
  args: unknown;
}

export interface DoorCallOptions {
  timeoutMs?: number;
  /** Whether the daemon that opened the door is still there. A seam for tests. */
  alive?: (pid: number) => boolean;
  /**
   * The process that is the daemon NOW, as the daemon's own status file says
   * with a heartbeat that is still fresh. Null when no daemon is running.
   *
   * When this is given, the door's file must name that same process. The
   * door's file outlives a daemon that was killed, and its port is then free
   * for any program on this machine to take. A process id is given out again
   * in time, so "a process with that id is running" is not enough: without
   * this look, a person's request could be sent to whatever took the port.
   */
  daemonPid?: () => Promise<number | null>;
  /** `node:net`'s `connect`. A seam for tests. */
  connect?: (options: { host: string; port: number }) => Socket;
}

/** The door's file, or null when it is not there or is not one. */
export async function readDoorFile(file: string): Promise<LocalDoorFile | null> {
  let parsed: unknown;
  try {
    const bytes = await readFile(file);
    if (bytes.byteLength > DOOR_FILE_MAX_BYTES) return null;
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { v, port, secret, pid, openedAt } = parsed as Record<string, unknown>;
  if (v !== 1) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return null;
  if (typeof openedAt !== "string" || openedAt.length > 40) return null;
  return { v: 1, port, secret, pid, openedAt };
}

/** Whether a process of this user with this id is running. A process of
 *  another user is not the daemon, and reads as not running. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Exchange {
  status: number;
  body: string;
}

/**
 * What the door's answer is, from the bytes read so far. `"more"` while the
 * answer is not all there, and null for bytes that are not an answer of the
 * door: it always says how long its body is, and never answers in pieces.
 */
export function parseDoorAnswer(bytes: Buffer, ended: boolean): Exchange | "more" | null {
  const split = bytes.indexOf("\r\n\r\n");
  if (split < 0) return ended ? null : "more";
  const lines = bytes.subarray(0, split).toString("latin1").split("\r\n");
  const status = /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/.exec(lines[0] ?? "");
  if (!status) return null;
  let length: number | null = null;
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) return null;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "transfer-encoding") return null;
    if (name === "content-length") {
      if (length !== null || !/^[0-9]{1,9}$/.test(value)) return null;
      length = Number(value);
    }
  }
  if (length === null) return null;
  const rest = bytes.subarray(split + 4);
  if (rest.byteLength < length) return ended ? null : "more";
  return { status: Number(status[1]), body: rest.subarray(0, length).toString("utf8") };
}

type Exchanged = { how: "answered"; answer: Exchange } | { how: "not_connected" } | { how: "cut" } | { how: "timeout" };

/** Send one request to this machine's own address and read one answer. */
function exchange(port: number, request: Buffer, options: DoorCallOptions): Promise<Exchanged> {
  return new Promise<Exchanged>((resolve) => {
    const socket = (options.connect ?? netConnect)({ host: LOCAL_DOOR_HOST, port });
    const chunks: Buffer[] = [];
    let size = 0;
    let connected = false;
    let done = false;
    const finish = (value: Exchanged): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(
      () => finish(connected ? { how: "timeout" } : { how: "not_connected" }),
      options.timeoutMs ?? DOOR_CALL_TIMEOUT_MS,
    );
    const look = (ended: boolean): void => {
      const parsed = parseDoorAnswer(Buffer.concat(chunks), ended);
      if (parsed === "more") return;
      finish(parsed ? { how: "answered", answer: parsed } : { how: "cut" });
    };
    socket.once("connect", () => {
      connected = true;
      socket.write(request);
    });
    socket.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > DOOR_ANSWER_MAX_BYTES) return finish({ how: "cut" });
      chunks.push(chunk);
      look(false);
    });
    socket.on("error", () => finish(connected ? { how: "cut" } : { how: "not_connected" }));
    socket.on("close", () => {
      if (!connected) return finish({ how: "not_connected" });
      look(true);
      finish({ how: "cut" });
    });
  });
}

/** The daemon's answer as the door sends it, or null for anything else. */
function answerOf(text: string): ActAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const answer = parsed as { ok?: unknown; reply?: unknown; error?: unknown };
  if (answer.ok === true) return { ok: true, reply: answer.reply ?? null };
  if (answer.ok !== false || typeof answer.error !== "string") return null;
  // One word, or `failed:` and one word. Nothing else is shown to a person.
  if (!/^(?:[a-z][a-z0-9_]{0,47}|failed:[a-z][a-z0-9_]{0,47})$/.test(answer.error)) return null;
  return { ok: false, error: answer.error as Extract<ActAnswer, { ok: false }>["error"] };
}

/**
 * Hand one act of a person to the daemon, and wait for its answer.
 *
 * `daemon_unreachable` when the door is not open: the daemon is not running,
 * it is starting, or no module that is switched on takes acts. Nothing of the
 * act was carried out then: either nothing was sent, or the door answered that
 * the secret is not this run's, and the door looks at the secret before it
 * hands anything on.
 *
 * AN ACT IS SENT AGAIN ONLY WHEN IT CANNOT HAVE BEEN CARRIED OUT. Once the
 * door has the request and the answer does not come whole, the act may have
 * run. It is then not sent a second time, to this door or to the next one:
 * the person is told `failed:interrupted` and looks.
 */
export async function sendAct(doorFile: string, request: ActRequest, options: DoorCallOptions = {}): Promise<DoorAnswer> {
  const body = Buffer.from(JSON.stringify(request), "utf8");
  if (body.byteLength > DOOR_REQUEST_MAX_BYTES) return { ok: false, error: "args_invalid" };
  let last: LocalDoorFile | null = null;
  // Twice at most. The second time only when nothing was carried out the first
  // time and the file changed meanwhile: the daemon started again between the
  // read and the call, and has a new door.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const door = await readDoorFile(doorFile);
    if (!door || !(options.alive ?? processAlive)(door.pid)) return UNREACHABLE;
    // The file is sent to nobody but the daemon that is running now.
    if (options.daemonPid && (await options.daemonPid().catch(() => null)) !== door.pid) return UNREACHABLE;
    if (last && last.secret === door.secret && last.port === door.port) return UNREACHABLE;
    last = door;
    const head =
      `POST ${DOOR_ACT_PATH} HTTP/1.1\r\n` +
      `Host: ${LOCAL_DOOR_HOST}:${door.port}\r\n` +
      `Authorization: Bearer ${door.secret}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${body.byteLength}\r\n` +
      "Connection: close\r\n\r\n";
    const got = await exchange(door.port, Buffer.concat([Buffer.from(head, "latin1"), body]), options);
    // The daemon has the act and did not answer in time. It may still finish.
    if (got.how === "timeout") return { ok: false, error: "failed:timeout" };
    // Nothing listens there: nothing was sent. Look at the file again.
    if (got.how === "not_connected") continue;
    // The request went out and the answer did not come whole. Whether the act
    // ran is not known, so it is not sent again.
    if (got.how === "cut") return { ok: false, error: ACT_INTERRUPTED };
    const { status } = got.answer;
    if (status === 200) return answerOf(got.answer.body) ?? { ok: false, error: "failed:internal" };
    // 401: not this run's secret, so the door is another run's. 404: a door
    // that is closing. Either way it handed nothing on. Look at the file again.
    if (status === 401 || status === 404) continue;
    // The door failed while it had the request. Whether the act ran is not
    // known, so it is not sent again.
    if (status >= 500) return { ok: false, error: ACT_INTERRUPTED };
    // The door refused what this side wrote, before it handed anything on.
    return { ok: false, error: "failed:internal" };
  }
  return UNREACHABLE;
}
