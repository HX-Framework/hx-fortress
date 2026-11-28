// A Visual FoxPro database's container, its .dbc: itself a FoxPro table, one row for each object of
// the database. A table's row (OBJECTTYPE "Table") holds the table's long name, and the rows of its
// fields (OBJECTTYPE "Field", PARENTID the table's OBJECTID) hold their long names, in the table's
// field order. A table of a database keeps only the first 10 characters of each field's name in its
// own header, so LOAD reads a .dbf with its database's container and takes the long names back.
//
// A table finds its row by its fields: the database's table whose fields, all of them and in order,
// begin as the table's own names do. Two such tables (two tables of one layout) are told apart by
// the file's name; a table no row fits keeps the names its header gives. Only the container's own
// columns are read: its memo file (.dct), which holds each object's properties, is not needed.

import { dbfInteger, type DbfField, readDbfHeader } from "./dbf.js";
import type { ByteSource } from "./source.js";
import { decode } from "./text.js";
import { UnreadableFile } from "./types.js";

/** One table of a database, by its long names. */
export interface DbcTable {
  name: string;
  /** Its fields' long names, in the table's field order. */
  fields: string[];
  /**
   * The same names read as a table's header reads its own (Windows-1252), so a header's name and
   * its long name compare as the same bytes in a database of any code page. `readDbc` fills it;
   * without it the names are compared as they are.
   */
  keys?: string[];
}

/** The largest container LOAD reads: a database of hundreds of tables and thousands of fields is a few MB. */
export const DBC_BYTES_MAX = 16 << 20;

/** How many characters of a field's long name a table's own header keeps. */
const HEADER_NAME_CHARS = 10;

/**
 * The tables a database's container names, with their fields' long names, in the container's
 * order. Null for a file that is not a container: no table header, or none of its four columns. A
 * read that fails (the bucket did not answer) is thrown, so LOAD reads the container again.
 */
export async function readDbc(source: ByteSource): Promise<DbcTable[] | null> {
  if (source.size > DBC_BYTES_MAX) return null;
  const h = await readDbfHeader(source).catch((err: unknown) => {
    if (err instanceof UnreadableFile) return null;
    throw err;
  });
  if (!h) return null;
  const column = (name: string): DbfField | undefined => h.fields.find((f) => f.name.toUpperCase() === name);
  const id = column("OBJECTID");
  const parent = column("PARENTID");
  const type = column("OBJECTTYPE");
  const name = column("OBJECTNAME");
  if (id?.type !== "I" || parent?.type !== "I" || type?.type !== "C" || name?.type !== "C") return null;
  const records = Math.max(0, Math.min(h.records, Math.floor((source.size - h.headerLength) / h.recordLength)));
  const bytes = records > 0 ? await source.read(h.headerLength, records * h.recordLength) : new Uint8Array(0);
  const text = (record: Uint8Array, f: DbfField): string => decode(record.subarray(f.offset, f.offset + f.length), { kind: "code-page", page: h.codePage }).replace(/\0+$/, "").trim();
  const integer = (record: Uint8Array, f: DbfField): number => dbfInteger(record.subarray(f.offset, f.offset + 4), h.level7);
  const asHeaderReads = (record: Uint8Array, f: DbfField): string => decode(record.subarray(f.offset, f.offset + f.length), { kind: "code-page", page: 1252 }).replace(/\0+$/, "").trim();
  const tables = new Map<number, DbcTable>();
  const fields: { parent: number; name: string; key: string }[] = [];
  for (let r = 0; r < records; r++) {
    const record = bytes.subarray(r * h.recordLength, (r + 1) * h.recordLength);
    // An object the database dropped keeps its row, marked deleted.
    if (record[0] === 0x2a) continue;
    const objectName = text(record, name);
    if (!objectName) continue;
    const kind = text(record, type).toLowerCase();
    if (kind === "table") tables.set(integer(record, id), { name: objectName, fields: [], keys: [] });
    else if (kind === "field") fields.push({ parent: integer(record, parent), name: objectName, key: asHeaderReads(record, name) });
  }
  for (const f of fields) {
    const table = tables.get(f.parent);
    table?.fields.push(f.name);
    table?.keys?.push(f.key);
  }
  return [...tables.values()].filter((t) => t.fields.length > 0);
}

/**
 * Whether a header's field name is the start of a long name: its first 10 characters, without
 * regard to case. A short name the header made unique with a number in its last places
 * (`INSPECTIO1`) fits a long name that begins with the rest.
 */
function begins(headerName: string, longName: string): boolean {
  const header = headerName.toUpperCase();
  // Cut before upper-casing: a letter can upper-case to two ("ß" to "SS").
  if (longName.slice(0, HEADER_NAME_CHARS).toUpperCase() === header) return true;
  const numbered = headerName.length === HEADER_NAME_CHARS ? /^(.+?)\d+$/.exec(headerName) : null;
  return !!numbered && longName.length > HEADER_NAME_CHARS && longName.toUpperCase().startsWith(numbered[1]!.toUpperCase());
}

/** Whether every letter and digit of a short name stands in a long name in its order: `perm2019` in `permits_2019`. */
function abbreviates(short: string, long: string): boolean {
  let at = 0;
  for (const c of short.replace(/[^\p{L}\p{N}]/gu, "")) {
    at = long.indexOf(c, at) + 1;
    if (at === 0) return false;
  }
  return true;
}

/**
 * The database's table a .dbf is, by its header's field names: the one whose fields begin as those
 * names do, all of them and in order. Of several, the one the file is named; else the one whose
 * name begins with the file's; else the one the file's name abbreviates (`perm2019.dbf` for
 * `permits_2019`); else none.
 */
export function dbcTableOf(tables: readonly DbcTable[], fileName: string, headerNames: readonly string[]): DbcTable | null {
  const fits = tables.filter((t) => t.fields.length === headerNames.length && (t.keys ?? t.fields).every((long, i) => begins(headerNames[i]!, long)));
  if (fits.length <= 1) return fits[0] ?? null;
  const stem = fileName
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]*$/, "")
    .toLowerCase();
  for (const named of [(t: DbcTable) => t.name.toLowerCase() === stem, (t: DbcTable) => t.name.toLowerCase().startsWith(stem), (t: DbcTable) => abbreviates(stem, t.name.toLowerCase())]) {
    const found = fits.filter(named);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) return null;
  }
  return null;
}
