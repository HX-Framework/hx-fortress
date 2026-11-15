// Access databases, .mdb (Access 97 to 2003) and .accdb (Access 2007 and later), read whole with
// mdb-reader: each of the database's own tables is a table, and its rows are read a batch at a
// time in the table's order. Linked and system tables are left out.
//
// Values are text: a date "2019-01-07" or "2019-02-14 10:45:00" (Access keeps no time zone, and
// neither does the store), a yes/no "true" or "false", currency with its four decimals, a number
// as it is held. OLE objects, binary columns and attachments are not loaded; the table's notes
// say which columns held them. A column's type in the catalog is Access's own: "text(20)",
// "datetime", "currency", "memo".
//
// mdb-reader reads a Node Buffer, which workerd gives a Worker under its `nodejs_compat` flag.

import MDBReader from "mdb-reader";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SourceRow, type SourceTable, UnreadableFile } from "./types.js";

type Column = ReturnType<ReturnType<MDBReader["getTable"]>["getColumns"]>[number];

/** Types whose values are bytes or attachments: never loaded. */
const NOT_LOADED = new Set(["ole", "binary", "complex"]);

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/**
 * Access's own type name, with a text column's length in characters: Access 2000 and later keep
 * two bytes a character, Access 97 (Jet 3) one.
 */
function accessType(c: Column, jet3: boolean): string {
  if (c.type === "text") return `text(${jet3 ? c.size : Math.round(c.size / 2)})`;
  if (c.type === "numeric" && c.precision != null) return `numeric(${c.precision},${c.scale ?? 0})`;
  if (c.type === "long" && c.autoLong) return "autonumber";
  return c.type;
}

/**
 * A Single (float32) as Access shows it: the shortest decimal that is the same float32. mdb-reader
 * gives it as a double, whose own digits show the float's error ("1.100000023841858" for 1.1).
 */
export function singleText(v: number): string {
  for (let digits = 1; digits <= 9; digits++) {
    const shortest = Number(v.toPrecision(digits));
    if (Math.fround(shortest) === v) return String(shortest);
  }
  return String(v);
}

function valueText(v: unknown, single: boolean): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v === "" ? null : v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? (single ? singleText(v) : String(v)) : null;
  if (typeof v === "bigint") return String(v);
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const day = `${pad(v.getUTCFullYear(), 4)}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    const time = v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds() ? ` ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}` : "";
    return day + time;
  }
  return null;
}

/** An Access database's bytes, opened: each of its own tables is a table. */
export function openAccess(bytes: Uint8Array): OpenedFile {
  let reader: MDBReader;
  try {
    reader = new MDBReader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (/password|encrypt/i.test(why)) throw new UnreadableFile("This database is protected with a password. Save a copy without one and upload that.", "unsupported");
    throw new UnreadableFile(`This Access database could not be read: ${why}`, "damaged");
  }
  // The database's version byte: 0 for Jet 3 (Access 97), higher for Jet 4 and ACE.
  const jet3 = bytes[0x14] === 0;
  const tables: SourceTable[] = [];
  const loaded: { table: ReturnType<MDBReader["getTable"]>; columns: { name: string; single: boolean }[] }[] = [];
  try {
    for (const name of reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false })) {
      const table = reader.getTable(name);
      const columns = table.getColumns();
      const skipped = columns.filter((c) => NOT_LOADED.has(c.type));
      const notes = skipped.length ? [`${skipped.map((c) => c.name).join(", ")} hold${skipped.length > 1 ? "" : "s"} files or binary values, which a store does not load.`] : [];
      tables.push({ name, columns: columns.map((c) => ({ name: c.name, originalType: accessType(c, jet3) })), rowCount: table.rowCount, notes });
      loaded.push({ table, columns: columns.map((c) => ({ name: c.name, single: c.type === "float" })) });
    }
  } catch (err) {
    throw new UnreadableFile(`This Access database could not be read: ${err instanceof Error ? err.message : String(err)}`, "damaged");
  }

  async function rows(index: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    const t = loaded[index];
    if (!t) throw new RangeError(`This database has no table ${index}.`);
    const from = cursor?.row ?? 0;
    let data: Record<string, unknown>[];
    try {
      data = t.table.getData({ rowOffset: from, rowLimit: limit.rows }) as Record<string, unknown>[];
    } catch (err) {
      // A damaged page: mdb-reader fails on it the same way each time.
      throw new UnreadableFile(`Row ${from + 1} on of ${tables[index]!.name} could not be read: ${err instanceof Error ? err.message : String(err)}`, "damaged");
    }
    const out: SourceRow[] = data.map((record, i) => ({
      n: from + i + 1,
      values: t.columns.map((c) => valueText(record[c.name], c.single)),
    }));
    const next = from + data.length;
    return { rows: out, next: data.length === limit.rows ? { row: next } : null, deleted: 0 };
  }

  return { format: "access", tables, notes: [], rows };
}
