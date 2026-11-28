// LOAD and SHAPE in a store's object, through its own job runner (jobs/runner.ts), on the stand-ins
// for its storage, its bucket and its alarms, with the real sample files of store-readers:
// what tables a town's files make, in how many chunks, what a chunk cut short leaves, what loading
// again keeps, and what SHAPE makes and keeps.

import { describe, it, host, stateOf, filesOf, whereBilled, itWhere } from "../../testing/suite/host.js";
import { countingHex, FakeBudget, FakeClock } from "../../testing/suite/stand-ins.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { StoreDeps } from "../core.js";
import { StoreHandler } from "../handler.js";
import type { StoreCaller, StoreResult } from "../types.js";
import { codePageKey, LOADED_GROUP, type LoadParams, type LoadResult, type LoadState, loadHandler, loadTablesProgress } from "./load.js";
import { SAMPLE_GROUP } from "../../../store-readers/src/pull.js";
import { shapeHandler, shapeKey } from "./shape.js";
import { PARK_AFTER_MS } from "../park.js";
import { JOB_HANDLERS } from "./index.js";
import type { JobHandler } from "./types.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "store-readers", "fixtures");
const STORE = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PERSON: StoreCaller = { storeId: STORE, actor: "user:u-1", org: "org-1" };
const RUN: StoreCaller = { storeId: STORE, actor: "run:mrn-1", org: "org-1" };

/**
 * A store whose clock moves `tick` ms each time something reads it, so a chunk ends after a few reads.
 * With `budget`, it counts toward its organization's budget (write-limit.ts).
 */
function setup(opts: { tick?: number; limit?: number; budget?: FakeBudget; jobs?: ReadonlyMap<string, JobHandler> } = {}) {
  const clock = new FakeClock();
  const storage = host().storage();
  const now = opts.tick ? () => (clock.advance(opts.tick!), clock.now()) : clock.now;
  storage.now = now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const budget = opts.budget;
  const deps: StoreDeps = {
    now,
    randomHex: countingHex,
    jobs: opts.jobs ?? new Map<string, JobHandler>([[loadHandler.kind, loadHandler as JobHandler], [shapeHandler.kind, shapeHandler as JobHandler]]),
    ...(budget ? { writeBudget: () => budget } : {}),
  };
  const store = new StoreHandler(state as never, { FILES: r2.asBucket(), ...(opts.limit ? { STORE_DAILY_WRITE_LIMIT: String(opts.limit) } : {}) }, deps);
  return { clock, storage, r2, store };
}

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

/**
 * `it`, for a test that reads sample files: listed as skipped where one of them is missing. A copy
 * of this suite made for another repository holds only the sample files that are text.
 */
function sampled(...names: string[]) {
  const missing = names.find((name) => !existsSync(join(FIXTURES, name)));
  return itWhere(missing === undefined, `this copy of the suite has no sample file ${missing}`);
}

/** A file put into the store as a page puts it: one part. */
async function upload(s: ReturnType<typeof setup>, name: string, bytes: Uint8Array): Promise<{ id: string; name: string }> {
  const created = value(await s.store.fileCreate(PERSON, { name, size: bytes.byteLength, contentType: "application/octet-stream" }));
  const target = value(await s.store.filePartTarget(PERSON, created.file.id, 1));
  const part = await s.r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, bytes);
  value(await s.store.fileComplete(PERSON, created.file.id, { parts: [{ n: 1, etag: part.etag }] }));
  return { id: created.file.id, name: created.file.name };
}

/** Submits a job and runs the store's alarms until it ends; answers the job and how many alarms (chunks) it took. */
async function runJob(s: ReturnType<typeof setup>, body: { kind: string; params: unknown; requestKey: string }) {
  const job = value(await s.store.jobSubmit(RUN, body)).job;
  // The store keeps an alarm for its other work too, so the loop ends when the job does.
  let alarms = 0;
  let ended = job;
  while (alarms < 2000 && (ended.state === "queued" || ended.state === "running")) {
    await s.store.alarm();
    s.clock.advance(5_000);
    alarms++;
    ended = value(await s.store.job(RUN, job.id)).job;
  }
  return { job: ended, chunks: alarms };
}

const rows = (s: ReturnType<typeof setup>, sql: string) => s.storage.sql.exec(sql).toArray().map((r) => ({ ...r }));

/**
 * Counts the rows a store's statements write from now on, as each statement's cursor says
 * (`rowsWritten`): all of them, and the data rows LOAD inserts into a table's new version. The
 * stand-in counts as workerd does (testing/fakes.ts): index entries, a CREATE TABLE AS's rows, a
 * CREATE INDEX's rows and a RENAME included.
 */
function countWrites(s: ReturnType<typeof setup>): { all: number; data: number } {
  const sql = s.storage.sql;
  const exec = sql.exec.bind(sql);
  const counts = { all: 0, data: 0 };
  sql.exec = ((query: string, ...bindings: unknown[]) => {
    const cursor = exec(query, ...bindings);
    counts.all += cursor.rowsWritten;
    if (/^INSERT INTO "[^"]+__new"/.test(query)) counts.data += cursor.rowsWritten;
    return cursor;
  }) as typeof sql.exec;
  return counts;
}
const madeBy = { runId: "mrn-1", step: "s1" };

