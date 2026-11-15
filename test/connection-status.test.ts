// What a person is shown about the connection: in the status file, in the
// terminal and on the console's page of data paths.
//
// The state is what the RUNNING daemon published about its own connection.
// Each reader below has to show that state and no other: not a state from a
// daemon that stopped writing, and not a guess where the daemon did not say.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { statusFortress } from "../src/cli-lifecycle";
import { utcDay } from "../src/cloud/counts";
import { fortressPaths } from "../src/host/paths";
import type { HostStatusSnapshot } from "../src/host/types";
import type { ServiceManager } from "../src/service/types";
import { FileStatusReader } from "../src/status-reader";
import { createConsoleMount } from "../src/ui/console-mount";
import { UiRuntime } from "../src/ui/runtime";

function snapshot(connection: Record<string, unknown> = {}, writtenAt = new Date().toISOString()): HostStatusSnapshot {
  return {
    schemaVersion: 1,
    sessions: "off",
    host: {
      state: "running",
      pid: 1234,
      startedAt: "2027-03-14T09:00:00.000Z",
      updatedAt: "2027-03-14T09:00:01.000Z",
      error: null,
      writtenAt,
    },
    connection: { state: "connected", reason: null, message: null, ...connection },
    postgres: { phase: "ready", reason: null },
    modules: [{ id: "host", state: "running", error: null }],
  } as HostStatusSnapshot;
}

