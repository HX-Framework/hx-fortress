// The SQL that measures a store's columns: the one profile's statements (profile.ts). Every
// statement here only reads. A store's own PROFILE job runs them on its SQLite over every row, a
// store answers a table's profile with them for a page, and a reader that reaches a store only
// through its `query` door runs them there: one set of statements, so every place counts the same
// rows.
//
// What a store's SQLite asks of a statement:
//   - a double-quoted name that matches no column is read as text, so names go in backticks;
//   - a result holds at most 100 columns;
//   - a LIKE or GLOB pattern is at most 50 bytes;
//   - a statement is at most 100 KB;
//   - one compound SELECT has at most 5 terms ("too many terms in compound SELECT"): `unionAll`
//     nests a longer chain.
//
// A table is named through `main.` (`tableRef`), and a column a LOAD packed into `_extra` is read
// out of `_extra` here (`packedValue`), not by its bare name: a store's door serves a packed column
// by a WITH of the table's name, which `main.` reads past.
//
// A value is text with stray spaces, so every value is read trimmed, and an empty cell and a cell
// of spaces both count as no value. What reads as a number or as a day is the store's own test
// (`numberSql`, `isoDateSql` in jobs.ts).
//
// What a statement costs a store, which is one object with little memory:
//   - a table is read once. A census and a link first group a column's values (`GROUP BY v`, AS
//     MATERIALIZED), and every number is then read from the groups: the store keeps one copy of
//     the column's different values, never one row per row. Without MATERIALIZED SQLite reads the
//     table again for each part of the statement;
//   - an expression is evaluated once per row. SQLite writes a subquery's expressions into the
//     query around it, so `trim(...)` named `v` and used ten times is trimmed ten times. A subquery
//     with a LIMIT inside another with a LIMIT is left as it is, and one with no FROM is too:
//     `rangesSql`, `binsSql` and the readings use that. Measured on a store under a local workerd,
//     four ranges over 6,038 rows: 261 ms written plainly, 25 ms so.
//
// `rows` caps how many of a table's rows a statement reads: a page's profile reads up to
// PROFILE_ROWS_MAX, and a PROFILE job reads every row (null).

import { EXTRA_COLUMN, dateTextSql, isoDateSql, numberSql, numberValueSql, realDaySql, trimmedSql } from "./jobs.js";

/**
 * The most rows of a table one profile reads when it is asked to stop somewhere: a bigger table is
 * read up to here, and the profile says so. The rows are the table's first as SQLite stores them
 * (`LIMIT` with no `ORDER BY`): a table a LOAD made keeps its file's order, and sorting 200,000 rows
 * to pick them would cost more than the reading.
 */
export const PROFILE_ROWS_MAX = 200_000;
/** The longest value a profile quotes. */
export const QUOTE_CHARS = 120;
/** The most common values a profile keeps per column. */
export const TOP_VALUES = 8;
/**
 * The ways of writing a profile keeps per column. A column of days, numbers or money has far fewer
 * (one per count of digits), so past this many a column is free text or close to it.
 */
export const TOP_SHAPES = 120;
/** Values with no match that a link's answer quotes. */
export const UNMATCHED_EXAMPLES = 5;
/** The most bars a column's histogram has. */
export const BINS_MAX = 12;

/** The most terms one compound SELECT may have in a store's SQLite. */
export const COMPOUND_TERMS_MAX = 5;
/** The most columns one result may have in a store's SQLite. */
const RESULT_COLUMNS_MAX = 100;

/** A cap of rows as a LIMIT clause; none for every row. */
const limitOf = (rows: number | null): string => (rows === null ? "" : ` LIMIT ${Math.max(0, Math.floor(rows))}`);

/**
 * SELECTs joined by UNION ALL, however many: past COMPOUND_TERMS_MAX they are grouped, each group a
 * subquery, so no compound has more terms than a store takes. The first SELECT names the columns.
 */
export function unionAll(selects: readonly string[]): string {
  if (selects.length <= COMPOUND_TERMS_MAX) return selects.join("\nUNION ALL ");
  const size = Math.ceil(selects.length / COMPOUND_TERMS_MAX);
  const groups: string[] = [];
  for (let i = 0; i < selects.length; i += size) groups.push(`SELECT * FROM (${unionAll(selects.slice(i, i + size))})`);
  return groups.join("\nUNION ALL ");
}

/** A table's or a column's name as SQL takes it. */
export const ident = (name: string): string => `\`${name.replace(/`/g, "``")}\``;

