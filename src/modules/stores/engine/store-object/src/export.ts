// A store's export: its database as one SQLite file, which the store writes itself
// (sqlite-file/writer.ts), and the list of its files. The gateway hands both out as one archive
// (archive.ts), which an app's own copy of this package loads on its owner's account; or another
// store loads the file as a copy of this one (import.ts).
//
// An export is one of the store's own jobs, in chunks between alarms. While it runs it holds the
// store's writes (history.ts `HOLD_KEY`), so the file is one moment of the store: every table and
// every index from the same rows. Reads go on, and so does what no file depends on (sessions, an
// upload's parts). The file lands in the bucket in pieces, under
// `stores/<storeId>/exports/<exportId>/`: page 1 last, as piece 0, once every root page is known,
// then `manifest.json`, which says how the pieces make the file and which files go with it. The
// plan (which trees, in what order) stays in a work table, so the job's state stays small.
//
// What the file holds: every table, index, view and trigger, with these exceptions. The platform's
// own tables and SQLite's statistics are left out. `_sessions` is empty: a session belongs to the
// address it was made on. `_meta` holds only what describes the tables and the files: SHAPE's saved
// queries, CHECK's rules, what an Answers table answers, and the code page a person set for the
// text of files of a name, which LOAD reads them in; its other rows (the store's id, a restore or
// an export under way, its count of writes) are this store's own.
// `_files` lists only files that arrived and were not deleted, each with its place in the archive
// (`files/<fileId>/<name>`) as its key and the folder it is in; `_folders` lists the live folders. The store's records of what changed (`_deltas`, its keys, its
// readers, its row hashes, `_parked`) are empty: their numbers mean nothing to another store. A
// table parked in the bucket (park.ts) is not in the database, so its rows are not in the file: the
// manifest names it (`parkedLeftOut`), and the town's file it was read from is in the archive, so a
// LOAD makes it again.
//
// A copy (for a preview) differs: it is the whole store when that is under 100 MB, and otherwise
// each table's newest 5,000 rows plus the rows their foreign keys point to; it brings no history
// and no jobs; the values of columns whose declared type says `personal` are replaced, in the
// columns whose foreign keys tie them to those too; it writes no index b-trees, since the store
// that loads it builds its own indexes; and it lists the files the copied rows name (all of them
// for a whole copy, the newest up to 1 GiB for a sample). A virtual table cannot be copied, and the
// copy says so before it starts. Only this package's import reads a copy's file, so a WITHOUT
// ROWID table whose key is personal is written in its old key order with its new values.

import { StoreError } from "./core.js";
import { EXPORTS_SWEEP_KEY, holdStore, releaseHold } from "./history.js";
import { JobParamsError, type JobContext, type JobHandler } from "./jobs/types.js";
import { PAGE_SIZE, type SqliteValue } from "./sqlite-file/format.js";
import { archiveFileName } from "./sqlite-file/tar.js";
import { finishFile, IndexTree, PageOut, TableTree, type IndexTreeState, type SchemaEntry, type TableTreeState } from "./sqlite-file/writer.js";
import { ident, passedOver, SYSTEM_TABLES, type SqlLike, type StoreSqlValue } from "./sql.js";
import type { StoreFiles } from "./store-files.js";

export const EXPORT_KIND = "export";
/** A copy is of the whole store when its database and files are under this many bytes. */
export const COPY_WHOLE_UNDER_BYTES = 100 * 1024 * 1024;
/** Otherwise a copy takes each table's newest this many rows, and the rows they point to. */
export const COPY_SAMPLE_ROWS = 5_000;
/** The most bytes of files a sample brings: the newest its rows name, up to this. */
export const COPY_SAMPLE_FILE_BYTES = 1024 ** 3;
/** An export to download stays this long; a copy's, only until the copy has surely loaded it. */
export const EXPORT_KEEP_MS = 7 * 24 * 60 * 60_000;
export const COPY_KEEP_MS = 24 * 60 * 60_000;
export const EXPORT_ID_RE = /^exp_[0-9a-f]{24}$/;

/** A piece of the file goes to the bucket at this size; the last of a chunk may be smaller. */
const PIECE_BYTES = 8 * 1024 * 1024;
/** How many rows one read asks for at first, and at most (`nextLimit`). */
const FIRST_BATCH_ROWS = 32;
const MAX_BATCH_ROWS = 50_000;
const BATCH_BYTES = 4 * 1024 * 1024;
/** workerd's most result columns: a wider table's rows are read in two halves, joined by rowid. */
const RESULT_COLUMNS_MAX = 100;
/** A chunk stops starting new batches this long before its deadline. */
const DEADLINE_MARGIN_MS = 2_000;

const SYSTEM = new Set<string>(SYSTEM_TABLES);
/** A table of the store's data, not one of its own or SQLite's: what an export's counts count. */
const isDataTable = (name: string): boolean => !SYSTEM.has(name) && !name.toLowerCase().startsWith("sqlite_");
/** The tables an export makes for itself while it runs, and drops. */
const ROWS_TABLE = "_export_rows";
const FILES_TABLE = "_export_files";
const PLAN_TABLE = "_export_plan";

export type ExportPurpose = "download" | "copy";

export interface ExportParams {
  exportId: string;
  purpose: ExportPurpose;
  /** A copy's rule: the whole store under 100 MB (`auto`), or always one or the other. A download is whole. */
  mode: "auto" | "whole" | "sample";
  /** Whether a copy replaces the values of personal columns. A download keeps them. */
  personal: "keep" | "replace";
}

export interface ExportFile {
  id: string;
  name: string;
  size: number;
  contentType: string;
  /** Where its bytes are in the bucket now. */
  key: string;
}

export interface ExportManifest {
  v: 1;
  exportId: string;
  storeId: string;
  purpose: ExportPurpose;
  mode: "whole" | "sample";
  createdAt: string;
  expiresAt: string;
  db: { pageSize: number; pages: number; bytes: number; pieces: { key: string; size: number }[] };
  files: ExportFile[];
  fileBytes: number;
  tables: number;
  rows: number;
  replaced: number;
  /** How many files a sample's rows name that it left out to stay within its bytes. */
  filesLeftOut: number;
  /** The parked tables whose rows the file does not hold (park.ts). */
  parkedLeftOut: string[];
  migrations: string[];
}

export interface ExportResult {
  exportId: string;
  purpose: ExportPurpose;
  mode: "whole" | "sample";
  bytes: number;
  pages: number;
  tables: number;
  rows: number;
  files: number;
  fileBytes: number;
  replaced: number;
  filesLeftOut: number;
  parkedLeftOut: string[];
}

