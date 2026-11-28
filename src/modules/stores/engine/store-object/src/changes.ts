// What a statement changed in a store, row by row (the data plan's B10): a Human Program's run keeps
// the rows its `exec` changed, each with its values before and after, so a run can be tried first
// and undone. The api asks for it in `exec`'s body (statements.ts `runExec`):
//
//   trial   `{ trial: { sql, params?, run?, step?, key? } }`: the statements run with the record
//           on, and their transaction is rolled back, so nothing in the store's tables changes.
//           The trial keeps its counts, its first CHANGE_SAMPLE_ROWS rows and a fingerprint of
//           every row it touched, as each was before (`_changes`, state `trial`), so a person can
//           see what the call would change. The trial's SQL is not at the top of the body: a store
//           older than this file refuses a body with no `sql`, where it would run the SQL for real.
//   record  `{ sql, params?, record: { run, step, key?, expect? } }`: the statements run and stay,
//           and the store keeps every row they inserted, updated or deleted (`_change_rows`), with
//           its values before and after. With `expect`, the rows the statements touch must be the
//           rows the call's newest trial touched, holding what they held then; otherwise nothing is
//           written (`change_moved`).
//   undo    `{ undo: <change id> }`: each row a kept change wrote goes back, newest first, only
//           while it still holds what the change left there; any other is held, and counted. A
//           table the change made goes, while it holds the rows the change left in it.
//
// How rows are caught: before a statement runs, every table it writes (read from its own program,
// as the guard reads it, sql.ts) gets three triggers of the store's own (`_chg_<change>_<n>_<op>`).
// They copy each row the statement inserts, updates or deletes into `_change_rows`, by rowid, with
// its values as JSON: a list of `json_object`s of the table's columns, CHANGE_PART_COLUMNS columns
// each (a function takes at most 127 arguments), a BLOB as `{"$blob": "<hex>"}`. The triggers are
// made inside the batch's transaction and dropped before it ends, so no other call ever sees them,
// and the guard leaves them (and only them) out of the schema it checks. A row is named by its
// rowid, read as `rowid`, or as `_rowid_` or `oid` where a column takes that name. While a batch
// that may REPLACE a row runs (its own SQL, a table's ON CONFLICT REPLACE, or a trigger of the
// store's), recursive_triggers is on, so a row that REPLACE removes is caught as deleted (SQLite
// fires no delete trigger for it otherwise); any other batch leaves it off, so a table's own
// trigger that writes its own table runs as it does outside a run. A table the batch makes is not
// caught: Undo drops it whole.
//
// What a recorded batch may not do (`change_unrecordable`, which the api answers by running the
// batch unrecorded once it was asked for): drop, rename or alter a table that was there before it
// (migrate does that; then change its rows here), write a virtual table or a table with no rowids,
// or touch a row too large to keep twice.
// A record of more than CHANGE_ROWS_KEPT_MAX rows keeps its counts only (`whole`): it cannot be
// undone row by row, and Restore to Here puts the store back. A trial goes after TRIAL_KEPT_MS, a
// kept change after CHANGE_KEPT_MS, the store's restore window. Neither table goes into an export.
//
// A run's steps keep their changes to the run's own tables here too (B10 part 2, program-tables.ts):
// a `_changes` row of kind 'table' (a statement's is 'rows'), with the job that made it and one
// table, whose `program` says how Undo puts it back: a new version swapped back for the version
// before (kept as `<name>__v<n>`), a table the run made dropped, or rows changed in place put back
// as a statement's are, by the same triggers (`catchRows`), and the columns the change added
// dropped. Its `meta` holds the step's settings as they were when its job started, which Undo
// writes back. `undoChange` takes `tableUndo` from program-tables.ts for the versions and what follows.

import { StoreError, type StoreCore } from "./core.js";
import { getMeta, setMeta } from "./schema.js";
import { firstWord, isReservedName, refuseOrphaningDrop, splitStatements, sqlTokens, type SqlLike, type SqlToken, type StoreSqlValue } from "./sql.js";
import type { ChangeSummary, ChangeTableCount } from "./types.js";

/** The rows a trial keeps, for a person to see what the call would change. */
export const CHANGE_SAMPLE_ROWS = 200;
/** The most rows a kept change keeps row by row; a larger one keeps its counts only. */
export const CHANGE_ROWS_KEPT_MAX = 500_000;
/** How long a trial's record stays. */
export const TRIAL_KEPT_MS = 24 * 60 * 60_000;
/** How long a kept change's record stays: the store's restore window. */
export const CHANGE_KEPT_MS = 30 * 24 * 60 * 60_000;
/** Columns in one `json_object` of a row's values: two arguments each, under SQLite's 127. */
export const CHANGE_PART_COLUMNS = 50;
/** The store's own triggers that catch a batch's rows start with this. */
export const CAPTURE_PREFIX = "_chg_";
/** The table the capture's triggers write, which the guard lets them write (and no statement of the batch's own). */
export const CAPTURE_TABLES: ReadonlySet<string> = new Set(["_change_rows"]);
/** Old changes a recorded call clears at most, so one call never spends long on another's record. */
const PRUNE_EACH_CALL = 3;
/** Rows an undo reads at a time, newest first. */
const UNDO_PAGE = 1_000;

/** What `_changes.tables` keeps of each table a change wrote. */
export interface ChangeTableRecord {
  name: string;
  /** The table's columns when the change caught its rows, in order: a row's values follow them. */
  columns: string[];
  inserted: number;
  updated: number;
  deleted: number;
  /** The change made the table; `rows` is what it held when the change ended. */
  made: boolean;
  rows?: number;
  /** A run's change to a program table (B10 part 2): what Undo needs beyond the rows. */
  program?: ProgramTableBefore;
}

/**
 * What a run's change to one of its own tables (a LOAD's, a SHAPE's, a cleanup step's) keeps so
 * Undo This Run can put the table back (program-tables.ts). A new version keeps the version before
 * as a table of its own; a change in place keeps its rows, as a store_exec does. The change's
 * `_changes` row is of kind 'table' and names the job that made it.
 */
export interface ProgramTableBefore {
  /** `version`: the version before is swapped back in; `made`: the run made the table, which goes; `rows`: each row it changed in place goes back. */
  how: "version" | "made" | "rows";
  /** The version before, kept as a table of its own (`<name>__v<n>`); null when it was a view or parked, or for `rows`. */
  kept: string | null;
  /** The table's row of `_tables` and its rows of `_columns` before the change; `row` is null for a table the run made. */
  row: Record<string, StoreSqlValue> | null;
  columns: Record<string, StoreSqlValue>[];
  /** The view it was before, as SQLite keeps it (`CREATE VIEW …`). */
  view: string | null;
  /** Its version and rows before (null for none) and once the change ended: Undo puts a version back only while the table holds the change's. */
  versionBefore: number | null;
  versionAfter: number;
  rowsBefore: number | null;
  rowsAfter: number;
  /** `rows`: the change spans the job's commits and is still open; `delta` is the change of the table's deltas it records. */
  open?: true;
  delta?: number;
  /** `rows`: its rows were not caught (a parked table's, or rows written outside the job's commits): its counts only. */
  uncaught?: true;
  /** `rows`: the table's columns once the change ended. Those past `columns` the change added: Undo drops them. */
  columnsAfter?: string[];
  /** `rows`: rows the change wrote only in the columns it added, which no row of the record keeps (Undo drops the columns). */
  filled?: number;
  /**
   * The settings the step that made the change keeps in `_meta` between runs (`JobHandler.memoryKeys`),
   * as they were when its job started, by key; null for a key that held none. Undo writes them back
   * with the table.
   */
  meta?: Record<string, string | null>;
}

