// PUSH and COMPARE in a store's object, through its own job runner, on the stand-ins for its storage
// and its alarms, driven the way a DB IO job drives them: a job's key, its calls, its pages. What a
// store keeps of a preview, a write and a compare, row by row, and what it refuses.
//
// Every test that writes counts the rows the job wrote, as the stand-in counts them the way workerd
// does: 2 for a row inserted into a table with its `_key` index, 1 for a row of the memory or of a
// write's record (a WITHOUT ROWID table is its own index) or a row updated or deleted, and the DDL.
// What a made table's own records add is bounded by `records` (its width); the rows a page writes are
// counted exactly.

import { describe, it, host, stateOf, filesOf, whereBilled } from "../../testing/suite/host.js";
import { countingHex, FakeClock } from "../../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import {
  COMPARE_ROWS_MAX,
  COMPARED_GROUP,
  HELD_GROUP,
  PREVIEW_GROUP,
  previewKey,
  pushRecordKey,
  pushTargetId,
  pushWriteKey,
  REHEARSAL_GROUP,
  type CompareResult,
  type PushPreviewResult,
  type PushRecord,
  type PushResult,
  type PushUndoResult,
  type PushWriteRecord,
  type SavedPreview,
} from "../../../store-readers/src/push.js";
import type { StoreDeps } from "../core.js";
import { StoreHandler } from "../handler.js";
import type { StoreCaller, StoreResult } from "../types.js";
import { compareHandler, pushHandler, pushPreviewHandler, pushUndoHandler } from "./push.js";
import type { JobHandler } from "./types.js";

const STORE = "sto_dddddddddddddddddddddddddddddddd";
const RUN: StoreCaller = { storeId: STORE, actor: "run:mrn-1" };
const CONNECTION = { id: "dbc_1", name: "Maple Ridge permits", engine: "sqlserver" };
const TARGET = { schema: "dbo", name: "permits" };
const WRITER = "program:hp_1@3";
const DB_COLUMNS = [
  { name: "permit_no", type: "varchar(20)", required: true },
  { name: "status", type: "varchar(20)", required: false },
  { name: "fee", type: "decimal(10,2)", required: false },
];
const BEGIN = { columns: DB_COLUMNS, primaryKey: ["permit_no"] };
const COLUMNS = ["permit_no", "status", "fee"];
const TARGET_ID = pushTargetId(CONNECTION.id, TARGET);
const RECORD_KEY = pushRecordKey(CONNECTION.id, TARGET);
const PREVIEW = "push_preview_permits";
/**
 * The most a made table's own records write, by its columns: 2 for each column's catalog row (and its
 * key), and 24 for the rest: the version's swap (5), its catalog row, history and delta, the job's
 * note of the table it began, and a record of the job's own (`previewKey`, `pushRecordKey`).
 */
const records = (columns: number): number => 24 + 2 * columns;

/** Hashes as a DB IO job sends them: 16 hex digits. */
const h = (n: number): string => n.toString(16).padStart(16, "0");

/** The store's table: ten permits. Its `Status` is the database's `status` without regard to case, and `notes` is the store's alone. */
const TEN: [string, string, string][] = [
  ["P01", "Issued", "10.00"],
  ["P02", "Issued", "20.00"],
  ["P03", "Final", "30.00"],
  ["P04", "Issued", "40.00"],
  ["P05", "Issued", "50.00"],
  ["P06", "Final", "60.00"],
  ["P07", "Issued", "70.00"],
  ["P08", "Issued", "80.00"],
  ["P09", "Issued", "90.00"],
  ["P10", "Final", "100.00"],
];

function setup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const jobs = new Map<string, JobHandler>([pushPreviewHandler, pushHandler, pushUndoHandler, compareHandler].map((handler) => [handler.kind, handler as unknown as JobHandler]));
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs };
  const store = new StoreHandler(state as never, { FILES: filesOf().asBucket() }, deps);
  return { clock, storage, store };
}
type Setup = ReturnType<typeof setup>;

let keys = 0;
/** A key as the gateway makes one. */
const newKey = (): string => `k1.gateway-made-${++keys}`;

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function refusal(result: StoreResult<unknown>): { code: string; error: string } {
  assert.equal(result.ok, false, "expected a refusal");
  return result as unknown as { code: string; error: string };
}

const sql = (s: Setup, query: string, ...bindings: unknown[]) => s.storage.sql.exec(query, ...bindings).toArray().map((r) => ({ ...r }));
const tableRows = (s: Setup, table: string) => sql(s, `SELECT * FROM "${table}" ORDER BY "_key"`);
const columnsOf = (s: Setup, table: string) => sql(s, "SELECT name FROM pragma_table_info(?) ORDER BY cid", table).map((r) => r.name);
const jobOf = async (s: Setup, jobId: string) => value(await s.store.job(RUN, jobId)).job;
/** The memory: each key's hash sent, hash held, and 1 when this store put the row there (inserted it). */
const memory = (s: Setup) => sql(s, "SELECT k, sent, held, put FROM _pushed WHERE target = ? ORDER BY k", TARGET_ID).map((r) => [r.k, r.sent, r.held, r.put]);
const record = (s: Setup): PushRecord | null => {
  const row = sql(s, "SELECT value FROM _meta WHERE key = ?", RECORD_KEY)[0];
  return row ? (JSON.parse(String(row.value)) as PushRecord) : null;
};

/** The store's table a write reads, as a pull or a LOAD would leave it: its own `_key` and `_hash`, and the town's columns. */
function permits(s: Setup, rows: readonly [string | null, string, string][] = TEN) {
  s.storage.sql.exec(`CREATE TABLE permits ("_key" TEXT, "_hash" TEXT, permit_no TEXT, Status TEXT, fee TEXT, notes TEXT)`);
  for (const [no, status, fee] of rows) s.storage.sql.exec("INSERT INTO permits VALUES (?, ?, ?, ?, ?, 'kept by the store')", no, h(1), no, status, fee);
}

/** The memory and the record an earlier write left: the rows it put there (inserted), under the job's key and columns. */
function wroteBefore(s: Setup, rows: readonly [string, string, string][], writers: Record<string, string> = {}) {
  s.storage.sql.exec("INSERT INTO _meta (key, value) VALUES (?, ?)", RECORD_KEY, JSON.stringify({ key: ["permit_no"], columns: COLUMNS, writers, last: null } satisfies PushRecord));
  for (const [k, sent, held] of rows) s.storage.sql.exec("INSERT INTO _pushed (target, k, sent, held, at, put) VALUES (?, ?, ?, ?, '2026-11-01T00:00:00.000Z', 1)", TARGET_ID, k, sent, held);
}

/** The store past its day's write limit: today's count far over the default. */
function pastTheLimit(s: Setup) {
  const day = new Date(s.clock.now()).toISOString().slice(0, 10);
  s.storage.sql.exec("INSERT INTO _meta (key, value) VALUES (?, '5000000') ON CONFLICT (key) DO UPDATE SET value = excluded.value", `rows_written:${day}`);
}

function previewParams(overrides: Record<string, unknown> = {}) {
  return { connection: CONNECTION, source: "permits", target: TARGET, key: [], into: PREVIEW, theirEdits: "hold", writer: WRITER, madeBy: { runId: "mrn-1", step: "s1" }, ...overrides };
}

/** A job made, started by the store's alarm, and a key for its DB IO job. */
async function started(s: Setup, kind: string, params: unknown, requestKey: string) {
  const job = value(await s.store.jobSubmit(RUN, { kind, params, requestKey })).job;
  await s.store.alarm();
  const { key } = value(await s.store.jobKey(RUN, job.id, { key: newKey() }));
  return { jobId: job.id, key };
}

/** The rest of a job after its DB IO job's end: the store makes its table. */
async function finished(s: Setup, jobId: string) {
  await s.store.alarm();
  const job = await jobOf(s, jobId);
  assert.equal(job.state, "done", `the job is ${job.state}: ${job.error}`);
  return job;
}

/** The rows a DB IO job finds for the ten permits, against a database that holds P01 to P08 and P11. */
const FOUND = [
  { key: "P03", action: "changed", now: h(0x30), will: h(0x31), changed: ["status"], before: ["P03", "Issued", "30.00"], after: ["P03", "Final", "30.00"] },
  { key: "P05", action: "held", now: h(0x50), will: h(0x51), why: "changed_there", changed: ["status"], before: ["P05", "Withdrawn", "50.00"], after: ["P05", "Issued", "50.00"] },
  { key: "P06", action: "adopt", now: h(0x60), will: h(0x60) },
  { key: "P09", action: "new", will: h(0x91), after: ["P09", "Issued", "90.00"] },
  { key: "P10", action: "new", will: h(0xa1), after: ["P10", "Final", "100.00"] },
  { key: "P11", action: "removed", now: h(0xb0), before: ["P11", "Issued", "110.00"] },
  { key: "P12", action: "forget" },
];

/** The memory before: P01 written and untouched since, P11 and P12 written and since gone from the store's table. */
const MEMORY: [string, string, string][] = [
  ["P01", h(0x10), h(0x10)],
  ["P11", h(0xb0), h(0xb0)],
  ["P12", h(0xc0), h(0xc0)],
];

/** A preview of the ten permits: two new, one changed, one removed, one held, one adopted, one forgotten. */
async function previewed(s: Setup, requestKey = "preview-1") {
  const { jobId, key } = await started(s, "push_preview", previewParams(), requestKey);
  assert.deepEqual(value(await s.store.rowsBegin(RUN, jobId, key, BEGIN)), { columns: COLUMNS, key: ["permit_no"], missing: [], rows: 10 });
  assert.deepEqual(value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: FOUND.slice(0, 4) })), { page: 1, taken: true });
  assert.deepEqual(value(await s.store.rowsSend(RUN, jobId, key, { page: 2, rows: FOUND.slice(4) })), { page: 2, taken: true });
  assert.deepEqual(value(await s.store.rowsEnd(RUN, jobId, key, { read: 10, targetRows: 9, same: 6 })), { finishing: true });
  const job = await finished(s, jobId);
  return { jobId, job, result: job.result as PushPreviewResult };
}

