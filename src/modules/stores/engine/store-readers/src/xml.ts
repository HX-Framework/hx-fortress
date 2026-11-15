// XML exports, read by range through one scanner (xml-scan.ts), with a cursor that is a byte
// offset in the file. Two kinds:
//
//   - An Excel 2003 XML spreadsheet ("XML Spreadsheet 2003", what older programs write for "Export
//     to Excel"): each worksheet with any values is a table, read like an .xlsx sheet (xlsx.ts):
//     its header is chosen among its first rows with values (header.ts), a title above the table
//     left out, a blank row keeps its number, a value is the cell's own (a date "2019-01-07", a
//     number to 15 digits, yes/no "true" or "false"), and a whole number in a zero-padded format
//     keeps its zeros ("06804").
//   - Records: a file whose elements repeat, such as Access's "Export to XML", an ADO recordset,
//     a .NET DataSet, or `<permits><permit>…</permit>…</permits>`. The records are the children
//     of the shallowest element that holds a repeated child; each name among them is a table
//     (Access writes one name per table). A record's attributes and child elements are its
//     columns: a nested element's children are "Owner.Name", a child that repeats is a JSON list,
//     an element named with Access's escapes ("Permit_x0020_No") reads "Permit No". A schema in the
//     file (XSD, as Access and .NET write it) gives the columns their types; otherwise a column's
//     type is "text".
//
// A date-time written the XML way, "2019-01-07T09:30:15" with no time zone, reads as the other
// readers write it: "2019-01-07 09:30:15", or "2019-01-07" at midnight. Other values are the
// file's text; an empty one is null. A record's row number counts from 1 among its table's records.

import { excelNumber, type Kind, kindOf, ZERO_PADDED } from "./cells.js";
import { chooseHeader, OPENING_ROWS, type OpeningRow } from "./header.js";
import type { ByteSource } from "./source.js";
import type { TextEncoding } from "./text.js";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SourceColumn, type SourceRow, type SourceTable, UnreadableFile } from "./types.js";
import { columnLetters, zeroPadded } from "./xlsx.js";
import { childrenOf, localName, textOf, XmlScanner, xmlEncoding, xmlOpening, type XmlNode, type XmlToken } from "./xml-scan.js";

const SAMPLE_ROWS = 2000;
/** How deep a record's elements become columns of their own; deeper ones are JSON. */
const FLAT_DEPTH = 3;
/** The deepest a record element can be found below the file's root element. */
const RECORD_DEPTH = 4;

type Open = Extract<XmlToken, { kind: "open" }>;

/** A date-time written the XML way, with no zone, as the readers write dates; anything else as it is. */
export function isoDateText(v: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?(\.\d+)?$/.exec(v);
  if (!m) return v;
  const time = `${m[2]}${m[3] ?? ":00"}${m[4] && Number(m[4]) ? m[4].replace(/0+$/, "") : ""}`;
  return time === "00:00:00" ? m[1]! : `${m[1]} ${time}`;
}

/** An element's name as a column's: without its prefix, with Access's and .NET's `_xHHHH_` escapes read. */
export function xmlColumnName(name: string): string {
  const local = localName(name);
  return local.indexOf("_x") < 0 ? local : local.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Attributes that are not values: namespace declarations and the schema-instance ones. */
const isMarkupAttribute = (name: string): boolean => name === "xmlns" || name.startsWith("xmlns:") || name.startsWith("xsi:");

const isNil = (node: XmlNode): boolean => node.attrs["xsi:nil"] === "true";

/** Whether an element holds elements, or attributes that are values. */
const isStructured = (node: XmlNode): boolean => node.content.some((c) => typeof c !== "string") || Object.keys(node.attrs).some((a) => !isMarkupAttribute(a));

/** An element as JSON: its text, or an object of its attributes and children, a child that repeats as a list. */
function nodeJson(node: XmlNode): unknown {
  if (isNil(node)) return null;
  if (!isStructured(node)) return textOf(node);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.attrs)) if (!isMarkupAttribute(k)) out[xmlColumnName(k)] = v;
  for (const c of childrenOf(node)) {
    const key = xmlColumnName(c.name);
    const value = nodeJson(c);
    if (key in out) {
      const had = out[key];
      out[key] = Array.isArray(had) && (had as { many?: true }).many ? (had.push(value), had) : Object.assign([had, value], { many: true as const });
    } else out[key] = value;
  }
  return out;
}

