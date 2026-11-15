// What a Store's statement may not be.
//
// A person, or the control plane's agent, writes the statements a Store runs.
// The engine was written for a platform that refuses a statement which reaches
// outside the Store. This runtime's SQLite refuses nothing of the kind and
// offers no hook to refuse with, so this file does it, before a statement is
// handed to SQLite at all.
//
// A STATEMENT REACHES ONLY ITS OWN STORE'S FILE. Refused, wherever in the text
// it stands (in another letter case, behind a comment, as a second statement
// after a semicolon, after EXPLAIN):
//
//   • ATTACH and DETACH: ATTACH opens any SQLite file the process can read,
//     another organization's Store among them.
//   • VACUUM, with or without INTO: INTO writes a copy of the Store to any path.
//   • A PRAGMA that is not on the short list below, and the same PRAGMA written
//     as a table (`pragma_…`).
//   • Loading an extension, the one built-in function that takes a pointer,
//     and the two functions that read and write a file where a build has them.
//   • A virtual table of any module but full text search: made with CREATE
//     VIRTUAL TABLE, or named as a table where the module lets itself be read
//     without one. Two such tables compile SQL text that a VALUE holds
//     (`bytecode`, `tables_used`), and a PRAGMA takes effect when it is
//     compiled. So a statement may not name any module of this SQLite but full
//     text search and the two that read JSON.
//
//     WHAT THAT COSTS. The name is refused wherever it stands, because the
//     text does not say whether a name is a table's or a column's, and SQLite
//     takes a table's name in single quotes too. So a table or a column of a
//     Store cannot be called `bytecode`, `tables_used`, or by the name of
//     another module this SQLite has (`dbstat`, `rtree`, `fts3`, `fts4`), and
//     a statement cannot hold one of those names as a text of its own: such a
//     text is bound as a value.
//   • A statement whose first word is not one of the kinds a Store runs. The
//     list is closed, so a kind of statement that a later SQLite adds does not
//     run here until somebody adds it.
//
// Also refused, because the platform refuses them and the engine counts on it:
// the statements that begin and end a transaction (the host owns those), and a
// statement past the platform's limits where the text can show it.
//
// And one more, because the host keeps a transaction of its own open around a
// Store's writes (sql-storage.ts): ROLLBACK as what a statement does on a
// conflict (`INSERT OR ROLLBACK`, `ON CONFLICT ROLLBACK`, `RAISE(ROLLBACK, …)`).
// Each ends the whole transaction, the host's included.
//
// HOW IT IS HELD. sql-text.ts cuts the text as SQLite does, and refuses what
// it cannot cut with certainty. This file then looks at the first word of
// every statement, where a statement starts at the beginning of the text and
// after EVERY semicolon, also inside a trigger's body. A statement SQLite
// would run starts at one of those places, so a refused word cannot be the
// first word of anything that runs. The names that are refused anywhere are
// looked for in every token.
//
// It is one of three things that hold the rule. The second is in sql-storage.ts:
// a statement is handed to SQLite with a call that compiles the first statement
// of a text and no more. The third is there too: after every statement the
// host asks SQLite which files the connection has open, and ends the Store's
// process when it is more than the Store's own.

import { asciiLower, asciiUpper, scanSql, type Token } from "./sql-text";

// ── The platform's limits ────────────────────────────────────────────────────

export const SQL_LIMITS = {
  /** Bytes of UTF-8 in one text handed to `exec`. */
  sqlBytes: 100_000,
  /** Values one statement may bind. */
  variables: 100,
  /** Columns in a result, and in a table. */
  columns: 100,
  /** Bytes in one text or blob value. */
  valueBytes: 2_000_000,
  /** Bytes in a LIKE or GLOB pattern. */
  likePatternBytes: 50,
  /** SELECTs joined by UNION, INTERSECT and EXCEPT. */
  compoundSelects: 5,
} as const;

/** The PRAGMAs a statement may run. Each reads the Store's own schema, checks
 *  the Store's own file, or changes how this one connection reads a statement.
 *  None names a file or a folder. It is the platform's own list. */
export const ALLOWED_PRAGMAS: ReadonlySet<string> = new Set([
  "table_list",
  "table_info",
  "table_xinfo",
  "data_version",
  "page_size",
  "case_sensitive_like",
  "foreign_keys",
  "defer_foreign_keys",
  "ignore_check_constraints",
  "legacy_alter_table",
  "recursive_triggers",
  "reverse_unordered_selects",
  "foreign_key_check",
  "foreign_key_list",
  "index_info",
  "index_list",
  "index_xinfo",
  "quick_check",
  "optimize",
]);

