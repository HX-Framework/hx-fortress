// Writes a SQLite database file from rows, a page at a time, in file order: what a store's export
// does, since a Durable Object cannot hand out its own database file. Each table and each index
// becomes a b-tree built from the bottom up as its rows arrive in order (rowid order for a table,
// the index's own order for an index), so the writer holds one partial page per level and never
// the file. Pages leave in the order they are numbered, from page 2; page 1, which holds the
// header and the root of sqlite_schema, is made last, once every root page is known, and goes
// first in the file.
//
// A writer's state is plain data (`WriterState`): a job keeps it between chunks and a new writer
// goes on from it, with the pages it already handed out gone to the bucket.

import {
  encodeRecord,
  encodeVarint,
  localPayloadSize,
  MAGIC,
  PAGE_INTERIOR_INDEX,
  PAGE_INTERIOR_TABLE,
  PAGE_LEAF_INDEX,
  PAGE_LEAF_TABLE,
  PAGE_SIZE,
  putU16,
  putU32,
  SqliteFileError,
  varintLength,
  type SqliteValue,
} from "./format.js";

/** Bytes of a b-tree page's header: 8 on a leaf, 12 with the right-most child on an interior page. */
const LEAF_HEADER = 8;
const INTERIOR_HEADER = 12;
/** Page 1 starts with the file's 100-byte header. */
const FILE_HEADER = 100;
/** The SQLite version the file says wrote it (3.46.1); readers only show it. */
const WRITER_VERSION = 3046001;

/** The space a cell takes on its page: its bytes, at least 4 (SQLite's smallest cell), and its pointer. */
function cellSpace(cell: Uint8Array): number {
  return Math.max(4, cell.byteLength) + 2;
}

const b64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The page holding the file's byte 2^30, which SQLite keeps for its locks and never uses: it stays empty. */
const LOCK_BYTE_PAGE = Math.floor(2 ** 30 / PAGE_SIZE) + 1;

/** Where pages go: numbered in the order they arrive, from page 2, past the page SQLite keeps for its locks. */
export class PageOut {
  next: number;
  readonly pages: Uint8Array[] = [];

  constructor(next = 2) {
    this.next = next;
  }

  emit(page: Uint8Array): number {
    if (page.byteLength !== PAGE_SIZE) throw new SqliteFileError("A page is the wrong size.");
    if (this.next === LOCK_BYTE_PAGE) {
      this.pages.push(new Uint8Array(PAGE_SIZE));
      this.next++;
    }
    this.pages.push(page);
    return this.next++;
  }

  /** The number the next page will get. */
  get upcoming(): number {
    return this.next === LOCK_BYTE_PAGE ? this.next + 1 : this.next;
  }

  /** The pages handed out since the last take, as one run of bytes. */
  take(): Uint8Array {
    const out = new Uint8Array(this.pages.length * PAGE_SIZE);
    this.pages.forEach((page, i) => out.set(page, i * PAGE_SIZE));
    this.pages.length = 0;
    return out;
  }

  get pending(): number {
    return this.pages.length;
  }
}

/** A b-tree page laid out: its cells from the end of the page back, their pointers after the header. */
export function layoutPage(type: number, cells: readonly Uint8Array[], rightChild: number | null, headerAt = 0): Uint8Array {
  const page = new Uint8Array(PAGE_SIZE);
  const interior = type === PAGE_INTERIOR_INDEX || type === PAGE_INTERIOR_TABLE;
  const pointers = headerAt + (interior ? INTERIOR_HEADER : LEAF_HEADER);
  let content = PAGE_SIZE;
  cells.forEach((cell, i) => {
    content -= Math.max(4, cell.byteLength);
    page.set(cell, content);
    putU16(page, pointers + 2 * i, content);
  });
  if (pointers + 2 * cells.length > content) throw new SqliteFileError("A page's cells do not fit on it.");
  page[headerAt] = type;
  putU16(page, headerAt + 1, 0);
  putU16(page, headerAt + 3, cells.length);
  putU16(page, headerAt + 5, content);
  page[headerAt + 7] = 0;
  if (interior) putU32(page, headerAt + 8, rightChild ?? 0);
  return page;
}