/** What a batch's capture hands the guard (statements.ts `runGuarded`). */
export interface CaptureGuard {
  /** The tables the capture's triggers write: the guard lets them through for a statement whose own text never names them. */
  readonly own: ReadonlySet<string>;
  /** The capture's own objects, which the guard leaves out of the schema it checks. */
  hides(name: string): boolean;
  /** Called with the tables a statement writes, before it runs: each gets the triggers that catch its rows. */
  before(tables: readonly string[]): void;
}

/** A batch's capture: the guard's hook, and what it caught. */
export interface ChangeCapture {
  readonly id: number;
  readonly guard: CaptureGuard;
  /** The tables caught, with their columns, in the order they were first written. */
  readonly tables: Map<string, string[]>;
  /** The tables there before the batch, by lowercased name, with their definitions. */
  readonly existing: ReadonlyMap<string, { name: string; sql: string | null }>;
  /** Drops the triggers. Called before the batch's transaction ends. */
  dropTriggers(): void;
  /** Puts recursive_triggers back. Called whatever happened. */
  close(): void;
}

/** A name as SQL takes it whatever it holds. */
const bt = (name: string): string => `\`${name.replace(/`/g, "``")}\``;
/** Text as an SQL literal. */
const lit = (text: string): string => `'${text.replace(/'/g, "''")}'`;
const lower = (name: string): string => name.toLowerCase();

/** A batch whose change no record could keep: the api then runs it unrecorded, as it asked (run-changes.ts). */
const unrecordable = (message: string): StoreError => new StoreError(400, "change_unrecordable", message);

/** The name that reads a table's rowid: `rowid`, or `_rowid_` or `oid` where a column takes that name; null when all three are columns. */
export function rowidOf(columns: readonly string[]): string | null {
  const taken = new Set(columns.map(lower));
  return ["rowid", "_rowid_", "oid"].find((name) => !taken.has(name)) ?? null;
}

/** The `_meta` key of the last change number taken. */
const CHANGE_SEQ_KEY = "change_seq";

/**
 * Takes the next change's number. A number is never taken twice, a pruned change's included: a run
 * names its changes by number, and an Undo must never reach a change another run made later.
 */
export function takeChangeId(sql: SqlLike): number {
  const kept = Number(sql.exec<{ n: number | null }>("SELECT max(id) AS n FROM _changes").one().n ?? 0);
  const taken = Number(getMeta(sql, CHANGE_SEQ_KEY) ?? 0);
  const id = Math.max(kept, Number.isSafeInteger(taken) ? taken : 0) + 1;
  setMeta(sql, CHANGE_SEQ_KEY, String(id));
  return id;
}

/** A table's columns, in order, generated columns left out (they are worked out, never written). */
function columnsOf(sql: SqlLike, table: string): string[] {
  return sql.exec<{ name: string }>(`PRAGMA table_info(${bt(table)})`).toArray().map((r) => String(r.name));
}

/** A row's values as the record keeps them: a JSON list of objects of CHANGE_PART_COLUMNS columns. */
export function valuesSql(ref: string, columns: readonly string[]): string {
  const parts: string[] = [];
  for (let at = 0; at < columns.length; at += CHANGE_PART_COLUMNS) {
    const pairs = columns.slice(at, at + CHANGE_PART_COLUMNS).map((c) => {
      const v = `${ref}${bt(c)}`;
      return `${lit(c)}, CASE WHEN typeof(${v}) = 'blob' THEN json_object('$blob', hex(${v})) ELSE ${v} END`;
    });
    parts.push(`json_object(${pairs.join(", ")})`);
  }
  return `json_array(${parts.join(", ")})`;
}

/** The JSON path of a column's value in a row's values (`valuesSql`). */
function pathOf(columns: readonly string[], column: string): string {
  const at = columns.indexOf(column);
  return `$[${Math.floor(at / CHANGE_PART_COLUMNS)}].${JSON.stringify(column)}`;
}

/**
 * Starts catching the rows a batch changes, as change `id`. Call `close` whatever happens, and
 * `dropTriggers` before the batch's transaction commits.
 */
export function beginCapture(core: StoreCore, id: number, opts: { replaces?: boolean } = {}): ChangeCapture {
  const sql = core.sql;
  const tables = new Map<string, string[]>();
  const triggers: string[] = [];
  // The capture's own triggers, which alone the guard leaves out: a statement's own `_chg_…` object is checked as any other.
  const own = new Set<string>();
  // The tables there before the batch: a table it makes is no row it changed, and one it drops or alters is refused (`refuseReshaped`).
  const existing = new Map<string, { name: string; sql: string | null }>();
  for (const row of sql.exec<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table'").toArray()) {
    existing.set(lower(String(row.name)), { name: String(row.name), sql: row.sql === null ? null : String(row.sql) });
  }
  // Only a batch that may REPLACE a row turns recursive triggers on (`replacesRows`): then the row it
  // replaces fires the capture's delete trigger. Left off otherwise, so a table's own trigger that
  // updates its own table runs as it does outside a run.
  if (opts.replaces) sql.exec("PRAGMA recursive_triggers = ON");
  const guard: CaptureGuard = {
    own: CAPTURE_TABLES,
    hides: (name) => own.has(lower(name)),
    before(written) {
      for (const name of written) {
        const key = lower(name);
        // SQLite's own tables (AUTOINCREMENT's sequence) move with the rows; they take no trigger.
        if (key.startsWith("sqlite_")) continue;
        if (CAPTURE_TABLES.has(key) || [...tables.keys()].some((t) => lower(t) === key)) continue;
        // A table the batch made goes whole on Undo, so its rows are not caught.
        const was = existing.get(key);
        if (!was) continue;
        const table = was.name;
        if (/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(String(was.sql ?? ""))) {
          throw unrecordable(`${table} is a virtual table, whose rows a run's change cannot keep. Change it outside a Human Program's run.`);
        }
        const listed = sql.exec<{ wr: number }>(`PRAGMA table_list(${bt(table)})`).toArray()[0];
        if (listed && Number(listed.wr) === 1) {
          throw unrecordable(`${table} has no rowids, so a run's change cannot name its rows to put them back. Give it an INTEGER PRIMARY KEY, or change it outside a Human Program's run.`);
        }
        const columns = columnsOf(sql, table);
        const rowid = rowidOf(columns);
        if (!rowid) {
          throw unrecordable(`${table} has columns named rowid, _rowid_ and oid, so a run's change cannot name its rows to put them back. Change it outside a Human Program's run.`);
        }
        const n = tables.size;
        tables.set(table, columns);
        for (const trigger of catchRows(sql, id, n, table, columns, rowid)) {
          triggers.push(trigger);
          own.add(lower(trigger));
        }
      }
    },
  };
  return {
    id,
    guard,
    tables,
    existing,
    dropTriggers() {
      for (const trigger of triggers.splice(0)) sql.exec(`DROP TRIGGER IF EXISTS ${bt(trigger)}`);
    },
    close() {
      if (opts.replaces) sql.exec("PRAGMA recursive_triggers = OFF");
    },
  };
}

