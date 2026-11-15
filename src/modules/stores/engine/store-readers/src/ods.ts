// OpenDocument spreadsheets: .ods (LibreOffice, OpenOffice, and what Excel and Google Sheets save
// as OpenDocument) and .fods, the same document as one XML file. Every sheet is in one XML part,
// content.xml, which is read as a stream (xml-scan.ts) a row at a time: by range from the zip when
// it is stored, inflated forward when it is deflated, and by range from the file itself for .fods.
//
// Values follow the Excel readers (xlsx.ts, excel.ts), so a workbook reads the same whichever way
// it was saved: a cell's own value, not its displayed text; a date "2019-01-07" or "2019-02-14
// 10:45:00"; a time "09:30:15"; a number rounded to the 15 digits a spreadsheet shows; yes/no
// "true" or "false"; an error as the spreadsheet shows it ("#DIV/0!"). A whole number shown with
// leading zeros or separators ("06804", "123-45-6789") keeps that text, whose zeros are its
// meaning. A sheet's header is chosen among its first rows with values (header.ts): its first row
// with a value, unless a title and blank rows sit above the table, which are left out. A blank row
// is skipped and keeps its number. A column's type is the kind of value in its first 2,000 rows.
//
// A row that a spreadsheet repeats (`table:number-rows-repeated`, as LibreOffice writes empty
// rows down to row 1,048,576) is counted, never written out, unless it holds values. A cursor is
// the byte offset in content.xml of the next row, with its row number.

import { excelNumber, type Kind, kindOf } from "./cells.js";
import { chooseHeader, OPENING_ROWS, type OpeningRow } from "./header.js";
import type { ByteSource } from "./source.js";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SourceColumn, type SourceRow, type SourceTable, UnreadableFile } from "./types.js";
import { childrenOf, localName, XmlScanner, xmlEncoding, type XmlNode } from "./xml-scan.js";
import { entrySource, entryText, zipEntries } from "./zip.js";
import { columnLetters } from "./xlsx.js";

/** The most columns a sheet has (LibreOffice 7.4 and later); a repeated cell never reaches past it. */
const MAX_COLUMNS = 16_384;
const SAMPLE_ROWS = 2000;

/** Elements that hold a sheet's rows, at any depth inside the sheet, and its columns. */
const ROW_GROUPS = new Set(["table:table-header-rows", "table:table-row-group", "table:table-rows"]);
const COLUMN_GROUPS = new Set(["table:table-header-columns", "table:table-column-group", "table:table-columns"]);

interface Cell {
  text: string;
  kind: Kind;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** A date value ("2019-01-07", "2019-02-14T10:45:00.25") as the readers write dates, to the second. */
export function odfDate(v: string): string | null {
  const m = /^(-?\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/.exec(v.trim());
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] == null) return day;
  let seconds = Math.round(Number(m[6] ?? 0));
  let minutes = Number(m[5]);
  let hours = Number(m[4]);
  if (seconds === 60) (seconds = 0), minutes++;
  if (minutes === 60) (minutes = 0), hours++;
  // A time that rounds up to midnight stays on its own day: 23:59:59.6 reads as 23:59:59.
  if (hours === 24) return `${day} 23:59:59`;
  const time = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return time === "00:00:00" ? day : `${day} ${time}`;
}

/** A time value, an ISO 8601 duration ("PT09H30M15S", "PT33H"), as hours, minutes and seconds. */
export function odfTime(v: string): string | null {
  const m = /^-?P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v.trim());
  if (!m) return null;
  const total = Math.round((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0));
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** A paragraph's text: runs of spaces in the XML read as one space; `text:s`, `text:tab` and `text:line-break` are kept. */
function paragraphText(node: XmlNode): string {
  let out = "";
  for (const c of node.content) {
    if (typeof c === "string") out += c.replace(/[ \t\r\n]+/g, " ");
    else if (c.name === "text:s") out += " ".repeat(Math.min(1000, Math.max(1, Number(c.attrs["text:c"] ?? 1) || 1)));
    else if (c.name === "text:tab") out += "\t";
    else if (c.name === "text:line-break") out += "\n";
    else if (c.name === "office:annotation" || c.name === "text:note" || c.name === "text:ruby-text") continue;
    else out += paragraphText(c);
  }
  return out;
}

