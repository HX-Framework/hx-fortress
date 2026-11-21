// A store's record of its loads (store-readers/load-record), read from real loads: a store's
// object and its LOAD, on the stand-ins for its storage, its bucket and its alarms. The record is
// read through the store's own `query` door, as whoever reads it outside the store must.
//
// Each case is one a reader of the record gets wrong when it reads only a load's result: a file
// loaded again into its table, two files of one name in one load, a load that failed after its
// first table, a file a load could not read, and a load that has not run yet.

import { describe, it, host, stateOf, filesOf } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import { LOAD_RECORD_ROWS, loadRecordSql, readLoadRecord, type LoadRecord, type LoadRecordRow } from "../../store-readers/src/load-record.js";

import type { StoreDeps } from "./core.js";
import { StoreHandler } from "./handler.js";
import { loadHandler } from "./jobs/load.js";
import type { JobHandler } from "./jobs/types.js";
import type { StoreCaller, StoreResult } from "./types.js";

const STORE = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PERSON: StoreCaller = { storeId: STORE, actor: "user:u-1" };
const RUN: StoreCaller = { storeId: STORE, actor: "run:mrn-1" };
const madeBy = { runId: null, step: null };

function setup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map<string, JobHandler>([[loadHandler.kind, loadHandler as JobHandler]]) };
  const store = new StoreHandler(state as never, { FILES: r2.asBucket() }, deps);
  return { clock, r2, store };
}
type Store = ReturnType<typeof setup>;

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

async function upload(s: Store, name: string, text: string): Promise<{ id: string; name: string }> {
  const bytes = new TextEncoder().encode(text);
  const created = value(await s.store.fileCreate(PERSON, { name, size: bytes.byteLength, contentType: "text/csv" }));
  const target = value(await s.store.filePartTarget(PERSON, created.file.id, 1));
  const part = await s.r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, bytes);
  value(await s.store.fileComplete(PERSON, created.file.id, { parts: [{ n: 1, etag: part.etag }] }));
  return { id: created.file.id, name: created.file.name };
}

/** Asks for a load and runs it to its end; five seconds pass at each chunk. */
async function load(s: Store, files: { id: string; name: string }[], requestKey: string, more: Record<string, unknown> = {}) {
  let job = value(await s.store.jobSubmit(RUN, { kind: "load", params: { files, madeBy, ...more }, requestKey })).job;
  for (let alarms = 0; alarms < 2000 && (job.state === "queued" || job.state === "running"); alarms += 1) {
    await s.store.alarm();
    s.clock.advance(5_000);
    job = value(await s.store.job(RUN, job.id)).job;
  }
  return job;
}

/** The record as someone outside the store reads it: the statement through `query`, and the catalog for who made each table's rows. */
async function record(s: Store, only?: { fileIds: string[] }): Promise<{ record: LoadRecord; madeJob: Map<string, string | null> }> {
  const answer = value(await s.store.query(PERSON, { sql: loadRecordSql(only), limit: LOAD_RECORD_ROWS }));
  const rows: LoadRecordRow[] = answer.rows.map((row) => Object.fromEntries(answer.columns.map((name, i) => [name, row[i] as string | number | null])));
  const tables = value(await s.store.catalog(PERSON)).tables.filter((t) => t.kind !== "system");
  const made = new Map<string, string[]>();
  for (const t of tables) if (t.madeBy?.job) made.set(t.madeBy.job, [...(made.get(t.madeBy.job) ?? []), t.name]);
  return { record: readLoadRecord(rows, { truncated: answer.truncated, made }), madeJob: new Map(tables.map((t) => [t.name, t.madeBy?.job ?? null])) };
}

const permits = (rows: number, closed: number, extra = ""): string => [`Permit No,Status${extra}`, ...Array.from({ length: rows }, (_, i) => `BP-${i + 1},${i < closed ? "closed" : "open"}${extra ? ",x" : ""}`)].join("\n");
const brief = (r: LoadRecord) => r.loads.map((l) => ({ file: l.fileId, table: l.table, rows: l.rows, version: l.version, job: l.job, ...(l.unchanged ? { unchanged: true } : {}), ...(l.unclear ? { unclear: true } : {}) }));

