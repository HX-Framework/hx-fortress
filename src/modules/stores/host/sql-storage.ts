// A Store's SQL, on one SQLite file of this host.
//
// The Store's engine was written for a platform that hands it a database as
// `storage.sql`: one call, `exec(statement, ...values)`, which answers a
// cursor. This file answers that same call on `bun:sqlite`. The shapes here
// are the platform's public ones (a cursor's `next`, `toArray`, `one`, `raw`,
// `columnNames`, `rowsRead`, `rowsWritten`, and iteration), written out as
// this file's own types so that nothing here needs the platform's packages.
//
// Five rules, and where each is held:
//
//   1. The cursor is the platform's. Bytes come back as an `ArrayBuffer`, and
//      `rowsWritten` is SQLite's own count of changed rows, before and after.
//   2. A statement that begins or ends a transaction is refused, in the
//      platform's words (sql-guard.ts). `savepoint` below is the way, and
//      `FileStorage.transactionSync` is how the engine reaches it.
//   3. The platform's limits, where this runtime can see them. See `HELD`.
//   4. A statement reaches only its own Store's file (sql-guard.ts, and the
//      check after every statement in `runPiece` below).
//   5. A statement that never ends cannot be stopped from here: SQLite runs it
//      on the thread that asked. That rule is held one level up, by running
//      each Store in a process of its own (store-process.ts).
//
// WHEN WHAT A STATEMENT WROTE IS KEPT. As on the platform: not one statement at
// a time. Before the first statement that may write, the host opens a
// transaction of its own, and `commit` keeps everything written since. The
// storage around this file says when that is (file-storage.ts): when the
// program next waits for something, when a `transactionSync` ends, and before
// a call is answered. A statement that only reads opens nothing.
//
// WHAT IS KEPT COMPILED. A statement that reads or changes rows, for its next
// run. Every other statement is compiled, run and put away at once. SQLite
// counts an EXPLAIN as running until it is put away, and while a statement
// runs nothing can be kept.
//
// WHAT IS NOT THE PLATFORM'S, measured on Bun 1.3.14:
//
//   • A whole number is bound as an integer. The platform binds every number
//     as a real, so `typeof(?)` answers differently, and a whole number written
//     into a column with no type reads back as `1` here and `1.0` there.
//   • `rowsWritten` counts rows. The platform also counts each index entry.
//   • `rowsRead` is the number of rows answered, not the rows SQLite visited.
//   • The rows of a statement are all read when `exec` returns, so a cursor
//     that was not read to its end holds nothing open.
//   • Text that SQLite holds and that is not valid UTF-8 (a blob cast to text)
//     is answered as empty text.
//   • Two columns of one result with one name are listed in order, as on the
//     platform, except where the names leave more than one reading (a column
//     whose own name ends in `:` and digits, or is `true` or `false`). Such a
//     statement is refused before it runs, and says to name each column.
//
// ONE THING THE RUNTIME GETS WRONG, measured on Bun 1.3.14: it lists the names
// of a result of 63 columns or more BACKWARDS, while it answers the values in
// order. A row read by those names would hold every value under another
// column's name. So this file never takes the runtime's list as it is: for
// each width of a result it asks the runtime once, with a statement whose
// names it knows, in which order the names come (`namesBackwards`). A runtime
// that lists them in order, as a later one may, is taken at its word. One
// that lists them in neither order is not guessed at: the statement is refused.

import { Database, type Statement } from "bun:sqlite";

import {
  NAMEABLE_MODULES,
  readStatements,
  SQL_LIMITS,
  SqlRefused,
  type SqlResultCode,
  type StatementPiece,
} from "./sql-guard";

/** A value SQLite hands back. */
export type SqlValue = ArrayBuffer | string | number | null;
export type SqlRow = Record<string, SqlValue>;