/** A cell's displayed text: its paragraphs, one a line, without its comment. */
function shownText(cell: XmlNode): string {
  const lines: string[] = [];
  for (const c of childrenOf(cell)) if (c.name === "text:p" || c.name === "text:h") lines.push(paragraphText(c).replace(/^ /, ""));
  return lines.join("\n");
}

/** A whole number the spreadsheet shows with leading zeros or separators keeps that text: "06804", "123-45-6789". */
function paddedText(shown: string, n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || shown.length < 2) return null;
  const digits = shown.replace(/[-\s()/]/g, "");
  if (!/^\d+$/.test(digits) || Number(digits) !== n) return null;
  return shown.startsWith("0") || digits !== shown ? shown : null;
}

/** One cell's value and kind, or null for an empty cell. `pad` is the digits its number format pads a whole number to. */
function cellOf(cell: XmlNode, pad: number): Cell | null {
  const a = cell.attrs;
  const type = a["office:value-type"] ?? a["calcext:value-type"];
  if (a["calcext:value-type"] === "error") {
    const text = shownText(cell);
    return text ? { text, kind: "error" } : null;
  }
  switch (type) {
    case "float":
    case "percentage":
    case "currency": {
      const n = Number(a["office:value"]);
      if (!Number.isFinite(n)) break;
      if (pad > 1 && Number.isInteger(n) && n >= 0) return { text: String(n).padStart(pad, "0"), kind: "text" };
      const padded = paddedText(shownText(cell), n);
      return padded ? { text: padded, kind: "text" } : { text: excelNumber(n), kind: "number" };
    }
    case "date": {
      const text = odfDate(a["office:date-value"] ?? "");
      if (text) return { text, kind: "date" };
      break;
    }
    case "time": {
      const text = odfTime(a["office:time-value"] ?? "");
      if (text) return { text, kind: "date" };
      break;
    }
    case "boolean": {
      const v = (a["office:boolean-value"] ?? "").toLowerCase();
      return { text: v === "true" || v === "1" ? "true" : "false", kind: "yes/no" };
    }
  }
  const text = a["office:string-value"] ?? shownText(cell);
  return text.trim() === "" ? null : { text, kind: "text" };
}

/** What a sheet's number formats say about padding: the digits each cell style pads a whole number to, and each column's default style. */
interface Formats {
  pads: ReadonlyMap<string, number>;
  columns: readonly (string | undefined)[];
}

/** A row's cells by column index; repeated cells with a value are repeated, up to the last column a sheet has. */
function cellsOf(row: XmlNode, formats: Formats): Map<number, Cell> {
  const cells = new Map<number, Cell>();
  const rowStyle = row.attrs["table:default-cell-style-name"];
  let col = 0;
  for (const c of childrenOf(row)) {
    if (c.name !== "table:table-cell" && c.name !== "table:covered-table-cell") continue;
    const repeat = Math.max(1, Number(c.attrs["table:number-columns-repeated"] ?? 1) || 1);
    const style = c.attrs["table:style-name"] ?? rowStyle ?? formats.columns[col];
    const value = cellOf(c, style ? (formats.pads.get(style) ?? 0) : 0);
    if (value) for (let k = 0; k < repeat && col + k < MAX_COLUMNS; k++) cells.set(col + k, value);
    col += repeat;
    if (col >= MAX_COLUMNS) break;
  }
  return cells;
}

const rowsRepeated = (attrs: Readonly<Record<string, string>>): number => Math.max(1, Number(attrs["table:number-rows-repeated"] ?? 1) || 1);

type Event =
  | { kind: "style"; node: XmlNode }
  | { kind: "sheet"; attrs: Record<string, string> }
  | { kind: "column"; attrs: Record<string, string> }
  | {
      kind: "row";
      /** How many rows this one element stands for, and where it starts. */
      repeat: number;
      start: number;
      depth: number;
      /** The row read whole; a row not read is passed over. */
      read(): Promise<XmlNode>;
      /** Where the row ends, once it is read. */
      end(): number;
    }
  | { kind: "sheet-end" };

