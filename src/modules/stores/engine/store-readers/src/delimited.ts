// Delimited text: CSV, tab-separated, semicolon- and pipe-separated exports, of any size.
//
// The file is read by range, a window at a time, and parsed at the level of its bytes (two-byte
// units for UTF-16): the delimiter, the quote and the line breaks are ASCII, and in UTF-8 an ASCII
// byte is never part of another character, so a record's end is found without decoding anything
// before it. A read stops at a record's end, and its cursor is that byte offset with the next
// row's number, so a load goes on from there in a later alarm.
//
// This is not sheet-io's `parseDelimited`: that one parses a string already in memory,
// and this one parses a file it never holds whole, in any encoding, and says where it stopped.
//
// Quoting follows RFC 4180, read leniently: a quote opens a quoted field only at the field's
// start, "" inside it is one quote, and characters after its closing quote stay in the field.
// Unquoted values lose surrounding spaces; an empty value is null. A line with nothing on it is
// skipped, though it keeps its row number, as a spreadsheet shows it. The header is chosen among the
// first rows with values (header.ts): the first row, unless a title line and blank lines sit above
// the table, which are left out. A first row that holds a number or a date is data, which a header
// never is, and the columns are numbered.
//
// The encoding is the one its bytes show (text.ts `detectEncoding`), or the code page a person set
// for the file, unless the file begins with a byte order mark: the mark says what the text is.

import { chooseHeader, OPENING_ROWS, readsAsName } from "./header.js";
import { codePageName } from "./jobs.js";
import type { ByteSource } from "./source.js";
import { decode, detectEncoding, encodingName, encodingOfPage, type TextEncoding } from "./text.js";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SetCodePage, type SourceColumn, type SourceRow, UnreadableFile } from "./types.js";

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;
const CTRL_Z = 0x1a;
/** The delimiters a file is tried with, in the order a tie goes. */
const DELIMITERS = [",", "\t", ";", "|"] as const;
const SNIFF_BYTES = 256 << 10;
/** The records the delimiter, the first row and the width are read from. */
const SNIFF_RECORDS = 60;
/** The records the header is looked for in: enough for OPENING_ROWS with values under a few blank lines. */
const OPENING_RECORDS = 2 * OPENING_ROWS;
const WINDOW_BYTES = 1 << 20;
/** The longest record a read goes looking for the end of; a "record" longer than this is a file that is not delimited text. */
const MAX_RECORD_BYTES = 64 << 20;

/** What the opening of a delimited file says about the whole of it. */
export interface DelimitedShape {
  encoding: TextEncoding;
  delimiter: string;
  /** The header's names, or null when the first row is data. */
  header: string[] | null;
  /** Where the first data row starts, and its row number. */
  dataStart: number;
  firstRow: number;
  /** The most values a row in the opening bytes holds. */
  width: number;
  /** What the table's notes say about the rows above the header that were left out (a title line); null when none were. */
  above: string | null;
}

/** A record found in a window: its fields' text, and where it ends, from the window's start. */
interface FoundRecord {
  fields: (string | null)[];
  end: number;
}

/** How a window's bytes are read: by byte, or by UTF-16 unit. */
interface Units {
  size: 1 | 2;
  at(bytes: Uint8Array, p: number): number;
}

function unitsOf(e: TextEncoding): Units {
  if (e.kind === "utf-16le") return { size: 2, at: (b, p) => b[p]! | (b[p + 1]! << 8) };
  if (e.kind === "utf-16be") return { size: 2, at: (b, p) => (b[p]! << 8) | b[p + 1]! };
  return { size: 1, at: (b, p) => b[p]! };
}

/**
 * The records that start at `from` in a window of bytes, as many as end inside it; a record the
 * window cuts off is left for the next read, unless `final` says the window ends where the file
 * does. `max` caps how many are read.
 */
