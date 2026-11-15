// PUSH and COMPARE as the api, a store's object and DB IO all see them (DB Connect, F3):
// a store's table written into a database's table, and the two compared, by key. db_push_preview,
// db_push and db_compare (the api's agent/tools/databases.ts) submit a store job; a
// DB IO job (DB IO, a Go program: apps/db-io/internal/push) then reads the store's rows and the
// database's, through the gateway with a key good for that one job, as a pull does
// (`store-readers/pull`); the store's object (packages/store-object/src/jobs/push.ts) keeps
// what it is sent. The api never carries a row: its tools answer counts and table handles.
//
// A write is two jobs, a preview and then the write of exactly that preview.
//
//   push_preview  The runner reads the store's table (`source`) and, by key, the database's rows it
//                 would touch, and sends the store one row for each key where something would
//                 happen: `new`, `changed`, `removed` or `held`. The store keeps them as a table of
//                 its own (group "Previews"): each with what the database holds now and what it
//                 would hold, and the machine's copy of the values to write. A row that would stay
//                 as it is never leaves the runner. The job's DB IO job uses the connection's READ
//                 login: it reads the database and writes nothing there.
//   push          The runner reads the preview's rows to write, a batch at a time, and writes each
//                 batch in one transaction on the database: it reads the batch's rows by key with
//                 locks, writes the ones that still hold what the preview read, reads them back,
//                 commits, and tells the store how each row ended. The store keeps, for each row it
//                 wrote, a hash of what it sent and a hash of what the database held after it (its
//                 memory, `_pushed`), and at the end a table of the rows held (group "To review").
//                 Its DB IO job uses the WRITE login.
//   compare       The runner reads the store's table and, by key, the database's rows for the same
//                 keys and the keys this store wrote, and sends the store one row for each key that
//                 differs. The store keeps them as a table (group "Comparisons"). READ login.
//
// The memory is how a write knows a row someone changed in the database since our last write: a row
// whose hash in the database is neither what our last write left there nor what we would write now
// is held, never overwritten (or removed). A preview that finds a row already holding the values it
// would write takes it into the memory as it is (`adopt`), so a later edit there is seen too; a key
// of the memory that neither the store's table nor the database holds any more is forgotten. The
// memory knows the rows this store put there (inserted, `put`): only those are ever `removed`, and
// only by a preview asked to (`removes`), so a table written a part at a time never removes the rest.
// The memory and who wrote (`PushRecord`) are of one key and one set of columns: a preview of others
// reads none, and its write starts them anew.
//
// A batch is written once: the store takes each batch's outcomes as one numbered page, and keeps the
// last key it took as the cursor the next batch is read after. A DB IO job that stops between its
// commit on the database and the store's record of the batch leaves the store's cursor where it was:
// its successor reads the same batch again, finds its rows already holding their new values, and
// counts them as written. No table of ours goes into the customer's database.
//
// A row is named (`_key`) by the key columns' values as the store holds them: one column's value as
// text, or the values of several as a JSON array of text, as a pull names its rows. `_hash` is a
// 64-bit hash of a row's values as text, in the order of the job's `columns` (the runner's
// RowHash64, the store's `rowHash`): the store's values hash as the store holds them, the
// database's as the runner reads them (engine.Text), so the two never meet in one hash. Which values
// are the same across the two sides is the runner's to say: it compares them as the database's
// column types read them (a number as a number, a date as a date).
//
// No import beyond names.ts, jobs.ts and pull.ts, so the store's object reads this file as it reads
// jobs.ts.

import { tableSlug } from "./names.js";
import { madeByOf, type MadeBy, MAX_TABLE_NAME, REVIEW_GROUP, TABLE_NAME_RE } from "./jobs.js";
import { pullFailOf, type PullConnection, type PullFailBody, PullShapeError } from "./pull.js";

export { pullFailOf as rowsFailOf, PullShapeError as PushShapeError, type PullFailBody as RowsFailBody };

/** The group a preview's table is in on the store's page. */
export const PREVIEW_GROUP = "Previews";
/** The group a rehearsal's manifest is in: what a write did inside a transaction it rolled back. */
export const REHEARSAL_GROUP = "Rehearsals";
/** At most this many links a preview counts. */
export const LINKS_MAX = 8;
/** At most this many previews one write writes, in one transaction. */
export const PUSH_PREVIEWS_MAX = 8;
/** The group a compare's table is in. */
export const COMPARED_GROUP = "Comparisons";
/** The group a push's held rows are in: rows a person looks at before the next write. */
export const HELD_GROUP = REVIEW_GROUP;

/** A batch: the rows one transaction on the database reads, checks and writes. */
export const PUSH_BATCH_ROWS = 500;
/** The most rows one read of the store's side answers. */
export const ROWS_READ_MAX = 1_000;
/** The most rows one page from the runner holds, and about how many bytes of JSON. */
export const ROWS_SEND_MAX = 2_000;
export const ROWS_SEND_BYTES = 1_500_000;
/** The most differences a compare keeps as rows of its table; the rest are counted. */
export const COMPARE_ROWS_MAX = 100_000;
/** The most columns a push or a compare reads: a database's table has at most 1,024 (SQL Server). */
export const PUSH_COLUMNS_MAX = 1_024;
/** The most columns a key has. */
export const PUSH_KEY_MAX = 16;

/** A table of a database, as its catalog names it. */
export interface DatabaseTableRef {
  /** The schema (SQL Server, Postgres), owner (Oracle) or database (MySQL) it is in. */
  schema: string;
  name: string;
}

/** `schema.name`, as the connection's catalog and a person write it. */
export const tableRefText = (t: DatabaseTableRef): string => `${t.schema}.${t.name}`;

/**
 * What a write does with a row someone changed in the database since our last write.
 *   hold       it is not written, and waits for a person in the store's To review (the default)
 *   overwrite  it is written as any other row
 */
export type TheirEdits = "hold" | "overwrite";

