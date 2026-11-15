// The daemon's door on this machine: how a person's act crosses from the
// console to the module it is for.
//
// The console and the daemon are two processes. A module lives in the daemon.
// Until this file the console reached the daemon by a row in a table, by a
// file and by a signal, and an answer came back the same way. The hand-over of
// an act must not rest in a row or a file. So the daemon listens here, and
// both the request and the reply cross in memory.
//
// WHAT IT IS. One listener on `127.0.0.1`, on a port the system picks at each
// start, and on no other address. It is open only while a module that is
// switched on lists acts: an HX Fortress with no such module has no listener
// and no file (the module host decides, in module-host.ts).
//
// WHO MAY CALL. Whoever holds the secret of this door: 32 random bytes, made
// when the door opens and written with the port to `runtime/local-door.json`,
// which only this HX Fortress's own user can read. The console reads that
// file. The secret is never logged, and it opens nothing once the door has
// closed.
//
// THE SECRET NEVER CROSSES THE SOCKET. A caller proves that it holds the
// secret: it sends a number it made up for this one call, and a code made
// from the secret, that number, the request's method and path, and its body
// (an HMAC). The door answers with a code made from the secret, the same
// number and the answer's body. So a program that listens on this door's
// port in the door's place learns no secret from a caller, and cannot make
// an answer that the console would show: the console shows an answer only
// when its code is right.
//
// The door does not remember the numbers. A request that was seen on its way
// could be sent a second time while the door has the same secret. Seeing it
// takes this HX Fortress's own user or the machine's administrator, who can
// read the secret itself.
//
// WHAT THE DOOR CHECKS, in this order, before anything is handed on:
//
//    1. the call comes from this machine
//    2. its `Host` header is this door's own address
//    3. it is not from a browser: it carries no `Origin` and no `Sec-Fetch-*`
//    4. it proves that it holds this door's secret
//    5. it is a POST to a path this door has
//    6. its body is JSON
//
// A call that fails 1, 2, 3 or 5 is answered 404, one that fails 4 is answered
// 401, one that fails 6 is answered 400, each with no detail, and each is
// counted in one audit record. A request that is not well-formed HTTP is
// answered by the runtime itself, before this file sees it, and is not
// counted.
//
// WHAT IT DOES NOT DO. Another program on this machine can connect to the
// port. Without the secret it gets nothing. A program that runs as this
// HX Fortress's own user can read the secret, as it can read every other file
// of this HX Fortress, and can then hand over an act under any person's
// login.
//
// The door decides nothing about the act itself. Who the person is comes from
// the caller, and every other check is the act gate's (act-gate.ts).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";

import type { ActAnswer } from "./module-contract";
import { readSmallFile, writePrivateJson } from "./private-json";
import type { ScopedLogger } from "./types";

export const LOCAL_DOOR_HOST = "127.0.0.1";
/** Where the console hands over one act of a person. */
export const DOOR_ACT_PATH = "/console/act";
/** The largest request the door reads. The console takes at most 256 KiB from
 *  a browser, and adds who the person is. */
export const DOOR_REQUEST_MAX_BYTES = 512 * 1024;
/** How long a call may stay open with no byte moving, in seconds. Above the
 *  time one act may run, so an act that is still running is not cut. */
const DOOR_IDLE_TIMEOUT_S = 45;
/** Far above what the door's file holds. A larger file is not one. */
const DOOR_FILE_MAX_BYTES = 4096;

/** The header that carries the number a caller made up for one call. */
export const DOOR_NONCE_HEADER = "x-door-nonce";
/** The header of an answer that carries the door's code for that answer. */
export const DOOR_PROOF_HEADER = "x-door-proof";
/** `Authorization: HXDoor <code>`. */
export const DOOR_AUTH_SCHEME = "HXDoor";
/** 16 random bytes, base64url. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** 32 bytes, base64url. */
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What `runtime/local-door.json` holds while the door is open. */
export interface LocalDoorFile {
  v: 1;
  port: number;
  /** 32 random bytes, base64url. New each time the file is written. */
  secret: string;
  /** The daemon that opened the door. A caller checks that it is the daemon
   *  that is running now. */
  pid: number;
  openedAt: string;
}

