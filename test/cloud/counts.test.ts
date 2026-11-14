// What crossed the connection, counted and kept.

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ConnectionCounts,
  connectionView,
  COUNT_DAYS_KEPT,
  parseCounts,
  readConnectionCounts,
  utcDay,
  type CountsFile,
} from "../../src/cloud/counts";

let dirs: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-counts-"));
  dirs.push(dir);
  return path.join(dir, "connection", "counts.json");
}

afterEach(async () => {
  for (const dir of dirs) {
    // A test below takes the write bit off a folder.
    await chmod(path.join(dir, "connection"), 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function setup(file: string, at = "2027-03-14T09:00:00.000Z") {
  const now = { value: new Date(at) };
  const errors: { message: string; fields?: Record<string, unknown> }[] = [];
  const counts = new ConnectionCounts({
    file,
    now: () => new Date(now.value.getTime()),
    logger: { error: (message, fields) => void errors.push({ message, ...(fields ? { fields } : {}) }) },
    // No timer in a test: each write is asked for.
    flushMs: 0,
  });
  return { counts, now, errors };
}

const onDisk = async (file: string): Promise<CountsFile> => JSON.parse(await readFile(file, "utf8")) as CountsFile;

describe("counting", () => {
  test("a frame is counted by its name and its direction, for the UTC day it crossed on", async () => {
    const { counts, now } = setup(await tempFile());
    counts.sent("hello");
    counts.received("welcome");
    counts.received("moduleMessage");
    counts.received("moduleMessage");
    counts.sent("moduleReply");
    counts.refused("rpc");
    counts.dropped("too_large");
    counts.dropped("unknown");
    counts.dropped("unknown");
    expect(counts.of()).toEqual({
      in: { welcome: 1, moduleMessage: 2 },
      out: { hello: 1, moduleReply: 1 },
      refused: { rpc: 1 },
      dropped: { too_large: 1, unreadable: 0, unknown: 2 },
    });
    // One second before midnight, then one second after: two days.
    now.value = new Date("2027-03-14T23:59:59.000Z");
    counts.received("heartbeatAck");
    now.value = new Date("2027-03-15T00:00:01.000Z");
    counts.received("heartbeatAck");
    expect(counts.of("2027-03-14").in.heartbeatAck).toBe(1);
    expect(counts.of("2027-03-15")).toEqual({
      in: { heartbeatAck: 1 },
      out: {},
      refused: {},
      dropped: { too_large: 0, unreadable: 0, unknown: 0 },
    });
    expect(counts.of("2027-03-13").in).toEqual({});
  });

  test("what a reader is handed is a copy", async () => {
    const { counts } = setup(await tempFile());
    counts.received("welcome");
    const day = counts.of();
    day.in.welcome = 99;
    day.dropped.unknown = 99;
    expect(counts.of().in.welcome).toBe(1);
    expect(counts.of().dropped.unknown).toBe(0);
  });
});

describe("the file", () => {
  test("is written when asked, readable by its owner only, in a folder of its own", async () => {
    const file = await tempFile();
    const { counts } = setup(file);
    await counts.start();
    counts.sent("hello");
    counts.received("welcome");
    await counts.flush();
    expect(await onDisk(file)).toEqual({
      version: 1,
      days: {
        "2027-03-14": {
          in: { welcome: 1 },
          out: { hello: 1 },
          refused: {},
          dropped: { too_large: 0, unreadable: 0, unknown: 0 },
        },
      },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    // Nothing is left beside it.
    expect(await readdir(path.dirname(file))).toEqual(["counts.json"]);
  });

  test("is not written again while nothing changed", async () => {
    const file = await tempFile();
    const { counts } = setup(file);
    counts.sent("hello");
    await counts.flush();
    const first = (await stat(file)).mtimeMs;
    await Bun.sleep(20);
    await counts.flush();
    expect((await stat(file)).mtimeMs).toBe(first);
  });

  test("a later run adds to what an earlier run counted", async () => {
    const file = await tempFile();
    const first = setup(file);
    first.counts.received("moduleMessage");
    first.counts.refused("rpc");
    first.counts.dropped("unreadable");
    await first.counts.stop();

    const second = setup(file);
    // Counted before the file was read: a frame can arrive first.
    second.counts.received("moduleMessage");
    await second.counts.start();
    second.counts.received("moduleMessage");
    second.counts.dropped("unreadable");
    expect(second.counts.of()).toEqual({
      in: { moduleMessage: 3 },
      out: {},
      refused: { rpc: 1 },
      dropped: { too_large: 0, unreadable: 2, unknown: 0 },
    });
    await second.counts.stop();
    expect((await onDisk(file)).days["2027-03-14"]?.in.moduleMessage).toBe(3);
  });

  test(`keeps ${COUNT_DAYS_KEPT} days by the calendar, however few of them have counts`, async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    const day = (counts: number) => ({
      in: { welcome: counts },
      out: {},
      refused: {},
      dropped: { too_large: 0, unreadable: 0, unknown: 0 },
    });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        // 2027-03-14 is the day of the run. Ninety days end with it, so they
        // start on 2026-12-15.
        days: { "2026-06-01": day(1), "2026-12-14": day(2), "2026-12-15": day(3), "2027-03-13": day(4) },
      }),
    );
    const { counts } = setup(file);
    await counts.start();
    counts.received("welcome");
    await counts.stop();
    expect(Object.keys((await onDisk(file)).days).sort()).toEqual(["2026-12-15", "2027-03-13", "2027-03-14"]);
  });

  test("a file that cannot be used is kept aside, said once, and the counts start from zero", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"version":1,"days":{"2027-03-14":{"in":{"welcome":"many"}}}}');
    const { counts, errors } = setup(file);
    await counts.start();
    counts.received("welcome");
    await counts.stop();
    expect(errors).toEqual([
      {
        message:
          "the counts of the connection's messages could not be read, so this run starts them again from zero",
        fields: { keptAs: "counts.json.unreadable" },
      },
    ]);
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 1 });
    expect(await readFile(`${file}.unreadable`, "utf8")).toContain('"many"');
  });

  test("a folder that cannot be written loses no count: it is said once and written when it can be", async () => {
    const file = await tempFile();
    const { counts, errors } = setup(file);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(file), 0o500);
    counts.received("welcome");
    await counts.flush();
    counts.received("welcome");
    await counts.flush();
    expect(errors.map((error) => error.message)).toEqual([
      "the counts of the connection's messages could not be written",
    ]);
    await chmod(path.dirname(file), 0o700);
    await counts.flush();
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 2 });
  });

  test("two writes asked for at once do not run into each other", async () => {
    const file = await tempFile();
    const { counts } = setup(file);
    counts.received("welcome");
    const first = counts.flush();
    counts.received("welcome");
    const second = counts.flush();
    await Promise.all([first, second]);
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 2 });
    expect(await readdir(path.dirname(file))).toEqual(["counts.json"]);
  });
});

