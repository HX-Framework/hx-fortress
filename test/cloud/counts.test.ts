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
    // Tests below take the write bit off a folder and the read bit off a file.
    await chmod(path.join(dir, "connection"), 0o700).catch(() => {});
    await chmod(path.join(dir, "connection", "counts.json"), 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
  dirs = [];
});

/** The file modes below stop nobody who runs as root. */
const asRoot = process.getuid?.() === 0;

function setup(file: string, at = "2027-03-14T09:00:00.000Z", flushMs = 0) {
  const now = { value: new Date(at) };
  const errors: { message: string; fields?: Record<string, unknown> }[] = [];
  const counts = new ConnectionCounts({
    file,
    now: () => new Date(now.value.getTime()),
    logger: { error: (message, fields) => void errors.push({ message, ...(fields ? { fields } : {}) }) },
    // No timer in a test, unless it asks for one: each write is asked for.
    flushMs,
  });
  return { counts, now, errors };
}

const day = (welcome: number) => ({
  in: { welcome },
  out: {},
  refused: {},
  dropped: { too_large: 0, unreadable: 0, unknown: 0 },
});
const fileOf = (welcome: number): string => JSON.stringify({ version: 1, days: { "2027-03-14": day(welcome) } });
const KEPT_ASIDE = /^counts\.json\.unreadable-\d{8}T\d{9}Z-[0-9a-f]{8}$/;

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

  test("a file that is not a counts file is kept aside, said once, and the counts start from zero", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"version":1,"days":{"2027-03-14":{"in":{"welcome":"many"}}}}');
    const { counts, errors } = setup(file);
    await counts.start();
    counts.received("welcome");
    await counts.stop();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(
      "the counts of the connection's messages are not a counts file of this build, so this run starts them again from zero",
    );
    const keptAs = String(errors[0]?.fields?.keptAs);
    expect(keptAs).toMatch(KEPT_ASIDE);
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 1 });
    expect(await readFile(path.join(path.dirname(file), keptAs), "utf8")).toContain('"many"');
  });

  test("a second file that is not a counts file does not replace the copy kept of the first", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "first");
    const first = setup(file);
    await first.counts.start();
    await first.counts.stop();
    await writeFile(file, "second");
    // The same moment by the clock, so the time in the name cannot tell them apart.
    const second = setup(file);
    await second.counts.start();
    await second.counts.stop();
    const kept = (await readdir(path.dirname(file))).filter((name) => KEPT_ASIDE.test(name));
    expect(kept).toHaveLength(2);
    const texts = await Promise.all(kept.map((name) => readFile(path.join(path.dirname(file), name), "utf8")));
    expect(texts.sort()).toEqual(["first", "second"]);
  });

  test.skipIf(asRoot)("a file that cannot be read at all is not moved and not written over", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, fileOf(7));
    // The folder can be written, so nothing but this code keeps the file.
    await chmod(file, 0o000);
    const { counts, errors } = setup(file);
    await counts.start();
    counts.received("welcome");
    await counts.flush();
    counts.received("welcome");
    await counts.stop();
    expect(await readdir(path.dirname(file))).toEqual(["counts.json"]);
    expect(errors).toEqual([
      {
        message:
          "the counts of the connection's messages could not be read, so they are not written either: this run's counts are kept in memory until the file can be read",
        fields: { cause: "io" },
      },
    ]);
    await chmod(file, 0o600);
    expect(await readFile(file, "utf8")).toBe(fileOf(7));
    // Readable again: the next write takes up the seven and adds this run's two.
    await counts.flush();
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 9 });
  });

  test("a folder where the file should be is left alone, and the counts go on in memory", async () => {
    const file = await tempFile();
    await mkdir(file, { recursive: true });
    const { counts, errors } = setup(file);
    await counts.start();
    counts.received("welcome");
    await counts.stop();
    expect(await readdir(path.dirname(file))).toEqual(["counts.json"]);
    expect(errors.map((error) => error.fields)).toEqual([{ cause: "io" }]);
    expect(counts.of().in).toEqual({ welcome: 1 });
  });

  test.skipIf(asRoot)("a file that cannot be moved aside is not written over either", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "not a counts file");
    await chmod(path.dirname(file), 0o500);
    const { counts, errors } = setup(file);
    await counts.start();
    counts.received("welcome");
    await counts.flush();
    expect(await readFile(file, "utf8")).toBe("not a counts file");
    expect(errors.map((error) => error.fields)).toEqual([{ cause: "content" }]);
    // Once the folder can be written, the file is kept aside and the counts are written.
    await chmod(path.dirname(file), 0o700);
    await counts.flush();
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 1 });
    const kept = (await readdir(path.dirname(file))).filter((name) => KEPT_ASIDE.test(name));
    expect(kept).toHaveLength(1);
    expect(await readFile(path.join(path.dirname(file), kept[0] as string), "utf8")).toBe("not a counts file");
  });

  test.skipIf(asRoot)("a folder that cannot be written loses no count: it is said once and written when it can be", async () => {
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
    // Nothing is left behind by the writes that failed.
    expect(await readdir(path.dirname(file))).toEqual([]);
    await chmod(path.dirname(file), 0o700);
    await counts.flush();
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 2 });
  });

  test("two writes asked for at once do not run into each other", async () => {
    const file = await tempFile();
    const { counts, errors } = setup(file);
    counts.received("welcome");
    const first = counts.flush();
    counts.received("welcome");
    const second = counts.flush();
    await Promise.all([first, second]);
    expect(errors).toEqual([]);
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 2 });
    expect(await readdir(path.dirname(file))).toEqual(["counts.json"]);
  });

  test("two starts asked for at once take up the file's counts once", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, fileOf(7));
    const { counts } = setup(file);
    counts.received("welcome");
    await Promise.all([counts.start(), counts.start(), counts.flush()]);
    // Seven from the file and one from this run: not fifteen.
    expect(counts.of().in).toEqual({ welcome: 8 });
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 8 });
    // And a third start, later, adds nothing.
    await counts.start();
    await counts.flush();
    expect(counts.of().in).toEqual({ welcome: 8 });
    await counts.stop();
  });

  test("many writes asked for at once are one write, and none is lost", async () => {
    const file = await tempFile();
    const { counts, errors } = setup(file);
    await counts.start();
    const asked: Promise<void>[] = [];
    for (let index = 0; index < 50; index += 1) {
      counts.received("welcome");
      asked.push(counts.flush());
    }
    // Asked for before any of them began: they are the same write.
    expect(new Set(asked).size).toBe(1);
    await Promise.all(asked);
    expect(errors).toEqual([]);
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 50 });
    // A count that is made after that write is in the next one.
    counts.received("welcome");
    await counts.flush();
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 51 });
  });

  test("is written by its timer while a count changes", async () => {
    const file = await tempFile();
    const { counts } = setup(file, "2027-03-14T09:00:00.000Z", 15);
    await counts.start();
    counts.received("welcome");
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && (await readConnectionCounts(file)).state !== "ok") await Bun.sleep(10);
    expect((await onDisk(file)).days["2027-03-14"]?.in).toEqual({ welcome: 1 });
    await counts.stop();
  });
});

