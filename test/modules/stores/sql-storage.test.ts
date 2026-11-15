import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

import { FileStorage } from "../../../src/modules/stores/host/file-storage";
import { SqlRefused, SQL_LIMITS } from "../../../src/modules/stores/host/sql-guard";
import {
  SqliteFailure,
  StoreReachBroken,
  StoreSql,
  StoreTransactionLost,
} from "../../../src/modules/stores/host/sql-storage";
import { cleanFolders, newStoreFolder, tempFolder } from "./_rig";

const opened: FileStorage[] = [];
function memoryStore(): FileStorage {
  const storage = new FileStorage();
  opened.push(storage);
  return storage;
}

afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
  cleanFolders();
});

function thrownBy(work: () => unknown): Error {
  try {
    work();
  } catch (thrown) {
    return thrown as Error;
  }
  throw new Error("nothing was thrown");
}

describe("the cursor", () => {
  test("rows as objects, the columns' names, and how many rows", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE permits (permit_no TEXT PRIMARY KEY, kind TEXT, fee REAL)");
    sql.exec("INSERT INTO permits VALUES (?, ?, ?), (?, ?, ?)", "BP-1", "Deck", 120.5, "BP-2", "Roof", 80);
    const cursor = sql.exec("SELECT permit_no, kind, fee FROM permits ORDER BY permit_no");
    expect(cursor.columnNames).toEqual(["permit_no", "kind", "fee"]);
    expect(cursor.rowsRead).toBe(2);
    expect(cursor.rowsWritten).toBe(0);
    expect(cursor.toArray()).toEqual([
      { permit_no: "BP-1", kind: "Deck", fee: 120.5 },
      { permit_no: "BP-2", kind: "Roof", fee: 80 },
    ]);
    // Read once.
    expect(cursor.toArray()).toEqual([]);
  });

  test("next, iteration, raw and one each read what is left", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE t (n INTEGER)");
    sql.exec("INSERT INTO t VALUES (1), (2), (3), (4)");
    const cursor = sql.exec<{ n: number }>("SELECT n FROM t ORDER BY n");
    expect(cursor.next()).toEqual({ done: false, value: { n: 1 } });
    const seen: number[] = [];
    for (const row of cursor) {
      seen.push(row.n);
      if (row.n === 2) break;
    }
    expect(seen).toEqual([2]);
    expect([...cursor.raw()]).toEqual([[3], [4]]);
    expect(cursor.next()).toEqual({ done: true, value: undefined });

    expect(sql.exec("SELECT count(*) AS c FROM t").one()).toEqual({ c: 4 });
    expect(thrownBy(() => sql.exec("SELECT n FROM t").one()).message).toBe(
      "Expected exactly one result from SQL query, but got multiple results.",
    );
    expect(thrownBy(() => sql.exec("SELECT n FROM t WHERE n > 9").one()).message).toBe(
      "Expected exactly one result from SQL query, but got no results.",
    );
  });

  test("rowsWritten counts the rows a statement changed", () => {
    const { sql } = memoryStore();
    expect(sql.exec("CREATE TABLE t (n INTEGER)").rowsWritten).toBe(0);
    expect(sql.exec("INSERT INTO t VALUES (1), (2), (3)").rowsWritten).toBe(3);
    expect(sql.exec("UPDATE t SET n = n + 1 WHERE n > 1").rowsWritten).toBe(2);
    expect(sql.exec("DELETE FROM t").rowsWritten).toBe(3);
    expect(sql.exec("SELECT 1").rowsWritten).toBe(0);
  });

  test("bytes go in as an ArrayBuffer or a view, and come back as an ArrayBuffer", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE f (id INTEGER, body BLOB)");
    sql.exec("INSERT INTO f VALUES (1, ?)", new Uint8Array([1, 2, 3]).buffer);
    sql.exec("INSERT INTO f VALUES (2, ?)", new Uint8Array([9, 8, 7, 6]).subarray(1, 3));
    const rows = sql.exec<{ body: ArrayBuffer }>("SELECT body FROM f ORDER BY id").toArray();
    expect(rows.map((row) => row.body instanceof ArrayBuffer)).toEqual([true, true]);
    expect(rows.map((row) => [...new Uint8Array(row.body)])).toEqual([[1, 2, 3], [8, 7]]);
  });

  test("text, numbers and null come back as they are", () => {
    const { sql } = memoryStore();
    const row = sql.exec("SELECT ? AS t, ? AS i, ? AS r, ? AS n", "18 Mill Road", 42, 1.5, null).one();
    expect(row).toEqual({ t: "18 Mill Road", i: 42, r: 1.5, n: null });
  });

  test("a statement that answers no rows has no columns", () => {
    const { sql } = memoryStore();
    const cursor = sql.exec("CREATE TABLE t (a)");
    expect(cursor.columnNames).toEqual([]);
    expect(cursor.toArray()).toEqual([]);
  });

  test("a column called __proto__ is a column", () => {
    const { sql } = memoryStore();
    const row = sql.exec('SELECT 1 AS "__proto__", 2 AS b').one();
    expect(Object.keys(row)).toEqual(["__proto__", "b"]);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });

  test("two columns of one name: every column is listed, in order, and the later one is in the object", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE permits (id INTEGER, owner INTEGER)");
    sql.exec("CREATE TABLE owners (id INTEGER, name TEXT)");
    sql.exec("INSERT INTO permits VALUES (1, 7)");
    sql.exec("INSERT INTO owners VALUES (7, 'Lena Hart')");
    const joined = sql.exec("SELECT * FROM permits p JOIN owners o ON o.id = p.owner");
    expect(joined.columnNames).toEqual(["id", "owner", "id", "name"]);
    expect([...sql.exec("SELECT * FROM permits p JOIN owners o ON o.id = p.owner").raw()]).toEqual([
      [1, 7, 7, "Lena Hart"],
    ]);
    expect(joined.toArray()).toEqual([{ id: 7, owner: 7, name: "Lena Hart" }]);
    // With no row to count the columns by.
    expect(sql.exec("SELECT 1 AS a, 2 AS b, 3 AS a WHERE 0").columnNames).toEqual(["a", "b", "a"]);
    // More than three of one name: SQLite tells them apart by numbers of its own.
    expect(sql.exec("SELECT 1 AS n, 2 AS n, 3 AS n, 4 AS n, 5 AS n, 6 AS n").columnNames).toEqual([
      "n", "n", "n", "n", "n", "n",
    ]);
  });

  test("two columns of one name are refused where the names leave more than one reading", () => {
    const { sql } = memoryStore();
    const words = "Two columns of this result have one name. Give each a name of its own with AS.";
    // A column's own name that looks like the name SQLite makes for a second `a`.
    expect(() => sql.exec('SELECT 1 AS a, 2 AS a, 3 AS "a:1"')).toThrow(words);
    expect(() => sql.exec('SELECT 1 AS "t:1", 2 AS "t:1"')).toThrow(words);
    // SQLite gives a column called `true` another name where it is read as a table.
    expect(() => sql.exec("SELECT true, 1 AS x, 2 AS x")).toThrow(words);
    // Each alone is fine.
    expect(sql.exec('SELECT 1 AS a, 3 AS "a:1"').columnNames).toEqual(["a", "a:1"]);
    expect(sql.exec("SELECT true, 1 AS x").columnNames).toEqual(["true", "x"]);
  });

  test("a statement that writes and answers two columns of one name is refused before it writes", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE t (n INTEGER)");
    expect(() => sql.exec("INSERT INTO t VALUES (3) RETURNING n, n")).toThrow("Two columns of this result have one name");
    expect(sql.exec("SELECT count(*) AS c FROM t").one()).toEqual({ c: 0 });
    // With a name for each, it runs.
    const cursor = sql.exec("INSERT INTO t VALUES (3) RETURNING n, n AS again");
    expect(cursor.rowsWritten).toBe(1);
    expect(cursor.toArray()).toEqual([{ n: 3, again: 3 }]);
  });

  test("a statement that writes and is refused for what it answers leaves nothing of itself", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE t (n INTEGER, big BLOB)");
    expect(() =>
      sql.exec(`INSERT INTO t VALUES (1, zeroblob(${SQL_LIMITS.valueBytes + 1})) RETURNING big`),
    ).toThrow("string or blob too big: SQLITE_TOOBIG");
    expect(sql.exec("SELECT count(*) AS c FROM t").one()).toEqual({ c: 0 });
  });
});

