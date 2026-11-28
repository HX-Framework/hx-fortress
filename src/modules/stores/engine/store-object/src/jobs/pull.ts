// PULL: a database's tables into a store (DB Connect, F2). db_pull
// (the api's agent/tools/databases.ts) submits the job; a DB IO job (DB IO, a Go program:
// apps/db-io/internal/pull) then sends it pages through the gateway, with the job's
// key. `store-readers/pull` has the design and the wire.
//
//   • A pull job is a job like any other (one at a time per store, made once per request key), but
//     it does no work on its own alarms: while it takes pages its chunk only sleeps until the
//     job's time is up (`{ wait }`), and each page does its own work, in the call that brings it. Its
//     last table's end wakes it to make the tables visible, and a runner's failure or its time
//     running out wakes it to fail.
//   • A table is written one of two ways, chosen when it begins. `new`: a first pull, or one whose
//     columns or key changed, writes `<name>__new`, made visible at the end (ProgramTables). `change`:
//     the table is changed in place by `_key`, and the store's deltas record the rows each page
//     added, changed and removed (`ProgramTables.openChange`, `keys`, `close`), so SHAPE and the
//     cleanup steps read only those. Either way a table has `_key`, `_hash` and the database's
//     columns as text (the first 90; the rest as JSON in `_extra`), and a unique index on `_key`,
//     so a row is found by its name, and a page is written once whatever is sent twice.
//   • The table is its own memory. A pull reads no `_row_hashes`: the runner compares what the
//     database holds with each row's `_hash` here (`pullHashes`), and only rows that differ arrive. A
//     pull's table stays in the store (group "From the town's database"): it is never parked.
//   • A table the database refuses before any of its pages arrives (its login may not read it, or it
//     is not there) is skipped (`pullSkip`): it ends with nothing made, the job's answer names it, and
//     the other tables go on. A job whose every table was skipped fails with the database's words.
//   • The job's progress has one entry per table (`tablesProgress`): its rows read so far, as each page
//     counts them, out of the rows the database's statistics expected, what was cut, and why a table
//     was not read. The last one stays on the job after it ends.
//   • Each page is one transaction: its rows, the page's number and the job's count of rows written.
//     A page sent again is answered as taken before, and a stopped job's successor sends only what
//     the hashes now say is missing, after the last page taken.
//
// A job's key (`makeJobKey`) is also how a push's, a preview's, an undo's and a compare's DB IO job
// reaches its job (jobs/push.ts): the five kinds are the ones a DB IO job feeds through calls.

import { EXTRA_COLUMN, packRow, type ColumnPlan } from "../../../store-readers/src/index.js";
import { HASH_COLUMN as HASH, KEY_COLUMN as KEY } from "../../../store-readers/src/jobs.js";
import { ROWS_JOB_KINDS } from "../../../store-readers/src/push.js";
import {
  planPulledColumns,
  pullPickKey,
  pullRecordKey,
  PULL_LIMITS,
  PULL_STORE_LIMIT,
  pullBeginOf,
  pullEndOf,
  pullFailOf,
  pullHashesOf,
  pullPageOf,
  pullParamsOf,
  PullShapeError,
  PULLED_GROUP,
  SAMPLE_GROUP,
  type PulledTable,
  type PullBeginAnswer,
  type PullEndAnswer,
  type PullHashesAnswer,
  type PullMode,
  type PullPageAnswer,
  type PullParams,
  type PullResult,
  type PullSkipCode,
  type PullSkippedTable,
  type PullState,
  type SavedPullPick,
  pullSkipOf,
  pullWorkOf,
} from "../../../store-readers/src/pull.js";
import { sha256Hex, StoreError, type StoreCore } from "../core.js";
import { CountedSql } from "../metered-sql.js";
import { programTables, ProgramTableError } from "../program-tables.js";
import { getMeta, setMeta } from "../schema.js";
import type { SqlLike, StoreSqlValue } from "../sql.js";
import { ident as quote, isReservedName, tableExists } from "../sql.js";
import type { JobProgress, JobTableProgress } from "../types.js";
import { dayEndsAt, writesToday } from "../write-limit.js";
import { type JobContext, type JobHandler, JobParamsError } from "./types.js";

/** How long a job waits for its first DB IO job's key; a key names its own time. */
export const PULL_WAITS_MS = 45 * 60_000;
/** How long past its key's time a job with no DB IO job keeps what it took, while no other job needs the store. */
export const PULL_KEPT_AFTER_MS = 24 * 3_600_000;

/** One table of the job, as it stands. */
interface PullTableRun {
  mode: PullMode | null;
  /** Its columns and key as the runner last read them: a change makes the table anew. */
  kept: ColumnPlan["kept"];
  packed: ColumnPlan["packed"];
  key: string[];
  /** A change in place: the store before it began, for the history's Restore to Here. */
  restorePoint: string | null;
  /** A change in place: its number once a page has changed a row (`ProgramTables.openChange`). */
  change: number | null;
  /** The last page taken. */
  page: number;
  added: number;
  changed: number;
  removed: number;
  read: number;
  cut: number;
  ended: boolean;
  /** The database refused the table before any of its pages arrived: it ended with nothing made. */
  skipped?: { code: PullSkipCode; message: string } | null;
  /** The rows the runner had read so far, as its last page said. */
  readSoFar?: number;
}

