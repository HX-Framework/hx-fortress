// Parking (Stores, Part A): a LOAD's table leaves the store's database once a SHAPE has made a
// cleaned table from it, and waits as files in the store's bucket until something needs its rows.
//
//   • When a SHAPE ends, each LOAD table it read gets a time to park (`_tables.park_at`, after
//     PARK_AFTER_MS): long enough for the program's next steps, which often read the same table.
//     The store's alarm then submits a `park` job, once no other job is open.
//   • `park` writes the table's rows in rowid order as gzipped JSON Lines, PART_ROWS rows or about
//     PART_CHARS characters a file, under `stores/<storeId>/parked/<table>/v<version>-<id>/`, then a
//     manifest, then, in one transaction, records the files in `_parked`, marks the table parked
//     and drops it. A table brought back and parked again with no change in between keeps its
//     files and is only dropped.
//   • `bring_back` reads the files back into `<table>__new` a part a chunk, and swaps it in with
//     the same version: its rows did not change. SHAPE brings back a parked source itself.
//   • A LOAD of the town's file again keeps a parked table parked (load.ts): it writes the file's
//     rows as the table's new files, records only the changed rows, and the files before are
//     superseded (`ProgramTables.reparked`). A LOAD that makes the table whole (new columns) makes
//     a new version in the database instead (program-tables.ts commit), which supersedes them too.
//     Superseded files go once the restore window has passed, since a store restored to an earlier
//     moment may name them again. After a restore, files the restored database does not name are
//     kept as superseded too (`adoptParkedFiles`).
//   • SHAPE reads a parked driver's changed rows out of its files itself (jobs/shape.ts `byParts`),
//     and brings a parked table back only when it reads every row.
//
// The catalog lists a parked table with its columns and `parked` (data.ts), and a query that
// reads one is refused with words that say how to bring it back (handler.ts).

import { LOADED_GROUP, type ParkParams, type ParkResult } from "../../store-readers/src/jobs.js";
import { StoreError, type StoreCore } from "./core.js";
import { lastChange } from "./deltas.js";
import { submitJob } from "./jobs/runner.js";
import { type JobContext, type JobHandler, JobParamsError } from "./jobs/types.js";
import type { SqlLike, StoreSqlValue } from "./sql.js";

import { PARK_AFTER_MS } from "./park-time.js";
import { writesToday } from "./write-limit.js";
import type { StoreFiles } from "./store-files.js";
export { PARK_AFTER_MS };
/** The most rows, and about the most characters of JSON, one part file holds. */
export const PART_ROWS = 20_000;
export const PART_CHARS = 8_000_000;
/** The bytes of rows one INSERT of a bring back binds: a value is at most 2 MB in a store. */
const INSERT_BYTES = 1_000_000;
/**
 * A superseded parked table's files stay this long: a restore can return to a moment that names
 * them. The restore window (history.ts RESTORE_WINDOW_MS, written out here: history.ts imports this file).
 */
export const PARKED_KEEP_MS = 30 * 24 * 60 * 60_000;
/** Who the store names as the one who parked a table on its own. */
export const STORE_ACTOR = "store:parking";

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A column of a parked table, as its CREATE needs it again. */
export interface ParkedColumn {
  name: string;
  type: string;
  notnull: boolean;
}

/** A parked table's files, as `_parked` records them. */
export interface ParkedFiles {
  id: string;
  table: string;
  version: number;
  change: number;
  prefix: string;
  columns: ParkedColumn[];
  rows: number;
  bytes: number;
  parts: number;
  at: string;
}

export const parkedPrefix = (storeId: string, table: string, version: number, id: string): string => `stores/${storeId}/parked/${table}/v${version}-${id}/`;
export const partKey = (prefix: string, n: number): string => `${prefix}part-${String(n).padStart(5, "0")}.jsonl.gz`;

