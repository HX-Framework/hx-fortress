import { describe, expect, test } from "bun:test";

import {
  ALLOWED_PRAGMAS,
  readStatements,
  SQL_LIMITS,
  SqlRefused,
  TRANSACTION_MESSAGE,
  type SqlRule,
} from "../../../src/modules/stores/host/sql-guard";

/** The rule that refused `sql`, or null when it was let through. */
function rule(sql: string): SqlRule | null {
  try {
    readStatements(sql);
    return null;
  } catch (thrown) {
    if (thrown instanceof SqlRefused) return thrown.rule;
    throw thrown;
  }
}

function message(sql: string): string {
  try {
    readStatements(sql);
  } catch (thrown) {
    if (thrown instanceof SqlRefused) return thrown.message;
    throw thrown;
  }
  throw new Error("the statement was let through");
}

/**
 * The ways somebody hides a statement: as it is, in another letter case,
 * behind a comment, after a comment line, as a second statement after a
 * semicolon, after an empty statement, after EXPLAIN, and behind a byte order
 * mark.
 */
function disguises(statement: string): [string, string][] {
  const mixed = [...statement]
    .map((letter, index) => (index % 2 === 0 ? letter.toLowerCase() : letter.toUpperCase()))
    .join("");
  return [
    ["as it is", statement],
    ["in small letters", statement.toLowerCase()],
    ["in mixed letters", mixed],
    ["behind a block comment", `/* a note */ ${statement}`],
    ["with a comment between its words", statement.replace(" ", " /* x */ ")],
    ["after a comment line", `-- a note\n${statement}`],
    ["after a comment line that ends in a carriage return", `-- it's\r\n${statement} --'`],
    ["as a second statement", `SELECT 1; ${statement}`],
    ["as a second statement with no space", `SELECT 1;${statement}`],
    ["after an empty statement", `;;${statement}`],
    ["as a third statement behind a comment", `SELECT 1; SELECT 2; /* x */ ${statement}`],
    ["after EXPLAIN", `EXPLAIN ${statement}`],
    ["after EXPLAIN QUERY PLAN", `EXPLAIN QUERY PLAN ${statement}`],
    ["behind a byte order mark", "\uFEFF" + statement],
    ["inside a trigger's body", `CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; ${statement}; END`],
    ["after a trigger", `CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END; ${statement}`],
    ["on a new line with tabs", `SELECT 1;\n\t\t${statement}`],
  ];
}