/**
 * Which of the platform's limits this host holds in full.
 *
 * `bun:sqlite` cannot set SQLite's own limits, so each is checked here, on what
 * a statement's text, its bound values and its answer show:
 *
 *   • statement length, bound values, compound SELECTs: held in full.
 *   • columns: held for a result and for a table (a table is checked after the
 *     statement that made it, and the statement is undone).
 *   • value size: held for a value that is bound and a value that is answered.
 *     NOT held for a value a statement builds and keeps inside the database.
 *   • LIKE pattern: held for a pattern written in the statement or bound to it.
 *     NOT held for a pattern a statement builds from parts.
 */
export const HELD = {
  sqlLength: true,
  variableNumber: true,
  compoundSelect: true,
  column: true,
  length: false,
  likePatternLength: false,
} as const;

// ── Errors ───────────────────────────────────────────────────────────────────

const RESULT_CODES: Readonly<Record<number, string>> = {
  1: "SQLITE_ERROR",
  2: "SQLITE_INTERNAL",
  3: "SQLITE_PERM",
  4: "SQLITE_ABORT",
  5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED",
  7: "SQLITE_NOMEM",
  8: "SQLITE_READONLY",
  9: "SQLITE_INTERRUPT",
  10: "SQLITE_IOERR",
  11: "SQLITE_CORRUPT",
  12: "SQLITE_NOTFOUND",
  13: "SQLITE_FULL",
  14: "SQLITE_CANTOPEN",
  15: "SQLITE_PROTOCOL",
  16: "SQLITE_EMPTY",
  17: "SQLITE_SCHEMA",
  18: "SQLITE_TOOBIG",
  19: "SQLITE_CONSTRAINT",
  20: "SQLITE_MISMATCH",
  21: "SQLITE_MISUSE",
  22: "SQLITE_NOLFS",
  23: "SQLITE_AUTH",
  24: "SQLITE_FORMAT",
  25: "SQLITE_RANGE",
  26: "SQLITE_NOTADB",
};

/**
 * SQLite failed a statement. The message is SQLite's own, then the name of its
 * result code, as the platform writes one.
 *
 * THE MESSAGE CAN HOLD A ROW'S VALUE. SQLite puts into it whatever the
 * statement gave it to say: the words of a trigger's `RAISE`, a JSON path that
 * was bound, the words of a full text search. So the message is held like a
 * row: it is for the person whose statement it was, and it goes into no log,
 * no audit record and no answer to the control plane. `code` is what those may
 * hold.
 */
export class SqliteFailure extends Error {
  /** The result code's name: `SQLITE_CONSTRAINT`, `SQLITE_FULL`. */
  readonly code: string;

  constructor(message: string, errno: number | undefined) {
    const code = RESULT_CODES[(errno ?? 1) & 0xff] ?? "SQLITE_ERROR";
    super(`${message}: ${code}`);
    this.name = "SqliteFailure";
    this.code = code;
  }
}

function sqliteFailure(thrown: unknown): Error {
  if (
    thrown instanceof SqlRefused ||
    thrown instanceof SqliteFailure ||
    thrown instanceof StoreReachBroken ||
    thrown instanceof StoreTransactionLost
  ) {
    return thrown;
  }
  const error = thrown as { message?: unknown; errno?: unknown } | null;
  const message = typeof error?.message === "string" ? error.message : "SQLite failed";
  return new SqliteFailure(message, typeof error?.errno === "number" ? error.errno : undefined);
}

function refuse(rule: SqlRefused["rule"], words: string, code: SqlResultCode | null): never {
  throw new SqlRefused(rule, words, code);
}

/** A statement opened a second database on the Store's connection. */
export class StoreReachBroken extends Error {
  constructor() {
    super("a statement opened a file that is not the Store's own");
    this.name = "StoreReachBroken";
  }
}

/**
 * A statement failed in a way that made SQLite end the host's own transaction:
 * a full disk, a failed read or write of the file, no memory. Everything
 * written since the last `commit` is gone with it.
 *
 * A Store's process ends itself here (`onTransactionLost`), because its
 * program may remember things the file no longer holds. Where nobody ends the
 * process, every statement is refused with this error until the outermost
 * `savepoint` has returned, so that nothing written after the loss is kept by
 * itself.
 */
