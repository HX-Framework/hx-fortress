// SQL inside a store: splitting text into statements, asking SQLite what a statement writes, and
// the rule that `exec` and `migrate` change only managed tables.
//
// What a statement writes is read from its own program: `EXPLAIN <statement>` lists the B-trees
// it opens for writing (OpenWrite), empties (Clear) or drops (Destroy), each by its root page,
// and `sqlite_master` names the table each root page belongs to. A statement that would write a
// program table or a system table is refused before it runs. A change to the schema is checked
// after the batch runs, inside the same transaction: a batch that added, dropped or altered a
// system or program table, an index or trigger on one, or a view, trigger or foreign key that
// names one, is rolled back and refused. A statement that changes the schema is checked the same
// way as soon as it runs, so a protected table is never renamed, even for the length of a batch.
// A program table renamed to an old version keeps every reference to it pointing at the version,
// so nothing managed may name a program table at all.
//
// SQLite in workerd reads a double-quoted name that matches no column as text (its "double-quoted
// string literal" quirk). drizzle-kit's table rebuild can name a column the old table lacks
// (`INSERT INTO __new_t("a", "b") SELECT "a", "b" FROM t`, b being new), and every row would get
// the text 'b'. So each statement is EXPLAINed with its double-quoted names in backticks, which
// SQLite reads as names or not at all: a name that matches nothing fails there with SQLite's own
// "no such column", and the statement is refused before it runs.
//
// A PRAGMA takes effect when SQLite prepares it, before EXPLAIN could show anything, and it lasts
// for the object's connection. So PRAGMAs are sorted by name before anything is prepared: a query
// may read the schema with a few, and exec and migrate may only pass drizzle-kit's foreign-key
// pragmas, which do nothing inside a transaction.

export { migrationStatements, splitStatements } from "./split.js";

/** A value SQLite hands back: text, a number, bytes or NULL. Cloudflare's name for the same four is `SqlStorageValue`. */
export type StoreSqlValue = ArrayBuffer | string | number | null;

/**
 * What `exec` hands back: a statement's rows, read once. The members are those of Cloudflare's
 * `SqlStorageCursor`, which fits this interface as it is; another host answers the same ones.
 */
export interface StoreSqlCursor<T extends Record<string, StoreSqlValue>> {
  next(): { done?: false; value: T } | { done: true; value?: never };
  /** The rows not read yet. */
  toArray(): T[];
  /** The one row of a statement that answers exactly one; anything else throws. */
  one(): T;
  /** The rows not read yet, each as its values in the columns' order. */
  raw<U extends StoreSqlValue[]>(): IterableIterator<U>;
  readonly columnNames: string[];
  readonly rowsRead: number;
  /** The rows the statement wrote, as the host counts them: the daily write limit adds these up (metered-sql.ts). */
  readonly rowsWritten: number;
  [Symbol.iterator](): IterableIterator<T>;
}

/** Runs one statement of a store's SQLite, with its values bound in order. */
export interface SqlLike {
  exec<T extends Record<string, StoreSqlValue>>(query: string, ...bindings: unknown[]): StoreSqlCursor<T>;
}

/** The opcodes of a program that change the schema: names and root pages are read again after it. */
const SCHEMA_OPCODES = new Set(["CreateBtree", "ParseSchema", "DropTable", "DropIndex", "DropTrigger", "VCreate", "VDestroy", "SetCookie"]);

/** OpenWrite's P5 flag that makes P2 the register holding a new b-tree's root, not a root page. */
const OPFLAG_P2ISREG = 0x10;

/** The opcodes of a program that change the database file. */
const WRITE_OPCODES = new Set([
  "OpenWrite",
  "Destroy",
  "Clear",
  "CreateBtree",
  "ParseSchema",
  "DropTable",
  "DropIndex",
  "DropTrigger",
  "VCreate",
  "VDestroy",
  "VUpdate",
  "SetCookie",
]);

