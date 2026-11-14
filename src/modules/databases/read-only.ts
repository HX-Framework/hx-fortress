// A scan of a statement's text, made before anything is started: is it one
// statement, and does it look like one that only reads?
//
// WHAT KEEPS A QUERY FROM CHANGING A DATABASE is not this file. It is the
// connection's login, which can only read: a query runs only on a connection
// whose last test found that (query.ts). And the data runner runs the
// statement in a transaction it rolls back.
//
// This scan is in front of both. It refuses a statement that is plainly not a
// read, before a secret is read or a program is started, and it leaves a line
// in the audit trail that says why. It reads the text only and asks no
// database anything, so there are things it cannot see. They are listed at the
// end of this comment, and in SECURITY.md.
//
// THE RULE. Take the quoted text and the comments out of the statement. What
// is left must start with SELECT or WITH, must be one statement, and must hold
// none of the words below as a word of its own. A column that has such a name
// is written in quotes, and then it is not looked at.
//
// EACH ENGINE IS READ ITS OWN WAY. The engines do not agree on what is a
// quote. So the scan is told the connection's engine:
//
//   • `[name]` is a quoted name on SQL Server, where `]]` is a `]` inside it.
//     On the other engines a bracket is an ordinary character.
//   • `$$text$$` and `$tag$text$tag$` are quoted text on PostgreSQL only.
//   • A backtick quotes a name on MySQL only. Elsewhere it is refused.
//   • On SQL Server a second statement needs no semicolon, so the words that
//     start one there are refused too. SQL Server reserves every one of them,
//     so none can be a column's name without quotes.
//
// WHAT TWO ENGINES COULD READ DIFFERENTLY IS REFUSED, NOT GUESSED AT:
//
//   • `#` outside quotes: a comment on MySQL, an operator elsewhere
//   • `--` with no space after it: MySQL reads two minus signs
//   • a backslash before a quote inside quoted text: some engines escape the
//     quote, the others end the text
//   • `/*! … */`: a comment MySQL runs
//   • a `/*` inside a comment: some engines nest comments, the others do not
//   • Oracle's `q'[…]'` and SQL Server's `{call …}`
//   • a control character other than a tab or a line end
//   • a carriage return that no line feed follows: some engines end a `--`
//     comment there and some do not
//   • a letter outside a to z that stands outside quotes: the engines do not
//     agree on which of them are part of a name. A name that holds one is
//     written in quotes
//   • on PostgreSQL, a `$` that does not open quoted text: a parameter, part
//     of a name, or quoted text that touches a number. A query has no
//     parameters
//   • a quote, a bracket or a comment that is never closed
//
// WHAT A SCAN OF THE TEXT CANNOT SEE. A function that does more than read
// (one that takes the next number of a sequence, sleeps, or calls out of the
// database). On SQL Server, a second SELECT, and a second statement that
// starts with a word SQL Server does not reserve. A statement that holds a lock
// for as long as it runs. Each of these is bounded by what the connection's
// login may do and by the two minutes a job may take.

import type { Engine } from "./manifest";

/** Why a statement is not taken. */
export type StatementRefusal =
  | "empty"
  | "not_a_select"
  | "several_statements"
  | "writes"
  | "not_closed"
  | "backslash_quote"
  | "dashes_without_space"
  | "hash_sign"
  | "comment_that_runs"
  | "nested_comment"
  | "control_character"
  | "unquoted_letter"
  | "other_quoting";

/**
 * The words that change a database, or reach outside it, on every engine. A
 * statement that holds one outside quotes and comments does not run. `INTO` is
 * here because SELECT INTO writes a table or a file.
 */
export const WRITE_WORDS: readonly string[] = [
  "INTO",
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "TRUNCATE",
  "DROP",
  "ALTER",
  "CREATE",
  "GRANT",
  "REVOKE",
  "DENY",
  "EXEC",
  "EXECUTE",
  "COMMIT",
  "ROLLBACK",
  "BACKUP",
  "RESTORE",
  "DBCC",
  "KILL",
  "SHUTDOWN",
  "RECONFIGURE",
  "OPENROWSET",
  "OPENDATASOURCE",
  "OPENQUERY",
];

