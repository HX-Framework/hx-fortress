// The three ways SQL reaches a store: `query` reads, `exec` changes managed tables, `migrate`
// applies a migration the store keeps (sql.ts says how a statement's writes are read).

import { sha256Hex, type StoreCore } from "./core.js";
import { asWritten } from "../../store-readers/src/readings.js";
import { frontDoor, readingsWritten } from "./front-door.js";
import { refuseWhileHeld } from "./history.js";
import { refusePastWriteLimit } from "./write-limit.js";
import {
  backtickNames,
  checkStatementKind,
  createdKind,
  explainGuarded,
  firstWord,
  refuseOrphaningDrop,
  isReservedName,
  migrationStatements,
  namesIn,
  PROGRAM_VERSION_RE,
  rootPages,
  schemaChanges,
  schemaObjects,
  splitStatements,
  StoreSqlRefusal,
  type SchemaObject,
  type SqlLike,
} from "./sql.js";
import { PARAMS_MAX, QUERY_LIMIT_DEFAULT, QUERY_LIMIT_MAX, SQL_MAX_CHARS, type ExecResult, type MigrateResult, type Migration, type QueryResult, type SqlValue } from "./types.js";

/** The longest value one query cell carries; a longer one is cut and named in `cut`. */
export const QUERY_CELL_MAX = 10_000;
/** A query answer stops adding rows past about this many bytes of values. */
export const QUERY_BYTES_MAX = 2 * 1024 * 1024;

export function checkSqlText(sql: unknown): string {
  if (typeof sql !== "string" || sql.trim().length === 0) throw new StoreSqlRefusal("bad_request", "Send the SQL as `sql`.");
  if (sql.length > SQL_MAX_CHARS) throw new StoreSqlRefusal("bad_request", `SQL is at most ${SQL_MAX_CHARS.toLocaleString("en-US")} characters.`);
  return sql;
}

export function checkParams(params: unknown): SqlValue[] {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) throw new StoreSqlRefusal("bad_request", "`params` is a list of values.");
  if (params.length > PARAMS_MAX) throw new StoreSqlRefusal("bad_request", `A statement takes at most ${PARAMS_MAX} parameters. Insert in batches through json_each(?) instead.`);
  for (const value of params) {
    const ok = value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
    if (!ok) throw new StoreSqlRefusal("bad_request", "Each parameter is text, a number or null.");
  }
  return params as SqlValue[];
}

function cellOf(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return `(binary, ${(value as ArrayBuffer).byteLength} bytes)`;
  return String(value);
}

class Rollback extends Error {}

