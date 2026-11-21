// SQLite databases (.sqlite, .db, and GeoPackages, .gpkg), read by range a page at a time, with no
// SQLite library: workerd refuses WebAssembly compiled from bytes, which sql.js needs. The reader
// follows the file format (https://www.sqlite.org/fileformat2.html). A database is a file of pages
// of one size; each table is a b-tree of pages whose leaves hold its rows; and sqlite_schema, the
// b-tree on page 1, names every table, its first page and its CREATE TABLE statement.
//
// Each table SQLite stores is a table here, with its columns and their types as its CREATE TABLE
// statement writes them ("VARCHAR(30)", or "any" for a column with no type). SQLite's own tables,
// virtual tables (full-text and spatial indexes, whose rows an extension of SQLite builds) with the
// tables that hold their data, and a GeoPackage's gpkg_ and rtree_ tables are left out, and views
// are not loaded. The file's notes name what was left out.
//
// Values are text, as SQLite shows them: integers in full, reals to the 15 digits CAST(x AS TEXT)
// shows ("150.0", "0.3", "1.0e+20"), text in the database's encoding, and a blob of up to 4,096
// bytes as SQLite's literal X'0A1B…'. A longer blob is not loaded, and the table's notes name the
// columns that hold them. An empty string is null, as in the other readers.
//
// Pages are read through 1 MB windows while they come in order, and one at a time when they do not,
// so a database of any size is read in little memory. A cursor is the path from the table's first
// page to its next row (the page and the place in it at each level) and the rows read so far: plain
// numbers that a newly opened copy of the file goes on from. A damaged or hostile file stops with a
// sentence that says where: no b-tree is followed deeper than SQLite's own 20 levels, a page reached
// twice in one read of a table is a loop, and every page number, cell and record length is checked
// against the file before it is used.

import { type ByteSource, windowedSource } from "./source.js";
import { decode, type TextEncoding, UTF8 } from "./text.js";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SourceColumn, type SourceRow, type SourceTable, UnreadableFile } from "./types.js";

/** "SQLite format 3" and a NUL: the first 16 bytes of every SQLite database. */
const MAGIC = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];
const WINDOW_BYTES = 1 << 20;
const WINDOWS_KEPT = 8;
/** How far from one of the last few pages read a page is near it, and how many of them count. */
const NEAR_BYTES = 256 << 10;
const RECENT_PAGES = 4;
/** SQLite's own limit on how deep a b-tree goes (BTCURSOR_MAX_DEPTH). */
const MAX_DEPTH = 20;
/** The longest blob loaded, as its X'…' literal. */
export const BLOB_BYTES_MAX = 4096;
/** The rows of each table read when the file is opened, for its notes. */
const SAMPLE_ROWS = 2000;
/**
 * The most text one row reads. A row with more has its longest values cut, each to the same
 * share; a store keeps far less of a row than this (load.ts `ROW_CHARS_MAX`).
 */
const ROW_TEXT_BYTES = 8 << 20;
/** How many bytes of pages a batch reads when its limit does not say. */
const BATCH_BYTES = 64 << 20;
/** The longest record header SQLite itself reads. */
const RECORD_HEADER_MAX = 98_307;
/** A GeoPackage's application id at offset 68: "GPKG", or "GP10" and "GP11" in versions 1.0 and 1.1. */
const GEOPACKAGE_IDS = new Set([0x47504b47, 0x47503130, 0x47503131]);
/** What the tables holding a virtual table's data end in: FTS3 and FTS4, FTS5, R*Tree. */
const SHADOW_SUFFIXES = ["content", "data", "idx", "docsize", "config", "segments", "segdir", "stat", "node", "rowid", "parent"];
/** Declared types that say a column holds files or other bytes. */
const BINARY_TYPE = /BLOB|BINARY|^IMAGE$|^BYTEA$/i;

/** Column affinities, which decide how SQLite stores and shows a column's values. */
const BLOB = 0;
const TEXT = 1;
const NUMERIC = 2;
const INTEGER = 3;
const REAL = 4;
type Affinity = typeof BLOB | typeof TEXT | typeof NUMERIC | typeof INTEGER | typeof REAL;

/** Whether a file's opening bytes are a SQLite database's header. */
export function looksLikeSqlite(head: Uint8Array): boolean {
  return head.byteLength >= 16 && MAGIC.every((b, i) => head[i] === b);
}

// ─── damage ──────────────────────────────────────────────────────────────────

/**
 * A part of the file that is not what the format says it is. Its message ends a sentence that
 * starts with the page and the table it was found in, which the code reading the table adds.
 */
class Broken extends Error {}

const RUNS_PAST = "has a cell that runs past the end of the page";

function damaged(what: string): UnreadableFile {
  return new UnreadableFile(`This SQLite database is damaged: ${what}.`, "damaged");
}

const count = (n: number): string => n.toLocaleString("en-US");

// ─── bytes ───────────────────────────────────────────────────────────────────

const u16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const u32 = (b: Uint8Array, at: number): number => b[at]! * 0x1000000 + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);

/** Where the varint read last ended. */
let varintEnd = 0;

/** A varint at `at` that ends before `end`, as a number: exact up to 2^53, past any length in a file. */
function varint(b: Uint8Array, at: number, end: number, why = RUNS_PAST): number {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    if (at + i >= end) throw new Broken(why);
    const c = b[at + i]!;
    v = v * 128 + (c & 0x7f);
    if (c < 0x80) {
      varintEnd = at + i + 1;
      return v;
    }
  }
  if (at + 8 >= end) throw new Broken(why);
  varintEnd = at + 9;
  return v * 256 + b[at + 8]!;
}

const SAFE = 2n ** 53n;

/** A rowid: a varint read as a signed 64-bit integer; a number when one holds it exactly. */
function rowidAt(b: Uint8Array, at: number, end: number): number | bigint {
  let v = 0;
  // Seven bytes hold 49 bits: a number, never negative.
  for (let i = 0; i < 7; i++) {
    if (at + i >= end) throw new Broken(RUNS_PAST);
    const c = b[at + i]!;
    v = v * 128 + (c & 0x7f);
    if (c < 0x80) {
      varintEnd = at + i + 1;
      return v;
    }
  }
  let big = BigInt(v);
  if (at + 7 >= end) throw new Broken(RUNS_PAST);
  const c = b[at + 7]!;
  big = (big << 7n) | BigInt(c & 0x7f);
  if (c < 0x80) varintEnd = at + 8;
  else {
    if (at + 8 >= end) throw new Broken(RUNS_PAST);
    big = (big << 8n) | BigInt(b[at + 8]!);
    varintEnd = at + 9;
  }
  const signed = BigInt.asIntN(64, big);
  return signed >= -SAFE && signed <= SAFE ? Number(signed) : signed;
}

// ─── the database header ─────────────────────────────────────────────────────

interface Header {
  pageSize: number;
  /** A page's size less the bytes an extension keeps at the end of each page. */
  usable: number;
  pageCount: number;
  encoding: TextEncoding;
  wal: boolean;
  geopackage: boolean;
}