describe("LOAD", () => {
  sampled("permits-utf8.csv", "permits.xlsx", "permits-2010.accdb", "permits-vfp.dbf", "permits-vfp.fpt")("loads a town's files into one table of text per sheet or table, each row with its file and its row", async () => {
    const s = setup();
    const csv = await upload(s, "permits-utf8.csv", fixture("permits-utf8.csv"));
    const xlsx = await upload(s, "permits.xlsx", fixture("permits.xlsx"));
    const accdb = await upload(s, "permits-2010.accdb", fixture("permits-2010.accdb"));
    const dbf = await upload(s, "permits-vfp.dbf", fixture("permits-vfp.dbf"));
    const fpt = await upload(s, "permits-vfp.fpt", fixture("permits-vfp.fpt"));
    const pdf = await upload(s, "scan.pdf", new TextEncoder().encode("%PDF-1.7\n%âã\n1 0 obj"));
    const { job } = await runJob(s, { kind: "load", params: { files: [csv, xlsx, accdb, { ...dbf, memo: fpt }, pdf], madeBy }, requestKey: "store_load:mrn-1:s1@" });
    assert.equal(job.state, "done", job.error ?? "");
    const result = job.result as LoadResult;
    assert.deepEqual(
      result.tables.map((t) => [t.table, t.version, t.rows, t.file, t.sheet]),
      [
        ["permits_utf8", 1, 4, "permits-utf8.csv", null],
        ["permits__permits", 1, 4, "permits.xlsx", "Permits"],
        ["permits__owners", 1, 2, "permits.xlsx", "Owners"],
        ["permits__lookups", 1, 1, "permits.xlsx", "Lookups"],
        ["permits__wide", 1, 2, "permits.xlsx", "Wide"],
        ["permits_2010__permits", 1, 5, "permits-2010.accdb", "Permits"],
        ["permits_2010__owners", 1, 3, "permits-2010.accdb", "Owners"],
        ["permits_2010__wide", 1, 3, "permits-2010.accdb", "Wide"],
        ["permits_vfp", 1, 5, "permits-vfp.dbf", null],
      ],
    );
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!.why, /^scan\.pdf is not a kind of file a store loads/);
    assert.deepEqual(rows(s, `SELECT "_file", "_row", "Owner", "Fee", "Notes" FROM permits_utf8 ORDER BY "_row"`), [
      { _file: csv.id, _row: 2, Owner: "Rosa Delgado", Fee: "150.00", Notes: "Deck addition.\r\nRear yard, 12 x 16 ft." },
      { _file: csv.id, _row: 3, Owner: "Peña Holdings LLC", Fee: "2250.50", Notes: 'Mixed use: "retail" on the ground floor.' },
      { _file: csv.id, _row: 5, Owner: "Désirée Okafor", Fee: null, Notes: null },
      { _file: csv.id, _row: 6, Owner: "Tomás Brennan", Fee: "75.25", Notes: "Fence, 6 ft." },
    ]);
    assert.deepEqual(rows(s, `SELECT "PERMITNO", "FEE", "NOTES" FROM permits_vfp WHERE "_row" = 4`), [{ PERMITNO: "BP-2019-0004", FEE: "75.25", NOTES: "Fence, 6 ft, along the north line.".repeat(20) }]);
    // Each row is named across loads by its "Permit No" (the first column that reads like an
    // identifier, different in every row), and carries a hash of its values.
    assert.deepEqual(
      rows(s, `SELECT "_key" FROM permits_utf8 ORDER BY "_row"`).map((r) => r._key),
      ["BP-2019-0001", "BP-2019-0002", "BP-2019-0003", "BP-2019-0004"],
    );
    assert.ok(rows(s, `SELECT "_hash" FROM permits_utf8`).every((r) => /^[0-9a-f]{16}$/.test(String(r._hash))));
    const wide = rows(s, `SELECT * FROM permits_2010__wide WHERE "_row" = 2`)[0]!;
    assert.equal(Object.keys(wide).length, 95);
    assert.equal(JSON.parse(String(wide._extra)).F120, "r2c120");
    // The catalog: each table in its group, made by the run's step, with the town's own types.
    const catalog = value(await s.store.catalog(PERSON));
    const vfp = catalog.tables.find((t) => t.name === "permits_vfp")!;
    assert.equal(vfp.kind, "program");
    assert.equal(vfp.group, "From the town");
    assert.deepEqual([vfp.madeBy?.runId, vfp.madeBy?.step], ["mrn-1", "s1"]);
    assert.equal(vfp.columns.find((c) => c.name === "FEE")?.originalType, "Y");
    assert.equal(vfp.columns.find((c) => c.name === "ISSUED")?.originalType, "D");
    // Every table a LOAD made is in the catalog, a sheet of 93 columns too: workerd answers at most
    // 100 columns a query, which the catalog's profile of a table must stay within.
    assert.deepEqual(
      catalog.tables.filter((t) => t.kind === "program").map((t) => t.name).sort(),
      result.tables.map((t) => t.table).sort(),
    );
    const wideTable = catalog.tables.find((t) => t.name === "permits_2010__wide")!;
    assert.equal(wideTable.columns.length, 95);
    assert.equal(wideTable.count, 3);
    assert.equal(wideTable.columns.find((c) => c.name === "_extra")?.filled, 1);
    assert.deepEqual(result.tables.find((t) => t.table === "permits_vfp")!.notes, ["Read as a Visual FoxPro table in Windows-1252.", "1 row was marked deleted in the file, and was not loaded."]);
    assert.deepEqual(rows(s, "SELECT name FROM sqlite_master WHERE name LIKE '%\\_\\_new' ESCAPE '\\'"), []);
  });

  sampled("wrenfield.dbc", "bldgperm.dbf", "inspect.dbf")("names a Visual FoxPro database's tables and columns by the long names in its container", async () => {
    const s = setup();
    const dbc = await upload(s, "wrenfield.dbc", fixture("wrenfield.dbc"));
    const permits = await upload(s, "bldgperm.dbf", fixture("bldgperm.dbf"));
    const inspections = await upload(s, "inspect.dbf", fixture("inspect.dbf"));
    const files = [
      { ...permits, dbc: { id: dbc.id } },
      { ...inspections, dbc: { id: dbc.id } },
    ];
    const { job } = await runJob(s, { kind: "load", params: { files, madeBy }, requestKey: "store_load:mrn-dbc:s1@" });
    assert.equal(job.state, "done", job.error ?? "");
    const result = job.result as LoadResult;
    assert.deepEqual(
      result.tables.map((t) => [t.table, t.rows, t.file]),
      [
        ["building_permits", 8, "bldgperm.dbf"],
        ["inspection_results", 5, "inspect.dbf"],
      ],
    );
    assert.deepEqual(rows(s, `SELECT "permit_number", "contractor_license_number", "permit_fee_amount" FROM building_permits ORDER BY "_row" LIMIT 2`), [
      { permit_number: "BP-2019-00412", contractor_license_number: "WC-88213", permit_fee_amount: "245.50" },
      { permit_number: "BP-2019-00413", contractor_license_number: "WC-80377", permit_fee_amount: "1180.00" },
    ]);
    // The same files loaded again keep their tables, and write none of their rows: the long names are the tables' own.
    const writes = countWrites(s);
    const again = await runJob(s, { kind: "load", params: { files, madeBy }, requestKey: "store_load:mrn-dbc:s2@" });
    assert.deepEqual(
      (again.job.result as LoadResult).tables.map((t) => [t.table, t.version, t.changes]),
      [
        ["building_permits", 1, { added: 0, changed: 0, removed: 0 }],
        ["inspection_results", 1, { added: 0, changed: 0, removed: 0 }],
      ],
    );
    assert.equal(writes.data, 0, "no row of either table changed");
    // A table uploaded again alone finds the container its header names among the store's files.
    const refreshed = await upload(s, "bldgperm.dbf", fixture("bldgperm.dbf"));
    const alone = await runJob(s, { kind: "load", params: { files: [refreshed], madeBy }, requestKey: "store_load:mrn-dbc:s3@" });
    assert.deepEqual((alone.job.result as LoadResult).tables.map((t) => t.table), ["building_permits"]);
    // A copy of a table under another file's name keeps that name: the long name's table holds another file's rows.
    const copy = await upload(s, "inspect_2019.dbf", fixture("inspect.dbf"));
    const copied = await runJob(s, { kind: "load", params: { files: [{ ...copy, dbc: { id: dbc.id } }], madeBy }, requestKey: "store_load:mrn-dbc:s4@" });
    assert.deepEqual((copied.job.result as LoadResult).tables.map((t) => t.table), ["inspect_2019"]);
  });

  sampled("wrenfield.dbc", "bldgperm.dbf")("keeps loading a FoxPro table into the table it filled before its database's container came", async () => {
    const s = setup();
    const permits = await upload(s, "bldgperm.dbf", fixture("bldgperm.dbf"));
    const first = await runJob(s, { kind: "load", params: { files: [permits], madeBy }, requestKey: "store_load:mrn-old:s1@" });
    assert.deepEqual((first.job.result as LoadResult).tables.map((t) => t.table), ["bldgperm"]);
    assert.ok(Object.keys(rows(s, "SELECT * FROM bldgperm LIMIT 1")[0]!).includes("PERMIT_NUM"));
    const dbc = await upload(s, "wrenfield.dbc", fixture("wrenfield.dbc"));
    const later = await runJob(s, { kind: "load", params: { files: [{ ...permits, dbc: { id: dbc.id } }], madeBy }, requestKey: "store_load:mrn-old:s2@" });
    const table = (later.job.result as LoadResult).tables[0]!;
    // The table a program reads stays where it is; its columns take their long names, and it says why its name stays.
    assert.equal(table.table, "bldgperm");
    assert.ok(Object.keys(rows(s, "SELECT * FROM bldgperm LIMIT 1")[0]!).includes("permit_number"));
    assert.ok(table.notes.includes("Its database names it building_permits. It keeps the name it was first loaded under, bldgperm."), table.notes.join(" | "));
    assert.equal(rows(s, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'building_permits'").length, 0);
  });

  sampled("wrenfield.dbc", "cornershop.dbc", "bldgperm.dbf", "inspect.dbf")("keeps a long name's table its file's, parked or not, and reads a table with the container of its database among several of one name", async () => {
    const s = setup({ jobs: JOB_HANDLERS });
    const dbc = await upload(s, "wrenfield.dbc", fixture("wrenfield.dbc"));
    const inspect = await upload(s, "inspect.dbf", fixture("inspect.dbf"));
    await runJob(s, { kind: "load", params: { files: [{ ...inspect, dbc: { id: dbc.id } }], madeBy }, requestKey: "store_load:mrn-own:s1@" });
    // A program reads the table, and it parks: its rows leave the store's database.
    const columns = ["_file", "_row", "_key", "_hash", "permit_number", "inspection_date", "inspector_full_name", "inspection_outcome_code"];
    await runJob(s, { kind: "shape", params: { into: "inspections_clean", sql: `SELECT "_key", "_file", "_row", permit_number FROM inspection_results`, goal: "inspections", sources: JSON.stringify([["inspection_results", columns]]), madeBy }, requestKey: "store_shape:mrn-own:s2@" });
    s.clock.advance(PARK_AFTER_MS + 1_000);
    for (let k = 0; k < 20; k++) {
      await s.store.alarm();
      s.clock.advance(5_000);
    }
    assert.equal(rows(s, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inspection_results'").length, 0, "the table parked");
    // Another file of the same layout keeps its own name: LOAD's record says whose rows the parked table holds.
    const copy = await upload(s, "insp_archive.dbf", fixture("inspect.dbf"));
    const copied = await runJob(s, { kind: "load", params: { files: [{ ...copy, dbc: { id: dbc.id } }], madeBy }, requestKey: "store_load:mrn-own:s3@" });
    assert.deepEqual((copied.job.result as LoadResult).tables.map((t) => t.table), ["insp_archive"]);
    // A file whose own name is that long name takes the next free name beside it.
    const csv = await upload(s, "inspection_results.csv", new TextEncoder().encode("permit_number,outcome\nBP-1,PASS\n"));
    const named = await runJob(s, { kind: "load", params: { files: [csv], madeBy }, requestKey: "store_load:mrn-own:s4@" });
    assert.deepEqual((named.job.result as LoadResult).tables.map((t) => t.table), ["inspection_results_2"]);
    // A second database's container of the same file name, newer: a table uploaded alone takes the one whose tables fit.
    await upload(s, "wrenfield.dbc", fixture("cornershop.dbc"));
    const permits = await upload(s, "bldgperm.dbf", fixture("bldgperm.dbf"));
    const alone = await runJob(s, { kind: "load", params: { files: [permits], madeBy }, requestKey: "store_load:mrn-own:s5@" });
    assert.deepEqual((alone.job.result as LoadResult).tables.map((t) => t.table), ["building_permits"]);
  });

  sampled("permits-libre.ods", "parcels.geojson", "inspections.jsonl", "permits-access.xml", "town.sqlite", "permits-snappy.parquet", "town-export.zip")("loads OpenDocument, JSON, XML, SQLite and Parquet files, and a zip of a town's export, one table per table each holds", async () => {
    const s = setup();
    const files = [];
    for (const name of ["permits-libre.ods", "parcels.geojson", "inspections.jsonl", "permits-access.xml", "town.sqlite", "permits-snappy.parquet", "town-export.zip"]) files.push(await upload(s, name, fixture(name)));
    const writes = countWrites(s);
    const { job } = await runJob(s, { kind: "load", params: { files, madeBy }, requestKey: "store_load:mrn-1:s2@" });
    assert.equal(job.state, "done", job.error ?? "");
    const result = job.result as LoadResult;
    assert.deepEqual(result.skipped, []);
    // Each row of every file is written once. The other rows, counted as workerd counts them (the
    // stand-in adds each index entry and each RENAME's 5): the catalog's, mostly a row and its key's
    // entry for each column of each table (882), and for each of the 61 columns two wide tables
    // packed into `_extra` (122), the job's progress, history and version swaps, and
    // what lets the next load name only the rows that changed: a hash of each row (77) and each
    // table's change (52). The last 4 keep the store's count of rows written: its row and its key's
    // entry, each of the two times it is kept (write-limit.ts). One more is the job's entry in the
    // index that finds a run's jobs.
    const loaded = result.tables.reduce((n, t) => n + t.rows, 0);
    // A run's load keeps each table it made as the run's change, for Undo This Run (program-tables.ts):
    // a row of `_changes` with its index entries, and the store's last change number, 6 a table, 156
    // for these 26.
    whereBilled(() => assert.deepEqual([loaded, writes.data, writes.all, result.tables.length], [77, 77, 1682 + 156, 26]));
    const made = new Map(result.tables.map((t) => [t.table, t]));
    assert.deepEqual([...made.keys()].filter((t) => !t.startsWith("town__") && !t.startsWith("permits_snappy")), [
      "permits_libre__permits",
      "permits_libre__lookups",
      "parcels",
      "inspections",
      "permits_access",
      "town_export__permits_utf8",
      "town_export__owners",
      "town_export__permits_permits",
      "town_export__permits_owners",
      "town_export__permits_lookups",
      "town_export__permits_wide",
      "town_export__budget_permits_libre_permits",
      "town_export__budget_permits_libre_lookups",
      "town_export__t_2019_inspections",
      "town_export__t_2019_permits_1252",
    ]);
    assert.deepEqual(rows(s, `SELECT "_row", "ZIP", "Fee", "Notes" FROM permits_libre__permits ORDER BY "_row"`), [
      { _row: 2, ZIP: "06804", Fee: "150", Notes: "Deck addition.\nRear yard,  12 x 16 ft." },
      { _row: 3, ZIP: "06801", Fee: "2250.5", Notes: null },
      { _row: 6, ZIP: "06804", Fee: null, Notes: null },
      { _row: 7, ZIP: "06804", Fee: null, Notes: null },
    ]);
    assert.deepEqual(rows(s, `SELECT "PARCEL_ID", "ACRES" FROM parcels ORDER BY "_row"`), [
      { PARCEL_ID: "07-112-004", ACRES: "0.25" },
      { PARCEL_ID: "07-201-019", ACRES: "0.61" },
      { PARCEL_ID: "08-004-001", ACRES: "12.405" },
    ]);
    assert.deepEqual(rows(s, `SELECT "_row", "result" FROM inspections ORDER BY "_row"`), [
      { _row: 1, result: "pass" },
      { _row: 2, result: "fail" },
      { _row: 4, result: "pass" },
    ]);
    // The catalog keeps the types the files gave: Access's in its XML export.
    const catalog = value(await s.store.catalog(PERSON));
    const access = catalog.tables.find((t) => t.name === "permits_access")!;
    assert.deepEqual(access.columns.filter((c) => !c.name.startsWith("_")).map((c) => [c.name, c.originalType]), [
      ["Permit No", "text(12)"],
      ["Issued", "datetime"],
      ["Fee", "currency"],
      ["Address", "text(60)"],
      ["Paid", "yesno"],
    ]);
    // Each table of the zip names the file in it that it came from; every row's _file is the zip's.
    assert.deepEqual(made.get("town_export__owners")!.notes.slice(0, 2), ["town-export.zip also holds 2 files a store does not load: map.pdf, parcels.shp.", "From OWNERS.DBF in the zip."]);
    const zip = files.find((f) => f.name === "town-export.zip")!;
    assert.deepEqual(rows(s, `SELECT DISTINCT "_file" FROM town_export__t_2019_inspections`), [{ _file: zip.id }]);
    assert.deepEqual(rows(s, "SELECT name FROM sqlite_master WHERE name LIKE '%\\_\\_new' ESCAPE '\\'"), []);
  });

  sampled("town-export.zip")("loads a zip in many short chunks the same rows as in one, writing each row once", async () => {
    const one = setup();
    const f1 = await upload(one, "town-export.zip", fixture("town-export.zip"));
    const oneWrites = countWrites(one);
    const whole = await runJob(one, { kind: "load", params: { files: [f1], madeBy }, requestKey: "a" });
    const many = setup({ tick: 4_000 });
    const f2 = await upload(many, "town-export.zip", fixture("town-export.zip"));
    const manyWrites = countWrites(many);
    const chunked = await runJob(many, { kind: "load", params: { files: [f2], madeBy }, requestKey: "a" });
    assert.equal(chunked.job.state, "done", chunked.job.error ?? "");
    assert.ok(chunked.chunks > whole.chunks, `${chunked.chunks} chunks against ${whole.chunks}`);
    // Each row is written once however many chunks the load takes; a chunk adds one row of the job's progress.
    const loaded = (whole.job.result as LoadResult).tables.reduce((n, t) => n + t.rows, 0);
    assert.deepEqual([oneWrites.data, manyWrites.data], [loaded, loaded]);
    assert.equal(manyWrites.all - oneWrites.all, chunked.chunks - whole.chunks);
    const tables = (whole.job.result as LoadResult).tables.map((t) => t.table);
    assert.deepEqual((chunked.job.result as LoadResult).tables.map((t) => t.table), tables);
    for (const t of tables) {
      const all = (s: ReturnType<typeof setup>) => rows(s, `SELECT * FROM "${t}" ORDER BY "_row"`).map(({ _file: _, ...r }) => r);
      assert.deepEqual(all(many), all(one), t);
    }
  });

  it("loads in many short chunks the same rows as in one", async () => {
    const lines = ["Permit No,Owner,Fee"];
    for (let i = 1; i <= 5000; i++) lines.push(`BP-${i},"Owner ${i}, Jr.",${i}.50`);
    const big = new TextEncoder().encode(lines.join("\r\n"));
    const one = setup();
    const f1 = await upload(one, "permits.csv", big);
    const whole = await runJob(one, { kind: "load", params: { files: [f1], madeBy }, requestKey: "a" });
    const many = setup({ tick: 4_000 });
    const f2 = await upload(many, "permits.csv", big);
    const chunked = await runJob(many, { kind: "load", params: { files: [f2], madeBy }, requestKey: "a" });
    assert.equal(chunked.job.state, "done", chunked.job.error ?? "");
    assert.ok(chunked.chunks > whole.chunks + 2, `${chunked.chunks} chunks against ${whole.chunks}`);
    const key = (s: ReturnType<typeof setup>) => rows(s, `SELECT "_row", "Permit No", "Owner", "Fee" FROM permits ORDER BY "_row"`);
    assert.deepEqual(key(many), key(one));
    assert.deepEqual(rows(many, `SELECT count(*) AS n, count(DISTINCT "_row") AS d FROM permits`), [{ n: 5000, d: 5000 }]);
  });

  it("loads a file again in many short chunks the same as in one, keys repeated batches apart included", async () => {
    // 5,000 permits; rows 4,998 to 5,000 repeat BP-8 to BP-10, in the third batch.
    const csv = (line: (i: number) => string | null) => {
      const lines = ["Permit No,Owner,Fee"];
      for (let i = 1; i <= 5000; i++) {
        const l = line(i);
        if (l !== null) lines.push(l);
      }
      return new TextEncoder().encode(lines.join("\r\n"));
    };
    const first = (i: number) => `BP-${i > 4997 ? i - 4990 : i},Owner ${i},${i}.50`;
    // Permit 2 is withdrawn; permit 9's owner changes, and so does the row that repeats it.
    const again = (i: number) => (i === 2 ? null : i === 9 ? "BP-9,Owner nine,9.50" : i === 4999 ? "BP-9,Owner 4999 again,1.00" : first(i));
    const twice = async (s: ReturnType<typeof setup>) => {
      const f1 = await upload(s, "permits.csv", csv(first));
      await runJob(s, { kind: "load", params: { files: [f1], madeBy }, requestKey: "a" });
      const f2 = await upload(s, "permits.csv", csv(again));
      const writes = countWrites(s);
      const ran = await runJob(s, { kind: "load", params: { files: [f2], madeBy }, requestKey: "b" });
      assert.equal(ran.job.state, "done", ran.job.error ?? "");
      return { ...ran, writes };
    };
    const one = setup();
    const a = await twice(one);
    const many = setup({ tick: 4_000 });
    const b = await twice(many);
    assert.ok(b.chunks > a.chunks + 2, `${b.chunks} chunks against ${a.chunks}`);
    for (const ran of [a, b]) {
      assert.deepEqual((ran.job.result as LoadResult).tables.map((t) => [t.version, t.rows, t.changes]), [[1, 4999, { added: 0, changed: 2, removed: 1 }]]);
      assert.equal(ran.writes.data, 0, "no table is made anew");
    }
    const keyed = (s: ReturnType<typeof setup>) => rows(s, `SELECT "_key", "_hash", "Owner", "Fee" FROM permits ORDER BY "_key"`);
    assert.deepEqual(keyed(many), keyed(one));
    assert.deepEqual(rows(one, `SELECT "_key", "Owner" FROM permits WHERE "Permit No" = 'BP-9' ORDER BY "_key"`), [
      { _key: "BP-9", Owner: "Owner nine" },
      { _key: "BP-9#2", Owner: "Owner 4999 again" },
    ]);
  });

  it("goes on from its last batch when a chunk fails partway, and writes no row twice", async () => {
    // Some 3 MB: a batch reads on in a 1 MB window, so the file takes several reads.
    const lines = ["Permit No,Owner"];
    for (let i = 1; i <= 150_000; i++) lines.push(`BP-${i},Owner ${i}`);
    const s = setup();
    const f = await upload(s, "permits.csv", new TextEncoder().encode(lines.join("\n")));
    // The bucket fails the fourth read of the file: the chunk that asked throws, and the runner tries it again.
    const get = s.r2.get.bind(s.r2);
    let reads = 0;
    s.r2.get = (async (key: string, options?: unknown) => {
      if (key.endsWith("/permits.csv") && ++reads === 4) throw new Error("The bucket did not answer.");
      return get(key, options as never);
    }) as typeof s.r2.get;
    const { job } = await runJob(s, { kind: "load", params: { files: [f], madeBy }, requestKey: "b" });
    assert.equal(job.state, "done", job.error ?? "");
    assert.ok(reads > 4);
    assert.deepEqual(rows(s, `SELECT count(*) AS n, count(DISTINCT "_row") AS d FROM permits`), [{ n: 150_000, d: 150_000 }]);
  });

  sampled("parcels-pipe.txt")("finds a table it swapped in just before a chunk stopped, and does not load it again", async () => {
    const s = setup();
    const f = await upload(s, "parcels-pipe.txt", fixture("parcels-pipe.txt"));
    // The chunk stops right after the swap, before the job's state says the table is made.
    let stopped = false;
    const stopping: JobHandler = {
      kind: "load",
      parse: loadHandler.parse,
      run(ctx) {
        const commit: typeof ctx.commit = (update, write) => {
          const state = update.state as LoadState;
          if (!stopped && state.made.length === 1) {
            stopped = true;
            throw new Error("The object stopped.");
          }
          ctx.commit(update, write);
        };
        return loadHandler.run({ ...ctx, commit } as never);
      },
    };
    const jobs = (s.store as unknown as { core: { deps: StoreDeps } }).core.deps.jobs as Map<string, JobHandler>;
    jobs.set("load", stopping);
    const { job } = await runJob(s, { kind: "load", params: { files: [f], madeBy }, requestKey: "stops" });
    assert.ok(stopped);
    assert.equal(job.state, "done", job.error ?? "");
    assert.deepEqual((job.result as LoadResult).tables.map((t) => [t.table, t.version, t.rows]), [["parcels_pipe", 1, 3]]);
    assert.deepEqual(rows(s, "SELECT name, version FROM _tables WHERE name LIKE 'parcels_pipe%'"), [{ name: "parcels_pipe", version: 1 }]);
    assert.deepEqual(rows(s, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'parcels_pipe%' ORDER BY name").map((r) => r.name), ["parcels_pipe"]);
  });

  sampled("parcels-pipe.txt")("keeps its table and version when the same files load again, writes none of their rows, and finds no row changed", async () => {
    const s = setup();
    const f = await upload(s, "parcels-pipe.txt", fixture("parcels-pipe.txt"));
    const first = await runJob(s, { kind: "load", params: { files: [f], madeBy }, requestKey: "first" });
    assert.equal((first.job.result as LoadResult).tables[0]!.changes, null, "a first load has nothing to compare with");
    const writes = countWrites(s);
    const { job } = await runJob(s, { kind: "load", params: { files: [f], madeBy }, requestKey: "second" });
    assert.deepEqual((job.result as LoadResult).tables.map((t) => [t.table, t.version, t.rows, t.changes]), [["parcels_pipe", 1, 3, { added: 0, changed: 0, removed: 0 }]]);
    // No row changed: no row of the table, no hash and no record of a change is written.
    assert.equal(writes.data, 0);
    assert.deepEqual(rows(s, "SELECT count(*) AS n FROM _deltas WHERE tbl = 'parcels_pipe'"), [{ n: 1 }]);
    // The job's own records: its row, its progress at each step, and its history.
    assert.ok(writes.all < 25, `wrote ${writes.all}`);
    // The town's file is still in the store: a LOAD's table keeps no earlier copy.
    assert.deepEqual(rows(s, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'parcels_pipe%' ORDER BY name").map((r) => r.name), ["parcels_pipe"]);
    // The same request key answers the job it made, and loads nothing again.
    const again = value(await s.store.jobSubmit(RUN, { kind: "load", params: { files: [f], madeBy }, requestKey: "second" })).job;
    assert.equal(again.id, job.id);
  });

  it("leaves out a title above a file's header, and makes the table whole with the real header where the last load took the title for it", async () => {
    const s = setup();
    const enc = (lines: string[]) => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
    const header = "APN,Situs Address,City,ZIP,Zoning,Lot Size (sq ft),Year Built";
    const parcels = ["525-0078-045-00,1412 Oak St,Brookfield,06804,R-1,5000,1924", "432-0028-006-00,88 Mill Pond Rd,Brookfield,06804,R-2,7405.5,1951", "415-0079-072-00,300 Main St,Brookfield,06801,C-1,12000,1988"];
    const title = "Brookfield Assessor - Parcel Extract (generated 03/02/2026, do not edit)";
    // What LOAD made of a sheet with a title before it looked for the header: the title named the
    // first column, the others were numbered, the real header was the first row, and with no column
    // that names a row, each row was named by its hash.
    const before = await upload(s, "parcels.csv", enc([`${title.replace(",", "")},column 2,column 3,column 4,column 5,column 6,column 7`, header, ...parcels]));
    await runJob(s, { kind: "load", params: { files: [before], madeBy }, requestKey: "before" });
    assert.equal(rows(s, "SELECT count(*) AS n FROM parcels")[0]!.n, 4);
    assert.equal(rows(s, "SELECT key_from FROM _tables WHERE name = 'parcels'")[0]!.key_from, "");
    // The town's file, as it is: a title, a blank row, then the header.
    const file = await upload(s, "parcels.csv", enc([`"${title}",,,,,,`, ",,,,,,", header, ...parcels]));
    const { job } = await runJob(s, { kind: "load", params: { files: [file], madeBy }, requestKey: "after" });
    const made = (job.result as LoadResult).tables[0]!;
    assert.deepEqual([made.table, made.version, made.rows, made.changes], ["parcels", 2, 3, null]);
    assert.deepEqual(made.notes, ["Read as UTF-8 text separated by commas.", `Rows 1 and 2, above the header, were left out: "${title}".`]);
    assert.deepEqual(rows(s, "SELECT name FROM pragma_table_info('parcels') ORDER BY cid").map((r) => r.name), ["_file", "_row", "_key", "_hash", ...header.split(",")]);
    // The columns changed, so the key column was chosen again: each row is named by its APN.
    assert.equal(rows(s, "SELECT key_from FROM _tables WHERE name = 'parcels'")[0]!.key_from, "APN");
    assert.deepEqual(rows(s, `SELECT "_row", "_key", "Situs Address" FROM parcels ORDER BY "_row"`), [
      { _row: 4, _key: "525-0078-045-00", "Situs Address": "1412 Oak St" },
      { _row: 5, _key: "432-0028-006-00", "Situs Address": "88 Mill Pond Rd" },
      { _row: 6, _key: "415-0079-072-00", "Situs Address": "300 Main St" },
    ]);
    // Loaded again, the same file keeps the table's version and writes only the rows that changed.
    const again = await upload(s, "parcels.csv", enc([`"${title}",,,,,,`, ",,,,,,", header, parcels[0]!, parcels[1]!.replace("R-2", "R-3"), parcels[2]!]));
    const next = await runJob(s, { kind: "load", params: { files: [again], madeBy }, requestKey: "again" });
    assert.deepEqual((next.job.result as LoadResult).tables.map((t) => [t.version, t.changes]), [[2, { added: 0, changed: 1, removed: 0 }]]);
  });

  it("loads a run on a sample's rows into a table of its own beside the whole data's, which it never changes", async () => {
    const s = setup();
    const enc = (lines: string[]) => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
    const permits = ["Permit,Status", "BP-1,Issued", "BP-2,Final", "BP-3,Issued", "BP-4,Void", "BP-5,Final", "BP-6,Issued"];
    const whole = await upload(s, "permits.csv", enc(permits));
    await runJob(s, { kind: "load", params: { files: [whole], madeBy }, requestKey: "whole" });
    // The rows of these numbers in the file: the header is row 1.
    const chosen = await upload(s, "permits.csv", enc(permits));
    const { job } = await runJob(s, { kind: "load", params: { files: [chosen], madeBy, sample: { records: [5, 3] } }, requestKey: "chosen" });
    const made = (job.result as LoadResult).tables[0]!;
    assert.deepEqual([made.table, made.rows], ["permits_sample", 2]);
    assert.deepEqual(rows(s, `SELECT "_row", "Permit" FROM permits_sample ORDER BY "_row"`), [
      { _row: 3, Permit: "BP-2" },
      { _row: 5, Permit: "BP-4" },
    ]);
    assert.deepEqual(rows(s, "SELECT name, grp FROM _tables WHERE name IN ('permits', 'permits_sample') ORDER BY name"), [
      { name: "permits", grp: LOADED_GROUP },
      { name: "permits_sample", grp: SAMPLE_GROUP },
    ]);
    assert.equal(rows(s, "SELECT count(*) AS n FROM permits")[0]!.n, 6);
    // The first rows, again: the sample's table is made new.
    const first = await upload(s, "permits.csv", enc(permits));
    const next = await runJob(s, { kind: "load", params: { files: [first], madeBy, sample: { rows: 4 } }, requestKey: "first" });
    assert.deepEqual((next.job.result as LoadResult).tables.map((t) => [t.table, t.version, t.rows]), [["permits_sample", 2, 4]]);
    assert.deepEqual(rows(s, `SELECT "Permit" FROM permits_sample ORDER BY "_row"`).map((r) => r.Permit), ["BP-1", "BP-2", "BP-3", "BP-4"]);
    // A code page set for a sample is not kept for the file's later LOADs: the whole data's LOAD keeps it.
    const read = await upload(s, "permits.csv", enc(permits));
    await runJob(s, { kind: "load", params: { files: [{ ...read, codePage: 1252 }], madeBy, sample: { rows: 1 } }, requestKey: "code-page" });
    assert.equal(rows(s, `SELECT count(*) AS n FROM _meta WHERE key = '${codePageKey("permits.csv")}'`)[0]!.n, 0);
    // A pull's sample of the same name is never replaced: this sample goes beside it.
    s.storage.sql.exec("INSERT INTO _jobs (id, kind, request_key, state, params, by_sub, created_at, updated_at) VALUES ('job_pull', 'pull', 'a-pull', 'done', '{}', 'user:u-1', '2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z')");
    s.storage.sql.exec("UPDATE _tables SET made_job = 'job_pull' WHERE name = 'permits_sample'");
    const beside = await runJob(s, { kind: "load", params: { files: [await upload(s, "permits.csv", enc(permits))], madeBy, sample: { rows: 2 } }, requestKey: "beside" });
    assert.deepEqual((beside.job.result as LoadResult).tables.map((t) => [t.table, t.rows]), [["permits_sample_loaded", 2]]);
    assert.equal(rows(s, "SELECT count(*) AS n FROM permits_sample")[0]!.n, 1);
  });

  it("keeps naming a table's rows by their hashes when its file loads again with the same columns", async () => {
    const s = setup();
    const fees = (raise: number) => new TextEncoder().encode(`Fee Code,Amount\n${Array.from({ length: 30 }, (_, i) => `F${i % 7},${i + raise}`).join("\n")}\n`);
    await runJob(s, { kind: "load", params: { files: [await upload(s, "fees.csv", fees(0))], madeBy }, requestKey: "first" });
    assert.equal(rows(s, "SELECT key_from FROM _tables WHERE name = 'fees'")[0]!.key_from, "");
    const { job } = await runJob(s, { kind: "load", params: { files: [await upload(s, "fees.csv", fees(0))], madeBy }, requestKey: "second" });
    assert.deepEqual((job.result as LoadResult).tables.map((t) => [t.version, t.changes]), [[1, { added: 0, changed: 0, removed: 0 }]]);
    assert.equal(rows(s, "SELECT key_from FROM _tables WHERE name = 'fees'")[0]!.key_from, "");
  });

  sampled("parcels-pipe.txt")("names its table beside one a migration made, and never writes that one", async () => {
    const s = setup();
    value(await s.store.migrate(PERSON, { id: "0001_parcels", sql: "CREATE TABLE parcels_pipe (id INTEGER PRIMARY KEY, note TEXT)" }));
    const f = await upload(s, "parcels-pipe.txt", fixture("parcels-pipe.txt"));
    const { job } = await runJob(s, { kind: "load", params: { files: [f], madeBy }, requestKey: "c" });
    assert.deepEqual((job.result as LoadResult).tables.map((t) => t.table), ["parcels_pipe_loaded"]);
    assert.deepEqual(rows(s, "SELECT count(*) AS n FROM parcels_pipe"), [{ n: 0 }]);
  });

  it("loads a batch far wider than the 2 MB a store binds as one value, a row at a time", async () => {
    // 50 columns of 30 characters, 2,500 rows: about 4 MB a batch, which one bound string could not carry.
    const cell = "x".repeat(30);
    const lines = [Array.from({ length: 50 }, (_, i) => `c${i + 1}`).join(","), ...Array.from({ length: 2500 }, (_, r) => Array.from({ length: 50 }, () => `${cell}${r}`).join(","))];
    const s = setup();
    const f = await upload(s, "wide.csv", new TextEncoder().encode(lines.join("\n")));
    const { job } = await runJob(s, { kind: "load", params: { files: [f], madeBy }, requestKey: "wide" });
    assert.equal(job.state, "done", job.error ?? "");
    assert.deepEqual(rows(s, "SELECT count(*) AS n FROM wide"), [{ n: 2500 }]);
  });

  it("cuts the values of a row longer than a store keeps, and says how many", async () => {
    const memo = "Permit notes. ".repeat(250_000); // 3.5 million characters: past a store's 2 MB a row
    const s = setup();
    const f = await upload(s, "notes.csv", new TextEncoder().encode(`Permit No,Notes\nBP-1,${memo}\nBP-2,short\n`));
    const { job } = await runJob(s, { kind: "load", params: { files: [f], madeBy }, requestKey: "long" });
    assert.equal(job.state, "done", job.error ?? "");
    const made = (job.result as LoadResult).tables[0]!;
    assert.match(made.notes.join(" "), /1 value was cut: a store keeps at most 600,000 characters in a row\./);
    const [first, second] = rows(s, `SELECT "Permit No" AS p, length("Notes") AS n FROM notes ORDER BY "_row"`) as { p: string; n: number }[];
    // The long value keeps the most of the row it can; the short one is whole.
    assert.ok(first!.n > 590_000 && first!.n <= 600_000, `kept ${first!.n} characters`);
    assert.deepEqual(second, { p: "BP-2", n: 5 });
  });

  sampled("parcels-pipe.txt")("skips a file deleted while it loaded, keeps what it made, and loads the files after it", async () => {
    const lines = ["Permit No,Owner", ...Array.from({ length: 150_000 }, (_, i) => `BP-${i + 1},Owner ${i + 1}`)];
    // A chunk of a batch or two, so the file is far from loaded when it is deleted.
    const s = setup({ tick: 5_000 });
    const big = await upload(s, "permits.csv", new TextEncoder().encode(lines.join("\n")));
    const parcels = await upload(s, "parcels-pipe.txt", fixture("parcels-pipe.txt"));
    const submitted = value(await s.store.jobSubmit(RUN, { kind: "load", params: { files: [big, parcels], madeBy }, requestKey: "deleted" })).job;
    // A few chunks in, someone deletes the big file on the store's page.
    for (let i = 0; i < 6; i++) {
      await s.store.alarm();
      s.clock.advance(5_000);
    }
    value(await s.store.fileDelete(PERSON, big.id));
    let job = value(await s.store.job(RUN, submitted.id)).job;
    for (let alarms = 0; alarms < 2000 && (job.state === "queued" || job.state === "running"); alarms++) {
      await s.store.alarm();
      s.clock.advance(5_000);
      job = value(await s.store.job(RUN, submitted.id)).job;
    }
    assert.equal(job.state, "done", job.error ?? "");
    const result = job.result as LoadResult;
    assert.deepEqual(result.tables.map((t) => t.table), ["parcels_pipe"]);
    assert.match(result.skipped[0]!.why, /^permits\.csv could not be read on after \d+ rows of permits\.csv: permits\.csv was deleted while it loaded\.$/);
    assert.deepEqual(rows(s, "SELECT name FROM sqlite_master WHERE name LIKE 'permits%'"), []);
  });

  sampled("permits-vfp.dbf")("loads a FoxPro table whose memo file is empty, with its memos empty", async () => {
    const s = setup();
    const dbf = await upload(s, "permits-vfp.dbf", fixture("permits-vfp.dbf"));
    const fpt = await upload(s, "permits-vfp.fpt", new Uint8Array(0));
    const { job } = await runJob(s, { kind: "load", params: { files: [{ ...dbf, memo: fpt }], madeBy }, requestKey: "empty-memo" });
    assert.equal(job.state, "done", job.error ?? "");
    assert.deepEqual(rows(s, `SELECT count(*) AS n, count("NOTES") AS notes FROM permits_vfp`), [{ n: 5, notes: 0 }]);
  });

  sampled("permits-utf8.csv", "parcels-pipe.txt")("names a file's table beside one a SHAPE made, and a file named for SQLite's own tables apart from them", async () => {
    const s = setup();
    const csv = await upload(s, "permits-utf8.csv", fixture("permits-utf8.csv"));
    await runJob(s, { kind: "load", params: { files: [csv], madeBy }, requestKey: "first" });
    const shaped = await runJob(s, { kind: "shape", params: { into: "permits", sql: 'SELECT "Permit No" AS permit_no FROM permits_utf8', goal: null, sources: "[]", madeBy }, requestKey: "shape" });
    assert.equal(shaped.job.state, "done", shaped.job.error ?? "");
    // A file named permits.csv would make `permits`, which the SHAPE made: it loads beside it.
    const same = await upload(s, "permits.csv", fixture("permits-utf8.csv"));
    const sqlite = await upload(s, "SQLite export.csv", fixture("parcels-pipe.txt"));
    const { job } = await runJob(s, { kind: "load", params: { files: [same, sqlite], madeBy }, requestKey: "second" });
    assert.deepEqual((job.result as LoadResult).tables.map((t) => t.table), ["permits_loaded", "t_sqlite_export"]);
    assert.deepEqual(rows(s, "SELECT count(*) AS n FROM permits"), [{ n: 4 }]);
  });

  it("opens each store's file once while another store loads in the same isolate", async () => {
    const lines = ["Permit No,Owner", ...Array.from({ length: 150_000 }, (_, i) => `BP-${i + 1},Owner ${i + 1}`)];
    const bytes = new TextEncoder().encode(lines.join("\n"));
    const count = (s: ReturnType<typeof setup>) => {
      const get = s.r2.get.bind(s.r2);
      const reads = { n: 0 };
      s.r2.get = (async (key: string, options?: unknown) => (reads.n++, get(key, options as never))) as typeof s.r2.get;
      return reads;
    };
    // Alone: the reads one LOAD of the file takes.
    const alone = setup({ tick: 40 });
    const f0 = await upload(alone, "permits.csv", bytes);
    const aloneReads = count(alone);
    await runJob(alone, { kind: "load", params: { files: [f0], madeBy }, requestKey: "alone" });
    // Two stores taking turns, a chunk each.
    const a = setup({ tick: 40 });
    const b = setup({ tick: 40 });
    const fa = await upload(a, "permits.csv", bytes);
    const fb = await upload(b, "permits.csv", bytes);
    const aReads = count(a);
    const bReads = count(b);
    const ja = value(await a.store.jobSubmit(RUN, { kind: "load", params: { files: [fa], madeBy }, requestKey: "a" })).job;
    const jb = value(await b.store.jobSubmit(RUN, { kind: "load", params: { files: [fb], madeBy }, requestKey: "b" })).job;
    for (let i = 0; i < 2000; i++) {
      const sa = value(await a.store.job(RUN, ja.id)).job.state;
      const sb = value(await b.store.job(RUN, jb.id)).job.state;
      if (sa === "done" && sb === "done") break;
      await a.store.alarm();
      await b.store.alarm();
      a.clock.advance(5_000);
      b.clock.advance(5_000);
    }
    assert.deepEqual(rows(a, "SELECT count(*) AS n FROM permits"), [{ n: 150_000 }]);
    assert.deepEqual(rows(b, "SELECT count(*) AS n FROM permits"), [{ n: 150_000 }]);
    assert.ok(aReads.n <= aloneReads.n + 1 && bReads.n <= aloneReads.n + 1, `alone ${aloneReads.n} reads; taking turns ${aReads.n} and ${bReads.n}`);
  });

  it("shows each file's tables in its progress, in the files' order, and a file it could not read with why, after it ended too", async () => {
    const s = setup();
    const text = (words: string) => new TextEncoder().encode(words);
    const permits = await upload(s, "permits.csv", text("permit_no,status\nA1,Issued\nA2,Final\nA3,Issued\n"));
    const blank = await upload(s, "blank.csv", text(""));
    const owners = await upload(s, "owners.csv", text("owner,parcel\nRosa Delgado,12\n"));
    const { job: ended } = await runJob(s, { kind: "load", params: { files: [permits, blank, owners], madeBy }, requestKey: "progress" });
    assert.equal(ended.state, "done", ended.error ?? "");
    const tables = ended.progress?.tables ?? [];
    assert.deepEqual(
      tables.map((t) => [t.name, t.source, t.state, t.done, t.total]),
      [
        ["permits", "permits.csv", "done", 3, 3],
        ["blank.csv", "blank.csv", "skipped", 0, null],
        ["owners", "owners.csv", "done", 1, 1],
      ],
    );
    assert.match(tables[1]!.why ?? "", /blank\.csv/);
  });

  it("lists a load's waiting files by name, and the tables of the file it reads by theirs", () => {
    const files = [{ id: "fil_1", name: "permits.xlsx" }, { id: "fil_2", name: "owners.csv" }] as LoadParams["files"];
    const planned = (name: string, source: string, rows: number | null) => ({ index: 0, source, name, kept: [], packed: [], notes: [], keyFrom: null, rows });
    const state = {
      file: 0,
      tables: [planned("permits_2026", "2026", 1200), planned("permits_2025", "2025", null)],
      table: 0,
      current: { cursor: null, rows: 400, deleted: 0, extra: false, done: false, cut: 2, stopped: null },
      made: [],
      skipped: [],
      rows: 400,
    } as unknown as LoadState;
    assert.deepEqual(loadTablesProgress({ files, madeBy } as LoadParams, state), [
      { name: "permits_2026", source: "permits.xlsx › 2026", state: "running", done: 400, total: 1200, cut: 2 },
      { name: "permits_2025", source: "permits.xlsx › 2025", state: "waiting", done: 0, total: null },
      { name: "owners.csv", source: "owners.csv", state: "waiting", done: 0, total: null },
    ]);
  });

  it("refuses files it is not given, by their ids and names", async () => {
    const s = setup();
    const refused = await s.store.jobSubmit(RUN, { kind: "load", params: { files: [], madeBy }, requestKey: "d" });
    assert.equal(refused.ok, false);
    assert.equal((refused as { code: string }).code, "bad_request");
  });
});

describe("LOAD and the code page of a file's text", () => {
  const codePages = (s: ReturnType<typeof setup>) => rows(s, "SELECT key, value FROM _meta WHERE key LIKE 'code^_page:%' ESCAPE '^' ORDER BY key");

  sampled("owners-says-1251.dbf", "owners-1251.dbf")("reads a FoxPro table's text in the code page its words show where its header names another, and a Russian one in its own", async () => {
    const s = setup();
    const says = await upload(s, "owners-says-1251.dbf", fixture("owners-says-1251.dbf"));
    const russian = await upload(s, "owners-1251.dbf", fixture("owners-1251.dbf"));
    const { job } = await runJob(s, { kind: "load", params: { files: [says, russian], madeBy }, requestKey: "found" });
    assert.equal(job.state, "done", job.error ?? "");
    assert.deepEqual(
      (job.result as LoadResult).tables.map((t) => [t.table, t.rows, t.notes]),
      [
        [
          "owners_says_1251",
          5,
          ['Read as a Visual FoxPro table in Windows-1252. Its header names Windows-1251, but its text is Windows-1252: Windows-1251 would read "Peña Holdings LLC" as "Pe\u0441a Holdings LLC", and 6 more words wrong too.'],
        ],
        ["owners_1251", 5, ["Read as a Visual FoxPro table in Windows-1251."]],
      ],
    );
    assert.deepEqual(
      rows(s, `SELECT "NAME", "MAILING" FROM owners_says_1251 ORDER BY "_row"`).map((r) => r.NAME),
      ["Peña Holdings LLC", "Désirée Okafor", "Tomás Brennan", "Zoë Müller", "Rosa Delgado"],
    );
    assert.deepEqual(rows(s, `SELECT "NAME", "MAILING" FROM owners_1251 WHERE "_row" = 1`), [{ NAME: "Иванов Пётр Сергеевич", MAILING: "ул. Ленина, д. 5, кв. 12, Москва" }]);
    // LOAD found both itself: the store keeps no code page for either.
    assert.deepEqual(codePages(s), []);
  });

  sampled("cafes-437-says-1252.dbf")("keeps the code page a person set for a file's name: a later load of a file of that name reads its text so, until one says auto", async () => {
    const s = setup();
    const names = () => rows(s, `SELECT "NAME" FROM cafes ORDER BY "_row"`).map((r) => r.NAME);
    const first = await upload(s, "cafes.dbf", fixture("cafes-437-says-1252.dbf"));
    const set = await runJob(s, { kind: "load", params: { files: [{ ...first, codePage: 437 }], madeBy }, requestKey: "set" });
    assert.equal(set.job.state, "done", set.job.error ?? "");
    assert.deepEqual((set.job.result as LoadResult).tables[0]!.notes, ["Read as a dBase table in code page 437, the code page set for cafes.dbf; its header names Windows-1252."]);
    assert.deepEqual(names(), ["Café du Parc", "Rosé Wine Bar", "Brookfield Diner"]);
    assert.deepEqual(codePages(s), [{ key: "code_page:cafes.dbf", value: "437" }]);

    // The town sends the file again, and a program loads it with no word about its code page.
    const second = await upload(s, "CAFES.DBF", fixture("cafes-437-says-1252.dbf"));
    const writes = countWrites(s);
    const again = await runJob(s, { kind: "load", params: { files: [second], madeBy }, requestKey: "again" });
    const loaded = (again.job.result as LoadResult).tables[0]!;
    assert.deepEqual(
      [loaded.table, loaded.changes, loaded.notes],
      ["cafes", { added: 0, changed: 0, removed: 0 }, ["Read as a dBase table in code page 437, the code page set for CAFES.DBF; its header names Windows-1252."]],
    );
    assert.equal(writes.data, 0, "no row of the table changed");
    assert.deepEqual(names(), ["Café du Parc", "Rosé Wine Bar", "Brookfield Diner"]);
    assert.deepEqual(codePages(s), [{ key: "code_page:cafes.dbf", value: "437" }]);

    // "auto" forgets it: LOAD reads what the text shows again, and the two names with an "é" change.
    const auto = await runJob(s, { kind: "load", params: { files: [{ ...second, codePage: "auto" }], madeBy }, requestKey: "auto" });
    assert.equal(auto.job.state, "done", auto.job.error ?? "");
    assert.deepEqual((auto.job.result as LoadResult).tables[0]!.notes, ["Read as a dBase table in Windows-1252."]);
    assert.deepEqual(names(), ["Caf\u201a du Parc", "Ros\u201a Wine Bar", "Brookfield Diner"]);
    assert.deepEqual(codePages(s), []);
  });

  sampled("cafes-437-says-1252.dbf")("refuses a code page it does not read text in", async () => {
    const s = setup();
    const f = await upload(s, "cafes.dbf", fixture("cafes-437-says-1252.dbf"));
    const refused = await s.store.jobSubmit(RUN, { kind: "load", params: { files: [{ ...f, codePage: 932 }], madeBy }, requestKey: "cp932" });
    assert.equal(refused.ok, false);
    assert.equal((refused as { error: string }).error, "The code page set for cafes.dbf is not one LOAD reads text in.");
  });
});

describe("LOAD at the store's daily write limit", () => {
  const NEXT_DAY = Date.parse("2026-11-08T00:00:00Z");
  /** A CSV of `n` rows after its header: more than one batch of 2,000. */
  const csv = (n: number): Uint8Array => new TextEncoder().encode(`No,Fee\n${Array.from({ length: n }, (_, i) => `BP-${i + 1},${i + 1}`).join("\n")}\n`);
  const FILE_ROWS = 7_000;

  /** Fires the store's alarms as the platform would, moving the clock to each, up to `until`. */
  async function alarmsUntil(s: ReturnType<typeof setup>, until: number) {
    for (let i = 0; i < 200 && s.storage.alarm !== null && s.storage.alarm <= until; i++) {
      if (s.storage.alarm > s.clock.now()) s.clock.advance(s.storage.alarm - s.clock.now());
      s.storage.alarm = null;
      await s.store.alarm();
    }
  }

  /**
   * A load of one file of 7,000 rows into a store of `limit` rows a day, run up to where it first
   * stops. `shared`: the limit is its organization's budget's, which a test may raise.
   */
  async function started(limit: number, opts: { shared?: boolean } = {}) {
    const budget = opts.shared ? new FakeBudget(limit) : undefined;
    const s = setup(budget ? { budget } : { limit });
    const f = await upload(s, "permits.csv", csv(FILE_ROWS));
    const counts = countWrites(s);
    const job = value(await s.store.jobSubmit(RUN, { kind: "load", params: { files: [f], madeBy }, requestKey: "store_load:mrn-1:s1@" })).job;
    await alarmsUntil(s, s.clock.now() + 60_000);
    return { s, f, counts, job, budget };
  }

  /** The rows the load's table holds, and whether each row of the file came once. */
  function loaded(s: ReturnType<typeof setup>, table: string) {
    return s.storage.sql.exec(`SELECT count(*) AS n, count(DISTINCT "_row") AS rows, min("_row") AS first, max("_row") AS last FROM "${table}"`).one();
  }

  it("stops at the batch that reaches the limit, keeps the table in progress and its place, and writes nothing more", async () => {
    const { s, job, counts } = await started(3_000);
    const waiting = value(await s.store.job(RUN, job.id)).job;
    assert.equal(waiting.state, "running");
    assert.equal(waiting.waiting?.code, "write_limit_reached");
    // Two batches of 2,000: the second reaches the limit, and the chunk ends at that commit.
    assert.equal(counts.data, 4_000);
    assert.equal(loaded(s, "permits__new").n, 4_000);
    const state = JSON.parse(String(s.storage.sql.exec("SELECT run_state FROM _jobs WHERE id = ?", job.id).one().run_state)) as LoadState;
    assert.equal(state.rows, 4_000);
    assert.deepEqual(waiting.progress, { done: 4_000, total: null, note: "Loading permits.csv", tables: [{ name: "permits", source: "permits.csv", state: "running", done: 4_000, total: null }] });
    const before = counts.all;
    // Looking again writes nothing of the job's: another of the store's alarms.
    s.clock.advance(60_000);
    s.storage.alarm = null;
    await s.store.alarm();
    assert.equal(counts.data, 4_000);
    assert.ok(counts.all - before < 10, `only the store's own count (${counts.all - before})`);
  });

  it("goes on after 00:00 UTC from the row it stopped at, and writes each row of the file once", async () => {
    const { s, job, counts } = await started(3_000);
    // The next day writes the file's third batch and its last 1,000 rows, then the day's count is
    // past 3,000 and the swap waits for the day after.
    await alarmsUntil(s, NEXT_DAY + 60_000);
    await alarmsUntil(s, NEXT_DAY + 86_400_000 + 60_000);
    const done = value(await s.store.job(RUN, job.id)).job;
    assert.equal(done.state, "done", done.error ?? "");
    assert.equal(done.waiting, null);
    assert.equal(counts.data, FILE_ROWS, "each row of the file was written once, over the days it took");
    assert.deepEqual({ ...loaded(s, "permits") }, { n: FILE_ROWS, rows: FILE_ROWS, first: 2, last: FILE_ROWS + 1 });
    const result = done.result as LoadResult;
    assert.deepEqual(result.tables.map((t) => [t.table, t.version, t.rows]), [["permits", 1, FILE_ROWS]]);
    assert.equal(s.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'permits__new'").one().n, 0);
  });

  it("goes on within a minute once its organization's limit is raised, and writes each row of the file once", async () => {
    const { s, job, counts, budget } = await started(3_000, { shared: true });
    assert.equal(value(await s.store.job(RUN, job.id)).job.waiting?.code, "write_limit_reached");
    budget!.limit = 1_000_000;
    await alarmsUntil(s, s.clock.now() + 2 * 60_000);
    const done = value(await s.store.job(RUN, job.id)).job;
    assert.equal(done.state, "done", done.error ?? "");
    assert.equal(counts.data, FILE_ROWS);
    assert.deepEqual({ ...loaded(s, "permits") }, { n: FILE_ROWS, rows: FILE_ROWS, first: 2, last: FILE_ROWS + 1 });
    assert.ok(s.clock.now() < NEXT_DAY, "the same day");
  });

  it("writes the same rows as a load that never stopped", async () => {
    const whole = setup();
    const f = await upload(whole, "permits.csv", csv(FILE_ROWS));
    const ran = await runJob(whole, { kind: "load", params: { files: [f], madeBy }, requestKey: "whole" });
    assert.equal(ran.job.state, "done", ran.job.error ?? "");
    const { s, job } = await started(3_000);
    await alarmsUntil(s, NEXT_DAY + 86_400_000 + 60_000);
    assert.equal(value(await s.store.job(RUN, job.id)).job.state, "done");
    const read = (x: ReturnType<typeof setup>) => x.storage.sql.exec('SELECT "_row", "No", "Fee" FROM permits ORDER BY "_row"').toArray().map((r) => `${r._row}|${r.No}|${r.Fee}`);
    assert.deepEqual(read(s), read(whole));
  });
});

describe("SHAPE", () => {
  sampled("permits-utf8.csv")("makes a new version of its table from one SELECT, and keeps the SQL with its goal", async () => {
    const s = setup();
    const f = await upload(s, "permits-utf8.csv", fixture("permits-utf8.csv"));
    await runJob(s, { kind: "load", params: { files: [f], madeBy }, requestKey: "load" });
    const sql = `SELECT "Permit No" AS permit_no, "Owner" AS owner, CAST(NULLIF(TRIM("Fee"), '') AS REAL) AS fee, "_file", "_row" FROM permits_utf8`;
    const params = { into: "permits", sql, goal: "one row per permit", sources: '[["permits_utf8",["Permit No"]]]', madeBy: { runId: "mrn-2", step: "s2" } };
    const first = await runJob(s, { kind: "shape", params, requestKey: "shape-1" });
    assert.equal(first.job.state, "done", first.job.error ?? "");
    assert.deepEqual(first.job.result, { table: "permits", version: 1, rows: 4, mode: "whole", added: 4, changed: 0, removed: 0, why: "it is the first time this table is made" });
    assert.deepEqual(rows(s, "SELECT permit_no, fee FROM permits ORDER BY _row"), [
      { permit_no: "BP-2019-0001", fee: 150 },
      { permit_no: "BP-2019-0002", fee: 2250.5 },
      { permit_no: "BP-2019-0003", fee: null },
      { permit_no: "BP-2019-0004", fee: 75.25 },
    ]);
    // Its rows carry no _key, so the store cannot change them by key: each run makes the table whole.
    const second = await runJob(s, { kind: "shape", params, requestKey: "shape-2" });
    assert.deepEqual(second.job.result, { table: "permits", version: 2, rows: 4, mode: "whole", added: 4, changed: 0, removed: 0, why: "its rows have no _key from one source table, so each run makes it whole" });
    const saved = JSON.parse(String(rows(s, `SELECT value FROM _meta WHERE key = '${shapeKey("permits")}'`)[0]!.value));
    assert.deepEqual([saved.goal, saved.sql, saved.sources, saved.version, saved.madeBy], ["one row per permit", sql, '[["permits_utf8",["Permit No"]]]', 2, "run:mrn-1"]);
    const permits = value(await s.store.catalog(PERSON)).tables.find((t) => t.name === "permits")!;
    assert.equal(permits.group, "Cleaned");
    assert.equal(permits.version, 2);
  });

  it("refuses a second statement, a write, a store's own table, and a table a migration made", async () => {
    const s = setup();
    value(await s.store.migrate(PERSON, { id: "0001", sql: "CREATE TABLE parcels (id INTEGER PRIMARY KEY)" }));
    const submit = (into: string, sql: string) => s.store.jobSubmit(RUN, { kind: "shape", params: { into, sql, goal: null, sources: "[]", madeBy }, requestKey: `${into}:${sql}` });
    for (const [into, sql] of [
      ["permits", "SELECT 1; DROP TABLE parcels"],
      ["permits", "DELETE FROM parcels"],
      ["_meta", "SELECT 1 AS one"],
      ["permits__v2", "SELECT 1 AS one"],
    ] as const) {
      const r = await submit(into, sql);
      assert.equal(r.ok, false, `${into}: ${sql}`);
      assert.equal((r as { code: string }).code, "bad_request");
    }
    const { job } = await runJob(s, { kind: "shape", params: { into: "parcels", sql: "SELECT 1 AS one", goal: null, sources: "[]", madeBy }, requestKey: "managed" });
    assert.equal(job.state, "failed");
    assert.match(job.error ?? "", /is a managed table/);
  });

  it("makes no version without a column an app on the store reads, and keeps the table as it was", async () => {
    const s = setup();
    const keep = { loan_totals: [{ column: "loans", reader: "Laptop Loans on prod" }] };
    const first = await runJob(s, { kind: "shape", params: { into: "loan_totals", sql: "SELECT 'Ana' AS borrower, 2 AS loans", goal: null, sources: "[]", madeBy, keep }, requestKey: "v1" });
    assert.deepEqual(first.job.result, { table: "loan_totals", version: 1, rows: 1, mode: "whole", added: 1, changed: 0, removed: 0, why: "it is the first time this table is made" });
    // The program's next version drops `loans`: refused, at once, and version 1 stays.
    const second = await runJob(s, { kind: "shape", params: { into: "loan_totals", sql: "SELECT 'Ana' AS borrower", goal: null, sources: "[]", madeBy, keep }, requestKey: "v2" });
    assert.equal(second.job.state, "failed");
    assert.match(second.job.error ?? "", /has no column loans, which Laptop Loans on prod reads, so it was not made: loan_totals stays as it was/);
    assert.deepEqual(rows(s, "SELECT borrower, loans FROM loan_totals"), [{ borrower: "Ana", loans: 2 }]);
    assert.equal(value(await s.store.catalog(PERSON)).tables.find((t) => t.name === "loan_totals")!.version, 1);
    // Column names match whatever their case.
    const third = await runJob(s, { kind: "shape", params: { into: "loan_totals", sql: "SELECT 'Ana' AS borrower, 3 AS LOANS", goal: null, sources: "[]", madeBy, keep }, requestKey: "v3" });
    assert.deepEqual(third.job.result, { table: "loan_totals", version: 2, rows: 1, mode: "whole", added: 1, changed: 0, removed: 0, why: "its SQL changed" });
  });

  sampled("permits-utf8.csv")("refuses at once a double-quoted name that is no column, which SQLite would read as text", async () => {
    const s = setup();
    const f = await upload(s, "permits-utf8.csv", fixture("permits-utf8.csv"));
    await runJob(s, { kind: "load", params: { files: [f], madeBy }, requestKey: "load" });
    // "Fees" is no column of permits_utf8 ("Fee" is): every row would get the text 'Fees'.
    const params = { into: "permits", sql: 'SELECT "Permit No" AS permit_no, "Fees" AS fee FROM permits_utf8', goal: null, sources: "[]", madeBy };
    const { job, chunks } = await runJob(s, { kind: "shape", params, requestKey: "typo" });
    assert.equal(job.state, "failed");
    assert.match(job.error ?? "", /"Fees" is not a column of what this statement reads/);
    assert.equal(chunks, 1, "a refusal is not tried again");
    assert.deepEqual(rows(s, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'permits%' ORDER BY name").map((r) => r.name), ["permits_utf8"]);
  });

  sampled("permits-utf8.csv")("never replaces a LOAD's table, and refuses a name SQLite keeps for itself", async () => {
    const s = setup();
    const f = await upload(s, "permits-utf8.csv", fixture("permits-utf8.csv"));
    await runJob(s, { kind: "load", params: { files: [f], madeBy }, requestKey: "load" });
    const { job, chunks } = await runJob(s, { kind: "shape", params: { into: "permits_utf8", sql: 'SELECT "Permit No" AS p FROM permits_utf8', goal: null, sources: "[]", madeBy }, requestKey: "over" });
    assert.equal(job.state, "failed");
    assert.match(job.error ?? "", /permits_utf8 holds rows a LOAD read from the store's files, which a SHAPE does not replace\. Make the cleaned table under another name, such as permits_utf8_clean\./);
    assert.equal(chunks, 1);
    const refused = await s.store.jobSubmit(RUN, { kind: "shape", params: { into: "sqlite_sequence", sql: "SELECT 1 AS one", goal: null, sources: "[]", madeBy }, requestKey: "sqlite" });
    assert.equal(refused.ok, false);
    assert.equal((refused as { code: string }).code, "bad_request");
  });

  it("refuses at once a table the store does not have", async () => {
    const s = setup();
    const params = { into: "permits", sql: "SELECT * FROM permits_csv", goal: null, sources: "[]", madeBy };
    const { job, chunks } = await runJob(s, { kind: "shape", params, requestKey: "missing" });
    assert.equal(job.state, "failed");
    assert.match(job.error ?? "", /The SELECT does not run on this store: .*no such table: permits_csv/);
    assert.equal(chunks, 1);
  });
});
