// The scan of a statement's text that an HX Fortress makes before anything is
// started: one statement, and no word that writes.
//
// The scan is told the connection's engine, because the engines do not agree
// on what is a quote. These cases are this repository's own. Each group under
// "does not run" is one way a statement could hide what it does from a scan
// that read every engine alike.

import { describe, expect, test } from "bun:test";

import type { Engine } from "../../../src/modules/databases/manifest";
import { ENGINE_WORDS, statementRefusal, WRITE_WORDS } from "../../../src/modules/databases/read-only";

const ENGINES: readonly Engine[] = ["sqlserver", "oracle", "mysql", "postgres"];

/** Statements every engine's scan takes. */
const READS: readonly string[] = [
  "SELECT 1",
  "select * from permits where type = 'Deck';",
  "  SELECT permit_no FROM permits  ",
  "WITH recent AS (SELECT permit_no FROM permits) SELECT * FROM recent",
  "/* the first three */ SELECT permit_no FROM permits",
  // A write word inside a string, a quoted name or a comment is not a word.
  "SELECT 'DELETE FROM permits' AS note FROM permits",
  "SELECT 'a;b -- not a comment' FROM permits",
  'SELECT "INTO" FROM permits',
  "SELECT permit_no -- DELETE it later\nFROM permits",
  "SELECT permit_no -- a comment\r\nFROM permits",
  "SELECT 'it''s; fine' FROM permits",
  // A write word that is part of a longer name is another word.
  "SELECT created_at, updated_at, deleted_at, into_date, update_count FROM permits",
  "SELECT replace(address, 'Road', 'Rd') FROM permits",
  // A backslash that is not before a quote is only a backslash.
  "SELECT folder FROM permits WHERE folder LIKE 'C:\\%'",
  "SELECT permit_no FROM permits WHERE note LIKE '%--%'\nAND type = 'a;b'",
  // A letter outside a to z is taken inside quotes and inside a comment.
  'SELECT "straße", "名前" FROM permits WHERE applicant = \'Zoë\' -- größer\n',
  // A number is a number.
  "SELECT 1e3, 0x1F, .5, 12.75 FROM permits",
  "SELECT valuation * 1.2e1 AS v2 FROM permits",
];

/** Statements that only some engines' scans take. */
const READS_ON: readonly [Engine, string][] = [
  ["sqlserver", "SELECT [INTO], [delete] FROM [dbo].[permits] -- SELECT INTO here is a comment"],
  ["sqlserver", "SELECT TOP 3 permit_no FROM permits ORDER BY issued OFFSET 0 ROWS FETCH NEXT 3 ROWS ONLY"],
  ["sqlserver", "SELECT [a]]b] FROM permits"],
  ["mysql", "SELECT `update`, `drop` FROM permits"],
  ["mysql", "SELECT IF(valuation > 100, 1, 0) FROM permits"],
  ["postgres", "SELECT detail->'lot', tags[1] FROM permits"],
  ["postgres", "SELECT ARRAY['a', ']'] FROM permits"],
  ["postgres", "SELECT $$it's a text$$, $tag$and; another$tag$ FROM permits"],
  ["postgres", "SELECT open, close, set FROM prices"],
  ["oracle", "SELECT sid FROM v$session"],
  // A quote after a q is the start of ordinary quoted text on every engine
  // but Oracle: the text here ends at the quote before FROM.
  ["sqlserver", "SELECT 1q'[a']' FROM permits FOR UPDATE --'"],
  ["mysql", "SELECT 1q'[a']' FROM permits FOR UPDATE --'"],
  ["postgres", "SELECT xq'[a']' FROM permits FOR UPDATE --'"],
];

/** A statement, why it is refused, and on which engines (all, when left out). */
type Refused = [sql: string, why: string, on?: Engine[]];