function filesOf(row: Record<string, StoreSqlValue>): ParkedFiles {
  return {
    id: String(row.id),
    table: String(row.tbl),
    version: Number(row.version),
    change: Number(row.change),
    prefix: String(row.prefix),
    columns: JSON.parse(String(row.columns)) as ParkedColumn[],
    rows: Number(row.rows),
    bytes: Number(row.bytes),
    parts: Number(row.parts),
    at: String(row.at),
  };
}

/** The files of a parked table; null when it is not parked. */
export function parkedFiles(sql: SqlLike, table: string): ParkedFiles | null {
  const row = sql
    .exec<Record<string, StoreSqlValue>>("SELECT p.* FROM _tables AS t JOIN _parked AS p ON p.id = t.parked WHERE lower(t.name) = lower(?) AND t.kind = 'program'", table)
    .toArray()[0];
  return row ? filesOf(row) : null;
}

/** Whether a table is parked: its rows are in the store's files, not its database. */
export function isParked(sql: SqlLike, table: string): boolean {
  return sql.exec("SELECT 1 FROM _tables WHERE lower(name) = lower(?) AND kind = 'program' AND parked IS NOT NULL", table).toArray().length > 0;
}

const tableExists = (sql: SqlLike, name: string): boolean => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

/** A string's length in UTF-8 bytes, which is what a store's limit on a value counts. */
export function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Two bytes below U+0800; three above it; four for a surrogate pair, two code units of it.
    if (c >= 0x80) n += c < 0x800 || (c >= 0xd800 && c <= 0xdfff) ? 1 : 2;
  }
  return n;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * Writes part `part` of a parked table's files: its rows, one JSON array a line in the files'
 * column order, gzipped. Answers its bytes. Writing a part again writes the same object.
 */
export async function putPart(bucket: StoreFiles, prefix: string, part: number, lines: readonly string[], of: { table: string; version: number }): Promise<number> {
  const bytes = await gzip(`${lines.join("\n")}\n`);
  await bucket.put(partKey(prefix, part), bytes, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { table: of.table, version: String(of.version), part: String(part), rows: String(lines.length) },
  });
  return bytes.byteLength;
}

/** Writes the manifest of a parked table's files, once every part is written. */
export async function putManifest(
  bucket: StoreFiles,
  files: { table: string; version: number; change: number; prefix: string; columns: readonly ParkedColumn[]; rows: number; parts: number; bytes: number },
): Promise<void> {
  const manifest = { table: files.table, version: files.version, change: files.change, columns: files.columns, rows: files.rows, parts: files.parts, bytes: files.bytes, format: "jsonl.gz" };
  await bucket.put(`${files.prefix}manifest.json`, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { table: files.table, version: String(files.version), rows: String(files.rows) },
  });
}

/** The rows of part `part` of a parked table's files, a JSON array each in the files' column order; null when the part is gone. */
export async function readPart(bucket: StoreFiles, prefix: string, part: number): Promise<string[] | null> {
  const object = await bucket.get(partKey(prefix, part));
  if (!object) return null;
  return (await gunzip(await object.arrayBuffer())).split("\n").filter((line) => line.length > 0);
}

const mb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function parseTable(params: unknown, what: string): ParkParams {
  if (!isRecord(params) || typeof params.table !== "string" || !params.table.trim() || params.table.length > 100) {
    throw new JobParamsError(`${what} takes the table, by its name.`);
  }
  return { table: params.table.trim() };
}

// ─── park ──────────────────────────────────────────────────────────────────────────────────────

export interface ParkState {
  id: string;
  prefix: string;
  version: number;
  change: number;
  columns: ParkedColumn[];
  /** The rowid the next part starts after. */
  after: number;
  parts: number;
  rows: number;
  bytes: number;
  /** Every row is in a part. */
  written: boolean;
  /** The files of an earlier park of this very version, reused: nothing is written. */
  reused: boolean;
  /** Characters of JSON a row took in the last part: how many rows the next part reads. */
  perRow?: number;
}

