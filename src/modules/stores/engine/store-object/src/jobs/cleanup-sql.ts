// What the cleanup jobs (PROFILE, CLASSIFY, MATCH, CHECK) share inside a store: names quoted the
// store's way, what "a value" is, what reads as a number or a date, and the store's own record of
// its tables. SQL only: a store's object has no functions of its own in SQLite, so every test of a
// value is an expression SQLite runs over the whole table at once.

import { answerKeySql, type ChangedRows, changedRowsSql, dateSql, hasValueSql, isoDateSql, KEY_COLUMN, numberSql, numberValueSql, trimmedSql, wholeSql } from "../../../store-readers/src/jobs.js";
import { StoreError } from "../core.js";
import { changedSince, lastChange, readMark } from "../deltas.js";
import { parkedWords } from "../park-time.js";
import { isHiddenTable, isReservedName, PROGRAM_VERSION_RE, type SqlLike, type StoreSqlValue } from "../sql.js";

/**
 * A name in backticks. Never double quotes: SQLite in workerd reads a double-quoted name that is no
 * column as text, so a stale name would become that text in every row (sql.ts).
 */
export const ident = (name: string): string => `\`${name.replace(/`/g, "``")}\``;

/** A text literal. */
export const literal = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** A value as text without spaces, tabs or line breaks at either end; NULL stays NULL. */
export const trimmed = trimmedSql;

/** Whether a value holds anything: not NULL, and not only spaces. */
export const hasValue = hasValueSql;

/** A value's answer key, as CLASSIFY and MATCH keep answers (`answerKeySql`). */
export const keyOf = answerKeySql;

// What reads as a number or as a date is written once, in store-readers/jobs, where the api
// reads it too: whatever profiles a store's tables through its `query` door counts the same rows.
export { dateSql, isoDateSql, numberSql, wholeSql };

/** Trimmed text `v` as a number, when it reads as one. */
export const numberOf = numberValueSql;

/** Whether trimmed text `v` reads as yes or no in words (not as 1 or 0, which read as numbers). */
export const yesNoSql = (v: string): string => `(lower(${v}) IN ('y', 'n', 'yes', 'no', 'true', 'false', 't', 'f'))`;

/** Whether trimmed text `v` reads as an email address: one @, a dot after it, no spaces. */
export const emailSql = (v: string): string => `(${v} GLOB '?*@?*.?*' AND ${v} NOT GLOB '* *' AND length(${v}) - length(replace(${v}, '@', '')) = 1)`;

/** Whether trimmed text `v` reads as a US phone number: ten digits, or eleven after a 1. */
export function phoneSql(v: string): string {
  const digits = `replace(replace(replace(replace(replace(replace(${v}, '(', ''), ')', ''), '-', ''), '.', ''), ' ', ''), '+', '')`;
  return `(${digits} NOT GLOB '*[^0-9]*' AND (length(${digits}) = 10 OR (length(${digits}) = 11 AND ${digits} GLOB '1*')))`;
}

/** Whether trimmed text `v` reads as a US ZIP code: five digits, or ZIP+4. */
export const zipSql = (v: string): string => `(${v} GLOB '[0-9][0-9][0-9][0-9][0-9]' OR ${v} GLOB '[0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]')`;

/** A table's columns by name, in their order. */
export function columnsOf(sql: SqlLike, table: string): string[] {
  return sql
    .exec<{ name: string }>(`PRAGMA table_info(${ident(table)})`)
    .toArray()
    .map((c) => String(c.name));
}

export interface TableRecord {
  kind: "program" | "managed";
  version: number;
  grp: string | null;
  comment: string | null;
  made_job: string | null;
}

/** The store's record of a table (`_tables`), or null for one it has none of. */
export function tableRecord(sql: SqlLike, name: string): TableRecord | null {
  const row = sql.exec<Record<string, StoreSqlValue>>("SELECT kind, version, grp, comment, made_job FROM _tables WHERE name = ?", name).toArray()[0];
  if (!row) return null;
  return {
    kind: row.kind === "program" ? "program" : "managed",
    version: Number(row.version),
    grp: row.grp === null ? null : String(row.grp),
    comment: row.comment === null ? null : String(row.comment),
    made_job: row.made_job === null ? null : String(row.made_job),
  };
}

/** Whether this job already swapped in the newest version of `name` (a chunk cut short after its commit). */
export const committedBy = (sql: SqlLike, jobId: string, name: string): boolean => tableRecord(sql, name)?.made_job === jobId;