/**
 * Who writes, for the first-write rule: `program:<id>@<version>` for a Human Program's version, or
 * `user:<id>` for a person in a chat or over MCP. The first write of each into each table asks a
 * person.
 */
export type PushWriter = string;

/**
 * A link: a column of the write whose value names a row of another table of the same database by one of
 * its columns, with no foreign key to say so. A preview counts the rows whose link finds no row.
 */
export interface LinkSpec {
  /** The write's column, as the database's table names it. */
  column: string;
  /** The table and the column its value names a row by. */
  to: DatabaseTableRef & { column: string };
}

/** How a preview's rows to write fare against one link: counts only. */
export interface LinkCount {
  column: string;
  /** `schema.table.column` */
  to: string;
  /** Rows whose value finds a row there. */
  linked: number;
  /** Rows whose value finds none: the write cannot make their link. */
  unlinked: number;
  /** Rows with no value (NULL or empty). */
  empty: number;
  /**
   * Rows whose value finds no row there, but names a row that the store's newest preview of that
   * table adds: written together with it, they find their row. Counted apart, and left out of
   * `unlinked`. The store counts them, not the DB IO job; missing where none was found.
   */
  added?: number;
}

export interface PushPreviewParams {
  connection: PullConnection;
  /** The store's table or view whose rows would be written. */
  source: string;
  target: DatabaseTableRef;
  /** The key's columns as the database's table names them; empty: its primary key. */
  key: string[];
  /** The preview's table in the store. */
  into: string;
  theirEdits: TheirEdits;
  /**
   * Also remove the rows this store put there (inserted) that its table no longer holds. Off unless
   * asked: a program that writes a table a week, or a part of a table, must not remove the rest.
   */
  removes: boolean;
  /** The links whose rows it counts; none when asked for none. */
  links: LinkSpec[];
  writer: PushWriter;
  madeBy: MadeBy;
}

/** A preview as a write names it: exactly this version of it. */
export interface PreviewRef {
  table: string;
  version: number;
}

export interface PushParams {
  connection: PullConnection;
  /** The preview as its handle names it: exactly this version of it is written. */
  preview: PreviewRef;
  /**
   * The other previews of a write of several tables, after `preview`: all of them are written in one
   * transaction, their new and changed rows in this order, then their removed rows in the reverse one.
   */
  also: PreviewRef[];
  /** Write for real in one transaction, then roll it back: nothing stays; the store keeps a manifest. */
  rehearse: boolean;
  writer: PushWriter;
  madeBy: MadeBy;
}

/** An undo of one write: the rows it inserted removed, the rows it changed put back, while they still hold what it left. */
export interface PushUndoParams {
  connection: PullConnection;
  /** The id of the push job whose write is undone. */
  write: string;
  writer: PushWriter;
  madeBy: MadeBy;
}

export interface CompareParams {
  connection: PullConnection;
  /** The store's table or view to compare. */
  source: string;
  target: DatabaseTableRef;
  /** The key's columns as the database's table names them; empty: its primary key. */
  key: string[];
  /** The compare's table in the store. */
  into: string;
  madeBy: MadeBy;
}

/** What a preview found, as its job answers it: the preview table's handle, and its counts. */
export interface PushPreviewResult {
  table: string;
  version: number;
  /** Rows of the preview table: one for each key where something would happen. */
  rows: number;
  source: string;
  /** The database's table, `schema.name`. */
  target: string;
  key: string[];
  /** The columns a write would write, as the database's table names them. */
  columns: string[];
  inserts: number;
  updates: number;
  deletes: number;
  held: number;
  /** Rows the database already holds as the store does: nothing to write. */
  unchanged: number;
  /** Rows of the database's table when the preview read it. */
  targetRows: number;
  /** The part of the database's table the write would change, 0 to 1 (1 for an empty table it fills). */
  share: number;
  /** No earlier write by this writer into this table from this store: the write asks a person first. */
  first: boolean;
  /** Columns of the store's table the database's table has not: never written. */
  ignored: string[];
  /** Each link asked for, with how the rows to write fare against it. */
  links: LinkCount[];
}

/** A preview as the store keeps it, under `previewKey(table)`: what a push of it reads. */
export interface SavedPreview extends PushPreviewResult {
  connection: PullConnection;
  targetRef: DatabaseTableRef;
  theirEdits: TheirEdits;
  removes: boolean;
  writer: PushWriter;
  at: string;
}

/** Where a store keeps what its newest preview in `table` holds (`_meta`). */
export const previewKey = (table: string): string => `push-preview:${table}`;

/** What a write did to one database's table, as its job answers it. */
export interface PushPartResult {
  preview: PreviewRef;
  target: string;
  inserted: number;
  updated: number;
  deleted: number;
  held: number;
  /** This table's held rows in the store (To review); null when none was held. */
  heldTable: { table: string; version: number; rows: number } | null;
}

/** What a write did, as its job answers it. */
export interface PushResult {
  /** This write's id (its job's): what an undo names. */
  write: string;
  /** A rehearsal: written in one transaction and rolled back; nothing stayed. */
  rehearsed: boolean;
  /** A rehearsal's rows read back after the rollback holding exactly what they held before; null for a write. */
  restored: number | null;
  /** A rehearsal's manifests, one per database's table; empty for a write. */
  manifest: { table: string; version: number; rows: number }[];
  /** Each preview's part of the write, in the order written. Totals are below. */
  parts: PushPartResult[];
  preview: PreviewRef;
  target: string;
  inserted: number;
  updated: number;
  deleted: number;
  /** Rows not written: held at the preview, and rows the database changed after it. */
  held: number;
  /** Of `held`, the rows the database changed between the preview and the write. */
  heldSince: number;
  batches: number;
  /** The held rows' table in the store (To review); null when no row was held. */
  heldTable: { table: string; version: number; rows: number } | null;
}

