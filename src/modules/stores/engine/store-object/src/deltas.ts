// What changed in a store's program tables (Stores, Part A): the delta the store records for each
// table, which SHAPE and the cleanup steps read to touch only the rows that changed.
//
// Every change to a program table gets a change number (`_deltas.change`, the table's rowid, so it
// only grows) and records the `_key`s of the rows it added, changed or removed (`_delta_rows`, as
// JSON arrays of up to KEYS_PER_PART keys: one row written for thousands of keys). A step saves the
// change number it read a table up to, marks it (`markRead`), and its next run asks `changedSince`
// for the keys of the changes after it. The keys every marked reader has read go, and a table's
// newest DELTA_CHANGES_KEPT changes at most keep theirs (DELTA_UNREAD_KEPT when no step has marked
// it), so the record stays the size of what the readers have not read yet. A change the store
// cannot name row by row is `whole`, and so is any change whose keys the store no longer keeps:
// then the reader takes the whole table. A change a job opened and did not close (it failed) reads
// as whole for good.
//
// A LOAD's table finds its changes by comparing its rows' `_hash` with the store's memory of the
// hashes it took in last time (`_row_hashes`, by `_key`), so the table can leave the store
// (parking) and the next upload still names only the rows that differ.
//
// Shapes in `store-readers/jobs` (`TableDelta`, `RowCounts`, `KEY_COLUMN`, `HASH_COLUMN`).

import { DELTA_CHANGES_KEPT, DELTA_UNREAD_KEPT, HASH_COLUMN, KEY_COLUMN, type RowChange, type RowCounts, type TableDelta } from "../../store-readers/src/jobs.js";
import type { StoreCore } from "./core.js";
import { CLAIMS_MAX, startClaims } from "./jobs/claims.js";
import type { SqlLike, StoreSqlValue } from "./sql.js";

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const KINDS: readonly RowChange[] = ["added", "changed", "removed"];

/** The most keys one `_delta_rows` row holds: well under the 2 MB a store keeps in a value. */
export const KEYS_PER_PART = 5_000;
/**
 * The most characters of keys one `_delta_rows` row holds, whatever their number: a character is at
 * most three bytes of UTF-8, so long keys stay under the 2 MB too.
 */
const KEY_PART_CHARS = 600_000;

/**
 * Adds `items` to the end of `list` one at a time. A spread (`list.push(...items)`) passes each item
 * as an argument, and past about 125,000 of them the call stack overflows (RangeError).
 */
export function appendAll<T>(list: T[], items: Iterable<T>): void {
  for (const item of items) list.push(item);
}

/** The `_key`s a change added, changed and removed. */
export interface RowKeys {
  added?: readonly string[];
  changed?: readonly string[];
  removed?: readonly string[];
}

/** The rows that changed in a table after a change number, for a step to read. */
export interface ChangedSince extends RowCounts {
  /**
   * A subquery of the changed rows' `_key`s, distinct (`k`): `… WHERE "_key" IN (<keysSql>)`. Its
   * parameters are numbered (?1, ?2, ?3), so a statement may name it more than once and bind
   * `params` once; they are a statement's first three.
   */
  keysSql: string;
  params: (string | number)[];
  /** The change number the reader has read up to once it took these keys. */
  upTo: number;
  /** How many keys the subquery answers, at most (a key changed twice counts twice). */
  keys: number;
}

/** The number the next change gets. */
const changeNumberAfter = (sql: SqlLike): number => Number(sql.exec<{ n: number | null }>("SELECT max(change) AS n FROM _deltas").one().n ?? 0) + 1;

/** The change a step read `table` up to on its last run; null when it has no mark. */
export function readMark(sql: SqlLike, reader: string, table: string): number | null {
  const row = sql.exec<{ change: number }>("SELECT change FROM _delta_reads WHERE reader = ? AND tbl = ?", reader, table).toArray()[0];
  return row ? Number(row.change) : null;
}

/** The newest change number of a table: 0 when it has none. A step keeps this as "read up to". */
export function lastChange(sql: SqlLike, table: string): number {
  return Number(sql.exec<{ n: number | null }>("SELECT max(change) AS n FROM _deltas WHERE tbl = ?", table).one().n ?? 0);
}

/**
 * The keys of a change, one JSON array a row of `_delta_rows` (at most KEYS_PER_PART keys and
 * KEY_PART_CHARS characters), after any it already holds of that kind.
 */