export function exportPrefix(storeId: string, exportId: string): string {
  return `stores/${storeId}/exports/${exportId}/`;
}

export function manifestKey(storeId: string, exportId: string): string {
  return `${exportPrefix(storeId, exportId)}manifest.json`;
}

const literal = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** One b-tree to write: which rows make it, in what order, and what happens to their values. */
interface TreeSpec {
  name: string;
  table: string;
  format: "table" | "index";
  /** The values of a record, as SQL over the table. */
  columns: string[];
  /** A rowid table's rowid, as SQL; the record of an INTEGER PRIMARY KEY's column holds null. */
  rowid: string | null;
  nullAt: number | null;
  /** An index's (or a WITHOUT ROWID table's) order, as ORDER BY terms. */
  order: string[];
  where: string | null;
  personal: number[];
  scanFiles: boolean;
  /** `_files`: the record places of id, name and r2_key, whose key becomes the archive's path. */
  fileKey: { id: number; name: number; key: number } | null;
}

/** What a run writes, decided once: kept in a work table, since it can be larger than a job's state should be. */
interface ExportPlan {
  entries: SchemaEntry[];
  trees: TreeSpec[];
}

interface ExportState {
  /** A sample walks its foreign keys first; every export then writes its trees. */
  phase: "sample" | "trees";
  mode: "whole" | "sample";
  /** The round of that walk: the rows it added last are the ones its next round starts from. */
  round: number;
  /** The key that makes a copy's replacements: random for each copy, and gone with the job's state. */
  key: string | null;
  /** Which tree is being written, and how far. */
  at: number;
  after: string | null;
  offset: number;
  tree: TableTreeState | IndexTreeState | null;
  next: number;
  pieces: { key: string; size: number }[];
  /** Each finished tree's root page, by its name in the file. */
  roots: [string, number][];
  rows: number;
  replaced: number;
  tables: number;
  filesLeftOut: number;
}

// ── What the file holds ──────────────────────────────────────────────────────────────────────────

interface XInfo {
  cid: number;
  name: string;
  type: string;
  pk: number;
  hidden: number;
}

function tableXInfo(sql: SqlLike, table: string): XInfo[] {
  return sql
    .exec<Record<string, StoreSqlValue>>(`PRAGMA table_xinfo(${ident(table)})`)
    .toArray()
    .map((c) => ({ cid: Number(c.cid), name: String(c.name), type: String(c.type ?? ""), pk: Number(c.pk), hidden: Number(c.hidden ?? 0) }));
}

function indexList(sql: SqlLike, table: string): { name: string; origin: string; partial: boolean }[] {
  return sql
    .exec<Record<string, StoreSqlValue>>(`PRAGMA index_list(${ident(table)})`)
    .toArray()
    .map((r) => ({ name: String(r.name), origin: String(r.origin), partial: Number(r.partial) === 1 }));
}

interface IndexColumn {
  cid: number;
  name: string | null;
  desc: boolean;
  coll: string;
  key: boolean;
}

function indexXInfo(sql: SqlLike, index: string): IndexColumn[] {
  return sql
    .exec<Record<string, StoreSqlValue>>(`PRAGMA index_xinfo(${ident(index)})`)
    .toArray()
    .map((r) => ({ cid: Number(r.cid), name: r.name === null ? null : String(r.name), desc: Number(r.desc) === 1, coll: String(r.coll ?? "BINARY"), key: Number(r.key) === 1 }));
}

/** The column that holds a rowid table's rowid (an INTEGER PRIMARY KEY), if one does. */
function integerPrimaryKey(sql: SqlLike, table: string, columns: readonly XInfo[]): string | null {
  const pks = columns.filter((c) => c.pk > 0);
  return pks.length === 1 && pks[0]!.type.toUpperCase() === "INTEGER" && !indexList(sql, table).some((i) => i.origin === "pk") ? pks[0]!.name : null;
}

/** A table's foreign keys: the columns of each, and the columns of the table it points at. */
export function foreignKeys(sql: SqlLike, table: string): { parent: string; from: string[]; to: string[] }[] {
  const keys = new Map<number, { parent: string; from: string[]; to: (string | null)[] }>();
  for (const k of sql.exec<Record<string, StoreSqlValue>>(`PRAGMA foreign_key_list(${ident(table)})`).toArray()) {
    const entry = keys.get(Number(k.id)) ?? { parent: String(k.table), from: [], to: [] };
    entry.from.push(String(k.from));
    entry.to.push(k.to === null ? null : String(k.to));
    keys.set(Number(k.id), entry);
  }
  const out: { parent: string; from: string[]; to: string[] }[] = [];
  for (const k of keys.values()) {
    // A key that names no parent columns points at the parent's primary key.
    const to = k.to.every((t) => t !== null) ? (k.to as string[]) : tableXInfo(sql, k.parent).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    if (to.length === k.from.length) out.push({ parent: k.parent, from: k.from, to });
  }
  return out;
}

const PLAN_PART_CHARS = 500_000;

/** Writes a job's plan into its own work table, in parts under a value's size limit. */
export function savePlan(sql: SqlLike, table: string, plan: unknown): void {
  sql.exec(`DROP TABLE IF EXISTS ${table}`);
  sql.exec(`CREATE TABLE ${table} (n INTEGER PRIMARY KEY, part TEXT NOT NULL)`);
  const text = JSON.stringify(plan);
  for (let i = 0, n = 0; i < text.length; i += PLAN_PART_CHARS, n++) sql.exec(`INSERT INTO ${table} (n, part) VALUES (?, ?)`, n, text.slice(i, i + PLAN_PART_CHARS));
}

export function loadPlan<T>(sql: SqlLike, table: string): T {
  return JSON.parse(sql.exec<{ part: string }>(`SELECT part FROM ${table} ORDER BY n`).toArray().map((r) => String(r.part)).join("")) as T;
}

/** The name a table's rowid answers to: `rowid`, unless a column took it. */
function rowidName(columns: readonly XInfo[], table: string): string {
  const taken = new Set(columns.map((c) => c.name.toLowerCase()));
  const name = ["rowid", "_rowid_", "oid"].find((n) => !taken.has(n));
  if (!name) throw new StoreError(400, "export_refused", `Table ${table} names columns rowid, _rowid_ and oid, so an export cannot read its rows' order.`);
  return name;
}

const withoutRowid = (sql: string | null): boolean => sql !== null && /\)\s*(?:STRICT\s*,\s*)?WITHOUT\s+ROWID\b/i.test(sql);

