import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { FileStorage, NO_BOOKMARK, SNAPSHOTS_KEPT } from "../../../src/modules/stores/host/file-storage";
import {
  applyRestore,
  folderBytes,
  freeBytes,
  listSnapshots,
  makeStoreFolder,
  mendStoreFolder,
  prepareStoreFolder,
  readAlarm,
  readRestore,
  storeFolder,
  writeAlarm,
  writeRestore,
  type StoreFolder,
} from "../../../src/modules/stores/host/store-folder";
import { cleanFolders, newStoreFolder, tempFolder } from "./_rig";

const opened: FileStorage[] = [];
function open(options: ConstructorParameters<typeof FileStorage>[0] = {}): FileStorage {
  const storage = new FileStorage(options);
  opened.push(storage);
  return storage;
}

afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
  cleanFolders();
});

const mode = (file: string): number => statSync(file).mode & 0o777;

describe("a Store's folder", () => {
  test("is made for the owner alone, with the Store's file in it", () => {
    const folder = newStoreFolder();
    open({ folder }).sql.exec("CREATE TABLE t (a)");
    expect(mode(folder.root)).toBe(0o700);
    expect(mode(folder.files)).toBe(0o700);
    expect(mode(folder.snapshots)).toBe(0o700);
    expect(mode(folder.scratch)).toBe(0o700);
    expect(mode(folder.database)).toBe(0o600);
  });

  test("a folder that was open to others is narrowed, and keeps what it holds", () => {
    const folder = storeFolder(`${tempFolder()}/store`);
    prepareStoreFolder(folder);
    const first = open({ folder });
    first.sql.exec("CREATE TABLE t (a)");
    first.sql.exec("INSERT INTO t VALUES (1)");
    first.close();
    opened.length = 0;
    // As if somebody had loosened it by hand.
    const loosen = new Database(folder.database);
    loosen.close();
    writeFileSync(`${folder.root}/note.txt`, "x");
    Bun.spawnSync(["chmod", "-R", "a+rwx", folder.root]);
    const again = open({ folder });
    expect(mode(folder.root)).toBe(0o700);
    expect(mode(folder.database)).toBe(0o600);
    expect(again.sql.exec("SELECT a FROM t").toArray()).toEqual([{ a: 1 }]);
  });

  test("its size is what its files take, and the disk says what is free", async () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    storage.sql.exec("CREATE TABLE t (a TEXT)");
    storage.sql.exec("INSERT INTO t VALUES (?)", "x".repeat(100_000));
    storage.flush();
    writeFileSync(`${folder.files}/one`, "12345");
    const bytes = await folderBytes(folder.root);
    expect(bytes).toBeGreaterThan(100_000);
    expect(bytes).toBe(statSync(folder.database).size + 5);
    expect(storage.sql.databaseSize).toBe(statSync(folder.database).size);
    expect(freeBytes(folder.root)).toBeGreaterThan(0);
    expect(await folderBytes(`${folder.root}/not-there`)).toBe(0);
  });
});

describe("a new Store's folder", () => {
  test("is made once, with every level and the file for the owner alone", () => {
    const folder = storeFolder(path.join(tempFolder(), "s000001"));
    expect(makeStoreFolder(folder)).toBe(true);
    for (const dir of [folder.root, folder.files, folder.snapshots, folder.scratch]) {
      expect(mode(dir)).toBe(0o700);
    }
    expect(mode(folder.database)).toBe(0o600);
    expect(statSync(folder.database).size).toBe(0);
    // The Store's process opens it as it is.
    const storage = open({ folder });
    storage.sql.exec("CREATE TABLE t (a)");
    storage.close();
  });

  test("a folder that is there is never taken for a new Store, and nothing in it is touched", () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    storage.sql.exec("CREATE TABLE salaries (name TEXT, pay INTEGER)");
    storage.sql.exec("INSERT INTO salaries VALUES ('Lena Hart', 91000)");
    storage.close();
    const before = statSync(folder.database).size;
    expect(makeStoreFolder(folder)).toBe(false);
    expect(statSync(folder.database).size).toBe(before);
    // An empty folder that is there is not taken either.
    const empty = storeFolder(tempFolder());
    expect(makeStoreFolder(empty)).toBe(false);
    expect(existsSync(empty.database)).toBe(false);
  });

  test("a folder that could only be half made is removed again, and the failure is told", () => {
    const root = path.join(tempFolder(), "s000001");
    // One level of the folder cannot be made: the level above it is missing.
    const folder = { ...storeFolder(root), snapshots: path.join(root, "no-such-level", "snapshots") };
    expect(() => makeStoreFolder(folder)).toThrow("ENOENT");
    // Nothing is left that would use up a Store's number.
    expect(existsSync(root)).toBe(false);
    // The same folder can be made afterwards.
    expect(makeStoreFolder(storeFolder(root))).toBe(true);
  });

  test("making it does not remove the draft of an alarm's time: only the Store's own process does", () => {
    const folder = newStoreFolder();
    const draft = `${folder.alarm}.4242.0a1b2c3d.tmp`;
    writeFileSync(draft, "{}");
    expect(makeStoreFolder(folder)).toBe(false);
    expect(existsSync(draft)).toBe(true);
    // Nor does preparing the folder: a process does that before it holds the
    // Store. The process that holds the Store removes it.
    prepareStoreFolder(folder);
    expect(existsSync(draft)).toBe(true);
    open({ folder });
    expect(existsSync(draft)).toBe(false);
  });
});

describe("a Store's folder that lost a level", () => {
  test("a level that held nothing is put back, for the owner alone, and the file is not touched", () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    storage.sql.exec("CREATE TABLE permits (permit_no TEXT)");
    storage.sql.exec("INSERT INTO permits VALUES ('BP-2026-0412')");
    storage.close();
    opened.length = 0;
    const before = statSync(folder.database).size;
    // A copy of the disk that leaves out a folder that holds nothing.
    for (const dir of [folder.files, folder.snapshots, folder.scratch]) rmSync(dir, { recursive: true });
    expect(mendStoreFolder(folder)).toBe(true);
    for (const dir of [folder.files, folder.snapshots, folder.scratch]) expect(mode(dir)).toBe(0o700);
    expect(statSync(folder.database).size).toBe(before);
    // Nothing to put back is fine too.
    expect(mendStoreFolder(folder)).toBe(true);
  });

  test("a folder that is gone is not made again, and neither is a file that is gone", () => {
    const gone = storeFolder(path.join(tempFolder(), "s000001"));
    expect(mendStoreFolder(gone)).toBe(false);
    expect(existsSync(gone.root)).toBe(false);
    // The folder is there and the Store's file is not: it is not opened as an
    // empty Store, so no level is made in it either.
    const emptied = storeFolder(tempFolder());
    expect(mendStoreFolder(emptied)).toBe(false);
    expect(existsSync(emptied.database)).toBe(false);
    expect(existsSync(emptied.scratch)).toBe(false);
  });
});

