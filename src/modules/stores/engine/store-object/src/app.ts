// What a Modern App's own code runs on its store, through the store handle each request gets
// (the gateway's `AppStores`, behind the apps edge): one statement, or a batch of statements in
// one transaction, answered in the shapes drizzle's sqlite-proxy driver reads (types.ts,
// `AppStatementResult`).
//
// The rules, each checked from the statement's own program (sql.ts) before it runs:
//   - The schema is the app's repository's: a statement that changes it is refused. Migrations
//     change it, through `migrate`, which a release carries.
//   - An app writes managed tables only: never a program table, never one of the store's own.
//   - An app reads its own tables, program tables (a program may fill a table an app shows) and,
//     of the store's own tables, `_users` (its user list). Nothing else of the store's own.
//   - One statement per call; no PRAGMA; no BEGIN, COMMIT or SAVEPOINT: a batch is the
//     transaction. drizzle's `db.transaction()` sends those as calls of their own, so an app uses
//     `db.batch([...])` instead, and the refusal says so.

import type { StoreCore } from "./core.js";
import { refuseWhileHeld } from "./history.js";
import { checkStatementKind, explainGuarded, firstWord, isReservedName, rootPages, splitStatements, StoreSqlRefusal } from "./sql.js";
import { checkSqlText, protectedNames } from "./statements.js";
import { PARAMS_MAX, type AppMethod, type AppStatement, type AppStatementResult } from "./types.js";
import { refusePastWriteLimit } from "./write-limit.js";

/** The most statements one batch takes. */
export const APP_BATCH_MAX = 100;
/** An answer stops at about this many bytes of values: an app pages through more. */
export const APP_ANSWER_BYTES_MAX = 8 * 1024 * 1024;

const METHODS: ReadonlySet<string> = new Set<AppMethod>(["run", "all", "values", "get"]);
const TRANSACTION_WORDS = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"]);
/** Of the store's own tables, the one an app's statements may read. */
const APP_READABLE = new Set(["_users", "sqlite_sequence"]);

type Bindable = string | number | null | ArrayBuffer;

/** A parameter as SQLite takes it: drizzle sends booleans, bigints and bytes too. */
function bindable(value: unknown): Bindable {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StoreSqlRefusal("bad_request", "A number parameter is finite: no NaN or Infinity.");
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  // A whole number past what a JS number holds goes as text; SQLite's INTEGER affinity reads it back exactly.
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  throw new StoreSqlRefusal("bad_request", "Each parameter is text, a number, true or false, null, or bytes.");
}

function bindAll(params: unknown): Bindable[] {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) throw new StoreSqlRefusal("bad_request", "`params` is a list of values.");
  if (params.length > PARAMS_MAX) throw new StoreSqlRefusal("bad_request", `A statement takes at most ${PARAMS_MAX} parameters. Send long lists in batches of 90.`);
  return params.map(bindable);
}

/** The one statement of a call, sorted and checked before anything prepares it. */
function oneStatement(sql: unknown): string {
  const statements = splitStatements(checkSqlText(sql));
  if (statements.length !== 1) throw new StoreSqlRefusal("bad_request", "Send one statement at a time, or several together as a batch.");
  const statement = statements[0]!;
  const word = firstWord(statement);
  if (TRANSACTION_WORDS.has(word)) {
    throw new StoreSqlRefusal(
      "bad_request",
      "A store runs each batch in one transaction of its own, so an app sends no BEGIN, COMMIT or SAVEPOINT. Send the statements together with db.batch([...]) instead of db.transaction().",
    );
  }
  if (word === "PRAGMA") throw new StoreSqlRefusal("bad_request", "An app's statements cannot change how the store works: no PRAGMA.");
  checkStatementKind(statement, "batch");
  return statement;
}

function cellOf(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return value;
}

function sizeOf(value: unknown): number {
  if (typeof value === "string") return value.length * 2;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return 8;
}

interface Checked {
  statement: string;
  params: Bindable[];
  method: AppMethod;
}

function checked(input: unknown): Checked {
  if (!input || typeof input !== "object") throw new StoreSqlRefusal("bad_request", "A statement is { sql, params, method }.");
  const { sql, params, method } = input as Partial<AppStatement>;
  if (typeof method !== "string" || !METHODS.has(method)) throw new StoreSqlRefusal("bad_request", "`method` is run, all, values or get.");
  return { statement: oneStatement(sql), params: bindAll(params), method: method as AppMethod };
}

/** What one transaction's statements share: the names they may not write, the tables' root pages, what they wrote. */
interface Batch {
  guarded: Set<string>;
  roots: Map<number, string>;
  written: Set<string>;
  bytes: number;
  /** The daily write limit was checked before the batch's first write. */
  limitChecked: boolean;
}

function totalChanges(core: StoreCore): number {
  return Number(core.sql.exec<{ n: number }>("SELECT total_changes() AS n").one().n);
}