// ── A CREATE INDEX statement's parts: its columns' expressions and its WHERE ────────────────────

/** What a bare word in SQL is made of: anything past ASCII counts as a letter. */
const WORD_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;

/** The statement's top-level tokens, with each token's start and end, outside strings and comments. */
function tokens(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      const j = text.indexOf("\n", i);
      i = j < 0 ? text.length : j + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      i = j < 0 ? text.length : j + 2;
      continue;
    }
    const start = i;
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < text.length) {
        if (text[i] === c) {
          if (text[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "[") {
      const j = text.indexOf("]", i);
      i = j < 0 ? text.length : j + 1;
    } else if (WORD_CHAR.test(c)) {
      while (i < text.length && WORD_CHAR.test(text[i]!)) i++;
    } else {
      i++;
    }
    out.push({ text: text.slice(start, i), start, end: i });
  }
  return out;
}

/** The expression of each indexed column, and the WHERE of a partial index, from its CREATE INDEX. */
export function indexParts(createSql: string): { columns: string[]; where: string | null } {
  const toks = tokens(createSql);
  const on = toks.findIndex((t) => t.text.toUpperCase() === "ON");
  const open = toks.findIndex((t, i) => i > on && t.text === "(");
  if (on < 0 || open < 0) throw new StoreError(400, "export_refused", "An index's statement could not be read.");
  let depth = 0;
  let itemStart = toks[open]!.end;
  const columns: string[] = [];
  let close = -1;
  for (let i = open; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.text === "(") depth++;
    else if (t.text === ")") {
      depth--;
      if (depth === 0) {
        columns.push(createSql.slice(itemStart, t.start));
        close = i;
        break;
      }
    } else if (t.text === "," && depth === 1) {
      columns.push(createSql.slice(itemStart, t.start));
      itemStart = t.end;
    }
  }
  if (close < 0) throw new StoreError(400, "export_refused", "An index's statement could not be read.");
  const bare = columns.map((item) => {
    const its = tokens(item);
    let end = its.length;
    if (end > 0 && /^(ASC|DESC)$/i.test(its[end - 1]!.text)) end--;
    if (end > 1 && its[end - 2]!.text.toUpperCase() === "COLLATE") end -= 2;
    return item.slice(0, end > 0 ? its[end - 1]!.end : 0).trim();
  });
  const whereAt = toks.findIndex((t, i) => i > close && t.text.toUpperCase() === "WHERE");
  const where = whereAt < 0 ? null : createSql.slice(toks[whereAt]!.end).trim().replace(/;\s*$/, "") || null;
  return { columns: bare, where };
}

/** An index-format b-tree's values and order, from its columns' info. */
function indexShape(sql: SqlLike, index: string, createSql: string | null, rowid: string | null): { columns: string[]; order: string[]; where: string | null } {
  const info = indexXInfo(sql, index);
  const needsParts = createSql !== null && info.some((c) => c.cid === -2);
  const parts = createSql !== null ? indexParts(createSql) : { columns: [], where: null };
  let keyAt = 0;
  const columns = info.map((c) => {
    if (c.cid >= 0) {
      if (c.key) keyAt++;
      return ident(c.name!);
    }
    if (c.cid === -1) {
      if (!rowid) throw new StoreError(400, "export_refused", `Index ${index} names a rowid its table does not have.`);
      return rowid;
    }
    if (!needsParts) throw new StoreError(400, "export_refused", `Index ${index} is on an expression, and its statement is missing.`);
    const expr = parts.columns[keyAt++];
    if (!expr) throw new StoreError(400, "export_refused", `Index ${index}'s expressions could not be read.`);
    return `(${expr})`;
  });
  const order = info.map((c, i) => `${columns[i]} COLLATE ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.coll) ? c.coll : "BINARY"} ${c.desc ? "DESC" : "ASC"}`);
  return { columns, order, where: parts.where };
}

/** Which rows of a table the file holds: the rule for each system table, a copy's sample, or every row. */
function rowsOf(table: string, purpose: ExportPurpose, mode: "whole" | "sample", rowid: string | null, sampled: ReadonlySet<string>): string | null {
  switch (table) {
    case "_meta":
      // What describes the tables: SHAPE's saved queries, CHECK's rules, what an Answers table
      // answers; and the code page set for files of a name (jobs/load.ts `codePageKey`), since
      // the files go too. The other rows are this store's own.
      return "(key LIKE 'shape:%' OR key LIKE 'check:%' OR key LIKE 'answers:%' OR key LIKE 'code^_page:%' ESCAPE '^')";
    case "_fixes":
      // A person's fixes name the values they replaced, which a copy with personal values replaced must not hold.
      return purpose === "copy" ? "0" : null;
    case "_sessions":
    case "_deltas":
    case "_delta_rows":
    case "_delta_reads":
    case "_row_hashes":
    case "_pushed":
    case "_push_writes":
    case "_parked":
      return "0";
    case "_files":
      return purpose === "copy" && mode === "sample" ? `state = 'ready' AND deleted_at IS NULL AND id IN (SELECT id FROM ${FILES_TABLE})` : "state = 'ready' AND deleted_at IS NULL";
    case "_folders":
      // The folders the files listed are in, and every other live folder: a folder may be empty.
      return "deleted_at IS NULL";
    case "_jobs":
      return purpose === "copy" ? "0" : "state IN ('done', 'failed')";
    case "_history":
      return purpose === "copy" ? "0" : null;
  }
  if (purpose === "copy" && mode === "sample" && sampled.has(table) && rowid) return `${rowid} IN (SELECT rid FROM ${ROWS_TABLE} WHERE tbl = ${literal(table)})`;
  return null;
}

