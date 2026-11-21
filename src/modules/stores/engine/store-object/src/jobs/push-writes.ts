// What a store keeps of its writes into a database's tables (jobs/push.ts): its memory of what it
// last wrote into each table (`_pushed`), and its record of each write, row by row
// (`_push_writes`), from which an undo takes one write back.
//
//   • The memory holds, for each key of a database's table, a hash of what the store sent, a hash of
//     what the database held after it, and whether this store put the row there (`put`).
//   • A write's record holds, for each row it wrote or removed, what it did there (`did`: inserted,
//     updated or deleted; none when it did nothing an undo can take back: a removed row gone already),
//     the hashes it sent and the database held after, the columns an update set (`set_cols`), the
//     database's row before an update or a delete (`before`), the hash of the table's other columns
//     right after an insert or right before a delete (`whole`), and the memory's entry for the key
//     before the write (`mem`: `[sent, held, put]`, or none). A row a DB IO job found already holding
//     its new values was written by an earlier DB IO job whose page the store never heard: its preview
//     says what that one did (new: inserted; changed: updated, from the values the preview read). The
//     rows a write held are not in it: it never wrote them.
//   • `state`: `pending` while the database has not committed what a page says (a write of several
//     previews, an undo: their pages are taken as they come, and nothing of them applies until the
//     DB IO job's committed end), `done` once it applies, `undone` once an undo put the row back. A
//     write of one preview takes each page `done`: its batch is committed already.
//   • An undo keeps its own outcomes under its own job: `did` is `undone` or `held`, and a held row's
//     `why` (changed, columns, too_long).
//   • A write's rows are kept as long as the store's jobs are (`_jobs` is never pruned): an undo of a
//     write of any age undoes the rows that still hold what it left.

import type { UndoneRow, UndoRow, WrittenRow } from "../../../store-readers/src/push.js";
import type { SqlLike } from "../sql.js";
import { BIND_BYTES, batches } from "./pull.js";

/** The most keys one statement looks up, changes or deletes. */
export const KEYS_AT_ONCE = 1_000;

const utf8 = new TextEncoder();
const bytesOf = (text: string): number => utf8.encode(text).byteLength;

/** Keys as JSON arrays, each of at most KEYS_AT_ONCE keys and BIND_BYTES. */
export function keyParts(keys: readonly string[]): string[] {
  const out: string[] = [];
  let part: string[] = [];
  let bytes = 2;
  for (const key of keys) {
    const size = bytesOf(JSON.stringify(key)) + 1;
    if (part.length && (part.length >= KEYS_AT_ONCE || bytes + size > BIND_BYTES)) {
      out.push(JSON.stringify(part));
      part = [];
      bytes = 2;
    }
    part.push(key);
    bytes += size;
  }
  if (part.length) out.push(JSON.stringify(part));
  return out;
}

// ─── the memory ───────────────────────────────────────────────────────────────────────────────

// A row this store put there stays one: `put` never goes back to 0.
const REMEMBER_SET =
  "ON CONFLICT (target, k) DO UPDATE SET sent = excluded.sent, held = excluded.held, at = excluded.at, put = max(_pushed.put, excluded.put) WHERE _pushed.sent IS NOT excluded.sent OR _pushed.held IS NOT excluded.held OR excluded.put > _pushed.put";

/**
 * Rows the database holds as the store wrote them (or as it would): `[key, sent, held, put]` into
 * the memory, `put` "1" for a row this store inserted, "0" for one it changed or found already
 * holding its values. A row it holds already is not written again.
 */
export function remember(sql: SqlLike, target: string, at: string, rows: (string | null)[][]): void {
  const { json, single } = batches(rows);
  for (const part of json) {
    sql.exec(`INSERT INTO _pushed (target, k, sent, held, at, put) SELECT ?1, j.value ->> 0, j.value ->> 1, j.value ->> 2, ?2, CAST(j.value ->> 3 AS INTEGER) FROM json_each(?3) AS j WHERE true ${REMEMBER_SET}`, target, at, part);
  }
  for (const row of single) sql.exec(`INSERT INTO _pushed (target, k, sent, held, at, put) VALUES (?, ?, ?, ?, ?, CAST(? AS INTEGER)) ${REMEMBER_SET}`, target, row[0], row[1], row[2], at, row[3]);
}