/** What an undo did, as its job answers it. */
export interface PushUndoResult {
  /** The write undone. */
  write: string;
  /** Its first database's table, `schema.name`. */
  target: string;
  /** Rows the write inserted, removed again. */
  removed: number;
  /** Rows the write changed, put back to what they held before it. */
  putBack: number;
  /** Rows the write removed, inserted again. */
  reinserted: number;
  /** Rows changed in the database since the write: not undone. */
  held: number;
  /** The held rows' table in the store (To review); null when none was held. */
  heldTable: { table: string; version: number; rows: number } | null;
  parts: { target: string; removed: number; putBack: number; reinserted: number; held: number; heldTable: { table: string; version: number; rows: number } | null }[];
}

/** What a compare found, as its job answers it. */
export interface CompareResult {
  table: string;
  version: number;
  /** Rows of the compare's table: one for each key that differs, up to COMPARE_ROWS_MAX. */
  rows: number;
  source: string;
  target: string;
  key: string[];
  columns: string[];
  /** Rows of the store's table. */
  storeRows: number;
  /** Rows of the database's table. */
  databaseRows: number;
  /** Keys whose rows hold the same values on both sides. */
  matching: number;
  /** Keys the store holds and the database does not. */
  onlyInStore: number;
  /** Keys this store wrote into the database that its table no longer holds. */
  onlyInDatabase: number;
  /** Keys both hold, with values that differ. */
  differing: number;
  /** Rows of the database's table this store neither holds nor wrote: counted, never read into it. */
  otherRows: number;
  /** Differences past COMPARE_ROWS_MAX: counted, not kept. */
  unlisted: number;
}

// ─── the store's memory of what it wrote ──────────────────────────────────────────────────────

/** How the store names a database's table in its memory (`_pushed.target`) and records. */
export const pushTargetId = (connectionId: string, target: DatabaseTableRef): string => JSON.stringify([connectionId, target.schema, target.name]);

/** Where a store keeps what it knows of its writes into a database's table (`_meta`). */
export const pushRecordKey = (connectionId: string, target: DatabaseTableRef): string => `push:${pushTargetId(connectionId, target)}`;

/**
 * What a store keeps of its writes into one database's table. Its memory's hashes are of `columns`,
 * keyed by `key`: a preview that begins with other columns or another key forgets the memory and
 * the writers, so its first write asks again.
 */
export interface PushRecord {
  key: string[];
  columns: string[];
  /** Each writer that wrote into the table, and when it first did. */
  writers: Record<PushWriter, string>;
  last: { at: string; by: string; preview: { table: string; version: number }; inserted: number; updated: number; deleted: number; held: number } | null;
}

/** Where a store keeps what one write was: its connection, its parts, and whether an undo undid it (`_meta`). */
export const pushWriteKey = (job: string): string => `push-write:${job}`;

export interface PushWriteRecord {
  connection: PullConnection;
  /**
   * Each table of the write, with the rows an undo takes back there, by what the write did to them
   * (`inserted`, `updated`, `deleted`: its record's rows with a `did`), and the rows it held: 0 until
   * the write ends, and for a rehearsal.
   */
  parts: {
    preview: PreviewRef;
    target: DatabaseTableRef;
    key: string[];
    columns: string[];
    inserted: number;
    updated: number;
    deleted: number;
    held: number;
    /** The links its preview counted to another table of this write: an undo holds the rows they join together. */
    links?: LinkSpec[];
  }[];
  at: string;
  by: string;
  rehearse: boolean;
  /**
   * The write ended: done, or failed with what its database committed kept. False while it runs or
   * waits for a DB IO job: its counts are not known yet, and an undo is not asked for.
   */
  ended: boolean;
  /** When an undo undid it; null while it stands. */
  undone: string | null;
}

// ─── the wire: the runner and the store's object ─────────────────────────────────────────────
// Every call carries the job's key in its authorization header, as a pull's pages do, and the store
// checks it against the one it gave last: a newer DB IO job's key makes an older one's refused.

export type RowsJobKind = "push_preview" | "push" | "compare" | "push_undo";
export const ROWS_JOB_KINDS: readonly RowsJobKind[] = ["push_preview", "push", "compare", "push_undo"];

/** One database's table a job works on: a write's preview, an undo's part of its write. */
export interface RowsPart {
  target: DatabaseTableRef;
  key: string[];
  columns: string[];
  /**
   * An undo's: the links this part's preview counted to another table of the same write, as the
   * write kept them. The undo holds with each row it holds every row they join to it.
   */
  links?: LinkSpec[];
}

/** `GET …/rows`: where the job stands, and what its DB IO job does. */
export interface RowsState {
  kind: RowsJobKind;
  /**
   * waiting    the store runs another job first
   * taking     the store takes the DB IO job's calls
   * finishing  the DB IO job ended its part; the store is making its tables
   * done, failed
   */
  state: "waiting" | "taking" | "finishing" | "done" | "failed";
  error: string | null;
  target: DatabaseTableRef;
  /**
   * The key the job was asked for, as the database's table names it (empty before a preview or a
   * compare begins when it was asked for none: the table's primary key); a push's is its preview's.
   */
  key: string[];
  /** The columns, as the database's table names them, in its order: a push's, or once begun. */
  columns: string[];
  /** A preview's: what it does with a row someone changed in the database since our last write. */
  theirEdits: TheirEdits;
  /** A preview's: whether it removes the rows this store put there that its table no longer holds. */
  removes: boolean;
  /** A preview or a compare has begun: a successor begins again. */
  begun: boolean;
  /** The last page the store took. */
  page: number;
  /** A push's: the last key of the last batch the store took; the next batch is read after it. */
  cursor: string | null;
  /**
   * A write of several previews, a rehearsal and an undo: the whole of it in one transaction, begun
   * again by each DB IO job (`rows/begin` with `again`), and taken by the store only at its end.
   */
  oneTransaction: boolean;
  /** A rehearsal: roll the transaction back. */
  rehearse: boolean;
  /** Each table the job works on, in write order; `target`, `key` and `columns` above are the first's. */
  parts: RowsPart[];
  /** A preview's links to count. */
  links: LinkSpec[];
  limits: { readRows: number; sendRows: number; sendBytes: number; batchRows: number };
}