export interface PullJobState {
  /** taking: pages come in. finishing: every table ended, its tables are made visible. failing: the job fails with `failure`. */
  phase: "taking" | "finishing" | "failing";
  failure: string | null;
  tables: PullTableRun[];
  /** The tables made visible so far, in order. */
  made: PulledTable[];
  /** The next table to make visible or pass over; a state from before skips counts `made` instead. */
  at?: number;
}

/**
 * What a pulled table was read from, as `_meta` keeps it: while it stays the same, a pull changes the
 * table in place. A column's name and place say what the table holds; its type's size does not (a
 * store keeps every column as text), so a wider column changes no row.
 */
function recordOf(params: PullParams, table: PullParams["tables"][number], columns: readonly string[], key: readonly string[]): string {
  return JSON.stringify({ connection: params.connection.id, source: table.source, columns, key });
}

/** A table of the job before its DB IO job begins it. */
const blankRun = (): PullTableRun => ({ mode: null, kept: [], packed: [], key: [], restorePoint: null, change: null, page: 0, added: 0, changed: 0, removed: 0, read: 0, cut: 0, ended: false });

/** A job's state grows with its tables' columns, and is one value of the store's: at most 2 MB. */
const STATE_BYTES_MAX = 1_900_000;

export const fresh = (into: string): string => `${into}__new`;

/** The store as `programTables` sees it: the same store, its statements counted in `sql`. */
export const countedCore = (core: StoreCore, sql: CountedSql): StoreCore => Object.create(core, { sql: { value: sql } }) as StoreCore;

/** A statement binds at most this many bytes of JSON: a store refuses a value past 2 MB. */
export const BIND_BYTES = 1_900_000;
const utf8Bytes = new TextEncoder();

/** A job a DB IO job feeds through calls with the job's key, as `_jobs` holds it. */
export interface KeyedJobRow {
  id: string;
  kind: string;
  state: string;
  params: string;
  run_state: string | null;
  by_sub: string;
  error: string | null;
  key_hash: string | null;
}

type PullJobRow = KeyedJobRow;

/** The kinds of job fed through calls with the job's key: a pull and a push's four (jobs/push.ts) by a DB IO job, a READ (jobs/read.ts) by the file reader. */
const KEYED_KINDS: ReadonlySet<string> = new Set(["pull", ...ROWS_JOB_KINDS, "read"]);
const PULL_KINDS: ReadonlySet<string> = new Set(["pull"]);

/** A job of one of these kinds in words, for the refusals of its calls. */
const KIND_WORDS: Readonly<Record<string, string>> = { pull: "pull", push_preview: "preview", push: "write", push_undo: "undo", compare: "compare", read: "READ" };

/** The job, refused when this store has none of that id, or it is not of one of `kinds`: `refusal` says what it does not take. */
export function keyedJob(core: StoreCore, jobId: string, kinds: ReadonlySet<string>, refusal: string): KeyedJobRow {
  const row = core.sql.exec<Record<string, StoreSqlValue>>("SELECT id, kind, state, params, run_state, by_sub, error, key_hash FROM _jobs WHERE id = ?", jobId).toArray()[0] as unknown as KeyedJobRow | undefined;
  if (!row) throw new StoreError(404, "not_found", "This store has no such job.");
  if (!kinds.has(row.kind)) throw new StoreError(400, "bad_request", refusal);
  return row;
}

/** The job, refused when this store has none of that id, or it is no pull. */
function pullJob(core: StoreCore, jobId: string): PullJobRow {
  return keyedJob(core, jobId, PULL_KINDS, "That job does not take pages.");
}

const paramsOf = (row: PullJobRow): PullParams => JSON.parse(row.params) as PullParams;
const stateOf = (row: PullJobRow): PullJobState | null => (row.run_state === null ? null : (JSON.parse(row.run_state) as PullJobState));

/** Each table of the job as its progress shows it: its rows read so far out of those expected. */
export function tablesProgress(params: PullParams, state: PullJobState): JobTableProgress[] {
  return params.tables.map((table, i) => {
    const run = state.tables[i] ?? blankRun();
    const status: JobTableProgress["state"] = run.skipped ? "skipped" : run.ended ? "done" : run.mode !== null ? "running" : "waiting";
    // Until a page says how far the runner read, the rows it sent are what it read of them.
    const done = run.ended && !run.skipped ? run.read : Math.max(run.readSoFar ?? 0, run.added + run.changed);
    return {
      name: table.into,
      source: `${table.source.schema}.${table.source.name}`,
      state: status,
      done,
      total: table.expected ?? null,
      cut: run.cut,
      added: run.added,
      changed: run.changed,
      removed: run.removed,
      ...(run.skipped ? { why: run.skipped.message } : {}),
    };
  });
}

/** The job's state and its progress, and the rows these statements wrote, joined to the job's count. */
function saveState(core: StoreCore, jobId: string, params: PullParams, state: PullJobState, rows: number, note?: string): void {
  const progress: JobProgress = {
    done: state.tables.reduce((n, t) => n + t.added + t.changed + t.removed, 0),
    total: null,
    ...(note ? { note } : {}),
    tables: tablesProgress(params, state),
  };
  core.sql.exec(
    "UPDATE _jobs SET run_state = ?, progress = ?, rows_written = coalesce(rows_written, 0) + ?, updated_at = ? WHERE id = ?",
    JSON.stringify(state),
    JSON.stringify(progress),
    rows,
    core.nowIso(),
    jobId,
  );
}

