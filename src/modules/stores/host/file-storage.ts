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
// BOOKMARKS. A bookmark is a snapshot of the file. Snapshots come with the
// restore; until then this storage says what the platform says of a store with
// no way back: a bookmark of zeros, and a refusal for the other two calls.

import { Database } from "bun:sqlite";

import { StoreSql, type StoreSqlOptions } from "./sql-storage";
import {
  emptyStoreFile,
  prepareStoreFolder,
  readAlarm,
  writeAlarm,
  type StoreFolder,
} from "./store-folder";

/** What the platform answers for the current bookmark of a store that keeps none. */
export const NO_BOOKMARK = "00000000-00000000-00000000-00000000000000000000000000000000";
/** The engine reads these words to know that there is no earlier moment. */
const NO_WAY_BACK = "This Store's host does not implement point-in-time recovery.";

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
}

/** Open a Store's database the way this host keeps one. */
function openDatabase(folder: StoreFolder | undefined): Database {
  if (!folder) {
    const memory = new Database(":memory:");
    settle(memory);
    return memory;
  }
  prepareStoreFolder(folder);
  const database = new Database(folder.database, { readwrite: true, create: true });
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
  return database;
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
  /** Whether this storage keeps bookmarks. It keeps none yet. */
  pointInTime = false;
  private readonly folder: StoreFolder | undefined;
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
    this.sql = new StoreSql(openDatabase(this.folder), {
      ...(options.onReachBroken ? { onReachBroken: options.onReachBroken } : {}),
      ...(options.onTransactionLost ? { onTransactionLost: options.onTransactionLost } : {}),
      onPending: () => this.keepSoon(),
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
   * Empty the Store: every table, every row. The alarm is left as it is, as on
   * the platform. The Store's folder is the module's to remove.
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
    this.sql.replace(() => {
      // Cut where it is, never removed: a process that is ended right here
      // must not leave a Store's folder with no file in it.
      if (folder) emptyStoreFile(folder);
      return openDatabase(folder);
    });
  }

  // ── Bookmarks ──────────────────────────────────────────────────────────────

  async getCurrentBookmark(): Promise<string> {
    return NO_BOOKMARK;
  }

  async getBookmarkForTime(): Promise<string> {
    throw new Error(NO_WAY_BACK);
  }

  async onNextSessionRestoreBookmark(): Promise<string> {
    throw new Error(NO_WAY_BACK);
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
    }
  }
}