describe("a preview of a write, in a store", () => {
  it("keeps one row for each key where a write would do something, with what the database holds and what it would hold", async () => {
    const s = setup();
    permits(s);
    wroteBefore(s, MEMORY);
    const { job, result } = await previewed(s);
    assert.deepEqual(result, {
      table: PREVIEW,
      version: 1,
      rows: 5,
      source: "permits",
      target: "dbo.permits",
      key: ["permit_no"],
      columns: COLUMNS,
      inserts: 2,
      updates: 1,
      deletes: 1,
      held: 1,
      unchanged: 6,
      targetRows: 9,
      share: 4 / 9,
      first: true,
      ignored: ["notes"],
      links: [],
    } satisfies PushPreviewResult);
    // What a person reads comes first; the machine's columns after it.
    assert.deepEqual(columnsOf(s, PREVIEW), ["permit_no", "what_happens", "status_now", "status_after", "fee_now", "fee_after", "note", "_key", "_hash", "_now_hash", "_values", "_changed", "_before"]);
    assert.deepEqual(tableRows(s, PREVIEW), [
      { _key: "P03", _hash: h(0x31), _now_hash: h(0x30), _values: '["P03","Final","30.00"]', _changed: '["status"]', _before: '["P03","Issued","30.00"]', permit_no: "P03", what_happens: "changed", status_now: "Issued", status_after: "Final", fee_now: "30.00", fee_after: "30.00", note: "Changes status" },
      { _key: "P05", _hash: h(0x51), _now_hash: h(0x50), _values: '["P05","Issued","50.00"]', _changed: '["status"]', _before: '["P05","Withdrawn","50.00"]', permit_no: "P05", what_happens: "held", status_now: "Withdrawn", status_after: "Issued", fee_now: "50.00", fee_after: "50.00", note: "Changed in Maple Ridge permits since our last write: not written" },
      { _key: "P09", _hash: h(0x91), _now_hash: null, _values: '["P09","Issued","90.00"]', _changed: null, _before: null, permit_no: "P09", what_happens: "new", status_now: null, status_after: "Issued", fee_now: null, fee_after: "90.00", note: null },
      { _key: "P10", _hash: h(0xa1), _now_hash: null, _values: '["P10","Final","100.00"]', _changed: null, _before: null, permit_no: "P10", what_happens: "new", status_now: null, status_after: "Final", fee_now: null, fee_after: "100.00", note: null },
      { _key: "P11", _hash: null, _now_hash: h(0xb0), _values: null, _changed: null, _before: '["P11","Issued","110.00"]', permit_no: "P11", what_happens: "removed", status_now: "Issued", status_after: null, fee_now: "110.00", fee_after: null, note: "permits no longer has this row" },
    ]);
    // The memory takes P06 as there, never as put there by this store, and lets P12 go; P11 stays until a write removes it.
    assert.deepEqual(memory(s), [["P01", h(0x10), h(0x10), 1], ["P06", h(0x60), h(0x60), 0], ["P11", h(0xb0), h(0xb0), 1]]);
    assert.deepEqual(record(s), { key: ["permit_no"], columns: COLUMNS, writers: {}, last: null }, "the record of the same key and columns stays");
    // Five rows in the table and its `_key` index, one row of the memory taken and one let go, and the table's own records.
    assert.ok(job.rowsWritten! >= 5 * 2 + 2 && job.rowsWritten! < 5 * 2 + 2 + records(12), `wrote ${job.rowsWritten}`);
    const catalog = sql(s, "SELECT grp, rows, version, made_run FROM _tables WHERE name = ?", PREVIEW)[0];
    assert.deepEqual(catalog, { grp: PREVIEW_GROUP, rows: 5, version: 1, made_run: "mrn-1" });
    const said = Object.fromEntries(sql(s, "SELECT name, original_type, comment FROM _columns WHERE tbl = ?", PREVIEW).map((c) => [c.name, [c.original_type, c.comment]]));
    assert.deepEqual(said.status_now, ["varchar(20)", '"status" as dbo.permits holds it now.']);
    assert.deepEqual(said.what_happens, [null, "What a write would do with the row: new, changed, removed or held."]);
    const saved = JSON.parse(String(sql(s, "SELECT value FROM _meta WHERE key = ?", previewKey(PREVIEW))[0]!.value)) as SavedPreview;
    assert.deepEqual({ ...saved, at: "" }, { ...result, connection: CONNECTION, targetRef: TARGET, theirEdits: "hold", removes: false, writer: WRITER, at: "" });
    assert.equal(columnsOf(s, `${PREVIEW}__new`).length, 0, "its work table is gone");
  });

  it("takes a page once, however often it is sent, and only the next page after it", async () => {
    const s = setup();
    permits(s);
    const { jobId, key } = await started(s, "push_preview", previewParams(), "twice");
    value(await s.store.rowsBegin(RUN, jobId, key, BEGIN));
    const begun = (await jobOf(s, jobId)).rowsWritten;
    const page = { page: 1, rows: [FOUND[3], FOUND[4]] };
    assert.deepEqual(value(await s.store.rowsSend(RUN, jobId, key, page)), { page: 1, taken: true });
    const once = (await jobOf(s, jobId)).rowsWritten;
    whereBilled(() => assert.equal(once! - begun!, 2 * 2, "two rows, each in the table and its index"));
    assert.deepEqual(value(await s.store.rowsSend(RUN, jobId, key, page)), { page: 1, taken: false });
    assert.equal((await jobOf(s, jobId)).rowsWritten, once, "the page sent again wrote nothing");
    assert.equal(refusal(await s.store.rowsSend(RUN, jobId, key, { page: 3, rows: [] })).code, "page_out_of_order");
    assert.equal(tableRows(s, `${PREVIEW}__new`).length, 2);
  });

  it("starts over at a successor's begin", async () => {
    const s = setup();
    permits(s);
    const { jobId, key } = await started(s, "push_preview", previewParams(), "successor");
    value(await s.store.rowsBegin(RUN, jobId, key, BEGIN));
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: [FOUND[3]] }));
    // The container is gone; a new DB IO job gets its own key and begins again.
    const next = value(await s.store.jobKey(RUN, jobId, { key: newKey() })).key;
    assert.equal(refusal(await s.store.rowsSend(RUN, jobId, key, { page: 2, rows: [FOUND[4]] })).code, "job_key_refused");
    const state = value(await s.store.rowsState(RUN, jobId, next));
    assert.deepEqual([state.state, state.begun, state.page, state.key, state.columns], ["taking", true, 1, ["permit_no"], COLUMNS]);
    value(await s.store.rowsBegin(RUN, jobId, next, BEGIN));
    assert.equal(value(await s.store.rowsState(RUN, jobId, next)).page, 0);
    assert.equal(tableRows(s, `${PREVIEW}__new`).length, 0, "the work begins again");
    assert.deepEqual(value(await s.store.rowsSend(RUN, jobId, next, { page: 1, rows: [FOUND[3], FOUND[4]] })), { page: 1, taken: true });
    value(await s.store.rowsEnd(RUN, jobId, next, { read: 10, targetRows: 8, same: 8 }));
    const job = await finished(s, jobId);
    assert.equal((job.result as PushPreviewResult).inserts, 2);
    assert.deepEqual(tableRows(s, PREVIEW).map((r) => r._key), ["P09", "P10"]);
  });

  it("reads no memory when the columns written change, and leaves it and who wrote to that preview's write", async () => {
    const s = setup();
    permits(s);
    wroteBefore(s, MEMORY, { [WRITER]: "2026-11-01T00:00:00.000Z" });
    const { jobId, key } = await started(s, "push_preview", previewParams(), "fewer");
    // The database's table lost its fee column: what the memory hashed is not what a write writes now.
    const begin = value(await s.store.rowsBegin(RUN, jobId, key, { columns: DB_COLUMNS.slice(0, 2), primaryKey: ["permit_no"] }));
    assert.deepEqual(begin, { columns: ["permit_no", "status"], key: ["permit_no"], missing: [], rows: 10 });
    assert.deepEqual(value(await s.store.rowsRead(RUN, jobId, key, { part: "memory", after: null })), { rows: [], next: null }, "the memory is of the old columns");
    // A row it finds already holding the store's values is not noted in a memory of other columns.
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: [{ key: "P02", action: "adopt", now: h(0x20), will: h(0x20) }, { key: "P11", action: "forget" }] }));
    value(await s.store.rowsEnd(RUN, jobId, key, { read: 10, targetRows: 10, same: 10 }));
    const job = await finished(s, jobId);
    assert.equal((job.result as PushPreviewResult).first, true, "its write asks a person again");
    assert.deepEqual((job.result as PushPreviewResult).ignored, ["fee", "notes"]);
    // A preview made by mistake leaves the memory that holds people's edits back, and who wrote.
    assert.deepEqual(memory(s).map((m) => m[0]), ["P01", "P11", "P12"]);
    assert.deepEqual(Object.keys(record(s)!.writers), [WRITER]);
    // Its write starts the memory and the record of its columns anew.
    const write = value(await s.store.jobSubmit(RUN, { kind: "push", params: { connection: CONNECTION, preview: { table: PREVIEW, version: 1 }, writer: WRITER, madeBy: null }, requestKey: "new-columns" })).job;
    await s.store.alarm();
    assert.equal((await jobOf(s, write.id)).state, "done");
    assert.deepEqual(memory(s), []);
    assert.deepEqual({ ...record(s)!, last: null }, { key: ["permit_no"], columns: ["permit_no", "status"], writers: {}, last: null });
  });

  it("reads the store's table by rowid, its memory by key, and says the key and the columns it read", async () => {
    const s = setup();
    permits(s);
    wroteBefore(s, MEMORY);
    // A value the database would take as a number, one past 2^53, and bytes.
    s.storage.sql.exec("UPDATE permits SET fee = 9007199254740993 WHERE permit_no = 'P02'");
    s.storage.sql.exec("UPDATE permits SET fee = x'00ff' WHERE permit_no = 'P04'");
    s.storage.sql.exec("UPDATE permits SET fee = 1.5 WHERE permit_no = 'P06'");
    const { jobId, key } = await started(s, "push_preview", previewParams(), "reads");
    assert.equal(refusal(await s.store.rowsRead(RUN, jobId, key, { part: "source", after: null })).code, "rows_not_begun");
    value(await s.store.rowsBegin(RUN, jobId, key, BEGIN));
    const first = value(await s.store.rowsRead(RUN, jobId, key, { part: "source", after: null, limit: 4 }));
    assert.deepEqual(first, {
      rows: [
        ["P01", "Issued", "10.00"],
        ["P02", "Issued", "9007199254740993"],
        ["P03", "Final", "30.00"],
        ["P04", "Issued", "\\x00ff"],
      ],
      next: "4",
    });
    const second = value(await s.store.rowsRead(RUN, jobId, key, { part: "source", after: first.next, limit: 4 }));
    assert.deepEqual(second.rows[1], ["P06", "Final", "1.5"]);
    assert.equal(second.next, "8");
    assert.deepEqual(value(await s.store.rowsRead(RUN, jobId, key, { part: "source", after: second.next, limit: 4 })), { rows: [["P09", "Issued", "90.00"], ["P10", "Final", "100.00"]], next: null });
    const mem = value(await s.store.rowsRead(RUN, jobId, key, { part: "memory", after: null, limit: 2 }));
    assert.deepEqual(mem, { rows: [["P01", h(0x10), h(0x10), true], ["P11", h(0xb0), h(0xb0), true]], next: "P11" });
    assert.deepEqual(value(await s.store.rowsRead(RUN, jobId, key, { part: "memory", after: "P11", limit: 2 })), { rows: [["P12", h(0xc0), h(0xc0), true]], next: null });
    assert.equal(refusal(await s.store.rowsRead(RUN, jobId, key, { part: "write", after: null })).code, "bad_request");
  });

  it("reads a view by place, and takes the key it is asked for in the database's spelling", async () => {
    const s = setup();
    permits(s);
    s.storage.sql.exec("CREATE VIEW issued AS SELECT permit_no AS Permit_No, Status, fee FROM permits WHERE Status = 'Issued'");
    const { jobId, key } = await started(s, "push_preview", previewParams({ source: "Issued", key: ["PERMIT_NO"] }), "view");
    const begin = value(await s.store.rowsBegin(RUN, jobId, key, { columns: DB_COLUMNS, primaryKey: [] }));
    assert.deepEqual(begin, { columns: COLUMNS, key: ["permit_no"], missing: [], rows: 7 });
    const first = value(await s.store.rowsRead(RUN, jobId, key, { part: "source", after: null, limit: 3 }));
    assert.deepEqual(first, { rows: [["P01", "Issued", "10.00"], ["P02", "Issued", "20.00"], ["P04", "Issued", "40.00"]], next: "3" });
    const second = value(await s.store.rowsRead(RUN, jobId, key, { part: "source", after: "3", limit: 3 }));
    assert.deepEqual(second.next, "6");
    assert.deepEqual(value(await s.store.rowsRead(RUN, jobId, key, { part: "source", after: "6", limit: 3 })), { rows: [["P09", "Issued", "90.00"]], next: null });
    assert.equal(value(await s.store.rowsState(RUN, jobId, key)).theirEdits, "hold");
  });

  it("keeps its own words' names when the database's key takes one of them", async () => {
    const s = setup();
    s.storage.sql.exec("CREATE TABLE notes (note TEXT, body TEXT)");
    s.storage.sql.exec("INSERT INTO notes VALUES ('N1', 'first')");
    const { jobId, key } = await started(s, "push_preview", previewParams({ source: "notes" }), "own-words");
    value(await s.store.rowsBegin(RUN, jobId, key, { columns: [{ name: "note", type: "text", required: true }, { name: "body", type: "text", required: false }], primaryKey: ["note"] }));
    assert.deepEqual(columnsOf(s, `${PREVIEW}__new`), ["note_2", "what_happens", "body_now", "body_after", "note", "_key", "_hash", "_now_hash", "_values", "_changed", "_before"]);
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: [{ key: "N1", action: "new", will: h(1), after: ["N1", "first"] }] }));
    assert.deepEqual(tableRows(s, `${PREVIEW}__new`).map((r) => [r.note_2, r.what_happens, r.note]), [["N1", "new", null]]);
  });

  it("reads no table a job is still writing", async () => {
    const s = setup();
    permits(s);
    s.storage.sql.exec("CREATE TABLE permits__new (permit_no TEXT)");
    const job = value(await s.store.jobSubmit(RUN, { kind: "push_preview", params: previewParams({ source: "permits__new" }), requestKey: "work-table" })).job;
    await s.store.alarm();
    assert.equal((await jobOf(s, job.id)).error, "This store has no table or view permits__new.");
  });

  it("names a required column of the database's that the store's table has not", async () => {
    const s = setup();
    permits(s);
    const { jobId, key } = await started(s, "push_preview", previewParams(), "missing");
    const columns = [...DB_COLUMNS, { name: "issued_on", type: "date", required: true }, { name: "inspector", type: "varchar(50)", required: false }];
    assert.deepEqual(value(await s.store.rowsBegin(RUN, jobId, key, { columns, primaryKey: ["permit_no"] })).missing, ["issued_on"]);
  });

  it("refuses a key that does not name each row once, in counts and names alone", async () => {
    const s = setup();
    permits(s, [...TEN, [null, "Issued", "1.00"], [null, "Final", "2.00"]]);
    const one = await started(s, "push_preview", previewParams(), "no-key");
    const empty = refusal(await s.store.rowsBegin(RUN, one.jobId, one.key, BEGIN));
    assert.deepEqual(empty, { ok: false, status: 409, code: "push_key", error: "2 rows of permits have no permit_no: every row needs a key to be written." });
    s.storage.sql.exec("UPDATE permits SET permit_no = 'P01' WHERE permit_no IS NULL");
    const twice = refusal(await s.store.rowsBegin(RUN, one.jobId, one.key, BEGIN));
    assert.equal(twice.error, "1 key names more than one row of permits: a key names one row.");
    assert.equal(refusal(await s.store.rowsBegin(RUN, one.jobId, one.key, { columns: DB_COLUMNS, primaryKey: [] })).error, "dbo.permits has no primary key: say which columns name a row.");
  });

  it("refuses a key the store's table lacks, or one the database's has not", async () => {
    const s = setup();
    permits(s);
    const asked = await started(s, "push_preview", previewParams({ key: ["inspector"] }), "key-there");
    assert.equal(refusal(await s.store.rowsBegin(RUN, asked.jobId, asked.key, { columns: [...DB_COLUMNS, { name: "Inspector", type: "text", required: false }], primaryKey: [] })).error, "permits has no column Inspector, which the key names: a row is found by its key on both sides.");
    assert.equal(refusal(await s.store.rowsBegin(RUN, asked.jobId, asked.key, BEGIN)).error, "dbo.permits has no column inspector, which the key names.");
  });

  it("fails at once without its store table, or when its table's name is another step's", async () => {
    const s = setup();
    permits(s);
    s.storage.sql.exec(`CREATE TABLE ${PREVIEW} (x TEXT)`);
    for (const [params, requestKey, words] of [
      [previewParams({ source: "nope" }), "no-source", /^This store has no table or view nope\.$/],
      [previewParams({ source: "_meta" }), "own-table", /^This store has no table or view _meta\.$/],
      [previewParams(), "taken", /push_preview_permits is one of this store's own tables/],
    ] as const) {
      const job = value(await s.store.jobSubmit(RUN, { kind: "push_preview", params, requestKey })).job;
      await s.store.alarm();
      const ended = await jobOf(s, job.id);
      assert.equal(ended.state, "failed");
      assert.match(ended.error ?? "", words);
    }
  });

  it("fails with its DB IO job's words, and drops what it had begun", async () => {
    const s = setup();
    permits(s);
    const { jobId, key } = await started(s, "push_preview", previewParams(), "fails");
    value(await s.store.rowsBegin(RUN, jobId, key, BEGIN));
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: [FOUND[3]] }));
    assert.equal(value(await s.store.rowsFail(RUN, jobId, key, { code: "database", message: "The login was refused." })), null);
    await s.store.alarm();
    const job = await jobOf(s, jobId);
    assert.deepEqual([job.state, job.error], ["failed", "The login was refused."]);
    assert.equal(sql(s, "SELECT 1 FROM sqlite_master WHERE name = ?", `${PREVIEW}__new`).length, 0);
  });

  it("fails when its DB IO job stops and its time runs out, keeping no day for it", async () => {
    const s = setup();
    permits(s);
    const job = value(await s.store.jobSubmit(RUN, { kind: "push_preview", params: previewParams(), requestKey: "late" })).job;
    await s.store.alarm();
    const { key } = value(await s.store.jobKey(RUN, job.id, { key: newKey(), until: new Date(s.clock.now() + 30 * 60_000).toISOString() }));
    value(await s.store.rowsBegin(RUN, job.id, key, BEGIN));
    value(await s.store.rowsSend(RUN, job.id, key, { page: 1, rows: [FOUND[3]] }));
    s.clock.advance(31 * 60_000);
    await s.store.alarm();
    const ended = await jobOf(s, job.id);
    assert.equal(ended.state, "failed");
    assert.match(ended.error ?? "", /stopped before this preview was done/);
  });

  it("holds its place at the day's write limit until the day ends", async () => {
    const s = setup();
    permits(s);
    const job = value(await s.store.jobSubmit(RUN, { kind: "push_preview", params: previewParams(), requestKey: "limit" })).job;
    await s.store.alarm();
    const { key } = value(await s.store.jobKey(RUN, job.id, { key: newKey(), until: new Date(s.clock.now() + 30 * 60_000).toISOString() }));
    value(await s.store.rowsFail(RUN, job.id, key, { code: "store_limit", message: "This store reached its limit of rows written today." }));
    s.clock.advance(40 * 60_000);
    await s.store.alarm();
    assert.equal((await jobOf(s, job.id)).state, "running", "it waits past its key's own time, until the day ends");
  });

  it("removes only when asked, and tells its DB IO job so", async () => {
    const s = setup();
    permits(s);
    const asked = await started(s, "push_preview", previewParams({ removes: true }), "removes");
    assert.equal(value(await s.store.rowsState(RUN, asked.jobId, asked.key)).removes, true);
    const plain = await started(s, "push_preview", previewParams({ into: "push_preview_plain" }), "keeps");
    assert.equal(value(await s.store.rowsState(RUN, plain.jobId, plain.key)).removes, false);
  });

  it("refuses a table that keeps columns in _extra the database's table has", async () => {
    const s = setup();
    s.storage.sql.exec(`CREATE TABLE wide ("_key" TEXT, permit_no TEXT, status TEXT, "_extra" TEXT)`);
    s.storage.sql.exec(`INSERT INTO wide VALUES ('P01', 'P01', 'Issued', '{"fee":"10.00"}')`);
    const { jobId, key } = await started(s, "push_preview", previewParams({ source: "wide" }), "packed");
    const refused = refusal(await s.store.rowsBegin(RUN, jobId, key, BEGIN));
    assert.equal(refused.code, "push_source");
    assert.match(refused.error, /wide keeps some of its columns packed in _extra/);
  });

  it("gives a job waiting its turn a clean start under a new DB IO job's key", async () => {
    const s = setup();
    permits(s);
    await started(s, "push_preview", previewParams(), "ahead");
    const behind = value(await s.store.jobSubmit(RUN, { kind: "push_preview", params: previewParams({ into: "push_preview_behind" }), requestKey: "behind" })).job;
    const first = value(await s.store.jobKey(RUN, behind.id, { key: newKey() })).key;
    value(await s.store.rowsFail(RUN, behind.id, first, { code: "login", message: "The login was refused." }));
    assert.equal(sql(s, "SELECT error FROM _jobs WHERE id = ?", behind.id)[0]!.error, "The login was refused.");
    value(await s.store.jobKey(RUN, behind.id, { key: newKey() }));
    assert.equal(sql(s, "SELECT error FROM _jobs WHERE id = ?", behind.id)[0]!.error, null, "the new DB IO job's turn is its own");
  });

  it("answers its end again when the answer was lost", async () => {
    const s = setup();
    permits(s);
    const { jobId, key } = await started(s, "push_preview", previewParams(), "lost");
    value(await s.store.rowsBegin(RUN, jobId, key, BEGIN));
    const end = { read: 10, targetRows: 10, same: 10 };
    assert.deepEqual(value(await s.store.rowsEnd(RUN, jobId, key, end)), { finishing: true });
    assert.deepEqual(value(await s.store.rowsEnd(RUN, jobId, key, end)), { finishing: true }, "while the store finishes");
    await finished(s, jobId);
    assert.deepEqual(value(await s.store.rowsEnd(RUN, jobId, key, end)), { finishing: true }, "after the job is done");
  });

  it("packs a wide table's columns past the 90th into _extra a pair at a time, and keeps its own words as columns", async () => {
    const s = setup();
    const names = Array.from({ length: 49 }, (_, i) => `c${i + 1}`);
    s.storage.sql.exec(`CREATE TABLE wide (permit_no TEXT, ${names.map((n) => `${n} TEXT`).join(", ")})`);
    s.storage.sql.exec(`INSERT INTO wide VALUES ('W1', ${names.map((n) => `'${n}'`).join(", ")})`);
    const { jobId, key } = await started(s, "push_preview", previewParams({ source: "wide" }), "wide");
    const columns = [{ name: "permit_no", type: "text", required: true }, ...names.map((name) => ({ name, type: "text", required: false }))];
    value(await s.store.rowsBegin(RUN, jobId, key, { columns, primaryKey: ["permit_no"] }));
    const after = ["W1", ...names.map((n) => `${n}-new`)];
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: [{ key: "W1", action: "new", will: h(1), after }] }));
    value(await s.store.rowsEnd(RUN, jobId, key, { read: 1, targetRows: 0, same: 0 }));
    const job = await finished(s, jobId);
    assert.equal((job.result as PushPreviewResult).share, 1, "an empty table it fills");
    const made = columnsOf(s, PREVIEW);
    // 1 key column, 43 pairs, and its two words: 89 columns a person reads, then _extra, then the machine's 6.
    assert.equal(made.length, 89 + 1 + 6);
    assert.deepEqual(made.slice(0, 3), ["permit_no", "what_happens", "c1_now"]);
    assert.deepEqual(made.slice(87, 90), ["c43_after", "note", "_extra"]);
    assert.deepEqual(made.slice(-6), ["_key", "_hash", "_now_hash", "_values", "_changed", "_before"]);
    const [row] = tableRows(s, PREVIEW);
    assert.deepEqual(JSON.parse(String(row!._extra)), { c44_after: "c44-new", c45_after: "c45-new", c46_after: "c46-new", c47_after: "c47-new", c48_after: "c48-new", c49_after: "c49-new" });
    assert.equal(JSON.parse(String(row!._values)).length, 50, "the values to write are whole");
  });
});

