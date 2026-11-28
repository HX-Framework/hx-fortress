// SHAPE: one table of a store made from its others by one SQLite SELECT (Stores, Part A).
// store_shape (the api's agent/tools/store-steps.ts) writes or takes the SQL, checks
// it on a sample, and submits this job; the model call that writes SQL from a goal stays there.
// The store keeps the SQL in `_meta` under `shape:<into>`, with the goal and the source tables'
// columns it was written for, so a later run of the same goal on the same columns runs it again
// without asking a model. Its params, result and saved record are `store-readers/jobs`.
//
// The tables a SHAPE reads are the store's tables its SELECT names (`tablesRead`): a view by the
// tables its own SELECT names, a parked table too. How the table is made, each run (`ShapeMode`):
//   whole      The first run, a new SQL, new source columns, or a SELECT that does not make each
//              row from one row of one table (`rowLocal`: no GROUP BY, aggregate, window, LIMIT,
//              DISTINCT, UNION or rowid): `CREATE TABLE "<into>__new" AS …`, swapped in as a new
//              version; the version before is kept and older ones dropped. When every row has a
//              different `_key`, all from one source table named once in a FROM or JOIN (the
//              driver), later runs change the table by key.
//   changed    Only the rows whose source rows changed are written, in place, by `_key`, comparing
//              first, so a row that comes out the same is not written (an UPDATE writes every row it
//              matches); `_file` and `_row` alone never count as a change. The first such run makes
//              the unique index on `_key` it needs. When only the driver changed and the store names
//              its changed keys (deltas.ts), the SELECT runs over just those rows: the driver's name
//              is shadowed by a CTE of its changed rows. When another table it reads changed (a
//              lookup), the driver was made anew (its rows keep their `_key`s), or it reads a table
//              made by a migration, which records no changes, it runs over the driver a range of
//              rowids at a time, and writes the rows that differ.
//   unchanged  No table it reads changed since the last run: nothing is written.
//   view       The SELECT is kept as a view: no rows of its own, always current ("Ready").
// Whichever way, the store records what changed in the table, so the steps after it read only
// those rows; a parked table it reads is brought back first (park.ts), except a parked driver
// whose changed keys the store names: the rows of those keys are read out of its parked files a
// part at a time, and the SELECT runs over them with the driver's name shadowed by a CTE of them,
// so nothing comes back into the database; and its driver, when a LOAD made it, is parked a while
// later (a lookup stays: every run reads it).

import {
  keepOf,
  KEY_COLUMN,
  LOADED_GROUP,
  madeByOf,
  MAX_TABLE_NAME,
  TABLE_NAME_RE,
  tableNameRefusal,
  READY_GROUP,
  type RowCounts,
  type SavedShape,
  SHAPED_GROUP,
  shapeKey,
  type ShapeMode,
  type ShapeParams,
  type ShapeResult,
} from "../../../store-readers/src/jobs.js";
import { PULLED_GROUP } from "../../../store-readers/src/pull.js";
import { StoreError } from "../core.js";
import { abandonDeltas, appendAll, changedSince, KEYS_PER_PART, lastChange, type RowKeys, wholeSince } from "../deltas.js";
import { type BringBackState, bringBackStep, type ParkedColumn, parkedFiles, readPart, utf8Length } from "../park.js";
import { getMeta } from "../schema.js";
import { NO_PACKED, type PackedReads, readable, withPacked } from "../front-door.js";
import { closedLine, columnNames, explainGuarded, firstWord, isReservedName, PROGRAM_VERSION_RE, splitStatements, type SqlLike, sqlTokens, tableExists, type StoreSqlValue } from "../sql.js";
import { type CommittedTable, type JobContext, type JobHandler, JobParamsError } from "./types.js";

export { SHAPED_GROUP, shapeKey, type ShapeParams };

