// From what a Store's program answers, to what the control plane is told.
//
// The Store's program answers the people who may read rows, so its answers
// hold words: a column's comment and sample values, a note in the history, the
// reason a job failed. None of that may cross to the control plane.
//
// EVERY ANSWER HERE IS BUILT, NOT FILTERED. A function below never copies an
// object of the program's and removes fields from it. It makes a new object
// and puts into it only values it has checked, one by one:
//
//   • a count is copied only when it is a whole number, zero or more
//   • a flag only when it is true or false
//   • a state only when it is a word of this module's own list
//   • a time only when it is an instant, and it is written anew here
//   • a name only when it is a `name` as an answer may hold one
//
// A string of the program's that is none of these is never copied, whatever
// field it stands in. So a field this file does not know (one a later version
// of the program adds) cannot cross: nothing reads it.
//
// The module host checks each answer against the ask's declared shape again
// before it leaves. This file is why that check passes, and it is the half
// that knows which of the program's fields are safe to read at all.
//
// WHAT THIS DOES NOT PROVE. A table's or a column's name is chosen by whoever
// made the table, and a name of up to 128 characters from the `name` alphabet
// passes. So a name can still be chosen to carry a value: the check bounds
// what a name is made of, not what it means. The control plane is told a
// Store's table and column names on purpose. SECURITY.md is to say so when
// the module is listed, as it does for the Databases module.

import { AskFailure } from "../../host/module-contract";
import { ID_MAX_CHARS, ID_PATTERN, isIsoInstant, isName } from "../../host/shape";
import { asciiUpper } from "./host/sql-text";
import {
  CATALOG_PAGE_TABLES,
  HISTORY_KINDS,
  HISTORY_LINES_MAX,
  JOB_REFUSALS,
  JOB_STATES,
  PULL_STEPS,
  PULL_TABLE_MODES,
  PULL_TABLES_MAX,
  REVIEW_KINDS,
  REVIEW_TABLES_MAX,
  TABLE_COLUMNS_MAX,
  TABLE_KINDS,
  type ColumnType,
} from "./manifest";

// ── Reading a value that may hold anything ───────────────────────────────────

type Loose = Record<string, unknown>;

/** The value's own fields, or none. An own field is read with `field`. */
function record(value: unknown): Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Loose) : {};
}

/** One own field of a record. A getter on a prototype is never run. */
function field(from: Loose, name: string): unknown {
  // `name` is a word written in this file.
  // eslint-disable-next-line security/detect-object-injection
  return Object.hasOwn(from, name) ? from[name] : undefined;
}

/** A list, or none. For a field that a value may leave out. */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A whole number, zero or more. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A name an answer may hold, and not an empty one. */
function name(value: unknown): string | undefined {
  return isName(value) && value.length > 0 ? value : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= ID_MAX_CHARS &&
    ID_PATTERN.test(value)
    ? value
    : undefined;
}

/** One word of a closed list. */
function oneOf<T extends string>(value: unknown, words: readonly T[]): T | undefined {
  return typeof value === "string" && (words as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** The latest instant a time may name: the year 9999. */
const LATEST_MS = 253_402_300_799_999;

/**
 * An instant, written anew. The program gives a time as text
 * (`2026-03-02T09:14:00.000Z`) or as milliseconds. What is sent is what
 * `Date#toISOString()` writes for that instant, never the program's own text.
 */
function time(value: unknown): string | undefined {
  let ms: number;
  if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string" && isIsoInstant(value)) {
    ms = Date.parse(value);
  } else {
    return undefined;
  }
  return Number.isSafeInteger(ms) && ms >= 0 && ms <= LATEST_MS ? new Date(ms).toISOString() : undefined;
}

/** The Store's program answered something this module cannot tell in an
 *  answer's fields. One word reaches the control plane. */
function unreadable(): never {
  throw new AskFailure("store_answer_unreadable");
}

function need<T>(value: T | undefined): T {
  return value === undefined ? unreadable() : value;
}

/** A list that an answer cannot do without. */
function needList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : unreadable();
}

/** Put `value` into `into` under `key`, when there is one. */
function put<T>(into: Record<string, unknown>, key: string, value: T | undefined): void {
  if (value === undefined) return;
  // An own property whatever the key is called. Every key is written here.
  Object.defineProperty(into, key, { value, enumerable: true, writable: true, configurable: true });
}

// ── A column's type, as one word ─────────────────────────────────────────────

/**
 * The word for a declared type.
 *
 * A column's declared type is any text (`VARCHAR(20)`, `my type`). Only the
 * letters of the text are looked at, to pick one word of a closed list; no
 * part of the text is sent.
 */