/**
 * The parts of content.xml a sheet is read from, in order: table styles (which say a sheet is
 * hidden), each sheet's start, its rows, and its end. From inside a sheet when `depth` is given:
 * the row groups the offset is inside of.
 */
async function* walk(scanner: XmlScanner, depth: number | null): AsyncGenerator<Event> {
  let inside = depth;
  for (let t = await scanner.next(); t; t = await scanner.next()) {
    if (inside === null) {
      if (t.kind !== "open") continue;
      if (t.name === "table:table") {
        yield { kind: "sheet", attrs: t.attrs };
        if (t.selfClosing) yield { kind: "sheet-end" };
        else inside = 0;
      } else if ((t.name === "style:style" && (t.attrs["style:family"] === "table" || t.attrs["style:family"] === "table-cell")) || t.name === "number:number-style") {
        yield { kind: "style", node: await scanner.element(t) };
      }
      else if (t.name === "office:font-face-decls" || t.name === "office:scripts" || t.name === "office:settings" || t.name === "office:master-styles" || t.name === "office:meta") await scanner.skip(t);
      continue;
    }
    if (t.kind === "open") {
      if (t.name === "table:table-row") {
        const open = t;
        let node: XmlNode | null = null;
        yield {
          kind: "row",
          repeat: rowsRepeated(open.attrs),
          start: open.start,
          depth: inside,
          read: async () => (node ??= await scanner.element(open)),
          end: () => scanner.offset,
        };
        if (!node) await scanner.skip(open);
      } else if (ROW_GROUPS.has(t.name) || COLUMN_GROUPS.has(t.name)) {
        if (!t.selfClosing) inside++;
      } else if (t.name === "table:table-column") {
        yield { kind: "column", attrs: t.attrs };
        await scanner.skip(t);
      } else await scanner.skip(t);
    } else if (t.kind === "close") {
      if (inside > 0) inside--;
      else {
        inside = null;
        yield { kind: "sheet-end" };
      }
    }
  }
}

interface Layout {
  table: SourceTable;
  formats: Formats;
  /** Where the rows after the header start, and the header's own repeats still to give. */
  data: ReadCursor;
  firstCol: number;
  lastCol: number;
}

export interface OpenOdsOptions {
  /** A flat OpenDocument file (.fods): the document is the file itself, not a zip. */
  flat?: boolean;
}

