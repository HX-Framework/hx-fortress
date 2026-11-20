// A store's import: an export loaded into an empty store. The export is an archive someone sent
// into this store as a file (Export's .tar, or its .sqlite alone), or another store's export made
// for a copy (copy-from, for a preview). The store reads the SQLite file itself
// (sqlite-file/reader.ts), since a Durable Object has no way to open one.
//
// A copy with `replace` (a Modern App's Copy Data) loads over what the store holds. Nothing goes
// until the other store's export is there and sound: the plan's commit empties the store, keeping
// its people and its history, and marks its files deleted, so a restore to the moment before the
// copy brings them all back. That moment is taken before the job exists (handler.ts), so a store
// restored to it has no job to go on with.
//
// An import is one of the store's own jobs, in chunks between alarms, and holds the store's writes
// while it runs. In order:
//   1. The tables, from their CREATE TABLE statements, each checked: one statement that makes that
//      table and its own indexes, naming none of the store's own tables. No virtual tables.
//   2. Their rows, each table in rowid order (a WITHOUT ROWID table in key order), parents before
//      children, with each table's unique indexes already made: a foreign key can point at one.
//      A row whose foreign key points at a row not loaded yet waits in `_import_pending`, and
//      all the waiting rows go in together, with their keys checked at the end, so rows that
//      point at each other go in too. If any key still points at nothing, the import fails.
//   3. The other indexes, views and triggers, after the rows, so no trigger runs on a loaded row.
//   4. The files' bytes, each into this store's place in the bucket with its record in the
//      object's metadata (history.ts rebuilds `_files` from that after a restore).
//   5. The store's own records from the file: its migrations (`_migrations` and drizzle's own),
//      the user list, the catalog's tables and columns, the history, SHAPE's saved queries, and
//      the files' records, each naming this store's key. Never sessions, jobs or the source
//      store's own marks.
// A failed import leaves the store empty again, so it can be tried again. An import holds the store
// from the moment it is accepted, but only undoes what it began: refused at its first chunk
// because the store is not empty after all, it leaves the store as it found it.

import { windowedSource, type ByteSource } from "../../store-readers/src/source.js";

import { randomHex, StoreError } from "./core.js";
import { EXPORT_ID_RE, foreignKeys, loadPlan, readManifest, savePlan } from "./export.js";
import { fileKey } from "./files.js";
import { settleFolders } from "./folders.js";
import { holdStore, isLoading, releaseHold, HOLD_KEY } from "./history.js";
import { JobParamsError, type JobContext, type JobHandler } from "./jobs/types.js";
import { decodeRecord, encodeRecord, type SqliteValue } from "./sqlite-file/format.js";
import { piecesSource, SqliteFileReader, type BTreeCursor, type BTreeRow } from "./sqlite-file/reader.js";
import { looksLikeTar, readTar } from "./sqlite-file/tar.js";
import { backtickNames, createdKind, firstWord, ident, namesIn, passedOver, schemaChanges, schemaObjects, splitStatements, SYSTEM_TABLES, type SqlLike, type StoreSqlValue } from "./sql.js";
import type { StoreFiles } from "./store-files.js";

export const IMPORT_KIND = "import";
/** How long an import waits for another store's export to finish. */
export const IMPORT_WAIT_MS = 60 * 60_000;
const BATCH_ROWS = 500;
const BATCH_BYTES = 4 * 1024 * 1024;
const DEADLINE_MARGIN_MS = 2_000;
const PART_BYTES = 8 * 1024 * 1024;
/** workerd's most bound values in one statement. */
const PARAMS_MAX = 100;
const PENDING_TABLE = "_import_pending";
/** The files to bring: a table, since a store can hold more of them than a job's state should. */
const FILES_TABLE = "_import_files";
/** What the import makes, decided once: a table too, so the job's state, written at every commit, stays small. */
const PLAN_TABLE = "_import_plan";
const SYSTEM = new Set<string>(SYSTEM_TABLES);
/** The store's own tables an import loads rows into, in this order (`_files` last, once the bytes are
 *  in, right after the folders they are in). */
const SYSTEM_LOADED = ["_tables", "_columns", "_migrations", "__drizzle_migrations", "_history", "_users", "_meta", "_fixes", "_folders", "_files"];

export type ImportSource = { kind: "file"; fileId: string } | { kind: "export"; storeId: string; exportId: string };

export interface ImportParams {
  source: ImportSource;
  /** Words for the history: the file's name, or the store it came from. */
  label: string;
  /** Loads over what the store holds, instead of asking for an empty store. */
  replace?: boolean;
  /** With `replace`: the moment before the copy was accepted, for the history's Restore to Here. */
  restorePoint?: string | null;
  /** With `replace`: when that was. The history's event carries it, as a restore names its event's time. */
  restorePointAt?: string | null;
}

export interface ImportResult {
  tables: number;
  rows: number;
  files: number;
  fileBytes: number;
  migrations: number;
  users: number;
}

/** Where the SQLite file's bytes are. */
type DbPlace = { kind: "pieces"; pieces: { key: string; size: number }[] } | { kind: "object"; key: string; offset: number; size: number };

interface ImportFile {
  id: string;
  name: string;
  size: number;
  contentType: string;
  receivedAt: string;
  receivedBy: string;
  via: string;
  batch: string | null;
  fromKey: string;
  fromOffset: number;
}

interface PlannedTable {
  name: string;
  root: number;
  format: "table" | "index";
  sql: string;
}

interface PlannedObject {
  type: "index" | "view" | "trigger";
  name: string;
  sql: string;
}

interface ImportPlan {
  tables: PlannedTable[];
  objects: PlannedObject[];
  /** The store's own tables in the file, with their columns in the file's order. */
  system: { name: string; root: number; columns: string[] }[];
  /** AUTOINCREMENT's counters, as the file kept them. */
  sequence: { name: string; seq: number }[];
}

interface ImportState {
  phase: "wait" | "tables" | "rows" | "pending" | "objects" | "files" | "system" | "finish";
  waitingSince: number;
  db: DbPlace | null;
  archive: { fileId: string; key: string } | null;
  /** How many files `_import_files` holds; `at` counts those brought. */
  files: number;
  at: number;
  cursor: BTreeCursor | null;
  upload: { id: string; parts: { n: number; etag: string }[] } | null;
  rows: number;
  fileBytes: number;
}

