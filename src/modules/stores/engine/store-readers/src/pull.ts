// PULL as the api, a store's object and DB IO all see it (DB Connect, F2): a database's
// tables into a store, a page at a time, with only the rows that changed. db_pull
// (the api's agent/tools/databases.ts) submits a `pull` job to the store; DB IO
// (apps/db-io/internal/pull, Go) reads the database and sends the store its pages
// with a key that is good for that one job; the store's object (packages/store-object/src/jobs/
// pull.ts) writes each page once. The api never carries a row.
//
// How a pull finds what changed, without moving the whole table:
//
//   1. For each table, the runner reads the table's columns and primary key from the database
//      and begins it (`begin`): the store answers how it writes the table. `new`: a first pull, or
//      one whose columns or key changed, writes a new version of the table. `change`: the table is
//      changed in place, row by row.
//   2. The runner reads what the store holds of that table, each row's `_key` and `_hash`
//      (`hashes`): a few dozen bytes a row, into the runner's container.
//   3. The runner reads every row of the database's table, names it (`_key`) and hashes its values
//      (`_hash`), and sends only the rows whose hash the store does not hold, and the keys the
//      store holds that the database no longer has (`page`). An unchanged row never leaves the
//      runner's container, and the store writes only what a page holds.
//   4. When every row is read, the runner ends the table (`end`). When every table has ended, the
//      store makes its tables visible and the job is done; db_pull answers one handle per table.
//
// A page is written once: each has the next number of its table, a page sent again is answered as
// taken, and a stopped DB IO job's successor reads the hashes the store holds now, so it sends only
// what the store does not have yet. A store keeps only the rows' own columns: `_key` and `_hash`
// are its memory of the last pull.
//
// The runner names a row (`_key`) by its primary key: the key column's value as text, or the key
// columns' values as a JSON array of text when the key has several. A table with no primary key
// names each row by its hash (`h:` and the hash), and a repeat of the same row gets "#2", "#3" in
// the order the database answered. `_hash` is a 64-bit hash of the row's values as text, in the
// table's column order, as 16 hex digits: the same function LOAD hashes a file's rows with
// (`rowHash`), ported to Go, and checked against the same vectors on both sides
// (apps/db-io/contract/row-hash.json).
//
// No import beyond names.ts and jobs.ts, so the store's object reads this file as it reads jobs.ts.

import { planColumns, type ColumnPlan, tableSlug, unusedName } from "./names.js";
import { keepOf, type KeepColumns, madeByOf, TABLE_NAME_RE, type MadeBy } from "./jobs.js";

export { unusedName };

/**
 * The group a pull's tables are in: never parked, and never a LOAD's to replace. Like
 * `LOADED_GROUP`, the name stores keep from their first days: the page and the tools show it as
 * "From the database" (`tableGroupWords`, in the package of the pages' words), and it is never renamed here.
 */
export const PULLED_GROUP = "From the town's database";

/** The most tables one pull reads. */
export const PULL_TABLES_MAX = 50;
/** A page holds at most this many rows, and about this many bytes of JSON. */
export const PULL_PAGE_ROWS = 5_000;
export const PULL_PAGE_BYTES = 1_500_000;
/** A row keeps at most this many bytes of values: a store holds at most 2 MB in a row. */
export const PULL_ROW_BYTES_MAX = 1_500_000;
/** The most removed keys one page carries. */
export const PULL_REMOVED_MAX = 20_000;
/** The most `_key`, `_hash` pairs one read of a table's hashes answers. */
export const PULL_HASH_ROWS = 20_000;
/** The most columns a pulled table reads: a database table has at most 1,024 (SQL Server). */
export const PULL_COLUMNS_MAX = 1_024;


/** A table of the database, as its catalog names it, and the store's table it becomes. */
export interface PullTableParam {
  /** The schema (SQL Server, Postgres), owner (Oracle) or database (MySQL) the table is in. */
  source: { schema: string; name: string };
  /** The store's table: a plain name (`permits`). */
  into: string;
}

/** The connection a pull reads, for the store's records: its id, name and engine. */
export interface PullConnection {
  id: string;
  name: string;
  engine: string;
}

export interface PullParams {
  tables: PullTableParam[];
  connection: PullConnection;
  madeBy: MadeBy;
  /** The words a person named the tables with, when a model picked them: the store keeps the pick. */
  pick?: string;
  /** Columns the tables it makes must keep: an app on the store reads them. */
  keep?: KeepColumns;
}