/** The ten permits previewed, then a write of that preview started, with a key for its DB IO job. */
async function writing(s: Setup, requestKey = "push-1") {
  permits(s);
  wroteBefore(s, MEMORY);
  await previewed(s);
  const params = { connection: CONNECTION, preview: { table: PREVIEW, version: 1 }, writer: WRITER, madeBy: { runId: "mrn-1", step: "s2" } };
  return { ...(await started(s, "push", params, requestKey)), params };
}

describe("a write of a preview, in a store", () => {
  it("takes each batch's outcomes once, keeps what it wrote, and lists the rows held back", async () => {
    const s = setup();
    const { jobId, key } = await writing(s);
    const state = value(await s.store.rowsState(RUN, jobId, key));
    assert.deepEqual(
      { ...state, limits: null },
      {
        kind: "push",
        state: "taking",
        error: null,
        target: TARGET,
        key: ["permit_no"],
        columns: COLUMNS,
        theirEdits: "hold",
        removes: false,
        begun: false,
        page: 0,
        cursor: null,
        limits: null,
        oneTransaction: false,
        rehearse: false,
        parts: [{ target: TARGET, key: ["permit_no"], columns: COLUMNS }],
        links: [],
      },
    );
    assert.equal(refusal(await s.store.rowsBegin(RUN, jobId, key, BEGIN)).code, "bad_request");
    const first = value(await s.store.rowsRead(RUN, jobId, key, { part: "write", after: null, limit: 2 }));
    assert.deepEqual(first, {
      rows: [
        { key: "P03", action: "changed", now: h(0x30), values: ["P03", "Final", "30.00"], changed: ["status"] },
        { key: "P09", action: "new", now: null, values: ["P09", "Issued", "90.00"], changed: null },
      ],
      next: "P09",
    });
    const before = (await jobOf(s, jobId)).rowsWritten;
    const batch = { page: 1, last: "P09", rows: [{ key: "P03", outcome: "written", sent: h(0x31), held: h(0x31) }, { key: "P09", outcome: "written", sent: h(0x91), held: h(0x92) }] };
    assert.deepEqual(value(await s.store.rowsSend(RUN, jobId, key, batch)), { page: 1, taken: true });
    // The database's table's bar: the rows its batches took so far, out of its preview's.
    const during = (await jobOf(s, jobId)).progress!;
    assert.deepEqual(during.tables, [{ name: "dbo.permits", source: PREVIEW, state: "running", done: 2, total: during.total }]);
    const once = (await jobOf(s, jobId)).rowsWritten;
    assert.equal(once! - before!, 2 + 2, "two rows of the memory, and two of the write's record");
    assert.deepEqual(value(await s.store.rowsSend(RUN, jobId, key, batch)), { page: 1, taken: false });
    assert.equal((await jobOf(s, jobId)).rowsWritten, once, "the batch sent again wrote nothing");
    assert.equal(value(await s.store.rowsState(RUN, jobId, key)).cursor, "P09");
    const second = value(await s.store.rowsRead(RUN, jobId, key, { part: "write", after: "P09", limit: 2 }));
    assert.deepEqual(second.rows.map((r) => (r as { key: string }).key), ["P10", "P11"]);
    assert.deepEqual(second.rows[1], { key: "P11", action: "removed", now: h(0xb0), values: null, changed: null });
    assert.deepEqual(value(await s.store.rowsRead(RUN, jobId, key, { part: "write", after: "P11", limit: 2 })), { rows: [], next: null });
    value(await s.store.rowsSend(RUN, jobId, key, { page: 2, last: "P11", rows: [{ key: "P10", outcome: "held", why: "appeared" }, { key: "P11", outcome: "removed" }] }));
    assert.deepEqual(value(await s.store.rowsEnd(RUN, jobId, key, { batches: 2 })), { finishing: true });
    const job = await finished(s, jobId);
    // The same numbers stay on the job after it ended.
    assert.deepEqual(job.progress?.tables, [{ name: "dbo.permits", source: PREVIEW, state: "done", done: 4, total: 4 }]);
    const heldTable = "push_held_permits";
    assert.deepEqual(job.result, {
      write: jobId,
      rehearsed: false,
      restored: null,
      manifest: [],
      parts: [{ preview: { table: PREVIEW, version: 1 }, target: "dbo.permits", inserted: 1, updated: 1, deleted: 1, held: 2, heldTable: { table: heldTable, version: 1, rows: 2 }, kept: 0, keptColumns: [], keptTable: null }],
      preview: { table: PREVIEW, version: 1 },
      target: "dbo.permits",
      inserted: 1,
      updated: 1,
      deleted: 1,
      held: 2,
      heldSince: 1,
      batches: 2,
      heldTable: { table: heldTable, version: 1, rows: 2 },
      kept: 0,
      keptTable: null,
    } satisfies PushResult);
    // The memory: what was written, P09 as put there by this store (it was new), and the removed key gone.
    assert.deepEqual(memory(s), [["P01", h(0x10), h(0x10), 1], ["P03", h(0x31), h(0x31), 0], ["P06", h(0x60), h(0x60), 0], ["P09", h(0x91), h(0x92), 1]]);
    // The rows held at the preview, and the one the database took on after it.
    assert.deepEqual(columnsOf(s, heldTable), ["permit_no", "what_happens", "status_now", "status_after", "fee_now", "fee_after", "note", "_key"]);
    assert.deepEqual(
      tableRows(s, heldTable).map((r) => [r._key, r.what_happens, r.status_now, r.status_after, r.note]),
      [
        ["P05", "held", "Withdrawn", "Issued", "Changed in Maple Ridge permits since our last write: not written"],
        ["P10", "held", null, "Final", "Added to Maple Ridge permits after the preview: not written"],
      ],
    );
    assert.equal(sql(s, "SELECT grp FROM _tables WHERE name = ?", heldTable)[0]!.grp, HELD_GROUP);
    const rec = record(s)!;
    assert.deepEqual(Object.keys(rec.writers), [WRITER]);
    assert.deepEqual({ ...rec.last!, at: "" }, { at: "", by: "run:mrn-1", preview: { table: PREVIEW, version: 1 }, inserted: 1, updated: 1, deleted: 1, held: 2 });
    // Three rows of the memory, three of the write's record, the held table's two rows, and its own records: not the preview's size, nor the store table's.
    assert.ok(job.rowsWritten! >= 3 + 3 + 2 && job.rowsWritten! < 3 + 3 + 2 + records(8), `wrote ${job.rowsWritten}`);
    // The writer's next preview into the table asks nobody first.
    const next = await started(s, "push_preview", previewParams(), "preview-2");
    value(await s.store.rowsBegin(RUN, next.jobId, next.key, BEGIN));
    value(await s.store.rowsEnd(RUN, next.jobId, next.key, { read: 10, targetRows: 9, same: 10 }));
    const again = await finished(s, next.jobId);
    assert.equal((again.result as PushPreviewResult).first, false);
  });

  it("goes on after the cursor under a stopped DB IO job's successor", async () => {
    const s = setup();
    const { jobId, key } = await writing(s);
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, last: "P09", rows: [{ key: "P03", outcome: "written", sent: h(0x31), held: h(0x31) }, { key: "P09", outcome: "written", sent: h(0x91), held: h(0x91) }] }));
    const next = value(await s.store.jobKey(RUN, jobId, { key: newKey() })).key;
    assert.equal(refusal(await s.store.rowsState(RUN, jobId, key)).code, "job_key_refused", "a newer key refuses the older one");
    const state = value(await s.store.rowsState(RUN, jobId, next));
    assert.deepEqual([state.page, state.cursor], [1, "P09"]);
    assert.deepEqual(value(await s.store.rowsRead(RUN, jobId, next, { part: "write", after: state.cursor, limit: 500 })).rows.map((r) => (r as { key: string }).key), ["P10", "P11"]);
  });

  it("refuses a write of a preview another one replaced", async () => {
    const s = setup();
    permits(s);
    wroteBefore(s, MEMORY);
    await previewed(s, "preview-1");
    await previewed(s, "preview-2");
    const job = value(await s.store.jobSubmit(RUN, { kind: "push", params: { connection: CONNECTION, preview: { table: PREVIEW, version: 1 }, writer: WRITER, madeBy: null }, requestKey: "old" })).job;
    await s.store.alarm();
    const ended = await jobOf(s, job.id);
    assert.deepEqual([ended.state, ended.error], ["failed", "push_preview_permits is now version 2: preview again, then write that."]);
  });

  it("refuses a write once a write of other columns came after its preview", async () => {
    const s = setup();
    permits(s);
    wroteBefore(s, MEMORY);
    await previewed(s);
    const later = JSON.stringify({ at: "2999-01-01T00:00:00.000Z", by: "run:mrn-9", preview: { table: "push_preview_other", version: 1 }, inserted: 1, updated: 0, deleted: 0, held: 0 });
    s.storage.sql.exec("UPDATE _meta SET value = json_set(value, '$.columns', json('[\"permit_no\",\"status\"]'), '$.last', json(?)) WHERE key = ?", later, RECORD_KEY);
    const job = value(await s.store.jobSubmit(RUN, { kind: "push", params: { connection: CONNECTION, preview: { table: PREVIEW, version: 1 }, writer: WRITER, madeBy: null }, requestKey: "stale" })).job;
    await s.store.alarm();
    const ended = await jobOf(s, job.id);
    assert.deepEqual([ended.state, ended.error], ["failed", "The columns written into dbo.permits changed since this preview: preview again."]);
  });

  it("ends at once with nothing to write, listing the rows held back, and notes no writer: it asked nobody", async () => {
    const s = setup();
    permits(s);
    const { jobId, key } = await started(s, "push_preview", previewParams(), "held-only");
    value(await s.store.rowsBegin(RUN, jobId, key, BEGIN));
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: [FOUND[1], FOUND[2]] }));
    value(await s.store.rowsEnd(RUN, jobId, key, { read: 10, targetRows: 10, same: 9 }));
    await finished(s, jobId);
    const job = value(await s.store.jobSubmit(RUN, { kind: "push", params: { connection: CONNECTION, preview: { table: PREVIEW, version: 1 }, writer: WRITER, madeBy: null }, requestKey: "nothing" })).job;
    await s.store.alarm();
    const done = await jobOf(s, job.id);
    assert.equal(done.state, "done", done.error ?? "");
    assert.deepEqual(done.result, {
      write: job.id,
      rehearsed: false,
      restored: null,
      manifest: [],
      parts: [{ preview: { table: PREVIEW, version: 1 }, target: "dbo.permits", inserted: 0, updated: 0, deleted: 0, held: 1, heldTable: { table: "push_held_permits", version: 1, rows: 1 }, kept: 0, keptColumns: [], keptTable: null }],
      preview: { table: PREVIEW, version: 1 },
      target: "dbo.permits",
      inserted: 0,
      updated: 0,
      deleted: 0,
      held: 1,
      heldSince: 0,
      batches: 0,
      heldTable: { table: "push_held_permits", version: 1, rows: 1 },
      kept: 0,
      keptTable: null,
    } satisfies PushResult);
    assert.deepEqual(Object.keys(record(s)!.writers), [], "the first write with rows to write asks");
    // A later write that holds nothing back empties the list.
    const clear = await started(s, "push_preview", previewParams(), "clear");
    value(await s.store.rowsBegin(RUN, clear.jobId, clear.key, BEGIN));
    value(await s.store.rowsEnd(RUN, clear.jobId, clear.key, { read: 10, targetRows: 10, same: 10 }));
    const preview = await finished(s, clear.jobId);
    const empty = value(await s.store.jobSubmit(RUN, { kind: "push", params: { connection: CONNECTION, preview: { table: PREVIEW, version: (preview.result as PushPreviewResult).version }, writer: WRITER, madeBy: null }, requestKey: "empty" })).job;
    await s.store.alarm();
    assert.deepEqual(((await jobOf(s, empty.id)).result as PushResult).heldTable, null);
    assert.equal(tableRows(s, "push_held_permits").length, 0);
  });

  it("writes a preview once: a second write of it is refused", async () => {
    const s = setup();
    const { jobId, key } = await writing(s);
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, last: "P11", rows: [{ key: "P03", outcome: "written", sent: h(0x31), held: h(0x31) }] }));
    value(await s.store.rowsEnd(RUN, jobId, key, { batches: 1 }));
    await finished(s, jobId);
    const again = value(await s.store.jobSubmit(RUN, { kind: "push", params: { connection: CONNECTION, preview: { table: PREVIEW, version: 1 }, writer: WRITER, madeBy: null }, requestKey: "again" })).job;
    await s.store.alarm();
    const ended = await jobOf(s, again.id);
    assert.deepEqual([ended.state, ended.error], ["failed", "push_preview_permits version 1 was written already: preview again to see what is left to write."]);
  });

  it("asked again after a write failed, reads none of the rows the failed one wrote", async () => {
    const s = setup();
    const { jobId, key } = await writing(s);
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, last: "P09", rows: [{ key: "P03", outcome: "written", sent: h(0x31), held: h(0x31) }, { key: "P09", outcome: "written", sent: h(0x91), held: h(0x91) }] }));
    value(await s.store.rowsFail(RUN, jobId, key, { code: "database", message: "Could not insert the batch's new rows into dbo.permits." }));
    await s.store.alarm();
    assert.equal((await jobOf(s, jobId)).state, "failed");
    // What it is stays, with what its batches did, for an undo: it wrote P03 and P09, and the preview held P05.
    const kept = JSON.parse(String(sql(s, "SELECT value FROM _meta WHERE key = ?", pushWriteKey(jobId))[0]!.value)) as PushWriteRecord;
    assert.deepEqual(kept.parts.map((p) => [p.inserted, p.updated, p.deleted, p.held]), [[1, 1, 0, 1]]);
    assert.deepEqual(sql(s, "SELECT k, state FROM _push_writes WHERE job = ? ORDER BY k", jobId), [{ k: "P03", state: "done" }, { k: "P09", state: "done" }]);
    const retry = await started(s, "push", { connection: CONNECTION, preview: { table: PREVIEW, version: 1 }, writer: WRITER, madeBy: null }, "retry");
    const rows = value(await s.store.rowsRead(RUN, retry.jobId, retry.key, { part: "write", after: null, limit: 500 })).rows;
    assert.deepEqual(rows.map((r) => (r as { key: string }).key), ["P10", "P11"], "P03 and P09 are written already");
  });

  it("records a row an earlier DB IO job wrote, whose page the store never heard, by what its preview says", async () => {
    const s = setup();
    const { jobId, key } = await writing(s);
    // A successor finds P03 and P09 holding their new values, and P11 gone already: it names no did.
    value(
      await s.store.rowsSend(RUN, jobId, key, {
        page: 1,
        last: "P11",
        rows: [
          { key: "P03", outcome: "written", sent: h(0x31), held: h(0x32) },
          { key: "P09", outcome: "written", sent: h(0x91), held: h(0x92) },
          { key: "P11", outcome: "removed" },
        ],
      }),
    );
    // The preview changed P03 from what it read and found P09 new; P11 may be someone else's delete.
    assert.deepEqual(sql(s, "SELECT k, did, set_cols, before FROM _push_writes WHERE job = ? ORDER BY k", jobId), [
      { k: "P03", did: "updated", set_cols: '["status"]', before: '["P03","Issued","30.00"]' },
      { k: "P09", did: "inserted", set_cols: null, before: null },
      { k: "P11", did: null, set_cols: null, before: null },
    ]);
  });

  it("counts and lists the values its database kept other than it sent them, each beside the one it holds", async () => {
    const s = setup();
    const { jobId, key } = await writing(s);
    value(
      await s.store.rowsSend(RUN, jobId, key, {
        page: 1,
        last: "P09",
        rows: [
          // A trigger wrote P03's status in capitals; P09's was cut short to fit its column.
          { key: "P03", outcome: "written", sent: h(0x31), held: h(0x33), did: "updated", set: ["status"], before: ["P03", "Issued", "30.00"], after: ["P03", "FINAL", "30.00"], kept: [{ column: "status", how: "changed" }] },
          { key: "P09", outcome: "written", sent: h(0x91), held: h(0x93), did: "inserted", after: ["P09", "Issu", "90.00"], kept: [{ column: "status", how: "cut" }] },
        ],
      }),
    );
    value(await s.store.rowsSend(RUN, jobId, key, { page: 2, last: "P11", rows: [{ key: "P10", outcome: "held", why: "appeared" }, { key: "P11", outcome: "removed" }] }));
    value(await s.store.rowsEnd(RUN, jobId, key, { batches: 2, kept: [{ table: 0, column: "status", how: "changed", rows: 1 }, { table: 0, column: "status", how: "cut", rows: 1 }] }));
    const job = await finished(s, jobId);
    const result = job.result as PushResult;
    const list = { table: "push_kept_permits", version: 1, rows: 2 };
    assert.equal(result.kept, 2);
    assert.deepEqual(result.keptTable, list);
    assert.deepEqual([result.parts[0]!.kept, result.parts[0]!.keptColumns, result.parts[0]!.keptTable], [2, [{ column: "status", how: "cut", rows: 1 }, { column: "status", how: "changed", rows: 1 }], list]);
    assert.deepEqual(columnsOf(s, "push_kept_permits"), ["permit_no", "what_happened", "kept_differently", "status_sent", "status_kept", "fee_sent", "fee_kept", "_key", "_hash", "_after_hash"]);
    assert.deepEqual(
      tableRows(s, "push_kept_permits").map((r) => [r._key, r.what_happened, r.kept_differently, r.status_sent, r.status_kept, r.fee_sent, r.fee_kept]),
      [
        ["P03", "updated", "status: changed", "Final", "FINAL", "30.00", "30.00"],
        ["P09", "inserted", "status: cut short", "Issued", "Issu", "90.00", "90.00"],
      ],
    );
  });

  it("leaves an earlier write's list of kept rows as it is when a later write keeps none: no preview finds them again", async () => {
    const s = setup();
    const first = await writing(s);
    // A write's `after` holds only the kept columns' values.
    value(await s.store.rowsSend(RUN, first.jobId, first.key, { page: 1, last: "P09", rows: [{ key: "P09", outcome: "written", sent: h(0x91), held: h(0x93), did: "inserted", after: [null, "Issu", null], kept: [{ column: "status", how: "cut" }] }] }));
    value(await s.store.rowsEnd(RUN, first.jobId, first.key, { batches: 1 }));
    const list = { table: "push_kept_permits", version: 1, rows: 1 };
    assert.deepEqual(((await finished(s, first.jobId)).result as PushResult).keptTable, list);
    assert.deepEqual(
      tableRows(s, "push_kept_permits").map((r) => [r._key, r.kept_differently, r.status_sent, r.status_kept, r.fee_sent, r.fee_kept]),
      [["P09", "status: cut short", "Issued", "Issu", "90.00", "90.00"]],
    );
    await previewed(s, "preview-2");
    const second = await started(s, "push", { ...first.params, preview: { table: PREVIEW, version: 2 } }, "push-2");
    value(await s.store.rowsSend(RUN, second.jobId, second.key, { page: 1, last: "P03", rows: [{ key: "P03", outcome: "written", sent: h(0x31), held: h(0x31), did: "updated", set: ["status"], before: ["P03", "Issued", "30.00"] }] }));
    value(await s.store.rowsEnd(RUN, second.jobId, second.key, { batches: 1 }));
    const result = (await finished(s, second.jobId)).result as PushResult;
    assert.deepEqual([result.kept, result.keptTable], [0, null]);
    assert.deepEqual(sql(s, "SELECT version, rows FROM _tables WHERE name = 'push_kept_permits'"), [{ version: 1, rows: 1 }]);
  });

  it("takes a committed batch's page when another table took the list's name since the write began, and keeps the counts", async () => {
    const s = setup();
    const { jobId, key } = await writing(s);
    value(await s.store.exec({ storeId: STORE, actor: "user:u-1" }, { sql: "CREATE TABLE push_kept_permits (x TEXT)" }));
    const page = { page: 1, last: "P09", rows: [{ key: "P09", outcome: "written", sent: h(0x91), held: h(0x93), did: "inserted", after: [null, "Issu", null], kept: [{ column: "status", how: "cut" }] }] };
    assert.deepEqual(value(await s.store.rowsSend(RUN, jobId, key, page)), { page: 1, taken: true });
    // The batch is remembered and recorded, as any committed batch is.
    assert.deepEqual(sql(s, "SELECT k, did FROM _push_writes WHERE job = ?", jobId), [{ k: "P09", did: "inserted" }]);
    value(await s.store.rowsEnd(RUN, jobId, key, { batches: 1 }));
    const result = (await finished(s, jobId)).result as PushResult;
    assert.deepEqual([result.kept, result.parts[0]!.keptColumns, result.keptTable], [1, [{ column: "status", how: "cut", rows: 1 }], null]);
    assert.deepEqual(columnsOf(s, "push_kept_permits"), ["x"]);
  });

  it("keeps what it is from its start, ended and counted only once it ends: the rows an undo takes back", async () => {
    const s = setup();
    const { jobId, key } = await writing(s);
    const record = () => JSON.parse(String(sql(s, "SELECT value FROM _meta WHERE key = ?", pushWriteKey(jobId))[0]!.value)) as PushWriteRecord;
    assert.deepEqual([record().ended, record().parts.map((p) => [p.inserted, p.updated, p.deleted, p.held])], [false, [[0, 0, 0, 0]]]);
    value(
      await s.store.rowsSend(RUN, jobId, key, {
        page: 1,
        last: "P11",
        rows: [
          { key: "P03", outcome: "written", sent: h(0x31), held: h(0x32), did: "updated", set: ["status"], before: ["P03", "Issued", "30.00"] },
          { key: "P09", outcome: "written", sent: h(0x91), held: h(0x92), did: "inserted" },
          { key: "P10", outcome: "written", sent: h(0xa1), held: h(0xa2), did: "inserted" },
          { key: "P11", outcome: "removed" },
        ],
      }),
    );
    value(await s.store.rowsEnd(RUN, jobId, key, { batches: 1 }));
    await finished(s, jobId);
    // P11 was gone already: no undo puts it back, so the record does not count it.
    assert.deepEqual([record().ended, record().parts.map((p) => [p.inserted, p.updated, p.deleted, p.held])], [true, [[2, 1, 0, 1]]]);
  });

  it("reads a row an earlier write left with the values its preview sends: a preview that overwrites the database's edits writes it again", async () => {
    const s = setup();
    permits(s);
    // P03 was written before with the values this preview sends, and changed in the database since.
    wroteBefore(s, [...MEMORY, ["P03", h(0x31), h(0x3f)]]);
    await previewed(s);
    const { jobId, key } = await started(s, "push", { connection: CONNECTION, preview: { table: PREVIEW, version: 1 }, writer: WRITER, madeBy: null }, "overwrite");
    const rows = value(await s.store.rowsRead(RUN, jobId, key, { part: "write", after: null, limit: 500 })).rows;
    assert.deepEqual(rows.map((r) => (r as { key: string }).key), ["P03", "P09", "P10", "P11"]);
  });

  it("goes on with a write the store began before writes of several tables, its one preview as its one part", async () => {
    const s = setup();
    const { jobId, key } = await writing(s);
    // The state as a store before writes of several tables kept it: the preview's counts beside the rest.
    const saved = JSON.parse(String(sql(s, "SELECT run_state FROM _jobs WHERE id = ?", jobId)[0]!.run_state)) as { parts: Record<string, unknown>[] } & Record<string, unknown>;
    const { preview: _preview, manifest: _manifest, ...part } = saved.parts[0]!;
    const old = { phase: saved.phase, failure: saved.failure, ...part, page: saved.page, cursor: saved.cursor, batches: saved.batches, made: saved.made };
    s.storage.sql.exec("UPDATE _jobs SET run_state = ? WHERE id = ?", JSON.stringify(old), jobId);
    const state = value(await s.store.rowsState(RUN, jobId, key));
    assert.deepEqual([state.oneTransaction, state.parts.length, state.target], [false, 1, { schema: "dbo", name: "permits" }]);
    assert.deepEqual(value(await s.store.rowsSend(RUN, jobId, key, { page: 1, last: "P09", rows: [{ key: "P09", outcome: "written", sent: h(0x91), held: h(0x92), did: "inserted" }] })), { page: 1, taken: true });
  });

  it("takes a write's batch past the day's write limit: the database has it already", async () => {
    const s = setup();
    const { jobId, key } = await writing(s);
    pastTheLimit(s);
    assert.deepEqual(value(await s.store.rowsSend(RUN, jobId, key, { page: 1, last: "P09", rows: [{ key: "P09", outcome: "written", sent: h(0x91), held: h(0x91) }] })), { page: 1, taken: true });
    assert.deepEqual(memory(s).find((m) => m[0] === "P09"), ["P09", h(0x91), h(0x91), 1]);
  });

  it("refuses a preview's page past the day's write limit: it writes only the store's own table", async () => {
    const s = setup();
    permits(s);
    const preview = await started(s, "push_preview", previewParams(), "past");
    value(await s.store.rowsBegin(RUN, preview.jobId, preview.key, BEGIN));
    pastTheLimit(s);
    assert.equal(refusal(await s.store.rowsSend(RUN, preview.jobId, preview.key, { page: 1, rows: [FOUND[3]] })).code, "write_limit_reached");
  });

  it("keeps what a stopped write took for a day, unless another job needs the store", async () => {
    const s = setup();
    const { jobId, key } = await writing(s);
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, last: "P09", rows: [{ key: "P03", outcome: "written", sent: h(0x31), held: h(0x31) }] }));
    s.clock.advance(50 * 60_000);
    await s.store.alarm();
    assert.equal((await jobOf(s, jobId)).state, "running", "a successor may go on from its cursor");
    value(await s.store.jobSubmit(RUN, { kind: "push_preview", params: previewParams({ into: "push_preview_other" }), requestKey: "behind" }));
    await s.store.alarm();
    const ended = await jobOf(s, jobId);
    assert.equal(ended.state, "failed");
    assert.match(ended.error ?? "", /What it wrote stays written: preview again to see what is left\./);
  });
});