/** A record's values by column name: attributes, leaf children, nested children as "A.B", repeated children as JSON lists. */
export function recordFields(record: XmlNode): Map<string, string | null> {
  const out = new Map<string, string | null>();
  // An attribute and a child element of the same name both keep their values: the second is "id_2".
  const put = (name: string, value: string | null) => {
    let key = name;
    for (let k = 2; out.has(key); k++) key = `${name}_${k}`;
    out.set(key, value);
  };
  const walk = (node: XmlNode, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(node.attrs)) if (!isMarkupAttribute(k)) put(prefix + xmlColumnName(k), v === "" ? null : isoDateText(v));
    const kids = childrenOf(node);
    const counts = new Map<string, number>();
    for (const c of kids) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    const done = new Set<string>();
    for (const c of kids) {
      const name = prefix + xmlColumnName(c.name);
      if (counts.get(c.name)! > 1) {
        if (done.has(c.name)) continue;
        done.add(c.name);
        put(name, JSON.stringify(kids.filter((k) => k.name === c.name).map(nodeJson)));
      } else if (isNil(c)) put(name, null);
      else if (!isStructured(c)) {
        const text = textOf(c);
        put(name, text.trim() === "" ? null : isoDateText(text));
      } else if (depth >= FLAT_DEPTH) put(name, JSON.stringify(nodeJson(c)));
      else walk(c, `${name}.`, depth + 1);
    }
  };
  walk(record, "", 1);
  return out;
}

// ─── the schema a file may carry ─────────────────────────────────────────────

/** Column types by table and column, from an XSD schema in the file. */
type SchemaTypes = Map<string, Map<string, string>>;

const isSchema = (name: string): boolean => localName(name).toLowerCase() === "schema";

/** A schema element's type in words: Access's own ("text(30)", "currency"), else the XSD type's name ("double", "string(30)"). */
function schemaType(el: XmlNode): string | null {
  let type = el.attrs["od:jetType"] ?? el.attrs["type"] ?? null;
  let length: string | null = null;
  for (const c of childrenOf(el)) {
    if (localName(c.name) !== "simpleType") continue;
    for (const r of childrenOf(c)) {
      if (localName(r.name) !== "restriction") continue;
      type ??= r.attrs["base"] ?? null;
      for (const f of childrenOf(r)) if (localName(f.name) === "maxLength") length = f.attrs["value"] ?? null;
    }
  }
  if (!type) return null;
  const name = localName(type);
  return length && /^(text|string)$/i.test(name) ? `${name}(${length})` : name;
}

/** Every element with a name in a schema, and the named elements under it: a table and its columns. */
function schemaTypes(schema: XmlNode): SchemaTypes {
  const out: SchemaTypes = new Map();
  const visit = (node: XmlNode, table: string | null) => {
    for (const c of childrenOf(node)) {
      if (localName(c.name) === "element" && c.attrs["name"]) {
        const name = xmlColumnName(c.attrs["name"]);
        if (table) {
          const type = schemaType(c);
          if (type) {
            const columns = out.get(table) ?? new Map<string, string>();
            columns.set(name, type);
            out.set(table, columns);
          }
        }
        visit(c, name);
      } else visit(c, table);
    }
  };
  visit(schema, null);
  return out;
}

// ─── records ─────────────────────────────────────────────────────────────────

/** What a scan of the whole file says about one element path. */
interface PathStat {
  name: string;
  count: number;
  structured: boolean;
  /** Where its first element starts. */
  first: number;
  /** Its children's paths, in the order they first appear. */
  children: string[];
}

interface RecordTable {
  name: string;
  table: SourceTable;
  /** Where its first record starts, inside the container. */
  first: number;
  columns: string[];
}