/**
 * A payload's part that stays in its cell: its local bytes, and the first overflow page's number
 * when the rest goes to a chain of overflow pages, which leave now, in order.
 */
function localPart(payload: Uint8Array, kind: "table-leaf" | "index", out: PageOut): Uint8Array {
  const local = localPayloadSize(payload.byteLength, PAGE_SIZE, kind);
  if (local === payload.byteLength) return payload;
  const rest = payload.subarray(local);
  const per = PAGE_SIZE - 4;
  const count = Math.ceil(rest.byteLength / per);
  const first = out.upcoming;
  for (let i = 0, number = first; i < count; i++) {
    const page = new Uint8Array(PAGE_SIZE);
    const next = i === count - 1 ? 0 : number + 1 === LOCK_BYTE_PAGE ? number + 2 : number + 1;
    putU32(page, 0, next);
    page.set(rest.subarray(i * per, (i + 1) * per), 4);
    out.emit(page);
    number = next;
  }
  const part = new Uint8Array(local + 4);
  part.set(payload.subarray(0, local), 0);
  putU32(part, local, first);
  return part;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A root not yet placed: page 1's must fit below the file header, which can split it. */
interface PendingRoot {
  type: number;
  cells: Uint8Array[];
  rightChild: number | null;
}

// ── A rowid table's b-tree ───────────────────────────────────────────────────────────────────────

export interface TableTreeState {
  kind: "table";
  leaf: string[];
  leafMax: string | null;
  last: string | null;
  levels: { children: { page: number; key: string }[]; emitted: boolean }[];
  leaves: number;
}

/**
 * A rowid table, its rows given in rowid order. Leaves hold the rows; each interior cell names a
 * child and the largest rowid under it. A page closes with all but its last two children pending,
 * so the last page of each level has at least two children and an interior page never has none.
 */
export class TableTree {
  private leaf: Uint8Array[] = [];
  private leafUsed = LEAF_HEADER;
  private leafMax: bigint | null = null;
  private last: bigint | null = null;
  private levels: { children: { page: number; key: bigint }[]; emitted: boolean }[] = [];
  private leaves = 0;

  static from(state: TableTreeState): TableTree {
    const tree = new TableTree();
    tree.leaf = state.leaf.map(unb64);
    tree.leafUsed = LEAF_HEADER + tree.leaf.reduce((n, c) => n + cellSpace(c), 0);
    tree.leafMax = state.leafMax === null ? null : BigInt(state.leafMax);
    tree.last = state.last === null ? null : BigInt(state.last);
    tree.levels = state.levels.map((l) => ({ emitted: l.emitted, children: l.children.map((c) => ({ page: c.page, key: BigInt(c.key) })) }));
    tree.leaves = state.leaves;
    return tree;
  }

  state(): TableTreeState {
    return {
      kind: "table",
      leaf: this.leaf.map(b64),
      leafMax: this.leafMax === null ? null : String(this.leafMax),
      last: this.last === null ? null : String(this.last),
      levels: this.levels.map((l) => ({ emitted: l.emitted, children: l.children.map((c) => ({ page: c.page, key: String(c.key) })) })),
      leaves: this.leaves,
    };
  }

  /** One row: its rowid, larger than the last one's, and its record's values. */
  add(rowid: bigint | number, values: readonly SqliteValue[], out: PageOut): void {
    const id = BigInt(rowid);
    if (this.last !== null && id <= this.last) throw new SqliteFileError("A table's rows go in rowid order.");
    this.last = id;
    const record = encodeRecord(values);
    const head = concat(encodeVarint(record.byteLength), encodeVarint(id));
    const cell = concat(head, localPart(record, "table-leaf", out));
    if (this.leafUsed + cellSpace(cell) > PAGE_SIZE) this.closeLeaf(out);
    this.leaf.push(cell);
    this.leafUsed += cellSpace(cell);
    this.leafMax = id;
  }

  private closeLeaf(out: PageOut): void {
    const page = out.emit(layoutPage(PAGE_LEAF_TABLE, this.leaf, null));
    this.leaves++;
    this.leaf = [];
    this.leafUsed = LEAF_HEADER;
    this.addChild(0, { page, key: this.leafMax! }, out);
  }

  private interiorCells(children: readonly { page: number; key: bigint }[]): Uint8Array[] {
    return children.slice(0, -1).map((c) => {
      const cell = new Uint8Array(4 + varintLength(c.key));
      putU32(cell, 0, c.page);
      cell.set(encodeVarint(c.key), 4);
      return cell;
    });
  }

  private fits(children: readonly { page: number; key: bigint }[], room = PAGE_SIZE): boolean {
    let used = INTERIOR_HEADER;
    for (let i = 0; i < children.length - 1; i++) used += Math.max(4, 4 + varintLength(children[i]!.key)) + 2;
    return used <= room;
  }

  private addChild(level: number, child: { page: number; key: bigint }, out: PageOut): void {
    const l = (this.levels[level] ??= { children: [], emitted: false });
    l.children.push(child);
    if (this.fits(l.children)) return;
    const take = l.children.length - 2;
    const pageChildren = l.children.slice(0, take);
    l.children = l.children.slice(take);
    l.emitted = true;
    const page = out.emit(layoutPage(PAGE_INTERIOR_TABLE, this.interiorCells(pageChildren), pageChildren[take - 1]!.page));
    this.addChild(level + 1, { page, key: pageChildren[take - 1]!.key }, out);
  }

  /** The tree's root, made last. For page 1 (`rootInPage1`) it is laid out by the caller. */
  finish(out: PageOut): number;
  finish(out: PageOut, rootInPage1: true): PendingRoot;
  finish(out: PageOut, rootInPage1 = false): number | PendingRoot {
    if (this.leaves === 0) {
      // One leaf holds every row (or none): it is the root.
      const root: PendingRoot = { type: PAGE_LEAF_TABLE, cells: this.leaf, rightChild: null };
      if (rootInPage1) return this.fitPage1(root, out);
      return out.emit(layoutPage(root.type, root.cells, null));
    }
    if (this.leaf.length > 0) this.closeLeaf(out);
    for (let level = 0; ; level++) {
      const l = this.levels[level]!;
      const top = level === this.levels.length - 1;
      if (top && !l.emitted && l.children.length === 1) throw new SqliteFileError("A table's b-tree ended with one child.");
      if (top && !l.emitted) {
        const root: PendingRoot = { type: PAGE_INTERIOR_TABLE, cells: this.interiorCells(l.children), rightChild: l.children[l.children.length - 1]!.page };
        if (rootInPage1) return this.fitPage1(root, out, l.children);
        return out.emit(layoutPage(root.type, root.cells, root.rightChild));
      }
      const page = out.emit(layoutPage(PAGE_INTERIOR_TABLE, this.interiorCells(l.children), l.children[l.children.length - 1]!.page));
      const key = l.children[l.children.length - 1]!.key;
      l.children = [];
      this.addChild(level + 1, { page, key }, out);
    }
  }

  /** Page 1's root: as it is when it fits below the file header, else split in two under a new root. */
  private fitPage1(root: PendingRoot, out: PageOut, children?: { page: number; key: bigint }[]): PendingRoot {
    const room = PAGE_SIZE - FILE_HEADER;
    if (root.type === PAGE_LEAF_TABLE) {
      const used = LEAF_HEADER + root.cells.reduce((n, c) => n + cellSpace(c), 0);
      if (used <= room) return root;
      // One row too big for page 1 goes on a leaf of its own, and page 1 only points at it: an
      // empty leaf beside it would be corrupt. Only page 1 may be an interior page with no cells.
      if (root.cells.length === 1) return { type: PAGE_INTERIOR_TABLE, cells: [], rightChild: out.emit(layoutPage(PAGE_LEAF_TABLE, root.cells, null)) };
      const half = Math.ceil(root.cells.length / 2);
      const left = out.emit(layoutPage(PAGE_LEAF_TABLE, root.cells.slice(0, half), null));
      const right = out.emit(layoutPage(PAGE_LEAF_TABLE, root.cells.slice(half), null));
      return { type: PAGE_INTERIOR_TABLE, cells: this.interiorCells([{ page: left, key: this.keyOfLeafCell(root.cells[half - 1]!) }, { page: right, key: 0n }]), rightChild: right };
    }
    if (this.fits(children!, room)) return root;
    const half = Math.ceil(children!.length / 2);
    const leftChildren = children!.slice(0, half);
    const rightChildren = children!.slice(half);
    const left = out.emit(layoutPage(PAGE_INTERIOR_TABLE, this.interiorCells(leftChildren), leftChildren[leftChildren.length - 1]!.page));
    const right = out.emit(layoutPage(PAGE_INTERIOR_TABLE, this.interiorCells(rightChildren), rightChildren[rightChildren.length - 1]!.page));
    return { type: PAGE_INTERIOR_TABLE, cells: this.interiorCells([{ page: left, key: leftChildren[leftChildren.length - 1]!.key }, { page: right, key: 0n }]), rightChild: right };
  }

  /** A leaf cell's rowid: after the payload's length. */
  private keyOfLeafCell(cell: Uint8Array): bigint {
    let at = 0;
    while (cell[at]! & 0x80 && at < 8) at++;
    at++;
    let v = 0n;
    for (let i = 0; i < 9; i++) {
      const b = cell[at + i]!;
      if (i === 8) return BigInt.asIntN(64, (v << 8n) | BigInt(b));
      v = (v << 7n) | BigInt(b & 0x7f);
      if ((b & 0x80) === 0) return BigInt.asIntN(64, v);
    }
    return v;
  }
}

// ── An index's b-tree (and a WITHOUT ROWID table's) ──────────────────────────────────────────────

export interface IndexTreeState {
  kind: "index";
  leaf: string[];
  levels: { pairs: { page: number; sep: string | null }[]; emitted: boolean }[];
  leaves: number;
}

/**
 * An index, its entries given in the index's own order. Unlike a table's, an index's b-tree keeps
 * each entry once: the entry between two children sits in their parent. When a leaf is full, its
 * last entry goes up as the divider and the next leaf starts with the entry that did not fit, so
 * no leaf is ever left empty. Interior pages keep two children pending, as a table's do.
 */
export class IndexTree {
  private leaf: Uint8Array[] = [];
  private leafUsed = LEAF_HEADER;
  private levels: { pairs: { page: number; sep: Uint8Array | null }[]; emitted: boolean }[] = [];
  private leaves = 0;

  static from(state: IndexTreeState): IndexTree {
    const tree = new IndexTree();
    tree.leaf = state.leaf.map(unb64);
    tree.leafUsed = LEAF_HEADER + tree.leaf.reduce((n, c) => n + cellSpace(c), 0);
    tree.levels = state.levels.map((l) => ({ emitted: l.emitted, pairs: l.pairs.map((p) => ({ page: p.page, sep: p.sep === null ? null : unb64(p.sep) })) }));
    tree.leaves = state.leaves;
    return tree;
  }

  state(): IndexTreeState {
    return {
      kind: "index",
      leaf: this.leaf.map(b64),
      levels: this.levels.map((l) => ({ emitted: l.emitted, pairs: l.pairs.map((p) => ({ page: p.page, sep: p.sep === null ? null : b64(p.sep) })) })),
      leaves: this.leaves,
    };
  }

  /** One entry: the index's columns, then the rowid (or a WITHOUT ROWID table's key and columns). */
  add(values: readonly SqliteValue[], out: PageOut): void {
    const record = encodeRecord(values);
    const part = concat(encodeVarint(record.byteLength), localPart(record, "index", out));
    if (this.leafUsed + cellSpace(part) > PAGE_SIZE) {
      if (this.leaf.length < 2) throw new SqliteFileError("An index's entries do not fit two to a page.");
      const sep = this.leaf.pop()!;
      const page = out.emit(layoutPage(PAGE_LEAF_INDEX, this.leaf, null));
      this.leaves++;
      this.leaf = [];
      this.leafUsed = LEAF_HEADER;
      this.addPair(0, { page, sep }, out);
    }
    this.leaf.push(part);
    this.leafUsed += cellSpace(part);
  }

  private interiorCells(pairs: readonly { page: number; sep: Uint8Array | null }[]): Uint8Array[] {
    return pairs.slice(0, -1).map((p) => {
      const cell = new Uint8Array(4 + p.sep!.byteLength);
      putU32(cell, 0, p.page);
      cell.set(p.sep!, 4);
      return cell;
    });
  }

  private fits(pairs: readonly { page: number; sep: Uint8Array | null }[], room = PAGE_SIZE): boolean {
    let used = INTERIOR_HEADER;
    for (let i = 0; i < pairs.length - 1; i++) used += Math.max(4, 4 + pairs[i]!.sep!.byteLength) + 2;
    return used <= room;
  }

  private addPair(level: number, pair: { page: number; sep: Uint8Array | null }, out: PageOut): void {
    const l = (this.levels[level] ??= { pairs: [], emitted: false });
    l.pairs.push(pair);
    if (this.fits(l.pairs)) return;
    const take = l.pairs.length - 2;
    const pagePairs = l.pairs.slice(0, take);
    l.pairs = l.pairs.slice(take);
    l.emitted = true;
    const page = out.emit(layoutPage(PAGE_INTERIOR_INDEX, this.interiorCells(pagePairs), pagePairs[take - 1]!.page));
    this.addPair(level + 1, { page, sep: pagePairs[take - 1]!.sep }, out);
  }

  finish(out: PageOut): number {
    if (this.leaves === 0) return out.emit(layoutPage(PAGE_LEAF_INDEX, this.leaf, null));
    const last = out.emit(layoutPage(PAGE_LEAF_INDEX, this.leaf, null));
    this.leaf = [];
    this.addPair(0, { page: last, sep: null }, out);
    for (let level = 0; ; level++) {
      const l = this.levels[level]!;
      const top = level === this.levels.length - 1;
      if (top && !l.emitted && l.pairs.length === 1) return l.pairs[0]!.page;
      const page = out.emit(layoutPage(PAGE_INTERIOR_INDEX, this.interiorCells(l.pairs), l.pairs[l.pairs.length - 1]!.page));
      const sep = l.pairs[l.pairs.length - 1]!.sep;
      l.pairs = [];
      if (top && !l.emitted) return page;
      this.addPair(level + 1, { page, sep }, out);
    }
  }
}

// ── The file: sqlite_schema on page 1, and the header ────────────────────────────────────────────

/** One row of sqlite_schema: a table, an index, a view or a trigger, and its root page (0 for none). */
export interface SchemaEntry {
  type: "table" | "index" | "view" | "trigger";
  name: string;
  tableName: string;
  rootPage: number;
  sql: string | null;
}

/**
 * Page 1: the file's header and the root of sqlite_schema. sqlite_schema's other pages, if it needs
 * any, leave through `out` first; `pages` is then the file's page count.
 */
export function finishFile(entries: readonly SchemaEntry[], out: PageOut): { page1: Uint8Array; pages: number } {
  const schema = new TableTree();
  entries.forEach((e, i) => schema.add(i + 1, [e.type, e.name, e.tableName, e.rootPage, e.sql], out));
  const root = schema.finish(out, true);
  const page1 = layoutPage(root.type, root.cells, root.rightChild, FILE_HEADER);
  const pages = out.next - 1;
  page1.set(MAGIC, 0);
  putU16(page1, 16, PAGE_SIZE);
  page1[18] = 1; // legacy (rollback journal) file format, for writing and for reading
  page1[19] = 1;
  page1[20] = 0; // no bytes reserved at the end of a page
  page1[21] = 64;
  page1[22] = 32;
  page1[23] = 32;
  putU32(page1, 24, 1); // file change counter
  putU32(page1, 28, pages); // the database's size in pages
  putU32(page1, 32, 0); // no free pages
  putU32(page1, 36, 0);
  putU32(page1, 40, 1); // schema cookie
  putU32(page1, 44, 4); // schema format 4
  putU32(page1, 48, 0);
  putU32(page1, 52, 0); // no auto-vacuum
  putU32(page1, 56, 1); // UTF-8
  putU32(page1, 60, 0);
  putU32(page1, 64, 0);
  putU32(page1, 68, 0);
  putU32(page1, 92, 1); // the size above is valid for this change counter
  putU32(page1, 96, WRITER_VERSION);
  return { page1, pages };
}
