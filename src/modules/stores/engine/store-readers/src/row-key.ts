// A raw row's name and fingerprint (Stores, Part A): how a store knows, when a town sends its file
// again, which rows are new, which changed and which are gone, without keeping the old table.
//
//   `_key`   the row's name across loads: the value of the table's key column when its first rows
//            show one (a permit number, a parcel id), else `h:` and the row's hash. A repeat of
//            the same name in one table gets "#2", "#3" in file order (store/jobs/load.ts).
//   `_hash`  a 64-bit hash of the row's values, as 16 hex digits.
//
// The hash reads each value's UTF-16 code units, so the same row hashes the same in workerd and in
// Node. It finds changes; it does not guard against anyone forging a collision.

import { slug, type PlannedColumn } from "./names.js";

/** Marks a value's start, and a missing value, outside the range of a code unit (0..0xffff). */
const VALUE = 0x1_0001;
const MISSING = 0x1_0002;

/** A 64-bit hash of a row's values, as 16 hex digits. The values' order counts, and null differs from "". */
export function rowHash(values: readonly (string | null | undefined)[]): string {
  let h1 = 0xdeadbeef ^ values.length;
  let h2 = 0x41c6ce57 ^ values.length;
  for (const v of values) {
    if (v === null || v === undefined) {
      h1 = Math.imul(h1 ^ MISSING, 2654435761);
      h2 = Math.imul(h2 ^ MISSING, 1597334677);
      continue;
    }
    h1 = Math.imul(h1 ^ VALUE, 2654435761);
    h2 = Math.imul(h2 ^ VALUE, 1597334677);
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ v.length, 2654435761);
    h2 = Math.imul(h2 ^ v.length, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** The `_key` of a row with no key value of its own: its hash. */
export const hashKey = (hash: string): string => `h:${hash}`;

/**
 * A column name that reads like a row's identifier: "ID", "Permit No", "PARCEL_ID", "PermitNumber",
 * "APN". Phone, fax and zip columns are not, however unique their values.
 */
function soundsLikeKey(name: string): boolean {
  const s = slug(name);
  if (!s || /(^|_)(phone|fax|tel|zip|postal|ssn|date|year|amount|fee)(_|$)/.test(s)) return false;
  return (
    /^(id|key|no|num|nbr|number|uid|guid|uuid|apn|pin|recno|record_(id|no|num|number))$/.test(s) ||
    /(^|_)(id|no|num|nbr|number|uuid|guid|apn|pin)$/.test(s) ||
    /^[a-z]{3,}(id|no|nbr|num|number)$/.test(s)
  );
}

/** The share of a table's first rows a key column may leave empty or repeat: a town's data has the odd slip. */
export const KEY_SLIPS = 0.01;

/**
 * The column a raw table's `_key` comes from: the one an earlier load of the table used, when the
 * file still has it, so a row keeps its name; else the first column that reads like an identifier
 * and, in the table's first rows, holds a value in almost every row, almost every one different (at
 * most KEY_SLIPS of them empty or repeated: a repeat gets "#2", an empty one its hash). Null: the
 * table has none, and each row is named by its hash.
 */
export function keyColumnOf(kept: readonly PlannedColumn[], firstRows: readonly (readonly (string | null)[])[], recorded: string | null): PlannedColumn | null {
  if (recorded) {
    const same = kept.find((c) => c.name.toLowerCase() === recorded.toLowerCase());
    if (same) return same;
  }
  if (!firstRows.length) return null;
  const slips = Math.floor(firstRows.length * KEY_SLIPS);
  for (const column of kept) {
    if (!soundsLikeKey(column.name) && !soundsLikeKey(column.source)) continue;
    const seen = new Set<string>();
    let bad = 0;
    for (const row of firstRows) {
      const v = row[column.index]?.trim();
      if (!v || seen.has(v)) bad++;
      else seen.add(v);
      if (bad > slips) break;
    }
    if (bad <= slips) return column;
  }
  return null;
}

/** A row's `_key`: its key column's value, trimmed, or its hash when it has none. */
export function rowKey(value: string | null | undefined, hash: string): string {
  const v = value?.trim();
  return v ? v : hashKey(hash);
}