describe("the frames this HX Fortress sends on a timer", () => {
  const heartbeats = async (file: string): Promise<number | undefined> =>
    (await onDisk(file)).days["2027-03-14"]?.out.heartbeat;

  test("are counted like any other, and alone they are written every five minutes", async () => {
    const file = await tempFile();
    const { counts, now } = setup(file);
    await counts.start();
    counts.sent("heartbeat");
    counts.received("heartbeatAck");
    await counts.flush();
    // The first write is due at once: nothing was written before it.
    expect(await heartbeats(file)).toBe(1);

    now.value = new Date("2027-03-14T09:04:59.000Z");
    counts.sent("heartbeat");
    counts.sent("collectionStats");
    await counts.flush();
    expect(counts.of().out.heartbeat).toBe(2);
    expect(await heartbeats(file)).toBe(1);

    now.value = new Date("2027-03-14T09:05:00.000Z");
    await counts.flush();
    expect(await heartbeats(file)).toBe(2);
    expect((await onDisk(file)).days["2027-03-14"]?.out.collectionStats).toBe(1);
  });

  test("are written with the next frame of any other kind", async () => {
    const file = await tempFile();
    const { counts, now } = setup(file);
    await counts.start();
    counts.sent("heartbeat");
    await counts.flush();
    now.value = new Date("2027-03-14T09:00:30.000Z");
    counts.sent("heartbeat");
    await counts.flush();
    expect(await heartbeats(file)).toBe(1);
    counts.received("moduleMessage");
    await counts.flush();
    expect(await heartbeats(file)).toBe(2);
  });

  test("are written when HX Fortress stops", async () => {
    const file = await tempFile();
    const { counts, now } = setup(file);
    await counts.start();
    counts.sent("heartbeat");
    await counts.flush();
    now.value = new Date("2027-03-14T09:00:30.000Z");
    counts.sent("heartbeat");
    await counts.stop();
    expect(await heartbeats(file)).toBe(2);
  });

  test("a refused frame is written at once, whatever its name", async () => {
    const file = await tempFile();
    const { counts, now } = setup(file);
    await counts.start();
    counts.sent("heartbeat");
    await counts.flush();
    now.value = new Date("2027-03-14T09:00:30.000Z");
    counts.refused("collectionStats");
    await counts.flush();
    expect((await onDisk(file)).days["2027-03-14"]?.refused).toEqual({ collectionStats: 1 });
  });
});

