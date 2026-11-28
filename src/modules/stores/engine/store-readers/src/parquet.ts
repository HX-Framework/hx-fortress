// Apache Parquet files, read by range. A Parquet file keeps its rows in row groups, and each row
// group keeps each column as a chunk of pages, compressed page by page. This reader reads the
// footer from the end of the file (the schema, and where every column chunk is), then reads a row
// group a page at a time: each column holds only the page its next row is on, and the column's
// dictionary page, never the whole row group. pyarrow writes up to 1,048,576 rows in a row group
// by default, in pages of 20,000 rows: read whole with hyparquet's own reader, such a row group of
// a 17-column table (96 MB) took 456 MB of heap; read a page at a time it fits in a store's object
// (README.md, "Size caps"). DuckDB writes each column chunk as one page, so its row groups are
// held whole; their size is what the cap below measures.
//
// hyparquet (pure JavaScript, with Snappy built in) parses the footer, the page headers and the
// encodings; fzstd reads Zstandard and fflate gzip. A flat column's page is kept as its own bytes
// with typed arrays of offsets and dictionary indexes, and each value becomes text only when its
// row is read. Lists, maps and structs go through hyparquet's assembly and become JSON text.
//
// Values are text, or null: integers in decimal (64-bit ones exactly), doubles as JavaScript
// prints them, floats as the shortest decimal that is the same float, booleans "true" and
// "false", dates "2019-01-07", timestamps "2019-01-07 09:30:15" (fractional seconds only when
// not zero, no time zone), times "09:30:15", decimals exactly from their unscaled integer, UUIDs
// in their canonical form, an empty string as null. A binary value of up to 4,096 bytes is
// X'0A1B…' in hexadecimal; a longer one is not loaded. A column's type is its logical type in
// words: "string", "int64", "timestamp(us, UTC)", "decimal(10,2)", "list<string>", "struct".
//
// The cursor is the row's index in the file. Reading on from the last batch goes on in the open
// pages; any other cursor (or a newly opened file) finds its row group and, in each column, the
// page holding the row from the page headers alone.

import { assembleNested } from "hyparquet/src/assemble.js";
import { parquetHeader, readPage } from "hyparquet/src/column.js";
import { convert, DEFAULT_PARSERS, parseFloat16 } from "hyparquet/src/convert.js";
import { decompressPage } from "hyparquet/src/datapage.js";
import { deltaBinaryUnpack, deltaByteArray, deltaLengthByteArray } from "hyparquet/src/delta.js";
import { byteStreamSplit, readRleBitPackedHybrid } from "hyparquet/src/encoding.js";
import { parquetMetadata, parquetSchema } from "hyparquet/src/metadata.js";
import { readPlain } from "hyparquet/src/plain.js";
import { getMaxDefinitionLevel, getTreePath, isListLike, isMapLike } from "hyparquet/src/schema.js";
import type { ColumnMetaData, Compressors, DataReader, DecodedArray, Encoding, FileMetaData, PageHeader, ParquetParsers, ParquetType, RowGroup, SchemaElement, SchemaTree } from "hyparquet";
import { gunzipSync } from "fflate";
import { decompress as unzstd } from "fzstd";
import { singleText } from "./cells.js";
import type { ByteSource } from "./source.js";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SourceColumn, type SourceRow, type SourceTable, UnreadableFile } from "./types.js";

const MB = 1 << 20;

/**
 * The most of a row group a read may hold at once, as `heldBytes` estimates it from the footer:
 * each column's dictionary and largest page, or the whole column chunk where the footer does not
 * count its pages. Measured as the memory a read needs (README.md, "Size caps"); a file with a
 * row group above it is refused before any of its rows are read.
 */
export const PARQUET_HELD_CAP = 40 * MB;

/** The largest footer (the list of row groups and column chunks) a store reads; it stays in memory while the file is read. */
export const PARQUET_FOOTER_CAP = 8 * MB;

/** The least read from a column chunk at a time: page headers and small pages come several to a read. */
const MIN_READ = 64 << 10;
/** A page header longer than this is taken for a damaged one. */
const HEADER_MAX = 4 * MB;
/** The longest binary value loaded, as hexadecimal text. */
const BINARY_MAX = 4096;
/** A dictionary of up to this many values keeps each value's text once it is made. */
const CACHED_DICTIONARY = 16_384;

const utf8 = new TextDecoder("utf-8");

const COMPRESSORS: Compressors = {
  ZSTD: (input, size) => unzstd(input, new Uint8Array(size)),
  GZIP: (input, size) => gunzipSync(input, { out: new Uint8Array(size) }),
};
const READ_CODECS: ReadonlySet<string> = new Set(["UNCOMPRESSED", "SNAPPY", "ZSTD", "GZIP"]);
const CODEC_NAMES: Readonly<Record<string, string>> = { BROTLI: "Brotli", LZ4: "LZ4", LZ4_RAW: "LZ4", LZO: "LZO" };

/** hyparquet's value parsers for lists, maps and structs: an INT96 timestamp stays its nanoseconds since 1970. */
const PARSERS: ParquetParsers = { ...DEFAULT_PARSERS, timestampFromNanoseconds: (nanos: bigint) => nanos };

type ColumnDecoder = Parameters<typeof readPage>[2];

const damaged = (message: string): UnreadableFile => new UnreadableFile(message, "damaged");
const DAMAGED_FOOTER = "The footer of this Parquet file is damaged, so its columns cannot be read.";
const DAMAGED_PAGE = "A page of this Parquet file is damaged, so its rows cannot be read on from there.";

/** Whether a file starts like a Parquet file: "PAR1", or "PARE" for one whose footer is encrypted. It lives
 *  in format.ts, which reads a file's first bytes without loading a reader. */
export { looksLikeParquet } from "./format.js";

// ─── types and text ──────────────────────────────────────────────────────────

type Unit = "MILLIS" | "MICROS" | "NANOS";
type Kind = "string" | "int" | "uint32" | "uint64" | "float" | "double" | "boolean" | "date" | "timestamp" | "time" | "int96" | "decimal" | "uuid" | "float16" | "interval" | "binary" | "null";

/** How a leaf column's values become text, and its type in words. */
interface LeafType {
  kind: Kind;
  name: string;
  unit?: Unit;
  scale?: number;
}

