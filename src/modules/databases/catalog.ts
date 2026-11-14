// A connection's catalog: the names of its tables and columns, as a test read
// them, kept in pages the `catalog.read` ask answers from.
//
// Three things happen to what the data runner read, before anything is kept:
//
//   A TYPE BECOMES ONE WORD. The engine's own type ("nvarchar(20)") is text the
//   database chose. An answer has no field for text, so the module reads the
//   type and keeps the word it belongs to, with its length as a count.
//
//   A NAME THAT DOES NOT FIT IS LEFT OUT AND COUNTED. A table's or a column's
//   name is kept only when it is a `name` as an answer can hold one. It is
//   never rewritten, cut or encoded: an encoding would let a name carry any
//   bytes past a shape, and a reader could no longer see what crossed.
//
//   THE REST IS CUT INTO PAGES, each small enough to be one answer.
//
// Nothing here ever sees a row. A test reads names, types and the engine's own
// estimate of how many rows a table has.

import type { ModuleStatePort } from "../../host/module-contract";
import { isName } from "../../host/shape";
import type { RunnerTable } from "./data-runner";
import {
  CATALOG_ITEM_COLUMNS_MAX,
  CATALOG_PAGE_TABLES_MAX,
  type ColumnType,
  type Engine,
  type TableKind,
} from "./manifest";

/** Most columns on one page, over all its tables. */
const PAGE_COLUMNS_MAX = 1_000;
/** Most characters of JSON one page's items come to. Well under what one
 *  answer may be on the connection. */
const PAGE_CHARS_MAX = 96 * 1024;

// ── A type, as one word ──────────────────────────────────────────────────────

export interface ColumnTypeView {
  type: ColumnType;
  length?: number;
  scale?: number;
}

/** A type's name without its sizes, lower case, with single spaces: the word
 *  before the brackets, and any words after them. */
function splitType(text: string): { base: string; sizes: number[] } {
  const open = text.indexOf("(");
  const close = open < 0 ? -1 : text.indexOf(")", open);
  const words = (open < 0 ? text : `${text.slice(0, open)} ${close < 0 ? "" : text.slice(close + 1)}`)
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(" ");
  const sizes: number[] = [];
  if (open >= 0 && close > open) {
    for (const part of text.slice(open + 1, close).split(",")) {
      const size = part.trim();
      // Digits only. "max", a list of an enum's values and anything else that
      // is not a size is no size.
      if (/^[0-9]{1,9}$/.test(size)) sizes.push(Number(size));
      else return { base: words, sizes: [] };
    }
  }
  return { base: words, sizes };
}

const TEXT_TYPES = new Set([
  "char", "nchar", "varchar", "nvarchar", "varchar2", "nvarchar2", "character", "character varying",
  "national character", "national character varying", "bpchar", "text", "ntext", "tinytext",
  "mediumtext", "longtext", "clob", "nclob", "long", "citext", "name", "string", "sysname",
  "uuid", "uniqueidentifier", "json", "jsonb", "xml", "xmltype", "enum", "set", "rowid", "urowid",
  "inet", "cidr", "macaddr",
]);
const WHOLE_NUMBER_TYPES = new Set([
  "int", "integer", "bigint", "smallint", "tinyint", "mediumint", "int2", "int4", "int8", "serial",
  "bigserial", "smallserial", "int unsigned", "integer unsigned", "bigint unsigned",
  "smallint unsigned", "tinyint unsigned", "mediumint unsigned", "year", "oid",
]);
const DECIMAL_TYPES = new Set([
  "decimal", "numeric", "number", "dec", "money", "smallmoney", "float", "real", "double",
  "double precision", "float4", "float8", "binary_float", "binary_double", "decimal unsigned",
  "float unsigned", "double unsigned",
]);
/** The decimal types that state how many digits they hold. */
const EXACT_DECIMAL_TYPES = new Set(["decimal", "numeric", "number", "dec", "decimal unsigned"]);
const DATE_TIME_TYPES = new Set([
  "datetime", "datetime2", "smalldatetime", "datetimeoffset", "timestamp without time zone",
  "timestamp with time zone", "timestamp with local time zone", "timestamptz",
]);
const TIME_TYPES = new Set(["time", "time without time zone", "time with time zone", "timetz"]);
const FLAG_TYPES = new Set(["bit", "boolean", "bool"]);
const BYTES_TYPES = new Set([
  "binary", "varbinary", "image", "blob", "tinyblob", "mediumblob", "longblob", "bytea", "raw",
  "long raw", "bfile", "rowversion",
]);