describe("the file", () => {
  test("what was written is there when the Store is opened again", () => {
    const folder = newStoreFolder();
    const first = open({ folder });
    first.sql.exec("CREATE TABLE permits (permit_no TEXT)");
    first.sql.exec("INSERT INTO permits VALUES ('BP-2026-0412')");
    first.close();
    opened.length = 0;
    expect(open({ folder }).sql.exec("SELECT permit_no FROM permits").toArray()).toEqual([
      { permit_no: "BP-2026-0412" },
    ]);
  });

  test("is held by one process: opening it a second time is refused by SQLite", () => {
    const folder = newStoreFolder();
    open({ folder }).sql.exec("CREATE TABLE t (a)");
    // A second connection stands in for a second process: SQLite holds the
    // lock per connection.
    expect(() => new FileStorage({ folder })).toThrow(/database is locked/);
    // Not even to read.
    const reader = new Database(folder.database, { readonly: true });
    expect(() => reader.prepare("SELECT count(*) FROM t").values()).toThrow(/database is locked/);
    reader.close();
  });

  test("the settings a Store's statements count on", () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    const setting = (name: string): unknown =>
      (storage.sql.db.prepare(`PRAGMA ${name}`).values() as unknown[][]).at(0)?.at(0);
    expect(setting("journal_mode")).toBe("truncate");
    expect(setting("locking_mode")).toBe("exclusive");
    expect(setting("synchronous")).toBe(2);
    expect(setting("foreign_keys")).toBe(1);
    expect(setting("recursive_triggers")).toBe(0);
    expect(setting("auto_vacuum")).toBe(0);
  });

  test("foreign keys are enforced", () => {
    const { sql } = open();
    sql.exec("CREATE TABLE owners (id INTEGER PRIMARY KEY)");
    sql.exec("CREATE TABLE permits (owner INTEGER REFERENCES owners (id))");
    expect(() => sql.exec("INSERT INTO permits VALUES (7)")).toThrow(
      "FOREIGN KEY constraint failed: SQLITE_CONSTRAINT",
    );
  });
});

describe("transactionSync", () => {
  test("keeps everything, or nothing", () => {
    const storage = open();
    storage.sql.exec("CREATE TABLE t (n INTEGER)");
    expect(
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO t VALUES (1)");
        storage.sql.exec("INSERT INTO t VALUES (2)");
        return "done";
      }),
    ).toBe("done");
    expect(() =>
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO t VALUES (3)");
        throw new Error("no");
      }),
    ).toThrow("no");
    expect(storage.sql.exec("SELECT n FROM t ORDER BY n").toArray()).toEqual([{ n: 1 }, { n: 2 }]);
    storage.flush();
    expect(storage.sql.db.inTransaction).toBe(false);
  });

  test("one inside another undoes only its own part", () => {
    const storage = open();
    storage.sql.exec("CREATE TABLE t (n INTEGER)");
    storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO t VALUES (1)");
      expect(() =>
        storage.transactionSync(() => {
          storage.sql.exec("INSERT INTO t VALUES (2)");
          throw new Error("inner");
        }),
      ).toThrow("inner");
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO t VALUES (3)");
      });
    });
    expect(storage.sql.exec("SELECT n FROM t ORDER BY n").toArray()).toEqual([{ n: 1 }, { n: 3 }]);
  });
});

describe("when what was written is kept", () => {
  /** The moment after the work at hand: where a program that waits is. */
  const aWait = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  test("a statement that only reads opens no transaction", () => {
    const storage = open();
    storage.sql.exec("SELECT 1");
    storage.sql.exec("PRAGMA table_list");
    storage.sql.exec("EXPLAIN SELECT 1");
    expect(storage.sql.db.inTransaction).toBe(false);
  });

  test("writes with no wait between them wait together, and are kept when the program next waits", async () => {
    const storage = open({ folder: newStoreFolder() });
    storage.sql.exec("CREATE TABLE t (n INTEGER)");
    storage.sql.exec("INSERT INTO t VALUES (1)");
    storage.sql.exec("INSERT INTO t VALUES (2)");
    // One transaction of the host's own holds all three.
    expect(storage.sql.db.inTransaction).toBe(true);
    await aWait();
    expect(storage.sql.db.inTransaction).toBe(false);
    expect(storage.sql.exec("SELECT count(*) AS c FROM t").one()).toEqual({ c: 2 });
  });

  test("a wait that needs no time does not keep", async () => {
    const storage = open();
    storage.sql.exec("CREATE TABLE t (n INTEGER)");
    // Work that goes on at once, as after a promise that was settled already.
    await Promise.resolve();
    storage.sql.exec("INSERT INTO t VALUES (1)");
    expect(storage.sql.db.inTransaction).toBe(true);
  });

  test("a transaction that is not inside another one is kept when it ends", () => {
    const storage = open();
    storage.sql.exec("CREATE TABLE t (n INTEGER)");
    storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO t VALUES (1)");
      storage.transactionSync(() => storage.sql.exec("INSERT INTO t VALUES (2)"));
      // The inner one's end keeps nothing: the outer one may still be undone.
      expect(storage.sql.db.inTransaction).toBe(true);
      storage.flush();
      expect(storage.sql.db.inTransaction).toBe(true);
    });
    expect(storage.sql.db.inTransaction).toBe(false);
    expect(storage.sql.exec("SELECT count(*) AS c FROM t").one()).toEqual({ c: 2 });
  });

  test("what a transaction's work throws reaches the caller as it is", () => {
    const storage = open();
    class Refusal extends Error {}
    const thrown = new Refusal("the program's own");
    let caught: unknown = null;
    try {
      storage.transactionSync(() => {
        throw thrown;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);
  });

  test("a transaction that fails keeps nothing of itself, and leaves what waited before it", () => {
    const storage = open();
    storage.sql.exec("CREATE TABLE t (n INTEGER)");
    storage.flush();
    storage.sql.exec("INSERT INTO t VALUES (1)");
    expect(() =>
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO t VALUES (2)");
        throw new Error("no");
      }),
    ).toThrow("no");
    // The first write still waits to be kept.
    expect(storage.sql.db.inTransaction).toBe(true);
    storage.flush();
    expect(storage.sql.exec("SELECT n FROM t").toArray()).toEqual([{ n: 1 }]);
  });

  test("a setting of foreign keys takes effect between keepings, and not while writes wait, as on the platform", () => {
    const storage = open();
    const enforced = (): unknown => storage.sql.exec("PRAGMA foreign_keys").one().foreign_keys;
    storage.sql.exec("PRAGMA foreign_keys = OFF");
    expect(enforced()).toBe(0);
    storage.sql.exec("PRAGMA foreign_keys = ON");
    storage.sql.exec("CREATE TABLE t (n INTEGER)");
    // Inside the host's transaction SQLite drops the setting.
    storage.sql.exec("PRAGMA foreign_keys = OFF");
    expect(enforced()).toBe(1);
  });

  test("what cannot be kept is undone, and the owner is told", () => {
    let told = 0;
    const storage = open({ onNotKept: () => (told += 1) });
    storage.sql.exec("CREATE TABLE owners (id INTEGER PRIMARY KEY)");
    storage.sql.exec("CREATE TABLE permits (owner INTEGER REFERENCES owners (id))");
    storage.flush();
    // The check of this row's owner is put off until the keeping.
    storage.sql.exec("PRAGMA defer_foreign_keys = ON");
    storage.sql.exec("INSERT INTO permits VALUES (7)");
    expect(() => storage.flush()).toThrow("FOREIGN KEY constraint failed: SQLITE_CONSTRAINT");
    expect(told).toBe(1);
    expect(storage.sql.db.inTransaction).toBe(false);
    expect(storage.sql.exec("SELECT count(*) AS c FROM permits").one()).toEqual({ c: 0 });
  });
});