const REFUSED: Refused[] = [
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
  ["SELECT 1; 'x'", "several_statements"],
  ["SELECT * INTO permits_copy FROM permits", "writes"],
  ["SELECT address FROM permits INTO OUTFILE '/tmp/permits'", "writes"],
  ["WITH gone AS (SELECT 1 AS a) DELETE FROM permits", "writes"],
  ["SELECT 1 COMMIT DELETE FROM permits", "writes"],
  ["SELECT 1 EXEC xp_cmdshell 'dir'", "writes"],
  ["SELECT * FROM permits FOR UPDATE", "writes"],
  ["SELECT * FROM OPENROWSET('provider', 'server', 'DELETE FROM permits')", "writes"],
  ["select 1 InTo permits_copy from permits", "writes"],

  // ── Text before the first SELECT ──────────────────────────────────────────
  // SQL Server runs a procedure named at the start of a batch with no EXEC.
  // Quoted text is not a space, so it does not hide in front of SELECT.
  ["[xp_dirtree] '\\\\203.0.113.5\\x' SELECT 1", "not_a_select", ["sqlserver"]],
  ["\"xp_dirtree\" '\\\\203.0.113.5\\x' SELECT 1", "not_a_select"],
  ["[usp_PurgeOldPermits] SELECT 1", "not_a_select", ["sqlserver"]],
  ["'x' SELECT 1", "not_a_select"],

  // ── A write word that touches a number ────────────────────────────────────
  // An engine reads `1e1DELETE` as a number and then DELETE.
  ["SELECT max(valuation)INTO OUTFILE '/tmp/permits' FROM permits", "writes"],
  ["SELECT 1INTO permits_copy FROM permits", "writes"],
  ["SELECT 1e1DELETE FROM permits", "writes"],
  ["SELECT 1e1COMMIT SELECT 1e1DELETE FROM permits", "writes"],
  ["SELECT 1e1INTO OUTFILE '/tmp/permits'", "writes"],
  ["SELECT 0x1FDELETE FROM permits", "writes"],
  ["SELECT 1.e1DELETE FROM permits", "writes"],
  ["SELECT .5e1DELETE FROM permits", "writes"],
  ["SELECT $1DELETE FROM permits", "writes", ["sqlserver", "oracle", "mysql"]],
  ["SELECT 1 INTO@x", "writes"],

  // ── Where a comment ends ──────────────────────────────────────────────────
  // Some engines end `--` at a carriage return alone, and some nest `/* */`.
  // A carriage return alone ends a `--` comment on some engines and not on
  // others, so one that no line feed follows is not taken at all.
  ["SELECT 1 -- x\r; DELETE FROM permits", "control_character"],
  ["SELECT 1 --\rCOMMIT DELETE FROM permits", "control_character"],
  ["SELECT 1 -- x\rINTO permits_copy FROM permits", "control_character"],
  ["SELECT 1 -- \r'\n INTO OUTFILE \"/tmp/x\" -- '", "control_character"],
  ["SELECT * FROM permits -- \r'\n FOR UPDATE -- '", "control_character"],
  ["SELECT 1 /* /* */ ' */ ; DELETE FROM permits --'", "nested_comment"],
  ["SELECT 1 /* /* */ ' */ COMMIT DELETE FROM permits --'", "nested_comment"],
  ["SELECT 1 /*!50000 INTO OUTFILE '/tmp/permits' */", "comment_that_runs"],
  ["SELECT 1 /*M!100000 INTO OUTFILE '/tmp/permits' */", "comment_that_runs"],
  ["SELECT 1 /*m!100000 INTO OUTFILE '/tmp/permits' */", "comment_that_runs"],
  ["SELECT 5--1 INTO OUTFILE '/tmp/permits'", "dashes_without_space"],
  ["SELECT 1 # it's\n INTO OUTFILE '/tmp/permits' # '", "hash_sign"],
  ["SELECT 1 /* never closed", "not_closed"],

  // ── What is a quote, engine by engine ─────────────────────────────────────
  ["SELECT 'a\\'' INTO OUTFILE '/tmp/permits' -- '", "backslash_quote"],
  ["SELECT 'Mill", "not_closed"],
  ['SELECT "permit_no FROM permits', "not_closed"],
  ["SELECT [permit_no FROM permits", "not_closed"],
  // On SQL Server `]]` is a bracket inside the name, so the name goes on, and
  // the quote inside it opens nothing.
  ["SELECT 1 AS [a]]'] COMMIT DELETE FROM permits", "writes", ["sqlserver"]],
  ["SELECT 1 AS [a]]'] EXEC xp_cmdshell 'dir'", "writes", ["sqlserver"]],
  // On the other engines a bracket is no quote, so the text after it is read.
  ["SELECT ARRAY[']'] ; DELETE FROM permits", "several_statements", ["postgres", "mysql", "oracle"]],
  ["SELECT ARRAY[']'] AS a INTO permits_copy FROM permits", "writes", ["postgres", "mysql", "oracle"]],
  // PostgreSQL reads `$$…$$` as quoted text, so a quote inside it opens nothing.
  ["SELECT $$'$$ INTO permits_copy FROM permits", "writes", ["postgres"]],
  ["SELECT $$'$$; COMMIT; DROP TABLE permits;", "several_statements", ["postgres"]],
  ["WITH y AS (SELECT $$'$$ AS q), x AS (DELETE FROM permits RETURNING 1) SELECT $$'$$ FROM x", "writes", ["postgres"]],
  // The same six with `--'` at the end, which is how each was hidden from a
  // scan that took the quote for the start of a text. Now the scan reads the
  // quoting as the engine does, reaches the two dashes, and stops there.
  ["SELECT 1 AS [a]]'] COMMIT DELETE FROM permits --'", "dashes_without_space", ["sqlserver"]],
  ["SELECT 1 AS [a]]'] EXEC xp_cmdshell 'dir' --'", "dashes_without_space", ["sqlserver"]],
  ["SELECT ARRAY[']'] ; DELETE FROM permits --'", "dashes_without_space", ["postgres"]],
  ["SELECT ARRAY[']'] AS a INTO permits_copy FROM permits --'", "dashes_without_space", ["postgres"]],
  ["SELECT $$'$$ INTO permits_copy FROM permits --'", "dashes_without_space", ["postgres"]],
  ["SELECT $$'$$; COMMIT; DROP TABLE permits; --'", "dashes_without_space", ["postgres"]],
  ["SELECT $tag$ never closed", "not_closed", ["postgres"]],
  // PostgreSQL takes `@` as an operator, so quoted text can follow it.
  ["SELECT ARRAY['x'] <@$$ {'} $$; DROP TABLE permits", "several_statements", ["postgres"]],
  // A `$` that opens no quoted text is read by what stands around it: part of
  // a name, a parameter, or quoted text that touches a number.
  ["SELECT 1 AS a$$ FROM permits; DROP TABLE permits; SELECT 1 AS a$$", "other_quoting", ["postgres"]],
  ["SELECT 1$$'$$; DROP TABLE permits; --'", "other_quoting", ["postgres"]],
  // Found by a review: with one token of the scan changed, each of these was
  // let through, and no test said so.
  [`SELECT "a\\" , " INTO OUTFILE '/tmp/x' -- "`, "backslash_quote"],
  ["SELECT 1 AS a_$$ FROM permits; COMMIT; DROP TABLE permits; SELECT 1 AS a_$$", "other_quoting", ["postgres"]],
  ["SELECT Q'[']' FROM permits FOR UPDATE --'", "other_quoting", ["oracle"]],
  ["SELECT 1\u2029", "control_character"],
  ["SELECT 1\u000b", "control_character"],
  ["SELECT 1\u007f", "control_character"],
  ["SELECT 1\r", "control_character"],
  ["DROP TABLE permits; SELECT 1", "not_a_select"],
  ["SELECT $é$ ' $é$; DROP TABLE permits; --'", "other_quoting", ["postgres"]],
  ["SELECT permit_no FROM permits WHERE valuation > $1", "other_quoting", ["postgres"]],
  ["SELECT $1DELETE FROM permits", "other_quoting", ["postgres"]],
  // A letter outside a to z is part of a name on some engines only.
  ["WITH é$$ AS (DELETE FROM permits RETURNING 1) SELECT 1 FROM é$$", "unquoted_letter"],
  ["SELECT 1 AS é$$ FROM permits; DROP TABLE permits; SELECT 1 AS é$$", "unquoted_letter"],
  ["SELECT straße FROM permits", "unquoted_letter"],
  ["SELECT 1 ＩＮＴＯ permits_copy", "unquoted_letter"],
  // Oracle's own way of quoting ends where its bracket closes.
  ["SELECT q'[']' FROM permits FOR UPDATE --'", "other_quoting", ["oracle"]],
  ["SELECT nq'[']' FROM permits", "other_quoting", ["oracle"]],
  // Oracle starts such text after a number too. So a quote right after a q is
  // refused there whatever stands before the q: a number, or the letters of a
  // name. No statement that reads has a quote right after a name.
  ["SELECT 1q'[a']' FROM permits FOR UPDATE --'", "other_quoting", ["oracle"]],
  ["SELECT xq'[a']' FROM permits FOR UPDATE --'", "other_quoting", ["oracle"]],
  ["SELECT 1.5Q'{x'}' FROM permits FOR UPDATE --'", "other_quoting", ["oracle"]],
  ["SELECT freq'x' FROM permits", "other_quoting", ["oracle"]],
  ["SELECT 1 `; DELETE FROM permits; -- `", "other_quoting", ["sqlserver", "oracle", "postgres"]],
  ["SELECT 1 {call sp_who}", "other_quoting", ["sqlserver"]],

  // ── A second statement with no semicolon, on SQL Server ───────────────────
  ["SELECT TOP 1 * FROM permits WITH (TABLOCKX, HOLDLOCK) WAITFOR DELAY '0:1:50'", "writes", ["sqlserver"]],
  ["SELECT 1 DECLARE @p binary(16) SELECT @p = TEXTPTR(note) FROM permits WRITETEXT permits.note @p 'gone'", "writes", ["sqlserver"]],
  ["SELECT 1 UPDATETEXT permits.note @p 0 NULL 'x'", "writes", ["sqlserver"]],
  ["SELECT 1 SET NOCOUNT ON", "writes", ["sqlserver"]],
  ["SELECT 1 USE master SELECT name FROM sys.sql_logins", "writes", ["sqlserver"]],
  ["SELECT 1 DISABLE TRIGGER audit_permits ON permits", "writes", ["sqlserver"]],
  ["SELECT 1 ADD SIGNATURE TO dbo.p BY CERTIFICATE c", "writes", ["sqlserver"]],
  ["SELECT 1 WHILE 1 = 1 SELECT 1", "writes", ["sqlserver"]],
  ["SELECT 1 BEGIN TRAN", "writes", ["sqlserver"]],
  ["SELECT 1 CHECKPOINT", "writes", ["sqlserver"]],
  ["SELECT 1 REVERT", "writes", ["sqlserver"]],
  ["SELECT 1 OPEN SYMMETRIC KEY k DECRYPTION BY PASSWORD = 'p'", "writes", ["sqlserver"]],
  ["SELECT 1 PRINT 'x'", "writes", ["sqlserver"]],
  ["SELECT * FROM permits LOCK IN SHARE MODE", "writes", ["mysql"]],

  // ── A character that is not text ──────────────────────────────────────────
  ["SELECT 1 -- x\u2028; DELETE FROM permits", "control_character"],
  ["SELECT 1 -- x\u0085DELETE FROM permits", "control_character"],
  ["SELECT 1\u0000", "control_character"],
  ["SELECT 1 -- x\fDELETE FROM permits", "control_character"],
];

