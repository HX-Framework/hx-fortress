// LOAD and SHAPE as the api and a store's object both see them (Stores, Part A): what store_load
// and store_shape (the api's agent/tools/store-steps.ts) submit, what the store's
// job handlers (packages/store-object/src/jobs/{load,shape}.ts) answer, and the
// names both read. One module, so the two sides cannot drift: the store's object may import this
// package and nothing else of the deployer's, and the api imports this file alone (`store-readers/jobs`),
// not the readers.

import { type OpenedFile, type ReadCursor, type SourceRow, type SourceTable, UnreadableFile } from "./types.js";

/**
 * The group a LOAD's tables are in; store_shape reads its sources from it. The name stores keep
 * from their first days, when each held a town's records: the page and the tools show it as
 * "From the files" (`tableGroupWords`, in the package of the pages' words). Never rename it here: every store holds it,
 * and the gateway and the api, which deploy apart, both compare it.
 */
export const LOADED_GROUP = "From the town";
/** The group a SHAPE's tables are in. */
export const SHAPED_GROUP = "Cleaned";
/** The group a SHAPE's views are in: what the target system takes, as a view over the cleaned tables. */
export const READY_GROUP = "Ready";
/** Where a store keeps the SQL a SHAPE made `<into>` with (`_meta`). */
export const shapeKey = (into: string): string => `shape:${into}`;

/** Who made a table: the run and the step, or nothing (a chat's or an agent's call). */
export interface MadeBy {
  runId: string | null;
  step: string | null;
}

const nameOrNull = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length > 0 && v.length <= 200);

/** `madeBy` as a job takes it; null when it is not a run and a step, or nothing. */
export function madeByOf(v: unknown): MadeBy | null {
  if (v === undefined || v === null) return { runId: null, step: null };
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const runId = o.runId ?? null;
  const step = o.step ?? null;
  return nameOrNull(runId) && nameOrNull(step) ? { runId, step } : null;
}

/** A file LOAD reads, and a dBase or FoxPro table's memo file and database's container in the same store. */
export interface LoadFile {
  id: string;
  name: string;
  memo?: { id: string };
  /** A Visual FoxPro table's database's container (.dbc), read for the long names of the table and its fields (dbc.ts). */
  dbc?: { id: string };
  /**
   * The code page a person set for the file's text, one of `READABLE_CODE_PAGES`: for a dBase
   * table, delimited text, and those inside a zip. The store keeps it under the file's name, so
   * every later LOAD of a file of that name reads its text so. "auto" forgets it: LOAD finds the
   * code page from the text again.
   */
  codePage?: number | "auto";
  /**
   * An .xls workbook or an Access database larger than a store reads whole: the READ job that read
   * it beside the store (store-object jobs/read.ts). LOAD opens that READ's read-out, and drops it
   * once the LOAD ends: each READ reads for one LOAD.
   */
  readOut?: string;
}

// ─── Code pages ──────────────────────────────────────────────────────────────────────────────────
// A dBase table's header names the code page its text is in, and LOAD reads the text in the code
// page the text shows, where the two disagree (code-page.ts). Delimited text is read as UTF-8 or
// Windows-1252, whichever its bytes show (text.ts). A person sets the code page of a file whose
// text LOAD still reads wrongly: store_load's `codePage`, kept by the store under the file's name.

/** UTF-8, by the number Windows gives it, beside the single-byte code pages. */
export const UTF8_CODE_PAGE = 65001;

/** The code pages LOAD reads text in: the single-byte ones it has tables for (codepages.ts), and UTF-8. */
export const READABLE_CODE_PAGES: readonly number[] = [
  437, 737, 850, 852, 857, 860, 861, 863, 865, 866, 874, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 10000, 10006, 10007, 10029, UTF8_CODE_PAGE,
];

/** A code page's name as a person reads it: "Windows-1252", "code page 437", "Mac code page 10000", "UTF-8". */
export function codePageName(page: number): string {
  if (page === UTF8_CODE_PAGE) return "UTF-8";
  return page >= 1250 && page <= 1258 ? `Windows-${page}` : page >= 10000 ? `Mac code page ${page}` : `code page ${page}`;
}

/**
 * A code page as a person names it: "Windows-1252", "cp1252", "1252", "code page 437", "DOS 850",
 * "UTF-8", "Latin-1" (Windows-1252, as browsers read it); "auto" to let LOAD find it. Null for
 * words that name no code page LOAD reads.
 */
export function codePageOf(words: unknown): number | "auto" | null {
  if (typeof words === "number") return READABLE_CODE_PAGES.includes(words) ? words : null;
  if (typeof words !== "string") return null;
  const w = words.trim().toLowerCase().replace(/[\s_]+/g, " ");
  if (w === "auto") return "auto";
  if (/^utf ?-?8$/.test(w)) return UTF8_CODE_PAGE;
  if (/^(?:latin ?-?1|iso ?-?8859 ?-?1)$/.test(w)) return 1252;
  const digits = /^(?:(?:windows|win|cp|ibm|dos|oem|mac|ansi) ?-?)?(?:code ?page ?-?)?(\d{3,5})$/.exec(w)?.[1];
  const page = digits ? Number(digits) : NaN;
  return READABLE_CODE_PAGES.includes(page) ? page : null;
}

/**
 * Columns a table must keep in each new version a program makes, by table: an app on the store
 * reads them (`reader` says who, in a sentence's words: "Laptop Loans on prod"). A version without
 * one is not made, and the table stays as it was.
 */
export type KeepColumns = Record<string, Array<{ column: string; reader: string }>>;

/** `keep` as a job's parameters carry it, checked; undefined when there is none. */
export function keepOf(value: unknown): KeepColumns | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("keep names, by table, the columns each must keep.");
  const out: KeepColumns = {};
  for (const [table, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) throw new Error(`keep's entry for ${table} is not a list.`);
    out[table.toLowerCase()] = list.map((k) => {
      const column = k && typeof k === "object" ? (k as { column?: unknown }).column : undefined;
      const reader = k && typeof k === "object" ? (k as { reader?: unknown }).reader : undefined;
      if (typeof column !== "string" || !column || typeof reader !== "string" || !reader) throw new Error(`keep's entry for ${table} names a column and who reads it.`);
      return { column, reader };
    });
  }
  return Object.keys(out).length ? out : undefined;
}

/** Why a new version that drops columns an app reads is not made. */
export function keepRefusal(name: string, missing: ReadonlyArray<{ column: string; reader: string }>): string {
  const columns = [...new Set(missing.map((m) => m.column))];
  const readers = [...new Set(missing.map((m) => m.reader))];
  const these = columns.length === 1 ? `the column ${columns[0]}` : `the columns ${columns.join(", ")}`;
  return `The new version of ${name} has no ${columns.length === 1 ? "column" : "columns"} ${columns.join(", ")}, which ${readers.join(" and ")} ${readers.length === 1 ? "reads" : "read"}, so it was not made: ${name} stays as it was. Keep ${these}, or change the app first.`;
}

export interface LoadParams {
  files: LoadFile[];
  madeBy: MadeBy;
  /** Columns the tables it makes must keep: an app on the store reads them. */
  keep?: KeepColumns;
  /**
   * A run on a sample: each file's first rows, or the rows of these numbers (`_row`, a row's number
   * in its file), into tables of their own beside the whole data's, which they never replace.
   */
  sample?: LoadSample;
}

/** A LOAD's sample: each file's first `rows` rows, or its rows of these numbers. */
export type LoadSample = { rows: number } | { records: number[] };

/** A LOAD's sample names at most this many row numbers. */
export const SAMPLE_RECORDS_MAX = 1_000;

/** One table a LOAD made, or a file it could not read (`table` null, the reason in `notes`). */
export interface LoadedTable {
  table: string;
  version: number;
  rows: number;
  file: string;
  sheet: string | null;
  notes: string[];
  /** The rows added, changed and removed since the table's last load, by `_key`; null for a first load, or when most rows changed. */
  changes?: RowCounts | null;
  /**
   * The table's name in full, when LOAD cut it at MAX_TABLE_NAME characters: a second name for
   * the same table, which SQL may read it by. Missing when the name was not cut.
   */
  fullName?: string;
  /** The file's columns past the first MAX_KEPT_COLUMNS, packed into `_extra`: SQL reads each by its name. */
  packed?: string[];
}

export interface LoadResult {
  tables: LoadedTable[];
  skipped: { file: string; why: string }[];
}

export interface ShapeParams {
  into: string;
  sql: string;
  goal: string | null;
  /** The source tables and their columns, as the SQL was written for them (JSON). */
  sources: string;
  madeBy: MadeBy;
  /** "view": a SELECT the store keeps as a view, always current, with no rows of its own. Left out: a table. */
  as?: "table" | "view";
  /** Make the whole table anew, even when the store knows which rows changed. */
  whole?: boolean;
  /** Columns the table must keep: an app on the store reads them. */
  keep?: KeepColumns;
}

/** What a store keeps under `shapeKey(into)`: the SQL, the goal and the sources it was written for. */
export interface SavedShape {
  goal: string | null;
  sql: string;
  sources: string;
  version: number;
  madeAt: string;
  madeBy: string;
  /** "view" when the SHAPE made a view. */
  as?: "table" | "view";
  /**
   * The source table whose `_key` names each row of the table, one row per source row: a later run
   * changes only the rows whose keys changed. Null: every run makes the whole table.
   */
  driver?: string | null;
  /** The table's columns, in order, as the SELECT makes them. */
  columns?: string[];
  /** The store's change number of each source table when the SHAPE last read it (`TableDelta.change`). */
  read?: Record<string, number>;
}

