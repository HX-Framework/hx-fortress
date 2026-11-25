// A Store's storage: what the engine asks its host for, on one SQLite file.
//
// The engine asks for a database (`sql`), a transaction that either happens
// or does not (`transactionSync`), one alarm, a way to delete everything, and
// bookmarks for going back in time. On the platform it was written for, the
// object that holds a Store gives all of these. Here this class does.
//
// The file is opened so that it stands by itself on any disk:
//
//   • One process holds the file, and holds it shut to every other
//     (`locking_mode = EXCLUSIVE`). Two processes can never write one Store.
//   • What is kept is on the disk when the keeping returns
//     (`synchronous = FULL`), and a change that was half written when the
//     process ended is undone the next time the file is opened
//     (`journal_mode = TRUNCATE`: SQLite's journal beside the file).
//   • Nothing depends on memory shared between processes, which a disk mounted
//     from the network does not give.
//
// Settings that differ between builds of SQLite are set to the platform's:
// foreign keys are enforced, a trigger does not fire itself, and a new file
// does not shrink by itself.
//
// WHEN WHAT WAS WRITTEN IS KEPT (`flush`). As on the platform, statements that
// run with no wait between them are kept together, or not at all:
//
//   • when the program next waits for something. The first write since the
//     last keeping asks for a keeping as soon as the work at hand, and
//     everything it set going without a wait, has run;
//   • when a `transactionSync` that is not inside another one ends. The
//     platform keeps that one a moment later. The engine counts a job's tries
//     in a transaction of its own before it runs the job's work, and that
//     count has to outlast work that never returns;
//   • when the owner says so: a Store's process does before it answers a call.
//
// So when the process is ended in the middle of something (a statement that
// ran too long, a crash, the machine going down), the file is as the last
// keeping left it.
//
// THE ALARM is kept with the writes it belongs to. A time that is sooner than
// the one on the disk is written before the writes are kept, and any other
// change after. If the process ends between the two, the Store is woken once
// for nothing. It is never left waiting for an alarm nobody kept.
//
// AN ALARM THAT FIRED stays on the disk until the program has dealt with it
// (`takeAlarm`, `settleAlarm`). The program sees no alarm meanwhile, as on the
// platform. If the process is ended while the program is at it, the next
// process finds the time on the disk, still due, and the Store is woken again.
//
// BOOKMARKS. On the platform a bookmark is a place in a log, and costs
// nothing. SQLite keeps no such log. Here a bookmark is a SNAPSHOT: a whole
// copy of the Store's file as it is at that moment, kept in the Store's
// `snapshots` folder under a name of this host's own.
//
//   • The engine asks for a bookmark before each change it can undo (a
//     migration, a table's new version, a pull's start), and keeps the name in
//     the line of the Store's history. So a Store goes back to the moment
//     before a line of its history, and to no moment between two of them.
//   • A bookmark is taken with everything that waited kept first. Two that
//     are asked for with no change between them are one snapshot.
//   • A restore is asked for by a bookmark, and happens when the Store is next
//     opened (`applyRestore` in store-folder.ts). The copy that takes the
//     Store's place is made when the restore is asked for, so that the
//     opening only gives it the file's name. The answer is a bookmark of the
//     moment just before, so that the restore itself can be undone.
//   • A Store keeps its newest snapshots, `SNAPSHOTS_KEPT` of them. An older
//     line of the history can no longer be gone back to (`holdsBookmark`).
//     The one a restore names is kept past that count for as long as this
//     process runs (`keepBookmark`): the restore is done as the next one
//     opens the Store.
//   • A Store whose file is larger than `SNAPSHOT_STORE_MAX_BYTES` keeps none.
//     Every bookmark costs one copy of the file, written and kept on the disk
//     while a call waits. Such a Store says what the platform says of a store
//     with no way back: a bookmark of zeros, and a refusal for a restore. The
//     bound is asked in ONE place (`keepsMoments`), by every call here: a
//     Store that grew past it holds no moment from then on, also not one it
//     took while it was smaller, and those snapshots are removed when it is
//     next asked for a bookmark.
//   • A Store kept in memory keeps none either.
//
// HOW THE FILE IS COPIED. Through one descriptor of this class's own, which is
// opened for the first snapshot and CLOSED ONLY AFTER THE DATABASE IS. On a
// system that keeps a file's locks for each process, a process that closes
// any descriptor of a file gives up every lock it holds on that file. SQLite
// holds the Store shut with such a lock. So nothing here opens the Store's
// file and closes it again while the database is open.
//
// The copy is read between two keepings, with no statement running: the file
// then holds every page of the Store, and SQLite's journal beside it is empty.

