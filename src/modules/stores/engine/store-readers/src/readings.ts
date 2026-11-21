// The two readings a statement for a store may name: `as_number(x)` reads text as a number, and
// `as_iso_date(x)` reads text as a day, where x is a column or any expression. Beside them is one
// function of the store's own, `stable_id(x)`, which makes an id from text that comes out the same
// on every run. A store's SQLite takes no functions of its own, so each call is written out as the
// SQL it stands for before the statement runs (`withReadings`). The store does this at its front
// door for every query, `exec` and SHAPE (store-object front-door.ts), and the Store gateway's
// client does it for every query and `exec` it sends (the stores package's client.ts). So a
// question, a program's step, Maya's `store_query`, a Notebook's `source_query` and a statement a
// person pastes all read a value the same way, by the store's own tests in jobs.ts.
//
// A column a reading reads is text with stray spaces, so every value is read trimmed, and an empty
// cell and a cell of spaces are no value. "$1,250.00" reads as 1250 and "N/A" as NULL, never 0, so
// a sum or an average counts only the numbers. A day is an ISO date (with a time after it or not)
// or month/day/year as US offices write it, and only a day the calendar has.

import { dateTextSql, numberTextSql, realDaySql, trimmedSql, trimmedText } from "./jobs.js";

const oneLine = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** Where a reading's value goes in its expression. No statement holds this character. */
const VALUE = "\u0000";

// Each reading's expression is written once, on one line, around the place of its value. The value
// (a column, or any expression a model wrote) is put in as it is: squeezing it onto the line too
// would end a statement at the first `--` comment inside it and change the spaces of its literals.
const NUMBER_EXPR = oneLine(
  `(SELECT CASE WHEN u <> '' AND u <> '.' AND u NOT GLOB '*[^0-9.]*' AND u NOT GLOB '*.*.*' THEN CAST(n AS REAL) END ` +
    `FROM (SELECT n, ltrim(n, '+-') AS u FROM (SELECT ${numberTextSql(trimmedSql(VALUE))} AS n)))`,
);
// The middle step has no FROM, so SQLite keeps it and works the date's text out once a row. With
// a FROM it was written into the step around it, which names it three times (0.28 s against
// 0.15 s over 200,000 rows on SQLite 3.51, 2026-11-14).
const DAY_EXPR = oneLine(`(SELECT ${realDaySql("i")} FROM (SELECT (SELECT ${dateTextSql("v")} FROM (SELECT ${trimmedSql(VALUE)} AS v)) AS i))`);

const bound = (expr: string, value: string): string => expr.split(VALUE).join(value);

/**
 * SQL that reads `value` (a column, or any expression) as a number: NULL where it is not one,
 * never 0. The value is bound once in a subquery with no FROM, so it is written once however long
 * it is. It reads what jobs.ts `numberSql` reads and gives what `numberValueSql` gives; the
 * Notebook's read-sql.test.ts, in the api, holds the three together over a list of hard values
 * on SQLite, and store-object's front-door tests run the readings through a store.
 */
export const asNumberExpr = (value: string): string => bound(NUMBER_EXPR, value);

/**
 * SQL that reads `value` (a column, or any expression) as a day, YYYY-MM-DD: NULL where it names
 * no real day. It is jobs.ts `isoDateSql` with the value bound once.
 */
export const asIsoDateExpr = (value: string): string => bound(DAY_EXPR, value);

// `stable_id(x)`: a program that makes the keys of the system its rows go to must make the same key
// for the same row on every run, where a random id differs each time (finding 5 of the data plan's
// first proof). SQLite has no hash function, no XOR, and turns an integer product past 2^63 into a
// lossy REAL, so the id is four polynomial hashes of the text's characters, each taken modulo a
// prime under 2^31: a lane's value times its multiplier stays under 2^62. After the last character
// each lane is mixed once more with the text's length, so texts that differ only at their end give
// ids that differ everywhere. The 121 bits go out as a UUID of version 8 (RFC 9562's own format),
// lower case, which fits a column made for UUIDs. Every id a store ever made depends on these
// numbers, so they never change: readings.test.ts holds ids made from them.
const ID_LANES = [
  { start: 314159265, times: 1732050807, mod: 2147483647 },
  { start: 271828182, times: 1414213562, mod: 2147483629 },
  { start: 693147180, times: 1618033988, mod: 2147483587 },
  { start: 577215664, times: 1772453850, mod: 2147483579 },
] as const;
const LANE_NAMES = ["a", "b", "c", "d"] as const;
const lanes = (each: (name: string, lane: (typeof ID_LANES)[number]) => string): string => ID_LANES.map((lane, k) => each(LANE_NAMES[k]!, lane)).join(", ");