/** How a SHAPE made its table this time. */
export type ShapeMode =
  /** Made anew: a first run, a new SQL or new source columns, or a table with no `_key` for its rows. */
  | "whole"
  /** Only the rows whose source rows changed since the last run were written, by `_key`. */
  | "changed"
  /** No source table changed since the last run, so nothing was written. */
  | "unchanged"
  /** Kept as a view: no rows of its own. */
  | "view";

/** What a SHAPE job answers: the table's handle, how it was made, and what changed in it. */
export interface ShapeResult extends RowCounts {
  table: string;
  version: number;
  rows: number;
  mode: ShapeMode;
  /** Why the whole table was made, when it was, in words. */
  why?: string;
  /** Source tables the store brought back from its files before it could run the SQL. */
  broughtBack?: string[];
}

// ─── What changed: the delta a store records for each table ─────────────────────────────────────
// Every change to a program table gets a store-wide change number that only grows, and the store
// records which rows it added, changed and removed, by each row's `_key` (store/deltas.ts). A step
// that reads a table saves the change number it read up to, and on its next run reads only the
// rows whose keys changed after it. A change the store cannot name row by row (a first load, a
// table made anew from new SQL) is "whole": the reader takes the whole table. LOAD finds what
// changed by comparing each row's `_hash` with the store's memory of the hashes it took in last
// time, so a new upload of a town's file names, and writes, only the rows that differ. The
// database pulls record their changes the same way.

/**
 * A row's name across loads and changes. Every LOAD table has it: the town's own key when the
 * table's first rows show one (a permit number), else a hash of the row's values; a repeat gets
 * "#2", "#3" in file order. A SHAPE that makes one row per source row keeps it, and then changes
 * its table by key.
 */
export const KEY_COLUMN = "_key";
/** A hash of a row's values as it came in: how the store knows a row with the same `_key` changed. */
export const HASH_COLUMN = "_hash";
/**
 * Where LOAD packs a file's columns past its first 90 (names.ts `MAX_KEPT_COLUMNS`), as one JSON
 * object by column name: a store table holds at most 100 columns. A store reads a packed column by
 * its name, from here.
 */
export const EXTRA_COLUMN = "_extra";

export type RowChange = "added" | "changed" | "removed";

/** How many rows a change added, changed and removed. */
export interface RowCounts {
  added: number;
  changed: number;
  removed: number;
}

/** One change to a program table, as the store records it. */
export interface TableDelta extends RowCounts {
  table: string;
  /** The store's change number: it only grows. */
  change: number;
  /** The table's version after the change; a change in place keeps the version. */
  version: number;
  /** The store cannot say which rows changed: a reader takes the whole table. */
  whole: boolean;
  at: string;
  job: string | null;
}

/**
 * A store keeps the keys of a change until every step that reads the table has read past it (each
 * keeps a mark: `markRead`), and never those of more than a table's newest this-many changes: a
 * reader further behind takes the whole table.
 */
export const DELTA_CHANGES_KEPT = 16;
/** The newest changes whose keys a store keeps for a table no step has marked as read. */
export const DELTA_UNREAD_KEPT = 2;

// ─── Parking: a raw table kept as a file once it is cleaned ─────────────────────────────────────
// A LOAD's table is parked a while after a SHAPE made a cleaned table from it: its rows are written
// to the store's bucket as gzipped JSON Lines, one file a part, and the table leaves the store's
// database. The catalog still lists it, with `parked`. Bring Back writes the rows back. A new LOAD
// of the town's file keeps it parked: the file's rows become its new files, and the store records
// only the rows that changed. A LOAD whose file's columns changed makes a new version instead.

/** `park` and `bring_back` take the table. */
export interface ParkParams {
  table: string;
}

/** Where a parked table is: when it was parked, its rows and the bytes its files take. */
export interface ParkedTable {
  at: string;
  rows: number;
  bytes: number;
}

/** What `park` and `bring_back` answer. */
export interface ParkResult {
  table: string;
  version: number;
  rows: number;
  parked: boolean;
}

/** The longest name a LOAD or a SHAPE gives a table. */
export const MAX_TABLE_NAME = 60;

/** What may name a table a step makes in a store. */
export const TABLE_NAME_RE = new RegExp(`^[a-z][a-z0-9_]{0,${MAX_TABLE_NAME - 1}}$`);

/**
 * Why `name` cannot name a table a step makes, in words; null when it can. A name longer than
 * MAX_TABLE_NAME says so: a longer limit would make a file loaded again under it a second table.
 */
export function tableNameRefusal(name: string): string | null {
  if (TABLE_NAME_RE.test(name)) return null;
  if (name.length > MAX_TABLE_NAME && /^[a-z][a-z0-9_]*$/.test(name)) {
    return `"${name}" is ${name.length} characters, and a table's name holds at most ${MAX_TABLE_NAME}. Name the table in ${MAX_TABLE_NAME} characters or fewer.`;
  }
  return `"${name}" cannot name a table: use lowercase words joined by underscores.`;
}

/**
 * The names SQL text reads, lowercased: bare words and quoted names, outside strings and comments.
 * Which of them are tables is the store's to say; a SHAPE given its SQL reads its sources from it.
 */
export function namesInSql(sqlText: string): Set<string> {
  const out = new Set<string>();
  const re = /"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|\[([^\]]+)\]|'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|([A-Za-z_][A-Za-z0-9_$]*)/g;
  for (const m of sqlText.matchAll(re)) {
    const name = m[1]?.replace(/""/g, '"') ?? m[2]?.replace(/``/g, "`") ?? m[3] ?? m[4];
    if (name) out.add(name.toLowerCase());
  }
  return out;
}

// ─── The cleanup steps: PROFILE, CLASSIFY, MATCH, CHECK (Stores, Part A, slice E) ───────────────
// store_profile, store_classify, store_match and store_check (the api's agent/tools/
// store-cleanup.ts) submit these; the store's handlers (store/jobs/{profile,classify,match,check}.ts)
// answer them. A model call never runs in the store: the api asks the model and sends its answers.
//
// A store keeps one working copy of what these steps write. CLASSIFY and MATCH add their column to
// the table once and then change only the rows whose value changes; their Answers tables and
// CHECK's flags are made once and then changed row by row; a profile's rows replace the last ones.
// Each step takes the whole table, or only the rows a set of keys names (`changed`): the rows that
// changed since its last run, so a nightly run writes what changed and nothing more.

/** The group a CLASSIFY's and a MATCH's kept answers are in. */
export const ANSWERS_GROUP = "Answers";
/** The group a CHECK's flags are in. */
export const REVIEW_GROUP = "To review";
/** The group a PROFILE's tables are in. */
export const PROFILE_GROUP = "Profiles";

/** Where a store keeps the rules a CHECK of `table` ran with (`_meta`). */
export const checkKey = (table: string): string => `check:${table}`;
/** Where a store keeps what an Answers table answers: the column, the list, the reference table. */
export const answersKey = (answers: string): string => `answers:${answers}`;

/**
 * The SQL of a value's answer key: its text, lowercased, without spaces, tabs or line breaks at
 * either end. One expression on both sides, so the api's question ("which values have no answer
 * yet?") and the store's join read the same key. Only the store computes it: SQLite's `lower`
 * folds ASCII letters only, and JavaScript's would fold others too.
 */
export const answerKeySql = (expr: string): string => `lower(trim(CAST(${expr} AS TEXT), char(32, 9, 10, 13)))`;

/** The SQL of a value as text without spaces, tabs or line breaks at either end; NULL stays NULL. */
export const trimmedSql = (expr: string): string => `trim(CAST(${expr} AS TEXT), char(32, 9, 10, 13))`;

/** What `trimmedSql` does, in JavaScript: only spaces, tabs and line breaks go. A no-break space stays, as it does in the store. */
export const trimmedText = (text: string): string => text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");

/**
 * The SQL that is true when a value holds anything: not NULL, and not only spaces. It is 0 or 1 and
 * never NULL, since SQL reads `NOT (NULL <> '')` as NULL and a rule would pass an empty cell.
 */
export const hasValueSql = (expr: string): string => `coalesce(${trimmedSql(expr)} <> '', 0)`;

// What reads as a number or as a date, as SQL over a value's trimmed text. A store's own steps
// (PROFILE, CHECK) count with these, and so does whatever else profiles a store's tables through
// its `query` door, so the two can never count different rows.

/** Trimmed text `v` as a number would be written: no $, commas or spaces. */
export const numberTextSql = (v: string): string => `replace(replace(replace(${v}, '$', ''), ',', ''), ' ', '')`;
const unsignedSql = (v: string): string => `ltrim(${numberTextSql(v)}, '+-')`;

/** Text `v` without the ".0" SQLite writes after a whole number kept as REAL. */
const noPointZeroSql = (v: string): string => `(CASE WHEN ${v} GLOB '*.0' THEN substr(${v}, 1, length(${v}) - 2) ELSE ${v} END)`;

