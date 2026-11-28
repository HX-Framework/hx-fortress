// What a column's values read as, worked out from how they are written: a part of the one profile
// (profile.ts).
//
// A profile counts a column's values by their shape: the value with every digit turned into 9
// (`shapeOf` in profile-sql.ts). A handful of shapes covers a column of dates, numbers or codes, so
// the shapes say what the column holds and in how many formats, over every row, with no pattern per
// format in SQL. This file reads the shapes. It is pure: profile.ts feeds it what the store answered.
//
// What reads as a number here is what the store's own `numberSql` reads, and a date format marked
// `iso` is one its `isoDateSql` reads (jobs.ts), so the share a profile states, the range it reads
// and the SQL expression it hands out for the column all count the same values.

/** One way a column's values are written, with how many rows are written so. */
export interface ShapeCount {
  /** The value with every digit as 9: `9999-99-99`. */
  shape: string;
  rows: number;
  /** One value written this way. */
  example: string;
}

export type Reads = "empty" | "whole number" | "number" | "money" | "date" | "date and time" | "yes or no" | "text";

/** A format a column's values come in, in words a person reads. */
export interface Format {
  /** "year-month-day", "month/day/year", "digits only", "with a dollar sign"… */
  name: string;
  rows: number;
  example: string;
}

export interface ColumnReading {
  reads: Reads;
  /** The share of the column's values that read so, 0 to 1. */
  share: number;
  /** The formats the values that read so come in, most common first. Empty for text with no pattern. */
  formats: Format[];
  /** Values that do not read as the rest, among the shapes seen: how many rows, and a few of them. */
  odd: { rows: number; examples: string[] };
  /** A column of days whose every format `isoDateSql` reads: its SQL expression and its range hold for the column. */
  isoReadable: boolean;
}

type Family = "date" | "datetime" | "number" | "text";

interface Rule {
  family: Family;
  name: string;
  /** A finer kind of number: it decides between "whole number", "number" and "money". */
  number?: "whole" | "decimal" | "money";
  /** A date format `isoDateSql` reads as YYYY-MM-DD. */
  iso?: true;
}

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
// Its seconds' colon is written as a class, `[:]`: two colons in a row read as an IPv6 address
// to the engine folder's address check (infra/scripts/store-engine-folder.mjs).
const TIME = "9{1,2}:99(?:[:]99(?:\\.9+)?)?(?: ?[ap]m)?";

/**
 * The date formats, each tested against the shape; the first a shape passes names its format. The
 * three marked `iso` are the ones `isoDateSql` reads, written as it tests them: a capital T or a
 * space before a time, and a four-digit year after month/day.
 */
const DATE_RULES: readonly (Rule & { test: RegExp })[] = [
  { family: "date", iso: true, name: "year-month-day", test: /^9999-99-99$/ },
  { family: "datetime", iso: true, name: "year-month-day and a time", test: /^9999-99-99[T ]/ },
  { family: "date", iso: true, name: "month/day/year", test: /^9{1,2}\/9{1,2}\/9999$/ },
  { family: "date", name: "month/day/year, two-digit year", test: /^9{1,2}\/9{1,2}\/99$/ },
  { family: "datetime", name: "month/day/year and a time", test: new RegExp(`^9{1,2}/9{1,2}/9{2,4} ${TIME}$`, "i") },
  { family: "date", name: "year/month/day", test: /^9999\/99\/99$/ },
  { family: "date", name: "day.month.year", test: /^9{1,2}\.9{1,2}\.9999$/ },
  { family: "date", name: "day month year, month in letters", test: new RegExp(`^9{1,2}[- ]${MONTH}[- ,]+9{2,4}$`, "i") },
  { family: "date", name: "month in letters, day, year", test: new RegExp(`^${MONTH} 9{1,2},? 9{4}$`, "i") },
];

/**
 * A shape `numberSql` reads as a number: without its dollar signs, commas and spaces and without
 * its sign, digits with at most one point. Brackets and a percent sign are not part of a number
 * there, so "($25.00)" and "12.5%" read as text here, and a profile lists them as `odd`.
 */
function numberRule(shape: string): Rule | null {
  const bare = shape.replace(/[$, ]/g, "").replace(/^[+-]+/, "");
  if (!/^(?:9+\.?9*|\.9+)$/.test(bare)) return null;
  const point = bare.includes(".");
  const commas = shape.includes(",");
  const spaces = shape.includes(" ");
  if (shape.includes("$")) return { family: "number", number: "money", name: "with a dollar sign" };
  if (point) return { family: "number", number: "decimal", name: commas ? "with commas and a decimal point" : spaces ? "with spaces and a decimal point" : "with a decimal point" };
  return { family: "number", number: "whole", name: commas ? "with commas" : spaces ? "with spaces" : "digits only" };
}

const YES_NO = new Set(["y", "n", "yes", "no", "true", "false", "t", "f"]);

/** The share of a column's values a family must hold for the column to read as that family. */
export const READS_SHARE = 0.6;
/** A column of text is said to have formats when this few shapes cover this much of it. */
const PATTERN_SHAPES_MAX = 12;
const PATTERN_SHARE = 0.9;