function readHeader(head: Uint8Array, fileSize: number): Header {
  if (head.byteLength < 100 || !looksLikeSqlite(head)) {
    throw new UnreadableFile("This file is not a SQLite database a store can read: it does not begin with SQLite's header, so it is encrypted or another kind of file.", "unsupported");
  }
  const raw = u16(head, 16);
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) throw damaged(`its header gives a page size of ${raw} bytes, which SQLite never writes`);
  if (head[19]! > 2) throw new UnreadableFile(`This SQLite database is in a file format newer than a store reads (read version ${head[19]}).`, "unsupported");
  const usable = pageSize - head[20]!;
  if (usable < 480) throw damaged(`its header keeps ${head[20]} bytes of each ${pageSize}-byte page aside, leaving too few for SQLite`);
  if (head[21] !== 64 || head[22] !== 32 || head[23] !== 32) throw damaged("its header's payload fractions are not the ones SQLite writes");
  const code = u32(head, 56);
  if (code > 3) throw damaged(`its header names text encoding ${code}, which SQLite does not have`);
  const encoding: TextEncoding = code === 2 ? { kind: "utf-16le" } : code === 3 ? { kind: "utf-16be" } : UTF8;
  const filePages = Math.floor(fileSize / pageSize);
  // The header's page count holds when the change counter matches the one it was written with.
  const counted = u32(head, 28);
  const valid = counted > 0 && u32(head, 24) === u32(head, 92);
  if (valid && counted > filePages) {
    throw new UnreadableFile(
      `This SQLite database is cut short: its header counts ${count(counted)} pages of ${count(pageSize)} bytes, and the file holds ${count(filePages)}. An upload that did not finish does this: upload it again.`,
      "damaged",
    );
  }
  const pageCount = valid ? counted : filePages;
  if (pageCount < 1) throw damaged("the file ends before its first page does");
  return { pageSize, usable, pageCount, encoding, wal: head[18] === 2 || head[19] === 2, geopackage: GEOPACKAGE_IDS.has(u32(head, 68)) };
}

// ─── pages ───────────────────────────────────────────────────────────────────

/**
 * A database's pages, read through windows of the file while they come in order (a table written
 * at once, or vacuumed, keeps its pages together) and one at a time when they do not, so a table
 * whose pages are scattered costs a read per page, not a window per page. Pages come in order when
 * two reads running each land near one of the last few pages read: that holds for a table's leaves
 * and the overflow pages between them, and almost never for pages scattered at random.
 */
class PageReader {
  private readonly windows: ByteSource;
  /** The windows `windows` keeps, least recently used first: the same rule windowedSource keeps them by. */
  private readonly held: number[] = [];
  /** The last pages read, and how many reads running landed near one of them. */
  private readonly recent: number[] = [];
  private run = 0;
  private readonly near: number;

  constructor(
    private readonly source: ByteSource,
    readonly size: number,
    private readonly windowBytes: number,
    private readonly kept: number,
  ) {
    this.windows = windowedSource(source, windowBytes, kept);
    this.near = Math.max(1, NEAR_BYTES / size);
  }

  async read(n: number): Promise<Uint8Array> {
    const offset = (n - 1) * this.size;
    const w = Math.floor(offset / this.windowBytes);
    this.run = this.recent.some((r) => r !== n && Math.abs(n - r) <= this.near) ? this.run + 1 : 0;
    this.recent.push(n);
    if (this.recent.length > RECENT_PAGES) this.recent.shift();
    const at = this.held.indexOf(w);
    let bytes: Uint8Array;
    if (at >= 0 || this.run >= 2) {
      if (at >= 0) this.held.splice(at, 1);
      this.held.push(w);
      if (this.held.length > this.kept) this.held.shift();
      bytes = await this.windows.read(offset, this.size);
    } else bytes = await this.source.read(offset, this.size);
    if (bytes.byteLength < this.size) throw new Broken(`points at page ${n}, which the file ends before`);
    return bytes;
  }
}

/** Page numbers, a bit each, in pieces of 64 KB made as pages in their range are added. */
class PageSet {
  private readonly pieces = new Map<number, Uint8Array>();

  has(n: number): boolean {
    const piece = this.pieces.get(n >>> 19);
    return !!piece && ((piece[(n >>> 3) & 0xffff]! >> (n & 7)) & 1) === 1;
  }

  add(n: number): void {
    let piece = this.pieces.get(n >>> 19);
    if (!piece) this.pieces.set(n >>> 19, (piece = new Uint8Array(1 << 16)));
    piece[(n >>> 3) & 0xffff]! |= 1 << (n & 7);
  }
}

/** One b-tree page: its type, its cells and, for an interior page, its right-most child. */
interface Page {
  n: number;
  bytes: Uint8Array;
  /** 2 an interior index page, 5 an interior table page, 10 an index leaf, 13 a table leaf. */
  type: number;
  cells: number;
  /** Where the cell pointer array starts. */
  pointers: number;
  right: number;
}

interface Db {
  pages: PageReader;
  pageSize: number;
  usable: number;
  pageCount: number;
  encoding: TextEncoding;
  /** The most of a record a table leaf, or an index page, keeps on the page, and the least either keeps when the rest spills. */
  tableMax: number;
  indexMax: number;
  spillMin: number;
  rowTextBytes: number;
}

// ─── b-trees ─────────────────────────────────────────────────────────────────

/** A page on the path to the next row, and the place on it: see `Walk`. */
interface Frame {
  page: Page;
  q: number;
}

/**
 * One read of a table's b-tree, in the table's order: the path from its first page to the next row.
 * At each level `q` is the place on the page. On a leaf it is the next cell. On an interior table
 * page it is the child being read (the last is the right-most pointer). An index b-tree (a
 * WITHOUT ROWID table) also keeps rows on its interior pages, between its children: there an even
 * `q` is child q/2, and an odd one the row in cell (q-1)/2. A page's `q` moves on when the page
 * below it is finished.
 */
class Walk {
  readonly stack: Frame[] = [];
  /** Bytes of pages this read has read. */
  bytes = 0;
  /** Rows given so far. */
  row = 0;
  /** The page being read, for a message. */
  at = 0;
  /** The cell `ready` or `next` found. */
  index = 0;
  /** Each value's serial type and where it starts in the record, for the record being read. */
  readonly types: number[] = [];
  readonly starts: number[] = [];

  constructor(
    readonly db: Db,
    readonly root: number,
    /** An index b-tree: a WITHOUT ROWID table. */
    readonly keyed: boolean,
    readonly seen: PageSet,
  ) {}

  async begin(): Promise<void> {
    this.at = this.root;
    if (this.root < 1 || this.root > this.db.pageCount) throw new Broken(`is past the end of the file, which has ${count(this.db.pageCount)} pages`);
    await this.push(this.root);
  }

  /** Goes on from a cursor this table's read returned, from this file or another copy of it. `mark` adds the path's pages to `seen`. */
  async resume(cursor: ReadCursor, mark: boolean): Promise<void> {
    const depth = cursor.depth;
    if (!isCount(depth) || depth < 1 || depth > MAX_DEPTH || !isCount(cursor.row)) throw new RangeError("This cursor is not one a read of a SQLite table returned.");
    this.row = cursor.row;
    for (let j = 0; j < depth; j++) {
      const n = cursor[`p${j}`];
      const q = cursor[`i${j}`];
      if (!isCount(n) || !isCount(q)) throw new RangeError("This cursor is not one a read of a SQLite table returned.");
      const expected = j === 0 ? this.root : this.below(this.stack[j - 1]!);
      if (n !== expected || n < 1 || n > this.db.pageCount) throw new Broken("no longer leads to where the last read of the table stopped");
      if (mark) this.seen.add(n);
      const page = await this.load(n);
      const most = page.type === 2 ? 2 * page.cells : page.cells;
      if (q > most || (j < depth - 1 && page.type === 2 && q % 2 === 1)) throw new Broken("no longer leads to where the last read of the table stopped");
      this.stack.push({ page, q });
    }
  }

