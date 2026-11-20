// Excel .xlsx workbooks, read as a stream. SheetJS reads a workbook whole and keeps every cell as
// an object: a 3.6 MB .xlsx took 110 MB of heap, most of what a store's object has. This reader
// keeps one row at a time: it reads the zip's directory from the end of the file, then inflates
// each sheet by range (`DecompressionStream("deflate-raw")`, native in workerd and Node) and scans
// its XML a row at a time. Only the shared strings stay in memory, as one UTF-8 buffer.
//
// Values follow excel.ts (the .xls reader), so a workbook reads the same in either format: a
// date "2019-01-07" or "2019-02-14 10:45:00"; a number rounded to the 15 digits Excel shows; a
// zero-padded format's text ("06804"); yes/no as "true" or "false"; an error as "#N/A". A
// column's type is the kind of value in its first 2,000 rows. A sheet's header is chosen among its
// first rows with values (header.ts): a title and the blank rows under it are left out.
//
// A cursor is a row index in the sheet. The sheet's inflated stream stays open between batches,
// so reading a sheet batch after batch inflates it once; a cursor the open stream has passed (or
// a new object) inflates the sheet again from its start and skips to the row.

import { excelNumber, type Kind, kindOf, ZERO_PADDED } from "./cells.js";
import { chooseHeader, OPENING_ROWS, type OpeningRow } from "./header.js";
import type { ByteSource } from "./source.js";
import { entryBytes, entryText, type ZipEntry, zipEntries } from "./zip.js";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SourceColumn, type SourceRow, type SourceTable, UnreadableFile } from "./types.js";

// ─── XML ─────────────────────────────────────────────────────────────────────

const ENTITY: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML text with its entities read, and Excel's _xHHHH_ escapes for characters XML cannot hold. */
function xmlText(s: string): string {
  const plain = s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e]!));
  return plain.indexOf("_x") < 0 ? plain : plain.replace(/_x([0-9a-fA-F]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const ATTRS = new Map<string, RegExp>();
const attr = (tag: string, name: string): string | null => {
  let re = ATTRS.get(name);
  if (!re) ATTRS.set(name, (re = new RegExp(`\\s${name}="([^"]*)"`)));
  const m = re.exec(tag);
  return m ? xmlText(m[1]!) : null;
};

/** The text of a string item: its <t> runs, without phonetic guides. */
function runsText(xml: string): string {
  const body = xml.indexOf("<rPh") < 0 ? xml : xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += m[1] ? xmlText(m[1]) : "";
  return out;
}

/**
 * The elements named `tag` in a stream of XML text, one at a time, each as its own text. `stop`
 * ends the scan where the elements end (</sheetData>).
 */
async function* elements(chunks: AsyncIterable<Uint8Array>, tag: string, stop: string | null): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let buf = "";
  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true });
    let pos = 0;
    // Where the elements end, looked for once per chunk: once per element would read the buffer again for every row.
    const stopAt = stop ? buf.indexOf(stop) : -1;
    for (;;) {
      let start = buf.indexOf(open, pos);
      while (start >= 0) {
        const next = buf.charCodeAt(start + open.length);
        if (next === 0x20 || next === 0x3e || next === 0x2f || next === 0x09 || next === 0x0a || next === 0x0d) break;
        start = buf.indexOf(open, start + 1);
      }
      if (stopAt >= 0 && (start < 0 || stopAt < start)) return;
      if (start < 0) {
        pos = Math.max(pos, buf.length - open.length);
        break;
      }
      const tagEnd = buf.indexOf(">", start);
      if (tagEnd < 0) {
        pos = start;
        break;
      }
      let end: number;
      if (buf.charCodeAt(tagEnd - 1) === 0x2f) end = tagEnd + 1;
      else {
        const closeAt = buf.indexOf(close, tagEnd);
        if (closeAt < 0) {
          pos = start;
          break;
        }
        end = closeAt + close.length;
      }
      yield buf.slice(start, end);
      pos = end;
    }
    buf = buf.slice(pos);
  }
}

// ─── shared strings, kept as UTF-8 ───────────────────────────────────────────

/**
 * The shared strings: one UTF-8 buffer and where each string starts in it. Its text is never
 * longer than the XML it comes from, so the buffer is made once, at the XML's inflated size.
 */