/** Whether trimmed text `v` reads as a whole number: digits, a sign, $ and commas allowed, or a REAL that is one. */
export const wholeSql = (v: string): string => `(${unsignedSql(noPointZeroSql(v))} <> '' AND ${unsignedSql(noPointZeroSql(v))} NOT GLOB '*[^0-9]*')`;

/** Whether trimmed text `v` reads as a number: digits with at most one decimal point. */
export const numberSql = (v: string): string =>
  `(replace(${unsignedSql(v)}, '.', '') <> '' AND replace(${unsignedSql(v)}, '.', '') NOT GLOB '*[^0-9]*' AND length(${unsignedSql(v)}) - length(replace(${unsignedSql(v)}, '.', '')) <= 1)`;

/** Trimmed text `v` as a number, when `numberSql` says it reads as one. */
export const numberValueSql = (v: string): string => `CAST(${numberTextSql(v)} AS REAL)`;

/** The four ways M/D/YYYY is written with one or two digits each. */
const MDY = ["[0-9]/[0-9]", "[0-9][0-9]/[0-9]", "[0-9]/[0-9][0-9]", "[0-9][0-9]/[0-9][0-9]"].map((md) => `${md}/[0-9][0-9][0-9][0-9]`);

/**
 * Trimmed text `v` in the form YYYY-MM-DD by how it is written, or NULL: an ISO date (with a time
 * after it or not), or M/D/YYYY as US towns write it. It does not ask whether the day exists:
 * `isoDateSql` does.
 */
export function dateTextSql(v: string): string {
  return `CASE
    WHEN ${v} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR ${v} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ]*' THEN substr(${v}, 1, 10)
    WHEN ${MDY.map((p) => `${v} GLOB '${p}'`).join(" OR ")} THEN printf('%04d-%02d-%02d', CAST(substr(${v}, -4) AS INTEGER), CAST(substr(${v}, 1, instr(${v}, '/') - 1) AS INTEGER), CAST(substr(${v}, instr(${v}, '/') + 1, length(${v}) - instr(${v}, '/') - 5) AS INTEGER))
  END`;
}

/** Text `iso` (YYYY-MM-DD) when the calendar has that day, else NULL: February 30 is no date. */
export const realDaySql = (iso: string): string => `(CASE WHEN date(${iso}) = ${iso} THEN ${iso} END)`;

/**
 * Trimmed text `v` as a date in the form YYYY-MM-DD, or NULL: an ISO date (with a time after it or
 * not), or M/D/YYYY as US towns write it. Only real days: February 30 is no date.
 */
export const isoDateSql = (v: string): string => realDaySql(dateTextSql(v));

/** Whether trimmed text `v` reads as a date. */
export const dateSql = (v: string): string => `(${isoDateSql(v)} IS NOT NULL)`;

/** A table a step made, as a step gives it: its name, its version and its rows. */
export interface MadeTable {
  table: string;
  version: number;
  rows: number;
}

/**
 * The rows a step works on when not the whole table: the rows whose `key` columns hold one of
 * `values`, one array of values a row, in `key`'s order. The rows that changed since the step's
 * last run, as the step before it says them.
 */
export interface ChangedRows {
  key: string[];
  values: (string | number | null)[][];
}

/**
 * The most keys one step takes: their JSON stays under the gateway's 1 MiB body, with room for a
 * table's row names. A larger change is the whole table to the step that says it.
 */
export const CHANGED_KEYS_MAX = 10_000;

/**
 * The SQL that keeps the rows of `alias` that `changed` names, and the one value it binds (the keys
 * as JSON); every row when `changed` is null. Compared as text on both sides, so a key read from
 * JSON finds an INTEGER or a TEXT column's value alike. `quote` quotes a column's name.
 */
export function changedRowsSql(alias: string, changed: ChangedRows | null, quote: (name: string) => string): { where: string; params: string[] } {
  if (!changed) return { where: "1", params: [] };
  const columns = changed.key.map((k) => `CAST(${alias}.${quote(k)} AS TEXT)`);
  const picks = changed.key.map((_, i) => `CAST(json_extract(value, '$[${i}]') AS TEXT)`);
  const left = columns.length === 1 ? columns[0]! : `(${columns.join(", ")})`;
  return { where: `${left} IN (SELECT ${picks.join(", ")} FROM json_each(?))`, params: [JSON.stringify(changed.values)] };
}

/** A step's `changed` as a step sent it, checked; null for the whole table. Throws words. */
export function changedRowsOf(v: unknown): ChangedRows | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new TypeError("changed names the key columns and the keys that changed.");
  const o = v as Record<string, unknown>;
  const key = typeof o.key === "string" ? [o.key] : o.key;
  if (!Array.isArray(key) || !key.length || key.length > 5 || key.some((k) => typeof k !== "string" || !k.trim())) throw new TypeError("changed.key names one to five columns.");
  if (!Array.isArray(o.values) || o.values.length > CHANGED_KEYS_MAX) throw new TypeError(`changed.values holds at most ${CHANGED_KEYS_MAX} keys.`);
  const values = o.values.map((row) => {
    const cells = Array.isArray(row) ? row : [row];
    if (cells.length !== key.length || cells.some((c) => c !== null && typeof c !== "string" && typeof c !== "number")) {
      throw new TypeError(`Each key in changed.values holds ${key.length} value${key.length === 1 ? "" : "s"}, one for each of ${key.join(", ")}.`);
    }
    return cells as (string | number | null)[];
  });
  return { key: key.map((k) => String(k).trim()), values };
}

// PROFILE ─────────────────────────────────────────────────────────────────────────────────────────

/** What most of a column's values read as. */
export type ProfileType = "empty" | "whole number" | "number" | "date" | "yes/no" | "text";

export interface ProfileParams {
  /** The table to profile. */
  table: string;
  /** The profile table to make: `<table>_profile`. */
  into: string;
  madeBy: MadeBy;
}

/** One column of a profile, as a run's step gives it. */
export interface ProfiledColumn {
  column: string;
  /** The share of rows with a value, 0 to 1. */
  filled: number;
  /** Distinct values that are not empty. */
  distinct: number;
  type: ProfileType;
  /** The share of the column's values that read as `type`, 0 to 1. */
  typeShare: number;
  /** The one fact about the column that matters most before it is cleaned, in words. */
  fact?: string;
}

export interface ProfileResult extends MadeTable {
  /** The table profiled, its version and its rows. */
  of: MadeTable;
  columns: ProfiledColumn[];
}

// CLASSIFY ────────────────────────────────────────────────────────────────────────────────────────

/** One value's answer: the class it maps to (null: none fits), how sure the answerer is, and why. */
export interface ClassifyAnswer {
  value: string;
  answer: string | null;
  sure: number;
  note?: string | null;
}

export interface ClassifyParams {
  table: string;
  column: string;
  /** The column the answer goes into: added to `table` on the first run, then changed in place. */
  into: string;
  /** The Answers table: `answers_<into>`. */
  answers: string;
  /** The fixed list an answer is one of. */
  classes: string[];
  /** An answer less sure than this waits for a person (`review` 1). */
  sure: number;
  /** New answers, to keep beside the ones the store has; a person's answer is never replaced. */
  add: ClassifyAnswer[];
  /** Who answered `add`: "model:<id>". */
  by: string;
  /** Only these rows; null: every row. */
  changed: ChangedRows | null;
  madeBy: MadeBy;
}

export interface ClassifyResult {
  table: MadeTable;
  answers: MadeTable;
  /** Answers kept this run. */
  added: number;
  /** Rows of the table whose `into` changed this run. */
  written: number;
  /** Answers that wait for a person. */
  unsure: number;
  /** Values of the column with no answer yet. */
  unanswered: number;
}

/** The most values one CLASSIFY asks about; the next run asks about the rest. */
export const CLASSIFY_ASK_MAX = 2000;
/** The most classes a CLASSIFY maps to. */
export const CLASSIFY_CLASSES_MAX = 200;

// MATCH ───────────────────────────────────────────────────────────────────────────────────────────

/** How MATCH reads a value before it compares: an address's street words in USPS form, or plain words. */
export type MatchKind = "address" | "text";

/** A reference row a value might be: its matched column's text, and the value MATCH takes from it. */
export interface MatchCandidate {
  reference: string;
  take: string;
  /** How alike the two are, 0 to 1. */
  score: number;
}

/** A value the rules could not match, with the reference rows most like it. */
export interface MatchLeftover {
  value: string;
  /** The rows of the table that hold it. */
  rows: number;
  candidates: MatchCandidate[];
}

/** A model's or a person's answer for one value: the value it takes (null: none of them), how sure, why. */
export interface MatchAnswer {
  value: string;
  take: string | null;
  sure: number;
  note?: string | null;
}

