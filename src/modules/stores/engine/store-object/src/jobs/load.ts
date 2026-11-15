// LOAD: a store's files into tables of the store (Stores, Part A). store_load
// (the api's agent/tools/store-steps.ts) submits it; the store's job runner calls
// `run` once per chunk until every file is read (jobs/types.ts). Its params and its answer are
// `store-readers/jobs`, which the api reads too.
//
//   • Each file is opened with store-readers, read by range: delimited text and dBase tables
//     at any size, an .xlsx as a stream, an .xls or an Access database whole up to its cap. A file
//     it cannot read, or cannot read on from some row, is skipped with the reason, and the rest
//     load. A read of the bucket that fails is tried again (the runner tries a chunk three times).
//   • Each sheet or table becomes one program table of text: `_file` (the file's id), `_row`
//     (where the row is in the file), `_key` (the row's name across loads) and `_hash` (a hash of
//     its values; store-readers row-key.ts), the file's first 90 columns by their own names,
//     and `_extra` (the rest of a row, as JSON) when a row needs it. A row is at most 2 MB in a
//     store: the values of a longer one are cut, and the table's notes say how many.
//   • `_key` is the value of the table's key column, chosen on its first batch (the column an
//     earlier load used, else the first one that reads like an identifier and holds a different
//     value in every row of the batch), or `h:` and the row's hash, so `_key` names one row: a
//     repeat of a key gets "#2", "#3" in file order. A table named by its rows' hashes chooses
//     again when its file's columns change (`keyFromFor`).
//   • A first load, or a file whose columns or key column changed, makes the table whole: its rows
//     go into `<name>__new` a batch at a time, one INSERT a row, committed with the cursor it read
//     to, so a chunk cut short goes on from its last batch and writes no row twice. Once every row
//     is in, a repeated key gets its "#2", "#3", and the table's last batch swaps it in
//     (`tables.commit`, `dropOld`): the store keeps no earlier copy of a town's raw rows (its files
//     are still in the store), and records which `_key`s were added, changed and removed against
//     its memory of the last load's `_hash`es. A chunk cut short after the swap finds
//     `<name>__new` gone and reads the version from the catalog instead of loading the table again.
//   • A file loaded again into its table (same columns, same key column) writes only the rows that
//     changed. Each batch's keys are looked up in the store's memory (`_row_hashes`): a key it does
//     not have is added, a row whose hash differs is changed, the rest are left as they are; once
//     every row is read, the keys no row took are removed (jobs/claims.ts keeps which keys the
//     file took). A table in the store's database changes in place, by `_key`. A parked table
//     (park.ts) stays parked: the file's rows are written as its new files in the store's bucket,
//     and the database takes only the memory's new hashes and the change's keys. Either way the
//     version stays, one change records the keys (`openChange`, `keys`, `close`), and a change of
//     most of the table is recorded whole. A reload that finds most of its first rows changed, a
//     row too wide for a parked table's files, too many repeated keys, or a state that would grow
//     past what the store keeps for a job (STATE_BYTES_MAX), makes the table whole after all, and
//     records that change whole. A table an app on the store reads (`keep`) is made whole when it
//     is parked, so it comes back into the database, or when it lacks a column the app reads, so
//     the commit refuses it as it refuses any new version without one.
//
// A dBase table's text is read in the code page the text shows, which is mostly the one its header
// names (store-readers code-page.ts), and its notes say why where the two disagree. A code
// page a person set for a file (`LoadFile.codePage`) is kept in `_meta` under the file's name
// (`codePageKey`), so every later LOAD of a file of that name reads its text so, until a LOAD
// that says "auto" forgets it.
//
// The opened file stays in its store's object between chunks of the same job (an .xlsx's open
// stream, an Access database's bytes), one per object; an object that restarted opens it again.

import {
  type ByteSource,
  EXTRA_COLUMN,
  FILE_COLUMN,
  filePrefixes,
  HASH_COLUMN,
  KEY_COLUMN,
  keyColumnOf,
  openFile,
  type OpenedFile,
  packRow,
  planColumns,
  type PlannedColumn,
  type ReadCursor,
  ROW_COLUMN,
  type RowBatch,
  rowHash,
  rowKey,
  secondTableName,
  tableNameIn,
  UnreadableFile,
  unusedName,
} from "../../../store-readers/src/index.js";
import { keepOf, LOADED_GROUP, type LoadedTable, type LoadFile, type LoadParams, type LoadResult, madeByOf, READABLE_CODE_PAGES, type RowCounts } from "../../../store-readers/src/jobs.js";
import { abandonDeltas, appendAll, KEYS_PER_PART, type RowKeys, WHOLE_SHARE } from "../deltas.js";
import { type ParkedColumn, parkedFiles, parkedPrefix, putManifest, putPart, utf8Length } from "../park.js";
import { getMeta } from "../schema.js";
import { isReservedName } from "../sql.js";
import { byChars, Claims, type ClaimsState, rememberKeys, startClaims, takeKeys, untaken } from "./claims.js";
import { keyedUnique } from "./shape.js";
import { type CommittedTable, type JobContext, type JobFile, type JobHandler, JobParamsError, type ProgramTableColumn } from "./types.js";

export { LOADED_GROUP, type LoadedTable, type LoadFile, type LoadParams, type LoadResult };

/** One table of the file being loaded, as the job planned it. */
interface PlannedTable {
  /** Its index among the file's tables, and its name there. */
  index: number;
  source: string | null;
  name: string;
  /** Its name in full, where LOAD cut it at 60 characters: a second name SQL reads it by (front-door.ts). */
  fullName?: string;
  kept: PlannedColumn[];
  packed: PlannedColumn[];
  notes: string[];
  /** The column an earlier load took `_key` from: its name, "" for the row's hash, null for none yet. */
  keyFrom: string | null;
  /** Made whole whatever the store holds of it: a reload of it fell back. */
  whole?: boolean;
  /** Its change is recorded whole: part of a reload that fell back, or that stopped part way, is in the memory already. */
  wholeChange?: boolean;
}

/** How the table being loaded is written: anew and swapped in, or by its keys, in place or as new parked files. */
type How = "whole" | "place" | "parked";