// The text is bound once, trimmed, in a subquery with no FROM, as the readings bind theirs. A
// recursive CTE walks its characters, and the step after it mixes each lane with the length.
const ID_EXPR = oneLine(
  `(SELECT CASE WHEN t <> '' THEN (` +
    `WITH RECURSIVE h(i, a, b, c, d) AS (` +
    `SELECT 1, ${lanes((_, l) => String(l.start))} ` +
    `UNION ALL SELECT i + 1, ${lanes((n, l) => `(${n} * ${l.times} + unicode(substr(t, i, 1))) % ${l.mod}`)} FROM h WHERE i <= length(t)) ` +
    `SELECT printf('%08x-%04x-8%03x-%04x-%04x%08x', a, (b >> 15) & 65535, b & 4095, 32768 | ((c >> 17) & 16383), c & 65535, d) ` +
    `FROM (SELECT ${lanes((n, l) => `(${n} * ${l.times} + i) % ${l.mod} AS ${n}`)} FROM h WHERE i > length(t))` +
    `) END FROM (SELECT ${trimmedSql(VALUE)} AS t))`,
);

/**
 * SQL that makes an id from `value` (a column, or any expression): the same text gives the same id
 * on every run and in every store, as a UUID of version 8; text that differs, in any character or
 * in its case, gives another. The text is read trimmed, as the readings read it, and
 * NULL, an empty text and a text of spaces give NULL: no value names no row. Build `value` from what
 * names the row, with what kind of row it is: stable_id('permit:' || `Town` || ':' || `Permit No`).
 */
export const stableIdExpr = (value: string): string => bound(ID_EXPR, value);

/**
 * What `stable_id` makes, in JavaScript, for code that must make the same id as a store's SQL. It
 * takes text: a number gives the id of the text SQLite writes for it (12.0 is "12.0").
 */
export function stableIdText(text: string | null): string | null {
  const t = text === null ? "" : trimmedText(text);
  if (!t) return null;
  const h = ID_LANES.map((l) => BigInt(l.start));
  const step = (k: number, add: bigint): bigint => (h[k]! * BigInt(ID_LANES[k]!.times) + add) % BigInt(ID_LANES[k]!.mod);
  let length = 0;
  for (const ch of t) {
    const code = BigInt(ch.codePointAt(0)!);
    for (let k = 0; k < h.length; k++) h[k] = step(k, code);
    length += 1;
  }
  const [a, b, c, d] = h.map((_, k) => Number(step(k, BigInt(length + 1))));
  const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");
  return `${hex(a!, 8)}-${hex((b! >>> 15) & 65535, 4)}-8${hex(b! & 4095, 3)}-${hex(32768 | ((c! >>> 17) & 16383), 4)}-${hex(c! & 65535, 4)}${hex(d!, 8)}`;
}

const READINGS = new Map<string, (value: string) => string>([
  ["as_number", asNumberExpr],
  ["as_iso_date", asIsoDateExpr],
  ["stable_id", stableIdExpr],
]);

/** The readings' names, as a statement calls them. */
export const READING_NAMES: readonly string[] = [...READINGS.keys()];

/**
 * A column's reading as a statement names it: as_number(`Fee`). A profile hands a column's call out
 * ready: a short call is copied whole, where the expression it stands for is 400 to 900 characters
 * that a model miscopies.
 */
export const readingCall = (name: "as_number" | "as_iso_date", column: string): string => `${name}(\`${column.replace(/`/g, "``")}\`)`;

/** Where the quoted run that opens at `i` ends: the index after its closing quote. A doubled quote inside it is a quote. */
function quotedEnd(sql: string, i: number): number {
  const q = sql[i]!;
  const close = q === "[" ? "]" : q;
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === close) {
      if (close !== "]" && sql[j + 1] === close) j += 2;
      else return j + 1;
    } else j += 1;
  }
  return sql.length;
}

/**
 * Where the quoted run or the comment that opens at `i` ends, or `i` when neither opens there:
 * text in quotes, a quoted name, a `--` comment up to its line's end, a block comment.
 */
