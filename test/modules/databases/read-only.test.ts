// The Fortress's own check that a statement is one statement that only reads.
//
// The data runner makes the same check by the same rule. These cases are this
// repository's own. They cover each part of the rule: what a statement starts
// with, the words that write, what is hidden inside quotes and comments, and
// each text the engines read differently.

import { describe, expect, test } from "bun:test";

import { statementRefusal, WRITE_WORDS } from "../../../src/modules/databases/read-only";

const READS: readonly string[] = [
  "SELECT 1",
  "select * from permits where type = 'Deck';",
  "  SELECT permit_no FROM permits  ",
  "WITH recent AS (SELECT permit_no FROM permits) SELECT * FROM recent",
  "/* the first three */ SELECT TOP 3 permit_no FROM permits",
  // A write word inside a string, a quoted name or a comment is not a word.
  "SELECT 'DELETE FROM permits' AS note FROM permits",
  "SELECT 'a;b -- not a comment' FROM permits",
  'SELECT "INTO" FROM permits',
  "SELECT [INTO], [delete] FROM permits -- SELECT INTO here is a comment",
  "SELECT `update`, `drop` FROM permits",
  "SELECT permit_no -- DELETE it later\nFROM permits",
  "SELECT 'it''s; fine' FROM permits",
  // A write word that is part of a longer name is another word.
  "SELECT created_at, updated_at, deleted_at, into_date, update_count FROM permits",
  "SELECT replace(address, 'Road', 'Rd') FROM permits",
  // A backslash that is not before a quote is only a backslash.
  "SELECT folder FROM permits WHERE folder LIKE 'C:\\%'",
  "SELECT detail->'lot' FROM permits",
  "SELECT permit_no FROM permits WHERE note LIKE '%--%'\nAND type = 'a;b'",
];

const REFUSED: readonly [string, string][] = [
  ["", "empty"],
  ["   \n ", "empty"],
  ["-- nothing but a comment", "empty"],
  ["/* nothing */", "empty"],
  ["DROP TABLE permits", "not_a_select"],
  ["UPDATE permits SET type = 'Deck'", "not_a_select"],
  ["EXEC sp_who", "not_a_select"],
  ["(SELECT 1)", "not_a_select"],
  ["SELECT 1; DELETE FROM permits", "several_statements"],
  ["SELECT 1; SELECT 2", "several_statements"],
  ["SELECT * INTO permits_copy FROM permits", "writes"],
  ["SELECT address FROM permits INTO OUTFILE '/tmp/permits'", "writes"],
  ["WITH gone AS (SELECT 1 AS a) DELETE FROM permits", "writes"],
  ["SELECT 1 COMMIT DELETE FROM permits", "writes"],
  ["SELECT 1 EXEC xp_cmdshell 'dir'", "writes"],
  ["SELECT * FROM permits FOR UPDATE", "writes"],
  ["SELECT * FROM OPENROWSET('provider', 'server', 'DELETE FROM permits')", "writes"],
  // A write word that touches what stands before it is still a word.
  ["SELECT max(valuation)INTO OUTFILE '/tmp/permits' FROM permits", "writes"],
  ["SELECT 1INTO permits_copy FROM permits", "writes"],
  ["select 1 InTo permits_copy from permits", "writes"],
  // What the engines read differently is refused, not guessed at.
  ["SELECT 1 /*!50000 INTO OUTFILE '/tmp/permits' */", "comment_that_runs"],
  ["SELECT 1 /*M!100000 INTO OUTFILE '/tmp/permits' */", "comment_that_runs"],
  ["SELECT 'a\\'' INTO OUTFILE '/tmp/permits' -- '", "backslash_quote"],
  ["SELECT 5--1 INTO OUTFILE '/tmp/permits'", "dashes_without_space"],
  ["SELECT 1 # it's\n INTO OUTFILE '/tmp/permits' # '", "hash_sign"],
  ["SELECT 'Mill", "not_closed"],
  ["SELECT 1 /* never closed", "not_closed"],
  ["SELECT [permit_no FROM permits", "not_closed"],
  ['SELECT "permit_no FROM permits', "not_closed"],
];

describe("one statement that only reads", () => {
  test.each(READS.map((sql) => [sql]))("runs: %s", (sql) => {
    expect(statementRefusal(sql)).toBeNull();
  });

  test.each(REFUSED)("does not run: %s", (sql, why) => {
    expect(statementRefusal(sql)).toBe(why as ReturnType<typeof statementRefusal>);
  });

  test("every word that writes is refused as a word of its own, in any case", () => {
    for (const word of WRITE_WORDS) {
      expect(statementRefusal(`SELECT 1 ${word} permits`)).toBe("writes");
      expect(statementRefusal(`select 1 ${word.toLowerCase()} permits`)).toBe("writes");
      // Quoted, it is a name. Inside a longer word, it is another word.
      expect(statementRefusal(`SELECT "${word}", [${word}] FROM permits`)).toBeNull();
      expect(statementRefusal(`SELECT ${word}_count, last_${word} FROM permits`)).toBeNull();
    }
  });

  test("a letter that becomes a plain one in upper case does not hide a word", () => {
    // U+017F, the long s, is S in upper case.
    expect(statementRefusal("SELECT 1 IN\u017FERT permits")).toBe("writes");
  });
});