export const ROWS_LIMITS: RowsState["limits"] = {
  readRows: ROWS_READ_MAX,
  sendRows: ROWS_SEND_MAX,
  sendBytes: ROWS_SEND_BYTES,
  batchRows: PUSH_BATCH_ROWS,
};

/** A column of the database's table, as the runner read it just now. */
export interface RowsColumn {
  name: string;
  /** The engine's type with its size: "varchar(50)", "decimal(10,2)". */
  type: string;
  /** NOT NULL with no default, and neither an identity nor computed: a new row needs a value. */
  required: boolean;
}

/**
 * `POST …/rows/begin` (a preview, a compare): the database's table as the runner read it. The store
 * matches its table's columns to the database's by name, each without regard to case, and answers
 * what the job reads and writes. A successor's begin starts the job's work over.
 */
export interface RowsBeginBody {
  columns: RowsColumn[];
  /** The table's primary key in key order; empty for none. */
  primaryKey: string[];
}

/** `POST …/rows/begin` of a one-transaction write or an undo: the store forgets what it took of this job. */
export interface RowsBeginAgainBody {
  again: true;
}

export interface RowsBeginAnswer {
  /** The columns both sides have, as the database's table names them, in its order. */
  columns: string[];
  /** The key, as the database's table names it: the one asked for, else its primary key. */
  key: string[];
  /** Required columns of the database's table that the store's table does not fill. */
  missing: string[];
  /** Rows of the store's table. */
  rows: number;
}

/**
 * `POST …/rows/read`: rows the store holds for the job, after `after` (null to start).
 *   memory  a preview's or a compare's: what this store last wrote into the database's table, as
 *           `[key, sent, held]`: the hash of what it sent, and of what the database held after.
 *   source  a preview's or a compare's: the store's table's rows, as their values in `columns`
 *           order, each as text or null (`[v1, …, vn]`).
 *   write   a push's: the preview's rows to write, as `WriteRow`s, in `_key` order.
 */
export interface RowsReadBody {
  /**
   *   undo    an undo's: the rows its write wrote into `table`, as `UndoRow`s, in `_key` order.
   */
  part: "memory" | "source" | "write" | "undo";
  after: string | null;
  limit?: number;
  /** A write's or an undo's part: which of its tables (default 0). */
  table?: number;
  /**
   * A one-transaction write's rows of one kind: its new and changed rows (puts), or its removed ones
   * (removals). An undo's likewise: the rows its write inserted or updated, or the ones it removed.
   */
  only?: "puts" | "removals";
}

export interface RowsReadAnswer {
  rows: unknown[];
  /** The `after` of the next read; null after the last. */
  next: string | null;
}

/** A row a push writes, as the preview found it. */
export interface WriteRow {
  key: string;
  action: "new" | "changed" | "removed";
  /** The hash of what the database held at the preview; null for a new row. */
  now: string | null;
  /** The values to write, in `columns` order; null for a removed row. */
  values: (string | null)[] | null;
  /** The columns a changed row changes; null for any other. */
  changed: string[] | null;
}

/**
 * Why a row is held, as the runner names it; the store words it.
 *   changed_there   the database changed it since our last write
 *   removed_there   the database removed it since our last write
 *   appeared        a new row's key is in the database since the preview
 *   since_preview   the database changed or removed it after the preview read it
 */
export type HeldWhy = "changed_there" | "removed_there" | "appeared" | "since_preview";
export const HELD_WHYS: readonly HeldWhy[] = ["changed_there", "removed_there", "appeared", "since_preview"];

/** A row an undo reads: what its write did there. */
export interface UndoRow {
  key: string;
  did: "inserted" | "updated" | "deleted";
  /** inserted and updated: the hash of what the database held right after the write. */
  held: string | null;
  /** updated: the columns it set. */
  set: string[] | null;
  /** updated and deleted: the database's values before the write, in the part's `columns` order. */
  before: (string | null)[] | null;
  /**
   * inserted and deleted: the hash of the table's other columns (those the write does not write)
   * right after the insert, or right before the delete; null when the table had none.
   */
  whole: string | null;
}

/**
 * Why an undo held a row, as the runner names it; the store words it.
 *   changed    the database changed it since the write
 *   columns    its other columns held values when the write removed it, or its table needs a value in
 *              a column the write did not write: an undo cannot put it back whole
 *   too_long   it holds a value too long to have been kept
 *   together   a link of the write joins it to a row the undo holds: rows written to name each other
 *              stay together
 */
export type UndoHeldWhy = "changed" | "columns" | "too_long" | "together";
export const UNDO_HELD_WHYS: readonly UndoHeldWhy[] = ["changed", "columns", "too_long", "together"];

/** How one row of an undo ended. */
export interface UndoneRow {
  key: string;
  /** undone: removed, put back or inserted again (or found so already); held: untouched, for `why`. */
  outcome: "undone" | "held";
  /** held: why (a runner from before it named one: changed). */
  why?: UndoHeldWhy;
}

/** A row a preview sends. */
export interface PreviewRow {
  key: string;
  /**
   * new, changed, removed  what the write would do
   * held                   not written: someone changed it in the database since our last write
   * adopt                  the database already holds the values: the memory takes it as written
   * forget                 neither side holds it any more: the memory lets it go
   */
  action: "new" | "changed" | "removed" | "held" | "adopt" | "forget";
  /** The hash of what the database holds now; null when it holds no row. */
  now: string | null;
  /** The hash of the store's values; null when the store's table holds no row. */
  will: string | null;
  /** A held row's reason. */
  why: HeldWhy | null;
  /** The columns whose values differ, for changed and held rows. */
  changed: string[] | null;
  /** What the database holds now, in `columns` order; null when it holds no row (or for adopt and forget). */
  before: (string | null)[] | null;
  /** The store's values, in `columns` order; null when the store's table holds no row (or for adopt and forget). */
  after: (string | null)[] | null;
  /** A row to write whose links find no row: the link columns. */
  unlinked: string[] | null;
}