describe("a statement reaches only its own Store's file", () => {
  const reaching: [string, string, SqlRule][] = [
    ["ATTACH", "ATTACH DATABASE '/data/other/store.sqlite' AS other", "attach"],
    ["ATTACH without the word DATABASE", "ATTACH '/data/other/store.sqlite' AS other", "attach"],
    ["DETACH", "DETACH DATABASE other", "detach"],
    ["VACUUM INTO", "VACUUM INTO '/tmp/copy.sqlite'", "vacuum"],
    ["VACUUM", "VACUUM", "vacuum"],
    ["VACUUM of one schema INTO", "VACUUM main INTO '/tmp/copy.sqlite'", "vacuum"],
    ["a PRAGMA that names a folder", "PRAGMA temp_store_directory = '/tmp/elsewhere'", "pragma"],
    ["a PRAGMA that lets the schema be written", "PRAGMA writable_schema = 1", "pragma"],
    ["a PRAGMA that lists the files", "PRAGMA database_list", "pragma"],
    ["a PRAGMA with its schema", "PRAGMA main.journal_mode = OFF", "pragma"],
    ["a PRAGMA written with brackets", "PRAGMA journal_mode(OFF)", "pragma"],
  ];

  for (const [what, statement, expected] of reaching) {
    describe(what, () => {
      for (const [how, sql] of disguises(statement)) {
        test(how, () => {
          expect(rule(sql)).toBe(expected);
        });
      }
    });
  }

  test("a refusal says what SQLite says, and never repeats the statement", () => {
    expect(message("ATTACH DATABASE '/data/other/store.sqlite' AS other")).toBe(
      "not authorized: SQLITE_AUTH",
    );
  });

  describe("a PRAGMA's name, however it is spelled", () => {
    test.each([
      ['PRAGMA "journal_mode" = OFF'],
      ["PRAGMA `journal_mode` = OFF"],
      ["PRAGMA [journal_mode] = OFF"],
      // SQLite takes text in single quotes where it wants a name.
      ["PRAGMA 'journal_mode' = OFF"],
      ['PRAGMA "main"."journal_mode" = OFF'],
      ["PRAGMA main.'journal_mode' = OFF"],
      ["PRAGMA JOURNAL_MODE"],
      // No name at all.
      ["PRAGMA"],
      ["PRAGMA = 1"],
      ["PRAGMA main."],
      // The schema is `table_info` here, and the PRAGMA is `journal_mode`.
      ["PRAGMA table_info.journal_mode"],
    ])("%s", (sql) => {
      expect(rule(sql)).toBe("pragma");
    });
  });

  describe("a PRAGMA read as a table", () => {
    test.each([
      ["SELECT * FROM pragma_database_list"],
      ["SELECT * FROM PRAGMA_DATABASE_LIST"],
      ["SELECT file FROM main.pragma_database_list"],
      ['SELECT * FROM "pragma_database_list"'],
      ["SELECT * FROM `pragma_database_list`"],
      ["SELECT * FROM [pragma_database_list]"],
      // SQLite takes a table's name in single quotes.
      ["SELECT * FROM 'pragma_database_list'"],
      ["SELECT * FROM t WHERE x IN (SELECT name FROM pragma_function_list)"],
      ["CREATE VIEW v AS SELECT * FROM pragma_database_list"],
      ["SELECT 1; SELECT * FROM pragma_journal_mode"],
    ])("%s", (sql) => {
      expect(rule(sql)).toBe("pragma");
    });

    test("the PRAGMAs on the list may be read as tables", () => {
      expect(rule("SELECT name FROM pragma_table_info('permits')")).toBeNull();
      expect(rule("SELECT * FROM pragma_table_list")).toBeNull();
      expect(rule("SELECT * FROM pragma_index_list(?)")).toBeNull();
    });

    test("text that only mentions a PRAGMA is text", () => {
      expect(rule("SELECT 'see pragma_database_list for the files'")).toBeNull();
      expect(rule("INSERT INTO notes VALUES ('PRAGMA database_list')")).toBeNull();
    });
  });

  describe("loading code", () => {
    test.each([
      ["SELECT load_extension('/tmp/x.so')"],
      ["SELECT LOAD_EXTENSION('/tmp/x.so', 'entry')"],
      ['SELECT "load_extension"(\'/tmp/x.so\')'],
      ["SELECT `load_extension`('/tmp/x.so')"],
      ["SELECT [load_extension]('/tmp/x.so')"],
      ["SELECT 1; SELECT load_extension('/tmp/x.so')"],
      ["SELECT 1 /* */ ; -- x\n SELECT load_extension ( '/tmp/x.so' )"],
      ["CREATE VIEW v AS SELECT load_extension('/tmp/x.so')"],
      ["CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT load_extension('/tmp/x.so'); END"],
      ["CREATE TABLE t (a DEFAULT (load_extension('/tmp/x.so')))"],
      ["SELECT fts3_tokenizer('simple')"],
      ["SELECT fts3_tokenizer('mine', x'0000000000000000')"],
    ])("%s", (sql) => {
      expect(rule(sql)).toBe("extension");
    });

    test("text that only mentions the function is text", () => {
      expect(rule("SELECT 'load_extension'")).toBeNull();
    });
  });

  describe("a virtual table", () => {
    test("full text search is the one kind a Store may make", () => {
      expect(rule("CREATE VIRTUAL TABLE notes USING fts5(body)")).toBeNull();
      expect(rule("CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5vocab(notes, 'row')")).toBeNull();
      expect(rule("create virtual table notes using FTS5(body)")).toBeNull();
    });

    test.each([
      ["CREATE VIRTUAL TABLE t USING csv(filename='/etc/passwd')"],
      ["CREATE VIRTUAL TABLE t USING dbstat"],
      ["CREATE VIRTUAL TABLE t USING rtree(id, a, b)"],
      ['CREATE VIRTUAL TABLE t USING "csv"(filename=\'/etc/passwd\')'],
      ["CREATE VIRTUAL TABLE t USING 'csv'(filename='/etc/passwd')"],
      ["SELECT 1; CREATE VIRTUAL TABLE t USING zipfile('/tmp/a.zip')"],
      ["CREATE /* x */ VIRTUAL /* y */ TABLE t USING fts3(body)"],
      ["CREATE VIRTUAL TABLE t"],
    ])("%s", (sql) => {
      expect(rule(sql)).toBe("virtual_table");
    });

    test("a generated column that is VIRTUAL is not a virtual table", () => {
      expect(rule("CREATE TABLE t (a INT, b INT GENERATED ALWAYS AS (a * 2) VIRTUAL)")).toBeNull();
    });
  });

  describe("what is not refused", () => {
    test("a column or a table that is called like a refused word, when it is quoted", () => {
      expect(rule('SELECT "attach", "vacuum", "pragma" FROM "detach"')).toBeNull();
    });

    test("a refused word that is not where a statement starts", () => {
      // `attach` is a name here. SQLite lets these words be names.
      expect(rule("SELECT attach FROM t")).toBeNull();
      expect(rule("INSERT INTO log (pragma) VALUES (1)")).toBeNull();
    });

    test("text and comments that hold a refused statement", () => {
      expect(rule("SELECT 'ATTACH DATABASE ''x'' AS y'")).toBeNull();
      expect(rule("SELECT 1 -- ; ATTACH DATABASE 'x' AS y")).toBeNull();
      expect(rule("SELECT 1 /* ; ATTACH DATABASE 'x' AS y; */")).toBeNull();
      expect(rule('SELECT "; ATTACH DATABASE x AS y;" FROM t')).toBeNull();
    });

    test("every PRAGMA on the list, with and without a schema and a value", () => {
      for (const name of ALLOWED_PRAGMAS) {
        expect(rule(`PRAGMA ${name}`)).toBeNull();
        expect(rule(`pragma main.${name.toUpperCase()}`)).toBeNull();
      }
      expect(rule("PRAGMA foreign_keys = OFF")).toBeNull();
      expect(rule("PRAGMA table_info(permits)")).toBeNull();
    });
  });
});

