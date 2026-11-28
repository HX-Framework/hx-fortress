// Program tables: what LOAD, SHAPE and the later steps make (jobs/types.ts ProgramTables). Their
// names follow SQLite's plain identifiers so a person's SQL reads them unquoted: a letter, then
// letters, digits and underscores.
//
// A store keeps one working copy of each table, and the version before it:
//   • A step that makes a table anew writes `<name>__new`, then `commit` swaps it in, in one
//     transaction: the current table becomes `<name>__v<n>` (or is dropped, `dropOld`), the new
//     one becomes `<name>`, and every version older than the one kept is dropped. History keeps an
//     event for every version, with its restore point, and point-in-time restore covers 30 days.
//   • A step that changes some rows (`changed`) writes them in place: the version stays.
// Either way the store records what changed (deltas.ts), so the steps after it can read only the
// rows that changed. The program views that read a table (a SHAPE's "Ready" views) are made again
// after a swap: SQLite's RENAME would point them at the version kept.
//
// Inside a Human Program's run every change is also kept under the run (changes.ts, kind 'table'),
// so Undo This Run can take it back (B10 part 2):
//   • A new version (`commit`, `makeView`) keeps the version before as `<name>__v<n>`, `dropOld`
//     or not, and the record names it: Undo swaps it back while the table holds the run's version.
//     A table the run made goes. A version a kept change of the same run names is never dropped
//     (`spareOf`), so a run that remakes a table twice goes back through both; a later run's
//     version replaces them, as it replaces any version before it.
//   • Rows changed in place (`changed`; `openChange` … `close`; `keepRows` … `changed`) are caught
//     by the store's triggers, made in each transaction that writes them and dropped before it ends:
//     the runner's commits (`arm`, `disarm`) and `changed`'s own. Undo puts each row back as a
//     store_exec's (changes.ts), and drops the columns the change added while no later job changed
//     the table; after one did, the columns stay, with what that job wrote in them. A change whose
//     rows were written outside the job's commits (a parked table's new files, a pull's pages)
//     keeps its counts only.
//   • The settings the step keeps in `_meta` between runs (its handler's `memoryKeys`: a SHAPE's
//     SQL, a CHECK's rules, a CLASSIFY's or MATCH's answers, a PROFILE's read) are kept as they were
//     when its job started (`keepMemoryBefore`), and Undo writes them back with the table it puts
//     back. They stay in the store, in the change's record: no job's result or summary carries them.
//   • After an undo the table reads whole to every step after it, and the step that made the change
//     forgets what it had read (its handler's `undone`), so its next run makes the table whole.
// The record's own writes (the triggers' rows, its row in `_changes`) are not the job's: they come
// off the job's count and the day's (`uncounted`, `forgetCaught`).

import { EXTRA_COLUMN, keepRefusal, LOADED_GROUP, READY_GROUP, type RowCounts, shapeKey, type TableDelta } from "../../store-readers/src/jobs.js";
import type { ChangeNote, CommittedTable, ParkedFilesRecord, ProgramTableColumn, ProgramTableMadeBy, ProgramTables } from "./jobs/types.js";
import {
  catchRows,
  closeTableChange,
  dropCatch,
  keepTableChange,
  lastSeq,
  openTableChanges,
  rowidOf,
  saveTableChange,
  tableChangeOf,
  type TableChangeFor,
  type TableChangeRecord,
  type TableUndo,
} from "./changes.js";
import { StoreError, type StoreCore } from "./core.js";
import { addDeltaKeys, closeDelta, deltaCounts, forgetReader, markRead, openDelta, recordDelta, recordLoadDelta, type RowKeys } from "./deltas.js";
import { parkLater } from "./park-time.js";
import { getMeta, setMeta } from "./schema.js";
import type { TableHandle } from "./types.js";
import { applyFixes } from "./review.js";
import { isReservedName, PROGRAM_VERSION_RE, type StoreSqlValue } from "./sql.js";

export const PROGRAM_TABLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

/** A table's name as SQL takes it whatever it holds. */
export const quote = (name: string) => `\`${name.replace(/`/g, "``")}\``;

export class ProgramTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramTableError";
  }
}

function checkName(name: string): void {
  if (!PROGRAM_TABLE_NAME_RE.test(name) || isReservedName(name) || PROGRAM_VERSION_RE.test(name)) {
    throw new ProgramTableError(`"${name}" cannot name a table: use a letter, then letters, digits or underscores, and no "__v" or "__new" ending.`);
  }
}

function tableExists(core: StoreCore, name: string): boolean {
  return core.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)", name).toArray().length > 0;
}

/** Refuses a name a managed table holds: exec may have made one since the job began. */
function refuseManaged(core: StoreCore, name: string, row: { kind: string } | undefined): void {
  if ((row && row.kind !== "program") || (!row && tableExists(core, name))) {
    // A StoreError: the job fails at once, never tried again (the name will not change by itself).
    throw new StoreError(400, "bad_request", `"${name}" is a managed table: a program cannot write it. Give the program's table another name.`);
  }
}

/** The `_meta` key that lists the tables a job began and has not committed or abandoned. */
const begunKey = (jobId: string) => `job_tables:${jobId}`;

/** The tables a job began and has not committed or abandoned, oldest first: it writes each as `<name>__new`. */
export function begun(core: StoreCore, jobId: string): string[] {
  const row = core.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = ?", begunKey(jobId)).toArray()[0];
  return row ? (JSON.parse(String(row.value)) as string[]) : [];
}

function setBegun(core: StoreCore, jobId: string, names: string[]): void {
  if (names.length === 0) core.sql.exec("DELETE FROM _meta WHERE key = ?", begunKey(jobId));
  else core.sql.exec("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", begunKey(jobId), JSON.stringify(names));
}

/** The `_meta` key that keeps a run's job's settings as they were when it started (`keepMemoryBefore`). */
const memoryKey = (jobId: string) => `job_memory:${jobId}`;

/**
 * As a run's job starts, before it writes anything: keeps the settings its step keeps in `_meta`
 * between runs (`JobHandler.memoryKeys`) as they are now. Each change the job keeps carries them
 * (`ProgramTableBefore.meta`), and Undo This Run writes them back. A setting the step writes before
 * it changes any table (a CLASSIFY with no new answers) is kept as it was all the same.
 */
export function keepMemoryBefore(core: StoreCore, jobId: string, keys: readonly string[]): void {
  if (!keys.length) return;
  const before: Record<string, string | null> = {};
  for (const key of keys) before[key] = getMeta(core.sql, key);
  uncounted(core, () => setMeta(core.sql, memoryKey(jobId), JSON.stringify(before)));
}