describe("the statements of a text", () => {
  test("each one runs, in order; the values go to the last, and the cursor is the last one's", () => {
    const { sql } = memoryStore();
    const cursor = sql.exec(
      "CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2); SELECT n FROM t WHERE n > ?",
      1,
    );
    expect(cursor.toArray()).toEqual([{ n: 2 }]);
  });

  test("an empty text answers an empty cursor", () => {
    const { sql } = memoryStore();
    expect(sql.exec("").toArray()).toEqual([]);
    expect(sql.exec(" -- nothing here\n;").columnNames).toEqual([]);
  });

  test("when one statement of a text is refused, none of it runs", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE t (n INTEGER)");
    expect(() => sql.exec("INSERT INTO t VALUES (1); ATTACH DATABASE ':memory:' AS other")).toThrow(
      "not authorized: SQLITE_AUTH",
    );
    expect(sql.exec("SELECT count(*) AS c FROM t").one()).toEqual({ c: 0 });
  });
});

describe("what SQLite says when it fails a statement", () => {
  test("its own message, then the name of its result code", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE t (n INTEGER PRIMARY KEY)");
    sql.exec("INSERT INTO t VALUES (1)");
    const missing = thrownBy(() => sql.exec("SELECT * FROM nowhere"));
    expect(missing).toBeInstanceOf(SqliteFailure);
    expect(missing.message).toBe("no such table: nowhere: SQLITE_ERROR");
    const twice = thrownBy(() => sql.exec("INSERT INTO t VALUES (1)")) as SqliteFailure;
    expect(twice.message).toBe("UNIQUE constraint failed: t.n: SQLITE_CONSTRAINT");
    expect(twice.code).toBe("SQLITE_CONSTRAINT");
    expect(thrownBy(() => sql.exec("SELEC 1")).message).toBe('near "SELEC": syntax error: SQLITE_ERROR');
  });

  test("the wrong number of values", () => {
    const { sql } = memoryStore();
    const words = "Wrong number of parameter bindings for SQL query.";
    expect(() => sql.exec("SELECT ?, ?", 1)).toThrow(words);
    expect(() => sql.exec("SELECT ?", 1, 2)).toThrow(words);
    expect(() => sql.exec("SELECT 1", 1)).toThrow(words);
    expect(() => sql.exec("", 1)).toThrow(words);
    // A statement before the last one gets no values.
    expect(() => sql.exec("SELECT ?; SELECT ?", 1)).toThrow(words);
  });

  test("the number of values is held before the first statement of a text runs", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE t (n INTEGER)");
    expect(() => sql.exec("INSERT INTO t VALUES (1); SELECT ?, ?", 1)).toThrow(
      "Wrong number of parameter bindings for SQL query.",
    );
    expect(() => sql.exec("INSERT INTO t VALUES (1); SELECT 'a' LIKE ?", "a".repeat(51))).toThrow(
      "LIKE or GLOB pattern too complex",
    );
    expect(() => sql.exec("INSERT INTO t VALUES (1); SELECT ?", { a: 1 })).toThrow();
    expect(sql.exec("SELECT count(*) AS c FROM t").one()).toEqual({ c: 0 });
  });

  test("a statement that fails when it is reached leaves the ones before it as they ran, as on the platform", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE t (n INTEGER)");
    expect(() => sql.exec("INSERT INTO t VALUES (1); SELECT * FROM nowhere")).toThrow("no such table");
    expect(sql.exec("SELECT count(*) AS c FROM t").one()).toEqual({ c: 1 });
  });

  test("a value that is not text, a number, bytes or null", () => {
    const { sql } = memoryStore();
    for (const value of [{ a: 1 }, [1, 2], new Date(0), () => 1, Symbol("s")]) {
      const refusal = thrownBy(() => sql.exec("SELECT ?", value)) as SqlRefused;
      expect(refusal).toBeInstanceOf(SqlRefused);
      expect(refusal.rule).toBe("binding_type");
    }
    // An object is never read as values by name.
    sql.exec("CREATE TABLE t (a, b)");
    expect(() => sql.exec("INSERT INTO t VALUES (:a, :b)", { a: 1, b: 2 })).toThrow();
    expect(sql.exec("SELECT count(*) AS c FROM t").one()).toEqual({ c: 0 });
  });
});

