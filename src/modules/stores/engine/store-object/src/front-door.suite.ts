// What a store does to SQL before it runs it (front-door.ts), on the stand-ins for its storage with
// workerd's limits (testing/fakes.ts: 100 columns, 5 SELECTs in a compound, 100 KB a statement):
// a file wider than a table, a file name longer than a table's name, and one table made from more
// tables than one compound may hold. Each case on a file of three rows, as Hilltown's forms had.

import { describe, it, host, stateOf, filesOf } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import type { StoreDeps } from "./core.js";
import { stableIdText } from "../../store-readers/src/readings.js";
import { nestCompounds, withCte } from "./front-door.js";
import { StoreHandler } from "./handler.js";
import { JOB_HANDLERS } from "./jobs/index.js";
import { oneSelect } from "./jobs/shape.js";
import type { LoadResult } from "./jobs/load.js";
import type { Job, StoreCaller, StoreResult } from "./types.js";

const STORE = `sto_${"e".repeat(32)}`;
const PERSON: StoreCaller = { storeId: STORE, actor: "user:u-1" };
const RUN: StoreCaller = { storeId: STORE, actor: "run:mrn-1" };
const madeBy = { runId: "mrn-1", step: "s1" };

function setup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: JOB_HANDLERS };
  const store = new StoreHandler(state as never, { FILES: r2.asBucket() }, deps);
  return { clock, storage, r2, store };
}
type Setup = ReturnType<typeof setup>;

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

async function upload(s: Setup, name: string, text: string): Promise<{ id: string; name: string }> {
  const bytes = new TextEncoder().encode(text);
  const created = value(await s.store.fileCreate(PERSON, { name, size: bytes.byteLength, contentType: "text/csv" }));
  const target = value(await s.store.filePartTarget(PERSON, created.file.id, 1));
  const part = await s.r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, bytes);
  value(await s.store.fileComplete(PERSON, created.file.id, { parts: [{ n: 1, etag: part.etag }] }));
  return { id: created.file.id, name: created.file.name };
}

async function settle(s: Setup): Promise<void> {
  let alarms = 0;
  while (alarms < 2000 && s.storage.sql.exec("SELECT 1 FROM _jobs WHERE state IN ('queued', 'running')").toArray().length) {
    await s.store.alarm();
    s.clock.advance(5_000);
    alarms++;
  }
}

/** Submits a job and runs it to its end: the job, or the submit's refusal. */
async function job(s: Setup, kind: string, params: unknown, requestKey: string): Promise<Job> {
  const submitted = value(await s.store.jobSubmit(RUN, { kind, params, requestKey })).job;
  await settle(s);
  return value(await s.store.job(RUN, submitted.id)).job;
}

async function done(s: Setup, kind: string, params: unknown, requestKey: string): Promise<Job> {
  const ended = await job(s, kind, params, requestKey);
  assert.equal(ended.state, "done", ended.error ?? "");
  return ended;
}

const csv = (rows: string[][]) => rows.map((r) => r.join(",")).join("\r\n");
const rowsOf = (s: Setup, sql: string, ...params: unknown[]) => s.storage.sql.exec(sql, ...params).toArray().map((r) => ({ ...r }));
const answer = async (s: Setup, sql: string) => value(await s.store.query(PERSON, { sql }));

/** Permits_Form_7.csv: Permit No, Applicant, Address, 87 more questions, then STATUS, CREATED, PARCEL_ID and FEE_PAID past the 90th. */
function wideForm(status: [string, string, string] = ["Issued", "Pending", "Issued"]): string {
  const head = ["Permit No", "Applicant", "Address", ...Array.from({ length: 87 }, (_, i) => `Q${i + 4}`), "STATUS", "CREATED", "PARCEL_ID", "FEE_PAID"];
  const body = [
    ["BP-1", "Ann Lee", "12 Elm St", status[0], "2024-01-05", "P-0101", "125.00"],
    ["BP-2", "Bo Diaz", "40 Oak Ave", status[1], "2024-02-11", "P-0102", ""],
    ["BP-3", "Cy Park", "7 Pine Rd", status[2], "2024-03-02", "P-0103", "80.00"],
  ].map((r) => [r[0]!, r[1]!, r[2]!, ...Array.from({ length: 87 }, () => "x"), r[3]!, r[4]!, r[5]!, r[6]!]);
  return csv([head, ...body]);
}

