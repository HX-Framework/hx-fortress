// dBase and FoxPro tables (.dbf), with their memo files (.fpt for FoxPro, .dbt for dBase), of any
// size: the header says where every record is, so a read takes a range of records and the cursor
// is the next record's number.
//
// The header's code page byte names the code page of the text (437 when an old DOS table leaves it
// unset, 1252 for a Visual FoxPro one), and mostly the text is in it. Where the text's words read
// right only in another (code-page.ts), the text is read in that one, and the notes say why: the
// words of up to the first 4 MB of records when the table opens, else of the first batch that
// holds a letter beyond A to Z. A code page a person set for the file wins over both.
//
// A record the town deleted is still in the file, marked with "*": it is skipped and counted.
// Values are text: dates "2019-01-07", date-times "2019-01-07 09:30:15", logicals "true" and
// "false", numbers as the file writes them, currency to at least two decimals; a memo is its text.
// Binary fields (general, picture, blob, varbinary) are not loaded, and the table's notes say so.

import { addWords, type CodePageGuess, guessCodePage, type SeenWord } from "./code-page.js";
import { codePageName } from "./jobs.js";
import type { DbcTable } from "./dbc.js";
import { type ByteSource, windowedSource } from "./source.js";
import { decode, encodingOfPage } from "./text.js";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SetCodePage, type SourceColumn, type SourceRow, UnreadableFile } from "./types.js";

/** A field of a dBase or FoxPro table. */
export interface DbfField {
  name: string;
  /** Its type letter: C, N, F, D, L, M, I, Y, T, B, V, G, P, W, Q, O, +, @, 0. */
  type: string;
  /** Where it starts in a record (the deletion mark is byte 0). */
  offset: number;
  length: number;
  decimals: number;
  /** Visual FoxPro's field flags: 0x01 a system field, 0x02 nullable, 0x04 binary. */
  flags: number;
  /** The bit in _NullFlags that says it is null. */
  nullBit: number | null;
  /** The bit in _NullFlags that says a varchar's length is in its last byte. */
  lengthBit: number | null;
}

export interface DbfHeader {
  version: number;
  /** The records the header counts, deleted ones included. */
  records: number;
  headerLength: number;
  recordLength: number;
  /** The code page the text is in, by number. */
  codePage: number;
  /** The fields a person sees, in order; _NullFlags is kept apart. */
  fields: DbfField[];
  nullFlags: DbfField | null;
  /** How its memo file is laid out, for a table with memo fields. */
  memo: "fpt" | "dbt3" | "dbt4" | null;
  /** dBase 7 writes numbers big-endian with the sign bit flipped. */
  level7: boolean;
  /**
   * The database a Visual FoxPro table belongs to, as its header names it after the fields: a path
   * to its container (`..\data\town.dbc`). Null for a free table, and for dBase and older FoxPro.
   */
  backlink: string | null;
}

/** How long a Visual FoxPro header's backlink is, after the fields' terminator. */
const BACKLINK_BYTES = 263;

/** The code page a dBase or FoxPro code page byte names. */
const CODE_PAGE_OF_BYTE: Readonly<Record<number, number>> = {
  0x01: 437, 0x02: 850, 0x03: 1252, 0x04: 10000, 0x08: 865, 0x09: 437, 0x0a: 850, 0x0b: 437, 0x0d: 437, 0x0e: 850,
  0x0f: 437, 0x10: 850, 0x11: 437, 0x12: 850, 0x14: 850, 0x15: 437, 0x16: 850, 0x17: 865, 0x18: 437, 0x19: 437,
  0x1a: 850, 0x1b: 437, 0x1c: 863, 0x1d: 850, 0x1f: 852, 0x22: 852, 0x23: 852, 0x24: 860, 0x25: 850, 0x26: 866,
  0x37: 850, 0x40: 852, 0x50: 874, 0x57: 1252, 0x58: 1252, 0x59: 1252, 0x64: 852, 0x65: 866, 0x66: 865, 0x67: 861,
  0x6a: 737, 0x6b: 857, 0x6c: 863, 0x7c: 874, 0x86: 737, 0x87: 852, 0x88: 857, 0x96: 10007, 0x97: 10029,
  0x98: 10006, 0xc8: 1250, 0xc9: 1251, 0xca: 1254, 0xcb: 1253, 0xcc: 1257,
};