  /** The next row's page, when the row is on the page already open: its cell is `index`. Null when a page must be read first, or the table has ended. */
  ready(): Page | null {
    const f = this.stack[this.stack.length - 1];
    if (!f) return null;
    const p = f.page;
    if (p.type === 13 || p.type === 10) {
      if (f.q >= p.cells) return null;
      this.index = f.q++;
    } else if (p.type === 2 && f.q % 2 === 1 && f.q < 2 * p.cells) {
      this.index = (f.q - 1) / 2;
      f.q++;
    } else return null;
    this.at = p.n;
    return p;
  }

  /** The next row's page, reading the pages on the way to it; null after the last row. */
  async next(): Promise<Page | null> {
    for (;;) {
      const quick = this.ready();
      if (quick) return quick;
      const f = this.stack[this.stack.length - 1];
      if (!f) return null;
      const p = f.page;
      this.at = p.n;
      if (p.type === 13 || p.type === 10) this.pop();
      else if (p.type === 5) {
        if (f.q <= p.cells) await this.push(this.childAt(p, f.q));
        else this.pop();
      } else if (f.q > 2 * p.cells) this.pop();
      else await this.push(this.childAt(p, f.q / 2));
    }
  }

  /** Leaves the finished pages, so the path ends at the next row; the table has ended when none is left. */
  settle(): void {
    for (;;) {
      const f = this.stack[this.stack.length - 1];
      if (!f) return;
      const p = f.page;
      const left = p.type === 13 || p.type === 10 ? f.q < p.cells : p.type === 5 ? f.q <= p.cells : f.q <= 2 * p.cells;
      if (left) return;
      this.pop();
    }
  }

  get done(): boolean {
    return this.stack.length === 0;
  }

  cursor(): ReadCursor {
    const c: Record<string, number> = { row: this.row, depth: this.stack.length };
    this.stack.forEach((f, j) => {
      c[`p${j}`] = f.page.n;
      c[`i${j}`] = f.q;
    });
    return c;
  }

  /** Marks a page read in this read of the table: one reached twice is a loop in a damaged file. */
  claim(n: number): void {
    if (n < 1 || n > this.db.pageCount) throw new Broken(`points at page ${count(n)}, past the end of the file, which has ${count(this.db.pageCount)} pages`);
    if (this.seen.has(n)) throw new Broken(`points at page ${count(n)}, which the table reached before`);
    this.seen.add(n);
  }

  private pop(): void {
    this.stack.pop();
    const parent = this.stack[this.stack.length - 1];
    if (parent) parent.q++;
  }

  private async push(n: number): Promise<void> {
    if (this.stack.length >= MAX_DEPTH) throw new Broken(`leads deeper than the ${MAX_DEPTH} levels of pages SQLite's tables go`);
    this.claim(n);
    this.stack.push({ page: await this.load(n), q: 0 });
  }

  /** The child page a page on the path, not its last, is reading. */
  private below(f: Frame): number {
    const p = f.page;
    if (p.type === 5) return this.childAt(p, f.q);
    if (p.type === 2) return this.childAt(p, f.q / 2);
    throw new Broken("no longer leads to where the last read of the table stopped");
  }

  private childAt(p: Page, i: number): number {
    if (i === p.cells) return p.right;
    const at = u16(p.bytes, p.pointers + 2 * i);
    if (at < p.pointers + 2 * p.cells || at + 4 > this.db.usable) throw new Broken("has a cell outside the page");
    return u32(p.bytes, at);
  }

  private async load(n: number): Promise<Page> {
    const bytes = await this.db.pages.read(n);
    this.bytes += this.db.pageSize;
    this.at = n;
    // Page 1 begins with the database's header.
    const head = n === 1 ? 100 : 0;
    const type = bytes[head]!;
    if (this.keyed ? type !== 2 && type !== 10 : type !== 5 && type !== 13) throw new Broken("is not a page of the table's b-tree");
    const interior = type === 2 || type === 5;
    const cells = u16(bytes, head + 3);
    const pointers = head + (interior ? 12 : 8);
    if (pointers + 2 * cells > this.db.usable) throw new Broken("counts more cells than the page holds");
    // An interior page stays on the path while the pages below it are read: a copy of it, so it
    // does not keep a whole window of the file in memory.
    return { n, bytes: interior ? bytes.slice() : bytes, type, cells, pointers, right: interior ? u32(bytes, head + 8) : 0 };
  }
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

const cursorKey = (c: ReadCursor): string => {
  let key = `${c.row}:${c.depth}`;
  for (let j = 0; j < (c.depth ?? 0); j++) key += `:${c[`p${j}`]},${c[`i${j}`]}`;
  return key;
};

// ─── cells and records ───────────────────────────────────────────────────────

/** A row's cell: its record's size, the part of the record on the page, its first overflow page, and its rowid. */
interface Cell {
  size: number;
  local: Uint8Array;
  overflow: number;
  rowid: number | bigint;
}

function cellOf(db: Db, page: Page, i: number): Cell {
  const b = page.bytes;
  const end = db.usable;
  let at = u16(b, page.pointers + 2 * i);
  if (at < page.pointers + 2 * page.cells || at >= end) throw new Broken("has a cell outside the page");
  // An interior index cell starts with its left child.
  if (page.type === 2) at += 4;
  const size = varint(b, at, end);
  at = varintEnd;
  let rowid: number | bigint = 0;
  if (page.type === 13) {
    rowid = rowidAt(b, at, end);
    at = varintEnd;
  }
  if (size > db.pageCount * db.usable) throw new Broken("has a record longer than the whole file");
  const max = page.type === 13 ? db.tableMax : db.indexMax;
  let local = size;
  if (size > max) {
    const k = db.spillMin + ((size - db.spillMin) % (db.usable - 4));
    local = k <= max ? k : db.spillMin;
  }
  const spills = local < size;
  if (at + local + (spills ? 4 : 0) > end) throw new Broken(RUNS_PAST);
  return { size, local: b.subarray(at, at + local), overflow: spills ? u32(b, at + local) : 0, rowid };
}

/** A record whose end spills onto overflow pages, read forward as its values need them. */
class Payload {
  /** The overflow page in `page`, counted from 0. */
  private index = -1;
  private page: Uint8Array | null = null;
  private next: number;

  constructor(
    private readonly walk: Walk,
    private readonly cell: Cell,
  ) {
    this.next = cell.overflow;
  }

  async bytes(start: number, length: number): Promise<Uint8Array> {
    const local = this.cell.local;
    const onPage = local.byteLength;
    if (start + length <= onPage) return local.subarray(start, start + length);
    const out = new Uint8Array(length);
    let done = 0;
    if (start < onPage) {
      out.set(local.subarray(start), 0);
      done = onPage - start;
    }
    // An overflow page holds the number of the next one, then usable - 4 bytes of the record.
    const room = this.walk.db.usable - 4;
    while (done < length) {
      const at = start + done - onPage;
      const index = Math.floor(at / room);
      const page = await this.overflow(index);
      const from = at - index * room;
      const take = Math.min(room - from, length - done);
      out.set(page.subarray(4 + from, 4 + from + take), done);
      done += take;
    }
    return out;
  }