export class StoreTransactionLost extends Error {
  readonly code = "transaction_lost";

  constructor() {
    super("the Store's transaction was ended by a failure, and what it had written is gone");
    this.name = "StoreTransactionLost";
  }
}

// ── The cursor ───────────────────────────────────────────────────────────────

/** A statement's rows, read once. */
export class SqlCursor<T extends SqlRow = SqlRow> implements IterableIterator<T> {
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  private readonly rows: SqlValue[][];
  private index = 0;

  constructor(columnNames: string[], rows: SqlValue[][], rowsWritten: number) {
    this.columnNames = columnNames;
    this.rows = rows;
    this.rowsRead = rows.length;
    this.rowsWritten = rowsWritten;
  }

  private object(values: SqlValue[]): T {
    const row: Record<string, SqlValue> = {};
    this.columnNames.forEach((name, position) => {
      // Defined, not assigned: a column may be called `__proto__`. Two columns
      // of one name leave the later one, as on the platform.
      Object.defineProperty(row, name, {
        value: values.at(position) ?? null,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
    return row as T;
  }

  next(): IteratorResult<T, undefined> {
    const values = this.rows.at(this.index);
    if (this.index >= this.rows.length || values === undefined) return { done: true, value: undefined };
    this.index += 1;
    return { done: false, value: this.object(values) };
  }

  /** The rows not read yet. */
  toArray(): T[] {
    const out = this.rows.slice(this.index).map((values) => this.object(values));
    this.index = this.rows.length;
    return out;
  }

  /** The one row of a statement that answers exactly one. */
  one(): T {
    const left = this.rows.length - this.index;
    if (left === 0) throw new Error("Expected exactly one result from SQL query, but got no results.");
    if (left > 1) throw new Error("Expected exactly one result from SQL query, but got multiple results.");
    return this.toArray()[0] as T;
  }

  /** The rows not read yet, each as its values in the columns' order. */
  *raw<U extends SqlValue[] = SqlValue[]>(): IterableIterator<U> {
    while (this.index < this.rows.length) {
      const values = this.rows.at(this.index) as SqlValue[];
      this.index += 1;
      yield values as U;
    }
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this;
  }
}

// ── Values in and out ────────────────────────────────────────────────────────

type Bindable = string | number | bigint | boolean | null | Uint8Array;

/** Two methods every string of this runtime has. The language level this
 *  repository is checked at does not list them yet. */
interface WellFormedString {
  isWellFormed(): boolean;
  toWellFormed(): string;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function byteSize(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
}

/** Refuse a text or a run of bytes that is larger than a value may be. */
function holdValueSize(value: string | Uint8Array): void {
  // Three bytes at most for each UTF-16 unit, so most text needs no count.
  if (typeof value === "string" && value.length * 3 <= SQL_LIMITS.valueBytes) return;
  if (byteSize(value) > SQL_LIMITS.valueBytes) {
    refuse("value_too_big", "string or blob too big", "SQLITE_TOOBIG");
  }
}

/** A value as `bun:sqlite` binds it, or a refusal. */
function bindable(value: unknown): Bindable {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    // Half of a pair of UTF-16 units is no character. Written as UTF-8 it
    // would become other bytes, and the text would not read back. It is bound
    // as the mark for a character that cannot be shown, as the platform does.
    const checked = value as unknown as WellFormedString;
    const text = checked.isWellFormed() ? value : checked.toWellFormed();
    holdValueSize(text);
    return text;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") {
    // A whole number SQLite cannot hold would be bound as another number.
    if (value < INT64_MIN || value > INT64_MAX) {
      throw new SqlRefused("binding_type", "A whole number bound to a statement fits in 64 bits.", null);
    }
    return value;
  }
  let bytes: Uint8Array | null = null;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (bytes === null) {
    // An object, a list, a date. `bun:sqlite` would bind an object's fields by
    // name, which is a second way to bind that the platform does not have.
    throw new SqlRefused(
      "binding_type",
      "A value bound to a statement is text, a number, bytes or null.",
      null,
    );
  }
  holdValueSize(bytes);
  return bytes;
}

/** A value as the platform hands it back: bytes as an `ArrayBuffer` of their own. */
function answered(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    holdValueSize(value);
    return value;
  }
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) {
    holdValueSize(value);
    const copy = new ArrayBuffer(value.byteLength);
    new Uint8Array(copy).set(value);
    return copy;
  }
  return null;
}

// ── exec ─────────────────────────────────────────────────────────────────────

/** How many statements are kept compiled. The engine runs the same few many
 *  times: a page of a load is one statement run thousands of times. */
const COMPILED_MAX = 128;
/** How many texts are kept read. Reading a text is the guard's whole work, and
 *  its answer depends on the text alone. */
const READ_MAX = 256;

/**
 * The value kept under `key`, made on first use. The map keeps at most `max`
 * values: past that, the one used longest ago is dropped.
 */
function remembered<V>(
  map: Map<string, V>,
  key: string,
  max: number,
  make: () => V,
  drop?: (value: V) => void,
): V {
  let value = map.get(key);
  if (value !== undefined) {
    // Moved to the end: the first entry is the one used longest ago.
    map.delete(key);
    map.set(key, value);
    return value;
  }
  value = make();
  map.set(key, value);
  if (map.size > max) {
    const [oldest, held] = map.entries().next().value as [string, V];
    map.delete(oldest);
    drop?.(held);
  }
  return value;
}

function finalize(statement: Statement): void {
  try {
    statement.finalize();
  } catch {
    // Already gone with its database.
  }
}

const WRONG_BINDINGS = "Wrong number of parameter bindings for SQL query.";
const SAME_NAME = "Two columns of this result have one name. Give each a name of its own with AS.";

/** A column's own name that SQLite's way of telling two columns of one name
 *  apart could also have made: `x:1`, and `true` and `false`. */
function hasTwoReadings(name: string): boolean {
  return /:\d+$/.test(name) || /^(?:true|false)$/i.test(name);
}

interface NativeStatement {
  columnsCount?: unknown;
}

export interface StoreSqlOptions {
  /** Called when a statement opened a second database on the connection,
   *  after the host has closed it again. The Store's process ends itself here. */
  onReachBroken?: () => void;
  /** Called when a failure made SQLite end the host's own transaction. The
   *  Store's process ends itself here. */
  onTransactionLost?: () => void;
  /** Called when the host opened a transaction of its own: something waits to
   *  be kept from now on. */
  onPending?: () => void;
}

/** `storage.sql`: one database, one call. */
export class StoreSql {
  private database: Database;
  /** The statements somebody wrote that read or change rows, compiled. */
  private readonly compiled = new Map<string, Statement>();
  /** The names of this SQLite's modules that no statement may name. */
  private modules: ReadonlySet<string> | null = null;
  /** The host's own few statements. Never dropped to make room, so nothing the
   *  host runs around a statement can take that statement's place. */
  private readonly own = new Map<string, Statement>();
  private readonly read = new Map<string, StatementPiece[]>();
  private readonly options: StoreSqlOptions;
  /** How many savepoints of the host's are open, one inside the other. */
  private depth = 0;
  /** The host's transaction was ended under an open savepoint. */
  private lost = false;
  private closed = false;