/** A row a compare sends: a key whose rows differ. */
export interface CompareRow {
  key: string;
  difference: "store_only" | "database_only" | "differs";
  /** The columns whose values differ, for `differs`. */
  columns: string[] | null;
  /** The store's values in `columns` order; null when it holds no row. */
  store: (string | null)[] | null;
  /** The database's values in `columns` order; null when it holds no row. */
  database: (string | null)[] | null;
}

/** How one row of a push's batch ended on the database. */
export interface WrittenRow {
  key: string;
  /** written: inserted or updated (or held its new values already); removed: deleted (or gone already); held: not written. */
  outcome: "written" | "removed" | "held";
  /** written: the hash of the values sent. */
  sent: string | null;
  /** written: the hash of what the database holds after the write, read back in its transaction. */
  held: string | null;
  /** held: why. */
  why: HeldWhy | null;
  /** written: whether the write inserted the row or updated it (null for one that held its new values already). */
  did: "inserted" | "updated" | null;
  /** written by an update: the columns it set. */
  set: string[] | null;
  /** updated and removed: the database's row before the write, in `columns` order. */
  before: (string | null)[] | null;
  /** A rehearsal's written rows: the database's row as the write left it in its transaction. */
  after: (string | null)[] | null;
  /**
   * inserted and removed: the hash of the table's other columns (those the write does not write) right
   * after the insert, or right before the delete, for an undo; absent when the table has none, and in
   * a rehearsal.
   */
  whole?: string | null;
}

/** `POST …/rows/send`: the runner's rows for the store: a preview's, a compare's, or a push batch's outcomes. */
export interface RowsSendBody {
  /** The next page: the last one taken, plus one. A push sends one page a batch. */
  page: number;
  rows: unknown[];
  /** A push's batch: its last key, the cursor the next batch is read after. */
  last?: string;
  /** A write's or an undo's part the rows are of (default 0). */
  table?: number;
}

export interface RowsSendAnswer {
  page: number;
  /** False when this page was taken before: nothing was written again. */
  taken: boolean;
}

/** `POST …/rows/end`: the runner's part is done. */
export interface RowsEndBody {
  /** A preview's or a compare's: rows of the store's table it read. */
  read?: number;
  /** A preview's or a compare's: rows of the database's table. */
  targetRows?: number;
  /** A preview's: keys whose rows the database already holds as the store does. A compare's: matching. */
  same?: number;
  /** A compare's: rows of the database's table this store neither holds nor wrote. */
  otherRows?: number;
  /** A push's: batches written. */
  batches?: number;
  /** A one-transaction write's or an undo's: the database committed it. */
  committed?: boolean;
  /** A rehearsal's: the database rolled it back. */
  rolledBack?: boolean;
  /** A rehearsal's: rows read back after the rollback holding exactly what they held before. */
  restored?: number;
  /** A preview's: each link's counts. */
  links?: LinkCount[];
}

export interface RowsEndAnswer {
  finishing: boolean;
}

// ─── checking what comes in ───────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{16}$/.test(v);
const hashOrNull = (v: unknown): v is string | null => v === null || hash(v);

/** A store's name for a table a push or a compare makes: as SHAPE's are. */
function tableNameOk(name: unknown): name is string {
  return typeof name === "string" && TABLE_NAME_RE.test(name) && !name.startsWith("sqlite_") && !name.includes("__");
}

/** The store's name for a preview or a compare of a database's table: `push_preview_permits`, `compare_permits`. */
export function previewTableName(target: DatabaseTableRef): string {
  return tableSlug(`push_preview_${target.name}`, "push_preview").slice(0, MAX_TABLE_NAME).replace(/_+$/, "");
}

export function compareTableName(target: DatabaseTableRef): string {
  return tableSlug(`compare_${target.name}`, "compare").slice(0, MAX_TABLE_NAME).replace(/_+$/, "");
}

/** The store's name for a rehearsal's manifest of a database's table: `rehearsal_permits`. */
export function rehearsalTableName(target: DatabaseTableRef): string {
  return tableSlug(`rehearsal_${target.name}`, "rehearsal").slice(0, MAX_TABLE_NAME).replace(/_+$/, "");
}

/** The store's name for an undo's held rows: `undo_held_permits`. */
export function undoHeldTableName(target: DatabaseTableRef): string {
  return tableSlug(`undo_held_${target.name}`, "undo_held").slice(0, MAX_TABLE_NAME).replace(/_+$/, "");
}

/** The store's name for a push's held rows: `push_held_permits`. */
export function heldTableName(preview: string): string {
  const base = preview.startsWith("push_preview_") ? preview.slice("push_preview_".length) : preview;
  return tableSlug(`push_held_${base}`, "push_held").slice(0, MAX_TABLE_NAME).replace(/_+$/, "");
}

function connectionOf(v: unknown, what: string): PullConnection {
  if (!isRecord(v) || !text(v.id, 100) || !text(v.name, 200) || !text(v.engine, 40)) throw new PullShapeError(`${what} names its connection: its id, name and engine.`);
  return { id: v.id, name: v.name, engine: v.engine };
}

function targetOf(v: unknown, what: string): DatabaseTableRef {
  if (!isRecord(v) || !text(v.schema, 256) || !text(v.name, 256)) throw new PullShapeError(`${what} names the database's table: its schema and name.`);
  return { schema: v.schema, name: v.name };
}

function keyOf(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > PUSH_KEY_MAX || !v.every((k) => text(k, 256))) throw new PullShapeError(`${what}'s key names at most ${PUSH_KEY_MAX} columns.`);
  if (new Set(v.map((k: string) => k.toLowerCase())).size !== v.length) throw new PullShapeError(`${what}'s key names each column once.`);
  return [...(v as string[])];
}