/**
 * A table of the store as a FROM clause names it: through `main.`, so a table that happens to be
 * called like one of this file's own WITH names (`g`, `pointing`) is still the table.
 */
export const tableRef = (name: string): string => `main.${ident(name)}`;

/**
 * A column a statement reads: one of the table's own, or one a LOAD packed into `_extra` because
 * the file had more columns than a table holds (a file's columns past its 90th).
 */
export type ColumnRef = {
  name: string;
  packed?: boolean;
};

/** A packed column's value, read from `_extra` as a store reads it: a name JSON's path cannot hold is looked up by key. */
function packedValue(name: string): string {
  const text = name.replace(/'/g, "''");
  if (/["\\]/.test(name)) return `(SELECT j.value FROM json_each(${ident(EXTRA_COLUMN)}) AS j WHERE j.key = '${text}')`;
  return `json_extract(${ident(EXTRA_COLUMN)}, '$."${text}"')`;
}

/** A column as the innermost SELECT of a statement reads it from its table: under its own name either way. */
export const rawOf = (column: ColumnRef): string => (column.packed ? `${packedValue(column.name)} AS ${ident(column.name)}` : ident(column.name));

/** A column's value as trimmed text; '' for an empty cell. `column` is a name, quoted here. */
export function valueOf(column: string): string {
  const c = ident(column);
  // A whole number kept as REAL casts to "5.0": read it as "5", as an INTEGER 5 in another table reads.
  // A REAL SQLite writes with an exponent (0.00001 as "1.0e-05", 1e20 as "1.0e+20") is written out in
  // digits, so it reads as the number it is.
  return `coalesce(CASE WHEN typeof(${c}) = 'real' AND ${c} = CAST(${c} AS INTEGER) THEN CAST(CAST(${c} AS INTEGER) AS TEXT) WHEN typeof(${c}) = 'real' AND instr(CAST(${c} AS TEXT), 'e') > 0 THEN rtrim(rtrim(printf('%.20f', ${c}), '0'), '.') ELSE ${trimmedSql(c)} END, '')`;
}

/**
 * How text `v` is written: every digit becomes 9 and nothing else changes, so "2021-03-14" and
 * "2019-11-02" are both `9999-99-99`, and "3/14/2021" is `9/99/9999`. Counting a column's values
 * by this tells its formats apart without one pattern per format.
 */
export function shapeOf(v: string): string {
  let out = v;
  for (const digit of "012345678") out = `replace(${out}, '${digit}', '9')`;
  return out;
}

/**
 * How several columns of a table are written, over its first `rows` rows, in one statement: rows of
 * `(c, a, n, f, x)`, `c` the column's place in `columns`, `a` a shape (`shapeOf`: every digit as 9),
 * `n` its rows, `f` the column's rows with a value, `x` one value written so, cut to `exampleChars`
 * (NULL where values are not read). The one SQL writer reads it to tell its model each column's
 * formats (sql-writer/describe.ts), which it names with `readColumn`, as a profile names them.
 */
export function formatsSql(table: string, columns: readonly string[], rows: number, opts: { values: boolean; shapes: number; exampleChars: number }): string {
  const branch = (column: string, i: number): string =>
    `SELECT * FROM (SELECT ${i} AS c, s AS a, count(*) AS n, sum(count(*)) OVER () AS f, ${opts.values ? `substr(min(v), 1, ${opts.exampleChars})` : "NULL"} AS x FROM (SELECT ${shapeOf("v")} AS s, v FROM (SELECT ${valueOf(column)} AS v FROM sample) WHERE v <> '') GROUP BY s ORDER BY n DESC, s LIMIT ${opts.shapes})`;
  return `WITH sample AS MATERIALIZED (SELECT ${columns.map(ident).join(", ")} FROM ${tableRef(table)} LIMIT ${rows})\n${unionAll(columns.map(branch))}`;
}

/**
 * Trimmed text `v` as a number, or NULL when it is not one: "$1,250.00" is 1250, and "N/A" is
 * NULL, never 0, so a sum or an average over the column counts only its numbers.
 */
export const numberOf = (v: string): string => `(CASE WHEN ${numberSql(v)} THEN ${numberValueSql(v)} END)`;

/** The rows of one column a profile reads, each value trimmed. */
const columnValues = (table: string, column: ColumnRef, rows: number | null): string => `SELECT ${valueOf(column.name)} AS v FROM (SELECT ${rawOf(column)} FROM ${tableRef(table)}${limitOf(rows)})`;

/** A column's different values, each with the rows that hold it (`c`): what a census and a link read. An empty cell is the value ''. */
const valueGroups = (table: string, column: ColumnRef, rows: number | null): string => `SELECT v, count(*) AS c FROM (${columnValues(table, column, rows)}) GROUP BY v`;

/**
 * A value as a person reads it alike in another case and with its spaces squeezed: "FINALED",
 * "Finaled" and " finaled " are one. SQLite's `lower` folds ASCII letters only.
 */
const looseCaseOf = (v: string): string => `lower(replace(replace(${v}, '  ', ' '), '  ', ' '))`;

/**
 * One column's census, as rows of `(k, a, n, x)`:
 *   rows      n: rows read
 *   filled    n: rows with a value
 *   distinct  n: different values
 *   spelled   n: different values once case and doubled spaces are set aside
 *   longest   n: the longest value's length
 *   repeated  n: values more than one row holds; x: the rows that hold them
 *   first     a: the smallest value as text
 *   last      a: the largest value as text
 *   value     a: one of the most common values; n: its rows
 *   shape     a: one of the most common ways of writing (see `shapeOf`); n: its rows; x: one value written so
 */
export function censusSql(table: string, column: ColumnRef, rows: number | null): string {
  return [
    `WITH g AS MATERIALIZED (${valueGroups(table, column, rows)})`,
    unionAll([
      `SELECT 'rows' AS k, NULL AS a, coalesce(sum(c), 0) AS n, NULL AS x FROM g`,
      `SELECT 'filled' AS k, NULL AS a, coalesce(sum(c), 0) AS n, NULL AS x FROM g WHERE v <> ''`,
      `SELECT 'distinct' AS k, NULL AS a, count(*) AS n, NULL AS x FROM g WHERE v <> ''`,
      `SELECT 'spelled' AS k, NULL AS a, count(DISTINCT ${looseCaseOf("v")}) AS n, NULL AS x FROM g WHERE v <> ''`,
      `SELECT 'longest' AS k, NULL AS a, coalesce(max(length(v)), 0) AS n, NULL AS x FROM g WHERE v <> ''`,
      `SELECT 'repeated' AS k, NULL AS a, count(*) AS n, coalesce(sum(c), 0) AS x FROM g WHERE v <> '' AND c > 1`,
      `SELECT 'first' AS k, substr(min(v), 1, ${QUOTE_CHARS}) AS a, NULL AS n, NULL AS x FROM g WHERE v <> ''`,
      `SELECT 'last' AS k, substr(max(v), 1, ${QUOTE_CHARS}) AS a, NULL AS n, NULL AS x FROM g WHERE v <> ''`,
      `SELECT * FROM (SELECT 'value' AS k, substr(v, 1, ${QUOTE_CHARS}) AS a, c AS n, NULL AS x FROM g WHERE v <> '' ORDER BY c DESC, v LIMIT ${TOP_VALUES})`,
      // A shape is worked out once per different value, not once per row.
      `SELECT * FROM (SELECT 'shape' AS k, substr(s, 1, ${QUOTE_CHARS}) AS a, sum(c) AS n, substr(min(v), 1, ${QUOTE_CHARS}) AS x FROM (SELECT ${shapeOf("v")} AS s, v, c FROM g WHERE v <> '') GROUP BY s ORDER BY sum(c) DESC, s LIMIT ${TOP_SHAPES})`,
    ]),
  ].join("\n");
}

/** The rows a census answers at most. */
export const CENSUS_ROWS = 8 + TOP_VALUES + TOP_SHAPES;

/** A column whose smallest and largest a profile reads: as numbers, or as days. */
export type RangedColumn = ColumnRef & {
  kind: "number" | "day";
};

/** Columns one `rangesSql` statement reads: each takes four of the result's columns. */
export const RANGE_COLUMNS_MAX = Math.floor(RESULT_COLUMNS_MAX / 4);

/** One step of a statement that SQLite keeps a step: a subquery with a LIMIT, so its expressions run once a row. */
const stepOf = (select: string, from: string, rows: number | null): string => `SELECT ${select} FROM (${from})${rows === null ? " LIMIT -1" : limitOf(rows)}`;

/**
 * The smallest and largest of several columns in one pass over the table. One row; for the column
 * at place `i`:
 *   a number  low<i>, high<i>, negative<i> (below zero), zero<i>
 *   a day     first<i>, last<i>, unread<i> (values written as a day that name no day, February 30),
 *             unreadx<i> (one of them)
 * At most RANGE_COLUMNS_MAX columns. Each step is a subquery with a LIMIT, so SQLite keeps it a step
 * and a value is trimmed, read as a day and checked against the calendar once per row.
 */
export function rangesSql(table: string, columns: readonly RangedColumn[], rows: number | null): string {
  const raw = `SELECT ${columns.map(rawOf).join(", ")} FROM ${tableRef(table)}${limitOf(rows)}`;
  const values = stepOf(columns.map((c, i) => `${valueOf(c.name)} AS v${i}`).join(", "), raw, rows);
  // A day is first written YYYY-MM-DD by its format (`t`), then held to the calendar (`x`).
  const written = stepOf(columns.map((c, i) => (c.kind === "number" ? `${numberOf(`v${i}`)} AS x${i}` : `${dateTextSql(`v${i}`)} AS t${i}, v${i}`)).join(", "), values, rows);
  const read = stepOf(columns.map((c, i) => (c.kind === "number" ? `x${i}` : `${realDaySql(`t${i}`)} AS x${i}, t${i} IS NOT NULL AS f${i}, v${i}`)).join(", "), written, rows);
  const ranges = columns
    .map((c, i) =>
      c.kind === "number"
        ? `min(x${i}) AS low${i}, max(x${i}) AS high${i}, coalesce(sum(x${i} < 0), 0) AS negative${i}, coalesce(sum(x${i} = 0), 0) AS zero${i}`
        : `min(x${i}) AS first${i}, max(x${i}) AS last${i}, coalesce(sum(f${i} AND x${i} IS NULL), 0) AS unread${i}, substr(min(CASE WHEN f${i} AND x${i} IS NULL THEN v${i} END), 1, ${QUOTE_CHARS}) AS unreadx${i}`,
    )
    .join(", ");
  return `SELECT ${ranges} FROM (${read})`;
}

/** How a column's histogram groups its values. */
export type BinsBy = "decade" | "year" | "month" | "range";

/**
 * A column's histogram, as rows of `(b, n)`: a bar's key and its rows, in order. A column of days
 * counts by decade, year or month (`b` is "2019", "2019-03" or "2010"); a column of numbers counts
 * in `count` bars of equal width from `low` to `high` (`b` is the bar's number from 0). Only values
 * that read so are counted.
 */
export function binsSql(table: string, column: ColumnRef, by: BinsBy, rows: number | null, range?: { low: number; high: number; count: number }): string {
  const raw = `SELECT ${rawOf(column)} FROM ${tableRef(table)}${limitOf(rows)}`;
  const values = stepOf(`${valueOf(column.name)} AS v`, raw, rows);
  if (by === "range") {
    const r = range ?? { low: 0, high: 0, count: 1 };
    const count = Math.max(1, Math.floor(r.count));
    const width = r.high > r.low ? (r.high - r.low) / count : 1;
    const read = stepOf(`${numberOf("v")} AS x`, values, rows);
    // The largest value falls in the last bar, not one past it.
    const bar = `CASE WHEN x >= ${r.high} THEN ${count - 1} ELSE CAST((x - (${r.low})) / ${width} AS INTEGER) END`;
    return `SELECT ${bar} AS b, count(*) AS n FROM (${read}) WHERE x IS NOT NULL GROUP BY b ORDER BY b`;
  }
  const read = stepOf(`${isoDateSql("v")} AS d`, values, rows);
  const key = by === "month" ? "substr(d, 1, 7)" : by === "year" ? "substr(d, 1, 4)" : "substr(d, 1, 3) || '0'";
  return `SELECT ${key} AS b, count(*) AS n FROM (${read}) WHERE d IS NOT NULL GROUP BY b ORDER BY b`;
}

/**
 * Whole rows that repeat another row. One row: `sets` (groups of equal rows) and `rows` (the rows
 * in them). A table a LOAD made carries `_hash`, a hash of each row's values, so its rows are
 * compared by that one short column; any other table is compared over the columns named.
 */
export function repeatedRowsSql(table: string, columns: readonly string[], hashed: boolean, rows: number | null): string {
  const list = hashed ? ident("_hash") : columns.map(ident).join(", ");
  return `SELECT count(*) AS sets, coalesce(sum(n), 0) AS rows FROM (SELECT count(*) AS n FROM (SELECT ${list} FROM ${tableRef(table)}${limitOf(rows)}) GROUP BY ${list} HAVING count(*) > 1)`;
}

/** A value as two tables may write it differently and mean the same: no dashes, spaces, dots or slashes, in capitals. */
export const looseOf = (v: string): string => `upper(replace(replace(replace(replace(${v}, '-', ''), ' ', ''), '.', ''), '/', ''))`;

/** One side of a link. A type, not an interface: it goes into a tool's JSON answer as it is. */
export type LinkEnd = {
  table: string;
  column: string;
};

/** One side of a link as its statement reads it: the column may be one a LOAD packed. */
export type LinkSide = LinkEnd & { packed?: boolean };

const sideColumn = (side: LinkSide): ColumnRef => ({ name: side.column, ...(side.packed ? { packed: true } : {}) });

/**
 * How well `from` points at `to`, in one statement that reads each table once, counted in rows.
 * Rows of `(k, a, n, filled, exact, loose, targets, unused)`:
 *   totals     n: rows of `from` read; filled: those with a value; exact: those whose value is one
 *              of `to`'s, character for character; loose: those that match only once dashes, spaces,
 *              dots, slashes and case are ignored; targets: different values of `to`; unused:
 *              values of `to` that no row of `from` names, either way
 *   unmatched  a: a value of `from` that matches nothing in `to`, most common first; n: its rows
 * `rows` caps the rows of `from` it reads. `to` is read whole: a row that points at a row past the
 * cap still finds it, so no row is counted as missing for where its row stands in `to`.
 */
export function linkSql(from: LinkSide, to: LinkSide, rows: number | null): string {
  const loose = looseOf("v");
  return [
    // The different values of the side that points, each with its rows; then each matched once.
    `WITH pointing AS MATERIALIZED (${valueGroups(from.table, sideColumn(from), rows)}),`,
    `target AS MATERIALIZED (SELECT v FROM (${valueGroups(to.table, sideColumn(to), null)}) WHERE v <> ''),`,
    // A value of only dashes or spaces reads loosely as nothing, and nothing matches nothing.
    `target_loose AS MATERIALIZED (SELECT DISTINCT ${loose} AS v FROM target WHERE ${loose} <> ''),`,
    `matched AS MATERIALIZED (SELECT v, c, v IN (SELECT v FROM target) AS e, (${loose} <> '' AND ${loose} IN (SELECT v FROM target_loose)) AS l FROM pointing WHERE v <> '')`,
    `SELECT 'totals' AS k, NULL AS a, (SELECT coalesce(sum(c), 0) FROM pointing) AS n, coalesce(sum(c), 0) AS filled, coalesce(sum(c * e), 0) AS exact, coalesce(sum(c * (NOT e AND l)), 0) AS loose, (SELECT count(*) FROM target) AS targets,`,
    `(SELECT count(*) FROM target WHERE v NOT IN (SELECT v FROM matched) AND (${loose} = '' OR ${loose} NOT IN (SELECT ${loose} FROM matched))) AS unused`,
    `FROM matched`,
    `UNION ALL`,
    `SELECT * FROM (SELECT 'unmatched' AS k, substr(v, 1, ${QUOTE_CHARS}) AS a, c AS n, NULL AS filled, NULL AS exact, NULL AS loose, NULL AS targets, NULL AS unused FROM matched WHERE NOT e AND NOT l ORDER BY c DESC, v LIMIT ${UNMATCHED_EXAMPLES})`,
  ].join("\n");
}

/** The rows a link's statement answers at most. */
export const LINK_ROWS = 1 + UNMATCHED_EXAMPLES;

/**
 * A store's quick look at a few columns of a table, as its catalog takes it: over the table's first
 * `rows` rows, how many rows (`n`), and per column how many are not NULL (`n<i>`) and how many
 * different values they hold (`d<i>`, each cut at 256 characters). Each column takes two of the
 * result's columns: call it for at most QUICK_COLUMNS_MAX columns at a time.
 */
export function quickLookSql(table: string, columns: readonly string[], rows: number): string {
  const parts = ["count(*) AS n"];
  columns.forEach((c, i) => parts.push(`count(${ident(c)}) AS n${i}`, `count(DISTINCT substr(CAST(${ident(c)} AS TEXT), 1, 256)) AS d${i}`));
  return `SELECT ${parts.join(", ")} FROM (SELECT ${columns.map(ident).join(", ")} FROM ${ident(table)}${limitOf(rows)})`;
}

/** The columns one `quickLookSql` reads: two counts each and the row count, within the result's 100. */
export const QUICK_COLUMNS_MAX = 49;
