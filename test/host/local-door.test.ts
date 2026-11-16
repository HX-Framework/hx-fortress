// The daemon's door on this machine: who may call it, what it turns away, when
// it is open at all, and how the console calls it.

import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

import { AUDIT_ACTIONS } from "../../src/console/audit-actions";
import {
  DOOR_ACT_PATH,
  DOOR_AUTH_SCHEME,
  DOOR_BODY_HASH_HEADER,
  DOOR_CALL_WINDOW_MS,
  DOOR_NONCE_HEADER,
  DOOR_PROOF_HEADER,
  DOOR_REQUEST_MAX_BYTES,
  DOOR_TIME_HEADER,
  doorAnswerCode,
  doorBodyHash,
  doorRequestCode,
  LocalDoor,
  type DoorRule,
  type LocalDoorDeps,
  type LocalDoorFile,
} from "../../src/host/local-door";
import {
  ACT_INTERRUPTED,
  DAEMON_UNREACHABLE,
  parseDoorAnswer,
  processAlive,
  readDoorFile,
  sendAct,
  type ActRequest,
  type DoorExchange,
} from "../../src/host/local-door-client";
import type { ActAnswer } from "../../src/host/module-contract";
import { act, makeActsRig, OPERATOR, recordsOf, SESSION, type ActsRig } from "./_acts-rig";
import { makeRig, spoolText, tempRoot, writeConfig, type Paths, type Rig } from "./_module-rig";

const REQUEST: ActRequest = {
  v: 1,
  person: OPERATOR,
  session: SESSION,
  module: "probe",
  act: "things.read",
  args: {},
};
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };
const UNREACHABLE = { ok: false, error: DAEMON_UNREACHABLE } as const;

interface Opened {
  door: LocalDoor;
  paths: Paths;
  file: LocalDoorFile;
  /** What the act handler was given. */
  handed: unknown[];
  refused: DoorRule[];
  /** What the handler answers next. */
  answer: { value: ActAnswer };
  cleanup: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function openDoor(more: Partial<LocalDoorDeps> = {}): Promise<Opened> {
  const { paths, cleanup } = await tempRoot();
  const handed: unknown[] = [];
  const refused: DoorRule[] = [];
  const answer = { value: { ok: true, reply: { reaches: [], names: [] } } as ActAnswer };
  const door = new LocalDoor({
    file: paths.localDoor,
    act: async (request) => {
      handed.push(request);
      return answer.value;
    },
    refused: (rule) => void refused.push(rule),
    logger: SILENT,
    ...more,
  });
  await door.open();
  const file = (await readDoorFile(paths.localDoor)) as LocalDoorFile;
  const opened: Opened = {
    door,
    paths,
    file,
    handed,
    refused,
    answer,
    cleanup: async () => {
      await door.close();
      await cleanup();
    },
  };
  cleanups.push(opened.cleanup);
  return opened;
}

/** Bytes written to a port of this machine exactly as given: what a caller
 *  that is not the console could send. Answers what came back. */
function raw(port: number, text: string): Promise<DoorExchange> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.write(text));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const parsed = parseDoorAnswer(Buffer.concat(chunks), true);
      if (!parsed || parsed === "more") return reject(new Error("not an answer"));
      resolve(parsed);
    });
  });
}

interface CallOptions {
  method?: string;
  target?: string;
  /** The `Host` header. Default: the door's own address. */
  host?: string;
  body?: string;
  /** More header lines, each `Name: value`. */
  extra?: string[];
  /** The number of this call. Null: no such header. Default: a fresh one. */
  nonce?: string | null;
  /** The whole `Authorization` value. Null: no such header. Default: the
   *  door's scheme with the right code for this number and this body. */
  authorization?: string | null;
  /** The secret the default code is made with. Default: the file's. */
  secret?: string;
  /** The time the call says. Null: no such header. Default: now. */
  time?: string | null;
  /** The hash the call says its body has. Null: no such header. Default: the
   *  hash of the body that is sent. */
  bodyHash?: string | null;
  /** What the default code is made for, where it is not what the call says. */
  signed?: { time?: string; what?: string; bodyHash?: string };
}

/** The head of one call to the door as the console makes it, with any part
 *  changed, and the number it carries. */
function headOf(door: { port: number; secret: string }, options: CallOptions, body: string): { head: string; nonce: string } {
  const nonce = options.nonce === undefined ? randomBytes(16).toString("base64url") : options.nonce;
  const time = options.time === undefined ? String(Date.now()) : options.time;
  const bodyHash = options.bodyHash === undefined ? doorBodyHash(Buffer.from(body)) : options.bodyHash;
  const what = `${options.method ?? "POST"} ${options.target ?? DOOR_ACT_PATH}`;
  const authorization =
    options.authorization === undefined
      ? `${DOOR_AUTH_SCHEME} ${doorRequestCode(options.secret ?? door.secret, {
          nonce: nonce ?? "",
          time: options.signed?.time ?? time ?? "",
          what: options.signed?.what ?? what,
          bodyHash: options.signed?.bodyHash ?? bodyHash ?? "",
        })}`
      : options.authorization;
  const lines = [
    `${what} HTTP/1.1`,
    `Host: ${options.host ?? `127.0.0.1:${door.port}`}`,
    ...(nonce === null ? [] : [`${DOOR_NONCE_HEADER}: ${nonce}`]),
    ...(time === null ? [] : [`${DOOR_TIME_HEADER}: ${time}`]),
    ...(bodyHash === null ? [] : [`${DOOR_BODY_HASH_HEADER}: ${bodyHash}`]),
    ...(authorization === null ? [] : [`Authorization: ${authorization}`]),
    "Content-Type: application/json",
    ...(options.extra ?? []),
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
  ];
  return { head: `${lines.join("\r\n")}\r\n\r\n`, nonce: nonce ?? "" };
}

/** One call to the door as the console makes it, with any part changed. */
async function call(
  door: { port: number; secret: string },
  options: CallOptions = {},
): Promise<DoorExchange & { nonce: string; bytes: string }> {
  const body = options.body ?? JSON.stringify(REQUEST);
  const { head, nonce } = headOf(door, options, body);
  const bytes = `${head}${body}`;
  return { ...(await raw(door.port, bytes)), nonce, bytes };
}

/** Send the head of a call that says a body follows, and no byte of that
 *  body. Answers the status that came back, or null when none came in time. */
