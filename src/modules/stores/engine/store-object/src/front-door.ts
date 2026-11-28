// What a store does to a statement before it runs it, so that SQL written from what a person sees
// of a store reads what the store keeps. Three things, each only where SQLite in workerd would
// otherwise refuse the statement:
//
//   • A table's second name. LOAD cuts a table's name at 60 characters (MAX_TABLE_NAME), so
//     "…_Application_2019-2024.csv" makes `…_application_2019`. The name in full is kept as the
//     table's second name (`_tables.full_name`), and a statement that names it reads the table.
//     A longer limit would make a file loaded again under it a second table.
//   • More than 5 SELECTs in one compound. SQLite in workerd takes at most 5 terms in a chain of
//     UNION, INTERSECT and EXCEPT ("too many terms in compound SELECT"). A longer chain runs as
//     CTEs of at most 5 terms, each starting with the one before, which keeps SQLite's own
//     left-to-right order for any mix of operators.
//   • A column LOAD packed into `_extra`. A store table holds at most 100 columns, so LOAD keeps a
//     file's first 90 and packs the rest of each row into `_extra` as JSON by column name
//     (store-readers names.ts), and records each packed column in `_columns` (`packed_in`). A
//     statement that names one, which SQLite finds in no table, reads that table through a CTE of
//     the table's name that adds the packed columns it names, each read from `_extra` with
//     json_extract. A CTE's name wins over a table's, and `main.` names the table.
//
//   • The two readings and `stable_id`. `as_number(x)` reads text as a number, `as_iso_date(x)`
//     reads text as a day, and `stable_id(x)` makes an id from text that is the same on every run
//     (the readers' readings.ts). SQLite in workerd takes no functions of a store's
//     own, so each call is written out as the SQL it stands for, first, before anything else here
//     reads the statement. An answer's column that has no alias is named by its expression's text,
//     so `runQuery` puts each written-out run back as the call it stood for (`asWritten`).
//
// The query reads (statements.ts `runQuery`) and SHAPE (jobs/shape.ts) come through here, and
// `exec` writes its statements' readings out with `readingsWritten`. A SHAPE shadows its driver
// with a CTE of its own, so it takes the packed columns apart (`packedNamed`) and adds them to
// that CTE.

import { EXTRA_COLUMN, MAX_TABLE_NAME } from "../../store-readers/src/jobs.js";
import { withReadings, type WrittenReading } from "../../store-readers/src/readings.js";
import { bare, closedLine, columnNames, explainGuarded, firstWord, ident, namesIn, type SqlLike, StoreSqlRefusal, tableExists } from "./sql.js";

/** The most SELECTs SQLite in workerd takes in one compound. */
export const COMPOUND_MAX = 5;
/** The most columns SQLite in workerd takes in a table and in an answer. */
export const COLUMNS_MAX = 100;

/** A token of SQL text and where it is: a name (bare or quoted), a string, a number, a parameter or punctuation. */
interface Token {
  kind: "word" | "quoted" | "string" | "number" | "param" | "punct";
  /** A name's name (without its quotes), else the text. */
  value: string;
  start: number;
  end: number;
}

const WORD_START = /[A-Za-z_\u0080-\uffff]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/;