export interface MatchParams {
  /** `candidates` reads only: what the rules match, and the leftovers with their candidates.
   *  `apply` keeps the answers and makes the new version of `table`. */
  pass: "candidates" | "apply";
  table: string;
  column: string;
  /** The reference table, the column of it values are matched to, and the column whose value is taken. */
  to: string;
  toColumn: string;
  take: string;
  /** The column the taken value goes into: added to `table` on the first run, then changed in place. */
  into: string;
  /** The Answers table: `matches_<into>`. */
  answers: string;
  kind: MatchKind;
  /** A model's answer less sure than this waits for a person. */
  sure: number;
  /** `candidates`: the most leftovers it gives. */
  ask: number;
  /** `apply`: the model's answers. */
  add: MatchAnswer[];
  /** Who answered `add`: "model:<id>". */
  by: string;
  /** Only these rows; null: the rows that changed since its last run, by the store's own record. */
  changed: ChangedRows | null;
  /** `apply`: no value was left for a later run, so the next run need read only what changes. */
  complete?: boolean;
  /**
   * The values kept with no answer because no model was asked (`by` "model:none", while the store
   * did not show its values to models) are asked about again: the store shows them now.
   */
  askUnasked?: boolean;
  madeBy: MadeBy;
}

/** What the rules matched, by how; `known` were answered before by a model or a person. */
export interface MatchCounts {
  exact: number;
  normalized: number;
  known: number;
  /** Values no rule matched and no reference row resembles. */
  unmatched: number;
}

export interface MatchCandidatesResult extends MatchCounts {
  pass: "candidates";
  leftovers: MatchLeftover[];
  /** Leftovers past `ask`, for a later run. */
  more: number;
}

export interface MatchApplyResult extends MatchCounts {
  pass: "apply";
  table: MadeTable;
  answers: MadeTable;
  /** Answers a model gave this run. */
  added: number;
  /** Rows of the table whose `into` changed this run. */
  written: number;
  /** Answers that wait for a person. */
  unsure: number;
}

export type MatchResult = MatchCandidatesResult | MatchApplyResult;

/** The most leftovers one MATCH asks a model about; the next run asks about the rest. */
export const MATCH_ASK_MAX = 300;
/** The candidates MATCH gives for one leftover. */
export const MATCH_CANDIDATES = 5;

// CHECK ───────────────────────────────────────────────────────────────────────────────────────────

/** How a format rule reads a value. `pattern` takes a GLOB pattern (`[0-9][0-9]-*`). */
export type CheckFormat = "date" | "number" | "whole number" | "email" | "phone" | "zip" | "pattern";

/**
 * A bound that is another column's value on the same row: `{ column: "issued_on" }`. `days` moves
 * it by that many days, after it or, below 0, before it: `{ column: "issued_on", days: 180 }` is
 * 180 days after the row's issued_on, and makes the range one of days.
 */
export interface ColumnBound {
  column: string;
  days?: number;
}

/**
 * A bound of a range: a number, a day written YYYY-MM-DD, a day counted from the day the check
 * runs: "today", "today-30" (30 days before it) or "today+7", or another column of the same row
 * (`ColumnBound`). The store works a counted day out each time the check runs, on the clock of the
 * person it runs for (`CheckParams.zone`), so a nightly run moves with the calendar. A string is
 * always a day: a column is named only by an object.
 */
export type CheckBound = number | string | ColumnBound;

/**
 * A condition on a row: a rule with `when` holds only on the rows that meet every condition of it.
 * The column's value is one of `values`, none of `not` (an empty cell is none of them), has a
 * value or is empty (`filled`), or is a number or a day between `min` and `max`, both included,
 * where a bound may be another column of the row. Values compare as an answer key does: trimmed,
 * in any case.
 */
export type CheckWhen =
  | { column: string; values: string[] }
  | { column: string; not: string[] }
  | { column: string; filled: boolean }
  | { column: string; min: CheckBound | null; max: CheckBound | null };

/** A rule a row must keep. `name` is the problem's words when a row breaks it; `when`, the rows it holds on. */
export type CheckRule =
  | { rule: "required"; columns: string[]; name?: string; when?: CheckWhen[] }
  | { rule: "unique"; columns: string[]; name?: string; when?: CheckWhen[] }
  | { rule: "format"; column: string; format: CheckFormat; pattern?: string; name?: string; when?: CheckWhen[] }
  | { rule: "range"; column: string; min?: CheckBound | null; max?: CheckBound | null; name?: string; when?: CheckWhen[] }
  | { rule: "one_of"; column: string; values: string[]; name?: string; when?: CheckWhen[] }
  | { rule: "reference"; column: string; table: string; to: string; name?: string; when?: CheckWhen[] };

export const CHECK_RULES_MAX = 40;
/** The most conditions one rule's `when` holds. */
export const CHECK_WHEN_MAX = 5;
/**
 * The most bounds of one rule, its conditions' included, that are other columns. Each is a day's
 * test of its own, about 4 KB of SQL, and a store runs statements of at most 100 KB: a unique rule
 * writes its conditions twice, so five such bounds there would pass that, and three leave room for
 * its other conditions.
 */
export const CHECK_COLUMN_BOUNDS_MAX = 3;

const CHECK_FORMATS: readonly CheckFormat[] = ["date", "number", "whole number", "email", "phone", "zip", "pattern"];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A day counted from today as a step or a model may write it: "today", "today-30", "Today + 7 days". */
const TODAY_WRITTEN = /^today(?:\s*([+-])\s*(\d{1,5})(?:\s*days?)?)?$/i;
/** A day counted from today as the store keeps it: "today", "today-30", "today+7". */
const TODAY_KEPT = /^today(?:([+-])(\d{1,5}))?$/;

/** workerd refuses a GLOB pattern longer than this. */
export const GLOB_PATTERN_MAX = 50;

const BOUND_WORDS =
  'A bound is a number, a day written YYYY-MM-DD, a day counted from the day the check runs (today, today-30 or today+7), or another column of the row: { "column": "issued_on" }, which days moves: { "column": "issued_on", "days": 180 }.';

/** The most days a bound counts from today or moves another column's day. */
const DAYS_MAX = 99_999;

/** Whether a bound is another column of the row. */
export const isColumnBound = (b: unknown): b is ColumnBound => !!b && typeof b === "object" && !Array.isArray(b) && typeof (b as { column?: unknown }).column === "string";

/** Another column as a bound, as a step or a model wrote it, in the store's own form. Throws words. */
function columnBoundOf(o: Record<string, unknown>): ColumnBound {
  if (typeof o.column !== "string" || !o.column.trim() || o.column.length > 200 || Object.keys(o).some((k) => k !== "column" && k !== "days")) throw new TypeError(BOUND_WORDS);
  const column = o.column.trim();
  const days = o.days === undefined || o.days === null || o.days === "" ? 0 : typeof o.days === "string" && /^\s*[+-]?\d+\s*$/.test(o.days) ? Number(o.days) : o.days;
  if (typeof days !== "number" || !Number.isInteger(days) || Math.abs(days) > DAYS_MAX) throw new TypeError(`A column's bound moves its day by a whole number of days: "days": 30 after it, or -30 before it.`);
  // No days to move is the column itself, so a rule is kept in one form however it was written.
  return days ? { column, days } : { column };
}

/** A bound as a step or a model wrote it, in the store's own form; null for none. Throws words. */
function boundOf(b: unknown): CheckBound | null {
  if (b === undefined || b === null || b === "") return null;
  if (typeof b === "number" && Number.isFinite(b)) return b;
  if (typeof b === "string") {
    const s = b.trim();
    if (ISO_DAY.test(s)) return s;
    const today = TODAY_WRITTEN.exec(s);
    if (today) return today[2] && Number(today[2]) > 0 ? `today${today[1]}${Number(today[2])}` : "today";
    if (s && Number.isFinite(Number(s))) return Number(s);
  }
  if (b && typeof b === "object" && !Array.isArray(b)) return columnBoundOf(b as Record<string, unknown>);
  throw new TypeError(BOUND_WORDS);
}

/**
 * A rule's or a condition's least and most, checked: at least one, both numbers or both days, and
 * never the column itself. Another column fits either, and a day it is moved by makes the bounds days.
 */
function boundsOf(r: Record<string, unknown>, what: string, column: string): { min: CheckBound | null; max: CheckBound | null } {
  const min = boundOf(r.min);
  const max = boundOf(r.max);
  if (min === null && max === null) throw new TypeError(`${what} gives its least value, its most, or both.`);
  const kinds = new Set([min, max].map(boundKind).filter((k) => k !== null));
  if (kinds.size > 1) throw new TypeError(`${what}'s bounds are both numbers or both days.`);
  if ([min, max].some((b) => isColumnBound(b) && b.column === column)) throw new TypeError(`${what} on ${column} compares it with itself: name another column as its bound.`);
  return { min, max };
}

/** Whether a bound is a day counted from the day the check runs. */
export const isTodayBound = (b: unknown): b is string => typeof b === "string" && TODAY_KEPT.test(b);

/** What one bound says the range compares: days, numbers, or nothing (another column, unmoved, fits both; so does no bound). */
function boundKind(b: CheckBound | null | undefined): "days" | "numbers" | null {
  if (b === undefined || b === null) return null;
  if (typeof b === "number") return "numbers";
  if (typeof b === "string") return "days";
  return b.days ? "days" : null;
}

/**
 * What a range compares, or a condition's: `days` when a bound is a day (a date, today, or another
 * column moved by days), `numbers` when a bound is a number, and `row` when every bound is another
 * column of the row as it is: then a day is compared with a day and a number with a number, row by
 * row, by what the two values read as.
 */
export type BoundsKind = "days" | "numbers" | "row";

/** What a range's bounds, or a condition's, compare (`BoundsKind`). */
export function boundsKind(min: CheckBound | null | undefined, max: CheckBound | null | undefined): BoundsKind {
  return boundKind(min) ?? boundKind(max) ?? "row";
}

