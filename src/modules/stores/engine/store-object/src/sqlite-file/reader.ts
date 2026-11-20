// Reads a SQLite database file a page at a time, with no SQLite library: what a store's import
// does with an export, inside a Durable Object, where the file is in the bucket and is read by
// range. LOAD's reader (`store-readers` sqlite.ts) shows a database's values as text, the
// way a town's file becomes a raw table; an import needs every value as it was (integers, reals,
// text and bytes of any length), so it reads records here and shares only the byte source.
//
// A cursor is the path from a b-tree's root to the next row: plain numbers a job keeps between
// chunks, and a reader of the same file goes on from. A damaged or hostile file stops with plain
// words: no b-tree deeper than SQLite's own 20 levels, every page number, cell, record and
// overflow chain checked against the file before it is used.

import { windowedSource, type ByteSource } from "../../../store-readers/src/source.js";

import {
  decodeRecord,
  localPayloadSize,
  MAGIC,
  PAGE_INTERIOR_INDEX,
  PAGE_INTERIOR_TABLE,
  PAGE_LEAF_INDEX,
  PAGE_LEAF_TABLE,
  readSmallVarint,
  readVarint,
  SqliteFileError,
  u16,
  u32,
  type SqliteValue,
} from "./format.js";
import type { SchemaEntry } from "./writer.js";

/** SQLite's own limit on a b-tree's depth (BTCURSOR_MAX_DEPTH). */
const MAX_DEPTH = 20;
/** The longest record a store takes: a row in workerd holds at most 2 MB, and a little more for its framing. */
const RECORD_MAX = 4 * 1024 * 1024;

/** Where a read of a b-tree goes on: the page and the step within it, at each level. */
export type BTreeCursor = Array<[page: number, step: number]>;

export interface BTreeRow {
  /** A table's rowid; none for an index's entry or a WITHOUT ROWID table's row. */
  rowid: number | bigint | null;
  values: SqliteValue[];
  /** The record's bytes, for the limits a caller keeps. */
  bytes: number;
}

export class SqliteFileReader {
  readonly pageSize: number;
  readonly usable: number;
  readonly pages: number;
  private readonly source: ByteSource;

  private constructor(source: ByteSource, pageSize: number, usable: number, pages: number) {
    this.source = source;
    this.pageSize = pageSize;
    this.usable = usable;
    this.pages = pages;
  }