describe("the alarm", () => {
  test("one time for a Store, kept in its folder with the next keeping", async () => {
    const folder = newStoreFolder();
    const told: (number | null)[] = [];
    const storage = open({ folder, onAlarm: (at) => told.push(at) });
    expect(await storage.getAlarm()).toBeNull();
    await storage.setAlarm(1_800_000_000_000);
    expect(await storage.getAlarm()).toBe(1_800_000_000_000);
    // Not on the disk yet.
    expect(readAlarm(folder)).toBeNull();
    storage.flush();
    expect(JSON.parse(readFileSync(folder.alarm, "utf8"))).toEqual({ at: 1_800_000_000_000 });
    expect(statSync(folder.alarm).mode & 0o777).toBe(0o600);
    await storage.setAlarm(1_800_000_060_000);
    storage.flush();
    expect(readAlarm(folder)).toBe(1_800_000_060_000);
    await storage.deleteAlarm();
    expect(await storage.getAlarm()).toBeNull();
    storage.flush();
    expect(existsSync(folder.alarm)).toBe(false);
    expect(told).toEqual([1_800_000_000_000, 1_800_000_060_000, null]);
    // Nothing is left beside it.
    expect(readdirSync(folder.root).filter((name) => name.startsWith("alarm"))).toEqual([]);
  });

  test("is kept by itself when the program next waits", async () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    await storage.setAlarm(1_800_000_000_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(readAlarm(folder)).toBe(1_800_000_000_000);
  });

  test("is read again when the Store is opened", async () => {
    const folder = newStoreFolder();
    const first = open({ folder });
    await first.setAlarm(1_800_000_000_000);
    // Closing keeps what waits.
    first.close();
    opened.length = 0;
    expect(await open({ folder }).getAlarm()).toBe(1_800_000_000_000);
  });

  test("a file that is not a time is no alarm", () => {
    const folder = newStoreFolder();
    for (const text of ["", "not json", '{"at":"soon"}', '{"at":-1}', "[]", '{"at":null}']) {
      writeFileSync(folder.alarm, text);
      expect(readAlarm(folder)).toBeNull();
    }
    writeAlarm(folder, 5);
    expect(readAlarm(folder)).toBe(5);
  });

  test("a draft that a crash left behind is removed once the Store's file is held, and not before", () => {
    const folder = newStoreFolder();
    const draft = `${folder.alarm}.4242.0a1b2c3d.tmp`;
    writeFileSync(draft, '{"at":1');
    writeFileSync(`${folder.root}/alarm.json.note`, "not a draft");
    // Preparing the folder removes nothing: a process does that before it
    // knows whether it will hold the Store.
    prepareStoreFolder(folder);
    expect(existsSync(draft)).toBe(true);
    open({ folder });
    expect(existsSync(draft)).toBe(false);
    expect(existsSync(`${folder.root}/alarm.json.note`)).toBe(true);
  });

  test("an alarm that fired stays on the disk until the program has dealt with it", async () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    storage.alarm = 500;
    storage.flush();
    expect(storage.takeAlarm()).toBe(500);
    // The program sees none, and a keeping meanwhile leaves the disk as it is.
    expect(storage.alarm).toBeNull();
    storage.flush();
    expect(readAlarm(folder)).toBe(500);
    // Dealt with, and no new time: the alarm is spent.
    storage.settleAlarm(500, true);
    storage.flush();
    expect(readAlarm(folder)).toBeNull();

    // The program failed, and set no new time: the old one stands.
    storage.alarm = 700;
    storage.flush();
    storage.takeAlarm();
    storage.settleAlarm(700, false);
    expect(storage.alarm).toBe(700);
    storage.flush();
    expect(readAlarm(folder)).toBe(700);

    // The program set a new time while it dealt with the old one: the new one
    // is kept, whether it then failed or not.
    storage.takeAlarm();
    storage.alarm = 900;
    storage.flush();
    expect(readAlarm(folder)).toBe(900);
    storage.settleAlarm(700, false);
    expect(storage.alarm).toBe(900);
  });

  describe("is written before the writes it belongs to are kept when it is sooner, and after them otherwise", () => {
    /** The alarm on the disk at the moment the writes are kept: read by a
     *  trigger-free trick, a keeping that fails after the first half. */
    function atTheKeeping(from: number | null, to: number | null): number | null {
      const folder = newStoreFolder();
      const storage = open({ folder });
      storage.sql.exec("CREATE TABLE owners (id INTEGER PRIMARY KEY)");
      storage.sql.exec("CREATE TABLE permits (owner INTEGER REFERENCES owners (id))");
      storage.alarm = from;
      storage.flush();
      // A keeping that fails: the alarm's first half is written, its second is not.
      storage.sql.exec("PRAGMA defer_foreign_keys = ON");
      storage.sql.exec("INSERT INTO permits VALUES (7)");
      storage.alarm = to;
      expect(() => storage.flush()).toThrow();
      return readAlarm(folder);
    }

    test("a first time is written before", () => {
      expect(atTheKeeping(null, 500)).toBe(500);
    });

    test("a sooner time is written before", () => {
      expect(atTheKeeping(900, 500)).toBe(500);
    });

    test("a later time waits, so that the Store is not woken too late for writes that were lost", () => {
      expect(atTheKeeping(500, 900)).toBe(500);
    });

    test("no time waits, so that the Store is still woken for writes that were lost", () => {
      expect(atTheKeeping(500, null)).toBe(500);
    });
  });
});

