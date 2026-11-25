// What the running daemon's environment names, written down for a terminal and
// the console. The file counts only while the daemon that wrote it runs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  keepDaemonEnvironment,
  publishDaemonEnvironment,
  readDaemonEnvironment,
  recordDaemonEnvironmentAtStart,
  type DaemonEnvironment,
  type DaemonEnvironmentPaths,
} from "../src/host/daemon-environment";
import { fortressPaths } from "../src/host/paths";

const DAEMON = 4242;

/** A public key's text. Made when the test runs: this file holds no key. */
const PUBLIC_KEY = Buffer.from("not a key of anything").toString("base64url");

const NAMED: Required<DaemonEnvironment> = {
  updateUrl: { value: "https://mirror.northstar.example/hx-fortress" },
  controlPlaneKey: { value: [{ id: "cp-2026-11", publicKey: PUBLIC_KEY }] },
  pgvectorUrl: { value: "https://files.northstar.example/pgvector" },
  pgBinariesUrl: null,
};
/** An environment that names nothing. */
const NOTHING: Required<DaemonEnvironment> = {
  updateUrl: null,
  controlPlaneKey: null,
  pgvectorUrl: null,
  pgBinariesUrl: null,
};

let root = "";
let paths: DaemonEnvironmentPaths;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-daemon-environment-"));
  paths = fortressPaths(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write the file as some other program might have, at the daemon's path. */
async function fileHolds(value: unknown): Promise<void> {
  await mkdir(path.dirname(paths.daemonEnvironment), { recursive: true });
  await writeFile(paths.daemonEnvironment, typeof value === "string" ? value : JSON.stringify(value));
}

const WELL_FORMED = {
  schemaVersion: 1,
  pid: DAEMON,
  writtenAt: "2026-11-17T09:00:00.000Z",
  updateUrl: null,
  controlPlaneKey: null,
};

describe("the file the daemon writes when it starts", () => {
  test("lives in the folder's runtime directory", () => {
    expect(fortressPaths(root).daemonEnvironment).toBe(path.join(root, "runtime", "daemon-environment.json"));
  });

  test("holds what the environment names, the writer's pid and when it was written", async () => {
    const now = new Date("2026-11-17T09:30:00.000Z");
    expect(await publishDaemonEnvironment(paths, NAMED, { pid: DAEMON, now })).toBe(true);
    expect(JSON.parse(await readFile(paths.daemonEnvironment, "utf8"))).toEqual({
      schemaVersion: 1,
      pid: DAEMON,
      writtenAt: "2026-11-17T09:30:00.000Z",
      updateUrl: { value: "https://mirror.northstar.example/hx-fortress" },
      controlPlaneKey: { value: [{ id: "cp-2026-11", publicKey: PUBLIC_KEY }] },
      pgvectorUrl: { value: "https://files.northstar.example/pgvector" },
      pgBinariesUrl: null,
    });
  });

  test("a setting that is left out is written, and read, as one the environment does not name", async () => {
    await publishDaemonEnvironment(paths, { updateUrl: null, controlPlaneKey: null }, { pid: DAEMON });
    const written = JSON.parse(await readFile(paths.daemonEnvironment, "utf8")) as Record<string, unknown>;
    expect([written.pgvectorUrl, written.pgBinariesUrl]).toEqual([null, null]);
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...NOTHING });
    // A file that holds only the first two settings is read in the same way.
    await fileHolds(WELL_FORMED);
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...NOTHING });
  });

  test("is read back as it was written, while its writer runs", async () => {
    await publishDaemonEnvironment(paths, NAMED, { pid: DAEMON });
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...NAMED });

    // Nothing named, and values that could not be understood, come back as they were.
    const unclear: Required<DaemonEnvironment> = {
      updateUrl: null,
      controlPlaneKey: { invalid: "FORTRESS_CONTROL_PLANE_KEY is not a list of keys" },
      pgvectorUrl: null,
      pgBinariesUrl: { invalid: "FORTRESS_PG_BINARIES_URL must use https:" },
    };
    await publishDaemonEnvironment(paths, unclear, { pid: DAEMON });
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...unclear });
  });

  test("is written with this process's pid when none is given", async () => {
    await publishDaemonEnvironment(paths, NAMED);
    expect((await readDaemonEnvironment(paths, process.pid))?.running).toBe(true);
  });

  test("only its owner can read it, also when an earlier file was open to others", async () => {
    await fileHolds(WELL_FORMED);
    await chmod(paths.daemonEnvironment, 0o644);
    await publishDaemonEnvironment(paths, NAMED, { pid: DAEMON });
    expect((await stat(paths.daemonEnvironment)).mode & 0o777).toBe(0o600);
  });

  test("replaces the file an earlier daemon wrote", async () => {
    await publishDaemonEnvironment(paths, NAMED, { pid: DAEMON });
    await publishDaemonEnvironment(paths, { updateUrl: null, controlPlaneKey: null }, { pid: DAEMON + 1 });
    expect(await readDaemonEnvironment(paths, DAEMON + 1)).toEqual({ running: true, ...NOTHING });
    expect((await readDaemonEnvironment(paths, DAEMON))?.running).toBe(false);
  });
});

