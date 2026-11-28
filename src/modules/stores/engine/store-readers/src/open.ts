// Which reader a town's file needs, from its opening bytes first and its name second, and the one
// door every reader is opened through.
//
// An .xls workbook and an Access database are read whole inside the store's object, so each has a
// size cap: a file above it is refused with a sentence that says what to do instead, and no
// reader starts, unless the store holds the file's read-out: its tables and rows as the file reader
// read them beside the store (jobs.ts READ), which open here as the file would (`openReadOut`). The
// caps were measured as the memory a file of that size needs while it is read (README.md, "Size caps"). Every other kind is read by range: delimited text, dBase tables,
// .xlsx and .ods workbooks, SQLite and Parquet files, JSON, XML, and zip archives of any of these.
// Which extensions name which kind is accepted.ts, with the words for a kind no reader reads.

import { openAccess } from "./access.js";
import { openArchive, ZIP_INFLATED_CAP } from "./archive.js";
import { type DbfDatabase, openDbf } from "./dbf.js";
import { openDelimited } from "./delimited.js";
import { openExcel } from "./excel.js";
import { openJson } from "./json.js";
import { extensionOf } from "./names.js";
import { openOds } from "./ods.js";
import { openParquet } from "./parquet.js";
import { type ByteSource, readAll } from "./source.js";
import { openSqlite } from "./sqlite.js";
import { codePageName, type ReadOut, sourceRowOf } from "./jobs.js";
import { DBC_BYTES_MAX, type DbcTable, dbcTableOf, readDbc } from "./dbc.js";
import { databaseFileWords, formatOf, WHOLE_FILE_CAPS } from "./format.js";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SetCodePage, type SourceFormat, type SourceRow, UnreadableFile } from "./types.js";
import { openXml } from "./xml.js";
import { openXlsx } from "./xlsx.js";

export { databaseFileWords, formatOf, WHOLE_FILE_CAPS } from "./format.js";

const LINES_EXTENSIONS = new Set(["jsonl", "ndjson"]);
const startsWith = (b: Uint8Array, bytes: readonly number[], at = 0): boolean => bytes.every((x, i) => b[at + i] === x);
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/**
 * A database's container as LOAD hands it to a table: its file's name, and its bytes (null when
 * they could not be read). `tables` is the container read already (null for a file that is not
 * one), as a zip reads it once for all its tables; `id`, a store's file id, lets a LOAD of many of
 * its tables read it once too.
 */
export interface DatabaseFile {
  name: string;
  source: ByteSource | null;
  id?: string;
  tables?: readonly DbcTable[] | null;
  /** Why it was not read, in words after its name, when it came and was not ("could not be read"). */
  unread?: string;
}

/** The containers read lately, by their store file's id: a stored file never changes. */
const containersRead = new Map<string, Promise<DbcTable[] | null>>();
const CONTAINERS_KEPT = 16;

/** A container's tables, read once for each store file however many of its tables open. A read that fails is never kept. */
function containerTables(dbc: DatabaseFile & { source: ByteSource }): Promise<DbcTable[] | null> {
  if (!dbc.id) return readDbc(dbc.source);
  const kept = containersRead.get(dbc.id);
  if (kept) return kept;
  const reading = readDbc(dbc.source);
  containersRead.set(dbc.id, reading);
  reading.catch(() => containersRead.delete(dbc.id!));
  if (containersRead.size > CONTAINERS_KEPT) containersRead.delete(containersRead.keys().next().value!);
  return reading;
}

const mb = (bytes: number): string => `${Math.round(bytes / (1 << 20))} MB`;
/** A file's size to a tenth of a megabyte, so a file just over a cap does not read as the cap. */
const fileMb = (bytes: number): string => `${(bytes / (1 << 20)).toFixed(1)} MB`;

export interface OpenFileOptions {
  /** A dBase or FoxPro table's memo file, when the store holds one with the table's name. */
  memo?: ByteSource | null;
  /** A Visual FoxPro table's database containers (.dbc) that came with it, nearest first: each one's file name and bytes. */
  dbc?: DatabaseFile | readonly DatabaseFile[] | null;
  /** The code page a person set for the file's text (`READABLE_CODE_PAGES`): a dBase table's, delimited text's, and theirs inside a zip. */
  codePage?: number | null;
  /**
   * For a workbook or a database above the size the store reads whole: the file opened from the
   * read-out the store holds of it (`openReadOut`), or null when it holds none. Asked only then.
   */
  readOut?: (() => Promise<OpenedFile | null>) | null;
}

/** The kinds of file whose code page a person sets: a zip's dBase tables and delimited text take the zip's. */
const SETS_CODE_PAGE = new Set<SourceFormat>(["dbf", "delimited", "zip"]);

/**
 * A town's file, opened by the reader its kind needs. Every kind but a workbook or a database read
 * whole is read by range and has no size limit; one read whole above its cap is refused.
 */
export async function openFile(fileName: string, source: ByteSource, options: OpenFileOptions = {}): Promise<OpenedFile> {
  const head = await source.read(0, Math.min(source.size, 8192));
  const kind = formatOf(fileName, head, source.size);
  if ("refused" in kind) throw new UnreadableFile(kind.refused, "unsupported");
  const codePage = options.codePage ? { page: options.codePage, file: fileName } : null;
  const whole = kind.format === "xls" || kind.format === "access" ? kind.format : null;
  const readOut = whole && source.size > WHOLE_FILE_CAPS[whole] && options.readOut ? await options.readOut() : null;
  const file = readOut ?? (await openAs(kind.format, fileName, source, { memo: options.memo ?? null, dbc: options.dbc ?? null, depth: 0, budget: ZIP_INFLATED_CAP, codePage }));
  if (!codePage || SETS_CODE_PAGE.has(file.format)) return file;
  return { ...file, notes: [...file.notes, `${codePageName(codePage.page)}, the code page set for ${fileName}, was not used: a code page is set only for a dBase table or delimited text.`] };
}