describe("deleting everything", () => {
  test("leaves an empty Store that can be written again, and leaves the alarm", async () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    storage.sql.exec("CREATE TABLE permits (address TEXT)");
    storage.sql.exec("INSERT INTO permits VALUES ('18 Mill Road')");
    await storage.setAlarm(500);
    await storage.deleteAll();
    expect(storage.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
    expect(readFileSync(folder.database).includes("18 Mill Road")).toBe(false);
    expect(await storage.getAlarm()).toBe(500);
    // What waited was kept first: the alarm among it.
    expect(readAlarm(folder)).toBe(500);
    storage.sql.exec("CREATE TABLE again (a)");
    expect(storage.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([{ name: "again" }]);
  });

  test("cuts the Store's file where it is: the file is there at every moment", async () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    storage.sql.exec("CREATE TABLE permits (address TEXT)");
    storage.sql.exec("INSERT INTO permits VALUES ('18 Mill Road')");
    // The file as it is before, held open. A file that is removed and made
    // again would leave this one with no name, and the Store's name with no
    // file for a moment: a process that is ended in that moment leaves a
    // Store that is never opened again.
    const before = openSync(folder.database, "r");
    try {
      await storage.deleteAll();
      expect(storage.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
      // The Store takes rows again.
      storage.sql.exec("CREATE TABLE again (a)");
      storage.sql.exec("INSERT INTO again VALUES (1)");
      expect(storage.sql.exec("SELECT count(*) AS n FROM again").one().n).toBe(1);
      // Everything is kept, and the Store's file is closed. It is closed
      // before the look from before is: closing any look at a file ends this
      // process's hold on it.
      storage.close();
      // Read through the look from before: what the Store wrote after it was
      // emptied is in that same file, and none of the old rows is.
      const held = readFileSync(before).toString("latin1");
      expect(held.includes("CREATE TABLE again")).toBe(true);
      expect(held.includes("18 Mill Road")).toBe(false);
      // And the file still has its name.
      expect(fstatSync(before).nlink).toBe(1);
    } finally {
      closeSync(before);
    }
  });

  test("after a statement of every kind the storage compiles, the Store can still be emptied", async () => {
    // The storage closes its database before it cuts the file, and a
    // database with a statement left open cannot be closed. So no statement
    // that the storage itself compiles may stay open, whatever became of it.
    const folder = newStoreFolder();
    const storage = open({ folder });
    storage.sql.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)");
    storage.sql.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER)");
    storage.sql.exec("INSERT INTO a VALUES (1, 'x')");
    storage.sql.exec("INSERT INTO b VALUES (1, 1)");
    // Two columns of one name: the storage compiles a second statement to
    // tell them apart.
    expect(storage.sql.exec("SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id").toArray()).toHaveLength(1);
    // A statement that is asked twice, and is kept between the two.
    storage.sql.exec("SELECT v FROM a WHERE id = ?", 1);
    storage.sql.exec("SELECT v FROM a WHERE id = ?", 1);
    // One that SQLite fails when it runs, one it cannot compile, and one the
    // host refuses before it is compiled.
    expect(() => storage.sql.exec("INSERT INTO a VALUES (1, 'again')")).toThrow();
    expect(() => storage.sql.exec("SELECT * FROM no_such_table")).toThrow();
    expect(() => storage.sql.exec("ATTACH DATABASE 'other.sqlite' AS other")).toThrow();
    // Inside a transaction, also one that is undone.
    storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO a VALUES (2, 'y')");
      storage.sql.exec("SELECT a.id, b.id FROM a LEFT JOIN b ON b.a_id = a.id");
    });
    expect(() =>
      storage.transactionSync(() => {
        storage.sql.exec("SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id");
        throw new Error("undone");
      }),
    ).toThrow("undone");
    storage.sql.exec("EXPLAIN SELECT * FROM a");
    await storage.deleteAll();
    expect(storage.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
    // And a second time, on the database that took the first one's place.
    storage.sql.exec("CREATE TABLE a (id INTEGER PRIMARY KEY)");
    storage.sql.exec("CREATE TABLE b (id INTEGER PRIMARY KEY)");
    storage.sql.exec("SELECT a.id, b.id FROM a, b");
    await storage.deleteAll();
    expect(storage.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
  });

  test("when the database cannot be closed, nothing is emptied and the Store is as it was", async () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    storage.sql.exec("CREATE TABLE permits (address TEXT)");
    storage.sql.exec("INSERT INTO permits VALUES ('18 Mill Road')");
    // A statement that somebody compiled past the storage and left open.
    const left = storage.sql.db.prepare("SELECT 1");
    left.get();
    await expect(storage.deleteAll()).rejects.toThrow();
    expect(storage.sql.exec("SELECT address FROM permits").toArray()).toEqual([{ address: "18 Mill Road" }]);
    storage.sql.exec("INSERT INTO permits VALUES ('7 Alder Court')");
    // With the statement gone, the Store is emptied.
    left.finalize();
    await storage.deleteAll();
    expect(storage.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
  });

  test("is refused inside a transaction, which could not undo it", async () => {
    const storage = open();
    storage.sql.exec("CREATE TABLE permits (address TEXT)");
    let refusal: unknown = null;
    storage.transactionSync(() => {
      void storage.deleteAll().catch((thrown: unknown) => (refusal = thrown));
      storage.sql.exec("INSERT INTO permits VALUES ('18 Mill Road')");
    });
    await Promise.resolve();
    expect(String(refusal)).toContain("cannot be emptied inside a transaction");
    expect(storage.sql.exec("SELECT count(*) AS c FROM permits").one()).toEqual({ c: 1 });
  });
});

describe("a storage that was closed", () => {
  test("refuses every call, and does not open the file again", async () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    storage.sql.exec("CREATE TABLE t (a)");
    storage.close();
    storage.close();
    expect(() => storage.sql.exec("SELECT 1")).toThrow("closed");
    expect(() => storage.transactionSync(() => 1)).toThrow("closed");
    expect(() => (storage.alarm = 5)).toThrow("closed");
    await expect(storage.deleteAll()).rejects.toThrow("closed");
    // The file is free for the next process, with what was written kept.
    const next = open({ folder });
    expect(next.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([{ name: "t" }]);
  });
});

describe("a Store that is kept in memory", () => {
  test("keeps no bookmark, and answers as a store with no way back", async () => {
    const storage = open();
    expect(storage.pointInTime).toBe(false);
    expect(await storage.getCurrentBookmark()).toBe(NO_BOOKMARK);
    await expect(storage.getBookmarkForTime()).rejects.toThrow(/point-in-time/);
    await expect(storage.onNextSessionRestoreBookmark("00000001-0123456789abcdef01234567")).rejects.toThrow(/not implement/);
    expect(storage.holdsBookmark("00000001-0123456789abcdef01234567")).toBe(false);
  });
});

// ── Bookmarks: snapshots of the Store's file ─────────────────────────────────

const BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{24}$/;
const snapshotOf = (folder: StoreFolder, bookmark: string): string => path.join(folder.snapshots, `${bookmark}.sqlite`);

/** The numbers in a table `t (n)` of a SQLite file, read by this runtime's
 *  own SQLite and by nothing of the storage. */
function numbersIn(file: string): number[] {
  const database = new Database(file, { readonly: true });
  try {
    return (database.prepare("SELECT n FROM t ORDER BY n").values() as number[][]).map((row) => row.at(0) as number);
  } finally {
    database.close();
  }
}

const numbers = (storage: FileStorage): number[] =>
  storage.sql
    .exec<{ n: number }>("SELECT n FROM t ORDER BY n")
    .toArray()
    .map((row) => row.n);

