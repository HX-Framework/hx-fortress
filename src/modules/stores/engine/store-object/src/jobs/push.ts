// PUSH and COMPARE: a store's table written into a database's table, and the two compared, by key
// (DB Connect, F3). db_push_preview, db_push and db_compare (the api's agent/tools/
// databases.ts) submit the jobs; a DB IO job (DB IO, a Go program: apps/db-io/internal/push)
// then reads the store's rows and the database's, and sends the store what it found, through the
// gateway with the job's key, as a pull's pages come (jobs/pull.ts). `store-readers/push`
// has the design and the wire.
//
//   • Each is a job like any other (one at a time per store, made once per request key), and, like a
//     pull, it does no work on its own alarms: while its DB IO job works, its chunk only sleeps until
//     the job's time is up (`{ wait }`), and each call does its own work. The DB IO job's end wakes it
//     to make its table, and a failure, or its time running out, wakes it to fail.
//   • push_preview: the DB IO job reads the store's table (`source`) a page at a time, and the
//     store's memory of its last write (`_pushed`), and sends a row for each key where a write would
//     do something. The store keeps them in `<into>__new`, made visible at the end in "Previews":
//     what happens to each row, what the database holds now and what it would hold, and the values
//     to write (`_values`). A row the database already holds as the store does goes into the memory
//     as written (`adopt`); a key neither side holds any more leaves it (`forget`). What a push of
//     the preview reads is kept under `previewKey`.
//     A preview may count links (`links`): a column of the write whose value names a row of another
//     table. The DB IO job counts them over the rows to write, and a row whose link finds no row
//     says so in its note.
//   • push of one preview: the DB IO job reads the preview's rows to write a batch at a time, after
//     the cursor, writes each batch in one transaction on the database, and sends how each row
//     ended, as one page. For each row written the store keeps the hash of what was sent and of
//     what the database held after, and records what the write did to it (`_push_writes`,
//     jobs/push-writes.ts), and the cursor moves past the batch. At the end, the rows held back (at
//     the preview, and those the database changed after it) are a table of their own, in "To
//     review".
//   • push of several previews (`also`), or a rehearsal (`rehearse`): the whole write is one
//     transaction on the database. Each DB IO job begins it again (`rows/begin` with `again`), which
//     forgets what the store took of the one before, and sends each batch's outcomes as a page of
//     one of its parts (`table`): the store keeps them pending, and applies nothing of them until
//     the DB IO job's end says the database committed. A rehearsal's DB IO job rolls the transaction
//     back: its pages become its manifests, one table per database table (group "Rehearsals"), and
//     neither the memory nor the record of who wrote changes.
//   • push_undo: one write taken back, in one transaction, as a write of several previews is: the
//     DB IO job reads the write's rows (`_push_writes`), puts back those that still hold what the write
//     left, and holds the rest. At its committed end each undone key's memory is what it was before
//     the write, and the rows it held are a table in "To review".
//   • compare: read as a preview is, but the DB IO job sends each key whose rows differ, and the
//     store keeps them, up to COMPARE_ROWS_MAX, in "Comparisons". It never changes the memory.
//   • The memory is kept for each database table, with a record of its key and columns
//     (`pushRecordKey`): a preview that begins with another key or other columns forgets it, and who
//     wrote, so the next write asks a person first. A rehearsal changes neither.
//   • Each page is one transaction: its rows, the page's number and the job's count of rows written.
//     A page sent again is answered as taken before. A preview's, a compare's, a one-transaction
//     write's and an undo's successor begins again; a write of one preview goes on after the cursor.
//     A job's pages are numbered in one row, whichever of its parts each is of.

import { cleanColumnName, EXTRA_COLUMN, MAX_KEPT_COLUMNS, packRow, planColumns, type ColumnPlan, type PlannedColumn } from "../../../store-readers/src/index.js";
import { HASH_COLUMN as HASH, KEY_COLUMN as KEY, MAX_TABLE_NAME } from "../../../store-readers/src/jobs.js";
import { PULL_STORE_LIMIT } from "../../../store-readers/src/pull.js";
import {
  COMPARE_ROWS_MAX,
  COMPARED_GROUP,
  compareParamsOf,
  compareRowsOf,
  HELD_GROUP,
  heldTableName,
  KEPT_HOWS,
  keptTableName,
  PREVIEW_GROUP,
  previewKey,
  previewRowsOf,
  pushParamsOf,
  pushPreviewParamsOf,
  pushRecordKey,
  PushShapeError,
  pushTargetId,
  pushUndoParamsOf,
  pushWriteKey,
  REHEARSAL_GROUP,
  rehearsalTableName,
  ROWS_JOB_KINDS,
  ROWS_LIMITS,
  rowsBeginAgainOf,
  rowsBeginOf,
  rowsEndOf,
  rowsFailOf,
  rowsReadOf,
  rowsSendOf,
  tableRefText,
  undoHeldTableName,
  undoneRowsOf,
  writtenRowsOf,
  type CompareParams,
  type CompareResult,
  type CompareRow,
  type DatabaseTableRef,
  type HeldWhy,
  type KeptColumn,
  type KeptValue,
  type LinkCount,
  type LinkSpec,
  type PreviewRef,
  type PreviewRow,
  type PushParams,
  type PushPartResult,
  type PushPreviewParams,
  type PushPreviewResult,
  type PushRecord,
  type PushResult,
  type PushUndoParams,
  type PushUndoResult,
  type PushWriteRecord,
  type PushWriter,
  type RowsBeginAnswer,
  type RowsBeginBody,
  type RowsEndAnswer,
  type RowsEndBody,
  type RowsJobKind,
  type RowsPart,
  type RowsReadAnswer,
  type RowsReadBody,
  type RowsSendAnswer,
  type RowsSendBody,
  type RowsState,
  type SavedPreview,
  type TheirEdits,
  type WriteRow,
  type WrittenRow,
} from "../../../store-readers/src/push.js";
import { sha256Hex, StoreError, type StoreCore } from "../core.js";
import { CountedSql } from "../metered-sql.js";
import { isParked } from "../park.js";
import { programTables, ProgramTableError } from "../program-tables.js";
import { getMeta, savedJson, setMeta } from "../schema.js";
import { columnNames, ident as quote, isReservedName, tableExists, type SqlLike, type StoreSqlValue } from "../sql.js";
import type { JobProgress, JobTableProgress } from "../types.js";
import { dayEndsAt, refusePastWriteLimit, writesToday } from "../write-limit.js";
import { batches, countedCore, fresh, keyedJob, type KeyedJobRow, PULL_KEPT_AFTER_MS, PULL_WAITS_MS, shaped, upsertFromJson, upsertOne } from "./pull.js";
import {
  forget,
  forgetPending,
  KEYS_AT_ONCE,
  keyParts,
  markRows,
  memoryOf,
  pendingRows,
  putBack,
  recordedKeys,
  recordRows,
  recordUndone,
  recordWrites,
  remember,
  type Previewed,
  undoableCounts,
  undoableOf,
  undoCount,
  undoRows,
} from "./push-writes.js";
import { type JobContext, type JobHandler, type JobOutcome, JobParamsError, type ProgramTables } from "./types.js";

// ─── names and limits ─────────────────────────────────────────────────────────────────────────

/** A preview table's columns for the machine, past `_key` and `_hash`: the hash of what the database holds, the values to write, and the columns a change changes. */
const NOW_HASH = "_now_hash";
const VALUES = "_values";
const CHANGED = "_changed";
/** A preview row's database values as it read them, in its columns' order: what a write that left no record of a row changed it from. */
const BEFORE = "_before";
const PREVIEW_MACHINE = [KEY, HASH, NOW_HASH, VALUES, CHANGED, BEFORE] as const;
const COMPARE_MACHINE = [KEY] as const;
/** A rehearsal's manifest's columns for the machine, past `_key` and `_hash` (what the write sent): the hash of what the database held after it, inside its transaction. */
const AFTER_HASH = "_after_hash";
const MANIFEST_MACHINE = [KEY, HASH, AFTER_HASH] as const;
/** The words a person reads in a preview's table, and in a compare's. */
const WHAT = "what_happens";
const NOTE = "note";
const DIFFERENCE = "difference";
const DIFFERING = "columns";
/** The words a person reads in a rehearsal's manifest and in an undo's held rows: what the write did, and the columns it set. */
const WHAT_HAPPENED = "what_happened";
const COLUMNS_SET = "columns_set";

/** About the most bytes of JSON one read answers: a read of wide rows ends early, and its `next` goes on from there. */
const READ_BYTES = 4_000_000;
/** A store answers at most this many columns at once: a table read by its rowid needs one for it. */
const RESULT_COLUMNS_MAX = 100;
/** The most keys held since its preview a push lists in its held table, and about the most bytes of JSON they take in its state; the rest are counted. */
const HELD_LISTED_MAX = 10_000;
/** A write's list of the rows its database kept differently holds at most this many of a table's rows, as a compare's table does; the rest are counted. */
const KEPT_LISTED_MAX = 100_000;
const HELD_LISTED_BYTES = 1_000_000;

const ROWS_KINDS: ReadonlySet<string> = new Set(ROWS_JOB_KINDS);
const WORDS: Readonly<Record<RowsJobKind, string>> = { push_preview: "preview", push: "write", compare: "compare", push_undo: "undo" };

const utf8 = new TextEncoder();
const bytesOf = (text: string): number => utf8.encode(text).byteLength;
const sameList = (a: readonly string[] | null | undefined, b: readonly string[]): boolean => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
const many = (n: number, one: string, more = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : more}`;
/** Names as words: "permit_no", "permit_no or year", "permit_no, year or ward". */
const oneOf = (names: readonly string[]): string => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`);
/** Names as words: "town.permits", "town.submissions and town.permits". */
const allOf = (names: readonly string[]): string => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const sum = <T>(items: readonly T[], of: (item: T) => number): number => items.reduce((n, item) => n + of(item), 0);

/**
 * A value of the store's as a DB IO job reads it: its text, a BLOB as `\x` and its hex digits, or
 * NULL. Never a number: one past 2^53 would lose digits on its way.
 */
const valueSql = (expr: string): string => `CASE WHEN typeof(${expr}) = 'blob' THEN '\\x' || lower(hex(${expr})) ELSE CAST(${expr} AS TEXT) END`;

// ─── the job's state ──────────────────────────────────────────────────────────────────────────

/** What a preview has taken so far: the rows of its table by what would happen, and its changes to the memory. */
interface PreviewCounts {
  inserts: number;
  updates: number;
  deletes: number;
  held: number;
  adopted: number;
  forgotten: number;
}

/** What a DB IO job counted at its end. */
interface EndCounts {
  read: number;
  targetRows: number;
  same: number;
  otherRows: number;
  /** A preview's: each link's counts, as the DB IO job sent them. */
  links?: LinkCount[];
}

/** A preview's and a compare's state: the store's table, read against the database's. */
interface ReadingState {
  /** taking: the DB IO job's calls come in. finishing: it ended its part, and the store makes its table. failing: the job fails with `failure`. */
  phase: "taking" | "finishing" | "failing";
  failure: string | null;
  /** The store's table or view, as its schema spells it. */
  table: string;
  begun: boolean;
  /** The database's columns both sides have, in its order; the store's column each is read from; the database's type of each. */
  columns: string[];
  sources: string[];
  types: string[];
  key: string[];
  missing: string[];
  ignored: string[];
  /** The rowid the store's table is read in the order of; null: a view, or a table read by place. */
  rowid: string | null;
  /** The made table's columns a person reads: kept as columns, and packed into `_extra`. */
  display: ColumnPlan;
  /** The last page taken. */
  page: number;
  end: EndCounts | null;
}

interface PreviewState extends ReadingState {
  counts: PreviewCounts;
  /** Once begun: the links it counts, each column as the database's table spells it. */
  links?: LinkSpec[];
  /** By link: rows whose value names a row the store's newest preview of the linked table adds (`addedByPreviews`). */
  added?: number[];
  made: PushPreviewResult | null;
}

interface CompareState extends ReadingState {
  /** Rows the compare's table holds. */
  listed: number;
  onlyInStore: number;
  onlyInDatabase: number;
  differing: number;
  unlisted: number;
  made: CompareResult | null;
}

/** One preview of a write: what it writes into one database's table, and how its rows ended so far. */
interface PushPart {
  preview: PreviewRef;
  /** The preview's, as the store saved it. */
  target: DatabaseTableRef;
  key: string[];
  columns: string[];
  theirEdits: TheirEdits;
  /** The preview's rows to write. */
  toWrite: number;
  inserted: number;
  updated: number;
  deleted: number;
  heldAtPreview: number;
  heldSince: number;
  /** The keys held since the preview, and why, for the held table; past HELD_LISTED_MAX they are only counted. */
  heldKeys: [string, HeldWhy][];
  heldKeysBytes: number;
  /** A rehearsal's manifest of this table: its name, and the columns a person reads in it. */
  manifest: { name: string; display: ColumnPlan } | null;
  /** The links its preview counted to another table of this write (`linksAcross`), kept with the write for an undo. */
  links?: LinkSpec[];
  /** Written rows the database kept other than the write sent them (DB IO's read-back), and those rows by column and how. Absent from a write the store began before it counted them. */
  kept?: number;
  keptColumns?: KeptColumn[];
  /** A write's list of those rows, `push_kept_<table>` (To review): its name and columns, and whether a page began it. None for a rehearsal, whose manifest holds every value, and none once its name was another table's. */
  keptList?: { name: string; display: ColumnPlan; begun: boolean } | null;
  /** The rows the list holds: past KEPT_LISTED_MAX they are only counted. */
  keptListed?: number;
}

/** A one-transaction job's DB IO job: whether one began it, and the hash of the key of the one that began it last. */
interface Begun {
  begun: boolean;
  begunBy: string | null;
}

interface PushState extends Begun {
  phase: "taking" | "finishing" | "failing";
  failure: string | null;
  /** Several previews, or a rehearsal: the whole write in one transaction, taken only at its end. */
  oneTransaction: boolean;
  rehearse: boolean;
  /** Each preview, in the order written. */
  parts: PushPart[];
  /** The last page (a batch's outcomes) taken, and that batch's last key. */
  page: number;
  cursor: string | null;
  batches: number;
  /** A rehearsal's rows read back after its rollback holding exactly what they held before. */
  restored: number | null;
  /** After a one-transaction write's committed end: the part and the last key its outcomes are taken up to. */
  applied: { part: number; after: string | null } | null;
  made: PushResult | null;
}

/** One database's table of the write an undo takes back. */
interface UndoPart {
  preview: PreviewRef;
  target: DatabaseTableRef;
  key: string[];
  columns: string[];
  /** The links its write kept between its tables: the undo holds the rows they join together. */
  links?: LinkSpec[];
  /** The write's rows of this table to take back. */
  toUndo: number;
  removed: number;
  putBack: number;
  reinserted: number;
  held: number;
}

interface UndoState extends Begun {
  phase: "taking" | "finishing" | "failing";
  failure: string | null;
  /** The write it takes back: its job's id. */
  write: string;
  parts: UndoPart[];
  page: number;
  /** After its committed end: the part and the last key its outcomes are taken up to. */
  applied: { part: number; after: string | null } | null;
  made: PushUndoResult | null;
}

type RowsJobState = PreviewState | CompareState | PushState | UndoState;

const kindOf = (row: KeyedJobRow): RowsJobKind => row.kind as RowsJobKind;
const stateOf = (row: KeyedJobRow): RowsJobState | null => {
  if (row.run_state === null) return null;
  const state = JSON.parse(row.run_state) as RowsJobState;
  return row.kind === "push" ? pushStateOf(state as PushState, JSON.parse(row.params) as PushParams) : state;
};

/**
 * A push's state as the store saved it. A write the store began before writes of several tables kept
 * its one preview's counts beside the rest (no `parts`): that preview becomes its one part, written a
 * batch at a time, so a write open across the change goes on.
 */
function pushStateOf(state: PushState, params: PushParams): PushState {
  if (Array.isArray(state.parts)) return state;
  type Before = Omit<PushState, "parts" | "oneTransaction" | "rehearse" | "begun" | "begunBy" | "restored" | "applied"> & Omit<PushPart, "preview" | "manifest">;
  const old = state as unknown as Before;
  const part: PushPart = {
    preview: params.preview,
    target: old.target,
    key: old.key,
    columns: old.columns,
    theirEdits: old.theirEdits,
    toWrite: old.toWrite,
    inserted: old.inserted,
    updated: old.updated,
    deleted: old.deleted,
    heldAtPreview: old.heldAtPreview,
    heldSince: old.heldSince,
    heldKeys: old.heldKeys ?? [],
    heldKeysBytes: old.heldKeysBytes ?? 0,
    manifest: null,
  };
  return { phase: old.phase, failure: old.failure, oneTransaction: false, rehearse: false, parts: [part], page: old.page, cursor: old.cursor, batches: old.batches, begun: false, begunBy: null, restored: null, applied: null, made: old.made };
}
const blankCounts = (): PreviewCounts => ({ inserts: 0, updates: 0, deletes: 0, held: 0, adopted: 0, forgotten: 0 });
const noEnd = (): EndCounts => ({ read: 0, targetRows: 0, same: 0, otherRows: 0 });

/** The job's state and its progress, and the rows these statements wrote, joined to the job's count. */
function saveState(core: StoreCore, jobId: string, state: RowsJobState, progress: JobProgress, rows: number): void {
  core.sql.exec(
    "UPDATE _jobs SET run_state = ?, progress = ?, rows_written = coalesce(rows_written, 0) + ?, updated_at = ? WHERE id = ?",
    JSON.stringify(state),
    JSON.stringify(progress),
    rows,
    core.nowIso(),
    jobId,
  );
}

