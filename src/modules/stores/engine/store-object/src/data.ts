// A store's tables in Design's Data view shapes: the catalog, a page of rows, the rows that point
// at a row (Used By), and where a row stands in its table's order. The rules follow the Data
// view's own reader for SQLite (the api's services/design-data/read-tool.ts): which
// column names a row, which columns are quiet, a cell cut at CELL_MAX, links from foreign keys.
// A store adds each table's kind, version, group and what made it, and each column's original
// type and how full it is.

import { FILE_COLUMN, HASH_COLUMN, KEY_COLUMN, ROW_COLUMN } from "../../store-readers/src/index.js";
import { DATABASE, type Catalog, type CatalogColumn, type CatalogPackedColumn, type CatalogTable, type Locate, type LocateBody, type RowFilter, type RowFilterOp, type Rows, type RowsBody, type UsedBy, type UsedByBody } from "./types.js";
import { StoreError, type StoreCore } from "./core.js";
import { parkedWords } from "./park-time.js";
import { isHiddenTable, PROGRAM_VERSION_RE, SYSTEM_TABLES, type SqlLike, type StoreSqlValue } from "./sql.js";

/**
 * The columns LOAD and a pull write into a program table for the store's own bookkeeping: where a
 * row came from (`_file`, `_row`), its name across loads (`_key`) and a hash of its values
 * (`_hash`). A client that draws a store's tables reads the same list from the wire contract it
 * speaks, and a host that keeps both checks at compile time that the two are the same.
 */
export const OWN_COLUMNS = [FILE_COLUMN, ROW_COLUMN, KEY_COLUMN, HASH_COLUMN] as const;

/** The longest cell a page carries; a longer one is marked in `cut`. */
export const CELL_MAX = 1_000;
/** The longest cell a whole row's read carries (`whole`, one row): the row's panel shows long text
 *  in full. `DESIGN_DATA_WHOLE_CELL_MAX` in the wire contract says the same. */
export const WHOLE_CELL_MAX = 100_000;
/** The rows of a table its columns' profile is read from. */
export const SAMPLE_ROWS = 5_000;
/** The columns one profile query reads: two counts each and the row count, within workerd's 100. */
const PROFILE_COLUMNS = 49;
/** A Used By count stops here and says "more". */
export const REF_COUNT_MAX = 10_000;
/** A filtered page's total is counted up to here; past it the total is unknown. */
export const TOTAL_COUNT_MAX = 1_000_000;

const LABEL_NAMES = ["public_id", "legal_name", "name", "full_name", "display_name", "display", "title", "subject", "label", "slug", "account_login", "login", "username", "user_name", "email", "key", "code", "number", "version", "kind", "type", "status"];
const NOISE_WORDS = /(^|_)(hash|hashed|token|sha1|sha256|md5|digest|salt|nonce|signature|password|passwd|secret|ip|user_agent)(_|$)/;
const NOISE_TYPES = /^(text|character|citext|varchar|clob|uuid|bytea|blob|inet|cidr)/i;
const SYSTEM = new Set<string>(SYSTEM_TABLES);

// Backticks, never double quotes: SQLite reads a double-quoted name that matches no column as text
// (sql.ts), so a stale column name in a request would come back as that text in every row.
const ident = (name: string) => `\`${name.replace(/`/g, "``")}\``;
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();

export class StoreDataError extends StoreError {
  constructor(status: number, message: string) {
    super(status, status === 404 ? "not_found" : "bad_request", message);
    this.name = "StoreDataError";
  }
}

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

/** The program tables parked in the store's files (park.ts), with the columns their files hold. */
function parkedTables(sql: SqlLike): { name: string; rows: number; bytes: number; at: string; columns: { name: string; type: string; notnull: boolean }[] }[] {
  return sql
    .exec<{ name: string; rows: number; bytes: number; at: string; columns: string }>(
      "SELECT t.name AS name, p.rows AS rows, p.bytes AS bytes, p.at AS at, p.columns AS columns FROM _tables AS t JOIN _parked AS p ON p.id = t.parked WHERE t.kind = 'program'",
    )
    .toArray()
    .map((r) => {
      let columns: { name: string; type: string; notnull: boolean }[] = [];
      try {
        columns = JSON.parse(String(r.columns)) as typeof columns;
      } catch {
        columns = [];
      }
      return { name: String(r.name), rows: Number(r.rows), bytes: Number(r.bytes), at: String(r.at), columns };
    });
}