async function openRecords(source: ByteSource, encoding: TextEncoding, start: number): Promise<OpenedFile> {
  // One pass over the whole file: how often each element path occurs, down to RECORD_DEPTH below the root.
  const stats = new Map<string, PathStat>();
  const stack: string[] = [];
  let schema: SchemaTypes = new Map();
  const scanner = new XmlScanner(source, encoding, start);
  let root: string | null = null;
  for (let t = await scanner.next(); t; t = await scanner.next()) {
    if (t.kind === "close") {
      stack.pop();
      continue;
    }
    if (t.kind !== "open") continue;
    if (isSchema(t.name)) {
      schema = schemaTypes(await scanner.element(t));
      continue;
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) stats.get(parent)!.structured = true;
    if (stack.length > RECORD_DEPTH) {
      await scanner.skip(t);
      continue;
    }
    const path = parent === undefined ? t.name : `${parent}/${t.name}`;
    let stat = stats.get(path);
    if (!stat) {
      stat = { name: t.name, count: 0, structured: false, first: t.start, children: [] };
      stats.set(path, stat);
      if (parent !== undefined) stats.get(parent)!.children.push(path);
      else root ??= path;
    }
    stat.count++;
    if (Object.keys(t.attrs).some((a) => !isMarkupAttribute(a))) stat.structured = true;
    if (!t.selfClosing) stack.push(path);
  }
  if (!root) throw new UnreadableFile("This XML file holds no elements.", "damaged");

  // The container: the shallowest element that occurs once and holds a child that repeats.
  let container: string | null = null;
  const queue = [root];
  while (queue.length && !container) {
    const path = queue.shift()!;
    const stat = stats.get(path)!;
    if (stat.count !== 1) continue;
    if (stat.children.some((c) => stats.get(c)!.count > 1)) container = path;
    else queue.push(...stat.children);
  }
  // No element repeats: each structured child of the root is a table of one row, or the root is one record.
  const notes: string[] = [];
  let recordPaths: string[];
  if (container) {
    recordPaths = stats.get(container)!.children.filter((c) => stats.get(c)!.structured || stats.get(c)!.count > 1);
    const left = stats.get(root)!.children.filter((c) => c !== container && !container!.startsWith(`${c}/`) && stats.get(c)!.structured);
    if (container !== root && left.length) notes.push(`Read the records inside <${xmlColumnName(stats.get(container)!.name)}>; the rest of the file (${left.map((c) => xmlColumnName(stats.get(c)!.name)).join(", ")}) is not loaded.`);
  } else {
    const structured = stats.get(root)!.children.filter((c) => stats.get(c)!.structured);
    container = structured.length ? root : null;
    recordPaths = structured;
  }

  const tables: RecordTable[] = [];
  if (!container) {
    // The root element is the one record: its values are read from the root itself.
    const stat = stats.get(root)!;
    const reader = new XmlScanner(source, encoding, stat.first);
    const open = (await reader.next()) as Open;
    const fields = recordFields(await reader.element(open));
    const columns = [...fields.keys()];
    if (!columns.length) throw new UnreadableFile("This XML file holds no values a store can read as a table.", "unsupported");
    const name = xmlColumnName(stat.name);
    tables.push({ name: stat.name, first: stat.first, columns, table: { name, columns: columns.map((c) => ({ name: c, originalType: "text" })), rowCount: 1, notes: [] } });
    return recordsFile(source, encoding, tables, notes, true);
  }

  for (const path of recordPaths) {
    const stat = stats.get(path)!;
    const name = xmlColumnName(stat.name);
    const reader = new XmlScanner(source, encoding, stat.first);
    const columns: string[] = [];
    const seen = new Set<string>();
    let sampled = 0;
    let depth = 0;
    for (let t = await reader.next(); t && sampled < SAMPLE_ROWS; t = await reader.next()) {
      if (t.kind === "close") {
        if (depth === 0) break;
        depth--;
        continue;
      }
      if (t.kind !== "open") continue;
      if (t.name !== stat.name) {
        await reader.skip(t);
        continue;
      }
      for (const field of recordFields(await reader.element(t)).keys()) if (!seen.has(field)) seen.add(field), columns.push(field);
      sampled++;
    }
    const types = schema.get(name);
    tables.push({
      name: stat.name,
      first: stat.first,
      columns,
      table: { name, columns: columns.map((c) => ({ name: c, originalType: types?.get(c) ?? "text" })), rowCount: stat.count, notes: [] },
    });
  }
  return recordsFile(source, encoding, tables, notes, false);
}