describe("a store's record of its loads", () => {
  it("lists a file loaded again into its table as a second load of that table, and the catalog says which load its rows are", async () => {
    const s = setup();
    const october = await upload(s, "permits.csv", permits(40, 0));
    const first = await load(s, [october], "october");
    const november = await upload(s, "permits.csv", permits(43, 5));
    const second = await load(s, [november], "november");
    const { record: r, madeJob } = await record(s);
    // The same columns: the table is changed in place and keeps its version, so only the job tells the loads apart.
    assert.deepEqual(brief(r), [
      { file: november.id, table: "permits", rows: 43, version: 1, job: second.id },
      { file: october.id, table: "permits", rows: 40, version: 1, job: first.id },
    ]);
    assert.equal(madeJob.get("permits"), second.id);
    assert.ok(r.loads[0]!.at > r.loads[1]!.at);
    assert.deepEqual([r.unread, r.loading, r.cut], [[], [], false]);

    // One more column: the table is made again, as its next version.
    const december = await upload(s, "permits.csv", permits(44, 5, ",Fee"));
    const third = await load(s, [december], "december");
    const after = await record(s);
    assert.deepEqual(brief(after.record)[0], { file: december.id, table: "permits", rows: 44, version: 2, job: third.id });
    assert.equal(after.madeJob.get("permits"), third.id);
  });

  it("marks a load that changed no row, which the catalog does not name as the one that made the table's rows", async () => {
    const s = setup();
    const october = await upload(s, "permits.csv", permits(40, 0));
    const first = await load(s, [october], "october");
    const again = await upload(s, "permits.csv", permits(40, 0));
    const second = await load(s, [again], "again");
    const { record: r, madeJob } = await record(s);
    assert.deepEqual(brief(r), [
      { file: again.id, table: "permits", rows: 40, version: 1, job: second.id, unchanged: true },
      { file: october.id, table: "permits", rows: 40, version: 1, job: first.id },
    ]);
    // The later load ended after the rows were made: a reader tells it from a load those rows replaced by that.
    assert.equal(madeJob.get("permits"), first.id);
    assert.ok(r.loads[0]!.at > r.loads[1]!.at);
  });

  it("gives two files of one name in one load each its own table, in the order the load took them", async () => {
    const s = setup();
    const october = await upload(s, "permits.csv", permits(40, 0));
    const november = await upload(s, "permits.csv", permits(43, 5));
    const parcels = await upload(s, "parcels.csv", "apn,acres\n1,2\n2,3");
    const job = await load(s, [october, parcels, november], "every file");
    const { record: r } = await record(s);
    assert.deepEqual(brief(r), [
      { file: october.id, table: "permits", rows: 40, version: 1, job: job.id },
      { file: parcels.id, table: "parcels", rows: 2, version: 1, job: job.id },
      { file: november.id, table: "permits_2", rows: 43, version: 1, job: job.id },
    ]);
  });

  it("reads a load that failed after its first table from the tables it made, and says why the other file was not read", async () => {
    const s = setup();
    const parcels = await upload(s, "parcels.csv", "apn,acres\n1,2\n2,3");
    const second = await upload(s, "permits.csv", permits(5, 0));
    // The second table must keep a column the file does not have: its commit is refused, and the load fails.
    const job = await load(s, [parcels, second], "fails on the second", { keep: { permits: [{ column: "Fee", reader: "Laptop Loans on prod" }] } });
    assert.equal(job.state, "failed");
    const { record: r, madeJob } = await record(s);
    // The first file's table was committed, and stays the store's.
    assert.equal(madeJob.get("parcels"), job.id);
    assert.deepEqual(brief(r), [{ file: parcels.id, table: "parcels", rows: null, version: null, job: job.id }]);
    assert.equal(r.unread.length, 1);
    assert.equal(r.unread[0]!.fileId, second.id);
    assert.match(r.unread[0]!.why, /^The load that was given it failed: The new version of permits has no column Fee/);
  });

  it("says why a load could not read a file, in the load's words", async () => {
    const s = setup();
    const empty = await upload(s, "empty.csv", "");
    const good = await upload(s, "parcels.csv", "apn,acres\n1,2");
    const job = await load(s, [empty, good], "one empty");
    assert.equal(job.state, "done");
    const { record: r } = await record(s);
    assert.deepEqual(brief(r), [{ file: good.id, table: "parcels", rows: 1, version: 1, job: job.id }]);
    assert.deepEqual(r.unread.map((u) => [u.fileId, u.fileName, u.why]), [[empty.id, "empty.csv", "empty.csv holds no table with any values."]]);
  });

  it("names the files of a load that has not run yet, and reads only the loads of the files asked for", async () => {
    const s = setup();
    const parcels = await upload(s, "parcels.csv", "apn,acres\n1,2");
    const done = await load(s, [parcels], "parcels");
    const other = await upload(s, "permits.csv", permits(3, 0));
    const waiting = await upload(s, "inspections.csv", "id,result\n1,pass");
    await load(s, [other], "permits");
    // Asked for, and no alarm has run it.
    value(await s.store.jobSubmit(RUN, { kind: "load", params: { files: [waiting], madeBy }, requestKey: "waiting" }));
    const all = await record(s);
    assert.deepEqual(all.record.loading, [waiting.id]);
    assert.deepEqual(all.record.loads.map((l) => l.table), ["permits", "parcels"]);

    const one = await record(s, { fileIds: [parcels.id] });
    assert.deepEqual(brief(one.record), [{ file: parcels.id, table: "parcels", rows: 1, version: 1, job: done.id }]);
    assert.deepEqual(one.record.loading, []);
    // A file no load was given has no record at all.
    const none = await upload(s, "notes.csv", "a,b\n1,2");
    const missing = await record(s, { fileIds: [none.id] });
    assert.deepEqual([missing.record.loads, missing.record.unread, missing.record.loading], [[], [], []]);
  });
});
