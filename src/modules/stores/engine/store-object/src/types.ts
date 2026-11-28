// What a store answers, in its own words. The store is self-contained (it imports nothing from
// its deployer), so these shapes are written out here. They are the same shapes the `stores` package gives
// the store's clients (Design's Data view shapes plus what a store adds), and the gateway's
// contract check fails to compile when the two drift (src/contract.check.ts).

export type SqlValue = string | number | null;

/** Who calls, as the caller's own checks verified it. The store refuses a call for another store. */
export interface StoreCaller {
  storeId: string;
  /** Who acts, kept where the store's own records need it: "user:<id>", "run:<id>", "guest:<email>". */
  actor: string;
  /**
   * The folder the caller's token holds it to (folders.ts): its uploads, its moves and its changes
   * to folders reach this folder and the folders inside it, and nothing outside. Left out, the
   * caller reaches every folder.
   */
  folder?: string;
  /**
   * The organization the caller's token names. The store keeps the first it hears (`_meta` `org`),
   * and its writes count toward that organization's daily write budget from then on, when its host
   * keeps one (`StoreDeps.writeBudget`, write-limit.ts).
   */
  org?: string;
}

/** Every answer: the value, or a refusal with an HTTP status, a code and plain words. */
export type StoreResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; error: string };

export interface DataLink {
  database: string;
  table: string;
  column: string;
  via: "foreign_key" | "values";
}

export interface CatalogColumn {
  name: string;
  type: string;
  nullable: boolean;
  comment?: string;
  values?: string[];
  source?: string;
  link?: DataLink;
  indexed?: boolean;
  quiet: boolean;
  originalType?: string;
  filled?: number;
  distinct?: number;
}

export interface CatalogTable {
  database: string;
  name: string;
  count: number;
  estimated: boolean;
  comment?: string;
  source?: string;
  key: string[];
  label: string | null;
  softDelete: boolean;
  quiet: boolean;
  kind: "program" | "managed" | "system";
  version: number;
  group: string | null;
  madeBy: { runId: string | null; step: string | null; job: string | null; at: string } | null;
  columns: CatalogColumn[];
  /** A LOAD's table whose rows wait in the store's files (park.ts): Bring Back writes them back. */
  parked?: { at: string; rows: number; bytes: number };
  /** A view: no rows of its own (a SHAPE's "Ready" view, or a migration's). */
  view?: boolean;
  /** A program table's newest change number (deltas.ts): a change in place keeps the version. */
  change?: number;
  /** A LOAD table's name in full, where LOAD cut it at 60 characters: SQL reads the table by it too (front-door.ts). */
  fullName?: string;
  /** The file's columns LOAD packed into `_extra`, past the table's own: SQL reads each by its name (front-door.ts). */
  packed?: CatalogPackedColumn[];
}

/** A column LOAD packed into `_extra`: its name, and the town's own type for it. */
export interface CatalogPackedColumn {
  name: string;
  originalType?: string;
}

export interface Catalog {
  databases: { name: string; engine: "postgres" | "sqlite"; error?: string }[];
  tables: CatalogTable[];
  bytes: number;
  ms: number;
}

/** What a filter asks of a column's values. `whereOf` in data.ts says what each one means. */
export type RowFilterOp =
  | "is"
  | "is_not"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "on"
  | "before"
  | "after"
  | "is_true"
  | "is_false"
  | "empty"
  | "not_empty";

/** One filter of a page: a column, what it asks of the column's values, and the value it compares
 *  with (left out for `is_true`, `is_false`, `empty` and `not_empty`). */
export interface RowFilter {
  column: string;
  op: RowFilterOp;
  value?: string;
}

export interface RowsBody {
  database: string;
  table: string;
  offset: number;
  limit: number;
  /** The first key alone, as a client older than `sorts` sends it. */
  sort?: { column: string; direction: "asc" | "desc" } | null;
  /** The sort's keys, the first first; read before `sort`. */
  sorts?: { column: string; direction: "asc" | "desc" }[];
  /** One row with no cell cut for the wire (cells up to `WHOLE_CELL_MAX`), for the row's panel:
   *  only with `limit` 1. */
  whole?: boolean;
  /** One column's value (Linked from), as a client older than `filters` sends it. */
  filter?: { column: string; value: string | null } | null;
  /** The filters a row passes, every one; read before `filter`. */
  filters?: RowFilter[];
  /** Words any text column of a row holds, in any letter case. Empty: no search. */
  search?: string;
  labels?: { column: string; database: string; table: string; key: string; label: string | null }[];
}