describe("what follows a trigger's END", () => {
  // A trigger is cut after its END. If something follows that END with no
  // semicolon between, the host would start a statement at a place where no
  // rule has looked. SQLite takes no such text, and the host refuses it whole.
  test.each([
    ["CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END PRAGMA database_list"],
    ["CREATE TRIGGER IF NOT EXISTS tr AFTER INSERT ON t BEGIN SELECT 1; END PRAGMA locking_mode = NORMAL"],
    ["CREATE TEMP TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END pragma query_only = ON"],
    ["CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END /* x */ PRAGMA journal_mode"],
    ["EXPLAIN CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END PRAGMA locking_mode"],
    ["CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END SELECT 2"],
    ["CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END ATTACH DATABASE 'f' AS x"],
    ["SELECT 1; CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END PRAGMA writable_schema = ON"],
  ])("%s", (sql) => {
    expect(rule(sql)).not.toBeNull();
    expect(() => readStatements(sql)).toThrow(SqlRefused);
  });

  test("the refusal is SQLite's own words for it", () => {
    const sql = "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END PRAGMA database_list";
    expect(rule(sql)).toBe("unreadable");
    expect(message(sql)).toBe('near "PRAGMA": syntax error: SQLITE_ERROR');
  });

  test("a trigger that ends the text, or is followed by a semicolon, is read as before", () => {
    const one = "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END";
    expect(readStatements(one).map((piece) => piece.text)).toEqual([one]);
    expect(readStatements(`${one};`).map((piece) => piece.text)).toEqual([one]);
    expect(readStatements(`${one} ; SELECT 2`).map((piece) => piece.text)).toEqual([one, "SELECT 2"]);
    // What follows after the semicolon is held to every rule.
    expect(rule(`${one}; PRAGMA database_list`)).toBe("pragma");
  });
});