/** SQL text's tokens in order, without spaces and comments. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  const n = text.length;
  let i = 0;
  // A quoted token from i, with a doubled quote read as one; answers its value and its end.
  const quoted = (q: string): { value: string; end: number } => {
    let value = "";
    let j = i + 1;
    while (j < n) {
      const c = text[j]!;
      if (c === q) {
        if (text[j + 1] === q) {
          value += q;
          j += 2;
          continue;
        }
        return { value, end: j + 1 };
      }
      value += c;
      j++;
    }
    return { value, end: n };
  };
  while (i < n) {
    const c = text[i]!;
    if (c === "-" && text[i + 1] === "-") {
      const e = text.indexOf("\n", i);
      i = e < 0 ? n : e + 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f") {
      i++;
    } else if (c === "'") {
      const q = quoted("'");
      out.push({ kind: "string", value: q.value, start: i, end: q.end });
      i = q.end;
    } else if (c === '"' || c === "`") {
      const q = quoted(c);
      out.push({ kind: "quoted", value: q.value, start: i, end: q.end });
      i = q.end;
    } else if (c === "[") {
      const e = text.indexOf("]", i + 1);
      const end = e < 0 ? n : e + 1;
      out.push({ kind: "quoted", value: text.slice(i + 1, e < 0 ? n : e), start: i, end });
      i = end;
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(text[j]!)) j++;
      out.push({ kind: "word", value: text.slice(i, j), start: i, end: j });
      i = j;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(text[j]!)) j++;
      out.push({ kind: "number", value: text.slice(i, j), start: i, end: j });
      i = j;
    } else if (c === "?" || c === ":" || c === "@" || c === "$") {
      let j = i + 1;
      while (j < n && WORD_PART.test(text[j]!)) j++;
      out.push({ kind: "param", value: text.slice(i, j), start: i, end: j });
      i = j;
    } else {
      out.push({ kind: "punct", value: c, start: i, end: i + 1 });
      i++;
    }
  }
  return out;
}

const isWord = (t: Token | undefined, ...words: string[]): boolean => t?.kind === "word" && words.includes(t.value.toLowerCase());
const isPunct = (t: Token | undefined, p: string): boolean => t?.kind === "punct" && t.value === p;

/** The statement with every token replaced as `replace` answers (null keeps it), from the end. */
function replaced(statement: string, toks: readonly Token[], replace: (t: Token) => string | null): string {
  let out = statement;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i]!;
    const next = replace(t);
    if (next !== null) out = out.slice(0, t.start) + next + out.slice(t.end);
  }
  return out;
}

// ── Tables read as others ────────────────────────────────────────────────────

/**
 * The statement with each table name `as` answers for read as that table: a run on a sample reads
 * its sample's tables (`<table>_sample`) where it names the whole data's (statements.ts
 * `sampleReads`). A name the statement gives itself (a CTE's: `name AS (`, `name(columns) AS (`)
 * keeps its name, and so does every name `as` answers null for.
 */
export function withTablesReadAs(statement: string, as: (name: string) => string | null): string {
  const toks = tokens(statement);
  const own = new Set<string>();
  toks.forEach((t, i) => {
    if (t.kind !== "word" && t.kind !== "quoted") return;
    // `name AS (` directly, or `name (a, b) AS (`: the CTE's own name.
    let j = i + 1;
    if (isPunct(toks[j], "(")) {
      while (j < toks.length && !isPunct(toks[j], ")")) j++;
      j++;
    }
    if (isWord(toks[j], "as") && isPunct(toks[j + 1], "(")) own.add(t.value.toLowerCase());
  });
  return replaced(statement, toks, (t) => {
    if ((t.kind !== "word" && t.kind !== "quoted") || own.has(t.value.toLowerCase())) return null;
    const read = as(t.value);
    return read && read.toLowerCase() !== t.value.toLowerCase() ? ident(read) : null;
  });
}

// ── Second names ─────────────────────────────────────────────────────────────

/**
 * Each LOAD table's second name, lowercase, and the table it names: the table's name in full where
 * LOAD cut it. A second name two tables share names neither.
 */
export function secondNames(sql: SqlLike): Map<string, string> {
  const out = new Map<string, string>();
  const shared = new Set<string>();
  for (const row of sql.exec<{ name: string; full_name: string }>("SELECT name, full_name FROM _tables WHERE full_name IS NOT NULL").toArray()) {
    const full = String(row.full_name).toLowerCase();
    if (out.has(full)) shared.add(full);
    out.set(full, String(row.name));
  }
  for (const full of shared) out.delete(full);
  return out;
}