/**
 * The word a column's type belongs to, with its length and scale where the
 * type states them.
 *
 * Three types mean different things on different engines, so the engine is
 * asked: `timestamp` is a row's version on SQL Server and an instant
 * elsewhere; `date` holds a time of day on Oracle; `bit` is a flag only when
 * it is one bit wide.
 */
export function columnTypeOf(engine: Engine, engineType: string): ColumnTypeView {
  const { base, sizes } = splitType(engineType);
  const [first, second] = sizes;
  const withLength = (type: ColumnType): ColumnTypeView =>
    first === undefined ? { type } : { type, length: first };

  if (base === "timestamp") {
    return engine === "sqlserver" ? { type: "binary", length: 8 } : { type: "date_time" };
  }
  if (base === "date") return { type: engine === "oracle" ? "date_time" : "date" };
  if (base === "bit") {
    if (engine === "mysql" && first !== undefined && first > 1) return { type: "binary", length: first };
    return { type: "flag" };
  }
  if (base === "bit varying" || base === "varbit") return withLength("binary");
  // MySQL has no flag type of its own: a flag is written as a one-digit tinyint.
  if (engine === "mysql" && base === "tinyint" && first === 1) return { type: "flag" };

  if (TEXT_TYPES.has(base)) return withLength("characters");
  if (BYTES_TYPES.has(base)) return withLength("binary");
  if (WHOLE_NUMBER_TYPES.has(base)) return { type: "whole_number" };
  if (DECIMAL_TYPES.has(base)) {
    // Only a type that counts digits states them. A float's size is its bits.
    if (first === undefined || !EXACT_DECIMAL_TYPES.has(base)) return { type: "decimal" };
    // Digits with none after the point is a whole number, whatever it is
    // called. A type that states its digits and no scale has a scale of 0.
    if ((second ?? 0) === 0) return { type: "whole_number", length: first };
    return { type: "decimal", length: first, scale: second as number };
  }
  if (DATE_TIME_TYPES.has(base)) return { type: "date_time" };
  if (TIME_TYPES.has(base)) return { type: "time" };
  if (FLAG_TYPES.has(base)) return { type: "flag" };
  return { type: "other" };
}

// ── What is kept ─────────────────────────────────────────────────────────────

export interface CatalogColumn {
  name: string;
  type: ColumnType;
  nullable: boolean;
  length?: number;
  scale?: number;
  key?: number;
}

/** One table, or one run of a wide table's columns. */
export interface CatalogItem {
  schema: string;
  name: string;
  kind: TableKind;
  rows?: number;
  /** How many columns the table has in this reading. */
  columnCount: number;
  /** The place of this item's first column, from 0. */
  first: number;
  columns: CatalogColumn[];
}

export interface CatalogSummary {
  /** When the catalog was read from the database. */
  readAt: string;
  pages: number;
  tables: number;
  columns: number;
  leftOut: { tables: number; columns: number };
  truncated: boolean;
}

export interface CatalogReading extends CatalogSummary {
  items: CatalogItem[][];
}

const isKeptName = (value: string): boolean => value.length > 0 && isName(value);

/** Turn what a test read into what is kept: types as words, names that fit,
 *  and pages. */
export function readCatalog(
  engine: Engine,
  tables: readonly RunnerTable[],
  truncated: boolean,
  readAt: string,
): CatalogReading {
  const leftOut = { tables: 0, columns: 0 };
  const pages: CatalogItem[][] = [];
  let page: CatalogItem[] = [];
  let pageColumns = 0;
  let pageChars = 0;
  let keptTables = 0;
  let keptColumns = 0;

  const put = (item: CatalogItem): void => {
    const chars = JSON.stringify(item).length;
    const full =
      page.length >= CATALOG_PAGE_TABLES_MAX ||
      pageColumns + item.columns.length > PAGE_COLUMNS_MAX ||
      pageChars + chars > PAGE_CHARS_MAX;
    if (page.length > 0 && full) {
      pages.push(page);
      page = [];
      pageColumns = 0;
      pageChars = 0;
    }
    page.push(item);
    pageColumns += item.columns.length;
    pageChars += chars;
  };

  for (const table of tables) {
    if (!isKeptName(table.schema) || !isKeptName(table.name)) {
      leftOut.tables += 1;
      continue;
    }
    const columns: CatalogColumn[] = [];
    for (const column of table.columns) {
      if (!isKeptName(column.name)) {
        leftOut.columns += 1;
        continue;
      }
      const view = columnTypeOf(engine, column.type);
      columns.push({
        name: column.name,
        type: view.type,
        nullable: column.nullable,
        ...(view.length === undefined ? {} : { length: view.length }),
        ...(view.scale === undefined ? {} : { scale: view.scale }),
        ...(column.key === undefined ? {} : { key: column.key }),
      });
    }
    keptTables += 1;
    keptColumns += columns.length;
    const head = {
      schema: table.schema,
      name: table.name,
      kind: table.kind,
      ...(table.rows === null ? {} : { rows: table.rows }),
      columnCount: columns.length,
    };
    // A table with no column that can be shown is still a table.
    for (let first = 0; first === 0 || first < columns.length; first += CATALOG_ITEM_COLUMNS_MAX) {
      put({ ...head, first, columns: columns.slice(first, first + CATALOG_ITEM_COLUMNS_MAX) });
    }
  }
  if (page.length > 0) pages.push(page);
  return {
    readAt,
    pages: pages.length,
    tables: keptTables,
    columns: keptColumns,
    leftOut,
    truncated,
    items: pages,
  };
}

