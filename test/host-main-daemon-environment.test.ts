// The daemon writes down what its environment names, and keeps that record
// with its status file.
//
// The record and its reader have their own tests (daemon-environment.test.ts).
// This one composes the daemon, as it composes itself at a start, and looks at
// what that start left on disk: a step that is left out here, or moved below
// a check that can end the start, is left out of every HX Fortress.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { publishDaemonEnvironment, readDaemonEnvironment } from "../src/host/daemon-environment";
import { runFortressHost } from "../src/host/main";
import { fortressPaths } from "../src/host/paths";
import type { CloudConnection } from "../src/host/types";
import { publishStatus } from "./host/_module-rig";

const VARIABLES = [
  "FORTRESS_OPENAI_API_KEY",
  "FORTRESS_SESSIONS",
  "FORTRESS_UPDATE_URL",
  "FORTRESS_CONTROL_PLANE_KEY",
  "FORTRESS_PGVECTOR_URL",
  "FORTRESS_PG_BINARIES_URL",
] as const;

const MIRROR = "https://mirror.northstar.example/hx-fortress";
const PGVECTOR = "https://files.northstar.example/pgvector";
/** A public key's text, made when the test runs: this file holds no key. */
const PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64url");

const NOTHING = { updateUrl: null, controlPlaneKey: null, pgvectorUrl: null, pgBinariesUrl: null };

const offline = (): CloudConnection => ({
  state: () => "offline",
  status: () => ({ state: "offline", reason: null, message: null }),
  open: async () => {},
  close: async () => {},
  notifyIngest: () => {},
});