describe("a module of SQLite that is read as a table", () => {
  // Two of them compile SQL text that a value holds, and a PRAGMA takes effect
  // when it is compiled.
  test.each([
    ["SELECT count(*) FROM bytecode(?)"],
    ["SELECT count(*) FROM BYTECODE('PRAGMA locking_mode = NORMAL')"],
    ["SELECT * FROM tables_used('PRAGMA query_only = ON')"],
    ['SELECT * FROM "bytecode" WHERE stmt = ?'],
    ["SELECT * FROM `bytecode` WHERE stmt = ?"],
    ["SELECT * FROM [bytecode] WHERE stmt = ?"],
    // SQLite takes a table's name in single quotes.
    ["SELECT * FROM 'bytecode' WHERE stmt = ?"],
    ["SELECT * FROM main.bytecode WHERE stmt = ?"],
    ["SELECT 1; SELECT * FROM t JOIN tables_used(?) u"],
    ["CREATE VIEW v AS SELECT * FROM bytecode('SELECT 1')"],
    ["CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT * FROM bytecode('SELECT 1'); END"],
    ["SELECT * FROM sqlite_dbpage"],
    ["SELECT sql FROM sqlite_stmt"],
  ])("%s", (sql) => {
    expect(rule(sql)).toBe("virtual_table");
    expect(message(sql)).toBe("not authorized: SQLITE_AUTH");
  });

  test("every module that SQLite says it has is refused by name, but full text search and the two that read JSON", () => {
    const modules = new Set(["dbstat", "rtree", "some_module_of_a_later_sqlite"]);
    const refusedBy = (sql: string): SqlRule | null => {
      try {
        readStatements(sql, modules);
        return null;
      } catch (thrown) {
        if (thrown instanceof SqlRefused) return thrown.rule;
        throw thrown;
      }
    };
    expect(refusedBy("SELECT * FROM dbstat")).toBe("virtual_table");
    expect(refusedBy("SELECT * FROM Some_Module_Of_A_Later_SQLite(1)")).toBe("virtual_table");
    expect(refusedBy("SELECT * FROM 'rtree'")).toBe("virtual_table");
    // Not on the list that was handed in: not refused.
    expect(refusedBy("SELECT * FROM permits")).toBeNull();
    expect(rule("SELECT * FROM dbstat")).toBeNull();
    // The ones a statement may name.
    expect(refusedBy("SELECT value FROM json_each(?)")).toBeNull();
    expect(refusedBy("SELECT value FROM json_tree(?)")).toBeNull();
    expect(refusedBy("CREATE VIRTUAL TABLE notes USING fts5(body)")).toBeNull();
  });

  test("the functions that read and write a file, where a build has them", () => {
    for (const sql of ["SELECT readfile('/etc/hosts')", "SELECT writefile('/tmp/x', a) FROM t"]) {
      expect(rule(sql)).toBe("extension");
    }
  });

  test("what the rule costs: such a name is refused as a column's too, and as a text of its own", () => {
    // The text does not say whether a name is a table's or a column's.
    expect(rule("SELECT bytecode FROM contracts")).toBe("virtual_table");
    expect(rule("SELECT * FROM contracts WHERE kind = 'bytecode'")).toBe("virtual_table");
    // Bound as a value, or as part of a longer text, it is not looked at.
    expect(rule("SELECT * FROM contracts WHERE kind = ?")).toBeNull();
    expect(rule("SELECT 'the bytecode of a contract'")).toBeNull();
    // A common word that is no module's name stays a name.
    expect(rule("SELECT edit, zipfile FROM uploads")).toBeNull();
  });
});

