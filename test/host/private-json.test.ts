// The one writer of this HX Fortress's owner-only files, and the reader of its
// small ones.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readOpened,
  readSmallFile,
  removeLeftTemporaries,
  TEMPORARY_LEFT_AFTER_MS,
  temporaryFor,
  writePrivateJson,
  type OpenedFile,
} from "../../src/host/private-json";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hx-private-json-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writePrivateJson", () => {
  test("writes the file for its owner only, in a folder for its owner only, and leaves nothing beside it", async () => {
    const file = path.join(dir, "kept", "state.json");
    await writePrivateJson(file, { n: 1 });
    await writePrivateJson(file, { n: 2 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ n: 2 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readdir(path.dirname(file))).toEqual(["state.json"]);
  });

  test("a write that fails leaves no temporary file, however often it is tried", async () => {
    // A folder where the file should be: the rename onto it fails every time.
    const file = path.join(dir, "kept", "state.json");
    await mkdir(file, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(writePrivateJson(file, { attempt })).rejects.toThrow();
    }
    expect(await readdir(path.dirname(file))).toEqual(["state.json"]);
  });
});

describe("what a write that never ended left behind", () => {
  // A process that is not this one: its id is never this one's.
  const ANOTHER = process.pid + 1;
  /** A temporary file as a write leaves it when its process stops before the rename. */
  async function left(file: string, pid: number, ageMs = 0): Promise<string> {
    const temporary = temporaryFor(file, pid);
    await writeFile(temporary, '{"value":"a page of table names"}\n', { mode: 0o600 });
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs);
      await utimes(temporary, then, then);
    }
    return path.basename(temporary);
  }

  test("is removed when another process wrote it, and the files themselves stay", async () => {
    const file = path.join(dir, "pages-3.json");
    await writePrivateJson(file, { value: "kept" });
    await left(file, ANOTHER);
    await left(file, 1);
    await left(path.join(dir, "summary.json"), ANOTHER);
    expect(await removeLeftTemporaries(dir)).toBe(3);
    expect(await readdir(dir)).toEqual(["pages-3.json"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ value: "kept" });
    // Nothing is left to remove.
    expect(await removeLeftTemporaries(dir)).toBe(0);
  });

  test("a write of this process that is under way is not touched, and one that is a minute old was left", async () => {
    const file = path.join(dir, "cursor.json");
    const underWay = await left(file, process.pid);
    const almost = await left(file, process.pid, TEMPORARY_LEFT_AFTER_MS - 5_000);
    await left(file, process.pid, TEMPORARY_LEFT_AFTER_MS + 5_000);
    expect(await removeLeftTemporaries(dir)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual([almost, underWay].sort());
    // The same two, a minute later.
    expect(await removeLeftTemporaries(dir, undefined, Date.now() + TEMPORARY_LEFT_AFTER_MS + 1)).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });

  test("can be asked for the temporary files of one file only", async () => {
    const mine = await left(path.join(dir, "pages-3.json"), ANOTHER);
    const other = await left(path.join(dir, "pages-30.json"), ANOTHER);
    const asked: string[] = [];
    expect(
      await removeLeftTemporaries(dir, (fileName) => {
        asked.push(fileName);
        return fileName === "pages-3.json";
      }),
    ).toBe(1);
    expect(asked.sort()).toEqual(["pages-3.json", "pages-30.json"]);
    expect(await readdir(dir)).toEqual([other]);
    expect(mine).not.toBe(other);
  });

  test("a file that is no temporary file of this writer is left alone, whatever it is called", async () => {
    const names = [
      "pages-3.json",
      "pages-3.json.bak",
      "pages-3.json.tmp",
      "notes.tmp",
      // No process id, a process id that is no number, and too few or too many hex digits.
      "pages-3.json.0123abcd.tmp",
      "pages-3.json.self.0123abcd.tmp",
      "pages-3.json.4242.0123abc.tmp",
      "pages-3.json.4242.0123abcde.tmp",
      "pages-3.json.4242.0123ABCD.tmp",
      "pages-3.json.4242.0123abcd.tmp.keep",
    ];
    for (const name of names) await writeFile(path.join(dir, name), "x");
    // A folder with the name of a temporary file is not a file to remove.
    await mkdir(path.join(dir, "folder.json.4242.0123abcd.tmp"));
    await writeFile(path.join(dir, "folder.json.4242.0123abcd.tmp", "inside"), "x");
    expect(await removeLeftTemporaries(dir)).toBe(0);
    expect((await readdir(dir)).sort()).toEqual([...names, "folder.json.4242.0123abcd.tmp"].sort());
  });

  test("a folder that is not there holds none", async () => {
    expect(await removeLeftTemporaries(path.join(dir, "never-made"))).toBe(0);
    // A file where the folder should be.
    await writeFile(path.join(dir, "a-file"), "x");
    expect(await removeLeftTemporaries(path.join(dir, "a-file"))).toBe(0);
  });
});

