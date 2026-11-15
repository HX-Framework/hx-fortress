// Which `_key`s a reload of a LOAD's table took so far (load.ts), kept between its chunks: a bitset
// over the numbers the store's memory gives the keys of a table (`_row_hashes.n`), in the job's state.
//
//   • A row takes the first of its key, its key and "#2", "#3", … that no earlier row of the file
//     took. The memory says which of those keys the last load had, with each one's hash and number;
//     the bitset says whether a row of this file took that number already. A key the memory does
//     not have takes a free number: one a removed key left, else the one after the greatest.
//   • Once every row is read, the keys of the memory whose numbers no row took are the rows the file
//     no longer holds.
//   • A table whose memory holds a key with no number (a store from before numbers) or more numbers
//     than a state holds, or whose file repeats more keys than the reload keeps hints for, is loaded
//     whole instead. A whole load numbers its keys again once more than half the numbers are gaps,
//     or whenever that lets the next reload start (deltas.ts `recordLoadDelta`). Past FREE_MAX
//     ranges of free numbers, a reload uses the first FREE_MAX of them and leaves the rest.
//   • The state is saved with each commit as one value of the store's, which holds at most 2 MB:
//     the bitset is saved only as far as its greatest number, and LOAD makes the table whole when
//     its state would grow past STATE_BYTES_MAX (load.ts).

import type { SqlLike } from "../sql.js";

/** The most numbers a reload keeps a bit for: 1 MB of bitset, about 1.33 MB in the job's state. */
export const CLAIMS_MAX = 8_000_000;
/** The most keys a reload keeps the next "#n" of: one for each key the file repeats. */
export const PROBES_MAX = 20_000;
/** The most ranges of free numbers a reload keeps: at most about 200 KB in the job's state. */
export const FREE_MAX = 10_000;
/** The most characters of keys one statement binds: well under the 2 MB a store binds as one value. */
const KEY_CHARS = 400_000;

/** What a reload keeps of the keys it took, between its chunks. */
export interface ClaimsState {
  /** The bitset, in base64: bit n is set once a row of the file took the key numbered n. */
  bits: string;
  /** Free numbers, as ranges [from, to], that new keys take first. */
  free: [number, number][];
  /** The number after the greatest a key has. */
  next: number;
  /** For each key the file repeats, the next "#n" to try. */
  probe: Record<string, number>;
}

/** A key of the store's memory: its hash and its number. */
export interface Remembered {
  h: string;
  n: number;
}

/** The key a row took, and what the memory held for it (null: a key the last load did not have). */
export interface TakenKey {
  key: string;
  known: Remembered | null;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * What a reload of `table` starts from: the memory's free numbers (the first FREE_MAX ranges of
 * them) and the one after the greatest; null when the table cannot be reloaded by its keys (no
 * memory, a key with no number, a number held twice, or more numbers than a state keeps a bit for).
 * Reads every key's number once, writes nothing.
 */
export function startClaims(sql: SqlLike, table: string): { claims: ClaimsState; known: number } | null {
  const stats = sql.exec<{ c: number; numbered: number; m: number | null }>("SELECT count(*) AS c, count(n) AS numbered, max(n) AS m FROM _row_hashes WHERE tbl = ?", table).one();
  const count = Number(stats.c);
  if (count === 0 || Number(stats.numbered) < count) return null;
  const max = Number(stats.m ?? 0);
  if (max + 1 > CLAIMS_MAX) return null;
  const free: [number, number][] = [];
  let expect = 1;
  for (const r of sql.exec<{ n: number }>("SELECT n FROM _row_hashes WHERE tbl = ? ORDER BY n", table)) {
    const n = Number(r.n);
    if (n < expect) return null;
    // Past FREE_MAX ranges, the free numbers are left unused, so the state stays small: new keys take
    // numbers after the greatest, and a whole load numbers the keys again once most are gaps.
    if (n > expect && free.length < FREE_MAX) free.push([expect, n - 1]);
    expect = n + 1;
  }
  return { claims: { bits: "", free, next: max + 1, probe: {} }, known: count };
}

/** The keys a reload took, in memory for one chunk: made from its state, and saved back with each commit. */
export class Claims {
  private bits: Uint8Array;
  private readonly free: [number, number][];
  private next: number;
  private readonly probe: Record<string, number>;
  private probes: number;

  constructor(state: ClaimsState) {
    this.bits = state.bits ? fromBase64(state.bits) : new Uint8Array(0);
    this.free = state.free.map(([a, b]) => [a, b]);
    this.next = state.next;
    this.probe = { ...state.probe };
    this.probes = Object.keys(this.probe).length;
  }

  has(n: number): boolean {
    const at = n >> 3;
    return at < this.bits.length && (this.bits[at]! & (1 << (n & 7))) !== 0;
  }

  take(n: number): void {
    const at = n >> 3;
    if (at >= this.bits.length) {
      const grown = new Uint8Array(Math.max(at + 1, this.bits.length * 2, 64));
      grown.set(this.bits);
      this.bits = grown;
    }
    this.bits[at]! |= 1 << (n & 7);
  }

  /** A number for a key the memory does not have: a free one, else the one after the greatest. */
  allocate(): number {
    const first = this.free[0];
    if (first) {
      const n = first[0];
      if (first[0] === first[1]) this.free.shift();
      else first[0]++;
      return n;
    }
    return this.next++;
  }

  /** Whether the next "#n" a reload keeps for a repeated key are more than it keeps. */
  get tooManyRepeats(): boolean {
    return this.probes > PROBES_MAX;
  }