/** The format a shape is written in; null for text. */
function ruleOf(shape: string): Rule | null {
  return DATE_RULES.find((rule) => rule.test.test(shape)) ?? numberRule(shape);
}

/** Shapes that differ only in how many digits a run has are one format: `9-9` for `99-999` and `9-99`. */
const runsAsOne = (shape: string): string => shape.replace(/9+/g, "9");

/**
 * What a column reads as.
 *
 * `shapes` are its most common shapes (not always all of them), `filled` its rows with a value,
 * and `common` its most common values, for a yes-or-no column. Rows whose shape was not among
 * `shapes` count as text: a column with more shapes than a profile keeps is free text or close to it.
 */
export function readColumn(input: { filled: number; distinct: number; shapes: readonly ShapeCount[]; common: readonly { value: string; rows: number }[] }): ColumnReading {
  const { filled, shapes } = input;
  if (filled === 0) return { reads: "empty", share: 0, formats: [], odd: { rows: 0, examples: [] }, isoReadable: false };

  if (input.distinct <= YES_NO.size && input.common.length >= input.distinct && input.common.every((c) => YES_NO.has(c.value.toLowerCase()))) {
    return { reads: "yes or no", share: 1, formats: [], odd: { rows: 0, examples: [] }, isoReadable: false };
  }

  // Each family's rows, and each named format's.
  const families = new Map<Family, number>();
  const formats = new Map<string, Format & { family: Family; number?: Rule["number"]; iso: boolean }>();
  const unread: ShapeCount[] = [];
  for (const s of shapes) {
    const rule = ruleOf(s.shape);
    if (!rule) {
      unread.push(s);
      continue;
    }
    families.set(rule.family, (families.get(rule.family) ?? 0) + s.rows);
    const format = formats.get(rule.name);
    if (format) format.rows += s.rows;
    else formats.set(rule.name, { name: rule.name, rows: s.rows, example: s.example, family: rule.family, iso: rule.iso === true, ...(rule.number ? { number: rule.number } : {}) });
  }
  const days = (families.get("date") ?? 0) + (families.get("datetime") ?? 0);
  const numbers = families.get("number") ?? 0;
  const byRows = (a: Format, b: Format): number => b.rows - a.rows || a.name.localeCompare(b.name);
  const formatsOf = (...wanted: Family[]): Format[] =>
    [...formats.values()]
      .filter((f) => wanted.includes(f.family))
      .sort(byRows)
      .map(({ name, rows, example }) => ({ name, rows, example }));
  const oddOf = (...read: Family[]): ColumnReading["odd"] => {
    const others = [...unread, ...shapes.filter((s) => {
      const rule = ruleOf(s.shape);
      return rule !== null && !read.includes(rule.family);
    })].sort((a, b) => b.rows - a.rows);
    const seen = shapes.reduce((sum, s) => sum + s.rows, 0);
    // Rows whose shape was not kept do not read as the family either.
    return { rows: others.reduce((sum, s) => sum + s.rows, 0) + Math.max(0, filled - seen), examples: others.slice(0, 3).map((s) => s.example) };
  };

  if (days / filled >= READS_SHARE && days >= numbers) {
    const withTime = families.get("datetime") ?? 0;
    const isoReadable = [...formats.values()].every((f) => (f.family !== "date" && f.family !== "datetime") || f.iso);
    return { reads: withTime * 2 > days ? "date and time" : "date", share: days / filled, formats: formatsOf("date", "datetime"), odd: oddOf("date", "datetime"), isoReadable };
  }
  if (numbers / filled >= READS_SHARE) {
    const kinds = [...formats.values()].filter((f) => f.family === "number");
    const rowsOf = (kind: Rule["number"]): number => kinds.filter((f) => f.number === kind).reduce((sum, f) => sum + f.rows, 0);
    const reads: Reads = rowsOf("money") > 0 ? "money" : rowsOf("decimal") > 0 ? "number" : "whole number";
    return { reads, share: numbers / filled, formats: formatsOf("number"), odd: oddOf("number"), isoReadable: false };
  }

  // Text. A few shapes that cover nearly all of it are worth naming: a code such as BP-9999-99999.
  // Shapes arrive most common first, so each group is named by its most common shape.
  const merged = new Map<string, Format>();
  for (const s of shapes) {
    const group = runsAsOne(s.shape);
    const format = merged.get(group);
    if (format) format.rows += s.rows;
    else merged.set(group, { name: s.shape, rows: s.rows, example: s.example });
  }
  const patterns = [...merged.values()].sort(byRows);
  const covered = patterns.reduce((sum, p) => sum + p.rows, 0);
  const patterned = patterns.length <= PATTERN_SHAPES_MAX && covered / filled >= PATTERN_SHARE && patterns.some((p) => /9/.test(p.name));
  return { reads: "text", share: 1, formats: patterned ? patterns : [], odd: { rows: 0, examples: [] }, isoReadable: false };
}