describe("a file wider than a table: its packed columns are read by their names", () => {
  it("names the 4 columns past the 90th in LOAD's answer and the catalog, and a query reads each by its name", async () => {
    const s = setup();
    const f = await upload(s, "Permits_Form_7.csv", wideForm());
    const load = await done(s, "load", { files: [f], madeBy }, "load-1");
    const made = (load.result as LoadResult).tables[0]!;
    assert.equal(made.table, "permits_form_7");
    assert.deepEqual(made.packed, ["STATUS", "CREATED", "PARCEL_ID", "FEE_PAID"]);
    assert.match(made.notes.join(" "), /the 4 after the first 90 are in _extra: STATUS, CREATED, PARCEL_ID, FEE_PAID\. SQL reads each by its name\./);
    // The table keeps 95 columns, as before; the catalog lists the 4 beside them.
    assert.equal(rowsOf(s, "SELECT count(*) AS n FROM pragma_table_info('permits_form_7')")[0]!.n, 95);
    const table = value(await s.store.catalog(PERSON)).tables.find((t) => t.name === "permits_form_7")!;
    assert.deepEqual(table.packed?.map((c) => c.name), ["STATUS", "CREATED", "PARCEL_ID", "FEE_PAID"]);
    assert.equal(table.columns.length, 95);

    const read = await answer(s, `SELECT "Permit No", "STATUS", "CREATED" FROM permits_form_7 ORDER BY "Permit No"`);
    assert.deepEqual(read.columns, ["Permit No", "STATUS", "CREATED"]);
    assert.deepEqual(read.rows, [
      ["BP-1", "Issued", "2024-01-05"],
      ["BP-2", "Pending", "2024-02-11"],
      ["BP-3", "Issued", "2024-03-02"],
    ]);
    // Bare and qualified names, in WHERE too, and an empty value stays empty.
    const where = await answer(s, `SELECT p."Permit No", FEE_PAID FROM permits_form_7 AS p WHERE p.STATUS = 'Issued' AND "PARCEL_ID" <> 'P-0103'`);
    assert.deepEqual(where.rows, [["BP-1", "125.00"]]);
    // An empty cell reads as NULL, as a kept column's empty cell does.
    assert.deepEqual((await answer(s, `SELECT FEE_PAID, nullif("Q4", 'x') AS q4 FROM permits_form_7 WHERE "Permit No" = 'BP-2'`)).rows, [[null, null]]);
    const kept = csv([["A", "B"], ["1", ""]]);
    await done(s, "load", { files: [await upload(s, "narrow.csv", kept)], madeBy }, "load-narrow");
    assert.deepEqual((await answer(s, `SELECT "B" FROM narrow`)).rows, [[null]]);
    // A name that is no column anywhere is still refused, in the store's words.
    const typo = await s.store.query(PERSON, { sql: `SELECT "STATUSS" FROM permits_form_7` });
    assert.equal(typo.ok, false);
    assert.match((typo as { error: string }).error, /"STATUSS" is not a column of what this statement reads/);
  });

  it("makes a SHAPE's table from packed columns, and a later load writes only the row whose packed value changed", async () => {
    const s = setup();
    await done(s, "load", { files: [await upload(s, "Permits_Form_7.csv", wideForm())], madeBy }, "load-1");
    const sql = `SELECT "_key", "_file", "_row", "Permit No" AS permit_no, "STATUS" AS status, "CREATED" AS created FROM permits_form_7`;
    const first = await done(s, "shape", { into: "permits_clean", sql, goal: null, sources: "[]", madeBy }, "shape-1");
    assert.equal((first.result as { mode: string }).mode, "whole");
    assert.deepEqual(rowsOf(s, "SELECT permit_no, status, created FROM permits_clean ORDER BY permit_no").map((r) => Object.values(r)), [
      ["BP-1", "Issued", "2024-01-05"],
      ["BP-2", "Pending", "2024-02-11"],
      ["BP-3", "Issued", "2024-03-02"],
    ]);
    // The store keeps the SQL as it was given, not as it ran.
    assert.equal(JSON.parse(String(rowsOf(s, "SELECT value FROM _meta WHERE key = 'shape:permits_clean'")[0]!.value)).sql, sql);

    // BP-2 is issued: the town's file comes again, and only that row changes.
    await done(s, "load", { files: [await upload(s, "Permits_Form_7.csv", wideForm(["Issued", "Issued", "Issued"]))], madeBy }, "load-2");
    const second = await done(s, "shape", { into: "permits_clean", sql, goal: null, sources: "[]", madeBy }, "shape-2");
    assert.equal((second.result as { mode: string }).mode, "changed");
    assert.deepEqual((second.result as { changed: number; added: number; removed: number }).changed, 1);
    assert.deepEqual(rowsOf(s, "SELECT status FROM permits_clean WHERE permit_no = 'BP-2'"), [{ status: "Issued" }]);
    assert.ok(second.rowsWritten! < 20, `wrote ${second.rowsWritten}`);
  });

  it("reads a parked table's packed columns out of its files when only its changed rows are read", async () => {
    const s = setup();
    await done(s, "load", { files: [await upload(s, "Permits_Form_7.csv", wideForm())], madeBy }, "load-1");
    const sql = `SELECT "_key", "_file", "_row", "Permit No" AS permit_no, "STATUS" AS status FROM permits_form_7`;
    await done(s, "shape", { into: "permits_clean", sql, goal: null, sources: "[]", madeBy }, "shape-1");
    // The town's table parks 10 minutes later, and a new file keeps it parked.
    s.clock.advance(11 * 60_000);
    await s.store.alarm();
    await settle(s);
    assert.equal(rowsOf(s, "SELECT parked IS NOT NULL AS parked FROM _tables WHERE name = 'permits_form_7'")[0]!.parked, 1);
    await done(s, "load", { files: [await upload(s, "Permits_Form_7.csv", wideForm(["Issued", "Revoked", "Issued"]))], madeBy }, "load-2");
    const second = await done(s, "shape", { into: "permits_clean", sql, goal: null, sources: "[]", madeBy }, "shape-2");
    assert.equal((second.result as { mode: string }).mode, "changed");
    assert.equal((second.result as { broughtBack?: string[] }).broughtBack, undefined);
    assert.deepEqual(rowsOf(s, "SELECT status FROM permits_clean WHERE permit_no = 'BP-2'"), [{ status: "Revoked" }]);
  });

  it("records the packed columns and the second name of a table loaded before the store kept them, on its next load, though no row changed", async () => {
    const s = setup();
    const name = "Hilltown_Residential_Mechanical_HVAC_Permit_Application_2019-2024.csv";
    const wide = wideForm();
    await done(s, "load", { files: [await upload(s, name, wide)], madeBy }, "load-1");
    const table = "hilltown_residential_mechanical_hvac_permit_application_2019";
    // As a store loaded it before this change: no packed column records, no second name.
    s.storage.sql.exec("DELETE FROM _columns WHERE packed_in IS NOT NULL");
    s.storage.sql.exec("UPDATE _tables SET full_name = NULL");
    const before = await s.store.query(PERSON, { sql: `SELECT "STATUS" FROM ${table}` });
    assert.equal(before.ok, false);
    const again = await done(s, "load", { files: [await upload(s, name, wide)], madeBy }, "load-2");
    assert.deepEqual((again.result as LoadResult).tables[0]!.changes, { added: 0, changed: 0, removed: 0 });
    assert.deepEqual((await answer(s, `SELECT "STATUS" FROM hilltown_residential_mechanical_hvac_permit_application_2019_2024 ORDER BY "Permit No"`)).rows, [["Issued"], ["Pending"], ["Issued"]]);
    // A load with nothing new to record writes none of it again.
    const third = await done(s, "load", { files: [await upload(s, name, wide)], madeBy }, "load-3");
    assert.ok(third.rowsWritten! < 40, `wrote ${third.rowsWritten}`);
  });

  it("leaves a statement that already reads a packed name as something else as it was", async () => {
    const s = setup();
    await done(s, "load", { files: [await upload(s, "Permits_Form_7.csv", wideForm())], madeBy }, "load-1");
    // The way a program read a packed column before: its own alias of that name.
    const own = await answer(s, `SELECT "Permit No", lower(json_extract("_extra", '$.STATUS')) AS "STATUS" FROM permits_form_7 ORDER BY "STATUS", "Permit No"`);
    assert.deepEqual(own.rows, [
      ["BP-1", "issued"],
      ["BP-3", "issued"],
      ["BP-2", "pending"],
    ]);
  });

  it("reads 25 packed columns of a file of 115, through only the columns it names, and refuses * with them", async () => {
    const s = setup();
    const head = Array.from({ length: 115 }, (_, i) => `C${i + 1}`);
    const body = [1, 2, 3].map((r) => head.map((c) => `${c}-${r}`));
    await done(s, "load", { files: [await upload(s, "wide.csv", csv([head, ...body]))], madeBy }, "load-w");
    const packed = head.slice(90);
    const read = await answer(s, `SELECT "C1", ${packed.map((c) => `"${c}"`).join(", ")} FROM wide WHERE "C115" = 'C115-2'`);
    assert.deepEqual(read.columns, ["C1", ...packed]);
    assert.deepEqual(read.rows, [["C1-2", ...packed.map((c) => `${c}-2`)]]);
    const all = await s.store.query(PERSON, { sql: `SELECT *, ${packed.map((c) => `"${c}"`).join(", ")} FROM wide` });
    assert.equal(all.ok, false);
    assert.match((all as { error: string }).error, /wide has 95 columns of its own, and this statement reads every one and 25 more from _extra: a statement answers at most 100 columns\. Name the columns it reads instead of \*\./);
  });
});