function skippedEnd(sql: string, i: number): number {
  const c = sql[i]!;
  if (c === "'" || c === '"' || c === "`" || c === "[") return quotedEnd(sql, i);
  if (c === "-" && sql[i + 1] === "-") {
    const end = sql.indexOf("\n", i);
    return end < 0 ? sql.length : end + 1;
  }
  if (c === "/" && sql[i + 1] === "*") {
    const end = sql.indexOf("*/", i + 2);
    return end < 0 ? sql.length : end + 2;
  }
  return i;
}

/** One call a statement named, and what it was written out as. */
export interface WrittenReading {
  /** As the statement named it: "as_number(`Fee`)". */
  call: string;
  /** As the store was sent it. */
  written: string;
}

/** A statement with its readings written out (`withReadings`). */
export interface WithReadings {
  sql: string;
  /** Whether any call was written out. */
  expanded: boolean;
  /** Each call beside what it became, the outermost of nested calls first. */
  readings: WrittenReading[];
  /** A call the statement left unfinished, in words for whoever wrote it. `sql` is then the statement as it was. */
  problem?: string;
}

/**
 * A statement with every `as_number(…)`, `as_iso_date(…)` and `stable_id(…)` written out. Text in quotes, quoted
 * names and comments are left as they are, inside a call's brackets too. `readings` lists each
 * call beside what it became, the outermost of nested calls first, so an answer can name a
 * column as the statement did (`asWritten`). A call with no closing bracket is the statement's
 * own mistake: `problem` says so, in words for whoever wrote it. A statement that names no reading
 * comes back as it was, character for character, so calling this twice changes nothing.
 */
export function withReadings(sql: string): WithReadings {
  let out = "";
  const readings: WrittenReading[] = [];
  const failed = (problem: string): WithReadings => ({ sql, expanded: readings.length > 0, readings: [], problem });
  let i = 0;
  while (i < sql.length) {
    const skipped = skippedEnd(sql, i);
    if (skipped > i) {
      out += sql.slice(i, skipped);
      i = skipped;
      continue;
    }
    const c = sql[i]!;
    // A word in any script, as SQLite reads one: "éas_number" is one name, and no reading.
    if (!/[\p{L}_]/u.test(c)) {
      out += c;
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < sql.length && /[\p{L}\p{N}_$]/u.test(sql[j]!)) j += 1;
    const word = sql.slice(i, j);
    const reading = READINGS.get(word.toLowerCase());
    let open = j;
    while (open < sql.length && /\s/.test(sql[open]!)) open += 1;
    if (!reading || sql[open] !== "(") {
      out += word;
      i = j;
      continue;
    }
    // The call's argument: up to the bracket that closes it, past quotes, comments and brackets inside.
    let depth = 1;
    let k = open + 1;
    while (k < sql.length && depth > 0) {
      const past = skippedEnd(sql, k);
      if (past > k) {
        k = past;
        continue;
      }
      if (sql[k] === "(") depth += 1;
      else if (sql[k] === ")") depth -= 1;
      k += 1;
    }
    if (depth > 0) return failed(`${word}( has no closing bracket. Write ${word}(\`Column\`): a column or an expression between the brackets.`);
    const inner = withReadings(sql.slice(open + 1, k - 1));
    if (inner.problem) return failed(inner.problem);
    // What stands between the brackets once its comments are gone: a call that holds only a comment holds nothing.
    if (!withoutComments(inner.sql).trim()) return failed(`${word}() needs a column or an expression between its brackets.`);
    // The line's end closes a `--` comment the argument ends with, before the bracket that closes the value.
    const written = reading(`(${inner.sql}\n)`);
    out += written;
    readings.push({ call: sql.slice(i, k), written }, ...inner.readings);
    i = k;
  }
  return { sql: out, expanded: readings.length > 0, readings };
}

/** A statement's text with its comments taken out, and its quoted runs kept. */
function withoutComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const end = skippedEnd(sql, i);
    if (end > i) {
      const c = sql[i]!;
      if (c !== "-" && c !== "/") out += sql.slice(i, end);
      i = end;
    } else {
      out += sql[i]!;
      i += 1;
    }
  }
  return out;
}

/**
 * A result column's name as the statement wrote it. SQLite names a column that has no alias by
 * its expression's text, which for a reading is the 300 to 700 characters it was written out as:
 * each such run is put back as the call it stood for.
 */
export function asWritten(name: string, readings: readonly WrittenReading[]): string {
  if (readings.length === 0) return name;
  let out = name;
  // The longest first: an outer call's text holds its inner calls' text.
  for (const reading of [...readings].sort((a, b) => b.written.length - a.written.length)) out = out.split(reading.written).join(reading.call);
  return out;
}