/** The modules a virtual table may use. */
const ALLOWED_MODULES: ReadonlySet<string> = new Set(["fts5", "fts5vocab"]);

/**
 * The modules of SQLite whose names a statement may hold: full text search,
 * and the two tables that read a JSON value. Every other module this SQLite
 * has is refused by name (sql-storage.ts reads the list from SQLite itself and
 * hands it to `readStatements`).
 */
export const NAMEABLE_MODULES: ReadonlySet<string> = new Set([
  "fts5",
  "fts5vocab",
  "json_each",
  "json_tree",
]);

/**
 * Modules that are refused by name whatever SQLite says it has: the ones a
 * build of SQLite itself can hold that reach past a Store's rows. `bytecode`
 * and `tables_used` compile SQL text that a value holds. `sqlite_dbpage` reads
 * and writes the file's pages. `sqlite_stmt` lists the text of every statement
 * of the connection.
 */
const REFUSED_MODULES: ReadonlySet<string> = new Set([
  "bytecode",
  "tables_used",
  "sqlite_dbpage",
  "sqlite_stmt",
]);

const NO_NAMES: ReadonlySet<string> = new Set();

/** Functions no statement may name. `load_extension` runs code from a file.
 *  `fts3_tokenizer` hands out, and takes, an address inside the process. The
 *  other two read and write a file, in a build that has them. */
const REFUSED_FUNCTIONS: ReadonlySet<string> = new Set([
  "load_extension",
  "fts3_tokenizer",
  "readfile",
  "writefile",
]);

/** What the platform says to a statement that begins or ends a transaction. */
export const TRANSACTION_MESSAGE =
  "To execute a transaction, please use the state.storage.transaction() or " +
  "state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.";

const TRANSACTION_WORDS: ReadonlySet<string> = new Set([
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

/**
 * The first words of the statements a Store runs. A statement that starts with
 * any other word is refused, in the words SQLite has for a word it does not
 * know. ATTACH, DETACH and VACUUM are refused before this list is looked at,
 * and so are the words of a transaction, each with a refusal of its own.
 */
const STATEMENT_WORDS: ReadonlySet<string> = new Set([
  "SELECT",
  "VALUES",
  "WITH",
  "INSERT",
  "REPLACE",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "PRAGMA",
  "REINDEX",
  "ANALYZE",
]);

/** The first words of the statements that write nothing: the host opens no
 *  transaction of its own for one. */
const READ_WORDS: ReadonlySet<string> = new Set(["SELECT", "VALUES", "PRAGMA"]);

// ── A refusal ────────────────────────────────────────────────────────────────

/** Which rule refused a statement. One word, for an audit record and a test. */
export type SqlRule =
  | "attach"
  | "detach"
  | "vacuum"
  | "pragma"
  | "extension"
  | "virtual_table"
  | "statement_kind"
  | "transaction"
  | "unreadable"
  | "too_long"
  | "too_many_variables"
  | "too_many_columns"
  | "too_many_selects"
  | "pattern_too_long"
  | "value_too_big"
  | "bindings"
  | "binding_type";

export type SqlResultCode = "SQLITE_AUTH" | "SQLITE_ERROR" | "SQLITE_TOOBIG";

/**
 * The host refused a statement.
 *
 * A refusal that comes from reading the text (this file) comes before any
 * statement of the text ran. sql-storage.ts raises a few more when a statement
 * is reached, and says for each what ran before it.
 *
 * The message is SQLite's own words for the refusal and then the result code's
 * name, as the platform writes its errors. Two of them name a piece of the
 * statement, as SQLite's own do: the first word of a statement of no known
 * kind, and the table that has too many columns. So a refusal's words are held
 * like a statement's own text: they are for the person whose statement it was,
 * and go into no log and no record.
 */
export class SqlRefused extends Error {
  readonly rule: SqlRule;
  readonly code: SqlResultCode | null;

  constructor(rule: SqlRule, words: string, code: SqlResultCode | null) {
    super(code ? `${words}: ${code}` : words);
    this.name = "SqlRefused";
    this.rule = rule;
    this.code = code;
  }
}

function notAuthorized(rule: SqlRule): SqlRefused {
  return new SqlRefused(rule, "not authorized", "SQLITE_AUTH");
}

// ── Reading a text ───────────────────────────────────────────────────────────

/** One statement of a text, ready to be handed to SQLite. */
export interface StatementPiece {
  /** The statement's own text, without the semicolon that ends it. */
  text: string;
  /** How many values it binds: the largest number any of its variables has. */
  variables: number;
  /** The numbers of the variables that stand where a LIKE or GLOB pattern
   *  does. The host checks the length of what is bound to each. */
  patternVariables: number[];
  /** It makes or changes a table, so the host checks the table's columns. */
  changesTables: boolean;
  /** It writes nothing: a SELECT, a VALUES, a PRAGMA, or an EXPLAIN of any
   *  statement. The host opens no transaction of its own for it. */
  reads: boolean;
  /** It reads or changes rows and nothing else, so what was compiled before it
   *  still holds after it. Any other statement may change the schema. */
  leavesSchema: boolean;
  /**
   * The host may keep it compiled for its next run: a statement that reads or
   * changes rows. An EXPLAIN is never kept: SQLite counts one as running until
   * it is put away, and nothing can be kept while a statement runs.
   */
  kept: boolean;
}

/** The first words of the statements that leave the schema as it is. */
const ROW_WORDS: ReadonlySet<string> = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "WITH",
  "VALUES",
]);

