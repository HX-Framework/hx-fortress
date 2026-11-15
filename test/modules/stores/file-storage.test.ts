import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FileStorage, NO_BOOKMARK } from "../../../src/modules/stores/host/file-storage";
import {
  folderBytes,
  freeBytes,
  makeStoreFolder,
  mendStoreFolder,
  prepareStoreFolder,
  readAlarm,
  storeFolder,
  writeAlarm,
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
    // The process that holds the Store removes a draft a crash left behind.
    prepareStoreFolder(folder);
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

  test("a draft that a crash left behind is removed when the folder is prepared", () => {
    const folder = newStoreFolder();
    const draft = `${folder.alarm}.4242.0a1b2c3d.tmp`;
    writeFileSync(draft, '{"at":1');
    writeFileSync(`${folder.root}/alarm.json.note`, "not a draft");
    prepareStoreFolder(folder);
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

describe("bookmarks, until the restore is built", () => {
  test("answer as a store with no way back", async () => {
    const storage = open();
    expect(storage.pointInTime).toBe(false);
    expect(await storage.getCurrentBookmark()).toBe(NO_BOOKMARK);
    await expect(storage.getBookmarkForTime()).rejects.toThrow(/point-in-time/);
    await expect(storage.onNextSessionRestoreBookmark()).rejects.toThrow(/not implement/);
  });
});