  /** The first "#n" to try for `base`: 1 is the key itself. */
  firstTry(base: string): number {
    return this.probe[base] ?? 1;
  }

  /** A row of `base` took "#n": the next row of `base` tries from "#n + 1". */
  tookTry(base: string, n: number): void {
    if (n < 2) return;
    if (!(base in this.probe)) this.probes++;
    this.probe[base] = n + 1;
  }

  /** Whether more numbers are in use than a state keeps a bit for. */
  get tooMany(): boolean {
    return this.next > CLAIMS_MAX;
  }

  state(): ClaimsState {
    // Every number taken is below `next`: the bytes past it, which growing the bitset by doubling
    // left, are not saved.
    const used = this.bits.subarray(0, Math.min(this.bits.length, Math.ceil(this.next / 8)));
    return { bits: toBase64(used), free: this.free.map(([a, b]) => [a, b]), next: this.next, probe: { ...this.probe } };
  }
}

const keyName = (base: string, n: number): string => (n === 1 ? base : `${base}#${n}`);

/** Reads the memory's hash and number of each of `keys` it has not read yet into `memory` (null: not there). */
function recall(sql: SqlLike, table: string, keys: readonly string[], memory: Map<string, Remembered | null>): void {
  const want = [...new Set(keys)].filter((k) => !memory.has(k));
  let part: string[] = [];
  let chars = 0;
  const ask = () => {
    if (!part.length) return;
    for (const k of part) memory.set(k, null);
    for (const r of sql.exec<{ k: string; h: string; n: number }>("SELECT k, h, n FROM _row_hashes WHERE tbl = ?1 AND k IN (SELECT value FROM json_each(?2))", table, JSON.stringify(part))) {
      memory.set(String(r.k), { h: String(r.h), n: Number(r.n) });
    }
    part = [];
    chars = 0;
  };
  for (const k of want) {
    if (part.length && chars + k.length > KEY_CHARS) ask();
    part.push(k);
    chars += k.length + 4;
  }
  ask();
}

/**
 * The keys a batch's rows take, in file order: each row's own key (`bases`), or the first "#n" of it
 * that no earlier row of the file took. Marks them taken. Reads the memory, writes nothing; null
 * when the file repeats more keys than the reload keeps hints for.
 */
export function takeKeys(sql: SqlLike, table: string, claims: Claims, bases: readonly string[]): TakenKey[] | null {
  const memory = new Map<string, Remembered | null>();
  recall(sql, table, bases, memory);
  const here = new Set<string>();
  const out: TakenKey[] = [];
  for (const base of bases) {
    let n = claims.firstTry(base);
    for (;;) {
      const key = keyName(base, n);
      // The next few of a repeated key at once: a file that repeats a key repeats it more than once.
      if (!memory.has(key)) recall(sql, table, Array.from({ length: 16 }, (_, i) => keyName(base, n + i)), memory);
      const known = memory.get(key) ?? null;
      if (!here.has(key) && !(known && claims.has(known.n))) {
        here.add(key);
        if (known) claims.take(known.n);
        out.push({ key, known });
        claims.tookTry(base, n);
        break;
      }
      n++;
    }
    if (claims.tooManyRepeats) return null;
  }
  return out;
}

/** The keys of the memory no row of the file took: the rows the file no longer holds. Reads each key once. */
export function untaken(sql: SqlLike, table: string, claims: Claims): string[] {
  const out: string[] = [];
  for (const r of sql.exec<{ k: string; n: number }>("SELECT k, n FROM _row_hashes WHERE tbl = ?", table)) {
    if (!claims.has(Number(r.n))) out.push(String(r.k));
  }
  return out;
}

/**
 * The memory brought up to date with a batch: its new keys with their numbers, its changed keys'
 * hashes, and the keys of rows the file no longer holds removed. Writes one row for each.
 */
export function rememberKeys(
  sql: SqlLike,
  table: string,
  rows: { added?: readonly { k: string; h: string; n: number }[]; changed?: readonly { k: string; h: string }[]; removed?: readonly string[] },
): void {
  for (const part of byChars(rows.added ?? [], (a) => a.k.length + 40)) {
    sql.exec(
      "INSERT INTO _row_hashes (tbl, k, h, n) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?2)",
      table,
      JSON.stringify(part.map((a) => [a.k, a.h, a.n])),
    );
  }
  // One statement a changed key, each found by the primary key: an UPDATE … FROM json_each makes
  // SQLite walk every key of the table for each batch.
  for (const c of rows.changed ?? []) sql.exec("UPDATE _row_hashes SET h = ?3 WHERE tbl = ?1 AND k = ?2", table, c.k, c.h);
  for (const part of byChars(rows.removed ?? [], (k) => k.length + 4)) {
    sql.exec("DELETE FROM _row_hashes WHERE tbl = ?1 AND k IN (SELECT value FROM json_each(?2))", table, JSON.stringify(part));
  }
}

/** `items` in runs of at most KEY_CHARS characters, by `size`. */
export function byChars<T>(items: readonly T[], size: (item: T) => number): T[][] {
  const out: T[][] = [];
  let part: T[] = [];
  let chars = 0;
  for (const item of items) {
    const n = size(item);
    if (part.length && chars + n > KEY_CHARS) {
      out.push(part);
      part = [];
      chars = 0;
    }
    part.push(item);
    chars += n;
  }
  if (part.length) out.push(part);
  return out;
}
