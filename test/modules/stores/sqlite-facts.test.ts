import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

import { namesBackwards } from "../../../src/modules/stores/host/sql-storage";
import { scanSql } from "../../../src/modules/stores/host/sql-text";
import { cleanFolders, tempFolder } from "./_rig";

afterAll(cleanFolders);

// What SQLite itself does with a statement's text, asked of a database with no
// guard in front of it.
//
// The guard refuses a statement by its tokens (sql-guard.ts), so it is right
// only where the scan cuts a text as SQLite cuts it. Each fact below is a
// place where the two could part, and each is asked of the SQLite this
// program runs on. A build of SQLite that answers differently fails here,
// and the scan is then changed with it.

const db = new Database(":memory:");
db.run("CREATE TABLE t (a)");
db.run("INSERT INTO t VALUES (1)");

function taken(sql: string): unknown[][] | null {
  return db.prepare(sql).values() as unknown[][] | null;
}

function words(sql: string): string[] {
  const scan = scanSql(sql);
  if (!scan.ok) throw new Error("the scan refused it");
  return scan.tokens.map((token) => `${token.kind}:${token.text}`);
}

describe("what SQLite takes for a name", () => {
  test("a table's name in single quotes, so text that is a refused table's name is refused", () => {
    expect(taken("SELECT a FROM 't'")).toEqual([[1]]);
    expect(taken("SELECT name FROM 'pragma_database_list'")).toEqual([["main"]]);
    expect(taken("SELECT name FROM main.pragma_database_list")).toEqual([["main"]]);
  });

  test("a PRAGMA's name and its schema in any quotes", () => {
    for (const sql of [
      "PRAGMA 'page_size'",
      'PRAGMA "page_size"',
      "PRAGMA [page_size]",
      "PRAGMA `page_size`",
      "PRAGMA 'main'.'page_size'",
    ]) {
      expect(taken(sql)).toEqual([[4096]]);
    }
  });

  test("a function's name in double quotes, backticks and brackets, and not in single quotes", () => {
    expect(taken('SELECT "abs"(-1)')).toEqual([[1]]);
    expect(taken("SELECT `abs`(-1)")).toEqual([[1]]);
    expect(taken("SELECT [abs](-1)")).toEqual([[1]]);
    expect(() => taken("SELECT 'abs'(-1)")).toThrow(/syntax error/);
  });

  test("a keyword in quotes is not that keyword", () => {
    expect(() => taken("'ATTACH' DATABASE ':memory:' AS x")).toThrow(/syntax error/);
    expect(() => taken('"ATTACH" DATABASE \':memory:\' AS x')).toThrow(/syntax error/);
  });
});

describe("where SQLite sees a word begin and end", () => {
  test("a byte order mark is white space before a word, and a letter inside one", () => {
    expect(taken("\uFEFFSELECT 7")).toEqual([[7]]);
    expect(words("\uFEFFSELECT 7")).toEqual(["word:SELECT", "number:7"]);
    expect(() => taken("SELECT\uFEFF 7")).toThrow(/syntax error/);
    expect(words("SELECT\uFEFF 7")).toEqual(["word:SELECT\uFEFF", "number:7"]);
  });

  test("a no-break space is a letter", () => {
    expect(() => taken("SELECT\u00A07")).toThrow(/syntax error/);
    expect(words("SELECT\u00A07")).toEqual(["word:SELECT\u00A07"]);
  });

  test("a vertical tab begins nothing, and is white space after a space", () => {
    expect(() => taken("\u000BSELECT 7")).toThrow(/unrecognized token/);
    expect(scanSql("\u000BSELECT 7").ok).toBe(false);
    expect(taken(" \u000BSELECT 7")).toEqual([[7]]);
    expect(words(" \u000BSELECT 7")).toEqual(["word:SELECT", "number:7"]);
  });
});

describe("where SQLite sees a comment and a text end", () => {
  test("a carriage return does not end a line comment, a line feed does", () => {
    expect(taken("SELECT 7 -- x\r, 8")).toEqual([[7]]);
    expect(words("SELECT 7 -- x\r, 8")).toEqual(["word:SELECT", "number:7"]);
    expect(taken("SELECT 7 -- x\n, 8")).toEqual([[7, 8]]);
    expect(words("SELECT 7 -- x\n, 8")).toEqual(["word:SELECT", "number:7", "punct:,", "number:8"]);
  });

  test("a block comment ends at the first star and slash, and does not nest", () => {
    expect(taken("SELECT 7 /* /* x */ , 8")).toEqual([[7, 8]]);
    expect(taken("SELECT 7 /*/ x */ , 8")).toEqual([[7, 8]]);
    expect(taken("SELECT 7 /* never closed")).toEqual([[7]]);
  });

  test("NUL ends the text: what follows it is never read, so the scan refuses the text", () => {
    expect(taken("SELECT 7\u0000 nonsense ((")).toEqual([[7]]);
    expect(scanSql("SELECT 7\u0000 nonsense ((").ok).toBe(false);
  });

  test("a variable followed by a bracket is one variable to SQLite, so the scan refuses it", () => {
    // Read as a variable and then a bracket, the quote inside would open text.
    expect(taken("SELECT $a('x)")).toEqual([[null]]);
    expect(scanSql("SELECT $a('x)").ok).toBe(false);
  });
});