function isWord(token: Token | undefined, upper: string): boolean {
  return token !== undefined && token.kind === "word" && asciiUpper(token.text) === upper;
}

/** A token that can stand where SQLite takes a name: a word, a quoted name, or
 *  text in single quotes (SQLite takes that for a name too). */
function nameOf(token: Token | undefined): string | null {
  if (!token) return null;
  if (token.kind === "word" || token.kind === "quoted" || token.kind === "string") {
    return asciiLower(token.text);
  }
  return null;
}

/** Where the statement that starts at `from` has its first word: past EXPLAIN
 *  and EXPLAIN QUERY PLAN. */
function leadIndex(tokens: readonly Token[], from: number): number {
  let i = from;
  if (isWord(tokens.at(i), "EXPLAIN")) {
    i += 1;
    if (isWord(tokens.at(i), "QUERY") && isWord(tokens.at(i + 1), "PLAN")) i += 2;
  }
  return i;
}

/**
 * Refuse the statement that starts at `from`, if its first word is one that
 * reaches outside the Store. Run at every place a statement can start.
 */
function refuseReach(tokens: readonly Token[], from: number): void {
  const at = leadIndex(tokens, from);
  const lead = tokens.at(at);
  if (!lead || lead.kind !== "word") return;
  const word = asciiUpper(lead.text);
  if (word === "ATTACH") throw notAuthorized("attach");
  if (word === "DETACH") throw notAuthorized("detach");
  if (word === "VACUUM") throw notAuthorized("vacuum");
  if (word === "PRAGMA") {
    // PRAGMA name, PRAGMA schema.name. Anything else after the word is not a
    // PRAGMA this host can name, so it does not run.
    let name = nameOf(tokens.at(at + 1));
    const dot = tokens.at(at + 2);
    if (name !== null && dot?.kind === "punct" && dot.text === ".") name = nameOf(tokens.at(at + 3));
    if (name === null || !ALLOWED_PRAGMAS.has(name)) throw notAuthorized("pragma");
  }
}

/** Refuse a token that names something no statement may name, wherever it
 *  stands. */
function refuseName(token: Token, modules: ReadonlySet<string>): void {
  if (token.kind !== "word" && token.kind !== "quoted" && token.kind !== "string") return;
  const name = asciiLower(token.text);
  // A module that lets itself be read as a table with no CREATE VIRTUAL TABLE.
  // SQLite takes a table's name in single quotes too, so text that is exactly
  // such a name is refused with the rest.
  if (REFUSED_MODULES.has(name) || modules.has(name)) throw notAuthorized("virtual_table");
  // A PRAGMA can be read as a table: `SELECT * FROM pragma_database_list`.
  // SQLite takes a table's name in single quotes too, so text that is exactly
  // such a name is refused with the rest.
  if (name.startsWith("pragma_") && /^pragma_[a-z0-9_]+$/.test(name)) {
    if (!ALLOWED_PRAGMAS.has(name.slice("pragma_".length))) throw notAuthorized("pragma");
    return;
  }
  if (token.kind !== "string" && REFUSED_FUNCTIONS.has(name)) throw notAuthorized("extension");
}

/**
 * Refuse ROLLBACK where it says what a statement does on a conflict.
 *
 * `INSERT OR ROLLBACK`, `UPDATE OR ROLLBACK`, a table's `ON CONFLICT ROLLBACK`
 * and a trigger's `RAISE(ROLLBACK, …)` end the whole transaction when a row
 * conflicts. The host keeps a transaction of its own open around a Store's
 * writes, and that one would end with it. Those are the three places the
 * grammar has the word in, and each is looked for by the words before it. A
 * column that is called `rollback` in a condition (`a OR rollback`) is none of
 * them.
 */