describe("a file name longer than a table's name: the name in full reads the same table", () => {
  const file = "Hilltown_Residential_Mechanical_HVAC_Permit_Application_2019-2024.csv";
  const full = "hilltown_residential_mechanical_hvac_permit_application_2019_2024";
  const text = csv([
    ["Permit No", "Status"],
    ["M-1", "Issued"],
    ["M-2", "Pending"],
    ["M-3", "Issued"],
  ]);

  it("keeps the name in full as a second name: LOAD's answer, the catalog, a query and a SHAPE read it", async () => {
    const s = setup();
    const load = await done(s, "load", { files: [await upload(s, file, text)], madeBy }, "load-a");
    const made = (load.result as LoadResult).tables[0]!;
    assert.equal(made.table, "hilltown_residential_mechanical_hvac_permit_application_2019");
    assert.equal(made.fullName, full);
    const table = value(await s.store.catalog(PERSON)).tables.find((t) => t.name === made.table)!;
    assert.equal(table.fullName, full);
    assert.deepEqual((await answer(s, `SELECT count(*) AS n FROM ${full}`)).rows, [[3]]);
    assert.deepEqual((await answer(s, `SELECT ${full}."Permit No" FROM ${full} WHERE "Status" = 'Pending'`)).rows, [["M-2"]]);
    const shaped = await done(s, "shape", { into: "hvac_permits", sql: `SELECT "_key", "Permit No" AS permit_no FROM ${full}`, goal: null, sources: "[]", madeBy }, "shape-a");
    assert.equal((shaped.result as { rows: number }).rows, 3);
    // Loaded again, the file keeps its table and its second name.
    await done(s, "load", { files: [await upload(s, file, text)], madeBy }, "load-b");
    assert.deepEqual(rowsOf(s, "SELECT name, full_name FROM _tables WHERE full_name IS NOT NULL"), [{ name: made.table, full_name: full }]);
  });

  it("gives each of two files whose names differ past the 60th character its own second name", async () => {
    const s = setup();
    const a = await upload(s, `Town_of_${file}`, text);
    const b = await upload(s, "Town_of_Hilltown_Residential_Mechanical_HVAC_Permit_Application_2025.csv", csv([["Permit No"], ["N-1"]]));
    const load = await done(s, "load", { files: [a, b], madeBy }, "load-2");
    const made = (load.result as LoadResult).tables.map((t) => ({ table: t.table, fullName: t.fullName }));
    assert.deepEqual(made, [
      { table: "town_of_hilltown_residential_mechanical_hvac_permit_applicat", fullName: `town_of_${full}` },
      { table: "town_of_hilltown_residential_mechanical_hvac_permit_appl_2", fullName: "town_of_hilltown_residential_mechanical_hvac_permit_application_2025" },
    ]);
    assert.deepEqual((await answer(s, `SELECT "Permit No" FROM town_of_hilltown_residential_mechanical_hvac_permit_application_2025`)).rows, [["N-1"]]);
  });

  it("refuses a SHAPE into a name past 60 characters, and says why", async () => {
    const s = setup();
    await done(s, "load", { files: [await upload(s, file, text)], madeBy }, "load-a");
    const into = `${full}_clean`;
    const refused = await s.store.jobSubmit(RUN, { kind: "shape", params: { into, sql: `SELECT "_key" FROM ${full}`, goal: null, sources: "[]", madeBy }, requestKey: "shape-long" });
    assert.equal(refused.ok, false);
    assert.equal((refused as { error: string }).error, `"${into}" is 71 characters, and a table's name holds at most 60. Name the table in 60 characters or fewer.`);
  });
});