/** Where a reload by keys stands. */
interface ReloadProgress {
  /** Which keys the file's rows took (claims.ts). */
  claims: ClaimsState;
  /** The keys the store's memory held before: what "most of the table" is measured against. */
  known: number;
  /** The change it records, once a row changed, and the store's restore point from before it. */
  change: number | null;
  restorePoint: string | null;
  counts: RowCounts;
  /** Keys read and not yet in the change's record: written a full part of keys at a time. */
  pending: { added: string[]; changed: string[]; removed: string[] };
  /** A parked table's new files, as far as they are written. */
  files: { id: string; prefix: string; version: number; columns: ParkedColumn[]; parts: number; bytes: number; rows: number } | null;
  /** In place: the unique index on `_key` that finds a changed row is made. */
  indexed: boolean;
  /** Every row is read, and the keys no row took are recorded as removed. */
  swept: boolean;
}

/** Where the table being loaded stands. */
interface TableProgress {
  cursor: ReadCursor | null;
  rows: number;
  deleted: number;
  /** The table being written has an `_extra` column. */
  extra: boolean;
  /** Every row is read. */
  done: boolean;
  /** Values cut so their row fits in a store. */
  cut: number;
  /** Why the reader stopped before the file's end, when it did. */
  stopped: string | null;
  /** The kept column `_key` comes from ("" for the row's hash); undefined until the first batch is read. */
  key?: string;
  /** Repeated keys got their "#2", "#3": `_key` names one row. */
  keyed?: boolean;
  /** Unset in a state an older store saved: whole. */
  how?: How;
  reload?: ReloadProgress;
  /** What the reader's batches said a person should know: a dBase table's text read in another code page from some record on. */
  found?: string[];
}

export interface LoadState {
  file: number;
  /** The file's tables once it is opened; null before. */
  tables: PlannedTable[] | null;
  table: number;
  current: TableProgress | null;
  made: LoadedTable[];
  skipped: { file: string; why: string }[];
  /** Rows loaded so far, over every table. */
  rows: number;
}

/** A batch: at most this many rows, and about this many bytes of the file. */
const BATCH_ROWS = 2000;
const BATCH_BYTES = 1 << 20;
const FILES_MAX = 500;
/**
 * The characters a row keeps: a store holds at most 2 MB in a row, and a character is at most
 * three bytes of UTF-8.
 */
export const ROW_CHARS_MAX = 600_000;
/** A reload in place makes the table whole once more than half the rows it read differ, after this many (or every row of a smaller table). */
const MOST_AFTER = 2_000;
/**
 * The most bytes a reload's state may hold when a commit saves it. The store keeps a job's row,
 * its params (up to FILES_MAX files) and its state, in at most 2 MB. The bitset of the keys it took
 * grows with the table, up to about 1.33 MB, and its free numbers up to about 200 KB (claims.ts).
 */
export const STATE_BYTES_MAX = 1_700_000;

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The `_meta` key that says a reload of a parked table is under way, and which job runs it. */
const reloadKey = (table: string): string => `load_reload:${table}`;
/** The `_meta` key of the code page a person set for the text of files of this name; an export takes it with the files. */
export const codePageKey = (fileName: string): string => `code_page:${fileName.toLowerCase()}`;
/** The packed columns LOAD's note names; past them it says how many more (store_tables lists every one). */
const PACKED_NAMED_MAX = 20;
/** A loaded table's second name and packed columns, as its answer gives them. */
const namedAs = (t: PlannedTable): Pick<LoadedTable, "fullName" | "packed"> => ({
  ...(t.fullName ? { fullName: t.fullName } : {}),
  ...(t.packed.length ? { packed: t.packed.map((c) => c.name) } : {}),
});

/** A read of the bucket that failed: tried again, unlike a file that cannot be read. */
class ReadFailed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ReadFailed";
  }
}

/**
 * The file a store's object has open between chunks of one job, by the object's SQL storage (one
 * per object): another store's LOAD in the same isolate never takes its place.
 */
const opened = new WeakMap<object, { key: string; file: OpenedFile }>();

function sourceOf(ctx: JobContext<LoadParams, LoadState>, file: JobFile): ByteSource {
  return {
    size: file.size,
    async read(offset, length) {
      // Nothing past the end: the bucket refuses a range there, and a reader asks for one at times
      // (an empty memo file's header).
      const end = Math.min(file.size, offset + Math.max(0, length));
      if (offset >= end) return new Uint8Array(0);
      try {
        return await ctx.files.read(file.id, offset, end - offset);
      } catch (err) {
        throw new ReadFailed(err);
      }
    },
  };
}

/** The code page to read a file's text in: the one this LOAD sets, else the one the store keeps for its name; null for LOAD to find it. */
function codePageFor(ctx: JobContext<LoadParams, LoadState>, f: LoadFile): number | null {
  if (f.codePage === "auto") return null;
  if (typeof f.codePage === "number") return f.codePage;
  const kept = Number(getMeta(ctx.sql, codePageKey(f.name)));
  return READABLE_CODE_PAGES.includes(kept) ? kept : null;
}

/** Keeps the code page this LOAD sets for a file's name, or forgets it for "auto"; writes nothing when the store already holds that. */
function keepCodePage(ctx: JobContext<LoadParams, LoadState>, f: LoadFile): void {
  if (f.codePage === "auto") ctx.sql.exec("DELETE FROM _meta WHERE key = ?", codePageKey(f.name));
  else if (typeof f.codePage === "number") {
    ctx.sql.exec("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value", codePageKey(f.name), String(f.codePage));
  }
}

/** The file at `state.file`, open: from this object's memory, or read again from the bucket. */
async function openCurrent(ctx: JobContext<LoadParams, LoadState>, state: LoadState): Promise<OpenedFile> {
  const f = ctx.params.files[state.file]!;
  const key = `${ctx.job.id}:${state.file}`;
  const known = opened.get(ctx.sql);
  if (known?.key === key) return known.file;
  opened.delete(ctx.sql);
  const file = ctx.files.get(f.id);
  if (!file) throw new UnreadableFile(`${f.name} is no longer in this store, or its upload has not finished.`, "damaged");
  const memo = f.memo ? ctx.files.get(f.memo.id) : null;
  const open = await openFile(file.name, sourceOf(ctx, file), { codePage: codePageFor(ctx, f), ...(memo ? { memo: sourceOf(ctx, memo) } : {}) });
  opened.set(ctx.sql, { key, file: open });
  return open;
}