/**
 * The statement with each table's second name in it replaced by the table's name. Only a name
 * longer than a table's name may be is a second name, so a statement without one costs nothing;
 * a table or view that has the name itself (a migration's) keeps it.
 */
export function withSecondNames(sql: SqlLike, statement: string): string {
  const long = tokens(statement).filter((t) => (t.kind === "word" || t.kind === "quoted") && t.value.length > MAX_TABLE_NAME);
  if (!long.length) return statement;
  const names = secondNames(sql);
  if (!names.size) return statement;
  return replaced(statement, long, (t) => {
    const table = names.get(t.value.toLowerCase());
    return table && !tableExists(sql, t.value) && !viewExists(sql, t.value) ? ident(table) : null;
  });
}

/** The tables a statement reads by their second names, as the store names them. */
export function readBySecondName(sql: SqlLike, statement: string): string[] {
  const long = tokens(statement).filter((t) => (t.kind === "word" || t.kind === "quoted") && t.value.length > MAX_TABLE_NAME);
  if (!long.length) return [];
  const names = secondNames(sql);
  return [...new Set(long.map((t) => names.get(t.value.toLowerCase())).filter((n): n is string => !!n))];
}

const viewExists = (sql: SqlLike, name: string): boolean => sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'view' AND lower(name) = lower(?)", name).toArray().length > 0;

// ── Compounds of more than 5 SELECTs ─────────────────────────────────────────

/**
 * The statement with every chain of more than `max` SELECTs joined by UNION, UNION ALL, INTERSECT
 * or EXCEPT, at any depth, run as CTEs of at most `max` terms: the first `max` terms, then each CTE
 * as the first term of the next with the next `max - 1`, and the last of them where the chain was,
 * with the chain's ORDER BY and LIMIT. SQLite reads a chain left to right, so any mix of operators
 * gives what it gave. The CTEs join the WITH list the chain already has, or start one, and their
 * names begin with `_`, which no table of a store's own may. A statement that holds no longer
 * chain comes back as it was.
 */
export function nestCompounds(statement: string, max = COMPOUND_MAX): string {
  const toks = tokens(statement);
  if (toks.filter((t) => isWord(t, "union", "intersect", "except")).length < max) return statement;
  const used = new Set(toks.filter((t) => t.kind === "word" || t.kind === "quoted").map((t) => t.value.toLowerCase()));
  let counter = 0;
  const cteName = (): string => {
    let name: string;
    do name = `_terms_${++counter}`;
    while (used.has(name));
    return name;
  };
  let k = 0;
  // The text from `from` to the `)` that closes this frame (or the end), with each chain in it
  // nested; and where that `)` is.
  const frame = (from: number): { text: string; end: number } => {
    let out = "";
    let at = from;
    // Where, in `out`, the frame's SELECT (or VALUES) begins, each operator is, and the chain's
    // ORDER BY or LIMIT begins.
    let body = -1;
    const ops: { start: number; end: number }[] = [];
    let tail = -1;
    const copy = (to: number) => {
      out += statement.slice(at, to);
      at = to;
    };
    while (k < toks.length) {
      const t = toks[k]!;
      if (isPunct(t, ")")) break;
      if (isPunct(t, "(")) {
        copy(t.end);
        k++;
        const inner = frame(t.end);
        out += inner.text;
        at = inner.end;
        if (k < toks.length) {
          copy(toks[k]!.end);
          k++;
        }
        continue;
      }
      if (t.kind === "word") {
        const word = t.value.toLowerCase();
        if ((word === "select" || word === "values") && body < 0) {
          copy(t.start);
          body = out.length;
        } else if (word === "union" || word === "intersect" || word === "except") {
          copy(t.start);
          const start = out.length;
          if (word === "union" && isWord(toks[k + 1], "all")) k++;
          copy(toks[k]!.end);
          ops.push({ start, end: out.length });
          tail = -1;
          k++;
          continue;
        } else if (ops.length && tail < 0 && (word === "limit" || (word === "order" && isWord(toks[k + 1], "by")))) {
          copy(t.start);
          tail = out.length;
        }
      }
      k++;
    }
    const end = k < toks.length ? toks[k]!.start : statement.length;
    copy(end);
    if (body < 0 || ops.length < max) return { text: out, end };
    return { text: chained(out, body, ops, tail, max, cteName) ?? out, end };
  };
  // A `)` no `(` opened ends the first frame early: the rest stays as it was, for SQLite to refuse.
  const top = frame(0);
  return top.text + statement.slice(top.end);
}