// The path below is the Store's own file, in the folder this class was handed.
/* eslint-disable security/detect-non-literal-fs-filename */

import { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, statSync } from "node:fs";

import { StoreSql, type StoreSqlOptions } from "./sql-storage";
import {
  applyRestore,
  dropRestore,
  emptyStoreFile,
  holdsSnapshot,
  isBookmark,
  listSnapshots,
  nextBookmark,
  prepareStoreFolder,
  pruneSnapshots,
  readAlarm,
  readRestore,
  readyRestore,
  removeDrafts,
  removeSnapshots,
  writeAlarm,
  writeRestore,
  writeSnapshot,
  type StoreFolder,
} from "./store-folder";

/** What the platform answers for the current bookmark of a store that keeps none. */
export const NO_BOOKMARK = "00000000-00000000-00000000-00000000000000000000000000000000";
/** The engine reads these words to know that there is no earlier moment. */
const NO_WAY_BACK = "This Store's host does not implement point-in-time recovery.";
/** For a restore to a time. The engine tells its caller these words, and must
 *  not take them for a host with no way back at all. */
const NO_SUCH_TIME = "this host goes back to a line of the Store's history, and to no time between two of them";
/** For a bookmark whose snapshot the Store no longer holds. */
const MOMENT_GONE = "This Store no longer holds that moment.";

/** How many snapshots a Store keeps: its newest. */
export const SNAPSHOTS_KEPT = 10;
/** The largest file a Store may have and still keep snapshots. A snapshot is
 *  a whole copy, made while a call waits: at 125 MB a second, which a small
 *  cloud disk writes, a file of this size takes about two seconds. */
export const SNAPSHOT_STORE_MAX_BYTES = 256 * 1024 * 1024;

export interface FileStorageOptions extends Omit<StoreSqlOptions, "onPending"> {
  /** The Store's folder. Left out, the Store is kept in memory and is gone
   *  when it is closed: for a test that needs no disk. */
  folder?: StoreFolder;
  /** Called with the alarm's new time, or null, each time the time that is
   *  kept changes. */
  onAlarm?: (at: number | null) => void;
  /**
   * Called when what was written could not be kept. The file is then as the
   * last keeping left it, and the program may remember more than it holds. A
   * Store's process ends itself here. Left out, the failure is thrown where
   * the keeping was asked for.
   */
  onNotKept?: () => void;
  /** Seams for tests: how many snapshots are kept, and the largest file a
   *  Store may have and still keep them. */
  snapshots?: { kept?: number; storeMaxBytes?: number };
}

/**
 * Open the file that is the Store's now, and hold it shut to every other
 * process. THROWS what SQLite throws when another process holds it.
 */
function hold(folder: StoreFolder): Database {
  const database = new Database(folder.database, { readwrite: true, create: true });
  try {
    // Before the first read: the lock is taken with it, and kept.
    database.run("PRAGMA locking_mode = EXCLUSIVE");
    database.run("PRAGMA journal_mode = TRUNCATE");
    database.run("PRAGMA synchronous = FULL");
    settle(database);
    // A write that changes nothing. It takes the file for this process alone,
    // and with the setting above the file stays taken until it is closed. A
    // second process that opens the same Store is refused by SQLite here.
    database.run("BEGIN EXCLUSIVE");
    database.run("COMMIT");
  } catch (thrown) {
    database.close();
    throw thrown;
  }
  return database;
}