function headOnly(door: { port: number; secret: string }, options: CallOptions, waitMs: number): Promise<number | null> {
  // The head says that 400,000 bytes of body follow.
  const { head } = headOf(door, { bodyHash: doorBodyHash(Buffer.from("x".repeat(400_000))), ...options }, "x".repeat(400_000));
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: door.port });
    const chunks: Buffer[] = [];
    const end = (status: number | null): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    const timer = setTimeout(() => end(null), waitMs);
    socket.once("connect", () => socket.write(head));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const status = /^HTTP\/1\.1 ([0-9]{3}) /.exec(Buffer.concat(chunks).toString("latin1"));
      if (status) end(Number(status[1]));
    });
    socket.on("error", () => end(null));
  });
}

describe("the door's file", () => {
  test("it says where the door is and holds its secret, readable by this user only", async () => {
    const opened = await openDoor();
    expect(opened.door.isOpen).toBe(true);
    expect(opened.file).toMatchObject({ v: 1, port: opened.door.port, pid: process.pid });
    expect(opened.file.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(opened.paths.localDoor)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(opened.paths.localDoor))).mode & 0o077).toBe(0);
  });

  test("closing removes the file and stops listening, and the next open has a new secret", async () => {
    const opened = await openDoor();
    const { secret } = opened.file;
    await opened.door.close();
    expect(opened.door.isOpen).toBe(false);
    await expect(stat(opened.paths.localDoor)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(call(opened.file)).rejects.toBeDefined();
    await opened.door.open();
    const again = (await readDoorFile(opened.paths.localDoor)) as LocalDoorFile;
    expect(again.secret).not.toBe(secret);
    // Opening twice is one door, with the secret it has.
    await opened.door.open();
    expect((await readDoorFile(opened.paths.localDoor))?.secret).toBe(again.secret);
  });

  test("when it closes, the file is gone before the listener stops", async () => {
    const opened = await openDoor();
    // The other order leaves, for a moment, a file that names a port nobody
    // of this HX Fortress listens on.
    const server = (opened.door as unknown as { server: { stop: (force?: boolean) => unknown } }).server;
    const stop = server.stop.bind(server);
    const fileThereAtStop: boolean[] = [];
    server.stop = (force?: boolean): unknown => {
      fileThereAtStop.push(existsSync(opened.paths.localDoor));
      return stop(force);
    };
    await opened.door.close();
    expect(fileThereAtStop).toEqual([false]);
    await expect(call(opened.file)).rejects.toBeDefined();
  });

  test("a file that was removed while the door is open is written again at the next look, with a new secret", async () => {
    const opened = await openDoor();
    await rm(opened.paths.localDoor);
    expect(await sendAct(opened.paths.localDoor, REQUEST)).toEqual(UNREACHABLE);
    await opened.door.open();
    const again = (await readDoorFile(opened.paths.localDoor)) as LocalDoorFile;
    expect(again).toMatchObject({ port: opened.file.port, pid: process.pid });
    expect(again.secret).not.toBe(opened.file.secret);
    expect(await sendAct(opened.paths.localDoor, REQUEST)).toMatchObject({ ok: true });
    // The old secret opens nothing now.
    expect((await call(opened.file)).status).toBe(401);
    // And so for a file that another door's words were written over.
    await writeFile(opened.paths.localDoor, JSON.stringify({ ...again, secret: "B".repeat(43) }));
    await opened.door.open();
    const third = (await readDoorFile(opened.paths.localDoor)) as LocalDoorFile;
    expect(third.secret).not.toBe("B".repeat(43));
    expect(await sendAct(opened.paths.localDoor, REQUEST)).toMatchObject({ ok: true });
  });

  test("a file that could not be removed when the door closed is removed at a later look", async () => {
    // A folder that takes no removal: only where this user is held to it.
    if (process.getuid?.() === 0) return;
    const said: string[] = [];
    const opened = await openDoor({ logger: { ...SILENT, error: (message: string) => void said.push(message) } });
    const folder = path.dirname(opened.paths.localDoor);
    await chmod(folder, 0o500);
    try {
      await opened.door.close("let_end");
      // The door is closed all the same, and it knows that its file is still there.
      expect(opened.door.isOpen).toBe(false);
      expect(opened.door.fileLeftBehind).toBe(true);
      expect(await readDoorFile(opened.paths.localDoor)).not.toBeNull();
      expect(said.filter((message) => message.includes("could not be removed"))).toHaveLength(1);
      // A look while the folder still takes no removal: tried, and said once only.
      await opened.door.close("let_end");
      expect(opened.door.fileLeftBehind).toBe(true);
      expect(said.filter((message) => message.includes("could not be removed"))).toHaveLength(1);
    } finally {
      await chmod(folder, 0o700);
    }
    await opened.door.close("let_end");
    expect(opened.door.fileLeftBehind).toBe(false);
    expect(await readDoorFile(opened.paths.localDoor)).toBeNull();
    await expect(stat(opened.paths.localDoor)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a file that was left behind is not removed once it is another process's", async () => {
    if (process.getuid?.() === 0) return;
    const opened = await openDoor();
    const folder = path.dirname(opened.paths.localDoor);
    await chmod(folder, 0o500);
    try {
      await opened.door.close();
    } finally {
      await chmod(folder, 0o700);
    }
    expect(opened.door.fileLeftBehind).toBe(true);
    // Another daemon on this folder has written its own door's file since.
    const theirs = JSON.stringify({ ...opened.file, pid: process.ppid, secret: "E".repeat(43) });
    await writeFile(opened.paths.localDoor, theirs);
    await opened.door.close();
    expect(opened.door.fileLeftBehind).toBe(false);
    expect(await readFile(opened.paths.localDoor, "utf8")).toBe(theirs);
  });

  test("an open door leaves a file that names another process that is running, and says so once", async () => {
    const said: string[] = [];
    const opened = await openDoor({ logger: { ...SILENT, error: (message: string) => void said.push(message) } });
    const running = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      // What a second daemon on this folder writes: its own door's file.
      const theirs = JSON.stringify({ v: 1, port: 5, secret: "F".repeat(43), pid: running.pid, openedAt: "2027-03-14T09:00:00.000Z" });
      await writeFile(opened.paths.localDoor, theirs);
      for (let look = 0; look < 3; look += 1) await opened.door.open();
      expect(await readFile(opened.paths.localDoor, "utf8")).toBe(theirs);
      expect(said.filter((message) => message.includes("names another process that is running"))).toHaveLength(1);
      // That process is gone: the file is nobody's, and this door writes its own again.
      running.kill();
      await running.exited;
      await opened.door.open();
      expect(await readDoorFile(opened.paths.localDoor)).toMatchObject({ port: opened.file.port, pid: process.pid });
      expect(await sendAct(opened.paths.localDoor, REQUEST)).toMatchObject({ ok: true });
    } finally {
      running.kill();
    }
  });

  test("it listens on this machine's own address and on no other", async () => {
    const opened = await openDoor();
    const server = (opened.door as unknown as { server: { hostname: string } }).server;
    expect(server.hostname).toBe("127.0.0.1");
    // An address of this machine on its network, where it has one: nothing
    // listens there on the door's port.
    const others = Object.values(os.networkInterfaces())
      .flat()
      .filter((address) => address && address.family === "IPv4" && !address.internal)
      .map((address) => address?.address as string);
    for (const address of others) {
      const outcome = await new Promise<string>((resolve) => {
        const socket = connect({ host: address, port: opened.file.port });
        socket.setTimeout(1_500, () => {
          socket.destroy();
          resolve("no answer");
        });
        socket.once("connect", () => {
          socket.destroy();
          resolve("connected");
        });
        socket.once("error", () => resolve("refused"));
      });
      expect([address, outcome]).not.toEqual([address, "connected"]);
    }
  });

  test("a logger that fails stops neither the opening nor the closing", async () => {
    const { paths, cleanup } = await tempRoot();
    cleanups.push(cleanup);
    const failing = (): never => {
      throw new Error("the log's disk is full");
    };
    const door = new LocalDoor({
      file: paths.localDoor,
      act: async () => ({ ok: true, reply: {} }),
      refused: () => {},
      logger: { debug: failing, info: failing, warn: failing, error: failing },
    });
    await door.open();
    expect(door.isOpen).toBe(true);
    expect(await readDoorFile(paths.localDoor)).not.toBeNull();
    await door.close();
    expect(door.isOpen).toBe(false);
    expect(await readDoorFile(paths.localDoor)).toBeNull();
  });
});