/** The tables the catalog and the readers show: every table but SQLite's, the platform's, and old versions. */
function visibleTables(sql: SqlLike): { name: string; type: string; sql: string | null }[] {
  return sql
    .exec<{ name: string; type: string; sql: string | null }>("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
    .toArray()
    .map((r) => ({ name: String(r.name), type: String(r.type), sql: r.sql === null ? null : String(r.sql) }))
    .filter((t) => !isHiddenTable(t.name) && !PROGRAM_VERSION_RE.test(t.name));
}

function columnsOf(sql: SqlLike, table: string): ColumnInfo[] {
  return sql.exec<Record<string, StoreSqlValue>>(`PRAGMA table_info(${ident(table)})`).toArray().map((c) => ({
    cid: Number(c.cid),
    name: String(c.name),
    type: String(c.type ?? ""),
    notnull: Number(c.notnull),
    pk: Number(c.pk),
  }));
}

/**
 * SQLite answers BLOB for a view's column whose source column has no declared type, such as one a
 * SHAPE made with `trim(…)` (CREATE TABLE … AS leaves those untyped), though its values are text:
 * the Data view would show each value as bytes. Such a column takes the storage class of its first
 * value among the view's first SAMPLE_ROWS rows, or none (read as text) when they hold no value.
 */
export function retypeViewColumns(sql: SqlLike, view: string, columns: ColumnInfo[]): void {
  const untyped = columns.filter((c) => /^blob$/i.test(c.type));
  const TYPES: Record<string, string> = { integer: "INTEGER", real: "REAL", blob: "BLOB" };
  // workerd answers at most 100 columns a statement.
  for (let i = 0; i < untyped.length; i += 90) {
    const part = untyped.slice(i, i + 90);
    const firsts = part.map((c, j) => `(SELECT typeof(v) FROM (SELECT ${ident(c.name)} AS v FROM ${ident(view)} LIMIT ${SAMPLE_ROWS}) WHERE v IS NOT NULL LIMIT 1) AS t${j}`);
    const row = sql.exec<Record<string, StoreSqlValue>>(`SELECT ${firsts.join(", ")}`).one();
    part.forEach((c, j) => {
      c.type = TYPES[String(row[`t${j}`])] ?? "";
    });
  }
}

function keyOf(columns: ColumnInfo[]): string[] {
  return columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
}

/** The table a request names, as the catalog shows it; refused when it is not one, or is parked. */
function tableNamed(sql: SqlLike, database: string, table: string): { name: string; columns: ColumnInfo[] } {
  if (database !== DATABASE) throw new StoreDataError(404, `A store has one database, "${DATABASE}".`);
  const found = visibleTables(sql).find((t) => t.name === table);
  if (!found && sql.exec("SELECT 1 FROM _tables WHERE name = ? AND kind = 'program' AND parked IS NOT NULL", table).toArray().length) {
    throw new StoreError(409, "table_parked", parkedWords(table));
  }
  if (!found) throw new StoreDataError(404, `This store has no table "${table}".`);
  const columns = columnsOf(sql, found.name);
  if (columns.length === 0) throw new StoreDataError(404, `This store has no table "${table}".`);
  // A page reads a BLOB column's length, not its bytes: a view's untyped column is no blob.
  if (found.type === "view") retypeViewColumns(sql, found.name, columns);
  return { name: found.name, columns };
}

function indexedColumns(sql: SqlLike, table: string, columns: ColumnInfo[]): Set<string> {
  const out = new Set<string>();
  for (const index of sql.exec<{ name: string }>(`PRAGMA index_list(${ident(table)})`).toArray()) {
    const first = sql.exec<{ seqno: number; name: string | null }>(`PRAGMA index_info(${ident(String(index.name))})`).toArray().find((x) => Number(x.seqno) === 0);
    if (first?.name) out.add(String(first.name));
  }
  const keys = columns.filter((c) => c.pk > 0);
  if (keys.length === 1 && /^integer$/i.test(keys[0]!.type)) out.add(keys[0]!.name);
  return out;
}

/** The values a CHECK in a table's own CREATE allows: col IN ('a', 'b'). */
function allowedValues(createSql: string | null, column: string): string[] | null {
  if (!createSql) return null;
  const escaped = column.replace(/[.*+?^$|()[\]{}\\]/g, "\\$&");
  const m = createSql.match(new RegExp(`(?:^|[^\\w$"\`\\[])["\`\\[]?${escaped}["\`\\]]?\\s+IN\\s*\\(([^)]*)\\)`, "i"));
  if (!m) return null;
  const values = [...m[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1]!.replace(/''/g, "'"));
  return values.length > 0 ? values : null;
}

interface Profile {
  rows: number;
  nonNull: number[];
  distinct: number[];
}

/** How full and how varied each column is, over the table's first SAMPLE_ROWS rows. */
function profileOf(sql: SqlLike, table: string, columns: ColumnInfo[]): Profile {
  if (columns.length === 0) return { rows: 0, nonNull: [], distinct: [] };
  const profile: Profile = { rows: 0, nonNull: [], distinct: [] };
  // workerd's SQLite answers at most 100 columns a query, and each column takes two: a table of 50
  // columns or more is read PROFILE_COLUMNS at a time, or it would be left out of the catalog.
  for (let at = 0; at < columns.length; at += PROFILE_COLUMNS) {
    const part = columns.slice(at, at + PROFILE_COLUMNS);
    const parts = ["count(*) AS n"];
    part.forEach((c, i) => parts.push(`count(${ident(c.name)}) AS n${i}`, `count(DISTINCT substr(CAST(${ident(c.name)} AS TEXT), 1, 256)) AS d${i}`));
    const row = sql
      .exec<Record<string, number>>(`SELECT ${parts.join(", ")} FROM (SELECT ${part.map((c) => ident(c.name)).join(", ")} FROM ${ident(table)} LIMIT ${SAMPLE_ROWS})`)
      .one();
    profile.rows = Number(row.n);
    part.forEach((_, i) => {
      profile.nonNull.push(Number(row[`n${i}`]));
      profile.distinct.push(Number(row[`d${i}`]));
    });
  }
  return profile;
}

function noisy(column: { name: string; type: string }): boolean {
  const name = snake(column.name);
  if (/^deleted_?at$/.test(name)) return true;
  return NOISE_WORDS.test(name) && (!column.type || NOISE_TYPES.test(column.type));
}

function labelOf(columns: ColumnInfo[], key: string[], profile: Profile): string | null {
  const byName = new Map(columns.map((c, i) => [snake(c.name), { c, i }]));
  for (const wanted of LABEL_NAMES) {
    const hit = byName.get(wanted);
    if (!hit || key.includes(hit.c.name)) continue;
    const nonNull = profile.nonNull[hit.i] ?? 0;
    if (nonNull === 0) continue;
    const distinct = profile.distinct[hit.i] ?? 0;
    if (nonNull > 20 && distinct * 2 < nonNull) continue;
    return hit.c.name;
  }
  return null;
}

interface TableMeta {
  kind: "program" | "managed";
  version: number;
  grp: string | null;
  made_run: string | null;
  made_step: string | null;
  made_job: string | null;
  made_at: string | null;
  rows: number | null;
  comment: string | null;
  /** A LOAD table's second name: its name in full, where LOAD cut it (front-door.ts). */
  full_name?: string | null;
}

interface ColumnMeta {
  original_type: string | null;
  filled: number | null;
  distinct_n: number | null;
  comment: string | null;
  /** `_extra` for a column LOAD packed there, which SQL reads by its name (front-door.ts). */
  packed_in?: string | null;
}

export function catalog(core: StoreCore): Catalog {
  const started = core.deps.now();
  const sql = core.sql;
  const metaByName = new Map<string, TableMeta>();
  for (const row of sql.exec<Record<string, StoreSqlValue>>("SELECT * FROM _tables").toArray()) {
    metaByName.set(String(row.name), row as unknown as TableMeta);
  }
  const columnMeta = new Map<string, ColumnMeta>();
  // The columns LOAD packed into `_extra`, by table, in the file's order.
  const packedBy = new Map<string, CatalogPackedColumn[]>();
  for (const row of sql.exec<Record<string, StoreSqlValue>>("SELECT * FROM _columns ORDER BY rowid").toArray()) {
    columnMeta.set(`${String(row.tbl)}\u0000${String(row.name)}`, row as unknown as ColumnMeta);
    if (row.packed_in === null || row.packed_in === undefined) continue;
    const list = packedBy.get(String(row.tbl)) ?? [];
    list.push({ name: String(row.name), ...(row.original_type ? { originalType: String(row.original_type) } : {}) });
    packedBy.set(String(row.tbl), list);
  }
  // A LOAD table's second name, and the columns SQL reads from its `_extra`.
  const namedAs = (name: string): Pick<CatalogTable, "fullName" | "packed"> => {
    const full = metaByName.get(name)?.full_name;
    const packed = packedBy.get(name);
    return { ...(full ? { fullName: String(full) } : {}), ...(packed?.length ? { packed } : {}) };
  };
  // Each program table's newest change (deltas.ts): a change in place keeps the version, so a
  // reader that keeps pages of rows keys them by both. A change still open (whole and kept) is not
  // counted yet: pages read while it runs are kept under the change before it, and its close
  // gives the table a new number.
  const changes = new Map<string, number>();
  for (const row of sql.exec<{ tbl: string; c: number }>("SELECT tbl, max(change) AS c FROM _deltas WHERE NOT (whole = 1 AND kept = 1) GROUP BY tbl").toArray()) {
    changes.set(String(row.tbl), Number(row.c));
  }
  const tables: CatalogTable[] = [];
  const all = visibleTables(sql);
  const byLower = new Map(all.map((t) => [t.name.toLowerCase(), t.name]));
  for (const t of all) {
    const table = catalogTable(sql, t, metaByName, columnMeta, byLower);
    if (!table) continue;
    const change = table.kind === "program" ? changes.get(table.name) : undefined;
    tables.push({ ...table, ...(t.type === "view" ? { view: true } : {}), ...(change !== undefined ? { change } : {}), ...(table.kind === "program" ? namedAs(table.name) : {}) });
  }
  // A parked table is not in the database: its columns and rows are in its parked files' record.
  for (const p of parkedTables(sql)) {
    if (byLower.has(p.name.toLowerCase())) continue;
    const meta = metaByName.get(p.name);
    tables.push({
      database: DATABASE,
      name: p.name,
      count: p.rows,
      estimated: false,
      ...(meta?.comment ? { comment: meta.comment } : {}),
      key: [],
      label: null,
      softDelete: false,
      quiet: false,
      kind: "program",
      version: meta ? Number(meta.version) : 1,
      group: meta?.grp ?? null,
      madeBy: meta?.made_at ? { runId: meta.made_run, step: meta.made_step, job: meta.made_job, at: meta.made_at } : null,
      columns: p.columns.map((c) => {
        const cm = columnMeta.get(`${p.name}\u0000${c.name}`);
        const column: CatalogColumn = {
          name: c.name,
          type: (c.type || "text").toLowerCase(),
          nullable: !c.notnull,
          quiet: c.name.startsWith("_") || noisy({ name: c.name, type: c.type }),
        };
        if (cm?.original_type) column.originalType = cm.original_type;
        if (cm?.comment) column.comment = cm.comment;
        if (cm?.filled !== null && cm?.filled !== undefined) column.filled = cm.filled;
        if (cm?.distinct_n !== null && cm?.distinct_n !== undefined) column.distinct = cm.distinct_n;
        return column;
      }),
      parked: { at: p.at, rows: p.rows, bytes: p.bytes },
      ...(changes.has(p.name) ? { change: changes.get(p.name)! } : {}),
      ...namedAs(p.name),
    });
  }
  tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    databases: [{ name: DATABASE, engine: "sqlite" }],
    tables,
    bytes: sql.databaseSize,
    ms: core.deps.now() - started,
  };
}