/**
 * Makes the store's three triggers that copy each row a statement inserts, updates or deletes in
 * `table` into `_change_rows`, as change `id`'s (the `n`-th table it catches), with the values of
 * `columns`, by `rowid`. Answers their names, for the caller to drop before its transaction ends.
 * With `updateOf`, an UPDATE is caught only when it sets one of `columns`: a step's UPDATE of a
 * column its change added (a CLASSIFY's new column) is no row to keep, since Undo drops the column.
 */
export function catchRows(sql: SqlLike, id: number, n: number, table: string, columns: readonly string[], rowid: string, opts: { updateOf?: boolean } = {}): string[] {
  const label = lit(table);
  const seq = `(SELECT coalesce(max(seq), 0) + 1 FROM _change_rows WHERE change = ${id})`;
  const insert = (op: string, ridBefore: string, ridAfter: string, before: string, after: string) =>
    `INSERT INTO _change_rows (change, seq, tbl, op, rid_before, rid_after, before, after) VALUES (${id}, ${seq}, ${label}, '${op}', ${ridBefore}, ${ridAfter}, ${before}, ${after})`;
  const bodies = [
    [`${CAPTURE_PREFIX}${id}_${n}_i`, `AFTER INSERT ON ${bt(table)} BEGIN ${insert("insert", "NULL", `NEW.${rowid}`, "NULL", valuesSql("NEW.", columns))}; END`],
    [
      `${CAPTURE_PREFIX}${id}_${n}_u`,
      `AFTER UPDATE${opts.updateOf && columns.length ? ` OF ${columns.map(bt).join(", ")}` : ""} ON ${bt(table)} BEGIN ${insert("update", `OLD.${rowid}`, `NEW.${rowid}`, valuesSql("OLD.", columns), valuesSql("NEW.", columns))}; END`,
    ],
    [`${CAPTURE_PREFIX}${id}_${n}_d`, `AFTER DELETE ON ${bt(table)} BEGIN ${insert("delete", `OLD.${rowid}`, "NULL", valuesSql("OLD.", columns), "NULL")}; END`],
  ] as const;
  const made: string[] = [];
  for (const [trigger, body] of bodies) {
    try {
      sql.exec(`CREATE TRIGGER ${bt(trigger)} ${body}`);
    } catch (error) {
      for (const t of made) sql.exec(`DROP TRIGGER IF EXISTS ${bt(t)}`);
      const why = error instanceof Error ? error.message.replace(/: SQLITE_\w+$/, "") : String(error);
      throw unrecordable(`A run's change cannot keep the rows of ${table}: ${why}.`);
    }
    made.push(trigger);
  }
  return made;
}

/** Drops triggers `catchRows` made. */
export function dropCatch(sql: SqlLike, triggers: readonly string[]): void {
  for (const trigger of triggers) sql.exec(`DROP TRIGGER IF EXISTS ${bt(trigger)}`);
}

/**
 * Whether a batch may replace a row, so its capture needs recursive triggers: its own INSERT OR
 * REPLACE, REPLACE INTO or UPDATE OR REPLACE (never the replace() function), a table's ON CONFLICT
 * REPLACE, or a trigger of the store's that replaces.
 */
export function replacesRows(sql: SqlLike, statements: readonly string[]): boolean {
  const replaces = (text: string): boolean => /\bOR\s+REPLACE\b/i.test(text) || /(?:;|\bBEGIN)\s*REPLACE\b/i.test(text);
  if (statements.some((statement) => replaces(statement) || firstWord(statement) === "REPLACE")) return true;
  const schema = sql.exec<{ type: string; sql: string | null }>("SELECT type, sql FROM sqlite_master WHERE type IN ('table', 'trigger') AND sql IS NOT NULL").toArray();
  return schema.some((row) => (row.type === "table" ? /\bON\s+CONFLICT\s+REPLACE\b/i.test(String(row.sql)) : replaces(String(row.sql))));
}

/** SQLite's refusals that come from catching a batch's rows, as `change_unrecordable`; null for any other. */
export function unkeptError(error: unknown, replaces: boolean): StoreError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/string or blob too big/i.test(message)) return unrecordable("A row this change touches is too large for a run to keep its values before and after.");
  if (replaces && /too many levels of trigger recursion/i.test(message)) {
    return unrecordable("This change replaces rows of a table whose own trigger writes it again, so a run cannot catch the rows it replaces.");
  }
  return null;
}

/** A keyword token, upper-cased; "" for a quoted name, punctuation or nothing. */
const keyword = (t: SqlToken | undefined): string => (t && t.kind === "name" && !t.quoted ? t.text.toUpperCase() : "");

/** The table a statement inserts into, updates or deletes from, past its WITH clause; null for any other statement. */
export function targetOf(statement: string): string | null {
  const tokens = sqlTokens(statement);
  let depth = 0;
  let at = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct") {
      if (t.text === "(") depth++;
      else if (t.text === ")") depth--;
      continue;
    }
    if (depth === 0 && ["INSERT", "REPLACE", "UPDATE", "DELETE"].includes(keyword(t))) {
      at = i;
      break;
    }
    // Only a WITH clause comes before the verb.
    if (i === 0 && keyword(t) !== "WITH") return null;
  }
  if (at < 0) return null;
  const verb = keyword(tokens[at]);
  let i = at + 1;
  if (keyword(tokens[i]) === "OR") i += 2;
  if ((verb === "INSERT" || verb === "REPLACE") && keyword(tokens[i]) === "INTO") i++;
  if (verb === "DELETE" && keyword(tokens[i]) === "FROM") i++;
  const first = tokens[i];
  if (!first || first.kind !== "name") return null;
  return tokens[i + 1]?.text === "." && tokens[i + 2]?.kind === "name" ? tokens[i + 2]!.text : first.text;
}

/**
 * Refuses, before anything runs, a statement a recorded batch may not hold: one that drops or
 * alters a table, or writes a virtual table, whose rows no record could put back. Comments are
 * read past; `refuseReshaped` checks the tables again once the batch ran, however it was written.
 */
export function refuseUnrecordable(sql: SqlLike, statements: readonly string[]): void {
  for (const statement of statements) {
    const tokens = sqlTokens(statement);
    if (keyword(tokens[0]) === "ALTER" || (keyword(tokens[0]) === "DROP" && keyword(tokens[1]) === "TABLE")) {
      throw unrecordable("A run's change keeps the rows it changes, and this statement drops or alters a table. Do that with a migration (store_migrate), then change the table's rows here.");
    }
    const target = targetOf(statement);
    if (target === null) continue;
    const row = sql.exec<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)", target).toArray()[0];
    if (row && /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(String(row.sql ?? ""))) {
      throw unrecordable(`${row.name} is a virtual table, whose rows a run's change cannot keep. Change it outside a Human Program's run.`);
    }
  }
}

/**
 * Refuses a batch that dropped, renamed or altered a table that was there before it: Undo could not
 * put that table's rows back. Inside the batch's transaction, so the refusal rolls the batch back.
 */
