// A store's own tables, made the first time its object wakes. Their names start with `_`; the
// catalog shows them as quiet system tables, and `exec` and `migrate` never touch them.
//
//   _meta        key → value: the store's id, when it was made, a destroy mark, rows written per
//                day, and the organization its callers' tokens name (write-limit.ts)
//   _tables      every program and managed table: kind, version, group, what made it, rows, and
//                a LOAD table's second name, its name in full where LOAD cut it (`full_name`,
//                front-door.ts)
//   _columns     a column's declared type, the town's own type (LOAD), and its profile; and each
//                column LOAD packed into `_extra` (`packed_in`), which SQL reads by its name
//   _migrations  each migration applied: id, SQL, checksum, who, when, the restore point before it
//   _files       each file: name, size, type, who sent it and how, its key in R2, its upload, and
//                the one folder it is in (`folder_id`, never none once the store has started)
//   _folders     the store's folders: a name, the folder each is in, and what it was made for
//                (`ref`), which a permission attaches to (folders.ts)
//   _jobs        long work (LOAD, SHAPE, PULL): its request key, state, progress and result, the
//                rows it was about to write and the rows it wrote, and for a pull the hash of the
//                key its DB IO job sends pages with
//   _history     migrations, table versions, restores, jobs and file batches
//   _deltas      every change to a program table: its change number, version, and rows added,
//                changed and removed (deltas.ts)
//   _delta_rows  the `_key`s of the rows a change added, changed or removed, as JSON arrays, until
//                every reader read them
//   _delta_reads how far each step that reads a table's changes has read it
//   _row_hashes  the `_hash` of each row of a LOAD's table, by `_key`, as the store last took it in,
//                and a number for each key (`n`), by which a reload marks the keys it took
//   _pushed      what the store last wrote into a database's table, by `_key` (jobs/push.ts): a hash
//                of the values it sent and of what the database held after, so a later write knows
//                a row someone changed there since and holds it
//   _push_writes each write's rows (jobs/push-writes.ts): what it did to each, what the database
//                held before and right after, and the memory's entry before it, so an undo can
//                take that one write back
//   _parked     the files a parked table's rows were written to, in the store's bucket (park.ts)
//   _fixes       a person's fixes to cells of a program's table, from the Tables tab's review: the
//                row (what names it across runs), the column, what it held and what it holds now;
//                every later version of the table, and every step's change to it, applies them again
//   _changes     a run's change to a store's tables (changes.ts): a trial, kept, or undone; whose run
//                and step, each table's columns and counts, and a fingerprint of the rows it touched;
//                `kind` 'rows' for a statement's change (store_exec), 'table' for a step's change to a
//                program's own table (program-tables.ts), with the `job` that made it
//   _change_rows each row a change inserted, updated or deleted, by rowid, with its values before
//                and after, so an undo can put it back
//   _users       a Modern App stage's user list: who may sign in, their role, tester mark, status
//   _sessions    the sessions of the people on that list; each id is a hash of the cookie's token
//
// And drizzle's own record of what it applied, `__drizzle_migrations` (a hash of each migration
// and its journal time), kept beside `_migrations`, so drizzle's migrator on an exported store
// sees what was applied and never applies it twice.
//
// Who called is kept only where a record needs it (who applied a migration, sent a file, started
// a job). The audit log of every call is the caller's (the gateway's), not the store's.

import type { SqlLike } from "./sql.js";