export function columnType(declared: unknown): ColumnType {
  if (typeof declared !== "string") return "other";
  // ASCII letters only, as SQLite reads a declared type: a letter past ASCII
  // never becomes one of these.
  const type = asciiUpper(declared);
  const has = (...parts: string[]): boolean => parts.some((part) => type.includes(part));
  if (has("BOOL")) return "flag";
  if (has("DATETIME", "TIMESTAMP")) return "date_time";
  if (has("DATE")) return "date";
  if (has("TIME")) return "time";
  // SQLite's own order for a declared type: INT first, then text, then bytes,
  // then numbers.
  if (has("INT")) return "whole_number";
  if (has("CHAR", "CLOB", "TEXT")) return "characters";
  if (has("BLOB", "BINARY", "BYTE")) return "binary";
  if (has("REAL", "FLOA", "DOUB", "NUMERIC", "DECIMAL", "NUMBER", "MONEY")) return "decimal";
  return "other";
}

// ── The catalog ──────────────────────────────────────────────────────────────

/**
 * One page of a Store's tables and their columns.
 *
 * `answered` is what the Store's program answered for this page: the page's
 * tables, and how many tables the Store has in all.
 *
 * THROWS `page_unknown` for a page past the last one. A Store with no table
 * has one page, with nothing on it.
 */
export function catalogAnswer(answered: unknown, page: number): Record<string, unknown> {
  const from = record(answered);
  const total = need(count(field(from, "total")));
  const tables = needList(field(from, "tables"));
  // More tables than were asked for is not this call's answer.
  if (tables.length > CATALOG_PAGE_TABLES) unreadable();
  const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_TABLES));
  if (page >= pages) throw new AskFailure("page_unknown");
  const leftOut = { tables: 0, columns: 0 };
  const items: Record<string, unknown>[] = [];
  for (const entry of tables) {
    const table = record(entry);
    const tableName = name(field(table, "name"));
    const kind = oneOf(field(table, "kind"), TABLE_KINDS);
    if (tableName === undefined || kind === undefined) {
      leftOut.tables += 1;
      continue;
    }
    // The names of the key's columns, in the key's order. Read as text to
    // find a column's place, and never sent.
    const key = list(field(table, "key"));
    const all = list(field(table, "columns"));
    const columns: Record<string, unknown>[] = [];
    for (const one of all) {
      // A table of a Store has no more columns than this. `columnCount`
      // below says how many there are, whatever is listed.
      if (columns.length >= TABLE_COLUMNS_MAX) break;
      const column = record(one);
      const columnName = name(field(column, "name"));
      if (columnName === undefined) {
        leftOut.columns += 1;
        continue;
      }
      const view: Record<string, unknown> = {
        name: columnName,
        type: columnType(field(column, "type")),
      };
      const place = key.indexOf(columnName);
      if (place >= 0) view.key = place + 1;
      columns.push(view);
    }
    items.push({
      name: tableName,
      kind,
      view: field(table, "view") === true,
      rows: count(field(table, "count")) ?? 0,
      estimated: field(table, "estimated") === true,
      version: count(field(table, "version")) ?? 0,
      columnCount: all.length,
      columns,
    });
  }
  return { page, pages, tables: total, leftOut, items };
}

// ── Stats ────────────────────────────────────────────────────────────────────

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A Store's numbers. */
export function statsAnswer(stats: unknown): Record<string, unknown> {
  const from = record(stats);
  const answer: Record<string, unknown> = {
    bytes: need(count(field(from, "bytes"))),
    tables: need(count(field(from, "tables"))),
    rows: need(count(field(from, "rows"))),
    files: need(count(field(from, "files"))),
    fileBytes: need(count(field(from, "fileBytes"))),
    busy: field(from, "busy") === true,
  };
  put(answer, "waitsUntil", time(field(from, "waitsUntil")));
  // Today's writes: the day as `YYYY-MM-DD`, the rows, the limit, and whose
  // limit it is. All four, or none.
  const writes = record(field(from, "writes"));
  const day = field(writes, "day");
  const since = typeof day === "string" && DAY_PATTERN.test(day) ? time(`${day}T00:00:00.000Z`) : undefined;
  const rows = count(field(writes, "rows"));
  const limit = count(field(writes, "limit"));
  const own = flag(field(writes, "own"));
  if (since !== undefined && rows !== undefined && limit !== undefined && own !== undefined) {
    answer.writesSince = since;
    answer.rowsWritten = rows;
    answer.writeLimit = limit;
    answer.ownLimit = own;
  }
  return answer;
}

/** What `write_limit.set` answers: the limit as it stands now. */
export function writeLimitAnswer(writes: unknown): Record<string, unknown> {
  const from = record(writes);
  return {
    writeLimit: need(count(field(from, "limit"))),
    ownLimit: need(flag(field(from, "own"))),
  };
}

// ── History ──────────────────────────────────────────────────────────────────

/** The word for somebody whose name an answer cannot hold. */
const SOMEBODY = "unknown";

/** A Store's history: when, what kind of thing, and who. A line's own words
 *  are not read. */
