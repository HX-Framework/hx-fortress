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
//     write-limit.json  the most rows the Store writes in a day, when it has a
//                       limit of its own
//     restore.json      the snapshot the Store goes back to when it is next
//                       opened, while a restore waits for that
//     files/            the Store's files
//     snapshots/        the Store as it was, for a restore: each a whole copy
//                       of store.sqlite, under a name of this host's own
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
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface StoreFolder {
  root: string;
  database: string;
  alarm: string;
  writeLimit: string;
  restore: string;
  /** The copy that takes the Store's place at its next opening, while a
   *  restore waits. */
  restored: string;
  files: string;
  snapshots: string;
  scratch: string;
}

/** The name of the level of a Store's folder that a Store's process is
 *  started for: it holds SQLite's temporary files. */
export const SCRATCH_FOLDER = "scratch";

export function storeFolder(root: string): StoreFolder {
  return {
    root,
    database: path.join(root, "store.sqlite"),
    alarm: path.join(root, "alarm.json"),
    writeLimit: path.join(root, "write-limit.json"),
    restore: path.join(root, "restore.json"),
    restored: path.join(root, "restore.sqlite"),
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
 * What a process does to a Store's folder before it opens the file: every
 * level and the file are narrowed to the owner, a level that is missing is
 * made, and what is in the folder is kept.
 *
 * IT REMOVES NOTHING. A process does this before it knows whether it will
 * hold the Store: another process may hold it, and be writing a draft just
 * now. What a crash left behind is removed by `removeDrafts`, once the
 * Store's file is held.
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
}

/**
 * Remove every draft a crash left behind: of the alarm's time, of the Store's
 * own write limit, of a restore and its copy, and of a snapshot.
 *
 * ONLY THE PROCESS THAT HOLDS THE STORE'S FILE calls this, once it holds it.
 * Only that process writes a draft, so none here is being written now.
 */
export function removeDrafts(folder: StoreFolder): void {
  for (const name of readdirSync(folder.root)) {
    if (DRAFT.test(name)) rmSync(path.join(folder.root, name), { force: true });
  }
  for (const name of readdirSync(folder.snapshots)) {
    if (name.endsWith(DRAFT_SUFFIX)) rmSync(path.join(folder.snapshots, name), { force: true });
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
export function syncFolder(dir: string): void {
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

/** What every draft's name ends in. */
const DRAFT_SUFFIX = ".tmp";
/** The names a file of the Store's folder is written under before it gets its
 *  own name: a small value's, and the copy a restore readies. */
const DRAFT = /^(?:(?:alarm|write-limit|restore)\.json|(?:store|restore)\.sqlite)\.[0-9]+\.[0-9a-f]+\.tmp$/;

/** A draft's name for `file`: one of its own for each write, so that a draft a
 *  crash left behind is never opened again with whatever mode it had. */
function draftOf(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString("hex")}${DRAFT_SUFFIX}`;
}

/**
 * Keep one small value in a file of the Store's folder, or remove the file.
 * The new value replaces the old in one step, and is on the disk when this
 * returns: its bytes, and its name where the file system lets a folder be
 * synced.
 */
function keep(folder: StoreFolder, file: string, value: Record<string, number | string> | null): void {
  if (value === null) {
    rmSync(file, { force: true });
    syncFolder(folder.root);
    return;
  }
  const draft = draftOf(file);
  try {
    const fd = openSync(draft, "wx", 0o600);
    try {
      // The mode above is a request that the process's mask may narrow.
      fchmodSync(fd, 0o600);
      // All of it, or a throw: half a value must never get the name.
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(draft, file);
  } catch (thrown) {
    rmSync(draft, { force: true });
    throw thrown;
  }
  syncFolder(folder.root);
}

/** Keep the alarm's time, or remove it. */
export function writeAlarm(folder: StoreFolder, at: number | null): void {
  keep(folder, folder.alarm, at === null ? null : { at });
}

// ── The Store's own daily write limit ────────────────────────────────────────

/**
 * The most rows the Store writes in a day, when it has a limit of its own, or
 * null when it has none.
 *
 * THROWS, with the code `write_limit_unreadable`, when the file is there and
 * does not hold a whole number of rows. A Store whose limit cannot be read is
 * not held to another one in its place.
 */
export function readWriteLimit(folder: StoreFolder): number | null {
  let text: string;
  try {
    text = readFileSync(folder.writeLimit, "utf8");
  } catch (thrown) {
    if ((thrown as { code?: unknown } | null)?.code === "ENOENT") return null;
    throw unreadableLimit();
  }
  let rows: unknown;
  try {
    rows = (JSON.parse(text) as { rows?: unknown } | null)?.rows;
  } catch {
    throw unreadableLimit();
  }
  if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 0) throw unreadableLimit();
  return rows;
}

function unreadableLimit(): Error {
  return Object.assign(new Error("the Store's own write limit cannot be read"), {
    code: "write_limit_unreadable",
  });
}

/** Keep the Store's own daily write limit, or remove it. Only the process
 *  that holds the Store writes it. */
export function writeWriteLimit(folder: StoreFolder, rows: number | null): void {
  keep(folder, folder.writeLimit, rows === null ? null : { rows });
}

// ── Snapshots, and a restore ─────────────────────────────────────────────────
//
// A snapshot is the Store's whole file as it was at one moment, under a name
// of this host's own: a bookmark. The storage takes one when the engine asks
// for a bookmark (file-storage.ts says when, and how the file is read). A
// restore is asked for by a bookmark, and is carried out when the Store is
// next opened (`applyRestore`).

/**
 * A bookmark: a number that goes up with each snapshot a Store takes, and
 * random letters. It names one file of the snapshots' folder and nothing
 * else. The engine keeps a bookmark in a line of the Store's history and hands
 * it back for a restore, so a value is held to this form before it is made
 * into a path.
 */
const BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{24}$/;
const SNAPSHOT_SUFFIX = ".sqlite";
/** How many bytes are copied at a time. */
const COPY_BYTES = 4 << 20;
/** The first bytes of every SQLite file that holds anything. */
const SQLITE_MAGIC = "SQLite format 3\0";

export function isBookmark(value: unknown): value is string {
  return typeof value === "string" && BOOKMARK.test(value);
}

/** The bookmark that comes after `newest`, or a Store's first one. Its number
 *  is never zero, so no bookmark is all zeros: the engine reads a bookmark of
 *  zeros as "this host keeps none". */
export function nextBookmark(newest: string | null): string {
  const number = newest === null ? 1 : Number.parseInt(newest.slice(0, 8), 16) + 1;
  return `${number.toString(16).padStart(8, "0")}-${randomBytes(12).toString("hex")}`;
}

/** Where a snapshot is. THROWS for a value that is no bookmark: nothing else
 *  is ever made into a path here. */
function snapshotPath(folder: StoreFolder, bookmark: string): string {
  if (!isBookmark(bookmark)) throw new Error("A snapshot is named by a bookmark.");
  return path.join(folder.snapshots, `${bookmark}${SNAPSHOT_SUFFIX}`);
}

/** The bookmarks of the snapshots a Store holds, oldest first. */
export function listSnapshots(folder: StoreFolder): string[] {
  let names: string[];
  try {
    names = readdirSync(folder.snapshots);
  } catch (thrown) {
    if ((thrown as { code?: unknown } | null)?.code === "ENOENT") return [];
    throw thrown;
  }
  return names
    .filter((name) => name.endsWith(SNAPSHOT_SUFFIX))
    .map((name) => name.slice(0, -SNAPSHOT_SUFFIX.length))
    .filter(isBookmark)
    .sort();
}

/** Whether the Store holds the snapshot a value names. A link, a folder, and
 *  a value that is no bookmark are none. */
export function holdsSnapshot(folder: StoreFolder, bookmark: unknown): boolean {
  if (!isBookmark(bookmark)) return false;
  try {
    return lstatSync(snapshotPath(folder, bookmark)).isFile();
  } catch {
    return false;
  }
}

/**
 * Copy the `size` bytes that `source` reads into the new file `target`, for
 * the owner alone, and keep it on the disk. THROWS when the source holds
 * fewer bytes, and what the disk throws. The caller removes what is left of
 * `target` then.
 */
function copyThrough(source: number, size: number, target: string): void {
  const out = openSync(target, "wx", 0o600);
  try {
    // The mode above is a request that the process's mask may narrow.
    fchmodSync(out, 0o600);
    const chunk = new Uint8Array(Math.min(COPY_BYTES, Math.max(size, 1)));
    for (let at = 0; at < size; ) {
      const read = readSync(source, chunk, 0, Math.min(chunk.byteLength, size - at), at);
      if (read === 0) throw Object.assign(new Error("a file ended before its size"), { code: "copy_short" });
      let written = 0;
      while (written < read) written += writeSync(out, chunk, written, read - written);
      at += read;
    }
    fsyncSync(out);
  } finally {
    closeSync(out);
  }
}

/**
 * Take a snapshot: the `size` bytes that `source` reads, kept under
 * `bookmark`. `source` is a descriptor of the Store's file, which its caller
 * holds: this file opens the Store's file nowhere but in `applyRestore`.
 *
 * A SNAPSHOT HAS ITS NAME ONLY ONCE IT IS WHOLE AND ON THE DISK. It is written
 * as a draft and renamed. So a file of the snapshots' folder that has a
 * bookmark's name is a whole copy, whatever ended the process meanwhile.
 */
export function writeSnapshot(folder: StoreFolder, bookmark: string, source: number, size: number): void {
  const file = snapshotPath(folder, bookmark);
  const draft = draftOf(file);
  try {
    copyThrough(source, size, draft);
    renameSync(draft, file);
  } catch (thrown) {
    rmSync(draft, { force: true });
    throw thrown;
  }
  syncFolder(folder.snapshots);
}

/** Remove every snapshot but the `keep` newest and the ones `always` names. */
export function pruneSnapshots(folder: StoreFolder, keep: number, always: readonly string[]): void {
  const held = listSnapshots(folder);
  const spare = held.slice(0, Math.max(0, held.length - keep)).filter((bookmark) => !always.includes(bookmark));
  for (const bookmark of spare) rmSync(snapshotPath(folder, bookmark), { force: true });
  if (spare.length > 0) syncFolder(folder.snapshots);
}

/** Remove every snapshot. */
export function removeSnapshots(folder: StoreFolder): void {
  pruneSnapshots(folder, 0, []);
}

function unreadableRestore(): Error {
  return Object.assign(new Error("the Store's waiting restore cannot be read"), {
    code: "restore_unreadable",
  });
}

/**
 * The bookmark the Store goes back to when it is next opened, or null when no
 * restore waits.
 *
 * THROWS, with the code `restore_unreadable`, when the file is there and does
 * not hold a bookmark. A Store that may be waiting for a restore is not
 * opened as if it were not.
 */
export function readRestore(folder: StoreFolder): string | null {
  let text: string;
  try {
    text = readFileSync(folder.restore, "utf8");
  } catch (thrown) {
    if ((thrown as { code?: unknown } | null)?.code === "ENOENT") return null;
    throw unreadableRestore();
  }
  let bookmark: unknown;
  try {
    bookmark = (JSON.parse(text) as { bookmark?: unknown } | null)?.bookmark;
  } catch {
    throw unreadableRestore();
  }
  if (!isBookmark(bookmark)) throw unreadableRestore();
  return bookmark;
}

/** Keep the bookmark the Store goes back to when it is next opened, or drop
 *  the request. Only the process that holds the Store writes it. */
export function writeRestore(folder: StoreFolder, bookmark: string | null): void {
  keep(folder, folder.restore, bookmark === null ? null : { bookmark });
}

/**
 * Whether the `size` bytes that `fd` reads are a whole SQLite file: SQLite's
 * own first bytes, and exactly as many pages as the file's own first page says
 * it has. SQLite keeps that count in the header, and it holds while the two
 * counters beside it are the same, which they are in every file this host's
 * SQLite wrote. A snapshot gets its name only once it is whole, so this fails
 * only for a file that was cut, damaged, or put there by hand. A file of no
 * bytes is none: a Store's file holds its first page from its first opening.
 */
function isWholeDatabase(fd: number, size: number): boolean {
  const head = new Uint8Array(100);
  if (size < head.byteLength || readSync(fd, head, 0, head.byteLength, 0) !== head.byteLength) return false;
  if (new TextDecoder("latin1").decode(head.subarray(0, SQLITE_MAGIC.length)) !== SQLITE_MAGIC) return false;
  const view = new DataView(head.buffer);
  const stored = view.getUint16(16);
  // SQLite writes its largest page size, 65,536, as 1.
  const pageSize = stored === 1 ? 65_536 : stored;
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) return false;
  const pages = view.getUint32(28);
  return pages > 0 && view.getUint32(24) === view.getUint32(92) && size === pages * pageSize;
}

/**
 * Whether `file` is there, is a file, and is a whole SQLite file. It is opened
 * once, and everything is asked of what was opened: nothing can take the
 * file's place between a look at it and the reading. A link is not followed:
 * it is no file of the Store's own. And the opening waits for nothing: a pipe
 * under that name would otherwise hold it until somebody wrote to the pipe,
 * and the Store could not be opened for as long.
 */
function isWholeDatabaseFile(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const stats = fstatSync(fd);
    return stats.isFile() && isWholeDatabase(fd, stats.size);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Make the copy that takes the Store's place at its next opening, from the
 * snapshot that `bookmark` names. It has its name (`restore.sqlite`) only once
 * it is whole and on the disk.
 *
 * It is made WHEN THE RESTORE IS ASKED FOR, inside the call that asks, and not
 * when the Store is opened: a Store's process has ten seconds to start and
 * open its Store, and a copy that does not fit into them would be started
 * over at every opening, for good. A copy that fails here fails one call, and
 * the Store is as it was.
 *
 * THROWS what the disk throws. The caller writes the request only after this.
 */
export function readyRestore(folder: StoreFolder, bookmark: string): void {
  const source = openSync(snapshotPath(folder, bookmark), "r");
  try {
    const draft = draftOf(folder.restored);
    try {
      copyThrough(source, fstatSync(source).size, draft);
      renameSync(draft, folder.restored);
    } catch (thrown) {
      rmSync(draft, { force: true });
      throw thrown;
    }
  } finally {
    closeSync(source);
  }
  syncFolder(folder.root);
}

/** Drop the restore that waits, if one does, with the copy that was readied
 *  for it. The request goes first: without it the copy is nobody's. */
export function dropRestore(folder: StoreFolder): void {
  writeRestore(folder, null);
  rmSync(folder.restored, { force: true });
}

/**
 * Carry out the restore that waits, if one does: give the copy that was
 * readied for it the name of the Store's file.
 *
 * ONLY THE PROCESS THAT HOLDS THE STORE'S FILE calls this, while it holds the
 * file as it was (file-storage.ts says how the copy is then taken hold of). A
 * process that only tries to open a Store which another one holds is refused
 * before it gets here, so it never puts a file in the place of one that is in
 * use.
 *
 * It answers `none` when no restore waits, `restored`, and `not_restored`
 * when there is nothing whole to go back to: the readied copy is gone or cut,
 * and so is the snapshot. The Store is then left as it is and the request is
 * dropped. The engine finds its own mark of the restore still in the Store,
 * and knows by it that the restore did not happen.
 *
 * OPENING ONLY RENAMES. The copy was made when the restore was asked for
 * (`readyRestore`). It is made here only where it is missing or cut, from the
 * snapshot: after a process that was ended between the rename and the
 * request's removal, the Store goes back to the same snapshot once more,
 * which changes nothing.
 *
 * EVERY STEP CAN BE DONE AGAIN. The request stays until the copy is the
 * Store's file, on the disk, under the file's own name. The Store's file is
 * there at every moment: the copy takes its name in one step. A readied copy
 * with no request is nobody's and is removed.
 *
 * THE JOURNAL GOES BEFORE THE COPY TAKES THE NAME. SQLite takes a journal
 * that it finds beside a file for that file's unfinished work, and would
 * write pages of the Store as it was into the copy.
 *
 * THROWS when the request cannot be read (`restore_unreadable`), and what the
 * disk throws: there is no room for a copy that has to be made again, for
 * one. The Store is not opened then, and the request still waits.
 */
export function applyRestore(folder: StoreFolder): "none" | "restored" | "not_restored" {
  const bookmark = readRestore(folder);
  if (bookmark === null) {
    rmSync(folder.restored, { force: true });
    return "none";
  }
  if (!isWholeDatabaseFile(folder.restored)) {
    rmSync(folder.restored, { force: true });
    if (!holdsSnapshot(folder, bookmark) || !isWholeDatabaseFile(snapshotPath(folder, bookmark))) {
      writeRestore(folder, null);
      return "not_restored";
    }
    readyRestore(folder, bookmark);
  }
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    rmSync(`${folder.database}${suffix}`, { force: true });
  }
  renameSync(folder.restored, folder.database);
  syncFolder(folder.root);
  // Last: until here, an opening that is cut short starts over.
  writeRestore(folder, null);
  return "restored";
}

// ── Sizes ────────────────────────────────────────────────────────────────────

/** How many entries of one folder are sized at a time. */
const SIZED_AT_ONCE = 32;

/**
 * The bytes every file under `dir` takes, as the files say. A file or a
 * folder that goes away while this looks is not counted, and a folder that is
 * not there takes none.
 *
 * It waits for the disk at every step, so the program that asks goes on with
 * its other work meanwhile, however many files a Store keeps. A few entries
 * of a folder are sized at a time: a Store keeps two files for each of its
 * objects, and none of the sizes depends on another.
 */
export async function folderBytes(dir: string): Promise<number> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const sizeOf = async (entry: import("node:fs").Dirent): Promise<number> => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return folderBytes(full);
    if (!entry.isFile()) return 0;
    try {
      return (await stat(full)).size;
    } catch {
      // Gone since it was listed.
      return 0;
    }
  };
  let total = 0;
  for (let from = 0; from < entries.length; from += SIZED_AT_ONCE) {
    const sizes = await Promise.all(entries.slice(from, from + SIZED_AT_ONCE).map(sizeOf));
    for (const size of sizes) total += size;
  }
  return total;
}

/** The bytes still free on the disk that holds `dir`, for this process. */
export function freeBytes(dir: string): number {
  const stats = statfsSync(dir);
  return stats.bavail * stats.bsize;
}
