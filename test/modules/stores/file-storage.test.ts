import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { FileStorage, NO_BOOKMARK } from "../../../src/modules/stores/host/file-storage";
import {
  folderBytes,
  freeBytes,
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

  test("its size is what its files take, and the disk says what is free", () => {
    const folder = newStoreFolder();
    const storage = open({ folder });
    storage.sql.exec("CREATE TABLE t (a TEXT)");
    storage.sql.exec("INSERT INTO t VALUES (?)", "x".repeat(100_000));
    storage.flush();
    writeFileSync(`${folder.files}/one`, "12345");
    const bytes = folderBytes(folder.root);
    expect(bytes).toBeGreaterThan(100_000);
    expect(bytes).toBe(statSync(folder.database).size + 5);
    expect(storage.sql.databaseSize).toBe(statSync(folder.database).size);
    expect(freeBytes(folder.root)).toBeGreaterThan(0);
    expect(folderBytes(`${folder.root}/not-there`)).toBe(0);
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
    expect(storage.deleteAll()).rejects.toThrow("closed");
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
    expect(storage.getBookmarkForTime()).rejects.toThrow(/point-in-time/);
    expect(storage.onNextSessionRestoreBookmark()).rejects.toThrow(/not implement/);
  });
});