export interface Rows {
  columns: string[];
  rows: (string | null)[][];
  total: number | null;
  labels: Record<string, Record<string, string>>;
  cut: string[];
  ms: number;
}

export interface UsedByBody {
  refs: { database: string; table: string; column: string; value: string }[];
}

export interface UsedBy {
  refs: { database: string; table: string; column: string; count: number; more?: boolean }[];
  ms: number;
}

export interface LocateBody {
  database: string;
  table: string;
  column: string;
  value: string;
}

export interface Locate {
  offset: number | null;
  ms: number;
}

/** Which table's structure: the store's one database, and a table of it. */
export interface StructureBody {
  database: string;
  table: string;
}

/**
 * Which table's profile: the store's one database, a table of it, and the columns to read (left
 * out: the table's own). The profile is the one profile's (`TableProfile` in the readers' profile).
 */
export interface ProfileBody {
  database?: string;
  table: string;
  columns?: string[];
}

/** What a foreign key does to a row when the row it points at changes or goes. */
export type ForeignKeyAction = "no action" | "restrict" | "cascade" | "set null" | "set default";

export interface StructureColumn {
  name: string;
  /** The type as the table declares it; empty for a column declared with none. */
  type: string;
  nullable: boolean;
  /** The default as SQL writes it. Null: none. */
  default: string | null;
  /** Its place in the primary key, from 1. */
  key?: number;
  identity?: "always" | "by default";
  generated?: string;
  /** A unique constraint or a whole unique index holds it alone. */
  unique?: boolean;
  comment?: string;
}

export interface StructureIndex {
  name: string;
  /** Its columns in order, or an expression's text where it reads one. */
  columns: string[];
  unique: boolean;
  origin: "key" | "unique" | "index";
  /** It holds only the rows this condition keeps. */
  where?: string;
  method?: string;
  /** Its CREATE INDEX; left out for one SQLite makes itself. */
  sql?: string;
}

export interface StructureForeignKey {
  name?: string;
  columns: string[];
  table: string;
  /** Empty: that table's primary key. */
  to: string[];
  onUpdate: ForeignKeyAction;
  onDelete: ForeignKeyAction;
}

/** A migration whose SQL names the table, from the store's own record (`_migrations`). */
export interface StructureMigration {
  id: string;
  appliedAt: string | null;
  appliedBy?: string;
  sql: string;
  cut?: boolean;
  source?: string;
}

/** One table's structure, from its PRAGMAs and `sqlite_master`, with what made it. */
export interface Structure {
  database: string;
  table: string;
  view?: boolean;
  columns: StructureColumn[];
  key: string[];
  keyName?: string;
  indexes: StructureIndex[];
  foreignKeys: StructureForeignKey[];
  /** CREATE TABLE (or VIEW), then its indexes and triggers. */
  sql: string;
  sqlCut?: boolean;
  /** A managed table's migrations whose SQL names it, oldest first. */
  migrations?: StructureMigration[];
  ms: number;
  kind: "program" | "managed" | "system";
  version: number;
  madeBy: { runId: string | null; step: string | null; job: string | null; at: string } | null;
}

export interface QueryResult {
  columns: string[];
  rows: SqlValue[][];
  truncated: boolean;
  cut?: string[];
  ms: number;
}

export interface ExecResult {
  changes: number;
  ms: number;
  /** What a recorded or tried batch changed, or what an undo put back (changes.ts). */
  change?: ChangeSummary;
}

/** What one table of a change had done to it. */
export interface ChangeTableCount {
  name: string;
  inserted: number;
  updated: number;
  deleted: number;
  /** The change made the table; `inserted` is what it held when the change ended. */
  made: boolean;
  /**
   * A new version of a program's table (B10 part 2): its version and rows before (null for a table
   * the run made) and after. A step's change in place to a program's table has none: its counts say it.
   */
  version?: { before: number | null; after: number; rowsBefore: number | null; rows: number };
}