/** A run's job's settings as they were when it started, or null when it kept none. */
function memoryBefore(core: StoreCore, jobId: string): Record<string, string | null> | null {
  const raw = getMeta(core.sql, memoryKey(jobId));
  if (!raw) return null;
  try {
    const kept = JSON.parse(raw) as unknown;
    return kept && typeof kept === "object" && !Array.isArray(kept) ? (kept as Record<string, string | null>) : null;
  } catch {
    return null;
  }
}

/** Writes a change's settings back as they were (`ProgramTableBefore.meta`), inside the undo's transaction. */
function restoreMemory(core: StoreCore, meta: Record<string, string | null> | undefined): void {
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (typeof value === "string") setMeta(core.sql, key, value);
    else core.sql.exec("DELETE FROM _meta WHERE key = ?", key);
  }
}

/**
 * Drops the tables in progress a job left (it failed, or ended without committing them). exec may
 * not touch a `<name>__new` table, so nothing else could.
 */
export function dropJobTables(core: StoreCore, jobId: string): void {
  for (const name of begun(core, jobId)) core.sql.exec(`DROP TABLE IF EXISTS ${quote(`${name}__new`)}`);
  setBegun(core, jobId, []);
}

/**
 * The versions of a table the store holds: `<name>__v<n>`, with n. The pattern names no table:
 * workerd refuses a LIKE or GLOB pattern longer than 50 bytes ("LIKE or GLOB pattern too complex"),
 * and a table loaded from a file such as "Alameda_County_Building_Permits_2019-2026.csv" has a
 * longer name than that once its underscores are escaped. So every version table is read, and the
 * name is compared here.
 */
export function keptVersions(core: StoreCore, name: string): { table: string; version: number }[] {
  const lower = name.toLowerCase();
  return core.sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*__v[0-9]*'")
    .toArray()
    .map((r) => String(r.name))
    .map((t) => ({ table: t, m: /^(.+)__v(\d+)$/i.exec(t) }))
    .filter((x): x is { table: string; m: RegExpExecArray } => !!x.m && x.m[1]!.toLowerCase() === lower)
    .map((x) => ({ table: x.table, version: Number(x.m[2]) }));
}

/**
 * Drops the versions of a table older than `keep` (every one, when `keep` is null), but those in
 * `spare` (lowercase): the versions a kept change of the run making this version names (`spareOf`).
 */
function dropOlderVersions(core: StoreCore, name: string, keep: number | null, spare: ReadonlySet<string> = NO_SPARE): void {
  for (const v of keptVersions(core, name)) {
    if ((keep === null || v.version < keep) && !spare.has(v.table.toLowerCase())) core.sql.exec(`DROP TABLE IF EXISTS ${quote(v.table)}`);
  }
}

const NO_SPARE: ReadonlySet<string> = new Set();

/**
 * The versions the kept changes of run `run` name (`<name>__v<n>`, lowercase), which its later
 * versions of a table keep: Undo This Run swaps back, newest first, each version the run made, down
 * to the one before its first. Another run's are not kept: once a later run's version replaced
 * them, that table changed since, and the earlier run's Undo leaves it as it is.
 */
function spareOf(core: StoreCore, run: string): ReadonlySet<string> {
  const spare = new Set<string>();
  for (const r of core.sql
    .exec<{ kept: string | null }>("SELECT json_extract(tables, '$[0].program.kept') AS kept FROM _changes WHERE run = ? AND kind = 'table' AND state = 'kept'", run)
    .toArray()) {
    if (typeof r.kept === "string") spare.add(r.kept.toLowerCase());
  }
  return spare;
}

/** A program view: its name and the SELECT the store keeps for it (`shapeKey`). */
interface ProgramView {
  name: string;
  sql: string;
}

/** The program views the store holds (a SHAPE's "Ready" views), with their SQL. */
export function programViews(core: StoreCore): ProgramView[] {
  const out: ProgramView[] = [];
  for (const row of core.sql
    .exec<{ name: string }>("SELECT t.name AS name FROM _tables AS t JOIN sqlite_master AS m ON m.name = t.name AND m.type = 'view' WHERE t.kind = 'program'")
    .toArray()) {
    const name = String(row.name);
    const raw = getMeta(core.sql, shapeKey(name));
    try {
      const saved = raw ? (JSON.parse(raw) as { sql?: unknown }) : null;
      if (saved && typeof saved.sql === "string") out.push({ name, sql: saved.sql });
    } catch {
      // A view whose SQL the store lost is left as it is.
    }
  }
  return out;
}

/**
 * Runs `swap` with the program views set aside: dropped first, so a RENAME neither rewrites them
 * onto the version it keeps nor fails on one that no longer runs, then made again from their SQL,
 * unless the swap gave the name to something else (a table that replaced a view, a view made
 * anew). A view that no longer runs on the new tables is left out, and its history says why.
 */
export function withViewsAside<T>(core: StoreCore, by: string, swap: () => T): T {
  const views = programViews(core);
  for (const v of views) core.sql.exec(`DROP VIEW IF EXISTS ${quote(v.name)}`);
  const result = swap();
  // A view over another view is made once the one it reads is back: each pass makes what it can.
  let pending = views.filter((v) => !core.sql.exec("SELECT 1 FROM sqlite_master WHERE lower(name) = lower(?)", v.name).toArray().length);
  while (pending.length) {
    const left = pending.filter((v) => !tryView(core, v.name, v.sql));
    if (left.length === pending.length) {
      for (const v of left) leaveOut(core, v.name, v.sql, by);
      break;
    }
    pending = left;
  }
  return result;
}

/** Makes a view, and answers whether its SELECT runs; one that does not is not left behind. */
function tryView(core: StoreCore, name: string, select: string): boolean {
  try {
    core.sql.exec(`CREATE VIEW ${quote(name)} AS ${select}`);
    core.sql.exec(`SELECT * FROM ${quote(name)} LIMIT 0`).toArray();
    return true;
  } catch {
    core.sql.exec(`DROP VIEW IF EXISTS ${quote(name)}`);
    return false;
  }
}

/** A program view whose SELECT no longer runs on the store's tables is left out, and its history says why. */
function leaveOut(core: StoreCore, name: string, select: string, by: string): void {
  let why = "";
  try {
    core.sql.exec(`EXPLAIN ${select}`).toArray();
  } catch (error) {
    why = ` (${error instanceof Error ? error.message.replace(/: SQLITE_\w+$/, "") : String(error)})`;
  }
  core.sql.exec("DELETE FROM _tables WHERE name = ? AND kind = 'program' AND grp = ?", name, READY_GROUP);
  core.history({ kind: "table", by, note: `${name}: its SELECT no longer runs on the store's tables, so the view was left out${why}. Make it again.` });
}