function writerOf(v: unknown, what: string): PushWriter {
  if (typeof v !== "string" || !/^(program:[^@\s]{1,100}@\d{1,9}|user:[^\s]{1,100})$/.test(v)) throw new PullShapeError(`${what} names who writes: a program's version or a person.`);
  return v;
}

function madeOf(v: unknown, what: string): MadeBy {
  const madeBy = madeByOf(v);
  if (!madeBy) throw new PullShapeError(`${what}'s madeBy names the run and the step, or nothing.`);
  return madeBy;
}

/**
 * A preview's links, checked against its own table: a link counts rows against the database as it is
 * before the write, so a link to the table the preview writes would count the rows the write itself
 * adds as unlinked; and a row's note names one link a column.
 */
function linksOf(v: unknown, target: DatabaseTableRef): LinkSpec[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > LINKS_MAX) throw new PullShapeError(`A preview counts at most ${LINKS_MAX} links.`);
  const seen = new Set<string>();
  return v.map((l) => {
    if (!isRecord(l) || !text(l.column, 256) || !isRecord(l.to) || !text(l.to.schema, 256) || !text(l.to.name, 256) || !text(l.to.column, 256)) {
      throw new PullShapeError("A link names its column, and the table and column its value names a row by.");
    }
    if (l.to.schema.toLowerCase() === target.schema.toLowerCase() && l.to.name.toLowerCase() === target.name.toLowerCase()) {
      throw new PullShapeError(`A link of ${l.column} names ${target.schema}.${target.name}, the table this preview writes: a link counts rows against the database before the write, so it names another table.`);
    }
    if (seen.has(l.column.toLowerCase())) throw new PullShapeError(`Two links name ${l.column}: a preview counts one link a column.`);
    seen.add(l.column.toLowerCase());
    return { column: l.column, to: { schema: l.to.schema, name: l.to.name, column: l.to.column } };
  });
}

/** A preview job's parameters, checked. */
export function pushPreviewParamsOf(value: unknown): PushPreviewParams {
  if (!isRecord(value)) throw new PullShapeError("A preview takes its store table, the database's table and its connection.");
  if (!text(value.source, 200)) throw new PullShapeError("A preview names the store's table whose rows it would write.");
  if (!tableNameOk(value.into)) throw new PullShapeError(`"${String(value.into)}" cannot name a store's table: use lowercase words joined by single underscores.`);
  const theirEdits = value.theirEdits ?? "hold";
  if (theirEdits !== "hold" && theirEdits !== "overwrite") throw new PullShapeError("theirEdits is hold or overwrite.");
  const removes = value.removes ?? false;
  if (typeof removes !== "boolean") throw new PullShapeError("removes is true or false.");
  const target = targetOf(value.target, "A preview");
  return {
    connection: connectionOf(value.connection, "A preview"),
    source: value.source,
    target,
    key: keyOf(value.key, "A preview"),
    into: value.into,
    theirEdits,
    removes,
    links: linksOf(value.links, target),
    writer: writerOf(value.writer, "A preview"),
    madeBy: madeOf(value.madeBy, "A preview"),
  };
}

function previewRefOf(p: unknown): PreviewRef {
  if (!isRecord(p) || !tableNameOk(p.table) || !count(p.version) || p.version < 1) throw new PullShapeError("A push names each preview: its table and version.");
  return { table: p.table, version: p.version };
}

/** A push job's parameters, checked. */
export function pushParamsOf(value: unknown): PushParams {
  if (!isRecord(value)) throw new PullShapeError("A push takes the preview it writes and its connection.");
  const preview = previewRefOf(value.preview);
  const also = value.also ?? [];
  if (!Array.isArray(also) || also.length > PUSH_PREVIEWS_MAX - 1) throw new PullShapeError(`A write writes at most ${PUSH_PREVIEWS_MAX} previews.`);
  const others = also.map(previewRefOf);
  if (new Set([preview.table, ...others.map((o) => o.table)]).size !== others.length + 1) throw new PullShapeError("A write names each preview once.");
  const rehearse = value.rehearse ?? false;
  if (typeof rehearse !== "boolean") throw new PullShapeError("rehearse is true or false.");
  return {
    connection: connectionOf(value.connection, "A push"),
    preview,
    also: others,
    rehearse,
    writer: writerOf(value.writer, "A push"),
    madeBy: madeOf(value.madeBy, "A push"),
  };
}

/** An undo job's parameters, checked. */
export function pushUndoParamsOf(value: unknown): PushUndoParams {
  if (!isRecord(value)) throw new PullShapeError("An undo takes the write it undoes and its connection.");
  if (!text(value.write, 100)) throw new PullShapeError("An undo names the write it undoes: its id.");
  return {
    connection: connectionOf(value.connection, "An undo"),
    write: value.write,
    writer: writerOf(value.writer, "An undo"),
    madeBy: madeOf(value.madeBy, "An undo"),
  };
}

/** A compare job's parameters, checked. */
export function compareParamsOf(value: unknown): CompareParams {
  if (!isRecord(value)) throw new PullShapeError("A compare takes its store table, the database's table and its connection.");
  if (!text(value.source, 200)) throw new PullShapeError("A compare names the store's table it compares.");
  if (!tableNameOk(value.into)) throw new PullShapeError(`"${String(value.into)}" cannot name a store's table: use lowercase words joined by single underscores.`);
  return {
    connection: connectionOf(value.connection, "A compare"),
    source: value.source,
    target: targetOf(value.target, "A compare"),
    key: keyOf(value.key, "A compare"),
    into: value.into,
    madeBy: madeOf(value.madeBy, "A compare"),
  };
}

/** A begin of a one-transaction write or an undo: it begins again. */
export function rowsBeginAgainOf(value: unknown): RowsBeginAgainBody {
  if (!isRecord(value) || value.again !== true) throw new PullShapeError("A write or an undo begins with { again: true }.");
  return { again: true };
}