export function recordsIn(bytes: Uint8Array, from: number, enc: TextEncoding, delimiter: number, final: boolean, max = Number.POSITIVE_INFINITY): FoundRecord[] {
  const u = unitsOf(enc);
  const step = u.size;
  const end = bytes.byteLength - (bytes.byteLength % step);
  const out: FoundRecord[] = [];
  let p = from;
  const piece = (s: number, e: number): string => (e > s ? decode(bytes.subarray(s, e), enc) : "");
  while (p < end && out.length < max) {
    const fields: (string | null)[] = [];
    let fieldStart = p;
    let parts: string[] | null = null; // the pieces of a quoted field
    let inQuotes = false;
    let segStart = p;
    let complete = false;
    const endField = (at: number) => {
      if (parts) {
        parts.push(piece(segStart, at));
        const v = parts.join("");
        fields.push(v === "" ? null : v);
      } else {
        const v = piece(fieldStart, at).replace(/^[ \t]+|[ \t]+$/g, "");
        fields.push(v === "" ? null : v);
      }
      parts = null;
    };
    while (p < end) {
      const c = u.at(bytes, p);
      if (inQuotes) {
        if (c === QUOTE) {
          if (p + step >= end && !final) break; // "" or the closing quote: the next unit says which
          if (p + step < end && u.at(bytes, p + step) === QUOTE) {
            parts!.push(piece(segStart, p + step));
            p += 2 * step;
            segStart = p;
            continue;
          }
          parts!.push(piece(segStart, p));
          inQuotes = false;
          p += step;
          segStart = p;
          continue;
        }
        p += step;
        continue;
      }
      if (c === QUOTE && p === fieldStart && !parts) {
        inQuotes = true;
        parts = [];
        p += step;
        segStart = p;
        continue;
      }
      if (c === delimiter) {
        endField(p);
        p += step;
        fieldStart = p;
        segStart = p;
        continue;
      }
      if (c === LF || c === CR) {
        if (c === CR && p + step >= end && !final) break; // a CR the window ends on may have its LF in the next
        endField(p);
        p += step;
        if (c === CR && p < end && u.at(bytes, p) === LF) p += step;
        complete = true;
        break;
      }
      p += step;
    }
    if (!complete) {
      if (!final || p < end) break; // cut off: the next read starts at this record again
      // The file ends without a line break after its last record.
      if (inQuotes && parts) parts.push(piece(segStart, p)), (segStart = p);
      endField(p);
      // A DOS end-of-file mark alone on the last line is no record.
      if (fields.length === 1 && fields[0] === "\u001a") fields[0] = null;
    }
    out.push({ fields, end: p });
    if (!complete) break;
  }
  return out;
}

const isBlank = (fields: readonly (string | null)[]): boolean => fields.every((f) => f == null);

/** Which delimiter splits the opening records most evenly into the most columns. */
function chooseDelimiter(head: Uint8Array, start: number, enc: TextEncoding, final: boolean): string {
  let best: { d: string; share: number; width: number } | null = null;
  for (const d of DELIMITERS) {
    const records = recordsIn(head, start, enc, d.charCodeAt(0), final, 60).filter((r) => !isBlank(r.fields));
    if (!records.length) continue;
    const counts = new Map<number, number>();
    for (const r of records) counts.set(r.fields.length, (counts.get(r.fields.length) ?? 0) + 1);
    let width = 0;
    let most = 0;
    for (const [w, n] of counts) if (n > most || (n === most && w > width)) (width = w), (most = n);
    if (width < 2) continue;
    const share = most / records.length;
    // Even splits beat uneven ones; among even ones, more columns beat fewer.
    if (!best || share > best.share + 0.1 || (Math.abs(share - best.share) <= 0.1 && width > best.width)) best = { d, share, width };
  }
  return best?.d ?? ",";
}

/** The encoding, delimiter and header of a delimited file, from its opening bytes; `set` is the encoding a person set for it, which a byte order mark overrules. */
export async function sniffDelimited(source: ByteSource, set: TextEncoding | null = null): Promise<DelimitedShape> {
  let take = Math.min(source.size, SNIFF_BYTES);
  for (;;) {
    const head = await source.read(0, take);
    const final = take >= source.size;
    const shown = detectEncoding(head);
    const { encoding, bom } = set && !shown.bom ? { encoding: set, bom: 0 } : shown;
    const delimiter = chooseDelimiter(head, bom, encoding, final);
    const opening = recordsIn(head, bom, encoding, delimiter.charCodeAt(0), final, OPENING_RECORDS);
    const records = opening.slice(0, SNIFF_RECORDS);
    const firstIndex = records.findIndex((r) => !isBlank(r.fields));
    if (firstIndex < 0 && !final && take < MAX_RECORD_BYTES) {
      take = Math.min(source.size, take * 4);
      continue;
    }
    if (firstIndex < 0) return { encoding, delimiter, header: null, dataStart: bom, firstRow: 1, width: 0, above: null };
    const width = Math.max(...records.map((r) => r.fields.length));
    // A title line and the blank lines under it, above the table's header, are left out (header.ts).
    const withValues: number[] = [];
    opening.forEach((r, i) => {
      if (!isBlank(r.fields) && withValues.length < OPENING_ROWS) withValues.push(i);
    });
    const choice = chooseHeader(withValues.map((i) => ({ n: i + 1, values: opening[i]!.fields.filter((f): f is string => f != null).map((text) => ({ text })) })));
    if (choice.index > 0) {
      const at = withValues[choice.index]!;
      return { encoding, delimiter, header: opening[at]!.fields.map((f) => f ?? ""), dataStart: opening[at]!.end, firstRow: at + 2, width, above: choice.note };
    }
    const first = records[firstIndex]!;
    const isHeader = first.fields.every((f) => f == null || readsAsName({ text: f }));
    if (!isHeader) return { encoding, delimiter, header: null, dataStart: firstIndex === 0 ? bom : records[firstIndex - 1]!.end, firstRow: firstIndex + 1, width, above: null };
    return { encoding, delimiter, header: first.fields.map((f) => f ?? ""), dataStart: first.end, firstRow: firstIndex + 2, width, above: null };
  }
}

