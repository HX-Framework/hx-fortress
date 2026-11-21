// PULL in a store's object, through its own job runner, on the stand-ins for its storage and its
// alarms. What a store writes for a pull's pages, row by row: a first pull, a pull of a few changed
// rows, a page sent twice, a key another DB IO job took, a job whose time ran out.
//
// Every test counts the rows the store wrote, as the stand-in counts them the way workerd does: 2
// for a row inserted (the table and its `_key` index), 1 for a row updated or deleted, and the DDL
// (N + 1 for CREATE INDEX, 5 for a RENAME). What a table's own records add (its catalog row, its
// columns, its history and its delta) is bounded; the rows a page writes are counted exactly.

import { describe, it, host, stateOf, filesOf, whereBilled, whereBookmarks } from "../../testing/suite/host.js";
import { countingHex, FakeClock } from "../../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import { PULLED_GROUP, pullPickKey, pullRecordKey, type PullPageAnswer, type PullResult } from "../../../store-readers/src/pull.js";
import type { StoreDeps } from "../core.js";
import { StoreHandler } from "../handler.js";
import type { StoreCaller, StoreResult } from "../types.js";
import { pullHandler } from "./pull.js";
import { loadHandler } from "./load.js";
import { shapeHandler } from "./shape.js";
import type { JobHandler } from "./types.js";

const STORE = "sto_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RUN: StoreCaller = { storeId: STORE, actor: "run:mrn-1" };
const ADMIN: StoreCaller = { storeId: STORE, actor: "user:u-admin" };
const SOURCE = { schema: "public", name: "permits" };
const CONNECTION = { id: "dbc_1", name: "Example County permits", engine: "postgres" };
const COLUMNS = [
  { name: "permit_no", type: "text" },
  { name: "status", type: "text" },
];
const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";
const HASH_C = "cccccccccccccccc";
const HASH_D = "dddddddddddddddd";
/** The most a table's own records write: its catalog row, its columns, its history, its delta and the job's note of what it began. */
const RECORDS = 40;

function setup(opts: { limit?: number } = {}) {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map<string, JobHandler>([[pullHandler.kind, pullHandler as JobHandler], [shapeHandler.kind, shapeHandler as JobHandler], [loadHandler.kind, loadHandler as JobHandler]]) };
  const env = { FILES: filesOf().asBucket(), ...(opts.limit !== undefined ? { STORE_DAILY_WRITE_LIMIT: String(opts.limit) } : {}) };
  const store = new StoreHandler(state as never, env, deps);
  // The platform starts the object again, as it does whenever an idle one was evicted.
  const restarted = () => new StoreHandler(state as never, env, deps);
  return { clock, storage, store, restarted };
}
type Setup = ReturnType<typeof setup>;

let keys = 0;
/** A key as the gateway makes one. */
const newKey = (): string => `k1.gateway-made-${++keys}`;

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function code(result: StoreResult<unknown>): string {
  assert.equal(result.ok, false, "expected a refusal");
  return (result as { code: string }).code;
}

function params(_s: Setup, into = "permits", tables?: unknown) {
  return {
    tables: tables ?? [{ source: SOURCE, into }],
    connection: CONNECTION,
    madeBy: { runId: "mrn-1", step: "s1" },
  };
}

/** A pull job made, started by the store's alarm, and a key for its DB IO job. */
async function startPull(s: Setup, requestKey: string, p: unknown = params(s)) {
  const job = value(await s.store.jobSubmit(RUN, { kind: "pull", params: p, requestKey })).job;
  await s.store.alarm();
  const { key } = value(await s.store.jobKey(RUN, job.id, { key: newKey() }));
  return { jobId: job.id, key };
}

/** One row as the runner sends it: key, hash and the columns' values. */
const row = (key: string, hash: string, status: string | null) => [key, hash, key, status];

const tableRows = (s: Setup, table: string) => s.storage.sql.exec(`SELECT * FROM "${table}" ORDER BY "_key"`).toArray().map((r) => ({ ...r }));
const jobOf = async (s: Setup, jobId: string) => value(await s.store.job(RUN, jobId)).job;

/** The rest of a job after its last table ended: the store makes the tables visible. */
async function finish(s: Setup, jobId: string) {
  await s.store.alarm();
  const job = await jobOf(s, jobId);
  assert.equal(job.state, "done", `the job is ${job.state}: ${job.error}`);
  return job;
}

/** A first pull of three rows, committed: the second pull's starting point. */
async function firstPull(s: Setup) {
  const { jobId, key } = await startPull(s, "first");
  const begin = value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
  assert.deepEqual(begin, { mode: "new", page: 0 });
  value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A1", HASH_A, "Issued"), row("A2", HASH_B, "Final")], removed: [] }));
  value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 2, rows: [row("A3", HASH_C, null)], removed: [] }));
  assert.deepEqual(value(await s.store.pullEnd(RUN, jobId, key, { table: 0, read: 3, cut: 0 })), { finishing: true });
  const job = await finish(s, jobId);
  return { jobId, job };
}