/**
 * Open a Store's database the way this host keeps one.
 *
 * THE STORE'S FILE IS HELD BEFORE ANYTHING IN ITS FOLDER IS CHANGED. A process
 * that tries to open a Store which another process holds is refused here, and
 * has removed nothing and put nothing in the file's place.
 *
 * A restore that waits is carried out then (`applyRestore`): the snapshot's
 * copy takes the file's name, and this process takes hold of the copy BEFORE it
 * lets go of the file as it was. So from the first hold on there is no moment
 * at which the Store is nobody's. If another process took the copy in between,
 * this one is refused: that one has the Store, restored.
 */
function openDatabase(folder: StoreFolder | undefined): Database {
  if (!folder) {
    const memory = new Database(":memory:");
    settle(memory);
    return memory;
  }
  prepareStoreFolder(folder);
  let held = hold(folder);
  try {
    removeDrafts(folder);
    if (applyRestore(folder) === "restored") {
      const copy = hold(folder);
      // Nothing was written through it, so it is closed with nothing to keep.
      held.close();
      held = copy;
    }
  } catch (thrown) {
    held.close();
    throw thrown;
  }
  return held;
}

/** The settings a Store's statements count on, whatever this build of SQLite
 *  starts with. */
function settle(database: Database): void {
  // Only a file with no table yet takes this one.
  database.run("PRAGMA auto_vacuum = NONE");
  database.run("PRAGMA foreign_keys = ON");
  database.run("PRAGMA recursive_triggers = OFF");
}

export class FileStorage {
  readonly sql: StoreSql;
  /**
   * Whether this storage keeps bookmarks: it does for a Store on the disk. Set
   * to false, it says what a host with no way back says. The engine's own
   * tests set it so.
   */
  pointInTime: boolean;
  private readonly folder: StoreFolder | undefined;
  private readonly snapshotsKept: number;
  private readonly snapshotStoreMaxBytes: number;
  /** This class's own descriptor of the Store's file, for copying it. Closed
   *  only after the database is: see the top of this file. */
  private reading: number | null = null;
  /** The newest snapshot this storage took, and the database's mark then. */
  private newest: { bookmark: string; mark: string } | null = null;
  /** Something may have been written since the newest snapshot: a statement
   *  that writes ran. Kept beside SQLite's own counters (`changeMark`) on
   *  purpose: a `REINDEX`, or an `ANALYZE` after the first, writes the file
   *  and moves neither. The cost is one more copy after a statement that
   *  turned out to change nothing. */
  private changed = true;
  /** Snapshots that are not removed to make room while this process runs. */
  private readonly stays = new Set<string>();
  private readonly onAlarm: ((at: number | null) => void) | undefined;
  private readonly onNotKept: (() => void) | undefined;
  /** The alarm as the engine set it. */
  private alarmAt: number | null;
  /** The alarm as the disk has it. */
  private keptAt: number | null;
  /** The alarm fired, and the program is dealing with it. */
  private firing = false;
  /** The keeping that was asked for and has not run yet. */
  private pending: ReturnType<typeof setImmediate> | null = null;
  private closed = false;

  constructor(options: FileStorageOptions = {}) {
    this.folder = options.folder;
    this.onAlarm = options.onAlarm;
    this.onNotKept = options.onNotKept;
    this.pointInTime = this.folder !== undefined;
    this.snapshotsKept = options.snapshots?.kept ?? SNAPSHOTS_KEPT;
    this.snapshotStoreMaxBytes = options.snapshots?.storeMaxBytes ?? SNAPSHOT_STORE_MAX_BYTES;
    this.sql = new StoreSql(openDatabase(this.folder), {
      ...(options.onReachBroken ? { onReachBroken: options.onReachBroken } : {}),
      ...(options.onTransactionLost ? { onTransactionLost: options.onTransactionLost } : {}),
      onPending: () => {
        this.changed = true;
        this.keepSoon();
      },
    });
    this.keptAt = this.folder ? readAlarm(this.folder) : null;
    this.alarmAt = this.keptAt;
  }