/** Why the door turned a call away. A fixed vocabulary. */
export type DoorRule = "door_peer" | "door_host" | "door_browser" | "door_secret" | "door_route" | "door_body";

/** How to close the door. `cut`: every call it holds is cut, for the daemon's
 *  stop. `let_end`: no new call is taken, and a call it holds gets its
 *  answer, for a module that was switched off. */
export type DoorClose = "cut" | "let_end";

export interface LocalDoorDeps {
  /** `runtime/local-door.json`. */
  file: string;
  /** The act gate. */
  act: (request: unknown) => Promise<ActAnswer>;
  /** A call was turned away. The caller counts it in the audit trail. */
  refused: (rule: DoorRule) => void;
  logger: ScopedLogger;
  clock?: () => Date;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function code(secret: string, lines: readonly string[]): string {
  return createHmac("sha256", Buffer.from(secret, "base64url")).update(lines.join("\n")).digest("base64url");
}

/**
 * The code a caller sends with a request: it proves that the caller holds the
 * secret, and gives the secret away to nobody.
 *
 * It is made for one call: this number, this method and path (`what`, as in
 * `POST /console/act`), and this body. So it opens no other path and carries
 * no other body.
 */
export function doorRequestCode(secret: string, nonce: string, what: string, body: Uint8Array): string {
  return code(secret, ["hx-fortress door v1 request", nonce, what, sha256Hex(body)]);
}

/** The code the door sends with an answer: it proves that the answer is the
 *  door's own, to the call that made up this number. */
export function doorAnswerCode(secret: string, nonce: string, body: Uint8Array): string {
  return code(secret, ["hx-fortress door v1 answer", nonce, sha256Hex(body)]);
}

/** Whether two codes are the same, in time that does not depend on them. */
export function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/** The door's file, or null when it is not there or is not one. Never waits on
 *  what is at the path, and never reads more than a door's file can hold. */
export async function readDoorFile(file: string): Promise<LocalDoorFile | null> {
  const read = await readSmallFile(file, DOOR_FILE_MAX_BYTES);
  if (read.state !== "read") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { v, port, secret, pid, openedAt } = parsed as Record<string, unknown>;
  if (v !== 1) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (typeof secret !== "string" || !CODE_PATTERN.test(secret)) return null;
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

function plain(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

const LOOPBACK_PEERS: ReadonlySet<string> = new Set(["127.0.0.1", "::ffff:127.0.0.1", "::1"]);

type Listener = ReturnType<typeof Bun.serve>;

/**
 * Stop a listener: close it to new calls, and with `cut` also cut every call
 * it holds.
 *
 * THE PROMISE OF THE STOP IS NOT WAITED FOR. The listener is closed to new
 * calls by the time `stop` returns, and with `cut` a held call is cut by then
 * too: a call made in the same turn is refused (measured on Bun 1.3.14). Its
 * promise is another matter. It may not settle while a handler still holds a
 * call, as an act that is running does. A door that waited for it could not
 * be closed while an act runs: the daemon's stop, and a module being switched
 * off, would wait with it.
 */
function stopListener(server: Listener, how: DoorClose): void {
  try {
    // Both outcomes are observed, so a late one is never an unhandled rejection.
    void Promise.resolve(server.stop(how === "cut")).then(
      () => {},
      () => {},
    );
  } catch {
    // A listener that is already stopped.
  }
}

export class LocalDoor {
  private readonly deps: LocalDoorDeps;
  private server: Listener | null = null;
  /** This door's secret, as it is in the file. Kept in memory to make and
   *  check the codes, and nowhere else. */
  private secret: string | null = null;
  /** Opening and closing take turns. */
  private turn: Promise<void> = Promise.resolve();

  constructor(deps: LocalDoorDeps) {
    this.deps = deps;
  }

  get isOpen(): boolean {
    return this.server !== null;
  }

  /** The port the door listens on, or null while it is closed. */
  get port(): number | null {
    return this.server?.port ?? null;
  }

  private next(work: () => Promise<void>): Promise<void> {
    const mine = this.turn.then(work, work);
    this.turn = mine.catch(() => {});
    return mine;
  }

  /** Write to the log, and carry on if it cannot be written: opening and
   *  closing the door do not depend on the log. */
  private say(level: "info" | "error", message: string, fields?: Record<string, unknown>): void {
    try {
      // `level` is one of two method names, both written in this file.
      // eslint-disable-next-line security/detect-object-injection
      this.deps.logger[level](message, fields);
    } catch {
      // A log that is full or gone.
    }
  }

  /** Make a new secret for a listener and write the door's file. */
  private async writeFile(server: Listener): Promise<void> {
    const secret = randomBytes(32).toString("base64url");
    const file: LocalDoorFile = {
      v: 1,
      port: server.port as number,
      secret,
      pid: process.pid,
      openedAt: (this.deps.clock ?? ((): Date => new Date()))().toISOString(),
    };
    await writePrivateJson(this.deps.file, file);
    this.secret = secret;
  }

  /**
   * Open the door, and write where it is and its secret.
   *
   * On a door that is open it looks at the file. A file that is gone, or that
   * is not this door's, is written again with a new secret: so a file that
   * something removed comes back by itself, and a caller is never left with
   * no way in while the door listens.
   *
   * Rejects when the listener or the file cannot be made. A listener whose
   * file could not be written is stopped again.
   */
  open(): Promise<void> {
    return this.next(async () => {
      if (this.server) {
        const held = await readDoorFile(this.deps.file);
        const mine =
          held !== null &&
          held.port === this.server.port &&
          held.pid === process.pid &&
          this.secret !== null &&
          sameCode(held.secret, this.secret);
        if (mine) return;
        await this.writeFile(this.server);
        this.say("info", "the file of the door on this machine was gone or was not this door's. It is written again, with a new secret");
        return;
      }
      const server = Bun.serve({
        hostname: LOCAL_DOOR_HOST,
        port: 0,
        maxRequestBodySize: DOOR_REQUEST_MAX_BYTES,
        idleTimeout: DOOR_IDLE_TIMEOUT_S,
        // Stated, not inherited: the default error page of a development
        // server holds the message and the source of whatever was thrown.
        development: false,
        fetch: (req, srv) => this.answer(req, srv.requestIP(req)?.address).catch(() => plain(500)),
        error: () => plain(500),
      });
      try {
        await this.writeFile(server);
      } catch (error) {
        this.secret = null;
        stopListener(server, "cut");
        throw error;
      }
      this.server = server;
      this.say("info", "the door on this machine is open: a person's act can reach a module", { port: server.port });
    });
  }

  /**
   * Close the door and remove its file. Does nothing when it is closed.
   * Never rejects: it runs in the daemon's stop.
   *
   * THE FILE GOES FIRST, THE LISTENER SECOND. The other order would leave,
   * for a moment, a file that names a port nothing of this HX Fortress
   * listens on, which any program on this machine could take.
   */
  close(how: DoorClose = "cut"): Promise<void> {
    return this.next(async () => {
      const server = this.server;
      if (!server) return;
      try {
        await rm(this.deps.file, { force: true });
      } catch (error) {
        // The door is closed all the same. The file is tried again the next
        // time the door is looked at, and a caller that reads it meanwhile is
        // not answered by this door: its secret opens nothing now.
        this.say("error", "the file of the door on this machine could not be removed. The door is closed", {
          error: error instanceof Error ? error.name : typeof error,
        });
      }
      this.server = null;
      this.secret = null;
      stopListener(server, how);
      this.say("info", "the door on this machine is closed");
    });
  }

  /**
   * At the daemon's start: remove a door's file that an earlier run left when
   * it did not stop cleanly. Its secret opens nothing now.
   *
   * A file that names another process that is running is left alone: it may
   * be the door of a daemon that still runs on this folder, and removing it
   * would leave that daemon with a door nobody can find. Never rejects.
   */
  clearStale(alive: (pid: number) => boolean = processAlive): Promise<void> {
    return this.next(async () => {
      if (this.server) return;
      const held = await readDoorFile(this.deps.file);
      if (held && held.pid !== process.pid && alive(held.pid)) return;
      await rm(this.deps.file, { force: true }).catch(() => {});
    });
  }

  private refuse(rule: DoorRule, status: number): Response {
    try {
      this.deps.refused(rule);
    } catch {
      // Counting a refusal must not turn it into anything else.
    }
    return plain(status);
  }

  private async answer(req: Request, peer: string | undefined): Promise<Response> {
    const server = this.server;
    const secret = this.secret;
    // A call that arrives while the door is closing finds it closed. Nothing
    // of it is read.
    if (!server || !secret) return plain(404);
    // ── 1. From this machine. The listener is bound to this machine only;
    //       this is the same rule, checked on the call. ──────────────────────
    if (peer === undefined || !LOOPBACK_PEERS.has(peer)) return this.refuse("door_peer", 404);
    // ── 2. Addressed to this door. A page that got a browser to resolve its
    //       own name to this machine sends its own name here. ────────────────
    if (req.headers.get("host") !== `${LOCAL_DOOR_HOST}:${server.port}`) return this.refuse("door_host", 404);
    // ── 3. Not from a browser. The console calls from its own process and
    //       sends none of these. ─────────────────────────────────────────────
    if (req.headers.has("origin") || req.headers.has("sec-fetch-site") || req.headers.has("sec-fetch-mode")) {
      return this.refuse("door_browser", 404);
    }
    // ── 4. The caller holds this door's secret. The code is made from the
    //       secret, the call's own number, its method and path, and the
    //       body. So the body is read first: at most the size the listener
    //       takes. ───────────────────────────────────────────────────────────
    const nonce = req.headers.get(DOOR_NONCE_HEADER) ?? "";
    const authorization = req.headers.get("authorization") ?? "";
    const scheme = `${DOOR_AUTH_SCHEME} `;
    const presented = authorization.startsWith(scheme) ? authorization.slice(scheme.length) : "";
    if (!NONCE_PATTERN.test(nonce) || !CODE_PATTERN.test(presented)) return this.refuse("door_secret", 401);
    let body: Uint8Array;
    try {
      body = new Uint8Array(await req.arrayBuffer());
    } catch {
      return this.refuse("door_body", 400);
    }
    const url = new URL(req.url);
    const what = `${req.method} ${url.pathname}${url.search}`;
    if (!sameCode(presented, doorRequestCode(secret, nonce, what, body))) return this.refuse("door_secret", 401);
    // ── 5. A path this door has. ─────────────────────────────────────────────
    if (req.method !== "POST" || url.pathname !== DOOR_ACT_PATH || url.search !== "") {
      return this.refuse("door_route", 404);
    }
    // ── 6. A JSON body. ──────────────────────────────────────────────────────
    let request: unknown;
    try {
      request = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      return this.refuse("door_body", 400);
    }
    const answer = Buffer.from(JSON.stringify(await this.deps.act(request)), "utf8");
    return new Response(answer, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        // Made with the secret this call was checked against, also when the
        // door has closed or changed its secret meanwhile.
        [DOOR_PROOF_HEADER]: doorAnswerCode(secret, nonce, answer),
      },
    });
  }
}