  private async overflow(index: number): Promise<Uint8Array> {
    if (index < this.index) throw new Error("A record's overflow pages were read out of order.");
    while (this.index < index) {
      const n = this.next;
      if (n === 0) throw new Broken("has a record whose overflow pages end before the record does");
      this.walk.claim(n);
      const page = await this.walk.db.pages.read(n);
      this.walk.bytes += this.walk.db.pageSize;
      this.page = page;
      this.index++;
      this.next = u32(page, 0);
    }
    return this.page!;
  }
}

/** The bytes of a value of each fixed-size serial type: NULL, integers of 1 to 8 bytes, a real, 0, 1. */
const FIXED = [0, 1, 2, 3, 4, 6, 8, 8, 0, 0, 0, 0];
const HEADER_TOO_LONG = "has a record whose header is longer than the record";
const HEADER_DAMAGED = "has a record whose header is damaged";

/** Reads a record's header into the walk's `types` and `starts`: how many values it holds. */
function readTypes(walk: Walk, head: Uint8Array, headerSize: number, from: number, size: number): number {
  const types = walk.types;
  const starts = walk.starts;
  let p = from;
  let at = headerSize;
  let n = 0;
  while (p < headerSize) {
    const st = varint(head, p, headerSize, HEADER_DAMAGED);
    p = varintEnd;
    types[n] = st;
    starts[n] = at;
    at += st >= 12 ? Math.floor((st - 12) / 2) : FIXED[st]!;
    n++;
  }
  if (at > size) throw new Broken("has a record whose values run past its end");
  return n;
}

/** A record's header, reading overflow pages when the header itself spills (a table of many columns). */
async function headerOf(walk: Walk, cell: Cell, payload: Payload): Promise<number> {
  const local = cell.local;
  const headerSize = varint(local, 0, local.byteLength, HEADER_DAMAGED);
  const from = varintEnd;
  if (headerSize < from || headerSize > cell.size || headerSize > RECORD_HEADER_MAX) throw new Broken(HEADER_TOO_LONG);
  const head = headerSize <= local.byteLength ? local : await payload.bytes(0, headerSize);
  return readTypes(walk, head, headerSize, from, cell.size);
}

// ─── values ──────────────────────────────────────────────────────────────────

/**
 * A real as SQLite shows it (CAST(x AS TEXT), printf's "%!.15g"): 15 significant digits, ".0" after
 * a whole number, an exponent of at least two digits, "Inf" for infinity. Checked against SQLite
 * 3.45 on 30,000 doubles of every size.
 */
export function sqliteReal(v: number): string | null {
  if (Number.isNaN(v)) return null;
  if (!Number.isFinite(v)) return v > 0 ? "Inf" : "-Inf";
  if (v === 0) return "0.0";
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return `${v}.0`;
  const s = v.toExponential(14);
  const e = s.indexOf("e");
  const negative = s.charCodeAt(0) === 45;
  let digits = s.slice(negative ? 1 : 0, e).replace(".", "");
  let last = digits.length;
  while (last > 1 && digits.charCodeAt(last - 1) === 48) last--;
  digits = digits.slice(0, last);
  const exp = Number(s.slice(e + 1));
  let out: string;
  if (exp < -4 || exp >= 15) out = `${digits[0]}.${digits.slice(1) || "0"}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  else if (exp >= 0) out = `${digits.slice(0, exp + 1).padEnd(exp + 1, "0")}.${digits.slice(exp + 1) || "0"}`;
  else out = `0.${"0".repeat(-exp - 1)}${digits}`;
  return negative ? `-${out}` : out;
}

/** A big-endian two's-complement integer of serial type 1 to 6; a bigint beyond 2^53. */
function intAt(b: Uint8Array, o: number, st: number): number | bigint {
  switch (st) {
    case 1:
      return (b[o]! << 24) >> 24;
    case 2:
      return ((b[o]! << 24) >> 16) | b[o + 1]!;
    case 3:
      return ((b[o]! << 24) >> 8) | (b[o + 1]! << 8) | b[o + 2]!;
    case 4:
      return (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!;
    case 5:
      return (((b[o]! << 24) >> 16) | b[o + 1]!) * 0x100000000 + u32(b, o + 2);
    default: {
      const high = (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!;
      const low = u32(b, o + 4);
      if (high >= -0x200000 && high < 0x200000) return high * 0x100000000 + low;
      return (BigInt(high) << 32n) | BigInt(low);
    }
  }
}

const scratch = new DataView(new ArrayBuffer(8));

/** A number's text: serial types 1 to 9. In a column of REAL affinity SQLite stores a whole real as an integer, and shows it as a real again. */
function numberText(b: Uint8Array, o: number, st: number, real: boolean): string | null {
  if (st === 7) {
    for (let i = 0; i < 8; i++) scratch.setUint8(i, b[o + i]!);
    return sqliteReal(scratch.getFloat64(0));
  }
  const v = st === 8 ? 0 : st === 9 ? 1 : intAt(b, o, st);
  return real ? sqliteReal(Number(v)) : String(v);
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, "0"));

/** A blob as SQLite's literal: X'0A1B'. */
function blobText(b: Uint8Array, o: number, length: number): string {
  let s = "X'";
  for (let i = 0; i < length; i++) s += HEX[b[o + i]!];
  return `${s}'`;
}

/** Text cut short, without the part of a character the cut left at its end. */
function wholeCharacters(bytes: Uint8Array, e: TextEncoding): Uint8Array {
  if (e.kind === "utf-16le" || e.kind === "utf-16be") {
    let end = bytes.byteLength - (bytes.byteLength % 2);
    const last = end >= 2 ? (e.kind === "utf-16le" ? bytes[end - 2]! | (bytes[end - 1]! << 8) : (bytes[end - 2]! << 8) | bytes[end - 1]!) : 0;
    if (last >= 0xd800 && last <= 0xdbff) end -= 2;
    return bytes.subarray(0, end);
  }
  let i = bytes.byteLength - 1;
  while (i > 0 && i > bytes.byteLength - 4 && (bytes[i]! & 0xc0) === 0x80) i--;
  const lead = bytes[i] ?? 0;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return i + need > bytes.byteLength ? bytes.subarray(0, i) : bytes;
}

function textOf(b: Uint8Array, o: number, length: number, cut: boolean, e: TextEncoding): string | null {
  let bytes = b.subarray(o, o + length);
  if (cut) bytes = wholeCharacters(bytes, e);
  const s = decode(bytes, e);
  return s === "" ? null : s;
}

/** How many bytes of each text value a row reads: all of them, unless the row holds more text than `ROW_TEXT_BYTES`; then the longest values each get the same share. */
function textCap(walk: Walk, t: Table, n: number): number {
  let total = 0;
  for (let r = 0; r < n; r++) {
    const st = walk.types[r]!;
    if (st >= 13 && st % 2 === 1 && t.slots[r]! >= 0) total += (st - 13) / 2;
  }
  const budget = walk.db.rowTextBytes;
  if (total <= budget) return Number.POSITIVE_INFINITY;
  const lengths: number[] = [];
  for (let r = 0; r < n; r++) {
    const st = walk.types[r]!;
    if (st >= 13 && st % 2 === 1 && t.slots[r]! >= 0) lengths.push((st - 13) / 2);
  }
  lengths.sort((a, b) => a - b);
  let left = budget;
  for (let i = 0; i < lengths.length; i++) {
    const share = Math.floor(left / (lengths.length - i));
    if (lengths[i]! > share) return share;
    left -= lengths[i]!;
  }
  return Number.POSITIVE_INFINITY;
}

/** The columns a record ends before (added by ALTER TABLE after it was written) read as their defaults; an INTEGER PRIMARY KEY is the rowid. */
function finish(t: Table, cell: Cell, n: number, out: (string | null)[]): void {
  for (let r = n; r < t.slots.length; r++) {
    const c = t.slots[r]!;
    if (c >= 0) out[c] = t.defaults[c]!;
  }
  if (t.rowid >= 0) out[t.rowid] = String(cell.rowid);
}

/** A row whose record is all on its page. */
function rowOnPage(walk: Walk, t: Table, cell: Cell): (string | null)[] {
  const local = cell.local;
  const headerSize = varint(local, 0, local.byteLength, HEADER_DAMAGED);
  const from = varintEnd;
  if (headerSize < from || headerSize > cell.size || headerSize > RECORD_HEADER_MAX) throw new Broken(HEADER_TOO_LONG);
  const n = Math.min(readTypes(walk, local, headerSize, from, cell.size), t.slots.length);
  const cap = textCap(walk, t, n);
  const out = new Array<string | null>(t.width).fill(null);
  const { types, starts } = walk;
  for (let r = 0; r < n; r++) {
    const c = t.slots[r]!;
    const st = types[r]!;
    if (c < 0 || st === 0 || st === 10 || st === 11) continue;
    const at = starts[r]!;
    if (st < 12) out[c] = numberText(local, at, st, t.affinity[c] === REAL);
    else if (st % 2 === 0) {
      const length = (st - 12) / 2;
      if (length > 0 && length <= BLOB_BYTES_MAX) out[c] = blobText(local, at, length);
    } else {
      const length = (st - 13) / 2;
      const take = Math.min(length, cap);
      if (length > 0) out[c] = textOf(local, at, take, take < length, walk.db.encoding);
    }
  }
  finish(t, cell, n, out);
  return out;
}

/** A row whose record spills onto overflow pages: only the pages its loaded values need are read. */
async function rowSpilled(walk: Walk, t: Table, cell: Cell): Promise<(string | null)[]> {
  const payload = new Payload(walk, cell);
  const n = Math.min(await headerOf(walk, cell, payload), t.slots.length);
  const cap = textCap(walk, t, n);
  const out = new Array<string | null>(t.width).fill(null);
  const { types, starts } = walk;
  for (let r = 0; r < n; r++) {
    const c = t.slots[r]!;
    const st = types[r]!;
    if (c < 0 || st === 0 || st === 10 || st === 11) continue;
    const at = starts[r]!;
    if (st < 12) {
      if (FIXED[st]) out[c] = numberText(await payload.bytes(at, FIXED[st]!), 0, st, t.affinity[c] === REAL);
      else out[c] = numberText(cell.local, 0, st, t.affinity[c] === REAL);
    } else if (st % 2 === 0) {
      const length = (st - 12) / 2;
      if (length > 0 && length <= BLOB_BYTES_MAX) out[c] = blobText(await payload.bytes(at, length), 0, length);
    } else {
      const length = (st - 13) / 2;
      const take = Math.min(length, cap);
      if (length > 0) out[c] = textOf(await payload.bytes(at, take), 0, take, take < length, walk.db.encoding);
    }
  }
  finish(t, cell, n, out);
  return out;
}

// ─── CREATE TABLE ────────────────────────────────────────────────────────────

interface Token {
  /** word: a bare name or keyword; name: a quoted name ("x", [x], `x`); text: a 'string'; blob: X'…'; op: any other character. */
  kind: "word" | "name" | "text" | "number" | "blob" | "op";
  value: string;
  start: number;
  end: number;
}

const isNameStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0x80;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isNamePart = (c: number): boolean => isNameStart(c) || isDigit(c) || c === 36;
const isHex = (c: number): boolean => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/** SQL's tokens, without its whitespace and comments. */
function tokensOf(sql: string): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql.charCodeAt(i);
    if (c <= 32) {
      i++;
      continue;
    }
    if (c === 45 && sql.charCodeAt(i + 1) === 45) {
      const line = sql.indexOf("\n", i);
      i = line < 0 ? n : line + 1;
      continue;
    }
    if (c === 47 && sql.charCodeAt(i + 1) === 42) {
      const close = sql.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    const start = i;
    if (c === 34 || c === 96 || c === 39) {
      // A quoted name or string: a doubled quote inside is one quote.
      const quote = sql[i]!;
      let value = "";
      i++;
      for (;;) {
        const k = sql.indexOf(quote, i);
        if (k < 0) {
          value += sql.slice(i);
          i = n;
          break;
        }
        value += sql.slice(i, k);
        if (sql[k + 1] === quote) {
          value += quote;
          i = k + 2;
          continue;
        }
        i = k + 1;
        break;
      }
      out.push({ kind: c === 39 ? "text" : "name", value, start, end: i });
    } else if (c === 91) {
      const k = sql.indexOf("]", i + 1);
      i = k < 0 ? n : k + 1;
      out.push({ kind: "name", value: sql.slice(start + 1, k < 0 ? n : k), start, end: i });
    } else if ((c === 88 || c === 120) && sql.charCodeAt(i + 1) === 39) {
      const k = sql.indexOf("'", i + 2);
      i = k < 0 ? n : k + 1;
      out.push({ kind: "blob", value: sql.slice(start + 2, k < 0 ? n : k), start, end: i });
    } else if (isDigit(c) || (c === 46 && isDigit(sql.charCodeAt(i + 1)))) {
      if (c === 48 && (sql[i + 1] === "x" || sql[i + 1] === "X")) {
        i += 2;
        while (i < n && isHex(sql.charCodeAt(i))) i++;
      } else {
        while (i < n && isDigit(sql.charCodeAt(i))) i++;
        if (sql[i] === ".") {
          i++;
          while (i < n && isDigit(sql.charCodeAt(i))) i++;
        }
        const sign = sql[i + 1] === "+" || sql[i + 1] === "-" ? 1 : 0;
        if ((sql[i] === "e" || sql[i] === "E") && isDigit(sql.charCodeAt(i + 1 + sign))) {
          i += 1 + sign;
          while (i < n && isDigit(sql.charCodeAt(i))) i++;
        }
      }
      out.push({ kind: "number", value: sql.slice(start, i), start, end: i });
    } else if (isNameStart(c)) {
      i++;
      while (i < n && isNamePart(sql.charCodeAt(i))) i++;
      out.push({ kind: "word", value: sql.slice(start, i), start, end: i });
    } else {
      i++;
      out.push({ kind: "op", value: sql[start]!, start, end: i });
    }
  }
  return out;
}

