// READ in a store's object, through its own job runner, on the stand-ins for its storage, its
// bucket and its alarms: a big workbook's tables and rows taken as pages from the file reader, LOAD
// opening the read-out as it would the file itself, a page sent twice, a key a newer reader took, a
// file the reader could not read, a read-out the store held already, and a deleted file's read-out
// going with its bytes.
//
// The file reader is played here by the same page builder it runs (store-readers jobs.ts
// `readPagesOf`), over the store's own reader of the sample file. A big file is the sample file's
// bytes padded past the size a store reads whole, so the store opens its read-out instead.

import { describe, host, it, itWhere, stateOf, filesOf } from "../../testing/suite/host.js";
import { countingHex, FakeClock } from "../../testing/suite/stand-ins.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openFile, WHOLE_FILE_CAPS } from "../../../store-readers/src/index.js";
import { type LoadResult, READ_LIMITS, type ReadResult, readPagesOf, type ReadState, rowForLoad, ROW_CHARS_MAX } from "../../../store-readers/src/jobs.js";
import type { StoreDeps } from "../core.js";
import { FILE_KEEP_DELETED_MS } from "../files.js";
import { StoreHandler } from "../handler.js";
import { FILE_PART_BYTES, type StoreCaller, type StoreResult } from "../types.js";
import { fitRow, loadHandler } from "./load.js";
import { readHandler, readOutFolder } from "./read.js";
import type { JobHandler } from "./types.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "store-readers", "fixtures");
const STORE = "sto_cccccccccccccccccccccccccccccccc";
const PERSON: StoreCaller = { storeId: STORE, actor: "user:u-1", org: "org-1" };
const RUN: StoreCaller = { storeId: STORE, actor: "run:mrn-1", org: "org-1" };
const READER = "file-reader test";

function setup(opts: { failPartOnce?: boolean } = {}) {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map<string, JobHandler>([[loadHandler.kind, loadHandler as JobHandler], [readHandler.kind, readHandler as JobHandler]]) };
  const bucket = r2.asBucket();
  // A bucket whose first read of a read-out's part fails, as R2 now and then does.
  let failed = false;
  const files = opts.failPartOnce
    ? new Proxy(bucket, {
        get(target, prop) {
          if (prop === "get") {
            return (key: string, options?: never) => (!failed && key.includes("/read-outs/") && key.includes("/part-") ? ((failed = true), Promise.reject(new Error("R2 timed out"))) : target.get(key, options));
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? v.bind(target) : v;
        },
      })
    : bucket;
  const store = new StoreHandler(state as never, { FILES: files }, deps);
  return { clock, storage, r2, store };
}
type Setup = ReturnType<typeof setup>;

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function code(result: StoreResult<unknown>): string {
  assert.equal(result.ok, false, "expected a refusal");
  return (result as { code: string }).code;
}

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** `it`, for a test that reads sample files: listed as skipped where one of them is missing (a copy of this suite with only its text samples). */
function sampled(...names: string[]) {
  const missing = names.find((name) => !existsSync(join(FIXTURES, name)));
  return itWhere(missing === undefined, `this copy of the suite has no sample file ${missing}`);
}

/** The sample file's bytes, padded past the size a store reads whole: what the file reader reads, and the store refuses to. */
function big(bytes: Uint8Array, format: "xls" | "access"): Uint8Array {
  const padded = new Uint8Array(WHOLE_FILE_CAPS[format] + 1024);
  padded.set(bytes);
  return padded;
}

/** A file put into the store as a page puts it: a part at a time. */
async function upload(s: Setup, name: string, bytes: Uint8Array): Promise<{ id: string; name: string }> {
  const created = value(await s.store.fileCreate(PERSON, { name, size: bytes.byteLength, contentType: "application/octet-stream" }));
  const parts: { n: number; etag: string }[] = [];
  for (let n = 1, at = 0; at < bytes.byteLength || n === 1; n++, at += FILE_PART_BYTES) {
    const target = value(await s.store.filePartTarget(PERSON, created.file.id, n));
    const part = await s.r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(n, bytes.subarray(at, at + FILE_PART_BYTES));
    parts.push({ n, etag: part.etag });
  }
  value(await s.store.fileComplete(PERSON, created.file.id, { parts }));
  return { id: created.file.id, name: created.file.name };
}

