// Whether a statement is one statement that only reads.
//
// A query for a data island is one SELECT. This is the Fortress's own check of
// that, made before anything is started. It is the first of three things that
// keep a query from changing a database. The data runner makes the same check
// again, by the same rule, and runs the statement in a transaction it rolls
// back. And the connection's login is one that can only read.
//
// THE RULE. Take the quoted text and the comments out of the statement. What
// is left must start with SELECT or WITH, must be one statement, and must hold
// none of the words below as a word of its own. A column that has such a name
// is written in quotes, and then it is not looked at.
//
// ANYTHING THE ENGINES READ DIFFERENTLY IS REFUSED, NOT GUESSED AT. The four
// engines do not agree on where a comment or a string ends. A text that one of
// them would read as a comment and another as a statement is refused, so that
// what this check saw is what every engine runs:
//
//   • `#` outside quotes: a comment on MySQL, an operator elsewhere
//   • `--` with no space after it: MySQL reads two minus signs
//   • a backslash before a quote inside a string: MySQL escapes the quote, the
//     others end the string
//   • `/*! … */`: a comment MySQL runs
//   • a quote, a bracket or a comment that is never closed
//
// It reads the text only. It asks no database anything.

/** Why a statement is not one statement that only reads. */
export type StatementRefusal =
  | "empty"
  | "not_a_select"
  | "several_statements"
  | "writes"
  | "not_closed"
  | "backslash_quote"
  | "dashes_without_space"
  | "hash_sign"
  | "comment_that_runs";

/**
 * The words that change a database, or reach outside it. A statement that
 * holds one outside quotes and comments does not run. `INTO` is here because
 * SELECT INTO writes a table or a file.
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

const WRITES: ReadonlySet<string> = new Set(WRITE_WORDS);

const isSpace = (char: string | undefined): boolean =>
  char === " " || char === "\t" || char === "\r" || char === "\n";

/** A character a word may start with, and one it may go on with. */
const startsWord = (char: string): boolean => /[A-Za-z_$@]/.test(char);
const continuesWord = (char: string): boolean => /[A-Za-z0-9_$@]/.test(char);

/**
 * The statement without its quoted text and its comments, each replaced by one
 * space. Or why it cannot be read the same way on every engine.
 */
function bare(sql: string): { text: string } | { refusal: StatementRefusal } {
  let text = "";
  let at = 0;
  while (at < sql.length) {
    const char = sql.charAt(at);
    const next = sql.charAt(at + 1);
    if (char === "'" || char === '"' || char === "`") {
      // A quoted text ends at the same quote. Two of them in a row is one
      // quote inside the text.
      let end = at + 1;
      let closed = false;
      while (end < sql.length) {
        const inside = sql.charAt(end);
        if (char !== "`" && inside === "\\" && sql.charAt(end + 1) === char) {
          return { refusal: "backslash_quote" };
        }
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
      text += " ";
    } else if (char === "[") {
      const close = sql.indexOf("]", at);
      if (close < 0) return { refusal: "not_closed" };
      at = close + 1;
      text += " ";
    } else if (char === "#") {
      return { refusal: "hash_sign" };
    } else if (char === "-" && next === "-") {
      const after = sql.charAt(at + 2);
      if (after !== "" && !isSpace(after)) return { refusal: "dashes_without_space" };
      const lineEnd = sql.indexOf("\n", at);
      at = lineEnd < 0 ? sql.length : lineEnd + 1;
      text += " ";
    } else if (char === "/" && next === "*") {
      const body = sql.slice(at + 2, at + 4);
      if (body.startsWith("!") || body === "M!") return { refusal: "comment_that_runs" };
      const close = sql.indexOf("*/", at + 2);
      if (close < 0) return { refusal: "not_closed" };
      at = close + 2;
      text += " ";
    } else {
      text += char;
      at += 1;
    }
  }
  return { text };
}

/** The words of a bare statement, upper case, in order. */
function wordsOf(text: string): string[] {
  const words: string[] = [];
  let at = 0;
  while (at < text.length) {
    if (!startsWord(text.charAt(at))) {
      at += 1;
      continue;
    }
    let end = at + 1;
    while (end < text.length && continuesWord(text.charAt(end))) end += 1;
    words.push(text.slice(at, end));
    at = end;
  }
  return words;
}

/** Why a statement does not run, or null when it is one statement that only
 *  reads. */
export function statementRefusal(sql: string): StatementRefusal | null {
  const read = bare(sql);
  if ("refusal" in read) return read.refusal;
  const text = read.text.trim().toUpperCase();
  if (text === "") return "empty";
  const words = wordsOf(text);
  const first = words[0];
  if ((first !== "SELECT" && first !== "WITH") || !text.startsWith(first)) return "not_a_select";
  const semicolon = text.indexOf(";");
  if (semicolon >= 0 && text.slice(semicolon + 1).trim() !== "") return "several_statements";
  return words.some((word) => WRITES.has(word)) ? "writes" : null;
}