describe("what a daemon's start writes down about its environment", () => {
  let root = "";
  const before: Record<string, string | undefined> = {};

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hx-host-main-environment-"));
    for (const name of VARIABLES) before[name] = process.env[name];
    for (const name of VARIABLES) delete process.env[name];
    // The daemon refuses to start with Agentic Sessions on and no embedding
    // key. Built here, so that no key-shaped text sits in this file.
    process.env.FORTRESS_OPENAI_API_KEY = ["sk", "test", "embedding", "key"].join("-");
  });

  afterEach(async () => {
    for (const name of VARIABLES) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    await rm(root, { recursive: true, force: true });
  });

  /** Compose the daemon as `hx-fortress host` does, and run `during` with it. */
  async function composed(during: (runtime: { start(): Promise<void>; stop(): Promise<void> }) => Promise<void> = async () => {}) {
    await runFortressHost({ root, version: "0.0.0-test", createConnection: offline, run: during });
  }
  const logged = async (): Promise<string> => readFile(fortressPaths(root).log, "utf8").catch(() => "");

  test("the record holds what the environment names, with this daemon's process id", async () => {
    process.env.FORTRESS_UPDATE_URL = `${MIRROR}/`;
    process.env.FORTRESS_CONTROL_PLANE_KEY = `cp-2026-11:${PUBLIC_KEY}`;
    process.env.FORTRESS_PGVECTOR_URL = PGVECTOR;
    await composed();
    expect(await readDaemonEnvironment(fortressPaths(root), process.pid)).toEqual({
      running: true,
      updateUrl: { value: MIRROR },
      controlPlaneKey: { value: [{ id: "cp-2026-11", publicKey: PUBLIC_KEY }] },
      pgvectorUrl: { value: PGVECTOR },
      pgBinariesUrl: null,
    });
  });

  test("an environment that names nothing is written down as that", async () => {
    await composed();
    expect(await readDaemonEnvironment(fortressPaths(root), process.pid)).toEqual({ running: true, ...NOTHING });
  });

  test("the record is written before a check that ends the start", async () => {
    // A value of FORTRESS_SESSIONS that is neither word ends the start at one
    // of its first checks. The record is there all the same: a terminal can
    // then tell that this host's service names an address for new versions.
    process.env.FORTRESS_SESSIONS = "maybe";
    process.env.FORTRESS_UPDATE_URL = MIRROR;
    let ran = false;
    const failure = await composed(async () => {
      ran = true;
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).not.toBeNull();
    expect(ran).toBe(false);
    expect(await readDaemonEnvironment(fortressPaths(root), process.pid)).toEqual({
      running: true,
      ...NOTHING,
      updateUrl: { value: MIRROR },
    });
  });

  test("a value that cannot be understood is written down with the reason, and said in the daemon's log", async () => {
    process.env.FORTRESS_UPDATE_URL = "http://mirror.northstar.example/hx-fortress";
    process.env.FORTRESS_CONTROL_PLANE_KEY = "no-colon";
    await composed();
    const record = await readDaemonEnvironment(fortressPaths(root), process.pid);
    expect(record?.updateUrl).toEqual({
      invalid: "FORTRESS_UPDATE_URL must use https: (cleartext http: is only allowed to a loopback host)",
    });
    expect(record?.controlPlaneKey).toEqual({
      invalid: "FORTRESS_CONTROL_PLANE_KEY must be written as <id>:<publicKey>",
    });
    const log = await logged();
    expect(log).toContain("the address for new versions in this daemon's environment cannot be understood");
    expect(log).toContain("the key of the control plane in this daemon's environment cannot be understood");
  });

  test("a start on a folder where another daemon runs leaves that daemon's record as it is, and says so", async () => {
    // The service's daemon runs: a fresh status file names a process that is
    // alive. This start is a second `hx-fortress host` on the same folder,
    // from a terminal whose environment names nothing.
    const paths = fortressPaths(root);
    const service = process.ppid;
    await publishStatus(paths, [], { pid: service });
    await publishDaemonEnvironment(paths, { updateUrl: { value: MIRROR }, controlPlaneKey: null }, { pid: service });
    const record = await readFile(paths.daemonEnvironment, "utf8");

    await composed();
    expect(await readFile(paths.daemonEnvironment, "utf8")).toBe(record);
    expect(await readDaemonEnvironment(paths, service)).toEqual({
      running: true,
      ...NOTHING,
      updateUrl: { value: MIRROR },
    });
    expect(await logged()).toContain("another HX Fortress daemon runs on this folder");
  });

  test("a status file left by a daemon that is gone does not hold the record back", async () => {
    // The daemon before this one was ended hard: its status file is still
    // fresh, and its process is not there.
    const paths = fortressPaths(root);
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    await publishStatus(paths, [], { pid: gone.pid });
    await publishDaemonEnvironment(paths, { updateUrl: { value: MIRROR }, controlPlaneKey: null }, { pid: gone.pid });

    await composed();
    expect(await readDaemonEnvironment(paths, process.pid)).toEqual({ running: true, ...NOTHING });
  });

  test("with a write of its status file the daemon makes the record its own again", async () => {
    // Which daemon runs is read from the status file, so the record has to be
    // that daemon's. Here something replaces the record after the start wrote
    // it. The next write of the status file puts it right. (On this folder
    // nobody set HX Fortress up, so the start writes its status and then ends
    // at its own read of config.json, before it starts anything.)
    process.env.FORTRESS_UPDATE_URL = MIRROR;
    const paths = fortressPaths(root);
    let between: unknown = null;
    let startFailed = false;
    await composed(async (runtime) => {
      await publishDaemonEnvironment(paths, NOTHING, { pid: process.ppid });
      between = await readDaemonEnvironment(paths, process.pid);
      await runtime.start().catch(() => {
        startFailed = true;
      });
      await runtime.stop().catch(() => {});
    });
    expect(between).toEqual({ running: false, ...NOTHING });
    expect(startFailed).toBe(true);
    expect(await readDaemonEnvironment(paths, process.pid)).toEqual({
      running: true,
      ...NOTHING,
      updateUrl: { value: MIRROR },
    });
  });
});