/** One table or view of the catalog; null when it has no columns or cannot be read (a view whose table is gone). */
function catalogTable(
  sql: StoreCore["sql"],
  t: { name: string; type: string; sql: string | null },
  metaByName: Map<string, TableMeta>,
  columnMeta: Map<string, ColumnMeta>,
  byLower: Map<string, string>,
): CatalogTable | null {
  try {
    return readCatalogTable(sql, t, metaByName, columnMeta, byLower);
  } catch {
    return null;
  }
}

function readCatalogTable(
  sql: StoreCore["sql"],
  t: { name: string; type: string; sql: string | null },
  metaByName: Map<string, TableMeta>,
  columnMeta: Map<string, ColumnMeta>,
  byLower: Map<string, string>,
): CatalogTable | null {
  {
    const columns = columnsOf(sql, t.name);
    if (columns.length === 0) return null;
    if (t.type === "view") retypeViewColumns(sql, t.name, columns);
    const system = SYSTEM.has(t.name);
    const meta = metaByName.get(t.name);
    const key = keyOf(columns);
    const indexed = t.type === "table" ? indexedColumns(sql, t.name, columns) : new Set<string>();
    const foreign = t.type === "table" ? sql.exec<Record<string, StoreSqlValue>>(`PRAGMA foreign_key_list(${ident(t.name)})`).toArray() : [];
    const profile = profileOf(sql, t.name, columns);
    let count: number;
    let estimated = false;
    if (meta?.rows !== null && meta?.rows !== undefined) count = Number(meta.rows);
    else if (profile.rows < SAMPLE_ROWS) count = profile.rows;
    else {
      count = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(t.name)}`).one().n);
    }
    const label = labelOf(columns, key, profile);
    const storeColumns: CatalogColumn[] = columns.map((c, i) => {
      const cm = columnMeta.get(`${t.name}\u0000${c.name}`);
      const nonNull = profile.nonNull[i] ?? 0;
      const distinct = profile.distinct[i] ?? 0;
      const column: CatalogColumn = {
        name: c.name,
        type: (c.type || "text").toLowerCase(),
        nullable: c.notnull === 0 && c.pk === 0,
        quiet: (key.includes(c.name) && label !== null) || noisy({ name: c.name, type: c.type }) || nonNull === 0 || (distinct === 1 && nonNull > 1),
      };
      const values = allowedValues(t.sql, c.name);
      if (values) column.values = values;
      if (indexed.has(c.name)) column.indexed = true;
      const fks = foreign.filter((f) => String(f.from) === c.name);
      const fk = fks.find((f) => foreign.filter((g) => g.id === f.id).length === 1);
      if (fk) {
        const target = byLower.get(String(fk.table).toLowerCase());
        if (target) {
          const targetColumns = columnsOf(sql, target);
          const to = fk.to === null || fk.to === undefined ? (keyOf(targetColumns).length === 1 ? keyOf(targetColumns)[0] : undefined) : targetColumns.find((x) => x.name.toLowerCase() === String(fk.to).toLowerCase())?.name;
          if (to) column.link = { database: DATABASE, table: target, column: to, via: "foreign_key" };
        }
      }
      if (cm?.original_type) column.originalType = cm.original_type;
      if (cm?.comment) column.comment = cm.comment;
      column.filled = cm?.filled ?? (profile.rows > 0 ? nonNull / profile.rows : 0);
      column.distinct = cm?.distinct_n ?? distinct;
      return column;
    });
    return {
      database: DATABASE,
      name: t.name,
      count,
      estimated,
      ...(meta?.comment ? { comment: meta.comment } : {}),
      key,
      label,
      softDelete: columns.some((c) => /^deleted_?at$/i.test(c.name)),
      quiet: system,
      kind: system ? "system" : (meta?.kind ?? "managed"),
      version: meta ? Number(meta.version) : 1,
      group: meta?.grp ?? null,
      madeBy: meta?.made_at ? { runId: meta.made_run, step: meta.made_step, job: meta.made_job, at: meta.made_at } : null,
      columns: storeColumns,
    };
  }
}

/** The keys a page asks to be sorted by: `sorts`, else the one `sort` an older client sends. */
export function sortsOf(body: Pick<RowsBody, "sort" | "sorts">): NonNullable<RowsBody["sorts"]> {
  if (body.sorts && body.sorts.length > 0) return body.sorts;
  return body.sort ? [body.sort] : [];
}

/** The ORDER BY of a page; empty when nothing orders it (a view with no key and no sort). */
function orderOf(table: string, columns: ColumnInfo[], key: string[], sorts: NonNullable<RowsBody["sorts"]>, isView: boolean): string {
  const t = ident(table);
  const order: string[] = [];
  const sorted = new Set<string>();
  for (const sort of sorts) {
    if (!columns.some((c) => c.name === sort.column)) throw new StoreDataError(400, `This table has no column "${sort.column}".`);
    if (sorted.has(sort.column)) continue;
    sorted.add(sort.column);
    order.push(`${t}.${ident(sort.column)} ${sort.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`);
  }
  if (sorted.size === 0) {
    const newest = columns.find((c) => /^(created_at|createdat|inserted_at)$/i.test(c.name));
    if (newest) order.push(`${t}.${ident(newest.name)} DESC NULLS LAST`);
  }
  for (const k of key) if (!sorted.has(k)) order.push(`${t}.${ident(k)} ASC`);
  // A view has no rowid: it keeps the order its own query gives.
  if (key.length === 0 && !isView) order.push(`${t}.rowid ASC`);
  return order.length > 0 ? ` ORDER BY ${order.join(", ")}` : "";
}

function isView(sql: StoreCore["sql"], name: string): boolean {
  return sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?", name).toArray().length > 0;
}

// ── Filters ─────────────────────────────────────────────────────────────────
//
// What each operator keeps, with T(c) the column's value as text, as a page shows it:
//   is            T(c) is the value, exactly
//   is_not        the cell is empty, or T(c) is not the value
//   contains, starts_with, ends_with
//                 T(c) holds the value, starts or ends with it, in any letter case (A to Z)
//   not_contains  the cell is empty, or T(c) does not hold the value
//   gt gte lt lte the cell is a number (a number, or text that is a plain number), compared with
//                 the value as numbers
//   on before after
//                 the cell starts with a day as ISO writes it (2026-11-18), on, before or after the
//                 value's day
//   is_true is_false
//                 1, true, t, yes or y; 0, false, f, no or n, in any letter case
//   empty         no value, or empty text; not_empty is the rest
// A search keeps the rows where any text column holds the words, in any letter case.

/** The most filters one page takes. */
export const FILTERS_MAX = 12;
/** The longest search over a table's text columns. */
export const SEARCH_MAX = 200;

const FILTER_OPS: ReadonlySet<string> = new Set<RowFilterOp>(["is", "is_not", "contains", "not_contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte", "on", "before", "after", "is_true", "is_false", "empty", "not_empty"]);
const NO_VALUE: ReadonlySet<string> = new Set<RowFilterOp>(["is_true", "is_false", "empty", "not_empty"]);
const COMPARED: ReadonlyMap<string, string> = new Map([
  ["gt", ">"],
  ["gte", ">="],
  ["lt", "<"],
  ["lte", "<="],
  ["before", "<"],
  ["after", ">"],
  ["on", "="],
]);
/** A plain number, as a filter's value and as text a number filter reads as one. */
const NUMBER = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The store's own columns a search passes over: a row's name across loads and its hash hold no words. */
const NOT_SEARCHED: ReadonlySet<string> = new Set([KEY_COLUMN, HASH_COLUMN]);

/** A column as a filter reads it: its name and the type its table declares. */
export interface FilterColumn {
  name: string;
  type: string;
}

/** The columns of a table with their declared types, for `whereOf`. */
export function filterColumns(sql: SqlLike, table: string): FilterColumn[] {
  return columnsOf(sql, table).map((c) => ({ name: c.name, type: c.type }));
}

/** The filters a page asks for: `filters`, else the one `filter` an older client sends (Linked
 *  from), read as `is`, or as `empty` for a null value. */
export function filtersOf(body: { filter?: RowsBody["filter"]; filters?: RowsBody["filters"] }): RowFilter[] {
  if (Array.isArray(body.filters) && body.filters.length > 0) return body.filters;
  if (!body.filter || typeof body.filter !== "object") return [];
  return [body.filter.value === null ? { column: body.filter.column, op: "empty" } : { column: body.filter.column, op: "is", value: body.filter.value }];
}

/**
 * Words as a SQL string literal, a quote doubled. The search reads every text column with one copy
 * of its words in the statement rather than a bound value per column: a store's statement takes at
 * most 100 bound values, and a table may have more text columns than that.
 */
const literalOf = (words: string): string => `'${words.replace(/\u0000/g, "").replace(/'/g, "''")}'`;

/** A day as ISO writes it, when it is one: 2026-02-30 is not. */
function dayOf(value: string): string | null {
  const v = value.trim();
  if (!DAY.test(v)) return null;
  const at = Date.parse(`${v}T00:00:00Z`);
  return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== v ? null : v;
}

/** A column a search reads: one whose type keeps text (CHAR, CLOB or TEXT), or one with no type. */
const keepsText = (type: string): boolean => type === "" || /char|clob|text/i.test(type);

/**
 * The WHERE of a page of rows, without the word: every filter and the search, on the columns of
 * `qualifier` (a table's quoted name, or a query's alias), with the values as parameters in the
 * order they stand. Null when nothing narrows the rows. A column is named only after it is found in
 * `columns`; an unknown column or operator, a missing value, and a value that is not a number or a
 * day are refused with a 400.
 */
export function whereOf(qualifier: string, columns: readonly FilterColumn[], body: { filter?: RowsBody["filter"]; filters?: RowsBody["filters"]; search?: RowsBody["search"] }): { sql: string | null; params: StoreSqlValue[] } {
  const filters = filtersOf(body);
  if (filters.length > FILTERS_MAX) throw new StoreDataError(400, `A page takes at most ${FILTERS_MAX} filters.`);
  const search = typeof body.search === "string" ? body.search.trim() : "";
  if (search.length > SEARCH_MAX) throw new StoreDataError(400, `A search is at most ${SEARCH_MAX} characters.`);
  const parts: string[] = [];
  const params: StoreSqlValue[] = [];
  for (const filter of filters) {
    // The review's rows reach here as the page sent them: nothing has read their shape yet.
    if (typeof filter !== "object" || filter === null) throw new StoreDataError(400, "A filter names a column and an operator.");
    const column = columns.find((c) => c.name === filter.column);
    if (!column) throw new StoreDataError(400, `This table has no column "${String(filter.column)}".`);
    const op = String(filter.op);
    if (!FILTER_OPS.has(op)) throw new StoreDataError(400, `A filter has no operator "${op}".`);
    const value = typeof filter.value === "string" ? filter.value : null;
    if (!NO_VALUE.has(op) && (value === null || value === "")) throw new StoreDataError(400, `A filter on "${column.name}" needs a value.`);
    const c = `${qualifier}.${ident(column.name)}`;
    const text = `CAST(${c} AS TEXT)`;
    const v = value ?? "";
    switch (op) {
      case "is":
        parts.push(`${text} = ?`);
        params.push(v);
        break;
      case "is_not":
        parts.push(`(${c} IS NULL OR ${text} <> ?)`);
        params.push(v);
        break;
      // Words found by instr() in the text folded with lower(), never by LIKE: a store's LIKE takes a
      // pattern of at most 50 bytes, and a value may be longer. lower() folds A to Z, as LIKE does.
      case "contains":
        parts.push(`instr(lower(${text}), lower(?)) > 0`);
        params.push(v);
        break;
      case "starts_with":
        parts.push(`instr(lower(${text}), lower(?)) = 1`);
        params.push(v);
        break;
      case "ends_with":
        parts.push(`substr(lower(${text}), -length(?)) = lower(?)`);
        params.push(v, v);
        break;
      case "not_contains":
        parts.push(`(${c} IS NULL OR instr(lower(${text}), lower(?)) = 0)`);
        params.push(v);
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (!NUMBER.test(v)) throw new StoreDataError(400, `"${v}" is not a number.`);
        const trimmed = `trim(${text})`;
        const number = `(CASE WHEN typeof(${c}) IN ('integer', 'real') THEN ${c} WHEN ${trimmed} <> '' AND ${trimmed} NOT GLOB '*[^0-9.eE+-]*' AND ${trimmed} GLOB '*[0-9]*' THEN CAST(${trimmed} AS REAL) END)`;
        parts.push(`${number} ${COMPARED.get(op)} ?`);
        params.push(Number(v));
        break;
      }
      case "on":
      case "before":
      case "after": {
        const day = dayOf(v);
        if (!day) throw new StoreDataError(400, `"${v}" is not a day: write it as 2026-11-18.`);
        parts.push(`(${text} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND substr(${text}, 1, 10) ${COMPARED.get(op)} ?)`);
        params.push(day);
        break;
      }
      case "is_true":
        parts.push(`lower(trim(${text})) IN ('1', 'true', 't', 'yes', 'y')`);
        break;
      case "is_false":
        parts.push(`lower(trim(${text})) IN ('0', 'false', 'f', 'no', 'n')`);
        break;
      case "empty":
        parts.push(`(${c} IS NULL OR ${text} = '')`);
        break;
      case "not_empty":
        parts.push(`(${c} IS NOT NULL AND ${text} <> '')`);
        break;
    }
  }
  if (search) {
    const searched = columns.filter((c) => keepsText(c.type) && !NOT_SEARCHED.has(c.name));
    const words = `lower(${literalOf(search)})`;
    if (searched.length === 0) parts.push("0");
    else parts.push(`(${searched.map((c) => `instr(lower(CAST(${qualifier}.${ident(c.name)} AS TEXT)), ${words}) > 0`).join(" OR ")})`);
  }
  return { sql: parts.length > 0 ? parts.join(" AND ") : null, params };
}