/** The last window read, which the next batch reads on from without asking the source again. */
export interface WindowCache {
  last: { at: number; bytes: Uint8Array } | null;
}

/** Rows of a delimited file from a cursor (`at`: a byte offset where a record starts; `row`: its number). */
export async function readDelimitedRows(source: ByteSource, shape: DelimitedShape, cursor: ReadCursor | null, limit: BatchLimit, cache: WindowCache = { last: null }): Promise<RowBatch> {
  let at = cursor?.at ?? shape.dataStart;
  let row = cursor?.row ?? shape.firstRow;
  const rows: SourceRow[] = [];
  const delimiter = shape.delimiter.charCodeAt(0);
  let window = Math.max(64 << 10, limit.bytes ?? WINDOW_BYTES);
  while (rows.length < limit.rows && at < source.size) {
    // A batch stops after its rows, mostly inside the window it read: the next one reads on in it.
    const kept = cache.last;
    const fromCache = !!kept && at >= kept.at && at < kept.at + kept.bytes.byteLength;
    const bytes = fromCache ? kept!.bytes.subarray(at - kept!.at) : await source.read(at, window);
    if (!fromCache) cache.last = { at, bytes };
    const final = at + bytes.byteLength >= source.size;
    const found = recordsIn(bytes, 0, shape.encoding, delimiter, final, limit.rows - rows.length);
    if (!found.length) {
      // The rest holds no whole record (in UTF-16, a stray last byte): the file ends here.
      if (final) {
        at = source.size;
        break;
      }
      // The kept window ends inside a record: read from where it starts.
      if (fromCache) {
        cache.last = null;
        continue;
      }
      // One record longer than the window: read a bigger one, up to a limit no real record reaches.
      if (window >= MAX_RECORD_BYTES) throw new UnreadableFile(`A row starting at byte ${at} runs past ${MAX_RECORD_BYTES >> 20} MB without ending, so this file is not delimited text a store can read.`, "damaged");
      window = Math.min(MAX_RECORD_BYTES, window * 4);
      cache.last = null;
      continue;
    }
    for (const r of found) {
      if (!isBlank(r.fields)) rows.push({ n: row, values: r.fields });
      row++;
    }
    at += found[found.length - 1]!.end;
    // With a byte limit, one window is the batch: the caller asks again from where it stopped.
    if (limit.bytes) break;
  }
  return { rows, next: at < source.size ? { at, row } : null, deleted: 0 };
}

export interface OpenDelimitedOptions {
  /** The code page a person set for its text: read in it, unless the file begins with a byte order mark. */
  codePage?: SetCodePage | null;
}

/** A delimited file, opened: one table, its columns from the header (or numbered), its rows read by range. */
export async function openDelimited(source: ByteSource, options: OpenDelimitedOptions = {}): Promise<OpenedFile> {
  const set = options.codePage ?? null;
  const shape = await sniffDelimited(source, set ? encodingOfPage(set.page) : null);
  const windows: WindowCache = { last: null };
  const names = shape.header ?? Array.from({ length: shape.width }, (_, i) => `column ${i + 1}`);
  const columns: SourceColumn[] = names.map((name) => ({ name, originalType: "text" }));
  const delimiterName = shape.delimiter === "\t" ? "tabs" : shape.delimiter === "," ? "commas" : shape.delimiter === ";" ? "semicolons" : "pipes";
  const notes = [`Read as ${encodingName(shape.encoding)} text separated by ${delimiterName}${shape.header ? "" : ", with no header row"}.`];
  if (set) {
    const name = codePageName(set.page);
    notes.push(
      encodingName(shape.encoding) === name
        ? `${name} is the code page set for ${set.file}.`
        : `It begins with the byte order mark of ${encodingName(shape.encoding)}, so it was read as that and not as ${name}, the code page set for ${set.file}.`,
    );
  }
  return {
    format: "delimited",
    tables: [{ name: null, columns, rowCount: null, notes: shape.above ? [shape.above] : [] }],
    notes,
    rows: (table, cursor, limit) => {
      if (table !== 0) throw new RangeError(`A delimited file holds one table; asked for table ${table}.`);
      return readDelimitedRows(source, shape, cursor, limit, windows);
    },
  };
}