/** A Store with a table `t` that holds 1, and a bookmark of that moment. */
async function storeWithBookmark(
  options: ConstructorParameters<typeof FileStorage>[0] = {},
): Promise<{ folder: StoreFolder; storage: FileStorage; bookmark: string }> {
  const folder = options?.folder ?? newStoreFolder();
  const storage = open({ ...options, folder });
  storage.sql.exec("CREATE TABLE t (n INTEGER)");
  storage.sql.exec("INSERT INTO t VALUES (1)");
  return { folder, storage, bookmark: await storage.getCurrentBookmark() };
}

/** Close a Store and open it again, as its next process does. */
function reopen(storage: FileStorage, options: ConstructorParameters<typeof FileStorage>[0]): FileStorage {
  storage.close();
  return open(options);
}

describe("a bookmark is a snapshot of the Store's file", () => {
  test("it names the Store as it is, with what waited kept first, in a whole copy for the owner alone", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    expect(storage.pointInTime).toBe(true);
    // A name of this host's own, and never the zeros that mean "none".
    expect(bookmark).toMatch(BOOKMARK);
    expect(bookmark).not.toMatch(/^[0-]+$/);
    expect(readdirSync(folder.snapshots)).toEqual([`${bookmark}.sqlite`]);
    expect(mode(snapshotOf(folder, bookmark))).toBe(0o600);
    // The row was written with no wait before the bookmark was asked for, and
    // it is in the copy: a database by itself, which SQLite opens.
    expect(numbersIn(snapshotOf(folder, bookmark))).toEqual([1]);
    expect(statSync(snapshotOf(folder, bookmark)).size).toBe(statSync(folder.database).size);
    expect(storage.holdsBookmark(bookmark)).toBe(true);
    // The Store goes on as it was.
    storage.sql.exec("INSERT INTO t VALUES (2)");
    expect(numbers(storage)).toEqual([1, 2]);
    expect(numbersIn(snapshotOf(folder, bookmark))).toEqual([1]);
  });

  test("two with no change between them are one snapshot, and any change makes another", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    expect(await storage.getCurrentBookmark()).toBe(bookmark);
    // A statement that only reads changes nothing.
    expect(numbers(storage)).toEqual([1]);
    expect(await storage.getCurrentBookmark()).toBe(bookmark);
    expect(readdirSync(folder.snapshots)).toHaveLength(1);

    const taken = [bookmark];
    const changes: (() => void)[] = [
      () => storage.sql.exec("INSERT INTO t VALUES (2)"),
      () => storage.sql.exec("UPDATE t SET n = n + 10 WHERE n = 2"),
      () => storage.sql.exec("CREATE TABLE other (a)"),
      () => storage.transactionSync(() => storage.sql.exec("DELETE FROM t WHERE n = 12")),
      () => storage.sql.exec("DROP TABLE other"),
    ];
    for (const change of changes) {
      change();
      const next = await storage.getCurrentBookmark();
      expect(taken).not.toContain(next);
      taken.push(next);
      // And again with nothing between: the same one.
      expect(await storage.getCurrentBookmark()).toBe(next);
    }
    // In the order they were taken, which is the order of their names.
    expect(listSnapshots(folder)).toEqual(taken);
    expect([...taken].sort()).toEqual(taken);
  });

  test("a statement that writes the file and moves none of SQLite's own counters makes a new snapshot too", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    storage.sql.exec("CREATE INDEX t_n ON t (n)");
    const indexed = await storage.getCurrentBookmark();
    expect(indexed).not.toBe(bookmark);
    // Neither SQLite's count of changed rows nor its schema version moves for
    // this statement, and it writes the file all the same. The storage goes
    // by what it was told was written, too.
    const mark = storage.sql.changeMark();
    storage.sql.exec("REINDEX");
    storage.flush();
    expect(storage.sql.changeMark()).toBe(mark);
    expect(await storage.getCurrentBookmark()).not.toBe(indexed);
    expect(readdirSync(folder.snapshots)).toHaveLength(3);
  });

  test("a change that went past the storage's own transaction is a change too", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    // Written on the database itself, as only the host's own code can: the
    // storage was told of no write. SQLite's own count of changed rows says so.
    storage.sql.db.run("INSERT INTO t VALUES (7)");
    const next = await storage.getCurrentBookmark();
    expect(next).not.toBe(bookmark);
    expect(numbersIn(snapshotOf(folder, next))).toEqual([1, 7]);
    // And a change of the schema alone.
    storage.sql.db.run("CREATE TABLE beside (a)");
    expect(await storage.getCurrentBookmark()).not.toBe(next);
  });

  test("a change that was undone is no change of the Store, and still a new snapshot is a whole one", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    expect(() =>
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO t VALUES (99)");
        throw new Error("undone");
      }),
    ).toThrow("undone");
    const next = await storage.getCurrentBookmark();
    // Nothing of the Store changed. The storage may still take a new copy: it
    // never answers an older moment for a newer one.
    expect(numbersIn(snapshotOf(folder, next))).toEqual([1]);
    expect(numbersIn(snapshotOf(folder, bookmark))).toEqual([1]);
  });

  test("inside a transaction no bookmark is taken", async () => {
    const { folder, storage } = await storeWithBookmark();
    let asked: Promise<string> | null = null;
    storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO t VALUES (2)");
      asked = storage.getCurrentBookmark();
      asked.catch(() => undefined);
    });
    await expect(asked as unknown as Promise<string>).rejects.toThrow("inside a transaction");
    expect(readdirSync(folder.snapshots)).toHaveLength(1);
  });

  test("the numbers go on in the Store's next process", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    storage.sql.exec("INSERT INTO t VALUES (2)");
    const second = await storage.getCurrentBookmark();
    const next = reopen(storage, { folder });
    // Nothing changed, and still a new one: what an earlier process took is
    // not taken for the Store as it is now.
    const third = await next.getCurrentBookmark();
    expect(listSnapshots(folder)).toEqual([bookmark, second, third]);
    expect(numbersIn(snapshotOf(folder, third))).toEqual([1, 2]);
    // Each still names its own moment.
    expect(next.holdsBookmark(bookmark)).toBe(true);
    expect(numbersIn(snapshotOf(folder, bookmark))).toEqual([1]);
  });

  test("a Store keeps its newest snapshots, and the older ones leave the disk", async () => {
    expect(SNAPSHOTS_KEPT).toBe(10);
    const { folder, storage, bookmark } = await storeWithBookmark({ snapshots: { kept: 3 } });
    const taken = [bookmark];
    for (let n = 2; n <= 6; n += 1) {
      storage.sql.exec("INSERT INTO t VALUES (?)", n);
      taken.push(await storage.getCurrentBookmark());
    }
    expect(listSnapshots(folder)).toEqual(taken.slice(-3));
    for (const gone of taken.slice(0, 3)) expect(storage.holdsBookmark(gone)).toBe(false);
    for (const held of taken.slice(-3)) expect(storage.holdsBookmark(held)).toBe(true);
    // Nothing else is in the folder: no draft, no older copy.
    expect(readdirSync(folder.snapshots).sort()).toEqual(taken.slice(-3).map((held) => `${held}.sqlite`));
  });

  test("a Store whose file is too large keeps none, and says what a host with no way back says", async () => {
    const folder = newStoreFolder();
    const small = await storeWithBookmark({ folder, snapshots: { storeMaxBytes: 64 * 1024 } });
    expect(small.bookmark).toMatch(BOOKMARK);
    // The Store grows past what it may be and still keep snapshots.
    small.storage.sql.exec("CREATE TABLE big (body TEXT)");
    for (let n = 0; n < 40; n += 1) small.storage.sql.exec("INSERT INTO big VALUES (?)", "x".repeat(4_000));
    small.storage.flush();
    expect(statSync(folder.database).size).toBeGreaterThan(64 * 1024);
    // From here on it holds no moment, also not the one it took while it was
    // small: its snapshot is still in the folder, and is no way back. And it
    // goes back to nothing: there would be no copy of the Store as it is, to
    // undo the going back with.
    expect(readdirSync(folder.snapshots)).toEqual([`${small.bookmark}.sqlite`]);
    expect(small.storage.holdsBookmark(small.bookmark)).toBe(false);
    await expect(small.storage.onNextSessionRestoreBookmark(small.bookmark)).rejects.toThrow(/point-in-time/);
    expect(readRestore(folder)).toBeNull();
    expect(existsSync(folder.restored)).toBe(false);
    // Asked for a bookmark, it makes no copy, and the old snapshot goes: it
    // only took room.
    expect(await small.storage.getCurrentBookmark()).toBe(NO_BOOKMARK);
    expect(await small.storage.getCurrentBookmark()).toBe(NO_BOOKMARK);
    expect(readdirSync(folder.snapshots)).toEqual([]);
    // Small again, it keeps them again.
    small.storage.sql.exec("DROP TABLE big");
    small.storage.flush();
    small.storage.sql.db.run("VACUUM");
    const again = await small.storage.getCurrentBookmark();
    expect(again).toMatch(BOOKMARK);
    expect(small.storage.holdsBookmark(again)).toBe(true);
  });

  test("a value that is no bookmark of this Store is held by nothing: no path is made of it", async () => {
    const { folder, storage } = await storeWithBookmark();
    const outside = path.join(path.dirname(folder.root), "outside.sqlite");
    writeFileSync(outside, "");
    // A folder and a link, each under a name that a snapshot could have.
    mkdirSync(path.join(folder.snapshots, "0000000a-00000000000000000000000a.sqlite"));
    symlinkSync(outside, path.join(folder.snapshots, "0000000b-00000000000000000000000b.sqlite"));
    for (const value of [
      "no such bookmark",
      "",
      "../store",
      "../../outside",
      `${"0".repeat(8)}-${"0".repeat(24)}/../../outside`,
      "0000000a-00000000000000000000000a",
      "0000000b-00000000000000000000000b",
      "0000000c-00000000000000000000000c",
      "0000000C-00000000000000000000000C",
      NO_BOOKMARK,
      null,
      7,
    ]) {
      expect([value, storage.holdsBookmark(value)]).toEqual([value, false]);
      await expect(storage.onNextSessionRestoreBookmark(value as string)).rejects.toThrow("no longer holds that moment");
    }
    expect(readRestore(folder)).toBeNull();
    expect(readFileSync(outside, "utf8")).toBe("");
  });
});