/** What the job runner asks of a job's tables besides what its steps do: the triggers of each of its commits. */
export interface RunTables extends ProgramTables {
  /** At a commit's start, inside its transaction: the rows the job's open changes write are caught from here. */
  arm(): void;
  /** At its end, inside the same transaction: the triggers go, and what they wrote comes off the job's count. */
  disarm(): void;
}

/**
 * Runs `work` and takes what it writes off the job's count and the day's: the record a run's change
 * keeps (its triggers, its row of `_changes`, its rows put in order) is not the job's own writing.
 */
function uncounted<T>(core: StoreCore, work: () => T): T {
  const counted = core.sql as { rows?: unknown };
  const rows = typeof counted.rows === "number" ? counted.rows : null;
  const unkept = core.meter.unkept;
  try {
    return work();
  } finally {
    core.meter.forget(unkept);
    if (rows !== null && typeof counted.rows === "number" && counted.rows > rows) counted.rows = rows;
  }
}

/** The job's count and the day's as the first of a commit's changes was armed, and the rows the triggers have caught since. */
interface CaughtSince {
  rows: number | null;
  unkept: number;
  caught: number;
}

const countedRows = (core: StoreCore): number | null => {
  const rows = (core.sql as { rows?: unknown }).rows;
  return typeof rows === "number" ? rows : null;
};

/**
 * Takes the rows the triggers caught since `s` off the job's count and the day's: each is the
 * record's, not the job's. The job wrote at least one row for each row caught, so at least that
 * many stay counted, should the platform not count a trigger's rows in its statement's (as
 * statements.ts does for a store_exec's).
 */
function forgetCaught(core: StoreCore, s: CaughtSince): void {
  if (s.caught <= 0) return;
  const counted = core.sql as { rows?: unknown };
  if (typeof counted.rows === "number" && s.rows !== null) counted.rows = s.rows + Math.max(s.caught, counted.rows - s.rows - s.caught);
  core.meter.forget(s.unkept, Math.max(s.caught, core.meter.unkept - s.unkept - s.caught));
}

/** A table's columns, in order. */
const columnsOfTable = (core: StoreCore, name: string): string[] =>
  core.sql.exec<{ name: string }>(`PRAGMA table_info(${quote(name)})`).toArray().map((c) => String(c.name));

/** A table's rows of `_columns`, as they are. */
const columnRows = (core: StoreCore, name: string): Record<string, StoreSqlValue>[] => core.sql.exec<Record<string, StoreSqlValue>>("SELECT * FROM _columns WHERE tbl = ?", name).toArray();

/** What a table was before a run's step makes a new version of it: what Undo puts back. */
interface VersionBefore {
  row: Record<string, StoreSqlValue> | null;
  columns: Record<string, StoreSqlValue>[];
  view: string | null;
  inDatabase: boolean;
  version: number | null;
  rows: number | null;
}

function versionBefore(core: StoreCore, name: string): VersionBefore {
  const row = core.sql.exec<Record<string, StoreSqlValue>>("SELECT * FROM _tables WHERE lower(name) = lower(?)", name).toArray()[0] ?? null;
  const view = core.sql.exec<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE type = 'view' AND lower(name) = lower(?)", name).toArray()[0]?.sql ?? null;
  const inDatabase = tableExists(core, name);
  const rows = row && row.rows !== null && row.rows !== undefined ? Number(row.rows) : inDatabase ? countRows(core, name) : null;
  return { row, columns: row ? columnRows(core, String(row.name)) : [], view: view === null ? null : String(view), inDatabase, version: row ? Number(row.version) : null, rows };
}

/** Keeps a run's new version of a table, or a table it made, under the run: the version before is `<name>__v<n>`. */
function keepVersion(core: StoreCore, who: TableChangeFor, name: string, before: VersionBefore, made: { version: number; rows: number; delta: TableDelta | null }): void {
  const d = made.delta;
  // A LOAD names the rows it added, changed and removed; any other new version is all new rows,
  // which its version's rows before and after say (`ChangeTableCount.version`).
  const counts = before.row && d && !d.whole ? { inserted: d.added, updated: d.changed, deleted: d.removed } : { inserted: made.rows, updated: 0, deleted: 0 };
  keepTableChange(core, who, {
    name,
    columns: [],
    ...counts,
    made: !before.row,
    ...(before.row ? {} : { rows: made.rows }),
    program: {
      how: before.row ? "version" : "made",
      kept: before.row && before.inDatabase ? `${name}__v${before.version}` : null,
      row: before.row,
      columns: before.columns,
      view: before.view,
      versionBefore: before.version,
      versionAfter: made.version,
      rowsBefore: before.rows,
      rowsAfter: made.rows,
      ...memoryOf(core, who.job),
    },
  });
}

/** The settings a run's job kept as it started (`keepMemoryBefore`), for its change's record. */
function memoryOf(core: StoreCore, jobId: string): { meta?: Record<string, string | null> } {
  const meta = memoryBefore(core, jobId);
  return meta && Object.keys(meta).length ? { meta } : {};
}

/**
 * Closes a job's changes to its run's tables that are still open, as the job ends (done, failed or
 * stopped), inside that transaction: each keeps the rows its commits caught, so Undo This Run can
 * take back what a job wrote before it stopped.
 */
export function settleRunChanges(core: StoreCore, jobId: string): void {
  for (const c of openTableChanges(core.sql, jobId)) {
    const delta = c.table.program.delta === undefined ? null : deltaCounts(core.sql, c.table.name, c.table.program.delta);
    uncounted(core, () => closeTableChange(core.sql, c.id, delta));
  }
  // Its changes keep its settings as they were; the job's own copy goes with it.
  uncounted(core, () => core.sql.exec("DELETE FROM _meta WHERE key = ?", memoryKey(jobId)));
}

