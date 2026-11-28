// The one profile of a store's table: what each column holds. Every place that measures a store's
// columns calls this: a store answers a page's ask for a table's profile with it, a store's PROFILE
// job writes it into a table, and a reader that reaches a store only through its `query` door (a
// Notebook's agent) runs the same statements there. A check of the repository refuses a second
// piece of code that measures columns (infra/scripts/one-profile.mjs).
//
// Per column: how full it is, how many different values it holds and how many once case is set
// aside, what the values read as and in which formats, the values that read as something else, the
// smallest and largest, a histogram, the most common values, the values that repeat where nearly
// every row differs, the table it points at counted in rows, and the one fact about it that
// matters most. Per table: the columns in which every row differs, and the whole rows that repeat.
//
// A column that holds personal numbers (a tax id, a date of birth, a password) is counted like the
// rest, and its values are kept back: no example, no common value, no range, no histogram
// (profile-personal.ts). What a profile holds may go to a page, a program's step or a model.
//
// It reads through `query`, one statement at a time or a few at once (`atOnce`), and calls
// `between` before each, where a store gives other calls their turn and a reader checks whether its
// ask was stopped. Each statement only reads, and stays inside a store's limits (profile-sql.ts).

import { HASH_COLUMN } from "./jobs.js";
import { readColumn, type ColumnReading, type Format, type Reads, type ShapeCount } from "./profile-formats.js";
import { LINK_SHARE, STORE_COLUMNS, countOf, linkOf, linkSearch, looksLikeKey, textOf, type LinkTable, type MeasuredLink } from "./profile-links.js";
import { personalByName, personalByShapes, type PersonalWhy } from "./profile-personal.js";
import { BINS_MAX, CENSUS_ROWS, LINK_ROWS, PROFILE_ROWS_MAX, RANGE_COLUMNS_MAX, binsSql, censusSql, linkSql, rangesSql, repeatedRowsSql, type BinsBy, type ColumnRef, type RangedColumn } from "./profile-sql.js";
import { readingCall } from "./readings.js";

export { readColumn, READS_SHARE, type ColumnReading, type Format, type Reads, type ShapeCount } from "./profile-formats.js";
export { LINK_SHARE, STORE_COLUMNS, TABLES_SEARCHED, countOf, distinctShare, linkCandidates, linkOf, linkSearch, looksLikeKey, subjectOf, textOf, wordsOf, type LinkCandidate, type LinkSearch, type LinkTable, type MeasuredLink } from "./profile-links.js";
export { personalByName, personalByShapes, type PersonalWhy } from "./profile-personal.js";
export {
  BINS_MAX,
  CENSUS_ROWS,
  COMPOUND_TERMS_MAX,
  LINK_ROWS,
  PROFILE_ROWS_MAX,
  QUICK_COLUMNS_MAX,
  QUOTE_CHARS,
  RANGE_COLUMNS_MAX,
  TOP_SHAPES,
  TOP_VALUES,
  UNMATCHED_EXAMPLES,
  binsSql,
  censusSql,
  formatsSql,
  ident,
  linkSql,
  looseOf,
  numberOf,
  quickLookSql,
  rangesSql,
  rawOf,
  repeatedRowsSql,
  shapeOf,
  tableRef,
  unionAll,
  valueOf,
  type BinsBy,
  type ColumnRef,
  type LinkEnd,
  type LinkSide,
  type RangedColumn,
} from "./profile-sql.js";

/** Columns one profile reads. A wider table is profiled in several calls, each naming its columns. */
export const PROFILE_COLUMNS_MAX = 60;
/** Links one profile measures: each is one statement over both tables. */
export const PROFILE_LINKS_MAX = 8;
/** A column is close enough to a key to report its repeats when this share of its values differ. */
const NEAR_KEY_SHARE = 0.9;
/** A column of text holds a list of values, whose spellings are worth counting, up to this many different values. */
const LIST_VALUES_MAX = 100;
/** The longest value a profile quotes, and the longest of a column's own comment. */
const VALUE_CHARS = 60;
const COMMENT_CHARS = 160;
/** The bars a histogram of days has at most by year; past it, by decade. */
const YEARS_MAX = 60;
/** What a column's range, histogram and link add to its profile at most, in characters. */
const RANGE_CHARS = 90;
const BINS_CHARS = 420;
const LINK_CHARS = 260;
/**
 * Whole rows of a table with no row hash are compared only up to this many cells (rows times
 * columns): past it the GROUP BY over every column holds more in a store's memory than it tells.
 */
const REPEATED_ROWS_CELLS_MAX = 1_000_000;

/** A table as a profile reads it: what a store's catalog says of it. A store's catalog table is one. */
export interface ProfileTable extends LinkTable {
  version?: number;
  change?: number;
  /** The table's own key, when it declares one. */
  key?: readonly string[];
  columns: readonly ProfileTableColumn[];
  /** Columns a LOAD packed into `_extra`: the file's own columns past its 90th. */
  packed?: readonly { name: string; originalType?: string }[];
}

export interface ProfileTableColumn {
  name: string;
  type?: string;
  filled?: number;
  distinct?: number;
  originalType?: string;
  comment?: string;
  /** Where a foreign key points. */
  link?: { table: string; column: string } | null;
}