/** Keys the memory lets go. */
export function forget(sql: SqlLike, target: string, keys: readonly string[]): void {
  for (const part of keyParts(keys)) sql.exec("DELETE FROM _pushed WHERE target = ?1 AND k IN (SELECT value FROM json_each(?2))", target, part);
}

/** A key's entry in the memory: the hash sent, the hash held, and 1 for a row this store put there. */
export type MemoryEntry = [sent: string, held: string, put: 0 | 1];

/** The memory's entries of these keys of a database's table. */
export function memoryOf(sql: SqlLike, target: string, keys: readonly string[]): Map<string, MemoryEntry> {
  const out = new Map<string, MemoryEntry>();
  for (const part of keyParts(keys)) {
    for (const r of sql.exec<{ k: string; sent: string; held: string; put: number }>("SELECT k, sent, held, put FROM _pushed WHERE target = ?1 AND k IN (SELECT value FROM json_each(?2))", target, part)) {
      out.set(String(r.k), [String(r.sent), String(r.held), Number(r.put) === 1 ? 1 : 0]);
    }
  }
  return out;
}

// ─── a write's record ─────────────────────────────────────────────────────────────────────────

/** What a write did to one row, as its record keeps it. */
export interface WriteRecordRow {
  k: string;
  did: "inserted" | "updated" | "deleted" | null;
  /** Written rows: the hash sent, and the hash the database held after. */
  sent: string | null;
  held: string | null;
  set: string[] | null;
  before: (string | null)[] | null;
  whole: string | null;
  mem: MemoryEntry | null;
}

/** What a preview found of a key: what would happen, the columns a change changes, and the database's values it read. */
export interface Previewed {
  action: string;
  changed: string[] | null;
  before: (string | null)[] | null;
}

/**
 * A batch's outcomes as a write's record keeps them: its written and removed rows, each with the
 * memory's entry for its key before the write. A written row with no `did` held its new values when
 * its DB IO job came: an earlier DB IO job wrote it, and its page never reached the store. Its preview
 * says what that one did: a new row it inserted, a changed one it updated from the values the preview
 * read (`previewed`). An outcome an undo cannot take back is kept with no `did`: a removed row that
 * was gone already (an earlier DB IO job's delete, or someone else's), a changed row whose preview
 * kept no values.
 */
export function recordRows(outcomes: readonly WrittenRow[], memory: ReadonlyMap<string, MemoryEntry>, previewed: ReadonlyMap<string, Previewed>): WriteRecordRow[] {
  const out: WriteRecordRow[] = [];
  for (const o of outcomes) {
    if (o.outcome === "held") continue;
    const mem = memory.get(o.key) ?? null;
    if (o.outcome === "removed") {
      out.push({ k: o.key, did: o.before ? "deleted" : null, sent: null, held: null, set: null, before: o.before, whole: o.before ? (o.whole ?? null) : null, mem });
      continue;
    }
    let did: WriteRecordRow["did"] = o.did === "inserted" ? "inserted" : o.did === "updated" && o.set?.length && o.before ? "updated" : null;
    let set = did === "updated" ? o.set : null;
    let before = did === "updated" ? o.before : null;
    if (o.did === null || o.did === undefined) {
      const was = previewed.get(o.key);
      if (was?.action === "new") did = "inserted";
      else if (was?.action === "changed" && was.changed?.length && was.before) [did, set, before] = ["updated", was.changed, was.before];
    }
    out.push({ k: o.key, did, sent: o.sent, held: o.held, set, before, whole: did === "inserted" ? (o.whole ?? null) : null, mem });
  }
  return out;
}

const RECORD_COLUMNS = "job, part, k, did, sent, held, set_cols, before, whole, mem, state";
// A row sent again keeps the memory's entry the first one read: what the key held before the write.
const RECORD_SET = "ON CONFLICT (job, part, k) DO UPDATE SET did = excluded.did, sent = excluded.sent, held = excluded.held, set_cols = excluded.set_cols, before = excluded.before, whole = excluded.whole, state = excluded.state";