/** A change a store keeps (changes.ts): a trial, a kept change, or one undone. */
export interface ChangeSummary {
  id: number;
  state: "trial" | "kept" | "undone";
  /** Rows inserted, updated or deleted in tables that were there before it. */
  rows: number;
  /** Too large to keep row by row: its counts only, and no undo row by row. */
  whole: boolean;
  tables: ChangeTableCount[];
  /** An undo's rows put back, and rows held because they changed since. */
  restored?: number;
  held?: number;
  /** Which rows it touched and what each held before, as one value: a trial and the change it allows match when their data did not move. */
  fingerprint?: string;
}

/** A batch to try, kept as a trial: what it would change, with nothing changed. */
export interface ExecTrialBody {
  sql?: unknown;
  params?: unknown;
  run?: unknown;
  step?: unknown;
  key?: unknown;
}

/** Who a recorded batch's change is for, and whether it must match the call's trial. */
export interface ExecRecordBody {
  run?: unknown;
  step?: unknown;
  key?: unknown;
  expect?: unknown;
}

/** `exec`'s body: a batch, a batch to try or record, or a change to undo. */
export interface ExecBody {
  sql?: unknown;
  params?: unknown;
  trial?: ExecTrialBody;
  record?: ExecRecordBody;
  undo?: unknown;
}

export interface Migration {
  id: string;
  checksum: string;
  sql: string;
  appliedAt: string;
  appliedBy: string;
  restorePoint: string | null;
}

export interface MigrateResult {
  applied: boolean;
  migration: Migration;
}

export type FileVia = "page" | "link" | "run" | "api";

export interface StoredFile {
  id: string;
  name: string;
  size: number;
  contentType: string;
  sha256: string | null;
  state: "uploading" | "ready";
  receivedAt: string;
  receivedBy: string;
  via: FileVia;
  batch: string | null;
  /** The one folder the file is in (folders.ts). A store never keeps a file in no folder. */
  folderId: string;
}

/** The rows of one table a file's preview shows (file-tables.ts). The api's contract keeps the same number. */
export const FILE_TABLE_ROWS = 200;

/**
 * The kinds of file a preview reads as tables, by extension: an Excel or OpenDocument workbook's
 * sheets, an Access or SQLite database's tables, a Parquet file, a dBase table. The api's contract
 * keeps the same list.
 */
export const FILE_TABLE_EXTENSIONS: readonly string[] = ["xlsx", "xlsm", "xltx", "xltm", "xls", "ods", "mdb", "accdb", "sqlite", "sqlite3", "db", "parquet", "dbf"];

/** Which table's rows a preview asks for: an index into its tables, the first when it names none there. */
export interface FileTablesBody {
  table?: number;
}

/** A file read as tables: every table it holds by name, with its columns, and the first rows of one. Every value is text, as LOAD reads it. */
export interface FileTables {
  tables: { name: string | null; columns: string[]; rows: number | null }[];
  /** The table whose rows these are: an index into `tables`. */
  table: number;
  rows: (string | null)[][];
  /** The table holds more rows than these. */
  more: boolean;
  /** What a person should know about the file as the readers read it: its encoding, what they could not read. */
  notes: string[];
}

/** A store's folder (folders.ts): every file is in exactly one. */
export interface StoredFolder {
  id: string;
  name: string;
  /** The folder it is in; null at the top. */
  parentId: string | null;
  /**
   * What it was made for, when it was made for something, which finds it again after a rename:
   * "uploads" (where a file goes when nobody names a folder), or what its maker names, such as
   * "sender:<id>", "link:<id>" or "sample:<id>". Null for a folder a person made.
   */
  ref: string | null;
  createdAt: string;
  createdBy: string;
  /** The files that arrived directly in it (not in the folders inside it), and their bytes. */
  files: number;
  bytes: number;
}

/**
 * One table of a job as its progress shows it, so a page draws a bar for each: a pull's or a load's
 * table in the store, a write's table in the database.
 */