describe("values in", () => {
  test("half of a pair of UTF-16 units is bound as the mark for a character that cannot be shown", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE notes (id INTEGER, body TEXT)");
    // A preview that was cut in the middle of a character outside the first plane.
    const cut = "Inspection passed 😀".slice(0, -1);
    sql.exec("INSERT INTO notes VALUES (1, ?)", cut);
    sql.exec("INSERT INTO notes VALUES (2, ?)", "ok \uDE00 then");
    const rows = sql.exec<{ body: string }>("SELECT body FROM notes ORDER BY id").toArray();
    expect(rows.map((row) => row.body)).toEqual(["Inspection passed �", "ok � then"]);
    // Whole characters are bound as they are.
    expect(sql.exec("SELECT ? AS v", "café 😀").one()).toEqual({ v: "café 😀" });
  });

  test("a whole number that SQLite cannot hold is refused, not bound as another number", () => {
    const { sql } = memoryStore();
    expect(sql.exec("SELECT ? AS v", 2n ** 63n - 1n).one()).toEqual({ v: Number(2n ** 63n - 1n) });
    expect(sql.exec("SELECT ? AS v", -(2n ** 63n)).one()).toEqual({ v: Number(-(2n ** 63n)) });
    for (const value of [2n ** 63n, -(2n ** 63n) - 1n, 18446744073709551621n]) {
      const refusal = thrownBy(() => sql.exec("SELECT ? AS v", value)) as SqlRefused;
      expect(refusal).toBeInstanceOf(SqlRefused);
      expect(refusal.rule).toBe("binding_type");
    }
  });

  test("true and false are bound as 1 and 0, and nothing as null", () => {
    const { sql } = memoryStore();
    expect(sql.exec("SELECT ? AS t, ? AS f, ? AS u", true, false, undefined).one()).toEqual({ t: 1, f: 0, u: null });
  });
});