/** A batch's rows into a write's record: `pending` until the database committed them, or `done`. */
export function recordWrites(sql: SqlLike, job: string, part: number, rows: readonly WriteRecordRow[], state: "pending" | "done"): void {
  const packed = rows.map((r) => [r.k, r.did, r.sent, r.held, r.set ? JSON.stringify(r.set) : null, r.before ? JSON.stringify(r.before) : null, r.whole, r.mem ? JSON.stringify(r.mem) : null]);
  const { json, single } = batches(packed);
  for (const chunk of json) {
    sql.exec(
      `INSERT INTO _push_writes (${RECORD_COLUMNS}) SELECT ?1, ?2, j.value ->> 0, j.value ->> 1, j.value ->> 2, j.value ->> 3, j.value ->> 4, j.value ->> 5, j.value ->> 6, j.value ->> 7, ?3 FROM json_each(?4) AS j WHERE true ${RECORD_SET}`,
      job,
      part,
      state,
      chunk,
    );
  }
  for (const row of single) sql.exec(`INSERT INTO _push_writes (${RECORD_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${RECORD_SET}`, job, part, ...row, state);
}

/** Which of these keys a job's record holds already for one of its parts. */
export function recordedKeys(sql: SqlLike, job: string, part: number, keys: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of keyParts(keys)) {
    for (const r of sql.exec<{ k: string }>("SELECT k FROM _push_writes WHERE job = ?1 AND part = ?2 AND k IN (SELECT value FROM json_each(?3))", job, part, p)) out.add(String(r.k));
  }
  return out;
}

/** A job's pending rows go: its DB IO job begins again, or the job failed before its database committed. */
export function forgetPending(sql: SqlLike, job: string): void {
  sql.exec("DELETE FROM _push_writes WHERE job = ? AND state = 'pending'", job);
}

/** A batch of a job's pending rows of one part, after `after`, in key order. */
export function pendingRows(sql: SqlLike, job: string, part: number, after: string | null, limit: number): { k: string; did: string | null; sent: string | null; held: string | null }[] {
  type Row = { k: string; did: string | null; sent: string | null; held: string | null };
  const select = "SELECT k, did, sent, held FROM _push_writes WHERE job = ?1 AND part = ?2 AND state = 'pending'";
  const rows = after === null ? sql.exec<Row>(`${select} ORDER BY k LIMIT ?3`, job, part, limit) : sql.exec<Row>(`${select} AND k > ?4 ORDER BY k LIMIT ?3`, job, part, limit, after);
  return rows.toArray().map((r) => ({ k: String(r.k), did: r.did === null ? null : String(r.did), sent: r.sent === null ? null : String(r.sent), held: r.held === null ? null : String(r.held) }));
}

/** Rows of a job's record, of one part, from one state to another. */
export function markRows(sql: SqlLike, job: string, part: number, keys: readonly string[], from: "pending" | "done", to: "done" | "undone"): void {
  for (const p of keyParts(keys)) {
    sql.exec("UPDATE _push_writes SET state = ?4 WHERE job = ?1 AND part = ?2 AND state = ?5 AND k IN (SELECT value FROM json_each(?3))", job, part, p, to, from);
  }
}

// ─── an undo ──────────────────────────────────────────────────────────────────────────────────

const UNDOABLE = "state = 'done' AND did IN ('inserted', 'updated', 'deleted')";
/** An undo reads a part's rows of one kind: those its write removed, or those it inserted or updated. */
const UNDO_KINDS = { removals: " AND did = 'deleted'", puts: " AND did IN ('inserted', 'updated')" } as const;

/** The rows of a write's part an undo takes back, after `after`, in key order: every kind, or `only` one. */
export function undoRows(sql: SqlLike, write: string, part: number, after: string | null, limit: number, only?: keyof typeof UNDO_KINDS): UndoRow[] {
  type Row = { k: string; did: string; held: string | null; set_cols: string | null; before: string | null; whole: string | null };
  const select = `SELECT k, did, held, set_cols, before, whole FROM _push_writes WHERE job = ?1 AND part = ?2 AND ${UNDOABLE}${only ? UNDO_KINDS[only] : ""}`;
  const rows = after === null ? sql.exec<Row>(`${select} ORDER BY k LIMIT ?3`, write, part, limit) : sql.exec<Row>(`${select} AND k > ?4 ORDER BY k LIMIT ?3`, write, part, limit, after);
  return rows.toArray().map((r): UndoRow => {
    const did = String(r.did) as UndoRow["did"];
    return {
      key: String(r.k),
      did,
      held: did === "deleted" || r.held === null ? null : String(r.held),
      set: did === "updated" && r.set_cols !== null ? (JSON.parse(String(r.set_cols)) as string[]) : null,
      before: did !== "inserted" && r.before !== null ? (JSON.parse(String(r.before)) as (string | null)[]) : null,
      whole: did !== "updated" && r.whole !== null ? String(r.whole) : null,
    };
  });
}