let keys = 0;
/** A key as the gateway makes one. */
const newKey = (): string => `k1.gateway-made-${++keys}`;

/** A READ made, started by the store's alarm, and a key for its reader. */
async function startRead(s: Setup, files: { id: string; name: string }[], requestKey = "read-1", madeBy?: { runId: string; step: string }) {
  const job = value(await s.store.jobSubmit(RUN, { kind: "read", params: { files, ...(madeBy ? { madeBy } : {}) }, requestKey })).job;
  await s.store.alarm();
  const { key } = value(await s.store.jobKey(RUN, job.id, { key: newKey() }));
  return { jobId: job.id, key };
}

/** The file reader's work on file `n` of a READ: its tables, then its pages, then its end, as `bytes` read. */
async function readAs(s: Setup, read: { jobId: string; key: string }, n: number, bytes: Uint8Array, name: string, opts: { reader?: string; stopAfter?: number; pageRows?: number } = {}): Promise<number> {
  const opened = await openFile(name, { size: bytes.byteLength, read: async (o, l) => bytes.subarray(o, o + l) });
  const begun = value(await s.store.readBegin(RUN, read.jobId, read.key, { file: n, reader: opts.reader ?? READER, format: opened.format, tables: opened.tables, notes: opened.notes }));
  let page = 0;
  let rows = 0;
  for await (const p of readPagesOf(opened, { ...READ_LIMITS, ...(opts.pageRows ? { pageRows: opts.pageRows } : {}) })) {
    page++;
    rows += p.rows.length;
    if (page <= begun.page) continue;
    if (opts.stopAfter !== undefined && page > opts.stopAfter) return page - 1;
    value(await s.store.readPage(RUN, read.jobId, read.key, { file: n, page, table: p.table, rows: p.rows }));
  }
  value(await s.store.readEnd(RUN, read.jobId, read.key, { file: n, rows }));
  return page;
}

/** Runs the store's alarms until job `jobId` ends. */
async function ended(s: Setup, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = value(await s.store.job(RUN, jobId)).job;
    if (job.state !== "queued" && job.state !== "running") return job;
    await s.store.alarm();
    s.clock.advance(5_000);
  }
  throw new Error("The job did not end.");
}

/** A LOAD of these files, run to its end. */
async function load(s: Setup, files: { id: string; name: string; readOut?: string }[], requestKey = "load-1") {
  const job = value(await s.store.jobSubmit(RUN, { kind: "load", params: { files, madeBy: { runId: "mrn-1", step: "s1" } }, requestKey })).job;
  return ended(s, job.id);
}

/** A table's rows as the store holds them, `_file` left out: it names the file of each store. */
const tableRows = (s: Setup, table: string) =>
  s.storage.sql
    .exec(`SELECT * FROM "${table}" ORDER BY _row`)
    .toArray()
    .map(({ _file: _f, ...rest }) => ({ ...rest }));

const readOutKeys = (s: Setup, fileId: string): string[] => [...s.r2.objects.keys()].filter((k) => k.startsWith(readOutFolder(STORE, fileId)));