/** The columns a rule's bounds name, in order. */
export const boundColumns = (min: CheckBound | null | undefined, max: CheckBound | null | undefined): string[] => [min, max].filter(isColumnBound).map((b) => b.column);

/** A day as YYYY-MM-DD, from an instant read on UTC's clock. */
const utcDay = (at: Date): string => `${String(at.getUTCFullYear()).padStart(4, "0")}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(at.getUTCDate()).padStart(2, "0")}`;

/**
 * The day `ms` falls on in `zone` (an IANA name, "America/Los_Angeles"), as YYYY-MM-DD: the day a
 * check's "today" is. With no zone, or one the clock does not know, the day in UTC.
 */
export function checkDayIn(ms: number, zone: string | null | undefined): string {
  if (zone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
      const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
      const day = `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
      if (ISO_DAY.test(day)) return day;
    } catch {
      // A zone the clock does not know: the day in UTC.
    }
  }
  return utcDay(new Date(ms));
}

/** A bound as a check compares it on `today` (YYYY-MM-DD): a counted day becomes the day it names. */
export function boundOn(b: CheckBound, today: string): CheckBound {
  const counted = typeof b === "string" ? TODAY_KEPT.exec(b) : null;
  if (!counted) return b;
  if (!counted[2]) return today;
  const [y, m, d] = today.split("-").map(Number);
  return utcDay(new Date(Date.UTC(y!, m! - 1, d! + (counted[1] === "-" ? -1 : 1) * Number(counted[2]))));
}

/** A zone as a step sent it: an IANA name, or null for UTC. */
export function zoneOf(v: unknown): string | null {
  return typeof v === "string" && v.length <= 64 && /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(v) ? v : null;
}

const WHEN_WORDS = "A condition in when names its column and one of: values (its value is one of them), not (none of them), filled (true: it has a value; false: it is empty), or min and max.";

/** One condition of a rule's `when`, checked. Throws words. */
function conditionOf(raw: unknown): CheckWhen {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(WHEN_WORDS);
  const c = raw as Record<string, unknown>;
  if (typeof c.column !== "string" || !c.column.trim() || c.column.length > 200) throw new TypeError("Each condition in when names its column.");
  const column = c.column.trim();
  const ranged = c.min !== undefined || c.max !== undefined;
  const kinds = [c.values !== undefined, c.not !== undefined, c.filled !== undefined, ranged].filter(Boolean).length;
  if (kinds !== 1) throw new TypeError(WHEN_WORDS);
  const list = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || !v.length || v.length > 500 || v.some((x) => typeof x !== "string" && typeof x !== "number")) throw new TypeError(`A condition's ${what} lists the values it means.`);
    return v.map((x) => String(x));
  };
  if (c.values !== undefined) return { column, values: list(c.values, "values") };
  if (c.not !== undefined) return { column, not: list(c.not, "not") };
  if (c.filled !== undefined) {
    if (typeof c.filled !== "boolean") throw new TypeError("A condition's filled is true (the column has a value) or false (it is empty).");
    return { column, filled: c.filled };
  }
  return { column, ...boundsOf(c, "A condition", column) };
}

/** A rule's `when` as a step or a model wrote it: one condition or a list; nothing when it has none. Throws words. */
function whenOf(raw: unknown): { when?: CheckWhen[] } {
  if (raw === undefined || raw === null) return {};
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length) return {};
  if (list.length > CHECK_WHEN_MAX) throw new TypeError(`A rule's when holds at most ${CHECK_WHEN_MAX} conditions.`);
  return { when: list.map(conditionOf) };
}

/**
 * One rule as a step or a model wrote it, in the store's own shape; a required rule over several
 * columns becomes one rule a column, so each empty cell is flagged on its own column. Throws words
 * when it is not a rule CHECK runs. A rule with no `when` is kept as it always was, so the rules a
 * store kept before conditions existed read as the same rules.
 */
export function checkRuleOf(raw: unknown): CheckRule[] {
  const rules = ruleOf(raw);
  const compared = rules[0] ? checkRuleColumnBounds(rules[0]).length : 0;
  if (compared > CHECK_COLUMN_BOUNDS_MAX) throw new TypeError(`A rule compares a value with at most ${CHECK_COLUMN_BOUNDS_MAX} other columns of the row, its conditions' included, and this one names ${compared}: give it fewer.`);
  return rules;
}

/** The bounds of a rule, its conditions' included, that are other columns of the row, in order. */
function checkRuleColumnBounds(rule: CheckRule): string[] {
  return [...(rule.rule === "range" ? boundColumns(rule.min, rule.max) : []), ...(rule.when ?? []).flatMap((c) => ("min" in c ? boundColumns(c.min, c.max) : []))];
}

function ruleOf(raw: unknown): CheckRule[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Each rule is an object that names its kind: required, unique, format, range, one_of or reference.");
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 300) : undefined;
  const named = name ? { name } : {};
  const one = (what: string): string => {
    const v = r[what];
    if (typeof v !== "string" || !v.trim() || v.length > 200) throw new TypeError(`A ${String(r.rule)} rule names its ${what === "to" ? "column of the other table" : what}.`);
    return v.trim();
  };
  const many = (): string[] => {
    const v = r.columns ?? (typeof r.column === "string" ? [r.column] : undefined);
    if (!Array.isArray(v) || !v.length || v.length > 20 || v.some((c) => typeof c !== "string" || !c.trim())) throw new TypeError(`A ${String(r.rule)} rule names its columns.`);
    return v.map((c) => String(c).trim());
  };
  switch (r.rule) {
    case "required": {
      const when = whenOf(r.when);
      return many().map((c) => ({ rule: "required", columns: [c], ...named, ...when }));
    }
    case "unique":
      return [{ rule: "unique", columns: many(), ...named, ...whenOf(r.when) }];
    case "format": {
      const format = r.format as CheckFormat;
      if (!CHECK_FORMATS.includes(format)) throw new TypeError(`A format rule's format is one of ${CHECK_FORMATS.join(", ")}.`);
      if (format === "pattern" && (typeof r.pattern !== "string" || !r.pattern || new TextEncoder().encode(r.pattern).length > GLOB_PATTERN_MAX)) throw new TypeError(`A pattern rule gives its GLOB pattern, at most ${GLOB_PATTERN_MAX} bytes.`);
      return [{ rule: "format", column: one("column"), format, ...(format === "pattern" ? { pattern: String(r.pattern) } : {}), ...named, ...whenOf(r.when) }];
    }
    case "range": {
      const column = one("column");
      const { min, max } = boundsOf(r, "A range rule", column);
      return [{ rule: "range", column, min, max, ...named, ...whenOf(r.when) }];
    }
    case "one_of": {
      const values = r.values;
      if (!Array.isArray(values) || !values.length || values.length > 500 || values.some((v) => typeof v !== "string" && typeof v !== "number")) throw new TypeError("A one_of rule lists the values it takes.");
      return [{ rule: "one_of", column: one("column"), values: values.map((v) => String(v)), ...named, ...whenOf(r.when) }];
    }
    case "reference":
      return [{ rule: "reference", column: one("column"), table: one("table"), to: one("to"), ...named, ...whenOf(r.when) }];
    default:
      throw new TypeError(`"${String(r.rule)}" is not a rule CHECK runs: required, unique, format, range, one_of or reference.`);
  }
}

/**
 * The columns of its table a rule reads: its own, the other columns its bounds name, then those its
 * `when` names with theirs. A fix of any of them can change what the rule says of the row.
 */
export function checkRuleColumns(rule: CheckRule): string[] {
  const own = "column" in rule ? [rule.column] : rule.columns;
  const bounds = rule.rule === "range" ? boundColumns(rule.min, rule.max) : [];
  const when = (rule.when ?? []).flatMap((c) => [c.column, ...("min" in c ? boundColumns(c.min, c.max) : [])]);
  return [...new Set([...own, ...bounds, ...when])];
}

/** Whether a rule counts a day from the day the check runs, in its own bounds or its `when`'s: on a new day it reads every row. */
export function ruleNamesToday(rule: CheckRule): boolean {
  const bounds = [...(rule.rule === "range" ? [rule.min, rule.max] : []), ...(rule.when ?? []).flatMap((c) => ("min" in c ? [c.min, c.max] : []))];
  return bounds.some(isTodayBound);
}

/** Every rule as a step or a model wrote them, checked; throws words for the first that is not one. */
export function checkRulesOf(raw: unknown): CheckRule[] {
  if (!Array.isArray(raw) || !raw.length) throw new TypeError("CHECK takes at least one rule.");
  const rules = raw.flatMap(checkRuleOf);
  if (rules.length > CHECK_RULES_MAX) throw new TypeError(`CHECK runs at most ${CHECK_RULES_MAX} rules at once.`);
  return rules;
}

/**
 * Words a check was given that no rule checks: as the person wrote them, and why no rule does, in a
 * few plain words. A check never drops words in silence: its answer and every later run's name them.
 */
export interface UncheckedWords {
  words: string;
  why: string;
}

/** The most unchecked words a check keeps. */
export const UNCHECKED_MAX = 40;