/** How many rows of a write's part an undo takes back. */
export function undoCount(sql: SqlLike, write: string, part: number): number {
  return Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM _push_writes WHERE job = ?1 AND part = ?2 AND ${UNDOABLE}`, write, part).one().n);
}

/** What an undo of a write's part takes back, by what the write did: the counts its question gives. */
export function undoableCounts(sql: SqlLike, write: string, part: number): { inserted: number; updated: number; deleted: number } {
  const out = { inserted: 0, updated: 0, deleted: 0 };
  for (const r of sql.exec<{ did: string; n: number }>(`SELECT did, count(*) AS n FROM _push_writes WHERE job = ?1 AND part = ?2 AND state IN ('done', 'undone') AND did IN ('inserted', 'updated', 'deleted') GROUP BY did`, write, part)) {
    out[String(r.did) as keyof typeof out] = Number(r.n);
  }
  return out;
}

/** What a write did to each of these keys of a part, among the rows an undo takes back. */
export function undoableOf(sql: SqlLike, write: string, part: number, keys: readonly string[]): Map<string, UndoRow["did"]> {
  const out = new Map<string, UndoRow["did"]>();
  for (const p of keyParts(keys)) {
    for (const r of sql.exec<{ k: string; did: string }>(`SELECT k, did FROM _push_writes WHERE job = ?1 AND part = ?2 AND ${UNDOABLE} AND k IN (SELECT value FROM json_each(?3))`, write, part, p)) {
      out.set(String(r.k), String(r.did) as UndoRow["did"]);
    }
  }
  return out;
}

/** An undo's outcomes into its own record, pending until its database committed; a held row with why. */
export function recordUndone(sql: SqlLike, undo: string, part: number, rows: readonly UndoneRow[]): void {
  const { json, single } = batches(rows.map((r) => [r.key, r.outcome, r.outcome === "held" ? (r.why ?? "changed") : null]));
  for (const p of json) {
    sql.exec(`INSERT INTO _push_writes (job, part, k, did, why, state) SELECT ?1, ?2, j.value ->> 0, j.value ->> 1, j.value ->> 2, 'pending' FROM json_each(?3) AS j WHERE true ON CONFLICT (job, part, k) DO UPDATE SET did = excluded.did, why = excluded.why, state = excluded.state`, undo, part, p);
  }
  for (const row of single) sql.exec("INSERT INTO _push_writes (job, part, k, did, why, state) VALUES (?, ?, ?, ?, ?, 'pending') ON CONFLICT (job, part, k) DO UPDATE SET did = excluded.did, why = excluded.why, state = excluded.state", undo, part, row[0], row[1], row[2]);
}

/**
 * After an undo committed: each undone key's memory as it was before the write (`mem`; none: the
 * key is forgotten). When a later write of another key or other columns began the memory anew
 * (`fits` false), the entries are of other columns, so the keys only go from it.
 */
export function putBack(sql: SqlLike, target: string, at: string, write: string, part: number, keys: readonly string[], fits: boolean): void {
  if (!fits) {
    forget(sql, target, keys);
    return;
  }
  for (const p of keyParts(keys)) {
    sql.exec(
      `INSERT INTO _pushed (target, k, sent, held, at, put)
       SELECT ?1, w.k, w.mem ->> 0, w.mem ->> 1, ?2, CAST(w.mem ->> 2 AS INTEGER) FROM _push_writes AS w
       WHERE w.job = ?3 AND w.part = ?4 AND w.mem IS NOT NULL AND w.k IN (SELECT value FROM json_each(?5))
       ON CONFLICT (target, k) DO UPDATE SET sent = excluded.sent, held = excluded.held, at = excluded.at, put = excluded.put`,
      target,
      at,
      write,
      part,
      p,
    );
    sql.exec(
      "DELETE FROM _pushed WHERE target = ?1 AND k IN (SELECT w.k FROM _push_writes AS w WHERE w.job = ?2 AND w.part = ?3 AND w.mem IS NULL AND w.k IN (SELECT value FROM json_each(?4)))",
      target,
      write,
      part,
      p,
    );
  }
}