/** One statement's rows, by column name. `limit` is the most rows it can answer. */
export type ProfileQuery = (sql: string, limit: number) => Promise<readonly Record<string, unknown>[]>;

/** One bar of a column's histogram. */
export interface ProfileBar {
  /** What the bar counts: a year ("2019"), a month ("2019-03"), a decade ("2010"), the smallest number of a range, or a value. */
  label: string;
  rows: number;
  /** A range's bounds: the bar holds numbers from `from` up to `to`. */
  from?: number;
  to?: number;
}

/** A column's histogram: how its values fall. */
export interface ProfileBins {
  /** By decade, year or month for days; in ranges of equal width for numbers; by value for a column of text, its most common values first. */
  by: BinsBy | "value";
  bars: ProfileBar[];
  /** Rows with a value in no bar: a column of text's other values. */
  more?: number;
}

/** The table a column points at, measured on the rows, counted in rows. */
export interface ColumnLink {
  table: string;
  column: string;
  /** How it was found: a foreign key, or the names of the two sides. */
  why: "foreign key" | "the same words" | "names the table";
  /** Rows with a value in the column. */
  rows: number;
  /** Rows whose value is one of the other column's, character for character. */
  found: number;
  /** Rows that match only once dashes, spaces, dots, slashes and case are set aside. */
  loosely: number;
  /** Rows whose value matches nothing there. */
  missing: number;
  /** A few values that match nothing, with their rows. None for a personal column. */
  examples: { value: string; rows: number }[];
  /** The share of the rows with a value that match, exactly or loosely: 0 to 1. */
  share: number;
}

/**
 * The one fact about a column that matters most before someone cleans it, as code reads it: what
 * kind of fact, and its numbers. `factWords` says it in words; a page says it in its own.
 */
export type ColumnFact =
  | { kind: "personal"; why: PersonalWhy }
  | { kind: "empty" }
  | { kind: "unlinked"; rows: number; table: string }
  | { kind: "formats"; formats: number; reads: Reads }
  | { kind: "odd"; rows: number }
  | { kind: "repeats"; values: number; rows: number }
  | { kind: "spellings"; values: number; spellings: number }
  | { kind: "gaps"; rows: number }
  | { kind: "linked"; table: string }
  | { kind: "unique" }
  | { kind: "values"; values: number };

export interface ColumnProfile {
  name: string;
  /** The file's own type for the column, when the store kept it. */
  originalType?: string;
  /** The file had more columns than a table holds, and a LOAD keeps this one packed in `_extra`. SQL reads it by its name like any other. */
  packed?: true;
  /** What the store's catalog says of the column. */
  comment?: string;
  /** Rows with a value: not empty, and not only spaces. */
  filled: number;
  /** Rows with no value, where there are any. */
  empty?: number;
  /** `filled` as a share of the rows read, 0 to 1. */
  filledShare: number;
  /** Different values. */
  distinct: number;
  /** Different values once case and doubled spaces are set aside, where that makes them fewer. */
  spellings?: number;
  reads: Reads;
  /** The share of the values that read so, 0 to 1. */
  readsShare: number;
  /** The formats the values come in, most common first. A personal column's example is the format's shape, never a value. */
  formats?: Format[];
  /** Values that do not read as the rest, and values written as a day that name no day. A personal column names none. */
  odd?: { rows: number; examples: string[] };
  /** A column of numbers or days: its smallest and largest. `unread` counts the values written as a day that name no day (February 30). */
  range?: { low: number | string; high: number | string; negative?: number; zero?: number; unread?: number };
  /** How the values fall. */
  bins?: ProfileBins;
  /** The longest value's length. */
  longest: number;
  /** The most common values. None for a personal column. */
  common: { value: string; rows: number }[];
  /** Every row read holds a different value, and none is empty. */
  unique?: true;
  /** Nearly every value differs, and these do not: values held by more than one row. */
  repeats?: { values: number; rows: number; examples: { value: string; rows: number }[] };
  /** The table it points at, counted in rows. */
  link?: ColumnLink;
  /** Its values are a person's numbers, and kept back. */
  personal?: { why: PersonalWhy };
  /** The one fact that matters most. */
  fact: ColumnFact;
  /**
   * What a statement writes to read this column as a day, YYYY-MM-DD, in every date format the
   * column holds, and as NULL where a value names no real day: as_iso_date(`Issued`). Absent for a
   * column with a format that reading does not take (a two-digit year, a month in letters, a time
   * after month/day/year): `formats` names them.
   */
  asIsoDate?: string;
  /** What a statement writes to read this column as a number, and as NULL where a value is not one: as_number(`Fee`). */
  asNumber?: string;
  /** The smallest and the largest value as text, for a column of text. None for a personal column. */
  first?: string;
  last?: string;
}