// ─── the job's key ────────────────────────────────────────────────────────────────────────────

/**
 * The key a job's DB IO job sends its calls with (a pull's pages; a push's, a preview's or a
 * compare's rows), as its caller made it (the gateway signs it, so a forged one never reaches a
 * store). The store keeps only its hash, and only the newest: a new key makes the one before it
 * refused, so two runners never write one job. `until` is how long the job waits for its DB IO job.
 */
export async function makeJobKey(core: StoreCore, jobId: string, body: { until?: unknown; key?: unknown }): Promise<{ key: string; until: string }> {
  if (typeof body.key !== "string" || !body.key) throw new StoreError(400, "bad_request", "A job's key is made by its caller.");
  const key = body.key;
  const hash = await sha256Hex(key);
  const row = keyedJob(core, jobId, KEYED_KINDS, "That job takes no DB IO job's calls, so it has no key.");
  if (row.state !== "queued" && row.state !== "running") throw new StoreError(409, "job_not_open", `This ${KIND_WORDS[row.kind] ?? "job"} has ended.`);
  const given = typeof body.until === "string" ? Date.parse(body.until) : Number.NaN;
  const until = new Date(Number.isFinite(given) ? given : core.deps.now() + PULL_WAITS_MS).toISOString();
  // A new key is a new DB IO job: the words a stopped one left on the job while it waited its turn
  // (`rowsFail`, `pullFail`) are not this one's.
  core.sql.exec("UPDATE _jobs SET key_hash = ?, key_until = ?, error = CASE WHEN state = 'queued' THEN NULL ELSE error END, updated_at = ? WHERE id = ?", hash, until, core.nowIso(), jobId);
  return { key, until };
}

/**
 * The job, for a call that carries `key`: refused unless the key is the one given last. `hash` is
 * `key`'s, taken before the first read of the job, so the rest of the call runs in one go.
 */
function admitted(core: StoreCore, jobId: string, hash: string): PullJobRow {
  const row = pullJob(core, jobId);
  if (row.key_hash !== hash) {
    throw new StoreError(403, "job_key_refused", "This key is not the one this pull takes pages with: a newer DB IO job holds it.");
  }
  return row;
}

/** The job as a call that sends pages may use it: running, taking pages, with its state. */
function taking(core: StoreCore, jobId: string, hash: string): { row: PullJobRow; params: PullParams; state: PullJobState } {
  const row = admitted(core, jobId, hash);
  const state = stateOf(row);
  if (row.state !== "running" || !state) throw new StoreError(409, "job_not_taking", "The store has not started this pull yet: another job is running.");
  if (state.phase !== "taking") throw new StoreError(409, "job_not_taking", "This pull takes no more pages: every table has ended, or it failed.");
  return { row, params: paramsOf(row), state };
}

export async function pullStateOf(core: StoreCore, jobId: string, key: string): Promise<PullState> {
  const hash = await sha256Hex(key);
  const row = admitted(core, jobId, hash);
  const params = paramsOf(row);
  const state = stateOf(row);
  const status = (): PullState["state"] => {
    if (row.state === "done") return "done";
    if (row.state === "failed") return "failed";
    if (row.state === "queued" || !state) return "waiting";
    return state.phase === "taking" ? "taking" : state.phase === "finishing" ? "finishing" : "failed";
  };
  return {
    state: status(),
    error: row.error ?? state?.failure ?? null,
    tables: params.tables.map((t, i) => {
      const run = state?.tables[i];
      return { source: t.source, into: t.into, mode: run?.mode ?? null, page: run?.page ?? 0, ended: run?.ended ?? false, ...(run?.skipped ? { skipped: true } : {}), ...(params.sample ? { sampleRows: params.sample.rows } : {}) };
    }),
    limits: PULL_LIMITS,
  };
}

// ─── a table begins ───────────────────────────────────────────────────────────────────────────

/** Why a pull may not write a table of this name, or null. */
function takenWhy(sql: SqlLike, params: PullParams, table: PullParams["tables"][number]): string | null {
  const { into, source } = table;
  if (isReservedName(into)) return `${into} is a name the store keeps for itself. Pull it under another name.`;
  const row = sql.exec<{ kind: string; grp: string | null }>("SELECT kind, grp FROM _tables WHERE lower(name) = lower(?)", into).toArray()[0];
  if (row) {
    if (row.kind !== "program") return `${into} is one of this store's own tables, which its migrations made: a pull does not write it. Pull it under another name.`;
    // A run on a sample writes its own tables, beside the whole data's.
    if (row.grp !== (params.sample ? SAMPLE_GROUP : PULLED_GROUP)) return `${into} holds rows another step made (${row.grp ?? "no group"}): a pull does not replace it. Pull it under another name.`;
    // A sample keeps no pull record: the job that made its table says what it holds, as the record
    // says it of the whole data's (`_jobs` is never pruned).
    if (params.sample) return sampleTakenWhy(sql, params, table);
    const from = recordFrom(getMeta(sql, pullRecordKey(into)));
    if (from && (from.connection !== params.connection.id || from.source.schema !== source.schema || from.source.name !== source.name)) {
      return `${into} holds rows pulled from ${from.source.schema}.${from.source.name}: a pull of ${source.schema}.${source.name} does not replace it. Pull it under another name.`;
    }
    return null;
  }
  const other = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table', 'view') AND lower(name) = lower(?)", into).toArray();
  return other.length ? `${into} is one of this store's own tables, which its migrations made: a pull does not write it. Pull it under another name.` : null;
}