/** The table a park or a bring back names, as the catalog has it: a LOAD's table. */
function loadTable(sql: SqlLike, table: string): { name: string; version: number; parked: string | null } {
  const row = sql.exec<{ name: string; version: number; grp: string | null; parked: string | null }>("SELECT name, version, grp, parked FROM _tables WHERE lower(name) = lower(?) AND kind = 'program'", table).toArray()[0];
  if (!row) throw new StoreError(404, "not_found", `This store has no program table "${table}".`);
  if (row.grp !== LOADED_GROUP) throw new StoreError(400, "bad_request", `Only a LOAD's tables are parked; ${row.name} is a step's table.`);
  return { name: String(row.name), version: Number(row.version), parked: row.parked === null ? null : String(row.parked) };
}

export const parkHandler: JobHandler<ParkParams, ParkState, ParkResult> = {
  kind: "park",

  parse(params) {
    return parseTable(params, "Parking");
  },

  async run(ctx) {
    const sql = ctx.sql;
    const t = loadTable(sql, ctx.params.table);
    let state = ctx.state ? { ...ctx.state } : null;
    // A chunk that parked it and stopped before it said so: it is parked.
    if (state && t.parked === state.id) return { result: { table: t.name, version: t.version, rows: state.rows, parked: true } };
    if (!state) {
      if (t.parked) {
        const files = parkedFiles(sql, t.name)!;
        return { result: { table: t.name, version: t.version, rows: files.rows, parked: true } };
      }
      if (!tableExists(sql, t.name)) throw new StoreError(404, "not_found", `${t.name} is not in the store's database, so there is nothing to park.`);
      const change = lastChange(sql, t.name);
      // Brought back and not changed since: its files are still right.
      const same = sql
        .exec<Record<string, StoreSqlValue>>("SELECT * FROM _parked WHERE tbl = ? AND version = ? AND change = ? AND superseded_at IS NULL ORDER BY at DESC LIMIT 1", t.name, t.version, change)
        .toArray()[0];
      if (same) {
        const files = filesOf(same);
        state = { id: files.id, prefix: files.prefix, version: t.version, change, columns: files.columns, after: 0, parts: files.parts, rows: files.rows, bytes: files.bytes, written: true, reused: true };
      } else {
        const columns = sql
          .exec<{ name: string; type: string; notnull: number }>("SELECT name, type, \"notnull\" FROM pragma_table_info(?) ORDER BY cid", t.name)
          .toArray()
          .map((c) => ({ name: String(c.name), type: String(c.type ?? ""), notnull: Number(c.notnull) === 1 }));
        const id = ctx.job.id.replace(/^job_/, "");
        state = { id, prefix: parkedPrefix(ctx.job.storeId, t.name, t.version, id), version: t.version, change, columns, after: 0, parts: 0, rows: 0, bytes: 0, written: false, reused: false };
      }
      const begun = { ...state };
      // The files' record goes in first, marked to go: a park that fails leaves no files for good.
      const now = ctx.now();
      ctx.commit({ state: begun, progress: { done: 0, total: null, note: `Parking ${t.name}` } }, () => {
        if (begun.reused) return;
        sql.exec(
          "INSERT INTO _parked (id, tbl, version, change, prefix, columns, rows, bytes, parts, at, superseded_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?) ON CONFLICT (id) DO NOTHING",
          begun.id,
          t.name,
          begun.version,
          begun.change,
          begun.prefix,
          JSON.stringify(begun.columns),
          new Date(now).toISOString(),
          new Date(now).toISOString(),
        );
      });
    }
    const cols = state.columns.map((c, i) => `${quote(c.name)} AS c${i}`).join(", ");
    while (!state.written && ctx.now() < ctx.deadline) {
      // As many rows as a part holds, by the size of the last part's rows: wide rows are not read
      // twenty thousand at a time only to be cut at PART_CHARS.
      const limit = state.perRow ? Math.max(100, Math.min(PART_ROWS, Math.floor(PART_CHARS / state.perRow))) : Math.min(PART_ROWS, 2_000);
      const rows = sql.exec<Record<string, StoreSqlValue>>(`SELECT rowid AS r, ${cols} FROM ${quote(t.name)} WHERE rowid > ? ORDER BY rowid LIMIT ${limit}`, state.after).toArray();
      if (!rows.length) {
        state.written = true;
        break;
      }
      const lines: string[] = [];
      let chars = 0;
      let last: number = state.after;
      for (const row of rows) {
        const line = JSON.stringify(state.columns.map((_, i) => row[`c${i}`] ?? null));
        if (lines.length && chars + line.length > PART_CHARS) break;
        lines.push(line);
        chars += line.length + 1;
        last = Number(row.r);
      }
      const bytes = await putPart(ctx.bucket, state.prefix, state.parts, lines, { table: t.name, version: state.version });
      state = { ...state, after: last, parts: state.parts + 1, rows: state.rows + lines.length, bytes: state.bytes + bytes, perRow: Math.max(1, Math.ceil(chars / lines.length)) };
      const next = { ...state };
      ctx.commit({ state: next, progress: { done: next.rows, total: null, note: `Parking ${t.name}` } });
    }
    if (!state.written) return { more: true };
    if (!state.reused) await putManifest(ctx.bucket, { table: t.name, ...state });
    const done = { ...state };
    ctx.commit({ state: done, progress: { done: done.rows, total: done.rows, note: `Parked ${t.name}` } }, () =>
      ctx.tables.park(t.name, done, `${t.name}: parked in the store's files, ${done.rows.toLocaleString("en-US")} rows (${mb(done.bytes)})`),
    );
    return { result: { table: t.name, version: done.version, rows: done.rows, parked: true } };
  },
};

