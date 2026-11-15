// Excel 97-2003 workbooks (.xls, and Excel 5 and 95 with their code pages), read whole with SheetJS
// (vendor/sheetjs): each sheet with any values is one table. SheetJS keeps every cell as an object,
// about 24 MB of heap for each MB of .xls, so open.ts caps these at 3 MB. An .xlsx is read as a
// stream instead (xlsx.ts), and reads the same values the same way.
//
// A sheet's header is chosen among its first rows with values (header.ts): its first row with a
// value, unless a title and blank rows sit above the table, which are left out. The rows under it
// are its rows, numbered as Excel shows them, and a blank row is skipped. A value is the cell's
// own, not its displayed text: a number as it is held, rounded to the 15 digits Excel shows; a
// date "2019-01-07" or "2019-01-07 09:30:00"; a yes/no "true" or "false"; an error "#N/A". Two
// kinds of number keep the text Excel shows: one in a zero-padded format ("00000" for a ZIP code,
// "000-00-0000"), whose leading zeros are its meaning, and one in the text format "@". A column's
// type in the catalog is the kind of value its cells hold: "number", "date", "text", "yes/no", or
// "mixed (…)".

import * as cptable from "xlsx/dist/cpexcel.full.mjs";
import * as XLSX from "xlsx";
import { ERROR_TEXT, excelNumber, type Kind, kindOf, ZERO_PADDED } from "./cells.js";
import { chooseHeader, OPENING_ROWS, type OpeningRow } from "./header.js";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SourceColumn, type SourceRow, type SourceTable, UnreadableFile } from "./types.js";

XLSX.set_cptable(cptable);