/** Why a sample's pull may not write a table of the sample group: a LOAD's sample, or another source's. */
function sampleTakenWhy(sql: SqlLike, params: PullParams, table: PullParams["tables"][number]): string | null {
  const { into, source } = table;
  const made = sql.exec<{ kind: string; params: string }>("SELECT j.kind, j.params FROM _tables t JOIN _jobs j ON j.id = t.made_job WHERE lower(t.name) = lower(?)", into).toArray()[0];
  if (!made) return null;
  if (made.kind !== "pull") return `${into} holds rows a ${made.kind.toUpperCase()} took from part of the data: a pull does not replace it. Pull it under another name.`;
  let was: { connection?: { id?: unknown }; tables?: { into?: unknown; source?: { schema?: unknown; name?: unknown } }[] } = {};
  try {
    was = JSON.parse(made.params) as typeof was;
  } catch {
    return null;
  }
  const from = (was.tables ?? []).find((t) => typeof t.into === "string" && t.into.toLowerCase() === into.toLowerCase())?.source;
  if (from && (was.connection?.id !== params.connection.id || from.schema !== source.schema || from.name !== source.name)) {
    return `${into} holds rows pulled from ${String(from.schema)}.${String(from.name)}: a pull of ${source.schema}.${source.name} does not replace it. Pull it under another name.`;
  }
  return null;
}

function createTable(sql: SqlLike, table: string, run: Pick<PullTableRun, "kept" | "packed">): void {
  const columns = [`${quote(KEY)} TEXT NOT NULL`, `${quote(HASH)} TEXT NOT NULL`, ...run.kept.map((c) => `${quote(c.name)} TEXT`), ...(run.packed.length ? [`${quote(EXTRA_COLUMN)} TEXT`] : [])];
  sql.exec(`CREATE TABLE ${quote(table)} (${columns.join(", ")})`);
}

/** The connection and the table a pulled table's record names; null for none, or one it cannot read. */
function recordFrom(record: string | null | undefined): { connection: string; source: { schema: string; name: string } } | null {
  if (!record) return null;
  try {
    return JSON.parse(record) as { connection: string; source: { schema: string; name: string } };
  } catch {
    return null;
  }
}

export async function pullBegin(core: StoreCore, jobId: string, key: string, body: unknown): Promise<PullBeginAnswer> {
  const hash = await sha256Hex(key);
  // Taken before the transaction, whose work a bookmark cannot wait inside: the store as it stood
  // before the table's first page, for its history's Restore to Here.
  const restorePoint = await core.bookmark();
  return core.transaction(() => {
    const { row, params, state } = taking(core, jobId, hash);
    const begin = shaped(() => pullBeginOf(body, params.tables.length));
    const table = params.tables[begin.table]!;
    const run = state.tables[begin.table]!;
    if (run.ended) throw new StoreError(409, "job_not_taking", `${table.into} has already ended in this pull.`);
    const plan = planPulledColumns(begin.columns);
    if (run.mode !== null && JSON.stringify([run.kept, run.packed, run.key]) === JSON.stringify([plan.kept, plan.packed, begin.key])) {
      // A stopped DB IO job's successor: it goes on from the store's last page.
      return { mode: run.mode, page: run.page };
    }
    const why = takenWhy(core.sql, params, table);
    if (why) throw new StoreError(409, "pull_name_taken", why);
    // A sample's table is made new each time: it holds only some of the rows.
    const mode: PullMode = !params.sample && tableExists(core.sql, table.into) && getMeta(core.sql, pullRecordKey(table.into)) === recordOf(params, table, begin.columns.map((c) => c.name), begin.key) ? "change" : "new";
    const counted = new CountedSql(core.meter);
    if (mode === "new") {
      const tables = programTables(countedCore(core, counted), { id: jobId, by: row.by_sub });
      let name: string;
      try {
        name = tables.begin(table.into);
      } catch (error) {
        if (error instanceof ProgramTableError) throw new StoreError(409, "pull_name_taken", error.message);
        throw error;
      }
      createTable(counted, name, plan);
      counted.exec(`CREATE UNIQUE INDEX ${quote(`${table.into}__key_${jobId.replace(/^job_/, "")}`)} ON ${quote(name)} (${quote(KEY)})`);
    }
    state.tables[begin.table] = { ...blankRun(), mode, kept: plan.kept, packed: plan.packed, key: begin.key, restorePoint: mode === "change" ? restorePoint : null };
    if (utf8Bytes.encode(JSON.stringify(state)).byteLength > STATE_BYTES_MAX) {
      throw new StoreError(409, "pull_too_wide", `This pull's tables have too many columns for one job (${table.into} is where it ran out). Pull fewer tables at once.`);
    }
    saveState(core, jobId, params, state, counted.rows, `Pulling ${table.into}`);
    return { mode, page: 0 };
  });
}

/** A body the wire's check refuses, as the store's own refusal. */
export function shaped<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof PullShapeError) throw new StoreError(400, "bad_request", error.message);
    throw error;
  }
}