export interface StatementWrites {
  /** The statement changes the database at all. */
  writes: boolean;
  /** The tables (and the tables of indexes) whose rows it writes, lowercased. */
  tables: Set<string>;
  /** The tables (and the tables of indexes) it opens to read, lowercased; root page 1 is `sqlite_master`. */
  reads: Set<string>;
  /** It changes the schema. */
  schema: boolean;
  /** The tables a DROP TABLE drops, lowercased. */
  dropped: Set<string>;
}

/** Root page → the table it belongs to (an index's table), lowercased. */
export function rootPages(sql: SqlLike): Map<number, string> {
  const out = new Map<number, string>();
  for (const row of sql.exec<{ tbl_name: string; rootpage: number | null }>("SELECT tbl_name, rootpage FROM sqlite_master WHERE rootpage > 0")) {
    if (typeof row.rootpage === "number") out.set(row.rootpage, String(row.tbl_name).toLowerCase());
  }
  return out;
}

/** What one statement would write, from its EXPLAIN. */
export function statementWrites(sql: SqlLike, statement: string, params: readonly unknown[], roots: Map<number, string>): StatementWrites {
  const tables = new Set<string>();
  const reads = new Set<string>();
  const dropped = new Set<string>();
  let writes = false;
  let schema = false;
  for (const op of sql.exec<{ opcode: string; p1: number; p2: number; p3: number; p4: StoreSqlValue; p5: number }>(`EXPLAIN ${statement}`, ...params)) {
    if (SCHEMA_OPCODES.has(op.opcode)) schema = true;
    if ((op.opcode === "OpenRead" || op.opcode === "ReopenIdx") && op.p3 === 0 && (Number(op.p5) & OPFLAG_P2ISREG) === 0) {
      const table = op.p2 === 1 ? "sqlite_master" : roots.get(op.p2);
      if (table) reads.add(table);
    }
    if (op.opcode === "DropTable" && typeof op.p4 === "string") dropped.add(op.p4.toLowerCase());
    if (!WRITE_OPCODES.has(op.opcode)) continue;
    writes = true;
    let root: number | null = null;
    // An OpenWrite on a b-tree the statement makes (CREATE TABLE … AS SELECT) names a register.
    if (op.opcode === "OpenWrite") root = op.p3 === 0 && (Number(op.p5) & OPFLAG_P2ISREG) === 0 ? op.p2 : null;
    else if (op.opcode === "Destroy" || op.opcode === "Clear") root = op.p1;
    if (root !== null) {
      const table = roots.get(root);
      if (table) tables.add(table);
    }
  }
  return { writes, tables, reads, schema, dropped };
}

/** Tables of the platform and of SQLite, which a store's SQL never reads: workerd refuses `_cf_*`. */
const PLATFORM_TABLE_RE = /^(_cf_|__miniflare|sqlite_)/i;

/** "VIEW" or "TRIGGER" for a statement that makes one: SQLite reads its body only when it is used. */
export function createdKind(statement: string): "VIEW" | "TRIGGER" | null {
  const m = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?(VIEW|TRIGGER)\b/i.exec(bare(statement));
  return m ? (m[1]!.toUpperCase() as "VIEW" | "TRIGGER") : null;
}

/**
 * Refuses dropping a table that another table's foreign key names while that table holds rows.
 * SQLite deletes the dropped table's rows first, and with foreign keys on, which a store always
 * has, that runs their ON DELETE actions (CASCADE empties the other table, SET NULL blanks it) or
 * leaves violations the commit refuses. drizzle-kit's `PRAGMA foreign_keys=OFF` does nothing
 * inside the store's transaction, so its table rebuild of a referenced table would do this.
 */