describe("reading the file", () => {
  test("a fortress that has counted nothing has no file, and that is not an error", async () => {
    expect(await readConnectionCounts(await tempFile())).toEqual({ state: "absent" });
  });

  test("a whole file or nothing", async () => {
    const good = {
      version: 1,
      days: {
        "2027-03-14": { in: { welcome: 1 }, out: {}, refused: {}, dropped: { too_large: 0, unreadable: 0, unknown: 0 } },
      },
    };
    expect(parseCounts(JSON.stringify(good))).toEqual(good as CountsFile);
    const broken: unknown[] = [
      "not json",
      [],
      { ...good, version: 2 },
      { version: 1 },
      { version: 1, days: [] },
      { version: 1, days: { "14 March": good.days["2027-03-14"] } },
      { version: 1, days: { "2027-03-14": { ...good.days["2027-03-14"], in: { welcome: -1 } } } },
      { version: 1, days: { "2027-03-14": { ...good.days["2027-03-14"], in: { welcome: 1.5 } } } },
      { version: 1, days: { "2027-03-14": { ...good.days["2027-03-14"], in: { welcome: "1" } } } },
      { version: 1, days: { "2027-03-14": { ...good.days["2027-03-14"], out: { "not a frame": 1 } } } },
      { version: 1, days: { "2027-03-14": { ...good.days["2027-03-14"], refused: null } } },
      { version: 1, days: { "2027-03-14": { ...good.days["2027-03-14"], dropped: { too_large: 0 } } } },
      { version: 1, days: { "2027-03-14": { in: {}, out: {}, refused: {} } } },
    ];
    for (const value of broken) {
      expect([value, parseCounts(typeof value === "string" ? value : JSON.stringify(value))]).toEqual([value, null]);
    }
  });

  test("a file that is there and cannot be used is said to be unreadable", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{");
    expect(await readConnectionCounts(file)).toEqual({ state: "unreadable" });
    // A folder where the file should be.
    await rm(file);
    await mkdir(file);
    expect(await readConnectionCounts(file)).toEqual({ state: "unreadable" });
  });
});

describe("the view a reader is shown", () => {
  test("lists each frame that crossed or was refused, in the order of the kinds, and leaves the rest out", () => {
    const view = connectionView("off", "2027-03-14", {
      in: { rosterSync: 0, moduleMessage: 2, welcome: 1, heartbeatAck: 40 },
      out: { moduleReply: 2, hello: 1, heartbeat: 40, rpcError: 3 },
      refused: { rpc: 3, rosterSync: 1 },
      dropped: { too_large: 1, unreadable: 2, unknown: 3 },
    });
    expect(view).toEqual({
      sessionContent: "off",
      since: "2027-03-14T00:00:00.000Z",
      messages: [
        { kind: "greeting", frame: "welcome", direction: "in", count: 1, refused: 0 },
        { kind: "greeting", frame: "hello", direction: "out", count: 1, refused: 0 },
        { kind: "heartbeat", frame: "heartbeatAck", direction: "in", count: 40, refused: 0 },
        { kind: "heartbeat", frame: "heartbeat", direction: "out", count: 40, refused: 0 },
        { kind: "ask", frame: "moduleMessage", direction: "in", count: 2, refused: 0 },
        { kind: "ask", frame: "moduleReply", direction: "out", count: 2, refused: 0 },
        { kind: "members", frame: "rosterSync", direction: "in", count: 0, refused: 1 },
        { kind: "session_call", frame: "rpc", direction: "in", count: 0, refused: 3 },
        { kind: "session_call", frame: "rpcError", direction: "out", count: 3, refused: 0 },
      ],
      dropped: { tooLarge: 1, unreadable: 2, unknown: 3 },
    });
  });

  test("a day with no counts is an empty list and three zeros", () => {
    expect(connectionView("not_set", utcDay(new Date("2027-03-14T09:00:00.000Z")), null)).toEqual({
      sessionContent: "not_set",
      since: "2027-03-14T00:00:00.000Z",
      messages: [],
      dropped: { tooLarge: 0, unreadable: 0, unknown: 0 },
    });
  });
});