const UNIT_NAME: Readonly<Record<Unit, string>> = { MILLIS: "ms", MICROS: "us", NANOS: "ns" };
const PER_SECOND: Readonly<Record<Unit, bigint>> = { MILLIS: 1000n, MICROS: 1_000_000n, NANOS: 1_000_000_000n };
const FRACTION_DIGITS: Readonly<Record<Unit, number>> = { MILLIS: 3, MICROS: 6, NANOS: 9 };

const timed = (kind: "timestamp" | "time", unit: Unit, utc: boolean): LeafType => ({ kind, unit, name: `${kind}(${UNIT_NAME[unit]}${utc ? ", UTC" : ""})` });

/** A leaf column's type, from its logical type, else its converted type, else its physical type. */
function leafType(e: SchemaElement): LeafType {
  const lt = e.logical_type;
  switch (lt?.type) {
    case "STRING":
      return { kind: "string", name: "string" };
    case "ENUM":
      return { kind: "string", name: "enum" };
    case "JSON":
      return { kind: "string", name: "json" };
    case "BSON":
      return { kind: "binary", name: "bson" };
    case "UUID":
      return { kind: "uuid", name: "uuid" };
    case "DATE":
      return { kind: "date", name: "date" };
    case "DECIMAL":
      return { kind: "decimal", name: `decimal(${lt.precision},${lt.scale})`, scale: lt.scale };
    case "TIMESTAMP":
      return timed("timestamp", lt.unit, lt.isAdjustedToUTC);
    case "TIME":
      return timed("time", lt.unit, lt.isAdjustedToUTC);
    case "INTEGER": {
      const name = `${lt.isSigned ? "int" : "uint"}${lt.bitWidth}`;
      return { kind: lt.isSigned ? "int" : e.type === "INT64" ? "uint64" : "uint32", name };
    }
    case "FLOAT16":
      return { kind: "float16", name: "float16" };
    case "INTERVAL":
      return { kind: "interval", name: "interval" };
    case "NULL":
      return { kind: "null", name: "null" };
    case "GEOMETRY":
      return { kind: "binary", name: "geometry" };
    case "GEOGRAPHY":
      return { kind: "binary", name: "geography" };
  }
  switch (e.converted_type) {
    case "UTF8":
      return { kind: "string", name: "string" };
    case "ENUM":
      return { kind: "string", name: "enum" };
    case "JSON":
      return { kind: "string", name: "json" };
    case "BSON":
      return { kind: "binary", name: "bson" };
    case "DATE":
      return { kind: "date", name: "date" };
    case "DECIMAL":
      return { kind: "decimal", name: `decimal(${e.precision ?? "?"},${e.scale ?? 0})`, scale: e.scale ?? 0 };
    // The converted timestamp and time types are the logical ones adjusted to UTC.
    case "TIMESTAMP_MILLIS":
      return timed("timestamp", "MILLIS", true);
    case "TIMESTAMP_MICROS":
      return timed("timestamp", "MICROS", true);
    case "TIME_MILLIS":
      return timed("time", "MILLIS", true);
    case "TIME_MICROS":
      return timed("time", "MICROS", true);
    case "UINT_8":
    case "UINT_16":
    case "UINT_32":
      return { kind: "uint32", name: e.converted_type.toLowerCase().replace("_", "") };
    case "UINT_64":
      return { kind: "uint64", name: "uint64" };
    case "INT_8":
    case "INT_16":
    case "INT_32":
    case "INT_64":
      return { kind: "int", name: e.converted_type.toLowerCase().replace("_", "") };
    case "INTERVAL":
      return { kind: "interval", name: "interval" };
  }
  switch (e.type) {
    case "BOOLEAN":
      return { kind: "boolean", name: "boolean" };
    case "INT32":
      return { kind: "int", name: "int32" };
    case "INT64":
      return { kind: "int", name: "int64" };
    case "INT96":
      return { kind: "int96", name: "timestamp(int96)" };
    case "FLOAT":
      return { kind: "float", name: "float" };
    case "DOUBLE":
      return { kind: "double", name: "double" };
    case "FIXED_LEN_BYTE_ARRAY":
      return { kind: "binary", name: `binary(${e.type_length ?? 0})` };
    default:
      return { kind: "binary", name: "binary" };
  }
}

/** A column's type in words, for a column with children too. */
function typeName(node: SchemaTree, inRepeat = false): string {
  const e = node.element;
  if (e.repetition_type === "REPEATED" && !inRepeat) return `list<${typeName(node, true)}>`;
  if (!node.children.length) return leafType(e).name;
  if (isListLike(node)) {
    const group = node.children[0]!;
    const element = group.children.length === 1 ? group.children[0]! : group;
    return `list<${typeName(element, element === group)}>`;
  }
  if (isMapLike(node)) return "map";
  if (e.logical_type?.type === "VARIANT") return "variant";
  return "struct";
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
const yearText = (y: number): string => (y < 0 ? `-${pad(-y, 4)}` : pad(y, 4));

/** A count of days from 1970-01-01 as a date, for any day an int32 can hold. */
export function parquetDate(days: number): string {
  // Howard Hinnant's days-to-civil, which holds for every proleptic Gregorian day.
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return `${yearText(yoe + era * 400 + (month <= 2 ? 1 : 0))}-${pad(month)}-${pad(day)}`;
}

/** A time of day from `units` since midnight, with fractional seconds only when they are not zero. */
function clockText(units: bigint, unit: Unit): string {
  const seconds = Number(units / PER_SECOND[unit]);
  const fraction = units % PER_SECOND[unit];
  const text = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  return fraction ? `${text}.${fraction.toString().padStart(FRACTION_DIGITS[unit], "0").replace(/0+$/, "")}` : text;
}

/** A timestamp from `units` since 1970-01-01 00:00:00, exactly. */
export function parquetTimestamp(units: bigint, unit: Unit): string {
  const perDay = PER_SECOND[unit] * 86_400n;
  let days = units / perDay;
  let rest = units % perDay;
  if (rest < 0n) {
    rest += perDay;
    days -= 1n;
  }
  return `${parquetDate(Number(days))} ${clockText(rest, unit)}`;
}

/** A decimal from its unscaled integer, exactly. */
export function decimalText(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  let digits = (negative ? -unscaled : unscaled).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  } else if (scale < 0) digits += "0".repeat(-scale);
  return negative ? `-${digits}` : digits;
}