  constructor(database: Database, options: StoreSqlOptions = {}) {
    this.database = database;
    this.options = options;
  }

  /** The database itself, for the host's own statements. Nothing a person or
   *  the control plane wrote is ever run on it directly. */
  get db(): Database {
    return this.database;
  }

  /** Whether a savepoint of the host's is open. */
  get inSavepoint(): boolean {
    return this.depth > 0;
  }

  /**
   * Close this database and put the one `open` makes in its place: after a
   * restore, or after everything was deleted.
   *
   * THE OLD ONE IS CLOSED FIRST, with every statement that was compiled on it.
   * This runtime keeps a database open for as long as one of its statements
   * is, and a database that is open holds the Store's file. So `open` runs
   * when the file is nobody's: it may cut the file to nothing, and it opens
   * the same file again.
   *
   * THROWS when the old database cannot be closed, before `open` is run. This
   * one is then still open, and usable.
   */
  replace(open: () => Database): void {
    this.forget();
    for (const statement of this.own.values()) finalize(statement);
    this.own.clear();
    // Not left for later: a database that is closed "when its last statement
    // is gone" would still hold the file when `open` runs.
    this.database.close(true);
    this.database = open();
    this.depth = 0;
    this.lost = false;
  }

  /** Drop every compiled statement that somebody wrote. */
  forget(): void {
    for (const statement of this.compiled.values()) finalize(statement);
    this.compiled.clear();
  }

