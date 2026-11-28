// How a store's tables connect: a part of the one profile (profile.ts). A town's files come with no
// foreign keys: every column a LOAD makes is text. So a link is found by its names and then
// measured on the rows:
//
//   1. `linkSearch` reads the catalog alone. A column may point at another table when its name says
//      so ("Parcel Number" in permits, and a table called parcels), or when both tables have a
//      column of the same words ("permit_no" and "Permit No"), and the column it points at holds a
//      different value in nearly every row.
//   2. `linkSql` (profile-sql.ts) reads the rows of both sides with one statement that only reads,
//      and `linkOf` reads its answer: how many rows point at something, how many match character
//      for character, how many match only once dashes and case are ignored, how many match nothing
//      (with examples), and how many values on the other side nobody points at. Counted in rows,
//      never in different values: one value that matches nothing can stand on most of the rows.
//
// A name can mislead in both directions, so the numbers decide.

import { EXTRA_COLUMN, HASH_COLUMN, KEY_COLUMN } from "./jobs.js";
import { FILE_COLUMN, ROW_COLUMN } from "./names.js";
import type { LinkEnd } from "./profile-sql.js";

/** The columns a store adds to every table it loads from a file: not the file's own. */
export const STORE_COLUMNS: ReadonlySet<string> = new Set([FILE_COLUMN, ROW_COLUMN, KEY_COLUMN, HASH_COLUMN, EXTRA_COLUMN]);

/** A table as the search for links reads it: what a store's catalog says of it. */
export interface LinkTable {
  name: string;
  count: number;
  kind?: string;
  view?: boolean;
  parked?: unknown;
  columns: readonly { name: string; filled?: number; distinct?: number }[];
}

/** The share of a column's values that must differ for another table to point at it. */
const KEY_SHARE = 0.95;
/** Rows a store's catalog samples for a column's numbers when no profile has read the whole table. */
const CATALOG_SAMPLE_ROWS = 5_000;
/** A link found by its names counts when this share of the rows that point match something. */
export const LINK_SHARE = 0.3;
/** Words a key's name carries that say nothing of what it is a key of. */
const KEY_WORDS = new Set(["id", "no", "num", "nbr", "number", "code", "key", "ref"]);
/** Tables one search of the names reads: it compares every table's columns with every other table's keys. */
export const TABLES_SEARCHED = 250;

