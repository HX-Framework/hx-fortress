// The one writer of this HX Fortress's owner-only files, and the reader of its
// small ones.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readOpened, readSmallFile, writePrivateJson, type OpenedFile } from "../../src/host/private-json";

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
