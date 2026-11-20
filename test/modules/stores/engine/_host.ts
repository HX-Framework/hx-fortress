// The host the Store's engine is tested on here.
//
// The engine comes with a suite of tests for any host
// (src/modules/stores/engine/store-object/testing/suite). A host hands the
// suite a new Store's storage, and says what it holds. This file hands it the
// Stores module's own: `FileStorage` on a real file in a folder of its own,
// with the guard and the limits a Store runs under, and a Store's process for
// the rule that needs one.
//
// Around the storage there is only what the suite reads beside it: the list
// of statements a test looks at, the database itself for a test that sets a
// Store up directly, and `restart`, which is what a new process of the Store
// does. Every call of a Store goes to the `FileStorage` unchanged.

import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import path from "node:path";

import type {
  ApartStore,
  HostDatabase,
  HostStatement,
  HostStorage,
  StoreHost,
} from "../../../../src/modules/stores/engine/store-object/testing/suite/host.js";
import { FileStorage } from "../../../../src/modules/stores/host/file-storage";
import { HELD, type SqlCursor, type StoreSql } from "../../../../src/modules/stores/host/sql-storage";
import type { StoreFolder } from "../../../../src/modules/stores/host/store-folder";
import { newStoreFolder, probeStore, tempFolder } from "../_rig";

/** The longest a statement may run in a Store that the suite opens apart. */
export const RUNAWAY_LIMIT_MS = 1_000;
/** What a call that has to start the Store's process first is given on top:
 *  the time of a start, on a busy machine. */
const START_ROOM_MS = 10_000;

/** The storages a test opened and has not closed. */
const opened = new Set<{ close(): void }>();

/** Close every storage that is open. For the end of each test. */
export function closeStorages(): void {
  for (const storage of opened) {
    try {
      storage.close();
    } catch {
      // A test may have left it unusable on purpose.
    }
  }
  opened.clear();
}

type Bound = SQLQueryBindings[];

/** A database as a test reads and writes it directly. `current` is asked each
 *  time: a Store that was emptied or started again has a new connection. */
function hostDatabase(current: () => Database): HostDatabase {
  return {
    prepare(sql: string): HostStatement {
      let bigInts = false;
      /** Compile the statement, use it once, and put it away at once. A
       *  statement that stays open keeps its database from being closed, and
       *  the storage closes its database when the engine empties a Store. */
      const once = <T>(use: (statement: Statement) => T): T => {
        const made = current().prepare(sql);
        try {
          // The runtime has this call. Its type declarations do not list it yet.
          if (bigInts) (made as unknown as { safeIntegers(on: boolean): unknown }).safeIntegers(true);
          return use(made);
        } finally {
          made.finalize();
        }
      };
      return {
        all: (...params) => once((statement) => statement.all(...(params as Bound)) as Record<string, unknown>[]),
        get: (...params) =>
          once((statement) => (statement.get(...(params as Bound)) as Record<string, unknown> | null) ?? undefined),
        run: (...params) => once((statement) => statement.run(...(params as Bound))),
        setReadBigInts(on: boolean): void {
          bigInts = on;
        },
      };
    },
    exec(sql: string): void {
      current().exec(sql);
    },
  };
}

/**
 * A Store's SQL, with the two things the suite reads beside it.
 *
 * A class, so that `exec` is a method of its prototype: a test of the suite
 * puts its own `exec` on the object for a while and deletes it again, and
 * what it deleted must give way to this one.
 */
class SuiteSql {
  /** Every statement `exec` took, in order. */
  readonly statements: string[] = [];
  /** The database itself, past the guard and the count of rows written. */
  readonly db: HostDatabase;
  readonly #current: () => StoreSql;

  constructor(current: () => StoreSql) {
    this.#current = current;
    this.db = hostDatabase(() => current().db);
  }

  exec(query: string, ...bindings: unknown[]): SqlCursor {
    this.statements.push(query);
    return this.#current().exec(query, ...bindings);
  }