const isWord = (t: Token | undefined, w: string): boolean => t?.kind === "word" && t.value.toUpperCase() === w;
const isOp = (t: Token | undefined, o: string): boolean => t?.kind === "op" && t.value === o;

/** The index of the ")" that closes the "(" at `open`, or the last token when none does. */
function closing(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isOp(tokens[i], "(")) depth++;
    else if (isOp(tokens[i], ")") && --depth === 0) return i;
  }
  return tokens.length - 1;
}

/** Tokens split at the commas outside parentheses. */
function splitTop(tokens: Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (isOp(t, "(")) depth++;
    else if (isOp(t, ")")) depth--;
    else if (isOp(t, ",") && depth === 0) {
      parts.push([]);
      continue;
    }
    parts[parts.length - 1]!.push(t);
  }
  return parts;
}

/** A DEFAULT, as SQLite reads it for a record written before its column was added. */
type Literal =
  | { kind: "null" }
  | { kind: "int"; value: bigint }
  /** A number written as text: SQLite keeps what was written, until the column's affinity makes it a number. */
  | { kind: "number"; text: string }
  | { kind: "text"; text: string }
  | { kind: "blob"; hex: string };

interface ColumnDef {
  name: string;
  /** As written, its whitespace tidied; "" when the column names no type. */
  type: string;
  primaryKey: boolean;
  /** PRIMARY KEY DESC on the column: never the rowid, a quirk SQLite keeps. */
  descending: boolean;
  collate: string | null;
  /** A generated column SQLite computes when it reads the row, so the record holds no value for it. */
  computed: boolean;
  fallback: Literal | null;
}