function refuse(message: string): StoreError {
  return new StoreError(400, "import_refused", message);
}

// ── Reading the source ───────────────────────────────────────────────────────────────────────────

function objectSource(bucket: StoreFiles, key: string, offset: number, size: number): ByteSource {
  return {
    size,
    async read(at, length) {
      const end = Math.min(size, at + length);
      if (at >= end) return new Uint8Array(0);
      const object = await bucket.get(key, { range: { offset: offset + at, length: end - at } });
      if (!object) throw new StoreError(404, "import_source_gone", "The export's bytes are gone from the bucket.");
      return new Uint8Array(await object.arrayBuffer());
    },
  };
}

function dbSource(bucket: StoreFiles, db: DbPlace): ByteSource {
  if (db.kind === "object") return objectSource(bucket, db.key, db.offset, db.size);
  return piecesSource(db.pieces.map((p) => objectSource(bucket, p.key, 0, p.size)));
}

interface Located {
  db: DbPlace;
  /** Each file's bytes, by its id. */
  files: Map<string, { key: string; offset: number; size: number }>;
  archive: ImportState["archive"];
}

/** Where the export is. Null while another store's export is still being written; why, when it failed. */
async function locate(ctx: JobContext<ImportParams, ImportState>): Promise<Located | null | { failed: string }> {
  const source = ctx.params.source;
  if (source.kind === "export") {
    const manifest = await readManifest(ctx.bucket, source.storeId, source.exportId, ctx.now());
    if (!manifest) {
      const failure = await ctx.bucket.get(`stores/${source.storeId}/exports/${source.exportId}/failed.json`);
      if (!failure) return null;
      return { failed: String(((await failure.json().catch(() => null)) as { error?: unknown } | null)?.error ?? "") };
    }
    return { db: { kind: "pieces", pieces: manifest.db.pieces }, files: new Map(manifest.files.map((f) => [f.id, { key: f.key, offset: 0, size: f.size }])), archive: null };
  }
  const row = ctx.sql.exec<Record<string, StoreSqlValue>>("SELECT r2_key, name, size FROM _files WHERE id = ? AND state = 'ready' AND deleted_at IS NULL", source.fileId).toArray()[0];
  if (!row) throw new StoreError(404, "file_not_found", "This store has no such file to import.");
  const key = String(row.r2_key);
  const name = String(row.name);
  const size = Number(row.size);
  const whole = objectSource(ctx.bucket, key, 0, size);
  const head = await whole.read(0, 512);
  const archive = { fileId: source.fileId, key };
  if (head.byteLength >= 16 && new TextDecoder().decode(head.subarray(0, 15)) === "SQLite format 3") {
    return { db: { kind: "object", key, offset: 0, size }, files: new Map(), archive };
  }
  if (!looksLikeTar(head)) throw refuse(`${name} is not a store's export: an import takes Export's .tar, or its .sqlite file.`);
  const tar = await readTar(windowedSource(whole, 1 << 20, 4));
  if (!tar.db) throw refuse(`${name} holds no .sqlite file.`);
  return {
    db: { kind: "object", key, offset: tar.db.offset, size: tar.db.size },
    files: new Map([...tar.files].map(([id, f]) => [id, { key, offset: f.offset, size: f.size }])),
    archive,
  };
}

// ── An empty store ───────────────────────────────────────────────────────────────────────────────

/** Why this store is not empty, or null: an import loads into a store with no tables, people, migrations or files. */
export function notEmpty(sql: SqlLike, archiveId: string | null): string | null {
  const tables = sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .toArray()
    .map((r) => String(r.name))
    .filter((n) => !SYSTEM.has(n) && !/^(sqlite_|_cf_|__miniflare|_import_|_export_)/i.test(n));
  if (tables.length > 0) return `it has tables (${tables.slice(0, 3).join(", ")}${tables.length > 3 ? ", …" : ""})`;
  if (sql.exec("SELECT 1 FROM _migrations LIMIT 1").toArray().length > 0) return "it has migrations";
  if (sql.exec("SELECT 1 FROM _users LIMIT 1").toArray().length > 0) return "it has people on its user list";
  if (sql.exec("SELECT 1 FROM _files WHERE id != ? AND deleted_at IS NULL LIMIT 1", archiveId ?? "").toArray().length > 0) return "it has files";
  return null;
}

// ── Checking what the file asks the store to make ───────────────────────────────────────────────

/** The statement's words outside strings and quoted names: what it says, not what it names. */
function bareWords(statement: string): string {
  return statement.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
}

function oneCreate(sqlText: string, kind: "TABLE" | "INDEX" | "VIEW" | "TRIGGER", name: string): string {
  const statements = splitStatements(sqlText);
  if (statements.length !== 1 || firstWord(statements[0]!) !== "CREATE") throw refuse(`The file's ${name} is not one CREATE statement.`);
  const statement = statements[0]!;
  const words = bareWords(statement);
  if (/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(words)) throw refuse(`The file's ${name} is a virtual table (such as a full-text index), which an import does not load.`);
  if (/^\s*CREATE\s+TEMP(?:ORARY)?\b/i.test(words)) throw refuse(`The file's ${name} is a temporary object.`);
  const head = new RegExp(`^\\s*CREATE\\s+${kind === "INDEX" ? "(?:UNIQUE\\s+)?INDEX" : kind}\\b`, "i");
  if (!head.test(words)) throw refuse(`The file's ${name} does not make a ${kind.toLowerCase()}.`);
  if (kind === "TABLE" && /\bSELECT\b/i.test(words)) throw refuse(`The file's ${name} is made from a query; an import makes tables from their columns.`);
  for (const word of namesIn(statement, { strings: true })) {
    if (word === name.toLowerCase()) continue;
    if (SYSTEM.has(word) || word === "sqlite_master" || word === "sqlite_schema") throw refuse(`The file's ${name} names ${word}, which is the store's own.`);
  }
  return createdKind(statement) ? (backtickNames(statement)?.text ?? statement) : statement;
}

