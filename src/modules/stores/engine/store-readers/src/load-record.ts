// What a store's own records say of its loads: which file each LOAD read into which table.
//
// A LOAD keeps, in the store's `_jobs`, the files it was given (`LoadParams.files`) and, once it is
// done, the tables it made and the files it could not read (`LoadResult`). Nothing else ties a file
// to a table for good. A table's rows carry `_file`, but a parked table has no rows to read, and a
// file loaded again into the same table changes only the rows that differ, so the rest keep the
// earlier file's `_file`.
//
// `loadRecordSql` reads the record through a store's `query` door and `readLoadRecord` reads its
// answer. They live beside the contract they read, and store-object tests them against real
// loads (src/load-record.test.ts): a change to what a LOAD records fails there, not in whoever
// reads the record.
//
// What the record does not say, and how this reads it:
//   - A done load names each table's file by its NAME (`LoadedTable.file`), not its id. A load takes
//     its files in order and lists its tables in that order, so of several files of one name the
//     first takes the first table of that name. A file of several tables (a workbook's sheets)
//     takes them in a run, which ends where a sheet's name comes again. Where the counts fit
//     neither way, each of those files is given all of those tables, marked `unclear`.
//   - A load that failed keeps no result. The tables it made before it failed are still the
//     store's, so the caller names the tables whose present rows each job made (the catalog's
//     `madeBy.job`), and a table is given to the file whose name it was made from (`filePrefixes`).

import { filePrefixes } from "./names.js";

/** The most rows of the record one statement answers: a store's `query` answers at most this many. */
export const LOAD_RECORD_ROWS = 1000;

/** A row of the record's answer, by column name. */
export type LoadRecordRow = Readonly<Record<string, string | number | null | undefined>>;

/** One load of one file into one table. */
export interface FileLoad {
  fileId: string;
  /** The file's name as the load knew it; "" for a memo file, which a load knows by its id alone. */
  fileName: string;
  table: string;
  /** The table's rows when the load ended; null for a load that failed after it made the table. */
  rows: number | null;
  /** The table's version the load left; null for a load that failed. */
  version: number | null;
  job: string;
  /** When the load ended. */
  at: string;
  /** The load found every row as the table already had it, and changed none. */
  unchanged?: true;
  /** The file is the memo file of this one (a dBase or FoxPro table's), which the load read with it. */
  memoOf?: string;
  /** The load held several files of this name and its record does not tell their tables apart: each has all of them. */
  unclear?: true;
}

/** A file a load was given and read into no table. */
export interface UnreadFile {
  fileId: string;
  fileName: string;
  /** Why, in the load's own words. */
  why: string;
  job: string;
  at: string;
}

export interface LoadRecord {
  /** Every load of a file into a table, newest load first. */
  loads: FileLoad[];
  /** Files a load read into no table, newest load first. */
  unread: UnreadFile[];
  /** The ids of the files a load that has not ended was given. */
  loading: string[];
  /** The store has more loads than the answer held: older ones are missing. */
  cut: boolean;
}

const text = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The statement that reads a store's record of loads, newest load first: one row for each file a
 * load was given, each table a done load made, each file it skipped, and a failed load's error.
 * With `only`, the loads that were given one of those files, whole. Send it with
 * `limit: LOAD_RECORD_ROWS`.
 */