function previewProgress(params: PushPreviewParams, state: PreviewState, note?: string): JobProgress {
  const c = state.counts;
  return { done: c.inserts + c.updates + c.deletes + c.held + c.adopted + c.forgotten, total: null, note: note ?? `Previewing a write of ${state.table} into ${tableRefText(params.target)}` };
}

function compareProgress(params: CompareParams, state: CompareState, note?: string): JobProgress {
  return { done: state.onlyInStore + state.onlyInDatabase + state.differing, total: null, note: note ?? `Comparing ${state.table} with ${tableRefText(params.target)}` };
}

const targetsOf = (parts: readonly { target: DatabaseTableRef }[]): string => allOf(parts.map((p) => tableRefText(p.target)));

/**
 * Each database table of a write or an undo as its progress shows it: its rows done (written, or
 * taken back, and held) out of its preview's. The first table not done is the one the job is on.
 * `ended`: the job has its result, and every table is done.
 */
function partsProgress<P extends { target: DatabaseTableRef; preview: PreviewRef }>(parts: readonly P[], done: (p: P) => number, total: (p: P) => number, ended: boolean): JobTableProgress[] {
  let on = false;
  return parts.map((p) => {
    const n = done(p);
    const of = total(p);
    let status: JobTableProgress["state"] = "done";
    if (!ended && n < of) {
      status = on ? "waiting" : "running";
      on = true;
    }
    return { name: tableRefText(p.target), source: p.preview.table, state: status, done: n, total: of };
  });
}

const written = (p: PushPart): number => p.inserted + p.updated + p.deleted + p.heldSince;
const undone = (p: UndoPart): number => p.removed + p.putBack + p.reinserted + p.held;

function pushProgress(state: PushState, note?: string, ended = false): JobProgress {
  return {
    done: sum(state.parts, written),
    total: sum(state.parts, (p) => p.toWrite),
    note: note ?? `${state.rehearse ? "Rehearsing a write" : "Writing"} into ${targetsOf(state.parts)}`,
    tables: partsProgress(state.parts, written, (p) => p.toWrite, ended),
  };
}

function undoProgress(state: UndoState, note?: string, ended = false): JobProgress {
  return {
    done: sum(state.parts, undone),
    total: sum(state.parts, (p) => p.toUndo),
    note: note ?? `Undoing a write into ${targetsOf(state.parts)}`,
    tables: partsProgress(state.parts, undone, (p) => p.toUndo, ended),
  };
}

/** A write's previews, in the order written: `preview`, then `also`. */
const previewsOf = (params: PushParams): PreviewRef[] => [params.preview, ...(params.also ?? [])];
/** Several previews, or a rehearsal: one transaction on the database for the whole write. */
const oneTransactionOf = (params: PushParams): boolean => (params.also?.length ?? 0) > 0 || params.rehearse === true;

// ─── the job's key ────────────────────────────────────────────────────────────────────────────

/** The job, for a call that carries the key whose hash is `hash`: refused unless the key is the one given last. */
function admitted(core: StoreCore, jobId: string, hash: string): KeyedJobRow {
  const row = keyedJob(core, jobId, ROWS_KINDS, "That job does not take rows.");
  if (row.key_hash !== hash) throw new StoreError(403, "job_key_refused", `This key is not the one this ${WORDS[kindOf(row)]} takes rows with: a newer DB IO job holds it.`);
  return row;
}

/** The job as a call that brings or reads rows may use it: running, taking its DB IO job's calls, with its state. */
function taking(core: StoreCore, jobId: string, hash: string): { row: KeyedJobRow; kind: RowsJobKind; state: RowsJobState } {
  const row = admitted(core, jobId, hash);
  const state = stateOf(row);
  const what = WORDS[kindOf(row)];
  if (row.state !== "running" || !state) throw new StoreError(409, "job_not_taking", `The store has not started this ${what} yet: another job is running.`);
  if (state.phase !== "taking") throw new StoreError(409, "job_not_taking", `This ${what} takes no more rows: its DB IO job ended its part, or it failed.`);
  return { row, kind: kindOf(row), state };
}

/** A preview's or a compare's state, refused until its DB IO job began it. */
function begunState(kind: RowsJobKind, state: RowsJobState): PreviewState | CompareState {
  const reading = state as PreviewState | CompareState;
  if (!reading.begun) throw new StoreError(409, "rows_not_begun", `This ${WORDS[kind]} has not begun: its DB IO job begins it with the database's columns first.`);
  return reading;
}

/**
 * Refuses a one-transaction write's or an undo's call from a DB IO job that did not begin it: each
 * DB IO job writes the whole of it again, in a transaction of its own, so what an earlier one sent is
 * not this one's.
 */
function refuseUnbegun(kind: RowsJobKind, state: Begun, keyHash: string | null): void {
  if (state.begunBy === null || state.begunBy !== keyHash) {
    throw new StoreError(409, "rows_not_begun", `This ${WORDS[kind]} is written in one transaction, which each DB IO job begins again: rows/begin with { again: true } first.`);
  }
}

/** A part of the job the DB IO job names (`table`), refused when the job has none of that number. */
function partOf<T>(parts: readonly T[], table: number | undefined, what: string): { part: T; at: number } {
  const at = table ?? 0;
  const part = parts[at];
  if (part === undefined) throw new StoreError(400, "bad_request", `This ${what} works on ${many(parts.length, "table")}: table is ${parts.length === 1 ? "0" : `0 to ${parts.length - 1}`}.`);
  return { part, at };
}

const rowsPart = (p: { target: DatabaseTableRef; key: string[]; columns: string[] }): RowsPart => ({ target: p.target, key: p.key, columns: p.columns });
const NO_PART: RowsPart = { target: { schema: "", name: "" }, key: [], columns: [] };

export async function rowsStateOf(core: StoreCore, jobId: string, key: string): Promise<RowsState> {
  const hash = await sha256Hex(key);
  const row = admitted(core, jobId, hash);
  const kind = kindOf(row);
  const state = stateOf(row);
  const status = (): RowsState["state"] => {
    if (row.state === "done") return "done";
    if (row.state === "failed") return "failed";
    if (row.state === "queued" || !state) return "waiting";
    return state.phase === "taking" ? "taking" : state.phase === "finishing" ? "finishing" : "failed";
  };
  const base = { kind, state: status(), error: row.error ?? state?.failure ?? null, limits: ROWS_LIMITS };
  if (kind === "push") {
    const own = state as PushState | null;
    const params = JSON.parse(row.params) as PushParams;
    // Before its first chunk a write is what its previews' records say.
    const saved = own ? [] : previewsOf(params).map((p) => savedJson<SavedPreview>(core.sql, previewKey(p.table)));
    const parts = own ? own.parts.map(rowsPart) : saved.map((s) => (s ? { target: s.targetRef, key: s.key, columns: s.columns } : NO_PART));
    const first = parts[0] ?? NO_PART;
    return {
      ...base,
      ...first,
      theirEdits: own?.parts[0]?.theirEdits ?? saved[0]?.theirEdits ?? "hold",
      removes: false,
      begun: own?.begun ?? false,
      page: own?.page ?? 0,
      cursor: own?.cursor ?? null,
      oneTransaction: oneTransactionOf(params),
      rehearse: params.rehearse === true,
      parts,
      links: [],
    };
  }
  if (kind === "push_undo") {
    const own = state as UndoState | null;
    // Before its first chunk an undo is what its write's record says.
    const record = own ? null : savedJson<PushWriteRecord>(core.sql, pushWriteKey((JSON.parse(row.params) as PushUndoParams).write));
    // Each part with the links its write kept: the undo holds the rows they join together.
    const parts = (own?.parts ?? record?.parts ?? []).map((p): RowsPart => ({ ...rowsPart(p), ...(p.links?.length ? { links: p.links } : {}) }));
    return {
      ...base,
      ...(parts[0] ?? NO_PART),
      theirEdits: "hold",
      removes: false,
      begun: own?.begun ?? false,
      page: own?.page ?? 0,
      cursor: null,
      oneTransaction: true,
      rehearse: false,
      parts,
      links: [],
    };
  }
  const params = JSON.parse(row.params) as PushPreviewParams | CompareParams;
  const reading = state as ReadingState | null;
  const part: RowsPart = { target: params.target, key: reading?.begun ? reading.key : params.key, columns: reading?.begun ? reading.columns : [] };
  return {
    ...base,
    ...part,
    theirEdits: kind === "push_preview" ? (params as PushPreviewParams).theirEdits : "hold",
    removes: kind === "push_preview" ? (params as PushPreviewParams).removes === true : false,
    begun: reading?.begun ?? false,
    page: reading?.page ?? 0,
    cursor: null,
    oneTransaction: false,
    rehearse: false,
    parts: [part],
    links: kind === "push_preview" ? ((reading as PreviewState | null)?.links ?? (params as PushPreviewParams).links ?? []) : [],
  };
}

// ─── the store's table, and the names a job makes ─────────────────────────────────────────────

interface SourceTable {
  name: string;
  type: "table" | "view";
  sql: string | null;
}

/**
 * The store's table or view a preview or a compare reads, as its schema spells it, or why there is
 * none. The store's own tables are none, and so is a table a job is still writing (`<name>__new`).
 */
function sourceOf(sql: SqlLike, name: string): SourceTable | string {
  const none = `This store has no table or view ${name}.`;
  if (isReservedName(name) || /__new$/i.test(name)) return none;
  const row = sql.exec<{ name: string; type: string; sql: string | null }>("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND lower(name) = lower(?)", name).toArray()[0];
  if (!row) return isParked(sql, name) ? `${name} is parked: its rows are in the store's files, not its database. Bring it back first.` : none;
  return { name: String(row.name), type: row.type === "view" ? "view" : "table", sql: row.sql === null ? null : String(row.sql) };
}

/** Why a preview or a compare may not make its table under this name, or null: it is free, or a table of the job's own group. */
function takenWhy(sql: SqlLike, into: string, group: string, what: string): string | null {
  const theirs = `${into} is one of this store's own tables, which its migrations made: a ${what} does not write it. Name its table another way.`;
  if (isReservedName(into)) return `${into} is a name the store keeps for itself. Name the ${what}'s table another way.`;
  const row = sql.exec<{ kind: string; grp: string | null }>("SELECT kind, grp FROM _tables WHERE lower(name) = lower(?)", into).toArray()[0];
  if (row) {
    if (row.kind !== "program") return theirs;
    if (row.grp !== group) return `${into} holds rows another step made (${row.grp ?? "no group"}): a ${what} does not replace it. Name its table another way.`;
    return null;
  }
  return sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table', 'view') AND lower(name) = lower(?)", into).toArray().length ? theirs : null;
}

const WITHOUT_ROWID = /\)\s*(?:STRICT\s*,\s*)?WITHOUT\s+ROWID\b/i;

/**
 * The rowid a table is read in the order of, a read after another: `rowid`, unless a column took
 * the name. Null reads it by place, as a view is read: a view, a table without a rowid, one whose
 * columns took all three of its names, or one so wide that its rowid would not fit in the answer.
 */
function rowidOf(sql: SqlLike, source: SourceTable, width: number): string | null {
  if (source.type !== "table" || WITHOUT_ROWID.test(source.sql ?? "") || width + 1 > RESULT_COLUMNS_MAX) return null;
  const taken = new Set(columnNames(sql, source.name).map((c) => c.toLowerCase()));
  return ["rowid", "_rowid_", "oid"].find((n) => !taken.has(n)) ?? null;
}

/**
 * The name a job makes one of its tables under: `base`, or the first after it that is free or a
 * table of the same kind an earlier job made (in `group`, with the columns `ours` knows it by), when
 * another step's table has the name. `used`: names this job gives its other tables. `earlier`: a
 * table of an earlier job is there.
 */
function madeTableName(sql: SqlLike, base: string, group: string, ours: (columns: string[]) => boolean, why: string, used: ReadonlySet<string> = new Set()): { name: string; earlier: boolean } {
  for (let k = 1; k <= 100; k++) {
    const name = k === 1 ? base : `${base.slice(0, MAX_TABLE_NAME - 4).replace(/_+$/, "")}_${k}`;
    if (used.has(name.toLowerCase())) continue;
    const row = sql.exec<{ kind: string; grp: string | null }>("SELECT kind, grp FROM _tables WHERE lower(name) = lower(?)", name).toArray()[0];
    const there = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table', 'view') AND lower(name) = lower(?)", name).toArray().length > 0;
    if (!row && !there) return { name, earlier: false };
    if (row?.kind !== "program" || row.grp !== group) continue;
    if (!there) return { name, earlier: false };
    // A check's flags are in the same group as held rows: a job's table is known by its columns.
    if (ours(columnNames(sql, name))) return { name, earlier: true };
  }
  throw new StoreError(409, "push_name_taken", `Every name for ${why} is another step's table.`);
}

/**
 * The table a push lists its held rows in: `push_held_<name>`, or the first after it that is free
 * or a held table of an earlier push, when another step's table has the name. `earlier`: a held
 * table of an earlier push is there, so a push with none held empties its list.
 */
function heldTableOf(sql: SqlLike, preview: string, used?: ReadonlySet<string>): { name: string; earlier: boolean } {
  return madeTableName(sql, heldTableName(preview), HELD_GROUP, (c) => c.includes(KEY) && c.includes(WHAT) && c.includes(NOTE), `the rows ${preview} held back`, used);
}

// ─── a made table's columns ───────────────────────────────────────────────────────────────────

/** A column's name with words after it, within a store column's 60 characters: `status_now`. */
function suffixed(name: string, suffix: string): string {
  return `${(cleanColumnName(name) || "column").slice(0, 60 - suffix.length).trimEnd()}${suffix}`;
}

/**
 * Where a column a person reads stands among a row's values (its `index`): the key's columns
 * first, then the job's own words, then two for each other column.
 */
type Role = { kind: "key"; column: string } | { kind: "word"; word: string } | { kind: "first" | "second"; column: string };

function roleOf(c: PlannedColumn, keyCount: number, words: readonly string[]): Role {
  if (c.index < keyCount) return { kind: "key", column: c.source };
  if (c.index < keyCount + words.length) return { kind: "word", word: words[c.index - keyCount]! };
  return { kind: (c.index - keyCount - words.length) % 2 === 0 ? "first" : "second", column: c.source };
}

/**
 * The columns a person reads in a preview's or a compare's table, as `packRow` takes them. A row's
 * values come in this order: the key's columns, `words` (the job's own), then two for each other
 * column (`suffixes`). The table holds them in this order: the key's columns, `words` but the last
 * `after` of them, the pairs that fit, then those `after`; pairs past MAX_KEPT_COLUMNS go into
 * `_extra` whole. Each name is unique and clear of the store's own and of `machine`; the job's own
 * words keep theirs, since they are named first.
 */
function displayPlan(
  machine: readonly string[],
  key: readonly { name: string; type: string }[],
  words: readonly string[],
  after: number,
  others: readonly { name: string; type: string }[],
  suffixes: readonly [string, string],
): ColumnPlan {
  const logical = [
    ...key.map((k) => ({ name: k.name, source: k.name, type: k.type })),
    ...words.map((w) => ({ name: w, source: w, type: "" })),
    ...others.flatMap((c) => suffixes.map((s) => ({ name: suffixed(c.name, s), source: c.name, type: c.type }))),
  ];
  const firstPair = key.length + words.length;
  // Named in this order: the job's own words, the key's columns, the pairs.
  const order = [...words.map((_, i) => key.length + i), ...key.map((_, i) => i), ...logical.slice(firstPair).map((_, i) => firstPair + i)];
  const planned = planColumns([...machine, ...order.map((i) => logical[i]!.name)].map((name) => ({ name, originalType: "" })));
  const names: string[] = [];
  for (const c of [...planned.kept, ...planned.packed]) if (c.index >= machine.length) names[order[c.index - machine.length]!] = c.name;
  const column = (i: number): PlannedColumn => ({ name: names[i]!, source: logical[i]!.source, originalType: logical[i]!.type, index: i });
  const pairs = Math.min(others.length, Math.floor((MAX_KEPT_COLUMNS - firstPair) / 2));
  const range = (from: number, to: number): PlannedColumn[] => Array.from({ length: to - from }, (_, i) => column(from + i));
  return {
    kept: [...range(0, firstPair - after), ...range(firstPair, firstPair + 2 * pairs), ...range(firstPair - after, firstPair)],
    packed: range(firstPair + 2 * pairs, logical.length),
  };
}

/** A job's columns as the key's and the others, with their types. */
function columnsOf(state: Pick<ReadingState, "columns" | "types" | "key">): { key: { name: string; type: string }[]; others: { name: string; type: string }[] } {
  const all = state.columns.map((name, i) => ({ name, type: state.types[i] ?? "" }));
  return { key: state.key.map((k) => all.find((c) => c.name === k)!), others: all.filter((c) => !state.key.includes(c.name)) };
}

const PREVIEW_WORDS = [WHAT, NOTE] as const;
const COMPARE_WORDS = [DIFFERENCE, DIFFERING] as const;
/** A rehearsal's manifest's words, and an undo's held rows': what the write did, the columns it set, and why a row was held. */
const MANIFEST_WORDS = [WHAT_HAPPENED, COLUMNS_SET, NOTE] as const;
/** The words a person reads in a write's list of the rows its database kept differently: what the write did, and the columns kept so and how. */
const KEPT_DIFFERENTLY = "kept_differently";
const KEPT_WORDS = [WHAT_HAPPENED, KEPT_DIFFERENTLY] as const;
/** How a list of kept values says each way. */
const KEPT_HOW_WORDS: Record<KeptValue["how"], string> = { cut: "cut short", rounded: "rounded", filled: "filled in", changed: "changed" };