/** The records' tables, opened: each read from its first record on, skipping the others' records. */
function recordsFile(source: ByteSource, encoding: TextEncoding, tables: RecordTable[], notes: string[], rootIsRecord: boolean): OpenedFile {
  async function rows(index: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    const t = tables[index];
    if (!t) throw new RangeError(`This file has no table ${index}.`);
    const from = cursor?.at ?? t.first;
    let n = cursor?.row ?? 1;
    const reader = new XmlScanner(source, encoding, from);
    const known = new Set(t.columns);
    const out: SourceRow[] = [];
    let depth = 0;
    let ended = false;
    while (out.length < limit.rows) {
      const tok = await reader.next();
      if (!tok) {
        ended = true;
        break;
      }
      if (tok.kind === "close") {
        if (depth === 0) {
          ended = true;
          break;
        }
        depth--;
        continue;
      }
      if (tok.kind !== "open") continue;
      if (tok.name !== t.name) {
        await reader.skip(tok);
        continue;
      }
      const fields = recordFields(await reader.element(tok));
      const values = t.columns.map((c) => fields.get(c) ?? null);
      let extra: Record<string, string> | undefined;
      for (const [k, v] of fields) if (v != null && !known.has(k)) (extra ??= {})[k] = v;
      out.push(extra ? { n, values, extra } : { n, values });
      n++;
      if (rootIsRecord) {
        ended = true;
        break;
      }
      if (limit.bytes && reader.offset - from >= limit.bytes) break;
    }
    return { rows: out, next: ended ? null : { at: reader.offset, row: n }, deleted: 0 };
  }
  return { format: "xml", tables: tables.map((t) => t.table), notes, rows };
}

// ─── Excel 2003 XML spreadsheets ─────────────────────────────────────────────

interface SheetCell {
  text: string;
  kind: Kind;
}

/** A SpreadsheetML cell's value, from its `Data` element and its style's number format. */
function sheetCell(cell: XmlNode, formats: ReadonlyMap<string, string>): SheetCell | null {
  const data = childrenOf(cell).find((c) => localName(c.name) === "Data");
  if (!data) return null;
  const type = data.attrs["ss:Type"] ?? data.attrs["Type"] ?? "String";
  const raw = textOf(data);
  switch (type) {
    case "Number": {
      const n = Number(raw);
      if (!Number.isFinite(n) || raw.trim() === "") return raw.trim() ? { text: raw, kind: "text" } : null;
      const style = cell.attrs["ss:StyleID"] ?? cell.attrs["StyleID"];
      const fmt = style ? formats.get(style) : undefined;
      if (fmt === "@") return { text: excelNumber(n), kind: "text" };
      if (fmt && ZERO_PADDED.test(fmt) && Number.isInteger(n) && n >= 0) return { text: zeroPadded(fmt, n), kind: "text" };
      return { text: excelNumber(n), kind: "number" };
    }
    case "DateTime": {
      // Excel writes a time of day on its day zero, 1899-12-31.
      const text = isoDateText(raw.trim().replace(/Z$/, "").replace(/\.0+$/, ""));
      if (text.startsWith("1899-12-31 ")) return { text: text.slice(11), kind: "date" };
      if (text === "1899-12-31") return { text: "00:00:00", kind: "date" };
      return text ? { text, kind: "date" } : null;
    }
    case "Boolean":
      return { text: raw.trim() === "1" || raw.trim().toLowerCase() === "true" ? "true" : "false", kind: "yes/no" };
    case "Error":
      return raw.trim() ? { text: raw.trim(), kind: "error" } : null;
    default:
      return raw.trim() === "" ? null : { text: raw, kind: "text" };
  }
}