/** Runs one checked CREATE, and refuses it unless it made its object (a table's own indexes aside) and nothing else. */
function create(sql: SqlLike, statement: string, name: string, type: string): void {
  const before = schemaObjects(sql);
  sql.exec(statement).toArray();
  const { added, dropped, changed } = schemaChanges(before, schemaObjects(sql));
  const lower = name.toLowerCase();
  const own = (o: { name: string; type: string; table: string }) =>
    o.name.toLowerCase() === lower ||
    (type === "table" && o.type === "index" && o.table === lower && o.name.toLowerCase().startsWith("sqlite_autoindex_")) ||
    o.name.toLowerCase() === "sqlite_sequence";
  if (dropped.length > 0 || changed.length > 0 || added.some((o) => !own(o)) || !added.some((o) => o.name.toLowerCase() === lower)) {
    throw refuse(`The file's statement for ${name} makes something other than ${name}.`);
  }
  // What the object is on, as SQLite read it: the file's own word for that is not to be trusted.
  if (added.some((o) => SYSTEM.has(o.table))) throw refuse(`The file's ${name} is on one of the store's own tables.`);
}

/** A CREATE TABLE's column names, in order: what its rows' records hold. Constraints are not columns. */
export function createTableColumns(createSql: string): string[] {
  const open = createSql.indexOf("(");
  if (open < 0) return [];
  const out: string[] = [];
  let depth = 0;
  let start = open + 1;
  const items: string[] = [];
  for (let i = open; i < createSql.length; i++) {
    const c = createSql[i]!;
    if (c === "-" && createSql[i + 1] === "-") {
      const end = createSql.indexOf("\n", i);
      i = end < 0 ? createSql.length : end;
      continue;
    }
    if (c === "/" && createSql[i + 1] === "*") {
      const end = createSql.indexOf("*/", i + 2);
      i = end < 0 ? createSql.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      i++;
      while (i < createSql.length && createSql[i] !== close) i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        items.push(createSql.slice(start, i));
        break;
      }
    } else if (c === "," && depth === 1) {
      items.push(createSql.slice(start, i));
      start = i + 1;
    }
  }
  for (const item of items) {
    const text = item.trim();
    if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(text)) continue;
    const m = /^(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|\[([^\]]+)\]|'((?:[^']|'')+)'|([^\s(]+))/.exec(text);
    const name = m?.[1]?.replace(/""/g, '"') ?? m?.[2]?.replace(/``/g, "`") ?? m?.[3] ?? m?.[4]?.replace(/''/g, "'") ?? m?.[5];
    if (name) out.push(name);
  }
  return out;
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────

interface TableShape {
  /** The record's values, in order: the column each goes to, or null for one the table makes itself. */
  record: (string | null)[];
  /** The column holding the rowid (an INTEGER PRIMARY KEY), if any. */
  ipk: string | null;
  rowid: string | null;
  links: { parent: string; from: string[]; to: string[] }[];
}

function shapeOf(sql: SqlLike, table: PlannedTable): TableShape {
  const cols = sql
    .exec<Record<string, StoreSqlValue>>(`PRAGMA table_xinfo(${ident(table.name)})`)
    .toArray()
    .map((c) => ({ name: String(c.name), type: String(c.type ?? ""), pk: Number(c.pk), hidden: Number(c.hidden ?? 0) }));
  const indexes = sql.exec<Record<string, StoreSqlValue>>(`PRAGMA index_list(${ident(table.name)})`).toArray().map((r) => ({ name: String(r.name), origin: String(r.origin) }));
  const links = foreignKeys(sql, table.name);
  const generated = new Set(cols.filter((c) => c.hidden === 2 || c.hidden === 3).map((c) => c.name));
  if (table.format === "index") {
    const pk = indexes.find((i) => i.origin === "pk");
    if (!pk) throw refuse(`Table ${table.name} is WITHOUT ROWID with no primary key.`);
    const info = sql.exec<Record<string, StoreSqlValue>>(`PRAGMA index_xinfo(${ident(pk.name)})`).toArray();
    return { record: info.map((r) => (r.name === null || generated.has(String(r.name)) ? null : String(r.name))), ipk: null, rowid: null, links };
  }
  const stored = cols.filter((c) => c.hidden === 0 || c.hidden === 3);
  const pks = cols.filter((c) => c.pk > 0);
  const ipk = pks.length === 1 && pks[0]!.type.toUpperCase() === "INTEGER" && !indexes.some((i) => i.origin === "pk") ? pks[0]!.name : null;
  const taken = new Set(cols.map((c) => c.name.toLowerCase()));
  const rowid = ["rowid", "_rowid_", "oid"].find((n) => !taken.has(n)) ?? null;
  return { record: stored.map((c) => (generated.has(c.name) ? null : c.name)), ipk, rowid, links };
}