function previewPlan(state: Pick<ReadingState, "columns" | "types" | "key">): ColumnPlan {
  const { key, others } = columnsOf(state);
  return displayPlan([NOW_HASH, VALUES, CHANGED, BEFORE], key, PREVIEW_WORDS, 1, others, ["_now", "_after"]);
}

function comparePlan(state: Pick<ReadingState, "columns" | "types" | "key">): ColumnPlan {
  const { key, others } = columnsOf(state);
  return displayPlan([], key, COMPARE_WORDS, 0, others, ["_store", "_database"]);
}

/**
 * A made table's columns, in its order: the ones a person reads first, `_extra` when some are packed,
 * then the machine's. A grid that shows every column (a run's card) opens on what a person reads.
 */
const madeColumns = (machine: readonly string[], display: ColumnPlan): string[] => [...display.kept.map((c) => c.name), ...(display.packed.length ? [EXTRA_COLUMN] : []), ...machine];

/** A made table's row: what `packRow` makes of the values a person reads, then the machine's values. */
function stored(machine: readonly (string | null)[], display: ColumnPlan, values: readonly (string | null)[]): (string | null)[] {
  const { kept, extra } = packRow(display, values);
  return [...kept, ...(display.packed.length ? [extra] : []), ...machine];
}

/** A key's values from its text, in the key's order: the text itself for a key of one column, the JSON array's for one of several; empty when it does not read. */
function keyValues(key: string, n: number): (string | null)[] {
  if (n === 1) return [key];
  try {
    const values = JSON.parse(key) as unknown;
    return Array.isArray(values) && values.length === n ? values.map((v) => (typeof v === "string" ? v : null)) : [];
  } catch {
    return [];
  }
}

/** A job's key and columns, in the database's spelling: a preview's or a compare's once begun, a write's part's. */
type KeyAndColumns = { key: readonly string[]; columns: readonly string[] };

/** The values a person reads of a row's key: the first side that holds the row, else its key's own text. */
function keyCells(state: KeyAndColumns, key: string, first: readonly (string | null)[] | null, second: readonly (string | null)[] | null): (string | null)[] {
  const own = keyValues(key, state.key.length);
  return state.key.map((k, i) => {
    const at = state.columns.indexOf(k);
    return first?.[at] ?? second?.[at] ?? own[i] ?? null;
  });
}

/** The places of a job's columns outside its key, in its order. */
const otherPlaces = (state: KeyAndColumns): number[] => state.columns.flatMap((c, i) => (state.key.includes(c) ? [] : [i]));

// ─── writing rows ─────────────────────────────────────────────────────────────────────────────

function insertFromJson(table: string, names: readonly string[]): string {
  return `INSERT INTO ${quote(table)} (${names.map(quote).join(", ")}) SELECT ${names.map((_, i) => `j.value ->> ${i}`).join(", ")} FROM json_each(?1) AS j`;
}

function insertOne(table: string, names: readonly string[]): string {
  return `INSERT INTO ${quote(table)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
}

/** Rows into a made table, as JSON a batch at a time; `upsert` replaces the row of a `_key` it already holds. */
function writeRows(sql: SqlLike, table: string, names: readonly string[], rows: (string | null)[][], upsert: boolean): void {
  const { json, single } = batches(rows);
  if (json.length) {
    const statement = upsert ? upsertFromJson(table, names) : insertFromJson(table, names);
    for (const batch of json) sql.exec(statement, batch);
  }
  if (single.length) {
    const statement = upsert ? upsertOne(table, names) : insertOne(table, names);
    for (const row of single) sql.exec(statement, ...row);
  }
}

// ─── a preview or a compare begins ────────────────────────────────────────────────────────────

/** The store's table matched to the database's, and the job's key, by the begin's rules. */
interface Matched {
  columns: string[];
  sources: string[];
  types: string[];
  key: string[];
  missing: string[];
  ignored: string[];
}

/**
 * The columns both tables have, in the database's order: for each of its columns, the store's of
 * exactly its name, else the one of its name without regard to case. A column of the store's whose
 * name starts with `_` is its own (`_key`, `_extra`), never written. The key is the one asked for,
 * else the database's primary key, in the database's spelling.
 */
function matched(sql: SqlLike, source: string, target: DatabaseTableRef, begin: RowsBeginBody, asked: readonly string[]): Matched {
  const own = columnNames(sql, source).filter((c) => !c.startsWith("_"));
  const used = new Set<string>();
  const out: Matched = { columns: [], sources: [], types: [], key: [], missing: [], ignored: [] };
  for (const c of begin.columns) {
    const match = own.find((s) => s === c.name && !used.has(s)) ?? own.find((s) => s.toLowerCase() === c.name.toLowerCase() && !used.has(s));
    if (match === undefined) {
      if (c.required) out.missing.push(c.name);
      continue;
    }
    used.add(match);
    out.columns.push(c.name);
    out.sources.push(match);
    out.types.push(c.type);
  }
  out.ignored = own.filter((s) => !used.has(s));
  const ref = tableRefText(target);
  const spelled = new Map(begin.columns.map((c) => [c.name.toLowerCase(), c.name]));
  out.key = asked.length
    ? asked.map((k) => {
        const name = spelled.get(k.toLowerCase());
        if (name === undefined) throw new StoreError(409, "push_key", `${ref} has no column ${k}, which the key names.`);
        return name;
      })
    : begin.primaryKey.map((k) => spelled.get(k.toLowerCase()) ?? k);
  if (!out.key.length) throw new StoreError(409, "push_key", `${ref} has no primary key: say which columns name a row.`);
  for (const k of out.key) {
    if (!out.columns.includes(k)) throw new StoreError(409, "push_key", `${source} has no column ${k}, which the key names: a row is found by its key on both sides.`);
  }
  return out;
}

/**
 * Refuses a store table that keeps columns packed in `_extra` (a pull or a load of a table wider
 * than MAX_KEPT_COLUMNS) when the database's table has columns the store's table does not hold as its
 * own: a write and a compare read only a table's own columns, so they would leave those out.
 */
function refusePacked(sql: SqlLike, source: string, target: DatabaseTableRef, begin: RowsBeginBody, m: Matched, what: string): void {
  if (begin.columns.length === m.columns.length || !columnNames(sql, source).includes(EXTRA_COLUMN)) return;
  if (!sql.exec(`SELECT 1 AS x FROM ${quote(source)} WHERE ${quote(EXTRA_COLUMN)} IS NOT NULL LIMIT 1`).toArray().length) return;
  throw new StoreError(
    409,
    "push_source",
    `${source} keeps some of its columns packed in ${EXTRA_COLUMN}, past the ${MAX_KEPT_COLUMNS} a store table holds as its own, and a ${what} reads only a table's own columns, so it would leave out columns of ${tableRefText(target)}. Shape a table of at most ${MAX_KEPT_COLUMNS} of its columns, the key among them, and ${what} that.`,
  );
}

/** Refuses a key that does not name each row of the store's table once: a row with no key, or a key of more than one row. Counts and names only, never a value. */
function refuseUnkeyed(sql: SqlLike, source: string, m: Matched, verb: string): void {
  const columns = m.key.map((k) => `t.${quote(m.sources[m.columns.indexOf(k)]!)}`);
  const from = `FROM ${quote(source)} AS t`;
  const empty = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n ${from} WHERE ${columns.map((c) => `${c} IS NULL`).join(" OR ")}`).one().n);
  if (empty > 0) {
    const what = m.key.length === 1 ? m.key[0]! : `value in ${oneOf(m.key)}`;
    throw new StoreError(409, "push_key", `${many(empty, "row")} of ${source} ${empty === 1 ? "has" : "have"} no ${what}: every row needs a key to be ${verb}.`);
  }
  // Grouped by the values as a DB IO job reads them, which is how it names a row: 7 and '7' are one key.
  const twice = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM (SELECT 1 ${from} GROUP BY ${columns.map(valueSql).join(", ")} HAVING count(*) > 1)`).one().n);
  if (twice > 0) throw new StoreError(409, "push_key", `${many(twice, "key")} ${twice === 1 ? "names" : "name"} more than one row of ${source}: a key names one row.`);
}

/** Whether a database table's record is of these key and columns: its memory and its writers are of them. */
function recordFits(record: PushRecord | null, m: { key: readonly string[]; columns: readonly string[] }): boolean {
  return record !== null && sameList(record.key, m.key) && sameList(record.columns, m.columns);
}

/**
 * Whether a writer wrote into a record's table before. A writer's name comes with a job, so it is
 * only ever looked up among the record's own entries: read as a property, a name such as
 * `constructor` would find what every object has, and such a writer would never be asked.
 */
function hasWriter(record: PushRecord, writer: PushWriter): boolean {
  return Object.hasOwn(record.writers ?? {}, writer);
}

/** Notes when a writer first wrote into a record's table, as an entry of the record's own. A later write keeps that first time. */
function addWriter(record: PushRecord, writer: PushWriter, at: string): void {
  if (!hasWriter(record, writer)) record.writers = { ...record.writers, [writer]: at };
}

/**
 * A write's record of its database table, of its preview's key and columns. When they are not the
 * record's, the memory of the old ones goes, and who wrote: at the write, never at a preview, so a
 * preview made with another key by mistake leaves the memory that holds people's edits back.
 */
function keepRecord(sql: SqlLike, connectionId: string, target: DatabaseTableRef, m: { key: string[]; columns: string[] }): void {
  const key = pushRecordKey(connectionId, target);
  if (recordFits(savedJson<PushRecord>(sql, key), m)) return;
  sql.exec("DELETE FROM _pushed WHERE target = ?", pushTargetId(connectionId, target));
  setMeta(sql, key, JSON.stringify({ key: m.key, columns: m.columns, writers: {}, last: null } satisfies PushRecord));
}

/**
 * The links a preview counts, each column as the database's table spells it: refused when a link
 * names a column the write does not write, the DB IO job could not count it.
 */
function spelledLinks(links: readonly LinkSpec[], m: Matched, target: DatabaseTableRef): LinkSpec[] {
  return links.map((l) => {
    const column = m.columns.find((c) => c === l.column) ?? m.columns.find((c) => c.toLowerCase() === l.column.toLowerCase());
    if (column === undefined) throw new StoreError(409, "push_link", `A link names ${l.column}, which is not a column this preview writes into ${tableRefText(target)}.`);
    return { column, to: l.to };
  });
}

/**
 * A one-transaction write's or an undo's begin: each DB IO job writes the whole of it again in a
 * transaction of its own, so what the store took of an earlier one goes (the database rolled it
 * back), its counts start over, and a rehearsal's manifests are begun anew.
 */
function beginAgain(core: StoreCore, row: KeyedJobRow, kind: "push" | "push_undo", state: PushState | UndoState, hash: string, body: unknown): RowsBeginAnswer {
  if (kind === "push" && !(state as PushState).oneTransaction) throw new StoreError(400, "bad_request", "A write of one preview does not begin: its columns and its key are its preview's, and it goes on after the store's cursor.");
  shaped(() => rowsBeginAgainOf(body));
  const sql = new CountedSql(core.meter);
  forgetPending(sql, row.id);
  if (kind === "push_undo") {
    const undo = state as UndoState;
    for (const part of undo.parts) Object.assign(part, { removed: 0, putBack: 0, reinserted: 0, held: 0 });
    Object.assign(undo, { page: 0, begun: true, begunBy: hash });
    saveState(core, row.id, undo, undoProgress(undo), sql.rows);
    return { columns: [], key: [], missing: [], rows: sum(undo.parts, (p) => p.toUndo) };
  }
  const push = state as PushState;
  const tables = programTables(countedCore(core, sql), { id: row.id, by: row.by_sub });
  for (const part of push.parts) {
    Object.assign(part, { inserted: 0, updated: 0, deleted: 0, heldSince: 0, heldKeys: [], heldKeysBytes: 0, kept: 0, keptColumns: [], keptListed: 0 });
    if (part.manifest) beginManifest(sql, tables, part.manifest);
    // What the database kept of a transaction it rolled back is not kept: the list begins again empty.
    if (part.keptList?.begun) beginManifest(sql, tables, part.keptList);
  }
  Object.assign(push, { page: 0, cursor: null, batches: 0, begun: true, begunBy: hash });
  saveState(core, row.id, push, pushProgress(push), sql.rows);
  return { columns: [], key: [], missing: [], rows: sum(push.parts, (p) => p.toWrite) };
}