/** Read-only SQL: one statement that writes nothing, run in a transaction that is always rolled back. */
export function runQuery(core: StoreCore, body: { sql?: unknown; params?: unknown; limit?: unknown }): QueryResult {
  const started = core.deps.now();
  const text = checkSqlText(body.sql);
  const params = checkParams(body.params);
  const limit = body.limit === undefined || body.limit === null ? QUERY_LIMIT_DEFAULT : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_LIMIT_MAX) {
    throw new StoreSqlRefusal("bad_request", `\`limit\` is a whole number from 1 to ${QUERY_LIMIT_MAX}.`);
  }
  const statements = splitStatements(text);
  if (statements.length !== 1) throw new StoreSqlRefusal("bad_request", "A query is one statement. Send each statement on its own.");
  const sql = core.sql;
  checkStatementKind(statements[0]!, "query");
  // The two readings and stable_id, second names, compounds of more than 5 SELECTs and packed columns, as a person reads them.
  const door = frontDoor(sql, statements[0]!, params);
  const statement = door.statement;
  // A query writes nothing, so which tables a write would touch does not matter here.
  if (explainGuarded(sql, statement, params, new Map()).writes) {
    throw new StoreSqlRefusal("read_only", "This statement changes the store, and a query only reads. Change a managed table with exec, or its schema with migrate.");
  }
  let answer: QueryResult = { columns: [], rows: [], truncated: false, ms: 0 };
  try {
    core.transaction(() => {
      // Every row of a statement is read, as a statement left open holds the store's tables against
      // a later DROP TABLE (export.ts `nextLimit`), so a read that could answer more than was asked
      // for is cut by its own SQL first. The newline keeps a trailing comment from swallowing it.
      const bounded = ["SELECT", "WITH", "VALUES"].includes(firstWord(statement)) ? `SELECT * FROM (${statement}\n) LIMIT ${limit + 1}` : statement;
      const cursor = sql.exec(bounded, ...params);
      // A reading's column with no alias is named by what it was written out as: name it as the statement did.
      const columns = [...cursor.columnNames].map((name) => asWritten(name, door.readings));
      const rows: SqlValue[][] = [];
      const cut: string[] = [];
      let bytes = 0;
      let truncated = false;
      for (const raw of cursor.raw()) {
        if (truncated) continue;
        if (rows.length >= limit || bytes > QUERY_BYTES_MAX) {
          truncated = true;
          continue;
        }
        const row = (raw as unknown[]).map((value, c) => {
          let cell = cellOf(value);
          if (typeof cell === "string" && cell.length > QUERY_CELL_MAX) {
            cell = cell.slice(0, QUERY_CELL_MAX);
            cut.push(`${rows.length}:${c}`);
          }
          bytes += typeof cell === "string" ? cell.length : 8;
          return cell;
        });
        rows.push(row);
      }
      if (cursor.rowsWritten > 0) throw new StoreSqlRefusal("read_only", "This statement changes the store, and a query only reads.");
      answer = { columns, rows, truncated, ms: 0, ...(cut.length > 0 ? { cut } : {}) };
      // A query never keeps anything it did.
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  answer.ms = core.deps.now() - started;
  return answer;
}

/**
 * The names `exec`, `migrate` and an app's own statements may not write: system tables, and
 * program tables with their old versions and the version a job is writing (`<name>__new`, before
 * its first commit too).
 */
export function protectedNames(sql: SqlLike): Set<string> {
  const out = new Set<string>();
  for (const row of sql.exec<{ name: string }>("SELECT lower(name) AS name FROM _tables WHERE kind = 'program'")) out.add(String(row.name));
  for (const row of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")) {
    const name = String(row.name).toLowerCase();
    // SQLite's own tables (AUTOINCREMENT's sequence) move with the managed tables that use them,
    // and drizzle's `__new_<table>` lives only inside one migration.
    if (isReservedName(name) && !name.startsWith("__new_") && !name.startsWith("sqlite_")) out.add(name);
    if (PROGRAM_VERSION_RE.test(name)) out.add(name);
  }
  return out;
}

function ownerOf(obj: SchemaObject): string {
  return obj.type === "index" || obj.type === "trigger" ? obj.table : obj.name.toLowerCase();
}

/**
 * The schema rule, checked after a batch ran and before it commits: no system or program table,
 * index or trigger was added, dropped or changed; no new table takes a name the store keeps for
 * itself or for a program table's versions; and no view, trigger or foreign key names a
 * protected table.
 */
function checkSchemaChanges(before: Map<string, SchemaObject>, after: Map<string, SchemaObject>, guarded: Set<string>, opts: { midBatch?: boolean } = {}): void {
  const { added, dropped, changed } = schemaChanges(before, after);
  for (const obj of [...added, ...dropped, ...changed]) {
    const owner = ownerOf(obj);
    const name = obj.name.toLowerCase();
    // drizzle-kit's table rebuild works through `__new_<table>` between two statements of one
    // migration; the batch as a whole may not leave one behind.
    if (opts.midBatch && (name.startsWith("__new_") || owner.startsWith("__new_"))) continue;
    // SQLite's own objects for a managed table: its UNIQUE indexes, AUTOINCREMENT's sequence.
    if (name.startsWith("sqlite_") && !guarded.has(owner)) continue;
    if (guarded.has(owner) || guarded.has(name) || isReservedName(name) || isReservedName(owner)) {
      throw new StoreSqlRefusal("protected_table", `This changes ${obj.name}, which belongs to the store or to a program. Programs change their own tables by running; exec and migrate change managed tables only.`);
    }
    if (added.includes(obj) && PROGRAM_VERSION_RE.test(obj.name)) {
      throw new StoreSqlRefusal("protected_table", `A name ending in "__v" and a number, or in "__new", is kept for programs' versions: ${obj.name}.`);
    }
  }
  for (const obj of [...added, ...changed]) {
    if (!obj.sql) continue;
    // A virtual table's module reads what its arguments name, often as text (fts5's
    // `content='<table>'`), and no statement's program shows those reads: its strings count too.
    const virtual = /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(obj.sql);
    const refersTo = virtual || obj.type === "view" || obj.type === "trigger" || /\bREFERENCES\b/i.test(obj.sql);
    if (!refersTo) continue;
    const named = namesIn(obj.sql);
    if (virtual) for (const m of obj.sql.matchAll(/'((?:[^']|'')*)'/g)) for (const word of m[1]!.replace(/''/g, "'").toLowerCase().split(/[^a-z0-9_$]+/)) if (word) named.add(word);
    for (const name of named) {
      if (name !== obj.name.toLowerCase() && guarded.has(name)) {
        throw new StoreSqlRefusal("protected_table", `${obj.name} names ${name}, which belongs to the store or to a program. A view, trigger, foreign key or virtual table may name managed tables only.`);
      }
    }
  }
}

interface BatchOutcome {
  changes: number;
  /** Managed tables made, dropped, or written. */
  created: string[];
  dropped: string[];
  written: Set<string>;
}

/**
 * Runs statements that may change managed tables only, inside the caller's transaction: each is
 * refused before it runs if it would write a protected table, a statement that changed the schema
 * is checked as soon as it ran, and the batch is checked again as a whole. A refusal throws,
 * which rolls the transaction back.
 */
function runGuarded(core: StoreCore, statements: string[], params: SqlValue[]): BatchOutcome {
  const sql = core.sql;
  if (params.length > 0 && statements.length !== 1) throw new StoreSqlRefusal("bad_request", "Parameters go with one statement. Send each statement on its own.");
  // Before anything is prepared: a PRAGMA acts as SQLite prepares it.
  const kinds = statements.map((statement) => checkStatementKind(statement, "batch"));
  const guarded = protectedNames(sql);
  const before = schemaObjects(sql);
  let schema = before;
  let roots = rootPages(sql);
  const written = new Set<string>();
  const totalBefore = Number(sql.exec<{ n: number }>("SELECT total_changes() AS n").one().n);
  statements.forEach((statement, i) => {
    if (kinds[i] === "skip") return;
    // A view's or a trigger's body is read when it is used, after this check: its double-quoted
    // names become backtick names, so one that is no column fails then instead of reading as text.
    const text = createdKind(statement) ? (backtickNames(statement)?.text ?? statement) : statement;
    const writes = explainGuarded(sql, text, params, roots);
    for (const table of writes.tables) {
      if (guarded.has(table)) {
        throw new StoreSqlRefusal("protected_table", `This writes ${table}, which belongs to the store or to a program. Programs change their own tables by running; exec and migrate change managed tables only.`);
      }
      written.add(table);
    }
    for (const table of writes.dropped) refuseOrphaningDrop(sql, table);
    sql.exec(text, ...params).toArray();
    if (writes.schema) {
      // At once, not only at the end: a protected table renamed and renamed back would leave the
      // batch's schema as it was while the statements between wrote it under another name.
      const now = schemaObjects(sql);
      checkSchemaChanges(schema, now, guarded, { midBatch: true });
      // A new view is read once here, so a name in it that is no column is refused now.
      for (const obj of schemaChanges(schema, now).added) {
        if (obj.type === "view") sql.exec(`EXPLAIN SELECT * FROM \`${obj.name.replace(/`/g, "``")}\``).toArray();
      }
      schema = now;
      roots = rootPages(sql);
    }
  });
  const changes = Number(sql.exec<{ n: number }>("SELECT total_changes() AS n").one().n) - totalBefore;
  checkSchemaChanges(before, schema, guarded);
  const { added, dropped } = schemaChanges(before, schema);
  return {
    changes,
    created: added.filter((o) => o.type === "table").map((o) => o.name),
    dropped: dropped.filter((o) => o.type === "table").map((o) => o.name),
    written,
  };
}

