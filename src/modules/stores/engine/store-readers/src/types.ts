// The shapes every reader answers in, whatever the file was: the tables it holds, their columns
// with the town's own types, and rows whose values are text. LOAD writes each table to a store
// as one raw table (packages/store-object/src/jobs/load.ts).

/** What a file is, as LOAD reads it. */
export type SourceFormat = "delimited" | "dbf" | "xlsx" | "xls" | "ods" | "access" | "sqlite" | "json" | "xml" | "parquet" | "zip";

/** One column of a table in a town's file. */
export interface SourceColumn {
  /** Its name in the file ("Permit No", "PERMITNO"), or "column 3" for a column the file leaves unnamed. */
  name: string;
  /** The town's own type, as the file says it: "C(12)", "N(10,2)", "D", "text(20)", "date", "number". */
  originalType: string;
}

/** One table a file holds: a delimited file's one table, a workbook's sheet, a database's table. */
export interface SourceTable {
  /** The sheet's or table's name in the file; null for a file of one unnamed table. */
  name: string | null;
  columns: SourceColumn[];
  /** The rows the file says the table holds, when it says (a dBase header, an Access table). */
  rowCount: number | null;
  /** What a person should know about this table: a hidden sheet, a memo file missing. */
  notes: string[];
}

/**
 * A row as read: where a person finds it in the file, and its values as text, one per column and
 * then any the row has beyond its columns. A spreadsheet's row is the one the program shows it on
 * (the header is row 1); a dBase row is its record number; an Access row counts from 1 in the
 * table's own order.
 */
export interface SourceRow {
  n: number;
  values: (string | null)[];
  /** Values the reader could not place in a column, by where they were in the file ("column A"); they go to `_extra`. */
  extra?: Readonly<Record<string, string>>;
}

/**
 * Where a read of one table stopped, so that the next one, in a later alarm or after the object
 * restarted, goes on from there. Plain numbers, kept in the job's progress.
 */
export type ReadCursor = Readonly<Record<string, number>>;

/** A batch of rows, where the next batch starts (null after the last), and the rows a file marks deleted that the batch skipped. */
export interface RowBatch {
  rows: SourceRow[];
  next: ReadCursor | null;
  /** Rows the file holds but marks deleted (dBase), skipped and counted. */
  deleted: number;
  /** What a person should know that this batch found: a dBase table's text read in another code page than its header names, from this batch on. */
  notes?: string[];
}

/** The code page a person set for a file's text (`READABLE_CODE_PAGES`), and the file they set it for, as a note names it: the file itself, or the zip it is in. */
export interface SetCodePage {
  page: number;
  file: string;
}

/** How much one batch may read: at most `rows` rows, and about `bytes` bytes of the file where the format reads by range. */
export interface BatchLimit {
  rows: number;
  bytes?: number;
}

/** A town's file, opened: its tables, and a way to read each one's rows in batches. */
export interface OpenedFile {
  format: SourceFormat;
  tables: SourceTable[];
  /** What a person should know about the whole file: its encoding, what it could not read. */
  notes: string[];
  /** Up to `limit` rows of the table at `table` (an index into `tables`), from `cursor` (null for the first). */
  rows(table: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch>;
}

/** A file LOAD cannot read, with the sentence that says why. */
export class UnreadableFile extends Error {
  constructor(
    message: string,
    /** "unsupported" for a kind of file LOAD does not read; "damaged" for one it should read and could not; "too-big" above the size a store reads in its own object. */
    readonly reason: "unsupported" | "damaged" | "too-big",
  ) {
    super(message);
    this.name = "UnreadableFile";
  }
}