class SharedStrings {
  private arena: Uint8Array;
  private used = 0;
  private starts = new Uint32Array(1024);
  private count = 0;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder("utf-8");

  constructor(capacity: number) {
    this.arena = new Uint8Array(Math.max(1024, capacity));
  }

  add(text: string): void {
    if (this.count + 2 > this.starts.length) {
      const grown = new Uint32Array(this.starts.length * 2);
      grown.set(this.starts);
      this.starts = grown;
    }
    this.starts[this.count++] = this.used;
    let put = this.encoder.encodeInto(text, this.arena.subarray(this.used));
    if (put.read < text.length) {
      // Never for a workbook whose part sizes are true: grow by what this string needs, not by
      // doubling a buffer that may already be tens of megabytes.
      const grown = new Uint8Array(this.used + text.length * 3);
      grown.set(this.arena.subarray(0, this.used));
      this.arena = grown;
      put = this.encoder.encodeInto(text, this.arena.subarray(this.used));
    }
    this.used += put.written;
  }

  get(i: number): string | null {
    if (i < 0 || i >= this.count) return null;
    const end = i + 1 < this.count ? this.starts[i + 1]! : this.used;
    return this.decoder.decode(this.arena.subarray(this.starts[i]!, end));
  }

  get size(): number {
    return this.count;
  }
}

// ─── number formats ──────────────────────────────────────────────────────────