export interface ShapeState {
  /** What the job does next. */
  phase: "bring" | "make" | "end";
  mode: ShapeMode;
  /**
   * For `changed`: by the driver's changed keys, by those keys read out of the parked driver's
   * files (`parts`), or over ranges of its rowids.
   */
  by: "keys" | "parts" | "ranges" | null;
  /** Why the whole table is made, in words. */
  why: string | null;
  /** The change number of each table it reads, when the job read it. */
  read: Record<string, number>;
  /** The driver and the table's columns, as the saved record keeps them. */
  driver: string | null;
  columns: string[] | null;
  /** Parked tables still to bring back, the one under way, and those brought back. */
  bring: string[];
  bringing: BringBackState | null;
  broughtBack: string[];
  /** whole: `<into>__new` holds the SELECT's rows. */
  made: boolean;
  /**
   * ranges: the open change, its restore point (the moment before it opened), the rowid the next
   * range starts after, and the driver's last rowid.
   */
  change: number | null;
  restorePoint: string | null;
  after: number;
  last: number;
  counts: RowCounts;
  result: ShapeResult | null;
  /** parts: the parked driver's files it reads, and the part to read next. */
  scan?: { files: string; part: number; parts: number };
  /** parts: keys it changed and has not yet written to the change's record, a full part of keys at a time. */
  pending?: { added: string[]; changed: string[]; removed: string[] };
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A store runs a statement of at most 100 KB; the SELECT is wrapped in CREATE TABLE … AS, or in an UPDATE. */
const SQL_MAX = 99_000;
const STATEMENT_MAX = 99_500;
const INTO = TABLE_NAME_RE;
/** The driver's rows one range of a `changed` run reads. */
export const RANGE_ROWS = 20_000;
/** The most changed keys a run reads out of a parked driver's files; past it, the driver comes back. */
export const PARTS_KEYS_MAX = 200_000;
/** The bytes of rows one statement of a `parts` run binds: a value is at most 2 MB in a store. */
const PARTS_BYTES = 1_000_000;
/** The `_key`s a `parts` run's statement changes: those of the rows it is given (?2). */
const PARTS_SCOPE = "SELECT j.value FROM json_each(?2) AS j";
const NO_COUNTS: RowCounts = { added: 0, changed: 0, removed: 0 };
/** A LOAD's own columns of where a row came from: written when a row changes, never a change by themselves. */
const WHERE_FROM = new Set(["_file", "_row"]);

/**
 * The SQL as one SELECT (or WITH … SELECT), without a closing semicolon; null for anything else.
 * Comments stay where they were written, before the statement too, as in a file a team keeps its
 * SQL in. A statement that ends in a `--` comment ends with a line's end, so SQL the job writes
 * after it is not read as part of the comment.
 */
export function oneSelect(sql: string): string | null {
  const statements = splitStatements(sql);
  if (statements.length !== 1) return null;
  const s = statements[0]!.trim().replace(/;\s*$/, "");
  return ["SELECT", "WITH"].includes(firstWord(s)) ? closedLine(s) : null;
}

/**
 * Refuses a SELECT this store cannot run as written, before anything is made: a double-quoted name
 * that is no column, which SQLite in workerd would read as text (sql.ts `explainGuarded`, as query
 * and exec refuse it), or a table or column the store does not have. The job fails at once with
 * the reason (a StoreError is not tried again).
 */
function guardSelect(sql: SqlLike, select: string, params: readonly unknown[] = []): void {
  try {
    explainGuarded(sql, select, params, new Map());
  } catch (err) {
    throw new StoreError(400, "bad_request", `The SELECT does not run on this store: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A table a SHAPE reads: a program's (parked or not) or a migration's. */
export interface ReadTable {
  name: string;
  kind: "program" | "managed";
  group: string | null;
  parked: boolean;
}

/** Words that end a FROM clause at its own depth. */
const ENDS_FROM = new Set(["where", "group", "order", "limit", "having", "window", "union", "intersect", "except", "select", "values"]);

/** How often a SELECT names a table by its plain name, and with a schema before it (`main.permits`). */
export interface TableNamed {
  plain: number;
  withSchema: number;
}

/**
 * The names a SELECT reads as tables: each name right after FROM or JOIN, or after a comma in a
 * FROM clause, by how often it is named plainly and how often with a schema (`main.permits` reads
 * permits too). A name anywhere else, a column, an alias or a function, is no table's.
 */
export function tablesNamed(select: string): Map<string, TableNamed> {
  const tokens = sqlTokens(select);
  const out = new Map<string, TableNamed>();
  // Whether each depth of parentheses is in a FROM clause now.
  const inFrom: boolean[] = [false];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct") {
      if (t.text === "(") inFrom.push(false);
      else if (t.text === ")" && inFrom.length > 1) inFrom.pop();
      continue;
    }
    const word = t.quoted ? null : t.text.toLowerCase();
    if (word === "from") {
      inFrom[inFrom.length - 1] = true;
      continue;
    }
    if (word !== null && ENDS_FROM.has(word)) {
      inFrom[inFrom.length - 1] = false;
      continue;
    }
    const before = tokens[i - 1];
    const keyword = before?.kind === "name" && !before.quoted ? before.text.toLowerCase() : null;
    if (!(keyword === "from" || keyword === "join" || (before?.text === "," && inFrom[inFrom.length - 1]))) continue;
    const withSchema = tokens[i + 1]?.text === "." && tokens[i + 2]?.kind === "name";
    const name = withSchema ? tokens[i + 2]! : t;
    if (withSchema) i += 2;
    const lower = name.text.toLowerCase();
    const named = out.get(lower) ?? { plain: 0, withSchema: 0 };
    if (withSchema) named.withSchema++;
    else named.plain++;
    out.set(lower, named);
  }
  return out;
}

/**
 * The tables SQLite itself opens to run a SELECT (EXPLAIN's OpenRead), by lowercase name; null
 * when it cannot say, as when the SELECT names a parked table.
 */
function tablesOpened(sql: SqlLike, select: string): Set<string> | null {
  try {
    const roots = new Map<number, string>();
    for (const r of sql.exec<{ tbl_name: string; rootpage: number | null }>("SELECT tbl_name, rootpage FROM sqlite_master WHERE type IN ('table', 'index') AND rootpage > 0").toArray()) {
      roots.set(Number(r.rootpage), String(r.tbl_name).toLowerCase());
    }
    const out = new Set<string>();
    for (const op of sql.exec<{ opcode: string; p2: number; p3: number }>(`EXPLAIN ${select}`).toArray()) {
      const table = op.opcode === "OpenRead" && Number(op.p3) === 0 ? roots.get(Number(op.p2)) : undefined;
      if (table) out.add(table);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The store's tables a SELECT reads, parked ones included: those it names in a FROM or a JOIN, a
 * view by the tables its own SELECT names there (a program view's kept SQL, a migration's view's
 * CREATE), and any other SQLite opens to run it; never `into`, a store's own table or a kept
 * version. A column that shares a parked table's name does not bring that table back.
 */
export function tablesRead(sql: SqlLike, select: string, into: string): ReadTable[] {
  const program = new Map<string, { name: string; group: string | null; parked: boolean }>();
  for (const r of sql.exec<{ name: string; grp: string | null; parked: string | null }>("SELECT name, grp, parked FROM _tables WHERE kind = 'program'").toArray()) {
    program.set(String(r.name).toLowerCase(), { name: String(r.name), group: r.grp === null ? null : String(r.grp), parked: r.parked !== null });
  }
  const schema = new Map<string, { name: string; type: string; sql: string | null }>();
  for (const r of sql.exec<{ name: string; type: string; sql: string | null }>("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view')").toArray()) {
    schema.set(String(r.name).toLowerCase(), { name: String(r.name), type: String(r.type), sql: r.sql === null ? null : String(r.sql) });
  }
  const out = new Map<string, ReadTable>();
  const seen = new Set<string>();
  // SQLite's own answer, when it can give one, catches a table the names above would miss.
  const queue = [...tablesNamed(select).keys(), ...(tablesOpened(sql, select) ?? [])];
  while (queue.length) {
    const lower = queue.shift()!;
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (lower === into.toLowerCase() || isReservedName(lower) || PROGRAM_VERSION_RE.test(lower)) continue;
    const own = program.get(lower);
    const found = schema.get(lower);
    if (found?.type === "view") {
      const viewSql = own ? savedOf(sql, own.name)?.sql : found.sql;
      if (viewSql) queue.push(...tablesNamed(viewSql).keys());
      continue;
    }
    if (own) out.set(lower, { name: own.name, kind: "program", group: own.group, parked: own.parked });
    else if (found?.type === "table") out.set(lower, { name: found.name, kind: "managed", group: null, parked: false });
  }
  return [...out.values()];
}

/** Words that make a SELECT's row depend on more than one row of its tables, or on a rowid. */
const NOT_ROW_LOCAL = new Set(["over", "window", "group", "having", "limit", "offset", "distinct", "union", "intersect", "except", "rowid", "oid", "_rowid_"]);
const AGGREGATES = new Set(["count", "sum", "avg", "min", "max", "total", "group_concat", "string_agg", "json_group_array", "json_group_object"]);
/** SQLite's min and max of two values or more are a row's own: `max(fee, 0)`. */
const ALSO_SCALAR = new Set(["min", "max"]);
/** What gives another value each run: a row made with it is not the same row from the same source row. */
const CLOCK_WORDS = new Set(["current_date", "current_time", "current_timestamp"]);
const CHANCE_CALLS = new Set(["random", "randomblob"]);
const ROWIDS = new Set(["rowid", "oid", "_rowid_"]);

/** Whether the call whose "(" is at `open` passes two arguments or more: a comma at its own depth. */
function twoArguments(tokens: readonly { text: string }[], open: number): boolean {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if (text === "(") depth++;
    else if (text === ")" && --depth === 0) return false;
    else if (text === "," && depth === 1) return true;
  }
  return false;
}

/**
 * Whether each row a SELECT makes comes from one row of one table, so the SELECT may run over
 * some rows of its driver and give the same rows a run over all of them would: no window, GROUP
 * BY, HAVING, aggregate, LIMIT, OFFSET, DISTINCT, UNION, INTERSECT or EXCEPT, and no rowid, which
 * the CTE that stands for the driver does not have. Nor the clock or chance (`date('now')`,
 * CURRENT_TIMESTAMP, `random()`): a row they make changes with no source row changing, so the
 * table is made whole each run. Doubt answers no.
 */
export function rowLocal(select: string): boolean {
  if (/'now'/i.test(select)) return false;
  const tokens = sqlTokens(select);
  return !tokens.some((t, i) => {
    if (t.kind !== "name") return false;
    const word = t.text.toLowerCase();
    if (t.quoted) return ROWIDS.has(word);
    if (CLOCK_WORDS.has(word)) return true;
    if (CHANCE_CALLS.has(word)) return tokens[i + 1]?.text === "(";
    if (AGGREGATES.has(word)) return tokens[i + 1]?.text === "(" && !(ALSO_SCALAR.has(word) && twoArguments(tokens, i + 1));
    return NOT_ROW_LOCAL.has(word);
  });
}

/**
 * How often a SELECT reads a table by its plain name in a FROM or a JOIN, which a CTE of that name
 * stands in for (`permits.x`, a column, does not count). A table it also reads as `main.permits`
 * answers 0: no CTE stands in for that read.
 */
export function tableRefs(select: string, table: string): number {
  const named = tablesNamed(select).get(table.toLowerCase());
  return named && named.withSchema === 0 ? named.plain : 0;
}

/**
 * The SELECT with the driver's name shadowed by a CTE of only some of its rows (`filter`), so the
 * SELECT runs over just those rows: a CTE's name wins over a table's, and `main.` names the table.
 * A SELECT that starts with WITH gets the CTE first in its list. The packed columns it reads
 * (front-door.ts) are read through that CTE for the driver, and through one of their own for any
 * other table.
 */
export function shadowed(select: string, driver: string, filter: string, packed: PackedReads = NO_PACKED): string {
  return withPacked(select, packed, { table: driver, cte: (list) => `${quote(driver)} AS (SELECT ${list} FROM main.${quote(driver)} WHERE ${filter})` });
}

/**
 * The SELECT with the driver's name shadowed by a CTE of rows it is given as JSON (?1: an array of
 * rows, each an array in the order of the parked files' `columns`) whose `_key`s are in ?2, so the
 * SELECT runs over rows that are not in the database. Each value is CAST to its column's declared
 * type, which gives it the column's affinity: it compares as it does in the table. The packed
 * columns it reads of the driver are read from those rows' `_extra`.
 */
export function shadowedByRows(select: string, driver: string, columns: readonly ParkedColumn[], packed: PackedReads = NO_PACKED): string {
  const at = columns.findIndex((c) => c.name === KEY_COLUMN);
  const values = columns.map((c, i) => {
    const v = `json_extract(j.value, '$[${i}]')`;
    return `${c.type ? `CAST(${v} AS ${c.type})` : v} AS ${quote(c.name)}`;
  });
  const rows = `SELECT ${values.join(", ")} FROM json_each(?1) AS j WHERE json_extract(j.value, '$[${at}]') IN (SELECT value FROM json_each(?2))`;
  return withPacked(select, packed, { table: driver, cte: (list) => `${quote(driver)} AS (${list === "*" ? rows : `SELECT ${list} FROM (${rows})`})` });
}

/** The SELECT as this store runs it: its tables' second names read, its compounds nested, and the packed columns it reads (front-door.ts). */
function runnable(sql: SqlLike, select: string): { select: string; packed: PackedReads } {
  const r = readable(sql, select);
  return { select: r.statement, packed: r.packed };
}

/** Whether every row of a table has a `_key`, and no two the same one. */
export function keysUnique(sql: SqlLike, table: string): boolean {
  const k = quote(KEY_COLUMN);
  const stats = sql.exec<{ n: number; d: number; c: number }>(`SELECT count(*) AS n, count(DISTINCT ${k}) AS d, count(${k}) AS c FROM ${quote(table)}`).one();
  return Number(stats.n) === Number(stats.d) && Number(stats.d) === Number(stats.c);
}

/** Whether a LOAD names a table's rows by their values' hash: its file had no key column. */
const hashKeyed = (sql: SqlLike, table: string): boolean => sql.exec("SELECT 1 AS x FROM _tables WHERE name = ? AND key_from = ''", table).toArray().length > 0;

/** Whether `table` has a unique index on `_key` alone: what a change by key needs. */
export function keyedUnique(sql: SqlLike, table: string): boolean {
  for (const index of sql.exec<{ name: string; unique: number }>('SELECT name, "unique" FROM pragma_index_list(?)', table).toArray()) {
    if (Number(index.unique) !== 1) continue;
    const cols = sql.exec<{ name: string | null }>("SELECT name FROM pragma_index_info(?)", String(index.name)).toArray();
    if (cols.length === 1 && cols[0]!.name === KEY_COLUMN) return true;
  }
  return false;
}

/** The record a SHAPE kept for `into`, or null. */
function savedOf(sql: SqlLike, into: string): SavedShape | null {
  const raw = getMeta(sql, shapeKey(into));
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as SavedShape;
    return typeof saved.sql === "string" ? saved : null;
  } catch {
    return null;
  }
}

/** How this run makes the table, and why when it makes it whole. */
export function decide(
  sql: SqlLike,
  params: ShapeParams,
  saved: SavedShape | null,
  reads: readonly ReadTable[],
  read: Record<string, number>,
): { mode: ShapeMode; by: "keys" | "ranges" | null; why: string | null } {
  const whole = (why: string) => ({ mode: "whole" as const, by: null, why });
  if (params.as === "view") return { mode: "view", by: null, why: null };
  if (params.whole) return whole("the whole table was asked for");
  if (!saved) return whole("it is the first time this table is made");
  if (saved.as === "view") return whole("it was a view until now");
  if (saved.sql !== params.sql) return whole("its SQL changed");
  if (saved.sources !== params.sources) return whole("its source tables' columns changed");
  // A store made from another's export has the SQL, and none of that store's change numbers.
  if (saved.driver && !saved.read) return whole("the store has no record of what changed since its last run");
  if (!saved.driver || !saved.read || !saved.columns) return whole(`its rows have no ${KEY_COLUMN} from one source table, so each run makes it whole`);
  const into = params.into;
  const now = tableExists(sql, into) ? columnNames(sql, into) : null;
  if (!now || saved.columns.some((c) => !now.includes(c))) return whole("the table is not as its last run left it");
  // An app on the store reads these columns: only a new version says whether it can hold them.
  const lower = new Set(now.map((c) => c.toLowerCase()));
  if (params.keep?.[into.toLowerCase()]?.some((k) => !lower.has(k.column.toLowerCase()))) return whole("an app reads a column the table does not have");
  const driver = saved.driver;
  if (!(driver in read)) return whole(`its SELECT no longer reads ${driver}`);
  // A LOAD names each row of its table once; another step's table may come to repeat a `_key`.
  const fromLoad = reads.find((t) => t.name === driver)?.group === LOADED_GROUP;
  if (!fromLoad && !keysUnique(sql, driver)) return whole(`${driver}'s rows no longer have one ${KEY_COLUMN} each`);
  const changed = Object.keys(read).filter((s) => read[s] !== saved.read![s]);
  // A migration's table records no changes: the rows are compared every run.
  const managed = reads.some((t) => t.kind === "managed");
  if (!changed.length && !managed) return { mode: "unchanged", by: null, why: null };
  const after = saved.read[driver] ?? 0;
  // Most of a LOAD's rows changed, and its rows are named by their values: each changed row is a
  // new `_key`, which costs a removal, a new row and its index entry in place, three writes where
  // making the table whole writes one.
  if (changed.includes(driver) && fromLoad && hashKeyed(sql, driver) && wholeSince(sql, driver, after)) {
    return whole(`most of ${driver}'s rows are new, and they are named by their values`);
  }
  // Only the driver changed, and the store names its changed rows: those rows. Otherwise (a lookup
  // changed, or the driver was made anew with its rows' `_key`s) the rows are compared, and only
  // those that differ are written.
  if (!managed && changed.length === 1 && changed[0] === driver) {
    const since = changedSince(sql, driver, after);
    if (since && since.keys === 0) return { mode: "unchanged", by: null, why: null };
    if (since) return { mode: "changed", by: "keys", why: null };
  }
  return { mode: "changed", by: "ranges", why: null };
}

/**
 * The driver: the one table whose `_key` every row of the new table holds, each once, when the
 * SELECT makes each row from one row of one table and reads that table once, in a FROM or a JOIN.
 * Two tables that would both do (keyed by the same town key) leave no driver: a lookup must never
 * be taken for it.
 */
export function driverOf(sql: SqlLike, fresh: string, select: string, reads: readonly ReadTable[]): string | null {
  if (!rowLocal(select) || !columnNames(sql, fresh).includes(KEY_COLUMN)) return null;
  const k = quote(KEY_COLUMN);
  // A table of no rows says nothing of whose `_key`s its rows carry: no driver until it has some.
  if (Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${quote(fresh)}`).one().n) === 0 || !keysUnique(sql, fresh)) return null;
  const candidates = reads.filter(
    (t) => t.kind === "program" && tableExists(sql, t.name) && columnNames(sql, t.name).includes(KEY_COLUMN) && tableRefs(select, t.name) === 1 && keysUnique(sql, t.name),
  );
  const holds = candidates.filter(
    (t) => !sql.exec(`SELECT 1 AS x FROM ${quote(fresh)} WHERE ${k} NOT IN (SELECT ${k} FROM ${quote(t.name)} WHERE ${k} IS NOT NULL) LIMIT 1`).toArray().length,
  );
  return holds.length === 1 ? holds[0]!.name : null;
}

/**
 * The three statements of a change in place, over `rows` (the SELECT, shadowed to some of the
 * driver's rows) and `scope` (the `_key`s of those driver rows): the rows that differ, the rows that
 * are new, and the rows whose source row is gone or no longer makes one. Each answers its `_key`s.
 */
export function changeStatements(into: string, columns: readonly string[], rows: string, scope: string): { update: string | null; insert: string; remove: string } {
  const t = quote(into);
  const k = quote(KEY_COLUMN);
  const set = columns.filter((c) => c !== KEY_COLUMN);
  const compared = set.filter((c) => !WHERE_FROM.has(c));
  return {
    update: compared.length
      ? `UPDATE ${t} SET ${set.map((c) => `${quote(c)} = n.${quote(c)}`).join(", ")} FROM (${rows}) AS n WHERE ${t}.${k} = n.${k} AND (${compared.map((c) => `${t}.${quote(c)} IS NOT n.${quote(c)}`).join(" OR ")}) RETURNING ${k} AS k`
      : null,
    insert: `INSERT INTO ${t} (${columns.map(quote).join(", ")}) SELECT ${columns.map((c) => `n.${quote(c)}`).join(", ")} FROM (${rows}) AS n WHERE n.${k} NOT IN (SELECT ${k} FROM ${t}) RETURNING ${k} AS k`,
    remove: `DELETE FROM ${t} WHERE ${k} IN (${scope}) AND ${k} NOT IN (SELECT ${k} FROM (${rows}) WHERE ${k} IS NOT NULL) RETURNING ${k} AS k`,
  };
}

const keysOf = (sql: SqlLike, statement: string | null, params: unknown[]): string[] =>
  statement ? sql.exec<{ k: StoreSqlValue }>(statement, ...params).toArray().map((r) => String(r.k)) : [];

/** Runs a change in place's three statements: the `_key`s each changed. */
function runChange(sql: SqlLike, s: ReturnType<typeof changeStatements>, params: unknown[]): RowKeys {
  return { changed: keysOf(sql, s.update, params), added: keysOf(sql, s.insert, params), removed: keysOf(sql, s.remove, params) };
}

const tooLong = (s: ReturnType<typeof changeStatements>): boolean => Math.max(s.update?.length ?? 0, s.insert.length, s.remove.length) > STATEMENT_MAX;

/**
 * Refuses a change in place whose SELECT makes two rows with one `_key` for some of the driver's
 * rows (a lookup table that came to hold a value twice): an UPDATE would keep one of them at
 * random, where the whole table would hold both.
 */
function refuseRepeatedKeys(sql: SqlLike, rows: string, params: unknown[]): void {
  const k = quote(KEY_COLUMN);
  if (sql.exec(`SELECT 1 AS x FROM (${rows}) GROUP BY ${k} HAVING count(*) > 1 LIMIT 1`, ...params).toArray().length) {
    throw new Error(`UNIQUE constraint failed: two rows have one ${KEY_COLUMN}`);
  }
}

/** A failure of a change in place that a whole table would not have: two rows with one `_key`, or a SELECT that does not run row by row. */
function rowByRowFailure(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(message)) return `two of its new rows have the same ${KEY_COLUMN}`;
  if (/no such column|no such table|misuse|syntax error|too big|SQLITE_TOOBIG|too many/i.test(message)) return "its SELECT does not run over some of its rows at a time";
  return null;
}

const inPlaceNote = (c: RowCounts): string =>
  `${(c.added + c.changed + c.removed).toLocaleString("en-US")} rows changed in place (${c.added.toLocaleString("en-US")} added, ${c.changed.toLocaleString("en-US")} changed, ${c.removed.toLocaleString("en-US")} removed)`;

export const shapeHandler: JobHandler<ShapeParams, ShapeState, ShapeResult> = {
  kind: "shape",

  // Undo This Run put its table back: what it read is no longer what the table holds, so the record
  // forgets it, and its next run makes the table whole (`decide`).
  undone(params, table, memory) {
    if (table !== params.into) return;
    const saved = savedOf(memory.sql, params.into);
    if (saved?.read) {
      const { read: _read, ...rest } = saved;
      memory.sql.exec("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", shapeKey(params.into), JSON.stringify(rest));
    }
    memory.forgetReader(shapeKey(params.into));
  },

  // The SQL it made the table or view with: Undo This Run writes back the SQL of what it puts back,
  // so a program view made again at a later swap is the view put back.
  memoryKeys: (params) => [shapeKey(params.into)],

  parse(params) {
    if (!isRecord(params)) throw new JobParamsError("SHAPE takes the table to make and the SELECT that makes it.");
    const { into, sql, goal, sources } = params;
    // A name past 60 characters says so: a store's table names hold at most 60.
    const longName = typeof into === "string" && into.length > MAX_TABLE_NAME ? tableNameRefusal(into) : null;
    if (longName) throw new JobParamsError(longName);
    if (typeof into !== "string" || !INTO.test(into) || /__(?:v\d+|new)$/.test(into) || isReservedName(into)) {
      throw new JobParamsError(`"${String(into)}" cannot name a table: use lowercase words joined by underscores.`);
    }
    if (typeof sql !== "string" || sql.length > SQL_MAX) throw new JobParamsError("SHAPE takes one SELECT statement.");
    const select = oneSelect(sql);
    if (!select) throw new JobParamsError("SHAPE runs one SELECT statement and nothing else.");
    if (goal !== null && goal !== undefined && typeof goal !== "string") throw new JobParamsError("A SHAPE's goal is words.");
    const madeBy = madeByOf(params.madeBy);
    if (!madeBy) throw new JobParamsError("madeBy names the run and the step, or nothing.");
    if (params.as !== undefined && params.as !== "table" && params.as !== "view") throw new JobParamsError('A SHAPE makes a "table" or a "view".');
    if (params.whole !== undefined && typeof params.whole !== "boolean") throw new JobParamsError("whole is true or false.");
    let keep;
    try {
      keep = keepOf(params.keep);
    } catch (err) {
      throw new JobParamsError(err instanceof Error ? err.message : String(err));
    }
    return {
      into,
      sql: select,
      goal: typeof goal === "string" ? goal : null,
      sources: typeof sources === "string" ? sources : "[]",
      madeBy,
      ...(params.as === "view" ? { as: "view" as const } : {}),
      ...(params.whole ? { whole: true } : {}),
      ...(keep ? { keep } : {}),
    };
  },

  async run(ctx) {
    const { into, sql: select } = ctx.params;
    const sql = ctx.sql;
    // A state an older store saved (no phase) starts again; a whole run's `begin` drops a leftover
    // `<into>__new`.
    const resumed = isRecord(ctx.state) && "phase" in ctx.state;
    const state: ShapeState = resumed ? structuredClone(ctx.state as ShapeState) : start(ctx);
    // The state is saved as `write` leaves it, in the same transaction.
    const save = (write?: () => void, note = `Making ${into}`) =>
      ctx.commit({ state, progress: { done: state.counts.added + state.counts.changed + state.counts.removed, total: null, note } }, write);
    if (!resumed) save();

    // 1. Parked tables it reads come back first.
    while (state.phase === "bring") {
      const table = state.bring[0];
      if (!table) {
        state.phase = "make";
        save();
        break;
      }
      const step = await bringBackStep(ctx as unknown as JobContext<unknown, ShapeState>, table, state.bringing, (b) => ({ ...structuredClone(state), bringing: b }));
      if (!step.done) {
        state.bringing = step.state;
        return { more: true };
      }
      state.bring = state.bring.slice(1);
      state.bringing = null;
      state.broughtBack.push(table);
      save();
      if (ctx.now() >= ctx.deadline) return { more: true };
    }

    // 2. The table is made: whole, changed, unchanged, or a view.
    if (state.phase === "make") {
      // A parked driver read out of its files is checked as the run reads it: over rows it is given.
      const files = state.by === "parts" && state.driver ? parkedFiles(sql, state.driver) : null;
      const r = runnable(sql, select);
      if (state.mode !== "unchanged") guardSelect(sql, files ? shadowedByRows(r.select, state.driver!, files.columns, r.packed) : withPacked(r.select, r.packed), files ? ["[]", "[]"] : []);
      if ((await make(ctx, state, save)) === "more") return { more: true };
      state.phase = "end";
    }

    // 3. The SQL and what it read are kept; what it read is marked read (a view reads no changes:
    //    its marks go); its driver, a LOAD's table, is parked a while later.
    const result = state.result!;
    const record: SavedShape = {
      goal: ctx.params.goal,
      sql: select,
      sources: ctx.params.sources,
      version: result.version,
      madeAt: new Date(ctx.now()).toISOString(),
      madeBy: ctx.job.by,
      ...(state.mode === "view" ? { as: "view" as const } : {}),
      driver: state.driver,
      columns: state.columns ?? [],
      read: state.read,
    };
    const driver = state.driver;
    save(() => {
      sql.exec("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", shapeKey(into), JSON.stringify(record));
      if (state.mode === "view") ctx.tables.forgetReader(shapeKey(into));
      else for (const [source, change] of Object.entries(state.read)) ctx.tables.markRead(shapeKey(into), source, change);
      // A table an app on the store reads stays in the database: the app reads it there.
      if (driver && ctx.params.keep?.[driver.toLowerCase()]) ctx.tables.stayInDatabase(driver);
      else if (driver) ctx.tables.parkLater([driver]);
    }, `Made ${into}`);
    return { result: { ...result, ...(state.broughtBack.length ? { broughtBack: state.broughtBack } : {}) } };
  },
};

/** The job's first state: what it reads, and how it makes the table. */
function start(ctx: JobContext<ShapeParams, ShapeState>): ShapeState {
  const { into, sql: select } = ctx.params;
  const sql = ctx.sql;
  // A LOAD's table keeps its file's rows as they came, and a pull's its database's: a SHAPE never replaces either.
  const loaded = sql.exec<{ grp: string | null }>("SELECT grp FROM _tables WHERE lower(name) = lower(?) AND kind = 'program'", into).toArray()[0];
  if (loaded && (loaded.grp === LOADED_GROUP || loaded.grp === PULLED_GROUP)) {
    const from = loaded.grp === LOADED_GROUP ? "a LOAD read from the store's files" : "a pull read from a database";
    throw new StoreError(400, "bad_request", `${into} holds rows ${from}, which a SHAPE does not replace. Make the cleaned table under another name, such as ${into}_clean.`);
  }
  const r = runnable(sql, select);
  const reads = tablesRead(sql, r.select, into);
  if (ctx.params.as === "view") {
    const raw = reads.filter((t) => t.group === LOADED_GROUP).map((t) => t.name);
    if (raw.length) {
      throw new StoreError(
        400,
        "bad_request",
        `A view reads cleaned tables, and ${raw.join(", ")} ${raw.length === 1 ? "is a LOAD's table" : "are LOAD's tables"}, which the store parks once a SHAPE cleans ${raw.length === 1 ? "it" : "them"}. Make the view from the cleaned tables.`,
      );
    }
  }
  const read = Object.fromEntries(reads.map((t) => [t.name, lastChange(sql, t.name)]));
  const saved = savedOf(sql, into);
  const decided = decide(sql, ctx.params, saved, reads, read);
  const { mode, why } = decided;
  let by: ShapeState["by"] = decided.by;
  // A parked driver whose changed keys the store names stays parked: those rows are read out of its files.
  const driver = saved?.driver ?? null;
  if (mode === "changed" && by === "keys" && driver && saved?.columns && reads.find((t) => t.name === driver)?.parked) {
    const since = changedSince(sql, driver, saved.read?.[driver] ?? 0);
    const files = parkedFiles(sql, driver);
    // Its statements name every column of the files: past what a statement may hold, the driver
    // comes back instead.
    const fits = (cols: readonly ParkedColumn[]) => !tooLong(changeStatements(into, saved.columns!, shadowedByRows(r.select, driver, cols, r.packed), PARTS_SCOPE));
    if (since && since.keys <= PARTS_KEYS_MAX && files?.columns.some((c) => c.name === KEY_COLUMN) && fits(files.columns)) by = "parts";
  }
  const bring = mode === "unchanged" ? [] : reads.filter((t) => t.parked && !(by === "parts" && t.name === driver)).map((t) => t.name);
  const keeps = mode === "changed" || mode === "unchanged";
  return {
    phase: bring.length ? "bring" : "make",
    mode,
    by,
    why,
    read,
    driver: keeps ? (saved?.driver ?? null) : null,
    columns: keeps ? (saved?.columns ?? null) : null,
    bring,
    bringing: null,
    broughtBack: [],
    made: false,
    change: null,
    restorePoint: null,
    after: 0,
    last: 0,
    counts: { ...NO_COUNTS },
    result: null,
  };
}

/** One chunk of making the table. Answers "more" when the next chunk goes on. */
async function make(ctx: JobContext<ShapeParams, ShapeState>, state: ShapeState, save: (write?: () => void, note?: string) => void): Promise<"more" | "done"> {
  const { into } = ctx.params;
  const sql = ctx.sql;
  const current = (): { version: number; rows: number } => {
    const row = sql.exec<{ version: number; rows: number | null }>("SELECT version, rows FROM _tables WHERE name = ?", into).toArray()[0];
    return { version: Number(row?.version ?? 0), rows: Number(row?.rows ?? 0) };
  };
  const done = (made: CommittedTable, mode: ShapeMode) => {
    const d = made.delta;
    state.counts = d ? { added: d.added, changed: d.changed, removed: d.removed } : { ...NO_COUNTS };
    state.result = { table: into, version: made.version, rows: made.rows, mode, ...state.counts, ...(state.why ? { why: state.why } : {}) };
  };

  if (state.mode === "unchanged") {
    state.result = { table: into, ...current(), mode: "unchanged", ...NO_COUNTS };
    return "done";
  }

  if (state.mode === "view") {
    // A view reads cleaned tables, which hold none of a LOAD's packed columns: only its compounds are nested.
    const made = await ctx.tables.makeView(into, runnable(sql, ctx.params.sql).select, { group: READY_GROUP, madeBy: ctx.params.madeBy, comment: ctx.params.goal, keep: ctx.params.keep?.[into.toLowerCase()] });
    state.driver = null;
    state.columns = columnNames(sql, into);
    state.result = { table: into, version: made.version, rows: made.rows, mode: "view", ...NO_COUNTS };
    return "done";
  }

  if (state.mode === "changed" && state.driver && state.columns) {
    try {
      const outcome = state.by === "keys" ? await byKeys(ctx, state, done) : state.by === "parts" ? await byParts(ctx, state, save, done) : await byRanges(ctx, state, save, done);
      if (outcome === "done" || outcome === "more") return outcome;
      asWhole(state, outcome);
    } catch (err) {
      const why = rowByRowFailure(err);
      if (!why) throw err;
      asWhole(state, why);
    }
    // A change it left open reads as whole for good, and its keys go.
    state.change = null;
    delete state.scan;
    delete state.pending;
    save(() => abandonDeltas(sql, ctx.job.id));
    // The whole table reads every row: a parked table it reads comes back first.
    const parked = tablesRead(sql, runnable(sql, ctx.params.sql).select, into).filter((t) => t.parked).map((t) => t.name);
    if (parked.length) {
      state.phase = "bring";
      state.bring = parked;
      save();
      return "more";
    }
  }
  return whole(ctx, state, save);
}

/** The run falls back to the whole table, and says why. */
function asWhole(state: ShapeState, why: string): void {
  state.mode = "whole";
  state.by = null;
  state.why = why;
  state.driver = null;
  state.columns = null;
  state.counts = { ...NO_COUNTS };
}

/** The unique index on `_key` a change in place needs: the first such run makes it. */
function ensureKeyIndex(ctx: JobContext<ShapeParams, ShapeState>): void {
  const { into } = ctx.params;
  if (!keyedUnique(ctx.sql, into)) ctx.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(`${into}__key_${ctx.job.id.replace(/^job_/, "")}`)} ON ${quote(into)} (${quote(KEY_COLUMN)})`);
}

/** Only the driver changed, and the store names its changed keys: the SELECT runs over just those rows, in one transaction. */
async function byKeys(ctx: JobContext<ShapeParams, ShapeState>, state: ShapeState, done: (made: CommittedTable, mode: ShapeMode) => void): Promise<"done" | string> {
  const { into } = ctx.params;
  const sql = ctx.sql;
  const driver = state.driver!;
  const saved = savedOf(sql, into);
  const since = changedSince(sql, driver, saved?.read?.[driver] ?? 0);
  if (!since) return `the store no longer names ${driver}'s changed rows`;
  const r = runnable(sql, ctx.params.sql);
  const rows = shadowed(r.select, driver, `${quote(KEY_COLUMN)} IN (${since.keysSql})`, r.packed);
  const s = changeStatements(into, state.columns!, rows, since.keysSql);
  if (tooLong(s)) return "its SQL is too long to run row by row";
  refuseRepeatedKeys(sql, rows, since.params);
  const made = await ctx.tables.changed(into, { madeBy: ctx.params.madeBy, note: inPlaceNote }, () => {
    ensureKeyIndex(ctx);
    return runChange(sql, s, since.params);
  });
  done(made, "changed");
  return "done";
}

/** Writes the keys a run changed into its change's record: each full part of keys, or, with `all`, every one. */
function writeKeys(ctx: JobContext<ShapeParams, ShapeState>, change: number, pending: NonNullable<ShapeState["pending"]>, all: boolean): void {
  for (const kind of ["added", "changed", "removed"] as const) {
    const list = pending[kind];
    const n = all ? list.length : list.length - (list.length % KEYS_PER_PART);
    if (n <= 0) continue;
    ctx.tables.keys(ctx.params.into, change, { [kind]: list.slice(0, n) });
    pending[kind] = list.slice(n);
  }
}

/** Rows of a parked file, in runs of at most PARTS_BYTES bytes. */
function byBytes(rows: readonly { key: string; line: string }[]): { key: string; line: string }[][] {
  const out: { key: string; line: string }[][] = [];
  let run: { key: string; line: string }[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = utf8Length(row.line) + utf8Length(row.key) + 4;
    if (run.length && bytes + size > PARTS_BYTES) {
      out.push(run);
      run = [];
      bytes = 0;
    }
    run.push(row);
    bytes += size;
  }
  if (run.length) out.push(run);
  return out;
}

/**
 * The parked driver changed, and the store names its changed keys: the rows of those keys are read
 * out of its parked files a part at a time, and the SELECT runs over each part's rows (given to it
 * as JSON) with the driver's name shadowed by a CTE of them, writing only the rows that differ.
 * Nothing of the driver comes back into the database. The rows whose driver row is gone (keys the
 * store's memory of the driver no longer holds) go at the end. The change stays open (whole to a
 * reader) until every part is read.
 */
async function byParts(
  ctx: JobContext<ShapeParams, ShapeState>,
  state: ShapeState,
  save: (write?: () => void, note?: string) => void,
  done: (made: CommittedTable, mode: ShapeMode) => void,
): Promise<"done" | "more" | string> {
  const { into } = ctx.params;
  const sql = ctx.sql;
  const driver = state.driver!;
  const files = parkedFiles(sql, driver);
  if (!files) return `${driver} is no longer in the store's files`;
  const saved = savedOf(sql, into);
  const since = changedSince(sql, driver, saved?.read?.[driver] ?? 0);
  if (!since) return `the store no longer names ${driver}'s changed rows`;
  const at = files.columns.findIndex((c) => c.name === KEY_COLUMN);
  const r = runnable(sql, ctx.params.sql);
  const rows = shadowedByRows(r.select, driver, files.columns, r.packed);
  const s = changeStatements(into, state.columns!, rows, PARTS_SCOPE);
  if (tooLong(s)) return "its SQL is too long to run row by row";
  if (state.change === null) {
    // Its restore point is the moment before the change opens; the change and the index go in with
    // the state that names them.
    state.restorePoint = await ctx.tables.bookmark();
    save(() => {
      state.change = ctx.tables.openChange(into);
      state.scan = { files: files.id, part: 0, parts: files.parts };
      ensureKeyIndex(ctx);
    });
  }
  const change = state.change!;
  const scan = state.scan;
  if (!scan || scan.files !== files.id) return `${driver}'s files changed while it ran`;
  // The keys it reads the rows of, read again each chunk: as many as the store names.
  const wanted = new Set(sql.exec<{ k: StoreSqlValue }>(`SELECT k FROM (${since.keysSql})`, ...since.params).toArray().map((r) => String(r.k)));
  // A part holding none of those keys writes nothing: the place it read to is saved with the next
  // part that holds some, or before the chunk ends.
  let unsaved = false;
  while (scan.part < scan.parts && ctx.now() < ctx.deadline) {
    const lines = await readPart(ctx.bucket, files.prefix, scan.part);
    if (!lines) throw new StoreError(409, "conflict", `Part ${scan.part + 1} of ${driver}'s parked files is gone from the store's bucket.`);
    const found: { key: string; line: string }[] = [];
    for (const line of lines) {
      const key = (JSON.parse(line) as unknown[])[at];
      if (typeof key === "string" && wanted.has(key)) found.push({ key, line });
    }
    scan.part++;
    if (!found.length) {
      unsaved = true;
      continue;
    }
    unsaved = false;
    save(() => {
      const pending = (state.pending ??= { added: [], changed: [], removed: [] });
      for (const run of byBytes(found)) {
        const params = [`[${run.map((r) => r.line).join(",")}]`, JSON.stringify(run.map((r) => r.key))];
        refuseRepeatedKeys(sql, rows, params);
        const keys = runChange(sql, s, params);
        appendAll(pending.added, keys.added ?? []);
        appendAll(pending.changed, keys.changed ?? []);
        appendAll(pending.removed, keys.removed ?? []);
      }
      writeKeys(ctx, change, pending, false);
    });
  }
  if (scan.part < scan.parts) {
    if (unsaved) save();
    return "more";
  }
  // The rows whose driver row is gone, then the change is closed.
  let made: CommittedTable | null = null;
  save(() => {
    const k = quote(KEY_COLUMN);
    const pending = (state.pending ??= { added: [], changed: [], removed: [] });
    appendAll(pending.removed, keysOf(sql, `DELETE FROM ${quote(into)} WHERE ${k} IN (${since.keysSql}) AND ${k} NOT IN (SELECT k FROM _row_hashes WHERE tbl = ?4) RETURNING ${k} AS k`, [...since.params, driver]));
    writeKeys(ctx, change, pending, true);
    made = ctx.tables.close(into, change, { madeBy: ctx.params.madeBy, note: inPlaceNote, restorePoint: state.restorePoint });
  });
  done(made!, "changed");
  return "done";
}

/**
 * A table it reads changed besides the driver, or the store does not name the driver's changes:
 * the SELECT runs over the driver a range of rowids a statement, writing the rows that differ.
 * The change stays open (whole to a reader) until every range is in.
 */
async function byRanges(
  ctx: JobContext<ShapeParams, ShapeState>,
  state: ShapeState,
  save: (write?: () => void, note?: string) => void,
  done: (made: CommittedTable, mode: ShapeMode) => void,
): Promise<"done" | "more" | string> {
  const { into } = ctx.params;
  const sql = ctx.sql;
  const driver = state.driver!;
  const range = "rowid > ?1 AND rowid <= ?2";
  const r = runnable(sql, ctx.params.sql);
  const rows = shadowed(r.select, driver, range, r.packed);
  const s = changeStatements(into, state.columns!, rows, `SELECT ${quote(KEY_COLUMN)} FROM main.${quote(driver)} WHERE ${range}`);
  if (tooLong(s)) return "its SQL is too long to run row by row";
  if (state.change === null) {
    // Its restore point is the moment before the change opens; the change and the index go in with
    // the state that names them.
    state.restorePoint = await ctx.tables.bookmark();
    save(() => {
      state.change = ctx.tables.openChange(into);
      state.after = 0;
      state.last = Number(sql.exec<{ n: number | null }>(`SELECT max(rowid) AS n FROM ${quote(driver)}`).one().n ?? 0);
      ensureKeyIndex(ctx);
    });
  }
  const change = state.change!;
  while (state.after < state.last && ctx.now() < ctx.deadline) {
    const lo = state.after;
    const hi = Math.min(state.last, lo + RANGE_ROWS);
    refuseRepeatedKeys(sql, rows, [lo, hi]);
    state.after = hi;
    save(() => ctx.tables.keys(into, change, runChange(sql, s, [lo, hi])));
  }
  if (state.after < state.last) return "more";
  // The rows whose source row is gone, then the change is closed.
  let made: CommittedTable | null = null;
  save(() => {
    const k = quote(KEY_COLUMN);
    ctx.tables.keys(into, change, { removed: keysOf(sql, `DELETE FROM ${quote(into)} WHERE ${k} NOT IN (SELECT ${k} FROM main.${quote(driver)} WHERE ${k} IS NOT NULL) RETURNING ${k} AS k`, []) });
    made = ctx.tables.close(into, change, { madeBy: ctx.params.madeBy, note: inPlaceNote, restorePoint: state.restorePoint });
  });
  done(made!, "changed");
  return "done";
}

/**
 * Whole: CREATE TABLE … AS into `<into>__new` and the swap, which keeps the version before. The
 * driver, when its rows have one, is kept for later runs; the index they need waits for them.
 */
async function whole(ctx: JobContext<ShapeParams, ShapeState>, state: ShapeState, save: (write?: () => void, note?: string) => void): Promise<"done"> {
  const { into } = ctx.params;
  const sql = ctx.sql;
  const fresh = `${into}__new`;
  const { select, packed } = runnable(sql, ctx.params.sql);
  if (!state.made) {
    const begun = ctx.tables.begin(into);
    state.made = true;
    save(() => void sql.exec(`CREATE TABLE ${quote(begun)} AS ${withPacked(select, packed)}`));
  }
  if (tableExists(sql, fresh)) {
    const columns = columnNames(sql, fresh);
    state.driver = driverOf(sql, fresh, select, tablesRead(sql, select, into));
    state.columns = columns;
    const made = await ctx.tables.commit(into, { group: SHAPED_GROUP, madeBy: ctx.params.madeBy, columns: columns.map((c) => ({ name: c })), comment: ctx.params.goal, keep: ctx.params.keep?.[into.toLowerCase()] });
    state.result = { table: into, version: made.version, rows: made.rows, mode: "whole", added: made.rows, changed: 0, removed: 0, ...(state.why ? { why: state.why } : {}) };
  } else {
    // An earlier chunk swapped it in and stopped before it said so: its driver is read off it.
    const row = sql.exec<{ version: number; rows: number }>("SELECT version, rows FROM _tables WHERE name = ?", into).toArray()[0];
    if (!row) throw new Error(`The new version of ${into} is gone, and the store has no record of it.`);
    state.columns ??= columnNames(sql, into);
    state.driver ??= driverOf(sql, into, select, tablesRead(sql, select, into));
    state.result = { table: into, version: Number(row.version), rows: Number(row.rows), mode: "whole", added: Number(row.rows), changed: 0, removed: 0, ...(state.why ? { why: state.why } : {}) };
  }
  return "done";
}