export function refuseReshaped(sql: SqlLike, capture: ChangeCapture): void {
  const now = new Map<string, string | null>();
  for (const row of sql.exec<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table'").toArray()) {
    now.set(lower(String(row.name)), row.sql === null ? null : String(row.sql));
  }
  for (const [key, was] of capture.existing) {
    if (isReservedName(key)) continue;
    if (!now.has(key)) throw unrecordable(`This change drops or renames ${was.name}, whose rows a run's change cannot put back. Do that with a migration (store_migrate), or outside a Human Program's run.`);
    if (now.get(key) !== was.sql) throw unrecordable(`This change alters ${was.name}, whose rows a run's change could then not put back. Alter it with a migration (store_migrate), then change its rows here.`);
  }
}

/** What a capture caught, once its batch ran: counts by table, the rows, and its fingerprint. */
export interface Caught {
  tables: ChangeTableRecord[];
  /** Rows changed in tables that were there before the batch. */
  rows: number;
  /** Rows the triggers wrote, an unchanged UPDATE's included: `exec`'s own count leaves them out. */
  written: number;
  fingerprint: string;
}

/**
 * Settles what change `id` caught: drops the rows an UPDATE left as they were, counts the rest by
 * table, adds the tables the batch made, and works out the change's fingerprint. Inside the batch's
 * transaction, after `dropTriggers`.
 */
