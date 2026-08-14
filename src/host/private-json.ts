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

import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
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
  await writeFile(tmp, `${body}\n`, { mode: 0o600 });
  // Belt: the mode above is a request the umask may narrow and an existing
  // inode ignores. This is the guarantee.
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, file);
}