export function rowsBeginOf(value: unknown): RowsBeginBody {
  if (!isRecord(value)) throw new PullShapeError("A begin names the database's table's columns and its primary key.");
  if (!Array.isArray(value.columns) || !value.columns.length || value.columns.length > PUSH_COLUMNS_MAX) {
    throw new PullShapeError(`A table has 1 to ${PUSH_COLUMNS_MAX} columns.`);
  }
  const names = new Set<string>();
  const columns = value.columns.map((c) => {
    if (!isRecord(c) || !text(c.name, 256) || typeof c.type !== "string" || c.type.length > 256 || typeof c.required !== "boolean") {
      throw new PullShapeError("Each column names itself, its type and whether a new row needs it.");
    }
    if (names.has(c.name.toLowerCase())) throw new PullShapeError(`The column ${c.name} is named twice.`);
    names.add(c.name.toLowerCase());
    return { name: c.name, type: c.type, required: c.required };
  });
  const primaryKey = value.primaryKey ?? [];
  if (!Array.isArray(primaryKey) || primaryKey.length > 32 || !primaryKey.every((k) => typeof k === "string" && names.has(k.toLowerCase()))) {
    throw new PullShapeError("A primary key names the table's own columns.");
  }
  return { columns, primaryKey: [...(primaryKey as string[])] };
}

export function rowsReadOf(value: unknown, kind: RowsJobKind): RowsReadBody {
  if (!isRecord(value)) throw new PullShapeError("A read names its part and where it starts.");
  const part = value.part;
  const parts: RowsReadBody["part"][] = kind === "push" ? ["write"] : kind === "push_undo" ? ["undo"] : ["memory", "source"];
  if (typeof part !== "string" || !parts.includes(part as RowsReadBody["part"])) throw new PullShapeError(`This job reads ${parts.join(" or ")}.`);
  if (value.after !== null && value.after !== undefined && typeof value.after !== "string") throw new PullShapeError("after is where the last read ended, or null to start.");
  const limit = value.limit === undefined ? ROWS_READ_MAX : value.limit;
  if (!count(limit) || limit < 1) throw new PullShapeError("limit is a whole number of rows.");
  const table = value.table ?? 0;
  if (!count(table) || table >= PUSH_PREVIEWS_MAX) throw new PullShapeError(`table is a part of the job: 0 to ${PUSH_PREVIEWS_MAX - 1}.`);
  const only = value.only;
  if (only !== undefined && ((kind !== "push" && kind !== "push_undo") || (only !== "puts" && only !== "removals"))) throw new PullShapeError("only is puts or removals, and only a write's or an undo's rows take it.");
  return {
    part: part as RowsReadBody["part"],
    after: typeof value.after === "string" ? value.after : null,
    limit: Math.min(limit, ROWS_READ_MAX),
    ...(table ? { table } : {}),
    ...(only ? { only } : {}),
  };
}

const valuesOf = (v: unknown, width: number, what: string): (string | null)[] | null => {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v) || v.length !== width || !v.every((x) => x === null || typeof x === "string")) throw new PullShapeError(`${what} holds one value a column, as text or null: ${width} of them.`);
  return v as (string | null)[];
};

const columnsListOf = (v: unknown, columns: readonly string[], what: string): string[] | null => {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v) || !v.every((c) => typeof c === "string" && columns.includes(c))) throw new PullShapeError(`${what} names the job's own columns.`);
  return v as string[];
};

const keyText = (v: unknown): v is string => typeof v === "string" && v.length <= 100_000;

/** A page of a preview's rows, checked against the job's columns. */
export function previewRowsOf(rows: unknown[], columns: readonly string[]): PreviewRow[] {
  const actions = new Set<PreviewRow["action"]>(["new", "changed", "removed", "held", "adopt", "forget"]);
  return rows.map((r) => {
    if (!isRecord(r) || !keyText(r.key) || typeof r.action !== "string" || !actions.has(r.action as PreviewRow["action"])) throw new PullShapeError("Each row of a preview names its key and what would happen.");
    if (!hashOrNull(r.now ?? null) || !hashOrNull(r.will ?? null)) throw new PullShapeError("A row's hashes are 16 hex digits, or null.");
    const why = r.why ?? null;
    if (why !== null && !HELD_WHYS.includes(why as HeldWhy)) throw new PullShapeError("A held row says why: changed_there, removed_there, appeared or since_preview.");
    const action = r.action as PreviewRow["action"];
    if (action === "held" && why === null) throw new PullShapeError("A held row says why.");
    const row: PreviewRow = {
      key: r.key,
      action,
      now: (r.now ?? null) as string | null,
      will: (r.will ?? null) as string | null,
      why: why as HeldWhy | null,
      changed: columnsListOf(r.changed, columns, "A row's changed columns"),
      before: valuesOf(r.before, columns.length, "A row's before"),
      after: valuesOf(r.after, columns.length, "A row's after"),
      unlinked: columnsListOf(r.unlinked, columns, "A row's unlinked columns"),
    };
    if ((action === "new" || action === "changed") && (row.after === null || row.will === null)) throw new PullShapeError(`A ${action} row carries the store's values and their hash.`);
    if ((action === "changed" || action === "removed") && row.now === null) throw new PullShapeError(`A ${action} row carries the hash of what the database holds.`);
    if (action === "adopt" && (row.now === null || row.will === null)) throw new PullShapeError("An adopted row carries both hashes.");
    return row;
  });
}

/** A page of a compare's rows, checked against the job's columns. */
export function compareRowsOf(rows: unknown[], columns: readonly string[]): CompareRow[] {
  const kinds = new Set<CompareRow["difference"]>(["store_only", "database_only", "differs"]);
  return rows.map((r) => {
    if (!isRecord(r) || !keyText(r.key) || typeof r.difference !== "string" || !kinds.has(r.difference as CompareRow["difference"])) throw new PullShapeError("Each row of a compare names its key and how it differs.");
    const row: CompareRow = {
      key: r.key,
      difference: r.difference as CompareRow["difference"],
      columns: columnsListOf(r.columns, columns, "A row's columns"),
      store: valuesOf(r.store, columns.length, "A row's store values"),
      database: valuesOf(r.database, columns.length, "A row's database values"),
    };
    if (row.difference !== "database_only" && row.store === null) throw new PullShapeError("A row the store holds carries its values.");
    if (row.difference !== "store_only" && row.database === null) throw new PullShapeError("A row the database holds carries its values.");
    return row;
  });
}