describe("going back to a bookmark", () => {
  test("happens when the Store is next opened, and not before, and the answer is a bookmark of the moment before", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    storage.sql.exec("INSERT INTO t VALUES (2)");
    const undo = await storage.onNextSessionRestoreBookmark(bookmark);
    expect(undo).toMatch(BOOKMARK);
    expect(undo).not.toBe(bookmark);
    // Nothing changes until the Store is opened again. What waits is on the disk.
    expect(numbers(storage)).toEqual([1, 2]);
    expect(readRestore(folder)).toBe(bookmark);
    expect(mode(folder.restore)).toBe(0o600);
    // What is written meanwhile does not outlast the going back.
    storage.sql.exec("INSERT INTO t VALUES (3)");

    const back = reopen(storage, { folder });
    expect(numbers(back)).toEqual([1]);
    expect(readRestore(folder)).toBeNull();
    expect(readdirSync(folder.root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(mode(folder.database)).toBe(0o600);
    // The Store takes writes, and both snapshots are still there.
    back.sql.exec("INSERT INTO t VALUES (10)");
    expect(numbers(back)).toEqual([1, 10]);
    expect(numbersIn(snapshotOf(folder, bookmark))).toEqual([1]);
    expect(numbersIn(snapshotOf(folder, undo))).toEqual([1, 2]);

    // The going back is undone the same way: the Store as it was just before.
    await back.onNextSessionRestoreBookmark(undo);
    expect(numbers(reopen(back, { folder }))).toEqual([1, 2]);
  });

  test("with nothing changed since the bookmark, the moment before is that same moment", async () => {
    const { storage, bookmark } = await storeWithBookmark();
    expect(await storage.onNextSessionRestoreBookmark(bookmark)).toBe(bookmark);
  });

  test("the snapshot a going back waits for stays, however many are taken after it", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark({ snapshots: { kept: 2 } });
    for (let n = 2; n <= 3; n += 1) {
      storage.sql.exec("INSERT INTO t VALUES (?)", n);
      await storage.getCurrentBookmark();
    }
    // Two newer ones are kept, and the first one is gone.
    expect(storage.holdsBookmark(bookmark)).toBe(false);
    const oldest = listSnapshots(folder).at(0) as string;
    storage.sql.exec("INSERT INTO t VALUES (4)");
    // Asked to go back to the oldest one it holds: the copy of the moment
    // before makes three, and the one to go back to is not removed for it.
    const undo = await storage.onNextSessionRestoreBookmark(oldest);
    expect(storage.holdsBookmark(oldest)).toBe(true);
    for (let n = 5; n <= 8; n += 1) {
      storage.sql.exec("INSERT INTO t VALUES (?)", n);
      await storage.getCurrentBookmark();
    }
    expect(storage.holdsBookmark(oldest)).toBe(true);
    expect(storage.holdsBookmark(undo)).toBe(false);
    expect(numbers(reopen(storage, { folder, snapshots: { kept: 2 } }))).toEqual([1, 2]);
  });

  test("a snapshot that is told to stay is not removed to make room while this process runs", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark({ snapshots: { kept: 1 } });
    // What the engine does for a restore: first a bookmark of the Store as it
    // is, and only then the going back. With one snapshot kept, that bookmark
    // would push out the one to go back to.
    storage.keepBookmark(bookmark);
    storage.sql.exec("INSERT INTO t VALUES (2)");
    const now = await storage.getCurrentBookmark();
    expect(now).not.toBe(bookmark);
    expect(storage.holdsBookmark(bookmark)).toBe(true);
    // Nothing changed since: the moment before is the bookmark just taken.
    expect(await storage.onNextSessionRestoreBookmark(bookmark)).toBe(now);
    expect(numbers(reopen(storage, { folder, snapshots: { kept: 1 } }))).toEqual([1]);
  });

  test("not told to stay, it is removed for the next one, and the Store cannot go back to it", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark({ snapshots: { kept: 1 } });
    // A value that is no bookmark is kept under no name.
    storage.keepBookmark("../store");
    storage.keepBookmark(`${bookmark}x`);
    storage.sql.exec("INSERT INTO t VALUES (2)");
    await storage.getCurrentBookmark();
    expect(storage.holdsBookmark(bookmark)).toBe(false);
    await expect(storage.onNextSessionRestoreBookmark(bookmark)).rejects.toThrow("no longer holds that moment");
    expect(readRestore(folder)).toBeNull();
  });

  test("the storage says whether a going back waits", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    expect(storage.restoreWaits).toBe(false);
    storage.sql.exec("INSERT INTO t VALUES (2)");
    await storage.onNextSessionRestoreBookmark(bookmark);
    expect(storage.restoreWaits).toBe(true);
    const back = reopen(storage, { folder });
    expect(back.restoreWaits).toBe(false);
    // A request that cannot be read counts as one that waits: the Store's
    // next opening refuses it.
    writeFileSync(folder.restore, "{");
    expect(back.restoreWaits).toBe(true);
    rmSync(folder.restore);
    // A Store kept in memory goes back to nothing.
    expect(open().restoreWaits).toBe(false);
  });

  test("emptying the Store removes its snapshots and a going back that waited", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    storage.sql.exec("INSERT INTO t VALUES (2)");
    await storage.onNextSessionRestoreBookmark(bookmark);
    expect(readdirSync(folder.snapshots)).toHaveLength(2);
    await storage.deleteAll();
    expect(readdirSync(folder.snapshots)).toEqual([]);
    expect(readRestore(folder)).toBeNull();
    expect(storage.holdsBookmark(bookmark)).toBe(false);
    // It stays empty at its next opening, and keeps bookmarks again.
    const next = reopen(storage, { folder });
    expect(next.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
    next.sql.exec("CREATE TABLE t (n INTEGER)");
    expect(await next.getCurrentBookmark()).toMatch(BOOKMARK);
  });

  test("emptying drops the going back first: a Store whose snapshots cannot be removed does not go back", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    storage.sql.exec("INSERT INTO t VALUES (2)");
    await storage.onNextSessionRestoreBookmark(bookmark);
    // Something that the removal of a file does not take away, under a
    // snapshot's name that comes before every other: the removal stops at it,
    // with every snapshot still there.
    mkdirSync(path.join(folder.snapshots, `00000000-${"a".repeat(24)}.sqlite`));
    await expect(storage.deleteAll()).rejects.toThrow();
    expect(storage.holdsBookmark(bookmark)).toBe(true);
    // The request went first. So the Store, which was not emptied, is as it
    // was when it is opened again: it has not gone back.
    expect(readRestore(folder)).toBeNull();
    const next = reopen(storage, { folder });
    expect(next.sql.exec("SELECT n FROM t ORDER BY n").toArray()).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("a storage that is told it keeps no bookmark answers as a host with no way back", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    storage.pointInTime = false;
    expect(await storage.getCurrentBookmark()).toBe(NO_BOOKMARK);
    await expect(storage.getBookmarkForTime()).rejects.toThrow(/point-in-time/);
    await expect(storage.onNextSessionRestoreBookmark(bookmark)).rejects.toThrow(/not implement/);
    expect(storage.holdsBookmark(bookmark)).toBe(false);
    expect(readRestore(folder)).toBeNull();
  });

  test("to a time it does not go: the words are not those of a host with no way back", async () => {
    const { storage } = await storeWithBookmark();
    const refused = await storage.getBookmarkForTime().catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(Error);
    // The engine reads these three for "this host keeps no earlier moment".
    expect((refused as Error).message).not.toMatch(/point-in-time|not implement|not supported/i);
    expect((refused as Error).message).toContain("a line of the Store's history");
  });
});