export function settleCapture(sql: SqlLike, capture: ChangeCapture, made: readonly string[]): Caught {
  const id = capture.id;
  const written = Number(sql.exec<{ n: number }>("SELECT count(*) AS n FROM _change_rows WHERE change = ?", id).one().n);
  // A table's own trigger that writes the row again (an `updated_at`) leaves it caught twice: once.
  mergeRewrites(sql, id);
  sql.exec("DELETE FROM _change_rows WHERE change = ? AND op = 'update' AND before IS after AND rid_before IS rid_after", id);
  const counts = new Map<string, { inserted: number; updated: number; deleted: number }>();
  for (const row of sql.exec<{ tbl: string; op: string; n: number }>("SELECT tbl, op, count(*) AS n FROM _change_rows WHERE change = ? GROUP BY tbl, op", id)) {
    const c = counts.get(String(row.tbl)) ?? { inserted: 0, updated: 0, deleted: 0 };
    const n = Number(row.n);
    if (row.op === "insert") c.inserted += n;
    else if (row.op === "update") c.updated += n;
    else c.deleted += n;
    counts.set(String(row.tbl), c);
  }
  const madeKeys = new Set(made.map(lower));
  const tables: ChangeTableRecord[] = [];
  let rows = 0;
  for (const [name, columns] of capture.tables) {
    if (madeKeys.has(lower(name))) continue;
    const c = counts.get(name) ?? { inserted: 0, updated: 0, deleted: 0 };
    rows += c.inserted + c.updated + c.deleted;
    tables.push({ name, columns, ...c, made: false });
  }
  for (const name of made) {
    const exists = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
    if (!exists) continue;
    const held = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${bt(name)}`).one().n);
    tables.push({ name, columns: columnsOf(sql, name), inserted: held, updated: 0, deleted: 0, made: true, rows: held });
  }
  return { tables, rows, written, fingerprint: fingerprintOf(sql, id) };
}

/**
 * Keeps each row a batch wrote more than once as one row of the record: a table's own trigger that
 * writes the row again (an `updated_at` trigger), or two statements of the batch. The values before
 * its first write and after its last stand; a row the batch inserted and then deleted is no change.
 * Rows that do not follow one from another (a rowid that moved, values that do not chain) stay as
 * they were caught. Inside the batch's transaction, after the triggers are dropped, before the counts.
 */
export function mergeRewrites(sql: SqlLike, id: number): void {
  // Each row of the record by the row of its table it leaves: one written twice is named twice.
  const groups = sql
    .exec<{ seqs: string }>(
      `SELECT group_concat(seq) AS seqs FROM (
         SELECT seq, tbl, coalesce(rid_after, rid_before) AS rid FROM _change_rows
         WHERE change = ? AND (rid_before IS NULL OR rid_after IS NULL OR rid_before = rid_after) ORDER BY seq
       ) GROUP BY tbl, rid HAVING count(*) > 1`,
      id,
    )
    .toArray()
    .map((g) => String(g.seqs).split(",").map(Number));
  for (const seqs of groups) {
    const rows = seqs
      .sort((a, b) => a - b)
      .map((seq) => sql.exec<ChangeRowRecord & Record<string, StoreSqlValue>>("SELECT seq, tbl, op, rid_before, rid_after, before, after FROM _change_rows WHERE change = ? AND seq = ?", id, seq).toArray()[0] as unknown as ChangeRowRecord | undefined)
      .filter((r): r is ChangeRowRecord => !!r);
    // In the order the rows were written: each takes the row as the one before it left it.
    const chain = chained(rows) ?? chained([...rows].reverse());
    if (!chain) continue;
    const first = chain[0]!;
    const last = chain[chain.length - 1]!;
    const before = first.op === "insert" ? null : first.before;
    const after = last.op === "delete" ? null : last.after;
    for (const r of chain) if (r !== first) sql.exec("DELETE FROM _change_rows WHERE change = ? AND seq = ?", id, r.seq);
    if (before === null && after === null) {
      sql.exec("DELETE FROM _change_rows WHERE change = ? AND seq = ?", id, first.seq);
      continue;
    }
    const rid = first.rid_before ?? first.rid_after;
    sql.exec(
      "UPDATE _change_rows SET op = ?, rid_before = ?, rid_after = ?, before = ?, after = ? WHERE change = ? AND seq = ?",
      before === null ? "insert" : after === null ? "delete" : "update",
      before === null ? null : rid,
      after === null ? null : rid,
      before,
      after,
      id,
      first.seq,
    );
  }
}

/** The rows as one chain of writes to one row: each takes the row as the one before left it; null when they do not. */
function chained(rows: readonly ChangeRowRecord[]): ChangeRowRecord[] | null {
  for (let i = 1; i < rows.length; i++) {
    const was = rows[i - 1]!;
    const now = rows[i]!;
    // A deleted row comes back by an insert of its rowid (REPLACE); any other write takes the values the last one left.
    const follows = was.op === "delete" ? now.op === "insert" : now.op !== "insert" && now.before === was.after;
    if (!follows) return null;
  }
  return [...rows];
}

/**
 * A fingerprint of the rows a change touched as each was before: which table, how, which row and
 * what it held. A trial and the call it allows match when the data they read has not moved, though
 * what the statements write (a time, a random value) may differ between the two.
 */
function fingerprintOf(sql: SqlLike, id: number): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let n = 0;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
  };
  // Every statement is read to its end (export.ts says why).
  for (const row of sql.exec<{ tbl: string; op: string; rid_before: number | null; before: string | null }>("SELECT tbl, op, rid_before, before FROM _change_rows WHERE change = ? ORDER BY seq", id)) {
    feed(`${row.tbl}\u0001${row.op}\u0001${row.rid_before ?? ""}\u0001${row.before ?? ""}\u0002`);
    n++;
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${n}:${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

/** The first rows of change `id`, as the record keeps them, to keep with its trial. */
export function sampleRows(sql: SqlLike, id: number, limit = CHANGE_SAMPLE_ROWS): Record<string, StoreSqlValue>[] {
  return sql.exec("SELECT seq, tbl, op, rid_before, rid_after, before, after FROM _change_rows WHERE change = ? ORDER BY seq LIMIT ?", id, limit).toArray();
}

/** Who and what a recorded change is for. */
export interface ChangeFor {
  run: string | null;
  step: string | null;
  key: string | null;
  by: string;
}

/** Keeps a trial: its counts and fingerprint, and the rows it caught first. After its batch rolled back. */
export function keepTrial(core: StoreCore, id: number, who: ChangeFor, caught: Caught, sample: readonly Record<string, StoreSqlValue>[]): ChangeSummary {
  const sql = core.sql;
  sql.exec(
    "INSERT INTO _changes (id, state, kind, run, step, request_key, by_sub, made_at, rows, whole, tables, fingerprint) VALUES (?, 'trial', 'rows', ?, ?, ?, ?, ?, ?, 0, ?, ?)",
    id,
    who.run,
    who.step,
    who.key,
    who.by,
    core.nowIso(),
    caught.rows,
    JSON.stringify(caught.tables),
    caught.fingerprint,
  );
  for (const row of sample) {
    sql.exec(
      "INSERT INTO _change_rows (change, seq, tbl, op, rid_before, rid_after, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      row.seq,
      row.tbl,
      row.op,
      row.rid_before,
      row.rid_after,
      row.before,
      row.after,
    );
  }
  return summaryOf({ id, state: "trial", rows: caught.rows, whole: 0, tables: JSON.stringify(caught.tables), restored: null, held: null, fingerprint: caught.fingerprint });
}

/** Opens change `id`'s record before its batch runs, so its rows have a change to belong to. */
export function openRecord(core: StoreCore, id: number, who: ChangeFor): void {
  core.sql.exec(
    "INSERT INTO _changes (id, state, kind, run, step, request_key, by_sub, made_at, rows, whole, tables) VALUES (?, 'kept', 'rows', ?, ?, ?, ?, ?, 0, 0, '[]')",
    id,
    who.run,
    who.step,
    who.key,
    who.by,
    core.nowIso(),
  );
}

/**
 * Refuses a recorded change that is not what the call's newest trial showed: other rows, or rows
 * that hold something else now. `expect` names the trial by the call's request key, or else by its
 * run and step.
 */
export function refuseMoved(sql: SqlLike, who: ChangeFor, caught: Caught): void {
  const trial = who.key
    ? sql.exec<{ fingerprint: string | null }>("SELECT fingerprint FROM _changes WHERE state = 'trial' AND request_key = ? ORDER BY id DESC LIMIT 1", who.key).toArray()[0]
    : sql.exec<{ fingerprint: string | null }>("SELECT fingerprint FROM _changes WHERE state = 'trial' AND run IS ? AND step IS ? ORDER BY id DESC LIMIT 1", who.run, who.step).toArray()[0];
  if (!trial) throw new StoreError(409, "change_moved", "This change has no trial to match: try it again first.");
  if (trial.fingerprint !== caught.fingerprint) {
    throw new StoreError(409, "change_moved", "The rows this change touches are not what its trial showed: someone changed them since. Try it again to see what it would change now.");
  }
}

/** Closes change `id`'s record once its batch ran: its counts, and its rows, or counts only past the most kept. */
export function closeRecord(core: StoreCore, id: number, caught: Caught, restorePoint: string | null, by: string): ChangeSummary {
  const sql = core.sql;
  const whole = caught.rows > CHANGE_ROWS_KEPT_MAX ? 1 : 0;
  if (whole) sql.exec("DELETE FROM _change_rows WHERE change = ?", id);
  sql.exec("UPDATE _changes SET rows = ?, whole = ?, tables = ?, fingerprint = ? WHERE id = ?", caught.rows, whole, JSON.stringify(caught.tables), caught.fingerprint, id);
  const changed = caught.tables.filter((t) => t.made || t.inserted + t.updated + t.deleted > 0);
  if (changed.length) core.history({ kind: "table", by, note: changeNote(changed), restorePoint, ref: `change:${id}` });
  return summaryOf({ id, state: "kept", rows: caught.rows, whole, tables: JSON.stringify(caught.tables), restored: null, held: null, fingerprint: caught.fingerprint });
}

// ── A run's change to a program table (B10 part 2) ─────────────────────────────
//
// A run's steps change their own tables through program-tables.ts, and each change is kept under
// the run, of kind 'table', with the job that made it: a new version or a table the run made
// (closed at once: the version before is kept as a table of its own), or rows changed in place
// (open while the job's commits write them, each commit's rows caught by `catchRows`, closed by the
// step's `changed` or `close`, or when the job ends).

/** Who a program table's change is for: its run and step, the job that makes it, and whose job it is. */
export interface TableChangeFor {
  run: string;
  step: string | null;
  job: string;
  by: string;
}

/** A program table's change as its record keeps it: one table, with what Undo needs. */
export type TableChangeRecord = ChangeTableRecord & { program: ProgramTableBefore };

/** A program table's change from its `_changes` row's `tables`, or null for any other. */
function tableRecordOf(text: string): TableChangeRecord | null {
  try {
    const t = (JSON.parse(text) as ChangeTableRecord[])[0];
    return t?.program ? (t as TableChangeRecord) : null;
  } catch {
    return null;
  }
}

/** Change `id`'s record, when it is a run's change to a program table. */
export function tableChangeOf(sql: SqlLike, id: number): TableChangeRecord | null {
  const row = sql.exec<{ tables: string }>("SELECT tables FROM _changes WHERE id = ? AND kind = 'table'", id).toArray()[0];
  return row ? tableRecordOf(String(row.tables)) : null;
}

/** Keeps a run's change to a program table under its run: closed, or open while its rows are written (`open`). Answers its number. */
export function keepTableChange(core: StoreCore, who: TableChangeFor, table: TableChangeRecord): number {
  const id = takeChangeId(core.sql);
  const rows = table.program.open ? 0 : table.inserted + table.updated + table.deleted;
  core.sql.exec(
    "INSERT INTO _changes (id, state, kind, job, run, step, request_key, by_sub, made_at, rows, whole, tables) VALUES (?, 'kept', 'table', ?, ?, ?, NULL, ?, ?, ?, 0, ?)",
    id,
    who.job,
    who.run,
    who.step,
    who.by,
    core.nowIso(),
    rows,
    JSON.stringify([table]),
  );
  return id;
}

/** A job's changes to program tables that are still open, oldest first. */
export function openTableChanges(sql: SqlLike, job: string): { id: number; table: TableChangeRecord }[] {
  const out: { id: number; table: TableChangeRecord }[] = [];
  for (const row of sql
    .exec<{ id: number; tables: string }>("SELECT id, tables FROM _changes WHERE job = ? AND kind = 'table' AND state = 'kept' AND json_extract(tables, '$[0].program.open') = 1 ORDER BY id", job)
    .toArray()) {
    const table = tableRecordOf(String(row.tables));
    if (table) out.push({ id: Number(row.id), table });
  }
  return out;
}

/** Writes a program table's changed record back to its `_changes` row. */
export function saveTableChange(sql: SqlLike, id: number, table: TableChangeRecord): void {
  sql.exec("UPDATE _changes SET tables = ? WHERE id = ?", JSON.stringify([table]), id);
}

/** The greatest `seq` change `id` holds: a commit's caught rows are what it moved by. */
export function lastSeq(sql: SqlLike, id: number): number {
  return Number(sql.exec<{ n: number | null }>("SELECT max(seq) AS n FROM _change_rows WHERE change = ?", id).one().n ?? 0);
}

/**
 * Closes a run's open change to a program table, inside the transaction that ends it: a row written
 * more than once is kept once, an UPDATE that left a row as it was goes, and the rest are counted.
 * Rows the change wrote only in the columns it added are counted and not kept: Undo drops those
 * columns. A change whose rows were not caught keeps `counts` (its delta's) and no rows. Answers the
 * record, or null when it changed nothing, and then it goes.
 */
export function closeTableChange(sql: SqlLike, id: number, counts: { added: number; changed: number; removed: number } | null): TableChangeRecord | null {
  const t = tableChangeOf(sql, id);
  if (!t) return null;
  const p = t.program;
  const inDatabase = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t.name).toArray().length > 0;
  const columnsAfter = inDatabase ? columnsOf(sql, t.name) : [...t.columns];
  const added = p.uncaught ? [] : columnsAfter.filter((c) => !t.columns.includes(c));
  let caught = 0;
  let filled = 0;
  if (p.uncaught) {
    sql.exec("DELETE FROM _change_rows WHERE change = ?", id);
    t.inserted = counts?.added ?? 0;
    t.updated = counts?.changed ?? 0;
    t.deleted = counts?.removed ?? 0;
  } else {
    mergeRewrites(sql, id);
    sql.exec("DELETE FROM _change_rows WHERE change = ? AND op = 'update' AND before IS after AND rid_before IS rid_after", id);
    const c = { insert: 0, update: 0, delete: 0 };
    for (const r of sql.exec<{ op: string; n: number }>("SELECT op, count(*) AS n FROM _change_rows WHERE change = ? GROUP BY op", id)) {
      if (r.op === "insert" || r.op === "update" || r.op === "delete") c[r.op] = Number(r.n);
    }
    caught = c.insert + c.update + c.delete;
    if (added.length && inDatabase) {
      const rowid = rowidOf(columnsAfter) ?? "rowid";
      filled = Number(
        sql
          .exec<{ n: number }>(
            `SELECT count(*) AS n FROM ${bt(t.name)} WHERE (${added.map((a) => `${bt(a)} IS NOT NULL`).join(" OR ")}) AND ${rowid} NOT IN (SELECT rid_after FROM _change_rows WHERE change = ? AND rid_after IS NOT NULL)`,
            id,
          )
          .one().n,
      );
    }
    t.inserted = c.insert;
    t.updated = c.update + filled;
    t.deleted = c.delete;
  }
  const rows = t.inserted + t.updated + t.deleted;
  if (rows === 0 && !added.length) {
    sql.exec("DELETE FROM _change_rows WHERE change = ?", id);
    sql.exec("DELETE FROM _changes WHERE id = ?", id);
    return null;
  }
  // Past the most rows a record keeps, or with none caught, its counts only: Restore to Here puts it back.
  const whole = p.uncaught === true || caught > CHANGE_ROWS_KEPT_MAX;
  if (whole) sql.exec("DELETE FROM _change_rows WHERE change = ?", id);
  const now = sql.exec<{ version: number; rows: number | null }>("SELECT version, rows FROM _tables WHERE name = ?", t.name).toArray()[0];
  delete p.open;
  p.columnsAfter = columnsAfter;
  if (filled) p.filled = filled;
  if (now) p.versionAfter = Number(now.version);
  p.rowsAfter = inDatabase ? Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${bt(t.name)}`).one().n) : Number(now?.rows ?? 0);
  sql.exec("UPDATE _changes SET rows = ?, whole = ?, tables = ? WHERE id = ?", rows, whole ? 1 : 0, JSON.stringify([t]), id);
  return t;
}