describe("what the door turns away", () => {
  test("a call that proves it holds the secret is handed on, and the answer proves that it is the door's", async () => {
    const opened = await openDoor();
    const got = await call(opened.file);
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body.toString("utf8"))).toEqual({ ok: true, reply: { reaches: [], names: [] } });
    expect(got.headers.get(DOOR_PROOF_HEADER)).toBe(doorAnswerCode(opened.file.secret, got.nonce, got.body));
    expect(opened.handed).toEqual([REQUEST]);
    expect(opened.refused).toEqual([]);
  });

  test("no code, a wrong code, the secret itself, and a code for another body or number are answered 401, and nothing is handed on", async () => {
    const opened = await openDoor();
    const { secret } = opened.file;
    const body = JSON.stringify(REQUEST);
    const nonce = randomBytes(16).toString("base64url");
    const time = String(Date.now());
    const bodyHash = doorBodyHash(Buffer.from(body));
    const rightCode = doorRequestCode(secret, { nonce, time, what: `POST ${DOOR_ACT_PATH}`, bodyHash });
    const other = JSON.stringify({ ...REQUEST, act: "thing.add" });
    const tries: [string, CallOptions][] = [
      ["no Authorization header", { authorization: null }],
      ["an empty one", { authorization: "" }],
      ["the scheme and no code", { authorization: `${DOOR_AUTH_SCHEME} ` }],
      // The way a secret is usually sent. It proves nothing here, and it must
      // not be accepted: a caller that sends it gives the secret away.
      ["the secret itself as a bearer token", { authorization: `Bearer ${secret}` }],
      ["the secret itself in the door's scheme", { authorization: `${DOOR_AUTH_SCHEME} ${secret}` }],
      ["a code made with another secret", { secret: "A".repeat(43) }],
      ["a code that is one character short", { nonce, time, authorization: `${DOOR_AUTH_SCHEME} ${rightCode.slice(0, -1)}` }],
      ["a code with one character more", { nonce, time, authorization: `${DOOR_AUTH_SCHEME} ${rightCode}x` }],
      ["the right code in another scheme", { nonce, time, authorization: `Bearer ${rightCode}` }],
      // The call says the hash of the body it sends, and its code is for another.
      ["a code made for another body", { signed: { bodyHash: doorBodyHash(Buffer.from(other)) } }],
      // The call says the hash its code is for, and sends another body.
      ["a body that is not the one the code was made for", { body: other, bodyHash }],
      ["a code made for another path", { signed: { what: "POST /console/island" } }],
      ["a code made for another method", { signed: { what: `GET ${DOOR_ACT_PATH}` } }],
      ["a code made for the path without its query", { target: `${DOOR_ACT_PATH}?as=operator`, signed: { what: `POST ${DOOR_ACT_PATH}` } }],
      ["a code made for another time", { signed: { time: String(Date.now() - 1_000) } }],
      ["the right code for another number", { nonce: randomBytes(16).toString("base64url"), time, authorization: `${DOOR_AUTH_SCHEME} ${rightCode}` }],
      ["no number", { nonce: null, time, authorization: `${DOOR_AUTH_SCHEME} ${rightCode}` }],
      ["a number that is not one", { nonce: "not a number", time, authorization: `${DOOR_AUTH_SCHEME} ${rightCode}` }],
      ["no time", { nonce, time: null, authorization: `${DOOR_AUTH_SCHEME} ${rightCode}` }],
      ["a time that is not one", { nonce, time: "just now", authorization: `${DOOR_AUTH_SCHEME} ${rightCode}` }],
      ["no hash of the body", { nonce, time, bodyHash: null, authorization: `${DOOR_AUTH_SCHEME} ${rightCode}` }],
      ["the hash of the body in upper case", { nonce, time, bodyHash: bodyHash.toUpperCase(), authorization: `${DOOR_AUTH_SCHEME} ${rightCode}` }],
    ];
    for (const [what, options] of tries) {
      const got = await call(opened.file, options);
      expect([what, got.status, got.body.byteLength, got.headers.has(DOOR_PROOF_HEADER)]).toEqual([what, 401, 0, false]);
    }
    expect(opened.handed).toEqual([]);
    expect(new Set(opened.refused)).toEqual(new Set(["door_secret"]));
    // The control: that number with its right code is taken.
    expect((await call(opened.file, { nonce, time, authorization: `${DOOR_AUTH_SCHEME} ${rightCode}` })).status).toBe(200);
  });

  test("a call without the right code is answered before a byte of its body is read", async () => {
    const opened = await openDoor();
    // Each head says that 400,000 bytes of body follow, and sends none. A
    // door that read the body first would wait for it, and hold what came.
    expect(await headOnly(opened.file, { authorization: null }, 3_000)).toBe(401);
    expect(await headOnly(opened.file, { secret: "A".repeat(43) }, 3_000)).toBe(401);
    expect(await headOnly(opened.file, { time: String(Date.now() - DOOR_CALL_WINDOW_MS - 5_000) }, 3_000)).toBe(401);
    expect(await headOnly(opened.file, { extra: ["Origin: https://attacker.example"] }, 3_000)).toBe(404);
    // The control: with the right code, the door waits for the body it was promised.
    expect(await headOnly(opened.file, {}, 400)).toBeNull();
    expect(opened.handed).toEqual([]);
  });

  test("a call is taken once: the same bytes sent again are turned away", async () => {
    const opened = await openDoor();
    const first = await call(opened.file);
    expect(first.status).toBe(200);
    // What somebody who saw the call on its way could send: the same bytes.
    const again = await raw(opened.file.port, first.bytes);
    expect([again.status, again.body.byteLength]).toEqual([401, 0]);
    expect(opened.handed).toHaveLength(1);
    expect(opened.refused).toEqual(["door_replay"]);
    // And two that arrive together: one is taken.
    const nonce = randomBytes(16).toString("base64url");
    const pair = await Promise.all([call(opened.file, { nonce }), call(opened.file, { nonce })]);
    expect(pair.map((got) => got.status).sort()).toEqual([200, 401]);
    expect(opened.handed).toHaveLength(2);
  });

  test("a call is taken only near its own time", async () => {
    const opened = await openDoor();
    const at = (shift: number): string => String(Date.now() + shift);
    for (const [what, time, status] of [
      ["made 29 seconds ago", at(-DOOR_CALL_WINDOW_MS + 1_000), 200],
      ["made 31 seconds ago", at(-DOOR_CALL_WINDOW_MS - 1_000), 401],
      ["made 31 seconds from now", at(DOOR_CALL_WINDOW_MS + 1_000), 401],
      ["made 29 seconds from now", at(DOOR_CALL_WINDOW_MS - 1_000), 200],
    ] as const) {
      expect([what, (await call(opened.file, { time })).status]).toEqual([what, status]);
    }
    expect(opened.handed).toHaveLength(2);
    expect(opened.refused).toEqual(["door_replay", "door_replay"]);
  });

  test("the door forgets a call only once its time alone refuses it, and takes no call it could not remember", async () => {
    const now = { value: Date.now() };
    const opened = await openDoor({ clock: () => new Date(now.value), rememberedMax: 2 });
    const first = await call(opened.file, { time: String(now.value) });
    const second = await call(opened.file, { time: String(now.value) });
    expect([first.status, second.status]).toEqual([200, 200]);
    // It remembers two, and that is all it can: a third is not taken, though
    // its code is right and it is new. Nothing is forgotten to make room.
    expect((await call(opened.file, { time: String(now.value) })).status).toBe(401);
    expect((await raw(opened.file.port, first.bytes)).status).toBe(401);
    expect(opened.handed).toHaveLength(2);
    // Past the window the two are forgotten, and their time refuses them.
    now.value += DOOR_CALL_WINDOW_MS + 1_000;
    expect((await call(opened.file, { time: String(now.value) })).status).toBe(200);
    expect((await raw(opened.file.port, first.bytes)).status).toBe(401);
    expect(opened.handed).toHaveLength(3);
    expect(new Set(opened.refused)).toEqual(new Set(["door_replay"]));
  });

  test("a call that names another host, or comes from a browser, is answered 404 even when its code is right", async () => {
    const opened = await openDoor();
    const { port } = opened.file;
    // A page that got a browser to resolve its own name to this machine.
    for (const host of [`attacker.example:${port}`, `localhost:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`]) {
      expect([host, (await call(opened.file, { host })).status]).toEqual([host, 404]);
    }
    for (const header of ["Origin: https://attacker.example", "Origin: null", "Sec-Fetch-Site: cross-site", "Sec-Fetch-Mode: cors"]) {
      expect([header, (await call(opened.file, { extra: [header] })).status]).toEqual([header, 404]);
    }
    expect(opened.handed).toEqual([]);
    expect(new Set(opened.refused)).toEqual(new Set(["door_host", "door_browser"]));
  });

  test("another method, another path and a body that is not JSON", async () => {
    const opened = await openDoor();
    // A GET carries no body, and its code is made for none.
    expect((await call(opened.file, { method: "GET", body: "" })).status).toBe(404);
    for (const [method, target] of [
      ["PUT", DOOR_ACT_PATH],
      ["POST", "/"],
      // Where a Secure Data Island's read will cross. Not built: the door has no such path.
      ["POST", "/console/island"],
      ["POST", `${DOOR_ACT_PATH}/`],
      ["POST", `${DOOR_ACT_PATH}?as=operator`],
    ] as const) {
      expect([method, target, (await call(opened.file, { method, target })).status]).toEqual([method, target, 404]);
    }
    expect((await call(opened.file, { body: "{ not json" })).status).toBe(400);
    expect(opened.handed).toEqual([]);
    expect(new Set(opened.refused)).toEqual(new Set(["door_route", "door_body"]));
  });

  test("a call without the secret learns nothing about what the door has", async () => {
    const opened = await openDoor();
    const known = await call(opened.file, { authorization: null });
    const unknown = await call(opened.file, { authorization: null, target: "/no/such/path" });
    expect([known.status, known.body.byteLength]).toEqual([unknown.status, unknown.body.byteLength]);
    expect(known.status).toBe(401);
  });
});