// ─── what the store holds of a table ──────────────────────────────────────────────────────────

/** Each row's `_key` and `_hash`, in `_key` order, after `after`: what the runner compares with the database. */
export async function pullHashes(core: StoreCore, jobId: string, key: string, body: unknown): Promise<PullHashesAnswer> {
  const hash = await sha256Hex(key);
  const { params, state } = taking(core, jobId, hash);
  const read = shaped(() => pullHashesOf(body, params.tables.length));
  const run = state.tables[read.table]!;
  if (run.mode === null) throw new StoreError(409, "pull_not_begun", "This table has not begun.");
  const table = run.mode === "new" ? fresh(params.tables[read.table]!.into) : params.tables[read.table]!.into;
  if (!tableExists(core.sql, table)) return { hashes: [], next: null };
  const limit = read.limit ?? PULL_LIMITS.hashRows;
  // Two statements, not one with an OR: each walks the `_key` index from where it starts.
  const select = `SELECT ${quote(KEY)} AS k, ${quote(HASH)} AS h FROM ${quote(table)}`;
  const rows = (read.after === null
    ? core.sql.exec<{ k: string; h: string }>(`${select} ORDER BY ${quote(KEY)} LIMIT ?`, limit)
    : core.sql.exec<{ k: string; h: string }>(`${select} WHERE ${quote(KEY)} > ? ORDER BY ${quote(KEY)} LIMIT ?`, read.after, limit)
  ).toArray();
  return { hashes: rows.map((r) => [String(r.k), String(r.h)]), next: rows.length === limit ? String(rows[rows.length - 1]!.k) : null };
}

// ─── a page ───────────────────────────────────────────────────────────────────────────────────

/** A row as the table holds it: its key, its hash, the kept columns' values, and `_extra` when the table has it. */
function storedRow(row: (string | null)[], run: PullTableRun): (string | null)[] {
  const { kept, extra } = packRow(run, row.slice(2));
  return [row[0]!, row[1]!, ...kept, ...(run.packed.length ? [extra] : [])];
}

function columnsOf(run: PullTableRun): string[] {
  return [KEY, HASH, ...run.kept.map((c) => c.name), ...(run.packed.length ? [EXTRA_COLUMN] : [])];
}

/** A statement that writes rows of `names` (`_key` among them) from one JSON array of rows, each replacing the row of its `_key`. */
export function upsertFromJson(table: string, names: readonly string[]): string {
  const list = names.map(quote).join(", ");
  const from = names.map((_, i) => `j.value ->> ${i}`).join(", ");
  const set = names.filter((n) => n !== KEY).map((n) => `${quote(n)} = excluded.${quote(n)}`).join(", ");
  return `INSERT INTO ${quote(table)} (${list}) SELECT ${from} FROM json_each(?1) AS j WHERE true ON CONFLICT (${quote(KEY)}) DO UPDATE SET ${set}`;
}

/** The same for one row, its values bound one a column: a row too long to bind as JSON. */
export function upsertOne(table: string, names: readonly string[]): string {
  const list = names.map(quote).join(", ");
  const set = names.filter((n) => n !== KEY).map((n) => `${quote(n)} = excluded.${quote(n)}`).join(", ");
  return `INSERT INTO ${quote(table)} (${list}) VALUES (${names.map(() => "?").join(", ")}) ON CONFLICT (${quote(KEY)}) DO UPDATE SET ${set}`;
}

/** Rows as JSON, grouped so each statement binds under BIND_BYTES; a row longer than that alone is `single`. */
export function batches(rows: readonly (string | null)[][]): { json: string[]; single: (string | null)[][] } {
  const json: string[] = [];
  const single: (string | null)[][] = [];
  let parts: string[] = [];
  let bytes = 2;
  const flush = () => {
    if (parts.length) json.push(`[${parts.join(",")}]`);
    parts = [];
    bytes = 2;
  };
  for (const row of rows) {
    const text = JSON.stringify(row);
    const size = utf8Bytes.encode(text).byteLength + 1;
    if (size + 2 > BIND_BYTES) {
      single.push(row);
      continue;
    }
    if (bytes + size > BIND_BYTES) flush();
    parts.push(text);
    bytes += size;
  }
  flush();
  return { json, single };
}

/** What a page's keys hold now: key to hash, read before the page writes. */
function heldHashes(sql: SqlLike, table: string, keys: readonly string[]): Map<string, string> {
  const held = new Map<string, string>();
  for (let i = 0; i < keys.length; i += 1_000) {
    const chunk = JSON.stringify(keys.slice(i, i + 1_000));
    const rows = sql.exec<{ k: string; h: string }>(`SELECT t.${quote(KEY)} AS k, t.${quote(HASH)} AS h FROM ${quote(table)} AS t WHERE t.${quote(KEY)} IN (SELECT j.value FROM json_each(?1) AS j)`, chunk);
    for (const r of rows) held.set(String(r.k), String(r.h));
  }
  return held;
}