export function loadRecordSql(only?: { fileIds: readonly string[] }): string {
  const ids = only ? only.fileIds.map(text).join(", ") : "";
  const load = only
    ? `j.kind = 'load' AND j.id IN (SELECT j2.id FROM main.\`_jobs\` j2, json_each(j2.params, '$.files') f2 WHERE j2.kind = 'load' AND (json_extract(f2.value, '$.id') IN (${ids}) OR json_extract(f2.value, '$.memo.id') IN (${ids})))`
    : `j.kind = 'load'`;
  // seq is the job's place among the store's jobs: they are kept in the order they were asked for, and run one at a time.
  const head = (k: string): string => `SELECT '${k}' AS k, j.rowid AS seq, j.id AS job, j.state AS state, j.updated_at AS at`;
  return [
    `SELECT * FROM (`,
    `${head("file")}, f.key AS i, json_extract(f.value, '$.id') AS a, json_extract(f.value, '$.name') AS b, json_extract(f.value, '$.memo.id') AS c, NULL AS n, NULL AS v, NULL AS d`,
    `FROM main.\`_jobs\` j, json_each(j.params, '$.files') f WHERE ${load}`,
    `UNION ALL`,
    // d: the rows the load added, changed and removed; NULL where it made the table whole.
    `${head("table")}, t.key AS i, json_extract(t.value, '$.table') AS a, json_extract(t.value, '$.file') AS b, json_extract(t.value, '$.sheet') AS c, json_extract(t.value, '$.rows') AS n, json_extract(t.value, '$.version') AS v,`,
    `json_extract(t.value, '$.changes.added') + json_extract(t.value, '$.changes.changed') + json_extract(t.value, '$.changes.removed') AS d`,
    `FROM main.\`_jobs\` j, json_each(j.result, '$.tables') t WHERE ${load} AND j.state = 'done'`,
    `UNION ALL`,
    `${head("skipped")}, s.key AS i, NULL AS a, json_extract(s.value, '$.file') AS b, substr(json_extract(s.value, '$.why'), 1, 300) AS c, NULL AS n, NULL AS v, NULL AS d`,
    `FROM main.\`_jobs\` j, json_each(j.result, '$.skipped') s WHERE ${load} AND j.state = 'done'`,
    `UNION ALL`,
    `${head("error")}, 0 AS i, NULL AS a, NULL AS b, substr(j.error, 1, 300) AS c, NULL AS n, NULL AS v, NULL AS d`,
    `FROM main.\`_jobs\` j WHERE ${load} AND j.state = 'failed'`,
    `) ORDER BY seq DESC, k, i`,
  ].join("\n");
}

interface JobFile {
  i: number;
  id: string;
  name: string;
  memo: string | null;
}

interface JobTable {
  i: number;
  table: string;
  file: string;
  sheet: string | null;
  rows: number | null;
  version: number | null;
  unchanged: boolean;
}

interface Job {
  job: string;
  state: string;
  at: string;
  files: JobFile[];
  tables: JobTable[];
  skipped: { i: number; file: string; why: string }[];
  error: string | null;
}

const str = (value: string | number | null | undefined): string => (value === null || value === undefined ? "" : String(value));
const num = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** A done load's tables of one file name, as runs: one run a file. A run ends where a sheet's name comes again. */
function runs(tables: readonly JobTable[]): JobTable[][] {
  const out: JobTable[][] = [];
  let seen = new Set<string>();
  for (const table of tables) {
    const sheet = table.sheet ?? "";
    if (out.length === 0 || seen.has(sheet)) {
      out.push([]);
      seen = new Set();
    }
    seen.add(sheet);
    out[out.length - 1]!.push(table);
  }
  return out;
}

/** Whether a table's name is one a LOAD makes from a file whose part of the name is `prefix`: the part, the part and a sheet, or the part and a number. */
function madeFrom(table: string, prefix: string): "named" | "numbered" | null {
  if (table === prefix || table.startsWith(`${prefix}__`)) return "named";
  // `unusedName` cuts a taken name at 56 characters and adds a number.
  const base = prefix.slice(0, 56);
  return table.startsWith(base) && /^_\d+$/.test(table.slice(base.length)) ? "numbered" : null;
}

/**
 * The record, read. `truncated` is the answer's own (`StoreQueryResult.truncated`), and `made`
 * names, by job id, the tables whose present rows that job made (a catalog's `madeBy.job`): a load
 * that failed is read from it.
 */