describe("the console's side", () => {
  test("it reaches the door and gets the daemon's answer", async () => {
    const opened = await openDoor();
    expect(await sendAct(opened.paths.localDoor, REQUEST)).toEqual({ ok: true, reply: { reaches: [], names: [] } });
    opened.answer.value = { ok: false, error: "failed:connection_unknown" };
    expect(await sendAct(opened.paths.localDoor, REQUEST)).toEqual({ ok: false, error: "failed:connection_unknown" });
    expect(opened.handed).toEqual([REQUEST, REQUEST]);
  });

  test("something that listens in the door's place is told no secret, and what it answers is not shown", async () => {
    const { paths, cleanup } = await tempRoot();
    const secret = randomBytes(32).toString("base64url");
    const seen: string[] = [];
    // What it answers: a reply that looks like the daemon's, in four ways.
    let answerWith: (req: Request, body: string) => Response = () => new Response("{}");
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const body = await req.text();
        seen.push(`${[...req.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n\n${body}`);
        return answerWith(req, body);
      },
    });
    cleanups.push(async () => {
      await squatter.stop(true);
      await cleanup();
    });
    // The door's file of a daemon that was killed, at a port something else took.
    await mkdir(path.dirname(paths.localDoor), { recursive: true });
    const file: LocalDoorFile = { v: 1, port: squatter.port as number, secret, pid: process.pid, openedAt: new Date().toISOString() };
    await writeFile(paths.localDoor, JSON.stringify(file));
    const reply = JSON.stringify({ ok: true, reply: { name: "orders-1" } });
    // What the door answered to an earlier call, with the door's true code
    // for it: something that saw that answer go by can send it again.
    const earlier = doorAnswerCode(secret, randomBytes(16).toString("base64url"), Buffer.from(reply));
    const answers: [string, (req: Request, body: string) => Response][] = [
      ["a reply with no code", () => new Response(reply)],
      ["a true answer of the door to an earlier call, sent again", () => new Response(reply, { headers: { [DOOR_PROOF_HEADER]: earlier } })],
      ["a reply with a made-up code", () => new Response(reply, { headers: { [DOOR_PROOF_HEADER]: "C".repeat(43) } })],
      // It cannot make the answer's code from what it was sent.
      ["a reply with the request's own code sent back", (req) => new Response(reply, { headers: { [DOOR_PROOF_HEADER]: (req.headers.get("authorization") ?? "").split(" ")[1] ?? "" } })],
      ["a reply with a code made from the number and the code it saw", (req) =>
        new Response(reply, {
          headers: {
            [DOOR_PROOF_HEADER]: doorAnswerCode((req.headers.get("authorization") ?? "").split(" ")[1] ?? "", req.headers.get(DOOR_NONCE_HEADER) ?? "", Buffer.from(reply)),
          },
        })],
    ];
    for (const [what, answer] of answers) {
      answerWith = answer;
      expect([what, await sendAct(paths.localDoor, REQUEST)]).toEqual([what, UNREACHABLE]);
    }
    expect(seen).toHaveLength(answers.length);
    expect(seen.join("\n")).not.toContain(secret);
    // The control: an answer with the door's own code for it is shown.
    answerWith = (req) => new Response(reply, { headers: { [DOOR_PROOF_HEADER]: doorAnswerCode(secret, req.headers.get(DOOR_NONCE_HEADER) ?? "", Buffer.from(reply)) } });
    expect(await sendAct(paths.localDoor, REQUEST)).toEqual({ ok: true, reply: { name: "orders-1" } });
  });

  test("it does not go through a proxy that the environment names", async () => {
    // In a process of its own: see _door-proxy-child.ts for why.
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "_door-proxy-child.ts")], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect([code, err]).toEqual([0, ""]);
    const result = JSON.parse(out.trim().split("\n").pop() ?? "{}") as {
      viaFetch: string;
      sawFromFetch: string[];
      viaSendAct: unknown;
      sawFromSendAct: string[];
      handed: number;
    };
    // What this guards against: the runtime's own `fetch` does go through the
    // proxy, with the request's headers.
    expect(result.viaFetch).toBe("from the proxy");
    expect(result.sawFromFetch).toEqual([`POST ${DOOR_ACT_PATH} authorization=sent`]);
    // The console's side reaches the door itself, and the proxy sees nothing.
    expect(result.viaSendAct).toEqual({ ok: true, reply: { reached: "the door" } });
    expect(result.sawFromSendAct).toEqual([]);
    expect(result.handed).toBe(1);
  });

  test("no file, a file that is not one, and a daemon that is gone all read as `daemon_unreachable`, and nothing is sent", async () => {
    const opened = await openDoor();
    const other = path.join(opened.paths.runtimeRoot, "other-door.json");
    expect(await sendAct(other, REQUEST)).toEqual(UNREACHABLE);
    for (const content of ["{ not json", "[]", JSON.stringify({ ...opened.file, v: 2 }), JSON.stringify({ ...opened.file, port: 0 }), JSON.stringify({ ...opened.file, secret: "short" }), JSON.stringify({ ...opened.file, pid: -1 })]) {
      await writeFile(other, content);
      expect([content, await sendAct(other, REQUEST)]).toEqual([content, UNREACHABLE]);
    }
    // The file is right, and the process that wrote it is not running.
    expect(await sendAct(opened.paths.localDoor, REQUEST, { alive: () => false })).toEqual(UNREACHABLE);
    expect(opened.handed).toEqual([]);
    expect(opened.refused).toEqual([]);
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
  });

  test("a named pipe, a folder or a huge file where the door's file should be is answered at once, and is not read", async () => {
    const { paths, cleanup } = await tempRoot();
    cleanups.push(cleanup);
    await mkdir(path.dirname(paths.localDoor), { recursive: true });
    const within = async (what: string): Promise<void> => {
      const started = Date.now();
      expect([what, await sendAct(paths.localDoor, REQUEST)]).toEqual([what, UNREACHABLE]);
      expect([what, Date.now() - started < 2_000]).toEqual([what, true]);
    };
    // A named pipe: opening one to read waits for a writer, for ever.
    expect(Bun.spawnSync(["mkfifo", paths.localDoor]).exitCode).toBe(0);
    await within("a named pipe");
    await rm(paths.localDoor);
    await mkdir(paths.localDoor);
    await within("a folder");
    await rm(paths.localDoor, { recursive: true });
    await writeFile(paths.localDoor, JSON.stringify({ v: 1, port: 5, secret: "D".repeat(43), pid: process.pid, openedAt: "x", padding: "y".repeat(100_000) }));
    await within("a file far too large");
  });

  test("the door's file is used for nobody but the daemon that is running now", async () => {
    const opened = await openDoor();
    const pid = opened.file.pid;
    // The daemon's own status file names another process, or none, or cannot be read.
    expect(await sendAct(opened.paths.localDoor, REQUEST, { daemonPid: async () => pid + 1 })).toEqual(UNREACHABLE);
    expect(await sendAct(opened.paths.localDoor, REQUEST, { daemonPid: async () => null })).toEqual(UNREACHABLE);
    expect(
      await sendAct(opened.paths.localDoor, REQUEST, {
        daemonPid: async () => {
          throw new Error("status.json cannot be read");
        },
      }),
    ).toEqual(UNREACHABLE);
    // Nothing was sent: the door was not called at all.
    expect(opened.handed).toEqual([]);
    expect(opened.refused).toEqual([]);
    // It names the same process: the act goes through.
    expect(await sendAct(opened.paths.localDoor, REQUEST, { daemonPid: async () => pid })).toMatchObject({ ok: true });
    expect(opened.handed).toHaveLength(1);
  });

  test("a file left by a run that is gone opens nothing: the port is closed, or the secret is another run's", async () => {
    const opened = await openDoor();
    const stale = path.join(opened.paths.runtimeRoot, "stale-door.json");
    // Another run's secret at this door's port.
    await writeFile(stale, JSON.stringify({ ...opened.file, secret: "B".repeat(43) }));
    expect(await sendAct(stale, REQUEST)).toEqual(UNREACHABLE);
    expect(opened.handed).toEqual([]);
    // A port nothing listens on.
    const { port } = opened.file;
    await opened.door.close();
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(stale, JSON.stringify({ ...opened.file, port }));
    expect(await sendAct(stale, REQUEST)).toEqual(UNREACHABLE);
  });

  test("a daemon that started again between the look and the call is found at its new door", async () => {
    const opened = await openDoor();
    const first = await readFile(opened.paths.localDoor, "utf8");
    await opened.door.close();
    await opened.door.open();
    const second = await readFile(opened.paths.localDoor, "utf8");
    // The console read the file of the first run, and reads the second run's
    // file when it looks again.
    let looks = 0;
    const file = path.join(opened.paths.runtimeRoot, "moving-door.json");
    await writeFile(file, first);
    const answer = await sendAct(file, REQUEST, {
      alive: () => {
        looks += 1;
        return true;
      },
      connect: (options) => {
        // After the first try, the file is the new run's.
        writeFileSync(file, second);
        return connect(options);
      },
    });
    expect(answer).toEqual({ ok: true, reply: { reaches: [], names: [] } });
    expect(looks).toBe(2);
  });

  test("a door that closes while it has the act: the person is told the act was interrupted, and it is not sent again", async () => {
    const { paths, cleanup } = await tempRoot();
    const handed: unknown[] = [];
    let reopened: () => void = () => {};
    const newDoor = new Promise<void>((resolve) => {
      reopened = resolve;
    });
    const door: LocalDoor = new LocalDoor({
      file: paths.localDoor,
      act: (request) => {
        handed.push(request);
        // The daemon starts again while it has the act: this door closes, and
        // a new one opens with a new secret. The act is never answered.
        void (async () => {
          await door.close();
          await door.open();
          reopened();
        })();
        return new Promise(() => {});
      },
      refused: () => {},
      logger: SILENT,
    });
    await door.open();
    cleanups.push(async () => {
      await door.close();
      await cleanup();
    });
    const first = await readDoorFile(paths.localDoor);
    expect(await sendAct(paths.localDoor, REQUEST)).toEqual({ ok: false, error: ACT_INTERRUPTED });
    // The new door is there, and it was not handed the act a second time.
    await newDoor;
    const second = await readDoorFile(paths.localDoor);
    expect(second).not.toBeNull();
    expect(second?.secret).not.toBe(first?.secret);
    await Bun.sleep(50);
    expect(handed).toHaveLength(1);
  });

  test("a door that is closed for a module that was switched off takes no new call, and the call it holds still gets its answer", async () => {
    const { paths, cleanup } = await tempRoot();
    let answer: (value: ActAnswer) => void = () => {};
    let taken: () => void = () => {};
    const handedOn = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const door = new LocalDoor({
      file: paths.localDoor,
      act: () => {
        taken();
        return new Promise<ActAnswer>((resolve) => {
          answer = resolve;
        });
      },
      refused: () => {},
      logger: SILENT,
    });
    await door.open();
    cleanups.push(async () => {
      await door.close();
      await cleanup();
    });
    const file = (await readDoorFile(paths.localDoor)) as LocalDoorFile;
    const pending = sendAct(paths.localDoor, REQUEST);
    await handedOn;
    await door.close("let_end");
    expect(await readDoorFile(paths.localDoor)).toBeNull();
    await expect(call(file)).rejects.toBeDefined();
    answer({ ok: false, error: "module_off" });
    expect(await pending).toEqual({ ok: false, error: "module_off" });
  });

  test("a daemon that has the act and does not answer in time is `failed:timeout`", async () => {
    const { paths, cleanup } = await tempRoot();
    const door = new LocalDoor({
      file: paths.localDoor,
      act: () => new Promise(() => {}),
      refused: () => {},
      logger: SILENT,
    });
    await door.open();
    cleanups.push(async () => {
      await door.close();
      await cleanup();
    });
    expect(await sendAct(paths.localDoor, REQUEST, { timeoutMs: 60 })).toEqual({ ok: false, error: "failed:timeout" });
  });

  test("a request too large for the door is not sent", async () => {
    const opened = await openDoor();
    const big = { ...REQUEST, args: { text: "x".repeat(DOOR_REQUEST_MAX_BYTES) } };
    expect(await sendAct(opened.paths.localDoor, big)).toEqual({ ok: false, error: "args_invalid" });
    expect(opened.handed).toEqual([]);
  });

  test("an answer that is not one of the daemon's is not shown", async () => {
    const opened = await openDoor();
    for (const value of [
      { ok: false, error: "A sentence with a value in it" },
      { ok: false, error: "failed:Not A Word" },
      { ok: "yes" },
      "text",
    ]) {
      opened.answer.value = value as unknown as ActAnswer;
      expect([value, await sendAct(opened.paths.localDoor, REQUEST)]).toEqual([value, { ok: false, error: "failed:internal" }]);
    }
  });

  test("the answer's bytes are read as the door writes them, and as nothing else", () => {
    const answer = (head: string, body: string): Buffer => Buffer.from(`${head}\r\n\r\n${body}`, "utf8");
    const read = (bytes: Buffer, ended: boolean): unknown => {
      const parsed = parseDoorAnswer(bytes, ended);
      return parsed === null || parsed === "more" ? parsed : { status: parsed.status, body: parsed.body.toString("utf8") };
    };
    expect(read(answer("HTTP/1.1 200 OK\r\nContent-Length: 2", "{}"), false)).toEqual({ status: 200, body: "{}" });
    expect(read(answer("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0", ""), false)).toEqual({ status: 401, body: "" });
    // Not all there yet.
    expect(read(Buffer.from("HTTP/1.1 200 OK\r\nContent-Le"), false)).toBe("more");
    expect(read(answer("HTTP/1.1 200 OK\r\nContent-Length: 10", "{}"), false)).toBe("more");
    // Cut short, in pieces, without a length, with two lengths, or not HTTP.
    expect(read(answer("HTTP/1.1 200 OK\r\nContent-Length: 10", "{}"), true)).toBeNull();
    expect(read(answer("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked", "2\r\n{}\r\n0\r\n\r\n"), true)).toBeNull();
    expect(read(answer("HTTP/1.1 200 OK", "{}"), true)).toBeNull();
    expect(read(answer("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 4", "{}{}"), true)).toBeNull();
    expect(read(answer("SSH-2.0-OpenSSH_9.6", ""), true)).toBeNull();
    expect(read(Buffer.alloc(0), true)).toBeNull();
    // A body longer than its length says: only the length is taken.
    expect(read(answer("HTTP/1.1 200 OK\r\nContent-Length: 2", "{}extra"), true)).toEqual({ status: 200, body: "{}" });
    // Headers are read by name in lower case. One that comes twice is not used.
    const withHeaders = parseDoorAnswer(answer(`HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Door-Proof: abc\r\nX-Other: 1\r\nx-other: 2`, "{}"), true);
    if (withHeaders === null || withHeaders === "more") throw new Error("not parsed");
    expect(withHeaders.headers.get(DOOR_PROOF_HEADER)).toBe("abc");
    expect(withHeaders.headers.has("x-other")).toBe(false);
    const twoProofs = parseDoorAnswer(answer(`HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Door-Proof: abc\r\nX-Door-Proof: def`, "{}"), true);
    if (twoProofs === null || twoProofs === "more") throw new Error("not parsed");
    expect(twoProofs.headers.has(DOOR_PROOF_HEADER)).toBe(false);
  });
});