describe("one table made from 13 tables: a UNION of more than 5 SELECTs", () => {
  async function thirteen(s: Setup): Promise<string[]> {
    const files = [];
    for (let i = 1; i <= 13; i++) {
      const n = String(i).padStart(2, "0");
      files.push(await upload(s, `form_${n}.csv`, csv([["Permit No", "Status"], [`F${n}-1`, "Issued"], [`F${n}-2`, "Pending"], [`F${n}-3`, "Issued"]])));
    }
    const load = await done(s, "load", { files, madeBy }, "load-13");
    return (load.result as LoadResult).tables.map((t) => t.table);
  }
  const term = (t: string) => `SELECT "_key", "Permit No" AS permit_no, "Status" AS status, '${t}' AS form FROM ${t}`;

  it("makes one table of 39 rows from 13 SELECTs, and a query of them answers", async () => {
    const s = setup();
    const names = await thirteen(s);
    assert.equal(names.length, 13);
    const sql = names.map(term).join("\nUNION ALL\n");
    const made = await done(s, "shape", { into: "all_forms", sql, goal: null, sources: "[]", madeBy }, "shape-13");
    assert.equal((made.result as { rows: number }).rows, 39);
    assert.deepEqual(rowsOf(s, "SELECT count(DISTINCT form) AS forms, count(*) AS n FROM all_forms"), [{ forms: 13, n: 39 }]);
    // The column types are those the same SELECTs give in one chain.
    assert.deepEqual(
      rowsOf(s, "SELECT name, type FROM pragma_table_info('all_forms')").map((c) => `${c.name} ${c.type}`),
      ["_key TEXT", "permit_no TEXT", "status TEXT", "form "],
    );
    // A query of 6, with its ORDER BY and LIMIT, and the sample store_shape checks a SQL on.
    const six = await answer(s, `${names.slice(0, 6).map(term).join(" UNION ALL ")} ORDER BY permit_no DESC LIMIT 2`);
    assert.deepEqual(six.rows.map((r) => r[1]), ["F06-3", "F06-2"]);
    const sample = await s.store.query(PERSON, { sql: `SELECT * FROM (\n${sql}\n) LIMIT 20`, limit: 20 });
    assert.equal(value(sample).rows.length, 20);
  });
});