export function rows(core: StoreCore, body: RowsBody): Rows {
  const started = core.deps.now();
  const sql = core.sql;
  const { name, columns } = tableNamed(sql, body.database, body.table);
  const key = keyOf(columns);
  const t = ident(name);
  // A whole row's read (the row's panel) carries long text in full, one row at a time.
  const cellMax = body.whole && body.limit === 1 ? WHOLE_CELL_MAX : CELL_MAX;
  const select = columns.map((c, i) => (/blob/i.test(c.type) ? `length(${t}.${ident(c.name)})` : `substr(CAST(${t}.${ident(c.name)} AS TEXT), 1, ${cellMax + 1})`) + ` AS c${i}`);
  const narrowed = whereOf(t, columns, body);
  const where = narrowed.sql ? ` WHERE ${narrowed.sql}` : "";
  const params = narrowed.params;
  const order = orderOf(name, columns, key, sortsOf(body), isView(sql, name));
  const raw = sql.exec<Record<string, StoreSqlValue>>(`SELECT ${select.join(", ")} FROM ${t}${where}${order} LIMIT ${body.limit} OFFSET ${body.offset}`, ...params).toArray();
  const cut: string[] = [];
  const out: (string | null)[][] = raw.map((r, ri) =>
    columns.map((_, ci) => {
      const v = r[`c${ci}`];
      if (v === null || v === undefined) return null;
      let s = String(v);
      if (s.length > cellMax) {
        s = s.slice(0, cellMax);
        cut.push(`${ri}:${ci}`);
      }
      return s;
    }),
  );
  let total: number | null = null;
  if (body.offset === 0) {
    const n = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM (SELECT 1 FROM ${t}${where} LIMIT ${TOTAL_COUNT_MAX + 1})`, ...params).one().n);
    total = n > TOTAL_COUNT_MAX ? null : n;
  }
  const labels: Record<string, Record<string, string>> = {};
  for (const ask of body.labels ?? []) {
    const c = columns.findIndex((col) => col.name === ask.column);
    if (c < 0 || ask.database !== DATABASE) continue;
    const values = [...new Set(out.map((row) => row[c]).filter((v): v is string => v !== null && v !== ""))];
    labels[ask.column] = {};
    if (values.length === 0) continue;
    try {
      const target = tableNamed(sql, DATABASE, ask.table);
      const shown = ask.label ? ident(ask.label) : ident(ask.key);
      for (const row of sql.exec<{ k: string; l: string | null }>(
        `SELECT CAST(${ident(ask.key)} AS TEXT) AS k, CAST(${shown} AS TEXT) AS l FROM ${ident(target.name)} WHERE CAST(${ident(ask.key)} AS TEXT) IN (SELECT value FROM json_each(?))`,
        JSON.stringify(values),
      )) {
        labels[ask.column]![String(row.k)] = row.l === null ? String(row.k) : String(row.l);
      }
    } catch {
      // A link whose target cannot be read shows its values.
      delete labels[ask.column];
    }
  }
  return { columns: columns.map((c) => c.name), rows: out, total, labels, cut, ms: core.deps.now() - started };
}

export function usedBy(core: StoreCore, body: UsedByBody): UsedBy {
  const started = core.deps.now();
  const sql = core.sql;
  const refs: UsedBy["refs"] = [];
  for (const ref of body.refs) {
    if (ref.database !== DATABASE) continue;
    try {
      const { name, columns } = tableNamed(sql, ref.database, ref.table);
      if (!columns.some((c) => c.name === ref.column)) continue;
      const count = Number(
        sql.exec<{ n: number }>(`SELECT count(*) AS n FROM (SELECT 1 FROM ${ident(name)} WHERE CAST(${ident(ref.column)} AS TEXT) = ? LIMIT ${REF_COUNT_MAX + 1})`, ref.value).one().n,
      );
      if (count > REF_COUNT_MAX) refs.push({ database: ref.database, table: ref.table, column: ref.column, count: REF_COUNT_MAX, more: true });
      else if (count > 0) refs.push({ database: ref.database, table: ref.table, column: ref.column, count });
    } catch {
      // A column that cannot be counted stays out.
    }
  }
  refs.sort((x, y) => y.count - x.count || x.table.localeCompare(y.table));
  return { refs, ms: core.deps.now() - started };
}

export function locate(core: StoreCore, body: LocateBody): Locate {
  const started = core.deps.now();
  const sql = core.sql;
  const { name, columns } = tableNamed(sql, body.database, body.table);
  if (!columns.some((c) => c.name === body.column)) throw new StoreDataError(400, `This table has no column "${body.column}".`);
  const order = orderOf(name, columns, keyOf(columns), [], isView(sql, name));
  let offset: number | null = null;
  try {
    const row = sql
      .exec<{ n: number }>(`SELECT n FROM (SELECT CAST(${ident(body.column)} AS TEXT) AS k, row_number() OVER (${order.trim()}) - 1 AS n FROM ${ident(name)}) WHERE k = ? LIMIT 1`, body.value)
      .toArray()[0];
    offset = row ? Number(row.n) : null;
  } catch {
    offset = null;
  }
  return { offset, ms: core.deps.now() - started };
}