describe("a compare, in a store", () => {
  const compareParams = (overrides: Record<string, unknown> = {}) => ({ connection: CONNECTION, source: "permits", target: TARGET, key: [], into: "compare_permits", madeBy: { runId: "mrn-1", step: "s3" }, ...overrides });

  it("keeps each key whose rows differ, counts them all, and stops listing at its cap", async () => {
    const s = setup();
    permits(s);
    wroteBefore(s, MEMORY);
    const { jobId, key } = await started(s, "compare", compareParams(), "compare-1");
    value(await s.store.rowsBegin(RUN, jobId, key, BEGIN));
    // The compare reads the memory of a write by the same key, and changes nothing of it.
    assert.equal(value(await s.store.rowsRead(RUN, jobId, key, { part: "memory", after: null })).rows.length, 3);
    const first = [
      { key: "P03", difference: "differs", columns: ["status"], store: ["P03", "Final", "30.00"], database: ["P03", "Issued", "30.00"] },
      { key: "P09", difference: "store_only", store: ["P09", "Issued", "90.00"] },
      { key: "P11", difference: "database_only", database: ["P11", "Issued", "110.00"] },
    ];
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: first }));
    assert.equal(sql(s, "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'compare_permits__key%'")[0]!.n, 0, "a compare's rows are only ever added: no index");
    // Past COMPARE_ROWS_MAX a difference is counted, not kept.
    let page = 1;
    const filler = COMPARE_ROWS_MAX - first.length + 5;
    for (let from = 0; from < filler; from += 2_000) {
      const rows = Array.from({ length: Math.min(2_000, filler - from) }, (_, i) => ({ key: `X${String(from + i).padStart(6, "0")}`, difference: "store_only", store: [`X${from + i}`, "Issued", "1.00"] }));
      value(await s.store.rowsSend(RUN, jobId, key, { page: ++page, rows }));
    }
    value(await s.store.rowsEnd(RUN, jobId, key, { read: 100_000, targetRows: 9, same: 4, otherRows: 3 }));
    const job = await finished(s, jobId);
    assert.deepEqual(job.result, {
      table: "compare_permits",
      version: 1,
      rows: COMPARE_ROWS_MAX,
      source: "permits",
      target: "dbo.permits",
      key: ["permit_no"],
      columns: COLUMNS,
      storeRows: 100_000,
      databaseRows: 9,
      matching: 4,
      onlyInStore: 1 + filler,
      onlyInDatabase: 1,
      differing: 1,
      otherRows: 3,
      unlisted: 5,
    } satisfies CompareResult);
    assert.deepEqual(columnsOf(s, "compare_permits"), ["permit_no", "difference", "columns", "status_store", "status_database", "fee_store", "fee_database", "_key"]);
    assert.deepEqual(sql(s, "SELECT * FROM compare_permits WHERE _key IN ('P03', 'P09', 'P11') ORDER BY _key"), [
      { _key: "P03", permit_no: "P03", difference: "Differs", columns: "status", status_store: "Final", status_database: "Issued", fee_store: "30.00", fee_database: "30.00" },
      { _key: "P09", permit_no: "P09", difference: "Only in the store", columns: null, status_store: "Issued", status_database: null, fee_store: "90.00", fee_database: null },
      { _key: "P11", permit_no: "P11", difference: "Only in Maple Ridge permits", columns: null, status_store: null, status_database: "Issued", fee_store: null, fee_database: "110.00" },
    ]);
    assert.equal(sql(s, "SELECT grp FROM _tables WHERE name = 'compare_permits'")[0]!.grp, COMPARED_GROUP);
    assert.deepEqual(memory(s), MEMORY.map((m) => [...m, 1]), "a compare never changes the memory");
    // One row written for each difference kept, and the table's own records.
    assert.ok(job.rowsWritten! >= COMPARE_ROWS_MAX && job.rowsWritten! < COMPARE_ROWS_MAX + records(8), `wrote ${job.rowsWritten}`);
  });

  it("reads no memory of a write by another key, and never refuses a required column it lacks", async () => {
    const s = setup();
    permits(s);
    wroteBefore(s, MEMORY);
    const { jobId, key } = await started(s, "compare", compareParams({ key: ["status", "fee"] }), "other-key");
    const columns = [...DB_COLUMNS, { name: "issued_on", type: "date", required: true }];
    const begin = value(await s.store.rowsBegin(RUN, jobId, key, { columns, primaryKey: ["permit_no"] }));
    assert.deepEqual([begin.key, begin.missing], [["status", "fee"], ["issued_on"]]);
    assert.deepEqual(value(await s.store.rowsRead(RUN, jobId, key, { part: "memory", after: null })), { rows: [], next: null });
    assert.deepEqual(record(s)!.key, ["permit_no"], "nor the record");
  });
});