export async function pullPage(core: StoreCore, jobId: string, key: string, body: unknown): Promise<PullPageAnswer> {
  const hash = await sha256Hex(key);
  return core.transaction(() => {
    const { row, params, state } = taking(core, jobId, hash);
    const page = shaped(() =>
      pullPageOf(body, params.tables.length, (t) => {
        const run = state.tables[t];
        if (run?.mode === null || !run) throw new PullShapeError("This table has not begun.");
        return run.kept.length + run.packed.length;
      }),
    );
    const table = params.tables[page.table]!;
    const run = state.tables[page.table]!;
    if (run.ended) throw new StoreError(409, "job_not_taking", `${table.into} has already ended in this pull.`);
    if (page.page <= run.page) return { page: page.page, taken: false, added: 0, changed: 0, removed: 0 };
    if (page.page !== run.page + 1) throw new StoreError(409, "page_out_of_order", `This table's next page is ${run.page + 1}, not ${page.page}.`);
    const target = run.mode === "new" ? fresh(table.into) : table.into;
    const counted = new CountedSql(core.meter);
    const held = heldHashes(counted, target, page.rows.map((r) => r[0]!));
    const added: string[] = [];
    const changed: string[] = [];
    const writes: (string | null)[][] = [];
    // A sample keeps no more than its first rows, whatever the runner sends: a DB IO older than
    // `sampleRows`, or a job that goes on from one that stopped, reads on past them.
    let room = params.sample ? Math.max(0, params.sample.rows - run.added) : Number.POSITIVE_INFINITY;
    for (const row of page.rows) {
      const was = held.get(row[0]!);
      if (was === undefined) {
        if (room <= 0) continue;
        room -= 1;
        added.push(row[0]!);
      } else if (was !== row[1]) changed.push(row[0]!);
      else continue;
      writes.push(storedRow(row, run));
    }
    const names = columnsOf(run);
    const { json, single } = batches(writes);
    if (json.length) {
      const statement = upsertFromJson(target, names);
      for (const batch of json) counted.exec(statement, batch);
    }
    if (single.length) {
      const statement = upsertOne(target, names);
      for (const row of single) counted.exec(statement, ...row);
    }
    const removed: string[] = [];
    // A sample removes nothing: the rows its runner did not read are not gone from the database.
    const removals = params.sample ? [] : page.removed;
    for (let i = 0; i < removals.length; i += 1_000) {
      const gone = counted.exec<{ k: string }>(`DELETE FROM ${quote(target)} WHERE ${quote(KEY)} IN (SELECT j.value FROM json_each(?1) AS j) RETURNING ${quote(KEY)} AS k`, JSON.stringify(removals.slice(i, i + 1_000))).toArray();
      for (const r of gone) removed.push(String(r.k));
    }
    if (run.mode === "change" && added.length + changed.length + removed.length > 0) {
      // The change opens at its first row, so a night with nothing new writes nothing.
      const tables = programTables(countedCore(core, counted), { id: jobId, by: row.by_sub });
      run.change ??= tables.openChange(table.into);
      tables.keys(table.into, run.change, { added, changed, removed });
    }
    run.page = page.page;
    run.added += added.length;
    run.changed += changed.length;
    run.removed += removed.length;
    if (page.read !== undefined) run.readSoFar = Math.max(run.readSoFar ?? 0, page.read);
    if (page.cut !== undefined) run.cut = Math.max(run.cut, page.cut);
    saveState(core, jobId, params, state, counted.rows, `Pulling ${table.into}`);
    return { page: page.page, taken: true, added: added.length, changed: changed.length, removed: removed.length };
  });
}

// ─── a table ends ─────────────────────────────────────────────────────────────────────────────

export async function pullEnd(core: StoreCore, jobId: string, key: string, body: unknown): Promise<PullEndAnswer> {
  const hash = await sha256Hex(key);
  const finishing = core.transaction(() => {
    // The answer to the last table's end can be lost: sent again once the store has moved on, it
    // answers the same, also after the job ended and its key went.
    if (pullJob(core, jobId).state === "done") return true;
    if (stateOf(admitted(core, jobId, hash))?.phase === "finishing") return true;
    const { params, state } = taking(core, jobId, hash);
    const end = shaped(() => pullEndOf(body, params.tables.length));
    const run = state.tables[end.table]!;
    if (run.mode === null) throw new StoreError(409, "pull_not_begun", "This table has not begun.");
    run.ended = true;
    run.read = end.read;
    run.cut = end.cut;
    const all = state.tables.every((t) => t.ended);
    if (all) state.phase = "finishing";
    saveState(core, jobId, params, state, 0, all ? "Making the tables visible" : undefined);
    return all;
  });
  if (finishing) await core.wakeAt(core.deps.now());
  return { finishing };
}

/**
 * The database refused a table before any of its pages was sent: it ends with nothing made, in the
 * database's words, and the other tables go on. Sent again for a table that ended, it answers the same.
 */
export async function pullSkip(core: StoreCore, jobId: string, key: string, body: unknown): Promise<PullEndAnswer> {
  const hash = await sha256Hex(key);
  const finishing = core.transaction(() => {
    if (pullJob(core, jobId).state === "done") return true;
    if (stateOf(admitted(core, jobId, hash))?.phase === "finishing") return true;
    const { row, params, state } = taking(core, jobId, hash);
    const skip = shaped(() => pullSkipOf(body, params.tables.length));
    const table = params.tables[skip.table]!;
    const run = state.tables[skip.table]!;
    if (run.ended) return state.tables.every((t) => t.ended);
    if (run.page > 0) throw new StoreError(409, "job_not_taking", `${table.into} took pages in this pull: it cannot be skipped now.`);
    // A table that began as new, and that the database then refused to read, drops what it began.
    if (run.mode === "new") programTables(core, { id: jobId, by: row.by_sub }).abandon(table.into);
    run.ended = true;
    run.skipped = { code: skip.code, message: skip.message };
    const all = state.tables.every((t) => t.ended);
    if (all) state.phase = "finishing";
    saveState(core, jobId, params, state, 0, all ? "Making the tables visible" : undefined);
    return all;
  });
  if (finishing) await core.wakeAt(core.deps.now());
  return { finishing };
}