export function readLoadRecord(rows: readonly LoadRecordRow[], opts: { truncated?: boolean; made?: ReadonlyMap<string, readonly string[]> } = {}): LoadRecord {
  const jobs = new Map<string, Job>();
  for (const row of rows) {
    const id = str(row.job);
    let job = jobs.get(id);
    if (!job) {
      job = { job: id, state: str(row.state), at: str(row.at), files: [], tables: [], skipped: [], error: null };
      jobs.set(id, job);
    }
    const i = num(row.i) ?? 0;
    if (row.k === "file") job.files.push({ i, id: str(row.a), name: str(row.b), memo: row.c === null || row.c === undefined ? null : str(row.c) });
    else if (row.k === "table" && row.a !== null && row.a !== undefined) job.tables.push({ i, table: str(row.a), file: str(row.b), sheet: row.c === null || row.c === undefined ? null : str(row.c), rows: num(row.n), version: num(row.v), unchanged: num(row.d) === 0 });
    else if (row.k === "skipped") job.skipped.push({ i, file: str(row.b), why: str(row.c) });
    else if (row.k === "error") job.error = str(row.c);
  }
  // An answer cut short may hold only some rows of its last, oldest load: that load is left out.
  if (opts.truncated && jobs.size > 1) jobs.delete([...jobs.keys()].at(-1)!);

  const record: LoadRecord = { loads: [], unread: [], loading: [], cut: opts.truncated === true };
  for (const job of jobs.values()) {
    const byPlace = <T extends { i: number }>(list: T[]): T[] => list.sort((x, y) => x.i - y.i);
    const files = byPlace(job.files);
    if (job.state === "queued" || job.state === "running") {
      for (const file of files) record.loading.push(file.id, ...(file.memo ? [file.memo] : []));
      continue;
    }
    // Each file's tables, by the file's place among the load's files.
    const given = new Map<number, { tables: JobTable[]; unclear: boolean }>();
    if (job.state === "done") {
      const tables = byPlace(job.tables);
      for (const name of new Set(files.map((file) => file.name))) {
        const named = files.filter((file) => file.name === name);
        const made = tables.filter((table) => table.file === name);
        if (made.length === 0) continue;
        const each = named.length === 1 ? [made] : made.length === named.length ? made.map((table) => [table]) : runs(made);
        if (each.length === named.length) named.forEach((file, k) => given.set(file.i, { tables: each[k]!, unclear: false }));
        else for (const file of named) given.set(file.i, { tables: made, unclear: true });
      }
    } else {
      // A load that failed: the tables it made that are still the store's, by the name each was made from.
      const prefixes = filePrefixes(files.map((file) => file.name));
      for (const table of [...(opts.made?.get(job.job) ?? [])].sort()) {
        const fits = (how: "named" | "numbered"): JobFile[] => files.filter((file, k) => madeFrom(table, prefixes[k]!) === how);
        const candidates = fits("named").length > 0 ? fits("named") : fits("numbered");
        // Of several files of one name, the first that has no table yet.
        const file = candidates.find((candidate) => !given.has(candidate.i)) ?? candidates.at(-1);
        if (!file) continue;
        const entry = given.get(file.i) ?? { tables: [], unclear: false };
        entry.tables.push({ i: entry.tables.length, table, file: file.name, sheet: null, rows: null, version: null, unchanged: false });
        given.set(file.i, entry);
      }
    }
    for (const file of files) {
      const mine = given.get(file.i);
      // A memo file was read with its table's file: what that file became, it became.
      const both: { id: string; name: string; memoOf?: string }[] = [{ id: file.id, name: file.name }, ...(file.memo ? [{ id: file.memo, name: "", memoOf: file.name }] : [])];
      if (mine && mine.tables.length > 0) {
        for (const table of mine.tables) {
          for (const one of both) {
            record.loads.push({
              fileId: one.id,
              fileName: one.name,
              table: table.table,
              rows: table.rows,
              version: table.version,
              job: job.job,
              at: job.at,
              ...(table.unchanged ? { unchanged: true as const } : {}),
              ...(one.memoOf ? { memoOf: one.memoOf } : {}),
              ...(mine.unclear ? { unclear: true as const } : {}),
            });
          }
        }
        continue;
      }
      const why =
        job.state === "done"
          ? (job.skipped.find((skipped) => skipped.file === file.name)?.why ?? "A load read it and made no table from it.")
          : `The load that was given it failed${job.error ? `: ${job.error}` : "."}`;
      for (const one of both) record.unread.push({ fileId: one.id, fileName: one.name, why, job: job.job, at: job.at });
    }
  }
  return record;
}