export async function rowsBegin(core: StoreCore, jobId: string, key: string, body: unknown): Promise<RowsBeginAnswer> {
  const hash = await sha256Hex(key);
  return core.transaction(() => {
    const { row, kind, state } = taking(core, jobId, hash);
    if (kind === "push" || kind === "push_undo") return beginAgain(core, row, kind, state as PushState | UndoState, hash, body);
    const begin = shaped(() => rowsBeginOf(body));
    const params = JSON.parse(row.params) as PushPreviewParams | CompareParams;
    const what = WORDS[kind];
    const source = sourceOf(core.sql, params.source);
    if (typeof source === "string") throw new StoreError(409, "push_source", source);
    const why = takenWhy(core.sql, params.into, kind === "compare" ? COMPARED_GROUP : PREVIEW_GROUP, what);
    if (why) throw new StoreError(409, "push_name_taken", why);
    const m = matched(core.sql, source.name, params.target, begin, params.key);
    refusePacked(core.sql, source.name, params.target, begin, m, what);
    refuseUnkeyed(core.sql, source.name, m, kind === "compare" ? "compared" : "written");
    const links = kind === "push_preview" ? spelledLinks((params as PushPreviewParams).links ?? [], m, params.target) : [];
    const sql = new CountedSql(core.meter);
    // A successor's begin starts the work over: its table is made anew.
    let name: string;
    try {
      name = programTables(countedCore(core, sql), { id: jobId, by: row.by_sub }).begin(params.into);
    } catch (error) {
      if (error instanceof ProgramTableError) throw new StoreError(409, "push_name_taken", error.message);
      throw error;
    }
    const display = kind === "compare" ? comparePlan(m) : previewPlan(m);
    const columns = madeColumns(kind === "compare" ? COMPARE_MACHINE : PREVIEW_MACHINE, display);
    sql.exec(`CREATE TABLE ${quote(name)} (${columns.map((c) => `${quote(c)} TEXT${c === KEY ? " NOT NULL" : ""}`).join(", ")})`);
    // A preview's rows are found by `_key`: a push reads them in its order, and a row sent twice is written once.
    if (kind === "push_preview") sql.exec(`CREATE UNIQUE INDEX ${quote(`${params.into}__key_${jobId.replace(/^job_/, "")}`)} ON ${quote(name)} (${quote(KEY)})`);
    const reading: ReadingState = { ...(state as ReadingState), table: source.name, begun: true, ...m, rowid: rowidOf(core.sql, source, m.columns.length), display, page: 0, end: null };
    if (kind === "compare") {
      const next: CompareState = { ...reading, listed: 0, onlyInStore: 0, onlyInDatabase: 0, differing: 0, unlisted: 0, made: null };
      saveState(core, jobId, next, compareProgress(params as CompareParams, next), sql.rows);
    } else {
      const next: PreviewState = { ...reading, counts: blankCounts(), links, added: links.map(() => 0), made: null };
      saveState(core, jobId, next, previewProgress(params as PushPreviewParams, next), sql.rows);
    }
    const rows = Number(core.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${quote(source.name)}`).one().n);
    return { columns: m.columns, key: m.key, missing: m.missing, rows };
  });
}

// ─── reads ────────────────────────────────────────────────────────────────────────────────────

/** How many of `rows`, from the first, fit in READ_BYTES of JSON: at least one. */
function fitting(rows: readonly unknown[]): number {
  let bytes = 2;
  for (let i = 0; i < rows.length; i++) {
    bytes += bytesOf(JSON.stringify(rows[i])) + 1;
    if (bytes > READ_BYTES && i > 0) return i;
  }
  return rows.length;
}

/**
 * A read's answer from the rows a statement gave: as many as fit, and where the next read starts
 * (`at` of the last one answered), or null when the statement gave fewer than it was asked for and
 * all of them fit.
 */
function answerOf<T>(rows: readonly T[], limit: number, at: (row: T, i: number) => string): { n: number; next: string | null } {
  const n = fitting(rows);
  return { n, next: n > 0 && (n < rows.length || rows.length === limit) ? at(rows[n - 1]!, n - 1) : null };
}

/** The store's rows, each its values in the job's columns' order, a read at a time: a table by its rowid, a view by place. */
function readSource(sql: SqlLike, state: ReadingState, after: string | null, limit: number): RowsReadAnswer {
  const width = state.sources.length;
  const values = state.sources.map((s, i) => `${valueSql(`t.${quote(s)}`)} AS v${i}`).join(", ");
  const from = `FROM ${quote(state.table)} AS t`;
  const valuesOf = (r: Record<string, StoreSqlValue>): (string | null)[] =>
    Array.from({ length: width }, (_, i) => {
      const v = r[`v${i}`];
      return v === null || v === undefined ? null : String(v);
    });
  if (state.rowid) {
    if (after !== null && !/^-?\d{1,19}$/.test(after)) throw new StoreError(400, "bad_request", "after is the rowid the last read ended at, or null to start.");
    const rid = `t.${state.rowid}`;
    const select = `SELECT CAST(${rid} AS TEXT) AS __rid, ${values} ${from}`;
    const rows = (after === null ? sql.exec(`${select} ORDER BY ${rid} LIMIT ?`, limit) : sql.exec(`${select} WHERE ${rid} > CAST(? AS INTEGER) ORDER BY ${rid} LIMIT ?`, after, limit)).toArray();
    const answered = rows.map(valuesOf);
    const { n, next } = answerOf(answered, limit, (_, i) => String(rows[i]!.__rid));
    return { rows: answered.slice(0, n), next };
  }
  if (after !== null && !/^\d{1,15}$/.test(after)) throw new StoreError(400, "bad_request", "after is how many rows the reads before took, or null to start.");
  const offset = after === null ? 0 : Number(after);
  const answered = sql.exec(`SELECT ${values} ${from} LIMIT ? OFFSET ?`, limit, offset).toArray().map(valuesOf);
  const { n, next } = answerOf(answered, limit, (_, i) => String(offset + i + 1));
  return { rows: answered.slice(0, n), next };
}

/** The memory of a database table, `[key, sent, held, put]` in key order (`put` true for a row this store put there). */
function readMemory(sql: SqlLike, target: string, after: string | null, limit: number): RowsReadAnswer {
  type Row = { k: string; sent: string; held: string; put: number };
  const select = "SELECT k, sent, held, put FROM _pushed WHERE target = ?1";
  const rows = (after === null ? sql.exec<Row>(`${select} ORDER BY k LIMIT ?2`, target, limit) : sql.exec<Row>(`${select} AND k > ?3 ORDER BY k LIMIT ?2`, target, limit, after))
    .toArray()
    .map((r): [string, string, string, boolean] => [String(r.k), String(r.sent), String(r.held), Number(r.put) === 1]);
  const { n, next } = answerOf(rows, limit, (r) => r[0]);
  return { rows: rows.slice(0, n), next };
}

/**
 * A preview's rows to write, in `_key` order: all of them, or only its new and changed rows (`puts`)
 * or only its removed ones (`removals`). A row a write of this very preview wrote is not read again:
 * the memory holds what the preview sends, written since the preview was made (`since`, its table's
 * `made_at`), so a write that failed and is asked again never writes a row twice, nor puts back one a
 * person removed since. A row an earlier write left with the same values is read: a preview that
 * overwrites the database's edits (theirEdits overwrite) writes it again.
 */
function readWrites(sql: SqlLike, preview: string, target: string, since: string, after: string | null, limit: number, only?: RowsReadBody["only"]): RowsReadAnswer {
  const k = `p.${quote(KEY)}`;
  const written = `EXISTS (SELECT 1 FROM _pushed AS m WHERE m.target = ? AND m.k = ${k} AND m.sent = p.${quote(HASH)} AND m.at >= ?)`;
  const what = `p.${quote(WHAT)}`;
  const puts = `(${what} IN ('new', 'changed') AND NOT ${written})`;
  const which = only === "puts" ? puts : only === "removals" ? `${what} = 'removed'` : `(${what} = 'removed' OR ${puts})`;
  // Only a read of new and changed rows asks the memory, which takes the target and the time.
  const memory = only === "removals" ? [] : [target, since];
  const select = `SELECT ${k} AS k, ${what} AS w, p.${quote(NOW_HASH)} AS h, p.${quote(VALUES)} AS v, p.${quote(CHANGED)} AS c FROM ${quote(preview)} AS p WHERE ${which}`;
  type Row = { k: string; w: string; h: string | null; v: string | null; c: string | null };
  const rows = (after === null ? sql.exec<Row>(`${select} ORDER BY ${k} LIMIT ?`, ...memory, limit) : sql.exec<Row>(`${select} AND ${k} > ? ORDER BY ${k} LIMIT ?`, ...memory, after, limit)).toArray().map(
    (r): WriteRow => {
      const action = String(r.w) as WriteRow["action"];
      return {
        key: String(r.k),
        action,
        now: r.h === null ? null : String(r.h),
        values: action === "removed" || r.v === null ? null : (JSON.parse(String(r.v)) as (string | null)[]),
        changed: action === "changed" && r.c !== null ? (JSON.parse(String(r.c)) as string[]) : null,
      };
    },
  );
  const { n, next } = answerOf(rows, limit, (r) => r.key);
  return { rows: rows.slice(0, n), next };
}

export async function rowsRead(core: StoreCore, jobId: string, key: string, body: unknown): Promise<RowsReadAnswer> {
  const hash = await sha256Hex(key);
  const { row, kind, state } = taking(core, jobId, hash);
  const read = shaped(() => rowsReadOf(body, kind));
  const limit = read.limit ?? ROWS_LIMITS.readRows;
  if (kind === "push") {
    const params = JSON.parse(row.params) as PushParams;
    const push = state as PushState;
    if (push.oneTransaction) refuseUnbegun(kind, push, row.key_hash);
    const { part } = partOf(push.parts, read.table, WORDS[kind]);
    const since = core.sql.exec<{ at: string | null }>("SELECT made_at AS at FROM _tables WHERE name = ?", part.preview.table).toArray()[0]?.at ?? "";
    return readWrites(core.sql, part.preview.table, pushTargetId(params.connection.id, part.target), since, read.after, limit, read.only);
  }
  if (kind === "push_undo") {
    const undo = state as UndoState;
    refuseUnbegun(kind, undo, row.key_hash);
    const { at } = partOf(undo.parts, read.table, WORDS[kind]);
    const rows = undoRows(core.sql, undo.write, at, read.after, limit, read.only);
    const { n, next } = answerOf(rows, limit, (r) => r.key);
    return { rows: rows.slice(0, n), next };
  }
  const params = JSON.parse(row.params) as PushPreviewParams | CompareParams;
  if (read.table) throw new StoreError(400, "bad_request", `A ${WORDS[kind]} reads one table: table is 0.`);
  const reading = begunState(kind, state);
  if (read.part === "source") return readSource(core.sql, reading, read.after, limit);
  // A compare reads the memory while its key is the compare's (its columns may differ); it never
  // changes it. A preview with another key or other columns reads none: the memory is of the old
  // ones until a write of the new ones (startPush).
  const record = savedJson<PushRecord>(core.sql, pushRecordKey(params.connection.id, params.target));
  if (kind === "compare" ? !sameList(record?.key, reading.key) : !recordFits(record, reading)) return { rows: [], next: null };
  return readMemory(core.sql, pushTargetId(params.connection.id, params.target), read.after, limit);
}

// ─── a page ───────────────────────────────────────────────────────────────────────────────────

/** A held row's note, by why it was held. */
function heldNote(why: HeldWhy | null, connection: string): string {
  switch (why) {
    case "removed_there":
      return `Removed from ${connection} since our last write: not written`;
    case "appeared":
      return `Added to ${connection} after the preview: not written`;
    case "since_preview":
      return `Changed in ${connection} after the preview: not written`;
    default:
      return `Changed in ${connection} since our last write: not written`;
  }
}

/**
 * A link a row's write cannot make, in words: "no row of town.properties has its parcel_id". It names
 * the link's table and columns as the job was asked for them, never a value.
 */
function unlinkedNote(column: string, links: readonly LinkSpec[]): string | null {
  const link = links.find((l) => l.column === column) ?? links.find((l) => l.column.toLowerCase() === column.toLowerCase());
  if (!link) return null;
  const by = link.to.column.toLowerCase() === column.toLowerCase() ? column : `${column} as ${link.to.column}`;
  return `no row of ${link.to.schema}.${link.to.name} has its ${by}`;
}

function previewNote(r: PreviewRow, source: string, connection: string, links: readonly LinkSpec[]): string | null {
  const note = ((): string | null => {
    switch (r.action) {
      case "changed":
        return r.changed?.length ? `Changes ${r.changed.join(", ")}` : null;
      case "removed":
        return `${source} no longer has this row`;
      case "held":
        return heldNote(r.why, connection);
      default:
        return null;
    }
  })();
  const unlinked = (r.unlinked ?? []).map((c) => unlinkedNote(c, links)).filter((n): n is string => n !== null);
  if (!unlinked.length) return note;
  const all = [...(note ? [note] : []), ...unlinked].join("; ");
  return `${all.charAt(0).toUpperCase()}${all.slice(1)}`;
}

/**
 * The rows of a preview's page whose link finds no row in the database, but names a row that the
 * store's newest preview of the linked table, into the same database, adds as new or changed:
 * written together, their link is made (finding 7 of the data plan's first proof counted a permit's
 * link to the submission the same write adds as finding none). The link is taken off the row's
 * `unlinked`, so its note does not name it, and counted in the preview's `added`, which its end
 * takes off the link's `unlinked` (`withAdded`). Values are compared as the two previews hold them,
 * as text, one query a link a page. A preview of the linked table made after this one is not read.
 */
function addedByPreviews(sql: SqlLike, connectionId: string, preview: PreviewState, rows: PreviewRow[]): void {
  const links = preview.links ?? [];
  if (!links.length || !rows.some((r) => r.unlinked?.length)) return;
  const added = (preview.added ??= links.map(() => 0));
  const siblings = previewsInto(sql, connectionId);
  const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  links.forEach((link, i) => {
    const sibling = siblings.find((p) => sameName(p.saved.targetRef.schema, link.to.schema) && sameName(p.saved.targetRef.name, link.to.name));
    if (!sibling) return;
    const at = sibling.saved.columns.findIndex((c) => sameName(c, link.to.column));
    const own = preview.columns.findIndex((c) => sameName(c, link.column));
    if (at < 0 || own < 0) return;
    const named = (r: PreviewRow): boolean => r.unlinked?.some((c) => sameName(c, link.column)) ?? false;
    const asked = [...new Set(rows.filter(named).map((r) => r.after?.[own]).filter((v): v is string => typeof v === "string" && v !== ""))];
    if (!asked.length) return;
    const value = `json_extract(${quote(VALUES)}, '$[${at}]')`;
    const found = new Set(
      sql
        .exec<{ v: string }>(`SELECT DISTINCT ${value} AS v FROM ${quote(sibling.table)} WHERE ${quote(WHAT)} IN ('new', 'changed') AND ${value} IN (SELECT value FROM json_each(?1))`, JSON.stringify(asked))
        .toArray()
        .map((r) => String(r.v)),
    );
    for (const r of rows) {
      const v = r.after?.[own];
      if (!named(r) || typeof v !== "string" || !found.has(v)) continue;
      r.unlinked = r.unlinked!.filter((c) => !sameName(c, link.column));
      added[i] = (added[i] ?? 0) + 1;
    }
  });
}

/** The store's previews into one database, newest first, each with its table: the ones whose table is still there. */
function previewsInto(sql: SqlLike, connectionId: string): { table: string; saved: SavedPreview }[] {
  const prefix = previewKey("");
  return sql
    .exec<{ key: string; value: string }>("SELECT key, value FROM _meta WHERE substr(key, 1, ?1) = ?2", prefix.length, prefix)
    .toArray()
    .map((r) => ({ table: r.key.slice(prefix.length), saved: JSON.parse(r.value) as SavedPreview }))
    .filter((p) => p.saved.connection?.id === connectionId && tableExists(sql, p.table))
    .sort((a, b) => (a.saved.at < b.saved.at ? 1 : a.saved.at > b.saved.at ? -1 : 0));
}

/** A preview's link counts from its DB IO job, with the rows the store found added by another preview taken off `unlinked` and counted as `added`. */
function withAdded(counts: readonly LinkCount[], added: readonly number[] | undefined): LinkCount[] {
  return counts.map((c, i) => {
    const n = Math.min(added?.[i] ?? 0, c.unlinked);
    return n > 0 ? { ...c, unlinked: c.unlinked - n, added: n } : c;
  });
}

/** A preview's row as its table holds it. */
function previewStored(r: PreviewRow, state: PreviewState, connection: string): (string | null)[] {
  const values = [
    ...keyCells(state, r.key, r.after, r.before),
    r.action,
    previewNote(r, state.table, connection, state.links ?? []),
    ...otherPlaces(state).flatMap((i) => [r.before?.[i] ?? null, r.after?.[i] ?? null]),
  ];
  return stored([r.key, r.will, r.now, r.after ? JSON.stringify(r.after) : null, r.changed ? JSON.stringify(r.changed) : null, r.before ? JSON.stringify(r.before) : null], state.display, values);
}

/** What a rehearsal's write did to a row, in its manifest's words. */
function whatHappened(o: WrittenRow): string {
  if (o.outcome === "held") return "held";
  if (o.outcome === "removed") return o.before ? "removed" : "already gone";
  return o.did === "inserted" ? "inserted" : o.did === "updated" ? "updated" : "already written";
}

/**
 * A rehearsal's row as its manifest holds it: the key's columns, what the write did, the columns it
 * set and why it held a row, then for each other column the value it sent (`sent`, the preview's)
 * beside the one the database held after it, inside its transaction.
 */
function manifestStored(o: WrittenRow, part: PushPart, sent: readonly (string | null)[] | null, connection: string): (string | null)[] {
  const own = { key: part.key, columns: part.columns };
  const values = [
    ...keyCells(own, o.key, o.after ?? sent, o.before),
    whatHappened(o),
    o.set?.length ? o.set.join(", ") : null,
    o.outcome === "held" ? heldNote(o.why, connection) : null,
    ...otherPlaces(own).flatMap((i) => [o.outcome === "written" ? (sent?.[i] ?? null) : null, o.after?.[i] ?? null]),
  ];
  return stored([o.key, o.sent, o.held], part.manifest!.display, values);
}

/**
 * A row its database kept differently, as a write's list of them holds it: the key's columns, what
 * the write did, the columns kept so and how, then for each other column the value it sent (the
 * preview's) beside the one the database holds after it. A write's `after` holds the kept columns'
 * values only: in every other the database holds what was sent.
 */
function keptStored(o: WrittenRow, part: PushPart, sent: readonly (string | null)[] | null): (string | null)[] {
  const own = { key: part.key, columns: part.columns };
  const kept = new Set((o.kept ?? []).map((k) => k.column));
  const values = [
    ...keyCells(own, o.key, sent, o.before),
    whatHappened(o),
    (o.kept ?? []).map((k) => `${k.column}: ${KEPT_HOW_WORDS[k.how]}`).join("; "),
    ...otherPlaces(own).flatMap((i) => [sent?.[i] ?? null, kept.has(part.columns[i]!) ? (o.after?.[i] ?? null) : (sent?.[i] ?? null)]),
  ];
  return stored([o.key, o.sent, o.held], part.keptList!.display, values);
}

/** A part's counts of kept rows by column and how, with a page's rows added: in the job's column order, then the ways' order. */
function withKept(counts: readonly KeptColumn[], rows: readonly WrittenRow[], columns: readonly string[]): KeptColumn[] {
  const by = new Map(counts.map((c) => [JSON.stringify([c.column, c.how]), { ...c }]));
  for (const o of rows) {
    for (const k of o.kept ?? []) {
      const at = JSON.stringify([k.column, k.how]);
      const c = by.get(at);
      if (c) c.rows++;
      else by.set(at, { column: k.column, how: k.how, rows: 1 });
    }
  }
  const place = (c: KeptColumn): number => columns.indexOf(c.column) * KEPT_HOWS.length + KEPT_HOWS.indexOf(c.how);
  return [...by.values()].sort((a, b) => place(a) - place(b));
}

/**
 * A write's page's rows its database kept differently: counted on their part, and for a write (not a
 * rehearsal, whose manifest holds every value) listed in the part's list, up to KEPT_LISTED_MAX rows,
 * which the first such page begins. The page of a batch its database committed is never refused for
 * the list: when its name is another table's by then (a person's, made since the write began), the
 * list goes and the counts stay.
 */
function noteKept(core: StoreCore, row: KeyedJobRow, sql: CountedSql, push: PushState, part: PushPart, written: readonly WrittenRow[], previewed: ReadonlyMap<string, { values: (string | null)[] | null }>): void {
  const kept = written.filter((o) => o.kept?.length);
  if (!kept.length) return;
  part.kept = (part.kept ?? 0) + kept.length;
  part.keptColumns = withKept(part.keptColumns ?? [], kept, part.columns);
  const list = part.keptList;
  const room = KEPT_LISTED_MAX - (part.keptListed ?? 0);
  if (push.rehearse || !list || room <= 0) return;
  if (!list.begun) {
    try {
      beginManifest(sql, programTables(countedCore(core, sql), { id: row.id, by: row.by_sub }), list);
    } catch (error) {
      if (!(error instanceof StoreError || error instanceof ProgramTableError)) throw error;
      part.keptList = null;
      return;
    }
    list.begun = true;
  }
  const listed = kept.slice(0, room);
  writeRows(sql, fresh(list.name), madeColumns(MANIFEST_MACHINE, list.display), listed.map((o) => keptStored(o, part, previewed.get(o.key)?.values ?? null)), false);
  part.keptListed = (part.keptListed ?? 0) + listed.length;
}

/** A compare's row as its table holds it. */
function compareStored(r: CompareRow, state: CompareState, connection: string): (string | null)[] {
  const difference = r.difference === "store_only" ? "Only in the store" : r.difference === "database_only" ? `Only in ${connection}` : "Differs";
  const values = [
    ...keyCells(state, r.key, r.store, r.database),
    difference,
    r.columns?.length ? r.columns.join(", ") : null,
    ...otherPlaces(state).flatMap((i) => [r.store?.[i] ?? null, r.database?.[i] ?? null]),
  ];
  return stored([r.key], state.display, values);
}

/** How each written key of a push was previewed: new or changed. */
function previewedAs(sql: SqlLike, preview: string, keys: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of keyParts(keys)) {
    for (const r of sql.exec<{ k: string; w: string }>(`SELECT ${quote(KEY)} AS k, ${quote(WHAT)} AS w FROM ${quote(preview)} WHERE ${quote(KEY)} IN (SELECT value FROM json_each(?))`, part)) out.set(String(r.k), String(r.w));
  }
  return out;
}

/**
 * What a preview found of these keys: what would happen, the columns a change changes, the database's
 * values it read (none in a preview made before it kept them), and the values the write sends.
 */
function previewedOf(sql: SqlLike, preview: string, keys: readonly string[]): Map<string, Previewed & { values: (string | null)[] | null }> {
  const out = new Map<string, Previewed & { values: (string | null)[] | null }>();
  const before = sql.exec("SELECT 1 FROM pragma_table_info(?) WHERE name = ?", preview, BEFORE).toArray().length > 0 ? quote(BEFORE) : "NULL";
  const json = (v: string | null) => (v === null ? null : JSON.parse(String(v)));
  for (const part of keyParts(keys)) {
    type Row = { k: string; w: string; c: string | null; b: string | null; v: string | null };
    for (const r of sql.exec<Row>(`SELECT ${quote(KEY)} AS k, ${quote(WHAT)} AS w, ${quote(CHANGED)} AS c, ${before} AS b, ${quote(VALUES)} AS v FROM ${quote(preview)} WHERE ${quote(KEY)} IN (SELECT value FROM json_each(?))`, part)) {
      out.set(String(r.k), { action: String(r.w), changed: json(r.c) as string[] | null, before: json(r.b) as (string | null)[] | null, values: json(r.v) as (string | null)[] | null });
    }
  }
  return out;
}

/**
 * Refuses a page that names a row twice, or (`earlier`) one an earlier page of the job took: in one
 * transaction the database writes a row once. Counts only, never a key.
 */
function refuseTwice(sql: SqlLike, jobId: string, part: number, keys: readonly string[], what: string, earlier: boolean): void {
  if (new Set(keys).size !== keys.length) throw new StoreError(409, "rows_twice", `A page of this ${what} names a row twice.`);
  const taken = earlier ? recordedKeys(sql, jobId, part, keys).size : 0;
  if (taken) throw new StoreError(409, "rows_twice", `${many(taken, "row")} of this page ${taken === 1 ? "was" : "were"} sent on an earlier page of this ${what}.`);
}

/** Refuses a rehearsal's page that names a row an earlier page put in its manifest: the database writes a row once. */
function refuseInManifest(sql: SqlLike, manifest: string, keys: readonly string[]): void {
  let taken = 0;
  for (const part of keyParts(keys)) {
    taken += Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${quote(manifest)} WHERE ${quote(KEY)} IN (SELECT value FROM json_each(?))`, part).one().n);
  }
  if (taken) throw new StoreError(409, "rows_twice", `${many(taken, "row")} of this page ${taken === 1 ? "was" : "were"} sent on an earlier page of this rehearsal.`);
}