describe("nestCompounds", () => {
  const terms = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i + 1} AS n`);

  it("leaves a chain of 5 SELECTs, and any statement without a longer one, as it was", () => {
    const five = terms(5).join(" UNION ALL ");
    assert.equal(nestCompounds(five), five);
    assert.equal(nestCompounds("SELECT 'a UNION b UNION c UNION d UNION e UNION f' AS t"), "SELECT 'a UNION b UNION c UNION d UNION e UNION f' AS t");
  });

  it("runs 13 SELECTs as CTEs of 5, each starting with the one before, with the chain's ORDER BY and LIMIT last", () => {
    const out = nestCompounds(`${terms(13).join(" UNION ALL ")} ORDER BY n LIMIT 3`);
    assert.equal(
      out,
      [
        "WITH _terms_1 AS (",
        "SELECT 1 AS n\nUNION ALL\nSELECT 2 AS n\nUNION ALL\nSELECT 3 AS n\nUNION ALL\nSELECT 4 AS n\nUNION ALL\nSELECT 5 AS n",
        "),",
        "_terms_2 AS (",
        "SELECT * FROM _terms_1\nUNION ALL\nSELECT 6 AS n\nUNION ALL\nSELECT 7 AS n\nUNION ALL\nSELECT 8 AS n\nUNION ALL\nSELECT 9 AS n",
        ")",
        "SELECT * FROM _terms_2\nUNION ALL\nSELECT 10 AS n\nUNION ALL\nSELECT 11 AS n\nUNION ALL\nSELECT 12 AS n\nUNION ALL\nSELECT 13 AS n",
        "ORDER BY n LIMIT 3",
      ].join("\n"),
    );
  });

  it("keeps the answer of any mix of operators, a WITH list, a subquery's chain, and the order of ? parameters", () => {
    const s = setup();
    const sql = s.storage.sql;
    const ask = (q: string, ...params: unknown[]) => sql.exec(q, ...params).toArray().map((r) => Object.values(r));
    // SQLite reads a chain left to right: what the long chain means is what this left-deep nesting gives.
    const mixed = ["SELECT 1 AS n", "SELECT 2", "SELECT 2", "SELECT 3", "SELECT 3", "SELECT 3", "SELECT 4", "SELECT 1"];
    const ops = ["UNION ALL", "UNION ALL", "UNION", "UNION ALL", "EXCEPT", "UNION ALL", "INTERSECT"];
    const chain = mixed.map((t, i) => (i === 0 ? t : `${ops[i - 1]} ${t}`)).join(" ");
    const expected = ask(`SELECT * FROM (SELECT * FROM (SELECT * FROM (SELECT * FROM (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 2 UNION SELECT 3 UNION ALL SELECT 3) EXCEPT SELECT 3) UNION ALL SELECT 4) INTERSECT SELECT 1) ORDER BY n`);
    assert.deepEqual(ask(nestCompounds(`${chain} ORDER BY n`)), expected);
    // Its own WITH list keeps its CTEs first.
    const withList = `WITH base(v) AS (SELECT 10) ${terms(7).map((t) => `${t} FROM base`).join(" UNION ALL ")}`;
    assert.match(nestCompounds(withList), /^WITH base\(v\) AS \(SELECT 10\),\n_terms_1 AS/);
    assert.equal(ask(nestCompounds(withList)).length, 7);
    // A chain in a subquery is nested inside it; ? parameters keep their order.
    const inner = `SELECT count(*) FROM (${Array.from({ length: 7 }, () => "SELECT ? AS v").join(" UNION ALL ")}) WHERE v > ?`;
    assert.deepEqual(ask(nestCompounds(inner), 1, 2, 3, 4, 5, 6, 7, 4), [[3]]);
    assert.deepEqual(ask(nestCompounds(`SELECT 1 AS x WHERE 3 IN (${terms(6).join(" UNION ")})`)), [[1]]);
  });
});

describe("the two readings and stable_id: a query, an exec and a SHAPE read a value as the store does", () => {
  // A county's permits: days written two ways, fees with a dollar sign and commas, an empty fee, N/A,
  // and a day the calendar does not have.
  const permits = [
    "Permit No,Issued,Fee",
    'BP-1,2024-09-15,"$1,250.00"',
    "BP-2,5/5/2026,$80.50",
    "BP-3,2024-01-02,",
    "BP-4,12/31/2024,N/A",
    "BP-5,2026-02-30,$10",
  ].join("\r\n");
  // A shop's orders: a day with a time after it, a total waived, a total over a thousand.
  const orders = ["Order,Placed,Total", "A-100,2024-01-05T10:15:00Z,12.50", "A-101,1/7/2024,WAIVED", 'A-102,2024-01-09 08:00,"$1,000"'].join("\r\n");

  async function loaded(s: Setup, name: string, text: string): Promise<string> {
    const load = await done(s, "load", { files: [await upload(s, name, text)], madeBy }, `load-${name}`);
    return (load.result as LoadResult).tables[0]!.table;
  }

  it("adds up fees by year in a query, names a column with no alias as the statement wrote it, and reads N/A as no number", async () => {
    const s = setup();
    const t = await loaded(s, "permits.csv", permits);
    const byYear = await answer(s, `SELECT substr(as_iso_date(\`Issued\`), 1, 4) AS year, ROUND(SUM(as_number(\`Fee\`)), 2) AS fees, count(*) AS permits FROM ${t} GROUP BY 1 ORDER BY 1`);
    assert.deepEqual(byYear.columns, ["year", "fees", "permits"]);
    // 2026-02-30 names no day, so BP-5 has no year; an empty fee and N/A add nothing, and count as no number.
    assert.deepEqual(byYear.rows, [[null, 10, 1], ["2024", 1250, 3], ["2026", 80.5, 1]]);
    const bare = await answer(s, `SELECT as_number(\`Fee\`), AS_ISO_DATE( \`Issued\` ) FROM ${t} WHERE \`Permit No\` = 'BP-1'`);
    assert.deepEqual(bare.columns, ["as_number(`Fee`)", "AS_ISO_DATE( `Issued` )"]);
    assert.deepEqual(bare.rows, [[1250, "2024-09-15"]]);
    assert.deepEqual((await answer(s, `SELECT as_number(\`Fee\`) AS fee, count(as_number(\`Fee\`)) OVER () AS numbers FROM ${t} WHERE \`Permit No\` = 'BP-4'`)).rows, [[null, 0]]);
    // Text in quotes is text, and a name that only looks like a reading is no reading.
    assert.deepEqual((await answer(s, "SELECT 'as_number(x)' AS t")).rows, [["as_number(x)"]]);
  });

  it("writes a shop's totals and days into a table with exec, and makes one with a SHAPE", async () => {
    const s = setup();
    const t = await loaded(s, "orders.csv", orders);
    value(await s.store.exec(PERSON, { sql: `CREATE TABLE order_totals (order_no TEXT, placed TEXT, total REAL); INSERT INTO order_totals SELECT \`Order\`, as_iso_date(\`Placed\`), as_number(\`Total\`) FROM ${t}` }));
    assert.deepEqual(rowsOf(s, "SELECT order_no, placed, total FROM order_totals ORDER BY order_no"), [
      { order_no: "A-100", placed: "2024-01-05", total: 12.5 },
      { order_no: "A-101", placed: "2024-01-07", total: null },
      { order_no: "A-102", placed: "2024-01-09", total: 1000 },
    ]);
    const shaped = await done(s, "shape", { into: "order_amounts", sql: `SELECT "_key", \`Order\` AS order_no, as_number(\`Total\`) AS total FROM ${t}`, goal: null, sources: "[]", madeBy }, "shape-amounts");
    assert.equal((shaped.result as { rows: number }).rows, 3);
    assert.deepEqual(rowsOf(s, "SELECT order_no, total FROM order_amounts ORDER BY order_no"), [
      { order_no: "A-100", total: 12.5 },
      { order_no: "A-101", total: null },
      { order_no: "A-102", total: 1000 },
    ]);
  });

  it("makes the same id from the same text in a query, an exec and a SHAPE, as stableIdText does, and none from no value", async () => {
    const s = setup();
    const t = await loaded(s, "permits.csv", permits);
    const ids = new Map(["BP-1", "BP-2", "BP-3", "BP-4", "BP-5"].map((no) => [no, stableIdText(`permit:example-county:${no}`)]));
    const asked = await answer(s, `SELECT \`Permit No\` AS no, stable_id('permit:example-county:' || \`Permit No\`) AS id FROM ${t} ORDER BY 1`);
    assert.deepEqual(asked.rows, [...ids].map(([no, id]) => [no, id]));
    // A column with no alias is named as the statement wrote it, and an empty fee makes no id.
    const bare = await answer(s, `SELECT stable_id(\`Fee\`) FROM ${t} WHERE \`Permit No\` = 'BP-3'`);
    assert.deepEqual(bare.columns, ["stable_id(`Fee`)"]);
    assert.deepEqual(bare.rows, [[null]]);
    // A SHAPE and an exec make the same ids again.
    const sql = `SELECT "_key", \`Permit No\` AS no, stable_id('permit:example-county:' || \`Permit No\`) AS id FROM ${t}`;
    await done(s, "shape", { into: "permit_ids", sql, goal: null, sources: "[]", madeBy }, "shape-ids");
    value(await s.store.exec(PERSON, { sql: `CREATE TABLE permit_ids_again AS ${sql}` }));
    for (const table of ["permit_ids", "permit_ids_again"]) {
      assert.deepEqual(
        rowsOf(s, `SELECT no, id FROM ${table} ORDER BY no`).map((r) => [r.no, r.id]),
        [...ids],
      );
    }
  });

  it("refuses a call left without its closing bracket, in words, before anything runs", async () => {
    const s = setup();
    const t = await loaded(s, "orders.csv", orders);
    const open = await s.store.query(PERSON, { sql: `SELECT as_number(\`Total\` FROM ${t}` });
    assert.equal(open.ok, false);
    assert.match(open.ok ? "" : open.error, /^as_number\( has no closing bracket/);
    const empty = await s.store.exec(PERSON, { sql: `CREATE TABLE x AS SELECT as_iso_date( ) AS d FROM ${t}` });
    assert.equal(empty.ok, false);
    assert.equal(empty.ok ? "" : empty.error, "as_iso_date() needs a column or an expression between its brackets.");
  });
});