/** What a change did, as Version History says it: "Changed 312 rows of permits; made fee_review". */
function changeNote(tables: readonly ChangeTableRecord[]): string {
  const parts = tables.map((t) => {
    if (t.made) return `made ${t.name}`;
    const n = t.inserted + t.updated + t.deleted;
    return `changed ${n.toLocaleString("en-US")} row${n === 1 ? "" : "s"} of ${t.name}`;
  });
  const text = parts.join("; ");
  return `A run ${text}`.slice(0, 500);
}

interface ChangeRowRecord {
  seq: number;
  tbl: string;
  op: "insert" | "update" | "delete";
  rid_before: number | null;
  rid_after: number | null;
  before: string | null;
  after: string | null;
}

/** The columns of a row's values that hold bytes (`{"$blob": hex}`), with the bytes. */
function blobsOf(values: string | null, columns: readonly string[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (!values || !values.includes('"$blob"')) return out;
  let parts: unknown;
  try {
    parts = JSON.parse(values);
  } catch {
    return out;
  }
  if (!Array.isArray(parts)) return out;
  for (const column of columns) {
    const at = columns.indexOf(column);
    const part = parts[Math.floor(at / CHANGE_PART_COLUMNS)] as Record<string, unknown> | undefined;
    const v = part?.[column] as { $blob?: unknown } | null | undefined;
    if (v && typeof v === "object" && typeof v.$blob === "string") {
      const hex = v.$blob;
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      out.set(column, bytes);
    }
  }
  return out;
}

/** A column's value read back from a row's values, as an SQL expression on parameter `?1`. */
function valueSql(columns: readonly string[], column: string, blobs: Map<string, Uint8Array>, params: unknown[]): string {
  if (blobs.has(column)) {
    params.push(blobs.get(column));
    return `?${params.length}`;
  }
  return `json_extract(?1, ${lit(pathOf(columns, column))})`;
}

/** Whether a trigger's body writes a virtual table, as a search index that follows its table does. */
function writesVirtual(sql: SqlLike, trigger: string): boolean {
  const body = trigger.replace(/^[\s\S]*?\bBEGIN\b/i, "").replace(/\bEND\s*;?\s*$/i, "");
  for (const statement of splitStatements(body)) {
    const target = targetOf(statement);
    if (target === null) continue;
    const row = sql.exec<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)", target).toArray()[0];
    if (row && /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(String(row.sql ?? ""))) return true;
  }
  return false;
}

/**
 * Drops, for the length of an undo, the store's own triggers on the tables it puts rows back in, and
 * answers what makes them again. The rows they wrote during the run are in the record and go back
 * with the rest: fired again, they would change those rows a second time (an `updated_at` trigger
 * would leave every row held). A trigger that writes a virtual table keeps firing, since no record
 * holds a virtual table's rows: a search index then follows its table back.
 */
function quietTriggers(sql: SqlLike, tables: Iterable<string>): string[] {
  const wanted = new Set([...tables].map(lower));
  const quiet: { name: string; sql: string }[] = [];
  for (const row of sql.exec<{ name: string; tbl_name: string; sql: string | null }>("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").toArray()) {
    if (!row.sql || !wanted.has(lower(String(row.tbl_name)))) continue;
    if (writesVirtual(sql, String(row.sql))) continue;
    quiet.push({ name: String(row.name), sql: String(row.sql) });
  }
  for (const t of quiet) sql.exec(`DROP TRIGGER ${bt(t.name)}`);
  return quiet.map((t) => t.sql);
}