/** Unchecked words as a step sent them, checked: what is not words is left out. */
export function uncheckedOf(v: unknown): UncheckedWords[] {
  if (!Array.isArray(v)) return [];
  const out: UncheckedWords[] = [];
  for (const u of v) {
    const o = u && typeof u === "object" && !Array.isArray(u) ? (u as Record<string, unknown>) : null;
    const words = typeof o?.words === "string" ? o.words.trim().slice(0, 500) : "";
    if (!words) continue;
    out.push({ words, why: typeof o?.why === "string" ? o.why.trim().slice(0, 300) : "" });
  }
  return out.slice(0, UNCHECKED_MAX);
}

export interface CheckParams {
  table: string;
  /** The flags table: `<table>_flags`. */
  into: string;
  rules: CheckRule[];
  /** The columns that name a row across runs; null: `_file` and `_row` when the table has them. */
  key: string[] | null;
  /** The words the rules were written from, when they were. */
  words: string | null;
  /** The table's columns the rules were written for (JSON), so a later run reuses them only while they stay. */
  signature: string;
  /** Only these rows; null: every row. */
  changed: ChangedRows | null;
  madeBy: MadeBy;
  /** The zone (an IANA name) of the person the check runs for: its clock says which day "today" is. Null: UTC. */
  zone?: string | null;
  /** The parts of `words` no rule checks, kept with the rules so every later run's answer names them. */
  unchecked?: UncheckedWords[];
  /** The run and the step whose model wrote `rules` from `words`; null when the rules were given as rules. */
  wordsBy?: MadeBy | null;
}

export interface CheckResult {
  flags: MadeTable;
  /** The table checked and its version. */
  checked: MadeTable;
  /** Rows with an open flag, over the whole table. */
  flagged: number;
  /** Flags this run opened, and open flags it closed because their row keeps the rule now. */
  opened: number;
  closed: number;
  /** Each rule's words and the rows that broke it. */
  rules: { name: string; rows: number }[];
  /** The day "today" was, YYYY-MM-DD on the zone's clock, when a rule counts from it. */
  today?: string;
}

/** What a store keeps under `checkKey(table)`: the rules, the words and columns they were written for, and the flags. */
export interface SavedCheck {
  rules: CheckRule[];
  key: string[] | null;
  words: string | null;
  signature: string;
  flags: string;
  /** The version of the table the flags were made for: their row ids are its rowids. */
  version: number;
  madeAt: string;
  madeBy: string;
  /** The zone whose clock says which day "today" is; null or absent: UTC. A person's fix is tested on it too. */
  zone?: string | null;
  /** The day the rules that count from today last read every row; null or absent: never. */
  day?: string | null;
  /** The parts of the words no rule checks. */
  unchecked?: UncheckedWords[];
  /** The run and the step whose model wrote the rules from the words. */
  wordsBy?: MadeBy | null;
}

/** What a store keeps under `answersKey(answers)`: what the Answers table answers. */
export interface SavedAnswers {
  kind: "classify" | "match";
  table: string;
  column: string;
  into: string;
  /** CLASSIFY: the list an answer is one of. */
  classes?: string[];
  /** MATCH: the reference table, its matched column and the column taken. */
  to?: string;
  toColumn?: string;
  take?: string;
  sure: number;
}

const given = (b: CheckBound | null | undefined): b is CheckBound => b !== undefined && b !== null;

/** What a row's values read as, for the words of a range compared row by row (`BoundsKind` "row"). */
export type RowReads = "days" | "numbers";

const daysWords = (n: number): string => `${n} day${n === 1 ? "" : "s"}`;

/** A bound moved by some days, as words say it: how many, which way, and from what ("today", or the column); null for one moved by none. */
function movedBy(b: CheckBound | null | undefined): { n: number; sign: "-" | "+"; from: string } | null {
  if (isColumnBound(b)) return b.days ? { n: Math.abs(b.days), sign: b.days < 0 ? "-" : "+", from: b.column } : null;
  const counted = typeof b === "string" ? TODAY_KEPT.exec(b) : null;
  return counted?.[2] && Number(counted[2]) ? { n: Number(counted[2]), sign: counted[1] as "-" | "+", from: "today" } : null;
}

/**
 * A bound in words: the number or the day as written, a day counted from today ("30 days before
 * today"), or another column of the row ("issued_on", "180 days after issued_on").
 */
export function boundWords(b: CheckBound): string {
  const moved = movedBy(b);
  if (moved) return `${daysWords(moved.n)} ${moved.sign === "-" ? "before" : "after"} ${moved.from}`;
  if (isColumnBound(b)) return b.column;
  return isTodayBound(b) ? "today" : String(b);
}

/** Whether a range's bounds compare as days, on a row whose values read as `reads` when the range compares row by row. */
function asDays(min: CheckBound | null | undefined, max: CheckBound | null | undefined, reads: RowReads): boolean {
  const kind = boundsKind(min, max);
  return kind === "days" || (kind === "row" && reads === "days");
}

/** Values in words: "ISSUED", "ISSUED or FINALED", "A, B or C", and past six, "A, B, C, D, E or 3 more". */
function valuesWords(values: readonly string[]): string {
  if (values.length > 6) return `${values.slice(0, 5).join(", ")} or ${values.length - 5} more`;
  return values.length > 1 ? `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}` : (values[0] ?? "");
}

/**
 * A condition of a rule's `when` in words: "status_code is ISSUED or FINALED". A range of other
 * columns compared row by row says days' words, or numbers' when `reads` says so.
 */
export function conditionWords(c: CheckWhen, reads: RowReads = "days"): string {
  if ("values" in c) return `${c.column} is ${valuesWords(c.values)}`;
  if ("not" in c) return c.not.length === 1 ? `${c.column} is not ${c.not[0]}` : `${c.column} is none of ${c.not.slice(0, 6).join(", ")}${c.not.length > 6 ? " …" : ""}`;
  if ("filled" in c) return c.filled ? `${c.column} has a value` : `${c.column} is empty`;
  const days = asDays(c.min, c.max, reads);
  if (given(c.min) && given(c.max)) return `${c.column} is between ${boundWords(c.min)} and ${boundWords(c.max)}`;
  if (given(c.min)) return days ? `${c.column} is on or after ${boundWords(c.min)}` : `${c.column} is at least ${boundWords(c.min)}`;
  return days ? `${c.column} is on or before ${boundWords(c.max!)}` : `${c.column} is at most ${boundWords(c.max!)}`;
}

/** What a range rule says of a value that breaks it: below or above a number, before or after a day. */
function rangeWords(rule: Extract<CheckRule, { rule: "range" }>, reads: RowReads): string {
  const { column, min, max } = rule;
  if (given(min) && given(max)) return `${column} is outside ${boundWords(min)} to ${boundWords(max)}`;
  if (!asDays(min, max, reads)) return given(min) ? `${column} is below ${boundWords(min)}` : `${column} is above ${boundWords(max!)}`;
  if (given(min)) {
    const moved = movedBy(min);
    return moved?.sign === "-" ? `${column} is more than ${daysWords(moved.n)} before ${moved.from}` : `${column} is before ${boundWords(min)}`;
  }
  const moved = movedBy(max);
  return moved?.sign === "+" ? `${column} is more than ${daysWords(moved.n)} after ${moved.from}` : `${column} is after ${boundWords(max!)}`;
}

/**
 * A piece of a rule's words: words, or, for a range compared row by row (`BoundsKind` "row"), the
 * words of each reading, chosen by what the row's value in `column` reads as: a flag on a row of
 * days says "finaled_on is before issued_on", one on a row of numbers "paid is below fee".
 */
export type WordPiece = string | { column: string; days: string; numbers: string };

/** One piece of words, said for each reading; plain words when both say the same. */
function piece(column: string, says: (reads: RowReads) => string): WordPiece {
  const days = says("days");
  const numbers = says("numbers");
  return days === numbers ? days : { column, days, numbers };
}

/** A rule's words in pieces, which `ruleWords` joins: the store joins them per flag, by what the row's values read as. */
export function ruleWordPieces(rule: CheckRule): WordPiece[] {
  if (rule.name && rule.name.trim()) return [rule.name.trim()];
  const own = piece("column" in rule ? rule.column : (rule.columns[0] ?? ""), (reads) => ownWords(rule, reads));
  return [own, ...(rule.when ?? []).flatMap((c, i) => [i ? " and " : " while ", piece(c.column, (reads) => conditionWords(c, reads))])];
}

/**
 * A check's words for a rule: its own `name`, or what it says of a row that breaks it, with the
 * rows it holds on: "issued_on is empty while status_code is ISSUED or FINALED". A range of other
 * columns compared row by row says days' words, or numbers' when `reads` says so.
 */
export function ruleWords(rule: CheckRule, reads: RowReads = "days"): string {
  return ruleWordPieces(rule)
    .map((p) => (typeof p === "string" ? p : p[reads]))
    .join("");
}

function ownWords(rule: CheckRule, reads: RowReads): string {
  switch (rule.rule) {
    case "required":
      return rule.columns.length === 1 ? `${rule.columns[0]} is empty` : `one of ${rule.columns.join(", ")} is empty`;
    case "unique":
      return `${rule.columns.join(" and ")} is on more than one row`;
    case "format":
      return rule.format === "pattern" ? `${rule.column} does not have the form ${rule.pattern ?? ""}` : `${rule.column} does not read as ${rule.format === "whole number" ? "a whole number" : rule.format === "email" ? "an email address" : rule.format === "zip" ? "a ZIP code" : `a ${rule.format}`}`;
    case "range":
      return rangeWords(rule, reads);
    case "one_of":
      return `${rule.column} is not one of ${rule.values.slice(0, 6).join(", ")}${rule.values.length > 6 ? " …" : ""}`;
    case "reference":
      return `${rule.column} is not in ${rule.table}.${rule.to}`;
  }
}