/** A chain of terms (`body` on, with its operators and tail) as CTEs of at most `max` terms; null when the frame is not a SELECT alone. */
function chained(text: string, body: number, ops: readonly { start: number; end: number }[], tail: number, max: number, cteName: () => string): string | null {
  const prefix = text.slice(0, body);
  // Comments before the frame's first word are no part of what it holds.
  const opening = bare(prefix);
  const withList = /^with\b/i.test(opening);
  // A frame that holds more than a SELECT (an INSERT's) is left to SQLite.
  if (!withList && opening !== "") return null;
  const terms: string[] = [];
  let from = body;
  for (const op of ops) {
    terms.push(text.slice(from, op.start).trim());
    from = op.end;
  }
  terms.push(text.slice(from, tail >= 0 ? tail : text.length).trim());
  const op = (i: number): string => text.slice(ops[i]!.start, ops[i]!.end);
  // Terms a to b, after the CTE before them as their first term when there is one.
  const compound = (head: string | null, a: number, b: number): string => {
    let s = head === null ? terms[a]! : `SELECT * FROM ${head}\n${op(a - 1)}\n${terms[a]}`;
    for (let j = a + 1; j < b; j++) s += `\n${op(j - 1)}\n${terms[j]}`;
    return s;
  };
  const ctes: string[] = [];
  let head: string | null = null;
  let i = 0;
  let last: string;
  for (;;) {
    const room = head === null ? max : max - 1;
    if (terms.length - i <= room) {
      last = compound(head, i, terms.length);
      break;
    }
    const name = cteName();
    ctes.push(`${name} AS (\n${compound(head, i, i + room)}\n)`);
    head = name;
    i += room;
  }
  const end = tail >= 0 ? `\n${text.slice(tail)}` : "";
  const list = ctes.join(",\n");
  // A WITH list whose last CTE a `--` comment follows gets its comma on the next line.
  return withList ? `${closedLine(prefix.trimEnd())},\n${list}\n${last}${end}` : `${prefix}WITH ${list}\n${last}${end}`;
}

// ── Packed columns ───────────────────────────────────────────────────────────

/** The packed columns a statement names of one table it reads, and the table's own columns. */
export interface PackedRead {
  /** The table, as the store names it. */
  table: string;
  /** The packed columns the statement names, as LOAD named them, in the file's order. */
  names: string[];
  /** The table's own columns: in the database, or in its parked files. */
  columns: string[];
}

/** The packed columns a statement reads, by table (lowercase). */
export type PackedReads = ReadonlyMap<string, PackedRead>;

export const NO_PACKED: PackedReads = new Map();

/** A parked table's columns, from its files' record. */
function parkedColumns(sql: SqlLike, table: string): string[] {
  const row = sql.exec<{ columns: string }>("SELECT p.columns FROM _tables AS t JOIN _parked AS p ON p.id = t.parked WHERE lower(t.name) = lower(?) AND t.kind = 'program'", table).toArray()[0];
  if (!row) return [];
  try {
    return (JSON.parse(String(row.columns)) as { name: string }[]).map((c) => c.name);
  } catch {
    return [];
  }
}

const ownColumns = (sql: SqlLike, table: string): string[] => (tableExists(sql, table) || viewExists(sql, table) ? columnNames(sql, table) : parkedColumns(sql, table));