/**
 * A file opened from its read-out (jobs.ts `ReadOut`): the tables, columns, notes and rows the file
 * reader read from it beside the store. `part(n)` is the lines of the read-out's part n, null when
 * it is gone. The file keeps the last part it read until it reads the next, so a table is read with
 * one read of each of its parts.
 */
export function openReadOut(out: ReadOut, part: (n: number) => Promise<string[] | null>): OpenedFile {
  if (!("format" in out.read)) throw new UnreadableFile(out.read.unread.message, out.read.unread.reason);
  const read = out.read;
  let held: { n: number; lines: string[] } | null = null;
  async function lines(n: number): Promise<string[]> {
    if (held?.n === n) return held.lines;
    const got = await part(n);
    if (!got) throw new UnreadableFile(`Part of what the reader read from ${out.file.name} is gone from the store. Load the file again: the reader reads it once more.`, "damaged");
    held = { n, lines: got };
    return got;
  }
  /**
   * Up to `limit.rows` rows from the cursor, across the table's parts. The bytes a batch reads are
   * not counted, as the readers of a workbook and a database read whole do not count them: a batch
   * holds the rows the file itself would have given, which LOAD chooses a table's key column by. Where
   * the reader could not read on in a table, the batch after its last rows throws the reader's words,
   * as the file's own reader threw them to the reader at that batch.
   */
  async function rows(table: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    const t = read.parts[table];
    if (!t) throw new RangeError(`This file has no table ${table}.`);
    const end = t.first + t.parts;
    let at = cursor?.part ?? t.first;
    let line = cursor?.line ?? 0;
    if (at >= end && t.stopped) throw new UnreadableFile(t.stopped.message, t.stopped.reason);
    const taken: SourceRow[] = [];
    while (at < end && taken.length < limit.rows) {
      const all = await lines(at);
      while (line < all.length && taken.length < limit.rows) taken.push(sourceRowOf(all[line++]!));
      if (line >= all.length) {
        at++;
        line = 0;
      }
    }
    return { rows: taken, next: at < end || t.stopped ? { part: at, line } : null, deleted: 0 };
  }
  return { format: read.format, tables: read.tables, notes: read.notes, rows };
}

/**
 * A table's database, from its container: the container's name, and the table it names by the
 * table's own field names (dbc.ts). A file that is not a container names none.
 */
async function databaseOf(dbc: DatabaseFile, fileName: string): Promise<DbfDatabase> {
  if (dbc.unread) return { file: dbc.name, tableOf: null, unread: dbc.unread };
  if (dbc.tables === undefined && !dbc.source) return { file: dbc.name, tableOf: null, unread: "could not be read" };
  if (dbc.tables === undefined && dbc.source!.size > DBC_BYTES_MAX) return { file: dbc.name, tableOf: null, unread: `is larger than the ${DBC_BYTES_MAX >> 20} MB LOAD reads of a container` };
  // A read that fails is thrown, so LOAD reads the table and its container again (`readDbc`).
  const tables = dbc.tables !== undefined ? dbc.tables : await containerTables({ ...dbc, source: dbc.source! });
  return { file: dbc.name, tableOf: tables ? (headerNames) => dbcTableOf(tables, fileName, headerNames) : null };
}

/**
 * A file opened by the reader of a format already known. `depth` counts the zips it is inside, and
 * `budget` is what a zip may still inflate into memory to read the files inside it.
 */
async function openAs(
  format: SourceFormat,
  fileName: string,
  source: ByteSource,
  options: { memo?: ByteSource | null; dbc?: DatabaseFile | readonly DatabaseFile[] | null; depth: number; budget: number; codePage?: SetCodePage | null },
): Promise<OpenedFile> {
  const codePage = options.codePage ?? null;
  switch (format) {
    case "delimited":
      return openDelimited(source, { codePage });
    case "dbf":
      return openDbf(source, {
        fileName,
        codePage,
        ...(options.memo ? { memo: options.memo } : {}),
        ...(options.dbc ? { databases: await Promise.all((Array.isArray(options.dbc) ? options.dbc : [options.dbc]).map((d: DatabaseFile) => databaseOf(d, fileName))) } : {}),
      });
    case "xlsx":
      return openXlsx(source);
    case "ods": {
      const head = await source.read(0, 4);
      return openOds(source, { flat: !startsWith(head, ZIP) });
    }
    case "json":
      return openJson(source, { lines: LINES_EXTENSIONS.has(extensionOf(fileName)) });
    case "xml":
      return openXml(source);
    case "sqlite":
      return openSqlite(source);
    case "parquet":
      return openParquet(source);
    case "zip":
      return openArchive(source, fileName, { formatOf, open: openAs }, options.depth, options.budget, codePage);
    case "xls":
    case "access": {
      const cap = WHOLE_FILE_CAPS[format];
      if (source.size > cap) {
        throw new UnreadableFile(
          format === "access"
            ? `${fileName} is ${fileMb(source.size)}. An Access database is read whole inside the store, which takes one up to ${mb(cap)}. Export its tables to CSV and upload those: delimited text loads at any size.`
            : `${fileName} is ${fileMb(source.size)}. An Excel 97-2003 workbook is read whole inside the store, which takes one up to ${mb(cap)}. Save it as .xlsx, or each sheet as CSV, and upload that.`,
          "too-big",
        );
      }
      const bytes = await readAll(source);
      return format === "access" ? openAccess(bytes) : openExcel(bytes, "xls");
    }
  }
}