describe("ROLLBACK as what a statement does on a conflict", () => {
  // Each of these ends the whole transaction when a row conflicts, the host's
  // own included.
  test.each([
    ["INSERT OR ROLLBACK INTO t VALUES (1)"],
    ["insert or rollback into t values (1)"],
    ["INSERT /* x */ OR /* y */ ROLLBACK INTO t VALUES (1)"],
    ["REPLACE INTO t VALUES (1); UPDATE OR ROLLBACK t SET a = 1"],
    ["UPDATE OR\nROLLBACK t SET a = 1"],
    ["CREATE TABLE t (a INTEGER PRIMARY KEY ON CONFLICT ROLLBACK)"],
    ["CREATE TABLE t (a TEXT NOT NULL ON CONFLICT ROLLBACK, b TEXT)"],
    ["CREATE TABLE t (a, b, UNIQUE (a, b) ON CONFLICT ROLLBACK)"],
    ["CREATE TRIGGER g BEFORE INSERT ON t BEGIN SELECT RAISE(ROLLBACK, 'no'); END"],
    ["CREATE TRIGGER g BEFORE INSERT ON t BEGIN SELECT raise ( rollback , 'no'); END"],
    ["CREATE TRIGGER g BEFORE INSERT ON t BEGIN INSERT OR ROLLBACK INTO u VALUES (1); END"],
  ])("%s", (sql) => {
    expect(rule(sql)).toBe("transaction");
    expect(message(sql)).toBe("not authorized: SQLITE_AUTH");
  });

  test("the other things a statement may do on a conflict are not refused", () => {
    for (const how of ["ABORT", "FAIL", "IGNORE", "REPLACE"]) {
      expect(rule(`INSERT OR ${how} INTO t VALUES (1)`)).toBeNull();
      expect(rule(`CREATE TABLE t (a INTEGER PRIMARY KEY ON CONFLICT ${how})`)).toBeNull();
    }
    expect(rule("CREATE TRIGGER g BEFORE INSERT ON t BEGIN SELECT RAISE(ABORT, 'no'); END")).toBeNull();
    expect(rule("INSERT INTO t VALUES (1) ON CONFLICT (a) DO UPDATE SET b = 2")).toBeNull();
  });

  test("the word where it is a name, or text, is not refused", () => {
    expect(rule('SELECT "rollback" FROM t WHERE a OR "rollback"')).toBeNull();
    expect(rule("SELECT 'OR ROLLBACK'")).toBeNull();
    expect(rule("SELECT a OR b, rollback FROM t")).toBeNull();
  });

  test("a column that is called rollback, in a condition, is not refused whatever the order of the terms", () => {
    // SQLite takes the word as a name. The rule looks for it only where the
    // grammar has it as what to do on a conflict.
    for (const sql of [
      "SELECT sha FROM deploys WHERE failed = 1 OR rollback = 1",
      "SELECT sha FROM deploys WHERE rollback = 1 OR failed = 1",
      "SELECT sha FROM deploys WHERE failed OR rollback",
      "UPDATE deploys SET failed = failed OR rollback",
      "INSERT INTO deploys (failed, rollback) SELECT a OR rollback, 0 FROM t",
      "SELECT conflict, rollback FROM t",
      "SELECT raise, (rollback) FROM t",
    ]) {
      expect(rule(sql)).toBeNull();
    }
  });
});

describe("the kinds of statement a Store runs", () => {
  test.each([
    ["SELECT 1"],
    ["VALUES (1)"],
    ["WITH a AS (SELECT 1) SELECT * FROM a"],
    ["INSERT INTO t VALUES (1)"],
    ["REPLACE INTO t VALUES (1)"],
    ["UPDATE t SET a = 1"],
    ["DELETE FROM t"],
    ["CREATE TABLE t (a)"],
    ["DROP TABLE t"],
    ["ALTER TABLE t ADD COLUMN b"],
    ["PRAGMA table_list"],
    ["REINDEX"],
    ["ANALYZE"],
    ["EXPLAIN SELECT 1"],
    ["explain query plan select 1"],
  ])("%s", (sql) => {
    expect(rule(sql)).toBeNull();
  });

  test("a statement that starts with any other word is refused, in SQLite's words for a word it does not know", () => {
    expect(rule("FROBNICATE permits")).toBe("statement_kind");
    expect(message("FROBNICATE permits")).toBe('near "FROBNICATE": syntax error: SQLITE_ERROR');
    expect(rule("SELECT 1; frobnicate")).toBe("statement_kind");
    expect(rule("EXPLAIN FROBNICATE")).toBe("statement_kind");
    // A word past ASCII is a word.
    expect(rule("SÉLECT 1")).toBe("statement_kind");
  });

  test("what starts with no word at all is left for SQLite to refuse", () => {
    expect(rule("(SELECT 1)")).toBeNull();
    expect(rule("1")).toBeNull();
    expect(rule("EXPLAIN")).toBeNull();
  });

  test("which statements write nothing", () => {
    const reads = (sql: string): boolean | undefined => readStatements(sql).at(0)?.reads;
    for (const sql of ["SELECT 1", "VALUES (1)", "PRAGMA table_list", "EXPLAIN DELETE FROM t", "explain query plan insert into t values (1)"]) {
      expect(reads(sql)).toBe(true);
    }
    for (const sql of ["INSERT INTO t VALUES (1)", "WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a", "CREATE TABLE t (a)", "ANALYZE", "DELETE FROM t"]) {
      expect(reads(sql)).toBe(false);
    }
    // An EXPLAIN of a statement that would make a table makes none.
    expect(readStatements("EXPLAIN CREATE TABLE t (a)").at(0)?.changesTables).toBe(false);
  });

  test("which statements the host may keep compiled: those that read or change rows", () => {
    const kept = (sql: string): boolean | undefined => readStatements(sql).at(0)?.kept;
    for (const sql of ["SELECT 1", "INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t", "WITH a AS (SELECT 1) SELECT * FROM a", "VALUES (1)", "REPLACE INTO t VALUES (1)"]) {
      expect(kept(sql)).toBe(true);
    }
    for (const sql of ["EXPLAIN SELECT 1", "EXPLAIN QUERY PLAN UPDATE t SET a = 1", "CREATE TABLE t (a)", "PRAGMA table_list", "ANALYZE", "DROP TABLE t"]) {
      expect(kept(sql)).toBe(false);
    }
  });
});