/** SQLite's refusal of a row for a constraint (UNIQUE, NOT NULL, CHECK), which an undo holds that row for. */
function isConstraintError(error: unknown): boolean {
  return /constraint failed/i.test(error instanceof Error ? error.message : String(error));
}

/** A change's record as its `_changes` row holds it, as `exec` answers it. */
function summaryOf(row: { id: number; state: string; rows: number; whole: number; tables: string; restored: number | null; held: number | null; fingerprint?: string | null }): ChangeSummary {
  let tables: ChangeTableRecord[] = [];
  try {
    tables = JSON.parse(row.tables) as ChangeTableRecord[];
  } catch {
    tables = [];
  }
  const counts: ChangeTableCount[] = tables.map((t) => ({
    name: t.name,
    inserted: t.inserted,
    updated: t.updated,
    deleted: t.deleted,
    made: t.made,
    // A program table's new version, or one the run made, says its version and rows before and after.
    ...(t.program && t.program.how !== "rows"
      ? { version: { before: t.program.versionBefore, after: t.program.versionAfter, rowsBefore: t.program.rowsBefore, rows: t.program.rowsAfter } }
      : {}),
  }));
  return {
    id: Number(row.id),
    state: row.state === "trial" ? "trial" : row.state === "undone" ? "undone" : "kept",
    rows: Number(row.rows),
    whole: Number(row.whole) === 1,
    tables: counts,
    ...(row.restored !== null && row.restored !== undefined ? { restored: Number(row.restored) } : {}),
    ...(row.held !== null && row.held !== undefined ? { held: Number(row.held) } : {}),
    ...(row.fingerprint ? { fingerprint: String(row.fingerprint) } : {}),
  };
}

/** A kept change's record as `summaryOf` reads it, for the change that a step's commit or close just kept. */
export function keptSummary(sql: SqlLike, id: number): ChangeSummary | null {
  const row = sql.exec<{ id: number; state: string; rows: number; whole: number; tables: string; restored: number | null; held: number | null }>(
    "SELECT id, state, rows, whole, tables, restored, held FROM _changes WHERE id = ?",
    id,
  ).toArray()[0];
  return row ? summaryOf(row) : null;
}

/**
 * How a program table's change is undone, beyond its rows (program-tables.ts, `tableUndo`): its
 * version or the table it made put back, and what follows any undo of a program table.
 */
export interface TableUndo {
  /**
   * A new version, or a table the run made: the version before back, or the table gone, and the
   * step's settings as they were, while the table holds the change's version. Refuses
   * (`change_version_gone`) when it does, but the copy of the version before is gone.
   */
  version(core: StoreCore, job: string | null, table: TableChangeRecord, by: string): { restored: number; held: number };
  /**
   * Rows changed in place, once each is back: while no later job changed the table, the columns the
   * change added go, and the table's record and the step's settings are what they were.
   */
  rows(core: StoreCore, job: string | null, table: TableChangeRecord, usable: boolean): { restored: number; held: number };
  /** After either: the table's whole change, so its readers read all of it, and the step that made the change forgets what it had read. */
  after(core: StoreCore, job: string | null, table: TableChangeRecord, by: string): void;
}

/**
 * Puts back the rows change `id` keeps, newest first, each only while it holds what the change left
 * there; any other is held and counted, as is a row a constraint now refuses (a UNIQUE value taken
 * since). A table the change made goes while it holds the rows the change left in it. The tables'
 * own triggers stay quiet meanwhile (`quietTriggers`). `columnsOf` says, for a table, the columns
 * its rows' values follow when it may be written, or null when its rows are held.
 */
