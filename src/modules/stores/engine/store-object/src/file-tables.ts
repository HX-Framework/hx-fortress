// A store's file read as tables, for its preview on the Files tab and for an agent's look at a
// database or a Parquet file: an Excel or OpenDocument workbook's sheets, an Access or SQLite
// database's tables, a Parquet file, a dBase table, and the first rows of one of them. LOAD's own
// readers open it here, in the store's object, from the bucket by range, so the preview shows what a
// load would make of it, under the caps LOAD holds to in this object. No other process opens the
// file: an .xlsx or .ods is a zip, and whatever serves many organizations never opens a zip a person
// uploaded. Nothing is written. A file is read whole only where its kind is read whole (an .xls
// workbook, an Access database), within the readers' own caps.

import { extensionOf, openFile, type OpenFileOptions, readDbfHeader, UnreadableFile, windowedSource, type ByteSource } from "../../store-readers/src/index.js";
import { StoreError, type StoreCore } from "./core.js";
import { fileBytes, listFiles, StoreFileError } from "./files.js";
import { FILE_TABLE_EXTENSIONS, FILE_TABLE_ROWS, type FileTables, type FileTablesBody, type StoredFile } from "./types.js";

/** How much of the file one batch of rows may read where the format reads by range. */
const BATCH_BYTES = 4 << 20;
/** A read keeps the last few windows of the file it read, a megabyte each. */
const WINDOW_BYTES = 1 << 20;
const WINDOWS_KEPT = 8;

/** Why a file's tables were not read: a code the gateway's clients know (`StoreGatewayErrorCode`). */
export type FileTablesRefusalCode = "file_not_found" | "file_not_ready" | "file_not_tables" | "file_unreadable";

/** Whether a preview reads a file as tables, by its name. */
export const readsAsTables = (name: string): boolean => FILE_TABLE_EXTENSIONS.includes(extensionOf(name));

const MEMO = /\.(fpt|dbt)$/i;
/** How many files of the name a table's header gives are offered as its container, as LOAD offers them. */
const CONTAINERS_OFFERED = 5;
const stemOf = (name: string): string => name.replace(/\.[^.]+$/, "").toLowerCase();

/** A ready file of the store, by range through windows. */
function sourceOf(core: StoreCore, file: StoredFile): ByteSource {
  return windowedSource(fileBytes(core, file.id), WINDOW_BYTES, WINDOWS_KEPT);
}

/**
 * What LOAD reads a dBase or FoxPro table with, so its preview shows the same: the memo file of its
 * name from its own upload, and the database containers of the name its header gives, its own
 * upload's first, then its folder's, then the newest (`containersFor` in jobs/load.ts).
 */
async function readWith(core: StoreCore, file: StoredFile, files: readonly StoredFile[], source: ByteSource): Promise<OpenFileOptions> {
  if (extensionOf(file.name) !== "dbf") return {};
  const others = files.filter((f) => f.state === "ready" && f.id !== file.id);
  const sameUpload = (f: StoredFile): boolean => file.batch !== null && f.batch === file.batch;
  const memo = others.find((f) => (sameUpload(f) || (file.batch === null && f.batch === null && f.folderId === file.folderId)) && MEMO.test(f.name) && stemOf(f.name) === stemOf(file.name));
  const link = (await readDbfHeader(source).catch(() => null))?.backlink;
  const wanted = link?.replace(/^.*[\\/]/, "").toLowerCase();
  const rank = (f: StoredFile): number => (sameUpload(f) ? 0 : f.folderId === file.folderId ? 1 : 2);
  const named = wanted
    ? others
        .filter((f) => f.name.toLowerCase() === wanted)
        .sort((a, b) => rank(a) - rank(b) || b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, CONTAINERS_OFFERED)
    : [];
  return {
    ...(memo ? { memo: sourceOf(core, memo) } : {}),
    ...(named.length ? { dbc: named.map((f) => ({ id: f.id, name: f.name, source: sourceOf(core, f) })) } : {}),
  };
}

/** The file's tables, and the first FILE_TABLE_ROWS rows of the one at `body.table` (the first when it names none there). */
export async function fileTables(core: StoreCore, fileId: string, body: FileTablesBody): Promise<FileTables> {
  const files = listFiles(core);
  const file = files.find((f) => f.id === fileId);
  if (!file) throw new StoreFileError(404, "file_not_found", "This store has no such file.");
  if (!readsAsTables(file.name)) throw new StoreError(400, "file_not_tables" satisfies FileTablesRefusalCode, `${file.name} is not a workbook, a database or a Parquet file.`);
  if (file.state !== "ready") throw new StoreFileError(409, "file_not_ready", `${file.name} is still uploading.`);
  const source = sourceOf(core, file);
  try {
    const opened = await openFile(file.name, source, await readWith(core, file, files, source));
    const tables = opened.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name), rows: t.rowCount }));
    if (tables.length === 0) return { tables, table: 0, rows: [], more: false, notes: opened.notes };
    const asked = body.table;
    const at = typeof asked === "number" && Number.isInteger(asked) && asked >= 0 && asked < tables.length ? asked : 0;
    const batch = await opened.rows(at, null, { rows: FILE_TABLE_ROWS + 1, bytes: BATCH_BYTES });
    return {
      tables,
      table: at,
      rows: batch.rows.slice(0, FILE_TABLE_ROWS).map((r) => r.values),
      more: batch.rows.length > FILE_TABLE_ROWS || batch.next !== null,
      notes: opened.notes,
    };
  } catch (err) {
    if (err instanceof UnreadableFile) throw new StoreError(422, "file_unreadable" satisfies FileTablesRefusalCode, err.message);
    throw err;
  }
}