describe("a statement that is explained", () => {
  // SQLite counts an EXPLAIN as running until it is put away, and while a
  // statement runs nothing can be kept and no table can be dropped.
  test.each([
    ["EXPLAIN QUERY PLAN UPDATE t SET x = 2 WHERE x = 1"],
    ["EXPLAIN INSERT INTO t VALUES (1)"],
    ["EXPLAIN QUERY PLAN DELETE FROM t"],
    ["EXPLAIN CREATE TABLE u (y)"],
    ["EXPLAIN QUERY PLAN SELECT * FROM t WHERE x = 1"],
    ["EXPLAIN SELECT 1"],
  ])("after %s, what is written next is kept", (explain) => {
    const storage = new FileStorage({ folder: newStoreFolder() });
    opened.push(storage);
    storage.sql.exec("CREATE TABLE t (x INTEGER)");
    storage.sql.exec("CREATE INDEX t_x ON t (x)");
    storage.flush();
    // Twice, as a statement that was kept compiled would be run again. How
    // many rows SQLite explains a statement in is its own business.
    storage.sql.exec(explain).toArray();
    storage.sql.exec(explain).toArray();
    storage.sql.exec("INSERT INTO t VALUES (10)");
    storage.transactionSync(() => storage.sql.exec("INSERT INTO t VALUES (11)"));
    storage.sql.exec("CREATE TABLE made_after (y)");
    storage.flush();
    expect(storage.sql.db.inTransaction).toBe(false);
    expect(storage.sql.exec("SELECT count(*) AS c FROM t").one()).toEqual({ c: 2 });
    // And nothing holds the table or its index.
    storage.sql.exec("DROP INDEX t_x");
    storage.sql.exec("DROP TABLE t");
    storage.flush();
    expect(storage.sql.exec("SELECT count(*) AS c FROM sqlite_master WHERE name = 't'").one()).toEqual({ c: 0 });
  });
});