function insertKeys(sql: SqlLike, table: string, change: number, kind: RowChange, keys: readonly string[]): void {
  if (!keys.length) return;
  let part = Number(sql.exec<{ n: number | null }>("SELECT max(part) AS n FROM _delta_rows WHERE tbl = ? AND change = ? AND kind = ?", table, change, kind).one().n ?? -1) + 1;
  let from = 0;
  while (from < keys.length) {
    let to = from;
    let chars = 0;
    while (to < keys.length && to - from < KEYS_PER_PART && (to === from || chars + keys[to]!.length + 3 <= KEY_PART_CHARS)) chars += keys[to++]!.length + 3;
    sql.exec("INSERT INTO _delta_rows (tbl, change, kind, part, keys) VALUES (?, ?, ?, ?, ?)", table, change, kind, part++, JSON.stringify(keys.slice(from, to)));
    from = to;
  }
}

/** How many keys of each kind a change holds. */
function countsOf(sql: SqlLike, table: string, change: number): RowCounts {
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const r of sql.exec<{ kind: RowChange; n: number }>("SELECT kind, sum(json_array_length(keys)) AS n FROM _delta_rows WHERE tbl = ? AND change = ? GROUP BY kind", table, change)) {
    counts[r.kind] = Number(r.n);
  }
  return counts;
}

/**
 * Drops the keys no reader needs: those of the changes every marked reader of the table has read,
 * those past its newest DELTA_CHANGES_KEPT changes (DELTA_UNREAD_KEPT when no step has marked the
 * table), and those of a change a job opened and left (`whole`). Those changes then read as whole.
 */
function prune(sql: SqlLike, table: string, open: number | null = null): void {
  const marks = sql.exec<{ floor: number | null; n: number }>("SELECT min(change) AS floor, count(*) AS n FROM _delta_reads WHERE tbl = ?", table).one();
  const readers = Number(marks.n);
  const floor = readers > 0 ? Number(marks.floor ?? 0) : 0;
  const keep = readers > 0 ? DELTA_CHANGES_KEPT : DELTA_UNREAD_KEPT;
  const old = sql
    .exec<{ change: number }>(
      `SELECT change FROM _deltas WHERE tbl = ? AND kept = 1 AND change IS NOT ? AND (whole = 1 OR change <= ?
         OR change NOT IN (SELECT change FROM _deltas WHERE tbl = ? AND whole = 0 ORDER BY change DESC LIMIT ?))`,
      table,
      open,
      floor,
      table,
      keep,
    )
    .toArray()
    .map((r) => Number(r.change));
  for (const change of old) {
    sql.exec("DELETE FROM _delta_rows WHERE tbl = ? AND change = ?", table, change);
    sql.exec("UPDATE _deltas SET kept = 0 WHERE change = ?", change);
  }
}

/**
 * A reader's mark: `reader` (a step, such as `shape:permits_clean`) has read `table` up to change
 * number `change`. The keys every marked reader has read then go. A mark that does not move writes
 * nothing.
 */
export function markRead(core: StoreCore, reader: string, table: string, change: number): void {
  core.sql.exec(
    `INSERT INTO _delta_reads (reader, tbl, change, at) VALUES (?, ?, ?, ?)
     ON CONFLICT (reader, tbl) DO UPDATE SET change = excluded.change, at = excluded.at WHERE _delta_reads.change IS NOT excluded.change`,
    reader,
    table,
    change,
    core.nowIso(),
  );
  prune(core.sql, table);
}

/**
 * A step that no longer reads changes, such as a SHAPE kept as a view: its marks go, so a mark it
 * will never move does not keep the keys of every change after it.
 */
export function forgetReader(core: StoreCore, reader: string): void {
  const tables = core.sql.exec<{ tbl: string }>("DELETE FROM _delta_reads WHERE reader = ? RETURNING tbl", reader).toArray();
  for (const t of tables) prune(core.sql, String(t.tbl));
}

function insertChange(core: StoreCore, table: string, change: number, opts: { version: number; whole: boolean; job: string | null; by?: string | null; counts: RowCounts }): TableDelta {
  const at = core.nowIso();
  core.sql.exec(
    "INSERT INTO _deltas (change, tbl, version, whole, added, changed, removed, kept, job, at, by_sub) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    change,
    table,
    opts.version,
    opts.whole ? 1 : 0,
    opts.counts.added,
    opts.counts.changed,
    opts.counts.removed,
    opts.whole ? 0 : 1,
    opts.job,
    at,
    opts.by ?? null,
  );
  prune(core.sql, table);
  return { table, change, version: opts.version, whole: opts.whole, ...opts.counts, at, job: opts.job };
}