/**
 * A page's held rows into its part's count, and (`list`) the keys and why into its held table's list,
 * up to HELD_LISTED_MAX keys and HELD_LISTED_BYTES for the whole write: its every part's list is in
 * the one state the store saves after each page.
 */
function noteHeld(push: PushState, part: PushPart, outcomes: readonly WrittenRow[], list: boolean): void {
  let keys = sum(push.parts, (p) => p.heldKeys.length);
  let bytes = sum(push.parts, (p) => p.heldKeysBytes);
  for (const o of outcomes) {
    if (o.outcome !== "held") continue;
    part.heldSince++;
    if (!list) continue;
    const entry: [string, HeldWhy] = [o.key, o.why!];
    const size = bytesOf(JSON.stringify(entry)) + 1;
    if (keys < HELD_LISTED_MAX && bytes + size <= HELD_LISTED_BYTES) {
      part.heldKeys.push(entry);
      part.heldKeysBytes += size;
      keys++;
      bytes += size;
    }
  }
}

/**
 * A write's page: how each row of one batch of one of its previews ended.
 *   of one preview  The database committed the batch: the store takes it as it comes, into the
 *                   memory and the write's record of each row (`done`), past the day's write limit as
 *                   an end is. Refused, the batch would stay written with no memory of it, and a
 *                   later edit of its rows there would be overwritten, not held.
 *   of several      Pending: the write's record keeps the outcomes (`pending`), and nothing applies
 *                   until the end says the database committed.
 *   a rehearsal     Its manifests take the outcomes; the database will roll them back.
 * The memory's entry for each written or removed key is read before anything changes it: what an
 * undo of this write puts back.
 */
function sendWritten(core: StoreCore, row: KeyedJobRow, push: PushState, send: RowsSendBody): RowsSendAnswer {
  const params = JSON.parse(row.params) as PushParams;
  if (push.oneTransaction) refuseUnbegun("push", push, row.key_hash);
  else if (send.last === undefined) throw new StoreError(400, "bad_request", "A batch's page names its last key (last), which the next batch is read after.");
  const { part, at } = partOf(push.parts, send.table, WORDS.push);
  const outcomes = shaped(() => writtenRowsOf(send.rows, part.columns));
  if (send.page <= push.page) return { page: send.page, taken: false };
  if (send.page !== push.page + 1) throw new StoreError(409, "page_out_of_order", `This write's next page is ${push.page + 1}, not ${send.page}.`);
  const sql = new CountedSql(core.meter);
  const now = core.nowIso();
  const target = pushTargetId(params.connection.id, part.target);
  const written = outcomes.filter((o) => o.outcome === "written");
  const removed = outcomes.filter((o) => o.outcome === "removed");
  const previewed = previewedOf(core.sql, part.preview.table, written.map((o) => o.key));
  const was = new Map([...previewed].map(([k, p]) => [k, p.action]));
  if (push.rehearse) {
    refuseTwice(core.sql, row.id, at, outcomes.map((o) => o.key), "rehearsal", false);
    refuseInManifest(core.sql, fresh(part.manifest!.name), outcomes.map((o) => o.key));
    writeRows(sql, fresh(part.manifest!.name), madeColumns(MANIFEST_MACHINE, part.manifest!.display), outcomes.map((o) => manifestStored(o, part, previewed.get(o.key)?.values ?? null, params.connection.name)), false);
  } else {
    // The memory holds entries of the record's key and columns only: a write of others begins it anew.
    const fits = recordFits(savedJson<PushRecord>(core.sql, pushRecordKey(params.connection.id, part.target)), part);
    const memory = fits ? memoryOf(core.sql, target, [...written, ...removed].map((o) => o.key)) : new Map();
    if (push.oneTransaction) {
      refuseTwice(core.sql, row.id, at, outcomes.map((o) => o.key), "write", true);
      recordWrites(sql, row.id, at, recordRows(outcomes, memory, previewed), "pending");
    } else {
      recordWrites(sql, row.id, at, recordRows(outcomes, memory, previewed), "done");
      // A row the preview found new is one this store put there.
      remember(sql, target, now, written.map((o) => [o.key, o.sent, o.held, was.get(o.key) === "new" ? "1" : "0"]));
      forget(sql, target, removed.map((o) => o.key));
    }
  }
  for (const o of written) {
    if (was.get(o.key) === "new") part.inserted++;
    else if (was.get(o.key) === "changed") part.updated++;
  }
  part.deleted += removed.length;
  noteKept(core, row, sql, push, part, written, previewed);
  // A rehearsal's manifest lists the rows it held: it makes no held table.
  noteHeld(push, part, outcomes, !push.rehearse);
  push.page = send.page;
  if (send.last !== undefined) push.cursor = send.last;
  push.batches++;
  saveState(core, row.id, push, pushProgress(push), sql.rows);
  return { page: send.page, taken: true };
}

/** An undo's page: how each row of one of its parts ended, pending until its end says the database committed. */
function sendUndone(core: StoreCore, row: KeyedJobRow, undo: UndoState, send: RowsSendBody): RowsSendAnswer {
  refuseUnbegun("push_undo", undo, row.key_hash);
  const { part, at } = partOf(undo.parts, send.table, WORDS.push_undo);
  const outcomes = shaped(() => undoneRowsOf(send.rows));
  if (send.page <= undo.page) return { page: send.page, taken: false };
  if (send.page !== undo.page + 1) throw new StoreError(409, "page_out_of_order", `This undo's next page is ${undo.page + 1}, not ${send.page}.`);
  const keys = outcomes.map((o) => o.key);
  refuseTwice(core.sql, row.id, at, keys, "undo", true);
  const did = undoableOf(core.sql, undo.write, at, keys);
  const strangers = keys.filter((k) => !did.has(k)).length;
  if (strangers) {
    throw new StoreError(409, "undo_rows", `${many(strangers, "row")} of this page ${strangers === 1 ? "is not one" : "are not ones"} the write wrote into ${tableRefText(part.target)}: an undo sends only the rows it read.`);
  }
  const sql = new CountedSql(core.meter);
  recordUndone(sql, row.id, at, outcomes);
  for (const o of outcomes) {
    if (o.outcome === "held") part.held++;
    else if (did.get(o.key) === "inserted") part.removed++;
    else if (did.get(o.key) === "updated") part.putBack++;
    else part.reinserted++;
  }
  undo.page = send.page;
  saveState(core, row.id, undo, undoProgress(undo), sql.rows);
  return { page: send.page, taken: true };
}

/**
 * A page of the DB IO job's rows. A write's page of one preview records a batch the database already
 * committed, so it is taken past the day's write limit (`sendWritten`). Every other page meets the
 * limit: a preview's and a compare's write only the store's own table, and a one-transaction
 * write's and an undo's are pending, their database not committed yet.
 */
export async function rowsSend(core: StoreCore, jobId: string, key: string, body: unknown): Promise<RowsSendAnswer> {
  const hash = await sha256Hex(key);
  return core.transaction(() => {
    const { row, kind, state } = taking(core, jobId, hash);
    if (kind !== "push" || (state as PushState).oneTransaction) refusePastWriteLimit(core);
    const send = shaped(() => rowsSendOf(body));
    if (kind === "push") return sendWritten(core, row, state as PushState, send);
    if (kind === "push_undo") return sendUndone(core, row, state as UndoState, send);
    if (send.table) throw new StoreError(400, "bad_request", `A ${WORDS[kind]} sends rows of one table: table is 0.`);
    const at = core.nowIso();
    const sql = new CountedSql(core.meter);
    const reading = begunState(kind, state);
    const params = JSON.parse(row.params) as PushPreviewParams | CompareParams;
    const rows = shaped(() => (kind === "compare" ? compareRowsOf(send.rows, reading.columns) : previewRowsOf(send.rows, reading.columns)));
    if (send.page <= reading.page) return { page: send.page, taken: false };
    if (send.page !== reading.page + 1) throw new StoreError(409, "page_out_of_order", `This ${WORDS[kind]}'s next page is ${reading.page + 1}, not ${send.page}.`);
    const table = fresh(params.into);
    if (kind === "compare") {
      const compare = reading as CompareState;
      const differences = rows as CompareRow[];
      // Past COMPARE_ROWS_MAX a difference is counted, not kept.
      const kept = differences.slice(0, Math.max(0, COMPARE_ROWS_MAX - compare.listed));
      writeRows(sql, table, madeColumns(COMPARE_MACHINE, compare.display), kept.map((r) => compareStored(r, compare, params.connection.name)), false);
      for (const r of differences) {
        if (r.difference === "store_only") compare.onlyInStore++;
        else if (r.difference === "database_only") compare.onlyInDatabase++;
        else compare.differing++;
      }
      compare.listed += kept.length;
      compare.unlisted += differences.length - kept.length;
      compare.page = send.page;
      saveState(core, jobId, compare, compareProgress(params as CompareParams, compare), sql.rows);
      return { page: send.page, taken: true };
    }
    const preview = reading as PreviewState;
    const found = rows as PreviewRow[];
    const shown = found.filter((r) => r.action !== "adopt" && r.action !== "forget");
    addedByPreviews(core.sql, params.connection.id, preview, shown);
    writeRows(sql, table, madeColumns(PREVIEW_MACHINE, preview.display), shown.map((r) => previewStored(r, preview, params.connection.name)), true);
    const target = pushTargetId(params.connection.id, params.target);
    const adopted = found.filter((r) => r.action === "adopt");
    const forgotten = found.filter((r) => r.action === "forget").map((r) => r.key);
    // The memory is of the record's key and columns: a preview of others leaves it as it is.
    if (recordFits(savedJson<PushRecord>(core.sql, pushRecordKey(params.connection.id, params.target)), preview)) {
      remember(sql, target, at, adopted.map((r) => [r.key, r.will, r.now, "0"]));
      forget(sql, target, forgotten);
    }
    const c = preview.counts;
    for (const r of shown) {
      if (r.action === "new") c.inserts++;
      else if (r.action === "changed") c.updates++;
      else if (r.action === "removed") c.deletes++;
      else c.held++;
    }
    c.adopted += adopted.length;
    c.forgotten += forgotten.length;
    preview.page = send.page;
    saveState(core, jobId, preview, previewProgress(params as PushPreviewParams, preview), sql.rows);
    return { page: send.page, taken: true };
  });
}

// ─── the end, and a failure ───────────────────────────────────────────────────────────────────

/**
 * What a write's end must say. A write of one preview committed each batch on its own, so it has
 * nothing to roll back. A write of several ends once its database committed the whole of it; a
 * rehearsal once its database rolled it back, with the rows it read back as they were before.
 */
function endOfWrite(push: PushState, end: RowsEndBody, keyHash: string | null): void {
  if (!push.oneTransaction) {
    if (end.rolledBack) throw new StoreError(400, "bad_request", "A write of one preview commits each batch: it has no transaction to roll back.");
    return;
  }
  refuseUnbegun("push", push, keyHash);
  if (push.rehearse) {
    if (end.rolledBack !== true || end.restored === undefined) throw new StoreError(400, "bad_request", "A rehearsal ends once its database rolled it back: rolledBack: true, and the rows read back as they were before (restored).");
    push.restored = end.restored;
  } else if (end.committed !== true) {
    throw new StoreError(400, "bad_request", "This write ends once its database committed the whole of it: committed: true.");
  }
}

export async function rowsEnd(core: StoreCore, jobId: string, key: string, body: unknown): Promise<RowsEndAnswer> {
  const hash = await sha256Hex(key);
  const finishing = core.transaction(() => {
    // The answer to an end can be lost: sent again once the store has moved on, it answers the
    // same, also after the job ended and its key went.
    if (keyedJob(core, jobId, ROWS_KINDS, "That job does not take rows.").state === "done") return true;
    if (stateOf(admitted(core, jobId, hash))?.phase === "finishing") return true;
    const { row, kind, state } = taking(core, jobId, hash);
    const end = shaped(() => rowsEndOf(body));
    if (kind === "push") {
      const push = state as PushState;
      endOfWrite(push, end, row.key_hash);
      push.phase = "finishing";
      saveState(core, jobId, push, pushProgress(push, push.rehearse ? "Making the rehearsal's manifests" : push.oneTransaction ? "Taking what the write did" : "Listing the rows held back"), 0);
      return true;
    }
    if (kind === "push_undo") {
      const undo = state as UndoState;
      refuseUnbegun(kind, undo, row.key_hash);
      if (end.committed !== true) throw new StoreError(400, "bad_request", "An undo ends once its database committed it: committed: true.");
      undo.phase = "finishing";
      saveState(core, jobId, undo, undoProgress(undo, "Taking what the undo did"), 0);
      return true;
    }
    const reading = begunState(kind, state);
    if (kind === "push_preview") refuseUncounted((JSON.parse(row.params) as PushPreviewParams).links ?? [], end.links ?? []);
    reading.end = {
      read: end.read ?? 0,
      targetRows: end.targetRows ?? 0,
      same: end.same ?? 0,
      otherRows: end.otherRows ?? 0,
      ...(kind === "push_preview" ? { links: withAdded(end.links ?? [], (reading as PreviewState).added) } : {}),
    };
    reading.phase = "finishing";
    const params = JSON.parse(row.params) as PushPreviewParams | CompareParams;
    const progress = kind === "compare" ? compareProgress(params as CompareParams, reading as CompareState, "Making the compare's table") : previewProgress(params as PushPreviewParams, reading as PreviewState, "Making the preview's table");
    saveState(core, jobId, reading, progress, 0);
    return true;
  });
  if (finishing) await core.wakeAt(core.deps.now());
  return { finishing };
}

/**
 * The DB IO job could not go on: the job fails with its words, once. Stopped at the day's write
 * limit it stays open until the day ends instead, with what it took, for the next DB IO job.
 */
export async function rowsFail(core: StoreCore, jobId: string, key: string, body: unknown): Promise<null> {
  const hash = await sha256Hex(key);
  const row = admitted(core, jobId, hash);
  const state = stateOf(row);
  const fail = shaped(() => rowsFailOf(body));
  if (row.state === "queued") {
    // It waits behind another job: its DB IO job is gone, and it says so when its turn comes.
    core.sql.exec("UPDATE _jobs SET error = ?, updated_at = ? WHERE id = ?", fail.message.slice(0, 2000), core.nowIso(), jobId);
    return null;
  }
  if (row.state !== "running" || state?.phase !== "taking") return null;
  if (fail.code === PULL_STORE_LIMIT) {
    // Nothing can write until the limit passes: until then it holds its place, and after that the
    // rule for a job nobody feeds applies (`waitOrEnd`).
    core.sql.exec("UPDATE _jobs SET key_until = ?, updated_at = ? WHERE id = ?", new Date(dayEndsAt(writesToday(core).day)).toISOString(), core.nowIso(), jobId);
    await core.wakeAt(core.deps.now());
    return null;
  }
  core.transaction(() => {
    state.phase = "failing";
    state.failure = fail.message;
    core.sql.exec("UPDATE _jobs SET run_state = ?, updated_at = ? WHERE id = ?", JSON.stringify(state), core.nowIso(), jobId);
  });
  await core.wakeAt(core.deps.now());
  return null;
}

// ─── the handlers ─────────────────────────────────────────────────────────────────────────────

function parsed<P>(parse: () => P): P {
  try {
    return parse();
  } catch (error) {
    if (error instanceof PushShapeError) throw new JobParamsError(error.message);
    throw error;
  }
}