export function refuseOrphaningDrop(sql: SqlLike, table: string): void {
  // The PRAGMA statement, not the `pragma_foreign_key_list()` table function, and never on the
  // platform's own tables (`_cf_*`): workerd's authorizer refuses both ("not authorized").
  const children: string[] = [];
  for (const row of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()) {
    const name = String(row.name);
    if (name.toLowerCase() === table.toLowerCase() || PLATFORM_TABLE_RE.test(name)) continue;
    const keys = sql.exec<{ table: string }>(`PRAGMA foreign_key_list(\`${name.replace(/`/g, "``")}\`)`).toArray();
    if (keys.some((k) => String(k.table).toLowerCase() === table.toLowerCase())) children.push(name);
  }
  for (const child of children) {
    if (sql.exec(`SELECT 1 FROM \`${child.replace(/`/g, "``")}\` LIMIT 1`).toArray().length === 0) continue;
    throw new StoreSqlRefusal(
      "bad_request",
      `Dropping ${table} would delete or orphan the rows of ${child}, whose foreign key names it: a store keeps foreign keys on, so PRAGMA foreign_keys=OFF does nothing in it. Change ${table} with ALTER TABLE where SQLite allows it, or empty ${child} first.`,
    );
  }
}

/**
 * The statement with each double-quoted name in backticks, and the names, outside strings and
 * comments. Null when it holds no double-quoted name.
 */
export function backtickNames(statement: string): { text: string; names: Set<string> } | null {
  const names = new Set<string>();
  const n = statement.length;
  let out = "";
  let i = 0;
  // The quoted token from i (a quote), with doubled quotes read as one; i ends past it.
  const quoted = (q: string): string => {
    let value = "";
    i++;
    while (i < n) {
      const c = statement[i]!;
      if (c === q) {
        if (statement[i + 1] === q) {
          value += q;
          i += 2;
          continue;
        }
        i++;
        return value;
      }
      value += c;
      i++;
    }
    return value;
  };
  while (i < n) {
    const c = statement[i]!;
    const start = i;
    if (c === "-" && statement[i + 1] === "-") {
      const end = statement.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
    } else if (c === "/" && statement[i + 1] === "*") {
      const end = statement.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === "`") {
      quoted(c);
    } else if (c === "[") {
      const end = statement.indexOf("]", i + 1);
      i = end < 0 ? n : end + 1;
    } else if (c === '"') {
      const name = quoted('"');
      names.add(name);
      out += `\`${name.replace(/`/g, "``")}\``;
      continue;
    } else {
      i++;
    }
    out += statement.slice(start, i);
  }
  return names.size > 0 ? { text: out, names } : null;
}

/** The name in SQLite's "no such column" message, in Node's words and in workerd's (`… at offset 7: SQLITE_ERROR`). */
function missingColumn(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return /no such column: (.+?)(?: at offset \d+)?(?:: SQLITE_\w+)?$/i.exec(message.trim())?.[1] ?? null;
}

/**
 * What a statement would write, from its EXPLAIN with its double-quoted names in backticks. A
 * double-quoted name SQLite would have read as text fails there, and the statement is refused.
 * Any other failure of that EXPLAIN falls back to the statement as written, so its own error
 * (or its own success) is SQLite's.
 */
export function explainGuarded(sql: SqlLike, statement: string, params: readonly unknown[], roots: Map<number, string>): StatementWrites {
  const named = backtickNames(statement);
  if (named === null) return statementWrites(sql, statement, params, roots);
  try {
    return statementWrites(sql, named.text, params, roots);
  } catch (error) {
    const missing = missingColumn(error);
    const name = missing === null ? null : named.names.has(missing) ? missing : (missing.split(".").pop() ?? null);
    if (name !== null && named.names.has(name)) {
      throw new StoreSqlRefusal(
        "bad_request",
        `"${name}" is not a column of what this statement reads, so SQLite would take it as the text '${name}'. Check the name, or write text in single quotes.`,
      );
    }
    return statementWrites(sql, statement, params, roots);
  }
}

/** The statement past its leading spaces and comments. */
export function bare(statement: string): string {
  return statement.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
}

/**
 * The statement, with a line's end after it when it ends in a `--` comment: SQL written after the
 * statement (the bracket that closes it, `AS n WHERE …`) is then not read as part of the comment.
 */