describe("text that cannot be read with certainty is refused whole", () => {
  test.each([
    ["text that never ends", "SELECT 'abc"],
    ["a NUL", "SELECT 1\u0000; ATTACH DATABASE 'f' AS x"],
    ["a variable followed by a bracket", "SELECT $a('x) ; ATTACH DATABASE 'f' AS y --'"],
    ["a character with no token", "SELECT 1 ^ 2"],
  ])("%s", (_what, sql) => {
    expect(rule(sql)).toBe("unreadable");
    expect(message(sql)).toBe("unrecognized token: SQLITE_ERROR");
  });
});

describe("the statements of a transaction are the host's", () => {
  test.each([
    ["BEGIN"],
    ["begin transaction"],
    ["BEGIN IMMEDIATE"],
    ["COMMIT"],
    ["END"],
    ["END TRANSACTION"],
    ["ROLLBACK"],
    ["ROLLBACK TO here"],
    ["SAVEPOINT here"],
    ["RELEASE here"],
    ["  /* x */ commit"],
    ["SELECT 1; COMMIT"],
    ["INSERT INTO t VALUES (1); ROLLBACK; INSERT INTO t VALUES (2)"],
  ])("%s", (sql) => {
    expect(rule(sql)).toBe("transaction");
    expect(message(sql)).toBe(TRANSACTION_MESSAGE);
  });

  test("the BEGIN and END of a trigger are not a transaction's", () => {
    const pieces = readStatements(
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; DELETE FROM c; END; SELECT 1",
    );
    expect(pieces.map((piece) => piece.text)).toEqual([
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; DELETE FROM c; END",
      "SELECT 1",
    ]);
  });

  test("the END of a CASE is not a trigger's", () => {
    const pieces = readStatements(
      "CREATE TEMP TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN 1 THEN 2 END; END",
    );
    expect(pieces).toHaveLength(1);
  });
});

describe("a text's statements", () => {
  test("are cut at each semicolon, without it", () => {
    expect(readStatements("SELECT 1; SELECT 2 ;\n SELECT 3").map((piece) => piece.text)).toEqual([
      "SELECT 1",
      "SELECT 2",
      "SELECT 3",
    ]);
  });

  test("no statement at all", () => {
    expect(readStatements("")).toEqual([]);
    expect(readStatements("  -- only a note\n ; ; ")).toEqual([]);
  });

  test("a comment before a statement is not part of it, one inside is", () => {
    expect(readStatements("/* a */ SELECT /* b */ 1 -- c").map((piece) => piece.text)).toEqual([
      "SELECT /* b */ 1",
    ]);
  });

  test("how many values each statement binds", () => {
    expect(readStatements("SELECT ?, ?").at(0)?.variables).toBe(2);
    expect(readStatements("SELECT ?3, ?1").at(0)?.variables).toBe(3);
    expect(readStatements("SELECT :a, :b, :a").at(0)?.variables).toBe(2);
    expect(readStatements("SELECT ?, ?5, ?").at(0)?.variables).toBe(6);
    expect(readStatements("SELECT ?; SELECT ?, ?").map((piece) => piece.variables)).toEqual([1, 2]);
  });

  test("which statements may change the schema", () => {
    const leaves = (sql: string): boolean | undefined => readStatements(sql).at(0)?.leavesSchema;
    expect(leaves("SELECT 1")).toBe(true);
    expect(leaves("WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a")).toBe(true);
    expect(leaves("EXPLAIN DROP TABLE t")).toBe(true);
    expect(leaves("CREATE TABLE t (a)")).toBe(false);
    expect(leaves("DROP TABLE t")).toBe(false);
    expect(leaves("ALTER TABLE t ADD COLUMN b")).toBe(false);
    expect(leaves("PRAGMA foreign_keys = OFF")).toBe(false);
  });
});