describe("a DB IO job's key for a write", () => {
  it("is refused once a newer one is made, and opens only its own job", async () => {
    const s = setup();
    permits(s);
    const job = value(await s.store.jobSubmit(RUN, { kind: "push_preview", params: previewParams(), requestKey: "keys" })).job;
    const a = value(await s.store.jobKey(RUN, job.id, { key: newKey() })).key;
    assert.equal(value(await s.store.rowsState(RUN, job.id, a)).state, "waiting");
    const b = value(await s.store.jobKey(RUN, job.id, { key: newKey() })).key;
    assert.equal(refusal(await s.store.rowsState(RUN, job.id, a)).code, "job_key_refused");
    assert.equal(value(await s.store.rowsState(RUN, job.id, b)).state, "waiting");
    assert.equal(refusal(await s.store.rowsBegin(RUN, job.id, b, BEGIN)).code, "job_not_taking", "nothing is taken before the store starts the job");
    assert.equal(refusal(await s.store.pullState(RUN, job.id, b)).code, "bad_request", "a preview takes no pull's calls");
  });

  it("refuses parameters a preview, a write or a compare does not take", async () => {
    const s = setup();
    for (const [kind, params] of [
      ["push_preview", previewParams({ into: "Bad Name" })],
      ["push_preview", previewParams({ writer: "someone" })],
      ["push", { connection: CONNECTION, preview: { table: PREVIEW, version: 0 }, writer: WRITER }],
      ["compare", { connection: CONNECTION, source: "permits", target: { schema: "dbo" }, into: "compare_permits" }],
    ] as const) {
      assert.equal(refusal(await s.store.jobSubmit(RUN, { kind, params, requestKey: `bad-${kind}-${JSON.stringify(params).length}` })).code, "bad_request");
    }
  });
});

// ─── links, rehearsals, several tables in one write, and undo ─────────────────────────────────
// On made-up tables of a town's database: town.permits, town.submissions, town.properties.

const TOWN = { id: "dbc_9", name: "Town permits", engine: "postgres" };
const PERMITS = { schema: "town", name: "permits" };
const SUBMISSIONS = { schema: "town", name: "submissions" };
const PERMITS_ID = pushTargetId(TOWN.id, PERMITS);
const SUBMISSIONS_ID = pushTargetId(TOWN.id, SUBMISSIONS);

/** A database table's memory: each key's hash sent, hash held, and 1 when this store put the row there. */
const memoryIn = (s: Setup, target: string) => sql(s, "SELECT k, sent, held, put FROM _pushed WHERE target = ? ORDER BY k", target).map((r) => [r.k, r.sent, r.held, r.put]);

/** A JSON record of the store's `_meta`, or null. */
function meta<T>(s: Setup, key: string): T | null {
  const row = sql(s, "SELECT value FROM _meta WHERE key = ?", key)[0];
  return row ? (JSON.parse(String(row.value)) as T) : null;
}

/** A job's rows of the record of writes: its part, the key, what it did there, the columns set and the row before (JSON), the memory before, and its state. */
const recorded = (s: Setup, job: string) => sql(s, "SELECT part, k, did, set_cols, before, mem, state FROM _push_writes WHERE job = ? ORDER BY part, k", job);

/** The doc's three permits, as the store holds them: 0101 the town has not, 0102 Closed where the town has Issued, 0103 one the town edits after the preview. */
function threePermits(s: Setup) {
  s.storage.sql.exec(`CREATE TABLE permits ("_key" TEXT, "_hash" TEXT, permit_no TEXT, status TEXT, fee TEXT)`);
  for (const [no, status, fee] of [
    ["BP-2026-0101", "Issued", "10.00"],
    ["BP-2026-0102", "Closed", "20.00"],
    ["BP-2026-0103", "Final", "30.00"],
  ]) {
    s.storage.sql.exec("INSERT INTO permits VALUES (?, ?, ?, ?, ?)", no, h(1), no, status, fee);
  }
}

/** What an earlier write into town.permits left: 0102 changed by it, 0103 put there by it. */
const TOWN_MEMORY: [string, string, string, number][] = [
  ["BP-2026-0102", h(0x20), h(0x21), 0],
  ["BP-2026-0103", h(0x30), h(0x31), 1],
];

function townWroteBefore(s: Setup, writers: Record<string, string> = {}) {
  s.storage.sql.exec("INSERT INTO _meta (key, value) VALUES (?, ?)", pushRecordKey(TOWN.id, PERMITS), JSON.stringify({ key: ["permit_no"], columns: COLUMNS, writers, last: null } satisfies PushRecord));
  for (const [k, sent, held, put] of TOWN_MEMORY) s.storage.sql.exec("INSERT INTO _pushed (target, k, sent, held, at, put) VALUES (?, ?, ?, ?, '2026-11-01T00:00:00.000Z', ?)", PERMITS_ID, k, sent, held, put);
}

/** What the preview finds: 0101 new, 0102 changed from Issued to Closed, 0103 changed (the town edits it only after the preview). */
const THREE_FOUND = [
  { key: "BP-2026-0101", action: "new", will: h(0x11), after: ["BP-2026-0101", "Issued", "10.00"] },
  { key: "BP-2026-0102", action: "changed", now: h(0x21), will: h(0x22), changed: ["status"], before: ["BP-2026-0102", "Issued", "20.00"], after: ["BP-2026-0102", "Closed", "20.00"] },
  { key: "BP-2026-0103", action: "changed", now: h(0x31), will: h(0x32), changed: ["status"], before: ["BP-2026-0103", "Issued", "30.00"], after: ["BP-2026-0103", "Final", "30.00"] },
];

/** The write's batch: 0101 inserted, 0102's status updated, 0103 held, since the town edited it after the preview. */
const THREE_WRITTEN = [
  { key: "BP-2026-0101", outcome: "written", sent: h(0x11), held: h(0x12), did: "inserted" },
  { key: "BP-2026-0102", outcome: "written", sent: h(0x22), held: h(0x23), did: "updated", set: ["status"], before: ["BP-2026-0102", "Issued", "20.00"] },
  { key: "BP-2026-0103", outcome: "held", why: "since_preview" },
];

const townPreviewParams = (overrides: Record<string, unknown> = {}) => ({ connection: TOWN, source: "permits", target: PERMITS, key: [], into: PREVIEW, theirEdits: "hold", writer: WRITER, madeBy: { runId: "mrn-1", step: "s1" }, ...overrides });

/** A preview of a store's table into a town's table, its DB IO job driven to its end. */
async function townPreview(s: Setup, p: { overrides?: Record<string, unknown>; columns?: typeof DB_COLUMNS; rows: unknown[]; end?: Record<string, unknown>; requestKey: string }) {
  const { jobId, key } = await started(s, "push_preview", townPreviewParams(p.overrides), p.requestKey);
  const columns = p.columns ?? DB_COLUMNS;
  value(await s.store.rowsBegin(RUN, jobId, key, { columns, primaryKey: [columns[0]!.name] }));
  value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: p.rows }));
  value(await s.store.rowsEnd(RUN, jobId, key, p.end ?? { read: p.rows.length, targetRows: 2, same: 0 }));
  return (await finished(s, jobId)).result as PushPreviewResult;
}

const writeParams = (overrides: Record<string, unknown> = {}) => ({ connection: TOWN, preview: { table: PREVIEW, version: 1 }, writer: WRITER, madeBy: { runId: "mrn-1", step: "s2" }, ...overrides });
const undoParams = (write: string, overrides: Record<string, unknown> = {}) => ({ connection: TOWN, write, writer: WRITER, madeBy: { runId: "mrn-1", step: "s3" }, ...overrides });

/** The doc's example written for real, a batch at a time, into a table whose record already names these writers. */
async function wroteThree(s: Setup, writers: Record<string, string> = {}) {
  threePermits(s);
  townWroteBefore(s, writers);
  await townPreview(s, { rows: THREE_FOUND, requestKey: "preview-three" });
  const { jobId, key } = await started(s, "push", writeParams(), "write-three");
  value(await s.store.rowsSend(RUN, jobId, key, { page: 1, last: "BP-2026-0103", rows: THREE_WRITTEN }));
  value(await s.store.rowsEnd(RUN, jobId, key, { batches: 1 }));
  return { write: jobId, result: (await finished(s, jobId)).result as PushResult };
}