/** The table's facts come before its columns, so an answer that is cut at its end still carries them. */
export interface TableProfile {
  table: string;
  version: number;
  /** The table's change in place, as the catalog counts them: a profile is of one version and change. */
  change?: number;
  /** The table's rows, as the store's catalog counts them. */
  rows: number;
  /** The rows this profile read: all of them, or the first PROFILE_ROWS_MAX. */
  rowsRead: number;
  /**
   * Counted here, so a sentence about the table copies its numbers and counts no column itself:
   * the columns read, how many of them hold a value in every row, and the least full.
   */
  summary: { columnsRead: number; complete: number; withEmptyRows: number; leastFilled: { column: string; empty: number; filledShare: number } | null };
  /** Columns in which every row holds a different value, among the columns read. */
  keys: string[];
  /** Whole rows that repeat another row, over the table's own columns; null when they were not compared: only some columns were read, or the table is too big to compare whole rows of. */
  repeatedRows: { sets: number; rows: number } | null;
  /** Columns this call did not read, by name: past the limit of one call, or past what one answer holds. */
  columnsNotRead: string[];
  /** The columns the store added to the table (`_file`, `_row`, `_key`…), which a profile leaves out. */
  storeColumns: string[];
  columns: ColumnProfile[];
}

export interface ProfileOptions {
  /** The columns to read, by their exact names. Left out: the table's own, without the ones its store added. */
  columns?: readonly string[];
  /** The most rows a statement reads; null for every row. Left out: PROFILE_ROWS_MAX. */
  rows?: number | null;
  /** The store's tables, the one profiled among them, for the links a column's name suggests. Left out: only a foreign key's link is measured. */
  tables?: readonly LinkTable[];
  /** Whether to read histograms. Left out: yes. */
  bins?: boolean;
  /** Whether to measure links. Left out: yes. */
  links?: boolean;
  /** Statements run at once: a reader over a network runs a few, a store one. */
  atOnce?: number;
  /** Called before each statement. A store gives other calls their turn; a reader throws when its ask was stopped. */
  between?: () => Promise<void> | void;
  /** The most characters the profile may take as JSON. Reading stops at the column that would pass it; at least one column is read. */
  budget?: number;
  /** Whether a column of text carries its smallest and largest value (`first`, `last`), as a PROFILE table keeps them. Left out: no. */
  textBounds?: boolean;
}

/** A table's own columns, in the file's order, without the ones its store added: a LOAD's packed columns last. */
export const ownColumns = (table: ProfileTable): string[] => [...table.columns.map((c) => c.name).filter((name) => !STORE_COLUMNS.has(name)), ...(table.packed ?? []).map((c) => c.name)];

/** The columns a store added to a table, in order. */
export const storeColumnsOf = (table: ProfileTable): string[] => table.columns.map((c) => c.name).filter((name) => STORE_COLUMNS.has(name));

/** Whether a column of a table is one a LOAD packed into `_extra`. */
const isPacked = (table: ProfileTable, name: string): boolean => (table.packed ?? []).some((c) => c.name === name);

/** A column as the statements read it: by its name, or out of `_extra`. */
export const columnRef = (table: ProfileTable, name: string): ColumnRef => (isPacked(table, name) ? { name, packed: true } : { name });

/**
 * How a table's whole rows are compared: by the hash of its values a LOAD wrote beside each row, or
 * over its own columns while it is small; null when they are not compared.
 */
export function wholeRowsBy(table: ProfileTable, rows: number | null = PROFILE_ROWS_MAX): "hash" | "columns" | null {
  if (table.columns.some((c) => c.name === HASH_COLUMN)) return "hash";
  const own = ownColumns(table).length;
  return own > 0 && (rows === null ? table.count : Math.min(table.count, rows)) * own <= REPEATED_ROWS_CELLS_MAX ? "columns" : null;
}

const share = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0);
/** Text cut to `max` characters with "…" at the cut, never between the two halves of a character
 *  such as an emoji: a lone half is refused by a JSON column and draws as a broken character. */