function putRowsBack(core: StoreCore, id: number, tables: readonly ChangeTableRecord[], usableOf: (t: ChangeTableRecord) => string[] | null): { restored: number; held: number; touched: Set<string>; usable: Set<string> } {
  const sql = core.sql;
  const byName = new Map(tables.map((t) => [t.name, t]));
  const usable = new Map<string, string[]>();
  for (const t of tables) {
    if (t.made) continue;
    const columns = usableOf(t);
    if (columns) usable.set(t.name, columns);
  }
  let restored = 0;
  let held = 0;
  const touched = new Set<string>();
  let below = Number.MAX_SAFE_INTEGER;
  // Made again, as they were, once every row is back (inside this transaction, so a failure keeps them).
  const quieted = quietTriggers(sql, usable.keys());
  for (;;) {
    const page = sql
      .exec<ChangeRowRecord & Record<string, StoreSqlValue>>(
        "SELECT seq, tbl, op, rid_before, rid_after, before, after FROM _change_rows WHERE change = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
        id,
        below,
        UNDO_PAGE,
      )
      .toArray() as unknown as ChangeRowRecord[];
    if (!page.length) break;
    for (const r of page) {
      below = Number(r.seq);
      const table = byName.get(String(r.tbl));
      // A made table's rows go with the table, below.
      if (table?.made) continue;
      const columns = usable.get(String(r.tbl));
      const rowid = columns ? rowidOf(columns) : null;
      if (!columns || !rowid) {
        held++;
        continue;
      }
      const t = bt(String(r.tbl));
      const now = (rid: number | null) =>
        rid === null ? null : (sql.exec<{ v: string }>(`SELECT ${valuesSql("", columns)} AS v FROM ${t} WHERE ${rowid} = ?`, rid).toArray()[0]?.v ?? null);
      if (r.op === "insert") {
        if (now(r.rid_after) !== r.after) {
          held++;
          continue;
        }
        sql.exec(`DELETE FROM ${t} WHERE ${rowid} = ?`, r.rid_after);
      } else if (r.op === "update") {
        if (now(r.rid_after) !== r.after || (r.rid_before !== r.rid_after && now(r.rid_before) !== null)) {
          held++;
          continue;
        }
        // The rowid goes back in a statement of its own: a table of 100 columns takes no 101st in one SET.
        const moved = r.rid_before !== r.rid_after;
        if (moved) sql.exec(`UPDATE ${t} SET ${rowid} = ? WHERE ${rowid} = ?`, r.rid_before, r.rid_after);
        const blobs = blobsOf(r.before, columns);
        const params: unknown[] = [r.before];
        const sets = columns.map((c) => `${bt(c)} = ${valueSql(columns, c, blobs, params)}`);
        params.push(r.rid_before);
        try {
          sql.exec(`UPDATE ${t} SET ${sets.join(", ")} WHERE ${rowid} = ?${params.length}`, ...params);
        } catch (error) {
          if (!isConstraintError(error)) throw error;
          if (moved) sql.exec(`UPDATE ${t} SET ${rowid} = ? WHERE ${rowid} = ?`, r.rid_after, r.rid_before);
          held++;
          continue;
        }
      } else {
        if (now(r.rid_before) !== null) {
          held++;
          continue;
        }
        const blobs = blobsOf(r.before, columns);
        const params: unknown[] = [r.before];
        const values = columns.map((c) => valueSql(columns, c, blobs, params));
        params.push(r.rid_before);
        try {
          sql.exec(`INSERT INTO ${t} (${rowid}, ${columns.map(bt).join(", ")}) VALUES (?${params.length}, ${values.join(", ")})`, ...params);
        } catch (error) {
          // A row another row stands in the way of now (a UNIQUE value taken since) stays out, and is counted.
          if (!isConstraintError(error)) throw error;
          held++;
          continue;
        }
      }
      restored++;
      touched.add(String(r.tbl));
    }
  }
  for (const t of tables) {
    if (!t.made) continue;
    const exists = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t.name).toArray().length > 0;
    if (!exists) continue;
    const holds = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${bt(t.name)}`).one().n);
    if (holds !== (t.rows ?? 0)) {
      held += holds;
      continue;
    }
    try {
      refuseOrphaningDrop(sql, t.name);
    } catch {
      held += holds;
      continue;
    }
    sql.exec(`DROP TABLE ${bt(t.name)}`);
    sql.exec("DELETE FROM _tables WHERE lower(name) = lower(?) AND kind = 'managed'", t.name);
    sql.exec("DELETE FROM _columns WHERE lower(tbl) = lower(?)", t.name);
    restored += holds;
  }
  for (const trigger of quieted) sql.exec(trigger);
  return { restored, held, touched, usable: new Set(usable.keys()) };
}

/** A table's columns now, or null for a table that is gone. */
function columnsNow(sql: SqlLike, name: string): string[] | null {
  const exists = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
  return exists ? columnsOf(sql, name) : null;
}

const sameColumns = (a: readonly string[] | null, b: readonly string[]): boolean => !!a && a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * Undoes kept change `id`: each row back, newest first, only while it holds what the change left
 * there; any other is held and counted (`putRowsBack`). A run's change to a program table goes back
 * by its record (`tables`, program-tables.ts): a new version swapped back, a table the run made gone,
 * rows changed in place put back and the columns the change added dropped; then the table reads
 * whole to the steps after it, and the step that made the change forgets what it had read. Undoing
 * a change already undone answers what that undo did.
 */
export function undoChange(core: StoreCore, id: number, run: string | null, by: string, restorePoint: string | null, tables?: TableUndo): ChangeSummary {
  const sql = core.sql;
  const row = sql
    .exec<{ id: number; state: string; kind: string | null; job: string | null; run: string | null; rows: number; whole: number; tables: string; restored: number | null; held: number | null }>(
      "SELECT id, state, kind, job, run, rows, whole, tables, restored, held FROM _changes WHERE id = ?",
      id,
    )
    .toArray()[0];
  // A change named with its run is that run's or none: a store restored to an earlier moment may
  // have given the number to a change of another run since.
  if (!row || (run !== null && row.run !== run)) throw new StoreError(404, "change_not_found", `This store keeps no change ${id}${run !== null ? " of that run" : ""}. A change is kept for 30 days.`);
  if (row.state === "undone") return summaryOf(row);
  if (row.state === "trial") throw new StoreError(409, "change_trial", "A trial changed nothing, so it has nothing to undo.");
  const program = row.kind === "table" ? tableRecordOf(String(row.tables)) : null;
  if (Number(row.whole) === 1) {
    throw new StoreError(
      409,
      "change_whole",
      program?.program.uncaught
        ? "The store kept this change's counts only (a parked table loaded again, or a database's rows pulled into a table it held), so it cannot be undone row by row. Restore to Here, in the store's Version History, puts the store back as it was before it."
        : "This change was too large to keep row by row, so it cannot be undone row by row. Restore to Here, in the store's Version History, puts the store back as it was before it.",
    );
  }
  if (row.kind === "table" && (!program || !tables)) throw new StoreError(409, "change_table", "This store cannot undo this change to a program's table: its record does not read.");
  // A step's job writes program tables between its commits: a table it is in the middle of is no
  // table to put back under it.
  if (program && sql.exec("SELECT 1 FROM _jobs WHERE state IN ('queued', 'running') LIMIT 1").toArray().length) {
    throw new StoreError(409, "store_busy", "A step is running in this store, and the tables this change put back may be the ones it writes. Undo This Run waits until it ends: try again then.");
  }
  sql.exec("PRAGMA defer_foreign_keys = ON");
  let restored = 0;
  let held = 0;
  const at = core.nowIso();
  if (program && program.program.how !== "rows") {
    ({ restored, held } = tables!.version(core, row.job, program, by));
  } else {
    const records = program ? [program] : ((JSON.parse(String(row.tables)) as ChangeTableRecord[]) ?? []);
    // A table whose columns changed since, or that is gone: its rows are held. A program table's
    // change in place may have added columns: its rows are written while the table has the columns
    // the change left it.
    const back = putRowsBack(core, id, records, (t) => {
      const now = columnsNow(sql, t.name);
      if (t.program) return sameColumns(now, t.program.columnsAfter ?? t.columns) ? t.columns : null;
      return sameColumns(now, t.columns) ? t.columns : null;
    });
    restored = back.restored;
    held = back.held;
    if (program) {
      const more = tables!.rows(core, row.job, program, back.usable.has(program.name));
      restored += more.restored;
      held += more.held;
    } else {
      // A table's row count is counted again when the store's stats are read (statements.ts `countStaleTables`).
      for (const name of back.touched) sql.exec("UPDATE _tables SET rows = NULL, updated_at = ? WHERE lower(name) = lower(?) AND kind = 'managed'", at, name);
    }
  }
  if (program) tables!.after(core, row.job, program, by);
  sql.exec("UPDATE _changes SET state = 'undone', undone_at = ?, undone_by = ?, restored = ?, held = ? WHERE id = ?", at, by, restored, held, id);
  core.history({ kind: "table", by, note: undoNote(program, restored, held), restorePoint, ref: `change:${id}` });
  return summaryOf({ ...row, state: "undone", restored, held });
}

/** What an undo did, as Version History says it. */
function undoNote(program: TableChangeRecord | null, restored: number, held: number): string {
  const n = (count: number) => `${count.toLocaleString("en-US")} row${count === 1 ? "" : "s"}`;
  if (program && program.program.how !== "rows") {
    const p = program.program;
    if (held) return `Undid a run's change: ${program.name} had changed since, so it stays as it is`;
    if (p.how === "made") return `Undid a run's change: ${program.name}, which the run made, is gone`;
    return `Undid a run's change: ${program.name} is back at version ${p.versionBefore ?? 1}, ${n(p.rowsBefore ?? 0)}`;
  }
  return held ? `Undid a run's change: ${n(restored)} put back; ${held.toLocaleString("en-US")} had changed since and stayed` : `Undid a run's change: ${n(restored)} put back`;
}

/** Clears the records past their time: trials after a day, kept changes after the restore window. */
export function pruneChanges(core: StoreCore): void {
  const sql = core.sql;
  const now = core.deps.now();
  const trialBefore = new Date(now - TRIAL_KEPT_MS).toISOString();
  const keptBefore = new Date(now - CHANGE_KEPT_MS).toISOString();
  const old = sql
    .exec<{ id: number }>("SELECT id FROM _changes WHERE made_at < ? OR (state = 'trial' AND made_at < ?) ORDER BY id LIMIT ?", keptBefore, trialBefore, PRUNE_EACH_CALL)
    .toArray();
  for (const { id } of old) {
    sql.exec("DELETE FROM _change_rows WHERE change = ?", id);
    sql.exec("DELETE FROM _changes WHERE id = ?", id);
  }
}