interface Cell {
  t: "b" | "e" | "n" | "d" | "s" | "z";
  v?: unknown;
  w?: string;
  z?: string;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

function dateText(v: number, date1904: boolean): string | null {
  const d = XLSX.SSF.parse_date_code(v, { date1904 }) as { y: number; m: number; d: number; H: number; M: number; S: number } | null;
  if (!d) return null;
  // A time with no date (a value under one day in a time format) is the time alone.
  if (v < 1 && v >= 0 && d.y <= 1900) return `${pad(d.H)}:${pad(d.M)}:${pad(d.S)}`;
  const day = `${pad(d.y, 4)}-${pad(d.m)}-${pad(d.d)}`;
  return d.H || d.M || d.S ? `${day} ${pad(d.H)}:${pad(d.M)}:${pad(d.S)}` : day;
}

/** A cell's value as text and the kind of value it is; null for a blank cell. */
function cellValue(cell: Cell | undefined, date1904: boolean): { text: string; kind: Kind } | null {
  if (!cell || cell.t === "z" || cell.v == null) return null;
  switch (cell.t) {
    case "s": {
      const text = String(cell.v);
      return text.trim() === "" ? null : { text, kind: "text" };
    }
    case "b":
      return { text: cell.v ? "true" : "false", kind: "yes/no" };
    case "e":
      // SheetJS keeps an error's code, not its text, when it is asked for no cell text.
      return { text: cell.w ?? (typeof cell.v === "number" ? ERROR_TEXT[cell.v] : undefined) ?? "#ERROR", kind: "error" };
    case "d": {
      const at = cell.v as Date;
      const day = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
      const time = at.getUTCHours() || at.getUTCMinutes() || at.getUTCSeconds() ? ` ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}` : "";
      return { text: day + time, kind: "date" };
    }
    case "n": {
      const v = cell.v as number;
      const fmt = cell.z ?? "General";
      if (fmt !== "General" && XLSX.SSF.is_date(fmt)) {
        const text = dateText(v, date1904);
        if (text) return { text, kind: "date" };
      }
      if (fmt === "@") return { text: cell.w ?? excelNumber(v), kind: "text" };
      if (ZERO_PADDED.test(fmt) && Number.isInteger(v) && v >= 0) {
        try {
          return { text: XLSX.SSF.format(fmt, v) as string, kind: "text" };
        } catch {
          // A format SheetJS cannot apply: the number as it is.
        }
      }
      return { text: excelNumber(v), kind: "number" };
    }
    default:
      return null;
  }
}

/** One sheet as a table: where its header row is, which columns hold values, and their types. */
interface SheetTable {
  table: SourceTable;
  data: (Cell | undefined)[][];
  /** The header row's index, and the first and last column with a value. */
  headerRow: number;
  firstCol: number;
  lastCol: number;
}

function sheetTable(name: string, ws: XLSX.WorkSheet, hidden: boolean, date1904: boolean): SheetTable | null {
  const data = ((ws as unknown as { "!data"?: (Cell | undefined)[][] })["!data"] ?? []) as (Cell | undefined)[][];
  // The sheet's first rows with values, and where each is: the header is chosen among them.
  const first: OpeningRow[] = [];
  const at: number[] = [];
  for (let r = 0; r < data.length && first.length < OPENING_ROWS; r++) {
    const row = data[r];
    if (!row) continue;
    const values: { text: string; kind: Kind }[] = [];
    for (let c = 0; c < row.length; c++) {
      const v = cellValue(row[c], date1904);
      if (v) values.push(v);
    }
    if (!values.length) continue;
    first.push({ n: r + 1, values });
    at.push(r);
  }
  if (!first.length) return null;
  const choice = chooseHeader(first);
  const headerRow = at[choice.index]!;
  let firstCol = Number.POSITIVE_INFINITY;
  let lastCol = -1;
  for (let r = headerRow; r < data.length; r++) {
    const row = data[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      if (!cellValue(row[c], date1904)) continue;
      firstCol = Math.min(firstCol, c);
      lastCol = Math.max(lastCol, c);
    }
  }
  const kinds: Set<Kind>[] = Array.from({ length: lastCol - firstCol + 1 }, () => new Set<Kind>());
  for (let r = headerRow + 1; r < data.length; r++) {
    const row = data[r];
    if (!row) continue;
    for (let c = firstCol; c <= lastCol; c++) {
      const v = cellValue(row[c], date1904);
      if (v) kinds[c - firstCol]!.add(v.kind);
    }
  }
  const header = data[headerRow] ?? [];
  const columns: SourceColumn[] = kinds.map((k, i) => ({
    name: cellValue(header[firstCol + i], date1904)?.text ?? `column ${i + 1}`,
    originalType: kindOf(k),
  }));
  const rows = data.slice(headerRow + 1).filter((row) => row?.some((c) => cellValue(c, date1904))).length;
  const notes = [...(hidden ? [`The sheet "${name}" is hidden in the workbook.`] : []), ...(choice.note ? [choice.note] : [])];
  return { table: { name, columns, rowCount: rows, notes }, data, headerRow, firstCol, lastCol };
}

/** A workbook's bytes, opened: each sheet with values is a table. */
export function openExcel(bytes: Uint8Array, format: "xls" | "xlsx" = "xls"): OpenedFile {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, { type: "array", dense: true, cellNF: true, cellDates: false, cellText: false, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (/password|encrypt/i.test(why)) throw new UnreadableFile("This workbook is protected with a password. Save a copy without one and upload that.", "unsupported");
    throw new UnreadableFile(`This workbook could not be read: ${why}`, "damaged");
  }
  const date1904 = Boolean(wb.Workbook?.WBProps?.date1904);
  const sheets: SheetTable[] = [];
  const notes: string[] = [];
  wb.SheetNames.forEach((name, i) => {
    const ws = wb.Sheets[name];
    const hidden = (wb.Workbook?.Sheets?.[i]?.Hidden ?? 0) !== 0;
    const t = ws ? sheetTable(name, ws, hidden, date1904) : null;
    if (t) sheets.push(t);
    else notes.push(`The sheet "${name}" has no values, so it makes no table.`);
  });

  async function rows(index: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    const s = sheets[index];
    if (!s) throw new RangeError(`This workbook has no table ${index}.`);
    let r = cursor?.row ?? s.headerRow + 1;
    const out: SourceRow[] = [];
    for (; r < s.data.length && out.length < limit.rows; r++) {
      const row = s.data[r];
      if (!row) continue;
      const values: (string | null)[] = [];
      let any = false;
      for (let c = s.firstCol; c <= s.lastCol; c++) {
        const v = cellValue(row[c], date1904);
        values.push(v?.text ?? null);
        if (v) any = true;
      }
      if (any) out.push({ n: r + 1, values });
    }
    return { rows: out, next: r < s.data.length ? { row: r } : null, deleted: 0 };
  }

  return { format, tables: sheets.map((s) => s.table), notes, rows };
}