/** When the job's DB IO job's time is up: its key's own time, or PULL_WAITS_MS after the job was made. */
function until(ctx: JobContext<unknown, unknown>): number {
  const row = ctx.sql.exec<{ key_until: string | null; created_at: string }>("SELECT key_until, created_at FROM _jobs WHERE id = ?", ctx.job.id).one();
  return row.key_until ? Date.parse(row.key_until) : Date.parse(row.created_at) + PULL_WAITS_MS;
}

/** A job whose DB IO job stopped while it waited its turn ends in that DB IO job's words. */
function refuseStopped(ctx: JobContext<unknown, unknown>): void {
  const stopped = ctx.sql.exec<{ error: string | null }>("SELECT error FROM _jobs WHERE id = ?", ctx.job.id).one().error;
  if (stopped) throw new StoreError(502, "push_failed", stopped);
}

/**
 * A job taking its DB IO job's calls sleeps until its time is up, and then fails in `timedOut`'s
 * words: a preview's or a compare's successor would begin it again. A write that took a batch is
 * `kept` instead, as a pull is: what it took stays for whoever goes on from there, unless another
 * job needs the store (it then fails in `gaveWay`), and for a day at most.
 */
function waitOrEnd(ctx: JobContext<unknown, unknown>, timedOut: string, kept?: { gaveWay: string }): JobOutcome<never> {
  const end = until(ctx);
  if (ctx.now() < end) return { wait: end };
  if (kept) {
    if (ctx.sql.exec("SELECT 1 AS x FROM _jobs WHERE state = 'queued' LIMIT 1").toArray().length) throw new StoreError(409, "push_gave_way", kept.gaveWay);
    if (ctx.now() < end + PULL_KEPT_AFTER_MS) return { wait: end + PULL_KEPT_AFTER_MS };
  }
  throw new StoreError(408, "push_timed_out", timedOut);
}

/** A preview's or a compare's first chunk: its store table and its table's name, checked. */
function startReading(ctx: JobContext<PushPreviewParams | CompareParams, unknown>, group: string, what: string): ReadingState {
  refuseStopped(ctx);
  const source = sourceOf(ctx.sql, ctx.params.source);
  if (typeof source === "string") throw new StoreError(404, "push_source", source);
  const why = takenWhy(ctx.sql, ctx.params.into, group, what);
  if (why) throw new StoreError(409, "push_name_taken", why);
  return { phase: "taking", failure: null, table: source.name, begun: false, columns: [], sources: [], types: [], key: [], missing: [], ignored: [], rowid: null, display: { kept: [], packed: [] }, page: 0, end: null };
}

/**
 * Makes `<name>__new` the newest version of `name`, or, when an earlier chunk of this job did so and
 * stopped before it said so, answers that version.
 */
async function madeTable(
  ctx: JobContext<{ madeBy: PushPreviewParams["madeBy"] }, unknown>,
  name: string,
  opts: { group: string; comment: string; columns: { name: string; originalType?: string; comment?: string }[] },
): Promise<{ version: number; rows: number }> {
  if (tableExists(ctx.sql, fresh(name))) {
    const handle = await ctx.tables.commit(name, { group: opts.group, madeBy: ctx.params.madeBy, dropOld: true, comment: opts.comment, columns: opts.columns });
    return { version: handle.version, rows: handle.rows };
  }
  const made = ctx.sql.exec<{ version: number; rows: number | null }>("SELECT version, rows FROM _tables WHERE name = ? AND made_job = ?", name, ctx.job.id).toArray()[0];
  if (!made) throw new StoreError(409, "push_failed", `${name} is gone from the store before it was made visible.`);
  return { version: Number(made.version), rows: Number(made.rows ?? 0) };
}

/** The catalog's words for the columns a person reads in a preview's or a compare's table. */
function described(display: ColumnPlan, keyCount: number, words: readonly string[], say: (role: Role) => string): { name: string; originalType?: string; comment: string }[] {
  return display.kept.map((c) => ({ name: c.name, ...(c.originalType ? { originalType: c.originalType } : {}), comment: say(roleOf(c, keyCount, words)) }));
}

const EXTRA_WORDS = { name: EXTRA_COLUMN, comment: "The row's other columns, as JSON by column name." };

/** A made table's rows by what happens to each. */
function byWhat(sql: SqlLike, table: string): Map<string, number> {
  return new Map(sql.exec<{ w: string; n: number }>(`SELECT ${quote(WHAT)} AS w, count(*) AS n FROM ${quote(table)} GROUP BY 1`).toArray().map((r) => [String(r.w), Number(r.n)]));
}

async function finishPreview(ctx: JobContext<PushPreviewParams, PreviewState>, state: PreviewState): Promise<PushPreviewResult> {
  const p = ctx.params;
  const ref = tableRefText(p.target);
  const made = await madeTable(ctx, p.into, {
    group: PREVIEW_GROUP,
    comment: `What writing ${state.table} into ${ref} in ${p.connection.name} would do`,
    columns: [
      { name: KEY, comment: "The row's name: its key's values, as the store holds them." },
      { name: HASH, comment: "A hash of the store's values, which a write would write." },
      { name: NOW_HASH, comment: `A hash of what ${ref} holds now.` },
      { name: VALUES, comment: "The values a write would write, as JSON, in the order of its columns." },
      { name: CHANGED, comment: "The columns a change would change, as JSON." },
      ...described(state.display, state.key.length, PREVIEW_WORDS, (role) => {
        if (role.kind === "key") return `"${role.column}" in ${ref}: part of the key that names a row.`;
        if (role.kind === "word") return role.word === WHAT ? "What a write would do with the row: new, changed, removed or held." : "Why a row is held, or the columns a change changes.";
        return role.kind === "first" ? `"${role.column}" as ${ref} holds it now.` : `"${role.column}" as the write would leave it.`;
      }),
      ...(state.display.packed.length ? [EXTRA_WORDS] : []),
    ],
  });
  const counts = byWhat(ctx.sql, p.into);
  const inserts = counts.get("new") ?? 0;
  const updates = counts.get("changed") ?? 0;
  const deletes = counts.get("removed") ?? 0;
  const end = state.end ?? noEnd();
  const changes = inserts + updates + deletes;
  const record = savedJson<PushRecord>(ctx.sql, pushRecordKey(p.connection.id, p.target));
  const result: PushPreviewResult = {
    table: p.into,
    version: made.version,
    rows: made.rows,
    source: state.table,
    target: ref,
    key: state.key,
    columns: state.columns,
    inserts,
    updates,
    deletes,
    held: counts.get("held") ?? 0,
    unchanged: end.same,
    targetRows: end.targetRows,
    share: end.targetRows > 0 ? Math.min(1, changes / end.targetRows) : changes > 0 ? 1 : 0,
    // A preview of another key or other columns starts a new record at its write.
    first: !record || !recordFits(record, state) || !hasWriter(record, p.writer),
    ignored: state.ignored,
    // Counts only, as the DB IO job sent them: never a value.
    links: end.links ?? [],
  };
  const saved: SavedPreview = { ...result, connection: p.connection, targetRef: p.target, theirEdits: p.theirEdits, removes: p.removes === true, writer: p.writer, at: new Date(ctx.now()).toISOString() };
  ctx.commit({ state: { ...state, made: result }, progress: previewProgress(p, state, "Previewed") }, () => setMeta(ctx.sql, previewKey(p.into), JSON.stringify(saved)));
  return result;
}

async function finishCompare(ctx: JobContext<CompareParams, CompareState>, state: CompareState): Promise<CompareResult> {
  const p = ctx.params;
  const ref = tableRefText(p.target);
  const made = await madeTable(ctx, p.into, {
    group: COMPARED_GROUP,
    comment: `How ${state.table} differs from ${ref} in ${p.connection.name}`,
    columns: [
      { name: KEY, comment: "The row's name: its key's values, as the store holds them." },
      ...described(state.display, state.key.length, COMPARE_WORDS, (role) => {
        if (role.kind === "key") return `"${role.column}" in ${ref}: part of the key that names a row.`;
        if (role.kind === "word") return role.word === DIFFERENCE ? `Whether the row is only in the store, only in ${p.connection.name}, or in both with values that differ.` : "The columns whose values differ.";
        return role.kind === "first" ? `"${role.column}" as the store holds it.` : `"${role.column}" as ${ref} holds it.`;
      }),
      ...(state.display.packed.length ? [EXTRA_WORDS] : []),
    ],
  });
  const end = state.end ?? noEnd();
  const result: CompareResult = {
    table: p.into,
    version: made.version,
    rows: made.rows,
    source: state.table,
    target: ref,
    key: state.key,
    columns: state.columns,
    storeRows: end.read,
    databaseRows: end.targetRows,
    matching: end.same,
    onlyInStore: state.onlyInStore,
    onlyInDatabase: state.onlyInDatabase,
    differing: state.differing,
    otherRows: end.otherRows,
    unlisted: state.unlisted,
  };
  ctx.commit({ state: { ...state, made: result }, progress: compareProgress(p, state, "Compared") });
  return result;
}

/** The statement that lists a push's held rows: the preview's rows held at the preview, and those `?1` names, each with why. */
function heldSelect(sql: SqlLike, preview: string, into: string): string {
  const columns = columnNames(sql, preview).filter((c) => c !== HASH && c !== NOW_HASH && c !== VALUES && c !== CHANGED && c !== BEFORE);
  const p = (c: string): string => `p.${quote(c)}`;
  const select = columns.map((c) => {
    if (c === WHAT) return `CAST(CASE WHEN s.k IS NULL THEN ${p(WHAT)} ELSE 'held' END AS TEXT) AS ${quote(WHAT)}`;
    if (c === NOTE) return `CAST(CASE s.why WHEN 'changed_there' THEN ?2 WHEN 'removed_there' THEN ?3 WHEN 'appeared' THEN ?4 WHEN 'since_preview' THEN ?5 ELSE ${p(NOTE)} END AS TEXT) AS ${quote(NOTE)}`;
    return `${p(c)} AS ${quote(c)}`;
  });
  const since = "SELECT j.value ->> 0 AS k, max(j.value ->> 1) AS why FROM json_each(?1) AS j GROUP BY 1";
  return `CREATE TABLE ${quote(into)} AS SELECT ${select.join(", ")} FROM ${quote(preview)} AS p LEFT JOIN (${since}) AS s ON s.k = ${p(KEY)} WHERE ${p(WHAT)} = 'held' OR s.k IS NOT NULL ORDER BY ${p(KEY)}`;
}

// ─── a write's end ────────────────────────────────────────────────────────────────────────────

/** How many of a committed write's or undo's pending rows one commit takes. */
const APPLY_ROWS = KEYS_AT_ONCE;

type HeldTable = PushResult["heldTable"];

/**
 * What a write was, for an undo (`pushWriteKey`): its connection and its parts, each with the rows an
 * undo takes back there once the write `ended` (its record's rows with a `did`, by what it did), and
 * the rows it held: 0 while it runs, and for a rehearsal.
 */
function writeRecordOf(ctx: JobContext<PushParams, PushState>, state: PushState, at: string, ended: boolean): PushWriteRecord {
  const counted = ended && !state.rehearse;
  const parts = state.parts.map((part, i) => ({
    preview: part.preview,
    target: part.target,
    key: part.key,
    columns: part.columns,
    ...(counted ? undoableCounts(ctx.sql, ctx.job.id, i) : { inserted: 0, updated: 0, deleted: 0 }),
    held: counted ? part.heldAtPreview + part.heldSince : 0,
    ...(part.links?.length ? { links: part.links } : {}),
  }));
  return { connection: ctx.params.connection, parts, at, by: ctx.job.by, rehearse: state.rehearse, ended, undone: null };
}

/** The record of a write that ended, with what an undo takes back of each table: when it began, if a write of one preview recorded that, and whether an undo undid it. */
function keepWriteRecord(ctx: JobContext<PushParams, PushState>, state: PushState, at: string): void {
  const key = pushWriteKey(ctx.job.id);
  const before = savedJson<PushWriteRecord>(ctx.sql, key);
  setMeta(ctx.sql, key, JSON.stringify({ ...writeRecordOf(ctx, state, before?.at ?? at, true), undone: before?.undone ?? null } satisfies PushWriteRecord));
}

/** A write's answer; `heldTables` names each part's held rows' table (none for a rehearsal), the first of them the write's. */
function pushResultOf(ctx: JobContext<PushParams, PushState>, state: PushState, end: Pick<PushResult, "restored" | "manifest">, heldTables: readonly HeldTable[], keptTables: readonly HeldTable[] = []): PushResult {
  const parts: PushPartResult[] = state.parts.map((part, i) => ({
    preview: part.preview,
    target: tableRefText(part.target),
    inserted: part.inserted,
    updated: part.updated,
    deleted: part.deleted,
    held: part.heldAtPreview + part.heldSince,
    heldTable: heldTables[i] ?? null,
    kept: part.kept ?? 0,
    keptColumns: part.keptColumns ?? [],
    keptTable: keptTables[i] ?? null,
  }));
  return {
    write: ctx.job.id,
    rehearsed: state.rehearse,
    restored: end.restored,
    manifest: end.manifest,
    parts,
    preview: ctx.params.preview,
    target: parts[0]!.target,
    inserted: sum(parts, (p) => p.inserted),
    updated: sum(parts, (p) => p.updated),
    deleted: sum(parts, (p) => p.deleted),
    held: sum(parts, (p) => p.held),
    heldSince: sum(state.parts, (p) => p.heldSince),
    batches: state.batches,
    // A write of several tables names the first held table: each part names its own.
    heldTable: parts.find((part) => part.heldTable !== null)?.heldTable ?? null,
    kept: sum(parts, (p) => p.kept),
    keptTable: parts.find((part) => part.keptTable !== null)?.keptTable ?? null,
  };
}

/** A batch of a job's pending rows of one part, after `after`, in key order: what one commit of its committed end takes. */
const pendingBatch = (sql: SqlLike, jobId: string, at: number, after: string | null) => pendingRows(sql, jobId, at, after, APPLY_ROWS);
type PendingRow = ReturnType<typeof pendingBatch>[number];

/**
 * A batch of a committed write's pending outcomes, of one part, taken: the memory of what it wrote
 * (a row the preview found new is one this store put there), the keys it removed let go, and the
 * rows of its record `done`.
 */
function takePending(sql: SqlLike, connectionId: string, jobId: string, part: PushPart, at: number, rows: readonly PendingRow[], now: string): void {
  const target = pushTargetId(connectionId, part.target);
  const written = rows.filter((r) => r.sent !== null && r.held !== null);
  const was = previewedAs(sql, part.preview.table, written.map((r) => r.k));
  remember(sql, target, now, written.map((r) => [r.k, r.sent, r.held, was.get(r.k) === "new" ? "1" : "0"]));
  forget(sql, target, rows.filter((r) => r.sent === null).map((r) => r.k));
  markRows(sql, jobId, at, rows.map((r) => r.k), "pending", "done");
}

/**
 * A one-transaction write's committed end: its pending outcomes are taken a batch at a time, part by
 * part, each table's memory and record first becoming those of its preview's key and columns (as a
 * write of one preview's do at its start). Answers false when the chunk's time ran out first.
 */
function applyCommitted(ctx: JobContext<PushParams, PushState>, state: PushState): boolean {
  const p = ctx.params;
  const now = new Date(ctx.now()).toISOString();
  if (!state.applied) {
    state.applied = { part: 0, after: null };
    ctx.commit({ state, progress: pushProgress(state, "Taking what the write did") }, () => {
      for (const part of state.parts) keepRecord(ctx.sql, p.connection.id, part.target, part);
    });
  }
  while (state.applied.part < state.parts.length) {
    if (ctx.now() >= ctx.deadline) return false;
    const at: number = state.applied.part;
    const rows = pendingBatch(ctx.sql, ctx.job.id, at, state.applied.after);
    if (!rows.length) {
      state.applied = { part: at + 1, after: null };
      continue;
    }
    state.applied = { part: at, after: rows[rows.length - 1]!.k };
    ctx.commit({ state, progress: pushProgress(state, "Taking what the write did") }, () => takePending(ctx.sql, p.connection.id, ctx.job.id, state.parts[at]!, at, rows, now));
  }
  return true;
}

/** The record of each table a write wrote (its memory's key and columns, who wrote and its last write), and of the write itself, for an undo. */
function recordWrite(ctx: JobContext<PushParams, PushState>, state: PushState, at: string): void {
  const p = ctx.params;
  for (const part of state.parts) {
    keepRecord(ctx.sql, p.connection.id, part.target, part);
    const recordKey = pushRecordKey(p.connection.id, part.target);
    const record = savedJson<PushRecord>(ctx.sql, recordKey)!;
    // Who wrote is who was asked before writing: a write with nothing to write asked nobody
    // (database-push.ts `asksPerson`), so its program's version is still to be asked.
    if (part.toWrite > 0) addWriter(record, p.writer, at);
    record.last = { at, by: ctx.job.by, preview: part.preview, inserted: part.inserted, updated: part.updated, deleted: part.deleted, held: part.heldAtPreview + part.heldSince };
    setMeta(ctx.sql, recordKey, JSON.stringify(record));
  }
  keepWriteRecord(ctx, state, at);
}

/**
 * A committed write whose job ended before it took what the database did (its run was stopped, or
 * a chunk kept failing): every pending outcome is taken all the same, in one go, and the write's
 * records kept. Its held rows are not listed: the job failed.
 */
function takeAll(ctx: JobContext<PushParams, PushState>, state: PushState): void {
  const p = ctx.params;
  const now = new Date(ctx.now()).toISOString();
  ctx.commit({ state, progress: pushProgress(state, "Stopped: what the database committed is taken") }, () => {
    for (const part of state.parts) keepRecord(ctx.sql, p.connection.id, part.target, part);
    state.parts.forEach((part, at) => {
      for (let rows = pendingBatch(ctx.sql, ctx.job.id, at, null); rows.length; rows = pendingBatch(ctx.sql, ctx.job.id, at, rows[rows.length - 1]!.k)) {
        takePending(ctx.sql, p.connection.id, ctx.job.id, part, at, rows, now);
      }
    });
    recordWrite(ctx, state, now);
  });
}