/**
 * Whether a LOAD must not write a table of this name: a table no program writes (a migration's, or
 * one made by hand), or one a SHAPE made, which a LOAD of a file of the same name would replace.
 */
function taken(ctx: JobContext<LoadParams, LoadState>, name: string): boolean {
  if (isReservedName(name)) return true;
  const row = ctx.sql.exec<{ kind: string; grp: string | null }>("SELECT kind, grp FROM _tables WHERE lower(name) = lower(?)", name).toArray()[0];
  if (row) return row.kind !== "program" || row.grp !== LOADED_GROUP;
  return ctx.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)", name).toArray().length > 0;
}

/** The columns a table of the file has, in order: LOAD's own four, the kept ones, and `_extra` when a row needs it. */
const columnList = (t: PlannedTable, extra: boolean): string[] => [FILE_COLUMN, ROW_COLUMN, KEY_COLUMN, HASH_COLUMN, ...t.kept.map((c) => c.name), ...(extra ? [EXTRA_COLUMN] : [])];

/** The columns `<name>__new` is made with: LOAD's own four, the kept ones, and `_extra` when a row needs it. */
function createSql(table: string, t: PlannedTable, extra: boolean): string {
  const cols = [
    `${quote(FILE_COLUMN)} TEXT NOT NULL`,
    `${quote(ROW_COLUMN)} INTEGER NOT NULL`,
    `${quote(KEY_COLUMN)} TEXT NOT NULL`,
    `${quote(HASH_COLUMN)} TEXT NOT NULL`,
    ...t.kept.map((c) => `${quote(c.name)} TEXT`),
    ...(extra ? [`${quote(EXTRA_COLUMN)} TEXT`] : []),
  ];
  return `CREATE TABLE ${quote(table)} (${cols.join(", ")})`;
}

/** One row's INSERT, its values bound: at most 95 of them, under workerd's 100. */
function insertSql(table: string, t: PlannedTable, extra: boolean): string {
  const cols = columnList(t, extra);
  return `INSERT INTO ${quote(table)} (${cols.map(quote).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
}

/** One changed row's UPDATE in place, by its `_key`: every column but `_key`, then the key, bound. */
function updateSql(table: string, t: PlannedTable, extra: boolean): string {
  const cols = columnList(t, extra).filter((c) => c !== KEY_COLUMN);
  return `UPDATE ${quote(table)} SET ${cols.map((c) => `${quote(c)} = ?`).join(", ")} WHERE ${quote(KEY_COLUMN)} = ?`;
}

/**
 * Gives each repeat of a `_key` in `<name>__new` its "#2", "#3", in the order the rows came, so
 * `_key` names one row; then a repeat the first pass made (a file whose own key reads "A#2" beside
 * two "A"s) gets "#r" and its row's rowid, which no other row has. Writes only the repeats.
 */
function keySql(table: string): string[] {
  const t = quote(table);
  const k = quote(KEY_COLUMN);
  const repeats = `FROM (SELECT rowid AS id, row_number() OVER (PARTITION BY ${k} ORDER BY rowid) AS n FROM ${t}) AS d WHERE ${t}.rowid = d.id AND d.n > 1`;
  return [`UPDATE ${t} SET ${k} = ${t}.${k} || '#' || d.n ${repeats}`, `UPDATE ${t} SET ${k} = ${t}.${k} || '#r' || ${t}.rowid ${repeats}`];
}

const hasColumn = (ctx: JobContext<LoadParams, LoadState>, table: string, column: string): boolean =>
  ctx.sql.exec("SELECT 1 AS x FROM pragma_table_info(?) WHERE name = ?", table, column).toArray().length > 0;

/** The column an earlier load of a table took `_key` from ("" for the row's hash); null when none did. */
function recordedKey(ctx: JobContext<LoadParams, LoadState>, name: string): string | null {
  const row = ctx.sql.exec<{ key_from: string | null }>("SELECT key_from FROM _tables WHERE lower(name) = lower(?) AND kind = 'program'", name).toArray()[0];
  return row && row.key_from !== null ? String(row.key_from) : null;
}

/** A store table's columns as it stands, in order and without `_extra`: in the database, or in its parked files; null when it has neither. */
function ownColumns(ctx: JobContext<LoadParams, LoadState>, name: string): string[] | null {
  const have = tableExists(ctx, name)
    ? ctx.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?) ORDER BY cid", name).toArray().map((c) => String(c.name))
    : (parkedFiles(ctx.sql, name)?.columns.map((c) => c.name) ?? null);
  if (!have) return null;
  return have[have.length - 1] === EXTRA_COLUMN ? have.slice(0, -1) : have;
}

/**
 * The column `_key` comes from for this load of a table, as far as an earlier load says: its name,
 * "" for the row's hash, null to choose on the first batch. A table named by its rows' hashes keeps
 * them while its file's columns stay the same, since a key column found later would rename every
 * row. A file whose columns differ makes the table whole, and its key column is chosen again, as on
 * a first load: a table whose last load took a title above the header for its header gets the key
 * column its real header names.
 */
function keyFromFor(ctx: JobContext<LoadParams, LoadState>, t: PlannedTable): string | null {
  const recorded = recordedKey(ctx, t.name);
  if (recorded !== "") return recorded;
  const have = ownColumns(ctx, t.name);
  const planned = columnList(t, false);
  return have && have.length === planned.length && have.every((c, i) => c === planned[i]) ? "" : null;
}

/**
 * A row's values, and those its reader could not place (`more`), cut so the row keeps at most
 * ROW_CHARS_MAX characters: every value keeps the same most it may, the longest the row can keep.
 * Cut before they are packed, so `_extra` stays whole JSON. How many were cut.
 */
export function fitRow(values: (string | null)[], more?: Record<string, string>): number {
  const lengths = [...values, ...Object.values(more ?? {})].map((v) => v?.length ?? 0);
  let total = 0;
  for (const n of lengths) total += n;
  if (total <= ROW_CHARS_MAX) return 0;
  lengths.sort((a, b) => a - b);
  let budget = ROW_CHARS_MAX;
  let cap = 0;
  for (let i = 0; i < lengths.length; i++) {
    const share = Math.floor(budget / (lengths.length - i));
    if (lengths[i]! > share) {
      cap = share;
      break;
    }
    budget -= lengths[i]!;
  }
  let cut = 0;
  values.forEach((v, i) => {
    if (v !== null && v.length > cap) {
      values[i] = v.slice(0, cap);
      cut++;
    }
  });
  for (const [k, v] of Object.entries(more ?? {})) {
    if (v.length > cap) {
      more![k] = v.slice(0, cap);
      cut++;
    }
  }
  return cut;
}

const tableExists = (ctx: JobContext<LoadParams, LoadState>, name: string): boolean =>
  ctx.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

function progressOf(ctx: JobContext<LoadParams, LoadState>, state: LoadState) {
  const f = ctx.params.files[state.file];
  return { done: state.rows, total: null, ...(f ? { note: `Loading ${f.name}` } : {}) };
}

const sameCursor = (a: ReadCursor | null, b: ReadCursor | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether a failure is tried again: a read of the bucket that failed, of a file still in the store.
 * Anything else (a file the reader cannot read, a damaged part of one, a file deleted while it
 * loaded) fails the same way each time, so the file is skipped instead.
 */
function retried(ctx: JobContext<LoadParams, LoadState>, f: LoadFile, err: unknown): boolean {
  return err instanceof ReadFailed && !!ctx.files.get(f.id) && (!f.memo || !!ctx.files.get(f.memo.id));
}

/** Why a file was skipped, in words. */
function unreadable(f: LoadFile, err: unknown): string {
  if (err instanceof ReadFailed) return `${f.name} was deleted while it loaded.`;
  if (err instanceof UnreadableFile) return err.message;
  return `${f.name} could not be read: ${err instanceof Error ? err.message : String(err)}`;
}

/** The catalog's words for a loaded table's columns. */
function columnsOf(t: PlannedTable, keyFrom: string, extra: boolean): ProgramTableColumn[] {
  return [
    { name: FILE_COLUMN, comment: "The id of the store's file the row came from." },
    { name: ROW_COLUMN, comment: "Where the row is in its file: a spreadsheet's row number, a dBase record's number." },
    {
      name: KEY_COLUMN,
      comment: keyFrom
        ? `The row's name across loads: its "${keyFrom}", with "#2", "#3" for a repeat.`
        : "The row's name across loads: a hash of its values, with \"#2\", \"#3\" for a repeat.",
    },
    { name: HASH_COLUMN, comment: "A hash of the row's values: how the store knows the row changed since the last load." },
    ...t.kept.map((c) => ({ name: c.name, originalType: c.originalType, ...(c.name !== c.source ? { comment: `"${c.source}" in the file.` } : {}) })),
    ...(extra ? [{ name: EXTRA_COLUMN, comment: "The row's other values, as JSON by column name." }] : []),
    // Past the table's own: SQL reads each by its name, from `_extra` (front-door.ts).
    ...t.packed.map((c) => ({
      name: c.name,
      originalType: c.originalType,
      comment: `${c.name !== c.source ? `"${c.source}" in the file, ` : ""}kept in ${EXTRA_COLUMN}: a table keeps a file's first ${t.kept.length} columns as its own.`,
      packed: true as const,
    })),
  ];
}