// ── Where it is kept ─────────────────────────────────────────────────────────
//
// In the module's own state, which the host keeps for one organization: one
// small document that says what the reading holds, and one for each page. A
// document's key is built from the connection's own id, never from its name.

interface StoredIndex extends CatalogSummary {
  /** Changes with every reading, so a page of one reading is never answered
   *  as a page of another. */
  reading: string;
}

interface StoredPage {
  reading: string;
  items: CatalogItem[];
}

/** A reading's summary and nothing else of the value it is read from. */
function summaryOf(from: CatalogSummary): CatalogSummary {
  return {
    readAt: from.readAt,
    pages: from.pages,
    tables: from.tables,
    columns: from.columns,
    leftOut: { tables: from.leftOut.tables, columns: from.leftOut.columns },
    truncated: from.truncated,
  };
}

const indexKey = (connectionId: string): string => `catalog-${connectionId}`;
const pageKey = (connectionId: string, page: number): string => `catalog-${connectionId}-${page}`;

/** A page was asked for while a newer reading was being written. */
export class CatalogChanged extends Error {
  constructor() {
    super("the catalog was read again while it was being paged through");
    this.name = "CatalogChanged";
  }
}

export async function saveCatalog(
  state: ModuleStatePort,
  connectionId: string,
  reading: CatalogReading,
  readingId: string,
): Promise<void> {
  const before = await state.read<StoredIndex | null>(indexKey(connectionId));
  // The pages first, then the document that points at them. A reader that
  // gets a page of this reading before the index names it is told the catalog
  // changed, and starts again.
  for (let page = 0; page < reading.items.length; page += 1) {
    // A position in the reading's own list of pages.
    // eslint-disable-next-line security/detect-object-injection
    const items = reading.items[page] as CatalogItem[];
    await state.write<StoredPage>(pageKey(connectionId, page), { reading: readingId, items });
  }
  await state.write<StoredIndex>(indexKey(connectionId), {
    ...summaryOf(reading),
    reading: readingId,
  });
  // A shorter reading leaves the longer one's last pages behind. State has no
  // way to remove a key, so each is overwritten with nothing.
  for (let page = reading.items.length; page < (before?.pages ?? 0); page += 1) {
    await state.write<null>(pageKey(connectionId, page), null);
  }
}

/** Forget a connection's catalog: it was removed, or it now names another
 *  database. */
export async function clearCatalog(state: ModuleStatePort, connectionId: string): Promise<void> {
  const before = await state.read<StoredIndex | null>(indexKey(connectionId));
  if (!before) return;
  await state.write<null>(indexKey(connectionId), null);
  for (let page = 0; page < before.pages; page += 1) {
    await state.write<null>(pageKey(connectionId, page), null);
  }
}

/**
 * One page of a connection's catalog. Null when no test of it has passed yet.
 * `page` 0 of a database with no tables is an empty page. Undefined `items`
 * means the page number is past the last one.
 */
export async function catalogPage(
  state: ModuleStatePort,
  connectionId: string,
  page: number,
): Promise<{ summary: CatalogSummary; items: CatalogItem[] | undefined } | null> {
  const index = await state.read<StoredIndex | null>(indexKey(connectionId));
  if (!index) return null;
  const { reading } = index;
  const summary = summaryOf(index);
  if (index.pages === 0) return { summary, items: page === 0 ? [] : undefined };
  if (page >= index.pages) return { summary, items: undefined };
  const stored = await state.read<StoredPage | null>(pageKey(connectionId, page));
  if (!stored || stored.reading !== reading) throw new CatalogChanged();
  return { summary, items: stored.items };
}