  /** Opens a file: its header must be a SQLite database's, in UTF-8. */
  static async open(source: ByteSource): Promise<SqliteFileReader> {
    if (source.size < 512) throw new SqliteFileError("This file is too short to be a SQLite database.");
    const head = await source.read(0, 100);
    if (!MAGIC.every((b, i) => head[i] === b)) throw new SqliteFileError("This file is not a SQLite database.");
    const raw = u16(head, 16);
    const pageSize = raw === 1 ? 65536 : raw;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) throw new SqliteFileError("This SQLite database's page size is not one SQLite makes.");
    const reserved = head[20]!;
    const usable = pageSize - reserved;
    if (usable < 480) throw new SqliteFileError("This SQLite database reserves too much of each page.");
    if (u32(head, 56) !== 1) throw new SqliteFileError("This SQLite database keeps its text in UTF-16. Save it as UTF-8 (PRAGMA encoding = 'UTF-8' on a new database, then copy the tables in).");
    const pages = Math.floor(source.size / pageSize);
    if (pages < 1) throw new SqliteFileError("This SQLite database has no pages.");
    return new SqliteFileReader(windowedSource(source, 1 << 20, 8), pageSize, usable, pages);
  }

  async page(n: number): Promise<Uint8Array> {
    if (!Number.isInteger(n) || n < 1 || n > this.pages) throw new SqliteFileError(`A b-tree points at page ${n}, which this file does not have.`);
    const bytes = await this.source.read((n - 1) * this.pageSize, this.pageSize);
    if (bytes.byteLength !== this.pageSize) throw new SqliteFileError(`Page ${n} is cut short.`);
    return bytes;
  }

  /** Every row of sqlite_schema, in its own order. */
  async schema(): Promise<SchemaEntry[]> {
    const out: SchemaEntry[] = [];
    let cursor: BTreeCursor | null = null;
    for (;;) {
      const read: { rows: BTreeRow[]; cursor: BTreeCursor | null } = await this.read(1, "table", cursor, { rows: 10_000 });
      for (const row of read.rows) {
        const [type, name, tableName, rootPage, sql] = row.values;
        if (typeof type !== "string" || typeof name !== "string") continue;
        out.push({
          type: type as SchemaEntry["type"],
          name,
          tableName: typeof tableName === "string" ? tableName : name,
          rootPage: typeof rootPage === "number" ? rootPage : 0,
          sql: typeof sql === "string" ? sql : null,
        });
      }
      if (!read.cursor) return out;
      cursor = read.cursor;
    }
  }

  /**
   * The next rows of a b-tree, from `cursor` (null: from the first), in its order: a table's in
   * rowid order, an index's (or a WITHOUT ROWID table's) in key order. Stops at `limit` and answers
   * where to go on, or null when the b-tree has no more.
   */
  async read(root: number, kind: "table" | "index", cursor: BTreeCursor | null, limit: { rows?: number; bytes?: number }): Promise<{ rows: BTreeRow[]; cursor: BTreeCursor | null }> {
    const stack: BTreeCursor = cursor ? cursor.map(([p, s]) => [p, s]) : [[root, 0]];
    const rows: BTreeRow[] = [];
    let bytes = 0;
    const maxRows = limit.rows ?? Infinity;
    const maxBytes = limit.bytes ?? Infinity;
    while (stack.length > 0) {
      if (rows.length >= maxRows || bytes >= maxBytes) return { rows, cursor: stack };
      if (stack.length > MAX_DEPTH) throw new SqliteFileError(`A b-tree in this file is deeper than SQLite makes one, at page ${stack[stack.length - 1]![0]}.`);
      const frame = stack[stack.length - 1]!;
      const [pageNo, step] = frame;
      const page = await this.page(pageNo);
      const at = pageNo === 1 ? 100 : 0;
      const type = page[at]!;
      const want = kind === "table" ? [PAGE_LEAF_TABLE, PAGE_INTERIOR_TABLE] : [PAGE_LEAF_INDEX, PAGE_INTERIOR_INDEX];
      if (!want.includes(type)) throw new SqliteFileError(`Page ${pageNo} is not a page of the ${kind === "table" ? "table" : "index"} b-tree that points at it.`);
      const cells = u16(page, at + 3);
      const leaf = type === PAGE_LEAF_TABLE || type === PAGE_LEAF_INDEX;
      const pointers = at + (leaf ? 8 : 12);
      if (pointers + 2 * cells > this.usable) throw new SqliteFileError(`Page ${pageNo} names more cells than it has room for.`);
      const cellAt = (i: number): number => {
        const offset = u16(page, pointers + 2 * i);
        if (offset < pointers + 2 * cells || offset >= this.usable) throw new SqliteFileError(`Page ${pageNo} has a cell outside it.`);
        return offset;
      };
      if (leaf) {
        if (step >= cells) {
          stack.pop();
          continue;
        }
        frame[1] = step + 1;
        const row = await this.cell(page, pageNo, cellAt(step), type);
        rows.push(row);
        bytes += row.bytes;
        continue;
      }
      if (type === PAGE_INTERIOR_TABLE) {
        if (step > cells) {
          stack.pop();
          continue;
        }
        frame[1] = step + 1;
        const child = step < cells ? u32(page, cellAt(step)) : u32(page, at + 8);
        stack.push([child, 0]);
        continue;
      }
      // An index's interior page: child 0, entry 0, child 1, entry 1, …, the right-most child.
      if (step > 2 * cells) {
        stack.pop();
        continue;
      }
      frame[1] = step + 1;
      if (step % 2 === 0) {
        const i = step / 2;
        const child = i < cells ? u32(page, cellAt(i)) : u32(page, at + 8);
        stack.push([child, 0]);
      } else {
        const row = await this.cell(page, pageNo, cellAt((step - 1) / 2), type);
        rows.push(row);
        bytes += row.bytes;
      }
    }
    return { rows, cursor: null };
  }

  /** A cell's row: its rowid (on a table's leaf) and its record, overflow pages and all. */
  private async cell(page: Uint8Array, pageNo: number, at: number, type: number): Promise<BTreeRow> {
    let p = at;
    if (type === PAGE_INTERIOR_INDEX) p += 4;
    const length = readSmallVarint(page, p);
    p += length.length;
    let rowid: number | bigint | null = null;
    if (type === PAGE_LEAF_TABLE) {
      const id = readVarint(page, p);
      p += id.length;
      rowid = id.value >= BigInt(Number.MIN_SAFE_INTEGER) && id.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id.value) : id.value;
    }
    const total = length.value;
    if (total > RECORD_MAX) throw new SqliteFileError(`A row on page ${pageNo} is larger than a store takes (${Math.round(total / 1024 / 1024)} MB).`);
    const local = localPayloadSize(total, this.usable, type === PAGE_LEAF_TABLE ? "table-leaf" : "index");
    if (p + local > this.usable) throw new SqliteFileError(`Page ${pageNo} has a cell that runs past its end.`);
    const record = new Uint8Array(total);
    record.set(page.subarray(p, p + local), 0);
    if (local < total) {
      let next = u32(page, p + local);
      let filled = local;
      let hops = 0;
      while (filled < total) {
        if (next === 0 || ++hops > this.pages) throw new SqliteFileError(`A row on page ${pageNo} names overflow pages the file does not have.`);
        const overflow = await this.page(next);
        const take = Math.min(this.usable - 4, total - filled);
        record.set(overflow.subarray(4, 4 + take), filled);
        filled += take;
        next = u32(overflow, 0);
      }
    }
    return { rowid, values: decodeRecord(record), bytes: total };
  }
}

/** Several R2 objects (an export's pieces) read as one file. */
export function piecesSource(pieces: readonly { size: number; read(offset: number, length: number): Promise<Uint8Array> }[]): ByteSource {
  const starts: number[] = [];
  let size = 0;
  for (const piece of pieces) {
    starts.push(size);
    size += piece.size;
  }
  return {
    size,
    async read(offset, length) {
      const end = Math.min(size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      const out = new Uint8Array(end - offset);
      for (let i = 0; i < pieces.length; i++) {
        const from = starts[i]!;
        const to = from + pieces[i]!.size;
        if (to <= offset || from >= end) continue;
        const a = Math.max(offset, from);
        const b = Math.min(end, to);
        out.set(await pieces[i]!.read(a - from, b - a), a - offset);
      }
      return out;
    },
  };
}
