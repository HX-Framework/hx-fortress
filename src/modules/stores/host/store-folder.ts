// A Store's folder on this host's disk.
//
//   <folder>/
//     store.sqlite      the Store: one SQLite file
//     store.sqlite-journal
//                       SQLite's journal. It holds what a change replaces, while
//                       the change is being written, and is empty between
//                       changes. SQLite reads it when it opens the Store, and
//                       undoes a change that was not finished.
//     alarm.json        when the Store next wants to be woken, if it does
//     files/            the Store's files
//     snapshots/        the Store as it was, for a restore
//     scratch/          SQLite's own temporary files, emptied by SQLite
//
// Every folder is made for the owner alone (0700) and every file too (0600).
// Encryption at rest is the disk's: the organization's cloud does it.
//
// The path of the folder is the module host's to say, for one organization.
// Nothing here builds a path from an organization's or a Store's id.
//
// WHO MAKES A STORE'S FOLDER. The module, once, when the Store is made
// (`makeStoreFolder`): the folder must not be there yet, so a new Store never
// takes over a folder that holds another Store's file. After that only the
// process that holds the Store touches what is in it (`prepareStoreFolder`).

// Every path below is built from the folder this file was handed and a fixed
// name of its own.
/* eslint-disable security/detect-non-literal-fs-filename */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface StoreFolder {
  root: string;
  database: string;
  alarm: string;
  files: string;
  snapshots: string;
  scratch: string;
}

/** The name of the level of a Store's folder that a Store's process runs in,
 *  and that holds SQLite's temporary files. */
export const SCRATCH_FOLDER = "scratch";

export function storeFolder(root: string): StoreFolder {
  return {
    root,
    database: path.join(root, "store.sqlite"),
    alarm: path.join(root, "alarm.json"),
    files: path.join(root, "files"),
    snapshots: path.join(root, "snapshots"),
    scratch: path.join(root, SCRATCH_FOLDER),
  };
}

/**
 * Make a NEW Store's folder and what it holds, each for the owner alone.
 *
 * Answers false, and makes nothing, when the folder is there already: whatever
 * it holds is another Store's, or what is left of one. THROWS what the disk
 * throws for any other failure.
 */