interface CreateTable {
  columns: ColumnDef[];
  /** A table constraint's PRIMARY KEY: its columns, in order, with any collation each names. */
  key: { name: string; collate: string | null }[] | null;
  withoutRowid: boolean;
  strict: boolean;
}

const TABLE_CONSTRAINT = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"]);
const COLUMN_CONSTRAINT = new Set(["CONSTRAINT", "PRIMARY", "NOT", "NULL", "UNIQUE", "CHECK", "DEFAULT", "COLLATE", "REFERENCES", "GENERATED", "AS"]);
const INT32_MAX = 2n ** 31n - 1n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A type as written, with runs of whitespace made one space and none around its parentheses: "DECIMAL(10, 2)". */
function tidyType(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\s*\(\s*/g, "(").replace(/\s*\)/g, ")").replace(/\s*,/g, ",").trim();
}

/** A number token as SQLite keeps it in a DEFAULT: one that fits in 32 bits is an integer, any other the text written. */
function numberLiteral(text: string, negative: boolean): Literal {
  if (/^0[xX]/.test(text)) {
    const v = BigInt(text) * (negative ? -1n : 1n);
    return { kind: "int", value: BigInt.asIntN(64, v) };
  }
  if (/^\d+$/.test(text)) {
    const v = BigInt(text) * (negative ? -1n : 1n);
    if (v >= -INT32_MAX - 1n && v <= INT32_MAX) return { kind: "int", value: v };
  }
  return { kind: "number", text: (negative ? "-" : "") + text };
}

/** The value after DEFAULT, from `k`; null for one SQLite computes (CURRENT_TIMESTAMP, an expression). */
function literalAt(item: Token[], k: number): Literal | null {
  const first = item[k];
  if (!first) return null;
  let parts: Token[];
  if (isOp(first, "(")) parts = item.slice(k, closing(item, k) + 1);
  else if ((isOp(first, "-") || isOp(first, "+")) && item[k + 1]?.kind === "number") parts = [first, item[k + 1]!];
  else parts = [first];
  while (parts.length >= 2 && isOp(parts[0], "(") && isOp(parts[parts.length - 1], ")")) parts = parts.slice(1, -1);
  let negative = false;
  if (parts.length === 2 && (isOp(parts[0], "-") || isOp(parts[0], "+")) && parts[1]!.kind === "number") {
    negative = parts[0]!.value === "-";
    parts = [parts[1]!];
  }
  const t = parts[0];
  if (parts.length !== 1 || !t) return null;
  switch (t.kind) {
    case "number":
      return numberLiteral(t.value, negative);
    case "text":
    case "name":
      return { kind: "text", text: t.value };
    case "blob":
      return /^([0-9a-fA-F]{2})*$/.test(t.value) ? { kind: "blob", hex: t.value.toUpperCase() } : null;
    case "word": {
      const w = t.value.toUpperCase();
      if (w === "NULL") return { kind: "null" };
      if (w === "TRUE" || w === "FALSE") return { kind: "int", value: w === "TRUE" ? 1n : 0n };
      if (w.startsWith("CURRENT_")) return null;
      // A bare name after DEFAULT is a string to SQLite.
      return { kind: "text", text: t.value };
    }
    default:
      return null;
  }
}