// REVIEW ──────────────────────────────────────────────────────────────────────────────────────────

/** A flagged table's name: `<table>_flags`. */
export const flagsTableOf = (table: string): string => `${table}_flags`.slice(0, MAX_TABLE_NAME);

// READ ────────────────────────────────────────────────────────────────────────────────────────────
//
// A store reads an .xls workbook and an Access database whole inside its own object, up to a cap
// (open.ts WHOLE_FILE_CAPS). A larger one is read beside the store, by the file reader
// (apps/file-reader): a short program that store_load starts with a READ job's key. The reader
// downloads the file's bytes through the job's own route, opens them with the reader the store
// itself uses (access.ts, excel.ts), and sends the file's tables, then its rows as pages. The store
// keeps them in its bucket as the file's read-out (`ReadOut`; jobs/read.ts in the store's object),
// and LOAD opens the read-out where it would have opened the file (open.ts `openReadOut`): its
// tables, columns, row numbers and notes are the ones LOAD would have read from the file.

/** The read-out's own version: a read-out of another version is read again, never opened. */
export const READ_OUT_VERSION = 1;
/** The kinds of file read beside the store: the ones a store reads whole. */
export const READ_FORMATS = ["xls", "access"] as const;
export type ReadFormat = (typeof READ_FORMATS)[number];
/** The most files one READ reads. */
export const READ_FILES_MAX = 20;
/**
 * The most rows a page holds, and about the most bytes of its JSON in UTF-8: a page is one part of
 * the read-out, and its body stays well under the 4 MB the gateway takes (a row alone is at most
 * about 2 MB once cut as LOAD cuts it, `rowForLoad`).
 */
export const READ_PAGE_ROWS = 5_000;
export const READ_PAGE_BYTES = 1_500_000;
/** The most bytes a file's beginning holds: its tables, their columns and the notes. */
export const READ_BEGIN_BYTES_MAX = 3_500_000;
/** The most tables a file's read-out names, columns a table has, and notes it keeps; a workbook's header cell holds up to 32,767 characters. */
export const READ_TABLES_MAX = 2_000;
export const READ_COLUMNS_MAX = 1_024;
const READ_NOTES_MAX = 1_000;
const READ_NOTE_CHARS = 10_000;
const READ_COLUMN_CHARS = 32_767;

/** A text's length in UTF-8 bytes. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
/**
 * The characters a row keeps in a store: a store holds at most 2 MB in a row, and a character is at
 * most three bytes of UTF-8. LOAD cuts a longer row's values (store-object jobs/load.ts `fitRow`).
 */
export const ROW_CHARS_MAX = 600_000;

/**
 * The most characters each value of a row keeps once LOAD cuts it to ROW_CHARS_MAX, given the
 * lengths of its values: every value keeps the same most it may, the longest the row can keep.
 * Null when the row fits whole.
 */
export function rowCapOf(lengths: readonly number[], max = ROW_CHARS_MAX): number | null {
  let total = 0;
  for (const n of lengths) total += n;
  if (total <= max) return null;
  const sorted = [...lengths].sort((a, b) => a - b);
  let budget = max;
  for (let i = 0; i < sorted.length; i++) {
    const share = Math.floor(budget / (sorted.length - i));
    if (sorted[i]! > share) return share;
    budget -= sorted[i]!;
  }
  return 0;
}

/**
 * A row as the reader sends it: each value longer than LOAD would keep is cut to one character more
 * than that, so the row stays small enough for a page and LOAD still cuts it, the same values to the
 * same length, and counts each cut in the table's notes.
 */
export function rowForLoad(values: (string | null)[], extra?: Record<string, string>, max = ROW_CHARS_MAX): { values: (string | null)[]; extra?: Record<string, string> } {
  const cap = rowCapOf([...values, ...Object.values(extra ?? {})].map((v) => v?.length ?? 0), max);
  if (cap === null) return { values, ...(extra ? { extra } : {}) };
  const keep = (v: string): string => (v.length > cap + 1 ? v.slice(0, cap + 1) : v);
  return {
    values: values.map((v) => (v === null ? null : keep(v))),
    ...(extra ? { extra: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, keep(v)])) } : {}),
  };
}

/** A file a READ reads: a ready file of the store. */
export interface ReadFileParam {
  id: string;
  name: string;
}

export interface ReadParams {
  files: ReadFileParam[];
  /** The run and the step that asked: a run's Stop ends its READ as it ends its LOAD. */
  madeBy?: MadeBy;
}

/** What a READ made of each file: its read-out's tables and rows, or why it could not be read. */
export interface ReadResult {
  files: { id: string; name: string; tables: number; rows: number; unread?: string }[];
}

/**
 * `GET …/read`: where the job stands, as the reader asks first. A file whose read-out the store
 * already holds is `ended`: the reader leaves it.
 */
export interface ReadState {
  /**
   * waiting  the store runs another job first
   * taking   the store takes pages
   * done, failed
   */
  state: "waiting" | "taking" | "done" | "failed";
  error: string | null;
  files: { id: string; name: string; size: number; ended: boolean }[];
  limits: { pageRows: number; pageBytes: number; rowChars: number };
}

export const READ_LIMITS: ReadState["limits"] = { pageRows: READ_PAGE_ROWS, pageBytes: READ_PAGE_BYTES, rowChars: ROW_CHARS_MAX };

/** A file's tables, before its rows. `reader` names the reader's build: pages a store holds from another build are read again. */
export interface ReadBeginBody {
  file: number;
  reader: string;
  format: ReadFormat;
  tables: SourceTable[];
  notes: string[];
}

/** The pages of the file the store already holds: the reader sends the page after them. */
export interface ReadBeginAnswer {
  page: number;
}

/** A row in a page: its number in its file, its values, and those its reader could not place in a column. */
export type ReadRow = [n: number, values: (string | null)[]] | [n: number, values: (string | null)[], extra: Record<string, string>];

/** A page: rows of one table, in file order. Pages count from 1 across the file's tables, which come in order. */
export interface ReadPageBody {
  file: number;
  page: number;
  table: number;
  rows: ReadRow[];
}

export interface ReadPageAnswer {
  page: number;
}

/** Why a reader could not read on in a table, as its reader said: LOAD meets the same words there. */
export interface ReadStopped {
  table: number;
  reason: "damaged" | "unsupported";
  message: string;
}

/** A file's end: the rows its pages held, every table's, and where the reader could not read on, when it could not. */
export interface ReadEndBody {
  file: number;
  rows: number;
  stopped?: ReadStopped;
}

export interface ReadEndAnswer {
  /** Every file has ended: the job ends. */
  finishing: boolean;
}

/** A file the reader could not read either: why, in the reader's words, which LOAD then gives. */
export interface ReadSkipBody {
  file: number;
  reason: "damaged" | "unsupported";
  message: string;
}

export interface ReadFailBody {
  code: string;
  message: string;
}

/**
 * A table's part of a read-out: its first part, how many, and the rows they hold. A table with no
 * rows has none. `stopped`: the reader could not read on after these rows, in these words.
 */
export interface ReadOutTable {
  first: number;
  parts: number;
  rows: number;
  stopped?: { reason: "damaged" | "unsupported"; message: string };
}

/**
 * The read-out of a file, as the store keeps it beside its parts (`manifest.json`): the file it is
 * of, then the file's tables and where their rows are, or why the file could not be read.
 */
export interface ReadOut {
  v: number;
  file: { id: string; name: string; size: number };
  at: string;
  /** The reader's build that read it. */
  reader: string;
  read: { format: ReadFormat; tables: SourceTable[]; notes: string[]; prefix: string; parts: ReadOutTable[]; rows: number } | { unread: { reason: "damaged" | "unsupported"; message: string } };
}

/** A body or a job's parameters that are not what a READ takes: refused with these words. */
export class ReadShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadShapeError";
  }
}

const readRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const readText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const readCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** A READ job's parameters, checked: one to READ_FILES_MAX files, each once. */
export function readParamsOf(value: unknown): ReadParams {
  if (!readRecord(value) || !Array.isArray(value.files) || !value.files.length || value.files.length > READ_FILES_MAX) {
    throw new ReadShapeError(`A READ reads 1 to ${READ_FILES_MAX} files of its store.`);
  }
  const seen = new Set<string>();
  const files = value.files.map((f) => {
    if (!readRecord(f) || !readText(f.id, 100) || !readText(f.name, 1_000)) throw new ReadShapeError("Each file of a READ names its id and its name.");
    if (seen.has(f.id)) throw new ReadShapeError(`A READ names ${f.name} once.`);
    seen.add(f.id);
    return { id: f.id, name: f.name };
  });
  const madeBy = madeByOf(value.madeBy);
  if (!madeBy) throw new ReadShapeError("madeBy names a run and a step, or nothing.");
  return { files, ...(value.madeBy !== undefined ? { madeBy } : {}) };
}