export function makeStoreFolder(folder: StoreFolder): boolean {
  try {
    // Not `recursive`: that would take a folder that is there for a new one.
    mkdirSync(folder.root, { mode: 0o700 });
  } catch (thrown) {
    if ((thrown as { code?: unknown } | null)?.code === "EEXIST") return false;
    throw thrown;
  }
  try {
    // The mode above is a request that the process's mask may narrow or not.
    chmodSync(folder.root, 0o700);
    for (const dir of [folder.files, folder.snapshots, folder.scratch]) {
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    // Made here, so that its mode is this one from the first byte.
    closeSync(openSync(folder.database, "wx", 0o600));
    chmodSync(folder.database, 0o600);
  } catch (thrown) {
    // Half made. The folder is new, this call made it, and it holds nothing:
    // it is removed again, so that it does not use up a Store's number. Where
    // that fails too it stays, and the next Store passes over it.
    try {
      rmSync(folder.root, { recursive: true, force: true });
    } catch {
      // What the caller is told is why the folder could not be made.
    }
    throw thrown;
  }
  return true;
}

/**
 * Empty a Store's file where it is.
 *
 * THE FILE IS THERE AT EVERY MOMENT. It is cut to nothing under its own name,
 * and never removed and made again. A process that is ended in the middle of
 * this leaves the Store as it was, or empty. It never leaves a folder with no
 * file: such a Store is not opened again (`mendStoreFolder`).
 *
 * THE JOURNAL GOES FIRST. SQLite takes a journal that it finds beside a file
 * for that file's unfinished work, and would write the old Store's pages back
 * into the empty one.
 *
 * Only the process that holds the Store calls this, with its database closed
 * and everything that waited kept.
 */
export function emptyStoreFile(folder: StoreFolder): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    rmSync(`${folder.database}${suffix}`, { force: true });
  }
  // Opened to add to: a file that is not there is made, as before the Store's
  // next opening makes it.
  const fd = openSync(folder.database, "a", 0o600);
  try {
    ftruncateSync(fd, 0);
    // An empty Store is on the disk when this returns.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether a Store's folder can be opened: it is there, with the Store's file
 * in it. Answers false, and makes nothing, when either is gone. A Store whose
 * file is gone is not opened as an empty one, and its folder is not made
 * again.
 *
 * A level under the folder that is missing is put back. A level holds nothing
 * until the Store uses it, and a copy of a disk may leave out a folder that
 * holds nothing: a Store that was put back from such a copy could otherwise
 * never be opened. THE STORE'S OWN FOLDER IS NOT MADE HERE: a level is made
 * inside a folder that is there, or not at all.
 */
export function mendStoreFolder(folder: StoreFolder): boolean {
  if (!existsSync(folder.database)) return false;
  for (const dir of [folder.files, folder.snapshots, folder.scratch]) {
    try {
      // Not `recursive`: the folder above it has to be there.
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
    } catch (thrown) {
      const code = (thrown as { code?: unknown } | null)?.code;
      if (code === "EEXIST") continue;
      // The Store's folder went in this moment.
      if (code === "ENOENT") return false;
      throw thrown;
    }
  }
  return true;
}

/**
 * What the process that holds a Store does to its folder before it opens the
 * file: every level and the file are narrowed to the owner, a level that is
 * missing is made, and what is in the folder is kept.
 *
 * ONLY THE PROCESS THAT HOLDS THE STORE calls this. It removes the drafts of
 * the alarm's time, and a draft that another process is writing just then
 * would be lost with them.
 */
export function prepareStoreFolder(folder: StoreFolder): void {
  for (const dir of [folder.root, folder.files, folder.snapshots, folder.scratch]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  // SQLite makes a new database readable by others where the process lets it.
  // The file is made here first, so its mode is this one, and SQLite's journal
  // takes the mode of the database it belongs to. Opened to add to: a file that
  // is there keeps what it holds.
  closeSync(openSync(folder.database, "a", 0o600));
  chmodSync(folder.database, 0o600);
  // A draft of the alarm's time that a crash left behind. Only one process
  // holds a Store, and it is this one that prepares the folder, so no draft
  // here is being written now.
  for (const name of readdirSync(folder.root)) {
    if (ALARM_DRAFT.test(name)) rmSync(path.join(folder.root, name), { force: true });
  }
}

// ── The alarm's time ─────────────────────────────────────────────────────────

/** When the Store asked to be woken, in milliseconds, or null. A file that
 *  cannot be read as a time is no alarm. */
export function readAlarm(folder: StoreFolder): number | null {
  let text: string;
  try {
    text = readFileSync(folder.alarm, "utf8");
  } catch {
    return null;
  }
  try {
    const at = (JSON.parse(text) as { at?: unknown }).at;
    return typeof at === "number" && Number.isFinite(at) && at >= 0 ? at : null;
  } catch {
    return null;
  }
}

/** Ask the file system to keep a folder's new entry. Best effort: not every
 *  file system lets a folder be opened and synced. */
function syncFolder(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // The file's bytes are on the disk either way. Only how soon its name is,
    // is left to the file system.
  }
}

/** The names a time is written under before it gets the alarm's own name. */
const ALARM_DRAFT = /^alarm\.json\.[0-9]+\.[0-9a-f]+\.tmp$/;

/**
 * Keep the alarm's time, or remove it. The new time replaces the old in one
 * step, and is on the disk when this returns: its bytes, and its name where
 * the file system lets a folder be synced.
 */
export function writeAlarm(folder: StoreFolder, at: number | null): void {
  if (at === null) {
    rmSync(folder.alarm, { force: true });
    syncFolder(folder.root);
    return;
  }
  // A name of its own for each write, so that a draft a crash left behind is
  // never opened again with whatever mode it had.
  const draft = `${folder.alarm}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(draft, "wx", 0o600);
    try {
      // The mode above is a request that the process's mask may narrow.
      fchmodSync(fd, 0o600);
      // All of it, or a throw: half a time must never get the name.
      writeFileSync(fd, JSON.stringify({ at }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(draft, folder.alarm);
  } catch (thrown) {
    rmSync(draft, { force: true });
    throw thrown;
  }
  syncFolder(folder.root);
}

// ── Sizes ────────────────────────────────────────────────────────────────────

/**
 * The bytes every file under `dir` takes, as the files say. A file or a
 * folder that goes away while this looks is not counted, and a folder that is
 * not there takes none.
 *
 * It waits for the disk at every step, so the program that asks goes on with
 * its other work meanwhile, however many files a Store keeps.
 */
export async function folderBytes(dir: string): Promise<number> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await folderBytes(full);
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        // Gone since it was listed.
      }
    }
  }
  return total;
}

/** The bytes still free on the disk that holds `dir`, for this process. */
export function freeBytes(dir: string): number {
  const stats = statfsSync(dir);
  return stats.bavail * stats.bsize;
}