/**
 * Words that start a statement of their own on one engine and are no part of a
 * SELECT there. Each engine reserves its words, so a column cannot have one of
 * these names without quotes.
 */
export const ENGINE_WORDS: Readonly<Record<Engine, readonly string[]>> = {
  sqlserver: [
    "DECLARE",
    "SET",
    "USE",
    "TRAN",
    "TRANSACTION",
    "TRIGGER",
    "ADD",
    "BREAK",
    "CONTINUE",
    "DUMP",
    "LOAD",
    "WAITFOR",
    "WRITETEXT",
    "UPDATETEXT",
    "READTEXT",
    "CHECKPOINT",
    "REVERT",
    "SETUSER",
    "OPEN",
    "CLOSE",
    "DEALLOCATE",
    "BEGIN",
    "WHILE",
    "IF",
    "GOTO",
    "RETURN",
    "PRINT",
    "RAISERROR",
    "SAVE",
    "BULK",
  ],
  // LOCK IN SHARE MODE holds rows locked for as long as the statement's
  // transaction lasts.
  mysql: ["LOCK"],
  postgres: [],
  oracle: [],
};

const isSpace = (char: string): boolean => char === " " || char === "\t" || char === "\r" || char === "\n";
const isDigit = (char: string): boolean => char >= "0" && char <= "9";
/** A character a name may hold on some engine. */
const inName = (char: string): boolean => /[A-Za-z0-9_$@#]/.test(char);
const startsWord = (char: string): boolean => /[A-Za-z_$@#]/.test(char);

/** What stands in the bare text where quoted text was. Not a space, so that a
 *  statement which begins with quoted text does not begin with SELECT. */
const QUOTED = '"';

/** Whether the text holds a character no statement needs and no two engines
 *  are known to read alike. */
function hasControlCharacter(sql: string): boolean {
  for (let at = 0; at < sql.length; at += 1) {
    const code = sql.charCodeAt(at);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
    if (code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) return true;
    // A carriage return alone ends a `--` comment on some engines and not on
    // others. One that a line feed follows is a line end everywhere.
    if (code === 0x0d && sql.charCodeAt(at + 1) !== 0x0a) return true;
  }
  return false;
}

type Scan = { text: string } | { refusal: StatementRefusal };

/**
 * The statement without its quoted text and its comments. Quoted text is
 * replaced by a mark and a comment by a space. Or why the text is not taken.
 */
function bare(sql: string, engine: Engine): Scan {
  let text = "";
  let at = 0;
  while (at < sql.length) {
    const char = sql.charAt(at);
    const next = sql.charAt(at + 1);
    const before = sql.charAt(at - 1);

    if (char === "'" || char === '"' || char === "`") {
      if (char === "`" && engine !== "mysql") return { refusal: "other_quoting" };
      if (char === "'" && engine === "oracle" && (before === "q" || before === "Q")) {
        // q'[…]' ends where its own bracket closes, not at the next quote.
        const lead = sql.charAt(at - 2);
        const outer = lead === "n" || lead === "N" ? sql.charAt(at - 3) : lead;
        if (outer === "" || !inName(outer)) return { refusal: "other_quoting" };
      }
      // Quoted text ends at the same quote. Two of them in a row is one quote
      // inside the text.
      let end = at + 1;
      let closed = false;
      while (end < sql.length) {
        const inside = sql.charAt(end);
        if (inside === "\\" && sql.charAt(end + 1) === char) return { refusal: "backslash_quote" };
        if (inside === char) {
          if (sql.charAt(end + 1) === char) {
            end += 2;
            continue;
          }
          closed = true;
          break;
        }
        end += 1;
      }
      if (!closed) return { refusal: "not_closed" };
      at = end + 1;
      text += QUOTED;
    } else if (char === "[" && engine === "sqlserver") {
      let end = at + 1;
      let closed = false;
      while (end < sql.length) {
        if (sql.charAt(end) === "]") {
          if (sql.charAt(end + 1) === "]") {
            end += 2;
            continue;
          }
          closed = true;
          break;
        }
        end += 1;
      }
      if (!closed) return { refusal: "not_closed" };
      at = end + 1;
      text += QUOTED;
    } else if (char === "{" && engine === "sqlserver") {
      return { refusal: "other_quoting" };
    } else if (char === "$" && engine === "postgres") {
      // `$$` or `$tag$` opens quoted text, where it does not touch a name
      // before it. PostgreSQL reads any other `$` by what stands around it: a
      // parameter, part of a name, or quoted text after a number. A query has
      // no parameters, so any other `$` is not taken.
      let tagEnd = at + 1;
      while (tagEnd < sql.length && /[A-Za-z0-9_]/.test(sql.charAt(tagEnd))) tagEnd += 1;
      const opens = !/[A-Za-z0-9_$]/.test(before) && sql.charAt(tagEnd) === "$" && !isDigit(next);
      if (!opens) return { refusal: "other_quoting" };
      const tag = sql.slice(at, tagEnd + 1);
      const close = sql.indexOf(tag, tagEnd + 1);
      if (close < 0) return { refusal: "not_closed" };
      at = close + tag.length;
      text += QUOTED;
    } else if (char === "#") {
      return { refusal: "hash_sign" };
    } else if (char === "-" && next === "-") {
      const after = sql.charAt(at + 2);
      if (after !== "" && !isSpace(after)) return { refusal: "dashes_without_space" };
      let end = at + 2;
      while (end < sql.length && sql.charAt(end) !== "\n" && sql.charAt(end) !== "\r") end += 1;
      at = end;
      text += " ";
    } else if (char === "/" && next === "*") {
      const lead = sql.slice(at + 2, at + 4);
      if (lead.startsWith("!") || lead === "M!" || lead === "m!") return { refusal: "comment_that_runs" };
      const close = sql.indexOf("*/", at + 2);
      if (close < 0) return { refusal: "not_closed" };
      const again = sql.indexOf("/*", at + 2);
      if (again >= 0 && again < close) return { refusal: "nested_comment" };
      at = close + 2;
      text += " ";
    } else {
      if (sql.charCodeAt(at) > 0x7e) return { refusal: "unquoted_letter" };
      text += char;
      at += 1;
    }
  }
  return { text };
}

/**
 * The words of a bare statement, in upper case. Null when a number runs into a
 * word that writes: an engine reads `1e1DELETE` as a number and then DELETE.
 */
function wordsOf(text: string, writes: ReadonlySet<string>): string[] | null {
  const words: string[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    const next = text.charAt(at + 1);
    if (isDigit(char) || ((char === "." || char === "$") && isDigit(next))) {
      let end = at + 1;
      while (end < text.length && (inName(text.charAt(end)) || text.charAt(end) === ".")) end += 1;
      const number = text.slice(at, end);
      for (const word of writes) if (number.includes(word)) return null;
      at = end;
    } else if (startsWord(char)) {
      let end = at + 1;
      while (end < text.length && inName(text.charAt(end))) end += 1;
      const word = text.slice(at, end);
      words.push(word);
      // MySQL reads `INTO@x` as INTO and a variable.
      const sign = word.indexOf("@");
      if (sign > 0) words.push(word.slice(0, sign));
      at = end;
    } else {
      at += 1;
    }
  }
  return words;
}

/**
 * Why a statement is not taken for a connection of this engine, or null when
 * it is one statement that reads as far as its text says.
 */
export function statementRefusal(sql: string, engine: Engine): StatementRefusal | null {
  if (hasControlCharacter(sql)) return "control_character";
  const read = bare(sql, engine);
  if ("refusal" in read) return read.refusal;
  const text = read.text.trim().toUpperCase();
  if (text === "") return "empty";
  // The engine's own words are the object's own keys, from a closed list.
  // eslint-disable-next-line security/detect-object-injection
  const writes = new Set([...WRITE_WORDS, ...ENGINE_WORDS[engine]]);
  const words = wordsOf(text, writes);
  if (words === null) return "writes";
  const first = words[0];
  if ((first !== "SELECT" && first !== "WITH") || !text.startsWith(first)) return "not_a_select";
  const semicolon = text.indexOf(";");
  if (semicolon >= 0 && text.slice(semicolon + 1).trim() !== "") return "several_statements";
  return words.some((word) => writes.has(word)) ? "writes" : null;
}