/**
 * A part's held rows into its held table (To review): those held at the preview, and those the
 * database changed after it. Null when it held none; an earlier push's list of the same rows is
 * emptied all the same.
 */
async function heldTableFor(ctx: JobContext<PushParams, PushState>, state: PushState, part: PushPart, used: Set<string>): Promise<HeldTable> {
  const p = ctx.params;
  const preview = part.preview.table;
  const ref = tableRefText(part.target);
  const held = part.heldAtPreview + part.heldSince;
  const { name, earlier } = heldTableOf(ctx.sql, preview, used);
  used.add(name.toLowerCase());
  const already = ctx.sql.exec("SELECT 1 AS x FROM _tables WHERE name = ? AND made_job = ?", name, ctx.job.id).toArray().length > 0;
  // Made when a row was held, and when an earlier push's list is there, so that list empties.
  if (held === 0 && !earlier && !already) return null;
  if (!already && !tableExists(ctx.sql, fresh(name))) {
    const why: HeldWhy[] = ["changed_there", "removed_there", "appeared", "since_preview"];
    ctx.commit({ state, progress: pushProgress(state, "Listing the rows held back") }, () => {
      const begun = ctx.tables.begin(name);
      ctx.sql.exec(heldSelect(ctx.sql, preview, begun), JSON.stringify(part.heldKeys), ...why.map((w) => heldNote(w, p.connection.name)));
    });
  }
  const words = new Map(ctx.sql.exec<{ name: string; original_type: string | null; comment: string | null }>("SELECT name, original_type, comment FROM _columns WHERE tbl = ?", preview).toArray().map((c) => [String(c.name), c]));
  const columns = columnNames(ctx.sql, tableExists(ctx.sql, fresh(name)) ? fresh(name) : name).map((c) => {
    const said = words.get(c);
    return { name: c, ...(said?.original_type ? { originalType: String(said.original_type) } : {}), ...(said?.comment ? { comment: String(said.comment) } : {}) };
  });
  const made = await madeTable(ctx, name, { group: HELD_GROUP, comment: `Rows the write of ${preview} held back from ${ref} in ${p.connection.name}: look at each before the next write`, columns });
  return held > 0 ? { table: name, version: made.version, rows: made.rows } : null;
}

/** The catalog's words for a write's list of kept rows' columns. */
function keptColumnWords(part: PushPart): { name: string; originalType?: string; comment: string }[] {
  const ref = tableRefText(part.target);
  const display = part.keptList!.display;
  return [
    { name: KEY, comment: "The row's name: its key's values, as the store holds them." },
    { name: HASH, comment: "A hash of the values the write sent." },
    { name: AFTER_HASH, comment: `A hash of what ${ref} holds after the write.` },
    ...described(display, part.key.length, KEPT_WORDS, (role) => {
      if (role.kind === "key") return `"${role.column}" in ${ref}: part of the key that names a row.`;
      if (role.kind === "word") return role.word === WHAT_HAPPENED ? "What the write did with the row: inserted or updated." : `The columns ${ref} holds other than the write sent them, and how: cut short, rounded, filled in or changed.`;
      return role.kind === "first" ? `"${role.column}" as the write sent it.` : `"${role.column}" as ${ref} holds it after the write.`;
    }),
    ...(display.packed.length ? [EXTRA_WORDS] : []),
  ];
}

/**
 * A part's list of the rows its database kept differently, made visible; null when it kept none.
 * An earlier write's list stays as it is: a preview never finds a kept row again, so its list is the
 * only record of it. A list that cannot be made under its name (another table took it since the write
 * began) goes, and the counts stay: it never fails a write its database committed.
 */
async function keptTableFor(ctx: JobContext<PushParams, PushState>, state: PushState, part: PushPart): Promise<HeldTable> {
  const list = part.keptList;
  if (!list?.begun) return null;
  const drop = (): HeldTable => {
    if (tableExists(ctx.sql, fresh(list.name))) ctx.commit({ state, progress: pushProgress(state, "Listing the values kept differently") }, () => ctx.tables.abandon(list.name));
    return null;
  };
  // Begun by a try its database rolled back, and kept nothing since.
  if ((part.kept ?? 0) === 0) return drop();
  try {
    const made = await madeTable(ctx, list.name, {
      group: HELD_GROUP,
      comment: `Rows ${tableRefText(part.target)} in ${ctx.params.connection.name} holds other than the write of ${part.preview.table} sent them: each value as sent beside the one it holds`,
      columns: keptColumnWords(part),
    });
    return { table: list.name, version: made.version, rows: made.rows };
  } catch {
    return drop();
  }
}

/** A real write's end: each part's held rows and kept rows listed, and the records of what it wrote. */
async function finishWrite(ctx: JobContext<PushParams, PushState>, state: PushState): Promise<PushResult> {
  const used = new Set<string>();
  const heldTables: HeldTable[] = [];
  for (const part of state.parts) heldTables.push(await heldTableFor(ctx, state, part, used));
  const keptTables: HeldTable[] = [];
  for (const part of state.parts) keptTables.push(await keptTableFor(ctx, state, part));
  const at = new Date(ctx.now()).toISOString();
  const result = pushResultOf(ctx, state, { restored: null, manifest: [] }, heldTables, keptTables);
  ctx.commit({ state: { ...state, made: result }, progress: pushProgress(state, "Written", true) }, () => recordWrite(ctx, state, at));
  return result;
}

/** The catalog's words for a rehearsal's manifest's columns. */
function manifestColumns(part: PushPart): { name: string; originalType?: string; comment: string }[] {
  const ref = tableRefText(part.target);
  const display = part.manifest!.display;
  return [
    { name: KEY, comment: "The row's name: its key's values, as the store holds them." },
    { name: HASH, comment: "A hash of the values the write sent; empty for a row it removed or held." },
    { name: AFTER_HASH, comment: `A hash of what ${ref} held after the write, inside its transaction.` },
    ...described(display, part.key.length, MANIFEST_WORDS, (role) => {
      if (role.kind === "key") return `"${role.column}" in ${ref}: part of the key that names a row.`;
      if (role.kind === "word") {
        if (role.word === WHAT_HAPPENED) return "What the write did with the row before it rolled back: inserted, updated, removed or held.";
        return role.word === COLUMNS_SET ? "The columns the write set in a row it updated." : "Why the write held a row.";
      }
      return role.kind === "first" ? `"${role.column}" as the write sent it.` : `"${role.column}" as ${ref} held it after the write, inside its transaction: a trigger's or a default's work shows.`;
    }),
    ...(display.packed.length ? [EXTRA_WORDS] : []),
  ];
}

/** A rehearsal's end: its database rolled the write back, and each part's manifest becomes visible. Neither the memory nor the record of who wrote changes. */
async function finishRehearsal(ctx: JobContext<PushParams, PushState>, state: PushState): Promise<PushResult> {
  const p = ctx.params;
  const manifest: PushResult["manifest"] = [];
  for (const part of state.parts) {
    const m = part.manifest!;
    const already = ctx.sql.exec("SELECT 1 AS x FROM _tables WHERE name = ? AND made_job = ?", m.name, ctx.job.id).toArray().length > 0;
    // A rehearsal with nothing to write had no DB IO job: its manifests are begun here, empty.
    if (!already && !tableExists(ctx.sql, fresh(m.name))) ctx.commit({ state, progress: pushProgress(state, "Making the rehearsal's manifests") }, () => beginManifest(ctx.sql, ctx.tables, m));
    const made = await madeTable(ctx, m.name, {
      group: REHEARSAL_GROUP,
      comment: `What writing ${part.preview.table} into ${tableRefText(part.target)} in ${p.connection.name} did inside one transaction, which it rolled back: nothing of it stayed`,
      columns: manifestColumns(part),
    });
    manifest.push({ table: m.name, version: made.version, rows: made.rows });
  }
  const at = new Date(ctx.now()).toISOString();
  // A rehearsal makes no held table: its manifests list the rows it held.
  const result = pushResultOf(ctx, state, { restored: state.restored ?? 0, manifest }, []);
  ctx.commit({ state: { ...state, made: result }, progress: pushProgress(state, "Rehearsed", true) }, () => keepWriteRecord(ctx, state, at));
  return result;
}

async function finishPush(ctx: JobContext<PushParams, PushState>, state: PushState): Promise<JobOutcome<PushResult>> {
  if (state.rehearse) return { result: await finishRehearsal(ctx, state) };
  if (state.oneTransaction && !applyCommitted(ctx, state)) return { more: true };
  return { result: await finishWrite(ctx, state) };
}

// ─── a write's start ──────────────────────────────────────────────────────────────────────────

/** The database's type of each of a write's columns, as its preview's catalog says them; "" where it says none. */
function previewTypes(sql: SqlLike, preview: string, part: { key: string[]; columns: string[] }): string[] {
  const said = new Map(sql.exec<{ name: string; original_type: string | null }>("SELECT name, original_type FROM _columns WHERE tbl = ?", preview).toArray().map((c) => [String(c.name), c.original_type === null ? "" : String(c.original_type)]));
  const typeOf = new Map<string, string>();
  // The preview's columns, named as its begin named them: a key's column, and the first of each pair, say their type.
  for (const c of previewPlan({ columns: part.columns, types: [], key: part.key }).kept) {
    const role = roleOf(c, part.key.length, PREVIEW_WORDS);
    if (role.kind === "key" || role.kind === "first") typeOf.set(role.column, said.get(c.name) ?? "");
  }
  return part.columns.map((c) => typeOf.get(c) ?? "");
}

/** A rehearsal's manifest's columns a person reads: the key's, what the write did, the columns it set, then each other column as sent and as the database held it after, and why it held a row. */
function manifestPlan(sql: SqlLike, part: PushPart): ColumnPlan {
  const { key, others } = columnsOf({ columns: part.columns, types: previewTypes(sql, part.preview.table, part), key: part.key });
  return displayPlan([AFTER_HASH], key, MANIFEST_WORDS, 1, others, ["_sent", "_after"]);
}

/** A write's list of the rows its database kept differently: the key's columns, what the write did and the columns kept so, then each other column as sent and as the database holds it. */
function keptPlan(sql: SqlLike, part: PushPart): ColumnPlan {
  const { key, others } = columnsOf({ columns: part.columns, types: previewTypes(sql, part.preview.table, part), key: part.key });
  return displayPlan([AFTER_HASH], key, KEPT_WORDS, 0, others, ["_sent", "_kept"]);
}

/** A rehearsal's manifest's table begun anew (`<name>__new`), as a job begins a table it makes; a write's list of kept rows too. */
function beginManifest(sql: SqlLike, tables: ProgramTables, manifest: { name: string; display: ColumnPlan }): void {
  let name: string;
  try {
    name = tables.begin(manifest.name);
  } catch (error) {
    if (error instanceof ProgramTableError) throw new StoreError(409, "push_name_taken", error.message);
    throw error;
  }
  const columns = madeColumns(MANIFEST_MACHINE, manifest.display);
  sql.exec(`CREATE TABLE ${quote(name)} (${columns.map((c) => `${quote(c)} TEXT${c === KEY ? " NOT NULL" : ""}`).join(", ")})`);
}

/**
 * One preview of a write, checked: exactly the version named, of the write's connection, still true
 * of the database's table as the store last wrote it, and not written already.
 */
