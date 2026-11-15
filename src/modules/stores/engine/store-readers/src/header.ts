// Which row of a sheet is its header. A town's export often opens with lines above its table: a
// title ("Brookfield Assessor - Parcel Extract (generated 03/02/2026, do not edit)"), a run
// date, a blank row. A report writer puts each in one or two cells, often merged across the table,
// and the table's own header comes after them. Every reader of sheets (xlsx.ts, excel.ts, ods.ts,
// xml.ts for Excel 2003 XML, delimited.ts) hands its first rows with values to `chooseHeader`,
// which says which of them is the header and what the table's notes say about the rows above it.
//
// The rule:
//
//   - The table's width is the number of values its rows hold most often, among the first rows
//     that hold two or more.
//   - The header is the first row with values in more than half of that width. Rows above it hold
//     fewer: a title, a date line. They are left out, and the table's notes quote them.
//   - Only when that row reads as names: text, never a number or a date, though a year alone may
//     name a column. A first full row that holds a number or a date is data, so the sheet has no
//     header under its first lines, and the sheet reads as it always did.
//   - Nothing is left out when the first row with values is full already, when no full row comes
//     within the first ROWS_ABOVE_MAX + 1 rows with values, or when no row holds two values.
//
// So a sheet whose header is its first row with values reads as it always did: same columns, same
// rows.

import type { Kind } from "./cells.js";

const NUMBERISH = /^[-+(]?\$?\s*\d[\d,]*(\.\d+)?\)?%?$|^[-+]?\.\d+$/;
const DATEISH = /^(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})([ T]\d{1,2}:\d{2}(:\d{2})?)?$/;

/** Whether a value reads as a number or a date, which a column's name never is. */
export const looksLikeData = (v: string): boolean => NUMBERISH.test(v.trim()) || DATEISH.test(v.trim());

/** A year alone ("2019"): a town's yearly columns are named by it, so it does not make a row data. */
const YEAR = /^(?:1[89]|20|21)\d\d$/;

/** A value of one of a sheet's first rows: its text, and its kind where the file types its cells (a workbook). */
export interface OpeningValue {
  text: string;
  kind?: Kind;
}

/** One of a sheet's first rows that holds values: its number as a spreadsheet shows it, and its values in column order, blanks left out. */
export interface OpeningRow {
  n: number;
  values: readonly OpeningValue[];
}

/** How many of a sheet's first rows with values a reader hands `chooseHeader`. */
export const OPENING_ROWS = 100;
/** The most rows with values left out above a header: a report's title, its dates and its parameters fit. */
export const ROWS_ABOVE_MAX = 20;
/** How many of the rows left out a note quotes, and how much of each value. */
const QUOTED_ROWS = 6;
const QUOTED_CHARS = 120;

/** Whether a value reads as a column's name: text that is not a number or a date. A year alone is a name. */
export function readsAsName(value: OpeningValue): boolean {
  const text = value.text.trim();
  if (YEAR.test(text)) return value.kind === undefined || value.kind === "text" || value.kind === "number";
  return (value.kind === undefined || value.kind === "text") && !looksLikeData(text);
}

/** The number of values a sheet's rows hold most often, among the rows that hold two or more; the larger on a tie. 0 when none does. */
export function tableWidth(rows: readonly OpeningRow[]): number {
  const counts = new Map<number, number>();
  for (const r of rows) if (r.values.length >= 2) counts.set(r.values.length, (counts.get(r.values.length) ?? 0) + 1);
  let width = 0;
  let most = 0;
  for (const [w, n] of counts) if (n > most || (n === most && w > width)) (width = w), (most = n);
  return width;
}

/** Which of a sheet's first rows is its header, and what the table's notes say about the rows above it. */
export interface HeaderChoice {
  /** The header's index among the rows given: 0 when nothing above it is left out. */
  index: number;
  /** The sentence for the table's notes when rows above the header were left out; null when none were. */
  note: string | null;
}

/**
 * The header among a sheet's first rows with values (up to OPENING_ROWS of them, in order): the
 * first row with values in more than half of the table's width, when rows with fewer values come
 * before it and it reads as names. Otherwise the first row, as a sheet has always been read.
 */
export function chooseHeader(rows: readonly OpeningRow[]): HeaderChoice {
  const width = tableWidth(rows);
  if (width < 2) return { index: 0, note: null };
  const limit = Math.min(rows.length, ROWS_ABOVE_MAX + 1);
  let at = 0;
  while (at < limit && rows[at]!.values.length * 2 <= width) at++;
  if (at === 0 || at === limit || !rows[at]!.values.every(readsAsName)) return { index: 0, note: null };
  return { index: at, note: leftOutNote(rows.slice(0, at), rows[at]!.n) };
}

const clip = (text: string): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > QUOTED_CHARS ? `${one.slice(0, QUOTED_CHARS - 1)}…` : one;
};

/**
 * What the table's notes say about the rows above its header: every row from the sheet's first to
 * the one before the header, blank ones among them, and the values of those that hold any.
 */
function leftOutNote(above: readonly OpeningRow[], header: number): string {
  const last = header - 1;
  const which = last === 1 ? "Row 1, above the header, was" : last === 2 ? "Rows 1 and 2, above the header, were" : `Rows 1 to ${last}, above the header, were`;
  const quoted = above.slice(0, QUOTED_ROWS).map((r) => r.values.map((v) => `"${clip(v.text)}"`).join(" "));
  const more = above.length - QUOTED_ROWS;
  return `${which} left out: ${quoted.join(", ")}${more > 0 ? `, and ${more} more row${more === 1 ? "" : "s"} with values` : ""}.`;
}