/**
 * The runner could not go on: the job fails with its words, once. Stopped at the day's write limit it
 * stays open a day longer instead, with what it took, for the next DB IO job to go on from.
 */
export async function pullFail(core: StoreCore, jobId: string, key: string, body: unknown): Promise<null> {
  const hash = await sha256Hex(key);
  const row = admitted(core, jobId, hash);
  const state = stateOf(row);
  const fail = shaped(() => pullFailOf(body));
  if (row.state === "queued") {
    // It waits behind another job: its DB IO job is gone, and it says so when its turn comes.
    core.sql.exec("UPDATE _jobs SET error = ?, updated_at = ? WHERE id = ?", fail.message.slice(0, 2000), core.nowIso(), jobId);
    return null;
  }
  if (row.state !== "running" || state?.phase !== "taking") return null;
  if (fail.code === PULL_STORE_LIMIT) {
    // Nothing can write until the limit passes: until then it holds its place, and after that the
    // rule for a pull nobody is feeding applies (`pullHandler.run`).
    core.sql.exec("UPDATE _jobs SET key_until = ?, updated_at = ? WHERE id = ?", new Date(dayEndsAt(writesToday(core).day)).toISOString(), core.nowIso(), jobId);
    await core.wakeAt(core.deps.now());
    return null;
  }
  core.transaction(() => {
    state.phase = "failing";
    state.failure = fail.message;
    saveState(core, jobId, paramsOf(row), state, 0);
  });
  await core.wakeAt(core.deps.now());
  return null;
}

// ─── the handler ──────────────────────────────────────────────────────────────────────────────

/** A table of `change` mode at its end: its handle, and the step that closes its change. The runner read every row, so its count is the table's. */
function closeChange(ctx: JobContext<PullParams, PullJobState>, table: PullParams["tables"][number], run: PullTableRun): { made: PulledTable; write: () => void } {
  const row = ctx.sql.exec<{ version: number }>("SELECT version FROM _tables WHERE name = ?", table.into).one();
  const from = `${table.source.schema}.${table.source.name} in ${ctx.params.connection.name}`;
  const write = () => {
    if (run.change === null) {
      // A run that failed part way may have left the count behind. A night with nothing new writes nothing.
      ctx.sql.exec("UPDATE _tables SET rows = ? WHERE name = ? AND rows IS NOT ?", run.read, table.into, run.read);
      return;
    }
    ctx.tables.close(table.into, run.change, {
      madeBy: ctx.params.madeBy,
      restorePoint: run.restorePoint,
      note: ({ added, changed, removed }) => `${added.toLocaleString("en-US")} added, ${changed.toLocaleString("en-US")} changed, ${removed.toLocaleString("en-US")} removed, from ${from}`,
    });
  };
  return { made: resultOf(table, run, Number(row.version), run.read), write };
}

function resultOf(table: PullParams["tables"][number], run: PullTableRun, version: number, rows: number): PulledTable {
  return {
    table: table.into,
    version,
    rows,
    source: `${table.source.schema}.${table.source.name}`,
    mode: run.mode!,
    read: run.read,
    added: run.added,
    changed: run.changed,
    removed: run.removed,
    cut: run.cut,
  };
}

