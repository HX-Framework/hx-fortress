// Jobs: long work inside a store (LOAD, SHAPE, and later CLASSIFY and the rest). A job is a row in
// `_jobs`, made once per request key: a replayed request answers the job it made. One job runs at
// a time per store, in chunks of at most JOB_CHUNK_MS between the object's alarms, and each chunk
// commits its writes and the job's progress in one transaction, so a crash resumes at the last
// chunk that committed.
//
// A handler registers by kind in store/jobs/index.ts. It reads its parameters, does one chunk of work,
// and calls `commit` with what it wrote; it answers `{ more: true }` to be woken for the next
// chunk, or `{ result }` when the job is done. It never waits past `deadline`, which ends early once
// the store's writes today reach its daily limit: the job then waits, and its next chunk goes on
// from its last commit.

import type { RowCounts, TableDelta } from "../../../store-readers/src/jobs.js";
import type { RowKeys } from "../deltas.js";
import type { SqlLike } from "../sql.js";
import type { JobEstimate, JobProgress, TableHandle } from "../types.js";
import type { StoreFiles } from "../store-files.js";

/** The most time one chunk may take before it commits and yields to the next alarm. */
export const JOB_CHUNK_MS = 20_000;

/** A job's parameters were not what its handler takes: the submit is refused with these words. */
export class JobParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobParamsError";
  }
}

/** A file of the store, as a job reads it. */
export interface JobFile {
  id: string;
  name: string;
  size: number;
  contentType: string;
}

export interface JobFiles {
  /** A ready file of this store, or null. */
  get(fileId: string): JobFile | null;
  /** Bytes of a file: `length` bytes from `offset` (fewer at its end). */
  read(fileId: string, offset: number, length: number): Promise<Uint8Array>;
}

export interface ProgramTableMadeBy {
  runId: string | null;
  step: string | null;
}

export interface ProgramTableColumn {
  name: string;
  /** The type the town's file or database gave it: "Date/Time", "N(10,2)". */
  originalType?: string;
  comment?: string;
  /** A file's column LOAD packed into `_extra`, past the table's own: SQL reads it by its name (front-door.ts). */
  packed?: true;
}

/** A table a step committed or changed, and the change the store recorded for it (null: nothing changed). */
export interface CommittedTable extends TableHandle {
  delta: TableDelta | null;
}

/**
 * A step that makes a table anew writes `<name>__new` (what `begin` answers), then `commit` swaps
 * it in, in one transaction: the current table becomes `<name>__v<n>` (dropped with `dropOld`),
 * older versions are dropped, and the new version is recorded in `_tables`, `_columns`, `_history`
 * and the store's deltas. A step that changes some rows writes them in place with `changed`. SQL
 * always reads the plain name.
 */
export interface ProgramTables {
  /** The name to write the new version under. Drops a leftover `<name>__new`. Refuses a name a
   *  managed or system table holds. */
  begin(name: string): string;
  /**
   * Swaps `<name>__new` in as the newest version. `dropOld` drops the version it replaces instead of
   * keeping it as `<name>__v<n>`: a store keeps one working copy of what a step remakes. `keep`
   * refuses a new version without a column it names (an app on the store reads it). `delta: "load"`
   * records the rows added, changed and removed by comparing each row's `_key` and `_hash` with the
   * store's memory of the last load; otherwise the change is recorded whole. `wholeChange` records
   * a LOAD's change whole while it brings the memory up to date (a reload fell back to the whole
   * table, part of it already in the memory). `keyFrom` names the column `_key` was taken from.
   */
  commit(
    name: string,
    opts: {
      group?: string | null;
      madeBy: ProgramTableMadeBy;
      columns?: ProgramTableColumn[];
      comment?: string | null;
      keep?: Array<{ column: string; reader: string }>;
      dropOld?: boolean;
      delta?: "whole" | "load";
      wholeChange?: boolean;
      keyFrom?: string | null;
    },
  ): Promise<CommittedTable>;
  /**
   * A step's change to a program table's rows in place: `write`, the person's kept fixes applied
   * again (review.ts `applyFixes`), then the table's row count, what made it, the change and a
   * history event, in one transaction. The version stays. `write` answers the `_key`s it added,
   * changed and removed; `false`, or keys naming no row, when it changed nothing, which records
   * nothing, so a run with nothing new costs no row; `true` or nothing records the change whole.
   */
  changed(name: string, opts: { madeBy: ProgramTableMadeBy; note: ChangeNote }, write: () => RowKeys | boolean | void): Promise<CommittedTable>;
  /** Drops `<name>__new`. */
  abandon(name: string): void;
  /** A bookmark of this moment, for a history event's "Restore to Here"; null where the platform keeps none. */
  bookmark(): Promise<string | null>;
  /**
   * Swaps a parked table's rows, brought back into `<name>__new`, in as `<name>` with the version it
   * had, inside the caller's transaction: its rows did not change, so no change is recorded.
   */
  swapBack(name: string, note: string): void;
  /**
   * Parks `<name>`, inside the caller's transaction: records its files (unless `reused`, the files
   * of an earlier park of the same rows), marks it parked, drops it from the database with the
   * program views set aside, and writes `note` to its history.
   */
  park(name: string, files: ParkedFilesRecord, note: string): void;
  /** Gives LOAD tables a step read their time to park (park.ts), unless they are parked already. */
  parkLater(names: readonly string[]): void;
  /** Takes back a table's time to park: an app on the store reads it. */
  stayInDatabase(name: string): void;
  /**
   * Marks that `reader` (a step, such as `shape:permits_clean`) has read `table` up to change number
   * `change` (deltas.ts `markRead`), inside the caller's transaction: the keys every reader has read go.
   */
  markRead(reader: string, table: string, change: number): void;
  /** Drops `reader`'s marks (deltas.ts `forgetReader`), inside the caller's transaction: a step kept as a view reads no changes. */
  forgetReader(reader: string): void;
  /**
   * A change in place that takes several chunks: `openChange` takes its change number, inside the
   * caller's transaction (the chunk that saves it), recorded whole until `close` records what it
   * added, changed and removed, so a reader never takes a part of it for all of it. `keys` adds the
   * `_key`s of one chunk's rows, inside that chunk's transaction. The job takes its restore point
   * (`bookmark`) before it opens the change, and keeps it until `close`. A parked table changes too
   * (a LOAD of its file writes its new files, `reparked`); `close` then takes its row count from
   * them. `whole` records the change whole: most of the table changed, and a reader takes all of it.
   */
  openChange(name: string): number;
  keys(name: string, change: number, keys: RowKeys): void;
  close(name: string, change: number, opts: { madeBy: ProgramTableMadeBy; note: ChangeNote; restorePoint: string | null; whole?: boolean }): CommittedTable;
  /**
   * A parked table's rows, written anew as `files` by a LOAD of its file, inside the caller's
   * transaction: they replace the files before, which go once the restore window has passed, and
   * the table stays parked with their row count.
   */
  reparked(name: string, files: Omit<ParkedFilesRecord, "reused">): void;
  /** The catalog's words for a table's columns, inside the caller's transaction: writes only those that differ. */
  describe(name: string, columns: readonly ProgramTableColumn[]): void;
  /**
   * Makes `<name>` a program view of `select` (a SHAPE's "Ready" view), in one transaction: a view of
   * that name is replaced, and a program table of that name is kept as its last version. A view
   * keeps no rows, so no change is recorded; its version counts each time it is made.
   */
  makeView(name: string, select: string, opts: { group: string; madeBy: ProgramTableMadeBy; comment?: string | null; keep?: Array<{ column: string; reader: string }> }): Promise<TableHandle>;
}