describe("when the door is open", () => {
  let rig: Rig | ActsRig;
  afterEach(async () => {
    await rig?.cleanup();
  });
  const doorFile = (): Promise<LocalDoorFile | null> => readDoorFile(rig.paths.localDoor);
  /** The console's call to this rig's door. The rig's daemon reads the rig's
   *  own clock, which stands still, so the call is made on that clock too. */
  const send = (request: ActRequest, options: Parameters<typeof sendAct>[2] = {}): ReturnType<typeof sendAct> =>
    sendAct(rig.paths.localDoor, request, { now: () => rig.now.value.getTime(), ...options });

  test("an HX Fortress with no module that takes acts has no door and no file, and a look at the switch touches neither", async () => {
    // The probe of the other tests: a module with asks and no acts.
    rig = await makeRig();
    expect(rig.host.door.isOpen).toBe(false);
    await expect(stat(rig.paths.localDoor)).rejects.toMatchObject({ code: "ENOENT" });
    // A file that is not the door's, at the door's path: a look leaves it alone.
    await mkdir(path.dirname(rig.paths.localDoor), { recursive: true });
    await writeFile(rig.paths.localDoor, "not a door's file");
    await rig.host.applyRequests();
    expect(rig.host.door.isOpen).toBe(false);
    expect(await readFile(rig.paths.localDoor, "utf8")).toBe("not a door's file");
  });

  test("it opens once a module that takes acts is on and started, and an act crosses it", async () => {
    rig = await makeActsRig();
    expect(rig.host.door.isOpen).toBe(true);
    expect(await send({ ...REQUEST, act: "thing.add", args: { name: "orders-1", host: "db.northstar.example", port: 1433 } })).toEqual({
      ok: true,
      reply: { name: "orders-1" },
    });
    expect((rig as ActsRig).acts.acted).toHaveLength(1);
    expect((await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct))[0]).toMatchObject({ actor: "maya.chen", sessionRef: SESSION });
    // The secret of the door is in no record and no log line.
    const secret = (await doorFile())?.secret as string;
    expect(await spoolText(rig.paths)).not.toContain(secret);
    expect(JSON.stringify(rig.logs)).not.toContain(secret);
  });

  test("it closes when the last such module is switched off, and opens again with a new secret", async () => {
    rig = await makeActsRig();
    const first = await doorFile();
    await writeConfig(rig.paths, ["session_vault"]);
    await rig.host.applyRequests();
    expect(rig.host.door.isOpen).toBe(false);
    expect(await doorFile()).toBeNull();
    expect(await send(REQUEST)).toEqual(UNREACHABLE);

    await writeConfig(rig.paths, ["session_vault", "probe"]);
    await rig.host.applyRequests();
    const second = await doorFile();
    expect(second?.secret).not.toBe(first?.secret);
    expect(await send(REQUEST)).toMatchObject({ ok: true });
  });

  test("a door's file that something removed is back after the next look at the switch", async () => {
    rig = await makeActsRig();
    const first = await doorFile();
    await rm(rig.paths.localDoor);
    expect(await send(REQUEST)).toEqual(UNREACHABLE);
    await rig.host.applyRequests();
    const second = await doorFile();
    expect(second).toMatchObject({ port: first?.port, pid: process.pid });
    expect(second?.secret).not.toBe(first?.secret);
    expect(await send(REQUEST)).toMatchObject({ ok: true });
  });

  test("a door's file that could not be removed at a switch-off is removed at the next look at the switch", async () => {
    if (process.getuid?.() === 0) return;
    rig = await makeActsRig();
    const folder = path.dirname(rig.paths.localDoor);
    await writeConfig(rig.paths, ["session_vault"]);
    await chmod(folder, 0o500);
    try {
      await rig.host.applyRequests();
    } finally {
      await chmod(folder, 0o700);
    }
    expect(rig.host.door.isOpen).toBe(false);
    expect(await doorFile()).not.toBeNull();
    // Nothing listens at the port the file names: the console says so.
    expect(await send(REQUEST)).toEqual(UNREACHABLE);
    await rig.host.applyRequests();
    expect(await doorFile()).toBeNull();
    await expect(stat(rig.paths.localDoor)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an act that is the first to notice that its module was switched off is answered `module_off`, and is not cut", async () => {
    rig = await makeActsRig();
    // Switched off in config.json, and the daemon has not been told yet.
    await writeConfig(rig.paths, ["session_vault"]);
    expect(await send({ ...REQUEST, act: "thing.add", args: { name: "orders-1", host: "db.northstar.example", port: 1433 } })).toEqual({
      ok: false,
      error: "module_off",
    });
    expect((rig as ActsRig).acts.acted).toEqual([]);
    // The act made the daemon follow the switch: the door is closed now.
    expect(rig.host.door.isOpen).toBe(false);
    expect(await doorFile()).toBeNull();
  });

  test("it is not open before the modules have started, and it is closed when the daemon stops", async () => {
    rig = await makeActsRig({ start: false });
    await rig.host.start();
    expect(rig.host.door.isOpen).toBe(false);
    await rig.registry.startAll(["session_vault", "probe"]);
    await rig.host.started();
    expect(rig.host.door.isOpen).toBe(true);
    await rig.host.stop();
    expect(rig.host.door.isOpen).toBe(false);
    expect(await doorFile()).toBeNull();
  });

  test("the first step of the daemon's stop closes the door, and no later look opens it again", async () => {
    rig = await makeActsRig();
    await rig.host.beginStop();
    expect(rig.host.door.isOpen).toBe(false);
    expect(await doorFile()).toBeNull();
    // What the daemon still does while the rest of it stops.
    await rig.host.applyRequests();
    await rig.host.follow();
    expect(rig.host.door.isOpen).toBe(false);
    expect(await doorFile()).toBeNull();
    expect(await send(REQUEST)).toEqual(UNREACHABLE);
  });

  test("a module being switched off does not wait for an act that is still running, and does not cut it", async () => {
    rig = await makeActsRig({ deps: { actDeadlineMs: 300 } });
    const acts = (rig as ActsRig).acts;
    const pending = send({ ...REQUEST, act: "never" });
    while (acts.acted.length === 0) await Bun.sleep(2);
    await writeConfig(rig.paths, ["session_vault"]);
    const started = Date.now();
    await rig.host.applyRequests();
    expect(Date.now() - started).toBeLessThan(250);
    expect(rig.host.door.isOpen).toBe(false);
    // The call was not cut: the act's own answer arrives when its time is up.
    expect(await pending).toEqual({ ok: false, error: "failed:timeout" });
  });

  test("the daemon's stop does not wait for an act that is still running: the call is cut", async () => {
    rig = await makeActsRig();
    const acts = (rig as ActsRig).acts;
    const pending = send({ ...REQUEST, act: "never" });
    while (acts.acted.length === 0) await Bun.sleep(2);
    const started = Date.now();
    await rig.host.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await pending).toEqual({ ok: false, error: ACT_INTERRUPTED });
    expect(await doorFile()).toBeNull();
  });

  test("a look at the switch that was under way when the daemon began to stop does not open the door again", async () => {
    rig = await makeActsRig();
    // The door is closed, as it is for a moment while a module is switched.
    await rig.host.door.close();
    const host = rig.host as unknown as { enabledNow: () => Promise<ReadonlySet<string> | null> };
    const readSwitch = host.enabledNow.bind(rig.host);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The read of the switch takes a while, as a slow disk makes it.
    host.enabledNow = async () => {
      await held;
      return readSwitch();
    };
    const look = rig.host.follow();
    // The daemon begins to stop while that read is under way.
    const stopping = rig.host.stop();
    release();
    await Promise.all([look, stopping]);
    expect(rig.host.door.isOpen).toBe(false);
    expect(await doorFile()).toBeNull();
  });

  test("a file that a run which did not stop cleanly left is removed at the next start", async () => {
    rig = await makeRig({ start: false });
    await mkdir(path.dirname(rig.paths.localDoor), { recursive: true });
    // A process id nothing has.
    await writeFile(rig.paths.localDoor, JSON.stringify({ v: 1, port: 5, secret: "C".repeat(43), pid: 2 ** 22 + 4321, openedAt: "2027-03-14T09:00:00.000Z" }));
    await rig.host.start();
    await expect(stat(rig.paths.localDoor)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a file that names another process that is running is left at the start: it may be another daemon's door", async () => {
    rig = await makeRig({ start: false });
    await mkdir(path.dirname(rig.paths.localDoor), { recursive: true });
    // A process of this user that is running, and is not this one.
    const running = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      const other = JSON.stringify({ v: 1, port: 5, secret: "C".repeat(43), pid: running.pid, openedAt: "2027-03-14T09:00:00.000Z" });
      await writeFile(rig.paths.localDoor, other);
      await rig.host.start();
      expect(await readFile(rig.paths.localDoor, "utf8")).toBe(other);
      // Once that process is gone, the file is nobody's.
      running.kill();
      await running.exited;
      await rig.host.door.clearStale();
      await expect(stat(rig.paths.localDoor)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      running.kill();
    }
    // A file that names this very process is an earlier run's: the id was given out again.
    await writeFile(rig.paths.localDoor, JSON.stringify({ v: 1, port: 5, secret: "C".repeat(43), pid: process.pid, openedAt: "2027-03-14T09:00:00.000Z" }));
    await rig.host.door.clearStale();
    await expect(stat(rig.paths.localDoor)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a switch that cannot be read leaves the door as it is, and every act is refused meanwhile", async () => {
    rig = await makeActsRig();
    await writeFile(rig.paths.config, "{ not json");
    await rig.host.applyRequests();
    expect(rig.host.door.isOpen).toBe(true);
    expect(await send(REQUEST)).toEqual({ ok: false, error: "module_off" });
  });

  test("a call the door turns away is counted in the audit trail, with nothing of what it sent", async () => {
    rig = await makeActsRig();
    const file = (await doorFile()) as LocalDoorFile;
    for (let i = 0; i < 4; i += 1) {
      await call(file, { authorization: `Bearer guess-${i}-of-a-secret` });
    }
    await rig.host.audit.flush();
    const refused = await recordsOf(rig, AUDIT_ACTIONS.localDoorRefused);
    // A run of the same refusal is two records: the first, and how many followed.
    expect(refused.map((record) => record.params)).toMatchObject([{ rule: "door_secret" }, { rule: "door_secret", attempts: 3 }]);
    expect(refused[0]?.actor).toBeNull();
    expect(await spoolText(rig.paths)).not.toContain("guess-");
    // The act gate was not reached.
    expect(await act(rig, "things.read")).toMatchObject({ ok: true });
  });
});