/** A big-endian two's-complement integer: a decimal's bytes. */
function bytesInteger(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return b.byteLength && b[0]! & 0x80 ? v - (1n << BigInt(8 * b.byteLength)) : v;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, "0"));

/** Bytes as X'0A1B…', or null for none or more than a store loads. */
function binaryText(b: Uint8Array): string | null {
  if (!b.byteLength || b.byteLength > BINARY_MAX) return null;
  let out = "X'";
  for (const x of b) out += HEX[x];
  return `${out}'`;
}

function uuidText(b: Uint8Array): string | null {
  if (b.byteLength !== 16) return binaryText(b);
  const hex = Array.from(b, (x) => HEX[x]!).join("").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An INTERVAL (months, days and milliseconds) as an ISO 8601 duration: "P1M2DT3.5S". */
function intervalText(b: Uint8Array): string | null {
  if (b.byteLength !== 12) return binaryText(b);
  const view = new DataView(b.buffer, b.byteOffset, 12);
  const months = view.getUint32(0, true);
  const days = view.getUint32(4, true);
  const ms = view.getUint32(8, true);
  const time = ms ? `T${ms / 1000}S` : "";
  return months || days || ms ? `P${months ? `${months}M` : ""}${days ? `${days}D` : ""}${time}` : "PT0S";
}

/** A half-precision float as the shortest decimal that rounds to it. */
function halfText(v: number): string {
  if (!Number.isFinite(v) || v === 0) return String(v);
  for (let digits = 1; digits < 6; digits++) {
    const candidate = Number(v.toPrecision(digits));
    const exponent = Math.min(15, Math.max(-14, Math.floor(Math.log2(Math.abs(candidate)))));
    const step = 2 ** (exponent - 10);
    if (Math.round(candidate / step) * step === v) return String(candidate);
  }
  return String(v);
}

/** An INT96 timestamp (nanoseconds of the day, then the Julian day) as nanoseconds since 1970. */
function int96Nanos(v: bigint): bigint {
  return ((v >> 64n) - 2_440_588n) * 86_400_000_000_000n + (v & 0xffff_ffff_ffff_ffffn);
}

/** A value as text, or null: what goes into a store's column. */
function textOf(t: LeafType, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  switch (t.kind) {
    case "string":
      if (v instanceof Uint8Array) return v.byteLength ? utf8.decode(v) : null;
      return v === "" ? null : String(v);
    case "int":
      return String(v);
    case "uint32":
      return typeof v === "number" ? String(v >>> 0) : String(v);
    case "uint64":
      return typeof v === "bigint" ? BigInt.asUintN(64, v).toString() : String(v);
    case "double":
      return typeof v === "number" ? (Number.isFinite(v) ? String(v) : null) : String(v);
    case "float":
      return typeof v === "number" ? (Number.isFinite(v) ? singleText(v) : null) : String(v);
    case "boolean":
      return v ? "true" : "false";
    case "date":
      return typeof v === "number" ? parquetDate(v) : null;
    case "timestamp":
      return typeof v === "bigint" ? parquetTimestamp(v, t.unit!) : typeof v === "number" ? parquetTimestamp(BigInt(v), t.unit!) : null;
    case "time": {
      const units = typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : -1n;
      return units >= 0n ? clockText(units, t.unit!) : null;
    }
    case "int96":
      return typeof v === "bigint" ? parquetTimestamp(v, "NANOS") : null;
    case "decimal": {
      const unscaled = typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : v instanceof Uint8Array && v.byteLength ? bytesInteger(v) : null;
      return unscaled === null ? null : decimalText(unscaled, t.scale ?? 0);
    }
    case "uuid":
      return v instanceof Uint8Array ? uuidText(v) : String(v);
    case "float16": {
      const n = v instanceof Uint8Array ? parseFloat16(v) : typeof v === "number" ? v : undefined;
      return n === undefined || !Number.isFinite(n) ? null : halfText(n);
    }
    case "interval":
      return v instanceof Uint8Array ? intervalText(v) : String(v);
    case "binary":
      return v instanceof Uint8Array ? binaryText(v) : String(v);
    case "null":
      return null;
  }
}

/** A value inside a list, map or struct, as JSON text: 64-bit integers and decimals as strings, so they stay exact. */
function jsonLeaf(t: LeafType, v: unknown): string {
  if (v === null || v === undefined) return "null";
  switch (t.kind) {
    case "string":
      return JSON.stringify(v instanceof Uint8Array ? utf8.decode(v) : String(v));
    case "int":
    case "uint32":
    case "uint64":
      return typeof v === "number" ? textOf(t, v)! : JSON.stringify(textOf(t, v));
    case "double":
    case "float":
    case "float16":
      return textOf(t, v) ?? "null";
    case "boolean":
      return v ? "true" : "false";
    default: {
      const text = textOf(t, v);
      return text === null ? "null" : JSON.stringify(text);
    }
  }
}

/** A value hyparquet decoded on its own (a VARIANT's), as JSON text. */
function genericJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "null" : JSON.stringify(parquetTimestamp(BigInt(v.getTime()), "MILLIS"));
  if (v instanceof Uint8Array) return JSON.stringify(binaryText(v));
  if (Array.isArray(v)) return `[${v.map(genericJson).join(",")}]`;
  if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${genericJson(x)}`).join(",")}}`;
  return "null";
}

const leafTypes = new WeakMap<SchemaTree, LeafType>();
const leafTypeOf = (node: SchemaTree): LeafType => {
  let t = leafTypes.get(node);
  if (!t) leafTypes.set(node, (t = leafType(node.element)));
  return t;
};

/** A list, map or struct as compact JSON text, its leaves by their own types. */
function jsonOf(v: unknown, node: SchemaTree, inRepeat = false): string {
  if (v === null || v === undefined) return "null";
  const e = node.element;
  if (e.repetition_type === "REPEATED" && !inRepeat) return Array.isArray(v) ? `[${v.map((x) => jsonOf(x, node, true)).join(",")}]` : "null";
  if (!node.children.length) return jsonLeaf(leafTypeOf(node), v);
  if (isListLike(node)) {
    const group = node.children[0]!;
    const element = group.children.length === 1 ? group.children[0]! : group;
    return Array.isArray(v) ? `[${v.map((x) => jsonOf(x, element, element === group)).join(",")}]` : "null";
  }
  if (typeof v !== "object") return "null";
  const o = v as Record<string, unknown>;
  if (isMapLike(node)) {
    const pair = node.children[0]!;
    const value = pair.children.find((c) => c.element.name === "value") ?? pair.children[1];
    return `{${Object.keys(o).map((k) => `${JSON.stringify(k)}:${value ? jsonOf(o[k], value) : "null"}`).join(",")}}`;
  }
  if (e.logical_type?.type === "VARIANT") return genericJson(v);
  return `{${node.children.map((c) => `${JSON.stringify(c.element.name)}:${jsonOf(o[c.element.name], c)}`).join(",")}}`;
}