export function programTables(core: StoreCore, job: { id: string; by: string; run?: string | null; step?: string | null }): RunTables {
  // A run's change in place: its rows are caught while a commit of the job, or `changed`'s own
  // transaction, writes them. Each armed change holds its triggers and where its rows stood.
  const armed = new Map<number, { triggers: string[]; seq: number }>();
  let since: CaughtSince | null = null;
  let inCommit = false;
  /** Whose run a change is: the step's `madeBy`, or the job's own for a call that names none. */
  const whose = (madeBy: ProgramTableMadeBy | null): TableChangeFor | null => {
    const run = madeBy ? madeBy.runId : (job.run ?? null);
    return run ? { run, step: madeBy ? madeBy.step : (job.step ?? null), job: job.id, by: job.by } : null;
  };
  const arm = (id: number, known?: TableChangeRecord): void => {
    if (armed.has(id)) return;
    const t = known ?? tableChangeOf(core.sql, id);
    if (!t || t.program.uncaught || !tableExists(core, t.name)) return;
    const rowid = rowidOf(t.columns);
    let triggers: string[] | null = null;
    if (rowid) {
      try {
        triggers = uncounted(core, () => catchRows(core.sql, id, 0, t.name, t.columns, rowid, { updateOf: true }));
      } catch {
        triggers = null;
      }
    }
    // A table whose rows no trigger can catch keeps its counts only.
    if (!triggers) {
      t.program.uncaught = true;
      uncounted(core, () => saveTableChange(core.sql, id, t));
      return;
    }
    since ??= { rows: countedRows(core), unkept: core.meter.unkept, caught: 0 };
    armed.set(id, { triggers, seq: lastSeq(core.sql, id) });
  };
  const disarm = (id: number): void => {
    const a = armed.get(id);
    if (!a) return;
    armed.delete(id);
    if (since) since.caught += lastSeq(core.sql, id) - a.seq;
    uncounted(core, () => dropCatch(core.sql, a.triggers));
    // The last change armed: what its triggers and the others' caught comes off the counts once.
    if (!armed.size && since) {
      forgetCaught(core, since);
      since = null;
    }
  };
  /** The job's open change to `name`, or a new one: its rows changed in place are caught from here on. */
  const openRows = (name: string, who: TableChangeFor, delta?: number): number => {
    const open = openTableChanges(core.sql, job.id).find((c) => c.table.name === name);
    if (open) {
      if (delta !== undefined && open.table.program.delta === undefined) {
        open.table.program.delta = delta;
        uncounted(core, () => saveTableChange(core.sql, open.id, open.table));
      }
      return open.id;
    }
    const row = core.sql.exec<Record<string, StoreSqlValue>>("SELECT * FROM _tables WHERE name = ?", name).toArray()[0] ?? null;
    const inDatabase = tableExists(core, name);
    const columns = inDatabase ? columnsOfTable(core, name) : [];
    const version = Number(row?.version ?? 1);
    const rows = row && row.rows !== null && row.rows !== undefined ? Number(row.rows) : inDatabase ? countRows(core, name) : 0;
    const record: TableChangeRecord = {
      name,
      columns,
      inserted: 0,
      updated: 0,
      deleted: 0,
      made: false,
      program: {
        how: "rows",
        kept: null,
        row,
        columns: columnRows(core, name),
        view: null,
        versionBefore: version,
        versionAfter: version,
        rowsBefore: rows,
        rowsAfter: rows,
        open: true,
        ...(delta !== undefined ? { delta } : {}),
        // A parked table's rows are in its files: none is caught.
        ...(inDatabase ? {} : { uncaught: true as const }),
        ...memoryOf(core, who.job),
      },
    };
    return uncounted(core, () => keepTableChange(core, who, record));
  };
  /** Closes a change whose rows no trigger caught (a pull's pages): its counts only. */
  const keepUncaught = (name: string, who: TableChangeFor, delta: TableDelta): void => {
    uncounted(core, () => {
      const id = openRows(name, who, delta.change);
      const t = tableChangeOf(core.sql, id);
      if (t) {
        t.program.uncaught = true;
        saveTableChange(core.sql, id, t);
      }
      closeTableChange(core.sql, id, delta);
    });
  };
  const countsOf = (delta: TableDelta | null): RowCounts | null => (delta ? { added: delta.added, changed: delta.changed, removed: delta.removed } : null);
  /**
   * Closes the job's open change in place to `name` before a new version replaces the table (a
   * step that fell back to making it whole): its rows are the version about to be kept as
   * `<name>__v<n>`, which Undo swaps back before it puts them back.
   */
  const closeOpenOf = (name: string): void => {
    for (const c of openTableChanges(core.sql, job.id)) {
      if (c.table.name.toLowerCase() !== name.toLowerCase()) continue;
      disarm(c.id);
      const delta = c.table.program.delta === undefined ? null : deltaCounts(core.sql, c.table.name, c.table.program.delta);
      uncounted(core, () => closeTableChange(core.sql, c.id, delta));
    }
  };

  return {
    arm() {
      inCommit = true;
      if (!job.run) return;
      for (const c of openTableChanges(core.sql, job.id)) arm(c.id, c.table);
    },

    disarm() {
      for (const id of [...armed.keys()]) disarm(id);
      inCommit = false;
    },

    begin(name) {
      checkName(name);
      const row = core.sql.exec<{ kind: string }>("SELECT kind FROM _tables WHERE lower(name) = lower(?)", name).toArray()[0];
      refuseManaged(core, name, row);
      core.sql.exec(`DROP TABLE IF EXISTS ${quote(`${name}__new`)}`);
      const names = begun(core, job.id);
      if (!names.includes(name)) setBegun(core, job.id, [...names, name]);
      return `${name}__new`;
    },

    async commit(name, opts): Promise<CommittedTable> {
      checkName(name);
      const restorePoint = await core.bookmark();
      return core.transaction(() => {
        // In a run the version before is kept, whatever the step asks, so Undo This Run can put it back.
        const who = whose(opts.madeBy);
        if (who) closeOpenOf(name);
        const before = who ? versionBefore(core, name) : null;
        const spare = who ? spareOf(core, who.run) : NO_SPARE;
        const handle = withViewsAside(core, job.by, () => commitVersion(core, job, name, who ? { ...opts, dropOld: false } : opts, restorePoint, spare));
        setBegun(core, job.id, begun(core, job.id).filter((n) => n !== name));
        // A person's fixes to the table's rows hold in its new version too.
        applyFixes(core, name);
        if (who && before) uncounted(core, () => keepVersion(core, who, name, before, handle));
        return handle;
      });
    },

    async changed(name, opts, write): Promise<CommittedTable> {
      checkName(name);
      const restorePoint = await core.bookmark();
      return core.transaction(() => {
        const row = core.sql.exec<{ kind: string; version: number; rows: number | null }>("SELECT kind, version, rows FROM _tables WHERE name = ?", name).toArray()[0];
        if (!row || row.kind !== "program" || !tableExists(core, name)) throw new ProgramTableError(`"${name}" is not a program's table, so a step does not change it in place.`);
        const version = Number(row.version);
        // In a run, the rows the step changes are caught, so Undo This Run can put them back: those
        // its earlier commits wrote (`keepRows`) are in the same record.
        const who = whose(opts.madeBy);
        const record = who ? openRows(name, who) : null;
        if (record !== null) arm(record);
        let wrote: RowKeys | boolean | void;
        let keys: RowKeys | null;
        let counts: RowCounts | null;
        let nothing: boolean;
        try {
          wrote = write();
          keys = typeof wrote === "object" ? wrote : null;
          counts = keys ? { added: keys.added?.length ?? 0, changed: keys.changed?.length ?? 0, removed: keys.removed?.length ?? 0 } : null;
          // A write that changed nothing records nothing: a night with nothing new costs no row.
          nothing = wrote === false || (counts !== null && counts.added + counts.changed + counts.removed === 0);
          // A person's fixes to the table's rows hold after a step changed them.
          if (!nothing) applyFixes(core, name);
        } finally {
          if (record !== null) disarm(record);
        }
        if (record !== null) uncounted(core, () => closeTableChange(core.sql, record, null));
        if (nothing) return { table: name, version, rows: row.rows === null ? countRows(core, name) : Number(row.rows), delta: null };
        const rows = counts && row.rows !== null ? Number(row.rows) + counts.added - counts.removed : countRows(core, name);
        const now = core.nowIso();
        core.sql.exec(
          "UPDATE _tables SET rows = ?, made_run = ?, made_step = ?, made_job = ?, made_at = ?, updated_at = ? WHERE name = ?",
          rows,
          opts.madeBy.runId,
          opts.madeBy.step,
          job.id,
          now,
          now,
          name,
        );
        const delta = keys ? recordDelta(core, name, { version, job: job.id, keys }) : recordDelta(core, name, { version, job: job.id, whole: true, rows });
        core.history({ kind: "table", by: job.by, note: `${name}: ${noteOf(opts.note, delta)}`, restorePoint, ref: job.id });
        return { table: name, version, rows, delta };
      });
    },

    keepRows(name) {
      checkName(name);
      const who = whose(null);
      if (!who) return;
      const row = core.sql.exec<{ kind: string }>("SELECT kind FROM _tables WHERE name = ?", name).toArray()[0];
      if (!row || row.kind !== "program" || !tableExists(core, name)) return;
      const record = openRows(name, who);
      if (inCommit) arm(record);
    },

    abandon(name) {
      checkName(name);
      core.sql.exec(`DROP TABLE IF EXISTS ${quote(`${name}__new`)}`);
      setBegun(core, job.id, begun(core, job.id).filter((n) => n !== name));
    },

    bookmark() {
      return core.bookmark();
    },

    swapBack(name, note) {
      checkName(name);
      const fresh = `${name}__new`;
      if (!tableExists(core, fresh)) throw new ProgramTableError(`There is no copy of "${name}" to bring back.`);
      if (tableExists(core, name)) throw new ProgramTableError(`"${name}" is in the store's database already.`);
      // A RENAME checks every view in the database: one that no longer runs would stop it.
      withViewsAside(core, job.by, () => core.sql.exec(`ALTER TABLE ${quote(fresh)} RENAME TO ${quote(name)}`));
      core.sql.exec("UPDATE _tables SET parked = NULL, park_at = NULL, updated_at = ? WHERE name = ?", core.nowIso(), name);
      // Back for a while: it parks again once its time comes, unless a step reads it first.
      parkLater(core, [name]);
      core.history({ kind: "table", by: job.by, note, ref: job.id });
      setBegun(core, job.id, begun(core, job.id).filter((n) => n !== name));
    },

    park(name, files: ParkedFilesRecord, note) {
      checkName(name);
      const now = core.nowIso();
      // The files' record went in when the park began, marked to go (a park that fails leaves no
      // files behind for good): now it says what they hold, and that they stay.
      if (!files.reused) {
        core.sql.exec(
          `INSERT INTO _parked (id, tbl, version, change, prefix, columns, rows, bytes, parts, at, superseded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (id) DO UPDATE SET columns = excluded.columns, rows = excluded.rows, bytes = excluded.bytes, parts = excluded.parts, at = excluded.at, superseded_at = NULL`,
          files.id,
          name,
          files.version,
          files.change,
          files.prefix,
          JSON.stringify(files.columns),
          files.rows,
          files.bytes,
          files.parts,
          now,
        );
      }
      // Parked again in files it had: they now say when, so each park reads as its own.
      else core.sql.exec("UPDATE _parked SET at = ? WHERE id = ?", now, files.id);
      core.sql.exec("UPDATE _tables SET parked = ?, park_at = NULL, updated_at = ? WHERE name = ?", files.id, now, name);
      withViewsAside(core, job.by, () => core.sql.exec(`DROP TABLE ${quote(name)}`));
      core.history({ kind: "table", by: job.by, note, ref: job.id });
    },

    parkLater(names) {
      parkLater(core, names);
    },

    stayInDatabase(name) {
      core.sql.exec("UPDATE _tables SET park_at = NULL WHERE name = ? AND park_at IS NOT NULL", name);
    },

    markRead(reader, table, change) {
      markRead(core, reader, table, change);
    },

    forgetReader(reader) {
      forgetReader(core, reader);
    },

    openChange(name) {
      checkName(name);
      const row = core.sql.exec<{ kind: string; version: number; parked: string | null }>("SELECT kind, version, parked FROM _tables WHERE name = ?", name).toArray()[0];
      // A parked table changes too: a LOAD of its file writes its new files and records its changed rows.
      if (!row || row.kind !== "program" || (!tableExists(core, name) && row.parked === null)) throw new ProgramTableError(`"${name}" is not a program's table, so a step does not change it in place.`);
      const change = openDelta(core, name, Number(row.version), job.id);
      // In a run, the rows the change writes from here on are caught in each of the job's commits.
      const who = whose(null);
      if (who) {
        const record = openRows(name, who, change);
        if (inCommit) arm(record);
      }
      return change;
    },

    keys(name, change, keys) {
      addDeltaKeys(core.sql, name, change, keys);
    },

    close(name, change, opts) {
      const row = core.sql.exec<{ version: number; rows: number | null }>("SELECT version, rows FROM _tables WHERE name = ?", name).one();
      const version = Number(row.version);
      const wasOpen = core.sql.exec("SELECT 1 FROM _deltas WHERE change = ? AND whole = 1 AND kept = 1", change).toArray().length > 0;
      const inDatabase = tableExists(core, name);
      // A person's fixes to the table's rows hold after a step changed them.
      if (inDatabase) applyFixes(core, name);
      const delta = closeDelta(core, name, change, { whole: opts.whole === true });
      // In a run, the record of the rows it changed closes with the change; a change whose rows were
      // written outside the job's commits (a pull's pages) keeps its counts.
      const who = whose(opts.madeBy);
      if (who) {
        const open = openTableChanges(core.sql, job.id).find((c) => c.table.name === name && (c.table.program.delta === undefined || c.table.program.delta === change));
        if (open) {
          disarm(open.id);
          uncounted(core, () => closeTableChange(core.sql, open.id, countsOf(delta)));
        } else if (delta && wasOpen) keepUncaught(name, who, delta);
      }
      // Counted, not worked out: a run that failed part way may have changed rows it never closed. A
      // parked table's rows are its files', which `reparked` recorded.
      const rows = inDatabase ? countRows(core, name) : Number(row.rows ?? 0);
      if (!delta || !wasOpen) {
        core.sql.exec("UPDATE _tables SET rows = ? WHERE name = ?", rows, name);
        return { table: name, version, rows, delta };
      }
      const now = core.nowIso();
      core.sql.exec(
        "UPDATE _tables SET rows = ?, made_run = ?, made_step = ?, made_job = ?, made_at = ?, updated_at = ? WHERE name = ?",
        rows,
        opts.madeBy.runId,
        opts.madeBy.step,
        job.id,
        now,
        now,
        name,
      );
      // The files a table brought back was parked in no longer hold its rows once they change in
      // place: they go once the restore window has passed, as a new version's would (park.ts).
      if (inDatabase) core.sql.exec("UPDATE _parked SET superseded_at = ? WHERE tbl = ? AND superseded_at IS NULL", now, name);
      core.history({ kind: "table", by: job.by, note: `${name}: ${noteOf(opts.note, delta)}`, restorePoint: opts.restorePoint, ref: job.id });
      return { table: name, version, rows, delta };
    },

    reparked(name, files) {
      checkName(name);
      const now = core.nowIso();
      // The files before go once the restore window has passed; a store restored to an earlier
      // moment may name them again (park.ts).
      core.sql.exec("UPDATE _parked SET superseded_at = ? WHERE tbl = ? AND superseded_at IS NULL AND id IS NOT ?", now, name, files.id);
      core.sql.exec(
        `INSERT INTO _parked (id, tbl, version, change, prefix, columns, rows, bytes, parts, at, superseded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version, change = excluded.change, columns = excluded.columns, rows = excluded.rows, bytes = excluded.bytes,
           parts = excluded.parts, at = excluded.at, superseded_at = NULL`,
        files.id,
        name,
        files.version,
        files.change,
        files.prefix,
        JSON.stringify(files.columns),
        files.rows,
        files.bytes,
        files.parts,
        now,
      );
      core.sql.exec("UPDATE _tables SET parked = ?, park_at = NULL, rows = ?, updated_at = ? WHERE name = ?", files.id, files.rows, now, name);
    },

    describe(name, columns) {
      for (const column of columns) {
        core.sql.exec(
          `INSERT INTO _columns (tbl, name, original_type, comment, packed_in) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (tbl, name) DO UPDATE SET original_type = excluded.original_type, comment = excluded.comment, packed_in = excluded.packed_in
           WHERE _columns.original_type IS NOT excluded.original_type OR _columns.comment IS NOT excluded.comment OR _columns.packed_in IS NOT excluded.packed_in`,
          name,
          column.name,
          column.originalType ?? null,
          column.comment ?? null,
          column.packed ? EXTRA_COLUMN : null,
        );
      }
      // A packed column the file no longer has goes: SQL would read it as empty.
      const packed = columns.filter((c) => c.packed).map((c) => c.name);
      core.sql.exec("DELETE FROM _columns WHERE tbl = ? AND packed_in IS NOT NULL AND name NOT IN (SELECT value FROM json_each(?))", name, JSON.stringify(packed));
    },

    async makeView(name, select, opts): Promise<TableHandle> {
      checkName(name);
      const restorePoint = await core.bookmark();
      return core.transaction(() => {
        const row = core.sql.exec<{ kind: string; version: number; created_at: string }>("SELECT kind, version, created_at FROM _tables WHERE lower(name) = lower(?)", name).toArray()[0];
        // A migration's table or view of that name is never replaced.
        if ((row && row.kind !== "program") || (!row && (tableExists(core, name) || viewExists(core, name)))) {
          // A StoreError, as `refuseManaged`'s: the job fails at once, never tried again.
          throw new StoreError(400, "bad_request", `"${name}" is a managed table or view: a program cannot write it. Give the program's view another name.`);
        }
        if (row?.kind === "program" && sqlGroup(core, name) === LOADED_GROUP) throw new StoreError(400, "bad_request", `"${name}" holds rows a LOAD read from the store's files: a view does not replace it.`);
        const version = row ? Number(row.version) + 1 : 1;
        // In a run, what the name was before is kept under the run: a table as its last version, a view as its SQL.
        const who = whose(opts.madeBy);
        if (who) closeOpenOf(name);
        const before = who ? versionBefore(core, name) : null;
        const spare = who ? spareOf(core, who.run) : NO_SPARE;
        withViewsAside(core, job.by, () => {
          // A table of that name is kept as its last version, as a commit keeps one; a view made
          // before it keeps no rows, so the older versions go, but those its run's changes name.
          if (row && tableExists(core, name)) {
            core.sql.exec(`ALTER TABLE ${quote(name)} RENAME TO ${quote(`${name}__v${row.version}`)}`);
            dropOlderVersions(core, name, Number(row.version), spare);
          } else {
            if (viewExists(core, name)) core.sql.exec(`DROP VIEW ${quote(name)}`);
            dropOlderVersions(core, name, null, spare);
          }
          core.sql.exec(`CREATE VIEW ${quote(name)} AS ${select}`);
        });
        // The view runs now, or nothing is made.
        const rows = Number(core.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${quote(name)}`).one().n);
        refuseWithoutKept(core, name, name, opts.keep);
        const now = core.nowIso();
        core.sql.exec(
          `INSERT INTO _tables (name, kind, version, grp, made_run, made_step, made_job, made_at, rows, comment, created_at, updated_at, key_from, parked, park_at)
           VALUES (?, 'program', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)
           ON CONFLICT (name) DO UPDATE SET kind = 'program', version = excluded.version, grp = excluded.grp, made_run = excluded.made_run,
             made_step = excluded.made_step, made_job = excluded.made_job, made_at = excluded.made_at, rows = NULL,
             comment = excluded.comment, updated_at = excluded.updated_at, key_from = NULL, parked = NULL, park_at = NULL`,
          name,
          version,
          opts.group,
          opts.madeBy.runId,
          opts.madeBy.step,
          job.id,
          now,
          opts.comment ?? null,
          row?.created_at ?? now,
          now,
        );
        core.sql.exec("DELETE FROM _columns WHERE tbl = ?", name);
        core.history({ kind: "table", by: job.by, note: `${name}: version ${version}, a view of ${rows.toLocaleString("en-US")} rows, with no rows of its own`, restorePoint, ref: job.id });
        if (who && before) uncounted(core, () => keepVersion(core, who, name, before, { version, rows, delta: null }));
        return { table: name, version, rows };
      });
    },
  };
}

/** Writes a table's row of `_tables` as it was, now, inside the caller's transaction. */
function restoreRecord(core: StoreCore, name: string, row: Record<string, StoreSqlValue>, at: string): void {
  const keys = Object.keys(row).filter((k) => k !== "name");
  if (!keys.length) return;
  const values = keys.map((k) => (k === "updated_at" ? at : (row[k] ?? null)));
  core.sql.exec(
    `INSERT INTO _tables (name, ${keys.map(quote).join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")}) ON CONFLICT (name) DO UPDATE SET ${keys.map((k) => `${quote(k)} = excluded.${quote(k)}`).join(", ")}`,
    name,
    ...values,
  );
}

/** Writes a table's rows of `_columns` as they were, inside the caller's transaction. */
function restoreColumns(core: StoreCore, name: string, rows: readonly Record<string, StoreSqlValue>[]): void {
  core.sql.exec("DELETE FROM _columns WHERE tbl = ?", name);
  for (const row of rows) {
    const keys = Object.keys(row);
    if (!keys.length) continue;
    core.sql.exec(`INSERT OR REPLACE INTO _columns (${keys.map(quote).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map((k) => row[k] ?? null));
  }
}

/**
 * How Undo This Run takes back a run's change to a program table (changes.ts `undoChange`). Each
 * part runs inside the undo's transaction.
 */
export const tableUndo: TableUndo = {
  version(core, job, t, by) {
    const p = t.program;
    const name = t.name;
    const now = core.sql.exec<{ version: number; made_job: string | null }>("SELECT version, made_job FROM _tables WHERE name = ? AND kind = 'program'", name).toArray()[0];
    // Only while the table holds the change's version, made by its job: a later version, or a later
    // change in place, stays as it is.
    const ours = !!now && Number(now.version) === p.versionAfter && now.made_job === job;
    if (!ours) return { restored: 0, held: Math.max(1, p.rowsAfter) };
    // The table holds the run's version, but the copy of the one before is gone: a later run's
    // version replaced it, and was undone since.
    if (p.kept !== null && !tableExists(core, p.kept)) {
      throw new StoreError(
        409,
        "change_version_gone",
        `This store no longer keeps ${name} as it was before this run: a later run's version of it replaced that copy. Restore to Here, in the store's Version History, puts the store back as it was before the run.`,
      );
    }
    const at = core.nowIso();
    // A table the run made has its record go first, so the views set aside are not made again on it.
    if (p.how === "made") core.sql.exec("DELETE FROM _tables WHERE name = ? AND kind = 'program'", name);
    let viewBack = true;
    withViewsAside(core, by, () => {
      if (tableExists(core, name)) core.sql.exec(`DROP TABLE ${quote(name)}`);
      if (viewExists(core, name)) core.sql.exec(`DROP VIEW ${quote(name)}`);
      if (p.how !== "version") return;
      if (p.kept) core.sql.exec(`ALTER TABLE ${quote(p.kept)} RENAME TO ${quote(name)}`);
      else if (p.view) {
        try {
          core.sql.exec(p.view);
        } catch {
          viewBack = false;
        }
      }
    });
    // The step's settings are as they were before its run: a view made again from its SQL at a later
    // swap is the one put back, and the step's next run reads what was there before.
    restoreMemory(core, p.meta);
    core.sql.exec("DELETE FROM _columns WHERE tbl = ?", name);
    // The run's version's files, should it have been parked since, go once the restore window has
    // passed, as a replaced version's do.
    core.sql.exec("UPDATE _parked SET superseded_at = ? WHERE tbl = ? AND superseded_at IS NULL", at, name);
    if (p.how === "made") return { restored: p.rowsAfter, held: 0 };
    if (!viewBack) {
      core.sql.exec("DELETE FROM _tables WHERE name = ? AND kind = 'program'", name);
      core.history({ kind: "table", by, note: `${name}: the view it was before no longer runs on the store's tables, so it was left out. Make it again.` });
      return { restored: 0, held: 0 };
    }
    if (p.row) restoreRecord(core, name, p.row, at);
    restoreColumns(core, name, p.columns);
    // The version before was parked: its files hold its rows again.
    if (p.row && typeof p.row.parked === "string") core.sql.exec("UPDATE _parked SET superseded_at = NULL WHERE id = ?", p.row.parked);
    // A person's fixes to the table's rows hold in the version put back.
    if (tableExists(core, name)) applyFixes(core, name);
    return { restored: p.rowsBefore ?? 0, held: 0 };
  },

  rows(core, job, t, usable) {
    const p = t.program;
    const name = t.name;
    if (!usable) return { restored: 0, held: p.filled ?? 0 };
    const added = (p.columnsAfter ?? t.columns).filter((c) => !t.columns.includes(c));
    const now = core.sql.exec<{ made_job: string | null }>("SELECT made_job FROM _tables WHERE name = ? AND kind = 'program'", name).toArray()[0];
    // No later job changed the table since: its maker is this change's job, or still the one it had
    // when the change began (a job that stopped before it recorded its change). Else that job's
    // change stays: the columns this change added, which it may have written, and the table's
    // record and the step's settings with them. Only the rows still as this change left them went
    // back (`putRowsBack`).
    const maker = now ? now.made_job : null;
    if (!now || (maker !== job && maker !== (p.row?.made_job ?? null))) return { restored: 0, held: added.length ? (p.filled ?? 0) : 0 };
    // The columns the change added go; one a view or an index still reads stays, emptied.
    for (const column of added) {
      try {
        core.sql.exec(`ALTER TABLE ${quote(name)} DROP COLUMN ${quote(column)}`);
      } catch {
        core.sql.exec(`UPDATE ${quote(name)} SET ${quote(column)} = NULL WHERE ${quote(column)} IS NOT NULL`);
      }
    }
    // The table's record is what it was before the change.
    if (p.row) {
      restoreRecord(core, name, p.row, core.nowIso());
      restoreColumns(core, name, p.columns);
    } else if (added.length) {
      const have = new Set(columnsOfTable(core, name));
      for (const column of added) if (!have.has(column)) core.sql.exec("DELETE FROM _columns WHERE tbl = ? AND name = ? AND packed_in IS NULL", name, column);
    }
    restoreMemory(core, p.meta);
    return { restored: p.filled ?? 0, held: 0 };
  },

  after(core, job, t, by) {
    const name = t.name;
    const sql = core.sql;
    const row = sql.exec<{ version: number }>("SELECT version FROM _tables WHERE name = ? AND kind = 'program'", name).toArray()[0];
    if (row && tableExists(core, name)) {
      const rows = countRows(core, name);
      sql.exec("UPDATE _tables SET rows = ?, updated_at = ? WHERE name = ?", rows, core.nowIso(), name);
      // Every step that reads the table reads all of it next: the rows it read last are not the rows it holds.
      recordDelta(core, name, { version: Number(row.version), job: null, by, whole: true, rows });
    }
    // The step that made the change forgets what it had read, so its next run makes the table whole.
    const made = job ? sql.exec<{ kind: string; params: string }>("SELECT kind, params FROM _jobs WHERE id = ?", job).toArray()[0] : undefined;
    const handler = made ? core.deps.jobs.get(String(made.kind)) : undefined;
    if (!made || !handler?.undone) return;
    let params: unknown = null;
    try {
      params = JSON.parse(String(made.params));
    } catch {
      return;
    }
    handler.undone(params, name, { sql, forgetReader: (reader) => forgetReader(core, reader) });
  },
};

/** The words of a change's history event. */
function noteOf(note: ChangeNote, delta: TableDelta): string {
  return typeof note === "function" ? note({ added: delta.added, changed: delta.changed, removed: delta.removed }) : note;
}

const sqlGroup = (core: StoreCore, name: string): string | null =>
  core.sql.exec<{ grp: string | null }>("SELECT grp FROM _tables WHERE lower(name) = lower(?)", name).toArray()[0]?.grp ?? null;

function viewExists(core: StoreCore, name: string): boolean {
  return core.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'view' AND lower(name) = lower(?)", name).toArray().length > 0;
}

const countRows = (core: StoreCore, name: string): number => Number(core.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${quote(name)}`).one().n);

/** Refuses a new version without a column an app on this store reads: it would break that app. */
function refuseWithoutKept(core: StoreCore, name: string, made: string, keep: ReadonlyArray<{ column: string; reader: string }> | undefined): void {
  if (!keep?.length) return;
  const have = new Set(core.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", made).toArray().map((c) => String(c.name).toLowerCase()));
  const missing = keep.filter((k) => !have.has(k.column.toLowerCase()));
  if (missing.length) throw new StoreError(400, "bad_request", keepRefusal(name, missing));
}

function commitVersion(
  core: StoreCore,
  job: { id: string; by: string },
  name: string,
  opts: {
    group?: string | null;
    madeBy: ProgramTableMadeBy;
    columns?: ProgramTableColumn[];
    comment?: string | null;
    keep?: Array<{ column: string; reader: string }>;
    dropOld?: boolean;
    delta?: "whole" | "load";
    wholeChange?: boolean;
    keyFrom?: string | null;
  },
  restorePoint: string | null,
  spare: ReadonlySet<string> = NO_SPARE,
): CommittedTable {
  const fresh = `${name}__new`;
  if (!tableExists(core, fresh)) throw new ProgramTableError(`There is no new version of "${name}" to commit.`);
  refuseWithoutKept(core, name, fresh, opts.keep);
  const row = core.sql.exec<{ kind: string; version: number; created_at: string }>("SELECT kind, version, created_at FROM _tables WHERE lower(name) = lower(?)", name).toArray()[0];
  refuseManaged(core, name, row);
  const version = row ? Number(row.version) + 1 : 1;
  // The version it replaces is kept as `<name>__v<n>`, or dropped when the step keeps one working
  // copy; older versions go either way, but those a kept change of the run names (`spare`). A
  // parked version's files stay for the restore window.
  const keepPrevious = !opts.dropOld;
  if (row && tableExists(core, name)) {
    if (keepPrevious) core.sql.exec(`ALTER TABLE ${quote(name)} RENAME TO ${quote(`${name}__v${row.version}`)}`);
    else core.sql.exec(`DROP TABLE ${quote(name)}`);
  }
  dropOlderVersions(core, name, row && keepPrevious ? Number(row.version) : null, spare);
  core.sql.exec(`ALTER TABLE ${quote(fresh)} RENAME TO ${quote(name)}`);
  const now = core.nowIso();
  core.sql.exec("UPDATE _parked SET superseded_at = ? WHERE tbl = ? AND superseded_at IS NULL", now, name);
  const rows = countRows(core, name);
  core.sql.exec(
    `INSERT INTO _tables (name, kind, version, grp, made_run, made_step, made_job, made_at, rows, comment, created_at, updated_at, key_from, parked, park_at)
     VALUES (?, 'program', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT (name) DO UPDATE SET kind = 'program', version = excluded.version, grp = excluded.grp, made_run = excluded.made_run,
       made_step = excluded.made_step, made_job = excluded.made_job, made_at = excluded.made_at, rows = excluded.rows,
       comment = excluded.comment, updated_at = excluded.updated_at, key_from = excluded.key_from, parked = NULL, park_at = NULL`,
    name,
    version,
    opts.group ?? null,
    opts.madeBy.runId,
    opts.madeBy.step,
    job.id,
    now,
    rows,
    opts.comment ?? null,
    row?.created_at ?? now,
    now,
    opts.keyFrom ?? null,
  );
  core.sql.exec("DELETE FROM _columns WHERE tbl = ?", name);
  for (const column of opts.columns ?? []) {
    core.sql.exec(
      "INSERT INTO _columns (tbl, name, original_type, comment, packed_in) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tbl, name) DO UPDATE SET original_type = excluded.original_type, comment = excluded.comment, packed_in = excluded.packed_in",
      name,
      column.name,
      column.originalType ?? null,
      column.comment ?? null,
      column.packed ? EXTRA_COLUMN : null,
    );
  }
  const delta: TableDelta =
    opts.delta === "load"
      ? recordLoadDelta(core, name, { version, job: job.id, rows, whole: opts.wholeChange === true })
      : recordDelta(core, name, { version, job: job.id, whole: true, rows });
  const changes = delta.whole ? "" : `; ${delta.added.toLocaleString("en-US")} added, ${delta.changed.toLocaleString("en-US")} changed, ${delta.removed.toLocaleString("en-US")} removed`;
  core.history({
    kind: "table",
    by: job.by,
    note: `${name}: version ${version}, ${rows.toLocaleString("en-US")} rows${changes}`,
    restorePoint,
    ref: job.id,
  });
  const handle: TableHandle = { table: name, version, rows };
  return { ...handle, delta };
}