describe("reading the file", () => {
  test("an HX Fortress that has counted nothing has no file, and that is not an error", async () => {
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

  test("a file that is there and cannot be used is said to be unreadable, with which of two reasons", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    // Read, and not a counts file.
    await writeFile(file, "{");
    expect(await readConnectionCounts(file)).toEqual({ state: "unreadable", cause: "content" });
    // Not read at all: a folder where the file should be.
    await rm(file);
    await mkdir(file);
    expect(await readConnectionCounts(file)).toEqual({ state: "unreadable", cause: "io" });
  });

  test("a named pipe where the file should be is not opened: nothing waits for a writer", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    const made = Bun.spawnSync(["mkfifo", file]);
    expect(made.exitCode).toBe(0);
    // Opening a pipe to read waits until something writes to it. Nothing does.
    const read = await Promise.race([
      readConnectionCounts(file),
      Bun.sleep(2_000).then(() => "still waiting" as const),
    ]);
    expect(read).toEqual({ state: "unreadable", cause: "io" });
    // A start does not wait either, and the pipe is left where it is.
    const { counts, errors } = setup(file);
    const started = await Promise.race([
      counts.start().then(() => "started" as const),
      Bun.sleep(2_000).then(() => "still waiting" as const),
    ]);
    expect(started).toBe("started");
    counts.received("welcome");
    await counts.stop();
    expect(errors.map((error) => error.fields)).toEqual([{ cause: "io" }]);
    expect(await readdir(path.dirname(file))).toEqual(["counts.json"]);
  });

  test("a file larger than a counts file can be is not read into memory", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    // Valid JSON, and one byte over the megabyte a counts file stays under.
    const text = fileOf(1);
    await writeFile(file, text + " ".repeat(1024 * 1024 + 1 - text.length));
    expect(await readConnectionCounts(file)).toEqual({ state: "unreadable", cause: "content" });
    await writeFile(file, text + " ".repeat(1024 * 1024 - text.length));
    expect((await readConnectionCounts(file)).state).toBe("ok");
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