function bindable(value: SqliteValue | undefined): string | number | null | ArrayBuffer {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number") return value ?? null;
  // A whole number past what a JS number holds goes as its digits, in `CAST(? AS INTEGER)` (`slot`).
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

/** A value's place in a statement: `?`, or for a whole number past 2^53 its digits made an integer again. */
function slot(value: SqliteValue | undefined): string {
  return typeof value === "bigint" && !Number.isSafeInteger(Number(value)) ? "CAST(? AS INTEGER)" : "?";
}

type LoadedRow = { rowid: number | bigint | null; values: SqliteValue[] };

/** A row as a statement takes it: its columns and values, and each value by its column's lowercased name. */
function partsOf(shape: TableShape, row: LoadedRow): { columns: string[]; values: SqliteValue[]; byName: Map<string, SqliteValue> } {
  const columns: string[] = [];
  const values: SqliteValue[] = [];
  const byName = new Map<string, SqliteValue>();
  shape.record.forEach((column, i) => {
    if (!column || i >= row.values.length) return;
    // The record holds null for an INTEGER PRIMARY KEY: its value is the rowid.
    const value = column === shape.ipk ? row.rowid : row.values[i]!;
    byName.set(column.toLowerCase(), value);
    columns.push(ident(column));
    values.push(value);
  });
  if (shape.ipk && !byName.has(shape.ipk.toLowerCase()) && row.rowid !== null) {
    byName.set(shape.ipk.toLowerCase(), row.rowid);
    columns.push(ident(shape.ipk));
    values.push(row.rowid);
  }
  return { columns, values, byName };
}

function insertRow(sql: SqlLike, table: string, shape: TableShape, row: LoadedRow, parts = partsOf(shape, row)): void {
  const { columns, values } = parts;
  // The rowid goes in too, so a row keeps its place, where the statement has room for one more value.
  if (!shape.ipk && shape.rowid && row.rowid !== null && values.length < PARAMS_MAX) {
    columns.unshift(shape.rowid);
    values.unshift(row.rowid);
  }
  if (columns.length === 0) sql.exec(`INSERT INTO ${ident(table)} DEFAULT VALUES`).toArray();
  else sql.exec(`INSERT INTO ${ident(table)} (${columns.join(", ")}) VALUES (${values.map(slot).join(", ")})`, ...values.map(bindable)).toArray();
}

/** Puts one row in, unless a foreign key points at a row that is not there yet: then it answers false. */
function placeRow(sql: SqlLike, table: string, shape: TableShape, row: LoadedRow): boolean {
  const parts = partsOf(shape, row);
  for (const link of shape.links) {
    const own = link.from.map((c) => parts.byName.get(c.toLowerCase()) ?? null);
    if (own.some((v) => v === null)) continue;
    // A row may point at itself: SQLite checks such a key when the row's own INSERT ends.
    if (link.parent.toLowerCase() === table.toLowerCase() && link.to.every((c, i) => parts.byName.get(c.toLowerCase()) === own[i])) continue;
    const where = link.to.map((c, i) => `${ident(c)} = ${slot(own[i])}`).join(" AND ");
    if (sql.exec(`SELECT 1 FROM ${ident(link.parent)} WHERE ${where} LIMIT 1`, ...own.map(bindable)).toArray().length === 0) return false;
  }
  insertRow(sql, table, shape, row, parts);
  return true;
}

/** Tables in an order where each comes after the tables its foreign keys point at, where it can. */
function parentsFirst(sql: SqlLike, tables: PlannedTable[]): PlannedTable[] {
  const named = new Map(tables.map((t) => [t.name.toLowerCase(), t.name]));
  const parents = new Map(tables.map((t) => [t.name, new Set(foreignKeys(sql, t.name).flatMap((k) => named.get(k.parent.toLowerCase()) ?? []).filter((p) => p !== t.name))]));
  const out: PlannedTable[] = [];
  const placed = new Set<string>();
  while (out.length < tables.length) {
    const next = tables.find((t) => !placed.has(t.name) && [...parents.get(t.name)!].every((p) => placed.has(p))) ?? tables.find((t) => !placed.has(t.name))!;
    out.push(next);
    placed.add(next.name);
  }
  return out;
}

/** The sizes of the files these `_files` rows name, as the import brought them. Empty for any other table. */
function sizesOf(sql: SqlLike, rows: readonly BTreeRow[], sys: { name: string; columns: string[] }): Map<string, number> {
  const out = new Map<string, number>();
  if (sys.name !== "_files") return out;
  for (const r of rows) {
    const id = String(named(sys.columns, r.values).id);
    const row = sql.exec<{ size: number }>(`SELECT size FROM ${FILES_TABLE} WHERE id = ?`, id).toArray()[0];
    if (row) out.set(id, Number(row.size));
  }
  return out;
}

/** A row of one of the store's own tables in the file, by its columns' names there. */
function named(columns: readonly string[], values: readonly SqliteValue[]): Record<string, SqliteValue> {
  const out: Record<string, SqliteValue> = {};
  columns.forEach((c, i) => (out[c] = i < values.length ? values[i]! : null));
  return out;
}

/**
 * A SHAPE's saved record without how far it read its tables: those are change numbers of the source
 * store's, which this one does not have, so its next run makes the table whole.
 */
function withoutReadMarks(value: string): string {
  try {
    const saved = JSON.parse(value) as Record<string, unknown> | null;
    if (!saved || typeof saved !== "object") return value;
    delete saved.read;
    return JSON.stringify(saved);
  } catch {
    return value;
  }
}

/**
 * Rows of one of the store's own tables from the file, by column name, each where it belongs: the
 * catalog's rows only for tables the import made, `_meta` without the source store's own marks,
 * and each `_files` row that came with its bytes, naming this store's key.
 */
function loadSystemRows(sql: SqlLike, table: string, columns: readonly string[], rows: readonly BTreeRow[], storeId: string, tables: ReadonlySet<string>, files: ReadonlyMap<string, number>): void {
  const here = new Set(sql.exec<{ name: string }>(`PRAGMA table_info(${ident(table)})`).toArray().map((c) => String(c.name)));
  for (const r of rows) {
    const row = named(columns, r.values);
    if ((table === "_tables" && !tables.has(String(row.name))) || ((table === "_columns" || table === "_fixes") && !tables.has(String(row.tbl)))) continue;
    // What describes the tables and the files: the source store's other rows of `_meta` are its own.
    if (table === "_meta" && !/^(?:shape|check|answers|code_page):/.test(String(row.key))) continue;
    if (table === "_meta" && String(row.key).startsWith("shape:") && typeof row.value === "string") row.value = withoutReadMarks(row.value);
    // A restore point is a moment of the source store's object, and means nothing to this one.
    if (table === "_history" || table === "_migrations") row.restore_point = null;
    if (table === "_files") {
      const size = files.get(String(row.id));
      if (size === undefined) continue;
      // The size is what arrived, whatever the record said.
      row.size = size;
      row.r2_key = fileKey(storeId, String(row.id), String(row.name));
      row.upload_id = null;
      // A copy is no arrival: what reads the files that arrived (events.ts) never answers it.
      row.ready_at = null;
    }
    const names = Object.keys(row).filter((c) => here.has(c));
    if (names.length === 0) continue;
    const verb = table === "__drizzle_migrations" ? "INSERT" : "INSERT OR REPLACE";
    sql.exec(`${verb} INTO ${ident(table)} (${names.map(ident).join(", ")}) VALUES (${names.map((c) => slot(row[c])).join(", ")})`, ...names.map((c) => bindable(row[c]))).toArray();
  }
}

// ── The job ──────────────────────────────────────────────────────────────────────────────────────

function parseParams(raw: unknown): ImportParams {
  const p = (raw ?? {}) as { source?: Partial<ImportSource> & { fileId?: unknown; storeId?: unknown; exportId?: unknown }; label?: unknown; replace?: unknown; restorePoint?: unknown; restorePointAt?: unknown };
  const s = p.source;
  if (s?.kind === "file") {
    if (typeof s.fileId !== "string" || !/^fil_[0-9a-f]{24}$/.test(s.fileId)) throw new JobParamsError("An import names the file to load: fil_ and 24 hex digits.");
  } else if (s?.kind === "export") {
    if (typeof s.storeId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(s.storeId) || typeof s.exportId !== "string" || !EXPORT_ID_RE.test(s.exportId)) {
      throw new JobParamsError("An import from a store names the store and its export.");
    }
  } else {
    throw new JobParamsError("An import loads a file of this store's, or another store's export.");
  }
  if (p.replace === true && s.kind !== "export") throw new JobParamsError("Only a copy from another store loads over what a store holds.");
  return {
    source: s as ImportSource,
    label: typeof p.label === "string" ? p.label.slice(0, 200) : "an export",
    ...(p.replace === true ? { replace: true, restorePoint: typeof p.restorePoint === "string" ? p.restorePoint : null, restorePointAt: typeof p.restorePointAt === "string" ? p.restorePointAt : null } : {}),
  };
}

async function readAll(reader: SqliteFileReader, root: number): Promise<BTreeRow[]> {
  const out: BTreeRow[] = [];
  let cursor: BTreeCursor | null = null;
  do {
    const read: { rows: BTreeRow[]; cursor: BTreeCursor | null } = await reader.read(root, "table", cursor, { rows: 2_000 });
    out.push(...read.rows);
    cursor = read.cursor;
  } while (cursor);
  return out;
}

async function makePlan(ctx: JobContext<ImportParams, ImportState>, found: Located): Promise<{ state: ImportState; plan: ImportPlan; files: ImportFile[] }> {
  const reader = await SqliteFileReader.open(dbSource(ctx.bucket, found.db));
  const schema = await reader.schema();
  const tables: PlannedTable[] = [];
  const objects: PlannedObject[] = [];
  const system: ImportPlan["system"] = [];
  let sequenceRoot: number | null = null;
  for (const e of schema) {
    const lower = e.name.toLowerCase();
    if (passedOver(e.name) || passedOver(e.tableName)) continue;
    if (e.type === "table") {
      if (lower === "sqlite_sequence") {
        sequenceRoot = e.rootPage;
        continue;
      }
      if (SYSTEM.has(e.name)) {
        // A copy that replaces a store's data leaves its people as they are: who may come in is not data.
        const left = ctx.params.replace === true && e.name === "_users";
        if (SYSTEM_LOADED.includes(e.name) && !left && e.rootPage > 0 && e.sql) system.push({ name: e.name, root: e.rootPage, columns: createTableColumns(e.sql) });
        continue;
      }
      if (lower.startsWith("_") || lower.startsWith("sqlite_")) throw refuse(`The file holds a table named ${e.name}, a name a store keeps for itself.`);
      if (!e.sql) throw refuse(`The file's table ${e.name} has no statement.`);
      if (e.rootPage <= 0) throw refuse(`The file's ${e.name} is a virtual table (such as a full-text index), which an import does not load.`);
      tables.push({ name: e.name, root: e.rootPage, format: /\)\s*(?:STRICT\s*,\s*)?WITHOUT\s+ROWID\b/i.test(e.sql) ? "index" : "table", sql: e.sql });
      continue;
    }
    if (SYSTEM.has(e.tableName) || e.tableName.toLowerCase().startsWith("sqlite_")) continue;
    // An index SQLite makes for a table's own constraint has no statement: the table makes it again.
    if (e.sql === null) continue;
    objects.push({ type: e.type as PlannedObject["type"], name: e.name, sql: e.sql });
  }
  system.sort((a, b) => SYSTEM_LOADED.indexOf(a.name) - SYSTEM_LOADED.indexOf(b.name));
  // The files the file lists, each with its bytes.
  const files: ImportFile[] = [];
  const filesTable = system.find((s) => s.name === "_files");
  if (filesTable) {
    const missing: string[] = [];
    for (const r of await readAll(reader, filesTable.root)) {
      const f = named(filesTable.columns, r.values);
      if (typeof f.id !== "string" || typeof f.name !== "string" || f.state !== "ready" || (f.deleted_at !== null && f.deleted_at !== undefined)) continue;
      const bytes = found.files.get(f.id);
      if (!bytes) {
        missing.push(f.name);
        continue;
      }
      files.push({
        id: f.id,
        name: f.name,
        size: bytes.size,
        contentType: typeof f.content_type === "string" ? f.content_type : "application/octet-stream",
        receivedAt: typeof f.received_at === "string" ? f.received_at : new Date(ctx.now()).toISOString(),
        receivedBy: typeof f.received_by === "string" ? f.received_by : ctx.job.by,
        via: typeof f.via === "string" ? f.via : "api",
        batch: typeof f.batch === "string" ? f.batch : null,
        fromKey: bytes.key,
        fromOffset: bytes.offset,
      });
    }
    if (missing.length > 0) throw refuse(`The export lacks the bytes of ${missing.length} of its files (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}).`);
  }
  const sequence = sequenceRoot ? (await readAll(reader, sequenceRoot)).flatMap((r) => (typeof r.values[0] === "string" ? [{ name: r.values[0], seq: Number(r.values[1] ?? 0) }] : [])) : [];
  return {
    state: { phase: "tables", waitingSince: ctx.now(), db: found.db, archive: found.archive, files: files.length, at: 0, cursor: null, upload: null, rows: 0, fileBytes: 0 },
    plan: { tables, objects, system, sequence },
    files,
  };
}