describe("what a statement handed to SQLite runs", () => {
  test("`prepare` compiles the first statement of a text and nothing after it", () => {
    const other = new Database(":memory:");
    other.prepare("SELECT 1; ATTACH DATABASE ':memory:' AS second").values();
    expect(other.prepare("PRAGMA database_list").values()).toHaveLength(1);
    // `run` and `exec` would have run both. The host uses neither for a
    // statement that somebody wrote.
    other.run("SELECT 1; ATTACH DATABASE ':memory:' AS second");
    expect(other.prepare("PRAGMA database_list").values()).toHaveLength(2);
    other.close();
  });

  test("a file to VACUUM INTO can be bound, so no reading of a statement's text finds the file", () => {
    // Which is why the guard refuses VACUUM by its first word.
    const copy = path.join(tempFolder("facts"), "copy.sqlite");
    const other = new Database(":memory:");
    other.run("CREATE TABLE t (a)");
    other.prepare("VACUUM INTO ?").values(copy);
    expect(existsSync(copy)).toBe(true);
    other.close();
  });

  test("a setting of foreign keys inside a transaction is dropped, not put off", () => {
    const other = new Database(":memory:");
    other.run("PRAGMA foreign_keys = ON");
    other.run("BEGIN");
    other.run("PRAGMA foreign_keys = OFF");
    expect(other.prepare("PRAGMA foreign_keys").values()).toEqual([[1]]);
    other.run("COMMIT");
    expect(other.prepare("PRAGMA foreign_keys").values()).toEqual([[1]]);
    other.close();
  });

  test("ROLLBACK on a conflict ends the whole transaction, a caller's included", () => {
    const other = new Database(":memory:");
    other.run("CREATE TABLE t (n INTEGER PRIMARY KEY)");
    other.run("INSERT INTO t VALUES (1)");
    other.run("CREATE TRIGGER g BEFORE DELETE ON t BEGIN SELECT RAISE(ROLLBACK, 'no'); END");
    for (const statement of ["INSERT OR ROLLBACK INTO t VALUES (1)", "DELETE FROM t"]) {
      other.run("BEGIN");
      expect(() => other.run(statement)).toThrow();
      expect(other.inTransaction).toBe(false);
    }
    // Any other way to fail leaves the transaction open.
    other.run("BEGIN");
    expect(() => other.run("INSERT OR ABORT INTO t VALUES (1)")).toThrow();
    expect(other.inTransaction).toBe(true);
    other.run("ROLLBACK");
    other.close();
  });
});

describe("what this runtime says of a statement", () => {
  test("it lists a name once when two columns share it, and counts every column", () => {
    const statement = db.prepare("SELECT 1 AS a, 2 AS b, 3 AS a");
    expect(statement.columnNames).toHaveLength(2);
    expect((statement as unknown as { native: { columnsCount: number } }).native.columnsCount).toBe(3);
    expect(statement.values()).toEqual([[1, 2, 3]]);
    // Read as a table, SQLite tells the two apart itself.
    expect(db.prepare("SELECT * FROM (SELECT 1 AS a, 2 AS b, 3 AS a)").columnNames).toEqual(["a", "b", "a:1"]);
  });

  test("it lists the names of a wide result in order or backwards, never in another order", () => {
    // Measured on Bun 1.3.14: in order up to 62 columns, backwards from 63 up,
    // with the values in order all the while. The storage asks for each width
    // (`namesBackwards`) and holds no number of its own. What it cannot live
    // with is a third order, and this is where a runtime that has one shows.
    for (let width = 1; width <= 100; width += 1) {
      const expected = Array.from({ length: width }, (_, at) => `c${at}`);
      const statement = db.prepare(`SELECT ${expected.map((name, at) => `${at} AS ${name}`).join(", ")}`);
      const listed = [...statement.columnNames];
      const values = (statement.values() as unknown[][]).at(0);
      statement.finalize();
      const backwards = width > 1 && listed.join() === [...expected].reverse().join();
      expect(listed.join() === expected.join() || backwards).toBe(true);
      expect(namesBackwards(width)).toBe(backwards);
      // The values are in the columns' order whichever way the names come.
      expect(values).toEqual(expected.map((_, at) => at));
    }
  });

  test("it says how many values a statement binds as SQLite counts them: the largest number", () => {
    expect(db.prepare("SELECT ?, ?").paramsCount).toBe(2);
    expect(db.prepare("SELECT ?3, ?1").paramsCount).toBe(3);
    expect(db.prepare("SELECT :a, :b, :a").paramsCount).toBe(2);
    expect(db.prepare("SELECT ?, ?5, ?").paramsCount).toBe(6);
    expect(db.prepare("SELECT $a, @a, :a, ?").paramsCount).toBe(4);
  });
});