  private usable(): void {
    if (this.closed) throw new Error("This Store's storage is closed.");
  }

  // ── Keeping ────────────────────────────────────────────────────────────────

  /** Ask for a keeping as soon as the work at hand has run. */
  private keepSoon(): void {
    if (this.pending !== null || this.closed) return;
    this.pending = setImmediate(() => {
      this.pending = null;
      try {
        this.flush();
      } catch (thrown) {
        // With an owner that was told, there is nobody else to tell here.
        if (!this.onNotKept) throw thrown;
      }
    });
  }

  /**
   * Keep what was written since the last time, and the alarm with it. Inside a
   * `transactionSync` nothing happens: its end keeps.
   *
   * THROWS when it cannot be kept, after it told `onNotKept`.
   */
  flush(): void {
    if (this.closed || this.sql.inSavepoint) return;
    if (this.pending !== null) {
      clearImmediate(this.pending);
      this.pending = null;
    }
    try {
      this.keepAlarm("before");
      this.sql.commit();
      this.keepAlarm("after");
    } catch (thrown) {
      this.onNotKept?.();
      throw thrown;
    }
  }

  // ── A transaction ──────────────────────────────────────────────────────────

  /** Run `closure` so that all of what it writes is kept, or none of it. One
   *  inside another undoes only its own part. The outermost one is kept when
   *  it ends. */
  transactionSync<T>(closure: () => T): T {
    this.usable();
    const outermost = !this.sql.inSavepoint;
    const result = this.sql.savepoint(closure);
    if (outermost) this.flush();
    return result;
  }

  // ── The alarm ──────────────────────────────────────────────────────────────

  /** The alarm's time, or null. One alarm for a Store: a new time replaces the
   *  old one. It is kept with the next keeping. */
  get alarm(): number | null {
    return this.alarmAt;
  }

  set alarm(at: number | null) {
    this.usable();
    this.alarmAt = at;
    if (at !== this.keptAt) this.keepSoon();
  }

  /**
   * The alarm fired: take it. The program sees none from here on, unless it
   * sets a new one, and the disk keeps the time until `settleAlarm`.
   */
  takeAlarm(): number | null {
    this.usable();
    const due = this.alarmAt;
    this.firing = true;
    this.alarmAt = null;
    return due;
  }

  /**
   * The program has dealt with the alarm that `takeAlarm` took, or failed to.
   * When it failed and set no new time, the time `due` stands again. The
   * alarm as it is now is kept with the next keeping.
   */
  settleAlarm(due: number | null, dealtWith: boolean): void {
    this.firing = false;
    if (!dealtWith && this.alarmAt === null) this.alarmAt = due;
    if (!this.closed && this.alarmAt !== this.keptAt) this.keepSoon();
  }