describe("the platform's limits, where the text shows them", () => {
  test("a text of more than 100,000 bytes", () => {
    const fits = `SELECT '${"a".repeat(SQL_LIMITS.sqlBytes - 9)}'`;
    expect(Buffer.byteLength(fits)).toBe(SQL_LIMITS.sqlBytes);
    expect(rule(fits)).toBeNull();
    expect(rule(`${fits} `)).toBe("too_long");
    expect(message(`${fits} `)).toBe("statement too long: SQLITE_TOOBIG");
    // Bytes, not characters.
    expect(rule(`SELECT '${"é".repeat(50_001)}'`)).toBe("too_long");
  });

  test("more than 100 values to bind", () => {
    const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");
    expect(rule(`SELECT ${marks(100)}`)).toBeNull();
    expect(rule(`SELECT ${marks(101)}`)).toBe("too_many_variables");
    expect(rule("SELECT ?101")).toBe("too_many_variables");
    expect(rule("SELECT ?100")).toBeNull();
    expect(message("SELECT ?101")).toBe("too many SQL variables: SQLITE_ERROR");
  });

  test("more than 5 SELECTs joined", () => {
    const chain = (n: number, by = "UNION ALL"): string =>
      Array.from({ length: n }, (_, i) => `SELECT ${i}`).join(` ${by} `);
    expect(rule(chain(5))).toBeNull();
    expect(rule(chain(6))).toBe("too_many_selects");
    expect(rule(chain(6, "INTERSECT"))).toBe("too_many_selects");
    expect(rule(chain(6, "except"))).toBe("too_many_selects");
    expect(message(chain(6))).toBe("too many terms in compound SELECT: SQLITE_ERROR");
  });

  test("SELECTs joined in different brackets are counted apart", () => {
    const five = Array.from({ length: 5 }, (_, i) => `SELECT ${i}`).join(" UNION ");
    expect(rule(`SELECT * FROM (${five}) a, (${five}) b`)).toBeNull();
    expect(rule(`${five}; ${five}`)).toBeNull();
    expect(rule(`SELECT * FROM (${five} UNION SELECT 9)`)).toBe("too_many_selects");
  });

  test("a LIKE or GLOB pattern of more than 50 bytes, written in the statement", () => {
    const pattern = (n: number): string => "a".repeat(n);
    expect(rule(`SELECT 1 WHERE x LIKE '${pattern(50)}'`)).toBeNull();
    expect(rule(`SELECT 1 WHERE x LIKE '${pattern(51)}'`)).toBe("pattern_too_long");
    expect(rule(`SELECT 1 WHERE x NOT LIKE '${pattern(51)}'`)).toBe("pattern_too_long");
    expect(rule(`SELECT 1 WHERE x GLOB '${pattern(51)}'`)).toBe("pattern_too_long");
    expect(rule(`SELECT like('${pattern(51)}', x)`)).toBe("pattern_too_long");
    expect(rule(`SELECT 1 WHERE x LIKE '${"é".repeat(26)}'`)).toBe("pattern_too_long");
    expect(message(`SELECT 1 WHERE x LIKE '${pattern(51)}'`)).toBe(
      "LIKE or GLOB pattern too complex: SQLITE_ERROR",
    );
  });

  test("which bound values stand where a pattern does", () => {
    expect(readStatements("SELECT 1 WHERE a = ? AND b LIKE ? AND c GLOB ?").at(0)?.patternVariables).toEqual([
      2, 3,
    ]);
    expect(readStatements("SELECT 1 WHERE b LIKE ?2 AND a = ?1").at(0)?.patternVariables).toEqual([2]);
    expect(readStatements("SELECT like(?, x), :p WHERE y LIKE :p").at(0)?.patternVariables).toEqual([1, 2]);
  });
});