  /** Close the database. Every call after this is refused. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.forget();
    for (const statement of this.own.values()) finalize(statement);
    this.own.clear();
    this.database.close();
  }

  private usable(): void {
    if (this.closed) throw new Error("This Store's database is closed.");
    if (this.lost) throw new StoreTransactionLost();
  }

  /** The size of the database file's contents, in bytes. */
  get databaseSize(): number {
    this.usable();
    return this.hostNumber("PRAGMA page_count") * this.hostNumber("PRAGMA page_size");
  }

  /** One of the host's own statements, compiled once. */
  private hostStatement(sql: string): Statement {
    let statement = this.own.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.own.set(sql, statement);
    }
    return statement;
  }

  /** One number from a statement of the host's own. */
  private hostNumber(sql: string): number {
    const rows = this.hostStatement(sql).values() as unknown[][] | null;
    const value = rows?.at(0)?.at(0);
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  /**
   * A statement somebody wrote, compiled. One that reads or changes rows is
   * kept for its next run. Any other is compiled for this run alone, and its
   * caller puts it away: an EXPLAIN stays counted as running until then.
   */
  private statement(piece: StatementPiece): Statement {
    // `prepare`, never `run` or `exec`: it compiles the first statement of a
    // text and nothing after it. Whatever a text holds past its first
    // statement, SQLite is never handed it here.
    const compile = (): Statement => this.database.prepare(piece.text);
    return piece.kept
      ? remembered(this.compiled, piece.text, COMPILED_MAX, compile, finalize)
      : compile();
  }

  /**
   * The names of this SQLite's virtual table modules that no statement may
   * name: every module it has, but full text search, the two that read JSON,
   * and the PRAGMAs as tables, which the guard holds to its own list. Asked of
   * SQLite itself, so that a build with a module this code never heard of
   * refuses it.
   */
  private refusedModules(): ReadonlySet<string> {
    if (this.modules) return this.modules;
    const names = new Set<string>();
    try {
      const rows = this.hostStatement("PRAGMA module_list").values() as unknown[][] | null;
      for (const row of rows ?? []) {
        const name = String(row.at(0)).toLowerCase();
        if (!NAMEABLE_MODULES.has(name) && !name.startsWith("pragma_")) names.add(name);
      }
    } catch {
      // A build that does not list its modules. The guard's own list stands.
    }
    this.modules = names;
    return names;
  }

  private statements(sql: string): StatementPiece[] {
    return remembered(this.read, sql, READ_MAX, () => readStatements(sql, this.refusedModules()));
  }

  // ── The host's transaction ─────────────────────────────────────────────────

  /** Open the host's transaction, unless one is open. */
  private begin(): void {
    if (this.database.inTransaction) return;
    this.database.run("BEGIN");
    this.options.onPending?.();
  }

  /**
   * Keep everything written since the last time. Nothing happens while a
   * savepoint is open: its end decides what is kept.
   *
   * THROWS `SqliteFailure` when SQLite cannot keep it. What was written is
   * then undone, so that the file is as the last `commit` left it.
   */
  commit(): void {
    if (this.closed || this.depth > 0 || !this.database.inTransaction) return;
    try {
      this.database.run("COMMIT");
    } catch (thrown) {
      try {
        if (this.database.inTransaction) this.database.run("ROLLBACK");
      } catch {
        // SQLite ended it already.
      }
      this.forget();
      throw sqliteFailure(thrown);
    }
  }

  /**
   * Run `work` so that all of what it writes stays, or none of it. One inside
   * another undoes only its own part.
   *
   * What stays is kept with the host's transaction (`commit`), and not before.
   */
  savepoint<T>(work: () => T): T {
    this.usable();
    this.begin();
    const name = `hx_host_sp_${this.depth}`;
    this.database.run(`SAVEPOINT ${name}`);
    this.depth += 1;
    let result: T;
    try {
      result = work();
      // `work` may have caught the loss of the transaction and gone on. What it
      // wrote is gone all the same, and its caller is told.
      if (this.lost) throw new StoreTransactionLost();
    } catch (thrown) {
      this.depth -= 1;
      this.undo(name);
      // What `work` threw is its caller's, as it is.
      throw thrown;
    }
    this.depth -= 1;
    try {
      this.database.run(`RELEASE ${name}`);
    } catch (thrown) {
      this.undo(name);
      throw sqliteFailure(thrown);
    }
    return result;
  }

  /** Take back what was written since the savepoint `name`. */
  private undo(name: string): void {
    // After a loss there is no transaction left to undo anything in. With the
    // outermost savepoint gone, statements run again.
    if (this.lost) {
      if (this.depth === 0) this.lost = false;
    } else if (this.database.inTransaction) {
      try {
        this.database.run(`ROLLBACK TO ${name}`);
        this.database.run(`RELEASE ${name}`);
      } catch {
        // SQLite ended the transaction itself. Nothing is left to undo.
      }
    }
    // The undo may have taken a table or a column back. What was compiled
    // meanwhile is compiled again when it is next asked for.
    this.forget();
  }

  /** SQLite ended the host's transaction under a statement. */
  private transactionLost(): never {
    this.forget();
    if (this.depth > 0) this.lost = true;
    this.options.onTransactionLost?.();
    throw new StoreTransactionLost();
  }

  // ── exec ───────────────────────────────────────────────────────────────────

  /**
   * Run every statement of `query`, in order. The values are bound to the last
   * one, and the cursor is the last one's, as on the platform.
   *
   * THROWS `SqlRefused` for a statement the host does not run, and
   * `SqliteFailure` for one SQLite failed.
   *
   * WHAT RAN BEFORE A THROW. Nothing, when the refusal comes from the text (a
   * statement of a refused kind, a limit the text shows), from the number of
   * values or from a bound value. Those are all looked at before the first
   * statement runs. A statement that fails or is refused when it is reached
   * (SQLite's own failure, too many columns, two columns of one name) leaves
   * the statements before it as they ran, as on the platform. It leaves
   * nothing of itself: a statement that is refused after it ran is undone.
   */
  exec<T extends SqlRow = SqlRow>(query: string, ...bindings: unknown[]): SqlCursor<T> {
    this.usable();
    const pieces = this.statements(query);
    const last = pieces.at(-1);
    // Every statement before the last binds no value, and the last binds
    // them all. The guard counted each statement's values as SQLite does.
    if (
      (last?.variables ?? 0) !== bindings.length ||
      pieces.some((piece) => piece !== last && piece.variables > 0)
    ) {
      refuse("bindings", WRONG_BINDINGS, null);
    }
    if (!last) return new SqlCursor<T>([], [], 0);
    const values = bindings.map(bindable);
    for (const number of last.patternVariables) {
      const pattern = values.at(number - 1);
      if (
        (typeof pattern === "string" || pattern instanceof Uint8Array) &&
        byteSize(pattern) > SQL_LIMITS.likePatternBytes
      ) {
        refuse("pattern_too_long", "LIKE or GLOB pattern too complex", "SQLITE_ERROR");
      }
    }
    let cursor: SqlCursor<T> | null = null;
    for (const piece of pieces) cursor = this.runPiece<T>(piece, piece === last ? values : []);
    return cursor as SqlCursor<T>;
  }

  private runPiece<T extends SqlRow>(piece: StatementPiece, values: Bindable[]): SqlCursor<T> {
    let statement: Statement;
    try {
      statement = this.statement(piece);
    } catch (thrown) {
      throw sqliteFailure(thrown);
    }
    try {
      return this.runCompiled<T>(statement, piece, values);
    } finally {
      // Put away before anything else runs. Until then SQLite counts an EXPLAIN
      // as a statement that is still running, and refuses to keep anything.
      if (!piece.kept) finalize(statement);
    }
  }

  private runCompiled<T extends SqlRow>(
    statement: Statement,
    piece: StatementPiece,
    values: Bindable[],
  ): SqlCursor<T> {
    // Held before anything ran, in `exec`. This is SQLite's own count: where
    // the two differ, the guard did not read the statement as SQLite did.
    if (statement.paramsCount !== values.length) refuse("bindings", WRONG_BINDINGS, null);
    const columns = columnCount(statement);
    if (columns > SQL_LIMITS.columns) {
      refuse("too_many_columns", "too many columns in result set", "SQLITE_ERROR");
    }
    const names = columns === 0 ? [] : this.columnNames(statement, piece, columns);

    const run = (): SqlCursor<T> => {
      const held = this.database.inTransaction;
      const before = this.hostNumber("SELECT total_changes()");
      let rows: unknown[][];
      try {
        rows = (statement.values(...values) as unknown[][] | null) ?? [];
      } catch (thrown) {
        if (held && !this.database.inTransaction) this.transactionLost();
        throw sqliteFailure(thrown);
      }
      if (held && !this.database.inTransaction) this.transactionLost();
      const written = this.hostNumber("SELECT total_changes()") - before;
      this.holdReach();
      if (piece.changesTables) this.holdTableColumns();
      return new SqlCursor<T>(
        names,
        rows.map((row) => row.map(answered)),
        written,
      );
    };

    if (piece.reads) return run();
    this.begin();
    // A statement that makes or changes a table, and one that writes and
    // answers rows, can be refused after it ran: a table with too many
    // columns, an answered value that is too large. Run inside a savepoint,
    // it is undone then.
    const cursor = piece.changesTables || columns > 0 ? this.savepoint(run) : run();
    // A statement that may have changed the schema: what was compiled against
    // the old one is compiled again when it is next asked for.
    if (!piece.leavesSchema) this.forget();
    return cursor;
  }

  /**
   * The third thing that holds "a statement reaches only its own Store's
   * file": after every statement, ask SQLite which databases this connection
   * has. It is the Store's own and SQLite's scratch one, or the host stops.
   *
   * It costs one small statement. It is here because the guard reads a
   * statement's text, and this reads what SQLite did.
   */
  private holdReach(): void {
    const rows = this.hostStatement("PRAGMA database_list").values() as unknown[][] | null;
    const extra = (rows ?? []).filter((row) => row.at(1) !== "main" && row.at(1) !== "temp");
    if (extra.length === 0) return;
    for (const row of extra) {
      const name = String(row.at(1)).split('"').join('""');
      try {
        this.database.run(`DETACH DATABASE "${name}"`);
      } catch {
        // The process ends below in any case.
      }
    }
    this.options.onReachBroken?.();
    throw new StoreReachBroken();
  }

  /** No table of the Store holds more columns than the platform lets one hold. */
  private holdTableColumns(): void {
    const rows = this.hostStatement(
      `SELECT name FROM pragma_table_list WHERE type = 'table' AND ncol > ${SQL_LIMITS.columns} LIMIT 1`,
    ).values() as unknown[][] | null;
    const table = rows?.at(0)?.at(0);
    if (typeof table === "string") {
      refuse("too_many_columns", `too many columns on ${table}`, "SQLITE_ERROR");
    }
  }

  /**
   * The name of every column of a result, in order, before the statement runs.
   *
   * `bun:sqlite` lists a name once when two columns share it. The platform
   * lists each column. So when the list is shorter than the result is wide,
   * SQLite is asked for the names another way: the same SELECT read as a
   * table, where SQLite itself tells two columns of one name apart (`id`,
   * `id:1`). That statement is compiled and never run.
   *
   * A name SQLite made that way is read back to the column's own. Where a
   * column's own name could be taken for such a made name, there is more than
   * one reading, and the statement is refused. So is a statement that is no
   * SELECT (`INSERT … RETURNING n, n`): it cannot be read as a table.
   */
  private columnNames(statement: Statement, piece: StatementPiece, columns: number): string[] {
    // As the runtime lists them. With every column listed, the list is put in
    // the columns' own order. With fewer (two columns have one name), it is
    // read only as a set, below.
    const listed = statement.columnNames;
    if (listed.length === columns) return inColumnOrder(listed);
    if (listed.some(hasTwoReadings)) refuse("too_many_columns", SAME_NAME, null);
    let made: string[];
    try {
      const table = this.database.prepare(`SELECT * FROM (\n${piece.text}\n)`);
      try {
        made = table.columnNames;
      } finally {
        // Also when it failed: a statement that stays open keeps its database
        // from being closed (`replace`).
        finalize(table);
      }
    } catch {
      return refuse("too_many_columns", SAME_NAME, null);
    }
    if (made.length !== columns) refuse("too_many_columns", SAME_NAME, null);
    made = inColumnOrder(made);
    const own = new Set(listed);
    return made.map((name) => {
      if (own.has(name)) return name;
      const plain = name.replace(/:\d+$/, "");
      if (!own.has(plain)) refuse("too_many_columns", SAME_NAME, null);
      return plain;
    });
  }
}

/** For each width of a result: whether this runtime lists its names backwards. */
const NAMES_BACKWARDS = new Map<number, boolean>();

/**
 * Whether this runtime lists the names of a result of `width` columns
 * backwards. Asked of the runtime itself, once for each width, with a
 * statement whose names are known: `SELECT 0 AS c0, 1 AS c1, …`.
 *
 * THROWS a refusal when the runtime lists them in neither order. Nothing is
 * remembered then, so the next statement of that width asks again.
 */
export function namesBackwards(width: number): boolean {
  const known = NAMES_BACKWARDS.get(width);
  if (known !== undefined) return known;
  const expected = Array.from({ length: width }, (_, at) => `c${at}`);
  const probe = new Database(":memory:");
  let listed: string[];
  try {
    const statement = probe.prepare(
      `SELECT ${expected.map((name, at) => `${at} AS ${name}`).join(", ")}`,
    );
    listed = [...statement.columnNames];
    finalize(statement);
  } finally {
    probe.close();
  }
  const same = (other: readonly string[]): boolean =>
    other.length === listed.length && other.every((name, at) => name === listed.at(at));
  let backwards: boolean;
  if (same(expected)) backwards = false;
  else if (same([...expected].reverse())) backwards = true;
  else {
    return refuse(
      "too_many_columns",
      "this runtime does not say which column of this result has which name",
      null,
    );
  }
  NAMES_BACKWARDS.set(width, backwards);
  return backwards;
}

/** The names of every column of a result, as the runtime listed them, put in
 *  the columns' own order. */
function inColumnOrder(listed: readonly string[]): string[] {
  return namesBackwards(listed.length) ? [...listed].reverse() : [...listed];
}

/** How many columns a statement answers. */
function columnCount(statement: Statement): number {
  const native = (statement as unknown as { native?: NativeStatement }).native;
  const count = native?.columnsCount;
  // Every statement of this runtime says. One that did not would be held to no
  // limit of columns, so it is refused.
  if (typeof count !== "number") {
    return refuse("too_many_columns", "this statement's columns cannot be counted", null);
  }
  return count;
}