/** Runs one checked statement inside the caller's transaction; the managed tables it wrote join the batch's. */
function runOne(core: StoreCore, item: Checked, batch: Batch): AppStatementResult {
  const sql = core.sql;
  const { guarded, roots, written } = batch;
  const what = explainGuarded(sql, item.statement, item.params, roots);
  if (what.schema) {
    throw new StoreSqlRefusal(
      "bad_request",
      "An app's statements do not change its schema: the schema comes from the app's repository, as drizzle-kit migrations its releases carry.",
    );
  }
  for (const table of what.tables) {
    if (guarded.has(table)) {
      throw new StoreSqlRefusal("protected_table", `This writes ${table}, which belongs to the store or to a program. An app writes its own tables only.`);
    }
    written.add(table);
  }
  for (const table of what.reads) {
    if (isReservedName(table) && !APP_READABLE.has(table)) {
      throw new StoreSqlRefusal("protected_table", `This reads ${table}, which is the store's own. An app reads its own tables, program tables and _users.`);
    }
  }
  if (what.writes) {
    refuseWhileHeld(core);
    // An app's writes are held to the store's daily write limit too, once a batch, before its first
    // write: a batch that starts under the limit finishes. Its reads never are.
    if (!batch.limitChecked) {
      refusePastWriteLimit(core);
      batch.limitChecked = true;
    }
  }
  const before = what.writes ? totalChanges(core) : 0;
  const cursor = sql.exec(item.statement, ...item.params);
  if (item.method === "run") {
    cursor.toArray();
    if (!what.writes) return { rows: [] };
    const after = sql.exec<{ n: number; id: number }>("SELECT total_changes() AS n, last_insert_rowid() AS id").one();
    return { rows: [], changes: Number(after.n) - before, lastInsertRowid: Number(after.id) };
  }
  // Every statement is stepped to its end, a read that asked for one row too: one left open holds
  // the store's tables against a later DROP TABLE until the runtime frees it (export.ts `nextLimit`).
  const rows: unknown[][] = [];
  for (const raw of cursor.raw()) {
    if (item.method === "get" && rows.length > 0) continue;
    const row = (raw as unknown[]).map(cellOf);
    for (const cell of row) batch.bytes += sizeOf(cell);
    if (batch.bytes > APP_ANSWER_BYTES_MAX) {
      throw new StoreSqlRefusal("bad_request", `This answer is larger than ${APP_ANSWER_BYTES_MAX / 1024 / 1024} MiB. Page through it with LIMIT and OFFSET, or a cursor on a key.`);
    }
    rows.push(row);
  }
  const wrote = what.writes ? { changes: totalChanges(core) - before } : {};
  if (item.method === "get") return { rows: rows[0], ...wrote };
  return { rows, ...wrote };
}

/** A table counted at this many rows or more is counted again at most every BIG_RECOUNT_MS. */
export const BIG_TABLE_ROWS = 100_000;
export const BIG_RECOUNT_MS = 15 * 60_000;

/**
 * A written managed table's row count becomes unknown: the store counts it again when its stats
 * are read, at most once a minute. A big table is counted again at most every 15 minutes, since
 * each count reads every row and an app writes all day.
 */
function markWritten(core: StoreCore, written: Set<string>): void {
  const now = core.deps.now();
  for (const table of written) {
    if (isReservedName(table)) continue;
    core.sql.exec(
      "UPDATE _tables SET rows = NULL, updated_at = ? WHERE lower(name) = ? AND kind = 'managed' AND rows IS NOT NULL AND (rows < ? OR updated_at < ?)",
      new Date(now).toISOString(),
      table,
      BIG_TABLE_ROWS,
      new Date(now - BIG_RECOUNT_MS).toISOString(),
    );
  }
}

function runInTransaction(core: StoreCore, items: Checked[]): AppStatementResult[] {
  return core.transaction(() => {
    const batch: Batch = { guarded: protectedNames(core.sql), roots: rootPages(core.sql), written: new Set(), bytes: 0, limitChecked: false };
    const out = items.map((item) => runOne(core, item, batch));
    markWritten(core, batch.written);
    return out;
  });
}

/** One statement of an app's, in one transaction of its own. */
export function runAppStatement(core: StoreCore, input: unknown): AppStatementResult {
  return runInTransaction(core, [checked(input)])[0]!;
}

/** An app's batch: every statement in one transaction, all of them or none. */
export function runAppBatch(core: StoreCore, input: unknown): AppStatementResult[] {
  if (!Array.isArray(input) || input.length === 0) throw new StoreSqlRefusal("bad_request", "A batch is a list of at least one { sql, params, method }.");
  if (input.length > APP_BATCH_MAX) throw new StoreSqlRefusal("bad_request", `A batch holds at most ${APP_BATCH_MAX} statements.`);
  return runInTransaction(core, input.map(checked));
}