function checkedPreview(ctx: JobContext<PushParams, PushState>, ref: PreviewRef): PushPart {
  const p = ctx.params;
  const table = ref.table;
  const saved = savedJson<SavedPreview>(ctx.sql, previewKey(table));
  const row = ctx.sql.exec<{ version: number; grp: string | null }>("SELECT version, grp FROM _tables WHERE name = ? AND kind = 'program'", table).toArray()[0];
  if (!row || !saved || row.grp !== PREVIEW_GROUP || !tableExists(ctx.sql, table)) throw new StoreError(409, "preview_replaced", `${table} is gone from the store: preview again, then write that.`);
  if (Number(row.version) !== ref.version || saved.version !== ref.version) {
    const now = Number(row.version) !== ref.version ? Number(row.version) : saved.version;
    throw new StoreError(409, "preview_replaced", `${table} is now version ${now}: preview again, then write that.`);
  }
  if (saved.connection.id !== p.connection.id) throw new StoreError(409, "preview_stale", `${table} previews a write into ${saved.target} in ${saved.connection.name}: preview again with ${p.connection.name}.`);
  const record = savedJson<PushRecord>(ctx.sql, pushRecordKey(p.connection.id, saved.targetRef));
  if (record && recordFits(record, saved)) {
    // A preview is written once: written again, it would put back what people changed since.
    if (record.last?.preview.table === table && record.last.preview.version === ref.version) {
      throw new StoreError(409, "preview_written", `${table} version ${ref.version} was written already: preview again to see what is left to write.`);
    }
  } else if (record?.last && record.last.at > saved.at) {
    // A write of other columns or another key came after this preview: what it read is gone.
    throw new StoreError(409, "preview_stale", `The columns written into ${saved.target} changed since this preview: preview again.`);
  }
  const toWrite = Number(ctx.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${quote(table)} WHERE ${quote(WHAT)} IN ('new', 'changed', 'removed')`).one().n);
  return {
    preview: ref,
    target: saved.targetRef,
    key: saved.key,
    columns: saved.columns,
    theirEdits: saved.theirEdits,
    toWrite,
    inserted: 0,
    updated: 0,
    deleted: 0,
    heldAtPreview: saved.held,
    heldSince: 0,
    heldKeys: [],
    heldKeysBytes: 0,
    manifest: null,
  };
}

/**
 * A push's first chunk: exactly the previews it names, each checked as one is (`checkedPreview`),
 * each database table once. A rehearsal names its manifests here, one per database table.
 */
function startPush(ctx: JobContext<PushParams, PushState>): PushState {
  refuseStopped(ctx);
  const p = ctx.params;
  const parts: PushPart[] = [];
  for (const ref of previewsOf(p)) {
    const part = checkedPreview(ctx, ref);
    const same = (t: DatabaseTableRef): boolean => t.schema.toLowerCase() === part.target.schema.toLowerCase() && t.name.toLowerCase() === part.target.name.toLowerCase();
    const twice = parts.find((o) => same(o.target));
    if (twice) throw new StoreError(409, "preview_twice", `${twice.preview.table} and ${ref.table} both write into ${tableRefText(part.target)}: a write writes each table once.`);
    parts.push(part);
  }
  for (const part of parts) {
    const links = linksAcross(savedJson<SavedPreview>(ctx.sql, previewKey(part.preview.table))?.links ?? [], part, parts);
    if (links.length) part.links = links;
  }
  if (p.rehearse) {
    const used = new Set<string>();
    for (const part of parts) {
      const { name } = madeTableName(ctx.sql, rehearsalTableName(part.target), REHEARSAL_GROUP, (c) => c.includes(KEY) && c.includes(WHAT_HAPPENED), `the rehearsal of a write into ${tableRefText(part.target)}`, used);
      used.add(name.toLowerCase());
      part.manifest = { name, display: manifestPlan(ctx.sql, part) };
    }
  } else {
    const used = new Set<string>();
    for (const part of parts) {
      const ref = tableRefText(part.target);
      const { name } = madeTableName(ctx.sql, keptTableName(part.target), HELD_GROUP, (c) => c.includes(KEY) && c.includes(KEPT_DIFFERENTLY), `the values ${ref} kept differently`, used);
      used.add(name.toLowerCase());
      part.keptList = { name, display: keptPlan(ctx.sql, part), begun: false };
    }
  }
  return { phase: "taking", failure: null, oneTransaction: oneTransactionOf(p), rehearse: p.rehearse === true, parts, page: 0, cursor: null, batches: 0, begun: false, begunBy: null, restored: null, applied: null, made: null };
}

/**
 * The links a part's preview counted that name another table of the same write, each as a link spec:
 * the counts name the linked table as `schema.table.column`, read against each other part's table so
 * that no name is split at a dot it holds. An undo of the write holds the rows they join together.
 */
function linksAcross(counted: readonly LinkCount[], part: PushPart, parts: readonly PushPart[]): LinkSpec[] {
  const out: LinkSpec[] = [];
  for (const c of counted) {
    for (const other of parts) {
      if (other === part) continue;
      const prefix = `${other.target.schema}.${other.target.name}.`;
      if (c.to.length > prefix.length && c.to.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
        out.push({ column: c.column, to: { schema: other.target.schema, name: other.target.name, column: c.to.slice(prefix.length) } });
        break;
      }
    }
  }
  return out;
}

/** A write taking its DB IO job's calls sleeps until its DB IO job's time is up, and then ends in words for how far it got. */
function waitForWrite(ctx: JobContext<PushParams, PushState>, state: PushState): JobOutcome<never> {
  if (!state.oneTransaction) {
    if (state.page === 0) return waitOrEnd(ctx, "No DB IO job wrote this preview before its time was up. Write it again.");
    return waitOrEnd(ctx, "The DB IO job stopped before every batch was written, and its time is up. What it wrote stays written: preview again to see what is left.", {
      gaveWay: "This write stopped and no DB IO job came back for it, so it ended when another job needed the store. What it wrote stays written: preview again to see what is left.",
    });
  }
  // Nothing of a rehearsal stays: its successor would begin it again.
  if (state.rehearse) return waitOrEnd(ctx, "No DB IO job finished this rehearsal before its time was up. Rehearse it again.");
  if (!state.begun) return waitOrEnd(ctx, "No DB IO job wrote these previews before its time was up. Write them again.");
  // Its DB IO job may have committed and stopped before it said so: a successor finds the rows written, and the store takes them.
  return waitOrEnd(ctx, "The DB IO job stopped before it said its database committed this write, and its time is up. Preview again to see what is written.", {
    gaveWay: "This write stopped before its DB IO job said its database committed it, and no DB IO job came back for it, so it ended when another job needed the store. Preview again to see what is written.",
  });
}

/**
 * Refuses a preview's end that does not count each link the preview was asked to count, in order: a
 * runner that counts none (one older than links) would answer as though none were asked, and a
 * program's check of the unlinked rows would read nothing.
 */
function refuseUncounted(asked: readonly LinkSpec[], counted: readonly LinkCount[]): void {
  const same = counted.length === asked.length && asked.every((l, i) => counted[i]!.column.toLowerCase() === l.column.toLowerCase());
  if (!same) throw new StoreError(409, "push_link", `This preview was asked to count ${many(asked.length, "link")} and its DB IO job counted ${counted.length}: a DB IO job that counts links writes nothing it was not asked for. Update DB IO, then preview again.`);
}

// ─── an undo ──────────────────────────────────────────────────────────────────────────────────

/** An undo's first chunk: the write it takes back, a real write into this connection, not undone already. */
function startUndo(ctx: JobContext<PushUndoParams, UndoState>): UndoState {
  refuseStopped(ctx);
  const p = ctx.params;
  const record = savedJson<PushWriteRecord>(ctx.sql, pushWriteKey(p.write));
  if (!record) throw new StoreError(404, "write_not_found", `This store has no write ${p.write} to undo: an undo names a write by the id db_push answered.`);
  if (record.rehearse) throw new StoreError(409, "write_rehearsed", `Write ${p.write} was a rehearsal: its database rolled it back, so nothing of it stayed to undo.`);
  if (record.connection.id !== p.connection.id) throw new StoreError(409, "write_elsewhere", `Write ${p.write} was into ${record.connection.name}, not ${p.connection.name}.`);
  if (record.undone) throw new StoreError(409, "write_undone", `Write ${p.write} was undone already.`);
  const parts = record.parts.map(
    (part, i): UndoPart => ({
      preview: part.preview,
      target: part.target,
      key: part.key,
      columns: part.columns,
      ...(part.links?.length ? { links: part.links } : {}),
      toUndo: undoCount(ctx.sql, p.write, i),
      removed: 0,
      putBack: 0,
      reinserted: 0,
      held: 0,
    }),
  );
  return { phase: "taking", failure: null, write: p.write, parts, page: 0, begun: false, begunBy: null, applied: null, made: null };
}

/**
 * A batch of a committed undo's pending outcomes, of one part, taken: each undone key's memory as it
 * was before the write, the write's rows `undone`, and the undo's own `done`.
 */
function takeUndone(sql: SqlLike, connectionId: string, jobId: string, state: UndoState, at: number, rows: readonly PendingRow[], now: string): void {
  const part = state.parts[at]!;
  const undone = rows.filter((r) => r.did === "undone").map((r) => r.k);
  const fits = recordFits(savedJson<PushRecord>(sql, pushRecordKey(connectionId, part.target)), part);
  putBack(sql, pushTargetId(connectionId, part.target), now, state.write, at, undone, fits);
  markRows(sql, state.write, at, undone, "done", "undone");
  markRows(sql, jobId, at, rows.map((r) => r.k), "pending", "done");
}

/** An undo's committed end: its pending outcomes taken a batch at a time, part by part. Answers false when the chunk's time ran out first. */
function applyUndone(ctx: JobContext<PushUndoParams, UndoState>, state: UndoState): boolean {
  const now = new Date(ctx.now()).toISOString();
  state.applied ??= { part: 0, after: null };
  while (state.applied.part < state.parts.length) {
    if (ctx.now() >= ctx.deadline) return false;
    const at: number = state.applied.part;
    const rows = pendingBatch(ctx.sql, ctx.job.id, at, state.applied.after);
    if (!rows.length) {
      state.applied = { part: at + 1, after: null };
      continue;
    }
    state.applied = { part: at, after: rows[rows.length - 1]!.k };
    ctx.commit({ state, progress: undoProgress(state, "Taking what the undo did") }, () => takeUndone(ctx.sql, ctx.params.connection.id, ctx.job.id, state, at, rows, now));
  }
  return true;
}

/** The write an undo took back, marked undone: a second undo of it is refused. */
function markUndone(sql: SqlLike, write: string, at: string): void {
  const key = pushWriteKey(write);
  const record = savedJson<PushWriteRecord>(sql, key);
  if (record && !record.undone) setMeta(sql, key, JSON.stringify({ ...record, undone: at } satisfies PushWriteRecord));
}

/** A committed undo whose job ended before it took what the database did: every pending outcome taken all the same, in one go. */
function takeAllUndone(ctx: JobContext<PushUndoParams, UndoState>, state: UndoState): void {
  const now = new Date(ctx.now()).toISOString();
  ctx.commit({ state, progress: undoProgress(state, "Stopped: what the database committed is taken") }, () => {
    state.parts.forEach((_, at) => {
      for (let rows = pendingBatch(ctx.sql, ctx.job.id, at, null); rows.length; rows = pendingBatch(ctx.sql, ctx.job.id, at, rows[rows.length - 1]!.k)) {
        takeUndone(ctx.sql, ctx.params.connection.id, ctx.job.id, state, at, rows, now);
      }
    });
    markUndone(ctx.sql, state.write, now);
  });
}

/** An undo's held rows' columns a person reads: the key's, what the write did, the columns it set, and why the undo left the row. */
const undoHeldPlan = (part: UndoPart): ColumnPlan =>
  displayPlan(
    [],
    part.key.map((k) => ({ name: k, type: "" })),
    MANIFEST_WORDS,
    0,
    [],
    ["", ""],
  );

/**
 * The statement that lists an undo's held rows of one part (`?1` the undo, `?2` the write, `?3` the
 * part), with what the write did to each and why the undo held it: `?4` changed there, `?5` other
 * columns it cannot put back, `?6` a value too long to have been kept, `?7` a row it holds names it
 * or it names a row it holds.
 */
function undoHeldSelect(part: UndoPart, display: ColumnPlan, into: string): string {
  const n = part.key.length;
  const select = display.kept.map((c) => {
    if (c.index < n) return `${n === 1 ? "u.k" : `CASE WHEN json_valid(u.k) THEN CAST(json_extract(u.k, '$[${c.index}]') AS TEXT) END`} AS ${quote(c.name)}`;
    const word = MANIFEST_WORDS[c.index - n];
    if (word === WHAT_HAPPENED) return `CAST(CASE w.did WHEN 'inserted' THEN 'inserted' WHEN 'updated' THEN 'updated' ELSE 'removed' END AS TEXT) AS ${quote(c.name)}`;
    if (word === COLUMNS_SET) return `(SELECT group_concat(j.value, ', ') FROM json_each(w.set_cols) AS j) AS ${quote(c.name)}`;
    return `CAST(CASE u.why WHEN 'columns' THEN ?5 WHEN 'too_long' THEN ?6 WHEN 'together' THEN ?7 ELSE ?4 END AS TEXT) AS ${quote(c.name)}`;
  });
  return `CREATE TABLE ${quote(into)} AS SELECT ${select.join(", ")}, u.k AS ${quote(KEY)} FROM _push_writes AS u JOIN _push_writes AS w ON w.job = ?2 AND w.part = u.part AND w.k = u.k WHERE u.job = ?1 AND u.part = ?3 AND u.did = 'held' ORDER BY u.k`;
}

/** An undo's held rows of one part: a table in To review, `undo_held_<table>`, made anew by each undo that held some. */
async function undoHeldTable(ctx: JobContext<PushUndoParams, UndoState>, state: UndoState, at: number, used: Set<string>): Promise<NonNullable<PushUndoResult["heldTable"]>> {
  const part = state.parts[at]!;
  const ref = tableRefText(part.target);
  const connection = ctx.params.connection.name;
  const { name } = madeTableName(ctx.sql, undoHeldTableName(part.target), HELD_GROUP, (c) => c.includes(KEY) && c.includes(WHAT_HAPPENED) && c.includes(NOTE), `the rows an undo of a write into ${ref} held`, used);
  used.add(name.toLowerCase());
  const display = undoHeldPlan(part);
  const already = ctx.sql.exec("SELECT 1 AS x FROM _tables WHERE name = ? AND made_job = ?", name, ctx.job.id).toArray().length > 0;
  if (!already && !tableExists(ctx.sql, fresh(name))) {
    ctx.commit({ state, progress: undoProgress(state, "Listing the rows held back") }, () => {
      const begun = ctx.tables.begin(name);
      ctx.sql.exec(
        undoHeldSelect(part, display, begun),
        ctx.job.id,
        state.write,
        at,
        `Changed in ${connection} since this write: not undone`,
        "Its other columns held values, or its table needs one the write did not write, so it cannot go back whole: not undone",
        "It holds a value too long to have been kept: not undone",
        "Written together with a row this undo kept, and joined to it by a link: not undone",
      );
    });
  }
  const made = await madeTable(ctx, name, {
    group: HELD_GROUP,
    comment: `Rows of ${ref} in ${connection} that an undo of a write left as they are, each with why: look at each`,
    columns: [
      ...described(display, part.key.length, MANIFEST_WORDS, (role) => {
        if (role.kind === "key") return `"${role.column}" in ${ref}: part of the key that names a row.`;
        if (role.kind === "word" && role.word === WHAT_HAPPENED) return "What the write did to the row: inserted, updated or removed.";
        if (role.kind === "word" && role.word === COLUMNS_SET) return "The columns the write set in a row it updated.";
        return "Why the undo left the row as it is.";
      }),
      { name: KEY, comment: "The row's name: its key's values, as the store holds them." },
    ],
  });
  return { table: name, version: made.version, rows: made.rows };
}

/** An undo's end: what it undid taken, the rows it held listed, and the write marked undone. */
async function finishUndo(ctx: JobContext<PushUndoParams, UndoState>, state: UndoState): Promise<JobOutcome<PushUndoResult>> {
  if (!applyUndone(ctx, state)) return { more: true };
  const used = new Set<string>();
  const heldTables: HeldTable[] = [];
  for (let at = 0; at < state.parts.length; at++) heldTables.push(state.parts[at]!.held > 0 ? await undoHeldTable(ctx, state, at, used) : null);
  const at = new Date(ctx.now()).toISOString();
  const result: PushUndoResult = {
    write: state.write,
    target: tableRefText(state.parts[0]!.target),
    removed: sum(state.parts, (p) => p.removed),
    putBack: sum(state.parts, (p) => p.putBack),
    reinserted: sum(state.parts, (p) => p.reinserted),
    held: sum(state.parts, (p) => p.held),
    // An undo of several tables names the first held table: each part names its own.
    heldTable: heldTables.find((t) => t !== null) ?? null,
    parts: state.parts.map((p, i) => ({ target: tableRefText(p.target), removed: p.removed, putBack: p.putBack, reinserted: p.reinserted, held: p.held, heldTable: heldTables[i] ?? null })),
  };
  ctx.commit({ state: { ...state, made: result }, progress: undoProgress(state, "Undone", true) }, () => markUndone(ctx.sql, state.write, at));
  return { result };
}

// ─── the job handlers ─────────────────────────────────────────────────────────────────────────

export const pushPreviewHandler: JobHandler<PushPreviewParams, PreviewState, PushPreviewResult> = {
  kind: "push_preview",
  // Its chunks write only a job's own records: each page meets the day's limit at its own call, and
  // a preview whose DB IO job sent all it had still ends, and its table becomes visible.
  pastLimit: true,

  parse: (params) => parsed(() => pushPreviewParamsOf(params)),

  async run(ctx) {
    if (ctx.state === null) {
      // Its links were checked as its parameters were (pushPreviewParamsOf): one a column, none to its own table.
      const state: PreviewState = { ...startReading(ctx, PREVIEW_GROUP, "preview"), counts: blankCounts(), made: null };
      ctx.commit({ state, progress: { done: 0, total: null, note: "Waiting for the database's rows" } });
      return { wait: until(ctx) };
    }
    const state = structuredClone(ctx.state);
    if (state.phase === "taking") return waitOrEnd(ctx, "The DB IO job stopped before this preview was done, and its time is up. Preview again.");
    if (state.phase === "failing") throw new StoreError(502, "push_failed", state.failure ?? "The DB IO job could not finish this preview.");
    return { result: state.made ?? (await finishPreview(ctx, state)) };
  },

  async failed(ctx) {
    ctx.tables.abandon(ctx.params.into);
  },
};

export const compareHandler: JobHandler<CompareParams, CompareState, CompareResult> = {
  kind: "compare",
  pastLimit: true,

  parse: (params) => parsed(() => compareParamsOf(params)),

  async run(ctx) {
    if (ctx.state === null) {
      const state: CompareState = { ...startReading(ctx, COMPARED_GROUP, "compare"), listed: 0, onlyInStore: 0, onlyInDatabase: 0, differing: 0, unlisted: 0, made: null };
      ctx.commit({ state, progress: { done: 0, total: null, note: "Waiting for the database's rows" } });
      return { wait: until(ctx) };
    }
    const state = structuredClone(ctx.state);
    if (state.phase === "taking") return waitOrEnd(ctx, "The DB IO job stopped before this compare was done, and its time is up. Compare again.");
    if (state.phase === "failing") throw new StoreError(502, "push_failed", state.failure ?? "The DB IO job could not finish this compare.");
    return { result: state.made ?? (await finishCompare(ctx, state)) };
  },

  async failed(ctx) {
    ctx.tables.abandon(ctx.params.into);
  },
};

export const pushHandler: JobHandler<PushParams, PushState, PushResult> = {
  kind: "push",
  // Its batches are written on the database before the store hears of them: a write that sent all
  // it had still ends past the day's limit, what it did is taken, and its held rows are listed.
  pastLimit: true,

  parse: (params) => parsed(() => pushParamsOf(params)),

  async run(ctx) {
    if (ctx.state === null) {
      const state = startPush(ctx);
      // Nothing to write: it ends here, with its held rows listed (a rehearsal: its manifests, empty).
      if (state.parts.every((part) => part.toWrite === 0)) return finishPush(ctx, { ...state, phase: "finishing" });
      ctx.commit({ state, progress: pushProgress(state, "Waiting for the database") }, () => {
        if (state.oneTransaction) return;
        // A write of one preview takes each batch as its database commits it: the memory and the
        // record become those of the preview's key and columns as the write begins, and what the
        // write is is kept from its start, so an undo takes back what it wrote even when it stops
        // part way.
        keepRecord(ctx.sql, ctx.params.connection.id, state.parts[0]!.target, state.parts[0]!);
        setMeta(ctx.sql, pushWriteKey(ctx.job.id), JSON.stringify(writeRecordOf(ctx, state, new Date(ctx.now()).toISOString(), false)));
      });
      return { wait: until(ctx) };
    }
    const state = structuredClone(pushStateOf(ctx.state, ctx.params));
    if (state.phase === "taking") return waitForWrite(ctx, state);
    if (state.phase === "failing") throw new StoreError(502, "push_failed", state.failure ?? `The DB IO job could not finish this ${state.rehearse ? "rehearsal" : "write"}.`);
    return state.made ? { result: state.made } : finishPush(ctx, state);
  },

  async failed(ctx) {
    const state = ctx.state === null ? null : pushStateOf(ctx.state, ctx.params);
    // Its database committed the whole of it before the job ended: what it did is taken all the same.
    if (state?.phase === "finishing" && state.oneTransaction && !state.rehearse && !state.made) takeAll(ctx, structuredClone(state));
    // A write of one preview that stopped part way keeps what its batches did, which an undo's
    // question counts: one statement, so it needs no transaction of its own.
    else if (state && !state.oneTransaction && getMeta(ctx.sql, pushWriteKey(ctx.job.id)) !== null) keepWriteRecord(ctx, state, new Date(ctx.now()).toISOString());
    forgetPending(ctx.sql, ctx.job.id);
  },
};

export const pushUndoHandler: JobHandler<PushUndoParams, UndoState, PushUndoResult> = {
  kind: "push_undo",
  // Its database commits before the store hears of it: an undo that sent all it had still ends past
  // the day's limit, what it undid is taken, and its held rows are listed.
  pastLimit: true,

  parse: (params) => parsed(() => pushUndoParamsOf(params)),

  async run(ctx) {
    if (ctx.state === null) {
      const state = startUndo(ctx);
      // Nothing to take back (the write wrote nothing an undo can undo): it ends here, the write undone.
      if (state.parts.every((part) => part.toUndo === 0)) return finishUndo(ctx, { ...state, phase: "finishing" });
      ctx.commit({ state, progress: undoProgress(state, "Waiting for the database") });
      return { wait: until(ctx) };
    }
    const state = structuredClone(ctx.state);
    if (state.phase === "taking") {
      if (!state.begun) return waitOrEnd(ctx, "No DB IO job undid this write before its time was up. Undo it again.");
      return waitOrEnd(ctx, "The DB IO job stopped before it said its database committed this undo, and its time is up. Undo it again.", {
        gaveWay: "This undo stopped before its DB IO job said its database committed it, and no DB IO job came back for it, so it ended when another job needed the store. Undo it again.",
      });
    }
    if (state.phase === "failing") throw new StoreError(502, "push_failed", state.failure ?? "The DB IO job could not finish this undo.");
    return state.made ? { result: state.made } : finishUndo(ctx, state);
  },

  async failed(ctx) {
    const state = ctx.state;
    // Its database committed the undo before the job ended: what it undid is taken all the same.
    if (state?.phase === "finishing" && !state.made) takeAllUndone(ctx, structuredClone(state));
    forgetPending(ctx.sql, ctx.job.id);
  },
};