/**
 * The packed columns a statement names, by the table that packed them: each column LOAD packed
 * into `_extra` of a table the statement names, when the statement names it too and no other table
 * it names has a column of that name (a statement that read that one keeps reading it). Empty for
 * a statement that names none, at the cost of one indexed read.
 */
export function packedNamed(sql: SqlLike, statement: string): Map<string, PackedRead> {
  const out = new Map<string, PackedRead>();
  const words = namesIn(statement);
  if (!words.size) return out;
  const rows = sql
    .exec<{ tbl: string; name: string }>("SELECT tbl, name FROM _columns WHERE packed_in IS NOT NULL AND tbl IN (SELECT value FROM json_each(?)) ORDER BY tbl, rowid", JSON.stringify([...words]))
    .toArray();
  const named = rows.filter((r) => words.has(String(r.name).toLowerCase()));
  if (!named.length) return out;
  // The other tables and views the statement names, and their columns.
  const others = new Map<string, Set<string>>();
  for (const word of words) {
    if (!tableExists(sql, word) && !viewExists(sql, word)) continue;
    others.set(word, new Set(columnNames(sql, word).map((c) => c.toLowerCase())));
  }
  for (const r of named) {
    const table = String(r.tbl);
    const lower = table.toLowerCase();
    const name = String(r.name);
    if ([...others].some(([other, columns]) => other !== lower && columns.has(name.toLowerCase()))) continue;
    const read = out.get(lower) ?? { table, names: [], columns: ownColumns(sql, table) };
    read.names.push(name);
    out.set(lower, read);
  }
  return out;
}