export const pullHandler: JobHandler<PullParams, PullJobState, PullResult> = {
  kind: "pull",
  // Its chunks write only a job's own records: each page meets the day's limit at its own call, and a
  // pull that sent all it had still ends, and its tables become visible.
  pastLimit: true,
  // A table's expected rows are the catalog's estimate: a try after a new Test Connection is the same pull.
  sameWork: (params) => pullWorkOf(params),

  parse(params) {
    try {
      return pullParamsOf(params);
    } catch (error) {
      if (error instanceof PullShapeError) throw new JobParamsError(error.message);
      throw error;
    }
  },

  async run(ctx) {
    const until = () => {
      const row = ctx.sql.exec<{ key_until: string | null; created_at: string }>("SELECT key_until, created_at FROM _jobs WHERE id = ?", ctx.job.id).one();
      return row.key_until ? Date.parse(row.key_until) : Date.parse(row.created_at) + PULL_WAITS_MS;
    };
    if (ctx.state === null) {
      // Its DB IO job stopped while it waited its turn: nothing will send its pages.
      const stopped = ctx.sql.exec<{ error: string | null }>("SELECT error FROM _jobs WHERE id = ?", ctx.job.id).one().error;
      if (stopped) throw new StoreError(502, "pull_failed", stopped);
      // The store has started this job: it takes pages until its DB IO job ends or its time is up.
      for (const table of ctx.params.tables) {
        const why = takenWhy(ctx.sql, ctx.params, table);
        if (why) throw new StoreError(409, "pull_name_taken", why);
      }
      const state: PullJobState = { phase: "taking", failure: null, tables: ctx.params.tables.map(blankRun), made: [] };
      ctx.commit({ state, progress: { done: 0, total: null, note: "Waiting for the database's rows", tables: tablesProgress(ctx.params, state) } }, () => {
        if (!ctx.params.pick) return;
        // Kept now, so a call that goes on from a stopped pull finds the same tables and this job.
        // Under a key the store makes itself: a pick names only words, never where they go.
        const saved: SavedPullPick = { words: ctx.params.pick, tables: ctx.params.tables, at: new Date(ctx.now()).toISOString(), by: ctx.job.by };
        setMeta(ctx.sql, pullPickKey(ctx.params.connection.id, ctx.params.pick), JSON.stringify(saved));
      });
      return { wait: until() };
    }
    const state = structuredClone(ctx.state);
    if (state.phase === "taking") {
      const end = until();
      if (ctx.now() < end) return { wait: end };
      // Its DB IO job's time is up and none has come back. What it took stays for whoever goes on
      // from here (a person may come back in the morning), unless another job needs the store.
      const tookSome = state.tables.some((t) => t.page > 0 || t.ended);
      if (tookSome && ctx.sql.exec("SELECT 1 AS x FROM _jobs WHERE state = 'queued' LIMIT 1").toArray().length) {
        throw new StoreError(409, "pull_gave_way", "This pull stopped and no DB IO job came back for it, so it ended when another job needed the store. Run it again.");
      }
      if (tookSome && ctx.now() < end + PULL_KEPT_AFTER_MS) return { wait: end + PULL_KEPT_AFTER_MS };
      throw new StoreError(408, "pull_timed_out", "The DB IO job stopped sending this pull's tables before they were all in, and its time is up.");
    }
    if (state.phase === "failing") throw new StoreError(502, "pull_failed", state.failure ?? "The DB IO job could not finish this pull.");
    const skipped: PullSkippedTable[] = ctx.params.tables.flatMap((table, i) => {
      const run = state.tables[i]!;
      return run.skipped ? [{ source: `${table.source.schema}.${table.source.name}`, into: table.into, code: run.skipped.code, message: run.skipped.message }] : [];
    });
    if (skipped.length === state.tables.length) {
      throw new StoreError(422, "pull_none_read", `No table of this pull could be read: ${skipped.map((t) => `${t.source}: ${t.message}`).join("; ")}`);
    }
    // Every table has ended: each is made visible, a table at a time; a skipped one is passed over.
    for (let i = state.at ?? state.made.length; i < state.tables.length; i++) {
      const table = ctx.params.tables[i]!;
      const run = state.tables[i]!;
      if (run.skipped) {
        state.at = i + 1;
        continue;
      }
      let writeChange: (() => void) | undefined;
      if (run.mode === "new") {
        if (tableExists(ctx.sql, fresh(table.into))) {
          const handle = await ctx.tables.commit(table.into, {
            group: ctx.params.sample ? SAMPLE_GROUP : PULLED_GROUP,
            madeBy: ctx.params.madeBy,
            dropOld: true,
            ...(ctx.params.keep?.[table.into] ? { keep: ctx.params.keep[table.into] } : {}),
            comment: ctx.params.sample
              ? `The first ${ctx.params.sample.rows} rows of ${table.source.schema}.${table.source.name} in ${ctx.params.connection.name}, as it answered them: a run on a sample`
              : `${table.source.schema}.${table.source.name} in ${ctx.params.connection.name}`,
            columns: [
              { name: KEY, comment: "The row's name across pulls: its primary key." },
              { name: HASH, comment: "A hash of the row's values as last pulled." },
              ...run.kept.map((c) => ({ name: c.name, originalType: c.originalType, ...(c.name !== c.source ? { comment: `"${c.source}" in the database.` } : {}) })),
              ...(run.packed.length ? [{ name: EXTRA_COLUMN, comment: "The row's other values, as JSON by column name." }] : []),
            ],
          });
          state.made.push(resultOf(table, run, handle.version, handle.rows));
        } else {
          // An earlier chunk made it visible and stopped before it said so.
          const row = ctx.sql.exec<{ version: number; rows: number }>("SELECT version, rows FROM _tables WHERE name = ?", table.into).one();
          state.made.push(resultOf(table, run, Number(row.version), Number(row.rows)));
        }
      } else {
        const closed = closeChange(ctx, table, run);
        state.made.push(closed.made);
        writeChange = closed.write;
      }
      const record = recordOf(ctx.params, table, [...run.kept, ...run.packed].map((c) => c.source), run.key);
      state.at = i + 1;
      ctx.commit({ state: structuredClone(state), progress: { done: i + 1, total: state.tables.length, note: "Making the tables visible", tables: tablesProgress(ctx.params, state) } }, () => {
        writeChange?.();
        // Written when it changes: a night with the same columns writes no row for it. A sample's
        // table keeps none: the next pull of it is new again.
        if (!ctx.params.sample && getMeta(ctx.sql, pullRecordKey(table.into)) !== record) setMeta(ctx.sql, pullRecordKey(table.into), record);
      });
      if (ctx.now() >= ctx.deadline && i + 1 < state.tables.length) return { more: true };
    }
    return { result: { tables: state.made, ...(skipped.length ? { skipped } : {}) } };
  },
};