/** A Row's cells by column index (0 for column A), placed by `ss:Index` and `ss:MergeAcross`. */
function sheetCells(row: XmlNode, formats: ReadonlyMap<string, string>): Map<number, SheetCell> {
  const cells = new Map<number, SheetCell>();
  let col = 0;
  for (const c of childrenOf(row)) {
    if (localName(c.name) !== "Cell") continue;
    const index = Number(c.attrs["ss:Index"] ?? c.attrs["Index"]);
    if (Number.isInteger(index) && index >= 1) col = index - 1;
    const value = sheetCell(c, formats);
    if (value) cells.set(col, value);
    col += 1 + Math.max(0, Number(c.attrs["ss:MergeAcross"] ?? c.attrs["MergeAcross"] ?? 0) || 0);
  }
  return cells;
}

interface SheetLayout {
  table: SourceTable;
  /** Where the rows after the header start, and the next row's number. */
  data: ReadCursor;
  firstCol: number;
  lastCol: number;
}

async function openSpreadsheetMl(source: ByteSource, encoding: TextEncoding, start: number): Promise<OpenedFile> {
  const formats = new Map<string, string>();
  const layouts: SheetLayout[] = [];
  const notes: string[] = [];
  const scanner = new XmlScanner(source, encoding, start);
  for (let t = await scanner.next(); t; t = await scanner.next()) {
    if (t.kind !== "open") continue;
    const local = localName(t.name);
    if (local === "Styles") {
      const styles = await scanner.element(t);
      for (const s of childrenOf(styles)) {
        const id = s.attrs["ss:ID"] ?? s.attrs["ID"];
        const fmt = childrenOf(s).find((c) => localName(c.name) === "NumberFormat");
        const code = fmt?.attrs["ss:Format"] ?? fmt?.attrs["Format"];
        if (id && code) formats.set(id, code);
      }
      continue;
    }
    if (local !== "Worksheet") continue;
    const name = t.attrs["ss:Name"] ?? t.attrs["Name"] ?? `Sheet${layouts.length + 1}`;
    let hidden = false;
    let header: { cells: Map<number, SheetCell>; data: ReadCursor; note: string | null } | null = null;
    // The worksheet's first rows with values, each with where the row after it starts, held until
    // its header is chosen among them.
    const first: { cells: Map<number, SheetCell>; row: number; after: number }[] = [];
    const kinds = new Map<number, Set<Kind>>();
    let firstCol = Number.POSITIVE_INFINITY;
    let lastCol = -1;
    let sampled = 0;
    /** A row under the header: its cells widen the table, and their kinds are its columns' types. */
    const sample = (cells: Map<number, SheetCell>): void => {
      for (const [c, v] of cells) {
        firstCol = Math.min(firstCol, c);
        lastCol = Math.max(lastCol, c);
        const set = kinds.get(c) ?? new Set<Kind>();
        set.add(v.kind);
        kinds.set(c, set);
      }
      sampled++;
    };
    /** The header among the rows held (header.ts); the rows held under it are sampled, and the rows above it are left out. */
    const chooseIn = (): { cells: Map<number, SheetCell>; data: ReadCursor; note: string | null } => {
      const choice = chooseHeader(first.map((r): OpeningRow => ({ n: r.row, values: [...r.cells.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) })));
      const h = first[choice.index]!;
      for (const c of h.cells.keys()) (firstCol = Math.min(firstCol, c)), (lastCol = Math.max(lastCol, c));
      for (const r of first.slice(choice.index + 1)) if (sampled < SAMPLE_ROWS) sample(r.cells);
      first.length = 0;
      return { cells: h.cells, data: { at: h.after, row: h.row + 1 }, note: choice.note };
    };
    // The worksheet's children: its Table, whose Rows are read, and its options, which say whether it is hidden.
    let depth = 0;
    for (let u = await scanner.next(); u; u = await scanner.next()) {
      if (u.kind === "close") {
        if (depth === 0) break;
        depth--;
        continue;
      }
      if (u.kind !== "open") continue;
      const what = localName(u.name);
      if (what === "Table" && depth === 0) {
        if (u.selfClosing) continue;
        let row = 0;
        for (let r = await scanner.next(); r; r = await scanner.next()) {
          if (r.kind === "close") break;
          if (r.kind !== "open") continue;
          if (localName(r.name) !== "Row") {
            await scanner.skip(r);
            continue;
          }
          const index = Number(r.attrs["ss:Index"] ?? r.attrs["Index"]);
          row = Number.isInteger(index) && index > row ? index : row + 1;
          const node = await scanner.element(r);
          if (sampled >= SAMPLE_ROWS) continue;
          const cells = sheetCells(node, formats);
          if (!cells.size) continue;
          if (header) {
            sample(cells);
            continue;
          }
          first.push({ cells, row, after: scanner.offset });
          if (first.length >= OPENING_ROWS) header = chooseIn();
        }
        continue;
      }
      if (what === "WorksheetOptions") {
        const options = await scanner.element(u);
        const visible = childrenOf(options).find((c) => localName(c.name) === "Visible");
        if (visible && /hidden/i.test(textOf(visible))) hidden = true;
        continue;
      }
      await scanner.skip(u);
    }
    if (!header && first.length) header = chooseIn();
    if (!header) {
      notes.push(`The sheet "${name}" has no values, so it makes no table.`);
      continue;
    }
    const columns: SourceColumn[] = [];
    for (let c = firstCol; c <= lastCol; c++) columns.push({ name: header.cells.get(c)?.text ?? `column ${c - firstCol + 1}`, originalType: kindOf(kinds.get(c)) });
    const tableNotes = [...(hidden ? [`The sheet "${name}" is hidden in the workbook.`] : []), ...(header.note ? [header.note] : [])];
    layouts.push({ table: { name, columns, rowCount: null, notes: tableNotes }, data: header.data, firstCol, lastCol });
  }
  if (!layouts.length && !notes.length) throw new UnreadableFile("This Excel XML file holds no worksheet.", "damaged");

  async function rows(index: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    const layout = layouts[index];
    if (!layout) throw new RangeError(`This workbook has no table ${index}.`);
    const from = cursor ?? layout.data;
    const reader = new XmlScanner(source, encoding, from.at!);
    // The row number the last Row read had; the next Row is one more unless it names its own.
    let row = from.row! - 1;
    const out: SourceRow[] = [];
    let ended = false;
    while (out.length < limit.rows) {
      const r = await reader.next();
      if (!r || r.kind === "close") {
        ended = true;
        break;
      }
      if (r.kind !== "open") continue;
      if (localName(r.name) !== "Row") {
        await reader.skip(r);
        continue;
      }
      const index = Number(r.attrs["ss:Index"] ?? r.attrs["Index"]);
      row = Number.isInteger(index) && index > row ? index : row + 1;
      const cells = sheetCells(await reader.element(r), formats);
      if (cells.size) {
        const values: (string | null)[] = [];
        for (let c = layout.firstCol; c <= layout.lastCol; c++) values.push(cells.get(c)?.text ?? null);
        const beyond = [...cells.keys()].filter((c) => c > layout.lastCol).sort((a, b) => a - b);
        if (beyond.length) for (let c = layout.lastCol + 1; c <= beyond[beyond.length - 1]!; c++) values.push(cells.get(c)?.text ?? null);
        let extra: Record<string, string> | undefined;
        for (const [c, cell] of cells) if (c < layout.firstCol) (extra ??= {})[`column ${columnLetters(c)}`] = cell.text;
        out.push(extra ? { n: row, values, extra } : { n: row, values });
      }
      if (limit.bytes && reader.offset - from.at! >= limit.bytes) break;
    }
    return { rows: out, next: ended ? null : { at: reader.offset, row: row + 1 }, deleted: 0 };
  }

  return { format: "xml", tables: layouts.map((l) => l.table), notes, rows };
}

/** Whether an XML file's opening is an Excel 2003 XML spreadsheet's. */
export function isSpreadsheetMl(opening: string): boolean {
  return /progid\s*=\s*"Excel\.Sheet"/i.test(opening) || (/<(?:ss:)?Workbook\b/.test(opening) && opening.includes("urn:schemas-microsoft-com:office:spreadsheet"));
}

/** An XML file, opened: an Excel 2003 XML spreadsheet's worksheets, or the file's records. */
export async function openXml(source: ByteSource): Promise<OpenedFile> {
  const head = await source.read(0, Math.min(source.size, 8192));
  const { encoding, start } = xmlEncoding(head);
  if (isSpreadsheetMl(xmlOpening(head))) return openSpreadsheetMl(source, encoding, start);
  return openRecords(source, encoding, start);
}