/** How the store writes a table: a new version of it, or its changed rows in place. */
export type PullMode = "new" | "change";

/** One table a pull wrote, as the job answers it. */
export interface PulledTable {
  table: string;
  version: number;
  rows: number;
  /** The database's table, `schema.name`. */
  source: string;
  mode: PullMode;
  /** The rows the database's table held when it was read. */
  read: number;
  added: number;
  changed: number;
  removed: number;
  /** Values the runner cut so their row fits in a store. */
  cut: number;
}

export interface PullResult {
  tables: PulledTable[];
}

/** Where `_meta` keeps what a pulled table was read from: its connection, its table, its columns and its key. */
export const PULL_RECORD_PREFIX = "pull:";
export const pullRecordKey = (into: string): string => `${PULL_RECORD_PREFIX}${into}`;

/** Where `_meta` keeps the tables a model picked for a person's words, per connection and words. */
export const pullPickKey = (connectionId: string, words: string): string => `pull-pick:${connectionId}:${normalWords(words)}`;
/** What a store keeps under `pullPickKey`. */
export interface SavedPullPick {
  words: string;
  tables: PullTableParam[];
  at: string;
  by: string;
}

/** Words as a pick is kept by them: trimmed, single-spaced, lowercase. */
export const normalWords = (words: string): string => words.trim().replace(/\s+/g, " ").toLowerCase();

// ─── the page wire: the runner and the store's object ─────────────────────────────────────────
// Every call carries the job's key in its authorization header, which the store checks against
// the one it gave last (`POST /v1/stores/:id/jobs/:jobId/key`): a newer DB IO job's key makes an
// older one's refused, so two runners never write one job.

/** A column of the database's table, as the runner read it: its name and the engine's type. */
export interface PullColumn {
  name: string;
  type: string;
}

/** `POST …/pull/begin`: a table's columns and key, read from the database just now. */
export interface PullBeginBody {
  /** The table's place in the job's `tables`, from 0. */
  table: number;
  columns: PullColumn[];
  /** The primary key's columns in key order; empty for a table with none. */
  key: string[];
}

export interface PullBeginAnswer {
  mode: PullMode;
  /** The last page the store took for this table in this job; 0 for none. */
  page: number;
}

/** `POST …/pull/hashes`: what the store holds of a table, by `_key`, after `after`. */
export interface PullHashesBody {
  table: number;
  after: string | null;
  limit?: number;
}

export interface PullHashesAnswer {
  /** `[_key, _hash]` pairs in `_key` order. */
  hashes: [string, string][];
  /** The `after` of the next read; null after the last. */
  next: string | null;
}

/**
 * `POST …/pull/page`: rows to write and keys to remove. Each row is `[_key, _hash, v1, …, vn]`,
 * its values as text (null for NULL) in the begun columns' order.
 */
export interface PullPageBody {
  table: number;
  /** The table's next page: the last one taken, plus one. */
  page: number;
  rows: (string | null)[][];
  removed: string[];
}

export interface PullPageAnswer {
  page: number;
  /** False when this page was taken before: nothing was written again. */
  taken: boolean;
  added: number;
  changed: number;
  removed: number;
}

/** `POST …/pull/end`: every row of the table was read, and every page that differs was sent. */
export interface PullEndBody {
  table: number;
  /** The rows the database's table held. */
  read: number;
  /** Values cut so their row fits in a store. */
  cut: number;
}

export interface PullEndAnswer {
  /** Every table has ended: the store is making them visible. */
  finishing: boolean;
}

/**
 * What a runner says when the store refused its page at the day's write limit (`write_limit_reached`):
 * the job stays open with what it took, a day longer, so the next DB IO job goes on from there.
 */
export const PULL_STORE_LIMIT = "store_limit";

/** `POST …/pull/fail`: the runner could not go on; the job fails with these words, unless its code is PULL_STORE_LIMIT. */
export interface PullFailBody {
  code: string;
  message: string;
}