// ─── bring back ────────────────────────────────────────────────────────────────────────────────

export interface BringBackState {
  id: string;
  /** The part to read next. */
  part: number;
  rows: number;
  /** `<table>__new` is made. */
  made: boolean;
}

function createSql(table: string, columns: readonly ParkedColumn[]): string {
  return `CREATE TABLE ${quote(table)} (${columns.map((c) => `${quote(c.name)}${c.type ? ` ${c.type}` : ""}${c.notnull ? " NOT NULL" : ""}`).join(", ")})`;
}

function insertSql(table: string, columns: readonly ParkedColumn[]): string {
  return `INSERT INTO ${quote(table)} (${columns.map((c) => quote(c.name)).join(", ")}) SELECT ${columns.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ")} FROM json_each(?)`;
}

/**
 * One step of bringing a parked table back, within a job's chunk: makes `<table>__new`, reads a part
 * of its files into it each commit, and swaps it in with its version once every part is in. `wrap`
 * puts the step's state into the job's own, which each commit keeps. Answers the step's state, and
 * whether the table is back. A table that is not parked is back.
 */
export async function bringBackStep<S>(
  ctx: JobContext<unknown, S>,
  table: string,
  from: BringBackState | null,
  wrap: (state: BringBackState) => S,
): Promise<{ state: BringBackState | null; done: boolean; rows: number }> {
  const sql = ctx.sql;
  const files = from ? sql.exec<Record<string, StoreSqlValue>>("SELECT * FROM _parked WHERE id = ?", from.id).toArray().map(filesOf)[0] ?? null : parkedFiles(sql, table);
  if (!files) {
    if (from) throw new StoreError(409, "conflict", `The files ${table} was parked in are gone from the store's records.`);
    return { state: null, done: true, rows: 0 };
  }
  const name = files.table;
  const fresh = `${name}__new`;
  // A chunk that swapped it in and stopped before it said so: it is back.
  if (from && !isParked(sql, name) && tableExists(sql, name)) return { state: from, done: true, rows: from.rows };
  let state: BringBackState = from ? { ...from } : { id: files.id, part: 0, rows: 0, made: false };
  if (!state.made) {
    const begun = ctx.tables.begin(name);
    state = { ...state, made: true };
    const made = { ...state };
    ctx.commit({ state: wrap(made), progress: { done: 0, total: files.rows, note: `Bringing back ${name}` } }, () => void sql.exec(createSql(begun, files.columns)));
  }
  while (state.part < files.parts && ctx.now() < ctx.deadline) {
    const lines = await readPart(ctx.bucket, files.prefix, state.part);
    if (!lines) throw new StoreError(409, "conflict", `Part ${state.part + 1} of ${name}'s parked files is gone from the store's bucket.`);
    const batches: string[][] = [];
    let batch: string[] = [];
    let bytes = 0;
    for (const line of lines) {
      const size = utf8Length(line) + 1;
      if (batch.length && bytes + size > INSERT_BYTES) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(line);
      bytes += size;
    }
    if (batch.length) batches.push(batch);
    const n = batches.reduce((sum, b) => sum + b.length, 0);
    state = { ...state, part: state.part + 1, rows: state.rows + n };
    const next = { ...state };
    ctx.commit({ state: wrap(next), progress: { done: next.rows, total: files.rows, note: `Bringing back ${name}` } }, () => {
      const insert = insertSql(fresh, files.columns);
      for (const b of batches) sql.exec(insert, `[${b.join(",")}]`);
    });
  }
  if (state.part < files.parts) return { state, done: false, rows: state.rows };
  const back = { ...state };
  ctx.commit({ state: wrap(back), progress: { done: back.rows, total: back.rows, note: `Brought back ${name}` } }, () => {
    ctx.tables.swapBack(name, `${name}: brought back from the store's files, ${back.rows.toLocaleString("en-US")} rows`);
  });
  return { state: back, done: true, rows: back.rows };
}