// ─── a column chunk's bytes, read forward by range ───────────────────────────

/**
 * A column chunk's bytes, read a window at a time: a window holds at least MIN_READ bytes, or the
 * page about to be read and the next page's header, so a chunk of small pages takes few reads.
 */
class ChunkBytes {
  private window: Uint8Array = new Uint8Array(0);
  private at = 0;
  private ahead = MIN_READ;

  constructor(
    private readonly source: ByteSource,
    readonly start: number,
    readonly end: number,
  ) {}

  private async load(from: number, length: number): Promise<void> {
    const bytes = await this.source.read(from, Math.min(this.end - from, Math.max(length, this.ahead)));
    if (bytes.byteLength < length) throw damaged("This Parquet file is cut short: a column's pages run past its end.");
    this.window = bytes;
    this.at = from;
  }

  private holds(from: number, length: number): boolean {
    return from >= this.at && from + length <= this.at + this.window.byteLength;
  }

  /** The page header at `pos`, and where the page's own bytes start. */
  async header(pos: number): Promise<{ header: PageHeader; dataAt: number }> {
    let length = Math.min(this.end - pos, 1024);
    for (;;) {
      if (!this.holds(pos, length)) await this.load(pos, length);
      const reader: DataReader = { view: new DataView(this.window.buffer, this.window.byteOffset, this.window.byteLength), offset: pos - this.at };
      try {
        const header = parquetHeader(reader);
        return { header, dataAt: this.at + reader.offset };
      } catch {
        // A header can run past the window: read further, up to the chunk's end.
        const windowEnd = this.at + this.window.byteLength;
        if (windowEnd >= this.end || windowEnd - pos >= HEADER_MAX) throw damaged(DAMAGED_PAGE);
        length = Math.min(this.end - pos, HEADER_MAX, Math.max(length * 4, windowEnd - pos + 1));
      }
    }
  }

  /** The `length` bytes at `from`, inside the chunk. */
  async take(from: number, length: number): Promise<Uint8Array> {
    if (!this.holds(from, length)) await this.load(from, length);
    return this.window.subarray(from - this.at, from - this.at + length);
  }

  /** A data page of `length` bytes was read: the next is likely about as long, so it is read with its header in one go. */
  expect(length: number): void {
    this.ahead = Math.max(MIN_READ, length + 8192);
  }

  /**
   * Lets go of the window's bytes before `upTo` once a compressed page there is decompressed: what
   * is left of the window (the next page's header, a small page) is kept as a copy, so a large
   * page's compressed bytes are not held beside its decompressed ones.
   */
  release(upTo: number): void {
    const rest = this.window.subarray(Math.max(0, upTo - this.at));
    if (rest.byteLength * 2 < this.window.byteLength) {
      this.window = rest.slice();
      this.at = Math.max(this.at, upTo);
    }
  }
}

/** A page header's sizes, checked against its column chunk before anything is allocated for it. */
function checkHeader(h: PageHeader, dataAt: number, chunk: ChunkInfo): void {
  const values = h.data_page_header?.num_values ?? h.data_page_header_v2?.num_values ?? h.dictionary_page_header?.num_values ?? 0;
  if (!(h.compressed_page_size >= 0) || dataAt + h.compressed_page_size > chunk.end || !(h.uncompressed_page_size >= 0) || !(values >= 0) || values > chunk.values) {
    throw damaged(DAMAGED_PAGE);
  }
  if (h.uncompressed_page_size > PARQUET_HELD_CAP) {
    throw new UnreadableFile(`This Parquet file has a page of ${Math.ceil(h.uncompressed_page_size / MB)} MB, and a store reads pages of up to ${PARQUET_HELD_CAP / MB} MB. Write it with smaller pages or row groups, or export it to CSV, and upload that.`, "too-big");
  }
}

// ─── flat columns ────────────────────────────────────────────────────────────

/** A page's values, kept in the page's own bytes where they are bytes. */
type Values =
  | { kind: "bytes"; data: Uint8Array; starts: Uint32Array; count: number }
  | { kind: "fixed"; data: Uint8Array; at: number; width: number; count: number }
  | { kind: "list"; list: ArrayLike<unknown>; count: number };

function valueAt(v: Values, k: number): unknown {
  switch (v.kind) {
    case "bytes":
      return v.data.subarray(v.starts[k]!, v.starts[k + 1]! - 4);
    case "fixed":
      return v.data.subarray(v.at + k * v.width, v.at + (k + 1) * v.width);
    case "list":
      return v.list[k];
  }
}

const list = (values: ArrayLike<unknown>): Values => ({ kind: "list", list: values, count: values.length });

/** `count` values written plainly. Byte arrays stay in the page: only where each starts is kept. */
function plainValues(reader: DataReader, type: ParquetType, count: number, width: number | undefined): Values {
  const { view } = reader;
  const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (type === "BYTE_ARRAY") {
    // Value k is data[starts[k], starts[k + 1] - 4): the next value's 4-byte length comes before its start.
    const starts = new Uint32Array(count + 1);
    let at = reader.offset;
    for (let k = 0; k < count; k++) {
      if (at + 4 > data.byteLength) throw damaged(DAMAGED_PAGE);
      const length = view.getUint32(at, true);
      starts[k] = at + 4;
      at += 4 + length;
      if (at > data.byteLength) throw damaged(DAMAGED_PAGE);
    }
    starts[count] = at + 4;
    reader.offset = at;
    return { kind: "bytes", data, starts, count };
  }
  if (type === "FIXED_LEN_BYTE_ARRAY") {
    if (!width || reader.offset + count * width > data.byteLength) throw damaged(DAMAGED_PAGE);
    const out: Values = { kind: "fixed", data, at: reader.offset, width, count };
    reader.offset += count * width;
    return out;
  }
  const size = type === "BOOLEAN" ? 1 / 8 : type === "INT32" || type === "FLOAT" ? 4 : type === "INT96" ? 12 : 8;
  if (reader.offset + Math.ceil(count * size) > data.byteLength) throw damaged(DAMAGED_PAGE);
  const values = readPlain(reader, type, count, width);
  return list(type === "INT96" ? Array.from(values as ArrayLike<bigint>, int96Nanos) : values);
}