/** A page of a push batch's outcomes, checked against the part's columns. */
export function writtenRowsOf(rows: unknown[], columns: readonly string[]): WrittenRow[] {
  const outcomes = new Set<WrittenRow["outcome"]>(["written", "removed", "held"]);
  return rows.map((r) => {
    if (!isRecord(r) || !keyText(r.key) || typeof r.outcome !== "string" || !outcomes.has(r.outcome as WrittenRow["outcome"])) throw new PullShapeError("Each row of a batch names its key and how it ended.");
    const outcome = r.outcome as WrittenRow["outcome"];
    const sent = r.sent ?? null;
    const held = r.held ?? null;
    const why = r.why ?? null;
    const did = r.did ?? null;
    if (outcome === "written" && (!hash(sent) || !hash(held))) throw new PullShapeError("A written row carries the hash of what was sent and of what the database holds.");
    if (outcome === "held" && !HELD_WHYS.includes(why as HeldWhy)) throw new PullShapeError("A held row says why.");
    if (did !== null && (outcome !== "written" || (did !== "inserted" && did !== "updated"))) throw new PullShapeError("A written row says whether it was inserted or updated.");
    const set = columnsListOf(r.set, columns, "A row's set columns");
    if (set !== null && did !== "updated") throw new PullShapeError("Only an updated row names the columns it set.");
    const before = valuesOf(r.before, columns.length, "A row's before");
    if (before !== null && did !== "updated" && outcome !== "removed") throw new PullShapeError("Only an updated or a removed row carries what the database held before.");
    const after = valuesOf(r.after, columns.length, "A row's after");
    if (after !== null && outcome !== "written") throw new PullShapeError("Only a written row carries what the database held after.");
    const whole = r.whole ?? null;
    if (!hashOrNull(whole)) throw new PullShapeError("A row's hash of its other columns is 16 hex digits, or null.");
    if (whole !== null && did !== "inserted" && outcome !== "removed") throw new PullShapeError("Only an inserted or a removed row carries the hash of its other columns.");
    return {
      key: r.key,
      outcome,
      sent: outcome === "written" ? (sent as string) : null,
      held: outcome === "written" ? (held as string) : null,
      why: outcome === "held" ? (why as HeldWhy) : null,
      did: did as WrittenRow["did"],
      set,
      before,
      after,
      ...(whole !== null ? { whole: whole as string } : {}),
    };
  });
}

/** A page of an undo's outcomes, checked. */
export function undoneRowsOf(rows: unknown[]): UndoneRow[] {
  return rows.map((r) => {
    if (!isRecord(r) || !keyText(r.key) || (r.outcome !== "undone" && r.outcome !== "held")) throw new PullShapeError("Each row of an undo names its key and whether it was undone or held.");
    const why = r.why ?? null;
    if (why !== null && (r.outcome !== "held" || !UNDO_HELD_WHYS.includes(why as UndoHeldWhy))) throw new PullShapeError("A held row of an undo says why: changed, columns, too_long or together.");
    return r.outcome === "held" ? { key: r.key, outcome: "held", why: (why ?? "changed") as UndoHeldWhy } : { key: r.key, outcome: "undone" };
  });
}

export function rowsSendOf(value: unknown): RowsSendBody {
  if (!isRecord(value)) throw new PullShapeError("A page names its number and its rows.");
  if (!count(value.page) || value.page < 1) throw new PullShapeError("A page's number starts at 1.");
  if (!Array.isArray(value.rows) || value.rows.length > ROWS_SEND_MAX) throw new PullShapeError(`A page holds at most ${ROWS_SEND_MAX} rows.`);
  if (value.last !== undefined && !keyText(value.last)) throw new PullShapeError("last is the batch's last key.");
  const table = value.table ?? 0;
  if (!count(table) || table >= PUSH_PREVIEWS_MAX) throw new PullShapeError(`table is a part of the job: 0 to ${PUSH_PREVIEWS_MAX - 1}.`);
  return { page: value.page, rows: value.rows, ...(typeof value.last === "string" ? { last: value.last } : {}), ...(table ? { table } : {}) };
}

export function rowsEndOf(value: unknown): RowsEndBody {
  if (!isRecord(value)) throw new PullShapeError("An end says what the runner counted.");
  const out: RowsEndBody = {};
  for (const name of ["read", "targetRows", "same", "otherRows", "batches", "restored"] as const) {
    const v = value[name];
    if (v === undefined) continue;
    if (!count(v)) throw new PullShapeError(`${name} is a whole number.`);
    out[name] = v;
  }
  for (const name of ["committed", "rolledBack"] as const) {
    const v = value[name];
    if (v === undefined) continue;
    if (typeof v !== "boolean") throw new PullShapeError(`${name} is true or false.`);
    out[name] = v;
  }
  if (out.committed && out.rolledBack) throw new PullShapeError("A transaction is committed or rolled back, not both.");
  if (value.links !== undefined) {
    if (!Array.isArray(value.links) || value.links.length > LINKS_MAX) throw new PullShapeError(`links holds at most ${LINKS_MAX} counts.`);
    out.links = value.links.map((l) => {
      if (!isRecord(l) || !text(l.column, 256) || !text(l.to, 800) || !count(l.linked) || !count(l.unlinked) || !count(l.empty)) {
        throw new PullShapeError("Each link's counts name its column, what it links to, and how many rows are linked, unlinked and empty.");
      }
      return { column: l.column, to: l.to, linked: l.linked, unlinked: l.unlinked, empty: l.empty };
    });
  }
  return out;
}