/**
 * Keeps `_tables` in step with the managed tables a batch made, dropped or wrote. A written
 * table's row count becomes unknown (null) rather than being counted again inside the write: the
 * store counts it when its stats are read (`countStaleTables`), at most once a minute.
 */
function recordManaged(core: StoreCore, outcome: BatchOutcome): void {
  const sql = core.sql;
  const now = core.nowIso();
  for (const name of outcome.dropped) {
    sql.exec("DELETE FROM _tables WHERE lower(name) = lower(?) AND kind = 'managed'", name);
    sql.exec("DELETE FROM _columns WHERE lower(tbl) = lower(?)", name);
  }
  const touched = new Set([...outcome.created.map((n) => n.toLowerCase()), ...outcome.written]);
  for (const lower of touched) {
    const row = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = ?", lower).toArray()[0];
    if (!row || isReservedName(lower)) continue;
    sql.exec(
      "INSERT INTO _tables (name, kind, version, rows, created_at, updated_at) VALUES (?, 'managed', 1, NULL, ?, ?) ON CONFLICT (name) DO UPDATE SET rows = NULL, updated_at = excluded.updated_at",
      String(row.name),
      now,
      now,
    );
  }
}

/** Counts the tables whose row count a write made unknown, and keeps the counts. */
export function countStaleTables(core: StoreCore): void {
  const sql = core.sql;
  for (const row of sql.exec<{ name: string }>("SELECT name FROM _tables WHERE rows IS NULL").toArray()) {
    const name = String(row.name);
    const exists = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
    if (!exists) continue;
    const rows = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM \`${name.replace(/`/g, "``")}\``).one().n);
    sql.exec("UPDATE _tables SET rows = ? WHERE name = ? AND rows IS NULL", rows, name);
  }
}