describe("readSmallFile", () => {
  test("a file of at most the limit is read whole, and one that is not there is `absent`", async () => {
    const file = path.join(dir, "small.json");
    expect(await readSmallFile(file, 16)).toEqual({ state: "absent" });
    await writeFile(file, "0123456789abcdef");
    const read = await readSmallFile(file, 16);
    expect(read.state === "read" ? read.bytes.toString("utf8") : read.state).toBe("0123456789abcdef");
    await writeFile(file, "");
    const empty = await readSmallFile(file, 16);
    expect(empty.state === "read" ? empty.bytes.byteLength : empty.state).toBe(0);
  });

  test("a file one byte over the limit is `unreadable`", async () => {
    const file = path.join(dir, "large.json");
    await writeFile(file, "0123456789abcdefg");
    expect(await readSmallFile(file, 16)).toEqual({ state: "unreadable" });
  });

  test("what is not a regular file is `unreadable` at once, and is never read", async () => {
    const started = Date.now();
    // A named pipe: opening one to read waits for a writer, for ever.
    const pipe = path.join(dir, "pipe");
    expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
    expect(await readSmallFile(pipe, 16)).toEqual({ state: "unreadable" });
    // A folder.
    expect(await readSmallFile(dir, 16)).toEqual({ state: "unreadable" });
    // A device, reached through a link at the file's path. Read, it gives no
    // bytes and no error, which would pass for an empty file.
    const link = path.join(dir, "link");
    await symlink("/dev/null", link);
    expect(await readSmallFile(link, 16)).toEqual({ state: "unreadable" });
    // A link to nothing.
    const dangling = path.join(dir, "dangling");
    await symlink(path.join(dir, "no-such-file"), dangling);
    expect(await readSmallFile(dangling, 16)).toEqual({ state: "absent" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a file that grows after its size was looked at is not read to its new end", async () => {
    // A file that said 4 bytes when it was looked at, and gives bytes for as
    // long as anybody reads: what a file that is being written to does.
    const asked: number[] = [];
    const growing = (size: number): OpenedFile => ({
      stat: async () => ({ isFile: () => true, size }),
      read: async (buffer, offset, length) => {
        asked.push(length);
        buffer.fill(0x78, offset, offset + length);
        return { bytesRead: length };
      },
    });
    expect(await readOpened(growing(4), 16)).toEqual({ state: "unreadable" });
    // Its four bytes and one more were asked for, and nothing past them.
    expect(asked.reduce((sum, length) => sum + length, 0)).toBe(5);
    // A file that gives its bytes a few at a time, and then ends, is read whole.
    let given = 0;
    const slow: OpenedFile = {
      stat: async () => ({ isFile: () => true, size: 6 }),
      read: async (buffer, offset, length) => {
        const bytes = Math.min(2, length, 6 - given);
        buffer.write("abcdef".slice(given, given + bytes), offset, "latin1");
        given += bytes;
        return { bytesRead: bytes };
      },
    };
    const read = await readOpened(slow, 16);
    expect(read.state === "read" ? read.bytes.toString("latin1") : read.state).toBe("abcdef");
    // And one that became shorter is read as far as it goes.
    const shorter: OpenedFile = {
      stat: async () => ({ isFile: () => true, size: 6 }),
      read: async () => ({ bytesRead: 0 }),
    };
    expect(await readOpened(shorter, 16)).toMatchObject({ state: "read" });
  });
});