export interface JobTableProgress {
  /** The table it writes: the store's for a pull or a load, the database's for a write. */
  name: string;
  /** Where its rows come from: a database's table (`schema.name`), a file's name, a store's table. */
  source?: string;
  /** waiting: not begun; running: its rows are read or written now; done; skipped: not read, `why` says why. */
  state: "waiting" | "running" | "done" | "skipped";
  /** Rows read (a pull, a load) or written and held (a write) so far. */
  done: number;
  /** The rows it comes to, when something says: a database's estimate, a file's own count, a write's preview. */
  total: number | null;
  /** Values cut so their row fits in a store. */
  cut?: number;
  /** A pull's rows added, changed and removed so far. */
  added?: number;
  changed?: number;
  removed?: number;
  /** Why it was skipped, in the database's or the reader's own words. */
  why?: string;
}

export interface JobProgress {
  done: number;
  total: number | null;
  note?: string;
  /** A READ's: when its file reader last called (jobs/read.ts). Nothing else writes it, so an api reads from it whether a reader holds the job. */
  readerAt?: string;
  /** Each table of a pull, a load or a write, in its order; absent for the other jobs. */
  tables?: JobTableProgress[];
  /** The tables past the ones `tables` lists: a load of many files lists the first ones only. */
  tablesLeftOut?: number;
}

/** What a job is about to write, said before its first write: rows, and what the number rests on. */
export interface JobEstimate {
  rows: number;
  /** "the files' sizes", "its largest source table". */
  basis: string;
}

/**
 * Why an open job writes nothing now: today's writes reached the store's daily limit. The job keeps
 * its place and its tables in progress, and goes on at 00:00 UTC, or as soon as the limit is raised.
 */
export interface JobWait {
  /** What it waits out: the daily write limit, by its refusal's code. */
  code: "write_limit_reached";
  /** The store's words for it, as its refusal of a write says them. */
  error: string;
  /** The latest it goes on, as an ISO time: the next 00:00 UTC. */
  until: string;
}

export interface Job {
  id: string;
  kind: string;
  requestKey: string;
  state: "queued" | "running" | "done" | "failed";
  progress: JobProgress | null;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** The rows it was about to write, when its kind could say; absent from a gateway older than the daily write limit. */
  estimate?: JobEstimate | null;
  /** The rows its chunks wrote so far, index entries included. */
  rowsWritten?: number;
  /** Set while the job is open and waits for the store's daily write limit; null otherwise. */
  waiting?: JobWait | null;
}

/** Why a job waits or failed, as a code (jobs/summary.ts `JOB_REFUSALS` says what each means). */
export type JobRefusal = "write_limit_reached" | "stopped" | "job_kind_unknown" | "chunk_failed" | "failed";

/** One table a job made or changed, as its summary names it. */
export interface JobSummaryTable {
  /** The table's name. */
  table: string;
  version: number | null;
  rows: number | null;
  /** How the job wrote the table, or what the table is to the job: a word from the kind's own list, or null. */
  step: string | null;
  /** The table's own counts, by the kind's own names. */
  counts: Record<string, number>;
}

/**
 * What a job did, for a reader that may hold no value of a row (jobs/summary.ts): its state, the
 * step it is in, its times, its counts and the names of its tables. The shape is the same for
 * every kind of job; `JOB_SUMMARY_SHAPES` lists the words and the names each kind may put in it.
 * A job's `result` stays what it is, for a reader that may hold rows.
 */
export interface JobSummary {
  id: string;
  kind: string;
  state: Job["state"];
  /** The part of its work an open job is in, or the pass a job was asked for: a word from the kind's own list, or null. */
  step: string | null;
  createdAt: string;
  updatedAt: string;
  /** When an open job that waits for the daily write limit goes on by itself, as an ISO time; null otherwise. */
  waitsUntil: string | null;
  /** Why it waits or failed, as a code; null for a job that does neither. Never the job's own words. */
  refusal: JobRefusal | null;
  /** The rows its chunks wrote so far. */
  rowsWritten: number;
  /** The rows it was about to write, as its kind said before its first write; null when its kind could not say. */
  estimatedRows: number | null;
  progress: { done: number; total: number | null } | null;
  /** What it counted, by the kind's own names. */
  counts: Record<string, number>;
  /** The tables it made or changed. */
  tables: JobSummaryTable[];
}