/** `count` values in a page's encoding (anything but a dictionary's indexes). */
function encodedValues(reader: DataReader, encoding: Encoding, type: ParquetType, count: number, width: number | undefined): Values {
  if (!count) return list([]);
  switch (encoding) {
    case "PLAIN":
      return plainValues(reader, type, count, width);
    case "RLE":
      if (type === "BOOLEAN") {
        const out = new Uint8Array(count);
        readRleBitPackedHybrid(reader, 1, out);
        return list(out);
      }
      break;
    case "DELTA_BINARY_PACKED": {
      if (type !== "INT32" && type !== "INT64") break;
      const out = type === "INT32" ? new Int32Array(count) : new BigInt64Array(count);
      deltaBinaryUnpack(reader, count, out);
      return list(out);
    }
    case "DELTA_LENGTH_BYTE_ARRAY":
    case "DELTA_BYTE_ARRAY": {
      const out = new Array<Uint8Array>(count);
      (encoding === "DELTA_BYTE_ARRAY" ? deltaByteArray : deltaLengthByteArray)(reader, count, out);
      return list(out);
    }
    case "BYTE_STREAM_SPLIT":
      return list(byteStreamSplit(reader, count, type, width));
  }
  throw new UnreadableFile(`A column of this Parquet file is written in the ${encoding} encoding, which a store does not read.`, "unsupported");
}

/** A flat column's page, decoded. */
interface FlatPage {
  rows: number;
  /** Each row's index among the page's values, -1 for a null; null when no row is null. */
  slots: Int32Array | null;
  /** Each value's index in the column's dictionary, for a dictionary-encoded page. */
  index: Int32Array | null;
  /** The page's own values, for a page that is not dictionary-encoded. */
  values: Values | null;
}

/** Where a column chunk is, and what its footer says it holds. */
interface ChunkInfo {
  start: number;
  end: number;
  values: number;
  meta: ColumnMetaData;
}

const isDictionaryEncoding = (e: Encoding): boolean => e === "PLAIN_DICTIONARY" || e === "RLE_DICTIONARY";

/** A flat column (a leaf right under the schema's root) of one row group, read a page at a time. */
class FlatColumn {
  private readonly bytes: ChunkBytes;
  private pos: number;
  private dictionary: Values | null = null;
  private dictionaryText: (string | null | undefined)[] | null = null;
  private page: FlatPage | null = null;
  /** The row (in the row group) of the page's first row, and of the row after its last. */
  private first = 0;
  private next = 0;

  constructor(
    source: ByteSource,
    private readonly chunk: ChunkInfo,
    private readonly type: LeafType,
    private readonly optional: boolean,
    private readonly typeLength: number | undefined,
  ) {
    this.bytes = new ChunkBytes(source, chunk.start, chunk.end);
    this.pos = chunk.start;
  }

  /** The text of rows `from` to `from + n - 1` of the row group. */
  async texts(from: number, n: number): Promise<(string | null)[]> {
    const out = new Array<string | null>(n);
    let i = 0;
    while (i < n) {
      if (!this.page || from + i < this.first || from + i >= this.next) await this.pageAt(from + i);
      const page = this.page!;
      const end = Math.min(n, this.next - from);
      for (; i < end; i++) out[i] = this.textAt(page, from + i - this.first);
    }
    return out;
  }

  private textAt(page: FlatPage, r: number): string | null {
    const k = page.slots ? page.slots[r]! : r;
    if (k < 0) return null;
    if (!page.index) return textOf(this.type, valueAt(page.values!, k));
    const d = page.index[k]!;
    if (this.dictionaryText) {
      const known = this.dictionaryText[d];
      if (known !== undefined) return known;
      return (this.dictionaryText[d] = textOf(this.type, valueAt(this.dictionary!, d)));
    }
    return textOf(this.type, valueAt(this.dictionary!, d));
  }

  /** Reads on to the page holding `row`; pages before it are passed over by their headers alone. */
  private async pageAt(row: number): Promise<void> {
    if (row < this.first) {
      this.pos = this.chunk.start;
      this.first = this.next = 0;
      this.page = null;
    }
    while (!this.page || row >= this.next) {
      if (this.pos >= this.chunk.end) throw damaged("A column of this Parquet file ends before its row group's last row.");
      const { header, dataAt } = await this.bytes.header(this.pos);
      checkHeader(header, dataAt, this.chunk);
      this.pos = dataAt + header.compressed_page_size;
      if (header.type === "DICTIONARY_PAGE") {
        const data = await this.bytes.take(dataAt, header.compressed_page_size);
        const page = decompressPage(data, header.uncompressed_page_size, this.chunk.meta.codec, COMPRESSORS);
        const count = header.dictionary_page_header?.num_values ?? 0;
        this.dictionary = plainValues({ view: new DataView(page.buffer, page.byteOffset, page.byteLength), offset: 0 }, this.chunk.meta.type, count, this.typeLength);
        this.dictionaryText = count <= CACHED_DICTIONARY ? new Array(count) : null;
        if (page !== data) this.bytes.release(this.pos);
        continue;
      }
      const rows = header.data_page_header?.num_values ?? header.data_page_header_v2?.num_rows;
      if (rows === undefined) continue; // an index page
      if (this.next + rows <= row) {
        this.page = null;
        this.first = this.next += rows;
        continue;
      }
      this.page = this.decode(header, await this.bytes.take(dataAt, header.compressed_page_size));
      this.bytes.expect(header.compressed_page_size);
      // A page that was compressed keeps its values in bytes of its own.
      if (this.chunk.meta.codec !== "UNCOMPRESSED" && header.data_page_header_v2?.is_compressed !== false) this.bytes.release(this.pos);
      this.first = this.next;
      this.next += rows;
    }
  }