/** A table's handle as the store records it. */
export function handleOf(sql: SqlLike, name: string): { table: string; version: number; rows: number } {
  const row = sql.exec<{ version: number; rows: number }>("SELECT version, rows FROM _tables WHERE name = ?", name).toArray()[0];
  if (!row) throw new Error(`The store has no record of ${name}.`);
  return { table: name, version: Number(row.version), rows: Number(row.rows) };
}

/** A table a step reads: one of the store's data tables, by its exact name; refused in words otherwise. */
export function dataTable(sql: SqlLike, name: string): void {
  const exists = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?", name).toArray().length > 0;
  if (!exists && sql.exec("SELECT 1 AS x FROM _tables WHERE name = ? AND kind = 'program' AND parked IS NOT NULL", name).toArray().length) {
    throw new StoreError(409, "table_parked", parkedWords(name));
  }
  if (!exists || isReservedName(name) || isHiddenTable(name) || PROGRAM_VERSION_RE.test(name)) {
    throw new StoreError(400, "bad_request", `This store has no table "${name}".`);
  }
}

/** A column of a table, by its exact name; refused in words, with the table's columns, otherwise. */
export function columnIn(columns: readonly string[], table: string, name: string): string {
  if (columns.includes(name)) return name;
  throw new StoreError(400, "bad_request", `${table} has no column "${name}". Its columns are ${columns.slice(0, 40).join(", ")}${columns.length > 40 ? " and more" : ""}.`);
}

/**
 * Which rows of `alias` a step works on: every row, or the rows whose key columns hold one of the
 * changed keys. Compared as text on both sides, so a key read from JSON finds an INTEGER or a TEXT
 * column's value alike. The keys go in as one bound value.
 */
export function inChanged(alias: string, changed: ChangedRows | null): { where: string; params: unknown[] } {
  return changedRowsSql(alias, changed, ident);
}

/** Past this many rows written, a change is recorded whole: the steps after it read every row. */
export const CHANGE_KEYS_MAX = 100_000;

/** What an UPDATE … RETURNING `_key` AS k wrote: how many rows, and their keys up to CHANGE_KEYS_MAX. Every row is read, which ends the statement. */
export function keysWritten(cursor: Iterable<{ k: StoreSqlValue }>): { written: number; keys: string[] } {
  let written = 0;
  const keys: string[] = [];
  for (const row of cursor) if (++written <= CHANGE_KEYS_MAX) keys.push(String(row.k));
  return { written, keys };
}

/** Which rows of a table a step reads this run: a test over the alias it was asked for, and its bound values. */
export interface StepRows {
  where: string;
  params: unknown[];
  /** Every row: nothing says which changed. */
  whole: boolean;
  /** No row: nothing changed. */
  none: boolean;
}

export const EVERY_ROW: StepRows = { where: "1", params: [], whole: true, none: false };

/** The most characters of keys a statement binds: a bound value holds 2 MB, and a character at most 3 bytes. */
const KEYS_CHARS_MAX = 600_000;

/**
 * The rows of `table` that changed since `reader`'s last run, by the store's record (deltas.ts).
 * Every row on its first run, for a table with no `_key` or one a migration made, and when the
 * record cannot say. The keys go in as one bound value, so `_key`'s unique index finds the rows.
 */
export function rowsSinceLastRun(sql: SqlLike, alias: string, table: string, reader: string): StepRows {
  if (tableRecord(sql, table)?.kind !== "program" || !columnsOf(sql, table).includes(KEY_COLUMN)) return EVERY_ROW;
  const mark = readMark(sql, reader, table);
  const since = mark === null ? null : changedSince(sql, table, mark);
  if (!since) return EVERY_ROW;
  if (since.keys === 0) return { where: "0", params: [], whole: false, none: true };
  const keys = JSON.stringify(sql.exec<{ k: StoreSqlValue }>(since.keysSql, ...since.params).toArray().map((r) => r.k));
  if (keys.length > KEYS_CHARS_MAX) return EVERY_ROW;
  return { where: `${alias}.${ident(KEY_COLUMN)} IN (SELECT value FROM json_each(?))`, params: [keys], whole: false, none: false };
}

/** Whether `table` is as `reader` last read it. The store records no changes of a migration's table, so that one never is. */
export function asLastRead(sql: SqlLike, reader: string, table: string): boolean {
  if (tableRecord(sql, table)?.kind !== "program") return false;
  return readMark(sql, reader, table) === lastChange(sql, table);
}

/**
 * A turn of the event loop. A store's object reads time from `Date.now()`, which stands still through
 * synchronous code on Cloudflare: a job's chunk deadline means nothing until a turn has passed.
 */
export const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** How many rows the statement just run changed. */
export const changes = (sql: SqlLike): number => Number(sql.exec<{ n: number }>("SELECT changes() AS n").one().n);