/**
 * Records a change to a table, inside the caller's transaction: `whole`, or the `_key`s it added,
 * changed and removed. Answers the change, with its number. `by` names the person whose fix it
 * is, for a change no job made.
 */
export function recordDelta(
  core: StoreCore,
  table: string,
  opts: { version: number; job: string | null; by?: string | null } & ({ whole: true; rows?: number } | { keys: RowKeys }),
): TableDelta {
  const change = changeNumberAfter(core.sql);
  if ("whole" in opts) {
    return insertChange(core, table, change, { version: opts.version, whole: true, job: opts.job, by: opts.by ?? null, counts: { added: opts.rows ?? 0, changed: 0, removed: 0 } });
  }
  for (const kind of KINDS) insertKeys(core.sql, table, change, kind, opts.keys[kind] ?? []);
  const counts = { added: opts.keys.added?.length ?? 0, changed: opts.keys.changed?.length ?? 0, removed: opts.keys.removed?.length ?? 0 };
  return insertChange(core, table, change, { version: opts.version, whole: false, job: opts.job, by: opts.by ?? null, counts });
}

/**
 * The rows of `table` that changed after change number `after`; null when the store cannot say
 * (a whole change came after it, or a change whose keys it no longer keeps): take the whole table.
 * No change after it answers no keys.
 */
export function changedSince(sql: SqlLike, table: string, after: number): ChangedSince | null {
  const rows = sql
    .exec<{ change: number; whole: number; kept: number; added: number; changed: number; removed: number }>(
      "SELECT change, whole, kept, added, changed, removed FROM _deltas WHERE tbl = ? AND change > ? ORDER BY change",
      table,
      after,
    )
    .toArray();
  const newest = lastChange(sql, table);
  if (after > newest) return null;
  if (rows.some((r) => Number(r.whole) === 1 || Number(r.kept) === 0)) return null;
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const r of rows) {
    counts.added += Number(r.added);
    counts.changed += Number(r.changed);
    counts.removed += Number(r.removed);
  }
  return {
    keysSql: "SELECT DISTINCT j.value AS k FROM _delta_rows AS d, json_each(d.keys) AS j WHERE d.tbl = ?1 AND d.change > ?2 AND d.change <= ?3",
    params: [table, after, newest],
    upTo: newest,
    keys: counts.added + counts.changed + counts.removed,
    ...counts,
  };
}

/**
 * A change in place that spans several chunks: its row goes in now, recorded whole, so a reader
 * that comes before it is closed takes the whole table rather than a part of the change.
 */
export function openDelta(core: StoreCore, table: string, version: number, job: string | null): number {
  const change = changeNumberAfter(core.sql);
  core.sql.exec(
    "INSERT INTO _deltas (change, tbl, version, whole, added, changed, removed, kept, job, at) VALUES (?, ?, ?, 1, 0, 0, 0, 1, ?, ?)",
    change,
    table,
    version,
    job,
    core.nowIso(),
  );
  return change;
}

/** The `_key`s of some of an open change's rows. */
export function addDeltaKeys(sql: SqlLike, table: string, change: number, keys: RowKeys): void {
  for (const kind of KINDS) insertKeys(sql, table, change, kind, keys[kind] ?? []);
}

/**
 * Closes an open change: it now names the rows it added, changed and removed, or, with `whole`
 * (most of the table changed), it is recorded whole and its keys go. A change that changed no row
 * is removed instead, so no reader takes it for a change (answers null). A change closed already,
 * or left by a job that failed, answers as it was recorded, so a chunk that runs again does no harm.
 */
export function closeDelta(core: StoreCore, table: string, change: number, opts: { whole?: boolean } = {}): TableDelta | null {
  const row = core.sql.exec<Record<string, StoreSqlValue>>("SELECT * FROM _deltas WHERE change = ? AND tbl = ?", change, table).toArray()[0];
  if (!row) return null;
  if (Number(row.whole) === 0 || Number(row.kept) === 0) {
    return {
      table,
      change,
      version: Number(row.version),
      whole: Number(row.whole) === 1,
      added: Number(row.added),
      changed: Number(row.changed),
      removed: Number(row.removed),
      at: String(row.at),
      job: row.job === null ? null : String(row.job),
    };
  }
  const counts = countsOf(core.sql, table, change);
  if (counts.added + counts.changed + counts.removed === 0) {
    core.sql.exec("DELETE FROM _deltas WHERE change = ? AND tbl = ?", change, table);
    return null;
  }
  const at = core.nowIso();
  if (opts.whole) {
    // Most rows: a reader takes the whole table, so the keys would only be written to go.
    core.sql.exec("DELETE FROM _delta_rows WHERE tbl = ? AND change = ?", table, change);
    core.sql.exec("UPDATE _deltas SET kept = 0, added = ?, changed = ?, removed = ?, at = ? WHERE change = ?", counts.added, counts.changed, counts.removed, at, change);
    prune(core.sql, table);
    return { table, change, version: Number(row.version), whole: true, ...counts, at, job: row.job === null ? null : String(row.job) };
  }
  core.sql.exec("UPDATE _deltas SET whole = 0, added = ?, changed = ?, removed = ?, at = ? WHERE change = ?", counts.added, counts.changed, counts.removed, at, change);
  prune(core.sql, table);
  return { table, change, version: Number(row.version), whole: false, ...counts, at, job: row.job === null ? null : String(row.job) };
}

