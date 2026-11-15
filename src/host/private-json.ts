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

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PrivateJsonOptions {
  /** Indent the JSON. For the files an operator is expected to open and read. */
  pretty?: boolean;
}

export async function writePrivateJson(
  file: string,
  value: unknown,
  options: PrivateJsonOptions = {},
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
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
 */
export async function readSmallFile(file: string, maxBytes: number): Promise<SmallFileRead> {
  let bytes: Buffer;
  try {
    // The caller's own file: a path this HX Fortress builds, never one a
    // request supplied.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) return { state: "unreadable" };
      bytes = await handle.readFile();
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unreadable" };
  }
  // The file can have grown between the two calls above.
  return bytes.byteLength > maxBytes ? { state: "unreadable" } : { state: "read", bytes };
}