export function closedLine(statement: string): string {
  let open = false;
  for (const m of statement.matchAll(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g)) {
    open = m[0].startsWith("--") && m.index + m[0].length === statement.length;
  }
  return open ? `${statement}\n` : statement;
}

/** The statement's first keyword, upper-cased. */
export function firstWord(statement: string): string {
  return /^[A-Za-z]+/.exec(bare(statement))?.[0]?.toUpperCase() ?? "";
}

/** Statements a store never runs, whoever sends them. */
const NEVER = new Set(["ATTACH", "DETACH", "VACUUM"]);

/** PRAGMAs a query may run: each reads the schema and changes nothing. */
export const READ_PRAGMAS = new Set(["table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo", "foreign_key_list", "foreign_key_check"]);

/** drizzle-kit's pragmas around a table rebuild, which exec and migrate pass over. */
const FOREIGN_KEYS_PRAGMA = /^PRAGMA\s+(foreign_keys|defer_foreign_keys)\s*=\s*(on|off|true|false|0|1)\s*;?\s*$/i;

/**
 * Sorts a statement before anything prepares it, since a PRAGMA acts as it is prepared. Answers
 * "skip" for drizzle-kit's foreign-key pragmas in a batch, "run" for anything else that may run,
 * and refuses the rest.
 */
export function checkStatementKind(statement: string, place: "query" | "batch"): "run" | "skip" {
  const word = firstWord(statement);
  if (NEVER.has(word)) throw new StoreSqlRefusal("bad_request", `A store does not run ${word}.`);
  if (word !== "PRAGMA") return "run";
  const text = bare(statement);
  if (place === "batch") {
    if (FOREIGN_KEYS_PRAGMA.test(text)) return "skip";
    throw new StoreSqlRefusal("bad_request", "A PRAGMA cannot change how the store works. Read the schema with a query instead.");
  }
  const m = /^PRAGMA\s+(?:main\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(=|\()?/i.exec(text);
  const name = m?.[1]?.toLowerCase() ?? "";
  if (READ_PRAGMAS.has(name) && m?.[2] !== "=") return "run";
  throw new StoreSqlRefusal("read_only", `A query reads, so it runs only the PRAGMAs that read the schema: ${[...READ_PRAGMAS].join(", ")}.`);
}

// ── Names ────────────────────────────────────────────────────────────────────

/** The store's own tables. */
export const SYSTEM_TABLES = ["_meta", "_tables", "_columns", "_migrations", "_files", "_folders", "_jobs", "_history", "_deltas", "_delta_rows", "_delta_reads", "_row_hashes", "_pushed", "_push_writes", "_parked", "_users", "_sessions", "_fixes", "_changes", "_change_rows", "_questions", "_question_rows", "_answers", "__drizzle_migrations"] as const;

/** A name that is the store's, the platform's or SQLite's own: never a managed table's. */
export function isReservedName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("_") || lower.startsWith("sqlite_");
}

/** Tables the catalog never shows: the platform's and SQLite's, and a migration's leftovers. */
export function isHiddenTable(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("sqlite_") || lower.startsWith("_cf_") || lower.startsWith("__miniflare") || lower.startsWith("__new_");
}

/** An old version of a program table (`permits__v7`), or the one being written (`permits__new`). */
export const PROGRAM_VERSION_RE = /^(.+)__(v\d+|new)$/i;

/**
 * A word in SQL that could name a table: identifiers and quoted names, lowercased. With `strings`,
 * single-quoted words too: SQLite also reads one as a name where it expects a name.
 */
export function namesIn(sqlText: string, opts: { strings?: boolean } = {}): Set<string> {
  const out = new Set<string>();
  const re = /"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|\[([^\]]+)\]|'((?:[^']|'')*)'|--[^\n]*|\/\*[\s\S]*?\*\/|([A-Za-z_][A-Za-z0-9_$]*)/g;
  for (const m of sqlText.matchAll(re)) {
    const quoted = opts.strings ? m[4]?.replace(/''/g, "'") : undefined;
    const name = m[1]?.replace(/""/g, '"') ?? m[2]?.replace(/``/g, "`") ?? m[3] ?? quoted ?? m[5];
    if (name) out.add(name.toLowerCase());
  }
  return out;
}

/** A token of SQL text: a name (bare or quoted: `quoted` says which) or one character of punctuation. */
export interface SqlToken {
  kind: "name" | "punct";
  text: string;
  quoted: boolean;
}

/** SQL text's names and punctuation, in order; strings, numbers' digits and comments left out. */
export function sqlTokens(sqlText: string): SqlToken[] {
  const out: SqlToken[] = [];
  const re = /"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|\[([^\]]+)\]|'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|([A-Za-z_][A-Za-z0-9_$]*)|([.,()])/g;
  for (const m of sqlText.matchAll(re)) {
    if (m[5]) {
      out.push({ kind: "punct", text: m[5], quoted: false });
      continue;
    }
    const quoted = m[1]?.replace(/""/g, '"') ?? m[2]?.replace(/``/g, "`") ?? m[3];
    if (quoted !== undefined) out.push({ kind: "name", text: quoted, quoted: true });
    else if (m[4]) out.push({ kind: "name", text: m[4], quoted: false });
  }
  return out;
}

/** Whether the database holds a table of this name, any case. */
export function tableExists(sql: SqlLike, name: string): boolean {
  return sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)", name).toArray().length > 0;
}