const VISUAL_FOXPRO = new Set([0x30, 0x31, 0x32]);
const DBASE_7 = new Set([0x04, 0x8c]);
const KNOWN_VERSIONS = new Set([0x02, 0x03, 0x04, 0x30, 0x31, 0x32, 0x43, 0x63, 0x83, 0x8b, 0x8c, 0xcb, 0xe5, 0xf5, 0xfb]);
/** Types whose values are bytes, not text: never loaded. */
const BINARY_TYPES = new Set(["G", "P", "W", "Q", "0"]);
const MEMO_TYPES = new Set(["M", "G", "P", "W"]);

const u16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000;
const u32be = (b: Uint8Array, at: number): number => b[at]! * 0x1000000 + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);

/** Whether the opening bytes look like a dBase or FoxPro table of this size. */
export function looksLikeDbf(head: Uint8Array, size: number): boolean {
  if (head.byteLength < 32 || !KNOWN_VERSIONS.has(head[0]!)) return false;
  const month = head[2]!;
  const day = head[3]!;
  if (month > 12 || day > 31) return false;
  const records = u32(head, 4);
  const headerLength = u16(head, 8);
  const recordLength = u16(head, 10);
  if (headerLength < 33 || recordLength < 2 || headerLength > size) return false;
  // The records fit in the file, give or take its end-of-file mark (a truncated file still opens).
  return headerLength + records * recordLength <= size + recordLength + 1;
}

/** The header of a dBase or FoxPro table. */
export async function readDbfHeader(source: ByteSource): Promise<DbfHeader> {
  const top = await source.read(0, 32);
  if (!looksLikeDbf(top, source.size)) throw new UnreadableFile("This file is not a dBase or FoxPro table its header can be read from.", "damaged");
  const version = top[0]!;
  const headerLength = u16(top, 8);
  const head = await source.read(0, headerLength);
  const level7 = DBASE_7.has(version);
  const descriptor = level7 ? 48 : 32;
  const level7Start = 68;
  const fields: DbfField[] = [];
  let nullFlags: DbfField | null = null;
  let offset = 1;
  let at = level7 ? level7Start : 32;
  for (; at + descriptor <= headerLength && head[at] !== 0x0d; at += descriptor) {
    const nameBytes = head.subarray(at, at + (level7 ? 32 : 11));
    const zero = nameBytes.indexOf(0);
    const name = decode(zero >= 0 ? nameBytes.subarray(0, zero) : nameBytes, { kind: "code-page", page: 1252 }).trim();
    const type = String.fromCharCode(head[at + (level7 ? 32 : 11)]!).toUpperCase();
    let length = head[at + (level7 ? 33 : 16)]!;
    const decimals = head[at + (level7 ? 34 : 17)]!;
    const flags = level7 ? 0 : head[at + 18]!;
    // Clipper and FoxBASE write a character field longer than 255 with the decimals byte as its high byte.
    if (type === "C" && !VISUAL_FOXPRO.has(version) && !level7 && decimals > 0) length += decimals << 8;
    const field: DbfField = { name, type, offset, length, decimals: type === "C" ? 0 : decimals, flags, nullBit: null, lengthBit: null };
    offset += length;
    if (type === "0" || (flags & 0x01 && name.toUpperCase() === "_NULLFLAGS")) nullFlags = field;
    else fields.push(field);
  }
  if (!fields.length) throw new UnreadableFile("This dBase or FoxPro table names no fields.", "damaged");
  // A table of a database names its container after the fields' terminator; a free table leaves it empty.
  const link = VISUAL_FOXPRO.has(version) && head[at] === 0x0d ? head.subarray(at + 1, Math.min(headerLength, at + 1 + BACKLINK_BYTES)) : null;
  const linkEnd = link ? link.indexOf(0) : -1;
  const backlink = link ? decode(linkEnd >= 0 ? link.subarray(0, linkEnd) : link, { kind: "code-page", page: 1252 }).trim() || null : null;
  const recordLength = u16(top, 10);
  if (offset > recordLength) throw new UnreadableFile("This dBase or FoxPro table's fields are longer than its records.", "damaged");
  // Visual FoxPro's null and varchar bits, one per nullable field and one per varchar, in field order.
  if (nullFlags) {
    let bit = 0;
    for (const f of fields) {
      if (f.type === "V" || f.type === "Q") f.lengthBit = bit++;
      if (f.flags & 0x02) f.nullBit = bit++;
    }
  }
  const codeByte = top[29]!;
  const codePage = CODE_PAGE_OF_BYTE[codeByte] ?? (VISUAL_FOXPRO.has(version) ? 1252 : 437);
  const hasMemo = fields.some((f) => MEMO_TYPES.has(f.type) || (f.type === "B" && !VISUAL_FOXPRO.has(version)));
  const memo = !hasMemo ? null : version === 0x83 ? "dbt3" : version === 0x8b || version === 0xcb || version === 0x8c ? "dbt4" : "fpt";
  return { version, records: u32(top, 4), headerLength, recordLength, codePage, fields, nullFlags, memo, level7, backlink };
}