describe("a pull job in a store", () => {
  it("makes a first pull's table visible at the end, and writes each row once", async () => {
    const s = setup();
    const { job, jobId } = await firstPull(s);
    assert.deepEqual(job.result, { tables: [{ table: "permits", version: 1, rows: 3, source: "public.permits", mode: "new", read: 3, added: 3, changed: 0, removed: 0, cut: 0 }] } satisfies PullResult);
    // Its summary says the same in names and counts, for a reader that may hold no value of a row.
    const summary = value(await s.store.jobSummary(RUN, jobId)).summary;
    assert.deepEqual(
      { state: summary.state, step: summary.step, refusal: summary.refusal, rowsWritten: summary.rowsWritten, counts: summary.counts, tables: summary.tables },
      {
        state: "done",
        step: null,
        refusal: null,
        rowsWritten: job.rowsWritten,
        counts: { tables: 1, rows: 3, read: 3, added: 3, changed: 0, removed: 0, cut: 0 },
        tables: [{ table: "permits", version: 1, rows: 3, step: "new", counts: { read: 3, added: 3, changed: 0, removed: 0, cut: 0 } }],
      },
    );
    for (const held of ["Issued", "Final", HASH_A, HASH_B]) assert.ok(!JSON.stringify(summary).includes(held), `the summary holds ${held}`);
    assert.deepEqual(tableRows(s, "permits"), [
      { _key: "A1", _hash: HASH_A, permit_no: "A1", status: "Issued" },
      { _key: "A2", _hash: HASH_B, permit_no: "A2", status: "Final" },
      { _key: "A3", _hash: HASH_C, permit_no: "A3", status: null },
    ]);
    // Three rows, written once each, in the table and its `_key` index, and the table's own records.
    assert.ok(job.rowsWritten! >= 3 * 2 && job.rowsWritten! < 3 * 2 + RECORDS, `wrote ${job.rowsWritten}`);
    const catalog = s.storage.sql.exec<{ grp: string; rows: number; version: number; made_run: string }>("SELECT grp, rows, version, made_run FROM _tables WHERE name = 'permits'").one();
    assert.deepEqual({ ...catalog }, { grp: PULLED_GROUP, rows: 3, version: 1, made_run: "mrn-1" });
    assert.ok(s.storage.sql.exec("SELECT value FROM _meta WHERE key = ?", pullRecordKey("permits")).toArray().length === 1);
    assert.equal(s.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'permits__new'").toArray().length, 0);
  });

  it("does not show a first pull's rows until its last table ended", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "unseen");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A1", HASH_A, "Issued")], removed: [] }));
    assert.equal(s.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'permits'").toArray().length, 0);
    const state = value(await s.store.pullState(RUN, jobId, key));
    assert.equal(state.state, "taking");
    assert.deepEqual(state.tables, [{ source: SOURCE, into: "permits", mode: "new", page: 1, ended: false }]);
    // The job's summary says where an open pull stands: its step, and each table's counts so far.
    const summary = value(await s.store.jobSummary(RUN, jobId)).summary;
    assert.deepEqual([summary.state, summary.step, summary.refusal], [(await jobOf(s, jobId)).state, "taking", null]);
    assert.deepEqual(summary.tables, [{ table: "permits", version: null, rows: null, step: "new", counts: { read: 0, added: 1, changed: 0, removed: 0, cut: 0, page: 1, ended: 0 } }]);
    assert.ok(!JSON.stringify(summary).includes("Issued"));
  });

  it("writes a page once, however often it is sent", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "twice");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    const begun = (await jobOf(s, jobId)).rowsWritten;
    const page = { table: 0, page: 1, rows: [row("A1", HASH_A, "Issued"), row("A2", HASH_B, "Final")], removed: [] };
    const first = value(await s.store.pullPage(RUN, jobId, key, page));
    assert.deepEqual(first, { page: 1, taken: true, added: 2, changed: 0, removed: 0 } satisfies PullPageAnswer);
    const before = (await jobOf(s, jobId)).rowsWritten;
    whereBilled(() => assert.equal(before! - begun!, 2 * 2, "two rows, each in the table and its index"));
    assert.deepEqual(value(await s.store.pullPage(RUN, jobId, key, page)), { page: 1, taken: false, added: 0, changed: 0, removed: 0 });
    assert.equal((await jobOf(s, jobId)).rowsWritten, before, "the page sent again wrote nothing");
    assert.equal(code(await s.store.pullPage(RUN, jobId, key, { ...page, page: 3 })), "page_out_of_order");
    assert.equal(tableRows(s, "permits__new").length, 2);
  });

  it("changes only the rows a nightly pull sends, in place, and counts them", async () => {
    const s = setup();
    await firstPull(s);
    const { jobId, key } = await startPull(s, "second");
    const begin = value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    assert.deepEqual(begin, { mode: "change", page: 0 });
    // The runner sends what differs: A2 changed, A4 is new, A3 is gone.
    const answer = value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A2", HASH_D, "Withdrawn"), row("A4", HASH_A, "Issued")], removed: ["A3"] }));
    assert.deepEqual(answer, { page: 1, taken: true, added: 1, changed: 1, removed: 1 });
    value(await s.store.pullEnd(RUN, jobId, key, { table: 0, read: 3, cut: 0 }));
    const job = await finish(s, jobId);
    assert.deepEqual((job.result as PullResult).tables[0], { table: "permits", version: 1, rows: 3, source: "public.permits", mode: "change", read: 3, added: 1, changed: 1, removed: 1, cut: 0 });
    assert.deepEqual(tableRows(s, "permits"), [
      { _key: "A1", _hash: HASH_A, permit_no: "A1", status: "Issued" },
      { _key: "A2", _hash: HASH_D, permit_no: "A2", status: "Withdrawn" },
      { _key: "A4", _hash: HASH_A, permit_no: "A4", status: "Issued" },
    ]);
    // One update, one insert (in the table and its index), one delete: 5 rows, and the table's own
    // records of the change (its keys, its catalog row, its history). The store did not rewrite it.
    assert.ok(job.rowsWritten! >= 5 && job.rowsWritten! < 5 + RECORDS, `wrote ${job.rowsWritten}`);
    const version = s.storage.sql.exec<{ version: number; rows: number }>("SELECT version, rows FROM _tables WHERE name = 'permits'").one();
    assert.deepEqual({ ...version }, { version: 1, rows: 3 });
    const history = s.storage.sql.exec<{ note: string; restore_point: string | null }>("SELECT note, restore_point FROM _history WHERE kind = 'table' ORDER BY at DESC, id DESC").toArray();
    const change = history.find((h) => h.note === "permits: 1 added, 1 changed, 1 removed, from public.permits in Example County permits");
    assert.ok(change, history.map((h) => h.note).join(" | "));
    whereBookmarks(() => assert.ok(change.restore_point, "Restore to Here goes back to before the first page of the change"));
    // The store's delta names the rows, for the steps that read only what changed.
    const delta = s.storage.sql.exec<{ whole: number; added: number; changed: number; removed: number }>("SELECT whole, added, changed, removed FROM _deltas WHERE tbl = 'permits' ORDER BY change DESC LIMIT 1").one();
    assert.deepEqual({ ...delta }, { whole: 0, added: 1, changed: 1, removed: 1 });
    const keys = Object.fromEntries(s.storage.sql.exec<{ kind: string; keys: string }>("SELECT kind, keys FROM _delta_rows WHERE tbl = 'permits'").toArray().map((r) => [r.kind, JSON.parse(r.keys)]));
    assert.deepEqual(keys, { added: ["A4"], changed: ["A2"], removed: ["A3"] });
  });

  it("lets a SHAPE read only the rows a pull changed, and never parks a pulled table", async () => {
    const s = setup();
    await firstPull(s);
    const shape = (requestKey: string) => ({
      kind: "shape",
      requestKey,
      params: { into: "permits_clean", sql: `SELECT "_key", permit_no, upper(status) AS status FROM permits`, goal: "one row per permit", sources: JSON.stringify([["permits", ["_key", "_hash", "permit_no", "status"]]]), madeBy: { runId: "mrn-1", step: "s2" } },
    });
    const run = async (requestKey: string) => {
      const job = value(await s.store.jobSubmit(RUN, shape(requestKey))).job;
      for (let i = 0; i < 50 && (await jobOf(s, job.id)).state !== "done"; i++) {
        await s.store.alarm();
        s.clock.advance(5_000);
      }
      const ended = await jobOf(s, job.id);
      assert.equal(ended.state, "done", ended.error ?? "");
      return ended;
    };
    const whole = await run("shape-1");
    assert.equal((whole.result as { mode: string }).mode, "whole");

    const { jobId, key } = await startPull(s, "night");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A2", HASH_D, "Withdrawn"), row("A4", HASH_A, "Issued")], removed: ["A3"] }));
    value(await s.store.pullEnd(RUN, jobId, key, { table: 0, read: 3, cut: 0 }));
    await finish(s, jobId);

    const changed = await run("shape-2");
    assert.deepEqual(
      { ...(changed.result as { mode: string; added: number; changed: number; removed: number; rows: number }) },
      { table: "permits_clean", version: 1, rows: 3, mode: "changed", added: 1, changed: 1, removed: 1 },
    );
    assert.deepEqual(tableRows(s, "permits_clean").map((r) => [r._key, r.status]), [["A1", "ISSUED"], ["A2", "WITHDRAWN"], ["A4", "ISSUED"]]);
    const park = s.storage.sql.exec<{ park_at: string | null; parked: string | null }>("SELECT park_at, parked FROM _tables WHERE name = 'permits'").one();
    assert.deepEqual({ ...park }, { park_at: null, parked: null }, "a pulled table stays in the store");
  });

  it("reads as a whole change once a pull failed part way through changing a table", async () => {
    const s = setup();
    await firstPull(s);
    const { jobId, key } = await startPull(s, "failing");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A2", HASH_D, "Withdrawn")], removed: [] }));
    const open = s.storage.sql.exec<{ whole: number }>("SELECT whole FROM _deltas WHERE tbl = 'permits' ORDER BY change DESC LIMIT 1").one();
    assert.equal(open.whole, 1, "an open change reads as whole: a reader never takes part of it for all of it");
    value(await s.store.pullFail(RUN, jobId, key, { code: "database", message: "The table went away." }));
    await s.store.alarm();
    assert.equal((await jobOf(s, jobId)).state, "failed");
    const delta = s.storage.sql.exec<{ whole: number; kept: number }>("SELECT whole, kept FROM _deltas WHERE tbl = 'permits' ORDER BY change DESC LIMIT 1").one();
    assert.deepEqual({ ...delta }, { whole: 1, kept: 0 });
    assert.equal(s.storage.sql.exec("SELECT 1 FROM _delta_rows WHERE tbl = 'permits'").toArray().length, 0, "its keys go");
  });

  it("writes nothing for a pull in which no row changed", async () => {
    const s = setup();
    await firstPull(s);
    const { jobId, key } = await startPull(s, "unchanged");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullEnd(RUN, jobId, key, { table: 0, read: 3, cut: 0 }));
    const job = await finish(s, jobId);
    assert.equal(job.rowsWritten, 0);
    assert.equal((job.result as PullResult).tables[0]!.added, 0);
    assert.equal(tableRows(s, "permits").length, 3);
  });

  it("leaves a row out of its write when the store already holds its hash", async () => {
    const s = setup();
    await firstPull(s);
    const { jobId, key } = await startPull(s, "same");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    const answer = value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A1", HASH_A, "Issued")], removed: [] }));
    assert.deepEqual(answer, { page: 1, taken: true, added: 0, changed: 0, removed: 0 });
    assert.equal((await jobOf(s, jobId)).rowsWritten, 0);
  });

  it("answers what it holds of a table in key order, a read at a time", async () => {
    const s = setup();
    await firstPull(s);
    const { jobId, key } = await startPull(s, "hashes");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    const first = value(await s.store.pullHashes(RUN, jobId, key, { table: 0, after: null, limit: 2 }));
    assert.deepEqual(first, { hashes: [["A1", HASH_A], ["A2", HASH_B]], next: "A2" });
    const second = value(await s.store.pullHashes(RUN, jobId, key, { table: 0, after: first.next, limit: 2 }));
    assert.deepEqual(second, { hashes: [["A3", HASH_C]], next: null });
  });

  it("refuses to write over a table pulled from another table or connection", async () => {
    const s = setup();
    await firstPull(s);
    for (const [other, requestKey] of [
      [{ ...params(s), tables: [{ source: { schema: "archive", name: "permits" }, into: "permits" }] }, "other-table"],
      [{ ...params(s), connection: { ...CONNECTION, id: "dbc_2" } }, "other-connection"],
    ] as const) {
      const job = value(await s.store.jobSubmit(RUN, { kind: "pull", params: other, requestKey })).job;
      await s.store.alarm();
      const ended = await jobOf(s, job.id);
      assert.equal(ended.state, "failed");
      assert.match(ended.error ?? "", /holds rows pulled from public\.permits/);
    }
    assert.equal(tableRows(s, "permits").length, 3, "the first table is still there");
  });

  it("changes the table in place when only a column's size changed", async () => {
    const s = setup();
    await firstPull(s);
    const { jobId, key } = await startPull(s, "wider");
    const wider = [{ name: "permit_no", type: "text" }, { name: "status", type: "varchar(100)" }];
    assert.deepEqual(value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: wider, key: ["permit_no"] })), { mode: "change", page: 0 });
  });

  it("makes a new version when the database's columns changed", async () => {
    const s = setup();
    await firstPull(s);
    const { jobId, key } = await startPull(s, "columns");
    const wider = [...COLUMNS, { name: "fee", type: "numeric" }];
    const begin = value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: wider, key: ["permit_no"] }));
    assert.equal(begin.mode, "new");
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [["A1", HASH_D, "A1", "Issued", "75.00"]], removed: [] }));
    value(await s.store.pullEnd(RUN, jobId, key, { table: 0, read: 1, cut: 0 }));
    const job = await finish(s, jobId);
    assert.equal((job.result as PullResult).tables[0]!.version, 2);
    assert.deepEqual(tableRows(s, "permits"), [{ _key: "A1", _hash: HASH_D, permit_no: "A1", status: "Issued", fee: "75.00" }]);
  });

  it("goes on from the store's last page under a stopped DB IO job's successor", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "resume");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A1", HASH_A, "Issued")], removed: [] }));
    // The container is gone. A new DB IO job gets its own key; the old one stops working.
    const next = value(await s.store.jobKey(RUN, jobId, { key: newKey() })).key;
    assert.equal(code(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 2, rows: [row("A2", HASH_B, "Final")], removed: [] })), "job_key_refused");
    const begin = value(await s.store.pullBegin(RUN, jobId, next, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    assert.deepEqual(begin, { mode: "new", page: 1 });
    const held = value(await s.store.pullHashes(RUN, jobId, next, { table: 0, after: null }));
    assert.deepEqual(held.hashes, [["A1", HASH_A]]);
    value(await s.store.pullPage(RUN, jobId, next, { table: 0, page: 2, rows: [row("A2", HASH_B, "Final")], removed: [] }));
    value(await s.store.pullEnd(RUN, jobId, next, { table: 0, read: 2, cut: 0 }));
    const job = await finish(s, jobId);
    assert.ok(job.rowsWritten! >= 2 * 2 && job.rowsWritten! < 2 * 2 + RECORDS, `each row written once, across both DB IO jobs: wrote ${job.rowsWritten}`);
    assert.equal(tableRows(s, "permits").length, 2);
  });

  it("starts a table over when its columns changed between two DB IO jobs", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "shifted");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A1", HASH_A, "Issued")], removed: [] }));
    const wider = [...COLUMNS, { name: "fee", type: "numeric" }];
    const begin = value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: wider, key: ["permit_no"] }));
    assert.deepEqual(begin, { mode: "new", page: 0 });
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [["A1", HASH_A, "A1", "Issued", "75.00"]], removed: [] }));
    assert.deepEqual(tableRows(s, "permits__new"), [{ _key: "A1", _hash: HASH_A, permit_no: "A1", status: "Issued", fee: "75.00" }]);
  });

  it("refuses a call without the job's key", async () => {
    const s = setup();
    const { jobId } = await startPull(s, "no-key");
    assert.equal(code(await s.store.pullState(RUN, jobId, "k1.nope")), "job_key_refused");
    assert.equal(code(await s.store.pullBegin(RUN, jobId, "k1.nope", { table: 0, columns: COLUMNS, key: [] })), "job_key_refused");
  });

  it("says a job waits while another runs, and takes no page before it starts", async () => {
    const s = setup();
    const job = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s), requestKey: "queued" })).job;
    const { key } = value(await s.store.jobKey(RUN, job.id, { key: newKey() }));
    assert.equal(value(await s.store.pullState(RUN, job.id, key)).state, "waiting");
    assert.equal(code(await s.store.pullBegin(RUN, job.id, key, { table: 0, columns: COLUMNS, key: [] })), "job_not_taking");
  });

  it("sleeps while it takes pages, rather than waking its alarm every moment", async () => {
    const s = setup();
    const job = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s), requestKey: "sleep" })).job;
    const until = new Date(s.clock.now() + 20 * 60_000).toISOString();
    value(await s.store.jobKey(RUN, job.id, { key: newKey(), until }));
    // As on the platform, the alarm that fires is gone by the time alarm() runs.
    s.storage.alarm = null;
    await s.store.alarm();
    assert.equal(s.storage.alarm, Date.parse(until));
  });

  it("does not count waking up as a chunk that got nowhere, however often its object restarts", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "restarts");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    // An idle object is evicted while the runner reads a big table; each start runs one chunk.
    for (let i = 0; i < 6; i++) await s.restarted().alarm();
    const fresh = s.restarted();
    assert.equal(value(await fresh.job(RUN, jobId)).job.state, "running");
    value(await fresh.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A1", HASH_A, "Issued")], removed: [] }));
    value(await fresh.pullEnd(RUN, jobId, key, { table: 0, read: 1, cut: 0 }));
    await fresh.alarm();
    assert.equal(value(await fresh.job(RUN, jobId)).job.state, "done");
  });

  it("fails with the runner's words, and drops what it had begun", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "fails");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A1", HASH_A, "Issued")], removed: [] }));
    assert.equal(value(await s.store.pullFail(RUN, jobId, key, { code: "connector_offline", message: "No connector is online." })), null);
    await s.store.alarm();
    const job = await jobOf(s, jobId);
    assert.equal(job.state, "failed");
    assert.equal(job.error, "No connector is online.");
    assert.equal(s.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'permits__new'").toArray().length, 0);
  });

  it("fails when its DB IO job stops and its time runs out", async () => {
    const s = setup();
    const job = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s), requestKey: "late" })).job;
    await s.store.alarm();
    const { key } = value(await s.store.jobKey(RUN, job.id, { key: newKey(), until: new Date(s.clock.now() + 30 * 60_000).toISOString() }));
    value(await s.store.pullBegin(RUN, job.id, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    s.clock.advance(31 * 60_000);
    await s.store.alarm();
    const ended = await jobOf(s, job.id);
    assert.equal(ended.state, "failed");
    assert.match(ended.error ?? "", /stopped sending/);
  });

  it("fails when no DB IO job ever comes", async () => {
    const s = setup();
    const job = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s), requestKey: "nobody" })).job;
    await s.store.alarm();
    s.clock.advance(46 * 60_000);
    await s.store.alarm();
    assert.equal((await jobOf(s, job.id)).state, "failed");
  });

  it("moves its time on when a successor's key asks", async () => {
    const s = setup();
    const job = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s), requestKey: "extended" })).job;
    await s.store.alarm();
    value(await s.store.jobKey(RUN, job.id, { key: newKey(), until: new Date(s.clock.now() + 10 * 60_000).toISOString() }));
    s.clock.advance(9 * 60_000);
    value(await s.store.jobKey(RUN, job.id, { key: newKey(), until: new Date(s.clock.now() + 30 * 60_000).toISOString() }));
    s.clock.advance(2 * 60_000);
    await s.store.alarm();
    assert.equal((await jobOf(s, job.id)).state, "running");
  });

  it("keeps what it took at the day's write limit, a day longer, for the next DB IO job", async () => {
    const s = setup();
    const job = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s), requestKey: "limit" })).job;
    await s.store.alarm();
    const { key } = value(await s.store.jobKey(RUN, job.id, { key: newKey(), until: new Date(s.clock.now() + 30 * 60_000).toISOString() }));
    value(await s.store.pullBegin(RUN, job.id, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullPage(RUN, job.id, key, { table: 0, page: 1, rows: [row("A1", HASH_A, "Issued")], removed: [] }));
    value(await s.store.pullFail(RUN, job.id, key, { code: "store_limit", message: "This store reached its limit of rows written today." }));
    assert.equal((await jobOf(s, job.id)).state, "running");
    s.clock.advance(40 * 60_000);
    await s.store.alarm();
    assert.equal((await jobOf(s, job.id)).state, "running", "it waits past the key's own time");
    const next = value(await s.store.jobKey(RUN, job.id, { key: newKey(), until: new Date(s.clock.now() + 30 * 60_000).toISOString() })).key;
    assert.deepEqual(value(await s.store.pullBegin(RUN, job.id, next, { table: 0, columns: COLUMNS, key: ["permit_no"] })), { mode: "new", page: 1 });
    assert.equal(tableRows(s, "permits__new").length, 1);
  });

  it("fails at once when a table's name belongs to another step", async () => {
    const s = setup();
    s.storage.sql.exec("INSERT INTO _tables (name, kind, version, grp, created_at, updated_at) VALUES ('permits', 'program', 1, 'From the town', '2026', '2026')");
    s.storage.sql.exec('CREATE TABLE permits ("Permit No" TEXT)');
    const job = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s), requestKey: "taken" })).job;
    await s.store.alarm();
    const ended = await jobOf(s, job.id);
    assert.equal(ended.state, "failed");
    assert.match(ended.error ?? "", /another step made/);
  });

  it("packs columns past the 90th into _extra, as LOAD does", async () => {
    const s = setup();
    const columns = Array.from({ length: 95 }, (_, i) => ({ name: `c${i + 1}`, type: "text" }));
    const { jobId, key } = await startPull(s, "wide");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns, key: ["c1"] }));
    const values = columns.map((c) => (c.name === "c92" ? null : `v-${c.name}`));
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [["K", HASH_A, ...values]], removed: [] }));
    value(await s.store.pullEnd(RUN, jobId, key, { table: 0, read: 1, cut: 0 }));
    await finish(s, jobId);
    const [stored] = tableRows(s, "permits");
    assert.equal(stored!.c90, "v-c90");
    assert.ok(!("c91" in stored!));
    assert.deepEqual(JSON.parse(String(stored!._extra)), { c91: "v-c91", c93: "v-c93", c94: "v-c94", c95: "v-c95" });
  });

  it("writes a row too long to bind as JSON", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "long");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    // 1,500,000 newlines: 3 MB as JSON, under the 2 MB a store holds as a value.
    const long = "\n".repeat(1_500_000);
    const answer = value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [["A1", HASH_A, "A1", long], row("A2", HASH_B, "Final")], removed: [] }));
    assert.equal(answer.added, 2);
    const held = tableRows(s, "permits__new");
    assert.equal(String(held[0]!.status).length, 1_500_000);
    assert.equal(held[1]!.status, "Final");
  });

  it("keeps a model's pick of the tables, under a key the store makes", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "pick", { ...params(s), pick: "the permit tables" });
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullEnd(RUN, jobId, key, { table: 0, read: 0, cut: 0 }));
    await finish(s, jobId);
    const saved = JSON.parse(s.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = ?", pullPickKey("dbc_1", "the permit tables")).one().value) as { words: string; tables: unknown[]; by: string };
    assert.equal(saved.words, "the permit tables");
    assert.deepEqual(saved.tables, [{ source: SOURCE, into: "permits" }]);
    assert.equal(saved.by, "run:mrn-1");
  });

  it("names no key of the store's own in a pick", async () => {
    const s = setup();
    const bad = await s.store.jobSubmit(RUN, { kind: "pull", params: { ...params(s), pick: { words: "x", key: "destroyed_at" } }, requestKey: "pick-bad" });
    assert.equal(code(bad), "bad_request");
  });

  it("fails a pull still waiting its turn when its DB IO job stopped, in that DB IO job's words", async () => {
    const s = setup();
    const first = await startPull(s, "running");
    const behind = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s, "fees"), requestKey: "behind" })).job;
    const { key } = value(await s.store.jobKey(RUN, behind.id, { key: newKey() }));
    assert.equal((await jobOf(s, behind.id)).state, "queued");
    value(await s.store.pullFail(RUN, behind.id, key, { code: "login", message: "The database refused the login." }));
    value(await s.store.pullBegin(RUN, first.jobId, first.key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullEnd(RUN, first.jobId, first.key, { table: 0, read: 0, cut: 0 }));
    await finish(s, first.jobId);
    await s.store.alarm();
    const ended = await jobOf(s, behind.id);
    assert.equal(ended.state, "failed");
    assert.equal(ended.error, "The database refused the login.");
  });

  it("holds its place until the write limit passes, then gives way to a job behind it", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "stopped");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A1", HASH_A, "Issued")], removed: [] }));
    value(await s.store.pullFail(RUN, jobId, key, { code: "store_limit", message: "This store reached its limit." }));
    const behind = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s, "fees"), requestKey: "behind" })).job;
    await s.store.alarm();
    assert.equal((await jobOf(s, jobId)).state, "running", "a person may raise the limit, and nothing else could write anyway");
    assert.equal((await jobOf(s, behind.id)).state, "queued");
    s.clock.advance(13 * 3_600_000);
    await s.store.alarm();
    const ended = await jobOf(s, jobId);
    assert.equal(ended.state, "failed");
    assert.match(ended.error ?? "", /no DB IO job came back/);
    await s.store.alarm();
    assert.equal((await jobOf(s, behind.id)).state, "running");
  });

  it("keeps a stopped pull for whoever goes on while nothing needs the store, and then for a day at most", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "stopped");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [row("A1", HASH_A, "Issued")], removed: [] }));
    s.clock.advance(50 * 60_000); // past the time its first key was given
    await s.store.alarm();
    assert.equal((await jobOf(s, jobId)).state, "running", "the rows it took stay for a Try Again in the morning");
    const next = value(await s.store.jobKey(RUN, jobId, { key: newKey() })).key;
    const begin = value(await s.store.pullBegin(RUN, jobId, next, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    assert.deepEqual(begin, { mode: "new", page: 1 }, "it goes on from the store's last page");
    s.clock.advance(70 * 3_600_000);
    await s.store.alarm();
    assert.equal((await jobOf(s, jobId)).state, "failed", "not for ever");
  });

  it("keeps a pick when the job starts, so a call that goes on finds the same tables", async () => {
    const s = setup();
    await startPull(s, "pick", { ...params(s), pick: "the permit tables" });
    assert.ok(s.storage.sql.exec("SELECT 1 FROM _meta WHERE key = ?", pullPickKey("dbc_1", "the permit tables")).toArray().length);
  });

  it("makes its tables visible when its last page reached the daily write limit", async () => {
    const s = setup({ limit: 1_000 });
    const { jobId, key } = await startPull(s, "limited");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    // One page that takes the store past 1,000 written rows: a row and its index entry count as
    // two where the host bills as Cloudflare does, and as one where it counts as SQLite does.
    const n = host().traits.billedWrites ? 600 : 1_100;
    const rows = Array.from({ length: n }, (_, i) => row(`A${i}`, HASH_A, "Issued"));
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows, removed: [] }));
    assert.ok(value(await s.store.stats(RUN)).writes!.rows >= 1_000, "the page took the store to its limit");
    assert.deepEqual(value(await s.store.pullEnd(RUN, jobId, key, { table: 0, read: n, cut: 0 })), { finishing: true });
    await finish(s, jobId);
    assert.equal(tableRows(s, "permits").length, n);
  });

  it("answers the last table's end again when its answer was lost", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "lost");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    const end = { table: 0, read: 0, cut: 0 };
    assert.deepEqual(value(await s.store.pullEnd(RUN, jobId, key, end)), { finishing: true });
    assert.deepEqual(value(await s.store.pullEnd(RUN, jobId, key, end)), { finishing: true }, "while the store finishes");
    await finish(s, jobId);
    assert.deepEqual(value(await s.store.pullEnd(RUN, jobId, key, end)), { finishing: true }, "after the job is done");
  });

  it("takes a key's removal when the key is empty text", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "empty");
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 1, rows: [["", HASH_A, "", "Issued"]], removed: [] }));
    assert.deepEqual(value(await s.store.pullPage(RUN, jobId, key, { table: 0, page: 2, rows: [], removed: [""] })), { page: 2, taken: true, added: 0, changed: 0, removed: 1 });
  });

  it("keeps a key's hash only while its job is open", async () => {
    const s = setup();
    const { jobId, key } = await startPull(s, "cleared");
    const held = () => s.storage.sql.exec<{ key_hash: string | null }>("SELECT key_hash FROM _jobs WHERE id = ?", jobId).one().key_hash;
    assert.ok(held());
    value(await s.store.pullBegin(RUN, jobId, key, { table: 0, columns: COLUMNS, key: ["permit_no"] }));
    value(await s.store.pullEnd(RUN, jobId, key, { table: 0, read: 0, cut: 0 }));
    await finish(s, jobId);
    assert.equal(held(), null);
  });

  it("gets a job's key while an export holds the store, as it was submitted", async () => {
    const s = setup();
    value(await s.store.exportStart(ADMIN, { requestKey: "export-1" }));
    const job = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s), requestKey: "beside-export" })).job;
    assert.ok(value(await s.store.jobKey(RUN, job.id, { key: newKey() })).key);
  });

  it("says when a job's tables have too many columns to keep track of", async () => {
    const s = setup();
    const many = Array.from({ length: 40 }, (_, i) => ({ source: { schema: "public", name: `t${i}` }, into: `t${i}` }));
    const { jobId, key } = await startPull(s, "wide", { ...params(s), tables: many });
    const wide = Array.from({ length: 1024 }, (_, i) => ({ name: `a_long_column_name_${i}`, type: "text" }));
    let refused = "";
    for (let table = 0; table < many.length && !refused; table++) {
      const begin = await s.store.pullBegin(RUN, jobId, key, { table, columns: wide, key: [] });
      if (!begin.ok) refused = begin.code;
    }
    assert.equal(refused, "pull_too_wide");
  });

  it("refuses a key its caller did not make", async () => {
    const s = setup();
    const job = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s), requestKey: "made" })).job;
    assert.equal(code(await s.store.jobKey(RUN, job.id, {})), "bad_request");
  });

  it("refuses parameters a pull does not take", async () => {
    const s = setup();
    const bad = await s.store.jobSubmit(RUN, { kind: "pull", params: { ...params(s), tables: [{ source: SOURCE, into: "Bad Name" }] }, requestKey: "bad" });
    assert.equal(code(bad), "bad_request");
    const twice = await s.store.jobSubmit(RUN, { kind: "pull", params: { ...params(s), tables: [{ source: SOURCE, into: "p" }, { source: SOURCE, into: "p" }] }, requestKey: "twice" });
    assert.equal(code(twice), "bad_request");
  });

  it("makes a job once per request key, and gives each DB IO job its own key", async () => {
    const s = setup();
    const first = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s), requestKey: "once" })).job;
    const again = value(await s.store.jobSubmit(RUN, { kind: "pull", params: params(s), requestKey: "once" })).job;
    assert.equal(first.id, again.id);
    const a = value(await s.store.jobKey(RUN, first.id, { key: newKey() })).key;
    const b = value(await s.store.jobKey(RUN, first.id, { key: newKey() })).key;
    assert.notEqual(a, b);
    assert.equal(code(await s.store.pullState(RUN, first.id, a)), "job_key_refused");
    assert.equal(value(await s.store.pullState(RUN, first.id, b)).state, "waiting");
  });
});