/** LOAD's note on a file with more columns than a table keeps: how many, and the packed ones by name. */
function packedNote(t: PlannedTable): string {
  const names = t.packed.map((c) => c.name);
  const listed = names.length > PACKED_NAMED_MAX ? `${names.slice(0, PACKED_NAMED_MAX).join(", ")} and ${names.length - PACKED_NAMED_MAX} more` : names.join(", ");
  return `The file has ${t.kept.length + t.packed.length} columns; the ${t.packed.length} after the first ${t.kept.length} are in ${EXTRA_COLUMN}: ${listed}. SQL reads each by its name.`;
}

/** Keeps a table's second name, its name in full where LOAD cut it (front-door.ts), or clears one it no longer has. */
function keepSecondName(ctx: JobContext<LoadParams, LoadState>, t: PlannedTable): void {
  const full = t.fullName ?? null;
  ctx.sql.exec("UPDATE _tables SET full_name = ? WHERE name = ? AND full_name IS NOT ?", full, t.name, full);
}

/**
 * How a file loaded again into its table writes: by its keys, in place (the table is in the
 * store's database) or as new parked files (the table is parked); null when it makes the table
 * whole: a first load, new or reordered columns, a new key column, no memory of the last load's
 * keys, or a parked table whose files have no place for the values past the first 90 columns. A
 * reload of a parked table that stopped part way (another job's mark is still there) left the
 * memory ahead of the files: the table is made whole, and its change recorded whole. Reads only.
 */
function planReload(ctx: JobContext<LoadParams, LoadState>, state: LoadState, t: PlannedTable): { how: "place" | "parked"; key: string; extra: boolean; reload: Omit<ReloadProgress, "restorePoint"> } | null {
  const sql = ctx.sql;
  const mark = getMeta(sql, reloadKey(t.name));
  if (mark !== null && mark !== ctx.job.id) {
    t.whole = true;
    t.wholeChange = true;
    return null;
  }
  if (t.keyFrom === null) return null;
  const key = t.keyFrom === "" ? "" : t.kept.find((c) => c.name.toLowerCase() === t.keyFrom!.toLowerCase())?.name;
  if (key === undefined) return null;
  const row = sql.exec<{ kind: string; grp: string | null; version: number; parked: string | null }>("SELECT kind, grp, version, parked FROM _tables WHERE name = ?", t.name).toArray()[0];
  if (!row || row.kind !== "program" || row.grp !== LOADED_GROUP) return null;
  const inDatabase = tableExists(ctx, t.name);
  const files = !inDatabase && row.parked !== null ? parkedFiles(sql, t.name) : null;
  if (!inDatabase && !files) return null;
  const have = inDatabase ? sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?) ORDER BY cid", t.name).toArray().map((c) => String(c.name)) : files!.columns.map((c) => c.name);
  const extra = have[have.length - 1] === EXTRA_COLUMN;
  const own = extra ? have.slice(0, -1) : have;
  const planned = columnList(t, false);
  if (own.length !== planned.length || own.some((c, i) => c !== planned[i])) return null;
  if (files && t.packed.length > 0 && !extra) return null;
  // An app on the store reads this table: a parked table comes back into the database, where the
  // app reads it, and a table without a column the app reads gets a new version, which the commit
  // refuses with words that name the app (SHAPE's `decide` does the same).
  const keep = ctx.params.keep?.[t.name.toLowerCase()];
  if (keep?.length && (files || keep.some((k) => !have.some((c) => c.toLowerCase() === k.column.toLowerCase())))) return null;
  const start = startClaims(sql, t.name);
  if (!start) return null;
  const version = Number(row.version);
  const id = `${ctx.job.id.replace(/^job_/, "")}-${state.file}-${t.index}`;
  return {
    how: inDatabase ? "place" : "parked",
    key,
    extra,
    reload: {
      claims: start.claims,
      known: start.known,
      change: null,
      counts: { added: 0, changed: 0, removed: 0 },
      pending: { added: [], changed: [], removed: [] },
      files: files ? { id, prefix: parkedPrefix(ctx.job.storeId, t.name, version, id), version, columns: files.columns, parts: 0, bytes: 0, rows: 0 } : null,
      indexed: inDatabase && keyedUnique(sql, t.name),
      swept: false,
    },
  };
}