const capped = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const end = max - 1;
  const last = text.charCodeAt(end - 1);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)}…`;
};

interface Census {
  rows: number;
  filled: number;
  distinct: number;
  spelled: number;
  longest: number;
  repeatedValues: number;
  repeatedRows: number;
  first: string;
  last: string;
  common: { value: string; rows: number }[];
  shapes: ShapeCount[];
}

/** A census statement's rows, read. */
function censusOf(answer: readonly Record<string, unknown>[]): Census {
  const census: Census = { rows: 0, filled: 0, distinct: 0, spelled: 0, longest: 0, repeatedValues: 0, repeatedRows: 0, first: "", last: "", common: [], shapes: [] };
  for (const row of answer) {
    const n = countOf(row.n);
    switch (row.k) {
      case "rows":
        census.rows = n;
        break;
      case "filled":
        census.filled = n;
        break;
      case "distinct":
        census.distinct = n;
        break;
      case "spelled":
        census.spelled = n;
        break;
      case "longest":
        census.longest = n;
        break;
      case "repeated":
        census.repeatedValues = n;
        census.repeatedRows = countOf(row.x);
        break;
      case "first":
        census.first = textOf(row.a);
        break;
      case "last":
        census.last = textOf(row.a);
        break;
      case "value":
        census.common.push({ value: textOf(row.a), rows: n });
        break;
      case "shape":
        census.shapes.push({ shape: textOf(row.a), rows: n, example: textOf(row.x) });
        break;
      default:
        break;
    }
  }
  // Most common first, whatever order the statement's parts answered in.
  census.common.sort((a, b) => b.rows - a.rows || a.value.localeCompare(b.value));
  census.shapes.sort((a, b) => b.rows - a.rows || a.shape.localeCompare(b.shape));
  return census;
}

/** A number as an answer carries it: whole when it is whole, else to two places. */
/** A bar's edge as a reader takes it in: two decimals, or three significant digits below one, so the
 *  bars of a column of 0.00001 to 0.0005 are not all edged at 0. */
const tidy = (value: number): number => (Number.isInteger(value) ? value : Math.abs(value) >= 1 ? Math.round(value * 100) / 100 : Number(value.toPrecision(3)));

const isDay = (reads: Reads): boolean => reads === "date" || reads === "date and time";
const isNumeric = (reads: Reads): boolean => reads === "whole number" || reads === "number" || reads === "money";

/** Whether the store keeps a column's values as numbers, so a statement can add them up as they are. */
// SQLite's own rule for a declared type that keeps numbers: it names INT, REAL, FLOA, DOUB, NUM or
// DEC anywhere (BIGINT, DOUBLE PRECISION, DECIMAL(10,2)).
const keptAsNumbers = (type: string | undefined): boolean => /INT|REAL|FLOA|DOUB|NUM|DEC/i.test(type ?? "");

/** One column, read: its census and what its values are written as. Its range, histogram and link are read after. */
interface ReadColumn {
  name: string;
  census: Census;
  reading: ColumnReading;
  personal: PersonalWhy | null;
  /** How its smallest and largest are read; null for a column with neither. */
  ranged: RangedColumn["kind"] | null;
}

function readOf(name: string, census: Census): ReadColumn {
  const reading = readColumn({ filled: census.filled, distinct: census.distinct, shapes: census.shapes, common: census.common });
  const personal = personalByName(name) ?? personalByShapes(census.shapes, census.filled);
  // A column of days has a range when the store's reading covers every format it holds.
  const ranged = isNumeric(reading.reads) ? "number" : isDay(reading.reads) && reading.isoReadable ? "day" : null;
  return { name, census, reading, personal, ranged };
}

type Range = NonNullable<ColumnProfile["range"]>;

/** A column's range as the statement read it, with one value written as a day that names no day, if any. */
interface ReadRange {
  range: Range;
  unreadExample: string | null;
}

/** Statements over `items`, `atOnce` at a time, in their order. */
async function inTurns<T, R>(items: readonly T[], atOnce: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const lane = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const at = next++;
      try {
        out[at] = await work(items[at]!);
      } catch (error) {
        // The caller hears of the first failure; the other lanes start nothing more.
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(atOnce, items.length)) }, lane));
  return out;
}

/** The ranges of the columns read as numbers or days, by column name: one statement per RANGE_COLUMNS_MAX of them. */
async function rangesOf(run: Runner, table: ProfileTable, columns: readonly ReadColumn[], rows: number | null): Promise<Map<string, ReadRange>> {
  const ranged: RangedColumn[] = columns.flatMap((c) => (c.ranged ? [{ ...columnRef(table, c.name), kind: c.ranged }] : []));
  const out = new Map<string, ReadRange>();
  for (let at = 0; at < ranged.length; at += RANGE_COLUMNS_MAX) {
    const group = ranged.slice(at, at + RANGE_COLUMNS_MAX);
    const [row] = await run(rangesSql(table.name, group, rows), 1);
    group.forEach((column, i) => {
      if (column.kind === "day") {
        const first = row?.[`first${i}`];
        const unread = countOf(row?.[`unread${i}`]);
        const example = row?.[`unreadx${i}`];
        if (first === null || first === undefined) {
          if (unread > 0) out.set(column.name, { range: { low: "", high: "", unread }, unreadExample: example === null || example === undefined ? null : textOf(example) });
          return;
        }
        out.set(column.name, { range: { low: textOf(first), high: textOf(row?.[`last${i}`]), ...(unread > 0 ? { unread } : {}) }, unreadExample: example === null || example === undefined ? null : textOf(example) });
        return;
      }
      const low = row?.[`low${i}`];
      if (low === null || low === undefined) return;
      const negative = countOf(row?.[`negative${i}`]);
      const zero = countOf(row?.[`zero${i}`]);
      // The smallest and largest as the store holds them: a tax rate of 0.0725 is not 0.07.
      out.set(column.name, { range: { low: countOf(low), high: countOf(row?.[`high${i}`]), ...(negative > 0 ? { negative } : {}), ...(zero > 0 ? { zero } : {}) }, unreadExample: null });
    });
  }
  return out;
}

/** How a column of days spanning these years is best counted. */
function dayBinsBy(first: string, last: string): BinsBy {
  const from = Number(first.slice(0, 4));
  const to = Number(last.slice(0, 4));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "year";
  const months = (to - from) * 12 + (Number(last.slice(5, 7)) - Number(first.slice(5, 7)));
  if (months < 24) return "month";
  return to - from + 1 <= YEARS_MAX ? "year" : "decade";
}

/** The periods from the day `first` to the day `last`, as day bins name them: "2019-03" by month,
 *  "2019" by year, "2010" by decade. Empty when the days are not written as YYYY-MM-DD. */
function dayKeys(by: BinsBy, first: string, last: string): string[] {
  const from = Number(first.slice(0, 4));
  const to = Number(last.slice(0, 4));
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return [];
  // Four digits, as the store's statement writes a year: the year 24 is "0024".
  const year = (y: number): string => String(y).padStart(4, "0");
  if (by === "month") {
    const start = from * 12 + Number(first.slice(5, 7)) - 1;
    const end = to * 12 + Number(last.slice(5, 7)) - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return [];
    return Array.from({ length: end - start + 1 }, (_, i) => `${year(Math.floor((start + i) / 12))}-${String(((start + i) % 12) + 1).padStart(2, "0")}`);
  }
  if (by === "decade") {
    const first10 = Math.floor(from / 10) * 10;
    return Array.from({ length: Math.floor(to / 10) - Math.floor(from / 10) + 1 }, (_, i) => year(first10 + i * 10));
  }
  return Array.from({ length: to - from + 1 }, (_, i) => year(from + i));
}

/** Equal bars from `low` to `high`: as many as there are whole numbers between them when that is fewer, else BINS_MAX. */
function numberBars(low: number, high: number, whole: boolean): { low: number; high: number; count: number } {
  if (!(high > low)) return { low, high, count: 1 };
  const count = whole && high - low + 1 <= BINS_MAX ? high - low + 1 : BINS_MAX;
  // A whole number per bar ends each bar one past its number, so the last number has its own bar.
  return whole && high - low + 1 <= BINS_MAX ? { low, high: high + 1, count } : { low, high, count };
}

/** One column's histogram: from its range for days and numbers, from its most common values for text. */
async function binsOf(run: Runner, table: ProfileTable, column: ReadColumn, range: Range | undefined, rows: number | null): Promise<ProfileBins | undefined> {
  if (column.personal || column.census.filled === 0) return undefined;
  if (column.ranged === "day" && range && typeof range.low === "string" && range.low) {
    const by = dayBinsBy(range.low, String(range.high));
    const answer = await run(binsSql(table.name, columnRef(table, column.name), by, rows), 200);
    // Every period from the first day to the last has its bar, an empty one too: a month with no
    // rows is a gap the histogram shows, never two months drawn side by side.
    const counted = new Map(answer.map((row) => [textOf(row.b), countOf(row.n)]));
    const keys = [...new Set([...dayKeys(by, range.low, String(range.high)), ...counted.keys()])].sort();
    return { by, bars: keys.map((label) => ({ label, rows: counted.get(label) ?? 0 })) };
  }
  if (column.ranged === "number" && range && typeof range.low === "number" && typeof range.high === "number" && Number.isFinite(range.low) && Number.isFinite(range.high)) {
    const whole = column.reading.reads === "whole number";
    const highest = range.high;
    const bars = numberBars(range.low, highest, whole);
    const answer = await run(binsSql(table.name, columnRef(table, column.name), "range", rows, bars), BINS_MAX + 1);
    const width = bars.high > bars.low ? (bars.high - bars.low) / bars.count : 0;
    const byBar = new Map(answer.map((row) => [countOf(row.b), countOf(row.n)]));
    return {
      by: "range",
      bars: Array.from({ length: bars.count }, (_, i) => {
        const from = tidy(bars.low + i * width);
        const to = tidy(i === bars.count - 1 ? highest : bars.low + (i + 1) * width);
        return { label: String(from), rows: byBar.get(i) ?? 0, from, to };
      }),
    };
  }
  // A column of text, or of numbers or days written so that no range reads them: its most common values.
  const common = column.census.common;
  if (common.length === 0) return undefined;
  const counted = common.reduce((sum, c) => sum + c.rows, 0);
  const more = column.census.filled - counted;
  return { by: "value", bars: common.map((c) => ({ label: capped(c.value, VALUE_CHARS), rows: c.rows })), ...(more > 0 ? { more } : {}) };
}

/** The columns read whose link to another table is worth measuring: a foreign key's, else the first a name suggests. */
function linksToMeasure(table: ProfileTable, read: readonly ReadColumn[], tables: readonly LinkTable[] | undefined): { from: ReadColumn; to: { table: string; column: string }; why: ColumnLink["why"] }[] {
  const out: { from: ReadColumn; to: { table: string; column: string }; why: ColumnLink["why"] }[] = [];
  const candidates = tables ? linkSearch(tables).candidates.filter((c) => c.from.table === table.name) : [];
  for (const column of read) {
    if (column.census.filled === 0) continue;
    const meta = table.columns.find((c) => c.name === column.name);
    if (meta?.link) {
      out.push({ from: column, to: meta.link, why: "foreign key" });
      continue;
    }
    const found = candidates.find((c) => c.from.column === column.name);
    if (found) out.push({ from: column, to: found.to, why: found.why });
  }
  return out.slice(0, PROFILE_LINKS_MAX);
}

/** The links of the columns read, measured on the rows, by column name. A link a name suggested counts only when enough of its rows match. */
async function linksOf(run: Runner, table: ProfileTable, read: readonly ReadColumn[], tables: readonly LinkTable[] | undefined, rows: number | null, atOnce: number): Promise<Map<string, ColumnLink>> {
  const wanted = linksToMeasure(table, read, tables);
  const packedIn = (name: string, column: string): boolean => {
    const t = tables?.find((x) => x.name === name) as ProfileTable | undefined;
    return !!t?.packed?.some((c) => c.name === column);
  };
  const measured = await inTurns(wanted, atOnce, async (w) => {
    const from = { table: table.name, column: w.from.name, ...(isPacked(table, w.from.name) ? { packed: true } : {}) };
    const to = { table: w.to.table, column: w.to.column, ...(packedIn(w.to.table, w.to.column) ? { packed: true } : {}) };
    const link: MeasuredLink = linkOf({ table: table.name, column: w.from.name }, w.to, await run(linkSql(from, to, rows), LINK_ROWS));
    return { w, link };
  });
  const out = new Map<string, ColumnLink>();
  for (const { w, link } of measured) {
    if (w.why !== "foreign key" && link.share < LINK_SHARE) continue;
    const filled = link.rows - link.empty;
    out.set(w.from.name, {
      table: w.to.table,
      column: w.to.column,
      why: w.why,
      rows: filled,
      found: link.matched,
      loosely: link.matchedLoosely,
      missing: link.unmatched,
      examples: w.from.personal ? [] : link.unmatchedExamples.map((e) => ({ value: capped(e.value, VALUE_CHARS), rows: e.rows })),
      share: link.share,
    });
  }
  return out;
}

/**
 * How many ways a column's values are written, as its fact counts them. A text column's shapes that
 * differ only in their letters are one way: permit numbers `ME-2024-00001` and `BP-2024-00001` are
 * written alike, where `14-106-014` and `14106014` are not.
 */
function writtenWays(column: Pick<ColumnProfile, "formats" | "reads">): number {
  const formats = column.formats ?? [];
  if (column.reads === "text") return new Set(formats.map((f) => f.name.replace(/\p{L}/gu, "A"))).size;
  // A number with a decimal point and one without are written alike: 10 and 10.25 are both plain
  // numbers, and 1,250 and 1,250.50 both carry commas. A dollar sign is another way.
  return new Set(formats.map((f) => (f.name === "with a decimal point" ? "digits only" : f.name.replace(/ and a decimal point$/, "")))).size;
}

/** The one fact about a column that matters most, in the order a person cleaning it would want them. */
export function factOf(column: Omit<ColumnProfile, "fact">, keyLike: boolean): ColumnFact {
  if (column.personal) return { kind: "personal", why: column.personal.why };
  if (column.filled === 0) return { kind: "empty" };
  if (column.link && column.link.missing > 0) return { kind: "unlinked", rows: column.link.missing, table: column.link.table };
  const ways = writtenWays(column);
  if (ways >= 2 && column.reads !== "yes or no") return { kind: "formats", formats: ways, reads: column.reads };
  if (column.odd && column.odd.rows > 0) return { kind: "odd", rows: column.odd.rows };
  if (column.repeats && keyLike) return { kind: "repeats", values: column.repeats.values, rows: column.repeats.rows };
  if (column.spellings !== undefined && column.distinct <= LIST_VALUES_MAX) return { kind: "spellings", values: column.distinct, spellings: column.spellings };
  if ((column.empty ?? 0) > 0) return { kind: "gaps", rows: column.empty! };
  if (column.link) return { kind: "linked", table: column.link.table };
  if (column.unique) return { kind: "unique" };
  return { kind: "values", values: column.distinct };
}

const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A column's fact in English words, for an answer a program or a model reads. A page says it in its own words. */
export function factWords(fact: ColumnFact): string {
  switch (fact.kind) {
    case "personal":
      return `Holds personal numbers (${fact.why}): its values are kept back`;
    case "empty":
      return "No row holds a value";
    case "unlinked":
      return `${count(fact.rows, "row")} find no row in ${fact.table}`;
    case "formats":
      return isDay(fact.reads) ? `${fact.formats} date formats` : `${fact.formats} formats`;
    case "odd":
      return `${count(fact.rows, "value")} read as something else`;
    case "repeats":
      return `${count(fact.values, "value")} repeat, on ${count(fact.rows, "row")}`;
    case "spellings":
      return `${count(fact.values, "value")}, ${fact.spellings.toLocaleString("en-US")} once case is set aside`;
    case "gaps":
      return `${count(fact.rows, "row")} empty`;
    case "linked":
      return `Every row finds its row in ${fact.table}`;
    case "unique":
      return "Every value differs";
    case "values":
      return count(fact.values, "value");
  }
}

/** What a PROFILE job's table says a column reads as: the words a store kept before formats were counted. */
export function profileTypeOf(reads: Reads): "empty" | "whole number" | "number" | "date" | "yes/no" | "text" {
  switch (reads) {
    case "money":
      return "number";
    case "date and time":
      return "date";
    case "yes or no":
      return "yes/no";
    default:
      return reads;
  }
}

function columnOf(table: ProfileTable, read: ReadColumn, extra: { range?: ReadRange; bins?: ProfileBins; link?: ColumnLink; textBounds?: boolean }): ColumnProfile {
  const { name, census, reading, personal } = read;
  const packed = isPacked(table, name);
  // A packed column is in no column of the table: the catalog keeps only its name and the file's type.
  const meta = packed ? undefined : table.columns.find((c) => c.name === name);
  const originalType = packed ? table.packed?.find((c) => c.name === name)?.originalType : meta?.originalType;
  const unique = census.rows > 0 && census.filled === census.rows && census.distinct === census.rows;
  const nearKey = !unique && census.filled > 0 && census.repeatedValues > 0 && census.distinct / census.filled >= NEAR_KEY_SHARE;
  const quoted = (c: { value: string; rows: number }): { value: string; rows: number } => ({ value: capped(c.value, VALUE_CHARS), rows: c.rows });
  // A column a file was loaded into is text, whatever it holds: its numbers need reading as numbers.
  // A column the store keeps as numbers, every value a plain number, adds up as it is.
  const plain = keptAsNumbers(meta?.type) && reading.odd.rows === 0 && reading.formats.every((f) => f.name === "digits only" || f.name === "with a decimal point");
  // A value written as a day that names no day reads as something else too.
  const unread = extra.range?.range.unread ?? 0;
  const oddRows = reading.odd.rows + unread;
  const oddExamples = personal ? [] : [...reading.odd.examples, ...(extra.range?.unreadExample ? [extra.range.unreadExample] : [])].slice(0, 3).map((e) => capped(e, VALUE_CHARS));
  const range = extra.range && !personal && extra.range.range.low !== "" ? extra.range.range : undefined;
  const profile: Omit<ColumnProfile, "fact"> = {
    name,
    ...(originalType ? { originalType } : {}),
    ...(packed ? { packed: true as const } : {}),
    ...(meta?.comment ? { comment: capped(meta.comment, COMMENT_CHARS) } : {}),
    filled: census.filled,
    ...(census.rows > census.filled ? { empty: census.rows - census.filled } : {}),
    filledShare: share(census.filled, census.rows),
    distinct: census.distinct,
    ...(census.spelled > 0 && census.spelled < census.distinct ? { spellings: census.spelled } : {}),
    reads: reading.reads,
    readsShare: Math.round(reading.share * 10_000) / 10_000,
    // A personal column's formats keep their shape and none of their letters or digits: a text
    // pattern's name is its values' shape, so it is masked as its example is.
    ...(reading.formats.length > 0
      ? {
          formats: reading.formats.map((f) => ({
            name: capped(personal && reading.reads === "text" ? maskedText(f.name) : f.name, VALUE_CHARS),
            rows: f.rows,
            example: capped(personal ? maskedText(f.example) : f.example, VALUE_CHARS),
          })),
        }
      : {}),
    ...(oddRows > 0 ? { odd: { rows: oddRows, examples: oddExamples } } : {}),
    ...(range ? { range } : {}),
    ...(extra.bins ? { bins: extra.bins } : {}),
    longest: census.longest,
    common: personal ? [] : census.common.slice(0, 5).map(quoted),
    ...(unique ? { unique: true as const } : {}),
    ...(nearKey ? { repeats: { values: census.repeatedValues, rows: census.repeatedRows, examples: personal ? [] : census.common.filter((c) => c.rows > 1).slice(0, 3).map(quoted) } } : {}),
    ...(extra.link ? { link: extra.link } : {}),
    ...(personal ? { personal: { why: personal } } : {}),
    ...(read.ranged === "day" ? { asIsoDate: readingCall("as_iso_date", name) } : {}),
    ...(read.ranged === "number" && !plain ? { asNumber: readingCall("as_number", name) } : {}),
    // A column with no range of numbers or days (text, yes or no, days in a format no reading takes)
    // keeps its first and last values in text order, where they are asked for.
    ...(extra.textBounds && !personal && !range && census.first ? { first: capped(census.first, VALUE_CHARS), last: capped(census.last, VALUE_CHARS) } : {}),
  };
  // A column whose values should name one row each: its name ends as a key's does, or it is the table's key.
  const keyLike = looksLikeKey(name) || (table.key?.includes(name) ?? false);
  return { ...profile, fact: factOf(profile, keyLike) };
}

/** A value as a personal column's format shows it: every digit as 9, a capital as A and any other
 *  letter as a, so "Summer2024!" reads "Aaaaaa9999!". */
function maskedText(value: string): string {
  return value.replace(/[0-8]/g, "9").replace(/\p{L}/gu, (ch) => (/\p{Lu}/u.test(ch) ? "A" : "a"));
}

type Runner = (sql: string, limit: number) => Promise<readonly Record<string, unknown>[]>;

/**
 * The profile of one table: its columns in order, up to PROFILE_COLUMNS_MAX and up to `budget`. The
 * columns it did not reach are named in `columnsNotRead`.
 */
export async function profileTable(query: ProfileQuery, table: ProfileTable, opts: ProfileOptions = {}): Promise<TableProfile> {
  const rows = opts.rows === undefined ? PROFILE_ROWS_MAX : opts.rows;
  const atOnce = Math.max(1, opts.atOnce ?? 1);
  const run: Runner = async (sql, limit) => {
    await opts.between?.();
    return query(sql, limit);
  };
  const own = ownColumns(table);
  const wanted = opts.columns ?? own;
  const facts = { table: table.name, version: table.version ?? 1, ...(table.change !== undefined ? { change: table.change } : {}), rows: table.count, storeColumns: storeColumnsOf(table) };
  const binsWanted = opts.bins !== false;
  const linksWanted = opts.links !== false;
  // Room for the columns: the budget less the table's facts with every wanted column named as not read.
  const room =
    (opts.budget ?? Number.POSITIVE_INFINITY) -
    JSON.stringify({ ...facts, rowsRead: table.count, summary: { columnsRead: 100, complete: 100, withEmptyRows: 100, leastFilled: { column: "x".repeat(64), empty: table.count, filledShare: 0.1234 } }, keys: [], repeatedRows: { sets: table.count, rows: table.count }, columnsNotRead: wanted, columns: [] }).length;

  // The columns that may point at another table: a foreign key's, or one a name suggests.
  const mayLink = new Set<string>(linksWanted ? [...table.columns.filter((c) => c.link).map((c) => c.name), ...(opts.tables ? linkSearch(opts.tables).candidates.filter((c) => c.from.table === table.name).map((c) => c.from.column) : [])] : []);
  const read: ReadColumn[] = [];
  let used = 0;
  let full = false;
  const candidates = wanted.slice(0, PROFILE_COLUMNS_MAX);
  for (let at = 0; at < candidates.length && !full; at += atOnce) {
    const group = await inTurns(candidates.slice(at, at + atOnce), atOnce, async (name) => readOf(name, censusOf(await run(censusSql(table.name, columnRef(table, name), rows), CENSUS_ROWS))));
    for (const column of group) {
      // A key is named twice: in its own profile and among the table's keys.
      const sized = columnOf(table, column, { textBounds: opts.textBounds === true });
      const chars =
        JSON.stringify(sized).length + 1 + (column.ranged ? RANGE_CHARS : 0) + (binsWanted && !column.personal ? BINS_CHARS : 0) + (mayLink.has(column.name) ? LINK_CHARS : 0) + column.name.length + 3;
      if (read.length > 0 && used + chars > room) {
        full = true;
        break;
      }
      read.push(column);
      used += chars;
    }
  }

  const ranges = await rangesOf(run, table, read, rows);
  const bins = new Map<string, ProfileBins>();
  if (binsWanted) {
    const binned = await inTurns(read, atOnce, async (column) => ({ name: column.name, bins: await binsOf(run, table, column, ranges.get(column.name)?.range, rows) }));
    for (const b of binned) if (b.bins) bins.set(b.name, b.bins);
  }
  const links = linksWanted ? await linksOf(run, table, read, opts.tables, rows, atOnce) : new Map<string, ColumnLink>();
  const columns = read.map((column) =>
    columnOf(table, column, {
      textBounds: opts.textBounds === true,
      ...(ranges.has(column.name) ? { range: ranges.get(column.name)! } : {}),
      ...(bins.has(column.name) ? { bins: bins.get(column.name)! } : {}),
      ...(links.has(column.name) ? { link: links.get(column.name)! } : {}),
    }),
  );
  let repeatedRows: TableProfile["repeatedRows"] = null;
  // Compared over the table's own values: the store's `_row` differs in every row of a file. A
  // table a LOAD made is compared by its rows' hash, any other over its own columns while it is small.
  const by = opts.columns || own.length === 0 ? null : wholeRowsBy(table, rows);
  if (by) {
    const [row] = await run(repeatedRowsSql(table.name, own, by === "hash", rows), 1);
    repeatedRows = { sets: countOf(row?.sets), rows: countOf(row?.rows) };
  }
  const rowsRead = read[0]?.census.rows ?? (rows === null ? table.count : Math.min(table.count, rows));
  const answerOf = (kept: readonly ColumnProfile[]): TableProfile => {
    const done = new Set(kept.map((c) => c.name));
    // By the count of empty rows, never by the share: a share is rounded, so on a big table two
    // columns with 13 and 14 empty rows show the same share.
    const notFull = kept.filter((c) => (c.empty ?? 0) > 0).sort((a, b) => (b.empty ?? 0) - (a.empty ?? 0) || a.name.localeCompare(b.name));
    const least = notFull[0];
    return {
      ...facts,
      rowsRead,
      summary: { columnsRead: kept.length, complete: kept.length - notFull.length, withEmptyRows: notFull.length, leastFilled: least ? { column: least.name, empty: least.empty ?? 0, filledShare: least.filledShare } : null },
      keys: kept.filter((c) => c.unique).map((c) => c.name),
      repeatedRows,
      columnsNotRead: wanted.filter((name) => !done.has(name)),
      columns: [...kept],
    };
  };
  // The room taken above for a column's range, histogram and link is a guess until they are read:
  // the finished answer is held to the budget, its last columns named as not read until it fits.
  const kept = [...columns];
  let answer = answerOf(kept);
  while (opts.budget !== undefined && kept.length > 1 && JSON.stringify(answer).length > opts.budget) {
    kept.pop();
    answer = answerOf(kept);
  }
  return answer;
}