/** Excel's built-in number formats a cell can name by id, the ones that matter here. */
const BUILT_IN_FORMATS: Readonly<Record<number, string>> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
  22: "m/d/yyyy h:mm", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 49: "@",
};
/** Built-in ids that are dates in some locale's Excel (27-36, 50-58): East Asian date formats. */
const LOCALE_DATE_IDS = new Set([27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** Whether a number format shows a date or a time: it holds d, m, y, h or s outside quotes, escapes and brackets. */
export function isDateFormat(code: string): boolean {
  if (!code || code === "General" || code === "@") return false;
  const stripped = code.replace(/"[^"]*"|\\.|_.|\*.|\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, "");
  return /[dmyhs]/i.test(stripped.replace(/[Ee][+-]/g, ""));
}


/** A whole number in a zero-padded format, as Excel shows it: "06804", "123-45-6789". */
export function zeroPadded(code: string, n: number): string {
  let digits = String(Math.round(n));
  const slots = [...code].filter((c) => c === "0" || c === "#").length;
  const out: string[] = [];
  // Digits fill the placeholders from the right; any left over go before the first one.
  for (let i = code.length - 1, used = 0; i >= 0; i--) {
    const c = code[i]!;
    if (c === "0" || c === "#") {
      used++;
      const d = digits.length ? digits[digits.length - 1]! : c === "0" ? "0" : "";
      digits = digits.slice(0, -1);
      out.unshift(used === slots ? digits + d : d);
      if (used === slots) digits = "";
    } else out.unshift(c);
  }
  return out.join("");
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** An Excel date serial as a date, a date-time, or a time of day. */
export function serialDate(v: number, date1904: boolean): string | null {
  if (!Number.isFinite(v) || v < 0) return null;
  // Excel's 1900 calendar has a February 29 that never was (serial 60); dates before it are a day off.
  const days = date1904 ? v + 1462 : v < 60 ? v + 1 : v;
  const ms = Math.round((days - 25569) * 86_400) * 1000;
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return null;
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
  if (v < 1) return time;
  const day = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  return time === "00:00:00" ? day : `${day} ${time}`;
}

// ─── cells and rows ──────────────────────────────────────────────────────────

interface Book {
  strings: SharedStrings;
  /** Each cell style's number format code, by the style's index. */
  styles: string[];
  date1904: boolean;
}

/** A column's letters from its index: 2 is "C", 27 is "AB". */
export function columnLetters(index: number): string {
  let out = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

/** A column index from a cell reference: "C7" is 2. */
function columnOf(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** One cell's value and kind, from its XML (`<c r="B2" t="s" s="3"><v>4</v></c>`) and its opening tag. */
function cellOf(xml: string, tag: string, book: Book): { text: string; kind: Kind } | null {
  const t = attr(tag, "t") ?? "n";
  if (t === "inlineStr") {
    const m = /<is>([\s\S]*?)<\/is>/.exec(xml);
    const text = m ? runsText(m[1]!) : "";
    return text.trim() === "" ? null : { text, kind: "text" };
  }
  const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(xml);
  if (!v) return null;
  const raw = xmlText(v[1]!);
  switch (t) {
    case "s": {
      const text = book.strings.get(Number(raw));
      return text == null || text.trim() === "" ? null : { text, kind: "text" };
    }
    case "str":
      return raw.trim() === "" ? null : { text: raw, kind: "text" };
    case "b":
      return { text: raw === "1" || raw === "true" ? "true" : "false", kind: "yes/no" };
    case "e":
      return { text: raw, kind: "error" };
    case "d":
      return { text: raw.replace("T", " ").replace(/(\.\d+)?Z?$/, "").replace(/ 00:00:00$/, ""), kind: "date" };
    default: {
      const n = Number(raw);
      if (!Number.isFinite(n)) return raw.trim() === "" ? null : { text: raw, kind: "text" };
      const style = attr(tag, "s");
      const fmt = style == null ? "General" : (book.styles[Number(style)] ?? "General");
      if (isDateFormat(fmt)) {
        const text = serialDate(n, book.date1904);
        if (text) return { text, kind: "date" };
      }
      if (fmt === "@") return { text: excelNumber(n), kind: "text" };
      if (fmt !== "General" && ZERO_PADDED.test(fmt) && Number.isInteger(n) && n >= 0) return { text: zeroPadded(fmt, n), kind: "text" };
      return { text: excelNumber(n), kind: "number" };
    }
  }
}

/** A row's cells by column index, and its row number, from `<row r="7">…</row>`. */
function rowOf(xml: string, book: Book, fallbackNumber: number): { n: number; cells: Map<number, { text: string; kind: Kind }> } {
  const tagEnd = xml.indexOf(">");
  const r = attr(xml.slice(0, tagEnd + 1), "r");
  const n = r ? Number(r) : fallbackNumber;
  const cells = new Map<number, { text: string; kind: Kind }>();
  let next = 0;
  for (const m of xml.slice(tagEnd + 1).matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
    const cell = m[0];
    const tag = cell.slice(0, cell.indexOf(">") + 1);
    const ref = attr(tag, "r");
    const col = ref ? columnOf(ref) : next;
    next = col + 1;
    const value = cellOf(cell, tag, book);
    if (value) cells.set(col, value);
  }
  return { n, cells };
}

// ─── the workbook ────────────────────────────────────────────────────────────

interface Sheet {
  name: string;
  hidden: boolean;
  entry: ZipEntry;
}

/** The workbook's sheets in order, with where each one's XML is. */
function sheetsOf(workbook: string, rels: string, entries: Map<string, ZipEntry>): { sheets: Sheet[]; skipped: string[] } {
  const targets = new Map<string, { target: string; type: string }>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) targets.set(id, { target, type: attr(m[0], "Type") ?? "" });
  }
  const sheets: Sheet[] = [];
  const skipped: string[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name") ?? `Sheet${sheets.length + 1}`;
    const rid = /\sr:id="([^"]*)"/.exec(m[0])?.[1] ?? attr(m[0], "id");
    const rel = rid ? targets.get(rid) : undefined;
    if (!rel || !/\/worksheet$/.test(rel.type)) {
      skipped.push(name);
      continue;
    }
    const path = rel.target.startsWith("/") ? rel.target.slice(1) : `xl/${rel.target.replace(/^\.\//, "")}`;
    const entry = entries.get(path.replace(/\/[^/]+\/\.\.\//g, "/"));
    if (!entry) {
      skipped.push(name);
      continue;
    }
    const state = attr(m[0], "state");
    sheets.push({ name, hidden: state === "hidden" || state === "veryHidden", entry });
  }
  return { sheets, skipped };
}

/** Each cell style's number format code, from styles.xml. */
function stylesOf(styles: string): string[] {
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = attr(m[0], "numFmtId");
    const code = attr(m[0], "formatCode");
    if (id != null && code != null) custom.set(Number(id), code);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const out: string[] = [];
  for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    out.push(custom.get(id) ?? BUILT_IN_FORMATS[id] ?? (LOCALE_DATE_IDS.has(id) ? "yyyy-mm-dd" : "General"));
  }
  return out;
}

const SAMPLE_ROWS = 2000;

/**
 * The most text a workbook's shared strings may hold (sharedStrings.xml, inflated): they stay in
 * memory while its sheets are read, and the rest of a load needs about 60 MB of a store object's
 * 128 MB. Everything else in a workbook is read a row at a time, whatever its size.
 */
export const SHARED_TEXT_CAP = 48 << 20;

/** The rows of a sheet, as a stream that can stop and go on. */
interface SheetStream {
  /** The index in the sheet of the next row this stream gives. */
  next: number;
  rows: AsyncGenerator<string>;
}

/** A workbook, opened from its bytes by range: each sheet with any values is one table. */
export async function openXlsx(source: ByteSource): Promise<OpenedFile> {
  const entries = await zipEntries(source, "This workbook");
  if (entries.has("EncryptedPackage")) throw new UnreadableFile("This workbook is protected with a password. Save a copy without one and upload that.", "unsupported");
  const workbook = await entryText(source, entries.get("xl/workbook.xml"));
  if (!workbook) throw new UnreadableFile("This zip file holds no Excel workbook.", "unsupported");
  const rels = await entryText(source, entries.get("xl/_rels/workbook.xml.rels"));
  const sst = entries.get("xl/sharedStrings.xml");
  if (sst && sst.size > SHARED_TEXT_CAP) {
    throw new UnreadableFile(
      `This workbook holds ${Math.round(sst.size / (1 << 20))} MB of text in its cells, and a store reads a workbook with up to ${SHARED_TEXT_CAP >> 20} MB. Save each sheet as CSV and upload those: delimited text loads at any size.`,
      "too-big",
    );
  }
  const book: Book = {
    strings: new SharedStrings(sst?.size ?? 0),
    styles: stylesOf(await entryText(source, entries.get("xl/styles.xml"))),
    date1904: /<workbookPr\b[^>]*\sdate1904="(?:1|true)"/.test(workbook),
  };
  if (sst) for await (const si of elements(entryBytes(source, sst), "si", null)) book.strings.add(runsText(si));
  const { sheets, skipped } = sheetsOf(workbook, rels, entries);
  const notes = skipped.map((name) => `The sheet "${name}" is a chart or holds no cells, so it makes no table.`);

  /** A sheet's header row and its width and kinds, from its first rows. */
  interface Layout {
    sheet: Sheet;
    table: SourceTable;
    /** Where the header row is among the sheet's <row> elements, and the first and last column with a value. */
    headerIndex: number;
    firstCol: number;
    lastCol: number;
  }
  type Cells = Map<number, { text: string; kind: Kind }>;
  const layouts: Layout[] = [];
  for (const sheet of sheets) {
    // The sheet's first rows with values, held until its header is chosen among them.
    const first: { index: number; n: number; cells: Cells }[] = [];
    let header: { index: number; cells: Cells; note: string | null } | null = null;
    let firstCol = Number.POSITIVE_INFINITY;
    let lastCol = -1;
    const kinds = new Map<number, Set<Kind>>();
    let sampled = 0;
    /** A row under the header: its cells widen the table, and their kinds are its columns' types. Whether the sample is full. */
    const sample = (cells: Cells): boolean => {
      for (const [c, v] of cells) {
        firstCol = Math.min(firstCol, c);
        lastCol = Math.max(lastCol, c);
        const set = kinds.get(c) ?? new Set<Kind>();
        set.add(v.kind);
        kinds.set(c, set);
      }
      return ++sampled >= SAMPLE_ROWS;
    };
    /** The header among the rows held (header.ts); the rows held under it are sampled, and the rows above it are left out. */
    const chooseIn = (rows: typeof first): { index: number; cells: Cells; note: string | null } => {
      const choice = chooseHeader(rows.map((r): OpeningRow => ({ n: r.n, values: [...r.cells.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) })));
      const h = rows[choice.index]!;
      for (const c of h.cells.keys()) (firstCol = Math.min(firstCol, c)), (lastCol = Math.max(lastCol, c));
      for (const r of rows.slice(choice.index + 1)) if (sample(r.cells)) break;
      rows.length = 0;
      return { index: h.index, cells: h.cells, note: choice.note };
    };
    let index = 0;
    const stream = elements(entryBytes(source, sheet.entry), "row", "</sheetData>");
    for await (const xml of stream) {
      const row = rowOf(xml, book, index + 1);
      index++;
      if (!row.cells.size) continue;
      if (header) {
        if (sample(row.cells)) break;
        continue;
      }
      first.push({ index: index - 1, n: row.n, cells: row.cells });
      if (first.length < OPENING_ROWS) continue;
      header = chooseIn(first);
      if (sampled >= SAMPLE_ROWS) break;
    }
    await stream.return(undefined);
    if (!header && first.length) header = chooseIn(first);
    if (!header) {
      notes.push(`The sheet "${sheet.name}" has no values, so it makes no table.`);
      continue;
    }
    const columns: SourceColumn[] = [];
    for (let c = firstCol; c <= lastCol; c++) {
      columns.push({
        name: header.cells.get(c)?.text ?? `column ${c - firstCol + 1}`,
        originalType: kindOf(kinds.get(c)),
      });
    }
    const tableNotes = [...(sheet.hidden ? [`The sheet "${sheet.name}" is hidden in the workbook.`] : []), ...(header.note ? [header.note] : [])];
    layouts.push({
      sheet,
      table: { name: sheet.name, columns, rowCount: null, notes: tableNotes },
      headerIndex: header.index,
      firstCol,
      lastCol,
    });
  }

  let live: { table: number; stream: SheetStream } | null = null;

  async function streamAt(table: number, index: number): Promise<SheetStream> {
    if (live && live.table === table && live.stream.next === index) return live.stream;
    if (live) await live.stream.rows.return(undefined).catch(() => undefined);
    live = null;
    const layout = layouts[table]!;
    const stream: SheetStream = { next: 0, rows: elements(entryBytes(source, layout.sheet.entry), "row", "</sheetData>") };
    // A new stream starts at the sheet's first row; skip to the cursor's.
    while (stream.next < index) {
      const { done } = await stream.rows.next();
      if (done) break;
      stream.next++;
    }
    live = { table, stream };
    return stream;
  }

  async function rows(table: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    const layout = layouts[table];
    if (!layout) throw new RangeError(`This workbook has no table ${table}.`);
    const stream = await streamAt(table, cursor?.row ?? layout.headerIndex + 1);
    const out: SourceRow[] = [];
    let ended = false;
    while (out.length < limit.rows) {
      let next: IteratorResult<string>;
      try {
        next = await stream.rows.next();
      } catch (err) {
        // A stream that threw is finished: the next try reads the sheet again from the cursor,
        // and never takes the ended stream for the sheet's end.
        if (live?.stream === stream) live = null;
        throw err;
      }
      if (next.done) {
        ended = true;
        break;
      }
      const index = stream.next++;
      const row = rowOf(next.value, book, index + 1);
      if (!row.cells.size) continue;
      const values: (string | null)[] = [];
      for (let c = layout.firstCol; c <= layout.lastCol; c++) values.push(row.cells.get(c)?.text ?? null);
      // Values right of the columns the first rows used are kept too, for _extra.
      const beyond = [...row.cells.keys()].filter((c) => c > layout.lastCol).sort((a, b) => a - b);
      if (beyond.length) for (let c = layout.lastCol + 1; c <= beyond[beyond.length - 1]!; c++) values.push(row.cells.get(c)?.text ?? null);
      // And those left of them, by their column's letters.
      let extra: Record<string, string> | undefined;
      for (const [c, cell] of row.cells) if (c < layout.firstCol) (extra ??= {})[`column ${columnLetters(c)}`] = cell.text;
      out.push(extra ? { n: row.n, values, extra } : { n: row.n, values });
    }
    if (ended && live?.table === table) {
      await live.stream.rows.return(undefined);
      live = null;
    }
    return { rows: out, next: ended ? null : { row: stream.next }, deleted: 0 };
  }

  return { format: "xlsx", tables: layouts.map((l) => l.table), notes, rows };
}
