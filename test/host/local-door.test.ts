// The daemon's door on this machine: who may call it, what it turns away, when
// it is open at all, and how the console calls it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

import { AUDIT_ACTIONS } from "../../src/console/audit-actions";
import { DOOR_ACT_PATH, DOOR_REQUEST_MAX_BYTES, LocalDoor, type DoorRule, type LocalDoorFile } from "../../src/host/local-door";
import {
  ACT_INTERRUPTED,
  DAEMON_UNREACHABLE,
  parseDoorAnswer,
  processAlive,
  readDoorFile,
  sendAct,
  type ActRequest,
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

async function openDoor(): Promise<Opened> {
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
    logger: { debug() {}, info() {}, warn() {}, error() {} },
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

/** One raw request to the door, exactly as written: what a caller that is not
 *  the console could send. Answers the status line's number. */
function raw(port: number, head: string, body = ""): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.write(`${head}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const parsed = parseDoorAnswer(Buffer.concat(chunks), true);
      if (!parsed || parsed === "more") return reject(new Error("not an answer"));
      resolve(parsed);
    });
  });
}

const good = (opened: Opened, extra = ""): string =>
  `POST ${DOOR_ACT_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${opened.file.port}\r\nAuthorization: Bearer ${opened.file.secret}\r\nContent-Type: application/json${extra}`;

describe("the door's file", () => {
  test("it says where the door is and holds this run's secret, readable by this user only", async () => {
    const opened = await openDoor();
    expect(opened.door.isOpen).toBe(true);
    expect(opened.file).toMatchObject({ v: 1, port: opened.door.port, pid: process.pid });
    expect(opened.file.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(opened.paths.localDoor)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(opened.paths.localDoor))).mode & 0o077).toBe(0);
  });

  test("closing removes the file and stops listening, and the next open has a new secret", async () => {
    const opened = await openDoor();
    const { port, secret } = opened.file;
    await opened.door.close();
    expect(opened.door.isOpen).toBe(false);
    await expect(stat(opened.paths.localDoor)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(raw(port, good(opened), "{}")).rejects.toBeDefined();
    await opened.door.open();
    const again = (await readDoorFile(opened.paths.localDoor)) as LocalDoorFile;
    expect(again.secret).not.toBe(secret);
    // Opening twice is one door.
    await opened.door.open();
    expect((await readDoorFile(opened.paths.localDoor))?.secret).toBe(again.secret);
  });

  test("it listens on this machine's own address and on no other", async () => {
    const opened = await openDoor();
    const server = (opened.door as unknown as { server: { hostname: string } }).server;
    expect(server.hostname).toBe("127.0.0.1");
  });
});

describe("what the door turns away", () => {
  test("a call with this run's secret is handed on, and its answer comes back", async () => {
    const opened = await openDoor();
    const got = await raw(opened.file.port, good(opened), JSON.stringify(REQUEST));
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body)).toEqual({ ok: true, reply: { reaches: [], names: [] } });
    expect(opened.handed).toEqual([REQUEST]);
    expect(opened.refused).toEqual([]);
  });

  test("no secret, a wrong one and a nearly right one are answered 401, and nothing is handed on", async () => {
    const opened = await openDoor();
    const { port, secret } = opened.file;
    const head = (authorization: string | null): string =>
      `POST ${DOOR_ACT_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}${authorization === null ? "" : `\r\nAuthorization: ${authorization}`}\r\nContent-Type: application/json`;
    for (const authorization of [
      null,
      "",
      "Bearer ",
      `Bearer ${secret.slice(0, -1)}`,
      `Bearer ${secret}x`,
      `bearer ${secret}`,
      `Basic ${secret}`,
      secret,
      "Bearer " + "A".repeat(43),
    ]) {
      const got = await raw(port, head(authorization), JSON.stringify(REQUEST));
      expect([authorization, got.status, got.body]).toEqual([authorization, 401, ""]);
    }
    expect(opened.handed).toEqual([]);
    expect(new Set(opened.refused)).toEqual(new Set(["door_secret"]));
  });

  test("a call that names another host, or comes from a browser, is answered 404 even with the secret", async () => {
    const opened = await openDoor();
    const { port, secret } = opened.file;
    const withHost = (host: string): string =>
      `POST ${DOOR_ACT_PATH} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${secret}\r\nContent-Type: application/json`;
    // A page that got a browser to resolve its own name to this machine.
    for (const host of [`attacker.example:${port}`, `localhost:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`]) {
      expect([host, (await raw(port, withHost(host), JSON.stringify(REQUEST))).status]).toEqual([host, 404]);
    }
    for (const header of ["Origin: https://attacker.example", "Origin: null", "Sec-Fetch-Site: cross-site", "Sec-Fetch-Mode: cors"]) {
      expect([header, (await raw(port, good(opened, `\r\n${header}`), JSON.stringify(REQUEST))).status]).toEqual([header, 404]);
    }
    expect(opened.handed).toEqual([]);
    expect(new Set(opened.refused)).toEqual(new Set(["door_host", "door_browser"]));
  });

  test("another method, another path and a body that is not JSON", async () => {
    const opened = await openDoor();
    const { port, secret } = opened.file;
    const to = (method: string, target: string): string =>
      `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${secret}\r\nContent-Type: application/json`;
    for (const [method, target] of [
      ["GET", DOOR_ACT_PATH],
      ["PUT", DOOR_ACT_PATH],
      ["POST", "/"],
      ["POST", "/console/island"],
      ["POST", `${DOOR_ACT_PATH}/`],
      ["POST", `${DOOR_ACT_PATH}?as=operator`],
    ] as const) {
      expect([method, target, (await raw(port, to(method, target), JSON.stringify(REQUEST))).status]).toEqual([method, target, 404]);
    }
    expect((await raw(port, good(opened), "{ not json")).status).toBe(400);
    expect(opened.handed).toEqual([]);
    expect(new Set(opened.refused)).toEqual(new Set(["door_route", "door_body"]));
  });

  test("a call without the secret learns nothing about what the door has", async () => {
    const opened = await openDoor();
    const { port } = opened.file;
    const without = (target: string): string => `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}`;
    const known = await raw(port, without(DOOR_ACT_PATH), "{}");
    const unknown = await raw(port, without("/no/such/path"), "{}");
    expect([known.status, known.body]).toEqual([unknown.status, unknown.body]);
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

  test("it does not go through a proxy that the environment names, and neither does the secret", async () => {
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
    // proxy, and hands it the door's secret.
    expect(result.viaFetch).toBe("from the proxy");
    expect(result.sawFromFetch).toEqual([`POST ${DOOR_ACT_PATH} authorization=sent`]);
    // The console's side reaches the door itself, and the proxy sees nothing.
    expect(result.viaSendAct).toEqual({ ok: true, reply: { reached: "the door" } });
    expect(result.sawFromSendAct).toEqual([]);
    expect(result.handed).toBe(1);
  });

  test("no file, a file that is not one, and a daemon that is gone all read as `daemon_unreachable`, and nothing is sent", async () => {
    const opened = await openDoor();
    const unreachable = { ok: false, error: DAEMON_UNREACHABLE } as const;
    const other = path.join(opened.paths.runtimeRoot, "other-door.json");
    expect(await sendAct(other, REQUEST)).toEqual(unreachable);
    for (const content of ["{ not json", "[]", JSON.stringify({ ...opened.file, v: 2 }), JSON.stringify({ ...opened.file, port: 0 }), JSON.stringify({ ...opened.file, secret: "short" }), JSON.stringify({ ...opened.file, pid: -1 })]) {
      await writeFile(other, content);
      expect([content, await sendAct(other, REQUEST)]).toEqual([content, unreachable]);
    }
    // The file is right, and the process that wrote it is not running.
    expect(await sendAct(opened.paths.localDoor, REQUEST, { alive: () => false })).toEqual(unreachable);
    expect(opened.handed).toEqual([]);
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
  });

  test("a file left by a run that is gone opens nothing: the port is closed, or the secret is another run's", async () => {
    const opened = await openDoor();
    const stale = path.join(opened.paths.runtimeRoot, "stale-door.json");
    // Another run's secret at this door's port.
    await writeFile(stale, JSON.stringify({ ...opened.file, secret: "B".repeat(43) }));
    expect(await sendAct(stale, REQUEST)).toEqual({ ok: false, error: DAEMON_UNREACHABLE });
    expect(opened.handed).toEqual([]);
    // A port nothing listens on.
    const { port } = opened.file;
    await opened.door.close();
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(stale, JSON.stringify({ ...opened.file, port }));
    expect(await sendAct(stale, REQUEST)).toEqual({ ok: false, error: DAEMON_UNREACHABLE });
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
        void writeFile(file, second);
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
      logger: { debug() {}, info() {}, warn() {}, error() {} },
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

  test("a daemon that has the act and does not answer in time is `failed:timeout`", async () => {
    const { paths, cleanup } = await tempRoot();
    const door = new LocalDoor({
      file: paths.localDoor,
      act: () => new Promise(() => {}),
      refused: () => {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
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
    expect(parseDoorAnswer(answer("HTTP/1.1 200 OK\r\nContent-Length: 2", "{}"), false)).toEqual({ status: 200, body: "{}" });
    expect(parseDoorAnswer(answer("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0", ""), false)).toEqual({ status: 401, body: "" });
    // Not all there yet.
    expect(parseDoorAnswer(Buffer.from("HTTP/1.1 200 OK\r\nContent-Le"), false)).toBe("more");
    expect(parseDoorAnswer(answer("HTTP/1.1 200 OK\r\nContent-Length: 10", "{}"), false)).toBe("more");
    // Cut short, in pieces, without a length, with two lengths, or not HTTP.
    expect(parseDoorAnswer(answer("HTTP/1.1 200 OK\r\nContent-Length: 10", "{}"), true)).toBeNull();
    expect(parseDoorAnswer(answer("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked", "2\r\n{}\r\n0\r\n\r\n"), true)).toBeNull();
    expect(parseDoorAnswer(answer("HTTP/1.1 200 OK", "{}"), true)).toBeNull();
    expect(parseDoorAnswer(answer("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 4", "{}{}"), true)).toBeNull();
    expect(parseDoorAnswer(answer("SSH-2.0-OpenSSH_9.6", ""), true)).toBeNull();
    expect(parseDoorAnswer(Buffer.alloc(0), true)).toBeNull();
    // A body longer than its length says: only the length is taken.
    expect(parseDoorAnswer(answer("HTTP/1.1 200 OK\r\nContent-Length: 2", "{}extra"), true)).toEqual({ status: 200, body: "{}" });
  });
});

describe("when the door is open", () => {
  let rig: Rig | ActsRig;
  afterEach(async () => {
    await rig?.cleanup();
  });
  const doorFile = (): Promise<LocalDoorFile | null> => readDoorFile(rig.paths.localDoor);

  test("an HX Fortress with no module that takes acts has no door and no file", async () => {
    // The probe of the other tests: a module with asks and no acts.
    rig = await makeRig();
    expect(rig.host.door.isOpen).toBe(false);
    await expect(stat(rig.paths.localDoor)).rejects.toMatchObject({ code: "ENOENT" });
    await rig.host.applyRequests();
    expect(rig.host.door.isOpen).toBe(false);
  });

  test("it opens once a module that takes acts is on and started, and an act crosses it", async () => {
    rig = await makeActsRig();
    expect(rig.host.door.isOpen).toBe(true);
    expect(await sendAct(rig.paths.localDoor, { ...REQUEST, act: "thing.add", args: { name: "orders-1", host: "db.northstar.example", port: 1433 } })).toEqual({
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
    expect(await sendAct(rig.paths.localDoor, REQUEST)).toEqual({ ok: false, error: DAEMON_UNREACHABLE });

    await writeConfig(rig.paths, ["session_vault", "probe"]);
    await rig.host.applyRequests();
    const second = await doorFile();
    expect(second?.secret).not.toBe(first?.secret);
    expect(await sendAct(rig.paths.localDoor, REQUEST)).toMatchObject({ ok: true });
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

  test("the daemon's stop, and a module being switched off, do not wait for an act that is still running", async () => {
    rig = await makeActsRig();
    const acts = (rig as ActsRig).acts;
    const running = async (): Promise<void> => {
      const before = acts.acted.length;
      while (acts.acted.length === before) await Bun.sleep(2);
    };
    // Switched off while an act runs: the door closes at once, and whoever
    // waits for the act is told that it was interrupted.
    let pending = sendAct(rig.paths.localDoor, { ...REQUEST, act: "never" });
    await running();
    await writeConfig(rig.paths, ["session_vault"]);
    let started = Date.now();
    await rig.host.applyRequests();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(rig.host.door.isOpen).toBe(false);
    expect(await pending).toEqual({ ok: false, error: ACT_INTERRUPTED });

    // The daemon stops while an act runs.
    await writeConfig(rig.paths, ["session_vault", "probe"]);
    await rig.host.applyRequests();
    pending = sendAct(rig.paths.localDoor, { ...REQUEST, act: "never" });
    await running();
    started = Date.now();
    await rig.host.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await pending).toEqual({ ok: false, error: ACT_INTERRUPTED });
    expect(await doorFile()).toBeNull();
  });

  test("a file that a run which did not stop cleanly left is removed at the next start", async () => {
    rig = await makeRig({ start: false });
    await mkdir(path.dirname(rig.paths.localDoor), { recursive: true });
    await writeFile(rig.paths.localDoor, JSON.stringify({ v: 1, port: 5, secret: "C".repeat(43), pid: 1, openedAt: "2027-03-14T09:00:00.000Z" }));
    await rig.host.start();
    await expect(stat(rig.paths.localDoor)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a switch that cannot be read leaves the door as it is, and every act is refused meanwhile", async () => {
    rig = await makeActsRig();
    await writeFile(rig.paths.config, "{ not json");
    await rig.host.applyRequests();
    expect(rig.host.door.isOpen).toBe(true);
    expect(await sendAct(rig.paths.localDoor, REQUEST)).toEqual({ ok: false, error: "module_off" });
  });

  test("a call the door turns away is counted in the audit trail, with nothing of what it sent", async () => {
    rig = await makeActsRig();
    const file = (await doorFile()) as LocalDoorFile;
    for (let i = 0; i < 4; i += 1) {
      await raw(file.port, `POST ${DOOR_ACT_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${file.port}\r\nAuthorization: Bearer guess-${i}-of-a-secret`, "{}");
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