  private decode(h: PageHeader, compressed: Uint8Array): FlatPage {
    const { codec, type } = this.chunk.meta;
    let rows: number;
    let encoding: Encoding;
    let present: Uint8Array | null = null;
    let page: Uint8Array;
    if (h.data_page_header) {
      rows = h.data_page_header.num_values;
      encoding = h.data_page_header.encoding;
      page = decompressPage(compressed, h.uncompressed_page_size, codec, COMPRESSORS);
    } else {
      const v2 = h.data_page_header_v2!;
      rows = v2.num_rows;
      encoding = v2.encoding;
      const levels = v2.repetition_levels_byte_length + v2.definition_levels_byte_length;
      if (!(levels >= 0 && levels <= compressed.byteLength) || v2.num_values !== rows) throw damaged(DAMAGED_PAGE);
      if (this.optional) {
        present = new Uint8Array(rows);
        readRleBitPackedHybrid({ view: new DataView(compressed.buffer, compressed.byteOffset, compressed.byteLength), offset: v2.repetition_levels_byte_length }, 1, present, v2.definition_levels_byte_length);
      }
      const body = compressed.subarray(levels);
      page = v2.is_compressed === false ? body : decompressPage(body, h.uncompressed_page_size - levels, codec, COMPRESSORS);
    }
    const reader: DataReader = { view: new DataView(page.buffer, page.byteOffset, page.byteLength), offset: 0 };
    if (h.data_page_header && this.optional) {
      present = new Uint8Array(rows);
      readRleBitPackedHybrid(reader, 1, present);
    }
    let count = rows;
    let slots: Int32Array | null = null;
    if (present) {
      count = 0;
      for (let i = 0; i < rows; i++) count += present[i]!;
      if (count < rows) {
        slots = new Int32Array(rows);
        for (let i = 0, k = 0; i < rows; i++) slots[i] = present[i] ? k++ : -1;
      }
    }
    if (isDictionaryEncoding(encoding)) {
      if (!this.dictionary) throw damaged(DAMAGED_PAGE);
      const index = new Int32Array(count);
      if (count) {
        const width = reader.view.getUint8(reader.offset++);
        if (width > 32) throw damaged(DAMAGED_PAGE);
        if (width) readRleBitPackedHybrid(reader, width, index, page.byteLength - reader.offset);
        const size = this.dictionary.count;
        for (let k = 0; k < count; k++) if (index[k]! >= size || index[k]! < 0) throw damaged(DAMAGED_PAGE);
      }
      return { rows, slots, index, values: null };
    }
    return { rows, slots, index: null, values: encodedValues(reader, encoding, type, count, this.typeLength) };
  }
}

// ─── lists, maps and structs ─────────────────────────────────────────────────

/**
 * A leaf of a list, map or struct column, read a page at a time with hyparquet's page reader:
 * each row is the leaf's own nesting of arrays, and a row a page leaves open goes on in the next.
 */
class NestedLeaf {
  private readonly bytes: ChunkBytes;
  private pos: number;
  private dictionary: DecodedArray | undefined = undefined;
  private rows: unknown[] = [];
  /** The row (in the row group) of `rows[0]`. */
  private first = 0;
  private ended = false;

  constructor(
    source: ByteSource,
    private readonly chunk: ChunkInfo,
    private readonly decoder: ColumnDecoder,
  ) {
    this.bytes = new ChunkBytes(source, chunk.start, chunk.end);
    this.pos = chunk.start;
  }

  /** Rows `from` to `from + n - 1` of the row group, each as hyparquet assembled the leaf's levels. */
  async rowsAt(from: number, n: number): Promise<unknown[]> {
    if (from < this.first) {
      this.pos = this.chunk.start;
      this.rows = [];
      this.first = 0;
      this.ended = false;
    }
    // Rows before `from` are done with; the last row read stays, since the next page may go on with it.
    const done = Math.min(from - this.first, this.rows.length - 1);
    if (done > 0) {
      this.rows = this.rows.slice(done);
      this.first += done;
    }
    while (this.first + this.rows.length - (this.ended ? 0 : 1) < from + n) {
      if (this.ended) throw damaged("A column of this Parquet file ends before its row group's last row.");
      await this.readPage();
    }
    return this.rows.slice(from - this.first, from - this.first + n);
  }

  private async readPage(): Promise<void> {
    if (this.pos >= this.chunk.end) {
      this.ended = true;
      return;
    }
    const { header, dataAt } = await this.bytes.header(this.pos);
    checkHeader(header, dataAt, this.chunk);
    this.pos = dataAt + header.compressed_page_size;
    if (header.type !== "DICTIONARY_PAGE" && header.type !== "DATA_PAGE" && header.type !== "DATA_PAGE_V2") return;
    const data = await this.bytes.take(dataAt, header.compressed_page_size);
    const reader: DataReader = { view: new DataView(data.buffer, data.byteOffset, data.byteLength), offset: 0 };
    if (header.type === "DICTIONARY_PAGE") {
      const { data: values } = readPage(reader, header, this.decoder, undefined, undefined, 0);
      this.dictionary = values && convert(values, this.decoder);
      if (this.chunk.meta.codec !== "UNCOMPRESSED") this.bytes.release(this.pos);
      return;
    }
    if (!this.dictionary && isDictionaryEncoding(header.data_page_header?.encoding ?? header.data_page_header_v2?.encoding ?? "PLAIN")) throw damaged(DAMAGED_PAGE);
    readPage(reader, header, this.decoder, this.dictionary, this.rows, 0);
    this.bytes.expect(header.compressed_page_size);
    if (this.chunk.meta.codec !== "UNCOMPRESSED" && header.data_page_header_v2?.is_compressed !== false) this.bytes.release(this.pos);
    if (this.pos >= this.chunk.end) this.ended = true;
  }
}

// ─── the file ────────────────────────────────────────────────────────────────

/** A top-level field of the schema: one column of the table. */
interface Field {
  /** The field as the file declares it, and as hyparquet assembles it (leaf types left plain). */
  node: SchemaTree;
  plain: SchemaTree;
  /** A leaf right under the root, not repeated: read by FlatColumn. */
  flat: boolean;
  /** Its leaves' indexes among a row group's column chunks. */
  leaves: number[];
}

/** One row group, open: its columns' readers, and where its rows are in the file. */
interface OpenGroup {
  index: number;
  start: number;
  rows: number;
  flat: Map<number, FlatColumn>;
  nested: Map<number, NestedLeaf>;
}