/** The streams of what settles in a store (events.ts), each read from its own time. */
export type StoreEventStream = "files" | "deleted" | "jobs" | "fixes";

/** A file an event names: its id, name, size and the folder it is (or was) in. */
export interface StoreEventFile {
  id: string;
  name: string;
  size: number;
  folderId: string;
}

/**
 * Something that happened in a store and settled (events.ts): made of ids, names, sizes and
 * counts, never a value of a row. `key` is the event's own, the same in every answer that holds it;
 * `at` is when it settled from (its last file, its last delete, its end, its last fix); `by` is the
 * caller's actor as the store keeps it ("user:<id>", "run:<id>", "guest:<email>", "app:<script>").
 */
export type StoreEvent =
  | {
      /** A batch of files that arrived (or one file with no batch): every file of it that arrived and is still here. */
      kind: "files";
      key: string;
      at: string;
      by: string;
      via: FileVia;
      files: StoreEventFile[];
      /** How many files it holds; `files` names at most EVENT_FILES_MAX of them. */
      count: number;
      /** The names of the folders its files are in and of every folder above them, the first file's own first. */
      folders: string[];
    }
  | {
      /** One caller's deletes, close together. */
      kind: "deleted";
      key: string;
      at: string;
      by: string;
      files: StoreEventFile[];
      count: number;
      folders: string[];
    }
  | {
      /** A job that ended, done or failed: its summary, and the run that made it. */
      kind: "job";
      key: string;
      at: string;
      by: string;
      runId: string | null;
      summary: JobSummary;
    }
  | {
      /** A person's fixes of one table's rows on the Tables tab. */
      kind: "fix";
      key: string;
      at: string;
      by: string;
      table: string;
      version: number;
      rows: number | null;
      /** How many fixes, and how many rows they changed. */
      fixes: number;
      changed: number;
    };

/** What settled since a reader's times (events.ts `storeEvents`). */
export interface StoreEvents {
  /** Oldest first within each stream. */
  events: StoreEvent[];
  /** Each stream's time to read from next: everything up to it is in this answer or in one before. */
  through: Record<StoreEventStream, string>;
  /** Something is still settling: read again within a minute. */
  settling: boolean;
}

export interface HistoryEvent {
  id: string;
  at: string;
  kind: "migration" | "table" | "restore" | "job" | "files";
  by: string;
  note: string;
  restorePoint?: string;
}

export interface History {
  events: HistoryEvent[];
  restorableFrom: string;
}

/** A store's writes on one UTC day, against its daily write limit (write-limit.ts). */
export interface StoreWrites {
  /** The UTC day, YYYY-MM-DD. */
  day: string;
  /**
   * Rows SQLite wrote that day, index entries included: what Cloudflare bills, $1.00 a million. The
   * rows of every store of the organization when `shared`, else this store's alone.
   */
  rows: number;
  /** The most rows those stores write a day; at it, they take no more writes of their data until the next UTC day. */
  limit: number;
  /** Whether `rows` and `limit` are the organization's daily write budget, which every store of it shares. */
  shared: boolean;
}

/** An organization's writes on one UTC day, as the keeper of its budget answers them. */
export interface SharedWrites {
  /** The UTC day, YYYY-MM-DD. */
  day: string;
  /** Rows every store of the organization wrote that day, as far as the keeper has heard. */
  rows: number;
  /** The most rows the organization's stores write a day. */
  limit: number;
}

/**
 * The keeper of a daily write budget the store's writes share with other stores: a deployment's gateway
 * keeps one per organization. The store tells it what it wrote, and holds itself to the answer.
 */
export interface WriteBudget {
  /** Adds the rows this store wrote on `day` (0 only asks), and answers the organization's count and limit. */
  wrote(day: string, rows: number): Promise<SharedWrites>;
}

/** The most folders a store's stats carry: those at the top, by name. */
export const STATS_FOLDERS = 50;

/** One of a store's folders at the top, as its stats carry it. */
export interface StatsFolder {
  id: string;
  name: string;
  /** The ready files in it and in the folders inside it, and their bytes. */
  files: number;
  bytes: number;
}

