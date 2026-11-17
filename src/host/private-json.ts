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
// `removeLeftTemporaries` is for the owner of a folder whose files hold what
// must not outlive them.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PrivateJsonOptions {
  /** Indent the JSON. For the files an operator is expected to open and read. */
  pretty?: boolean;
}

/** The temporary name of one write: the file's own name, the id of the process
 *  that writes, eight hex digits, and `.tmp`. `removeLeftTemporaries` knows a
 *  left file by this form, so the two are kept side by side. */
export function temporaryFor(file: string, pid: number = process.pid): string {
  return `${file}.${pid}.${randomBytes(4).toString("hex")}.tmp`;
}
const TEMPORARY_NAME = /^(.+)\.(\d{1,10})\.[0-9a-f]{8}\.tmp$/;

/** A temporary file of this process that is older than this was left by a
 *  write that never ended. A write takes milliseconds. */
export const TEMPORARY_LEFT_AFTER_MS = 60_000;

export async function writePrivateJson(
  file: string,
  value: unknown,
  options: PrivateJsonOptions = {},
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = temporaryFor(file);
  const body = options.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  try {
    await writeFile(tmp, `${body}\n`, { mode: 0o600 });
    // Belt: the mode above is a request the umask may narrow and an existing
    // inode ignores. This is the guarantee.
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Remove the temporary files that writes into `dir` left behind, and answer
 * how many.
 *
 * A temporary file was left when another process wrote it, which is a run of
 * this program that has ended, or when this process wrote it more than a
 * minute ago. A write that is under way is neither, and is not touched.
 *
 * `of` says for which files: it is asked with the name of the file a
 * temporary file was written for (`cursor.json`). Left out, for every file.
 *
 * Never rejects. A folder that is not there holds none, and a file that
 * cannot be looked at or removed is left for the next call.
 */
export async function removeLeftTemporaries(
  dir: string,
  of?: (fileName: string) => boolean,
  now: number = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    // The caller's own folder: a path this HX Fortress builds.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = TEMPORARY_NAME.exec(name);
    if (!match || (of && !of(match[1] as string))) continue;
    const temporary = path.join(dir, name);
    try {
      if (Number(match[2]) === process.pid) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const written = (await stat(temporary)).mtimeMs;
        if (now - written <= TEMPORARY_LEFT_AFTER_MS) continue;
      }
      await rm(temporary, { force: true });
      removed += 1;
    } catch {
      // Gone in the meantime, or not ours to remove.
    }
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