/** The sqlite_schema rows the file holds, and the b-trees to write for them. */
function planExport(sql: SqlLike, purpose: ExportPurpose, mode: "whole" | "sample", personal: boolean, sampled: ReadonlySet<string>): ExportPlan {
  const master = sql
    .exec<Record<string, StoreSqlValue>>("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master ORDER BY rowid")
    .toArray()
    .map((r) => ({ type: String(r.type) as SchemaEntry["type"], name: String(r.name), table: String(r.tbl_name), root: Number(r.rootpage ?? 0), sql: r.sql === null ? null : String(r.sql) }));
  const kept = master.filter((m) => !passedOver(m.name) && !passedOver(m.table));
  // A copy loads through the store's import, which cannot make one; better said now than after the whole copy ran.
  const virtual = purpose === "copy" ? kept.find((m) => m.type === "table" && m.root <= 0) : undefined;
  if (virtual) throw new StoreError(400, "export_refused", `A copy cannot bring ${virtual.name}: it is a virtual table (such as a full-text index), which an import does not load.`);
  const tableSql = new Map(kept.filter((m) => m.type === "table").map((m) => [m.name, m.sql]));
  const marks = purpose === "copy" && personal ? personalColumns(sql, kept.filter((m) => m.type === "table" && m.root > 0 && !SYSTEM.has(m.name) && !m.name.toLowerCase().startsWith("sqlite_")).map((m) => m.name)) : new Map<string, Set<string>>();
  const isMarked = (table: string, column: string): boolean => marks.get(table.toLowerCase())?.has(column.toLowerCase()) ?? false;
  const rowids = new Map<string, string | null>();
  const entries: SchemaEntry[] = [];
  const dataTrees: TreeSpec[] = [];
  const systemTrees: TreeSpec[] = [];
  const indexTrees: TreeSpec[] = [];
  for (const m of kept) {
    entries.push({ type: m.type, name: m.name, tableName: m.table, rootPage: 0, sql: m.sql });
    if (m.root <= 0) continue;
    if (m.type === "table") {
      const columns = tableXInfo(sql, m.name);
      if (withoutRowid(m.sql)) {
        const pk = indexList(sql, m.name).find((i) => i.origin === "pk");
        if (!pk) throw new StoreError(400, "export_refused", `Table ${m.name} is WITHOUT ROWID with no primary key index.`);
        const shape = indexShape(sql, pk.name, null, null);
        rowids.set(m.name, null);
        const spec: TreeSpec = {
          name: m.name,
          table: m.name,
          format: "index",
          columns: shape.columns,
          rowid: null,
          nullAt: null,
          order: shape.order,
          where: rowsOf(m.name, purpose, mode, null, sampled),
          personal: indexXInfo(sql, pk.name).flatMap((c, i) => (c.name !== null && isMarked(m.name, c.name) ? [i] : [])),
          scanFiles: purpose === "copy" && mode === "sample" && !SYSTEM.has(m.name),
          fileKey: null,
        };
        (SYSTEM.has(m.name) ? systemTrees : dataTrees).push(spec);
        continue;
      }
      const rowid = rowidName(columns, m.name);
      rowids.set(m.name, rowid);
      const stored = columns.filter((c) => c.hidden === 0 || c.hidden === 3);
      const ipk = integerPrimaryKey(sql, m.name, columns);
      const at = (name: string) => stored.findIndex((c) => c.name === name);
      const system = SYSTEM.has(m.name);
      const spec: TreeSpec = {
        name: m.name,
        table: m.name,
        format: "table",
        columns: stored.map((c) => ident(c.name)),
        rowid,
        nullAt: ipk === null ? null : at(ipk),
        order: [],
        where: rowsOf(m.name, purpose, mode, rowid, sampled),
        personal: stored.flatMap((c, i) => (isMarked(m.name, c.name) ? [i] : [])),
        scanFiles: purpose === "copy" && mode === "sample" && !system && !m.name.toLowerCase().startsWith("sqlite_"),
        fileKey: m.name === "_files" ? { id: at("id"), name: at("name"), key: at("r2_key") } : null,
      };
      (system ? systemTrees : dataTrees).push(spec);
      continue;
    }
    if (m.type === "index" && purpose === "download") {
      const rowid = rowids.get(m.table) ?? (withoutRowid(tableSql.get(m.table) ?? null) ? null : rowidName(tableXInfo(sql, m.table), m.table));
      const shape = indexShape(sql, m.name, m.sql, rowid);
      const tableRows = rowsOf(m.table, purpose, mode, rowid, sampled);
      const where = [tableRows, shape.where].filter((w): w is string => w !== null).map((w) => `(${w})`).join(" AND ") || null;
      indexTrees.push({ name: m.name, table: m.table, format: "index", columns: shape.columns, rowid: null, nullAt: null, order: shape.order, where, personal: [], scanFiles: false, fileKey: null });
    }
  }
  return { entries, trees: [...dataTrees, ...systemTrees, ...indexTrees] };
}

// ── A copy's sample: each table's newest rows, and the rows they point to ───────────────────────

function sampleTables(sql: SqlLike): Set<string> {
  const out = new Set<string>();
  for (const r of sql.exec<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND rootpage > 0").toArray()) {
    const name = String(r.name);
    if (passedOver(name) || SYSTEM.has(name) || name.toLowerCase().startsWith("sqlite_")) continue;
    if (withoutRowid(r.sql === null ? null : String(r.sql))) continue;
    out.add(name);
  }
  return out;
}

/** Starts `_export_rows`: each sampled table's newest rows, as round 0 of the walk along foreign keys. */
function seedSample(sql: SqlLike, sampled: ReadonlySet<string>): void {
  sql.exec(`DROP TABLE IF EXISTS ${ROWS_TABLE}`);
  sql.exec(`CREATE TABLE ${ROWS_TABLE} (tbl TEXT NOT NULL, rid INTEGER NOT NULL, round INTEGER NOT NULL, PRIMARY KEY (tbl, rid)) WITHOUT ROWID`);
  sql.exec(`CREATE INDEX ${ROWS_TABLE}_round ON ${ROWS_TABLE} (round, tbl)`);
  for (const table of sampled) {
    const r = rowidName(tableXInfo(sql, table), table);
    sql.exec(`INSERT OR IGNORE INTO ${ROWS_TABLE} (tbl, rid, round) SELECT ${literal(table)}, ${r}, 0 FROM ${ident(table)} ORDER BY ${r} DESC LIMIT ${COPY_SAMPLE_ROWS}`);
  }
}

interface SampleLink {
  child: string;
  /** The child's rowid, as SQL; null for a table that comes whole. */
  childRowid: string | null;
  parent: string;
  parentRowid: string;
  from: string[];
  to: string[];
}

/** Every foreign key that points at a sampled table. */
function sampleLinks(sql: SqlLike, sampled: ReadonlySet<string>): SampleLink[] {
  const named = new Map([...sampled].map((t) => [t.toLowerCase(), t]));
  const rowids = new Map([...sampled].map((t) => [t, rowidName(tableXInfo(sql, t), t)]));
  const children = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND rootpage > 0").toArray().map((r) => String(r.name)).filter((n) => !passedOver(n) && !SYSTEM.has(n));
  return children.flatMap((child) =>
    foreignKeys(sql, child).flatMap((k) => {
      // A key names its parent as its statement wrote it, in any case.
      const parent = named.get(k.parent.toLowerCase());
      return parent ? [{ child, childRowid: rowids.get(child) ?? null, parent, parentRowid: rowids.get(parent)!, from: k.from, to: k.to }] : [];
    }),
  );
}