const fileIndexOf = (v: unknown, files: number): number => {
  if (!readCount(v) || v >= files) throw new ReadShapeError("The call names a file this READ does not read.");
  return v;
};

function notesOf(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > READ_NOTES_MAX || !v.every((n) => readText(n, READ_NOTE_CHARS))) throw new ReadShapeError(`${what}'s notes are at most ${READ_NOTES_MAX} sentences.`);
  return [...(v as string[])];
}

/** A file's tables as a reader gives them, checked. */
function sourceTablesOf(v: unknown): SourceTable[] {
  if (!Array.isArray(v) || v.length > READ_TABLES_MAX) throw new ReadShapeError(`A file has at most ${READ_TABLES_MAX} tables.`);
  return v.map((t) => {
    if (!readRecord(t) || (t.name !== null && !readText(t.name, 256))) throw new ReadShapeError("Each table names itself, or is null for a file of one unnamed table.");
    if (!Array.isArray(t.columns) || t.columns.length > READ_COLUMNS_MAX) throw new ReadShapeError(`A table has at most ${READ_COLUMNS_MAX} columns.`);
    const columns = t.columns.map((c) => {
      if (!readRecord(c) || typeof c.name !== "string" || c.name.length > READ_COLUMN_CHARS || typeof c.originalType !== "string" || c.originalType.length > 1_000) throw new ReadShapeError("Each column names itself and its type.");
      return { name: c.name, originalType: c.originalType };
    });
    if (t.rowCount !== null && !readCount(t.rowCount)) throw new ReadShapeError("A table's row count is a whole number, or null.");
    return { name: t.name as string | null, columns, rowCount: t.rowCount as number | null, notes: notesOf(t.notes, "A table") };
  });
}

export function readBeginOf(value: unknown, files: number): ReadBeginBody {
  if (!readRecord(value)) throw new ReadShapeError("A file begins with its tables.");
  const file = fileIndexOf(value.file, files);
  if (!readText(value.reader, 200)) throw new ReadShapeError("A file begins by naming the reader's build.");
  if (typeof value.format !== "string" || !(READ_FORMATS as readonly string[]).includes(value.format)) throw new ReadShapeError(`A READ reads ${READ_FORMATS.join(" and ")} files.`);
  return { file, reader: value.reader, format: value.format as ReadFormat, tables: sourceTablesOf(value.tables), notes: notesOf(value.notes, "A file") };
}

/** A page, checked against its table's columns: each row is its number, one value a column, and the values past them. */
export function readPageOf(value: unknown, files: number, width: (file: number, table: number) => number | null): ReadPageBody {
  if (!readRecord(value)) throw new ReadShapeError("A page names its file, its number, its table and its rows.");
  const file = fileIndexOf(value.file, files);
  if (!readCount(value.page) || value.page < 1) throw new ReadShapeError("A page's number starts at 1.");
  if (!readCount(value.table)) throw new ReadShapeError("A page names its table.");
  const columns = width(file, value.table);
  if (columns === null) throw new ReadShapeError("The page names a table the file's beginning did not.");
  if (!Array.isArray(value.rows) || !value.rows.length || value.rows.length > READ_PAGE_ROWS) throw new ReadShapeError(`A page holds 1 to ${READ_PAGE_ROWS} rows.`);
  let last = 0;
  for (const row of value.rows) {
    if (!Array.isArray(row) || (row.length !== 2 && row.length !== 3)) throw new ReadShapeError("Each row is its number, its values, and the values past its columns.");
    const [n, values, extra] = row as unknown[];
    if (!readCount(n) || n <= last) throw new ReadShapeError("A page's rows come in file order, each by its number.");
    last = n;
    if (!Array.isArray(values) || values.length !== columns || !values.every((v) => v === null || typeof v === "string")) throw new ReadShapeError(`Each row of this table holds ${columns} values, text or null.`);
    if (row.length === 3 && (!readRecord(extra) || !Object.values(extra).every((v) => typeof v === "string"))) throw new ReadShapeError("The values past a row's columns are text, by where they were.");
  }
  return { file, page: value.page, table: value.table, rows: value.rows as ReadRow[] };
}

export function readEndOf(value: unknown, files: number): ReadEndBody {
  if (!readRecord(value)) throw new ReadShapeError("A file ends with the rows its pages held.");
  const file = fileIndexOf(value.file, files);
  if (!readCount(value.rows)) throw new ReadShapeError("rows is the rows the file's pages held.");
  if (value.stopped === undefined) return { file, rows: value.rows };
  const stopped = value.stopped;
  if (!readRecord(stopped) || !readCount(stopped.table) || (stopped.reason !== "damaged" && stopped.reason !== "unsupported") || typeof stopped.message !== "string" || !stopped.message.trim()) {
    throw new ReadShapeError("stopped names the table the reader could not read on in, why, and its words.");
  }
  return { file, rows: value.rows, stopped: { table: stopped.table, reason: stopped.reason, message: stopped.message.trim().slice(0, READ_NOTE_CHARS) } };
}

export function readSkipOf(value: unknown, files: number): ReadSkipBody {
  if (!readRecord(value)) throw new ReadShapeError("A file the reader could not read names itself and why.");
  const file = fileIndexOf(value.file, files);
  if (value.reason !== "damaged" && value.reason !== "unsupported") throw new ReadShapeError("A file is skipped as damaged or unsupported.");
  if (typeof value.message !== "string" || !value.message.trim()) throw new ReadShapeError("A skipped file says why.");
  return { file, reason: value.reason, message: value.message.trim().slice(0, 2_000) };
}

export function readFailOf(value: unknown): ReadFailBody {
  if (!readRecord(value) || typeof value.message !== "string" || !value.message.trim()) throw new ReadShapeError("A failure says why, in words.");
  const code = typeof value.code === "string" && /^[a-z_]{1,40}$/.test(value.code) ? value.code : "internal";
  return { code, message: value.message.trim().slice(0, 2_000) };
}

/** The rows a reader asks its file for at a time: the most a page holds, as LOAD asks a file for 2,000. */
const READ_BATCH_ROWS = 2_000;

/**
 * A file's pages, as the reader sends them after its beginning: each table's rows in file order, at
 * most READ_PAGE_ROWS rows and about READ_PAGE_BYTES bytes a page, each row cut as LOAD would cut it
 * (`rowForLoad`). A page holds one table's rows, and pages count from 1 across the tables. The rows
 * are asked for in LOAD's own batches, so a reader that cannot read on in a table fails where it
 * would have failed LOAD: the last item says so (`stopped`), after the rows before it, and the
 * file's later tables are not read, as LOAD would not read them.
 */
export async function* readPagesOf(file: OpenedFile, limits: ReadState["limits"] = READ_LIMITS): AsyncGenerator<{ table: number; rows: ReadRow[]; stopped?: Omit<ReadStopped, "table"> }> {
  for (let table = 0; table < file.tables.length; table++) {
    let cursor: ReadCursor | null = null;
    let rows: ReadRow[] = [];
    let bytes = 0;
    do {
      let batch;
      try {
        batch = await file.rows(table, cursor, { rows: READ_BATCH_ROWS });
      } catch (error) {
        if (!(error instanceof UnreadableFile)) throw error;
        if (rows.length) yield { table, rows };
        yield { table, rows: [], stopped: { reason: error.reason === "unsupported" ? "unsupported" : "damaged", message: error.message } };
        return;
      }
      // A workbook's and a database's readers mark no row deleted and find nothing in a batch: a
      // read-out has no place for either, so a reader that did would be read wrongly.
      if (batch.deleted || batch.notes?.length) throw new Error(`The reader of ${file.format} files said more of a batch than a read-out keeps.`);
      for (const r of batch.rows) {
        // The store says how much of a row it keeps (`limits.rowChars`), as LOAD there cuts it.
        const fit = rowForLoad(r.values, r.extra ? { ...r.extra } : undefined, limits.rowChars);
        const row: ReadRow = fit.extra ? [r.n, fit.values, fit.extra] : [r.n, fit.values];
        const size = utf8Length(readRowLine(row));
        if (rows.length && (rows.length >= limits.pageRows || bytes + size > limits.pageBytes)) {
          yield { table, rows };
          rows = [];
          bytes = 0;
        }
        rows.push(row);
        bytes += size;
      }
      cursor = batch.rows.length || JSON.stringify(batch.next) !== JSON.stringify(cursor) ? batch.next : null;
    } while (cursor);
    if (rows.length) yield { table, rows };
  }
}

/** A row of a page as a part of the read-out keeps it: one line of JSON. */
export const readRowLine = (row: ReadRow): string => JSON.stringify(row);

/** A part's line as the row LOAD reads. */
export function sourceRowOf(line: string): SourceRow {
  const [n, values, extra] = JSON.parse(line) as ReadRow | [number, (string | null)[], Record<string, string>];
  return { n, values, ...(extra ? { extra } : {}) };
}

/** A read-out as the store keeps it, when it is one of this version for this file; null otherwise. */
export function checkedReadOut(value: unknown, file: { id: string; size: number }): ReadOut | null {
  if (!readRecord(value) || value.v !== READ_OUT_VERSION || !readRecord(value.file) || value.file.id !== file.id || value.file.size !== file.size || !readRecord(value.read)) return null;
  return value as unknown as ReadOut;
}