export const bringBackHandler: JobHandler<ParkParams, BringBackState, ParkResult> = {
  kind: "bring_back",

  parse(params) {
    return parseTable(params, "Bring Back");
  },

  // Every row of the parked table is written again.
  estimate(params, view) {
    const rows = view.tableRows(params.table);
    return rows === null ? null : { rows, basis: `the rows of ${params.table}` };
  },

  async run(ctx) {
    const t = loadTable(ctx.sql, ctx.params.table);
    if (!ctx.state && !t.parked) {
      const rows = Number(ctx.sql.exec<{ rows: number | null }>("SELECT rows FROM _tables WHERE name = ?", t.name).one().rows ?? 0);
      return { result: { table: t.name, version: t.version, rows, parked: false } };
    }
    const step = await bringBackStep(ctx as unknown as JobContext<unknown, BringBackState>, t.name, ctx.state, (b) => b);
    if (!step.done) return { more: true };
    return { result: { table: t.name, version: t.version, rows: step.rows, parked: false } };
  },
};

// ─── when to park, and what goes ─────────────────────────────────────────────────────────────────

/**
 * The parks that are due, submitted as jobs once no other job is open, one table at a time. A table
 * someone read lately (`lastRead`, by lowercase name: the store's own memory, gone when the object
 * restarts) gets its time moved to a while after that read instead: parking it would only make
 * them bring it back. Answers when the next one is due, for the store's alarm.
 */