/** `GET …/pull`: where the job stands. */
export interface PullState {
  /**
   * waiting    the store runs another job first
   * taking     the store takes pages
   * finishing  every table has ended; the store is making them visible
   * done, failed
   */
  state: "waiting" | "taking" | "finishing" | "done" | "failed";
  error: string | null;
  tables: { source: { schema: string; name: string }; into: string; mode: PullMode | null; page: number; ended: boolean }[];
  limits: { pageRows: number; pageBytes: number; hashRows: number; rowBytes: number; removed: number };
}

export const PULL_LIMITS: PullState["limits"] = {
  pageRows: PULL_PAGE_ROWS,
  pageBytes: PULL_PAGE_BYTES,
  hashRows: PULL_HASH_ROWS,
  rowBytes: PULL_ROW_BYTES_MAX,
  removed: PULL_REMOVED_MAX,
};

// ─── checking what comes in ───────────────────────────────────────────────────────────────────

/** A body or a job's parameters that are not what a pull takes: refused with these words. */
export class PullShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullShapeError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** A store's name for a pulled table: a letter, then letters, digits and underscores, as SHAPE's are. */
function tableNameOk(name: string): boolean {
  return TABLE_NAME_RE.test(name) && !name.startsWith("sqlite_") && !name.includes("__");
}

/** A pull job's parameters, checked. */
export function pullParamsOf(value: unknown): PullParams {
  if (!isRecord(value)) throw new PullShapeError("A pull takes its tables, its connection and who made it.");
  const tables = value.tables;
  if (!Array.isArray(tables) || !tables.length) throw new PullShapeError("A pull names at least one table.");
  if (tables.length > PULL_TABLES_MAX) throw new PullShapeError(`A pull reads at most ${PULL_TABLES_MAX} tables.`);
  const seen = new Set<string>();
  const out: PullTableParam[] = tables.map((t) => {
    if (!isRecord(t) || !isRecord(t.source) || !text(t.source.schema, 256) || !text(t.source.name, 256) || typeof t.into !== "string") {
      throw new PullShapeError("Each table of a pull names its schema and name in the database, and the store's table it becomes.");
    }
    if (!tableNameOk(t.into)) throw new PullShapeError(`"${t.into}" cannot name a store's table: use lowercase words joined by single underscores.`);
    if (seen.has(t.into)) throw new PullShapeError(`Two tables of this pull would both become ${t.into}.`);
    seen.add(t.into);
    return { source: { schema: t.source.schema, name: t.source.name }, into: t.into };
  });
  const c = value.connection;
  if (!isRecord(c) || !text(c.id, 100) || !text(c.name, 200) || !text(c.engine, 40)) throw new PullShapeError("A pull names its connection: its id, name and engine.");
  const madeBy = madeByOf(value.madeBy);
  if (!madeBy) throw new PullShapeError("madeBy names the run and the step, or nothing.");
  const pick = value.pick;
  if (pick !== undefined && !text(pick, 500)) throw new PullShapeError("A pick is the words the tables were picked by.");
  let keep: KeepColumns | undefined;
  try {
    keep = keepOf(value.keep);
  } catch (error) {
    throw new PullShapeError(error instanceof Error ? error.message : String(error));
  }
  return {
    tables: out,
    connection: { id: c.id, name: c.name, engine: c.engine },
    madeBy,
    ...(typeof pick === "string" ? { pick } : {}),
    ...(keep ? { keep } : {}),
  };
}

const tableIndexOf = (v: unknown, tables: number): number => {
  if (!count(v) || v >= tables) throw new PullShapeError("The call names a table this pull does not read.");
  return v;
};

export function pullBeginOf(value: unknown, tables: number): PullBeginBody {
  if (!isRecord(value)) throw new PullShapeError("A table begins with its columns and its key.");
  const table = tableIndexOf(value.table, tables);
  if (!Array.isArray(value.columns) || !value.columns.length || value.columns.length > PULL_COLUMNS_MAX) {
    throw new PullShapeError(`A table has 1 to ${PULL_COLUMNS_MAX} columns.`);
  }
  const names = new Set<string>();
  const columns = value.columns.map((c) => {
    if (!isRecord(c) || !text(c.name, 256) || typeof c.type !== "string" || c.type.length > 256) throw new PullShapeError("Each column names itself and its type.");
    if (names.has(c.name)) throw new PullShapeError(`The column ${c.name} is named twice.`);
    names.add(c.name);
    return { name: c.name, type: c.type };
  });
  if (!Array.isArray(value.key) || value.key.length > 32 || !value.key.every((k) => typeof k === "string" && names.has(k))) {
    throw new PullShapeError("A table's key names its own columns.");
  }
  if (new Set(value.key).size !== value.key.length) throw new PullShapeError("A key names each column once.");
  return { table, columns, key: [...(value.key as string[])] };
}