export const SYSTEM_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _tables (
    name TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('program', 'managed')),
    version INTEGER NOT NULL DEFAULT 1,
    grp TEXT,
    made_run TEXT,
    made_step TEXT,
    made_job TEXT,
    made_at TEXT,
    rows INTEGER,
    comment TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    key_from TEXT,
    parked TEXT,
    park_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS _columns (
    tbl TEXT NOT NULL,
    name TEXT NOT NULL,
    declared_type TEXT,
    original_type TEXT,
    filled REAL,
    distinct_n INTEGER,
    comment TEXT,
    PRIMARY KEY (tbl, name)
  )`,
  `CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    sql TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    applied_by TEXT NOT NULL,
    restore_point TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS _files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    sha256 TEXT,
    state TEXT NOT NULL CHECK (state IN ('uploading', 'ready')),
    received_at TEXT NOT NULL,
    received_by TEXT NOT NULL,
    via TEXT NOT NULL,
    batch TEXT,
    r2_key TEXT NOT NULL,
    upload_id TEXT,
    deleted_at TEXT,
    deleted_by TEXT,
    folder_id TEXT
  )`,
  // A folder's name is unique beside its siblings in any case, which folders.ts checks before it
  // writes; no index holds it, so a store an import fills with a clash still opens.
  `CREATE TABLE IF NOT EXISTS _folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    ref TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    deleted_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS _folders_parent ON _folders (parent_id) WHERE deleted_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS _jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    request_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
    params TEXT NOT NULL,
    progress TEXT,
    result TEXT,
    error TEXT,
    run_state TEXT,
    chunks INTEGER NOT NULL DEFAULT 0,
    tries INTEGER NOT NULL DEFAULT 0,
    by_sub TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    estimate_rows INTEGER,
    estimate_basis TEXT,
    rows_written INTEGER NOT NULL DEFAULT 0,
    key_hash TEXT,
    key_until TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS _jobs_open ON _jobs (created_at) WHERE state IN ('queued', 'running')`,
  // A run's jobs, for its live rows (live.ts): `_jobs` is never pruned, and a frame reads them twice a second.
  `CREATE INDEX IF NOT EXISTS _jobs_run ON _jobs (json_extract(params, '$.madeBy.runId'))`,
  `CREATE TABLE IF NOT EXISTS _history (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('migration', 'table', 'restore', 'job', 'files')),
    by_sub TEXT NOT NULL,
    note TEXT NOT NULL,
    restore_point TEXT,
    ref TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS _history_at ON _history (at)`,
  // What changed (deltas.ts). `change` is the rowid, and each change takes the number after the
  // greatest, so a step's "read up to" only grows. Only a change in place that changed no row
  // gives its number back, before any step could read it (jobs run one at a time).
  `CREATE TABLE IF NOT EXISTS _deltas (
    change INTEGER PRIMARY KEY,
    tbl TEXT NOT NULL,
    version INTEGER NOT NULL,
    whole INTEGER NOT NULL,
    added INTEGER NOT NULL DEFAULT 0,
    changed INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    kept INTEGER NOT NULL DEFAULT 1,
    job TEXT,
    at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS _deltas_tbl ON _deltas (tbl, change)`,
  // A change's keys, a JSON array of up to KEYS_PER_PART a row: one row written for thousands of keys.
  `CREATE TABLE IF NOT EXISTS _delta_rows (
    tbl TEXT NOT NULL,
    change INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('added', 'changed', 'removed')),
    part INTEGER NOT NULL,
    keys TEXT NOT NULL,
    PRIMARY KEY (tbl, change, kind, part)
  ) WITHOUT ROWID`,
  // How far each reader (a step that reads a table's changes) has read each table: the keys every
  // reader has read go (deltas.ts prune).
  `CREATE TABLE IF NOT EXISTS _delta_reads (
    reader TEXT NOT NULL,
    tbl TEXT NOT NULL,
    change INTEGER NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (reader, tbl)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS _row_hashes (
    tbl TEXT NOT NULL,
    k TEXT NOT NULL,
    h TEXT NOT NULL,
    n INTEGER,
    PRIMARY KEY (tbl, k)
  ) WITHOUT ROWID`,
  // A write's memory (jobs/push.ts): `target` names the database's table (`pushTargetId`), `k` a row
  // by its `_key`, `sent` the hash of what the store sent, `held` the hash of what the database held
  // after, `at` when, `put` 1 when this store put the row there (inserted it), which only a write that
  // removes it may undo. One row a key, in the key's own b-tree: no index of its own to write.
  `CREATE TABLE IF NOT EXISTS _pushed (
    target TEXT NOT NULL,
    k TEXT NOT NULL,
    sent TEXT NOT NULL,
    held TEXT NOT NULL,
    at TEXT NOT NULL,
    put INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (target, k)
  ) WITHOUT ROWID`,
  // A write's record (jobs/push-writes.ts): `job` the write's (or an undo's) job, `part` which of its
  // database tables, `k` a row by its `_key`; `did` inserted, updated or deleted (an undo's own rows:
  // undone or held), `sent` and `held` the hashes sent and held after, `set_cols` the columns an
  // update set and `before` the database's row before it (JSON), `mem` the memory's entry for the
  // key before the write (JSON), `state` pending, done or undone. One row a key, in the key's own
  // b-tree.
  `CREATE TABLE IF NOT EXISTS _push_writes (
    job TEXT NOT NULL,
    part INTEGER NOT NULL,
    k TEXT NOT NULL,
    did TEXT,
    sent TEXT,
    held TEXT,
    set_cols TEXT,
    before TEXT,
    mem TEXT,
    whole TEXT,
    why TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'undone')),
    PRIMARY KEY (job, part, k)
  ) WITHOUT ROWID`,
  // A parked table's files (park.ts): the folder in the bucket, what it holds, and, once a newer
  // version of the table replaced it, when, so the files go after the restore window.
  `CREATE TABLE IF NOT EXISTS _parked (
    id TEXT PRIMARY KEY,
    tbl TEXT NOT NULL,
    version INTEGER NOT NULL,
    change INTEGER NOT NULL,
    prefix TEXT NOT NULL,
    columns TEXT NOT NULL,
    rows INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    parts INTEGER NOT NULL,
    at TEXT NOT NULL,
    superseded_at TEXT
  )`,
  // A person's fixes (review.ts): one row a cell, the newest value, and what the cell held before
  // the first fix, so a fix applies again only where the town's data still says what it said.
  `CREATE TABLE IF NOT EXISTS _fixes (
    id TEXT PRIMARY KEY,
    tbl TEXT NOT NULL,
    key_columns TEXT NOT NULL,
    row_key TEXT NOT NULL,
    column_name TEXT NOT NULL,
    was TEXT,
    value TEXT,
    version INTEGER NOT NULL,
    by_sub TEXT NOT NULL,
    at TEXT NOT NULL,
    UNIQUE (tbl, row_key, column_name)
  )`,
  // What a run's statements changed, row by row (changes.ts): a trial of a change, or a change kept
  // so its run can be undone. `tables` is JSON: each table's columns and counts.
  `CREATE TABLE IF NOT EXISTS _changes (
    id INTEGER PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('trial', 'kept', 'undone')),
    run TEXT,
    step TEXT,
    request_key TEXT,
    by_sub TEXT NOT NULL,
    made_at TEXT NOT NULL,
    rows INTEGER NOT NULL DEFAULT 0,
    whole INTEGER NOT NULL DEFAULT 0,
    tables TEXT NOT NULL,
    fingerprint TEXT,
    undone_at TEXT,
    undone_by TEXT,
    restored INTEGER,
    held INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS _changes_key ON _changes (request_key) WHERE request_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS _changes_run ON _changes (run, step)`,
  // A change's rows (changes.ts): which row of which table by rowid, inserted, updated or deleted,
  // and its values before and after as JSON. In the change's own b-tree, in the order caught.
  `CREATE TABLE IF NOT EXISTS _change_rows (
    change INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    tbl TEXT NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
    rid_before INTEGER,
    rid_after INTEGER,
    before TEXT,
    after TEXT,
    PRIMARY KEY (change, seq)
  ) WITHOUT ROWID`,
  // A Modern App's people (app-users.ts). Every store has the two tables; only an app's stores
  // fill them. An app's own statements read `_users` and write neither.
  `CREATE TABLE IF NOT EXISTS _users (
    id TEXT PRIMARY KEY,
    issuer TEXT,
    sub TEXT,
    email TEXT NOT NULL COLLATE NOCASE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    role TEXT NOT NULL,
    tester INTEGER NOT NULL DEFAULT 0,
    author INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'removed')),
    invited_by TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    removed_at TEXT,
    UNIQUE (issuer, sub),
    UNIQUE (email)
  )`,
  `CREATE TABLE IF NOT EXISTS _sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS _sessions_user ON _sessions (user_id)`,
  // An ended session's end is the moment it ended, so old ones of both kinds go by this index.
  `CREATE INDEX IF NOT EXISTS _sessions_expires ON _sessions (expires_at)`,
  // drizzle-orm's SQLite migrator makes this table with exactly these words.
  `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at numeric
  )`,
];

/** Columns added to a system table after stores already had it: each is added where it is missing. */
const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: "_files", column: "deleted_at", type: "TEXT" },
  { table: "_files", column: "deleted_by", type: "TEXT" },
  { table: "_tables", column: "key_from", type: "TEXT" },
  { table: "_tables", column: "parked", type: "TEXT" },
  { table: "_tables", column: "park_at", type: "TEXT" },
  { table: "_jobs", column: "estimate_rows", type: "INTEGER" },
  { table: "_jobs", column: "estimate_basis", type: "TEXT" },
  { table: "_jobs", column: "rows_written", type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "_jobs", column: "tries", type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "_jobs", column: "key_hash", type: "TEXT" },
  { table: "_jobs", column: "key_until", type: "TEXT" },
  { table: "_row_hashes", column: "n", type: "INTEGER" },
  { table: "_pushed", column: "put", type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "_push_writes", column: "whole", type: "TEXT" },
  { table: "_push_writes", column: "why", type: "TEXT" },
  { table: "_tables", column: "full_name", type: "TEXT" },
  { table: "_columns", column: "packed_in", type: "TEXT" },
  { table: "_files", column: "folder_id", type: "TEXT" },
  // When an upload became whole (files.ts `completeFile`): a batch of files settles from it (events.ts).
  { table: "_files", column: "ready_at", type: "TEXT" },
  // Who made a change: kept only for a person's fix on the Tables tab, whose change no job names.
  { table: "_deltas", column: "by_sub", type: "TEXT" },
  // A run's change to a program table (B10 part 2): 'table', with the job that made it; 'rows' (or
  // none, from before) for a statement's.
  { table: "_changes", column: "kind", type: "TEXT" },
  { table: "_changes", column: "job", type: "TEXT" },
];

/** Indexes on a column added above: made after the column, on stores that had the table before it. */
const ADDED_INDEXES: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS _files_folder ON _files (folder_id)`,
  // The files that became whole since a time (events.ts). Jobs that ended are read by `_history_at`:
  // an index on `_jobs.updated_at` would cost a written row on every update of a job's progress.
  `CREATE INDEX IF NOT EXISTS _files_ready ON _files (ready_at) WHERE ready_at IS NOT NULL`,
  // A batch's files and the files deleted since a time (events.ts), read without a scan of every file.
  `CREATE INDEX IF NOT EXISTS _files_batch ON _files (batch) WHERE batch IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS _files_deleted ON _files (deleted_at) WHERE deleted_at IS NOT NULL`,
  // A job's changes to its run's tables: each commit of the job reads the ones still open.
  `CREATE INDEX IF NOT EXISTS _changes_job ON _changes (job) WHERE job IS NOT NULL`,
];

export function ensureSystemTables(sql: SqlLike): void {
  for (const ddl of SYSTEM_DDL) sql.exec(ddl);
  for (const { table, column, type } of ADDED_COLUMNS) {
    const has = sql.exec("SELECT 1 FROM pragma_table_info(?) WHERE name = ?", table, column).toArray().length > 0;
    if (!has) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  for (const ddl of ADDED_INDEXES) sql.exec(ddl);
}

export function getMeta(sql: SqlLike, key: string): string | null {
  const row = sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = ?", key).toArray()[0];
  return row ? String(row.value) : null;
}

/** A JSON value kept in `_meta`, or null when there is none or it does not read. */
export function savedJson<T>(sql: SqlLike, key: string): T | null {
  const raw = getMeta(sql, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setMeta(sql: SqlLike, key: string, value: string): void {
  sql.exec("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
}