describe("SQL that opens with comment lines, as a team keeps it in a file", () => {
  // A file's SQL: a note on top, a block comment, a comment after a CTE, and a comment for its last line.
  const fileSql = (select: string) => ["-- Permits, cleaned for the county's report.", "/* Kept in the team's folder. */", select, "-- end of file"].join("\n");
  const withP = ["WITH p AS (", `  SELECT "_key", "_file", "_row", "Permit No" AS permit_no, "STATUS" AS status FROM permits_form_7`, ") -- one row a permit", "SELECT * FROM p"].join("\n");

  it("takes one SELECT or WITH past its comments, keeps them, and gives one that ends in a comment a line's end", () => {
    assert.equal(oneSelect("-- a note\nSELECT 1 AS n; -- done"), "-- a note\nSELECT 1 AS n");
    assert.equal(oneSelect("/* a */ WITH a AS (SELECT 1) SELECT * FROM a -- last"), "/* a */ WITH a AS (SELECT 1) SELECT * FROM a -- last\n");
    assert.equal(oneSelect("SELECT '-- no comment' AS t"), "SELECT '-- no comment' AS t");
    assert.equal(oneSelect("-- a note\nDELETE FROM t"), null);
    assert.equal(oneSelect("-- only a note"), null);
    assert.equal(oneSelect("-- two\nSELECT 1; SELECT 2"), null);
  });

  it("puts the store's own CTE first in a WITH list that comments open, and keeps the comments before it", () => {
    assert.equal(withCte("-- a note\nWITH a AS (SELECT 1) SELECT * FROM a", "b AS (SELECT 2)"), "-- a note\nWITH b AS (SELECT 2), a AS (SELECT 1) SELECT * FROM a");
    assert.equal(withCte("/* a */ with recursive a(n) AS (SELECT 1) SELECT * FROM a", "b AS (SELECT 2)"), "/* a */ WITH RECURSIVE b AS (SELECT 2), a(n) AS (SELECT 1) SELECT * FROM a");
    assert.equal(withCte("-- a note\nSELECT 1", "b AS (SELECT 2)"), "WITH b AS (SELECT 2)\n-- a note\nSELECT 1");
  });

  it("makes a table from packed columns with a file's WITH, makes it again in place, and a query of the file's SQL answers", async () => {
    const s = setup();
    await done(s, "load", { files: [await upload(s, "Permits_Form_7.csv", wideForm())], madeBy }, "load-1");
    const sql = fileSql(withP);
    const first = await done(s, "shape", { into: "permits_clean", sql, goal: null, sources: "[]", madeBy }, "shape-1");
    assert.equal((first.result as { mode: string }).mode, "whole");
    assert.deepEqual(rowsOf(s, "SELECT permit_no, status FROM permits_clean ORDER BY permit_no").map((r) => Object.values(r)), [
      ["BP-1", "Issued"],
      ["BP-2", "Pending"],
      ["BP-3", "Issued"],
    ]);
    // The store keeps the file's SQL with its comments, and a line's end after its last one.
    assert.equal(JSON.parse(String(rowsOf(s, "SELECT value FROM _meta WHERE key = 'shape:permits_clean'")[0]!.value)).sql, `${sql}\n`);

    // BP-2 is issued: the town's file comes again, and the table changes in place.
    await done(s, "load", { files: [await upload(s, "Permits_Form_7.csv", wideForm(["Issued", "Issued", "Issued"]))], madeBy }, "load-2");
    const second = await done(s, "shape", { into: "permits_clean", sql, goal: null, sources: "[]", madeBy }, "shape-2");
    assert.equal((second.result as { mode: string }).mode, "changed");
    assert.equal((second.result as { changed: number }).changed, 1);
    assert.deepEqual(rowsOf(s, "SELECT status FROM permits_clean WHERE permit_no = 'BP-2'"), [{ status: "Issued" }]);
    const read = await answer(s, fileSql(`${withP} WHERE status = 'Issued' ORDER BY permit_no`));
    assert.deepEqual(read.rows.map((r) => r[3]), ["BP-1", "BP-2", "BP-3"]);
  });

  it("runs a chain of 6 SELECTs that a comment opens as CTEs of 5, and one whose WITH list a comment ends", () => {
    const s = setup();
    const ask = (q: string) => s.storage.sql.exec(q).toArray().map((r) => Object.values(r));
    const six = (from = "") => Array.from({ length: 6 }, (_, i) => `SELECT ${i + 1} AS n${from}`).join("\nUNION ALL\n");
    const opened = nestCompounds(`-- six forms\n${six()}`);
    assert.match(opened, /^-- six forms\nWITH _terms_1 AS \(\n/);
    assert.deepEqual(ask(opened), [[1], [2], [3], [4], [5], [6]]);
    const listed = nestCompounds(`-- six forms\nWITH base(v) AS (SELECT 10) -- the base\n${six(" FROM base")}`);
    assert.match(listed, /^-- six forms\nWITH base\(v\) AS \(SELECT 10\) -- the base\n,\n_terms_1 AS \(\n/);
    assert.equal(ask(listed).length, 6);
  });
});