/** A name's words, in lower case: "Parcel Number", "parcel_number" and "parcelNumber" are all `parcel`, `number`. Letters and digits of any script. */
export function wordsOf(name: string): string[] {
  return name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Whether `many` is the plural of `one` as English writes it: parcels, taxes, categories. */
const pluralOf = (one: string, many: string): boolean => many === `${one}s` || many === `${one}es` || (one.endsWith("y") && many === `${one.slice(0, -1)}ies`);

/**
 * Whether two runs of words name the same thing: the same words, the last in the singular or the
 * plural. A column says "address" and its table "addresses"; no rule cuts every plural back to one
 * word ("statuses", "cases"), so the two are compared as they are.
 */
function sameWords(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const last = a.length - 1;
  for (let i = 0; i < last; i += 1) if (a[i] !== b[i]) return false;
  const x = a[last]!;
  const y = b[last]!;
  return x === y || pluralOf(x, y) || pluralOf(y, x);
}

/**
 * What a column is a key of, by its name, as words: "Permit No" and "permit_no" are both `permit`,
 * and "Permit Type" is `permit`, `type`. Empty for a name that says only that it is a key ("id",
 * "No"): every table has one, and it names no other table.
 */
const subjectWords = (name: string): string[] => wordsOf(name).filter((w) => !KEY_WORDS.has(w));

/** `subjectWords` as one string, for a reader. */
export const subjectOf = (name: string): string => subjectWords(name).join(" ");

/**
 * How well a column's subject names a table: 2 when it is the table's whole name ("permit" and
 * permits, "address" and addresses), 1 when it is the name's last words ("permit" and
 * building_permits, the noun an English name ends on), 0 when it is neither ("permit" and
 * permit_types). `wholes` are the table's name as words, and the same without a schema a pull put
 * before two underscores.
 */
function names(subject: readonly string[], wholes: readonly (readonly string[])[]): 0 | 1 | 2 {
  if (subject.length === 0) return 0;
  if (wholes.some((whole) => sameWords(whole, subject))) return 2;
  return wholes.some((whole) => whole.length > subject.length && sameWords(whole.slice(-subject.length), subject)) ? 1 : 0;
}

/** Whether a column's name ends the way a key's does: "Permit No", "inspection_id". */
export const looksLikeKey = (name: string): boolean => {
  const words = wordsOf(name);
  return words.length > 1 && KEY_WORDS.has(words[words.length - 1]!);
};

/** A table people and programs read: not the store's own bookkeeping. */
const isDataTable = (table: LinkTable): boolean => table.kind !== "system";

/** The share of a column's values that differ, from the catalog: exact after a profile, else over the catalog's sample. */
export function distinctShare(table: LinkTable, column: LinkTable["columns"][number]): number {
  const filled = column.filled ?? 0;
  const distinct = column.distinct ?? 0;
  if (filled <= 0 || distinct <= 0 || table.count <= 0) return 0;
  // A count past the sample can only have come from a read of the whole table.
  const rows = distinct > CATALOG_SAMPLE_ROWS ? table.count : Math.min(table.count, CATALOG_SAMPLE_ROWS);
  return Math.min(1, distinct / Math.max(1, filled * rows));
}

export interface LinkCandidate {
  from: LinkEnd;
  to: LinkEnd;
  /** Why the two might be linked, for the answer. */
  why: "the same words" | "names the table";
}

export interface LinkSearch {
  /** The columns that may point at another table, strongest first. */
  candidates: LinkCandidate[];
  /** Tables with rows where no column differs in nearly every row: nothing can be said to point at them by name. */
  tablesWithNoKey: string[];
  /** Tables past the ones one search reads. */
  tablesNotSearched: number;
}

/** A table as the search reads it: its names' words and each column's, worked out once. */
interface Searched {
  name: string;
  wholes: string[][];
  columns: { name: string; subject: string[]; share: number }[];
  /** The columns another table can point at: nearly every row differs. */
  keys: { name: string; subject: string[]; share: number }[];
}

/** The columns of the tables that may point at another table, strongest first. Reads the catalog only. */
export function linkSearch(tables: readonly LinkTable[]): LinkSearch {
  const readable = tables.filter((t) => isDataTable(t) && !t.parked && !t.view && t.count > 0);
  // Every name is read once: the search compares each column with every other table's keys.
  const searched: Searched[] = readable.slice(0, TABLES_SEARCHED).map((t) => {
    const columns = t.columns.filter((c) => !STORE_COLUMNS.has(c.name)).map((c) => ({ name: c.name, subject: subjectWords(c.name), share: distinctShare(t, c) }));
    return { name: t.name, wholes: [wordsOf(t.name), wordsOf(t.name.slice(t.name.lastIndexOf("__") + 1))], columns, keys: columns.filter((c) => c.share >= KEY_SHARE) };
  });
  const scored: (LinkCandidate & { score: number; share: number })[] = [];
  const tablesWithNoKey: string[] = [];
  for (const target of searched) {
    if (target.keys.length === 0) {
      tablesWithNoKey.push(target.name);
      continue;
    }
    // The table's own key, when a name must stand for the whole table: one named after the table, else one that ends like a key, else the first.
    const own = target.keys.find((k) => names(k.subject, target.wholes) === 2) ?? target.keys.find((k) => looksLikeKey(k.name)) ?? target.keys[0]!;
    for (const source of searched) {
      if (source === target) continue;
      for (const column of source.columns) {
        // A name that says only "id" or "number" is in every table, and links none.
        if (column.subject.length === 0) continue;
        const toTarget = names(column.subject, target.wholes);
        const same = target.keys.find((k) => sameWords(k.subject, column.subject));
        if (same) {
          // Two columns of one name that each differ in every row are two tables' own row keys
          // (`OBJECTID`, `created_at`), unless the name says whose key it is: `parcel_id` in parcels
          // and in parcel_details.
          if (column.share >= KEY_SHARE && toTarget === 0) continue;
          scored.push({ from: { table: source.name, column: column.name }, to: { table: target.name, column: same.name }, why: "the same words", score: 3 + toTarget, share: same.share });
        } else if (toTarget > 0) {
          scored.push({ from: { table: source.name, column: column.name }, to: { table: target.name, column: own.name }, why: "names the table", score: toTarget, share: own.share });
        }
      }
    }
  }
  // Two tables that both hold a key of the same words point at each other: keep the direction whose target is closer to a key.
  const keyOf = (c: LinkCandidate): string => `${c.from.table}\n${c.from.column}\n${c.to.table}\n${c.to.column}`;
  const byEnds = new Map(scored.map((c) => [keyOf(c), c]));
  const kept = scored.filter((c) => {
    const back = byEnds.get(keyOf({ from: c.to, to: c.from, why: c.why }));
    if (!back) return true;
    if (c.score !== back.score) return c.score > back.score;
    return c.share > back.share || (c.share === back.share && `${c.from.table}.${c.from.column}` < `${back.from.table}.${back.from.column}`);
  });
  const candidates = kept
    .sort((a, b) => b.score - a.score || a.from.table.localeCompare(b.from.table) || a.from.column.localeCompare(b.from.column))
    .map(({ score: _score, share: _share, ...candidate }) => candidate);
  return { candidates, tablesWithNoKey, tablesNotSearched: Math.max(0, readable.length - TABLES_SEARCHED) };
}

/** The candidates alone. */
export const linkCandidates = (tables: readonly LinkTable[]): LinkCandidate[] => linkSearch(tables).candidates;

/** One link measured on the rows of both sides, counted in rows. */
export interface MeasuredLink {
  from: LinkEnd;
  to: LinkEnd;
  /** Rows of `from` read. */
  rows: number;
  /** Rows of `from` with no value in the column. */
  empty: number;
  /** Rows whose value is one of `to`'s, character for character. */
  matched: number;
  /** Rows that match only once dashes, spaces, dots, slashes and case are ignored. */
  matchedLoosely: number;
  /** Rows whose value matches nothing in `to`. */
  unmatched: number;
  /** A few values that match nothing, with their rows. */
  unmatchedExamples: { value: string; rows: number }[];
  /** Different values of `to`. */
  targets: number;
  /** Values of `to` that no row of `from` points at. */
  targetsUnused: number;
  /** The share of the rows with a value that match, exactly or loosely: 0 to 1. */
  share: number;
}

/** A cell as a count: SQLite answers a sum as a number, or as text for a big one. */
export const countOf = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** A cell as text. */
export const textOf = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

/** A link's statement's answer (`linkSql`), read. */
export function linkOf(from: LinkEnd, to: LinkEnd, answer: readonly Record<string, unknown>[]): MeasuredLink {
  const totals = answer.find((row) => row.k === "totals");
  const rows = countOf(totals?.n);
  const filled = countOf(totals?.filled);
  const matched = countOf(totals?.exact);
  const matchedLoosely = countOf(totals?.loose);
  return {
    from,
    to,
    rows,
    empty: rows - filled,
    matched,
    matchedLoosely,
    unmatched: Math.max(0, filled - matched - matchedLoosely),
    unmatchedExamples: answer.filter((row) => row.k === "unmatched").map((row) => ({ value: textOf(row.a), rows: countOf(row.n) })),
    targets: countOf(totals?.targets),
    targetsUnused: countOf(totals?.unused),
    share: filled > 0 ? Math.round(((matched + matchedLoosely) / filled) * 10_000) / 10_000 : 0,
  };
}