describe("a record of who wrote into a database's table, in a store", () => {
  const A_PERSON = "user:u-7";
  const writersOf = (s: Setup) => meta<PushRecord>(s, pushRecordKey(TOWN.id, PERMITS))!.writers;
  /** Whether a preview by this writer says its write is the writer's first into the table. */
  const firstFor = async (s: Setup, writer: string, requestKey: string) => {
    const { jobId, key } = await started(s, "push_preview", townPreviewParams({ writer }), requestKey);
    value(await s.store.rowsBegin(RUN, jobId, key, { columns: DB_COLUMNS, primaryKey: [DB_COLUMNS[0]!.name] }));
    value(await s.store.rowsEnd(RUN, jobId, key, { read: 3, targetRows: 3, same: 3 }));
    return ((await finished(s, jobId)).result as PushPreviewResult).first;
  };

  it("keeps when a writer first wrote, and the writers before it, when it writes again", async () => {
    const s = setup();
    const before = { [WRITER]: "2026-11-01T00:00:00.000Z", [A_PERSON]: "2026-11-02T00:00:00.000Z" };
    await wroteThree(s, before);
    assert.deepEqual(writersOf(s), before);
  });

  it("notes a writer's first write beside the writers before it, and asks only a writer the record does not name", async () => {
    const s = setup();
    await wroteThree(s, { [A_PERSON]: "2026-11-02T00:00:00.000Z" });
    const rec = meta<PushRecord>(s, pushRecordKey(TOWN.id, PERMITS))!;
    assert.deepEqual(rec.writers, { [A_PERSON]: "2026-11-02T00:00:00.000Z", [WRITER]: rec.last!.at });
    assert.equal(await firstFor(s, WRITER, "preview-by-the-program"), false);
    assert.equal(await firstFor(s, A_PERSON, "preview-by-the-person"), false);
    assert.equal(await firstFor(s, "user:u-8", "preview-by-another-person"), true);
  });
});

describe("an undo of a write, in a store", () => {
  it("takes back the doc's write alone: 0101 removed, 0102 put back, 0103 never touched, the memory as before it", async () => {
    const s = setup();
    const { write, result } = await wroteThree(s);
    const heldTable = { table: "push_held_permits", version: 1, rows: 1 };
    assert.deepEqual(result, {
      write,
      rehearsed: false,
      restored: null,
      manifest: [],
      parts: [{ preview: { table: PREVIEW, version: 1 }, target: "town.permits", inserted: 1, updated: 1, deleted: 0, held: 1, heldTable, kept: 0, keptColumns: [], keptTable: null }],
      preview: { table: PREVIEW, version: 1 },
      target: "town.permits",
      inserted: 1,
      updated: 1,
      deleted: 0,
      held: 1,
      heldSince: 1,
      batches: 1,
      heldTable,
      kept: 0,
      keptTable: null,
    } satisfies PushResult);
    const afterWrite = [
      ["BP-2026-0101", h(0x11), h(0x12), 1],
      ["BP-2026-0102", h(0x22), h(0x23), 0],
      ["BP-2026-0103", h(0x30), h(0x31), 1],
    ];
    assert.deepEqual(memoryIn(s, PERMITS_ID), afterWrite);
    // Each row the write wrote, with what it did and the memory's entry before it: 0103 it held, so it never wrote it.
    assert.deepEqual(recorded(s, write), [
      { part: 0, k: "BP-2026-0101", did: "inserted", set_cols: null, before: null, mem: null, state: "done" },
      { part: 0, k: "BP-2026-0102", did: "updated", set_cols: '["status"]', before: '["BP-2026-0102","Issued","20.00"]', mem: JSON.stringify([h(0x20), h(0x21), 0]), state: "done" },
    ]);
    assert.deepEqual(
      { ...meta<PushWriteRecord>(s, pushWriteKey(write))!, at: "" },
      { connection: TOWN, parts: [{ preview: { table: PREVIEW, version: 1 }, target: PERMITS, key: ["permit_no"], columns: COLUMNS, inserted: 1, updated: 1, deleted: 0, held: 1 }], at: "", by: "run:mrn-1", rehearse: false, ended: true, undone: null } satisfies PushWriteRecord,
    );

    const undo = await started(s, "push_undo", undoParams(write), "undo-1");
    const state = value(await s.store.rowsState(RUN, undo.jobId, undo.key));
    assert.deepEqual(
      [state.kind, state.state, state.oneTransaction, state.rehearse, state.begun, state.page, state.target, state.parts],
      ["push_undo", "taking", true, false, false, 0, PERMITS, [{ target: PERMITS, key: ["permit_no"], columns: COLUMNS }]],
    );
    assert.equal(refusal(await s.store.rowsRead(RUN, undo.jobId, undo.key, { part: "undo", after: null })).code, "rows_not_begun", "each DB IO job begins it again first");
    assert.deepEqual(value(await s.store.rowsBegin(RUN, undo.jobId, undo.key, { again: true })), { columns: [], key: [], missing: [], rows: 2 });
    assert.deepEqual(value(await s.store.rowsRead(RUN, undo.jobId, undo.key, { part: "undo", after: null })), {
      rows: [
        { key: "BP-2026-0101", did: "inserted", held: h(0x12), set: null, before: null, whole: null },
        { key: "BP-2026-0102", did: "updated", held: h(0x23), set: ["status"], before: ["BP-2026-0102", "Issued", "20.00"], whole: null },
      ],
      next: null,
    });
    // An undo reads the rows its write removed apart from those it inserted or updated: it puts a
    // parent's removed rows back before a child's, and takes a child's new rows before a parent's.
    assert.deepEqual(value(await s.store.rowsRead(RUN, undo.jobId, undo.key, { part: "undo", after: null, only: "removals" })).rows, []);
    assert.deepEqual((value(await s.store.rowsRead(RUN, undo.jobId, undo.key, { part: "undo", after: null, only: "puts" })).rows as { key: string }[]).map((r) => r.key), ["BP-2026-0101", "BP-2026-0102"]);
    value(await s.store.rowsSend(RUN, undo.jobId, undo.key, { page: 1, last: "BP-2026-0102", rows: [{ key: "BP-2026-0101", outcome: "undone" }, { key: "BP-2026-0102", outcome: "undone" }] }));
    assert.deepEqual(memoryIn(s, PERMITS_ID), afterWrite, "nothing applies before its database commits");
    assert.equal(refusal(await s.store.rowsEnd(RUN, undo.jobId, undo.key, { batches: 1 })).code, "bad_request", "its end says its database committed");
    assert.deepEqual(value(await s.store.rowsEnd(RUN, undo.jobId, undo.key, { committed: true, batches: 1 })), { finishing: true });
    const undone = await finished(s, undo.jobId);
    assert.deepEqual(undone.result, {
      write,
      target: "town.permits",
      removed: 1,
      putBack: 1,
      reinserted: 0,
      held: 0,
      heldTable: null,
      parts: [{ target: "town.permits", removed: 1, putBack: 1, reinserted: 0, held: 0, heldTable: null }],
    } satisfies PushUndoResult);
    // The memory is what it was before the write: 0101 forgotten, 0102's entry back, 0103's never touched.
    assert.deepEqual(memoryIn(s, PERMITS_ID), TOWN_MEMORY);
    assert.deepEqual(recorded(s, write).map((r) => [r.k, r.state]), [["BP-2026-0101", "undone"], ["BP-2026-0102", "undone"]]);
    assert.ok(meta<PushWriteRecord>(s, pushWriteKey(write))!.undone, "the write is marked undone");
    // A write is undone once.
    const again = value(await s.store.jobSubmit(RUN, { kind: "push_undo", params: undoParams(write), requestKey: "undo-2" })).job;
    await s.store.alarm();
    const twice = await jobOf(s, again.id);
    assert.deepEqual([twice.state, twice.error], ["failed", `Write ${write} was undone already.`]);
  });

  it("lists why it held each row: changed there, other columns it cannot put back, or a value too long to have been kept", async () => {
    const s = setup();
    const { write } = await wroteThree(s);
    const { jobId, key } = await started(s, "push_undo", undoParams(write), "undo-why");
    value(await s.store.rowsBegin(RUN, jobId, key, { again: true }));
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: [{ key: "BP-2026-0101", outcome: "held", why: "columns" }, { key: "BP-2026-0102", outcome: "held", why: "too_long" }] }));
    value(await s.store.rowsEnd(RUN, jobId, key, { committed: true, batches: 1 }));
    await finished(s, jobId);
    assert.deepEqual(
      tableRows(s, "undo_held_permits").map((r) => [r._key, r.note]),
      [
        ["BP-2026-0101", "Its other columns held values, or its table needs one the write did not write, so it cannot go back whole: not undone"],
        ["BP-2026-0102", "It holds a value too long to have been kept: not undone"],
      ],
    );
  });

  it("leaves a row changed since the write, lists it in To review, and begins again under a successor", async () => {
    const s = setup();
    const { write } = await wroteThree(s);
    const { jobId, key } = await started(s, "push_undo", undoParams(write), "undo-held");
    value(await s.store.rowsBegin(RUN, jobId, key, { again: true }));
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: [{ key: "BP-2026-0101", outcome: "undone" }] }));
    // That DB IO job stopped before its commit; its successor begins again, and the store forgets what it took.
    const next = value(await s.store.jobKey(RUN, jobId, { key: newKey() })).key;
    assert.equal(refusal(await s.store.rowsSend(RUN, jobId, next, { page: 2, rows: [] })).code, "rows_not_begun");
    value(await s.store.rowsBegin(RUN, jobId, next, { again: true }));
    assert.deepEqual(recorded(s, jobId), [], "the stopped DB IO job's page is forgotten");
    assert.equal(value(await s.store.rowsState(RUN, jobId, next)).page, 0);
    // The town changed 0102 again after the write: the undo leaves it as it is.
    value(await s.store.rowsSend(RUN, jobId, next, { page: 1, rows: [{ key: "BP-2026-0101", outcome: "undone" }, { key: "BP-2026-0102", outcome: "held" }] }));
    const stranger = refusal(await s.store.rowsSend(RUN, jobId, next, { page: 2, rows: [{ key: "BP-2026-0103", outcome: "undone" }] }));
    assert.deepEqual([stranger.code, stranger.error], ["undo_rows", "1 row of this page is not one the write wrote into town.permits: an undo sends only the rows it read."], "0103 is no row of the write, and a refusal names no key");
    value(await s.store.rowsEnd(RUN, jobId, next, { committed: true, batches: 1 }));
    const done = await finished(s, jobId);
    const heldTable = { table: "undo_held_permits", version: 1, rows: 1 };
    assert.deepEqual(done.result, { write, target: "town.permits", removed: 1, putBack: 0, reinserted: 0, held: 1, heldTable, parts: [{ target: "town.permits", removed: 1, putBack: 0, reinserted: 0, held: 1, heldTable }] } satisfies PushUndoResult);
    // 0101's memory goes; 0102's stays what the write left, so the town's edit there is still held at the next write.
    assert.deepEqual(memoryIn(s, PERMITS_ID), [["BP-2026-0102", h(0x22), h(0x23), 0], ["BP-2026-0103", h(0x30), h(0x31), 1]]);
    assert.deepEqual(recorded(s, write).map((r) => [r.k, r.state]), [["BP-2026-0101", "undone"], ["BP-2026-0102", "done"]]);
    assert.deepEqual(columnsOf(s, "undo_held_permits"), ["permit_no", "what_happened", "columns_set", "note", "_key"]);
    assert.deepEqual(tableRows(s, "undo_held_permits"), [{ permit_no: "BP-2026-0102", what_happened: "updated", columns_set: "status", note: "Changed in Town permits since this write: not undone", _key: "BP-2026-0102" }]);
    assert.equal(sql(s, "SELECT grp FROM _tables WHERE name = 'undo_held_permits'")[0]!.grp, HELD_GROUP);
  });

  it("refuses an undo of no write, of a rehearsal, and of another connection's write", async () => {
    const s = setup();
    const { write } = await wroteThree(s);
    // A rehearsal of a newer preview that holds its one row: nothing to write, so it ends at once.
    const held = { key: "BP-2026-0103", action: "held", now: h(0x40), will: h(0x32), why: "changed_there", changed: ["status"], before: ["BP-2026-0103", "Void", "30.00"], after: ["BP-2026-0103", "Final", "30.00"] };
    const preview = await townPreview(s, { rows: [held], requestKey: "preview-held" });
    const rehearsal = value(await s.store.jobSubmit(RUN, { kind: "push", params: writeParams({ preview: { table: PREVIEW, version: preview.version }, rehearse: true }), requestKey: "rehearse-nothing" })).job;
    await s.store.alarm();
    const rehearsed = await jobOf(s, rehearsal.id);
    assert.equal(rehearsed.state, "done", rehearsed.error ?? "");
    assert.deepEqual((rehearsed.result as PushResult).manifest, [{ table: "rehearsal_permits", version: 1, rows: 0 }], "its manifest is made, empty");
    const other = { id: "dbc_8", name: "County permits", engine: "postgres" };
    for (const [params, requestKey, words] of [
      [undoParams("job_nope"), "undo-nothing", "This store has no write job_nope to undo: an undo names a write by the id db_push answered."],
      [undoParams(rehearsal.id), "undo-rehearsal", `Write ${rehearsal.id} was a rehearsal: its database rolled it back, so nothing of it stayed to undo.`],
      [undoParams(write, { connection: other }), "undo-elsewhere", `Write ${write} was into Town permits, not County permits.`],
    ] as const) {
      const job = value(await s.store.jobSubmit(RUN, { kind: "push_undo", params, requestKey })).job;
      await s.store.alarm();
      const ended = await jobOf(s, job.id);
      assert.deepEqual([ended.state, ended.error], ["failed", words]);
    }
    assert.deepEqual(memoryIn(s, PERMITS_ID).map((m) => m[0]), ["BP-2026-0101", "BP-2026-0102", "BP-2026-0103"], "no refused undo touched the memory");
  });
});

