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

import { EXTRA_COLUMN, keepRefusal, LOADED_GROUP, READY_GROUP, shapeKey, type TableDelta } from "../../store-readers/src/jobs.js";
import type { ChangeNote, CommittedTable, ParkedFilesRecord, ProgramTableColumn, ProgramTableMadeBy, ProgramTables } from "./jobs/types.js";
import { StoreError, type StoreCore } from "./core.js";
import { addDeltaKeys, closeDelta, forgetReader, markRead, openDelta, recordDelta, recordLoadDelta, type RowKeys } from "./deltas.js";
import { parkLater } from "./park-time.js";
import { getMeta } from "./schema.js";
import type { TableHandle } from "./types.js";
import { applyFixes } from "./review.js";
import { isReservedName, PROGRAM_VERSION_RE } from "./sql.js";

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

/** Drops the versions of a table older than `keep` (every one, when `keep` is null). */
function dropOlderVersions(core: StoreCore, name: string, keep: number | null): void {
  for (const v of keptVersions(core, name)) {
    if (keep === null || v.version < keep) core.sql.exec(`DROP TABLE IF EXISTS ${quote(v.table)}`);
  }
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

export function programTables(core: StoreCore, job: { id: string; by: string }): ProgramTables {
  return {
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
        const handle = withViewsAside(core, job.by, () => commitVersion(core, job, name, opts, restorePoint));
        setBegun(core, job.id, begun(core, job.id).filter((n) => n !== name));
        // A person's fixes to the table's rows hold in its new version too.
        applyFixes(core, name);
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
        const wrote = write();
        const keys = typeof wrote === "object" ? wrote : null;
        const counts = keys ? { added: keys.added?.length ?? 0, changed: keys.changed?.length ?? 0, removed: keys.removed?.length ?? 0 } : null;
        // A write that changed nothing records nothing: a night with nothing new costs no row.
        if (wrote === false || (counts && counts.added + counts.changed + counts.removed === 0)) {
          return { table: name, version, rows: row.rows === null ? countRows(core, name) : Number(row.rows), delta: null };
        }
        // A person's fixes to the table's rows hold after a step changed them.
        applyFixes(core, name);
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
        const delta = keys ? recordDelta(core, name, { version, job: job.id, keys: keys as RowKeys }) : recordDelta(core, name, { version, job: job.id, whole: true, rows });
        core.history({ kind: "table", by: job.by, note: `${name}: ${noteOf(opts.note, delta)}`, restorePoint, ref: job.id });
        return { table: name, version, rows, delta };
      });
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
      return openDelta(core, name, Number(row.version), job.id);
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
        withViewsAside(core, job.by, () => {
          // A table of that name is kept as its last version, as a commit keeps one; a view made
          // before it keeps no rows, so the older versions go.
          if (row && tableExists(core, name)) {
            core.sql.exec(`ALTER TABLE ${quote(name)} RENAME TO ${quote(`${name}__v${row.version}`)}`);
            dropOlderVersions(core, name, Number(row.version));
          } else {
            if (viewExists(core, name)) core.sql.exec(`DROP VIEW ${quote(name)}`);
            dropOlderVersions(core, name, null);
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
        return { table: name, version, rows };
      });
    },
  };
}

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
): CommittedTable {
  const fresh = `${name}__new`;
  if (!tableExists(core, fresh)) throw new ProgramTableError(`There is no new version of "${name}" to commit.`);
  refuseWithoutKept(core, name, fresh, opts.keep);
  const row = core.sql.exec<{ kind: string; version: number; created_at: string }>("SELECT kind, version, created_at FROM _tables WHERE lower(name) = lower(?)", name).toArray()[0];
  refuseManaged(core, name, row);
  const version = row ? Number(row.version) + 1 : 1;
  // The version it replaces is kept as `<name>__v<n>`, or dropped when the step keeps one working
  // copy; older versions go either way. A parked version's files stay for the restore window.
  const keepPrevious = !opts.dropOld;
  if (row && tableExists(core, name)) {
    if (keepPrevious) core.sql.exec(`ALTER TABLE ${quote(name)} RENAME TO ${quote(`${name}__v${row.version}`)}`);
    else core.sql.exec(`DROP TABLE ${quote(name)}`);
  }
  dropOlderVersions(core, name, row && keepPrevious ? Number(row.version) : null);
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