/** A leaf's annotation as hyparquet should decode it for assembly: text stays text, the rest stays as stored. */
function plainElement(e: SchemaElement): SchemaElement {
  if (!e.type) return e;
  const text = leafType(e).kind === "string";
  return { ...e, converted_type: text ? "UTF8" : undefined, logical_type: text ? { type: "STRING" } : undefined };
}

function leavesOf(node: SchemaTree): SchemaTree[] {
  return node.children.length ? node.children.flatMap(leavesOf) : [node];
}

/** The footer, read from the end of the file and parsed. */
async function readFooter(source: ByteSource): Promise<FileMetaData> {
  if (source.size < 12) throw damaged("This file is too short to be a Parquet file.");
  const tailLength = Math.min(source.size, MIN_READ);
  let tail = await source.read(source.size - tailLength, tailLength);
  if (tail.byteLength < tailLength) throw damaged("This Parquet file could not be read to its end.");
  const magic = utf8.decode(tail.subarray(tail.byteLength - 4));
  if (magic === "PARE") throw new UnreadableFile("This Parquet file is encrypted. Write it without encryption and upload that.", "unsupported");
  if (magic !== "PAR1") throw damaged("This Parquet file is cut short: its footer, which says where its columns are, is missing.");
  const length = new DataView(tail.buffer, tail.byteOffset, tail.byteLength).getUint32(tail.byteLength - 8, true);
  if (length > source.size - 12) throw damaged(DAMAGED_FOOTER);
  if (length > PARQUET_FOOTER_CAP) {
    throw new UnreadableFile(
      `This Parquet file's footer, which lists its row groups and columns, is ${Math.ceil(length / MB)} MB, and a store reads footers of up to ${PARQUET_FOOTER_CAP / MB} MB. Write it with fewer, larger row groups, or export it to CSV, and upload that.`,
      "too-big",
    );
  }
  if (length + 8 > tail.byteLength) {
    tail = await source.read(source.size - length - 8, length + 8);
    if (tail.byteLength < length + 8) throw damaged("This Parquet file could not be read to its end.");
  }
  try {
    return parquetMetadata(tail.subarray(tail.byteLength - length - 8), { geoparquet: false });
  } catch {
    throw damaged(DAMAGED_FOOTER);
  }
}

/** Where a column chunk is, checked against the file. */
function chunkInfo(meta: ColumnMetaData, dataEnd: number): ChunkInfo {
  const start = Number(meta.dictionary_page_offset || meta.data_page_offset);
  const end = start + Number(meta.total_compressed_size);
  if (!(start >= 4) || !(end <= dataEnd) || !(end >= start)) throw damaged("This Parquet file is cut short or damaged: its footer places a column past the end of its data.");
  return { start, end, values: Number(meta.num_values), meta };
}

/**
 * The most of a row group a read holds at once, from its footer: for each column chunk, its
 * dictionary page and its average page with half again for pages of uneven size (or the whole
 * chunk when the footer does not count its pages; DuckDB writes one page a chunk), a page's
 * offsets and indexes, and the window its bytes are read through. A leaf of a list, map or struct
 * counts three times, for the arrays hyparquet assembles it in.
 */
export function heldBytes(group: RowGroup, nestedLeaves: ReadonlySet<number> = new Set()): number {
  const rows = Number(group.num_rows);
  let held = 0;
  group.columns.forEach((chunk, i) => {
    const meta = chunk.meta_data;
    if (!meta) return;
    const size = Number(meta.total_uncompressed_size);
    let pages = 0;
    for (const s of meta.encoding_stats ?? []) if (s.page_type === "DATA_PAGE" || s.page_type === "DATA_PAGE_V2") pages += s.count;
    let part = size;
    if (pages > 1) {
      const dictionaryAt = Number(meta.dictionary_page_offset ?? 0);
      const dataAt = Number(meta.data_page_offset);
      // The dictionary page's share of the chunk, at the chunk's own rate of compression.
      const dictionary = dictionaryAt > 0 && dictionaryAt < dataAt ? Math.min(size, ((dataAt - dictionaryAt) * size) / Math.max(1, Number(meta.total_compressed_size))) : 0;
      part = Math.min(size, dictionary + ((size - dictionary) / pages) * 1.5);
    }
    // A page's text offsets or dictionary indexes take 4 bytes a row, where its nulls are another 4,
    // and the column's window MIN_READ.
    const perRow = (meta.type === "BYTE_ARRAY" || meta.encodings.some(isDictionaryEncoding) ? 4 : 0) + (meta.statistics?.null_count === 0n ? 0 : 4);
    part += (perRow * rows) / Math.max(1, pages) + MIN_READ;
    held += nestedLeaves.has(i) ? 3 * part : part;
  });
  return held;
}