/** A packed column's value, read from `_extra`: a name JSON's path cannot hold is looked up by key. */
function packedValue(name: string): string {
  const text = name.replace(/'/g, "''");
  if (/["\\]/.test(name)) return `(SELECT j.value FROM json_each(${ident(EXTRA_COLUMN)}) AS j WHERE j.key = '${text}')`;
  return `json_extract(${ident(EXTRA_COLUMN)}, '$."${text}"')`;
}

/** Whether a statement reads every column of something: a `*` of a select list, or a NATURAL join. */
function readsEveryColumn(statement: string): boolean {
  const toks = tokens(statement);
  return toks.some((t, i) => {
    if (isWord(t, "natural")) return true;
    if (!isPunct(t, "*")) return false;
    const before = toks[i - 1];
    return isWord(before, "select", "distinct", "all") || isPunct(before, ",") || isPunct(before, ".");
  });
}

/**
 * The select list of the CTE that stands for a table with the packed columns a statement names:
 * every column and the packed ones, or, where that passes the 100 columns a statement may answer,
 * only the columns the statement names. A statement that reads every column then is refused.
 * SQLite's row number goes in by the names the statement reads it by, since a CTE has none.
 */
export function packedList(read: PackedRead, statement: string): string {
  const words = namesIn(statement);
  const values = read.names.map((name) => `${packedValue(name)} AS ${ident(name)}`);
  const own = new Set(read.columns.map((c) => c.toLowerCase()));
  const rowids = ["rowid", "oid", "_rowid_"].filter((w) => words.has(w) && !own.has(w)).map((w) => `rowid AS ${w}`);
  if (read.columns.length + read.names.length + rowids.length <= COLUMNS_MAX) return ["*", ...rowids, ...values].join(", ");
  if (readsEveryColumn(statement)) {
    throw new StoreSqlRefusal(
      "bad_request",
      `${read.table} has ${read.columns.length} columns of its own, and this statement reads every one and ${read.names.length} more from ${EXTRA_COLUMN}: a statement answers at most ${COLUMNS_MAX} columns. Name the columns it reads instead of *.`,
    );
  }
  const columns = read.columns.filter((c) => words.has(c.toLowerCase())).map(ident);
  return [...columns, ...rowids, ...values].join(", ");
}

/** The statement with `cte` (one CTE or a list of them) first in its WITH list. Comments before its WITH stay before it. */
export function withCte(statement: string, cte: string): string {
  const rest = bare(statement);
  const m = /^with\s+(recursive\s+)?/i.exec(rest);
  if (m) return `${statement.slice(0, statement.length - rest.length)}WITH ${m[1] ? "RECURSIVE " : ""}${cte}, ${rest.slice(m[0].length)}`;
  return `WITH ${cte}\n${statement}`;
}

/**
 * The statement with each table whose packed columns it reads shadowed by a CTE of its name that
 * adds them. `own` is a CTE the caller stands for a table with already (a SHAPE's driver, over some
 * of its rows): its select list gets that table's packed columns, `*` when it has none.
 */
export function withPacked(statement: string, packed: PackedReads, own?: { table: string; cte: (list: string) => string }): string {
  const ctes: string[] = [];
  const ownLower = own?.table.toLowerCase();
  if (own) {
    const read = packed.get(ownLower!);
    ctes.push(own.cte(read ? packedList(read, statement) : "*"));
  }
  for (const [lower, read] of packed) {
    if (lower === ownLower) continue;
    ctes.push(`${ident(read.table)} AS (SELECT ${packedList(read, statement)} FROM main.${ident(read.table)})`);
  }
  return ctes.length ? withCte(statement, ctes.join(",\n")) : statement;
}

/** Whether a statement runs as it is: its EXPLAIN, with double-quoted names that are no column refused. */
function explains(sql: SqlLike, statement: string, params: readonly unknown[]): boolean {
  try {
    explainGuarded(sql, statement, params, new Map());
    return true;
  } catch {
    return false;
  }
}

/** A SELECT as the store runs it: its readings written out, its second names read and its compounds nested, and the packed columns it reads. */
export interface Readable {
  statement: string;
  /** Empty when it runs without them, or names none. */
  packed: PackedReads;
  /** Each reading the statement named, beside what it was written out as. Empty when it names none. */
  readings: WrittenReading[];
}

/**
 * A statement with its two readings and `stable_id` written out (see the top of this file). A call left without
 * its closing bracket, or with nothing between its brackets, is refused in words for whoever
 * wrote it. A statement that names no reading comes back as it was.
 */
export function readingsWritten(statement: string): { sql: string; readings: WrittenReading[] } {
  const read = withReadings(statement);
  if (read.problem) throw new StoreSqlRefusal("bad_request", read.problem);
  return { sql: read.sql, readings: read.readings };
}

/**
 * A SELECT with its readings written out, its second names read and its compounds nested, and the
 * packed columns it reads: none when the statement runs without them, so SQL that already reads
 * what it means keeps doing so.
 */
export function readable(sql: SqlLike, select: string, params: readonly unknown[] = [], opts: { as?: (name: string) => string | null } = {}): Readable {
  const read = readingsWritten(select);
  const named = withSecondNames(sql, read.sql);
  const statement = nestCompounds(opts.as ? withTablesReadAs(named, opts.as) : named);
  const packed = packedNamed(sql, statement);
  if (!packed.size || explains(sql, statement, params)) return { statement, packed: NO_PACKED, readings: read.readings };
  return { statement, packed, readings: read.readings };
}

/**
 * A query as the store runs it (a SELECT, WITH or VALUES; anything else with only its readings
 * written out), and the readings it named: see the top of this file.
 */
export function frontDoor(sql: SqlLike, statement: string, params: readonly unknown[], opts: { as?: (name: string) => string | null } = {}): { statement: string; readings: WrittenReading[] } {
  if (!["SELECT", "WITH", "VALUES"].includes(firstWord(statement))) {
    const read = readingsWritten(statement);
    return { statement: read.sql, readings: read.readings };
  }
  const r = readable(sql, statement, params, opts);
  return { statement: withPacked(r.statement, r.packed), readings: r.readings };
}