  /** Write the alarm, before or after the writes it belongs to are kept. */
  private keepAlarm(when: "before" | "after"): void {
    const at = this.alarmAt;
    if (at === this.keptAt) return;
    // The time that fired stays on the disk while the program deals with it.
    if (this.firing && at === null) return;
    // Before: only a time that is sooner than the one on the disk. A later
    // time, and no time at all, wait until the writes are kept.
    const sooner = at !== null && (this.keptAt === null || at < this.keptAt);
    if (when === "before" && !sooner) return;
    if (this.folder) writeAlarm(this.folder, at);
    this.keptAt = at;
    this.onAlarm?.(at);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  // ── Everything ─────────────────────────────────────────────────────────────

  /**
   * Empty the Store: every table, every row, and every snapshot of them. A
   * restore that waited is dropped. The alarm is left as it is, as on the
   * platform. The Store's folder is the module's to remove.
   *
   * The snapshots go too, where the platform keeps its log: a Store that was
   * emptied on purpose must not have its rows left on this disk.
   *
   * What waited to be kept is kept first, and the Store is empty on the disk
   * when this returns. So it is refused inside a `transactionSync`, which
   * could no longer undo it.
   *
   * The Store's file is there at every moment of this (`emptyStoreFile`): a
   * process that is ended in the middle leaves the Store as it was, or empty.
   */
  async deleteAll(): Promise<void> {
    this.usable();
    if (this.sql.inSavepoint) {
      throw new Error("A Store cannot be emptied inside a transaction.");
    }
    this.flush();
    const { folder } = this;
    if (folder) {
      // The request first: a process that is ended in the middle of this must
      // not put the Store back at its next opening.
      dropRestore(folder);
      removeSnapshots(folder);
    }
    this.newest = null;
    this.changed = true;
    this.stays.clear();
    this.sql.replace(() => {
      // Cut where it is, never removed: a process that is ended right here
      // must not leave a Store's folder with no file in it.
      if (folder) emptyStoreFile(folder);
      return openDatabase(folder);
    });
  }

  // ── Bookmarks ──────────────────────────────────────────────────────────────

  /**
   * A bookmark of the Store as it is now, with everything that waited kept: a
   * snapshot. Answers a bookmark of zeros where the Store keeps none (see the
   * top of this file). THROWS inside a `transactionSync`, and what the disk
   * throws when the copy cannot be made.
   */
  async getCurrentBookmark(): Promise<string> {
    this.usable();
    const { folder } = this;
    if (!folder || !this.pointInTime) return NO_BOOKMARK;
    return this.snapshot(folder) ?? NO_BOOKMARK;
  }

  /** This host goes back to a bookmark, and to no time, so the time it is
   *  asked for is not read. Always THROWS: the engine reads the words to tell
   *  "no such moment" from "no way back". */
  async getBookmarkForTime(): Promise<string> {
    this.usable();
    if (!this.folder || !this.pointInTime) throw new Error(NO_WAY_BACK);
    throw new Error(NO_SUCH_TIME);
  }

  /**
   * Have the Store go back to `bookmark` when it is next opened. Answers a
   * bookmark of the moment just before, with everything that waited kept: the
   * restore's own undo. Nothing of the Store's file changes until then.
   *
   * Three things are on the disk when this answers, made in this order: the
   * snapshot of the moment just before, the copy that takes the Store's place
   * (`readyRestore`), and the request. A request that waited before is
   * dropped first, with its copy: a copy never waits beside a request for
   * another bookmark. Where a step fails, nothing waits.
   *
   * THROWS for a bookmark whose snapshot the Store does not hold, where the
   * Store keeps none, and what the disk throws.
   */
  async onNextSessionRestoreBookmark(bookmark: string): Promise<string> {
    this.usable();
    const { folder } = this;
    if (!folder || !this.keepsMoments(folder)) throw new Error(NO_WAY_BACK);
    if (!holdsSnapshot(folder, bookmark)) throw new Error(MOMENT_GONE);
    // The snapshot to go back to may be the oldest one: it stays.
    const stayed = this.stays.has(bookmark);
    this.stays.add(bookmark);
    try {
      const undo = this.snapshot(folder);
      if (undo === null) throw new Error(NO_WAY_BACK);
      dropRestore(folder);
      readyRestore(folder, bookmark);
      writeRestore(folder, bookmark);
      return undo;
    } catch (thrown) {
      // Nothing waits, and the snapshot is one like any other again.
      if (!stayed) this.stays.delete(bookmark);
      try {
        dropRestore(folder);
      } catch {
        // A copy with no request is removed when the Store is next opened.
      }
      throw thrown;
    }
  }

  /** Whether the Store goes back to a bookmark when it is next opened. A
   *  request that cannot be read counts: the Store's next opening refuses it. */
  get restoreWaits(): boolean {
    if (!this.folder) return false;
    try {
      return readRestore(this.folder) !== null;
    } catch {
      return true;
    }
  }

  /**
   * Whether the Store keeps moments to go back to NOW: it is told to, and its
   * file as the disk holds it is no larger than a Store's may be to keep
   * snapshots. The one place that asks: a bookmark, a restore, and whether a
   * line of the history is a way back, all go by this.
   */
  private keepsMoments(folder: StoreFolder): boolean {
    if (!this.pointInTime) return false;
    try {
      // By the file's name: no descriptor of the Store's file is opened here.
      return statSync(folder.database).size <= this.snapshotStoreMaxBytes;
    } catch {
      return false;
    }
  }

  /** Whether the Store still holds the moment a bookmark names: a line of its
   *  history can be gone back to only while it does. A Store that keeps no
   *  moment now holds none, whatever snapshots are still in its folder. */
  holdsBookmark(bookmark: unknown): boolean {
    return this.folder !== undefined && this.keepsMoments(this.folder) && holdsSnapshot(this.folder, bookmark);
  }

  /**
   * Keep the snapshot that `bookmark` names for as long as this process runs,
   * however many are taken after it. For the moment a restore is about to go
   * back to: before the engine asks for the restore, it asks for a bookmark of
   * the Store as it is, and that one more snapshot must not push out the one
   * the restore names. `releaseBookmark` lets it go again.
   */
  keepBookmark(bookmark: string): void {
    if (isBookmark(bookmark)) this.stays.add(bookmark);
  }

  /** Let a snapshot go that `keepBookmark` kept: it is one like any other
   *  again. For a restore that was not readied after all. */
  releaseBookmark(bookmark: string): void {
    this.stays.delete(bookmark);
  }

  /**
   * The snapshot of the Store as it is now: a new one, or the newest when
   * nothing changed since it was taken. Null for a Store whose file is too
   * large to keep snapshots: the ones it took while it was smaller go then.
   */
  private snapshot(folder: StoreFolder): string | null {
    if (this.sql.inSavepoint) throw new Error("A Store's moment cannot be marked inside a transaction.");
    // Everything that waited is kept: the file then holds the whole Store.
    this.flush();
    const mark = this.sql.changeMark();
    const newest = this.newest;
    if (newest !== null && !this.changed && newest.mark === mark && holdsSnapshot(folder, newest.bookmark)) {
      return newest.bookmark;
    }
    this.reading ??= openSync(folder.database, "r");
    const size = fstatSync(this.reading).size;
    if (size > this.snapshotStoreMaxBytes) {
      // The Store keeps none from here on (`keepsMoments`). What it took while
      // it was smaller is no way back any more, and only takes room.
      this.newest = null;
      try {
        pruneSnapshots(folder, 0, [...this.stays]);
      } catch {
        // Looked at again when the next bookmark is asked for.
      }
      return null;
    }
    const bookmark = nextBookmark(newest?.bookmark ?? listSnapshots(folder).at(-1) ?? null);
    writeSnapshot(folder, bookmark, this.reading, size);
    this.newest = { bookmark, mark };
    this.changed = false;
    try {
      // The snapshot a restore names stays, whatever its age: a restore that
      // waits was asked of this process, which keeps its bookmark in `stays`
      // (one that waited when the Store was opened was carried out then).
      pruneSnapshots(folder, this.snapshotsKept, [bookmark, ...this.stays]);
    } catch {
      // The snapshot is taken. What could not be removed now is looked at
      // again when the next one is.
    }
    return bookmark;
  }

  // ── The end ────────────────────────────────────────────────────────────────

  /** Keep what waits, and close the file. Every call after this is refused.
   *  Safe to call twice. */
  close(): void {
    if (this.closed) return;
    try {
      this.flush();
    } finally {
      this.closed = true;
      if (this.pending !== null) clearImmediate(this.pending);
      this.pending = null;
      this.sql.close();
      // After the database, never before: see the top of this file.
      if (this.reading !== null) closeSync(this.reading);
      this.reading = null;
    }
  }
}