describe("one statement that only reads, as far as its text says", () => {
  test.each(READS.map((sql) => [sql]))("runs on every engine: %s", (sql) => {
    for (const engine of ENGINES) expect([engine, statementRefusal(sql, engine)]).toEqual([engine, null]);
  });

  test.each(READS_ON)("runs on %s: %s", (engine, sql) => {
    expect(statementRefusal(sql, engine)).toBeNull();
  });

  // Every row is given its list of engines, so each has three values.
  const refused = REFUSED.map(([sql, why, on]): [string, string, readonly Engine[]] => [sql, why, on ?? ENGINES]);
  test.each(refused)("does not run: %s", (sql, why, on) => {
    for (const engine of on) {
      expect([engine, statementRefusal(sql, engine)]).toEqual([engine, why as ReturnType<typeof statementRefusal>]);
    }
  });

  test("every word that writes is refused as a word of its own, in any case", () => {
    for (const engine of ENGINES) {
      // The engine's own list is the object's own key.
      // eslint-disable-next-line security/detect-object-injection
      for (const word of [...WRITE_WORDS, ...ENGINE_WORDS[engine]]) {
        expect([word, statementRefusal(`SELECT 1 ${word} permits`, engine)]).toEqual([word, "writes"]);
        expect(statementRefusal(`select 1 ${word.toLowerCase()} permits`, engine)).toBe("writes");
        // Quoted, it is a name. Inside a longer word, it is another word.
        expect(statementRefusal(`SELECT "${word}" FROM permits`, engine)).toBeNull();
        expect(statementRefusal(`SELECT ${word}_count, last_${word} FROM permits`, engine)).toBeNull();
      }
    }
  });

  test("a word one engine reserves is a column's name on another", () => {
    // SQL Server reserves these, so there they start a statement of their own.
    for (const word of ["SET", "OPEN", "CLOSE", "IF", "BEGIN"]) {
      expect(statementRefusal(`SELECT ${word} FROM prices`, "sqlserver")).toBe("writes");
      expect(statementRefusal(`SELECT ${word} FROM prices`, "postgres")).toBeNull();
    }
  });

  test("a letter that becomes a plain one in upper case does not hide a word", () => {
    // U+017F, the long s, is S in upper case. Outside quotes it is not taken.
    for (const engine of ENGINES) {
      expect(statementRefusal("SELECT 1 IN\u017FERT permits", engine)).toBe("unquoted_letter");
    }
  });
});