/** A Parquet file, opened from its bytes by range: one table, its columns the schema's top-level fields. */
export async function openParquet(source: ByteSource): Promise<OpenedFile> {
  const metadata = await readFooter(source);
  const dataEnd = source.size - metadata.metadata_length - 8;
  let tree: SchemaTree;
  let plainTree: SchemaTree;
  try {
    tree = parquetSchema(metadata);
    plainTree = parquetSchema({ schema: metadata.schema.map(plainElement) });
  } catch {
    throw damaged(DAMAGED_FOOTER);
  }
  const leafPaths = leavesOf(tree).map((leaf) => leaf.path.join("\u0000"));
  const leafIndex = new Map(leafPaths.map((p, i) => [p, i]));
  const fields: Field[] = tree.children.map((node, i) => ({
    node,
    plain: plainTree.children[i]!,
    flat: !node.children.length && node.element.repetition_type !== "REPEATED",
    leaves: leavesOf(node).map((leaf) => leafIndex.get(leaf.path.join("\u0000"))!),
  }));
  const nestedLeaves = new Set(fields.filter((f) => !f.flat).flatMap((f) => f.leaves));

  // Every row group's column chunks, checked before any row is read.
  const groups = metadata.row_groups;
  const starts: number[] = [];
  let total = 0;
  let held = 0;
  for (const group of groups) {
    if (group.columns.length !== leafPaths.length) throw damaged(DAMAGED_FOOTER);
    group.columns.forEach((chunk, i) => {
      if (chunk.file_path) throw new UnreadableFile("This Parquet file keeps its columns in other files, which a store does not read. Write it as one file and upload that.", "unsupported");
      const meta = chunk.meta_data;
      if (!meta) throw new UnreadableFile("This Parquet file's columns are encrypted. Write it without encryption and upload that.", "unsupported");
      if (meta.path_in_schema.join("\u0000") !== leafPaths[i]) throw damaged(DAMAGED_FOOTER);
      if (!READ_CODECS.has(meta.codec)) {
        const name = CODEC_NAMES[meta.codec] ?? meta.codec;
        throw new UnreadableFile(`This Parquet file is compressed with ${name}, which a store does not read. Write it with Snappy, Zstandard or gzip compression, and upload that.`, "unsupported");
      }
      chunkInfo(meta, dataEnd);
    });
    const rows = Number(group.num_rows);
    if (!(rows >= 0)) throw damaged(DAMAGED_FOOTER);
    starts.push(total);
    total += rows;
    held = Math.max(held, heldBytes(group, nestedLeaves));
  }
  if (held > PARQUET_HELD_CAP) {
    throw new UnreadableFile(
      `This Parquet file needs about ${Math.ceil(held / MB)} MB of memory to read one of its row groups, and a store reads row groups that need up to ${PARQUET_HELD_CAP / MB} MB. Write it with smaller row groups, or export it to CSV, and upload that.`,
      "too-big",
    );
  }

  const columns: SourceColumn[] = fields.map((f, i) => ({ name: f.node.element.name || `column ${i + 1}`, originalType: typeName(f.node) }));
  const notes: string[] = [];
  const binary = columns.filter((_, i) => fields[i]!.flat && leafType(fields[i]!.node.element).kind === "binary").map((c) => c.name);
  if (binary.length) notes.push(`${binary.join(", ")} hold${binary.length > 1 ? "" : "s"} files or binary values: a store loads those of up to 4,096 bytes as hexadecimal text, and not longer ones.`);
  const nested = columns.filter((_, i) => !fields[i]!.flat).map((c) => c.name);
  if (nested.length) notes.push(`${nested.join(", ")} hold${nested.length > 1 ? "" : "s"} lists, maps or structs, which a store loads as JSON text.`);
  const table: SourceTable = { name: null, columns, rowCount: total, notes };
  const writer = metadata.created_by?.replace(/\s*\(build [^)]*\)\s*$/, "").trim();

  let live: { group: OpenGroup; next: number } | null = null;

  function openGroup(index: number): OpenGroup {
    const group = groups[index]!;
    const flat = new Map<number, FlatColumn>();
    const nestedReaders = new Map<number, NestedLeaf>();
    for (const f of fields) {
      for (const leaf of f.leaves) {
        const meta = group.columns[leaf]!.meta_data!;
        const chunk = chunkInfo(meta, dataEnd);
        if (f.flat) {
          const e = f.node.element;
          flat.set(leaf, new FlatColumn(source, chunk, leafType(e), e.repetition_type !== "REQUIRED" && getMaxDefinitionLevel([tree, f.node]) > 0, e.type_length));
        } else {
          const schemaPath = getTreePath(plainTree, meta.path_in_schema);
          const decoder: ColumnDecoder = { pathInSchema: meta.path_in_schema, type: meta.type, element: schemaPath[schemaPath.length - 1]!.element, schemaPath, codec: meta.codec, parsers: PARSERS, compressors: COMPRESSORS, utf8: false };
          nestedReaders.set(leaf, new NestedLeaf(source, chunk, decoder));
        }
      }
    }
    return { index, start: starts[index]!, rows: Number(group.num_rows), flat, nested: nestedReaders };
  }

  /** The row group holding row `row` of the file. */
  function groupOf(row: number): number {
    let lo = 0;
    let hi = groups.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= row) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Each field's text for rows `from` to `from + n - 1` of an open row group. */
  async function columnTexts(group: OpenGroup, from: number, n: number): Promise<(string | null)[][]> {
    const out: (string | null)[][] = [];
    for (const f of fields) {
      if (f.flat) {
        out.push(await group.flat.get(f.leaves[0]!)!.texts(from, n));
        continue;
      }
      const parts = new Map<string, DecodedArray>();
      for (const leaf of f.leaves) parts.set(groups[group.index]!.columns[leaf]!.meta_data!.path_in_schema.join("."), (await group.nested.get(leaf)!.rowsAt(from, n)) as DecodedArray);
      let values: unknown[];
      if (f.node.children.length) {
        assembleNested(parts, f.plain, PARSERS);
        values = Array.from(parts.get(f.node.element.name) ?? []);
      } else values = Array.from(parts.values().next().value ?? []);
      out.push(values.map((v) => (v === null || v === undefined ? null : jsonOf(v, f.node))));
    }
    return out;
  }

  async function rows(index: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    if (index !== 0) throw new RangeError(`This Parquet file has no table ${index}.`);
    let next = cursor?.row ?? 0;
    if (!Number.isInteger(next) || next < 0) throw new RangeError(`A Parquet cursor is a row index, not ${JSON.stringify(cursor)}.`);
    const out: SourceRow[] = [];
    try {
      while (out.length < limit.rows && next < total) {
        let group = live && live.next === next && next < live.group.start + live.group.rows ? live.group : null;
        if (!group) {
          // The row group read before is let go before the next one's pages are read.
          live = null;
          group = openGroup(groupOf(next));
        }
        const meta = groups[group.index]!;
        // About `limit.bytes` of the file a batch: the row group's compressed size per row.
        const compressed = meta.columns.reduce((sum, c) => sum + Number(c.meta_data!.total_compressed_size), 0);
        const byBytes = limit.bytes ? Math.max(1, Math.floor((limit.bytes * group.rows) / Math.max(1, compressed))) : Number.POSITIVE_INFINITY;
        const n = Math.min(limit.rows - out.length, group.start + group.rows - next, byBytes);
        const texts = await columnTexts(group, next - group.start, n);
        for (let i = 0; i < n; i++) out.push({ n: next + i + 1, values: texts.map((column) => column[i]!) });
        next += n;
        live = { group, next };
        if (byBytes !== Number.POSITIVE_INFINITY && out.length >= byBytes) break;
      }
    } catch (err) {
      // A read that failed starts again from its row group's start the next time.
      live = null;
      throw err;
    }
    if (next >= total) live = null;
    return { rows: out, next: next < total ? { row: next } : null, deleted: 0 };
  }

  return { format: "parquet", tables: [table], notes: [writer ? `Read as a Parquet file written by ${writer}.` : "Read as a Parquet file."], rows };
}
