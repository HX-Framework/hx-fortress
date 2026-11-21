// The one writer of this HX Fortress's owner-only files, and the reader of its
// small ones.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readOpened,
  readSmallFile,
  removeLeftIn,
  temporaryFor,
  writePrivateJson,
  writesUnderWay,
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

describe("a folder of their own for the temporary files", () => {
  /** The file modes below stop nobody who runs as root. */
  const asRoot = process.getuid?.() === 0;
  const CHILD = path.join(import.meta.dir, "_private-json-child.ts");

  /** A temporary file as a write of `file` leaves it in `within` when its
   *  process stops before the rename. */
  async function left(within: string, file: string, pid = 4242): Promise<string> {
    await mkdir(within, { recursive: true });
    const temporary = temporaryFor(path.join(within, path.basename(file)), pid);
    await writeFile(temporary, '{"value":"a page of table names"}\n', { mode: 0o600 });
    return path.basename(temporary);
  }

  test("a write makes its temporary file there and not beside the file, and leaves the folder empty", async () => {
    const file = path.join(dir, "state", "pages-3.json");
    const within = path.join(dir, "state", ".writing");
    let seen: { beside: string[]; inside: string[] } | null = null;
    await writePrivateJson(
      file,
      { n: 1 },
      {
        temporaryIn: within,
        beforeRename: async () => {
          seen = { beside: await readdir(path.dirname(file)), inside: await readdir(within) };
        },
      },
    );
    // While the write was under way: one file, in the folder for them, named
    // for the file it is written for.
    expect(seen!.beside).toEqual([".writing"]);
    expect(seen!.inside).toHaveLength(1);
    expect(seen!.inside[0]).toMatch(/^pages-3\.json\.\d+\.[0-9a-f]{8}\.tmp$/);
    // And after it.
    expect((await readdir(path.dirname(file))).sort()).toEqual([".writing", "pages-3.json"]);
    expect(await readdir(within)).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ n: 1 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(within)).mode & 0o777).toBe(0o700);
  });

  test("a write of this process that is under way is not taken for one that was left", async () => {
    const file = path.join(dir, "state", "pages-3.json");
    const within = path.join(dir, "state", ".writing");
    let go: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const atRename = new Promise<void>((resolve) => (reached = resolve));
    const writing = writePrivateJson(
      file,
      { n: 1 },
      {
        temporaryIn: within,
        beforeRename: () => {
          reached();
          return new Promise<void>((resolve) => (go = resolve));
        },
      },
    );
    await atRename;
    expect(writesUnderWay()).toBe(1);
    // Beside one that an earlier run left for the same file: only that one goes.
    const earlier = await left(within, file, process.pid);
    expect(await readdir(within)).toHaveLength(2);
    expect(await removeLeftIn(within)).toBe(1);
    expect(await removeLeftIn(within, "pages-3.json")).toBe(0);
    const still = await readdir(within);
    expect(still).toHaveLength(1);
    expect(still).not.toContain(earlier);
    go();
    await writing;
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ n: 1 });
    expect(await readdir(within)).toEqual([]);
    expect(writesUnderWay()).toBe(0);
  });

  test("what a writer that was killed left is removed, and the file it was writing is as it was", async () => {
    const file = path.join(dir, "state", "pages-3.json");
    const within = path.join(dir, "state", ".writing");
    await writePrivateJson(file, { value: "the value before" }, { temporaryIn: within });
    // A real writer in a process of its own, killed between its write and its rename.
    const child = Bun.spawn([process.execPath, CHILD, file, within], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("written");
    child.kill("SIGKILL");
    await child.exited;
    const inside = await readdir(within);
    expect(inside).toHaveLength(1);
    expect(await readFile(path.join(within, inside[0] as string), "utf8")).toContain("a page of a database's table names");
    expect(await removeLeftIn(within, "pages-3.json")).toBe(1);
    expect(await readdir(within)).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ value: "the value before" });
  });

  test("asked for one file, it removes the temporary files of that file and of no other", async () => {
    const within = path.join(dir, ".writing");
    await left(within, "pages-3.json");
    await left(within, "pages-3.json", 7);
    const other = await left(within, "pages-30.json");
    const another = await left(within, "pages-3.jsonx");
    expect(await removeLeftIn(within, "pages-3.json")).toBe(2);
    expect((await readdir(within)).sort()).toEqual([other, another].sort());
    // Asked for none in particular, every one.
    expect(await removeLeftIn(within)).toBe(2);
    expect(await readdir(within)).toEqual([]);
  });

  test("a link is removed and not what it leads to, and a folder is left alone", async () => {
    const within = path.join(dir, ".writing");
    await mkdir(within);
    const kept = path.join(dir, "kept.json");
    await writeFile(kept, "kept");
    await symlink(kept, path.join(within, "pages-3.json.4242.0123abcd.tmp"));
    await symlink(path.join(dir, "nowhere"), path.join(within, "pages-3.json.4242.0123abce.tmp"));
    await mkdir(path.join(within, "pages-3.json.4242.0123abcf.tmp"));
    await writeFile(path.join(within, "pages-3.json.4242.0123abcf.tmp", "inside"), "x");
    expect(await removeLeftIn(within, "pages-3.json")).toBe(2);
    expect(await readdir(within)).toEqual(["pages-3.json.4242.0123abcf.tmp"]);
    expect(await readFile(kept, "utf8")).toBe("kept");
  });

  test("a folder that is not there holds none, and one that cannot be listed is an error", async () => {
    expect(await removeLeftIn(path.join(dir, "never-made"))).toBe(0);
    // A file where the folder should be.
    await writeFile(path.join(dir, "a-file"), "x");
    expect(await removeLeftIn(path.join(dir, "a-file"))).toBe(0);
    if (asRoot) return;
    const within = path.join(dir, ".writing");
    const one = await left(within, "pages-3.json");
    await chmod(within, 0o300);
    try {
      await expect(removeLeftIn(within)).rejects.toThrow();
      await expect(removeLeftIn(within, "pages-3.json")).rejects.toThrow();
    } finally {
      await chmod(within, 0o700);
    }
    expect(await readdir(within)).toEqual([one]);
    // A file that cannot be removed is an error too: the folder may be listed and not written.
    await chmod(within, 0o500);
    try {
      await expect(removeLeftIn(within)).rejects.toThrow();
    } finally {
      await chmod(within, 0o700);
    }
    expect(await removeLeftIn(within)).toBe(1);
  });

  test("a write that fails removes its own temporary file there too", async () => {
    // A folder where the file should be: the rename onto it fails every time.
    const file = path.join(dir, "state", "pages-3.json");
    const within = path.join(dir, "state", ".writing");
    await mkdir(file, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(writePrivateJson(file, { attempt }, { temporaryIn: within })).rejects.toThrow();
    }
    expect(await readdir(within)).toEqual([]);
    // A write that failed is no longer under way either.
    expect(writesUnderWay()).toBe(0);
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