describe("whether the daemon that wrote it runs", () => {
  test("running is true only for the pid of the writer", async () => {
    await publishDaemonEnvironment(paths, NAMED, { pid: DAEMON });
    expect((await readDaemonEnvironment(paths, DAEMON))?.running).toBe(true);
    // Another daemon runs now.
    expect((await readDaemonEnvironment(paths, DAEMON + 1))?.running).toBe(false);
    // No daemon runs. The file still says what the stopped one ran with.
    expect(await readDaemonEnvironment(paths, null)).toEqual({ running: false, ...NAMED });
  });
});

describe("a file that is not one this build wrote", () => {
  test("no file is no daemon", async () => {
    expect(await readDaemonEnvironment(paths, DAEMON)).toBeNull();
  });

  test.each([
    ["text that is not JSON", "{ not json"],
    ["an empty file", ""],
    ["JSON that is no object", JSON.stringify([WELL_FORMED])],
    ["null", "null"],
    ["another schemaVersion", JSON.stringify({ ...WELL_FORMED, schemaVersion: 2 })],
    ["a schemaVersion written as text", JSON.stringify({ ...WELL_FORMED, schemaVersion: "1" })],
    ["no schemaVersion", JSON.stringify({ ...WELL_FORMED, schemaVersion: undefined })],
    ["a pid written as text", JSON.stringify({ ...WELL_FORMED, pid: String(DAEMON) })],
    ["no pid", JSON.stringify({ ...WELL_FORMED, pid: undefined })],
    ["a pid that is null", JSON.stringify({ ...WELL_FORMED, pid: null })],
    ["an address written as plain text", JSON.stringify({ ...WELL_FORMED, updateUrl: "https://mirror.northstar.example/hx" })],
    ["an object that holds neither a value nor a reason", JSON.stringify({ ...WELL_FORMED, updateUrl: { address: "https://x.example" } })],
    ["a reason that is no text", JSON.stringify({ ...WELL_FORMED, updateUrl: { invalid: 5 } })],
    ["a key list in place of a setting", JSON.stringify({ ...WELL_FORMED, controlPlaneKey: [{ id: "a", publicKey: "b" }] })],
    ["no updateUrl", JSON.stringify({ ...WELL_FORMED, updateUrl: undefined })],
    ["no controlPlaneKey", JSON.stringify({ ...WELL_FORMED, controlPlaneKey: undefined })],
    ["a pgvector address written as plain text", JSON.stringify({ ...WELL_FORMED, pgvectorUrl: "https://files.example/x" })],
    ["a Postgres address that holds neither a value nor a reason", JSON.stringify({ ...WELL_FORMED, pgBinariesUrl: {} })],
  ])("%s is read as no file", async (_name, text) => {
    await fileHolds(text);
    expect(await readDaemonEnvironment(paths, DAEMON)).toBeNull();
  });

  test("a well-formed file is read, so the cases above fail for the reason they name", async () => {
    await fileHolds(WELL_FORMED);
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...NOTHING });
  });
});

describe("a write that fails", () => {
  test("is said: a folder where the file should be makes the write fail, and false is answered", async () => {
    await mkdir(paths.daemonEnvironment, { recursive: true });
    expect(await publishDaemonEnvironment(paths, NAMED, { pid: DAEMON })).toBe(false);
    expect(await readDaemonEnvironment(paths, DAEMON)).toBeNull();
  });

  test("removes the file an earlier daemon wrote, so a reused pid cannot read as this daemon's", async () => {
    // The writer puts its text in a file beside the target first, with a
    // longer name. With a target name of 250 characters that name is longer
    // than a file system allows, so the write fails, while the earlier file
    // at the target itself can still be removed.
    const target = { daemonEnvironment: path.join(root, "runtime", `${"d".repeat(245)}.json`) };
    await mkdir(path.dirname(target.daemonEnvironment), { recursive: true });
    await writeFile(target.daemonEnvironment, JSON.stringify(WELL_FORMED));
    expect(await readDaemonEnvironment(target, DAEMON)).not.toBeNull();

    // The new daemon has the pid the earlier one had.
    expect(await publishDaemonEnvironment(target, NAMED, { pid: DAEMON })).toBe(false);
    expect(await stat(target.daemonEnvironment).then(() => "still there", () => "removed")).toBe("removed");
    expect(await readDaemonEnvironment(target, DAEMON)).toBeNull();
  });
});