export function pullHashesOf(value: unknown, tables: number): PullHashesBody {
  if (!isRecord(value)) throw new PullShapeError("A read of hashes names its table.");
  const table = tableIndexOf(value.table, tables);
  if (value.after !== null && value.after !== undefined && typeof value.after !== "string") throw new PullShapeError("after is a key, or null to start.");
  const limit = value.limit === undefined ? PULL_HASH_ROWS : value.limit;
  if (!count(limit) || limit < 1) throw new PullShapeError("limit is a whole number of rows.");
  return { table, after: typeof value.after === "string" ? value.after : null, limit: Math.min(limit, PULL_HASH_ROWS) };
}

/** A page, checked against the table's columns: each row is its key, its hash and one value a column. */
export function pullPageOf(value: unknown, tables: number, width: (table: number) => number): PullPageBody {
  if (!isRecord(value)) throw new PullShapeError("A page names its table, its number, its rows and the keys it removes.");
  const table = tableIndexOf(value.table, tables);
  if (!count(value.page) || value.page < 1) throw new PullShapeError("A page's number starts at 1.");
  const rows = value.rows ?? [];
  const removed = value.removed ?? [];
  if (!Array.isArray(rows) || rows.length > PULL_PAGE_ROWS) throw new PullShapeError(`A page holds at most ${PULL_PAGE_ROWS} rows.`);
  if (!Array.isArray(removed) || removed.length > PULL_REMOVED_MAX) throw new PullShapeError(`A page removes at most ${PULL_REMOVED_MAX} keys.`);
  const cells = width(table) + 2;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== cells) throw new PullShapeError(`Each row of this table holds its key, its hash and ${cells - 2} values.`);
    if (typeof row[0] !== "string" || row[0].length > 100_000 || typeof row[1] !== "string" || !/^[0-9a-f]{16}$/.test(row[1])) throw new PullShapeError("Each row starts with its key and its hash (16 hex digits).");
    for (let i = 2; i < row.length; i++) if (row[i] !== null && typeof row[i] !== "string") throw new PullShapeError("A row's values are text, or null.");
  }
  if (!removed.every((k) => typeof k === "string" && k.length <= 100_000)) throw new PullShapeError("The keys a page removes are text.");
  return { table, page: value.page, rows: rows as (string | null)[][], removed: removed as string[] };
}

export function pullEndOf(value: unknown, tables: number): PullEndBody {
  if (!isRecord(value)) throw new PullShapeError("A table ends with the rows read.");
  const table = tableIndexOf(value.table, tables);
  if (!count(value.read)) throw new PullShapeError("read is the rows the database's table held.");
  const cut = value.cut === undefined ? 0 : value.cut;
  if (!count(cut)) throw new PullShapeError("cut is a whole number of values.");
  return { table, read: value.read, cut };
}

export function pullFailOf(value: unknown): PullFailBody {
  if (!isRecord(value) || typeof value.message !== "string" || !value.message.trim()) throw new PullShapeError("A failure says why, in words.");
  const code = typeof value.code === "string" && /^[a-z_]{1,40}$/.test(value.code) ? value.code : "internal";
  return { code, message: value.message.trim().slice(0, 1_000) };
}

// ─── a pulled table's columns in the store ──────────────────────────────────────────────────

/**
 * A table's columns as a store keeps them, the database's name and type in `source` and
 * `originalType`: what LOAD plans for a file's columns (the first MAX_KEPT_COLUMNS as columns of
 * their own, the rest packed into `_extra`, every name clear of the store's own).
 */
export function planPulledColumns(columns: readonly PullColumn[]): ColumnPlan {
  return planColumns(columns.map((c) => ({ name: c.name, originalType: c.type })));
}

/**
 * A store's name for a database's table: its name in lowercase words joined by underscores, never
 * starting with a digit, `_` or `sqlite_`, and never ending the way a kept version (`__v2`) or a
 * version being written (`__new`) does.
 */
export function pulledTableName(name: string): string {
  return tableSlug(name, "table");
}