function refuseConflictRollback(tokens: readonly Token[], index: number): void {
  if (!isWord(tokens.at(index), "ROLLBACK") || index < 2) return;
  const before = tokens.at(index - 1);
  const twoBefore = tokens.at(index - 2);
  const afterInsert = isWord(before, "OR") && (isWord(twoBefore, "INSERT") || isWord(twoBefore, "UPDATE"));
  const onConflict = isWord(before, "CONFLICT") && isWord(twoBefore, "ON");
  const raised = before?.kind === "punct" && before.text === "(" && isWord(twoBefore, "RAISE");
  if (afterInsert || onConflict || raised) throw notAuthorized("transaction");
}

/** The number SQLite gives each variable of one statement, and the largest. */
class Variables {
  private largest = 0;
  private readonly named = new Map<string, number>();

  /** The number of the variable `token`. */
  number(token: Token): number {
    const text = token.text;
    let n: number;
    if (text === "?") {
      n = this.largest + 1;
    } else if (text.startsWith("?")) {
      n = Number(text.slice(1));
      // "?0" and a number past what SQLite can hold are SQLite's to refuse.
      if (!Number.isSafeInteger(n) || n < 1) n = SQL_LIMITS.variables + 1;
    } else {
      n = this.named.get(text) ?? this.largest + 1;
      this.named.set(text, n);
    }
    this.largest = Math.max(this.largest, n);
    return n;
  }

  get count(): number {
    return this.largest;
  }
}

/**
 * Read one text handed to `exec`: refuse it, or cut it into its statements.
 *
 * `modules` holds the names of this SQLite's virtual table modules that no
 * statement may name, in small letters.
 *
 * THROWS `SqlRefused` when any statement of the text is one the host does not
 * run. Then none of them runs.
 */
export function readStatements(
  sql: string,
  modules: ReadonlySet<string> = NO_NAMES,
): StatementPiece[] {
  if (Buffer.byteLength(sql, "utf8") > SQL_LIMITS.sqlBytes) {
    throw new SqlRefused("too_long", "statement too long", "SQLITE_TOOBIG");
  }
  const scan = scanSql(sql);
  if (!scan.ok) throw new SqlRefused("unreadable", "unrecognized token", "SQLITE_ERROR");
  const { tokens } = scan;

  // Everywhere a statement can start, and every token.
  refuseReach(tokens, 0);
  tokens.forEach((token, index) => {
    if (token.kind === "semi") refuseReach(tokens, index + 1);
    refuseName(token, modules);
    refuseConflictRollback(tokens, index);
  });

  const pieces: StatementPiece[] = [];
  let index = 0;
  while (index < tokens.length) {
    if (tokens.at(index)?.kind === "semi") {
      index += 1;
      continue;
    }
    // Looked at again here, whatever stands before it: this is a place where
    // the host itself starts a statement, and SQLite is handed what starts
    // here as a statement of its own.
    refuseReach(tokens, index);
    const end = statementEnd(tokens, index);
    // A statement ends at a semicolon or at the end of the text. A trigger is
    // cut after its END, and what follows that END with no semicolon between
    // is no statement to SQLite: the whole text is one that it refuses.
    const after = tokens.at(end);
    if (after && after.kind !== "semi") {
      throw new SqlRefused("unreadable", `near "${after.text.slice(0, 40)}": syntax error`, "SQLITE_ERROR");
    }
    pieces.push(readPiece(sql, tokens, index, end));
    index = end;
  }
  return pieces;
}

/**
 * Where the statement that starts at `from` ends: the index of the semicolon
 * that ends it, or the number of tokens.
 *
 * A trigger holds statements of its own, each ended by a semicolon. Its text
 * runs to the END that follows one of them.
 */
function statementEnd(tokens: readonly Token[], from: number): number {
  const lead = leadIndex(tokens, from);
  let trigger = false;
  if (isWord(tokens.at(lead), "CREATE")) {
    let next = lead + 1;
    if (isWord(tokens.at(next), "TEMP") || isWord(tokens.at(next), "TEMPORARY")) next += 1;
    trigger = isWord(tokens.at(next), "TRIGGER");
  }
  for (let i = from; i < tokens.length; i += 1) {
    if (tokens.at(i)?.kind !== "semi") continue;
    if (!trigger) return i;
    // The END that closes the trigger: the statement runs up to and with it.
    if (isWord(tokens.at(i + 1), "END")) return i + 2;
  }
  return tokens.length;
}