let root = "";
let home = "";
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-connection-status-root-"));
  home = await mkdtemp(path.join(os.tmpdir(), "hx-connection-status-home-"));
  previousHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function writeStatus(value: unknown): Promise<void> {
  const file = fortressPaths(root).status;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

describe("the status file", () => {
  const read = (): Promise<HostStatusSnapshot | null> => new FileStatusReader(fortressPaths(root).status).read();

  test("holds the state inside the connection, in one of three words", async () => {
    for (const state of ["on", "off", "not_set"] as const) {
      await writeStatus(snapshot({ sessionContent: state }));
      expect((await read())?.connection).toEqual({ state: "connected", reason: null, message: null, sessionContent: state });
    }
  });

  test("a file from a build before the setting does not say, and reads as it did", async () => {
    await writeStatus(snapshot());
    expect((await read())?.connection).toEqual({ state: "connected", reason: null, message: null });
  });

  test("any other value is read as not said, never as a state", async () => {
    for (const value of ["OFF", "", "none", null, false, 0, ["off"], { state: "off" }]) {
      await writeStatus(snapshot({ sessionContent: value }));
      expect((await read())?.connection).toEqual({ state: "connected", reason: null, message: null });
    }
  });
});

describe("the terminal's status", () => {
  const manager = { name: "launchd", state: async () => ({ loaded: true, pid: 1234 }) } as unknown as ServiceManager;
  const lines = async (connection: Record<string, unknown>): Promise<string[]> => {
    const written: string[] = [];
    await statusFortress({
      manager,
      statusReader: { read: async () => snapshot(connection) },
      writeLine: (line) => void written.push(line),
    });
    return written;
  };

  test("says that the running daemon carries no session content, where it was told so", async () => {
    expect(await lines({ sessionContent: "off" })).toEqual([
      "Fortress:   running (launchd, pid 1234)",
      "Connection: connected",
      "Carries:    no session content",
      "Modules:",
      "  host  running",
    ]);
  });

  test("says that it carries session content, where that was switched on", async () => {
    expect(await lines({ sessionContent: "on" })).toContain("Carries:    session content");
  });

  test("prints what it always printed where nobody chose, and for a daemon from before the setting", async () => {
    const before = ["Fortress:   running (launchd, pid 1234)", "Connection: connected", "Modules:", "  host  running"];
    expect(await lines({ sessionContent: "not_set" })).toEqual(before);
    expect(await lines({})).toEqual(before);
  });
});

describe("the console's page of data paths", () => {
  const paths = (): ReturnType<typeof fortressPaths> => fortressPaths(root);

  /** The notes of the connection's row, as the mounted console computes them. */
  async function connectionNotes(): Promise<string> {
    const mounted = createConsoleMount({
      paths: paths(),
      runtime: new UiRuntime({
        uiRoot: path.join(root, "ui"),
        uiConfigFile: path.join(root, "ui", "ui.json"),
        cmdCredsDir: path.join(root, "runtime", "cmd-creds"),
        env: {},
      }),
      boundPort: 8788,
      serviceManager: "container",
      env: {},
    });
    await mounted.ready;
    const { rows } = await mounted.port.dataPaths();
    const row = rows.find((candidate) => candidate.id === "connection");
    if (!row) throw new Error("the page has no row for the connection");
    return [row.carries, ...(row.notes ?? [])].join("\n");
  }

  async function writeCounts(text: string): Promise<void> {
    await mkdir(path.dirname(paths().connectionCounts), { recursive: true });
    await writeFile(paths().connectionCounts, text);
  }

  const countsOf = (day: string): string =>
    JSON.stringify({
      version: 1,
      days: {
        [day]: {
          in: { moduleMessage: 3 },
          out: { moduleReply: 3 },
          refused: { rpc: 2 },
          dropped: { too_large: 0, unreadable: 0, unknown: 0 },
        },
      },
    });

  test("shows the state of a daemon that is running now", async () => {
    await writeStatus(snapshot({ sessionContent: "off" }));
    const notes = await connectionNotes();
    expect(notes).toContain("4 of 9 kinds of message:");
    expect(notes).toContain("Session content is off on this connection.");
  });

  test("claims no state for a daemon that stopped writing its status", async () => {
    // The same file, written a day ago: the daemon that said "off" is not known to be running.
    await writeStatus(snapshot({ sessionContent: "off" }, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()));
    const notes = await connectionNotes();
    expect(notes).toContain("The running daemon has not said whether session content may travel on this connection.");
    expect(notes).not.toContain("Session content is off");
  });

  test("claims no state with no status file, and for a daemon from before the setting", async () => {
    expect(await connectionNotes()).toContain("The running daemon has not said");
    await writeStatus(snapshot());
    expect(await connectionNotes()).toContain("The running daemon has not said");
  });

  test("says that nothing was counted when there is no file of counts", async () => {
    await writeStatus(snapshot({ sessionContent: "off" }));
    expect(await connectionNotes()).toContain("Nothing was counted on this connection today.");
  });

  test("says that nothing was counted today when the file holds only an earlier day", async () => {
    await writeStatus(snapshot({ sessionContent: "off" }));
    await writeCounts(countsOf("2020-01-01"));
    const notes = await connectionNotes();
    expect(notes).toContain("Nothing was counted on this connection today.");
    expect(notes).not.toContain("moduleMessage in 3");
  });

  test("shows today's counts from the daemon's own file", async () => {
    await writeStatus(snapshot({ sessionContent: "off" }));
    const today = utcDay(new Date());
    await writeCounts(countsOf(today));
    const notes = await connectionNotes();
    expect(notes).toContain(`Counted today, ${today} (a day in UTC), on this host, by the name of each message:`);
    expect(notes).toContain("Asks and their answers - moduleMessage in 3; moduleReply out 3");
    expect(notes).toContain("Calls that read or write a session - rpc in 0, refused 2");
  });

  test("shows the counts even when the daemon is not running: they are what crossed", async () => {
    const today = utcDay(new Date());
    await writeCounts(countsOf(today));
    const notes = await connectionNotes();
    expect(notes).toContain("The running daemon has not said");
    expect(notes).toContain("Asks and their answers - moduleMessage in 3; moduleReply out 3");
  });

  test("says that the counts could not be read, and shows none, for a file that is not a counts file", async () => {
    await writeStatus(snapshot({ sessionContent: "off" }));
    await writeCounts('{"version":1,"days":{"today":{}}}');
    const notes = await connectionNotes();
    expect(notes).toContain("The counts of this connection's messages are on this host and could not be read.");
    expect(notes).not.toContain("Counted today");
  });
});