describe("a going back that waits, when the Store is opened", () => {
  /** A Store that holds 1 and 2, closed, with a going back to the moment it
   *  held only 1 waiting. */
  async function waiting(): Promise<{ folder: StoreFolder; bookmark: string; undo: string }> {
    const { folder, storage, bookmark } = await storeWithBookmark();
    storage.sql.exec("INSERT INTO t VALUES (2)");
    const undo = await storage.onNextSessionRestoreBookmark(bookmark);
    storage.close();
    return { folder, bookmark, undo };
  }

  test("is carried out once: a second look finds nothing waiting", async () => {
    const { folder } = await waiting();
    expect(applyRestore(folder)).toBe("restored");
    expect(numbersIn(folder.database)).toEqual([1]);
    expect(applyRestore(folder)).toBe("none");
    expect(numbers(open({ folder }))).toEqual([1]);
  });

  test("the copy is made when the going back is asked for, and the opening only gives it the file's name", async () => {
    const { folder, bookmark } = await waiting();
    // Whole, for the owner alone, and the snapshot's own bytes.
    expect(mode(folder.restored)).toBe(0o600);
    expect(numbersIn(folder.restored)).toEqual([1]);
    expect(readFileSync(folder.restored).equals(readFileSync(snapshotOf(folder, bookmark)))).toBe(true);
    const readied = statSync(folder.restored).ino;
    // The snapshot is not read again: with it gone, the Store goes back all
    // the same, and its file is the very file that was readied.
    rmSync(snapshotOf(folder, bookmark));
    expect(applyRestore(folder)).toBe("restored");
    expect(statSync(folder.database).ino).toBe(readied);
    expect(existsSync(folder.restored)).toBe(false);
    expect(numbers(open({ folder }))).toEqual([1]);
  });

  test("a readied copy that is gone or cut is made again from the snapshot", async () => {
    for (const damage of [
      (file: string): void => rmSync(file),
      (file: string): void => truncateSync(file, statSync(file).size - 4_096),
      (file: string): void => writeFileSync(file, ""),
    ]) {
      const { folder } = await waiting();
      damage(folder.restored);
      expect(applyRestore(folder)).toBe("restored");
      expect(existsSync(folder.restored)).toBe(false);
      expect(numbers(open({ folder }))).toEqual([1]);
    }
  });

  test("a process that was ended after the copy took the file's name goes back once more, to the same Store", async () => {
    const { folder, bookmark } = await waiting();
    // As the disk is then: the copy has the Store's name, and the request
    // still waits.
    renameSync(folder.restored, folder.database);
    expect(readRestore(folder)).toBe(bookmark);
    expect(numbers(open({ folder }))).toEqual([1]);
    expect(readRestore(folder)).toBeNull();
  });

  test("a readied copy with no request is nobody's: it is removed, and the Store is as it was", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    storage.sql.exec("INSERT INTO t VALUES (2)");
    storage.close();
    // As after a process that was ended between the copy and the request.
    copyFileSync(snapshotOf(folder, bookmark), folder.restored);
    expect(numbers(open({ folder }))).toEqual([1, 2]);
    expect(existsSync(folder.restored)).toBe(false);
  });

  test("a second going back takes the place of the first: one request waits, with its own copy", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    storage.sql.exec("INSERT INTO t VALUES (2)");
    const second = await storage.getCurrentBookmark();
    storage.sql.exec("INSERT INTO t VALUES (3)");
    await storage.onNextSessionRestoreBookmark(bookmark);
    expect(numbersIn(folder.restored)).toEqual([1]);
    await storage.onNextSessionRestoreBookmark(second);
    expect(readRestore(folder)).toBe(second);
    expect(numbersIn(folder.restored)).toEqual([1, 2]);
    expect(numbers(reopen(storage, { folder }))).toEqual([1, 2]);
  });

  test("a going back that cannot be readied leaves nothing waiting", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    storage.sql.exec("INSERT INTO t VALUES (2)");
    // Something that is no file stands where the copy goes: it cannot take
    // its name.
    mkdirSync(folder.restored);
    writeFileSync(path.join(folder.restored, "kept"), "x");
    await expect(storage.onNextSessionRestoreBookmark(bookmark)).rejects.toThrow();
    expect(readRestore(folder)).toBeNull();
    expect(storage.restoreWaits).toBe(false);
    rmSync(folder.restored, { recursive: true });
    // The Store goes on, and is as it was at its next opening.
    expect(numbers(reopen(storage, { folder }))).toEqual([1, 2]);
  });

  test("a process that was ended in the middle left a draft: the next opening starts over and removes it", async () => {
    const { folder } = await waiting();
    // As after a process that was ended while it copied.
    writeFileSync(`${folder.database}.4242.0a1b2c3d.tmp`, "half a copy");
    expect(numbers(open({ folder }))).toEqual([1]);
    expect(readdirSync(folder.root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readRestore(folder)).toBeNull();
  });

  test("the journal of the Store as it was goes: its pages are not written into the copy", async () => {
    const { folder } = await waiting();
    // What a process leaves that was ended in the middle of a change. SQLite
    // takes a journal beside a file for that file's unfinished work.
    for (const suffix of ["-journal", "-wal", "-shm"]) writeFileSync(`${folder.database}${suffix}`, "pages of the Store as it was");
    expect(applyRestore(folder)).toBe("restored");
    for (const suffix of ["-journal", "-wal", "-shm"]) expect(existsSync(`${folder.database}${suffix}`)).toBe(false);
    expect(numbers(open({ folder }))).toEqual([1]);
  });

  test("opened by the storage with such a journal beside it, the Store is the snapshot's copy all the same", async () => {
    const { folder } = await waiting();
    writeFileSync(`${folder.database}-journal`, "pages of the Store as it was");
    const back = open({ folder });
    expect(numbers(back)).toEqual([1]);
    back.sql.exec("INSERT INTO t VALUES (5)");
    expect(numbers(reopen(back, { folder }))).toEqual([1, 5]);
  });

  test("where the copy and the snapshot are both gone, the Store is opened as it is and the request is dropped", async () => {
    const { folder, bookmark } = await waiting();
    rmSync(folder.restored);
    rmSync(snapshotOf(folder, bookmark));
    expect(applyRestore(folder)).toBe("not_restored");
    expect(readRestore(folder)).toBeNull();
    expect(numbers(open({ folder }))).toEqual([1, 2]);
  });

  test("a file that is no whole database file is not put in the Store's place", async () => {
    for (const damage of [
      (file: string): void => truncateSync(file, 1_000),
      (file: string): void => truncateSync(file, statSync(file).size - 1),
      // Cut at the end of a page: every page that is left is a whole one, and
      // the file's own first page still says how many it had.
      (file: string): void => truncateSync(file, statSync(file).size - 4_096),
      (file: string): void => writeFileSync(file, "x".repeat(8_192)),
      // No bytes at all: a Store's file holds its first page from its first
      // opening, so this is no Store that held nothing.
      (file: string): void => writeFileSync(file, ""),
      // A link to a whole database elsewhere is no file of the Store's own.
      (file: string): void => {
        const elsewhere = path.join(tempFolder("elsewhere"), "whole.sqlite");
        renameSync(file, elsewhere);
        symlinkSync(elsewhere, file);
      },
      // A pipe under the file's name: opening it must not wait for a writer.
      (file: string): void => {
        rmSync(file);
        const made = Bun.spawnSync(["mkfifo", file]);
        if (made.exitCode !== 0) throw new Error("no pipe could be made for this test");
      },
    ]) {
      const { folder, bookmark } = await waiting();
      // The copy and the snapshot it would be made again from.
      damage(folder.restored);
      damage(snapshotOf(folder, bookmark));
      expect(applyRestore(folder)).toBe("not_restored");
      expect(readRestore(folder)).toBeNull();
      expect(existsSync(folder.restored)).toBe(false);
      expect(numbersIn(folder.database)).toEqual([1, 2]);
    }
  });

  test("a snapshot of a Store that held nothing yet takes the Store back to nothing", async () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    const empty = await storage.getCurrentBookmark();
    storage.sql.exec("CREATE TABLE t (n INTEGER)");
    await storage.onNextSessionRestoreBookmark(empty);
    const back = reopen(storage, { folder });
    expect(back.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
    back.sql.exec("CREATE TABLE again (a)");
  });


  test("a request that cannot be read keeps the Store shut, and touches nothing", async () => {
    for (const text of ["", "not json", "{}", "null", '{"bookmark":7}', '{"bookmark":"../store"}', '{"bookmark":"0000000G-00000000000000000000000a"}']) {
      const { folder } = await waiting();
      writeFileSync(folder.restore, text);
      let thrown: { code?: unknown } | null = null;
      try {
        new FileStorage({ folder }).close();
      } catch (error) {
        thrown = error as { code?: unknown };
      }
      expect([text, thrown?.code]).toEqual([text, "restore_unreadable"]);
      expect(numbersIn(folder.database)).toEqual([1, 2]);
    }
  });

  test("a draft of a snapshot that a crash left is no snapshot, and is removed when the folder is prepared", async () => {
    const { folder, storage, bookmark } = await storeWithBookmark();
    storage.close();
    const draft = path.join(folder.snapshots, "0000ffff-0123456789abcdef01234567.sqlite.4242.0a1b2c3d.tmp");
    writeFileSync(draft, "half a copy");
    expect(listSnapshots(folder)).toEqual([bookmark]);
    const next = open({ folder });
    expect(existsSync(draft)).toBe(false);
    expect(next.holdsBookmark(bookmark)).toBe(true);
  });

  test("the request is written by the storage alone, and can be dropped by hand with nothing else changed", async () => {
    const { folder, bookmark } = await waiting();
    expect(readRestore(folder)).toBe(bookmark);
    writeRestore(folder, null);
    expect(existsSync(folder.restore)).toBe(false);
    expect(numbers(open({ folder }))).toEqual([1, 2]);
  });
});