describe("the host's own transaction", () => {
  test("a statement of a kind that only maintains the file runs", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE t (n INTEGER PRIMARY KEY, v TEXT)");
    sql.exec("CREATE INDEX t_v ON t (v)");
    expect(sql.exec("REINDEX").toArray()).toEqual([]);
    expect(sql.exec("ANALYZE").toArray()).toEqual([]);
  });

  test("a statement that starts with a word of no kind is refused by the host, before SQLite sees it", () => {
    const { sql } = memoryStore();
    const refusal = thrownBy(() => sql.exec("FROBNICATE permits")) as SqlRefused;
    expect(refusal).toBeInstanceOf(SqlRefused);
    expect(refusal.rule).toBe("statement_kind");
    expect(refusal.message).toBe('near "FROBNICATE": syntax error: SQLITE_ERROR');
  });

  test("a column that is called rollback can be asked for", () => {
    const { sql } = memoryStore();
    sql.exec("CREATE TABLE deploys (id INTEGER PRIMARY KEY, sha TEXT, failed INTEGER DEFAULT 0, rollback INTEGER DEFAULT 0)");
    sql.exec("INSERT INTO deploys (sha, rollback) VALUES ('abc', 1)");
    expect(sql.exec("SELECT sha FROM deploys WHERE failed = 1 OR rollback = 1").toArray()).toEqual([{ sha: "abc" }]);
    expect(sql.exec("UPDATE deploys SET failed = failed OR rollback").rowsWritten).toBe(1);
  });

  test("ROLLBACK on a conflict is refused, so a conflict cannot end the host's transaction", () => {
    const storage = memoryStore();
    storage.sql.exec("CREATE TABLE t (n INTEGER PRIMARY KEY)");
    storage.sql.exec("INSERT INTO t VALUES (1)");
    expect(() => storage.sql.exec("INSERT OR ROLLBACK INTO t VALUES (1)")).toThrow("not authorized: SQLITE_AUTH");
    expect(() =>
      storage.sql.exec("CREATE TRIGGER g BEFORE INSERT ON t BEGIN SELECT RAISE(ROLLBACK, 'no'); END"),
    ).toThrow("not authorized: SQLITE_AUTH");
    // The first row still waits to be kept.
    expect(storage.sql.db.inTransaction).toBe(true);
    expect(storage.sql.exec("SELECT count(*) AS c FROM t").one()).toEqual({ c: 1 });
  });

  describe("when a failure makes SQLite end it", () => {
    /** A Store with a trigger that ends the transaction: made behind the
     *  guard's back, to stand for a full disk or a failed write. */
    function withLoss(options: { onTransactionLost?: () => void } = {}): FileStorage {
      const storage = new FileStorage(options);
      opened.push(storage);
      storage.sql.exec("CREATE TABLE ledger (entry TEXT)");
      storage.sql.exec("CREATE TABLE t (n INTEGER)");
      storage.flush();
      storage.sql.db.run(
        "CREATE TRIGGER lose BEFORE INSERT ON t WHEN new.n < 0 BEGIN SELECT RAISE(ROLLBACK, 'lost'); END",
      );
      return storage;
    }

    test("the owner is told, and the statement fails as a loss", () => {
      let told = 0;
      const storage = withLoss({ onTransactionLost: () => (told += 1) });
      storage.sql.exec("INSERT INTO ledger VALUES ('before')");
      const lost = thrownBy(() => storage.sql.exec("INSERT INTO t VALUES (-1)"));
      expect(lost).toBeInstanceOf(StoreTransactionLost);
      expect(told).toBe(1);
      // What waited to be kept went with it.
      expect(storage.sql.exec("SELECT count(*) AS c FROM ledger").one()).toEqual({ c: 0 });
      // With no transaction of the program's open, statements run again.
      storage.sql.exec("INSERT INTO ledger VALUES ('after')");
      expect(storage.sql.exec("SELECT entry FROM ledger").toArray()).toEqual([{ entry: "after" }]);
    });

    test("inside a transaction, nothing written after the loss is kept by itself", () => {
      const storage = withLoss();
      const outcome = thrownBy(() =>
        storage.transactionSync(() => {
          storage.sql.exec("INSERT INTO ledger VALUES ('before')");
          try {
            storage.sql.exec("INSERT INTO t VALUES (-1)");
          } catch {
            // A program that goes on after the failure.
          }
          // Refused: there is no transaction left to write it in.
          expect(() => storage.sql.exec("INSERT INTO ledger VALUES ('after')")).toThrow(StoreTransactionLost);
          return "done";
        }),
      );
      expect(outcome).toBeInstanceOf(StoreTransactionLost);
      expect(storage.sql.exec("SELECT count(*) AS c FROM ledger").one()).toEqual({ c: 0 });
      // The Store goes on.
      storage.transactionSync(() => storage.sql.exec("INSERT INTO ledger VALUES ('next')"));
      expect(storage.sql.exec("SELECT entry FROM ledger").toArray()).toEqual([{ entry: "next" }]);
    });

    test("what was compiled against a schema that went with it is compiled again", () => {
      const storage = withLoss();
      expect(() =>
        storage.transactionSync(() => {
          storage.sql.exec("ALTER TABLE ledger ADD COLUMN extra TEXT DEFAULT 'x'");
          expect(storage.sql.exec("SELECT * FROM ledger").columnNames).toEqual(["entry", "extra"]);
          storage.sql.exec("INSERT INTO t VALUES (-1)");
        }),
      ).toThrow(StoreTransactionLost);
      expect(storage.sql.exec("SELECT * FROM ledger").columnNames).toEqual(["entry"]);
    });
  });

  test("a column that an undone transaction added is gone from what was compiled", () => {
    const storage = memoryStore();
    storage.sql.exec("CREATE TABLE w (a)");
    storage.sql.exec("INSERT INTO w VALUES (1)");
    expect(() =>
      storage.transactionSync(() => {
        storage.sql.exec("ALTER TABLE w ADD COLUMN b DEFAULT 'd'");
        expect(storage.sql.exec("SELECT * FROM w").toArray()).toEqual([{ a: 1, b: "d" }]);
        throw new Error("no");
      }),
    ).toThrow("no");
    expect(storage.sql.exec("SELECT * FROM w").toArray()).toEqual([{ a: 1 }]);
  });
});