describe("READ: a big workbook or database read beside the store", () => {
  for (const [sample, format] of [
    ["parcels-titled.xls", "xls"],
    ["permits-2000.mdb", "access"],
  ] as const) {
    sampled(sample)(`LOAD loads a big ${format === "xls" ? "workbook" : "database"} from its read-out exactly as it loads the file read whole`, async () => {
      const bytes = fixture(sample);
      // The file read whole, in a store of its own.
      const whole = setup();
      const small = await upload(whole, sample, bytes);
      const wholeLoad = await load(whole, [small]);
      assert.equal(wholeLoad.state, "done", wholeLoad.error ?? "");

      // The same file past the size a store reads whole: refused until the reader has read it.
      const s = setup();
      const file = await upload(s, sample, big(bytes, format));
      const refused = await load(s, [file], "load-refused");
      assert.match((refused.result as LoadResult).skipped[0]?.why ?? "", /is read whole inside the store/);

      const read = await startRead(s, [file]);
      const state = value(await s.store.readState(RUN, read.jobId, read.key));
      assert.equal(state.state, "taking");
      assert.deepEqual(state.files.map((f) => [f.name, f.ended]), [[sample, false]]);
      // Pages of a few rows each, so LOAD's batches of 2,000 rows cross many parts.
      await readAs(s, read, 0, bytes, sample, { pageRows: 7 });
      const done = await ended(s, read.jobId);
      assert.equal(done.state, "done", done.error ?? "");
      const tables = (wholeLoad.result as LoadResult).tables;
      assert.deepEqual(
        (done.result as ReadResult).files.map((f) => f.rows),
        [tables.reduce((n, t) => n + t.rows, 0)],
      );

      const loaded = await load(s, [{ ...file, readOut: read.jobId }], "load-2");
      assert.equal(loaded.state, "done", loaded.error ?? "");
      const result = loaded.result as LoadResult;
      assert.deepEqual(
        result.tables.map((t) => ({ ...t, file: "" })),
        tables.map((t) => ({ ...t, file: "" })),
      );
      for (const t of tables) assert.deepEqual(tableRows(s, t.table), tableRows(whole, t.table), t.table);
    });
  }

  it("cuts a row it sends as LOAD cuts the row read whole, so LOAD cuts it the same and counts the same cuts", () => {
    const long = (n: number, c: string) => c.repeat(n);
    const rows: [(string | null)[], Record<string, string> | undefined][] = [
      [["short", null, long(10, "a")], undefined],
      [[long(ROW_CHARS_MAX + 5_000, "b"), "x"], undefined],
      [[long(400_000, "c"), long(3_000_000, "d"), null, long(250_000, "e")], { "column Q": long(900_000, "f") }],
      [[long(ROW_CHARS_MAX, "g")], { "column B": "h" }],
    ];
    for (const [values, extra] of rows) {
      const whole = { values: [...values], extra: extra ? { ...extra } : undefined };
      const wholeCut = fitRow(whole.values, whole.extra);
      const sent = rowForLoad([...values], extra ? { ...extra } : undefined);
      const sentCut = fitRow(sent.values, sent.extra);
      assert.equal(sentCut, wholeCut);
      assert.deepEqual(sent.values, whole.values);
      assert.deepEqual(sent.extra, whole.extra);
    }
  });

  sampled("permits-2000.mdb")("loads the tables before the place the reader could not read on, and gives its words there, as LOAD reading the file would", async () => {
    const s = setup();
    const bytes = fixture("permits-2000.mdb");
    const file = await upload(s, "permits.mdb", big(bytes, "access"));
    const read = await startRead(s, [file]);
    const opened = await openFile("permits.mdb", { size: bytes.byteLength, read: async (o, l) => bytes.subarray(o, o + l) });
    assert.ok(opened.tables.length >= 2, "the sample has two tables");
    value(await s.store.readBegin(RUN, read.jobId, read.key, { file: 0, reader: READER, format: "access", tables: opened.tables, notes: opened.notes }));
    let page = 0;
    let rows = 0;
    for await (const p of readPagesOf(opened)) {
      if (p.table > 0) break;
      page++;
      rows += p.rows.length;
      value(await s.store.readPage(RUN, read.jobId, read.key, { file: 0, page, table: p.table, rows: p.rows }));
    }
    const words = `Row 1 on of ${opened.tables[1]!.name} could not be read: a damaged page`;
    value(await s.store.readEnd(RUN, read.jobId, read.key, { file: 0, rows, stopped: { table: 1, reason: "damaged", message: words } }));
    await ended(s, read.jobId);
    const loaded = await load(s, [{ ...file, readOut: read.jobId }]);
    const result = loaded.result as LoadResult;
    assert.deepEqual(result.tables.map((t) => t.rows), [rows]);
    assert.deepEqual(result.skipped, [{ file: "permits.mdb", why: `permits.mdb could not be read on: ${words}` }]);
  });

  sampled("parcels-titled.xls")("tries a chunk again when the bucket fails while LOAD reads a read-out, and loads it", async () => {
    const s = setup({ failPartOnce: true });
    const bytes = fixture("parcels-titled.xls");
    const file = await upload(s, "parcels.xls", big(bytes, "xls"));
    const read = await startRead(s, [file]);
    await readAs(s, read, 0, bytes, "parcels.xls");
    await ended(s, read.jobId);
    const loaded = await load(s, [{ ...file, readOut: read.jobId }]);
    assert.equal(loaded.state, "done", loaded.error ?? "");
    assert.deepEqual((loaded.result as LoadResult).skipped, []);
    assert.ok((loaded.result as LoadResult).tables.length > 0);
  });

  it("ends with its run: a run's Stop fails the run's READ", async () => {
    const s = setup();
    const file = await upload(s, "parcels.xls", big(new Uint8Array(16), "xls"));
    const read = await startRead(s, [file], "read-run", { runId: "mrn-1", step: "s1" });
    assert.deepEqual(value(await s.store.jobsStop(RUN, { runId: "mrn-1", why: "Stopped by a person." })), { stopped: 1 });
    const done = await ended(s, read.jobId);
    assert.equal(done.state, "failed");
  });

  sampled("parcels-titled.xls")("reads for one LOAD: two READs of one file each keep a read-out, and each LOAD drops only its own", async () => {
    const s = setup();
    const bytes = fixture("parcels-titled.xls");
    const file = await upload(s, "parcels.xls", big(bytes, "xls"));
    const first = await startRead(s, [file]);
    await readAs(s, first, 0, bytes, "parcels.xls");
    await ended(s, first.jobId);
    // A second run reads the same file: its READ reads it again, beside the first one's read-out.
    const second = await startRead(s, [file], "read-2");
    assert.deepEqual(value(await s.store.readState(RUN, second.jobId, second.key)).files.map((f) => f.ended), [false]);
    await readAs(s, second, 0, bytes, "parcels.xls");
    await ended(s, second.jobId);
    const ofJob = (jobId: string) => readOutKeys(s, file.id).filter((k) => k.includes(`/${jobId}/`));
    assert.ok(ofJob(first.jobId).length > 1 && ofJob(second.jobId).length > 1);
    // The first run's LOAD drops its own read-out; the second's still loads from its own.
    assert.equal((await load(s, [{ ...file, readOut: first.jobId }], "load-1")).state, "done");
    assert.deepEqual(ofJob(first.jobId), []);
    const loaded = await load(s, [{ ...file, readOut: second.jobId }], "load-2");
    assert.equal(loaded.state, "done");
    assert.deepEqual((loaded.result as LoadResult).skipped, []);
    assert.deepEqual(readOutKeys(s, file.id), []);
  });

  it("keeps a call the reader made while the READ waited its turn through the READ's first chunk", async () => {
    const s = setup();
    const file = await upload(s, "parcels.xls", big(new Uint8Array(16), "xls"));
    const job = value(await s.store.jobSubmit(RUN, { kind: "read", params: { files: [file] }, requestKey: "read-queued" })).job;
    const { key } = value(await s.store.jobKey(RUN, job.id, { key: newKey() }));
    assert.equal(value(await s.store.readState(RUN, job.id, key)).state, "waiting");
    const at = value(await s.store.job(RUN, job.id)).job.progress?.readerAt;
    assert.ok(at);
    await s.store.alarm();
    assert.equal(value(await s.store.readState(RUN, job.id, key)).state, "taking");
    assert.ok(value(await s.store.job(RUN, job.id)).job.progress?.readerAt);
  });

  it("keeps each of the reader's calls on the job, and none of the store's own runs of it", async () => {
    const s = setup();
    const file = await upload(s, "parcels.xls", big(new Uint8Array(16), "xls"));
    const read = await startRead(s, [file]);
    assert.equal(value(await s.store.job(RUN, read.jobId)).job.progress?.readerAt, undefined);
    s.clock.advance(60_000);
    await s.store.alarm();
    assert.equal(value(await s.store.job(RUN, read.jobId)).job.progress?.readerAt, undefined, "the store's own run of the job");
    value(await s.store.readState(RUN, read.jobId, read.key));
    const at = value(await s.store.job(RUN, read.jobId)).job.progress?.readerAt;
    assert.equal(at, new Date(s.clock.now()).toISOString());
  });

  sampled("parcels-titled.xls")("takes a page sent twice once, and refuses a page out of order and a table that came before", async () => {
    const s = setup();
    const bytes = fixture("parcels-titled.xls");
    const file = await upload(s, "parcels.xls", big(bytes, "xls"));
    const read = await startRead(s, [file]);
    const opened = await openFile("parcels.xls", { size: bytes.byteLength, read: async (o, l) => bytes.subarray(o, o + l) });
    value(await s.store.readBegin(RUN, read.jobId, read.key, { file: 0, reader: READER, format: "xls", tables: opened.tables, notes: opened.notes }));
    const first = (await readPagesOf(opened).next()).value!;
    const sent = { file: 0, page: 1, table: first.table, rows: first.rows };
    assert.deepEqual(value(await s.store.readPage(RUN, read.jobId, read.key, sent)), { page: 1 });
    assert.deepEqual(value(await s.store.readPage(RUN, read.jobId, read.key, sent)), { page: 1 });
    assert.equal(code(await s.store.readPage(RUN, read.jobId, read.key, { ...sent, page: 3 })), "read_page_order");
    if (opened.tables.length > 1) {
      value(await s.store.readPage(RUN, read.jobId, read.key, { ...sent, page: 2, table: opened.tables.length - 1, rows: [[2, opened.tables.at(-1)!.columns.map(() => "x")]] }));
      assert.equal(code(await s.store.readPage(RUN, read.jobId, read.key, { ...sent, page: 3 })), "read_table_order");
    }
    // The end counts the rows the store took.
    assert.equal(code(await s.store.readEnd(RUN, read.jobId, read.key, { file: 0, rows: 999_999 })), "read_rows_differ");
  });

  sampled("parcels-titled.xls")("refuses a key a newer reader took, and the newer one goes on after the pages the store holds", async () => {
    const s = setup();
    const bytes = fixture("parcels-titled.xls");
    const file = await upload(s, "parcels.xls", big(bytes, "xls"));
    const read = await startRead(s, [file]);
    const stopped = await readAs(s, read, 0, bytes, "parcels.xls", { stopAfter: 1 });
    assert.equal(stopped, 1);
    const { key } = value(await s.store.jobKey(RUN, read.jobId, { key: newKey() }));
    assert.equal(code(await s.store.readState(RUN, read.jobId, read.key)), "job_key_refused");
    const opened = await openFile("parcels.xls", { size: bytes.byteLength, read: async (o, l) => bytes.subarray(o, o + l) });
    // The same build goes on after the page the store holds; another build begins the file anew.
    assert.deepEqual(value(await s.store.readBegin(RUN, read.jobId, key, { file: 0, reader: READER, format: "xls", tables: opened.tables, notes: opened.notes })), { page: 1 });
    assert.deepEqual(value(await s.store.readBegin(RUN, read.jobId, key, { file: 0, reader: "another build", format: "xls", tables: opened.tables, notes: opened.notes })), { page: 0 });
    await readAs(s, { jobId: read.jobId, key }, 0, bytes, "parcels.xls", { reader: "another build" });
    const done = await ended(s, read.jobId);
    assert.equal(done.state, "done", done.error ?? "");
    // Only the read-out the manifest names stays: the stopped one's parts went.
    const prefixes = new Set(readOutKeys(s, file.id).filter((k) => !k.endsWith("manifest.json")).map((k) => k.split("/").at(-2)));
    assert.equal(prefixes.size, 1);
  });

  it("gives the reader's words for a file it could not read, and LOAD gives them too", async () => {
    const s = setup();
    const file = await upload(s, "old-permits.mdb", big(new TextEncoder().encode("\0\x01\0\0Standard Jet DB\0"), "access"));
    const read = await startRead(s, [file]);
    const message = "This Access database could not be read: its first page is damaged.";
    value(await s.store.readSkip(RUN, read.jobId, read.key, { file: 0, reason: "damaged", message }));
    const done = await ended(s, read.jobId);
    assert.deepEqual((done.result as ReadResult).files.map((f) => f.unread), [message]);
    const loaded = await load(s, [{ ...file, readOut: read.jobId }]);
    assert.deepEqual((loaded.result as LoadResult).skipped, [{ file: "old-permits.mdb", why: message }]);
  });

  sampled("parcels-titled.xls")("ends a file no longer in the store at once, and reads the others; a file that ended takes no beginning", async () => {
    const s = setup();
    const bytes = fixture("parcels-titled.xls");
    const a = await upload(s, "parcels.xls", big(bytes, "xls"));
    const b = await upload(s, "parcels-2.xls", big(bytes, "xls"));
    value(await s.store.fileDelete(PERSON, a.id));
    const both = await startRead(s, [a, b]);
    const state: ReadState = value(await s.store.readState(RUN, both.jobId, both.key));
    assert.deepEqual(state.files.map((f) => f.ended), [true, false]);
    assert.equal(code(await s.store.readBegin(RUN, both.jobId, both.key, { file: 0, reader: READER, format: "xls", tables: [], notes: [] })), "read_file_ended");
    await readAs(s, both, 1, bytes, "parcels-2.xls");
    const done = await ended(s, both.jobId);
    assert.deepEqual((done.result as ReadResult).files.map((f) => [f.name, f.unread ?? null, f.rows > 0]), [
      ["parcels.xls", "parcels.xls is no longer in this store, or its upload has not finished.", false],
      ["parcels-2.xls", null, true],
    ]);
  });

  sampled("parcels-titled.xls")("gives the reader a file's bytes only while it still reads that file", async () => {
    const s = setup();
    const bytes = fixture("parcels-titled.xls");
    const file = await upload(s, "parcels.xls", big(bytes, "xls"));
    const read = await startRead(s, [file]);
    const target = value(await s.store.readFileTarget(RUN, read.jobId, read.key, 1));
    assert.equal(target.size, WHOLE_FILE_CAPS.xls + 1024);
    assert.equal(code(await s.store.readFileTarget(RUN, read.jobId, read.key, 2)), "not_found");
    await readAs(s, read, 0, bytes, "parcels.xls");
    assert.equal(code(await s.store.readFileTarget(RUN, read.jobId, read.key, 1)), "read_file_ended");
  });

  sampled("parcels-titled.xls")("fails with the reader's words, and what it wrote of an unfinished file goes", async () => {
    const s = setup();
    const bytes = fixture("parcels-titled.xls");
    const file = await upload(s, "parcels.xls", big(bytes, "xls"));
    const read = await startRead(s, [file]);
    await readAs(s, read, 0, bytes, "parcels.xls", { stopAfter: 1 });
    assert.ok(readOutKeys(s, file.id).length > 0);
    value(await s.store.readFail(RUN, read.jobId, read.key, { code: "internal", message: "The reader ran out of memory." }));
    const done = await ended(s, read.jobId);
    assert.equal(done.state, "failed");
    assert.match(done.error ?? "", /ran out of memory/);
    assert.deepEqual(readOutKeys(s, file.id), []);
  });

  sampled("parcels-titled.xls")("takes a deleted file's read-out when it takes the file's bytes", async () => {
    const s = setup();
    const bytes = fixture("parcels-titled.xls");
    const file = await upload(s, "parcels.xls", big(bytes, "xls"));
    const kept = await upload(s, "parcels-kept.xls", big(bytes, "xls"));
    const read = await startRead(s, [file, kept]);
    await readAs(s, read, 0, bytes, "parcels.xls");
    await readAs(s, read, 1, bytes, "parcels-kept.xls");
    await ended(s, read.jobId);
    assert.ok(readOutKeys(s, file.id).length > 1);

    value(await s.store.fileDelete(PERSON, file.id));
    // A deleted file is kept a while: its read-out with it.
    await s.store.alarm();
    assert.ok(readOutKeys(s, file.id).length > 1);
    s.clock.advance(FILE_KEEP_DELETED_MS + 60_000);
    await s.store.alarm();
    assert.deepEqual(readOutKeys(s, file.id), []);
    assert.ok(readOutKeys(s, kept.id).length > 1, "the other file's read-out stays");
  });
});