/** An OpenDocument spreadsheet, opened: each sheet with any values is one table. */
export async function openOds(source: ByteSource, options: OpenOdsOptions = {}): Promise<OpenedFile> {
  let content: ByteSource;
  if (options.flat) content = source;
  else {
    const entries = await zipEntries(source, "This spreadsheet");
    const manifest = await entryText(source, entries.get("META-INF/manifest.xml"));
    if (/<manifest:encryption-data\b/.test(manifest)) throw new UnreadableFile("This spreadsheet is protected with a password. Save a copy without one and upload that.", "unsupported");
    const part = entries.get("content.xml");
    if (!part) throw new UnreadableFile("This zip file holds no OpenDocument spreadsheet.", "unsupported");
    content = await entrySource(source, part);
  }
  const head = await content.read(0, Math.min(content.size, 4096));
  const { encoding, start } = xmlEncoding(head);

  const hiddenStyles = new Set<string>();
  /** Number formats that pad a whole number with zeros, by name, and the cell styles that use them. */
  const padFormats = new Map<string, number>();
  const cellFormats = new Map<string, string>();
  const pads = new Map<string, number>();
  const layouts: Layout[] = [];
  const notes: string[] = [];
  const scanner = new XmlScanner(content, encoding, start);
  let sheet: { name: string; hidden: boolean; columns: (string | undefined)[] } | null = null;
  let row = 1;
  let header: { cells: Map<number, Cell>; data: ReadCursor; note: string | null } | null = null;
  /** The sheet's first rows with values, held until its header is chosen among them, and the rows they stand for. */
  let first: { cells: Map<number, Cell>; row: number; repeat: number; start: number; end: number; depth: number }[] = [];
  let firstRows = 0;
  let kinds = new Map<number, Set<Kind>>();
  let firstCol = Number.POSITIVE_INFINITY;
  let lastCol = -1;
  let sampled = 0;
  let formats: Formats = { pads, columns: [] };
  /** A row under the header, `copies` times over: its cells widen the table, and their kinds are its columns' types. */
  const sample = (cells: Map<number, Cell>, copies: number): void => {
    for (const [c, v] of cells) {
      firstCol = Math.min(firstCol, c);
      lastCol = Math.max(lastCol, c);
      const set = kinds.get(c) ?? new Set<Kind>();
      set.add(v.kind);
      kinds.set(c, set);
    }
    sampled += copies;
  };
  /**
   * The header among the rows held (header.ts), each copy of a repeated row counted as a row; the
   * rows held under it are sampled, and the rows above it are left out.
   */
  const chooseIn = (): { cells: Map<number, Cell>; data: ReadCursor; note: string | null } => {
    const opening: OpeningRow[] = [];
    const of: number[] = [];
    first.forEach((r, i) => {
      const values = [...r.cells.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      for (let k = 0; k < r.repeat && opening.length < OPENING_ROWS; k++) opening.push({ n: r.row + k, values }), of.push(i);
    });
    const choice = chooseHeader(opening);
    const at = of[choice.index]!;
    const h = first[at]!;
    for (const c of h.cells.keys()) (firstCol = Math.min(firstCol, c)), (lastCol = Math.max(lastCol, c));
    // A header row repeated (rare) gives its copies as data rows.
    if (h.repeat > 1) sample(h.cells, h.repeat - 1);
    for (const r of first.slice(at + 1)) {
      if (sampled >= SAMPLE_ROWS) break;
      sample(r.cells, r.repeat);
    }
    first = [];
    firstRows = 0;
    const data = h.repeat > 1 ? { at: h.start, depth: h.depth, row: h.row, rep: 1 } : { at: h.end, depth: h.depth, row: h.row + 1, rep: 0 };
    return { cells: h.cells, data, note: choice.note };
  };
  for await (const e of walk(scanner, null)) {
    if (e.kind === "style") {
      const name = e.node.attrs["style:name"];
      if (!name) continue;
      if (e.node.name === "number:number-style") {
        const number = childrenOf(e.node).find((c) => c.name === "number:number");
        const digits = Number(number?.attrs["number:min-integer-digits"] ?? 0);
        const decimals = Number(number?.attrs["number:decimal-places"] ?? 0);
        if (number && digits > 1 && !decimals && number.attrs["number:grouping"] !== "true") padFormats.set(name, digits);
      } else if (e.node.attrs["style:family"] === "table-cell") {
        const format = e.node.attrs["style:data-style-name"];
        if (format) cellFormats.set(name, format);
      } else {
        const props = childrenOf(e.node).find((c) => c.name === "style:table-properties");
        if (props?.attrs["table:display"] === "false") hiddenStyles.add(name);
      }
    } else if (e.kind === "sheet") {
      // Styles come before the sheets: which cell styles pad is known by the first one.
      if (!layouts.length && !notes.length) for (const [cell, format] of cellFormats) if (padFormats.has(format)) pads.set(cell, padFormats.get(format)!);
      const style = e.attrs["table:style-name"];
      sheet = { name: e.attrs["table:name"] ?? `Sheet${layouts.length + notes.length + 1}`, hidden: !!style && hiddenStyles.has(style), columns: [] };
      formats = { pads, columns: sheet.columns };
      row = 1;
      header = null;
      first = [];
      firstRows = 0;
      kinds = new Map();
      firstCol = Number.POSITIVE_INFINITY;
      lastCol = -1;
      sampled = 0;
    } else if (e.kind === "column") {
      if (!sheet) continue;
      const repeat = Math.max(1, Number(e.attrs["table:number-columns-repeated"] ?? 1) || 1);
      const style = e.attrs["table:default-cell-style-name"];
      const at = sheet.columns.length;
      // Only styles that pad matter here; a long run of plain columns adds nothing.
      if (style && pads.has(style)) for (let k = 0; k < repeat && at + k < MAX_COLUMNS; k++) sheet.columns[at + k] = style;
      else sheet.columns.length = Math.min(MAX_COLUMNS, at + repeat);
    } else if (e.kind === "row") {
      const repeat = e.repeat;
      if (!header) {
        const cells = cellsOf(await e.read(), formats);
        if (cells.size) {
          first.push({ cells, row, repeat, start: e.start, end: e.end(), depth: e.depth });
          firstRows += repeat;
          if (firstRows >= OPENING_ROWS) header = chooseIn();
        }
      } else if (sampled < SAMPLE_ROWS) {
        // Past the sample, a row is only counted: it is passed over, never read.
        const cells = cellsOf(await e.read(), formats);
        if (cells.size) sample(cells, repeat);
      }
      row += repeat;
    } else if (sheet) {
      if (!header && first.length) header = chooseIn();
      if (!header) notes.push(`The sheet "${sheet.name}" has no values, so it makes no table.`);
      else {
        const columns: SourceColumn[] = [];
        for (let c = firstCol; c <= lastCol; c++) columns.push({ name: header.cells.get(c)?.text ?? `column ${c - firstCol + 1}`, originalType: kindOf(kinds.get(c)) });
        const tableNotes = [...(sheet.hidden ? [`The sheet "${sheet.name}" is hidden in the spreadsheet.`] : []), ...(header.note ? [header.note] : [])];
        layouts.push({
          table: { name: sheet.name, columns, rowCount: null, notes: tableNotes },
          formats,
          data: header.data,
          firstCol,
          lastCol,
        });
      }
      sheet = null;
    }
  }
  if (!layouts.length && !notes.length) throw new UnreadableFile("This OpenDocument file holds no spreadsheet.", "unsupported");

  async function rows(table: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    const layout = layouts[table];
    if (!layout) throw new RangeError(`This spreadsheet has no table ${table}.`);
    const from = cursor ?? layout.data;
    const reader = new XmlScanner(content, encoding, from.at!);
    let n = from.row!;
    let rep = from.rep ?? 0;
    const out: SourceRow[] = [];
    let next: ReadCursor | null = null;
    for await (const e of walk(reader, from.depth ?? 0)) {
      if (e.kind === "sheet-end") break;
      if (e.kind !== "row") continue;
      const repeat = e.repeat;
      const cells = cellsOf(await e.read(), layout.formats);
      if (cells.size) {
        const values: (string | null)[] = [];
        for (let c = layout.firstCol; c <= layout.lastCol; c++) values.push(cells.get(c)?.text ?? null);
        const beyond = [...cells.keys()].filter((c) => c > layout.lastCol).sort((a, b) => a - b);
        if (beyond.length) for (let c = layout.lastCol + 1; c <= beyond[beyond.length - 1]!; c++) values.push(cells.get(c)?.text ?? null);
        let extra: Record<string, string> | undefined;
        for (const [c, cell] of cells) if (c < layout.firstCol) (extra ??= {})[`column ${columnLetters(c)}`] = cell.text;
        while (rep < repeat && out.length < limit.rows) {
          out.push(extra ? { n: n + rep, values: [...values], extra } : { n: n + rep, values: [...values] });
          rep++;
        }
        if (rep < repeat) {
          next = { at: e.start, depth: e.depth, row: n, rep };
          break;
        }
      }
      n += repeat;
      rep = 0;
      if (out.length >= limit.rows || (limit.bytes && e.end() - from.at! >= limit.bytes)) {
        next = { at: e.end(), depth: e.depth, row: n, rep: 0 };
        break;
      }
    }
    return { rows: out, next, deleted: 0 };
  }

  return { format: "ods", tables: layouts.map((l) => l.table), notes, rows };
}