/**
 * The keys a reload read that fill whole parts of its change's record (with `all`, every one),
 * taken out of `pending` for the commit to write: the state that commit saves holds only the rest.
 */
function fullParts(rl: ReloadProgress, all: boolean): RowKeys {
  const parts: { added?: string[]; changed?: string[]; removed?: string[] } = {};
  for (const kind of ["added", "changed", "removed"] as const) {
    const list = rl.pending[kind];
    const n = all ? list.length : list.length - (list.length % KEYS_PER_PART);
    if (n <= 0) continue;
    parts[kind] = list.slice(0, n);
    rl.pending[kind] = list.slice(n);
  }
  return parts;
}

/** Writes keys `fullParts` took into the reload's change, inside the commit that saves the rest. */
function writeKeys(ctx: JobContext<LoadParams, LoadState>, name: string, rl: ReloadProgress, parts: RowKeys): void {
  if (rl.change !== null && (parts.added?.length || parts.changed?.length || parts.removed?.length)) ctx.tables.keys(name, rl.change, parts);
}

/** The unique index on `_key` a reload in place finds a changed row by: the first such reload makes it. */
function ensureKeyIndex(ctx: JobContext<LoadParams, LoadState>, name: string): void {
  if (!keyedUnique(ctx.sql, name)) ctx.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(`${name}__key_${ctx.job.id.replace(/^job_/, "")}`)} ON ${quote(name)} (${quote(KEY_COLUMN)})`);
}

export const loadHandler: JobHandler<LoadParams, LoadState, LoadResult> = {
  kind: "load",

  parse(params) {
    if (!isRecord(params) || !Array.isArray(params.files) || !params.files.length) throw new JobParamsError("LOAD takes the files to load.");
    if (params.files.length > FILES_MAX) throw new JobParamsError(`LOAD takes at most ${FILES_MAX} files at once.`);
    const files: LoadFile[] = params.files.map((f) => {
      if (!isRecord(f) || typeof f.id !== "string" || !f.id || typeof f.name !== "string" || !f.name) throw new JobParamsError("Each file to load names its id and its name.");
      const memo = f.memo;
      if (memo !== undefined && (!isRecord(memo) || typeof memo.id !== "string" || !memo.id)) throw new JobParamsError(`The memo file of ${f.name} names its id.`);
      const codePage = f.codePage;
      if (codePage !== undefined && codePage !== "auto" && !(typeof codePage === "number" && READABLE_CODE_PAGES.includes(codePage))) {
        throw new JobParamsError(`The code page set for ${f.name} is not one LOAD reads text in.`);
      }
      return { id: f.id, name: f.name, ...(isRecord(memo) ? { memo: { id: String(memo.id) } } : {}), ...(codePage !== undefined ? { codePage } : {}) };
    });
    const madeBy = madeByOf(params.madeBy);
    if (!madeBy) throw new JobParamsError("madeBy names the run and the step, or nothing.");
    let keep;
    try {
      keep = keepOf(params.keep);
    } catch (err) {
      throw new JobParamsError(err instanceof Error ? err.message : String(err));
    }
    return { files, madeBy, ...(keep ? { keep } : {}) };
  },

  async run(ctx) {
    const state: LoadState = ctx.state ? structuredClone(ctx.state) : { file: 0, tables: null, table: 0, current: null, made: [], skipped: [], rows: 0 };
    // The state is saved as `write` leaves it, in the same transaction.
    const save = (write?: () => void) => ctx.commit({ state, progress: progressOf(ctx, state) }, write);
    const prefixes = filePrefixes(ctx.params.files.map((f) => f.name));
    const fullPrefixes = filePrefixes(ctx.params.files.map((f) => f.name), Number.POSITIVE_INFINITY);
    // The keys a reload took, in this chunk's memory: made from the state, which each commit keeps.
    let claimed: { at: string; claims: Claims } | null = null;
    const claimsOf = (rl: ReloadProgress): Claims => {
      const at = `${state.file}:${state.table}`;
      if (claimed?.at !== at) claimed = { at, claims: new Claims(rl.claims) };
      return claimed.claims;
    };
    // The last swap may take the day's writes to the store's limit (each row's hash is written
    // with it). Nothing is left to write then, so the job ends now, not after a wait for 00:00 UTC.
    const lastFile = ctx.params.files.length - 1;
    const nothingLeft = () => state.file > lastFile || (state.file === lastFile && state.tables !== null && state.table >= state.tables.length);
    while (ctx.now() < ctx.deadline || nothingLeft()) {
      if (state.file >= ctx.params.files.length) {
        opened.delete(ctx.sql);
        return { result: { tables: state.made, skipped: state.skipped } };
      }
      const f = ctx.params.files[state.file]!;
      // Every file of the job passes here at its end, read or skipped: the code page set for it is kept then too.
      const nextFile = (write?: () => void) => {
        state.file++;
        state.tables = null;
        state.table = 0;
        state.current = null;
        opened.delete(ctx.sql);
        save(() => {
          keepCodePage(ctx, f);
          write?.();
        });
      };
      let file: OpenedFile;
      try {
        file = await openCurrent(ctx, state);
      } catch (err) {
        if (retried(ctx, f, err)) throw err;
        state.skipped.push({ file: f.name, why: unreadable(f, err) });
        nextFile();
        continue;
      }
      if (!state.tables) {
        // The file's tables, named now that it is open: never a name another table of this load,
        // a table no program writes, or a SHAPE's table already has.
        const used = new Set(state.made.map((m) => m.table.toLowerCase()));
        const tables: PlannedTable[] = [];
        file.tables.forEach((t, index) => {
          if (!t.columns.length) return;
          let name = tableNameIn(prefixes[state.file]!, t.name, file.tables.length);
          if (taken(ctx, name)) name = `${isReservedName(name) ? "t_" : ""}${name.slice(0, 54)}_loaded`;
          name = unusedName(name, used);
          used.add(name.toLowerCase());
          const plan = planColumns(t.columns);
          const fullName = secondTableName(fullPrefixes[state.file]!, t.name, file.tables.length, name);
          const planned: PlannedTable = { index, source: t.name, name, ...(fullName ? { fullName } : {}), kept: plan.kept, packed: plan.packed, notes: t.notes, keyFrom: null };
          planned.keyFrom = keyFromFor(ctx, planned);
          tables.push(planned);
        });
        if (!tables.length) {
          state.skipped.push({ file: f.name, why: `${f.name} holds no table with any values.` });
          nextFile();
          continue;
        }
        state.tables = tables;
        state.table = 0;
        state.current = null;
        save(() => keepCodePage(ctx, f));
        continue;
      }
      if (state.table >= state.tables.length) {
        nextFile();
        continue;
      }
      const t = state.tables[state.table]!;
      // A table an older store began has no `_key`: it is loaded again from its first row.
      if (state.current && (state.current.how ?? "whole") === "whole" && !state.current.done && tableExists(ctx, `${t.name}__new`) && !hasColumn(ctx, `${t.name}__new`, KEY_COLUMN)) {
        state.rows -= state.current.rows;
        state.current = null;
      }
      if (!state.current) {
        const plan = t.whole ? null : planReload(ctx, state, t);
        if (plan) {
          // A reload by keys: the store as it stands is where its history's Restore to Here goes.
          const restorePoint = await ctx.tables.bookmark();
          state.current = { cursor: null, rows: 0, deleted: 0, extra: plan.extra, done: false, cut: 0, stopped: null, key: plan.key, keyed: true, how: plan.how, reload: { ...plan.reload, restorePoint } };
          const files = plan.reload.files;
          save(() => {
            if (!files) return;
            // A parked table's new files: their record goes in first, marked to go, so the files of a
            // reload that stops part way go once the restore window has passed; and the mark that the
            // reload is under way, so a LOAD after one that stopped records its change whole.
            const now = new Date(ctx.now()).toISOString();
            ctx.sql.exec(
              "INSERT INTO _parked (id, tbl, version, change, prefix, columns, rows, bytes, parts, at, superseded_at) VALUES (?, ?, ?, 0, ?, ?, 0, 0, 0, ?, ?) ON CONFLICT (id) DO NOTHING",
              files.id,
              t.name,
              files.version,
              files.prefix,
              JSON.stringify(files.columns),
              now,
              now,
            );
            ctx.sql.exec("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", reloadKey(t.name), ctx.job.id);
          });
          continue;
        }
        const fresh = ctx.tables.begin(t.name);
        state.current = { cursor: null, rows: 0, deleted: 0, extra: t.packed.length > 0, done: false, cut: 0, stopped: null, how: "whole" };
        const extra = state.current.extra;
        save(() => void ctx.sql.exec(createSql(fresh, t, extra)));
        continue;
      }
      const p = state.current;
      const how = p.how ?? "whole";
      /** A reload makes the table whole after all: what it wrote stays, and that change is recorded whole. */
      const fallBack = () => {
        t.whole = true;
        t.wholeChange = true;
        state.rows -= p.rows;
        state.current = null;
        claimed = null;
        save(() => abandonDeltas(ctx.sql, ctx.job.id));
      };
      if (!p.done) {
        let batch: RowBatch;
        try {
          batch = await file.rows(t.index, p.cursor, { rows: BATCH_ROWS, bytes: BATCH_BYTES });
        } catch (err) {
          if (retried(ctx, f, err)) throw err;
          // The file cannot be read on: this table and the file's tables after it are skipped, and
          // the tables of it already made stay. A reload's open change reads as whole for good.
          const from = p.rows ? ` after ${p.rows} rows of ${t.source ?? f.name}` : "";
          const left =
            how === "place" && p.rows
              ? ` ${t.name} changed in place up to there; its other rows are as the last load left them.`
              : how === "parked" && p.rows
                ? ` ${t.name} keeps the files of the last load, and its next load makes it whole.`
                : "";
          state.skipped.push({ file: f.name, why: `${f.name} could not be read on${from}: ${unreadable(f, err)}${left}` });
          nextFile(() => (how === "whole" ? ctx.tables.abandon(t.name) : abandonDeltas(ctx.sql, ctx.job.id)));
          continue;
        }
        // A reader that gives no rows and stays where it was would be asked again forever: the
        // table ends there.
        const stuck = !batch.rows.length && batch.next !== null && sameCursor(batch.next, p.cursor);
        // The key column is chosen on the first batch with rows, and kept for the whole table.
        let key = p.key;
        if (key === undefined && (batch.rows.length || batch.next === null || stuck)) {
          const column = t.keyFrom === "" ? null : keyColumnOf(t.kept, batch.rows.map((r) => r.values), t.keyFrom);
          key = column ? column.name : "";
        }
        const keyAt = key ? t.kept.findIndex((c) => c.name === key) : -1;
        let cut = 0;
        const rows = batch.rows.map((r) => {
          const values = [...r.values];
          const more = r.extra ? { ...r.extra } : undefined;
          cut += fitRow(values, more);
          const packed = packRow({ kept: t.kept, packed: t.packed }, values, more);
          const hash = rowHash([...packed.kept, packed.extra]);
          return { n: r.n, base: rowKey(keyAt >= 0 ? packed.kept[keyAt] : null, hash), hash, kept: packed.kept, extra: packed.extra };
        });
        const addExtra = !p.extra && rows.some((r) => r.extra !== null);
        const extra = p.extra || addExtra;
        const advanced: TableProgress = {
          ...p,
          cursor: stuck ? null : batch.next,
          rows: p.rows + rows.length,
          deleted: p.deleted + batch.deleted,
          extra,
          done: stuck || batch.next === null,
          cut: p.cut + cut,
          stopped: stuck ? `The reader stopped at ${JSON.stringify(batch.next)} before the file's end, and the rows after it were not loaded.` : p.stopped,
          ...(key === undefined ? {} : { key }),
          ...(batch.notes?.length ? { found: [...(p.found ?? []), ...batch.notes] } : {}),
        };
        if (how === "whole") {
          const fresh = `${t.name}__new`;
          state.current = advanced;
          state.rows += rows.length;
          save(() => {
            if (addExtra) ctx.sql.exec(`ALTER TABLE ${quote(fresh)} ADD COLUMN ${quote(EXTRA_COLUMN)} TEXT`);
            if (!rows.length) return;
            const insert = insertSql(fresh, t, extra);
            for (const r of rows) {
              const values = [f.id, r.n, r.base, r.hash, ...r.kept, r.extra];
              ctx.sql.exec(insert, ...(extra ? values : values.slice(0, -1)));
            }
          });
          continue;
        }

        // A reload by keys: the file's rows take their keys, and only those that differ from the
        // store's memory are written.
        const rl = p.reload!;
        // A parked table's files have no `_extra` column for a row's values past the first 90.
        if (addExtra && how === "parked") {
          fallBack();
          continue;
        }
        const claims = claimsOf(rl);
        const keys = takeKeys(ctx.sql, t.name, claims, rows.map((r) => r.base));
        if (!keys) {
          fallBack();
          continue;
        }
        const added: { i: number; k: string; h: string; n: number }[] = [];
        const changed: { i: number; k: string; h: string }[] = [];
        keys.forEach(({ key: k, known }, i) => {
          const r = rows[i]!;
          if (!known) {
            const n = claims.allocate();
            claims.take(n);
            added.push({ i, k, h: r.hash, n });
          } else if (known.h !== r.hash) changed.push({ i, k, h: r.hash });
        });
        // In place, most rows differing costs more than the whole table: every row, and the index.
        const read = p.rows + rows.length;
        const differ = rl.counts.added + rl.counts.changed + added.length + changed.length;
        if (claims.tooMany || (how === "place" && read >= Math.min(rl.known, MOST_AFTER) && differ > WHOLE_SHARE * read)) {
          fallBack();
          continue;
        }
        rl.counts.added += added.length;
        rl.counts.changed += changed.length;
        appendAll(rl.pending.added, added.map((a) => a.k));
        appendAll(rl.pending.changed, changed.map((c) => c.k));
        const parts = fullParts(rl, false);
        rl.claims = claims.state();
        // The state is one value of the store's, at most 2 MB: past STATE_BYTES_MAX (a table of
        // millions of keys, or of many repeated ones), the whole table costs less than a failed job.
        if (utf8Length(JSON.stringify(state)) > STATE_BYTES_MAX) {
          fallBack();
          continue;
        }
        // A parked table's new files take every row, in the files' column order; written before the
        // commit that counts them, so a chunk cut short writes the same part again.
        if (how === "parked" && rows.length) {
          const files = rl.files!;
          const lines = rows.map((r, i) => JSON.stringify([f.id, r.n, keys[i]!.key, r.hash, ...r.kept, ...(extra ? [r.extra] : [])]));
          files.bytes += await putPart(ctx.bucket, files.prefix, files.parts, lines, { table: t.name, version: files.version });
          files.parts++;
          files.rows += lines.length;
        }
        state.current = advanced;
        state.rows += rows.length;
        save(() => {
          if (rl.change === null && (added.length || changed.length)) rl.change = ctx.tables.openChange(t.name);
          if (how === "place") {
            if (addExtra) ctx.sql.exec(`ALTER TABLE ${quote(t.name)} ADD COLUMN ${quote(EXTRA_COLUMN)} TEXT`);
            if (changed.length && !rl.indexed) {
              ensureKeyIndex(ctx, t.name);
              rl.indexed = true;
            }
            const insert = insertSql(t.name, t, extra);
            for (const a of added) {
              const r = rows[a.i]!;
              const values = [f.id, r.n, a.k, r.hash, ...r.kept, r.extra];
              ctx.sql.exec(insert, ...(extra ? values : values.slice(0, -1)));
            }
            const update = updateSql(t.name, t, extra);
            for (const c of changed) {
              const r = rows[c.i]!;
              ctx.sql.exec(update, f.id, r.n, r.hash, ...r.kept, ...(extra ? [r.extra] : []), c.k);
            }
          }
          rememberKeys(ctx.sql, t.name, { added: added.map(({ k, h, n }) => ({ k, h, n })), changed: changed.map(({ k, h }) => ({ k, h })) });
          writeKeys(ctx, t.name, rl, parts);
        });
        continue;
      }

      if (how !== "whole") {
        const rl = p.reload!;
        // Every row is read: the keys no row of the file took are the rows it no longer holds.
        if (!rl.swept) {
          const gone = untaken(ctx.sql, t.name, claimsOf(rl));
          // In place, a file that lost more than twice the rows it holds (a cut-short export, say)
          // costs less made whole: a DROP writes nothing, where each removed row costs its DELETE
          // and its hash.
          if (how === "place" && gone.length > 2 * p.rows) {
            fallBack();
            continue;
          }
          rl.counts.removed += gone.length;
          appendAll(rl.pending.removed, gone);
          rl.swept = true;
          const parts = fullParts(rl, false);
          save(() => {
            if (rl.change === null && gone.length) rl.change = ctx.tables.openChange(t.name);
            if (how === "place") {
              for (const part of byChars(gone, (k) => k.length + 4)) ctx.sql.exec(`DELETE FROM ${quote(t.name)} WHERE ${quote(KEY_COLUMN)} IN (SELECT value FROM json_each(?))`, JSON.stringify(part));
            }
            rememberKeys(ctx.sql, t.name, { removed: gone });
            writeKeys(ctx, t.name, rl, parts);
          });
          continue;
        }
        // The end: the change closed, whole when most of the table changed, and a parked table's
        // new files in place of the old.
        const c = rl.counts;
        const files = rl.files;
        const now = files ? files.rows : rl.known + c.added - c.removed;
        const whole = c.added + c.changed + c.removed > WHOLE_SHARE * Math.max(now, rl.known);
        if (files && rl.change !== null) await putManifest(ctx.bucket, { table: t.name, version: files.version, change: rl.change, prefix: files.prefix, columns: files.columns, rows: files.rows, parts: files.parts, bytes: files.bytes });
        const notes = [...file.notes, ...t.notes, ...(p.found ?? [])];
        if (p.deleted) notes.push(`${p.deleted} row${p.deleted === 1 ? " was" : "s were"} marked deleted in the file, and ${p.deleted === 1 ? "was" : "were"} not loaded.`);
        if (t.packed.length) notes.push(packedNote(t));
        if (p.cut) notes.push(`${p.cut} value${p.cut === 1 ? " was" : "s were"} cut: a store keeps at most ${ROW_CHARS_MAX.toLocaleString("en-US")} characters in a row.`);
        if (p.stopped) notes.push(p.stopped);
        if (files) notes.push(`${t.name} stays parked: its rows are in the store's files, and only the rows that changed were recorded.`);
        const parts = fullParts(rl, true);
        save(() => {
          let made: CommittedTable | null = null;
          // The catalog's words for its columns, its packed ones and its second name, whether or
          // not a row changed: a table loaded before the store kept them gets them now. Each writes
          // only what differs.
          ctx.tables.describe(t.name, columnsOf(t, p.key ?? "", p.extra));
          keepSecondName(ctx, t);
          if (rl.change !== null) {
            writeKeys(ctx, t.name, rl, parts);
            if (files) ctx.tables.reparked(t.name, { id: files.id, version: files.version, change: rl.change, prefix: files.prefix, columns: files.columns, rows: files.rows, bytes: files.bytes, parts: files.parts });
            made = ctx.tables.close(t.name, rl.change, {
              madeBy: ctx.params.madeBy,
              note: (n) => `loaded again from ${f.name}: ${n.added.toLocaleString("en-US")} added, ${n.changed.toLocaleString("en-US")} changed, ${n.removed.toLocaleString("en-US")} removed`,
              restorePoint: rl.restorePoint,
              whole,
            });
          }
          ctx.sql.exec("DELETE FROM _meta WHERE key = ?", reloadKey(t.name));
          const row = ctx.sql.exec<{ version: number; rows: number | null }>("SELECT version, rows FROM _tables WHERE name = ?", t.name).one();
          const d = made ? (made as CommittedTable).delta : null;
          state.made.push({
            table: t.name,
            version: Number(row.version),
            rows: made ? (made as CommittedTable).rows : Number(row.rows ?? 0),
            file: f.name,
            sheet: t.source,
            notes,
            changes: d ? (d.whole ? null : { added: d.added, changed: d.changed, removed: d.removed }) : { added: 0, changed: 0, removed: 0 },
            ...namedAs(t),
          });
          state.table++;
          state.current = null;
        });
        continue;
      }

      // Every row is in: a repeated key gets its "#2", "#3", once.
      const fresh = `${t.name}__new`;
      if (!p.keyed && tableExists(ctx, fresh)) {
        state.current = { ...p, keyed: true };
        save(() => {
          for (const statement of keySql(fresh)) ctx.sql.exec(statement);
        });
        continue;
      }
      // The new version is swapped in, once.
      let handle: { table: string; version: number; rows: number };
      let changes: LoadedTable["changes"] = null;
      if (tableExists(ctx, fresh)) {
        const keyFrom = p.key ?? "";
        const committed = await ctx.tables.commit(t.name, {
          group: LOADED_GROUP,
          madeBy: ctx.params.madeBy,
          dropOld: true,
          delta: "load",
          ...(t.wholeChange ? { wholeChange: true } : {}),
          keyFrom,
          keep: ctx.params.keep?.[t.name.toLowerCase()],
          columns: columnsOf(t, keyFrom, p.extra),
        });
        handle = committed;
        const d = committed.delta;
        changes = d && !d.whole ? { added: d.added, changed: d.changed, removed: d.removed } : null;
      } else {
        // An earlier chunk swapped it in and stopped before it said so.
        const row = ctx.sql.exec<{ version: number; rows: number }>("SELECT version, rows FROM _tables WHERE name = ?", t.name).toArray()[0];
        if (!row) throw new Error(`The new version of ${t.name} is gone, and the store has no record of it.`);
        handle = { table: t.name, version: Number(row.version), rows: Number(row.rows) };
        const d = ctx.sql
          .exec<{ whole: number; added: number; changed: number; removed: number }>("SELECT whole, added, changed, removed FROM _deltas WHERE tbl = ? AND job = ? ORDER BY change DESC LIMIT 1", t.name, ctx.job.id)
          .toArray()[0];
        changes = d && Number(d.whole) === 0 ? { added: Number(d.added), changed: Number(d.changed), removed: Number(d.removed) } : null;
      }
      const notes = [...file.notes, ...t.notes, ...(p.found ?? [])];
      if (p.deleted) notes.push(`${p.deleted} row${p.deleted === 1 ? " was" : "s were"} marked deleted in the file, and ${p.deleted === 1 ? "was" : "were"} not loaded.`);
      if (t.packed.length) notes.push(packedNote(t));
      if (p.cut) notes.push(`${p.cut} value${p.cut === 1 ? " was" : "s were"} cut: a store keeps at most ${ROW_CHARS_MAX.toLocaleString("en-US")} characters in a row.`);
      if (p.stopped) notes.push(p.stopped);
      state.made.push({ table: handle.table, version: handle.version, rows: handle.rows, file: f.name, sheet: t.source, notes, changes, ...namedAs(t) });
      state.table++;
      state.current = null;
      // A reload of a parked table that stopped part way is made good: its mark goes. The table's
      // second name is kept with it.
      save(() => {
        ctx.sql.exec("DELETE FROM _meta WHERE key = ?", reloadKey(t.name));
        keepSecondName(ctx, t);
      });
    }
    return { more: true };
  },
};