/** The type a person reads in the catalog: "C(30)", "N(10,2)", "D", "M". */
export function dbfTypeName(f: DbfField): string {
  if (f.type === "C" || f.type === "V") return `${f.type}(${f.length})`;
  if (f.type === "N" || f.type === "F") return f.decimals ? `${f.type}(${f.length},${f.decimals})` : `${f.type}(${f.length})`;
  return f.type;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** A date from a day count (Julian day number) and milliseconds into the day. */
function fromJulian(day: number, ms: number): string | null {
  if (!day) return null;
  const at = new Date((day - 2440588) * 86_400_000 + ms);
  if (Number.isNaN(at.getTime())) return null;
  const date = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const rest = at.getUTCMilliseconds();
  return `${date} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}${rest ? `.${pad(rest, 3)}` : ""}`;
}

/** An 8-byte little-endian integer of ten-thousandths as a decimal, with at least two decimals. */
function currency(b: Uint8Array): string {
  const view = new DataView(b.buffer, b.byteOffset, 8);
  const v = view.getBigInt64(0, true);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / 10000n;
  let frac = String(abs % 10000n).padStart(4, "0");
  while (frac.length > 2 && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * dBase 7 writes a double's bytes big-endian, so they sort as bytes: a positive one with its sign
 * bit set, a negative one with every bit inverted.
 */
function level7Bytes(b: Uint8Array): Uint8Array {
  const out = Uint8Array.from(b);
  if (out[0]! & 0x80) out[0]! &= 0x7f;
  else for (let i = 0; i < out.length; i++) out[i] = ~out[i]! & 0xff;
  return out;
}

/**
 * A 4-byte integer field ("I", "+"): little-endian in FoxPro; in dBase 7 big-endian with only its
 * sign bit flipped, so it sorts as bytes.
 */
export function dbfInteger(raw: Uint8Array, level7: boolean): number {
  const view = new DataView(raw.buffer, raw.byteOffset, 4);
  return level7 ? view.getUint32(0, false) ^ 0x80000000 : view.getInt32(0, true);
}

const ascii = (b: Uint8Array): string => decode(b, { kind: "code-page", page: 1252 });

/** Reads a memo file's memos by block number. */
interface MemoReader {
  read(block: number): Promise<Uint8Array | null>;
}

/** How far from the last memo a memo may start and still be read through the windows. */
const MEMO_NEAR = 1 << 20;
/** What one read takes of a memo far from the last: its header and, mostly, all of its text. */
const MEMO_FAR_READ = 8 << 10;

function memoReader(source: ByteSource, layout: "fpt" | "dbt3" | "dbt4", head: Uint8Array): MemoReader {
  const windowed = windowedSource(source);
  const blockSize = layout === "fpt" ? (((head[6]! << 8) | head[7]!) || 512) : layout === "dbt4" ? u16(head, 20) || 512 : 512;
  let lastEnd = 0;
  /**
   * A memo's header and its text. Memos read in record order (most files) come through 1 MB
   * windows; one far from the last (a memo edited later is written at the end of the file) is
   * read alone, so a table whose memos are out of order does not read a window for each.
   */
  const withLength = async (at: number, lengthOf: (top: Uint8Array) => number | null): Promise<Uint8Array | null> => {
    const near = at >= lastEnd - MEMO_NEAR && at <= lastEnd + MEMO_NEAR;
    const first = near ? await windowed.read(at, 8) : await source.read(at, Math.min(MEMO_FAR_READ, source.size - at));
    if (first.byteLength < 8) return null;
    const length = lengthOf(first);
    if (length === null) return null;
    const take = Math.max(0, Math.min(length, source.size - at - 8));
    lastEnd = at + 8 + take;
    if (!near && 8 + take <= first.byteLength) return first.subarray(8, 8 + take);
    return near ? windowed.read(at + 8, take) : source.read(at + 8, take);
  };
  return {
    async read(block) {
      if (block <= 0) return null;
      const at = block * blockSize;
      if (at >= source.size) return null;
      if (layout === "fpt") return withLength(at, (top) => u32be(top, 4));
      if (layout === "dbt4") {
        const top = await windowed.read(at, 8);
        if (top[0] === 0xff && top[1] === 0xff && top[2] === 0x08 && top[3] === 0x00) return withLength(at, (t) => u32(t, 4) - 8);
      }
      // dBase III: the text runs to an end-of-file mark (0x1A), a block at a time.
      const parts: Uint8Array[] = [];
      for (let p = at; p < source.size; p += blockSize) {
        const chunk = await windowed.read(p, blockSize);
        const end = chunk.indexOf(0x1a);
        if (end >= 0) {
          parts.push(chunk.subarray(0, end));
          break;
        }
        parts.push(chunk);
        if (chunk.byteLength < blockSize) break;
      }
      const total = parts.reduce((n, p) => n + p.byteLength, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) out.set(p, o), (o += p.byteLength);
      return out;
    },
  };
}

/** The block number a memo field points at: four binary bytes in Visual FoxPro, ten digits elsewhere. */
function memoBlock(raw: Uint8Array): number {
  if (raw.byteLength === 4) return u32(raw, 0);
  const digits = ascii(raw).trim();
  return /^\d+$/.test(digits) ? Number(digits) : 0;
}

const isNull = (bits: Uint8Array | null, bit: number | null): boolean => bit != null && bits != null && ((bits[bit >> 3]! >> (bit & 7)) & 1) === 1;

/** The record's _NullFlags, for a Visual FoxPro table that has them. */
const nullBitsOf = (h: DbfHeader, record: Uint8Array): Uint8Array | null => (h.nullFlags ? record.subarray(h.nullFlags.offset, h.nullFlags.offset + h.nullFlags.length) : null);

/** Fields whose values are text in the table's code page: character, varchar and memo. */
const TEXT_TYPES = new Set(["C", "V", "M"]);

/** A character or varchar field's bytes, before they are read as text; null for a null. */
function textBytes(f: DbfField, record: Uint8Array, bits: Uint8Array | null): Uint8Array | null {
  if (isNull(bits, f.nullBit)) return null;
  const raw = record.subarray(f.offset, f.offset + f.length);
  if (f.type !== "V") return raw;
  // A varchar that does not fill its field keeps its length in its last byte.
  const used = isNull(bits, f.lengthBit) ? raw[raw.byteLength - 1]! : raw.byteLength;
  return raw.subarray(0, Math.min(used, raw.byteLength));
}

/** A memo's bytes, before they are read as text; null for none. */
async function memoBytes(f: DbfField, record: Uint8Array, bits: Uint8Array | null, memos: MemoReader | null): Promise<Uint8Array | null> {
  if (!memos || isNull(bits, f.nullBit)) return null;
  const block = memoBlock(record.subarray(f.offset, f.offset + f.length));
  return block ? memos.read(block) : null;
}

/** A text field's bytes as text in its code page: a character field without the spaces it is padded with; null for none. */
function textValue(f: DbfField, bytes: Uint8Array, page: number): string | null {
  const v = f.type === "C" ? decode(bytes, encodingOfPage(page)).replace(/[\s\u0000]+$/, "") : decode(bytes, encodingOfPage(page));
  return v === "" ? null : v;
}

/** One value of a field that is not text, as text, or null. */
async function fieldValue(h: DbfHeader, f: DbfField, record: Uint8Array, bits: Uint8Array | null): Promise<string | null> {
  if (isNull(bits, f.nullBit)) return null;
  const raw = record.subarray(f.offset, f.offset + f.length);
  switch (f.type) {
    case "N":
    case "F": {
      const v = ascii(raw).replace(/\u0000/g, "").trim();
      return v === "" ? null : v;
    }
    case "D": {
      // Some writers fill an empty date with NUL bytes, not spaces.
      const v = ascii(raw).replace(/\u0000/g, "").trim();
      if (!v || /^0+$/.test(v)) return null;
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
      return m ? `${m[1]}-${m[2]}-${m[3]}` : v;
    }
    case "L": {
      const c = String.fromCharCode(raw[0] ?? 0x20).toUpperCase();
      return c === "T" || c === "Y" ? "true" : c === "F" || c === "N" ? "false" : null;
    }
    case "I":
    case "+": {
      return String(dbfInteger(raw, h.level7));
    }
    case "Y":
      return raw.byteLength === 8 ? currency(raw) : null;
    case "T":
      return raw.byteLength === 8 ? fromJulian(u32(raw, 0), u32(raw, 4)) : null;
    case "O": {
      const b = level7Bytes(raw);
      const v = new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, false);
      return Number.isFinite(v) ? String(v) : null;
    }
    case "B": {
      if (VISUAL_FOXPRO.has(h.version)) {
        const v = new DataView(raw.buffer, raw.byteOffset, 8).getFloat64(0, true);
        return Number.isFinite(v) ? String(v) : null;
      }
      return null; // a dBase binary memo: bytes, not text
    }
    default:
      return null;
  }
}

/**
 * A Visual FoxPro table's database, from the container that came with it (dbc.ts): the container's
 * file name, and the table it names by the table's own field names; `tableOf` is null for a file
 * that is not a container.
 */
export interface DbfDatabase {
  file: string;
  tableOf: ((headerNames: readonly string[]) => DbcTable | null) | null;
  /** Why the container that came was not read, in words after its name: "could not be read". */
  unread?: string;
}

export interface OpenDbfOptions {
  /** Its memo file (.fpt or .dbt), when the store has it. */
  memo?: ByteSource | null;
  /**
   * The database containers that came with it, nearest first: the one its header names gives the
   * table and its fields their long names; of several of that name, the first whose tables fit it.
   */
  databases?: readonly DbfDatabase[];
  /** The table's own file name, for the notes. */
  fileName?: string;
  /** The code page a person set for its text: read in it, whatever its header names or its text shows. */
  codePage?: SetCodePage | null;
}

/** What LOAD reads of a table's records when it opens the table, at most: their words tell the code page of its text. */
export const SAMPLE_BYTES = 4 << 20;
/** Words past ASCII enough to tell it, in what the table's opening read reads and in one batch. */
const ENOUGH_WORDS = 400;

/** Why the text is read in another code page than its header names, in words. */
function disagreement(guess: CodePageGuess, named: number): string {
  const ex = guess.example;
  const more = guess.wrongInNamed - 1;
  const shown = ex ? `: ${codePageName(named)} would read "${ex.read}" as "${ex.named}"${more > 0 ? `, and ${more} more word${more === 1 ? "" : "s"} wrong too` : ""}` : "";
  return `Its header names ${codePageName(named)}, but its text is ${codePageName(guess.page)}${shown}.`;
}

/** The words past ASCII in the character and varchar fields of up to the first SAMPLE_BYTES of records. */
async function openingWords(source: ByteSource, h: DbfHeader, total: number): Promise<Map<string, SeenWord>> {
  const seen = new Map<string, SeenWord>();
  const text = h.fields.filter((f) => f.type === "C" || f.type === "V");
  if (!text.length) return seen;
  const perRead = Math.max(1, Math.floor((1 << 20) / h.recordLength));
  const most = Math.min(total, Math.max(1, Math.floor(SAMPLE_BYTES / h.recordLength)));
  for (let from = 0; from < most && seen.size < ENOUGH_WORDS; from += perRead) {
    const count = Math.min(perRead, most - from);
    const bytes = await source.read(h.headerLength + from * h.recordLength, count * h.recordLength);
    for (let i = 0; i < count; i++) {
      const record = bytes.subarray(i * h.recordLength, (i + 1) * h.recordLength);
      if (record.byteLength < h.recordLength || record[0] === 0x1a) return seen;
      if (record[0] === 0x2a) continue;
      const bits = nullBitsOf(h, record);
      for (const f of text) {
        const raw = textBytes(f, record, bits);
        if (raw) addWords(raw, seen, ENOUGH_WORDS);
      }
    }
  }
  return seen;
}

/**
 * A database table's long names, from its database's container (dbc.ts). A free table, whose
 * header names no database, keeps its names, whatever container came beside it. Of the containers
 * that came, those of the name its header gives are tried in order, and the first whose tables fit
 * names it. A table that keeps its header's names though its header names a database says why in
 * its notes.
 */
function longNamesOf(h: DbfHeader, databases: readonly DbfDatabase[], fileName: string | undefined, notes: string[]): DbcTable | null {
  if (!h.backlink) return null;
  const keeps = (why: string): null => {
    notes.push(`The columns keep the names in ${fileName ? `${fileName}'s` : "the table's own"} header, at most 10 characters each: ${why}`);
    return null;
  };
  const baseName = (path: string): string => path.replace(/^.*[\\/]/, "");
  const wanted = baseName(h.backlink);
  const named = databases.filter((d) => baseName(d.file).toLowerCase() === wanted.toLowerCase());
  if (!named.length) return keeps(`the container of its database, ${wanted}, did not come with it.`);
  const headerNames = h.fields.map((f) => f.name);
  for (const d of named) {
    const table = d.tableOf?.(headerNames);
    if (table) return table;
  }
  const first = named[0]!;
  return keeps(first.tableOf ? `${first.file} names no table with these fields.` : `${first.file} ${first.unread ?? "is not a Visual FoxPro database's container"}.`);
}

/** A dBase or FoxPro table, opened: its fields as columns, its records read by range. */
export async function openDbf(source: ByteSource, options: OpenDbfOptions = {}): Promise<OpenedFile> {
  const h = await readDbfHeader(source);
  const tableNotes: string[] = [];
  const fromDatabase = longNamesOf(h, options.databases ?? [], options.fileName, tableNotes);
  const nameOf = (f: DbfField): string => (fromDatabase ? fromDatabase.fields[h.fields.indexOf(f)]! : f.name);
  const memoHead = h.memo && options.memo ? await options.memo.read(0, 512) : null;
  const memos = h.memo && options.memo && memoHead ? memoReader(options.memo, h.memo, memoHead) : null;
  const memoFields = h.fields.filter((f) => f.type === "M");
  if (memoFields.length && !memos) {
    const wanted = `${(options.fileName ?? "the table").replace(/\.[^.]+$/, "")}.${h.memo === "fpt" ? "fpt" : "dbt"}`;
    tableNotes.push(`${memoFields.map(nameOf).join(", ")} ${memoFields.length > 1 ? "are" : "is"} empty: the memo file ${wanted} did not come with this table. Upload the two together and load again.`);
  }
  const binary = h.fields.filter((f) => BINARY_TYPES.has(f.type) || (f.type === "B" && !VISUAL_FOXPRO.has(h.version)) || f.type === "@");
  if (binary.length) tableNotes.push(`${binary.map(nameOf).join(", ")} hold${binary.length > 1 ? "" : "s"} binary values, which a store does not load.`);
  const available = Math.max(0, Math.floor((source.size - h.headerLength) / h.recordLength));
  if (available < h.records) tableNotes.push(`The file ends after ${available} of the ${h.records} records its header counts.`);
  const columns: SourceColumn[] = h.fields.map((f) => ({ name: nameOf(f), originalType: dbfTypeName(f) }));
  const total = Math.min(h.records, available);

  // The code page of the text: the one a person set, else what the words of the opening records
  // show, else, with no word past ASCII in them, what the first batch that holds one shows.
  const kind = VISUAL_FOXPRO.has(h.version) ? "Visual FoxPro" : h.memo === "fpt" ? "FoxPro" : "dBase";
  const named = h.codePage;
  let atOpen: number | null;
  let note: string;
  const set = options.codePage ?? null;
  if (set) {
    atOpen = set.page;
    note = `Read as a ${kind} table in ${codePageName(set.page)}, the code page set for ${set.file}${set.page !== named ? `; its header names ${codePageName(named)}` : ""}.`;
  } else {
    const seen = await openingWords(source, h, total);
    const guess = seen.size ? guessCodePage(seen, named) : null;
    atOpen = guess ? guess.page : null;
    note = guess && guess.page !== named ? `Read as a ${kind} table in ${codePageName(guess.page)}. ${disagreement(guess, named)}` : `Read as a ${kind} table in ${codePageName(named)}.`;
  }
  /** The code page the text is read in: null until a batch shows it, when the opening records hold no word past ASCII. */
  let page = atOpen;

  async function rows(table: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    if (table !== 0) throw new RangeError(`A dBase table is one table; asked for table ${table}.`);
    // A read from the first record chooses as the first one did; a later batch reads on in the code
    // page its cursor names, which the batch that chose it put there.
    page = cursor === null ? atOpen : typeof cursor.page === "number" ? cursor.page : page;
    const from = cursor?.record ?? 0;
    const byBytes = Math.max(1, Math.floor((limit.bytes ?? 1 << 20) / h.recordLength));
    const count = Math.min(total - from, limit.rows, byBytes);
    if (count <= 0) return { rows: [], next: null, deleted: 0 };
    const bytes = await source.read(h.headerLength + from * h.recordLength, count * h.recordLength);
    const out: SourceRow[] = [];
    // Text values are read as text once the batch's code page is known.
    const text: { row: SourceRow; at: number; field: DbfField; bytes: Uint8Array }[] = [];
    const seen = page === null ? new Map<string, SeenWord>() : null;
    let firstSeen = 0;
    let deleted = 0;
    let i = 0;
    for (; i < count; i++) {
      const record = bytes.subarray(i * h.recordLength, (i + 1) * h.recordLength);
      if (record.byteLength < h.recordLength || record[0] === 0x1a) break; // the end-of-file mark
      if (record[0] === 0x2a) {
        deleted++;
        continue;
      }
      const bits = nullBitsOf(h, record);
      const row: SourceRow = { n: from + i + 1, values: [] };
      for (const f of h.fields) {
        if (!TEXT_TYPES.has(f.type)) {
          row.values.push(await fieldValue(h, f, record, bits));
          continue;
        }
        row.values.push(null);
        const raw = f.type === "M" ? await memoBytes(f, record, bits, memos) : textBytes(f, record, bits);
        if (!raw) continue;
        text.push({ row, at: row.values.length - 1, field: f, bytes: raw });
        if (seen && seen.size < ENOUGH_WORDS) {
          addWords(raw, seen, ENOUGH_WORDS);
          if (!firstSeen && seen.size) firstSeen = row.n;
        }
      }
      out.push(row);
    }
    const notes: string[] = [];
    if (seen?.size) {
      const guess = guessCodePage(seen, named);
      page = guess.page;
      if (guess.page !== named) notes.push(`From record ${firstSeen.toLocaleString("en-US")}, the first with a letter beyond A to Z, it was read in ${codePageName(guess.page)}. ${disagreement(guess, named)}`);
    }
    for (const t of text) t.row.values[t.at] = textValue(t.field, t.bytes, page ?? named);
    const next = from + i;
    const cursorOut = next < total && i === count ? { record: next, ...(page !== null ? { page } : {}) } : null;
    return { rows: out, next: cursorOut, deleted, ...(notes.length ? { notes } : {}) };
  }

  return {
    format: "dbf",
    tables: [{ name: fromDatabase ? fromDatabase.name : null, columns, rowCount: total, notes: tableNotes }],
    notes: [note],
    rows,
  };
}