/** The most table names a store's stats carry; `tables` counts them all. */
export const STATS_TABLE_NAMES = 40;

export interface Stats {
  bytes: number;
  tables: number;
  rows: number;
  files: number;
  fileBytes: number;
  /** The folders at the top, by name, the first `STATS_FOLDERS`, so a list of stores can name them
   *  without asking each store. Absent from a gateway older than folders. */
  folders?: StatsFolder[];

  /** The tables' names, by name, the first `STATS_TABLE_NAMES` of them, so a list of stores can name
   *  them without asking each store. Absent from a gateway older than the names. */
  tableNames?: string[];
  /** Today's writes and the daily limit; absent from a gateway older than the limit. */
  writes?: StoreWrites;
}

export interface TableHandle {
  table: string;
  version: number;
  rows: number;
}

// ── Review: the rows a person fixes on the Tables tab (review.ts) ──────────────────────────────

/** A table with rows to review: a checked table's flagged rows, or an Answers table's unsure answers. */
export interface ReviewTable {
  table: string;
  kind: "flags" | "answers";
  /** A checked table's flags table; null for an Answers table. */
  flags: string | null;
  /** Rows still to review. */
  open: number;
  /** The table has a newer version than its check read: run the check again to review it. */
  stale: boolean;
}

export interface Review {
  tables: ReviewTable[];
}

export interface ReviewRowsBody {
  table: string;
  offset: number;
  limit: number;
  /** The `at` of the review's first page: what was settled after it stays listed, so rows keep their places. */
  since?: string;
  /** The filters a listed row passes, every one, as on a page of the table's rows. */
  filters?: RowFilter[];
  /** Words any text column of a listed row holds, in any letter case. Empty: no search. */
  search?: string;
}

/** What is wrong with a row: a rule it breaks (`rule`), or an answer that waits for a person (`unsure`). */
export interface ReviewFlag {
  column: string | null;
  /** The rule's words, or the answerer's note. */
  problem: string;
  /** The rule's place in its check; null for an answer. */
  rule: number | null;
  kind: "rule" | "unsure";
  /** What a person may accept as it is: an unsure answer. */
  suggestion: string | null;
  sure: number | null;
}

export interface ReviewRow {
  /** The row's rowid in its table. */
  id: number;
  cells: (string | null)[];
  /** Cells cut at CELL_MAX characters, by column index. */
  cut?: number[];
  flags: ReviewFlag[];
}

export interface ReviewRows {
  table: string;
  version: number;
  kind: "flags" | "answers";
  columns: string[];
  /** The columns a fix may write. */
  editable: string[];
  rows: ReviewRow[];
  /** Rows on the list: those still to review, and those settled since `since`. */
  total: number;
  /** Rows still to review. */
  open: number;
  /** When the store read this page; the `since` of the review's later pages. */
  at: string;
  ms: number;
}

/** A person's fix of one cell, or their yes to an unsure answer (`accept`). `was` is what they saw
 *  in the cell; left out, the fix writes whatever the cell holds now. */
export interface ReviewFixBody {
  table: string;
  id: number;
  column: string;
  was?: string | null;
  value?: string | null;
  accept?: boolean;
}

export interface ReviewFixResult {
  row: ReviewRow;
  /** Rows of the table still to review. */
  open: number;
  /** Other rows the fix changed the flags of, as they stand now: a unique rule's. */
  others: ReviewRow[];
}

/** Every part of an upload is this long but the last: 8 MiB, the product's upload chunk size. */
export const FILE_PART_BYTES = 8 * 1024 * 1024;
export const FILE_PARTS_MAX = 10_000;
export const FILE_NAME_MAX = 255;
/** A folder's name: at most this many characters. */
export const FOLDER_NAME_MAX = 120;
/** How deep folders go: a folder at the top is level 1. */
export const FOLDER_DEPTH_MAX = 4;
/** The most folders a store keeps. */
export const FOLDERS_MAX = 2_000;
/** The most files one move takes. */
export const FOLDER_MOVE_MAX = 1_000;
/** The `ref` of a store's Uploads folder: where a file goes when nobody names a folder. */
export const UPLOADS_REF = "uploads";
/** The Uploads folder's name when the store makes it. */
export const UPLOADS_NAME = "Uploads";
export const DATABASE = "store";
export const QUERY_LIMIT_MAX = 1_000;
export const QUERY_LIMIT_DEFAULT = 200;
export const SQL_MAX_CHARS = 200_000;
export const PARAMS_MAX = 100;