/** SQL that changes managed tables, in one transaction. */
export function runExec(core: StoreCore, body: { sql?: unknown; params?: unknown }): ExecResult {
  const started = core.deps.now();
  const text = checkSqlText(body.sql);
  const params = checkParams(body.params);
  // Each statement with its readings written out (front-door.ts): a cleaning reads a value as the store does.
  const statements = splitStatements(text).map((statement) => readingsWritten(statement).sql);
  if (statements.length === 0) throw new StoreSqlRefusal("bad_request", "Send at least one statement.");
  const outcome = core.transaction(() => {
    core.sql.exec("PRAGMA defer_foreign_keys = ON");
    const done = runGuarded(core, statements, params);
    recordManaged(core, done);
    return done;
  });
  return { changes: outcome.changes, ms: core.deps.now() - started };
}

const MIGRATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

function migrationOf(row: Record<string, unknown>): Migration {
  return {
    id: String(row.id),
    checksum: String(row.checksum),
    sql: String(row.sql),
    appliedAt: String(row.applied_at),
    appliedBy: String(row.applied_by),
    restorePoint: row.restore_point === null || row.restore_point === undefined ? null : String(row.restore_point),
  };
}

export function listMigrations(core: StoreCore): Migration[] {
  return core.sql.exec("SELECT * FROM _migrations ORDER BY applied_at, id").toArray().map((row) => migrationOf(row));
}

/**
 * Applies a migration once: the same id with the same SQL answers `applied: false`; the same id
 * with other SQL is refused. A restore point is taken first, and the statements apply in one
 * transaction or not at all. drizzle's own record (`__drizzle_migrations`) gets the migration's
 * hash and its journal time (`when`), or the time of the apply.
 */
export async function runMigrate(core: StoreCore, actor: string, body: { id?: unknown; sql?: unknown; when?: unknown }): Promise<MigrateResult> {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!MIGRATION_ID_RE.test(id)) throw new StoreSqlRefusal("bad_request", "A migration's id is 1 to 200 letters, digits, dots, dashes, colons or underscores, such as its drizzle tag.");
  // Only a migration that would apply is held to the size of SQL a store takes: one it already ran
  // is answered as it was, whatever its size.
  const text = typeof body.sql === "string" ? body.sql : checkSqlText(body.sql);
  const when = body.when === undefined || body.when === null ? null : Number(body.when);
  if (when !== null && (!Number.isSafeInteger(when) || when <= 0)) throw new StoreSqlRefusal("bad_request", "`when` is the drizzle journal's time for the migration, in epoch ms.");
  const checksum = await sha256Hex(text);
  const conflict = (row: Record<string, unknown>) =>
    new StoreSqlRefusal("migration_conflict", `Migration ${id} was applied with other SQL (checksum ${String(row.checksum).slice(0, 12)}…). Give a changed migration a new id.`);
  const existing = core.sql.exec("SELECT * FROM _migrations WHERE id = ?", id).toArray()[0];
  if (existing) {
    if (String(existing.checksum) !== checksum) throw conflict(existing);
    return { applied: false, migration: migrationOf(existing) };
  }
  checkSqlText(text);
  // A replay above writes nothing and is always answered; a migration that would apply is held to
  // the store's daily write limit, and waits for an export or an import, whoever came first.
  refusePastWriteLimit(core);
  refuseWhileHeld(core);
  const statements = migrationStatements(text);
  if (statements.length === 0) throw new StoreSqlRefusal("bad_request", "This migration holds no statement.");
  const restorePoint = await core.bookmark();
  // An export or an import may have started while this one waited for its restore point.
  refuseWhileHeld(core);
  const migration = core.transaction(() => {
    // Another call may have applied it while this one waited for its restore point.
    if (core.sql.exec("SELECT 1 FROM _migrations WHERE id = ?", id).toArray().length > 0) return null;
    core.sql.exec("PRAGMA defer_foreign_keys = ON");
    const done = runGuarded(core, statements, []);
    recordManaged(core, done);
    const appliedAt = core.nowIso();
    core.sql.exec(
      "INSERT INTO _migrations (id, checksum, sql, applied_at, applied_by, restore_point) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      checksum,
      text,
      appliedAt,
      actor,
      restorePoint,
    );
    core.sql.exec('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)', checksum, when ?? core.deps.now());
    core.history({ kind: "migration", by: actor, note: `Migration ${id}: ${statements.length} statement${statements.length === 1 ? "" : "s"}`, restorePoint, ref: id });
    return { id, checksum, sql: text, appliedAt, appliedBy: actor, restorePoint } satisfies Migration;
  });
  if (!migration) {
    const row = core.sql.exec("SELECT * FROM _migrations WHERE id = ?", id).toArray()[0]!;
    if (String(row.checksum) !== checksum) throw conflict(row);
    return { applied: false, migration: migrationOf(row) };
  }
  return { applied: true, migration };
}