/** Where a parked table's rows are: its files in the store's bucket, and what they hold (`_parked`). */
export interface ParkedFilesRecord {
  id: string;
  version: number;
  /** The table's change number when it was parked: the files serve again while it stays the same. */
  change: number;
  prefix: string;
  columns: { name: string; type: string; notnull: boolean }[];
  rows: number;
  bytes: number;
  parts: number;
  /** The files of an earlier park of these same rows, already recorded. */
  reused: boolean;
}

/** A history event's words for a change, or a function of what it added, changed and removed. */
export type ChangeNote = string | ((counts: RowCounts) => string);

export interface JobContext<P, S> {
  readonly job: { id: string; kind: string; requestKey: string; by: string; storeId: string };
  readonly params: P;
  /** What the last committed chunk left; null on the first chunk. */
  readonly state: S | null;
  readonly sql: SqlLike;
  readonly files: JobFiles;
  readonly tables: ProgramTables;
  /** The bucket the store's files are in, for a job that writes there itself (a park, an export, an import). */
  readonly bucket: StoreFiles;
  /** The store's database size in bytes, as the platform counts it. */
  databaseSize(): number;
  /**
   * Epoch ms by which this chunk commits and returns. It is 0 once today's writes reach the store's
   * daily limit: a handler that checks it between commits stops at its next one, and its job waits
   * for the next UTC day with all it committed (runner.ts).
   */
  readonly deadline: number;
  now(): number;
  /** The chunk's writes, its new state and its progress, in one transaction. */
  commit(update: { state: S; progress: JobProgress }, write?: () => void): void;
}

/**
 * What a chunk answers: run the next chunk at once, or `after` ms later for a job that waits on
 * something; the job's result; or `wait`, nothing to do until this time (epoch ms) unless a call
 * wakes the job sooner. A job fed from outside (a pull takes its pages through calls) sleeps with
 * no alarm running until then.
 */
export type JobOutcome<R> = { more: true; after?: number } | { result: R } | { wait: number };

/** What the store already knows, as an estimate reads it: nothing here writes. */
export interface JobEstimateView {
  /** A ready file of the store: its name and size; null for none. */
  file(fileId: string): { name: string; size: number } | null;
  /** The rows a table of the store holds; null when it has no such table. */
  tableRows(name: string): number | null;
  /** The first `bytes` bytes of a ready file of the store (one read of its bucket). */
  sample(fileId: string, bytes: number): Promise<Uint8Array>;
}

export interface JobHandler<P = unknown, S = unknown, R = unknown> {
  kind: string;
  /** Checks a submit's parameters; throws JobParamsError with plain words when they are wrong. */
  parse(params: unknown): P;
  /** One chunk of work. */
  run(ctx: JobContext<P, S>): Promise<JobOutcome<R>>;
  /** After the job failed: undoes what its chunks left behind. Its own failure is only logged. */
  failed?(ctx: JobContext<P, S>, error: string): Promise<void>;
  /** The job runs past the day's write limit: it writes only a few records of its own (an export). */
  pastLimit?: boolean;
  /**
   * The rows a new job is about to write, said when it is submitted, before its first write: the
   * store keeps it on the job and logs it with its cost (runner.ts). Cheap: it reads what the store
   * knows, and at most the first bytes of a file. A kind without one may have a default in
   * jobs/estimates.ts; else the job has none.
   */
  estimate?(params: P, view: JobEstimateView): JobEstimate | null | Promise<JobEstimate | null>;
}