/** One round of the walk: the parents of the rows the last round added, as this round's rows. Answers whether it found any. */
function growSample(sql: SqlLike, links: readonly SampleLink[], round: number): boolean {
  for (const link of links) {
    // A table that comes whole never gains rows, so its parents are found once, in the first round.
    if (link.childRowid === null && round > 0) continue;
    const on = link.to.map((t, i) => `p.${ident(t)} = c.${ident(link.from[i]!)}`).join(" AND ");
    const childRows = link.childRowid === null ? "" : `WHERE c.${link.childRowid} IN (SELECT rid FROM ${ROWS_TABLE} WHERE round = ${round} AND tbl = ${literal(link.child)})`;
    sql.exec(`INSERT OR IGNORE INTO ${ROWS_TABLE} (tbl, rid, round) SELECT ${literal(link.parent)}, p.${link.parentRowid}, ${round + 1} FROM ${ident(link.parent)} AS p JOIN ${ident(link.child)} AS c ON ${on} ${childRows}`).toArray();
  }
  return sql.exec(`SELECT 1 FROM ${ROWS_TABLE} WHERE round = ${round + 1} LIMIT 1`).toArray().length > 0;
}

/**
 * The columns a copy replaces, by lowercased table name: those whose declared type says `personal`,
 * and across foreign keys the columns that must still match them. A rowid cannot be replaced, so a
 * key that points at one is not.
 */
function personalColumns(sql: SqlLike, tables: readonly string[]): Map<string, Set<string>> {
  const marks = new Map<string, Set<string>>();
  const has = (table: string, column: string) => marks.get(table.toLowerCase())?.has(column.toLowerCase()) ?? false;
  const mark = (table: string, column: string) => {
    const set = marks.get(table.toLowerCase()) ?? new Set<string>();
    set.add(column.toLowerCase());
    marks.set(table.toLowerCase(), set);
  };
  const rowidColumn = new Map<string, string | null>();
  for (const table of tables) {
    const columns = tableXInfo(sql, table);
    rowidColumn.set(table.toLowerCase(), integerPrimaryKey(sql, table, columns)?.toLowerCase() ?? null);
    for (const c of columns) if (/personal/i.test(c.type)) mark(table, c.name);
  }
  const ties = tables.flatMap((child) => foreignKeys(sql, child).flatMap((k) => k.from.map((from, i) => ({ child, from, parent: k.parent, to: k.to[i]! }))));
  const toRowid = (tie: (typeof ties)[number]) => rowidColumn.get(tie.parent.toLowerCase()) === tie.to.toLowerCase();
  for (let changed = true; changed; ) {
    changed = false;
    for (const tie of ties) {
      if (toRowid(tie) || has(tie.child, tie.from) === has(tie.parent, tie.to)) continue;
      mark(tie.child, tie.from);
      mark(tie.parent, tie.to);
      changed = true;
    }
  }
  for (const tie of ties) if (toRowid(tie)) marks.get(tie.child.toLowerCase())?.delete(tie.from.toLowerCase());
  return marks;
}

