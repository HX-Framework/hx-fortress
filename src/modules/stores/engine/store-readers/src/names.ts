// What a store calls the tables and columns LOAD makes from a town's files.
//
// A raw table keeps the town's own column names ("Permit No"), so a person browsing the store sees
// the headers they sent; SHAPE's tables use plain snake_case. Every raw table also has columns of
// LOAD's own: `_file` (the file's id in the store), `_row` (where the row is in the file), `_key`
// (the row's name across loads) and `_hash` (a hash of its values; row-key.ts), and, only when
// needed, `_extra`: a store table holds at most 100 columns, so LOAD keeps a file's first 90 and
// packs the rest of each row, and any values a row has past its header, into `_extra` as one JSON
// object by column name.

import { EXTRA_COLUMN, HASH_COLUMN, KEY_COLUMN, MAX_TABLE_NAME } from "./jobs.js";
import type { SourceColumn } from "./types.js";

/** Columns a raw table keeps as columns of its own; the rest go into `_extra`. */
export const MAX_KEPT_COLUMNS = 90;
export const FILE_COLUMN = "_file";
export const ROW_COLUMN = "_row";
export { EXTRA_COLUMN, HASH_COLUMN, KEY_COLUMN };

/** A column of a raw table: its name in the store, and the file's column it holds. */
export interface PlannedColumn {
  /** Its name in the store: the file's, cleaned, and unique among the table's columns. */
  name: string;
  /** Its name in the file. */
  source: string;
  originalType: string;
  /** Where its value is in a row's values. */
  index: number;
}

/** How a file's columns become a raw table's: the ones kept as columns, and the ones packed into `_extra`. */
export interface ColumnPlan {
  kept: PlannedColumn[];
  packed: PlannedColumn[];
}

/** A file's column name as a store column: no control characters, no surrounding spaces, at most 60 characters. */
export function cleanColumnName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

/**
 * SQLite's names for a row's own number: a column of one of these names would hide it, and the
 * store reads a table in that order (parking, SHAPE over ranges of rows).
 */
const ROWID_NAMES = ["rowid", "oid", "_rowid_"];

/**
 * The store's columns for a file's columns, in the file's order. SQLite compares column names
 * without case, so "Name" and "NAME" in one file become "Name" and "NAME_2"; an unnamed column
 * is "column_3", and a column the town named like one of LOAD's own, or like SQLite's row number
 * ("OID"), is renamed the same way.
 */
export function planColumns(columns: readonly SourceColumn[]): ColumnPlan {
  const taken = new Set([FILE_COLUMN, ROW_COLUMN, KEY_COLUMN, HASH_COLUMN, EXTRA_COLUMN, ...ROWID_NAMES]);
  const named = columns.map((c, index) => {
    const base = cleanColumnName(c.name) || `column_${index + 1}`;
    let name = base;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    taken.add(name.toLowerCase());
    return { name, source: c.name, originalType: c.originalType, index };
  });
  return { kept: named.slice(0, MAX_KEPT_COLUMNS), packed: named.slice(MAX_KEPT_COLUMNS) };
}

/**
 * A row's values for the kept columns, and `_extra`: the packed columns' values, any the row has
 * past the file's columns ("column_95"), and those its reader could not place (`more`), as JSON,
 * or null when there are none.
 */
export function packRow(plan: ColumnPlan, values: readonly (string | null)[], more?: Readonly<Record<string, string>>): { kept: (string | null)[]; extra: string | null } {
  const kept = plan.kept.map((c) => values[c.index] ?? null);
  let extra: Record<string, string> | null = more && Object.keys(more).length ? { ...more } : null;
  for (const c of plan.packed) {
    const v = values[c.index];
    if (v != null) (extra ??= {})[c.name] = v;
  }
  const width = plan.kept.length + plan.packed.length;
  for (let i = width; i < values.length; i++) {
    const v = values[i];
    if (v != null && v !== "") (extra ??= {})[`column_${i + 1}`] = v;
  }
  return { kept, extra: extra ? JSON.stringify(extra) : null };
}

/** Words as a table name's part: lowercase letters, digits and underscores, accents dropped. */
export function slug(words: string): string {
  return words
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** A file's name without its extension and folders: "Permits 2019" from "town/Permits 2019.csv". */
export function baseName(fileName: string): string {
  const last = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(0, dot) : last;
}

/** A file's extension, lowercase, without its dot: "csv". */
export function extensionOf(fileName: string): string {
  const last = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}


/**
 * Words as a table's name, cut at `max` characters (MAX_TABLE_NAME). With no limit (`Infinity`)
 * it is the name in full, which LOAD keeps as a cut table's second name.
 */
export function tableSlug(words: string, fallback = "file", max: number = MAX_TABLE_NAME): string {
  let s = slug(words) || fallback;
  // A name never starts with a digit or an underscore (names that start with "_" are the store's
  // own tables), nor with "sqlite_", which SQLite keeps for its own.
  if (/^[0-9]/.test(s) || s.startsWith("sqlite_")) s = `t_${s}`;
  return s.slice(0, max).replace(/_+$/, "");
}

/**
 * Each file's part of its tables' names, from the names of every file one LOAD reads: the file's
 * name ("permits_2019"), or with its extension when two of the files would make the same one
 * ("permits_csv", "permits_xlsx"). Known before any file is opened, so a LOAD names each file's
 * tables as it reaches the file.
 */
export function filePrefixes(fileNames: readonly string[], max: number = MAX_TABLE_NAME): string[] {
  const first = fileNames.map((n) => tableSlug(baseName(n), "file", max));
  return fileNames.map((n, i) => {
    const clash = first.some((other, j) => j !== i && other === first[i] && fileNames[j] !== n);
    if (!clash) return first[i]!;
    const ext = slug(extensionOf(n));
    return (ext ? `${first[i]}_${ext}` : first[i]!).slice(0, max);
  });
}

/**
 * One table's name from its file's part: the part alone for a file of one table, else the part and
 * the table's name. A name never ends the way a store marks a kept version (`__v2`) or one being
 * written (`__new`): a sheet called "v2" or "New" makes `town_data__v2_sheet`.
 */
export function tableNameIn(prefix: string, table: string | null, tablesInFile: number, max: number = MAX_TABLE_NAME): string {
  const name = tablesInFile > 1 && table ? `${prefix}__${tableSlug(table, "file", max)}`.slice(0, max) : prefix;
  return /__(?:v\d+|new)$/i.test(name) ? `${name.slice(0, max - 6)}_sheet` : name;
}

/**
 * A LOAD table's name in full, when LOAD cut it at MAX_TABLE_NAME characters: its second name, by
 * which SQL may read it ("…_application_2019_2024" for a table named "…_application_2019"). Null
 * when its name was not cut. `fullPrefix` is the file's part from `filePrefixes(names, Infinity)`.
 */
export function secondTableName(fullPrefix: string, table: string | null, tablesInFile: number, name: string): string | null {
  const full = tableNameIn(fullPrefix, table, tablesInFile, Number.POSITIVE_INFINITY);
  return full.length > MAX_TABLE_NAME && full !== name ? full : null;
}

/** A name not yet `used` (compared without case): the name, else the name and a number. */
export function unusedName(name: string, used: ReadonlySet<string>): string {
  let unique = name;
  for (let k = 2; used.has(unique.toLowerCase()); k++) unique = `${name.slice(0, MAX_TABLE_NAME - 4)}_${k}`;
  return unique;
}