/** A table's or view's column names, in order. */
export function columnNames(sql: SqlLike, table: string): string[] {
  return sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?) ORDER BY cid", table).toArray().map((c) => String(c.name));
}

/** A name in backticks: SQLite reads a double-quoted name that matches no column as text. */
export const ident = (name: string): string => `\`${name.replace(/`/g, "``")}\``;

/** Objects an export or an import passes over: the platform's, SQLite's statistics, a migration's leftovers, and these jobs' own work tables. */
export const passedOver = (name: string): boolean => /^(_cf_|__miniflare|sqlite_stat|__new_|_export_|_import_)/i.test(name);

export interface SchemaObject {
  name: string;
  type: string;
  table: string;
  sql: string | null;
}

export function schemaObjects(sql: SqlLike): Map<string, SchemaObject> {
  const out = new Map<string, SchemaObject>();
  for (const row of sql.exec<{ name: string; type: string; tbl_name: string; sql: string | null }>("SELECT name, type, tbl_name, sql FROM sqlite_master")) {
    out.set(String(row.name).toLowerCase(), { name: String(row.name), type: String(row.type), table: String(row.tbl_name).toLowerCase(), sql: row.sql === null ? null : String(row.sql) });
  }
  return out;
}

/** What the batch changed in the schema: objects added, dropped or changed. */
export function schemaChanges(before: Map<string, SchemaObject>, after: Map<string, SchemaObject>): { added: SchemaObject[]; dropped: SchemaObject[]; changed: SchemaObject[] } {
  const added: SchemaObject[] = [];
  const dropped: SchemaObject[] = [];
  const changed: SchemaObject[] = [];
  for (const [key, obj] of after) {
    const old = before.get(key);
    if (!old) added.push(obj);
    else if (old.sql !== obj.sql || old.type !== obj.type || old.table !== obj.table) changed.push(obj);
  }
  for (const [key, obj] of before) if (!after.has(key)) dropped.push(obj);
  return { added, dropped, changed };
}

/** A refusal of SQL in plain words, with the gateway's code. */
export type StoreSqlRefusalCode = "protected_table" | "read_only" | "bad_request" | "migration_conflict";

export class StoreSqlRefusal extends Error {
  readonly code: StoreSqlRefusalCode;
  constructor(code: StoreSqlRefusalCode, message: string) {
    super(message);
    this.name = "StoreSqlRefusal";
    this.code = code;
  }
}