/** A sample keeps the newest files its rows name, up to its bytes. Answers how many it left out. */
function trimSampleFiles(sql: SqlLike): number {
  const count = () => Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${FILES_TABLE}`).one().n);
  const before = count();
  sql
    .exec(
      `DELETE FROM ${FILES_TABLE} WHERE id IN (
         SELECT id FROM (
           SELECT f.id, sum(f.size) OVER (ORDER BY f.received_at DESC, f.id) AS total
           FROM _files AS f JOIN ${FILES_TABLE} AS e ON e.id = f.id
           WHERE f.state = 'ready' AND f.deleted_at IS NULL
         ) WHERE total > ${COPY_SAMPLE_FILE_BYTES}
       )`,
    )
    .toArray();
  return before - count();
}

// ── Personal values: replaced the same way everywhere in one copy ───────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+$/;

async function hmacHex(key: CryptoKey, text: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function replacementOf(value: SqliteValue, hex: string): SqliteValue {
  if (typeof value === "string") return EMAIL.test(value) ? `person-${hex.slice(0, 12)}@example.com` : `Person ${hex.slice(0, 12)}`;
  if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) {
    const big = BigInt(value);
    const negative = big < 0n;
    const digits = (negative ? -big : big).toString().length;
    const span = 10n ** BigInt(digits);
    const floor = digits > 1 ? 10n ** BigInt(digits - 1) : 0n;
    let n = BigInt(`0x${hex.slice(0, 24)}`) % (span - floor) + floor;
    if (negative) n = -n;
    return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
  }
  if (typeof value === "number") return value === 0 ? 0 : value * (0.5 + parseInt(hex.slice(0, 8), 16) / 2 ** 32);
  if (value instanceof Uint8Array) {
    const out = new Uint8Array(value.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice((i % 32) * 2, (i % 32) * 2 + 2), 16);
    return out;
  }
  return value;
}

async function replacePersonal(rows: SqliteValue[][], positions: readonly number[], key: CryptoKey, cache: Map<string, SqliteValue>): Promise<number> {
  const wanted = new Map<string, SqliteValue>();
  const tag = (v: SqliteValue): string => (v instanceof Uint8Array ? `b:${[...v].join(",")}` : `${typeof v}:${String(v)}`);
  for (const row of rows) for (const p of positions) if (row[p] !== null && row[p] !== undefined && !cache.has(tag(row[p]!))) wanted.set(tag(row[p]!), row[p]!);
  if (cache.size + wanted.size > 50_000) cache.clear();
  await Promise.all([...wanted].map(async ([t, v]) => cache.set(t, replacementOf(v, await hmacHex(key, t)))));
  let replaced = 0;
  for (const row of rows) {
    for (const p of positions) {
      const v = row[p];
      if (v === null || v === undefined) continue;
      row[p] = cache.get(tag(v)) ?? replacementOf(v, await hmacHex(key, tag(v)));
      replaced++;
    }
  }
  return replaced;
}

const FILE_ID_RE = /\bfil_[0-9a-f]{24}\b/g;

/** Notes the files a copy's rows name, so the copy brings them. */
function noteFiles(sql: SqlLike, rows: readonly SqliteValue[][]): void {
  const ids = new Set<string>();
  for (const row of rows) for (const v of row) if (typeof v === "string" && v.includes("fil_")) for (const m of v.matchAll(FILE_ID_RE)) ids.add(m[0]);
  if (ids.size > 0) sql.exec(`INSERT OR IGNORE INTO ${FILES_TABLE} (id) SELECT value FROM json_each(?)`, JSON.stringify([...ids]));
}

// ── Reading a b-tree's rows ──────────────────────────────────────────────────────────────────────

/**
 * A whole number past 2^53 does not fit a JS number: Node's SQLite refuses to answer one, and
 * workerd would round it. Each value is read through this, which answers such a number as bytes:
 * a mark, then its digits, which `valueOf` turns back into the exact number. (A JS number that is
 * whole is written as an integer, so a REAL such as 3.0 in a column with no declared type comes
 * back as the INTEGER 3: the same value, which SQLite compares as equal. Every typed column reads
 * it back as its type.)
 */
const BIG_MARK = "e3a1f7c2904b5d6eb18fd2c3a4b5e6f7";
const BIG_MARK_BYTES = Uint8Array.from(BIG_MARK.match(/../g)!.map((h) => parseInt(h, 16)));

function exact(expr: string): string {
  return `CASE WHEN typeof(${expr}) = 'integer' AND (${expr} > 9007199254740991 OR ${expr} < -9007199254740991) THEN CAST(X'${BIG_MARK}' || CAST(${expr} AS TEXT) AS BLOB) ELSE ${expr} END`;
}

function valueOf(v: unknown): SqliteValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v;
  const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null;
  if (!bytes) return String(v);
  if (bytes.byteLength > BIG_MARK_BYTES.byteLength && BIG_MARK_BYTES.every((b, i) => bytes[i] === b)) {
    const digits = new TextDecoder().decode(bytes.subarray(BIG_MARK_BYTES.byteLength));
    if (/^-?\d{1,20}$/.test(digits)) return BigInt(digits);
  }
  return bytes;
}

function sizeOf(row: readonly SqliteValue[]): number {
  let n = 0;
  for (const v of row) n += typeof v === "string" ? v.length * 2 : v instanceof Uint8Array ? v.byteLength : 8;
  return n;
}

/** What the reads of this chunk have seen, so the next read asks for about a batch's bytes. */
interface BatchSeen {
  rows: number;
  bytes: number;
}

/**
 * How many rows the next read asks for. Every row a statement answers is read, whether it is kept
 * or not, because a statement left open holds its tables against a later DROP TABLE until the
 * runtime gets round to freeing it, and workerd offers no way to close one early.
 */
function nextLimit(seen: BatchSeen): number {
  if (seen.rows === 0) return FIRST_BATCH_ROWS;
  return Math.max(1, Math.min(MAX_BATCH_ROWS, Math.floor((BATCH_BYTES * seen.rows) / Math.max(1, seen.bytes))));
}

/** The next batch of a rowid table's rows after `after`, each as [rowid, record values]. */
function tableBatch(sql: SqlLike, spec: TreeSpec, after: string | null, seen: BatchSeen): { rowid: number | bigint; values: SqliteValue[] }[] {
  const rowid = spec.rowid!;
  const where = [after === null ? null : `${rowid} > ?`, spec.where === null ? null : `(${spec.where})`].filter(Boolean).join(" AND ");
  const params = after === null ? [] : [Number.isSafeInteger(Number(after)) ? Number(after) : after];
  const limit = nextLimit(seen);
  // workerd answers at most 100 columns: a wider table is read in halves, both in rowid order.
  const halves: string[][] = [];
  for (let i = 0; i < Math.max(1, spec.columns.length); i += RESULT_COLUMNS_MAX - 1) halves.push(spec.columns.slice(i, i + RESULT_COLUMNS_MAX - 1));
  const cursors = halves.map((cols) =>
    sql.exec(`SELECT ${[rowid, ...cols].map(exact).join(", ")} FROM ${ident(spec.table)}${where ? ` WHERE ${where}` : ""} ORDER BY ${rowid} LIMIT ${limit}`, ...params).raw()[Symbol.iterator](),
  );
  const out: { rowid: number | bigint; values: SqliteValue[] }[] = [];
  let bytes = 0;
  for (;;) {
    const parts = cursors.map((c) => c.next());
    if (parts[0]!.done) break;
    if (bytes >= BATCH_BYTES) continue;
    const first = parts[0]!.value as unknown[];
    const values: SqliteValue[] = [];
    for (const p of parts) values.push(...(p.value as unknown[]).slice(1).map(valueOf));
    out.push({ rowid: valueOf(first[0]) as number | bigint, values });
    bytes += sizeOf(values);
  }
  seen.rows += out.length;
  seen.bytes += bytes;
  return out;
}

function indexBatch(sql: SqlLike, spec: TreeSpec, offset: number, seen: BatchSeen): SqliteValue[][] {
  const cursor = sql.exec(`SELECT ${spec.columns.map(exact).join(", ")} FROM ${ident(spec.table)}${spec.where ? ` WHERE ${spec.where}` : ""} ORDER BY ${spec.order.join(", ")} LIMIT ${nextLimit(seen)} OFFSET ${offset}`);
  const out: SqliteValue[][] = [];
  let bytes = 0;
  for (const raw of cursor.raw()) {
    if (bytes >= BATCH_BYTES) continue;
    const row = (raw as unknown[]).map(valueOf);
    out.push(row);
    bytes += sizeOf(row);
  }
  seen.rows += out.length;
  seen.bytes += bytes;
  return out;
}

// ── The job ──────────────────────────────────────────────────────────────────────────────────────

function parseParams(raw: unknown): ExportParams {
  const p = (raw ?? {}) as Partial<ExportParams>;
  if (typeof p.exportId !== "string" || !EXPORT_ID_RE.test(p.exportId)) throw new JobParamsError("An export names its id: exp_ and 24 hex digits.");
  if (p.purpose !== "download" && p.purpose !== "copy") throw new JobParamsError("An export is for a download or a copy.");
  if (p.mode !== "auto" && p.mode !== "whole" && p.mode !== "sample") throw new JobParamsError("A copy is auto, whole or sample.");
  if (p.personal !== "keep" && p.personal !== "replace") throw new JobParamsError("A copy keeps or replaces personal values.");
  return { exportId: p.exportId, purpose: p.purpose, mode: p.purpose === "download" ? "whole" : p.mode, personal: p.purpose === "download" ? "keep" : p.personal };
}

async function putPiece(ctx: JobContext<ExportParams, ExportState>, state: ExportState, out: PageOut, seq?: number): Promise<void> {
  if (out.pending === 0) return;
  const bytes = out.take();
  const key = `${exportPrefix(ctx.job.storeId, ctx.params.exportId)}db/${String(seq ?? state.pieces.length + 1).padStart(6, "0")}`;
  await ctx.bucket.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  if (seq === undefined) state.pieces.push({ key, size: bytes.byteLength });
  else state.pieces.unshift({ key, size: bytes.byteLength });
}

function startState(ctx: JobContext<ExportParams, ExportState>): { state: ExportState; plan: ExportPlan; sampled: Set<string> } {
  const sql = ctx.sql;
  const { purpose } = ctx.params;
  let mode: "whole" | "sample" = "whole";
  if (purpose === "copy") {
    if (ctx.params.mode === "sample") mode = "sample";
    else if (ctx.params.mode === "auto") {
      const fileBytes = Number(sql.exec<{ n: number | null }>("SELECT sum(size) AS n FROM _files WHERE state = 'ready' AND deleted_at IS NULL").one().n ?? 0);
      mode = ctx.databaseSize() + fileBytes < COPY_WHOLE_UNDER_BYTES ? "whole" : "sample";
    }
  }
  const sampled = mode === "sample" ? sampleTables(sql) : new Set<string>();
  const plan = planExport(sql, purpose, mode, ctx.params.personal === "replace", sampled);
  const key = purpose === "copy" && ctx.params.personal === "replace" ? [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("") : null;
  const state: ExportState = {
    phase: mode === "sample" ? "sample" : "trees",
    mode,
    round: 0,
    key,
    at: 0,
    after: null,
    offset: 0,
    tree: null,
    next: 2,
    pieces: [],
    roots: [],
    rows: 0,
    replaced: 0,
    tables: plan.trees.filter((t) => t.name === t.table && isDataTable(t.table)).length,
    filesLeftOut: 0,
  };
  return { state, plan, sampled };
}

async function run(ctx: JobContext<ExportParams, ExportState>) {
  const sql = ctx.sql;
  const params = ctx.params;
  const stop = () => ctx.now() >= ctx.deadline - DEADLINE_MARGIN_MS;
  let state = ctx.state;
  if (state === null) {
    // The hold first, so no write lands between the plan and the file. A chunk that stops before
    // its commit does all of this again: each step replaces what it made.
    holdStore(sql, ctx.job.id, "export");
    if (params.purpose === "copy") {
      sql.exec(`DROP TABLE IF EXISTS ${FILES_TABLE}`);
      sql.exec(`CREATE TABLE ${FILES_TABLE} (id TEXT PRIMARY KEY) WITHOUT ROWID`);
    }
    const begun = startState(ctx);
    state = begun.state;
    ctx.commit({ state, progress: { done: 0, total: null, note: "Writing the file" } }, () => {
      savePlan(sql, PLAN_TABLE, begun.plan);
      if (begun.state.mode === "sample") seedSample(sql, begun.sampled);
    });
  }
  const plan = loadPlan<ExportPlan>(sql, PLAN_TABLE);

  if (state.phase === "sample") {
    const links = sampleLinks(sql, sampleTables(sql));
    for (;;) {
      const found = growSample(sql, links, state.round);
      state.round++;
      if (!found) {
        state.phase = "trees";
        ctx.commit({ state, progress: { done: 0, total: null, note: "Writing the file" } });
        break;
      }
      if (stop()) {
        ctx.commit({ state, progress: { done: 0, total: null, note: "Choosing the rows" } });
        return { more: true } as const;
      }
    }
  }

  const out = new PageOut(state.next);
  const key = state.key ? await crypto.subtle.importKey("raw", Uint8Array.from(state.key.match(/../g)!.map((h) => parseInt(h, 16))), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]) : null;
  const cache = new Map<string, SqliteValue>();
  const seen: BatchSeen = { rows: 0, bytes: 0 };
  const save = async (note: string) => {
    await putPiece(ctx, state!, out);
    state!.next = out.next;
    ctx.commit({ state: state!, progress: { done: state!.rows, total: null, note } });
  };

  while (state.at < plan.trees.length) {
    const spec = plan.trees[state.at]!;
    if (spec.format === "table") {
      // All the data trees are written by now, so what a sample's rows name is known.
      if (spec.fileKey && state.mode === "sample" && state.after === null && !state.tree) state.filesLeftOut = trimSampleFiles(sql);
      const tree = state.tree ? TableTree.from(state.tree as TableTreeState) : new TableTree();
      for (;;) {
        const batch = tableBatch(sql, spec, state.after, seen);
        const rows = batch.map((b) => b.values);
        if (key && spec.personal.length > 0) state.replaced += await replacePersonal(rows, spec.personal, key, cache);
        if (spec.scanFiles) noteFiles(sql, rows);
        for (const b of batch) {
          if (spec.nullAt !== null) b.values[spec.nullAt] = null;
          if (spec.fileKey) b.values[spec.fileKey.key] = `files/${String(b.values[spec.fileKey.id])}/${archiveFileName(String(b.values[spec.fileKey.name]))}`;
          tree.add(b.rowid, b.values, out);
        }
        if (batch.length > 0) state.after = String(batch[batch.length - 1]!.rowid);
        if (isDataTable(spec.table)) state.rows += batch.length;
        if (out.pending * PAGE_SIZE >= PIECE_BYTES) await putPiece(ctx, state, out);
        if (batch.length === 0) break;
        if (stop()) {
          state.tree = tree.state();
          await save(`Writing ${spec.table}`);
          return { more: true } as const;
        }
      }
      state.roots.push([spec.name, tree.finish(out)]);
    } else {
      const tree = state.tree ? IndexTree.from(state.tree as IndexTreeState) : new IndexTree();
      for (;;) {
        const rows = indexBatch(sql, spec, state.offset, seen);
        if (key && spec.personal.length > 0) state.replaced += await replacePersonal(rows, spec.personal, key, cache);
        if (spec.scanFiles) noteFiles(sql, rows);
        for (const row of rows) tree.add(row, out);
        state.offset += rows.length;
        if (spec.name === spec.table && isDataTable(spec.table)) state.rows += rows.length;
        if (out.pending * PAGE_SIZE >= PIECE_BYTES) await putPiece(ctx, state, out);
        if (rows.length === 0) break;
        if (stop()) {
          state.tree = tree.state();
          await save(`Writing ${spec.name}`);
          return { more: true } as const;
        }
      }
      state.roots.push([spec.name, tree.finish(out)]);
    }
    state.at++;
    state.tree = null;
    state.after = null;
    state.offset = 0;
    if (stop() && state.at < plan.trees.length) {
      await save("Writing the file");
      return { more: true } as const;
    }
  }

  // sqlite_schema's pages, then page 1 as the file's first piece; then the manifest.
  const roots = new Map(state.roots);
  const { page1, pages } = finishFile(plan.entries.map((e) => ({ ...e, rootPage: roots.get(e.name) ?? 0 })), out);
  await putPiece(ctx, state, out);
  const head = new PageOut(1);
  head.emit(page1);
  await putPiece(ctx, state, head, 0);
  const files = filesOf(sql, params.purpose, state.mode);
  const now = ctx.now();
  const parkedLeftOut = sql.exec<{ name: string }>("SELECT name FROM _tables WHERE parked IS NOT NULL ORDER BY name").toArray().map((r) => String(r.name));
  const manifest: ExportManifest = {
    v: 1,
    exportId: params.exportId,
    storeId: ctx.job.storeId,
    purpose: params.purpose,
    mode: state.mode,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (params.purpose === "copy" ? COPY_KEEP_MS : EXPORT_KEEP_MS)).toISOString(),
    db: { pageSize: PAGE_SIZE, pages, bytes: pages * PAGE_SIZE, pieces: state.pieces },
    files,
    fileBytes: files.reduce((n, f) => n + f.size, 0),
    tables: state.tables,
    rows: state.rows,
    replaced: state.replaced,
    filesLeftOut: state.filesLeftOut,
    parkedLeftOut,
    migrations: sql.exec<{ id: string }>("SELECT id FROM _migrations ORDER BY applied_at, id").toArray().map((r) => String(r.id)),
  };
  await ctx.bucket.put(manifestKey(ctx.job.storeId, params.exportId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { expiresAt: manifest.expiresAt },
  });
  const finished = state;
  ctx.commit({ state: finished, progress: { done: finished.rows, total: finished.rows, note: "Done" } }, () => {
    endExport(sql, ctx.job.id);
    noteSweep(sql, manifest.expiresAt);
  });
  const result: ExportResult = {
    exportId: params.exportId,
    purpose: params.purpose,
    mode: state.mode,
    bytes: manifest.db.bytes,
    pages,
    tables: state.tables,
    rows: state.rows,
    files: files.length,
    fileBytes: manifest.fileBytes,
    replaced: state.replaced,
    filesLeftOut: state.filesLeftOut,
    parkedLeftOut,
  };
  return { result };
}

/** The files that go with the file: as `_files` lists them in it. */
function filesOf(sql: SqlLike, purpose: ExportPurpose, mode: "whole" | "sample"): ExportFile[] {
  const where = rowsOf("_files", purpose, mode, null, new Set());
  return sql
    .exec<Record<string, StoreSqlValue>>(`SELECT id, name, size, content_type, r2_key FROM _files WHERE ${where} ORDER BY received_at, id`)
    .toArray()
    .map((r) => ({ id: String(r.id), name: String(r.name), size: Number(r.size), contentType: String(r.content_type), key: String(r.r2_key) }));
}

/** The export's own tables and its hold go. */
function endExport(sql: SqlLike, job: string): void {
  sql.exec(`DROP TABLE IF EXISTS ${ROWS_TABLE}`);
  sql.exec(`DROP TABLE IF EXISTS ${FILES_TABLE}`);
  sql.exec(`DROP TABLE IF EXISTS ${PLAN_TABLE}`);
  releaseHold(sql, job);
}

/** When the store next looks for exports past their time. */
function noteSweep(sql: SqlLike, at: string): void {
  sql.exec(`INSERT INTO _meta (key, value) VALUES ('${EXPORTS_SWEEP_KEY}', ?) ON CONFLICT (key) DO UPDATE SET value = min(value, excluded.value)`, at);
}

export const exportHandler: JobHandler<ExportParams, ExportState, ExportResult> = {
  kind: EXPORT_KIND,
  parse: parseParams,
  run,
  // An export writes only its own work tables: a store past the day's write limit can still be exported.
  pastLimit: true,
  async failed(ctx, error) {
    endExport(ctx.sql, ctx.job.id);
    const prefix = exportPrefix(ctx.job.storeId, ctx.params.exportId);
    const expiresAt = new Date(ctx.now() + COPY_KEEP_MS).toISOString();
    noteSweep(ctx.sql, expiresAt);
    // First, whatever else fails: a store waiting to load this export learns it failed, instead of
    // waiting an hour, and the sweep finds what is left of the export by this file.
    await ctx.bucket.put(`${prefix}failed.json`, JSON.stringify({ error: error.slice(0, 500) }), { httpMetadata: { contentType: "application/json" }, customMetadata: { expiresAt } });
    await deletePrefix(ctx.bucket, `${prefix}db/`);
  },
};

export async function deletePrefix(bucket: StoreFiles, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** An export's manifest, read back from the bucket; null when it never finished or its time is over. */
export async function readManifest(bucket: StoreFiles, storeId: string, exportId: string, now: number): Promise<ExportManifest | null> {
  if (!EXPORT_ID_RE.test(exportId)) return null;
  const object = await bucket.get(manifestKey(storeId, exportId));
  if (!object) return null;
  const manifest = (await object.json()) as ExportManifest;
  if (manifest.storeId !== storeId || manifest.exportId !== exportId) return null;
  if (Date.parse(manifest.expiresAt) <= now) return null;
  return manifest;
}

/**
 * Drops exports past their time, and answers when the next one is due. The store looks only when
 * its note says one may be (`exports_sweep_at`), so a store with no exports lists nothing.
 */
export async function sweepExports(sql: SqlLike, bucket: StoreFiles, storeId: string, now: number): Promise<number | null> {
  const at = sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = ?", EXPORTS_SWEEP_KEY).toArray()[0];
  if (!at) return null;
  if (Date.parse(String(at.value)) > now) return Date.parse(String(at.value));
  let next: number | null = null;
  let cursor: string | undefined;
  const prefix = `stores/${storeId}/exports/`;
  do {
    const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    for (const o of page.objects) {
      const end = o.key.endsWith("/manifest.json") ? "manifest.json" : o.key.endsWith("/failed.json") ? "failed.json" : null;
      if (!end) continue;
      const expires = Date.parse(o.customMetadata?.expiresAt ?? "");
      if (Number.isNaN(expires) || expires <= now) await deletePrefix(bucket, o.key.slice(0, -end.length));
      else next = next === null ? expires : Math.min(next, expires);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (next === null) sql.exec("DELETE FROM _meta WHERE key = ?", EXPORTS_SWEEP_KEY);
  else sql.exec("UPDATE _meta SET value = ? WHERE key = ?", new Date(next).toISOString(), EXPORTS_SWEEP_KEY);
  return next;
}
