// The daemon's door on this machine: how a person's act crosses from the
// console to the module it is for.
//
// The console and the daemon are two processes. A module lives in the daemon.
// Until this file the console reached the daemon by a row in a table, by a
// file and by a signal, and an answer came back the same way. An act's reply
// must not rest in a row or a file. So the daemon listens here, and both the
// request and the reply stay in memory.
//
// WHAT IT IS. One listener on `127.0.0.1`, on a port the system picks at each
// start, and on no other address. It is open only while a module that is
// switched on lists acts: an HX Fortress with no such module has no listener
// and no file (the module host decides, in module-host.ts).
//
// WHO MAY CALL. Whoever holds the secret of this run: 32 random bytes, made
// when the door opens and written with the port to `runtime/local-door.json`,
// which only this HX Fortress's own user can read. The console reads that
// file. The secret is never logged, and it is gone when the door closes.
//
// WHAT THE DOOR CHECKS, in this order, before anything is handed on:
//
//    1. the call comes from this machine
//    2. its `Host` header is this door's own address
//    3. it is not from a browser: it carries no `Origin` and no `Sec-Fetch-*`
//    4. it carries this run's secret
//    5. it is a POST to a path this door has
//    6. its body is JSON
//
// A call that fails 1, 2, 3 or 5 is answered 404, one that fails 4 is answered
// 401, one that fails 6 is answered 400, each with no detail, and each is
// counted in one audit record.
//
// WHAT IT DOES NOT DO. Another program on this machine can connect to the
// port. Without the secret it gets nothing. A program that runs as this
// HX Fortress's own user can read the secret, as it can read every other file
// of this HX Fortress.
//
// The door decides nothing about the act itself. Who the person is comes from
// the console, and every other check is the act gate's (act-gate.ts).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";

import type { ActAnswer } from "./module-contract";
import { writePrivateJson } from "./private-json";
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

/** What `runtime/local-door.json` holds while the door is open. */
export interface LocalDoorFile {
  v: 1;
  port: number;
  /** 32 random bytes, base64url. New at each open. */
  secret: string;
  /** The daemon that opened the door. A caller checks that it is alive. */
  pid: number;
  openedAt: string;
}

/** Why the door turned a call away. A fixed vocabulary. */
export type DoorRule = "door_peer" | "door_host" | "door_browser" | "door_secret" | "door_route" | "door_body";

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

function digestOf(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function plain(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

const LOOPBACK_PEERS: ReadonlySet<string> = new Set(["127.0.0.1", "::ffff:127.0.0.1", "::1"]);

/**
 * Stop a listener now: close it to new calls, and cut every call it holds.
 *
 * THE PROMISE OF THE STOP IS NOT WAITED FOR. Both things above are done by the
 * time `stop(true)` returns: a call made in the same turn is refused, and a
 * held call is cut (measured on Bun 1.3.14). Its promise is another matter.
 * While a call is still held in a handler, as an act that is running is, the
 * promise settles only when something else wakes the event loop, and with
 * nothing to wake it, never. A door that waited for it could not be closed
 * while an act runs: the daemon's stop, and a module being switched off, would
 * wait with it.
 */
function stopNow(server: ReturnType<typeof Bun.serve>): void {
  try {
    // Both outcomes are observed, so a late one is never an unhandled rejection.
    void Promise.resolve(server.stop(true)).then(
      () => {},
      () => {},
    );
  } catch {
    // A listener that is already stopped.
  }
}

export class LocalDoor {
  private readonly deps: LocalDoorDeps;
  private server: ReturnType<typeof Bun.serve> | null = null;
  /** The sha256 of this run's secret. The secret itself is kept nowhere but in
   *  the file. */
  private secretDigest: Buffer | null = null;
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

  /** Open the door, and write where it is and its secret. Does nothing when
   *  it is open. Rejects when the listener or the file cannot be made, and
   *  then nothing is left listening. */
  open(): Promise<void> {
    return this.next(async () => {
      if (this.server) return;
      const secret = randomBytes(32).toString("base64url");
      const server = Bun.serve({
        hostname: LOCAL_DOOR_HOST,
        port: 0,
        maxRequestBodySize: DOOR_REQUEST_MAX_BYTES,
        idleTimeout: DOOR_IDLE_TIMEOUT_S,
        // Stated, not inherited: the default error page of a development
        // server holds the message and the source of whatever was thrown.
        development: false,
        fetch: (req, srv) =>
          this.answer(req, srv.requestIP(req)?.address).catch(() => plain(500)),
        error: () => plain(500),
      });
      try {
        const file: LocalDoorFile = {
          v: 1,
          port: server.port as number,
          secret,
          pid: process.pid,
          openedAt: (this.deps.clock ?? ((): Date => new Date()))().toISOString(),
        };
        await writePrivateJson(this.deps.file, file);
      } catch (error) {
        stopNow(server);
        throw error;
      }
      this.secretDigest = digestOf(secret);
      this.server = server;
      this.deps.logger.info("the door on this machine is open: a person's act can reach a module", {
        port: server.port,
      });
    });
  }

  /** Close the door and remove its file. Does nothing when it is closed.
   *  Never rejects: it runs in the daemon's stop. */
  close(): Promise<void> {
    return this.next(async () => {
      const server = this.server;
      this.server = null;
      this.secretDigest = null;
      if (server) {
        stopNow(server);
        this.deps.logger.info("the door on this machine is closed");
      }
      // Also when it was not open: a run that did not stop cleanly leaves its
      // file, and the secret in it opens nothing now.
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
    const secretDigest = this.secretDigest;
    // A call that arrives while the door is closing finds it closed.
    if (!server || !secretDigest) return plain(404);
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
    // ── 4. This run's secret, compared in time that does not depend on it. ──
    const authorization = req.headers.get("authorization") ?? "";
    const presented = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    if (presented === "" || !timingSafeEqual(digestOf(presented), secretDigest)) {
      return this.refuse("door_secret", 401);
    }
    // ── 5. A path this door has. ─────────────────────────────────────────────
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== DOOR_ACT_PATH || url.search !== "") {
      return this.refuse("door_route", 404);
    }
    // ── 6. A JSON body. ──────────────────────────────────────────────────────
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return this.refuse("door_body", 400);
    }
    const answer = await this.deps.act(body);
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}