describe("a rehearsal of a write, in a store", () => {
  it("keeps nothing of the write but its manifest: the memory, the record of who wrote and the preview are as they were", async () => {
    const s = setup();
    threePermits(s);
    townWroteBefore(s);
    await townPreview(s, { rows: THREE_FOUND, requestKey: "preview-r" });
    const first = await started(s, "push", writeParams({ rehearse: true }), "rehearse-1");
    const state = value(await s.store.rowsState(RUN, first.jobId, first.key));
    assert.deepEqual([state.oneTransaction, state.rehearse, state.parts.length, state.begun], [true, true, 1, false]);
    assert.equal(refusal(await s.store.rowsSend(RUN, first.jobId, first.key, { page: 1, rows: [] })).code, "rows_not_begun");
    assert.deepEqual(value(await s.store.rowsBegin(RUN, first.jobId, first.key, { again: true })), { columns: [], key: [], missing: [], rows: 3 });
    value(await s.store.rowsSend(RUN, first.jobId, first.key, { page: 1, rows: [THREE_WRITTEN[2]] }));
    // That DB IO job stopped: its successor begins the rehearsal again, and its manifest with it.
    const key = value(await s.store.jobKey(RUN, first.jobId, { key: newKey() })).key;
    value(await s.store.rowsBegin(RUN, first.jobId, key, { again: true }));
    assert.deepEqual(tableRows(s, "rehearsal_permits__new"), []);
    assert.deepEqual(value(await s.store.rowsRead(RUN, first.jobId, key, { part: "write", after: null, only: "puts" })).rows.map((r) => (r as { key: string }).key), ["BP-2026-0101", "BP-2026-0102", "BP-2026-0103"]);
    assert.deepEqual(value(await s.store.rowsRead(RUN, first.jobId, key, { part: "write", after: null, only: "removals" })), { rows: [], next: null });
    // Inside its transaction the database took 0101's fee as a number, and its read back shows it so.
    const rows = [{ ...THREE_WRITTEN[0], after: ["BP-2026-0101", "Issued", "10"] }, { ...THREE_WRITTEN[1], after: ["BP-2026-0102", "Closed", "20.00"] }, THREE_WRITTEN[2]];
    value(await s.store.rowsSend(RUN, first.jobId, key, { page: 1, last: "BP-2026-0103", rows }));
    assert.equal(refusal(await s.store.rowsSend(RUN, first.jobId, key, { page: 2, last: "BP-2026-0103", rows: [THREE_WRITTEN[2]] })).code, "rows_twice", "the database writes a row once");
    assert.equal(refusal(await s.store.rowsEnd(RUN, first.jobId, key, { committed: true, batches: 1 })).code, "bad_request", "a rehearsal rolls back");
    assert.deepEqual(value(await s.store.rowsEnd(RUN, first.jobId, key, { rolledBack: true, restored: 2, batches: 1 })), { finishing: true });
    const job = await finished(s, first.jobId);
    const manifest = "rehearsal_permits";
    assert.deepEqual(job.result, {
      write: first.jobId,
      rehearsed: true,
      restored: 2,
      manifest: [{ table: manifest, version: 1, rows: 3 }],
      parts: [{ preview: { table: PREVIEW, version: 1 }, target: "town.permits", inserted: 1, updated: 1, deleted: 0, held: 1, heldTable: null, kept: 0, keptColumns: [], keptTable: null }],
      preview: { table: PREVIEW, version: 1 },
      target: "town.permits",
      inserted: 1,
      updated: 1,
      deleted: 0,
      held: 1,
      heldSince: 1,
      batches: 1,
      heldTable: null,
      kept: 0,
      keptTable: null,
    } satisfies PushResult);
    // One row a key the write touched: what it did, the columns it set, what it sent beside what the database held after.
    assert.deepEqual(columnsOf(s, manifest), ["permit_no", "what_happened", "columns_set", "status_sent", "status_after", "fee_sent", "fee_after", "note", "_key", "_hash", "_after_hash"]);
    assert.deepEqual(tableRows(s, manifest), [
      { permit_no: "BP-2026-0101", what_happened: "inserted", columns_set: null, status_sent: "Issued", status_after: "Issued", fee_sent: "10.00", fee_after: "10", note: null, _key: "BP-2026-0101", _hash: h(0x11), _after_hash: h(0x12) },
      { permit_no: "BP-2026-0102", what_happened: "updated", columns_set: "status", status_sent: "Closed", status_after: "Closed", fee_sent: "20.00", fee_after: "20.00", note: null, _key: "BP-2026-0102", _hash: h(0x22), _after_hash: h(0x23) },
      { permit_no: "BP-2026-0103", what_happened: "held", columns_set: null, status_sent: null, status_after: null, fee_sent: null, fee_after: null, note: "Changed in Town permits after the preview: not written", _key: "BP-2026-0103", _hash: null, _after_hash: null },
    ]);
    assert.equal(sql(s, "SELECT grp FROM _tables WHERE name = ?", manifest)[0]!.grp, REHEARSAL_GROUP);
    const said = Object.fromEntries(sql(s, "SELECT name, original_type, comment FROM _columns WHERE tbl = ?", manifest).map((c) => [c.name, [c.original_type, c.comment]]));
    assert.deepEqual(said.status_sent, ["varchar(20)", '"status" as the write sent it.']);
    // Nothing of it stays: the memory, the record of who wrote, and no row of the record of writes.
    assert.deepEqual(memoryIn(s, PERMITS_ID), TOWN_MEMORY);
    assert.deepEqual(meta<PushRecord>(s, pushRecordKey(TOWN.id, PERMITS)), { key: ["permit_no"], columns: COLUMNS, writers: {}, last: null });
    assert.deepEqual(recorded(s, first.jobId), []);
    const rec = meta<PushWriteRecord>(s, pushWriteKey(first.jobId))!;
    assert.deepEqual([rec.rehearse, rec.parts.map((p) => [p.inserted, p.updated, p.deleted, p.held])], [true, [[0, 0, 0, 0]]]);
    // Its preview is still to write.
    const real = await started(s, "push", writeParams(), "write-after-rehearsal");
    assert.equal(value(await s.store.rowsState(RUN, real.jobId, real.key)).state, "taking");
  });
});

describe("a write of several tables in one transaction, in a store", () => {
  const SUBMISSION_COLUMNS = [
    { name: "submission_id", type: "varchar(20)", required: true },
    { name: "permit_no", type: "varchar(20)", required: true },
    { name: "received", type: "date", required: false },
  ];
  /** A permit and its submission are written whole or not at all: two of each. */
  function townTables(s: Setup) {
    s.storage.sql.exec(`CREATE TABLE submissions ("_key" TEXT, "_hash" TEXT, submission_id TEXT, permit_no TEXT, received TEXT)`);
    s.storage.sql.exec(`INSERT INTO submissions VALUES ('S-1', ?1, 'S-1', 'BP-2026-0201', '2026-11-02'), ('S-2', ?1, 'S-2', 'BP-2026-0202', '2026-11-03')`, h(1));
    s.storage.sql.exec(`CREATE TABLE permits ("_key" TEXT, "_hash" TEXT, permit_no TEXT, status TEXT, fee TEXT)`);
    s.storage.sql.exec(`INSERT INTO permits VALUES ('BP-2026-0201', ?1, 'BP-2026-0201', 'Issued', '50.00'), ('BP-2026-0202', ?1, 'BP-2026-0202', 'Issued', '60.00')`, h(1));
  }
  const SUBMITTED = [
    { key: "S-1", action: "new", will: h(0x51), after: ["S-1", "BP-2026-0201", "2026-11-02"] },
    { key: "S-2", action: "new", will: h(0x52), after: ["S-2", "BP-2026-0202", "2026-11-03"] },
  ];
  const PERMITTED = [
    { key: "BP-2026-0201", action: "new", will: h(0x61), after: ["BP-2026-0201", "Issued", "50.00"] },
    { key: "BP-2026-0202", action: "new", will: h(0x62), after: ["BP-2026-0202", "Issued", "60.00"] },
  ];
  const writtenOf = (rows: readonly { key: string; will: string }[]) => rows.map((r) => ({ key: r.key, outcome: "written", sent: r.will, held: r.will, did: "inserted" }));
  const severalParams = () => writeParams({ preview: { table: "push_preview_submissions", version: 1 }, also: [{ table: PREVIEW, version: 1 }] });

  async function previewedBoth(s: Setup, submitted: unknown[] = SUBMITTED, permitted: unknown[] = PERMITTED) {
    townTables(s);
    await townPreview(s, { overrides: { source: "submissions", target: SUBMISSIONS, into: "push_preview_submissions" }, columns: SUBMISSION_COLUMNS, rows: submitted, requestKey: "preview-s" });
    await townPreview(s, { rows: permitted, requestKey: "preview-p" });
  }

  it("keeps the link its previews counted between its tables, hands it to its undo's DB IO job, and lists a row held with its partner", async () => {
    const s = setup();
    townTables(s);
    // A submission names its permit: the submissions' preview counts that link.
    const link = { column: "permit_no", to: { schema: "town", name: "permits", column: "permit_no" } };
    await townPreview(s, {
      overrides: { source: "submissions", target: SUBMISSIONS, into: "push_preview_submissions", links: [link] },
      columns: SUBMISSION_COLUMNS,
      rows: SUBMITTED,
      end: { read: 2, targetRows: 2, same: 0, links: [{ column: "permit_no", to: "town.permits.permit_no", linked: 0, unlinked: 2, empty: 0 }] },
      requestKey: "preview-s",
    });
    await townPreview(s, { rows: PERMITTED, requestKey: "preview-p" });
    const write = await started(s, "push", severalParams(), "linked-write");
    value(await s.store.rowsBegin(RUN, write.jobId, write.key, { again: true }));
    value(await s.store.rowsSend(RUN, write.jobId, write.key, { page: 1, last: "S-2", rows: writtenOf(SUBMITTED) }));
    value(await s.store.rowsSend(RUN, write.jobId, write.key, { page: 2, last: "BP-2026-0202", table: 1, rows: writtenOf(PERMITTED) }));
    value(await s.store.rowsEnd(RUN, write.jobId, write.key, { committed: true, batches: 2 }));
    await finished(s, write.jobId);
    assert.deepEqual(meta<PushWriteRecord>(s, pushWriteKey(write.jobId))!.parts.map((p) => p.links ?? null), [[link], null], "the write keeps the link between its tables");
    const undo = await started(s, "push_undo", undoParams(write.jobId), "linked-undo");
    assert.deepEqual(value(await s.store.rowsState(RUN, undo.jobId, undo.key)).parts.map((p) => p.links ?? null), [[link], null], "its undo hands it to its DB IO job");
    value(await s.store.rowsBegin(RUN, undo.jobId, undo.key, { again: true }));
    // The DB IO job held S-1, changed there, and its permit with it.
    value(await s.store.rowsSend(RUN, undo.jobId, undo.key, { page: 1, rows: [{ key: "S-1", outcome: "held", why: "changed" }, { key: "S-2", outcome: "undone" }] }));
    value(await s.store.rowsSend(RUN, undo.jobId, undo.key, { page: 2, table: 1, rows: [{ key: "BP-2026-0201", outcome: "held", why: "together" }, { key: "BP-2026-0202", outcome: "undone" }] }));
    value(await s.store.rowsEnd(RUN, undo.jobId, undo.key, { committed: true, batches: 2 }));
    const result = (await finished(s, undo.jobId)).result as PushUndoResult;
    assert.deepEqual(result.parts.map((p) => [p.target, p.held, p.removed]), [["town.submissions", 1, 1], ["town.permits", 1, 1]]);
    const held = result.parts[1]!.heldTable!.table;
    assert.deepEqual(
      sql(s, `SELECT permit_no, note FROM ${held}`),
      [{ permit_no: "BP-2026-0201", note: "Written together with a row this undo kept, and joined to it by a link: not undone" }],
    );
  });

  it("keeps each page pending until the committed end, forgets them at a successor's begin, and then takes both tables", async () => {
    const s = setup();
    await previewedBoth(s);
    const { jobId, key } = await started(s, "push", severalParams(), "several-1");
    const state = value(await s.store.rowsState(RUN, jobId, key));
    assert.deepEqual(
      [state.oneTransaction, state.rehearse, state.target, state.parts],
      [true, false, SUBMISSIONS, [{ target: SUBMISSIONS, key: ["submission_id"], columns: ["submission_id", "permit_no", "received"] }, { target: PERMITS, key: ["permit_no"], columns: COLUMNS }]],
    );
    assert.equal(value(await s.store.rowsBegin(RUN, jobId, key, { again: true })).rows, 4);
    assert.deepEqual(value(await s.store.rowsRead(RUN, jobId, key, { part: "write", after: null, table: 1, only: "puts" })).rows.map((r) => (r as { key: string }).key), ["BP-2026-0201", "BP-2026-0202"]);
    assert.equal(refusal(await s.store.rowsRead(RUN, jobId, key, { part: "write", after: null, table: 2 })).code, "bad_request", "it writes two tables");
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, last: "S-2", rows: writtenOf(SUBMITTED) }));
    value(await s.store.rowsSend(RUN, jobId, key, { page: 2, last: "BP-2026-0202", table: 1, rows: writtenOf(PERMITTED) }));
    // Pending: nothing applies before its database commits.
    assert.deepEqual([memoryIn(s, SUBMISSIONS_ID), memoryIn(s, PERMITS_ID)], [[], []]);
    assert.deepEqual(recorded(s, jobId).map((r) => [r.part, r.k, r.state]), [[0, "S-1", "pending"], [0, "S-2", "pending"], [1, "BP-2026-0201", "pending"], [1, "BP-2026-0202", "pending"]]);
    // Its DB IO job stopped before its commit: the successor begins again, and the store forgets what it took.
    const next = value(await s.store.jobKey(RUN, jobId, { key: newKey() })).key;
    assert.equal(refusal(await s.store.rowsSend(RUN, jobId, next, { page: 3, rows: [] })).code, "rows_not_begun");
    value(await s.store.rowsBegin(RUN, jobId, next, { again: true }));
    assert.deepEqual(recorded(s, jobId), []);
    assert.deepEqual(value(await s.store.rowsSend(RUN, jobId, next, { page: 1, last: "S-2", rows: writtenOf(SUBMITTED) })), { page: 1, taken: true });
    value(await s.store.rowsSend(RUN, jobId, next, { page: 2, last: "BP-2026-0202", table: 1, rows: writtenOf(PERMITTED) }));
    assert.equal(refusal(await s.store.rowsSend(RUN, jobId, next, { page: 3, table: 1, rows: writtenOf(PERMITTED.slice(0, 1)) })).code, "rows_twice", "one transaction writes a row once");
    // Past the day's write limit a pending page is refused: its database has not committed it. Its committed end is taken.
    pastTheLimit(s);
    assert.equal(refusal(await s.store.rowsSend(RUN, jobId, next, { page: 3, rows: [] })).code, "write_limit_reached");
    assert.equal(refusal(await s.store.rowsEnd(RUN, jobId, next, { batches: 2 })).code, "bad_request", "its end says its database committed");
    value(await s.store.rowsEnd(RUN, jobId, next, { committed: true, batches: 2 }));
    const job = await finished(s, jobId);
    const part = (preview: string, target: string) => ({ preview: { table: preview, version: 1 }, target, inserted: 2, updated: 0, deleted: 0, held: 0, heldTable: null, kept: 0, keptColumns: [], keptTable: null });
    assert.deepEqual(job.result, {
      write: jobId,
      rehearsed: false,
      restored: null,
      manifest: [],
      parts: [part("push_preview_submissions", "town.submissions"), part(PREVIEW, "town.permits")],
      preview: { table: "push_preview_submissions", version: 1 },
      target: "town.submissions",
      inserted: 4,
      updated: 0,
      deleted: 0,
      held: 0,
      heldSince: 0,
      batches: 2,
      heldTable: null,
      kept: 0,
      keptTable: null,
    } satisfies PushResult);
    assert.deepEqual(memoryIn(s, SUBMISSIONS_ID), [["S-1", h(0x51), h(0x51), 1], ["S-2", h(0x52), h(0x52), 1]]);
    assert.deepEqual(memoryIn(s, PERMITS_ID), [["BP-2026-0201", h(0x61), h(0x61), 1], ["BP-2026-0202", h(0x62), h(0x62), 1]]);
    assert.deepEqual([...new Set(recorded(s, jobId).map((r) => r.state))], ["done"]);
    // Each table's record names its own preview as its last write, and who wrote.
    for (const [target, preview] of [[SUBMISSIONS, "push_preview_submissions"], [PERMITS, PREVIEW]] as const) {
      const rec = meta<PushRecord>(s, pushRecordKey(TOWN.id, target))!;
      assert.deepEqual([Object.keys(rec.writers), rec.last?.preview, rec.last?.inserted], [[WRITER], { table: preview, version: 1 }, 2]);
    }
    assert.deepEqual(meta<PushWriteRecord>(s, pushWriteKey(jobId))!.parts.map((p) => [p.target, p.inserted]), [[SUBMISSIONS, 2], [PERMITS, 2]]);
  });

  it("takes what its database committed even when its run is stopped before the store took it", async () => {
    const s = setup();
    await previewedBoth(s);
    const { jobId, key } = await started(s, "push", severalParams(), "several-stopped");
    value(await s.store.rowsBegin(RUN, jobId, key, { again: true }));
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: writtenOf(SUBMITTED) }));
    value(await s.store.rowsSend(RUN, jobId, key, { page: 2, table: 1, rows: writtenOf(PERMITTED) }));
    value(await s.store.rowsEnd(RUN, jobId, key, { committed: true, batches: 2 }));
    value(await s.store.jobsStop(RUN, { runId: "mrn-1", why: "Stopped by a person." }));
    await s.store.alarm();
    const ended = await jobOf(s, jobId);
    assert.deepEqual([ended.state, ended.error], ["failed", "Stopped by a person."]);
    assert.equal(memoryIn(s, SUBMISSIONS_ID).length + memoryIn(s, PERMITS_ID).length, 4, "the memory of what the database holds");
    assert.deepEqual([...new Set(recorded(s, jobId).map((r) => r.state))], ["done"]);
    assert.deepEqual(meta<PushWriteRecord>(s, pushWriteKey(jobId))!.parts.map((p) => p.inserted), [2, 2], "an undo can take it back");
  });

  it("ends at once when no preview has rows to write, each table's held rows listed and its record kept", async () => {
    const s = setup();
    const held = { key: "S-1", action: "held", now: h(0x50), will: h(0x51), why: "changed_there", changed: ["received"], before: ["S-1", "BP-2026-0201", "2026-11-01"], after: ["S-1", "BP-2026-0201", "2026-11-02"] };
    await previewedBoth(s, [held], []);
    const job = value(await s.store.jobSubmit(RUN, { kind: "push", params: severalParams(), requestKey: "several-nothing" })).job;
    await s.store.alarm();
    const done = await jobOf(s, job.id);
    assert.equal(done.state, "done", done.error ?? "");
    const result = done.result as PushResult;
    const listed = { table: "push_held_submissions", version: 1, rows: 1 };
    assert.deepEqual(result.parts.map((p) => [p.target, p.held, p.heldTable]), [["town.submissions", 1, listed], ["town.permits", 0, null]]);
    assert.deepEqual([result.heldTable, result.batches], [listed, 0]);
    // Each table's last write is its own preview's; nobody was asked, so no writer is noted.
    for (const [target, preview] of [[SUBMISSIONS, "push_preview_submissions"], [PERMITS, PREVIEW]] as const) {
      const rec = meta<PushRecord>(s, pushRecordKey(TOWN.id, target))!;
      assert.deepEqual([rec.writers, rec.last?.preview], [{}, { table: preview, version: 1 }]);
    }
  });

  it("refuses a write that names one database table twice", async () => {
    const s = setup();
    townTables(s);
    await townPreview(s, { rows: PERMITTED, requestKey: "preview-a" });
    await townPreview(s, { overrides: { target: { schema: "TOWN", name: "Permits" }, into: "push_preview_permits_again" }, rows: PERMITTED, requestKey: "preview-b" });
    const job = value(await s.store.jobSubmit(RUN, { kind: "push", params: writeParams({ also: [{ table: "push_preview_permits_again", version: 1 }] }), requestKey: "twice" })).job;
    await s.store.alarm();
    const ended = await jobOf(s, job.id);
    assert.deepEqual([ended.state, ended.error], ["failed", "push_preview_permits and push_preview_permits_again both write into TOWN.Permits: a write writes each table once."]);
  });
});