/** A text as a number column holds it (NUMERIC, INTEGER or REAL affinity); null when it is not a number. */
function asNumber(text: string, affinity: Affinity): string | null {
  const s = text.trim();
  if (/^[+-]?\d+$/.test(s)) {
    const v = BigInt(s);
    if (v >= INT64_MIN && v <= INT64_MAX) return affinity === REAL ? sqliteReal(Number(v)) : String(v);
    return sqliteReal(Number(s));
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const v = Number(s);
  // A whole real becomes an integer, except in a column of REAL affinity.
  if (affinity !== REAL && Number.isInteger(v) && Math.abs(v) < 2 ** 63) return BigInt(v).toString();
  return sqliteReal(v);
}

/** What a column added by ALTER TABLE reads as in a record written before it: its DEFAULT, with the column's affinity applied, as text. */
function defaultText(lit: Literal | null, affinity: Affinity): string | null {
  if (!lit) return null;
  switch (lit.kind) {
    case "null":
      return null;
    case "blob":
      return lit.hex.length > 0 && lit.hex.length / 2 <= BLOB_BYTES_MAX ? `X'${lit.hex}'` : null;
    case "int":
      return affinity === REAL ? sqliteReal(Number(lit.value)) : String(lit.value);
    case "number":
      return affinity === TEXT ? lit.text : (asNumber(lit.text, affinity === BLOB ? NUMERIC : affinity) ?? lit.text);
    case "text":
      if (affinity === TEXT || affinity === BLOB) return lit.text === "" ? null : lit.text;
      return asNumber(lit.text, affinity) ?? (lit.text === "" ? null : lit.text);
  }
}

/** A column's affinity, from its declared type, by SQLite's rules (https://www.sqlite.org/datatype3.html). */
function affinityOf(type: string, strict: boolean): Affinity {
  const t = type.toUpperCase();
  if (strict && t === "ANY") return BLOB;
  if (t.includes("INT")) return INTEGER;
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return TEXT;
  if (t.includes("BLOB") || t === "") return BLOB;
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return REAL;
  return NUMERIC;
}

/** A name lowercased as SQLite compares names: ASCII letters only. */
const fold = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

function columnOf(item: Token[], sql: string): ColumnDef {
  const col: ColumnDef = { name: item[0]!.value, type: "", primaryKey: false, descending: false, collate: null, computed: false, fallback: null };
  let k = 1;
  while (k < item.length) {
    const t = item[k]!;
    if (t.kind === "name" || t.kind === "text" || (t.kind === "word" && !COLUMN_CONSTRAINT.has(t.value.toUpperCase()))) k++;
    else break;
  }
  if (k > 1 && isOp(item[k], "(")) k = closing(item, k) + 1;
  if (k > 1) {
    const type = tidyType(sql.slice(item[1]!.start, item[k - 1]!.end));
    // A type written as one quoted name: SQLite reads it without its quotes.
    col.type = k === 2 && item[1]!.kind !== "word" ? item[1]!.value : type;
  }
  let generated = false;
  for (; k < item.length; k++) {
    const t = item[k]!;
    if (isOp(t, "(")) {
      k = closing(item, k);
      continue;
    }
    if (t.kind !== "word") continue;
    switch (t.value.toUpperCase()) {
      case "PRIMARY":
        col.primaryKey = true;
        if (isWord(item[k + 1], "KEY")) k++;
        if (isWord(item[k + 1], "DESC")) col.descending = true;
        break;
      case "DEFAULT":
        // ON DELETE SET DEFAULT is a foreign key's action, not a default.
        if (!isWord(item[k - 1], "SET")) col.fallback = literalAt(item, k + 1);
        break;
      case "COLLATE":
        col.collate = item[k + 1]?.value ?? null;
        k++;
        break;
      case "CONSTRAINT":
        k++;
        break;
      case "AS":
        // GENERATED ALWAYS AS (…): VIRTUAL unless it says STORED.
        generated = true;
        col.computed = true;
        break;
      case "STORED":
        if (generated) col.computed = false;
        break;
    }
  }
  return col;
}

/** The columns of a table constraint's PRIMARY KEY (…), when the item holds one. */
function keyOf(item: Token[]): CreateTable["key"] {
  for (let i = 0; i < item.length; i++) {
    if (isOp(item[i], "(")) {
      i = closing(item, i);
      continue;
    }
    if (isWord(item[i], "PRIMARY") && isWord(item[i + 1], "KEY") && isOp(item[i + 2], "(")) {
      return splitTop(item.slice(i + 3, closing(item, i + 2)))
        .filter((term) => term.length > 0)
        .map((term) => {
          const collate = term.findIndex((t) => isWord(t, "COLLATE"));
          return { name: term[0]!.value, collate: collate >= 0 ? (term[collate + 1]?.value ?? null) : null };
        });
    }
  }
  return null;
}

/** A CREATE TABLE statement's columns, primary key and options; null when it names no columns. */
export function parseCreateTable(sql: string): CreateTable | null {
  const tokens = tokensOf(sql);
  const open = tokens.findIndex((t) => isOp(t, "("));
  if (open < 0) return null;
  const close = closing(tokens, open);
  const columns: ColumnDef[] = [];
  let key: CreateTable["key"] = null;
  let constraints = false;
  for (const item of splitTop(tokens.slice(open + 1, close))) {
    const first = item[0];
    if (!first) continue;
    // Table constraints come after the columns, with or without commas between them.
    if (!constraints && first.kind === "word" && TABLE_CONSTRAINT.has(first.value.toUpperCase())) constraints = true;
    if (constraints) key = keyOf(item) ?? key;
    else columns.push(columnOf(item, sql));
  }
  let withoutRowid = false;
  let strict = false;
  for (let i = close + 1; i < tokens.length; i++) {
    if (isWord(tokens[i], "WITHOUT") && isWord(tokens[i + 1], "ROWID")) withoutRowid = true;
    if (isWord(tokens[i], "STRICT")) strict = true;
  }
  return columns.length ? { columns, key, withoutRowid, strict } : null;
}

// ─── tables ──────────────────────────────────────────────────────────────────

/** A table, as its rows are read. */
interface Table {
  name: string;
  root: number;
  /** A WITHOUT ROWID table: an index b-tree whose records hold the primary key's columns first. */
  keyed: boolean;
  /** The column each value of a record is, in the record's order; -1 for none. */
  slots: number[];
  /** The column that is the rowid (an INTEGER PRIMARY KEY), or -1. */
  rowid: number;
  affinity: Affinity[];
  /** What each column reads as in a record that ends before it: its DEFAULT. */
  defaults: (string | null)[];
  width: number;
}

/** How a table's records map to its columns, from its CREATE TABLE statement. */
function tableOf(name: string, root: number, c: CreateTable): Table {
  const cols = c.columns;
  const affinity = cols.map((col) => affinityOf(col.type, c.strict));
  const named = (n: string): number => cols.findIndex((col) => fold(col.name) === fold(n));
  const key: { column: number; collate: string }[] = [];
  if (c.key) {
    for (const k of c.key) {
      const i = named(k.name);
      if (i >= 0) key.push({ column: i, collate: k.collate ?? cols[i]!.collate ?? "BINARY" });
    }
  } else {
    const i = cols.findIndex((col) => col.primaryKey);
    if (i >= 0) key.push({ column: i, collate: cols[i]!.collate ?? "BINARY" });
  }
  let rowid = -1;
  if (!c.withoutRowid && key.length === 1) {
    const col = cols[key[0]!.column]!;
    // Only a column declared exactly INTEGER is the rowid, and not with PRIMARY KEY DESC on the column itself.
    if (col.type.toUpperCase() === "INTEGER" && !(!c.key && col.descending)) rowid = key[0]!.column;
  }
  const stored = cols.map((_, i) => i).filter((i) => !cols[i]!.computed);
  let slots = stored;
  if (c.withoutRowid && key.length) {
    // The primary key's columns first, a column named twice with the same collation once, then the others in order.
    const first: { column: number; collate: string }[] = [];
    for (const k of key) if (!first.some((f) => f.column === k.column && fold(f.collate) === fold(k.collate))) first.push(k);
    const inKey = new Set(first.map((f) => f.column));
    slots = [...first.map((f) => f.column), ...stored.filter((i) => !inKey.has(i))];
  }
  return {
    name,
    root,
    keyed: c.withoutRowid,
    slots,
    rowid,
    affinity,
    defaults: cols.map((col, i) => defaultText(col.fallback, affinity[i]!)),
    width: cols.length,
  };
}

/** One row of sqlite_schema: what an entry is, its name, its first page, and the SQL that made it. */
interface SchemaEntry {
  type: string;
  name: string;
  root: number;
  sql: string;
}

const SCHEMA: Table = { name: "sqlite_schema", root: 1, keyed: false, slots: [0, 1, 2, 3, 4], rowid: -1, affinity: [TEXT, TEXT, TEXT, INTEGER, TEXT], defaults: [null, null, null, null, null], width: 5 };

async function readSchema(db: Db): Promise<SchemaEntry[]> {
  const walk = new Walk(db, 1, false, new PageSet());
  const out: SchemaEntry[] = [];
  try {
    await walk.begin();
    for (;;) {
      const page = walk.ready() ?? (await walk.next());
      if (!page) break;
      const cell = cellOf(db, page, walk.index);
      const v = cell.overflow === 0 ? rowOnPage(walk, SCHEMA, cell) : await rowSpilled(walk, SCHEMA, cell);
      out.push({ type: v[0] ?? "", name: v[1] ?? "", root: Number(v[3] ?? 0), sql: v[4] ?? "" });
    }
  } catch (err) {
    if (err instanceof Broken) throw damaged(`page ${walk.at} of sqlite_schema, its list of tables, ${err.message}`);
    throw err;
  }
  return out;
}

/** What a table's first rows say, for its notes: the columns holding blobs longer than a store loads, the columns with any value, and how many rows it has when it has no more. */
async function sampleOf(db: Db, t: Table): Promise<{ long: boolean[]; filled: boolean[]; rows: number; ended: boolean }> {
  const walk = new Walk(db, t.root, t.keyed, new PageSet());
  const long = new Array<boolean>(t.width).fill(false);
  const filled = new Array<boolean>(t.width).fill(false);
  let rows = 0;
  try {
    await walk.begin();
    while (rows < SAMPLE_ROWS) {
      const page = walk.ready() ?? (await walk.next());
      if (!page) break;
      const cell = cellOf(db, page, walk.index);
      const n = Math.min(await headerOf(walk, cell, new Payload(walk, cell)), t.slots.length);
      for (let r = 0; r < n; r++) {
        const c = t.slots[r]!;
        const st = walk.types[r]!;
        if (c < 0 || st === 0) continue;
        filled[c] = true;
        if (st >= 12 && st % 2 === 0 && (st - 12) / 2 > BLOB_BYTES_MAX) long[c] = true;
      }
      rows++;
    }
    walk.settle();
  } catch (err) {
    if (err instanceof Broken) throw new TableDamaged(`page ${walk.at} ${err.message}`);
    throw err;
  }
  return { long, filled, rows, ended: walk.done };
}

/** A table damaged where its first rows are, found while the file opens: it is left out, and the file's notes say why. */
class TableDamaged extends Error {}

const list = (names: string[]): string => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

export interface OpenSqliteOptions {
  /** The windows pages are read through: 1 MB, 8 kept. Smaller in tests, to see the reads. */
  windowBytes?: number;
  windows?: number;
  /** The most text one row reads (8 MB). Smaller in tests, to see values cut. */
  rowTextBytes?: number;
}

/** A SQLite database, opened by range: each table it stores, with its columns, and its rows a batch at a time. */
export async function openSqlite(source: ByteSource, options: OpenSqliteOptions = {}): Promise<OpenedFile> {
  const header = readHeader(await source.read(0, Math.min(source.size, 100)), source.size);
  const { pageSize, usable } = header;
  const windowBytes = Math.ceil(Math.max(options.windowBytes ?? WINDOW_BYTES, pageSize) / pageSize) * pageSize;
  const db: Db = {
    pages: new PageReader(source, pageSize, windowBytes, options.windows ?? WINDOWS_KEPT),
    pageSize,
    usable,
    pageCount: header.pageCount,
    encoding: header.encoding,
    tableMax: usable - 35,
    indexMax: Math.floor(((usable - 12) * 64) / 255) - 23,
    spillMin: Math.floor(((usable - 12) * 32) / 255) - 23,
    rowTextBytes: options.rowTextBytes ?? ROW_TEXT_BYTES,
  };
  const schema = await readSchema(db);

  // What the file holds besides its own tables.
  const own = (name: string): boolean => header.geopackage && /^(gpkg|rtree)_/i.test(name);
  const views = schema.filter((e) => e.type === "view" && !own(e.name)).map((e) => e.name);
  const virtual = schema.filter((e) => e.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(e.sql));
  const shadows = new Set(virtual.flatMap((v) => SHADOW_SUFFIXES.map((s) => `${fold(v.name)}_${s}`)));
  const notes: string[] = [];
  if (header.geopackage) notes.push("This is a GeoPackage: its gpkg_ tables, which describe its layers, and its rtree_ spatial indexes are not loaded.");
  if (header.wal) notes.push("This database is in write-ahead log (WAL) mode: changes still in its -wal file are not in it. To include them, close every program that has the database open before copying it.");
  if (views.length) {
    notes.push(views.length === 1 ? `${views[0]} is a view, a saved query with no rows of its own, so it is not loaded.` : `${list(views)} are views, saved queries with no rows of their own, so they are not loaded.`);
  }
  const shown = virtual.filter((v) => !own(v.name)).map((v) => `${v.name} (${/\bUSING\s+([^\s(]+)/i.exec(v.sql)?.[1] ?? "a module"})`);
  if (shown.length) {
    notes.push(
      shown.length === 1
        ? `The virtual table ${shown[0]} is not loaded: an extension of SQLite builds its rows, and the tables it keeps them in are left out too.`
        : `The virtual tables ${list(shown)} are not loaded: an extension of SQLite builds their rows, and the tables it keeps them in are left out too.`,
    );
  }

  const tables: SourceTable[] = [];
  const loaded: Table[] = [];
  let firstDamage: string | null = null;
  for (const e of schema) {
    if (e.type !== "table" || /^sqlite_/i.test(e.name) || own(e.name) || shadows.has(fold(e.name)) || virtual.includes(e)) continue;
    const create = parseCreateTable(e.sql);
    if (!create) {
      notes.push(`The table ${e.name} is not loaded: its CREATE TABLE statement could not be read.`);
      continue;
    }
    const t = tableOf(e.name, e.root, create);
    let sample: Awaited<ReturnType<typeof sampleOf>>;
    try {
      if (t.root < 2) throw new TableDamaged(`its first page is page ${t.root}, which no table of rows starts at`);
      sample = await sampleOf(db, t);
    } catch (err) {
      if (!(err instanceof TableDamaged)) throw err;
      notes.push(`The table ${e.name} is damaged, so it is not loaded: ${err.message}.`);
      firstDamage ??= `the table ${e.name}: ${err.message}`;
      continue;
    }
    const tableNotes: string[] = [];
    const binary = create.columns.filter((col, i) => sample.long[i] || (BINARY_TYPE.test(col.type) && !sample.filled[i] && !sample.ended)).map((col) => col.name);
    if (binary.length) tableNotes.push(`${binary.join(", ")} hold${binary.length > 1 ? "" : "s"} files or binary values longer than ${count(BLOB_BYTES_MAX)} bytes, which a store does not load.`);
    const computed = create.columns.filter((col) => col.computed).map((col) => col.name);
    if (computed.length) {
      tableNotes.push(
        computed.length === 1
          ? `${computed[0]} is computed by SQLite each time it is read, so the file holds no values for it.`
          : `${computed.join(", ")} are computed by SQLite each time they are read, so the file holds no values for them.`,
      );
    }
    const columns: SourceColumn[] = create.columns.map((col) => ({ name: col.name, originalType: col.type || "any" }));
    tables.push({ name: e.name, columns, rowCount: sample.ended ? sample.rows : null, notes: tableNotes });
    loaded.push(t);
  }
  // A file whose every table is damaged is a damaged file: LOAD says so, rather than that it holds no tables.
  if (!tables.length && firstDamage) throw damaged(firstDamage);

  /** The read that stopped last, and the pages it reached, so the next batch from its cursor goes on without reading them again. */
  let live: { table: number; key: string; seen: PageSet } | null = null;

  async function rows(index: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    const t = loaded[index];
    if (!t) throw new RangeError(`This database has no table ${index}.`);
    const key = cursor ? cursorKey(cursor) : null;
    const going = live && live.table === index && key !== null && live.key === key ? live.seen : null;
    live = null;
    const walk = new Walk(db, t.root, t.keyed, going ?? new PageSet());
    const most = limit.bytes ?? BATCH_BYTES;
    const out: SourceRow[] = [];
    try {
      if (cursor) await walk.resume(cursor, !going);
      else await walk.begin();
      while (out.length < limit.rows) {
        const page = walk.ready() ?? (await walk.next());
        if (!page) break;
        const cell = cellOf(db, page, walk.index);
        const values = cell.overflow === 0 ? rowOnPage(walk, t, cell) : await rowSpilled(walk, t, cell);
        out.push({ n: ++walk.row, values });
        if (walk.bytes >= most) break;
      }
      walk.settle();
    } catch (err) {
      if (err instanceof Broken) throw damaged(`page ${walk.at} of the table ${t.name} ${err.message}`);
      throw err;
    }
    const next = walk.done ? null : walk.cursor();
    if (next) live = { table: index, key: cursorKey(next), seen: walk.seen };
    return { rows: out, next, deleted: 0 };
  }

  return { format: "sqlite", tables, notes, rows };
}
