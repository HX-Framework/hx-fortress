// The one atomic writer for the 0600 files this fortress keeps on disk.
//
// Every one of them was written the same way in six places, and three of those
// copies had lost the same belt: `writeFile(..., { mode })` applies the mode
// only when it CREATES the file, and it is masked by the process umask — so a
// temporary path left behind by a crashed writer is re-opened at whatever mode
// it already had, and the rename publishes that mode onto a file the threat
// model calls owner-only. The chmod is what makes 0600 a fact rather than a
// request, and the unique temporary name is what keeps two writers (or one
// writer and one crash) from sharing a path in the first place.
//
// The directory is created 0700 for the same reason the file is 0600: an
// owner-only file inside a world-readable directory still tells everyone it is
// there, and how big it is.
//
// A write that fails removes its temporary file. Each write has a temporary
// name of its own, so a caller that writes on a timer into a folder where the
// rename keeps failing would otherwise leave one more file there each time.
//
// A process that stops between the write and the rename cannot remove it. The
// temporary file then stays, with what the write held, and nothing reads it.
// Where that must not be, the caller has its temporary files written into a
// folder of their own (`temporaryIn`), and `removeLeftIn` empties that folder
// of what no write of this process is using. A folder that holds nothing but
// temporary files can be listed whatever the folder beside it holds, and what
// is in it needs no name or date to be known for what it is.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PrivateJsonOptions {
  /** Indent the JSON. For the files an operator is expected to open and read. */
  pretty?: boolean;
  /**
   * The folder the temporary file is written in. Left out, the file's own
   * folder. It is made for its owner only. It must be on the file's own file
   * system, or the rename fails: a folder inside the file's folder is.
   */
  temporaryIn?: string;
  /** A seam for tests: waited for between the write and the rename. */
  beforeRename?: () => Promise<void>;
}

/** The temporary name of one write: the file's own name, the id of the process
 *  that writes, eight hex digits, and `.tmp`. So the temporary files of one
 *  file all start with that file's name and a dot. */
export function temporaryFor(file: string, pid: number = process.pid): string {
  return `${file}.${pid}.${randomBytes(4).toString("hex")}.tmp`;
}

/**
 * The temporary files this process is writing now, by their full path.
 *
 * What tells a write that is under way from one that was left behind. Not the
 * process id in the name: a daemon that starts again in a container often has
 * the id its earlier run had. Not the file's time: a clock can be set, and a
 * slow disk makes a live write look old.
 */
const underWay = new Set<string>();

/** How many writes of this process are under way. Each write leaves the count
 *  as it found it, however it ends. */
export function writesUnderWay(): number {
  return underWay.size;
}

export async function writePrivateJson(
  file: string,
  value: unknown,
  options: PrivateJsonOptions = {},
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const within = options.temporaryIn;
  const tmp = path.resolve(temporaryFor(within === undefined ? file : path.join(within, path.basename(file))));
  const body = options.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  // Before anything is waited for, so that no look at the folder can take
  // this write's file for one that was left.
  underWay.add(tmp);
  try {
    if (within !== undefined) await mkdir(within, { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${body}\n`, { mode: 0o600 });
    // Belt: the mode above is a request the umask may narrow and an existing
    // inode ignores. This is the guarantee.
    await chmod(tmp, 0o600).catch(() => {});
    await options.beforeRename?.();
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  } finally {
    underWay.delete(tmp);
  }
}

/**
 * Remove what writes left in a folder for temporary files, and answer how
 * many files that was.
 *
 * `temporaryDir` is a folder that holds nothing but temporary files: the
 * `temporaryIn` of the writes. Every file in it that no write of this process
 * is using was left by a write that will never end: its process stopped, or
 * its own removal failed. `forFile` limits this to the temporary files of one
 * file, by that file's name (`cursor.json`).
 *
 * A folder that is not there holds none. REJECTS when the folder is there and
 * cannot be listed, or when a file in it cannot be removed: the caller then
 * knows that it could not make sure. A folder inside it is no temporary file
 * and is left alone.
 *
 * One limit. A write of ANOTHER process that is under way looks the same as
 * one that was left, and is removed: that write then fails at its rename.
 * One daemon writes into a folder of HX Fortress, so this is the case of two
 * daemons on one folder.
 */
export async function removeLeftIn(temporaryDir: string, forFile?: string): Promise<number> {
  let names: string[];
  try {
    // The caller's own folder: a path this HX Fortress builds.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    names = await readdir(temporaryDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (forFile !== undefined && !name.startsWith(`${forFile}.`)) continue;
    const temporary = path.resolve(temporaryDir, name);
    if (underWay.has(temporary)) continue;
    try {
      // What is at the name itself: a link is removed, and not what it leads to.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if ((await lstat(temporary)).isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await rm(temporary, { force: true });
    removed += 1;
  }
  return removed;
}

/** What `readSmallFile` found at a path. */
export type SmallFileRead =
  | { state: "absent" }
  /** Something is there that is not a file of at most the limit, or it could
   *  not be read. */
  | { state: "unreadable" }
  | { state: "read"; bytes: Buffer };

/**
 * Read one of this HX Fortress's small files whole, whatever is at its path.
 *
 * The open itself never waits: opening something that is not a file can
 * otherwise wait for ever, as a named pipe waits for a writer. What was opened
 * is looked at through its own handle, and only a regular file of at most
 * `maxBytes` is read. So a named pipe, a device or a huge file at the path is
 * answered `unreadable` at once, and never read.
 *
 * No more is read than the size that was looked at, and one byte: a file that
 * grows after the look is `unreadable`, and is not read to its new end.
 */
export async function readSmallFile(file: string, maxBytes: number): Promise<SmallFileRead> {
  try {
    // The caller's own file: a path this HX Fortress builds, never one a
    // request supplied.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      return await readOpened(handle, maxBytes);
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unreadable" };
  }
}

/** What `readOpened` asks of a file that is open. */
export interface OpenedFile {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

/**
 * Read a file that is open, if it is a regular file of at most `maxBytes`.
 * At most its size as it was looked at is read, and one byte.
 */
export async function readOpened(handle: OpenedFile, maxBytes: number): Promise<SmallFileRead> {
  const info = await handle.stat();
  if (!info.isFile() || info.size > maxBytes) return { state: "unreadable" };
  const buffer = Buffer.alloc(info.size + 1);
  let length = 0;
  while (length < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  // The one byte more was filled: the file grew after its size was looked at.
  if (length > info.size) return { state: "unreadable" };
  return { state: "read", bytes: buffer.subarray(0, length) };
}