export function historyAnswer(history: unknown): Record<string, unknown> {
  const from = record(history);
  const lines: Record<string, unknown>[] = [];
  let leftOut = 0;
  let more = 0;
  for (const entry of needList(field(from, "events"))) {
    if (lines.length >= HISTORY_LINES_MAX) {
      more += 1;
      continue;
    }
    const event = record(entry);
    const lineId = id(field(event, "id"));
    const at = time(field(event, "at"));
    const kind = oneOf(field(event, "kind"), HISTORY_KINDS);
    if (lineId === undefined || at === undefined || kind === undefined) {
      leftOut += 1;
      continue;
    }
    const restorePoint = field(event, "restorePoint");
    lines.push({
      id: lineId,
      at,
      kind,
      // Replaced whole when it is not a name. It is never cut to fit.
      by: name(field(event, "by")) ?? SOMEBODY,
      restorable: typeof restorePoint === "string" && restorePoint.length > 0,
    });
  }
  const answer: Record<string, unknown> = { lines, leftOut, more };
  put(answer, "restorableFrom", time(field(from, "restorableFrom")));
  return answer;
}

// ── Review ───────────────────────────────────────────────────────────────────

/** How many rows wait for a person's review, table by table. */
export function reviewAnswer(review: unknown): Record<string, unknown> {
  const tables: Record<string, unknown>[] = [];
  let leftOut = 0;
  let more = 0;
  for (const entry of needList(field(record(review), "tables"))) {
    if (tables.length >= REVIEW_TABLES_MAX) {
      more += 1;
      continue;
    }
    const table = record(entry);
    const tableName = name(field(table, "table"));
    const kind = oneOf(field(table, "kind"), REVIEW_KINDS);
    const open = count(field(table, "open"));
    if (tableName === undefined || kind === undefined || open === undefined) {
      leftOut += 1;
      continue;
    }
    const view: Record<string, unknown> = {
      table: tableName,
      kind,
      open,
      stale: field(table, "stale") === true,
    };
    put(view, "flags", name(field(table, "flags")));
    tables.push(view);
  }
  return { tables, leftOut, more };
}

// ── A job ────────────────────────────────────────────────────────────────────

/** The counts a pull keeps, over all its tables and for each one. */
const PULL_COUNTS = ["read", "added", "changed", "removed", "cut"] as const;

/**
 * A job, from what the Store's program answered: `{ summary }`.
 *
 * The summary is the Store's program's own account of a job for a reader that
 * may hold no row: a state, a step, times, counts and the names of tables. Its
 * `result` and its error's words are not in it, and are not read here either.
 */
export function jobAnswer(answered: unknown): Record<string, unknown> {
  const from = record(field(record(answered), "summary"));
  const pull = field(from, "kind") === "pull";
  const answer: Record<string, unknown> = {
    job: need(id(field(from, "id"))),
    kind: pull ? "pull" : "other",
    state: need(oneOf(field(from, "state"), JOB_STATES)),
    createdAt: need(time(field(from, "createdAt"))),
    updatedAt: need(time(field(from, "updatedAt"))),
    rowsWritten: count(field(from, "rowsWritten")) ?? 0,
    leftOut: 0,
    more: 0,
  };
  put(answer, "waitsUntil", time(field(from, "waitsUntil")));
  put(answer, "refusal", oneOf(field(from, "refusal"), JOB_REFUSALS));
  put(answer, "estimatedRows", count(field(from, "estimatedRows")));
  const progress = record(field(from, "progress"));
  put(answer, "done", count(field(progress, "done")));
  put(answer, "total", count(field(progress, "total")));
  // A job of another kind is told by what every job has. Its own counts and
  // its tables wait until this module has a list for its kind.
  if (!pull) return answer;

  put(answer, "step", oneOf(field(from, "step"), PULL_STEPS));
  const counts = record(field(from, "counts"));
  for (const key of ["tables", "rows", ...PULL_COUNTS]) put(answer, key, count(field(counts, key)));
  const pulled: Record<string, unknown>[] = [];
  let leftOut = 0;
  let more = 0;
  for (const entry of list(field(from, "tables"))) {
    if (pulled.length >= PULL_TABLES_MAX) {
      more += 1;
      continue;
    }
    const table = record(entry);
    const tableName = name(field(table, "table"));
    if (tableName === undefined) {
      leftOut += 1;
      continue;
    }
    const view: Record<string, unknown> = { table: tableName };
    put(view, "version", count(field(table, "version")));
    put(view, "rows", count(field(table, "rows")));
    put(view, "mode", oneOf(field(table, "step"), PULL_TABLE_MODES));
    const own = record(field(table, "counts"));
    for (const key of PULL_COUNTS) put(view, key, count(field(own, key)));
    pulled.push(view);
  }
  answer.pulled = pulled;
  answer.leftOut = leftOut;
  answer.more = more;
  return answer;
}