export async function parkDue(core: StoreCore, jobsOpen: boolean, lastRead: ReadonlyMap<string, number> = new Map()): Promise<number | null> {
  const sql = core.sql;
  if (!jobsOpen) {
    const now = core.nowIso();
    const due = sql
      .exec<{ name: string; version: number }>("SELECT name, version FROM _tables WHERE park_at IS NOT NULL AND park_at <= ? AND parked IS NULL AND kind = 'program' ORDER BY park_at LIMIT 1", now)
      .toArray()[0];
    if (due) {
      const name = String(due.name);
      const after = core.deps.parkAfterMs ?? PARK_AFTER_MS;
      const read = lastRead.get(name.toLowerCase());
      const writes = writesToday(core);
      if (read !== undefined && read + after > core.deps.now()) {
        sql.exec("UPDATE _tables SET park_at = ? WHERE name = ?", new Date(read + after).toISOString(), name);
      } else if (writes.rows >= writes.limit) {
        // Past today's write limit the store takes no new job: the table parks on the next UTC day.
        sql.exec("UPDATE _tables SET park_at = ? WHERE name = ?", new Date(Date.parse(`${writes.day}T00:00:00.000Z`) + 86_400_000).toISOString(), name);
      } else {
        sql.exec("UPDATE _tables SET park_at = NULL WHERE name = ?", name);
        if (tableExists(sql, name)) {
          await submitJob(core, STORE_ACTOR, { kind: "park", params: { table: name }, requestKey: `park:${name}:v${due.version}:c${lastChange(sql, name)}:${now}` });
        }
      }
    }
  }
  const next = sql.exec<{ at: string | null }>("SELECT min(park_at) AS at FROM _tables WHERE park_at IS NOT NULL AND parked IS NULL").one().at;
  return next ? Math.max(Date.parse(String(next)), core.deps.now() + 1_000) : null;
}

/** Deletes the files of parked tables superseded longer ago than the restore window. Answers when the next go. */
export async function purgeParked(core: StoreCore): Promise<number | null> {
  const cutoff = new Date(core.deps.now() - PARKED_KEEP_MS).toISOString();
  const due = core.sql.exec<{ id: string; prefix: string }>("SELECT id, prefix FROM _parked WHERE superseded_at IS NOT NULL AND superseded_at < ?", cutoff).toArray();
  for (const row of due) {
    await deletePrefix(core, String(row.prefix));
    core.sql.exec("DELETE FROM _parked WHERE id = ?", String(row.id));
  }
  const next = core.sql.exec<{ at: string | null }>("SELECT min(superseded_at) AS at FROM _parked WHERE superseded_at IS NOT NULL").one().at;
  return next ? Date.parse(String(next)) + PARKED_KEEP_MS : null;
}

async function deletePrefix(core: StoreCore, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await core.env.FILES.list({ prefix, cursor });
    if (page.objects.length) await core.env.FILES.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/**
 * After a restore: parked files in the bucket that the restored database does not name are kept
 * as superseded, so they go once the restore window has passed.
 */
export async function adoptParkedFiles(core: StoreCore, storeId: string): Promise<void> {
  const root = `stores/${storeId}/parked/`;
  const sets = new Map<string, { table: string; version: number; bytes: number; parts: number }>();
  let cursor: string | undefined;
  do {
    const page = await core.env.FILES.list({ prefix: root, cursor });
    for (const o of page.objects) {
      const m = /^(.*?\/parked\/([^/]+)\/v(\d+)-[^/]+\/)/.exec(o.key);
      if (!m) continue;
      const set = sets.get(m[1]!) ?? { table: m[2]!, version: Number(m[3]), bytes: 0, parts: 0 };
      set.bytes += o.size;
      if (o.key.endsWith(".jsonl.gz")) set.parts += 1;
      sets.set(m[1]!, set);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const known = new Set(core.sql.exec<{ prefix: string }>("SELECT prefix FROM _parked").toArray().map((r) => String(r.prefix)));
  const now = core.nowIso();
  core.transaction(() => {
    for (const [prefix, set] of sets) {
      if (known.has(prefix)) continue;
      core.sql.exec(
        "INSERT INTO _parked (id, tbl, version, change, prefix, columns, rows, bytes, parts, at, superseded_at) VALUES (?, ?, ?, 0, ?, '[]', 0, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
        `orphan_${core.deps.randomHex(8)}`,
        set.table,
        set.version,
        prefix,
        set.bytes,
        set.parts,
        now,
        now,
      );
    }
  });
}