describe("the platform's limits", () => {
  test("a result of more than 100 columns", () => {
    const { sql } = memoryStore();
    const columns = (n: number): string => Array.from({ length: n }, (_, i) => `${i} AS c${i}`).join(", ");
    expect(sql.exec(`SELECT ${columns(100)}`).columnNames).toHaveLength(100);
    expect(() => sql.exec(`SELECT ${columns(101)}`)).toThrow("too many columns in result set: SQLITE_ERROR");
  });

  test("a table of more than 100 columns is not made, and one that grows past it is put back", () => {
    const { sql } = memoryStore();
    const columns = (n: number): string => Array.from({ length: n }, (_, i) => `c${i} TEXT`).join(", ");
    sql.exec(`CREATE TABLE wide (${columns(100)})`);
    expect(() => sql.exec(`CREATE TABLE wider (${columns(101)})`)).toThrow(
      "too many columns on wider: SQLITE_ERROR",
    );
    expect(sql.exec("SELECT name FROM sqlite_master ORDER BY name").toArray()).toEqual([{ name: "wide" }]);
    expect(() => sql.exec("ALTER TABLE wide ADD COLUMN one_more TEXT")).toThrow(
      "too many columns on wide: SQLITE_ERROR",
    );
    expect(sql.exec("SELECT count(*) AS c FROM pragma_table_info('wide')").one()).toEqual({ c: 100 });
    // Inside a transaction of the engine's, what came before the statement stays.
    const storage = memoryStore();
    storage.transactionSync(() => {
      storage.sql.exec("CREATE TABLE kept (a)");
      expect(() => storage.sql.exec(`CREATE TABLE wider (${columns(101)})`)).toThrow();
    });
    expect(storage.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([{ name: "kept" }]);
  });

  test("a bound value of more than 2,000,000 bytes", () => {
    const { sql } = memoryStore();
    const words = "string or blob too big: SQLITE_TOOBIG";
    expect(sql.exec("SELECT length(?) AS n", "a".repeat(SQL_LIMITS.valueBytes)).one()).toEqual({
      n: SQL_LIMITS.valueBytes,
    });
    expect(() => sql.exec("SELECT length(?)", "a".repeat(SQL_LIMITS.valueBytes + 1))).toThrow(words);
    // Bytes, not characters.
    expect(() => sql.exec("SELECT length(?)", "é".repeat(SQL_LIMITS.valueBytes / 2 + 1))).toThrow(words);
    expect(() => sql.exec("SELECT length(?)", new Uint8Array(SQL_LIMITS.valueBytes + 1))).toThrow(words);
  });

  test("an answered value of more than 2,000,000 bytes", () => {
    const { sql } = memoryStore();
    expect(() => sql.exec(`SELECT zeroblob(${SQL_LIMITS.valueBytes + 1}) AS z`)).toThrow(
      "string or blob too big: SQLITE_TOOBIG",
    );
  });

  test("a bound LIKE pattern of more than 50 bytes", () => {
    const { sql } = memoryStore();
    expect(sql.exec("SELECT 'a' LIKE ? AS hit", "a".repeat(50)).one()).toEqual({ hit: 0 });
    expect(() => sql.exec("SELECT 'a' LIKE ?", "a".repeat(51))).toThrow(
      "LIKE or GLOB pattern too complex: SQLITE_ERROR",
    );
    expect(() => sql.exec("SELECT ? AS x WHERE 'a' GLOB ?", 1, "a".repeat(51))).toThrow(
      "LIKE or GLOB pattern too complex: SQLITE_ERROR",
    );
  });
});

describe("a statement reaches only its own Store's file", () => {
  /** Another organization's Store, with one row in it. */
  function otherStore(): string {
    const file = path.join(tempFolder("other"), "store.sqlite");
    const other = new Database(file);
    other.run("CREATE TABLE other_rows (secret TEXT)");
    other.run("INSERT INTO other_rows VALUES ('a row of another organization')");
    other.close();
    return file;
  }

  /** Every way this test knows to open the other file from a statement. */
  function attacks(file: string): [string, string][] {
    const attach = `ATTACH DATABASE '${file}' AS other`;
    return [
      ["ATTACH", attach],
      ["attach, in small letters", attach.toLowerCase().replace(file.toLowerCase(), file)],
      ["ATTACH behind a comment", `/* a note */ ${attach}`],
      ["ATTACH after a comment line", `-- a note\n${attach}`],
      ["ATTACH as a second statement", `SELECT 1; ${attach}`],
      ["ATTACH as a second statement behind a comment", `SELECT 1; /* x */ ${attach}`],
      ["ATTACH after a comment that ends in a carriage return", `SELECT 1 -- it's\r\n; ${attach} --'`],
      ["ATTACH behind a byte order mark", "\uFEFF" + attach],
      ["ATTACH after a NUL", "SELECT 1\u0000; " + attach],
      ["ATTACH with the file bound", "ATTACH DATABASE ? AS other"],
      ["ATTACH by a link", `ATTACH DATABASE 'file:${file}?mode=ro' AS other`],
      ["ATTACH after a variable with a bracket", `SELECT $a('x) ; ${attach} --'`],
    ];
  }

  for (const [what] of attacks("/x")) {
    test(`${what}: refused, and the other Store's rows cannot be read afterwards`, () => {
      const file = otherStore();
      const attack = attacks(file).find(([name]) => name === what)?.[1] as string;
      const { sql } = memoryStore();
      const values = attack.includes("?") && !attack.includes("mode=ro") ? [file] : [];
      // Refused by the guard, before SQLite was handed anything: not by the
      // check that runs after a statement, which would mean the file was open
      // for a moment.
      expect(thrownBy(() => sql.exec(attack, ...values))).toBeInstanceOf(SqlRefused);
      expect(() => sql.exec("SELECT secret FROM other.other_rows")).toThrow("no such table");
      expect(() => sql.exec("SELECT secret FROM other_rows")).toThrow("no such table");
    });
  }

  test("VACUUM INTO writes no copy of the Store", () => {
    const storage = new FileStorage({ folder: newStoreFolder() });
    opened.push(storage);
    storage.sql.exec("CREATE TABLE permits (address TEXT)");
    storage.sql.exec("INSERT INTO permits VALUES ('18 Mill Road')");
    const copy = path.join(tempFolder("copy"), "copy.sqlite");
    for (const attack of [
      `VACUUM INTO '${copy}'`,
      `vacuum into '${copy}'`,
      `SELECT 1; VACUUM INTO '${copy}'`,
      `/* x */ VACUUM main INTO '${copy}'`,
      "VACUUM INTO ?",
    ]) {
      expect(() => storage.sql.exec(attack, ...(attack.includes("?") ? [copy] : []))).toThrow();
      expect(existsSync(copy)).toBe(false);
    }
  });

  test("a PRAGMA off the list changes nothing", () => {
    const storage = new FileStorage({ folder: newStoreFolder() });
    opened.push(storage);
    for (const attack of [
      "PRAGMA journal_mode = OFF",
      "pragma JOURNAL_MODE = memory",
      "SELECT 1; PRAGMA journal_mode = OFF",
      "PRAGMA main.'journal_mode' = OFF",
      "PRAGMA locking_mode = NORMAL",
      "PRAGMA writable_schema = ON",
    ]) {
      expect(() => storage.sql.exec(attack)).toThrow("not authorized: SQLITE_AUTH");
    }
    const mode = storage.sql.db.prepare("PRAGMA journal_mode").values() as string[][];
    expect(mode).toEqual([["truncate"]]);
    expect(() => storage.sql.exec("SELECT file FROM pragma_database_list")).toThrow(
      "not authorized: SQLITE_AUTH",
    );
  });

  test("an extension is not loaded", () => {
    const { sql } = memoryStore();
    for (const attack of [
      "SELECT load_extension('/tmp/x')",
      "SELECT LOAD_EXTENSION('/tmp/x', 'main')",
      'SELECT "load_extension"(\'/tmp/x\')',
      "SELECT 1; SELECT load_extension('/tmp/x')",
    ]) {
      expect(() => sql.exec(attack)).toThrow("not authorized: SQLITE_AUTH");
    }
  });

  test("what follows a trigger's END with no semicolon between does not run", () => {
    const storage = new FileStorage({ folder: newStoreFolder() });
    opened.push(storage);
    storage.sql.exec("CREATE TABLE t (x INTEGER)");
    for (const pragma of ["PRAGMA locking_mode = NORMAL", "PRAGMA query_only = ON", "PRAGMA database_list", "PRAGMA journal_mode = OFF"]) {
      const attack = `CREATE TRIGGER IF NOT EXISTS tr AFTER INSERT ON t BEGIN SELECT 1; END ${pragma}`;
      expect(thrownBy(() => storage.sql.exec(attack))).toBeInstanceOf(SqlRefused);
    }
    // Nothing of it ran: no trigger, and the settings are as they were.
    expect(storage.sql.exec("SELECT count(*) AS c FROM sqlite_master WHERE type = 'trigger'").one()).toEqual({ c: 0 });
    const setting = (name: string): unknown => (storage.sql.db.prepare(`PRAGMA ${name}`).values() as unknown[][]).at(0)?.at(0);
    expect(setting("locking_mode")).toBe("exclusive");
    expect(setting("query_only")).toBe(0);
    expect(setting("journal_mode")).toBe("truncate");
    storage.sql.exec("INSERT INTO t VALUES (1)");
    storage.flush();
  });

  test("a table that compiles the text of a value is refused, so a setting cannot be changed through one", () => {
    const storage = new FileStorage({ folder: newStoreFolder() });
    opened.push(storage);
    storage.sql.exec("CREATE TABLE t (x INTEGER)");
    for (const [attack, values] of [
      ["SELECT count(*) AS n FROM bytecode(?)", ["PRAGMA locking_mode = NORMAL"]],
      ["SELECT count(*) AS n FROM tables_used('PRAGMA query_only = ON')", []],
      ["SELECT count(*) AS n FROM 'bytecode' WHERE stmt = ?", ["PRAGMA journal_mode = OFF"]],
    ] as const) {
      const refusal = thrownBy(() => storage.sql.exec(attack, ...values)) as SqlRefused;
      expect(refusal).toBeInstanceOf(SqlRefused);
      expect(refusal.rule).toBe("virtual_table");
    }
    const setting = (name: string): unknown => (storage.sql.db.prepare(`PRAGMA ${name}`).values() as unknown[][]).at(0)?.at(0);
    expect(setting("locking_mode")).toBe("exclusive");
    expect(setting("query_only")).toBe(0);
    expect(setting("journal_mode")).toBe("truncate");
    storage.sql.exec("INSERT INTO t VALUES (1)");
    storage.flush();
  });

  test("every module this SQLite has is refused by name, but full text search and the two that read JSON", () => {
    // Asked of the SQLite this test runs on, so a build with another list of
    // modules is held to its own.
    const plain = new Database(":memory:");
    let modules: string[] = [];
    try {
      modules = (plain.prepare("PRAGMA module_list").values() as string[][]).flat();
    } catch {
      // A build that does not list its modules.
    }
    plain.close();
    const { sql } = memoryStore();
    for (const name of modules) {
      const nameable = ["fts5", "fts5vocab", "json_each", "json_tree"].includes(name.toLowerCase());
      if (nameable || name.toLowerCase().startsWith("pragma_")) continue;
      const refusal = thrownBy(() => sql.exec(`SELECT * FROM ${name}`)) as SqlRefused;
      expect(refusal).toBeInstanceOf(SqlRefused);
      expect(refusal.rule).toBe("virtual_table");
    }
    // JSON's two read a value and nothing else.
    expect(sql.exec("SELECT value FROM json_each(?)", "[1,2]").toArray()).toEqual([{ value: 1 }, { value: 2 }]);
  });

  test("the check after a statement: a second database on the connection ends the Store", () => {
    // What the guard is for cannot happen through `exec`. So the database is
    // attached behind the guard's back here, to show what the host does when
    // SQLite itself says a second file is open.
    const file = otherStore();
    let ended = 0;
    const database = new Database(":memory:");
    const sql = new StoreSql(database, { onReachBroken: () => (ended += 1) });
    database.run(`ATTACH DATABASE '${file}' AS other`);
    expect(() => sql.exec("SELECT 1")).toThrow(StoreReachBroken);
    expect(ended).toBe(1);
    // The host closed it again before it stopped.
    expect(database.prepare("PRAGMA database_list").values()).toHaveLength(1);
    database.close();
  });
});

describe("a transaction's statements are the host's to run", () => {
  test("refused in the platform's words, and nothing is left open", () => {
    const storage = memoryStore();
    for (const statement of ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT a", "RELEASE a", "END"]) {
      expect(() => storage.sql.exec(statement)).toThrow("To execute a transaction, please use");
    }
    expect(storage.sql.db.inTransaction).toBe(false);
  });
});