function keepPlan(sql: SqlLike, plan: ImportPlan, files: readonly ImportFile[]): void {
  savePlan(sql, PLAN_TABLE, plan);
  sql.exec(`DROP TABLE IF EXISTS ${FILES_TABLE}`);
  sql.exec(`CREATE TABLE ${FILES_TABLE} (n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, file TEXT NOT NULL, own INTEGER NOT NULL DEFAULT 0)`);
  for (const [i, file] of files.entries()) sql.exec(`INSERT INTO ${FILES_TABLE} (n, id, size, file) VALUES (?, ?, ?, ?)`, i, file.id, file.size, JSON.stringify(file));
}

function emptyState(since: number): ImportState {
  return { phase: "wait", waitingSince: since, db: null, archive: null, files: 0, at: 0, cursor: null, upload: null, rows: 0, fileBytes: 0 };
}

const isUniqueIndex = (o: PlannedObject): boolean => o.type === "index" && /^\s*CREATE\s+UNIQUE\b/i.test(o.sql);

async function run(ctx: JobContext<ImportParams, ImportState>) {
  const sql = ctx.sql;
  const stop = () => ctx.now() >= ctx.deadline - DEADLINE_MARGIN_MS;
  let state = ctx.state;

  if (state === null || state.phase === "wait") {
    const since = state?.waitingSince ?? ctx.now();
    const replace = ctx.params.replace === true;
    const why = replace ? null : notEmpty(sql, ctx.params.source.kind === "file" ? ctx.params.source.fileId : null);
    if (why) throw new StoreError(409, "store_not_empty", `An import loads into an empty store, and ${why}.`);
    // In the same step as that check: from here on, whatever is in the store is this import's to
    // undo. One that replaces has undone nothing until it empties the store, below.
    holdStore(sql, ctx.job.id, "import", !replace);
    const found = await locate(ctx);
    if (found === null) {
      if (ctx.now() - since > IMPORT_WAIT_MS) throw new StoreError(409, "import_source_failed", "The other store's export did not finish within an hour.");
      ctx.commit({ state: emptyState(since), progress: { done: 0, total: null, note: "Waiting for the other store's export" } });
      return { more: true, after: 2_000 } as const;
    }
    if ("failed" in found) throw new StoreError(409, "import_source_failed", `The other store's export failed${found.failed ? `: ${found.failed}` : ""}, so there is nothing to copy.`);
    const made = await makePlan(ctx, found);
    state = made.state;
    ctx.commit({ state, progress: { done: 0, total: null, note: "Making the tables" } }, () => {
      if (replace) {
        clearStore(sql, true, new Date(ctx.now()).toISOString());
        // Marked, not gone: their bytes stay 30 days, as far as a restore reaches.
        sql.exec("UPDATE _files SET deleted_at = ?, deleted_by = ? WHERE state = 'ready' AND deleted_at IS NULL", new Date(ctx.now()).toISOString(), ctx.job.by);
        // The copy brings its own folders. A restore to before it brings these back, as it is (history.ts).
        sql.exec("DELETE FROM _folders");
        holdStore(sql, ctx.job.id, "import", true);
      }
      keepPlan(sql, made.plan, made.files);
      // A file a store copied earlier has the same id and key: its bytes are the store's own, for a restore.
      if (replace) sql.exec(`UPDATE ${FILES_TABLE} SET own = 1 WHERE id IN (SELECT id FROM _files)`);
    });
  }
  const progress = (note: string) => ({ done: state!.rows, total: null, note });
  const plan = loadPlan<ImportPlan>(sql, PLAN_TABLE);

  if (state.phase === "tables") {
    const current = state;
    ctx.commit({ state: current, progress: progress("Loading the rows") }, () => {
      for (const t of plan.tables) create(sql, oneCreate(t.sql, "TABLE", t.name), t.name, "table");
      // Before the rows: a foreign key can point at a unique index, and SQLite refuses the child's
      // rows until it exists. A row's look for its parent uses it too.
      for (const o of plan.objects.filter(isUniqueIndex)) create(sql, oneCreate(o.sql, "INDEX", o.name), o.name, "index");
      sql.exec(`CREATE TABLE IF NOT EXISTS ${PENDING_TABLE} (n INTEGER PRIMARY KEY, tbl TEXT NOT NULL, record BLOB NOT NULL)`);
      plan.tables = parentsFirst(sql, plan.tables);
      savePlan(sql, PLAN_TABLE, plan);
      current.phase = "rows";
    });
  }

  let reader: SqliteFileReader | null = null;
  const open = async () => (reader ??= await SqliteFileReader.open(dbSource(ctx.bucket, state!.db!)));

  while (state.phase === "rows") {
    const current = state;
    if (current.at >= plan.tables.length) {
      ctx.commit({ state: current, progress: progress("Loading the rows") }, () => {
        current.phase = "pending";
        current.at = 0;
      });
      break;
    }
    const table = plan.tables[current.at]!;
    const shape = shapeOf(sql, table);
    const read = await (await open()).read(table.root, table.format, current.cursor, { rows: BATCH_ROWS, bytes: BATCH_BYTES });
    ctx.commit({ state: current, progress: progress(`Loading ${table.name}`) }, () => {
      for (const row of read.rows) {
        // A waiting row is kept as its own record, as many bytes as it had in the file.
        if (!placeRow(sql, table.name, shape, row)) sql.exec(`INSERT INTO ${PENDING_TABLE} (tbl, record) VALUES (?, ?)`, table.name, bindable(encodeRecord([row.rowid, ...row.values])));
      }
      current.rows += read.rows.length;
      current.cursor = read.cursor;
      if (!read.cursor) current.at++;
    });
    if (stop()) return { more: true } as const;
  }

  if (state.phase === "pending") {
    const current = state;
    const waiting = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${PENDING_TABLE}`).one().n);
    if (waiting > 0) {
      // The rows that waited, in one transaction with their keys checked as it ends, so rows that
      // point at each other, or at a row that came later, all go in. One at a time out of the table:
      // a row can be as large as a value may be.
      const shapes = new Map(plan.tables.map((t) => [t.name, shapeOf(sql, t)]));
      const first = String(sql.exec<{ tbl: string }>(`SELECT tbl FROM ${PENDING_TABLE} ORDER BY n LIMIT 1`).one().tbl);
      try {
        ctx.commit({ state: current, progress: progress("Loading the rows that point at others") }, () => {
          sql.exec("PRAGMA defer_foreign_keys = ON");
          for (let after = -1; ; ) {
            const waited = sql.exec<{ n: number; tbl: string; record: ArrayBuffer }>(`SELECT n, tbl, record FROM ${PENDING_TABLE} WHERE n > ? ORDER BY n LIMIT 1`, after).toArray()[0];
            if (!waited) break;
            after = Number(waited.n);
            const [rowid, ...values] = decodeRecord(new Uint8Array(waited.record));
            const table = String(waited.tbl);
            insertRow(sql, table, shapes.get(table)!, { rowid: rowid as number | bigint | null, values });
          }
        });
      } catch (error) {
        if (!/FOREIGN KEY constraint failed/i.test(error instanceof Error ? error.message : String(error))) throw error;
        throw new StoreError(409, "import_broken_links", `Of ${waiting} row${waiting === 1 ? "" : "s"} that waited for ${waiting === 1 ? "the row it points at" : "the rows they point at"}, some point at rows the export does not have, the first in ${first}.`);
      }
    }
    ctx.commit({ state: current, progress: progress("Making the indexes, views and triggers") }, () => {
      sql.exec(`DROP TABLE IF EXISTS ${PENDING_TABLE}`);
      current.phase = "objects";
    });
  }

  if (state.phase === "objects") {
    const current = state;
    const kinds = { index: "INDEX", view: "VIEW", trigger: "TRIGGER" } as const;
    ctx.commit({ state: current, progress: progress("Bringing the files") }, () => {
      // Indexes, then views (in the file's order, so one a view reads comes first), then triggers.
      for (const type of ["index", "view", "trigger"] as const) {
        for (const o of plan.objects.filter((x) => x.type === type && !isUniqueIndex(x))) create(sql, oneCreate(o.sql, kinds[type], o.name), o.name, type);
      }
      current.phase = "files";
      current.at = 0;
    });
  }

  while (state.phase === "files") {
    const current = state;
    if (current.at >= current.files) {
      ctx.commit({ state: current, progress: progress("Bringing the store's records") }, () => {
        current.phase = "system";
        current.at = 0;
        current.cursor = null;
      });
      break;
    }
    await copyFilePart(ctx, current);
    ctx.commit({ state: current, progress: progress(`Bringing the files (${current.at} of ${current.files})`) });
    if (stop()) return { more: true } as const;
  }

  while (state.phase === "system") {
    const current = state;
    if (current.at >= plan.system.length) {
      ctx.commit({ state: current, progress: progress("Finishing") }, () => {
        current.phase = "finish";
      });
      break;
    }
    const sys = plan.system[current.at]!;
    const read = await (await open()).read(sys.root, "table", current.cursor, { rows: BATCH_ROWS, bytes: BATCH_BYTES });
    // A view is in the catalog too: a program's view is made again each time a table it reads is swapped.
    const tables = new Set([...plan.tables.map((t) => t.name), ...plan.objects.filter((o) => o.type === "view").map((o) => o.name)]);
    ctx.commit({ state: current, progress: progress("Bringing the store's records") }, () => {
      loadSystemRows(sql, sys.name, sys.columns, read.rows, ctx.job.storeId, tables, sizesOf(sql, read.rows, sys));
      current.cursor = read.cursor;
      if (!read.cursor) current.at++;
    });
    if (stop()) return { more: true } as const;
  }

  // AUTOINCREMENT's counters, the archive gone, the hold gone, and one event in the history.
  const done = state;
  if (done.archive) await ctx.bucket.delete(done.archive.key).catch(() => undefined);
  const result: ImportResult = {
    tables: plan.tables.length,
    rows: done.rows,
    files: done.files,
    fileBytes: done.fileBytes,
    migrations: Number(sql.exec<{ n: number }>("SELECT count(*) AS n FROM _migrations").one().n),
    users: Number(sql.exec<{ n: number }>("SELECT count(*) AS n FROM _users").one().n),
  };
  ctx.commit({ state: done, progress: { done: done.rows, total: done.rows, note: "Done" } }, () => {
    const known = new Set(plan.tables.map((t) => t.name));
    for (const c of plan.sequence.filter((x) => known.has(x.name))) {
      if (sql.exec("SELECT 1 FROM sqlite_sequence WHERE name = ?", c.name).toArray().length === 0) sql.exec("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", c.name, c.seq);
      else sql.exec("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?", c.seq, c.name);
    }
    if (done.archive) sql.exec("DELETE FROM _files WHERE id = ?", done.archive.fileId);
    // Every file it brought in a folder: a file an export from before folders listed goes into Uploads.
    settleFolders({ sql, nowIso: () => new Date(ctx.now()).toISOString(), newId: (prefix) => `${prefix}_${randomHex(12)}` });
    sql.exec(`DROP TABLE IF EXISTS ${FILES_TABLE}`);
    sql.exec(`DROP TABLE IF EXISTS ${PLAN_TABLE}`);
    // The catalog counts each table's rows afresh, at its next stats read.
    sql.exec("UPDATE _tables SET rows = NULL");
    sql.exec("DELETE FROM _meta WHERE key = ?", HOLD_KEY);
    sql.exec(
      "INSERT INTO _history (id, at, kind, by_sub, note, restore_point, ref) VALUES (?, ?, 'files', ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      `his_import_${ctx.job.id}`,
      ctx.params.restorePointAt ?? new Date(ctx.now()).toISOString(),
      ctx.job.by,
      `${ctx.params.replace ? "Replaced this store's data with" : "Imported"} ${result.tables} table${result.tables === 1 ? "" : "s"}, ${result.rows} row${result.rows === 1 ? "" : "s"} and ${result.files} file${result.files === 1 ? "" : "s"} from ${ctx.params.label}`,
      // The history's Restore to Here on the event before this one goes to this point: back to before the copy.
      ctx.params.restorePoint ?? null,
      ctx.job.id,
    );
  });
  return { result };
}

/** One part of the next file (or a whole small file) into this store's place for it. */
async function copyFilePart(ctx: JobContext<ImportParams, ImportState>, state: ImportState): Promise<void> {
  const file = JSON.parse(String(ctx.sql.exec<{ file: string }>(`SELECT file FROM ${FILES_TABLE} WHERE n = ?`, state.at).one().file)) as ImportFile;
  const key = fileKey(ctx.job.storeId, file.id, file.name);
  const bytes = objectSource(ctx.bucket, file.fromKey, file.fromOffset, file.size);
  // The object carries its row, as an upload's does (files.ts), so a restore can list it again.
  const options = {
    httpMetadata: { contentType: file.contentType },
    customMetadata: { fileId: file.id, name: file.name, size: String(file.size), receivedAt: file.receivedAt, receivedBy: file.receivedBy, via: file.via, ...(file.batch ? { batch: file.batch } : {}) },
  };
  if (file.size <= PART_BYTES) {
    await ctx.bucket.put(key, await bytes.read(0, file.size), options);
    state.fileBytes += file.size;
    state.at++;
    return;
  }
  if (!state.upload) state.upload = { id: (await ctx.bucket.createMultipartUpload(key, options)).uploadId, parts: [] };
  const upload = ctx.bucket.resumeMultipartUpload(key, state.upload.id);
  const n = state.upload.parts.length + 1;
  const offset = (n - 1) * PART_BYTES;
  const last = offset + PART_BYTES >= file.size;
  const finish = () => {
    state.fileBytes += file.size;
    state.upload = null;
    state.at++;
  };
  // A chunk can stop after the bucket put the parts together and before the job noted it: the
  // upload is closed then, and the whole file is there.
  if (last && (await ctx.bucket.head(key))?.size === file.size) {
    finish();
    return;
  }
  const part = await upload.uploadPart(n, await bytes.read(offset, Math.min(PART_BYTES, file.size - offset)));
  state.upload.parts.push({ n, etag: part.etag });
  if (last) {
    await upload.complete(state.upload.parts.map((p) => ({ partNumber: p.n, etag: p.etag })));
    finish();
  }
}

export const importHandler: JobHandler<ImportParams, ImportState, ImportResult> = {
  kind: IMPORT_KIND,
  parse: parseParams,
  run,
  async failed(ctx) {
    // Refused before it began to fill the store, it has nothing of its own to undo: what the store
    // holds now is someone else's.
    if (isLoading(ctx.sql, ctx.job.id)) await resetAfterFailedImport(ctx);
    else releaseHold(ctx.sql, ctx.job.id);
  },
};

/**
 * Empties the store of its tables and of what describes them, its schema's history included. The
 * store's jobs, history and files stay. With `keepPeople` its user list and sessions stay too: who
 * may come in is not data (history.ts). A parked table's files stay for the restore window, and
 * then go, as a version a newer one replaced does (`purgeParked`).
 */
function clearStore(sql: SqlLike, keepPeople: boolean, now: string): void {
  // One table's rows may point at another's: the drops are checked together, when they are all done.
  sql.exec("PRAGMA defer_foreign_keys = ON");
  for (const row of sql.exec<{ type: string; name: string }>("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')").toArray()) {
    sql.exec(`DROP ${String(row.type).toUpperCase()} IF EXISTS ${ident(String(row.name))}`);
  }
  for (const row of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()) {
    const name = String(row.name);
    if (SYSTEM.has(name) || /^(sqlite_|_cf_|__miniflare)/i.test(name)) continue;
    sql.exec(`DROP TABLE IF EXISTS ${ident(name)}`);
  }
  for (const table of ["_tables", "_columns", "_migrations", "__drizzle_migrations", "_fixes", "_deltas", "_delta_rows", "_delta_reads", "_row_hashes", "_pushed", "_push_writes", ...(keepPeople ? [] : ["_users", "_sessions"])]) {
    sql.exec(`DELETE FROM ${ident(table)}`);
  }
  sql.exec("UPDATE _parked SET superseded_at = ? WHERE superseded_at IS NULL", now);
  // A write's record goes with its memory (jobs/push.ts), so the next write into each table asks a
  // person first, as a first write does; a preview's goes with its table. Each write's rows go too,
  // and the record of what it was: an undo takes back only what this store still remembers writing.
  // The code page set for files of a name goes with the files, which the copy brings its own of.
  sql.exec("DELETE FROM _meta WHERE key LIKE 'shape:%' OR key LIKE 'check:%' OR key LIKE 'answers:%' OR key LIKE 'push:%' OR key LIKE 'push-preview:%' OR key LIKE 'push-write:%' OR key LIKE 'code^_page:%' ESCAPE '^'");
}

/**
 * After a failed import: the store empty again, as it was, with the archive it was sent kept to try
 * again. It removes what this import brought, and nothing the store kept from before (a file
 * deleted earlier has its 30 days). One that replaced a store's data leaves it empty too, with its
 * people, and whoever asked puts it back from the restore point it took (deploy/copy-data.ts).
 */
async function resetAfterFailedImport(ctx: JobContext<ImportParams, ImportState>): Promise<void> {
  const sql = ctx.sql;
  const listed = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", FILES_TABLE).toArray().length > 0;
  const brought = listed ? sql.exec<{ id: string; name: string }>(`SELECT id, json_extract(file, '$.name') AS name FROM ${FILES_TABLE} WHERE own = 0`).toArray() : [];
  ctx.commit({ state: emptyState(ctx.now()), progress: { done: 0, total: null, note: "Failed; the store is empty again" } }, () => {
    if (listed) sql.exec(`DELETE FROM _files WHERE id IN (SELECT id FROM ${FILES_TABLE} WHERE own = 0)`);
    clearStore(sql, ctx.params.replace === true, new Date(ctx.now()).toISOString());
    // The folders this import brought, and none that holds a file the store keeps (the archive it was sent).
    sql.exec("DELETE FROM _folders WHERE id NOT IN (SELECT folder_id FROM _files WHERE deleted_at IS NULL AND folder_id IS NOT NULL)");
    sql.exec("DELETE FROM _meta WHERE key = ?", HOLD_KEY);
  });
  const keys = brought.map((f) => fileKey(ctx.job.storeId, String(f.id), String(f.name)));
  for (let i = 0; i < keys.length; i += 1000) await ctx.bucket.delete(keys.slice(i, i + 1000));
}