  get databaseSize(): number {
    return this.#current().databaseSize;
  }
}

function storage(): HostStorage {
  const folder: StoreFolder = newStoreFolder("engine-suite");
  let inner = new FileStorage({ folder });
  const handle = { close: (): void => inner.close() };
  opened.add(handle);
  return {
    sql: new SuiteSql(() => inner.sql) as unknown as HostStorage["sql"],
    transactionSync: <T>(closure: () => T): T => inner.transactionSync(closure),
    deleteAll: () => inner.deleteAll(),
    setAlarm: (at: number) => inner.setAlarm(at),
    getAlarm: () => inner.getAlarm(),
    deleteAlarm: () => inner.deleteAlarm(),
    getCurrentBookmark: () => inner.getCurrentBookmark(),
    getBookmarkForTime: () => inner.getBookmarkForTime(),
    onNextSessionRestoreBookmark: () => inner.onNextSessionRestoreBookmark(),
    get alarm(): number | null {
      return inner.alarm;
    },
    set alarm(at: number | null) {
      inner.alarm = at;
    },
    now: () => Date.now(),
    pointInTime: false,
    // What a Store's next process does: the file is closed with everything
    // kept, and opened again.
    restart(): void {
      inner.close();
      inner = new FileStorage({ folder });
    },
  };
}

/** A SQLite file that is no Store's, holding one row a Store must never read. */
let otherFile: string | null = null;
function fileOutsideEveryStore(): string {
  if (otherFile === null) {
    otherFile = path.join(tempFolder("engine-suite-other"), "other.sqlite");
    const database = new Database(otherFile, { create: true, readwrite: true });
    database.exec("CREATE TABLE other_rows (secret TEXT); INSERT INTO other_rows VALUES ('rows of another Store');");
    database.close();
  }
  return otherFile;
}

/**
 * A Store in a process of its own, as HX Fortress runs one.
 *
 * A call's limit counts from the moment it is handed over, and a call that
 * finds no process waits for one to start first. The rule is about how long a
 * statement RUNS. So a call that has to start the Store's process is given the
 * time of a start on top, and a call to a process that runs has the limit
 * alone: the statement that never ends is such a call.
 */
async function apart(): Promise<ApartStore> {
  // Every call below is handed its own limit.
  const store = probeStore();
  return {
    async exec(sql: string, ...bindings: unknown[]): Promise<Record<string, unknown>[]> {
      const limitMs = store.process.isOpen ? RUNAWAY_LIMIT_MS : RUNAWAY_LIMIT_MS + START_ROOM_MS;
      const { columns, rows } = await store.process.call<{ columns: string[]; rows: unknown[][] }>(
        "exec",
        [sql, ...bindings],
        { limitMs },
      );
      return rows.map((row) => Object.fromEntries(columns.map((name, at) => [name, row.at(at)])));
    },
    close: () => store.process.dispose(),
  };
}

export const engineHost: StoreHost = {
  name: "HX Fortress",
  storage,
  database(bytes?: Uint8Array): HostDatabase {
    const database = bytes ? Database.deserialize(bytes) : new Database(":memory:");
    opened.add(database);
    return hostDatabase(() => database);
  },
  traits: {
    // Written rows are counted as SQLite counts them.
    billedWrites: false,
    limits: {
      // What the storage itself says it holds (`HELD` in sql-storage.ts).
      ...HELD,
      // These two it holds in part: for a value that is bound to a statement
      // or answered by one, and for a pattern that is written in a statement
      // or bound to it. Not for a value or a pattern that a statement builds
      // inside the Store. The suite tries the bound ones, so it is told yes,
      // and its two tests hold the part that is held.
      length: true,
      likePatternLength: true,
    },
    // No snapshots yet: a Store here has no moment to go back to.
    bookmarks: false,
  },
  reach: { held: "host", otherFile: fileOutsideEveryStore },
  runaway: { held: "host", limitMs: RUNAWAY_LIMIT_MS, open: apart },
};