function readPiece(
  sql: string,
  tokens: readonly Token[],
  from: number,
  end: number,
): StatementPiece {
  const first = tokens.at(leadIndex(tokens, from));
  const firstWord = first?.kind === "word" ? asciiUpper(first.text) : "";

  // A transaction's own statements are the host's to run.
  if (TRANSACTION_WORDS.has(firstWord)) {
    throw new SqlRefused("transaction", TRANSACTION_MESSAGE, null);
  }
  // A word that starts no statement a Store runs. What starts with something
  // that is no word at all (a bracket, a number) is left for SQLite to refuse.
  if (first?.kind === "word" && !STATEMENT_WORDS.has(firstWord)) {
    throw new SqlRefused("statement_kind", `near "${first.text}": syntax error`, "SQLITE_ERROR");
  }

  const variables = new Variables();
  /** The variables that stand where a pattern does, until the loop numbers them. */
  const patterns = new Set<Token>();
  const patternVariables: number[] = [];
  // How many SELECTs are joined so far, at each depth of brackets.
  const joined: number[] = [0];
  let virtualTable = false;

  for (let i = from; i < end; i += 1) {
    const token = tokens.at(i) as Token;
    const next = i + 1 < end ? tokens.at(i + 1) : undefined;
    if (token.kind === "variable") {
      const n = variables.number(token);
      if (patterns.has(token)) patternVariables.push(n);
      continue;
    }
    if (token.kind === "semi") {
      // Inside a trigger: the next statement of its body counts anew.
      joined.length = 1;
      joined[0] = 0;
      continue;
    }
    if (token.kind === "punct") {
      if (token.text === "(") joined.push(0);
      else if (token.text === ")" && joined.length > 1) joined.pop();
      continue;
    }
    if (token.kind !== "word") continue;
    const word = asciiUpper(token.text);

    if (word === "UNION" || word === "INTERSECT" || word === "EXCEPT") {
      const selects = (joined.pop() ?? 0) + 1;
      joined.push(selects);
      if (selects + 1 > SQL_LIMITS.compoundSelects) {
        throw new SqlRefused("too_many_selects", "too many terms in compound SELECT", "SQLITE_ERROR");
      }
      continue;
    }

    if (word === "LIKE" || word === "GLOB") {
      // `x LIKE 'pattern'`, `x LIKE ?`, and the same two as a function, whose
      // first value is the pattern: `like('pattern', x)`.
      const called = next?.kind === "punct" && next.text === "(";
      const pattern = called ? (i + 2 < end ? tokens.at(i + 2) : undefined) : next;
      if (pattern?.kind === "string") {
        if (Buffer.byteLength(pattern.text, "utf8") > SQL_LIMITS.likePatternBytes) {
          throw new SqlRefused("pattern_too_long", "LIKE or GLOB pattern too complex", "SQLITE_ERROR");
        }
      } else if (pattern?.kind === "variable") {
        patterns.add(pattern);
      }
      continue;
    }

    if (word === "VIRTUAL" && isWord(next, "TABLE")) {
      virtualTable = true;
      continue;
    }
    if (virtualTable && word === "USING") {
      const module = nameOf(next);
      if (module === null || !ALLOWED_MODULES.has(module)) throw notAuthorized("virtual_table");
      virtualTable = false;
    }
  }
  // A virtual table with no USING is not a statement SQLite runs. It is refused
  // here all the same, so that no spelling of one is let through.
  if (virtualTable) throw notAuthorized("virtual_table");

  if (variables.count > SQL_LIMITS.variables) {
    throw new SqlRefused("too_many_variables", "too many SQL variables", "SQLITE_ERROR");
  }

  // EXPLAIN runs nothing of the statement it explains.
  const explained = isWord(tokens.at(from), "EXPLAIN");
  const start = (tokens.at(from) as Token).start;
  const last = tokens.at(end - 1) as Token;
  // The semicolon that ends the statement is not part of it.
  const stop = last.kind === "semi" ? last.start : last.end;
  return {
    text: sql.slice(start, stop),
    variables: variables.count,
    patternVariables,
    changesTables: !explained && (firstWord === "CREATE" || firstWord === "ALTER"),
    reads: explained || READ_WORDS.has(firstWord),
    leavesSchema: explained || ROW_WORDS.has(firstWord),
    kept: !explained && ROW_WORDS.has(firstWord),
  };
}
