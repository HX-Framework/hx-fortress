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

// Every path below is built from the folder this file was handed and a fixed
// name of its own.
/* eslint-disable security/detect-non-literal-fs-filename */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface StoreFolder {
  root: string;
  database: string;
  alarm: string;
  files: string;
  snapshots: string;
  scratch: string;
}

export function storeFolder(root: string): StoreFolder {
  return {
    root,
    database: path.join(root, "store.sqlite"),
    alarm: path.join(root, "alarm.json"),
    files: path.join(root, "files"),
    snapshots: path.join(root, "snapshots"),
    scratch: path.join(root, "scratch"),
  };
}

/** Make the folder and what it holds, each for the owner alone. A folder that
 *  is already there is narrowed to the owner, and keeps what is in it. */
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

/** The bytes every file under `dir` takes, as the files say. A file that goes
 *  away while this looks is not counted. */
export function folderBytes(dir: string): number {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += folderBytes(full);
    } else if (entry.isFile()) {
      try {
        total += statSync(full).size;
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