describe("a preview's links, in a store", () => {
  const LINKED_COLUMNS = [...DB_COLUMNS.slice(0, 2), { name: "parcel_id", type: "varchar(20)", required: false }, { name: "inspector", type: "varchar(20)", required: false }];
  const LINKS = [
    { column: "Parcel_ID", to: { schema: "town", name: "properties", column: "parcel_id" } },
    { column: "inspector", to: { schema: "town", name: "inspectors", column: "badge" } },
  ];

  it("counts the links a write cannot make, and words each row's note by the link's table and columns, never a value", async () => {
    const s = setup();
    s.storage.sql.exec(`CREATE TABLE permits ("_key" TEXT, "_hash" TEXT, permit_no TEXT, status TEXT, parcel_id TEXT, inspector TEXT)`);
    s.storage.sql.exec("INSERT INTO permits VALUES ('BP-2026-0301', ?1, 'BP-2026-0301', 'Issued', 'P-77', 'B-1'), ('BP-2026-0302', ?1, 'BP-2026-0302', 'Final', 'P-12', 'B-9'), ('BP-2026-0303', ?1, 'BP-2026-0303', 'Issued', 'P-12', NULL)", h(1));
    const { jobId, key } = await started(s, "push_preview", townPreviewParams({ links: LINKS }), "links");
    assert.deepEqual(value(await s.store.rowsState(RUN, jobId, key)).links, LINKS, "as asked, until it begins");
    value(await s.store.rowsBegin(RUN, jobId, key, { columns: LINKED_COLUMNS, primaryKey: ["permit_no"] }));
    assert.deepEqual(value(await s.store.rowsState(RUN, jobId, key)).links.map((l) => l.column), ["parcel_id", "inspector"], "each column as the database's table spells it");
    value(
      await s.store.rowsSend(RUN, jobId, key, {
        page: 1,
        rows: [
          { key: "BP-2026-0301", action: "new", will: h(0x71), after: ["BP-2026-0301", "Issued", "P-77", "B-1"], unlinked: ["parcel_id"] },
          { key: "BP-2026-0302", action: "changed", now: h(0x72), will: h(0x73), changed: ["status"], before: ["BP-2026-0302", "Issued", "P-12", "B-9"], after: ["BP-2026-0302", "Final", "P-12", "B-9"], unlinked: ["parcel_id", "inspector"] },
          { key: "BP-2026-0303", action: "new", will: h(0x74), after: ["BP-2026-0303", "Issued", "P-12", null], unlinked: null },
        ],
      }),
    );
    const counts = [
      { column: "parcel_id", to: "town.properties.parcel_id", linked: 1, unlinked: 2, empty: 0 },
      { column: "inspector", to: "town.inspectors.badge", linked: 1, unlinked: 1, empty: 1 },
    ];
    value(await s.store.rowsEnd(RUN, jobId, key, { read: 3, targetRows: 1, same: 0, links: counts }));
    const job = await finished(s, jobId);
    assert.deepEqual((job.result as PushPreviewResult).links, counts);
    assert.deepEqual(meta<SavedPreview>(s, previewKey(PREVIEW))!.links, counts, "kept with the preview");
    assert.deepEqual(
      tableRows(s, PREVIEW).map((r) => [r._key, r.note]),
      [
        ["BP-2026-0301", "No row of town.properties has its parcel_id"],
        ["BP-2026-0302", "Changes status; no row of town.properties has its parcel_id; no row of town.inspectors has its inspector as badge"],
        ["BP-2026-0303", null],
      ],
    );
  });

  it("counts apart a link to a row the store's newest preview of the linked table adds, and leaves it out of the row's note", async () => {
    const s = setup();
    // The parcels this store would add: P-77 is new in its preview of town.properties.
    s.storage.sql.exec(`CREATE TABLE properties ("_key" TEXT, "_hash" TEXT, parcel_id TEXT, address TEXT)`);
    s.storage.sql.exec("INSERT INTO properties VALUES ('P-77', ?1, 'P-77', '12 Elm St')", h(1));
    await townPreview(s, {
      overrides: { source: "properties", target: { schema: "town", name: "properties" }, into: "push_preview_properties" },
      columns: [
        { name: "parcel_id", type: "varchar(20)", required: true },
        { name: "address", type: "varchar(80)", required: false },
      ],
      rows: [{ key: "P-77", action: "new", will: h(0x81), after: ["P-77", "12 Elm St"] }],
      requestKey: "preview-parcels",
    });
    s.storage.sql.exec(`CREATE TABLE permits ("_key" TEXT, "_hash" TEXT, permit_no TEXT, status TEXT, parcel_id TEXT, inspector TEXT)`);
    s.storage.sql.exec("INSERT INTO permits VALUES ('BP-2026-0301', ?1, 'BP-2026-0301', 'Issued', 'P-77', 'B-1'), ('BP-2026-0302', ?1, 'BP-2026-0302', 'Final', 'P-12', 'B-9'), ('BP-2026-0303', ?1, 'BP-2026-0303', 'Issued', 'P-12', NULL)", h(1));
    const { jobId, key } = await started(s, "push_preview", townPreviewParams({ links: LINKS }), "links-added");
    value(await s.store.rowsBegin(RUN, jobId, key, { columns: LINKED_COLUMNS, primaryKey: ["permit_no"] }));
    value(
      await s.store.rowsSend(RUN, jobId, key, {
        page: 1,
        rows: [
          { key: "BP-2026-0301", action: "new", will: h(0x71), after: ["BP-2026-0301", "Issued", "P-77", "B-1"], unlinked: ["parcel_id"] },
          { key: "BP-2026-0302", action: "changed", now: h(0x72), will: h(0x73), changed: ["status"], before: ["BP-2026-0302", "Issued", "P-12", "B-9"], after: ["BP-2026-0302", "Final", "P-12", "B-9"], unlinked: ["parcel_id", "inspector"] },
          { key: "BP-2026-0303", action: "new", will: h(0x74), after: ["BP-2026-0303", "Issued", "P-12", null], unlinked: null },
        ],
      }),
    );
    const counts = [
      { column: "parcel_id", to: "town.properties.parcel_id", linked: 1, unlinked: 2, empty: 0 },
      { column: "inspector", to: "town.inspectors.badge", linked: 1, unlinked: 1, empty: 1 },
    ];
    value(await s.store.rowsEnd(RUN, jobId, key, { read: 3, targetRows: 1, same: 0, links: counts }));
    const job = await finished(s, jobId);
    // BP-2026-0301's parcel finds no row in the database, but the preview of town.properties adds it.
    const kept = [{ ...counts[0]!, unlinked: 1, added: 1 }, counts[1]!];
    assert.deepEqual((job.result as PushPreviewResult).links, kept);
    assert.deepEqual(meta<SavedPreview>(s, previewKey(PREVIEW))!.links, kept, "kept with the preview");
    assert.deepEqual(
      tableRows(s, PREVIEW).map((r) => [r._key, r.note]),
      [
        ["BP-2026-0301", null],
        ["BP-2026-0302", "Changes status; no row of town.properties has its parcel_id; no row of town.inspectors has its inspector as badge"],
        ["BP-2026-0303", null],
      ],
    );
  });

  it("refuses an end that counts none of the links it was asked to count: a DB IO job older than links", async () => {
    const s = setup();
    s.storage.sql.exec(`CREATE TABLE permits ("_key" TEXT, "_hash" TEXT, permit_no TEXT, status TEXT, parcel_id TEXT, inspector TEXT)`);
    s.storage.sql.exec("INSERT INTO permits VALUES ('BP-2026-0301', ?1, 'BP-2026-0301', 'Issued', 'P-77', 'B-1')", h(1));
    const { jobId, key } = await started(s, "push_preview", townPreviewParams({ links: LINKS }), "links-old");
    value(await s.store.rowsBegin(RUN, jobId, key, { columns: LINKED_COLUMNS, primaryKey: ["permit_no"] }));
    value(await s.store.rowsSend(RUN, jobId, key, { page: 1, rows: [{ key: "BP-2026-0301", action: "new", will: h(0x71), after: ["BP-2026-0301", "Issued", "P-77", "B-1"] }] }));
    const refused = refusal(await s.store.rowsEnd(RUN, jobId, key, { read: 1, targetRows: 0, same: 0 }));
    assert.equal(refused.code, "push_link");
    assert.match(refused.error, /asked to count 2 links and its DB IO job counted 0/);
  });

  it("refuses a link of a column the write does not write, at its begin, and two links of one column or a link to its own table as it is asked", async () => {
    const off = setup();
    threePermits(off);
    const one = await started(off, "push_preview", townPreviewParams({ links: LINKS.slice(0, 1) }), "link-off");
    const refused = refusal(await off.store.rowsBegin(RUN, one.jobId, one.key, BEGIN));
    assert.deepEqual([refused.code, refused.error], ["push_link", "A link names Parcel_ID, which is not a column this preview writes into town.permits."]);
    const twice = setup();
    threePermits(twice);
    const both = [LINKS[0], { column: "parcel_id", to: { schema: "town", name: "parcels", column: "id" } }];
    const doubled = refusal(await twice.store.jobSubmit(RUN, { kind: "push_preview", params: townPreviewParams({ links: both }), requestKey: "link-twice" }));
    assert.equal(doubled.error, "Two links name parcel_id: a preview counts one link a column.");
    const own = [{ column: "parcel_id", to: { schema: "town", name: "permits", column: "permit_no" } }];
    const self = refusal(await twice.store.jobSubmit(RUN, { kind: "push_preview", params: townPreviewParams({ links: own }), requestKey: "link-self" }));
    assert.match(self.error, /names town\.permits, the table this preview writes/);
  });
});