describe("a daemon's first step when it starts", () => {
  test("writes the file when no other daemon runs on the folder", async () => {
    expect(await recordDaemonEnvironmentAtStart(paths, NAMED, { anotherDaemon: null, pid: DAEMON })).toBe("written");
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...NAMED });
  });

  test("leaves the file of a daemon that runs on the folder as it is", async () => {
    // The service's daemon runs with an address in its environment. A second
    // `hx-fortress host`, typed in a terminal that names nothing, starts on
    // the same folder. It must not replace what the running daemon wrote:
    // a terminal would then take the project's releases for a host whose
    // service turned away from them.
    await publishDaemonEnvironment(paths, NAMED, { pid: DAEMON });
    const before = await readFile(paths.daemonEnvironment, "utf8");
    expect(await recordDaemonEnvironmentAtStart(paths, NOTHING, { anotherDaemon: DAEMON, pid: DAEMON + 1 })).toBe("left");
    expect(await readFile(paths.daemonEnvironment, "utf8")).toBe(before);
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...NAMED });
  });

  test("the daemon that the status file names is no other daemon to itself", async () => {
    // In a container a process id is used again: the status file of the start
    // before can name this very process.
    await publishDaemonEnvironment(paths, NAMED, { pid: DAEMON });
    expect(await recordDaemonEnvironmentAtStart(paths, NOTHING, { anotherDaemon: DAEMON, pid: DAEMON })).toBe("written");
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...NOTHING });
  });

  test("says when the file could not be written", async () => {
    await mkdir(paths.daemonEnvironment, { recursive: true });
    expect(await recordDaemonEnvironmentAtStart(paths, NAMED, { anotherDaemon: null, pid: DAEMON })).toBe("failed");
  });
});

describe("keeping the file with the status file", () => {
  test("writes the file when there is none", async () => {
    expect(await keepDaemonEnvironment(paths, NAMED, { pid: DAEMON })).toBe(true);
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...NAMED });
  });

  test("leaves its own file untouched, so a heartbeat every few seconds writes nothing", async () => {
    await publishDaemonEnvironment(paths, NAMED, { pid: DAEMON, now: new Date("2026-11-17T09:30:00.000Z") });
    const before = await readFile(paths.daemonEnvironment, "utf8");
    expect(await keepDaemonEnvironment(paths, NAMED, { pid: DAEMON, now: new Date("2026-11-17T09:30:05.000Z") })).toBe(true);
    expect(await readFile(paths.daemonEnvironment, "utf8")).toBe(before);
  });

  test("puts its own file back when another process replaced it", async () => {
    // A second start on the folder got as far as writing the status file, and
    // its record with it. The daemon that still runs writes its status a few
    // seconds later, and the record is its own again.
    await publishDaemonEnvironment(paths, NAMED, { pid: DAEMON });
    await publishDaemonEnvironment(paths, NOTHING, { pid: DAEMON + 1 });
    expect((await readDaemonEnvironment(paths, DAEMON))?.running).toBe(false);
    expect(await keepDaemonEnvironment(paths, NAMED, { pid: DAEMON })).toBe(true);
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...NAMED });
  });

  test("writes again when the file has this daemon's pid and other values", async () => {
    // A process id that is used again: the file of an earlier daemon.
    await publishDaemonEnvironment(paths, NOTHING, { pid: DAEMON });
    expect(await keepDaemonEnvironment(paths, NAMED, { pid: DAEMON })).toBe(true);
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...NAMED });
  });

  test("replaces a file that is not one this build wrote", async () => {
    await fileHolds("{ not json");
    expect(await keepDaemonEnvironment(paths, NAMED, { pid: DAEMON })).toBe(true);
    expect(await readDaemonEnvironment(paths, DAEMON)).toEqual({ running: true, ...NAMED });
  });

  test("answers false, and does not throw, when the file cannot be written", async () => {
    await mkdir(paths.daemonEnvironment, { recursive: true });
    expect(await keepDaemonEnvironment(paths, NAMED, { pid: DAEMON })).toBe(false);
  });
});