/**
 * The rows a change added, changed and removed, as far as it went: one still open counts the keys it
 * holds. Null for a change the store has no record of.
 */
export function deltaCounts(sql: SqlLike, table: string, change: number): RowCounts | null {
  const row = sql.exec<{ whole: number; kept: number; added: number; changed: number; removed: number }>("SELECT whole, kept, added, changed, removed FROM _deltas WHERE change = ? AND tbl = ?", change, table).toArray()[0];
  if (!row) return null;
  if (Number(row.whole) === 1 && Number(row.kept) === 1) return countsOf(sql, table, change);
  return { added: Number(row.added), changed: Number(row.changed), removed: Number(row.removed) };
}

/**
 * Forgets the store's memory of a LOAD's table (`_row_hashes`), once Undo This Run took back the
 * load that wrote it: the table's next load makes it whole and remembers its rows anew.
 */
export function forgetRowHashes(sql: SqlLike, table: string): void {
  sql.exec("DELETE FROM _row_hashes WHERE tbl = ?", table);
}

/** The changes a job opened and did not close (it failed or fell back): whole for good, their keys dropped. */
export function abandonDeltas(sql: SqlLike, job: string): void {
  for (const r of sql.exec<{ change: number; tbl: string }>("SELECT change, tbl FROM _deltas WHERE job = ? AND whole = 1 AND kept = 1", job).toArray()) {
    sql.exec("DELETE FROM _delta_rows WHERE tbl = ? AND change = ?", String(r.tbl), Number(r.change));
    sql.exec("UPDATE _deltas SET kept = 0 WHERE change = ?", Number(r.change));
  }
}

/** Whether a whole change of a table came after change number `after`: most of its rows may be new. */
export function wholeSince(sql: SqlLike, table: string, after: number): boolean {
  return sql.exec("SELECT 1 FROM _deltas WHERE tbl = ? AND change > ? AND whole = 1 LIMIT 1", table, after).toArray().length > 0;
}

/** A change counts as most of a table, and is recorded whole, past this share of its rows. */
export const WHOLE_SHARE = 0.5;

/**
 * A LOAD's new version of `table` (already swapped in, inside the commit's transaction) against the
 * store's memory of the rows it took in last time: records the rows added, changed and removed by
 * `_key`, and brings the memory up to date, writing only the rows that differ. The first load, or
 * one where most rows differ, is recorded whole: counted first, so no key is written to be dropped.
 * `whole` records it whole whatever differs: a reload that stopped part way left the memory ahead
 * of the rows it names (load.ts). Each new key gets a number (`_row_hashes.n`), by which the next
 * reload marks the keys it took (jobs/claims.ts).
 */