// ── A Modern App's own statements and people (app.ts, app-users.ts) ─────────

/** How drizzle's sqlite-proxy driver asks for an answer. */
export type AppMethod = "run" | "all" | "values" | "get";

export interface AppStatement {
  sql: string;
  params?: unknown[];
  method: AppMethod;
}

/**
 * One statement's answer, in the shapes drizzle's sqlite-proxy driver reads: "all" and "values"
 * answer every row as an array of values; "get" answers the first row, or nothing when there is
 * none (drizzle reads an empty array as a row); "run" answers no rows, with the rows it changed.
 */
export interface AppStatementResult {
  rows: unknown[] | undefined;
  changes?: number;
  lastInsertRowid?: number;
}

export type AppUserStatus = "invited" | "active" | "removed";

/** One person on a stage's user list (`_users`). The same shape as `StoreAppUser` in the `stores` package. */
export interface AppUser {
  id: string;
  issuer: string | null;
  sub: string | null;
  email: string;
  emailVerified: boolean;
  name: string | null;
  role: string;
  tester: boolean;
  author: boolean;
  status: AppUserStatus;
  invitedBy: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  removedAt: string | null;
}

export interface AppUserInviteBody {
  email: string;
  role: string;
  tester?: boolean;
  name?: string | null;
}

export interface AppUserUpdateBody {
  role?: string;
  tester?: boolean;
  name?: string | null;
  status?: "active" | "removed";
}

export interface AppUserSignOutResult {
  ended: number;
}

/** The person a sign-in names, signed out of every session that started before `before` (an ISO time). */
export interface AppIdentitySignOutBody {
  issuer: string;
  sub: string;
  before: string;
}

/** Who may open a stage: its authors; its authors and the testers on its list; everyone active on its list. */
export type AppWhoOpens = "authors" | "authors-testers" | "users";

/** Who may join a stage's list by signing in: no one (invited people only), people at these domains, anyone. */
export interface AppJoinRule {
  mode: "invited" | "domains" | "link";
  domains: string[];
}

/** A person as their sign-in's issuer vouched for them. */
export interface AppIdentity {
  issuer: string;
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface AppSignInBody {
  identity: AppIdentity;
  whoOpens: AppWhoOpens;
  join: AppJoinRule;
  /** The role someone who joins gets. */
  defaultRole: string;
  /** The role an author gets on a stage whose list does not have them. */
  authorRole: string;
  /** Whether the person is one of the app's authors, as the caller found out. */
  author: boolean;
  /** The session to start: its id (a hash of the cookie's token) and how long it lasts. */
  session: { id: string; days: number };
}

/** Why a person may not open a stage. */
export type AppAccessRefusal =
  | "removed"
  | "not_invited"
  | "domain_not_listed"
  | "authors_only"
  | "testers_only"
  | "email_in_use"
  | "email_unverified";

export type AppSignInResult =
  | { ok: true; user: AppUser; session: { id: string; expiresAt: string } }
  | { ok: false; reason: AppAccessRefusal; user: AppUser | null };

/**
 * A session, read on each request: the person, and whether they may open the stage if they are
 * one of the app's authors and if they are not. When the two agree, the caller needs no answer to
 * "is this person an author?".
 */
export type AppSessionResult =
  | { ok: true; user: AppUser; expiresAt: string; opens: { asAuthor: boolean; asOther: boolean } }
  | { ok: false; reason: "no_session" | "expired" | "ended" | "removed" };

/**
 * The person a native client's access token names, read on each request with no session: found by
 * the issuer and `sub` the token carries, and whether they may open the stage if they are one of the
 * app's authors and if they are not. A token carries no verified email, so nobody joins this way:
 * a person not on the list signs in once on the web first.
 */
export type AppTokenUserResult =
  | { ok: true; user: AppUser; opens: { asAuthor: boolean; asOther: boolean } }
  | { ok: false; reason: "not_listed" | "removed" };