export function recordLoadDelta(core: StoreCore, table: string, opts: { version: number; job: string | null; rows: number; whole?: boolean }): TableDelta {
  const sql = core.sql;
  const t = quote(table);
  const k = quote(KEY_COLUMN);
  const h = quote(HASH_COLUMN);
  const known = Number(sql.exec<{ n: number }>("SELECT count(*) AS n FROM _row_hashes WHERE tbl = ?", table).one().n);
  // Which rows differ from the memory: read, never written, until it is known what to keep.
  const ADDED = `FROM ${t} AS n WHERE n.${k} NOT IN (SELECT k FROM _row_hashes WHERE tbl = ?1)`;
  const CHANGED = `FROM ${t} AS n JOIN _row_hashes AS m ON m.tbl = ?1 AND m.k = n.${k} WHERE m.h IS NOT n.${h}`;
  const REMOVED = `FROM _row_hashes AS m WHERE m.tbl = ?1 AND m.k NOT IN (SELECT ${k} FROM ${t})`;
  const count = (from: string) => Number(sql.exec<{ c: number }>(`SELECT count(*) AS c ${from}`, table).one().c);
  const counts = known === 0 ? { added: opts.rows, changed: 0, removed: 0 } : { added: count(ADDED), changed: count(CHANGED), removed: count(REMOVED) };
  const whole = opts.whole === true || known === 0 || counts.added + counts.changed + counts.removed > WHOLE_SHARE * Math.max(opts.rows, known);
  const change = changeNumberAfter(sql);
  if (!whole) {
    // The keys, KEYS_PER_PART to a row.
    const parts = (kind: RowChange, keySql: string, from: string) =>
      sql.exec(
        `INSERT INTO _delta_rows (tbl, change, kind, part, keys)
         SELECT ?1, ?2, '${kind}', p, json_group_array(k) FROM (SELECT ${keySql} AS k, (row_number() OVER (ORDER BY ${keySql}) - 1) / ${KEYS_PER_PART} AS p ${from}) GROUP BY p`,
        table,
        change,
      );
    parts("added", `n.${k}`, ADDED);
    parts("changed", `n.${k}`, CHANGED);
    parts("removed", "m.k", REMOVED);
  }
  // The memory now holds this version's rows: only the hashes that differ are written, and a new
  // key its number, after the greatest.
  // Upserts over a SELECT, each row found by the primary key: an UPDATE … FROM the new table can make
  // SQLite walk one table for each row of the other.
  sql.exec(`DELETE FROM _row_hashes WHERE tbl = ? AND k NOT IN (SELECT ${k} FROM ${t})`, table);
  sql.exec(
    `INSERT INTO _row_hashes (tbl, k, h, n) SELECT ?1, x.${k}, x.${h}, NULL FROM ${t} AS x WHERE x.${k} IN (SELECT k FROM _row_hashes WHERE tbl = ?1)
     ON CONFLICT (tbl, k) DO UPDATE SET h = excluded.h WHERE _row_hashes.h IS NOT excluded.h`,
    table,
  );
  const greatest = () => Number(sql.exec<{ m: number | null }>("SELECT max(n) AS m FROM _row_hashes WHERE tbl = ?", table).one().m ?? 0);
  sql.exec(
    `INSERT INTO _row_hashes (tbl, k, h, n) SELECT ?1, x.${k}, x.${h}, ?2 + row_number() OVER (ORDER BY x.rowid) FROM ${t} AS x WHERE x.${k} NOT IN (SELECT k FROM _row_hashes WHERE tbl = ?1)`,
    table,
    greatest(),
  );
  numberKeys(sql, table, greatest);
  return insertChange(core, table, change, { version: opts.version, whole, job: opts.job, counts });
}

/**
 * Gives a number to each key of a table's memory that has none (a store from before numbers), and
 * numbers the keys again from 1 once more than half the numbers are gaps removed keys left, or
 * when a reload could not start from them (jobs/claims.ts `startClaims`: more numbers than its state
 * keeps a bit for) while the keys would fit. So the bitset a reload keeps stays the size of the
 * table, and a table never loads whole night after night for the shape of its numbers alone.
 * Writes only the keys whose number changes.
 */
function numberKeys(sql: SqlLike, table: string, greatest: () => number): void {
  const unnumbered = Number(sql.exec<{ c: number }>("SELECT count(*) AS c FROM _row_hashes WHERE tbl = ? AND n IS NULL", table).one().c);
  if (unnumbered > 0) {
    sql.exec(
      `INSERT INTO _row_hashes (tbl, k, h, n) SELECT tbl, k, h, ?2 + row_number() OVER (ORDER BY k) FROM _row_hashes WHERE tbl = ?1 AND n IS NULL
       ON CONFLICT (tbl, k) DO UPDATE SET n = excluded.n`,
      table,
      greatest(),
    );
  }
  const count = Number(sql.exec<{ c: number }>("SELECT count(*) AS c FROM _row_hashes WHERE tbl = ?", table).one().c);
  if (greatest() - count > count || (count > 0 && count < CLAIMS_MAX && !startClaims(sql, table))) {
    sql.exec(
      `INSERT INTO _row_hashes (tbl, k, h, n) SELECT tbl, k, h, row_number() OVER (ORDER BY n) FROM _row_hashes WHERE tbl = ?1
       ON CONFLICT (tbl, k) DO UPDATE SET n = excluded.n WHERE _row_hashes.n IS NOT excluded.n`,
      table,
    );
  }
}
