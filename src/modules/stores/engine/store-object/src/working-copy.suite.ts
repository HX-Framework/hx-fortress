// One working copy and changed-row steps, in a store's object on the stand-ins for its storage, its
// bucket and its alarms: what LOAD records as changed when a town sends its file again, what SHAPE
// writes then (only the rows that changed, counted the way workerd counts them: the stand-in adds
// index entries, CREATE TABLE AS, CREATE INDEX and RENAME as workerd does), how a LOAD's table is
// parked in the bucket and brought back, how many versions a table keeps, and the "Ready" view.

import { describe, it, host, stateOf, filesOf, whereBilled, whereBookmarks, type HostFiles } from "../testing/suite/host.js";
import { countingHex, FakeBudget, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import { READY_GROUP } from "../../store-readers/src/jobs.js";
import type { StoreDeps } from "./core.js";
import { changedSince, lastChange } from "./deltas.js";
import type { ExportManifest } from "./export.js";
import { StoreHandler } from "./handler.js";
import { JOB_HANDLERS } from "./jobs/index.js";
import type { LoadResult } from "./jobs/load.js";
import { rowLocal, shadowed, tableRefs, tablesNamed as namedInSelect } from "./jobs/shape.js";
import { PARK_AFTER_MS, PARKED_KEEP_MS } from "./park.js";
import type { Job, StoreCaller, StoreResult } from "./types.js";

const STORE = "sto_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PERSON: StoreCaller = { storeId: STORE, actor: "user:u-1", org: "org-1" };
const RUN: StoreCaller = { storeId: STORE, actor: "run:mrn-1", org: "org-1" };
const COPY_RUN: StoreCaller = { storeId: `sto_${"c".repeat(32)}`, actor: "run:mrn-2" };
const madeBy = { runId: "mrn-1", step: "s1" };

function setup(on: { r2: HostFiles; clock: FakeClock } | null = null, opts: { budget?: FakeBudget } = {}) {
  const clock = on?.clock ?? new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = on?.r2 ?? filesOf();
  const budget = opts.budget;
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: JOB_HANDLERS, ...(budget ? { writeBudget: () => budget } : {}) };
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

/** Runs the store's alarms until no job is open; answers how many ran. */
async function settle(s: Setup): Promise<number> {
  let alarms = 0;
  while (alarms < 2000 && s.storage.sql.exec("SELECT 1 FROM _jobs WHERE state IN ('queued', 'running')").toArray().length) {
    await s.store.alarm();
    s.clock.advance(5_000);
    alarms++;
  }
  return alarms;
}

async function runJob(s: Setup, kind: string, params: unknown, requestKey: string, caller: StoreCaller = RUN): Promise<Job> {
  const job = value(await s.store.jobSubmit(caller, { kind, params, requestKey })).job;
  await settle(s);
  const ended = value(await s.store.job(caller, job.id)).job;
  assert.equal(ended.state, "done", ended.error ?? "");
  return ended;
}

const rows = (s: Setup, sql: string, ...params: unknown[]) => s.storage.sql.exec(sql, ...params).toArray().map((r) => ({ ...r }));
const tablesNamed = (s: Setup, like: string) => rows(s, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ORDER BY name", like).map((r) => String(r.name));

/** A town's permits as CSV: `n` permits, then the changes a later export brings. */
function permitsCsv(n: number, change: (row: string[], i: number) => string[] | null = (r) => r, extra: string[][] = []): string {
  const lines = ["Permit No,Owner,Fee,Status"];
  for (let i = 1; i <= n; i++) {
    const row = change([`BP-${i}`, `Owner ${i % 97}`, `${(i * 7) % 500}.50`, ["Open", "Closed", "Final"][i % 3]!], i);
    if (row) lines.push(row.join(","));
  }
  for (const row of extra) lines.push(row.join(","));
  return lines.join("\r\n");
}

const CLEAN_SQL = `SELECT "_key", "_file", "_row", "Permit No" AS permit_no, "Owner" AS owner, CAST(NULLIF(TRIM("Fee"), '') AS REAL) AS fee, upper("Status") AS status FROM permits`;
const PERMIT_COLUMNS = ["_file", "_row", "_key", "_hash", "Permit No", "Owner", "Fee", "Status"];
const shapeParams = (over: Record<string, unknown> = {}) => ({
  into: "permits_clean",
  sql: CLEAN_SQL,
  goal: "one row per permit",
  sources: JSON.stringify([["permits", PERMIT_COLUMNS]]),
  madeBy,
  ...over,
});

/** Loads a town's permits and shapes them once: the store a nightly rerun starts from. */
async function loadedAndShaped(n: number, opts: { budget?: FakeBudget } = {}) {
  const s = setup(null, opts);
  const f1 = await upload(s, "permits.csv", permitsCsv(n));
  const load = await runJob(s, "load", { files: [f1], madeBy }, "load-1");
  const shape = await runJob(s, "shape", shapeParams(), "shape-1");
  return { s, load, shape };
}

/** The cleaned table, as a list a test compares: one entry a row, by `_key`. */
const cleaned = (s: Setup, table = "permits_clean") =>
  rows(s, `SELECT "_key", permit_no, owner, fee, status FROM ${table} ORDER BY "_key"`).map((r) => JSON.stringify(r));

describe("what changed: LOAD's record of a town's rows", () => {
  it("names each row by the town's key, and records a new upload's added, changed and removed rows against the last one's hashes", async () => {
    const s = setup();
    const f1 = await upload(s, "permits.csv", permitsCsv(500));
    const first = await runJob(s, "load", { files: [f1], madeBy }, "load-1");
    const made = (first.result as LoadResult).tables[0]!;
    assert.deepEqual([made.table, made.version, made.rows, made.changes], ["permits", 1, 500, null]);
    assert.deepEqual(rows(s, `SELECT "_key" FROM permits WHERE "_row" = 2`), [{ _key: "BP-1" }]);
    assert.equal(rows(s, "SELECT count(*) AS n FROM _row_hashes WHERE tbl = 'permits'")[0]!.n, 500);
    // A first load writes its rows, the memory of their hashes, and its own records: no index on either.
    assert.ok(first.rowsWritten! >= 1000 && first.rowsWritten! < 1100, `wrote ${first.rowsWritten}`);

    // A month later: 3 permits closed, 2 fees corrected, 1 withdrawn, 2 new.
    const f2 = await upload(
      s,
      "permits.csv",
      permitsCsv(
        500,
        (r, i) => (i === 7 ? null : i <= 3 ? [r[0]!, r[1]!, r[2]!, "Closed permit"] : i === 10 || i === 11 ? [r[0]!, r[1]!, "999.00", r[3]!] : r),
        [
          ["BP-501", "Owner 1", "10.00", "Open"],
          ["BP-502", "Owner 2", "20.00", "Open"],
        ],
      ),
    );
    const second = await runJob(s, "load", { files: [f2], madeBy }, "load-2");
    const again = (second.result as LoadResult).tables[0]!;
    // The table changes in place, by key: its version stays.
    assert.deepEqual([again.table, again.version, again.rows], ["permits", 1, 501]);
    assert.deepEqual(again.changes, { added: 2, changed: 5, removed: 1 });
    assert.deepEqual(
      rows(s, "SELECT d.kind AS kind, j.value AS k FROM _delta_rows AS d, json_each(d.keys) AS j WHERE d.tbl = 'permits' ORDER BY kind, k").map((r) => `${r.kind} ${r.k}`),
      ["added BP-501", "added BP-502", "changed BP-1", "changed BP-10", "changed BP-11", "changed BP-2", "changed BP-3", "removed BP-7"],
    );
    // The keys of a kind share a row of the record: three rows for eight keys.
    assert.equal(rows(s, "SELECT count(*) AS n FROM _delta_rows WHERE tbl = 'permits'")[0]!.n, 3);
    // The unique index on _key that finds a changed row, once (500 + 1); then only what changed: 2 new
    // rows and their index entries, 5 rows changed and 1 removed, 8 hashes, 3 rows of keys, and the
    // job's own records.
    whereBilled(() => assert.ok(second.rowsWritten! >= 501 + 4 + 5 + 1 + 8 + 3 && second.rowsWritten! < 501 + 4 + 5 + 1 + 8 + 3 + 40, `wrote ${second.rowsWritten}`));
    // Only one copy of the town's rows: the file is still in the store.
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits"]);
    const since = changedSince(s.storage.sql, "permits", 1)!;
    assert.deepEqual({ added: since.added, changed: since.changed, removed: since.removed, upTo: since.upTo }, { added: 2, changed: 5, removed: 1, upTo: 2 });
    assert.equal(changedSince(s.storage.sql, "permits", 0), null, "a reader from before the first load takes the whole table");
  });

  it("gives a repeated key its #2 in file order, and names the rows of a table with no key column by their hash", async () => {
    const s = setup();
    const dup = await upload(s, "fees.csv", "Fee Code,Amount\nA,1\nB,2\nA,3\n");
    await runJob(s, "load", { files: [dup], madeBy }, "dup");
    // "Fee Code" does not read like a row's identifier: every row is named by its hash.
    assert.ok(rows(s, `SELECT "_key" FROM fees`).every((r) => /^h:[0-9a-f]{16}$/.test(String(r._key))));
    // 200 parcels, one listed twice: a town's slip, so "Parcel ID" still names the rows.
    const parcels = `Parcel ID,Owner\n${Array.from({ length: 200 }, (_, i) => `P-${i + 1},Owner ${i}`).join("\n")}\nP-1,Owner again\n`;
    const ids = await upload(s, "parcels.csv", parcels);
    await runJob(s, "load", { files: [ids], madeBy }, "ids");
    assert.deepEqual(rows(s, `SELECT "_key" FROM parcels ORDER BY "_row"`).map((r) => r._key).slice(-3), ["P-199", "P-200", "P-1#2"]);
    assert.equal(rows(s, `SELECT count(DISTINCT "_key") AS n FROM parcels`)[0]!.n, 201);
    // The same file again: every row keeps its name, and nothing changed.
    const same = await upload(s, "parcels.csv", parcels);
    const again = await runJob(s, "load", { files: [same], madeBy }, "ids-2");
    assert.deepEqual((again.result as LoadResult).tables[0]!.changes, { added: 0, changed: 0, removed: 0 });
    // A town whose own key reads "Q-1#2" beside two "Q-1"s: the second "Q-1" would take that name
    // too, so the later of the two takes its row's own number instead.
    const clash = `Lot ID,Owner\n${Array.from({ length: 200 }, (_, i) => `Q-${i + 1},Owner ${i}`).join("\n")}\nQ-1,Owner again\nQ-1#2,Owner odd\n`;
    const lots = await upload(s, "lots.csv", clash);
    await runJob(s, "load", { files: [lots], madeBy }, "lots");
    assert.equal(rows(s, `SELECT count(DISTINCT "_key") AS n FROM lots`)[0]!.n, 202);
    assert.deepEqual(rows(s, `SELECT "_key" FROM lots ORDER BY "_row"`).map((r) => r._key).slice(-2), ["Q-1#2", "Q-1#2#r202"]);
  });

  it("keeps the key column an earlier load used, and reads as whole a reload where most rows differ", async () => {
    const s = setup();
    const f1 = await upload(s, "permits.csv", permitsCsv(40));
    await runJob(s, "load", { files: [f1], madeBy }, "l1");
    assert.equal(rows(s, "SELECT key_from FROM _tables WHERE name = 'permits'")[0]!.key_from, "Permit No");
    const f2 = await upload(s, "permits.csv", permitsCsv(40, (r) => [r[0]!, `${r[1]} Jr.`, r[2]!, r[3]!]));
    const second = await runJob(s, "load", { files: [f2], madeBy }, "l2");
    assert.equal((second.result as LoadResult).tables[0]!.changes, null);
    assert.equal(rows(s, "SELECT whole FROM _deltas WHERE tbl = 'permits' ORDER BY change DESC LIMIT 1")[0]!.whole, 1);
    assert.equal(changedSince(s.storage.sql, "permits", 1), null);
    // The memory holds the new rows, so the next upload compares with them.
    // Permit 4 is "Closed" (4 % 3 is 1): it is finaled.
    const f3 = await upload(s, "permits.csv", permitsCsv(40, (r, i) => [r[0]!, `${r[1]} Jr.`, r[2]!, i === 4 ? "Final" : r[3]!]));
    const third = await runJob(s, "load", { files: [f3], madeBy }, "l3");
    assert.deepEqual((third.result as LoadResult).tables[0]!.changes, { added: 0, changed: 1, removed: 0 });
  });
});

describe("LOAD writes only the rows that changed when a town sends its file again", () => {
  /** 1% of 1,000 permits change: 6 close (those already closed come out the same), 2 are withdrawn, 2 are new. */
  const monthLater = () =>
    permitsCsv(1000, (r, i) => (i === 50 || i === 51 ? null : i % 160 === 0 ? [r[0]!, r[1]!, r[2]!, "Closed"] : r), [
      ["BP-1001", "Owner 3", "1.00", "Open"],
      ["BP-1002", "Owner 4", "2.00", "Open"],
    ]);
  const closing = [160, 320, 480, 640, 800, 960].filter((i) => i % 3 !== 1).length;
  /** A table as a list a test compares, one entry a row by `_key`: its values and hash, never where it came from. */
  const raw = (s: Setup) => rows(s, `SELECT "_key", "_hash", "Permit No", "Owner", "Fee", "Status" FROM permits ORDER BY "_key"`).map((r) => JSON.stringify(r));

  it("changes a table in the database in place, by key: past the first such load, only the rows that changed", async () => {
    const s = setup();
    await runJob(s, "load", { files: [await upload(s, "permits.csv", permitsCsv(1000))] , madeBy }, "l1");
    // The first change in place makes the unique index on _key that finds a changed row (1,000 + 1).
    const f2 = await upload(s, "permits.csv", permitsCsv(1000, (r, i) => (i === 6 ? [r[0]!, r[1]!, r[2]!, "Final"] : r)));
    const second = await runJob(s, "load", { files: [f2], madeBy }, "l2");
    assert.deepEqual((second.result as LoadResult).tables[0]!.changes, { added: 0, changed: 1, removed: 0 });
    whereBilled(() => assert.ok(second.rowsWritten! >= 1001 && second.rowsWritten! < 1001 + 30, `wrote ${second.rowsWritten}`));
    const f3 = await upload(s, "permits.csv", monthLater());
    const third = await runJob(s, "load", { files: [f3], madeBy }, "l3");
    const made = (third.result as LoadResult).tables[0]!;
    // Permit 6, finaled last month, reads "Open" again this month: one more change.
    assert.deepEqual([made.version, made.rows, made.changes], [1, 1000, { added: 2, changed: closing + 1, removed: 2 }]);
    // 2 new rows and their index entries, the changed rows, 2 removed, their hashes, a row of keys for
    // each kind, and the job's own records: nothing like 1,000.
    assert.ok(third.rowsWritten! < 50, `wrote ${third.rowsWritten}`);
    // The same rows a whole load of that file makes; a changed row says it came from the new file.
    const whole = setup();
    await runJob(whole, "load", { files: [await upload(whole, "permits.csv", monthLater())], madeBy }, "w");
    assert.deepEqual(raw(s), raw(whole));
    assert.deepEqual(rows(s, `SELECT "_file" FROM permits WHERE "_key" IN ('BP-320', 'BP-1001') GROUP BY "_file"`), [{ _file: f3.id }]);
    // The store's memory holds every row's hash, and a new key takes a number a removed key left.
    assert.deepEqual(rows(s, `SELECT count(*) AS n FROM permits AS p JOIN _row_hashes AS m ON m.tbl = 'permits' AND m.k = p."_key" AND m.h = p."_hash"`), [{ n: 1000 }]);
    assert.ok(Number(rows(s, "SELECT max(n) AS m FROM _row_hashes WHERE tbl = 'permits'")[0]!.m) <= 1002);
  });

  it("keeps a parked table parked: its rows go to new files, and the database takes only the changed rows' hashes and keys", async () => {
    const { s } = await loadedAndShaped(1000);
    s.clock.advance(PARK_AFTER_MS + 1_000);
    await s.store.alarm();
    await settle(s);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
    const f2 = await upload(s, "permits.csv", monthLater());
    const load = await runJob(s, "load", { files: [f2], madeBy }, "load-2");
    const made = (load.result as LoadResult).tables[0]!;
    assert.deepEqual([made.version, made.rows, made.changes], [1, 1000, { added: 2, changed: closing, removed: 2 }]);
    // No row of the table: 8 hashes, a row of keys for each kind, the files' record, and the job's own records.
    assert.ok(load.rowsWritten! < 40, `wrote ${load.rowsWritten}`);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
    // The SHAPE reads the changed rows out of the files and writes only those; nothing comes back. Its
    // first change in place makes the unique index on _key it needs (1,000 + 1), as every SHAPE does.
    const shape = await runJob(s, "shape", shapeParams(), "shape-2");
    assert.deepEqual(shape.result, { table: "permits_clean", version: 1, rows: 1000, mode: "changed", added: 2, changed: closing, removed: 2 });
    whereBilled(() => assert.ok(shape.rowsWritten! >= 1001 && shape.rowsWritten! < 1001 + 40, `wrote ${shape.rowsWritten}`));
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
    // The next month: 10 owners become companies. Each step writes only those rows.
    const nextMonth = permitsCsv(1000, (r, i) => (i === 50 || i === 51 ? null : i % 160 === 0 ? [r[0]!, r[1]!, r[2]!, "Closed"] : i % 100 === 7 ? [r[0]!, `${r[1]} LLC`, r[2]!, r[3]!] : r), [
      ["BP-1001", "Owner 3", "1.00", "Open"],
      ["BP-1002", "Owner 4", "2.00", "Open"],
    ]);
    const f3 = await upload(s, "permits.csv", nextMonth);
    const load3 = await runJob(s, "load", { files: [f3], madeBy }, "load-3");
    assert.deepEqual((load3.result as LoadResult).tables[0]!.changes, { added: 0, changed: 10, removed: 0 });
    assert.ok(load3.rowsWritten! < 40, `wrote ${load3.rowsWritten}`);
    const shape3 = await runJob(s, "shape", shapeParams(), "shape-3");
    assert.deepEqual(shape3.result, { table: "permits_clean", version: 1, rows: 1000, mode: "changed", added: 0, changed: 10, removed: 0 });
    assert.ok(shape3.rowsWritten! < 40, `wrote ${shape3.rowsWritten}`);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
    // The same cleaned table a whole SHAPE makes from the files brought back.
    const byParts = cleaned(s);
    const whole = await runJob(s, "shape", shapeParams({ whole: true }), "shape-whole");
    assert.deepEqual((whole.result as { broughtBack?: string[] }).broughtBack, ["permits"]);
    assert.deepEqual(cleaned(s), byParts);
    // The files brought back are the newest upload's rows, each with the hash the memory holds.
    const fresh = setup();
    await runJob(fresh, "load", { files: [await upload(fresh, "permits.csv", nextMonth)], madeBy }, "w");
    assert.deepEqual(raw(s), raw(fresh));
    assert.deepEqual(rows(s, `SELECT count(*) AS n FROM permits AS p JOIN _row_hashes AS m ON m.tbl = 'permits' AND m.k = p."_key" AND m.h = p."_hash"`), [{ n: 1000 }]);
  });

  it("makes the table whole after a reload of a parked table stopped part way, and records that change whole", async () => {
    const { s } = await loadedAndShaped(5000);
    s.clock.advance(PARK_AFTER_MS + 1_000);
    await s.store.alarm();
    await settle(s);
    const serving = String(rows(s, "SELECT parked FROM _tables WHERE name = 'permits'")[0]!.parked);
    // The bucket refuses the reload's second part of new files, each time it is tried: the job fails.
    const put = s.r2.put.bind(s.r2);
    s.r2.put = (async (key: string, value: unknown, options?: never) => {
      if (key.includes("/parked/permits/") && key.endsWith("part-00001.jsonl.gz")) throw new Error("The bucket is not answering.");
      return put(key, value, options);
    }) as typeof s.r2.put;
    const changed = (r: string[], i: number) => (i % 50 === 0 ? [r[0]!, r[1]!, "0.01", r[3]!] : r);
    const f2 = await upload(s, "permits.csv", permitsCsv(5000, changed));
    const failed = value(await s.store.jobSubmit(RUN, { kind: "load", params: { files: [f2], madeBy }, requestKey: "load-2" })).job;
    await settle(s);
    assert.equal(value(await s.store.job(RUN, failed.id)).job.state, "failed");
    s.r2.put = put;
    // Its first part's rows are in the memory, not in the files that still serve.
    assert.equal(String(rows(s, "SELECT parked FROM _tables WHERE name = 'permits'")[0]!.parked), serving);
    assert.deepEqual(rows(s, "SELECT value FROM _meta WHERE key = 'load_reload:permits'"), [{ value: failed.id }]);
    // The next LOAD makes the table whole, and its change reads as whole to the steps after it.
    const again = await runJob(s, "load", { files: [f2], madeBy }, "load-3");
    const made = (again.result as LoadResult).tables[0]!;
    assert.deepEqual([made.version, made.changes], [2, null]);
    assert.equal(rows(s, "SELECT whole FROM _deltas WHERE tbl = 'permits' ORDER BY change DESC LIMIT 1")[0]!.whole, 1);
    assert.deepEqual(rows(s, "SELECT value FROM _meta WHERE key = 'load_reload:permits'"), []);
    // The SHAPE after it compares every row, and comes out as a whole SHAPE of the new upload would.
    await runJob(s, "shape", shapeParams(), "shape-2");
    const after = cleaned(s);
    await runJob(s, "shape", shapeParams({ whole: true }), "shape-whole");
    assert.deepEqual(after, cleaned(s));
    assert.deepEqual(rows(s, `SELECT fee FROM permits_clean WHERE "_key" = 'BP-50'`), [{ fee: 0.01 }]);
  });

  it("loads a parked table back into the database once an app on the store reads it, and refuses a reload without a column an app reads", async () => {
    const { s } = await loadedAndShaped(200);
    s.clock.advance(PARK_AFTER_MS + 1_000);
    await s.store.alarm();
    await settle(s);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
    // An app on the store has come to read the raw table: the town's next file makes it a new
    // version in the database, where the app reads it, and still records only the row that changed.
    const keep = { permits: [{ column: "Status", reader: "Permit Desk on prod" }] };
    const f2 = await upload(s, "permits.csv", permitsCsv(200, (r, i) => (i === 7 ? [r[0]!, r[1]!, r[2]!, "Final"] : r)));
    const back = await runJob(s, "load", { files: [f2], madeBy, keep }, "load-2");
    const made = (back.result as LoadResult).tables[0]!;
    assert.deepEqual([made.version, made.rows, made.changes], [2, 200, { added: 0, changed: 1, removed: 0 }]);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits", "permits_clean"]);
    assert.equal(value(await s.store.catalog(PERSON)).tables.find((t) => t.name === "permits")!.parked, undefined);
    // An app reads a column the town's file never had: the reload is refused, as a new version
    // without that column is, and the table stays as it was.
    const f3 = await upload(s, "permits.csv", permitsCsv(200, (r, i) => (i === 9 ? [r[0]!, r[1]!, r[2]!, "Final"] : r)));
    const params = { files: [f3], madeBy, keep: { permits: [{ column: "Parcel", reader: "Permit Desk on prod" }] } };
    const submitted = value(await s.store.jobSubmit(RUN, { kind: "load", params, requestKey: "load-3" })).job;
    await settle(s);
    const refused = value(await s.store.job(RUN, submitted.id)).job;
    assert.equal(refused.state, "failed");
    assert.match(refused.error ?? "", /has no column Parcel, which Permit Desk on prod reads, so it was not made: permits stays as it was/);
    assert.deepEqual(rows(s, `SELECT "Status" FROM permits WHERE "_key" = 'BP-9'`), [{ Status: "Open" }]);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits", "permits_clean"]);
  });

  it("makes a table in the database whole when the town's file lost more than twice the rows it holds", async () => {
    const s = setup();
    await runJob(s, "load", { files: [await upload(s, "permits.csv", permitsCsv(300))], madeBy }, "l1");
    // The next export holds only the last 50 permits: removing 250 rows in place would write each
    // one and its hash, where a new version writes the 50 and drops the old one for nothing.
    const cut = await upload(s, "permits.csv", permitsCsv(300, (r, i) => (i > 250 ? r : null)));
    const second = await runJob(s, "load", { files: [cut], madeBy }, "l2");
    const made = (second.result as LoadResult).tables[0]!;
    assert.deepEqual([made.version, made.rows, made.changes], [2, 50, null]);
    assert.ok(second.rowsWritten! < 450, `wrote ${second.rowsWritten}`);
    assert.deepEqual(rows(s, "SELECT count(*) AS n, min(n) AS lo, max(n) AS hi FROM _row_hashes WHERE tbl = 'permits'"), [{ n: 50, lo: 1, hi: 50 }]);
  });

  it("marks the files a table was parked in to go once the table, brought back, changes in place", async () => {
    const { s } = await loadedAndShaped(200);
    s.clock.advance(PARK_AFTER_MS + 1_000);
    await s.store.alarm();
    await settle(s);
    // Brought back, its files still hold its rows: parked again before any change, it reuses them.
    await runJob(s, "bring_back", { table: "permits" }, "back");
    assert.deepEqual(rows(s, "SELECT superseded_at IS NULL AS live FROM _parked WHERE tbl = 'permits'"), [{ live: 1 }]);
    // The town's next file changes a row in place: the files no longer hold the table's rows.
    const f2 = await upload(s, "permits.csv", permitsCsv(200, (r, i) => (i === 9 ? [r[0]!, r[1]!, r[2]!, "Final"] : r)));
    const load = await runJob(s, "load", { files: [f2], madeBy }, "load-2");
    assert.deepEqual((load.result as LoadResult).tables[0]!.changes, { added: 0, changed: 1, removed: 0 });
    assert.deepEqual(rows(s, "SELECT superseded_at IS NULL AS live FROM _parked WHERE tbl = 'permits'"), [{ live: 0 }]);
  });

  it("brings a parked driver back when its changed rows' statements would be too long to run", async () => {
    // A wide town file, and a SELECT just under the store's limit: given the parked rows as JSON,
    // with every column cast, it would pass the 100 KB a statement may hold.
    const fields = Array.from({ length: 59 }, (_, i) => `Field ${String(i + 1).padStart(2, "0")}`);
    const wide = (status: (i: number) => string) =>
      [["Permit No", ...fields, "Status"].join(","), ...Array.from({ length: 200 }, (_, i) => [`BP-${i + 1}`, ...fields.map(() => "v"), status(i + 1)].join(","))].join("\r\n");
    const sql = `SELECT "_key", "_file", "_row", "Permit No" AS permit_no, "Status" AS status, length('${"x".repeat(97_300)}') AS pad FROM permits`;
    const params = { into: "permits_clean", sql, goal: "one row per permit", sources: JSON.stringify([["permits", ["_file", "_row", "_key", "_hash", "Permit No", ...fields, "Status"]]]), madeBy };
    const s = setup();
    await runJob(s, "load", { files: [await upload(s, "permits.csv", wide(() => "Open"))], madeBy }, "load-1");
    await runJob(s, "shape", params, "shape-1");
    s.clock.advance(PARK_AFTER_MS + 1_000);
    await s.store.alarm();
    await settle(s);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
    await runJob(s, "load", { files: [await upload(s, "permits.csv", wide((i) => (i === 7 ? "Final" : "Open")))], madeBy }, "load-2");
    const shape = await runJob(s, "shape", params, "shape-2");
    assert.deepEqual((shape.result as { broughtBack?: string[] }).broughtBack, ["permits"]);
    assert.deepEqual(rows(s, `SELECT status FROM permits_clean WHERE "_key" = 'BP-7'`), [{ status: "Final" }]);
  });

  it("makes the table whole when what a reload keeps between its chunks would pass what a store keeps for a job", async () => {
    // 150 permits whose numbers run to 10,000 characters, each sent twice the next month: the
    // "#2" a reload keeps for each repeated key, and the new keys it has not yet recorded, would
    // pass the 2 MB a store keeps in a value long before the reload ends.
    const permit = (i: number) => `BP-${String(i).padStart(9_997, "0")}`;
    const month = (twice: boolean) => {
      const lines = ["Permit No,Owner"];
      for (let i = 1; i <= 150; i++) {
        lines.push(`${permit(i)},Owner ${i}`);
        if (twice) lines.push(`${permit(i)},Owner ${i} again`);
      }
      return lines.join("\r\n");
    };
    const s = setup();
    await runJob(s, "load", { files: [await upload(s, "permits.csv", month(false))], madeBy }, "l1");
    const second = await runJob(s, "load", { files: [await upload(s, "permits.csv", month(true))], madeBy }, "l2");
    const made = (second.result as LoadResult).tables[0]!;
    // A new version, and its change recorded whole: the steps after it read every row.
    assert.deepEqual([made.version, made.rows, made.changes], [2, 300, null]);
    assert.equal(rows(s, "SELECT whole FROM _deltas WHERE tbl = 'permits' ORDER BY change DESC LIMIT 1")[0]!.whole, 1);
    // The same rows a whole load of that file makes, still named by the permit number the first load
    // chose (a store meeting this file first finds no key column in it): a repeat is "#2".
    const whole = setup();
    await runJob(whole, "load", { files: [await upload(whole, "permits.csv", month(true))], madeBy }, "w");
    const values = (x: Setup) => rows(x, `SELECT "_hash", "Owner" FROM permits ORDER BY "_hash"`).map((r) => JSON.stringify(r));
    assert.deepEqual(values(s), values(whole));
    assert.deepEqual(rows(s, `SELECT count(DISTINCT "_key") AS keys, count(*) FILTER (WHERE "_key" = "Permit No" || '#2' AND "Owner" LIKE '% again') AS repeats FROM permits`), [{ keys: 300, repeats: 150 }]);
    assert.deepEqual(rows(s, `SELECT count(*) AS n FROM permits AS p JOIN _row_hashes AS m ON m.tbl = 'permits' AND m.k = p."_key" AND m.h = p."_hash"`), [{ n: 300 }]);
  });
});

describe("SHAPE writes only the rows whose source rows changed", () => {
  it("makes the table whole the first time, then after each 1% reload writes only the changed rows", async () => {
    const { s, shape } = await loadedAndShaped(1000);
    assert.deepEqual(shape.result, { table: "permits_clean", version: 1, rows: 1000, mode: "whole", added: 1000, changed: 0, removed: 0, why: "it is the first time this table is made" });
    // CREATE TABLE AS (1,000 + 2), the swap, and the job's records. The index a change by _key
    // needs waits for the first such change: a table made whole each time never pays for it.
    whereBilled(() => assert.ok(shape.rowsWritten! >= 1002 && shape.rowsWritten! < 1060, `wrote ${shape.rowsWritten}`));
    const saved = JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = 'shape:permits_clean'")[0]!.value));
    assert.equal(saved.driver, "permits");
    assert.deepEqual(rows(s, "SELECT name FROM pragma_index_list('permits_clean')"), []);

    // 1% of the permits change: 6 close, 2 are withdrawn, 2 are new.
    const f2 = await upload(
      s,
      "permits.csv",
      permitsCsv(1000, (r, i) => (i === 50 || i === 51 ? null : i % 160 === 0 ? [r[0]!, r[1]!, r[2]!, "Closed"] : r), [
        ["BP-1001", "Owner 3", "1.00", "Open"],
        ["BP-1002", "Owner 4", "2.00", "Open"],
      ]),
    );
    await runJob(s, "load", { files: [f2], madeBy }, "load-2");
    const changed = await runJob(s, "shape", shapeParams(), "shape-2");
    // Rows 160, 320, …, 960 change; those already "Closed" (i % 3 === 1) come out the same.
    const closing = [160, 320, 480, 640, 800, 960].filter((i) => i % 3 !== 1).length;
    assert.deepEqual(changed.result, { table: "permits_clean", version: 1, rows: 1000, mode: "changed", added: 2, changed: closing, removed: 2 });
    // The unique index on _key, once (1,000 + 1), then the rows that changed, their keys in the
    // store's record, and the job's own records.
    assert.equal(rows(s, `SELECT count(*) AS n FROM pragma_index_list('permits_clean') WHERE "unique" = 1`)[0]!.n, 1);
    whereBilled(() => assert.ok(changed.rowsWritten! >= 1001 && changed.rowsWritten! < 1001 + 60, `wrote ${changed.rowsWritten}`));

    // The next month's 1%: the rows that changed and the records, nothing like 1,000.
    const f3 = await upload(
      s,
      "permits.csv",
      permitsCsv(1000, (r, i) => (i === 50 || i === 51 ? null : i % 160 === 0 ? [r[0]!, r[1]!, r[2]!, "Closed"] : i % 100 === 7 ? [r[0]!, `${r[1]} LLC`, r[2]!, r[3]!] : r), [
        ["BP-1001", "Owner 3", "1.00", "Open"],
        ["BP-1002", "Owner 4", "2.00", "Open"],
      ]),
    );
    await runJob(s, "load", { files: [f3], madeBy }, "load-3");
    const next = await runJob(s, "shape", shapeParams(), "shape-3");
    assert.deepEqual(next.result, { table: "permits_clean", version: 1, rows: 1000, mode: "changed", added: 0, changed: 10, removed: 0 });
    assert.ok(next.rowsWritten! < 40, `wrote ${next.rowsWritten}`);
    whereBilled(() => assert.ok(next.rowsWritten! * 25 < shape.rowsWritten!));

    // The same table as a whole run would make from the new upload.
    const inPlace = cleaned(s);
    await runJob(s, "shape", shapeParams({ whole: true }), "shape-whole");
    assert.deepEqual(cleaned(s), inPlace);
  });

  it("writes nothing but its own records when no source changed, and records what it changed for the steps after it", async () => {
    const { s } = await loadedAndShaped(300);
    const again = await runJob(s, "shape", shapeParams(), "shape-again");
    assert.deepEqual(again.result, { table: "permits_clean", version: 1, rows: 300, mode: "unchanged", added: 0, changed: 0, removed: 0 });
    assert.ok(again.rowsWritten! < 12, `wrote ${again.rowsWritten}`);
    // A step after SHAPE reads the cleaned table's own changes.
    const before = lastChange(s.storage.sql, "permits_clean");
    const f2 = await upload(s, "permits.csv", permitsCsv(300, (r, i) => (i === 9 ? [r[0]!, "Someone Else", r[2]!, r[3]!] : r)));
    await runJob(s, "load", { files: [f2], madeBy }, "load-2");
    await runJob(s, "shape", shapeParams(), "shape-3");
    const since = changedSince(s.storage.sql, "permits_clean", before)!;
    assert.deepEqual([since.added, since.changed, since.removed], [0, 1, 0]);
    assert.deepEqual(rows(s, `${since.keysSql}`, ...since.params).map((r) => r.k), ["BP-9"]);
  });

  it("keeps the record of what changed only until its readers have read it", async () => {
    const { s } = await loadedAndShaped(200);
    const keys = (table: string) => Number(rows(s, "SELECT coalesce(sum(json_array_length(keys)), 0) AS n FROM _delta_rows WHERE tbl = ?", table)[0]!.n);
    for (let month = 1; month <= 4; month++) {
      // Each month renames the owners of 4 more permits; the earlier months' names stay.
      const f = await upload(s, "permits.csv", permitsCsv(200, (r, i) => (i % 50 >= 1 && i % 50 <= month ? [r[0]!, `${r[1]} (${i % 50})`, r[2]!, r[3]!] : r)));
      await runJob(s, "load", { files: [f], madeBy }, `load-${month + 1}`);
      // Before the SHAPE reads them, the reload's keys wait for it.
      assert.equal(keys("permits"), 4, `month ${month}`);
      await runJob(s, "shape", shapeParams(), `shape-${month + 1}`);
      // The SHAPE marked what it read: the keys go. No step reads the cleaned table yet, so it
      // keeps its newest two changes' keys, and the record does not grow month after month.
      assert.equal(keys("permits"), 0, `month ${month}`);
      assert.equal(keys("permits_clean"), Math.min(month, 2) * 4, `month ${month}`);
    }
    assert.deepEqual(rows(s, "SELECT reader, tbl FROM _delta_reads"), [{ reader: "shape:permits_clean", tbl: "permits" }]);
    // A reader that falls behind its table's newest 16 changes takes the whole table.
    assert.equal(changedSince(s.storage.sql, "permits", 1), null);
  });

  it("rewrites only the rows a changed lookup table changes, reading the driver a range at a time", async () => {
    const s = setup();
    const permits = await upload(s, "permits.csv", permitsCsv(300));
    const statuses = await upload(s, "statuses.csv", "Code,Label\nOpen,Open permit\nClosed,Closed permit\nFinal,Final inspection\n");
    await runJob(s, "load", { files: [permits, statuses], madeBy }, "load-1");
    const sql = `SELECT p."_key", p."Permit No" AS permit_no, s."Label" AS status_label FROM permits AS p LEFT JOIN statuses AS s ON s."Code" = p."Status"`;
    const params = { into: "permits_labeled", sql, goal: null, sources: JSON.stringify([["permits", PERMIT_COLUMNS], ["statuses", ["_file", "_row", "_key", "_hash", "Code", "Label"]]]), madeBy };
    const first = await runJob(s, "shape", params, "shape-1");
    assert.equal((first.result as { mode: string }).mode, "whole");
    const label = await upload(s, "statuses.csv", "Code,Label\nOpen,Open permit\nClosed,Closed permit\nFinal,Final inspection passed\n");
    await runJob(s, "load", { files: [label], madeBy }, "load-2");
    const readUpTo = lastChange(s.storage.sql, "permits_labeled");
    const second = await runJob(s, "shape", params, "shape-2");
    // Every third permit is "Final": 100 rows change; the other 200 come out the same and are not
    // written. The first change in place makes the index on _key (300 + 1).
    assert.deepEqual(second.result, { table: "permits_labeled", version: 1, rows: 300, mode: "changed", added: 0, changed: 100, removed: 0 });
    whereBilled(() => assert.ok(second.rowsWritten! >= 301 + 100 && second.rowsWritten! < 301 + 100 + 40, `wrote ${second.rowsWritten}`));
    assert.equal(rows(s, `SELECT count(*) AS n FROM permits_labeled WHERE status_label = 'Final inspection passed'`)[0]!.n, 100);
    // Its history event can undo it: its restore point is the moment before the change opened.
    const event = rows(s, "SELECT note, restore_point FROM _history WHERE note LIKE 'permits_labeled: 100 rows changed in place%'")[0]!;
    whereBookmarks(() => assert.ok(event.restore_point, "the change in place has a restore point"));
    // The steps after it read only those 100 rows.
    const since = changedSince(s.storage.sql, "permits_labeled", readUpTo)!;
    assert.deepEqual([since.added, since.changed, since.removed], [0, 100, 0]);
  });

  it("compares the rows when its driver was made anew, and writes only those that differ", async () => {
    const { s, shape } = await loadedAndShaped(100);
    // Most owners renamed: the LOAD records the reload whole, as most of its rows are new.
    const f2 = await upload(s, "permits.csv", permitsCsv(100, (r, i) => (i <= 60 ? [r[0]!, `${r[1]} Jr.`, r[2]!, r[3]!] : r)));
    const load = await runJob(s, "load", { files: [f2], madeBy }, "load-2");
    assert.equal((load.result as LoadResult).tables[0]!.changes, null);
    const again = await runJob(s, "shape", shapeParams(), "shape-2");
    assert.deepEqual(again.result, { table: "permits_clean", version: 1, rows: 100, mode: "changed", added: 0, changed: 60, removed: 0 });
    // The index on _key (100 + 1) and the 60 rows that differ: never more than a whole table.
    whereBilled(() => assert.ok(again.rowsWritten! >= 161 && again.rowsWritten! < 161 + 40, `wrote ${again.rowsWritten}`));
    assert.ok(again.rowsWritten! < shape.rowsWritten! + 101);
  });

  it("takes no driver whose own _key repeats, nor one for a first run that made no rows", async () => {
    const s = setup();
    const permits = await upload(s, "permits.csv", permitsCsv(40));
    await runJob(s, "load", { files: [permits], madeBy }, "load-1");
    const sources = JSON.stringify([["permits", PERMIT_COLUMNS]]);
    const driverOf = (into: string) => JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = ?", `shape:${into}`)[0]!.value)).driver;
    // Made whole each run (UNION ALL), and the same permit twice.
    const twice = `SELECT "_key", "Owner" AS owner FROM permits UNION ALL SELECT "_key", "Owner" FROM permits WHERE "Permit No" = 'BP-1'`;
    await runJob(s, "shape", { into: "doubled", sql: twice, goal: null, sources, madeBy }, "doubled");
    await runJob(s, "shape", { into: "from_doubled", sql: `SELECT "_key", owner FROM doubled`, goal: null, sources: "[]", madeBy }, "from-doubled");
    assert.equal(driverOf("from_doubled"), null);
    // No pending permits yet: the run made no rows, which say nothing of whose `_key`s they carry.
    const pending = `SELECT 'p-' || "_key" AS "_key", "Owner" AS owner FROM permits WHERE "Status" = 'Pending'`;
    await runJob(s, "shape", { into: "pending", sql: pending, goal: null, sources, madeBy }, "pending");
    assert.equal(driverOf("pending"), null);
    // A driver another step made, whose rows come to repeat a `_key`: the next run is whole.
    await runJob(s, "shape", { into: "owners_a", sql: `SELECT "_key", "Owner" AS owner FROM permits`, goal: null, sources, madeBy }, "a-1");
    const b = { into: "owners_b", sql: `SELECT "_key", upper(owner) AS owner FROM owners_a`, goal: null, sources: "[]", madeBy };
    await runJob(s, "shape", b, "b-1");
    assert.equal(driverOf("owners_b"), "owners_a");
    await runJob(s, "shape", { into: "owners_a", sql: twice, goal: null, sources, madeBy }, "a-2");
    const again = await runJob(s, "shape", b, "b-2");
    assert.deepEqual([(again.result as { mode: string }).mode, (again.result as { why?: string }).why], ["whole", "owners_a's rows no longer have one _key each"]);
    assert.equal(rows(s, "SELECT count(*) AS n FROM owners_b")[0]!.n, 41);
  });

  it("makes the table whole when most rows of a LOAD named by their values are new", async () => {
    const s = setup();
    const fees = (raise: number) => `Fee Code,Amount\n${Array.from({ length: 200 }, (_, i) => `F${i % 7},${i + raise}`).join("\n")}\n`;
    await runJob(s, "load", { files: [await upload(s, "fees.csv", fees(0))], madeBy }, "load-1");
    assert.equal(rows(s, "SELECT key_from FROM _tables WHERE name = 'fees'")[0]!.key_from, "");
    const params = { into: "fees_clean", sql: `SELECT "_key", "Fee Code" AS code, CAST("Amount" AS REAL) AS amount FROM fees`, goal: null, sources: JSON.stringify([["fees", ["_file", "_row", "_key", "_hash", "Fee Code", "Amount"]]]), madeBy };
    await runJob(s, "shape", params, "shape-1");
    // Every fee raised: every row is new by its hash.
    await runJob(s, "load", { files: [await upload(s, "fees.csv", fees(1000))], madeBy }, "load-2");
    const raised = await runJob(s, "shape", params, "shape-2");
    assert.deepEqual([(raised.result as { mode: string }).mode, (raised.result as { why?: string }).why], ["whole", "most of fees's rows are new, and they are named by their values"]);
    // CREATE TABLE AS of 200 rows and the records, where a change in place would write about three times that.
    assert.ok(raised.rowsWritten! < 260, `wrote ${raised.rowsWritten}`);
  });

  it("does not bring back a parked table whose name is only a column's", async () => {
    const s = setup();
    const fees = await upload(s, "fees.csv", `Fee No,Amount\n${Array.from({ length: 30 }, (_, i) => `FN-${i + 1},${i}`).join("\n")}\n`);
    const cases = await upload(s, "cases.csv", `Case No,Fees\n${Array.from({ length: 30 }, (_, i) => `C-${i + 1},${i}`).join("\n")}\n`);
    await runJob(s, "load", { files: [fees, cases], madeBy }, "load-1");
    await runJob(s, "shape", { into: "fees_clean", sql: `SELECT "_key", "Amount" AS amount FROM fees`, goal: null, sources: "[]", madeBy }, "fees-1");
    s.clock.advance(PARK_AFTER_MS + 1_000);
    await s.store.alarm();
    await settle(s);
    assert.deepEqual(namedInSelect(`SELECT "_key", "Fees" AS fees FROM cases`).get("fees"), undefined);
    const made = await runJob(s, "shape", { into: "cases_clean", sql: `SELECT "_key", "Fees" AS fees FROM cases`, goal: null, sources: "[]", madeBy }, "cases-1");
    assert.equal((made.result as { broughtBack?: string[] }).broughtBack, undefined);
    assert.equal(value(await s.store.catalog(PERSON)).tables.find((t) => t.name === "fees")!.parked?.rows, 30);
    assert.deepEqual(Object.keys(JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = 'shape:cases_clean'")[0]!.value)).read), ["cases"]);
  });

  it("reads a view's tables through it, and takes no lookup for its driver", async () => {
    const s = setup();
    const permits = await upload(s, "permits.csv", permitsCsv(60));
    // A second table keyed by the same permit numbers, read as a lookup.
    const fees = await upload(s, "fees.csv", `Permit No,Paid\n${Array.from({ length: 60 }, (_, i) => `BP-${i + 1},${i % 2 ? "yes" : "no"}`).join("\n")}\n`);
    await runJob(s, "load", { files: [permits, fees], madeBy }, "load-1");
    // Both tables hold every _key the result does: neither can be the driver.
    const both = `SELECT p."_key", p."Permit No" AS permit_no, f."Paid" AS paid FROM permits AS p JOIN fees AS f ON f."_key" = p."_key"`;
    const sources = JSON.stringify([["fees", ["_file", "_row", "_key", "_hash", "Permit No", "Paid"]], ["permits", PERMIT_COLUMNS]]);
    await runJob(s, "shape", { into: "permit_fees", sql: both, goal: null, sources, madeBy }, "both");
    assert.equal(JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = 'shape:permit_fees'")[0]!.value)).driver, null);
    // A SELECT that groups rows makes each run whole.
    const grouped = `SELECT "Status" AS status, count(*) AS n FROM permits GROUP BY "Status"`;
    await runJob(s, "shape", { into: "by_status", sql: grouped, goal: null, sources: JSON.stringify([["permits", PERMIT_COLUMNS]]), madeBy }, "grouped");
    assert.equal(JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = 'shape:by_status'")[0]!.value)).driver, null);
    // A SHAPE over a program's view reads the tables the view reads: a change to them is a change
    // to it. It names no table of its own in a FROM, so it is made whole each time.
    await runJob(s, "shape", { into: "paid_view", sql: `SELECT "_key", permit_no FROM permit_fees WHERE paid = 'yes'`, goal: null, sources: "[]", madeBy, as: "view" }, "view-1");
    await runJob(s, "shape", { into: "paid_list", sql: `SELECT "_key", permit_no FROM paid_view`, goal: null, sources: "[]", madeBy }, "over-view");
    const saved = JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = 'shape:paid_list'")[0]!.value));
    assert.deepEqual([Object.keys(saved.read), saved.driver], [["permit_fees"], null]);
    assert.equal(rows(s, "SELECT count(*) AS n FROM paid_list")[0]!.n, 30);
  });

  it("makes the whole table when its SQL changes, keeps the version before, and drops older ones", async () => {
    const { s } = await loadedAndShaped(50);
    const newSql = CLEAN_SQL.replace("upper(\"Status\")", "lower(\"Status\")");
    // Each its own run, as a program's nightly runs are: one run keeps every version it made, for its Undo.
    const run = (n: number) => ({ madeBy: { runId: `mrn-${n}`, step: "s1" } });
    const second = await runJob(s, "shape", shapeParams({ sql: newSql, ...run(2) }), "shape-2");
    assert.deepEqual([(second.result as { mode: string }).mode, (second.result as { why?: string }).why], ["whole", "its SQL changed"]);
    await runJob(s, "shape", shapeParams({ sql: CLEAN_SQL, ...run(3) }), "shape-3");
    await runJob(s, "shape", shapeParams({ whole: true, ...run(4) }), "shape-4");
    // One working copy and the version before it.
    assert.deepEqual(tablesNamed(s, "permits_clean%"), ["permits_clean", "permits_clean__v3"]);
    // History keeps an event for every version, each with its restore point.
    const notes = rows(s, "SELECT note FROM _history WHERE kind = 'table' AND note LIKE 'permits_clean: version%' ORDER BY at, id").map((r) => String(r.note).split(",")[0]);
    assert.deepEqual(notes, ["permits_clean: version 1", "permits_clean: version 2", "permits_clean: version 3", "permits_clean: version 4"]);
  });

  it("falls back to the whole table when two of its new rows would share a _key", async () => {
    const s = setup();
    const permits = await upload(s, "permits.csv", permitsCsv(30));
    const owners = await upload(s, "owners.csv", "Owner Name,Phone\nOwner 1,555-0001\nOwner 2,555-0002\n");
    await runJob(s, "load", { files: [permits, owners], madeBy }, "load-1");
    const sql = `SELECT p."_key", p."Owner" AS owner, o."Phone" AS phone FROM permits AS p LEFT JOIN owners AS o ON o."Owner Name" = p."Owner"`;
    const params = { into: "permit_phones", sql, goal: null, sources: JSON.stringify([["owners", ["_file", "_row", "_key", "_hash", "Owner Name", "Phone"]], ["permits", PERMIT_COLUMNS]]), madeBy };
    await runJob(s, "shape", params, "shape-1");
    // An owner listed twice: the permits of "Owner 1" now join two rows each.
    const twice = await upload(s, "owners.csv", "Owner Name,Phone\nOwner 1,555-0001\nOwner 2,555-0002\nOwner 1,555-0009\n");
    await runJob(s, "load", { files: [twice], madeBy }, "load-2");
    const second = await runJob(s, "shape", params, "shape-2");
    assert.deepEqual([(second.result as { mode: string }).mode, (second.result as { why?: string }).why], ["whole", "two of its new rows have the same _key"]);
    // Made whole, its rows no longer have one _key each, so the next run makes it whole too.
    const saved = JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = 'shape:permit_phones'")[0]!.value));
    assert.equal(saved.driver, null);
  });
});

describe("parking a LOAD's table once it is cleaned", () => {
  async function parked(n = 120) {
    const { s } = await loadedAndShaped(n);
    assert.ok(rows(s, "SELECT park_at FROM _tables WHERE name = 'permits'")[0]!.park_at, "the SHAPE gave permits a time to park");
    s.clock.advance(PARK_AFTER_MS + 1_000);
    await s.store.alarm();
    await settle(s);
    return s;
  }

  it("says a step's table is parked, not that the store has no such table", async () => {
    const s = await parked();
    const params = { table: "permits", into: "permit_flags", rules: [{ rule: "required", columns: ["Owner"] }], key: null, changed: null, words: null, signature: "[]", madeBy };
    const job = value(await s.store.jobSubmit(RUN, { kind: "check", params, requestKey: "check-parked" })).job;
    await settle(s);
    const ended = value(await s.store.job(RUN, job.id)).job;
    assert.equal(ended.state, "failed");
    assert.match(ended.error ?? "", /permits is parked/);
  });

  it("leaves a table an app on the store reads in the database", async () => {
    const { s } = await loadedAndShaped(60);
    assert.ok(rows(s, "SELECT park_at FROM _tables WHERE name = 'permits'")[0]!.park_at);
    await runJob(s, "shape", { ...shapeParams(), keep: { permits: [{ column: "Fee", reader: "Permit Desk on prod" }] } }, "shape-2");
    assert.equal(rows(s, "SELECT park_at FROM _tables WHERE name = 'permits'")[0]!.park_at, null);
    s.clock.advance(PARK_AFTER_MS + 1_000);
    await s.store.alarm();
    await settle(s);
    assert.deepEqual(rows(s, "SELECT id FROM _jobs WHERE kind = 'park'"), []);
    assert.deepEqual(tablesNamed(s, "permits"), ["permits"]);
  });

  /** A copy of `s` on a store of its own, on the same bucket, and the export's manifest. */
  async function copied(s: Setup) {
    const ex = value(await s.store.exportStart(PERSON, { requestKey: "copy:1", purpose: "copy", mode: "whole", personal: "keep" }));
    await settle(s);
    assert.equal(value(await s.store.job(PERSON, ex.job.id)).job.state, "done");
    const manifest = JSON.parse(new TextDecoder().decode(s.r2.objects.get(`stores/${STORE}/exports/${ex.exportId}/manifest.json`)!.bytes)) as ExportManifest;
    const dst = setup({ r2: s.r2, clock: s.clock });
    const { job } = value(await dst.store.importStart(COPY_RUN, { from: { storeId: STORE, exportId: ex.exportId }, requestKey: "copy" }));
    await settle(dst);
    const ended = value(await dst.store.job(COPY_RUN, job.id)).job;
    assert.equal(ended.state, "done", ended.error ?? "");
    return { manifest, dst };
  }

  it("leaves a parked table's rows out of an export and names it, and the file holds no record of what changed", async () => {
    const s = await parked();
    const { manifest: copy, dst } = await copied(s);
    assert.deepEqual(copy.parkedLeftOut, ["permits"]);
    // What the store wrote into a database stays with it: its memory, each write's rows, and the record of each write.
    s.storage.sql.exec("INSERT INTO _pushed (target, k, sent, held, at, put) VALUES ('[\"dbc_1\",\"town\",\"permits\"]', 'P1', 'a', 'b', '2026-11-01T00:00:00.000Z', 1)");
    s.storage.sql.exec("INSERT INTO _push_writes (job, part, k, did, state) VALUES ('job_1', 0, 'P1', 'inserted', 'done')");
    s.storage.sql.exec("INSERT INTO _meta (key, value) VALUES ('push-write:job_1', '{}')");
    // A file to download is one SQLite reads as it stands; a copy's has no index b-trees.
    const download = value(await s.store.exportStart(PERSON, { requestKey: "download-1" }));
    await settle(s);
    const manifest = JSON.parse(new TextDecoder().decode(s.r2.objects.get(`stores/${STORE}/exports/${download.exportId}/manifest.json`)!.bytes)) as ExportManifest;
    assert.deepEqual(manifest.parkedLeftOut, ["permits"]);
    const parts = manifest.db.pieces.map((p) => s.r2.objects.get(p.key)!.bytes);
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.byteLength;
    }
    const file = host().database(bytes);
    for (const table of ["_deltas", "_delta_rows", "_delta_reads", "_row_hashes", "_pushed", "_push_writes", "_parked"]) {
      assert.deepEqual({ ...file.prepare(`SELECT count(*) AS n FROM ${table}`).get() }, { n: 0 }, table);
    }
    assert.deepEqual({ ...file.prepare("SELECT count(*) AS n FROM _meta WHERE key LIKE 'push-write:%'").get() }, { n: 0 });
    assert.deepEqual(tablesNamed(dst, "permits%"), ["permits_clean"]);
    const names = value(await dst.store.catalog(COPY_RUN)).tables.map((t) => t.name);
    assert.ok(names.includes("permits_clean") && !names.includes("permits"), names.join(", "));
  });

  it("makes a SHAPE's table whole on its first run in a store made from an export, whose views stay program views", async () => {
    const { s } = await loadedAndShaped(60);
    await runJob(s, "shape", { into: "ready_permits", sql: "SELECT permit_no FROM permits_clean", goal: null, sources: "[]", madeBy, as: "view" }, "view-1");
    const { dst } = await copied(s);
    assert.equal(value(await dst.store.catalog(COPY_RUN)).tables.find((t) => t.name === "ready_permits")!.group, READY_GROUP);
    const again = await runJob(dst, "shape", shapeParams(), "shape-2", COPY_RUN);
    assert.deepEqual([(again.result as { mode: string }).mode, (again.result as { why?: string }).why], ["whole", "the store has no record of what changed since its last run"]);
    // The swap made the view again on the new table, not on the version it keeps.
    assert.deepEqual(rows(dst, "SELECT count(*) AS n FROM ready_permits"), [{ n: 60 }]);
    assert.doesNotMatch(String(rows(dst, "SELECT sql FROM sqlite_master WHERE name = 'ready_permits'")[0]!.sql), /__v\d/);
  });

  it("waits for the next UTC day when the store is past its daily write limit, and its alarm goes on", async () => {
    const budget = new FakeBudget();
    const { s } = await loadedAndShaped(1_200, { budget });
    // The organization's limit comes down below what the store has written; its alarm asks again.
    budget.limit = 1_000;
    s.clock.advance(PARK_AFTER_MS + 1_000);
    await s.store.alarm();
    assert.deepEqual(rows(s, "SELECT id FROM _jobs WHERE kind = 'park'"), [], "a park is a job, and past the limit the store takes no new job");
    assert.deepEqual(tablesNamed(s, "permits"), ["permits"]);
    const at = String(rows(s, "SELECT park_at FROM _tables WHERE name = 'permits'")[0]!.park_at);
    assert.equal(at.slice(11), "00:00:00.000Z");
    // The next UTC day counts from nothing, and the park goes ahead.
    s.clock.advance(Date.parse(at) - s.clock.now() + 1_000);
    await s.store.alarm();
    await settle(s);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
  });

  it("writes its rows to the store's files 10 minutes after a SHAPE read it, drops it, and lists it as parked", async () => {
    const s = await parked();
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
    const job = rows(s, "SELECT state, by_sub, rows_written FROM _jobs WHERE kind = 'park'")[0]!;
    assert.deepEqual([job.state, job.by_sub], ["done", "store:parking"]);
    // The park writes its own records and drops the table, which writes nothing.
    assert.ok(Number(job.rows_written) < 20, `wrote ${job.rows_written}`);
    const objects = [...s.r2.objects.keys()].filter((k) => k.includes("/parked/permits/"));
    assert.deepEqual(objects.map((k) => k.split("/").pop()), ["part-00000.jsonl.gz", "manifest.json"]);
    const catalog = value(await s.store.catalog(PERSON));
    const t = catalog.tables.find((x) => x.name === "permits")!;
    assert.equal(t.kind, "program");
    assert.equal(t.group, "From the town");
    assert.deepEqual([t.parked?.rows, t.count], [120, 120]);
    assert.ok((t.parked?.bytes ?? 0) > 100);
    assert.deepEqual(t.columns.map((c) => c.name), PERMIT_COLUMNS);
    // A query of it, or a page of its rows, says where its rows are.
    const r = await s.store.query(PERSON, { sql: "SELECT * FROM permits" });
    assert.equal(r.ok, false);
    assert.equal((r as { code: string }).code, "table_parked");
    assert.equal((r as { error: string }).error, "permits is parked: its rows are in the store's files, not its database. Bring it back to read it.");
    const page = await s.store.rows(PERSON, { database: "store", table: "permits", offset: 0, limit: 10 });
    assert.equal((page as { code: string }).code, "table_parked");
    // History says so.
    assert.ok(rows(s, "SELECT note FROM _history WHERE note LIKE 'permits: parked%'").length === 1);
  });

  it("brings it back with the same rows and version, and parks it again without writing its files again", async () => {
    const s = await parked();
    const files = [...s.r2.objects.keys()].filter((k) => k.includes("/parked/")).length;
    const back = await runJob(s, "bring_back", { table: "permits" }, "back-1");
    assert.deepEqual(back.result, { table: "permits", version: 1, rows: 120, parked: false });
    // Bringing back writes each row once, and the job's own records.
    assert.ok(back.rowsWritten! >= 120 && back.rowsWritten! < 160, `wrote ${back.rowsWritten}`);
    assert.equal(rows(s, `SELECT count(*) AS n FROM permits`)[0]!.n, 120);
    assert.deepEqual(rows(s, `SELECT "_key", "_hash" FROM permits ORDER BY "_row" LIMIT 2`).map((r) => r._key), ["BP-1", "BP-2"]);
    const hashes = rows(s, `SELECT count(*) AS n FROM permits AS p JOIN _row_hashes AS m ON m.tbl = 'permits' AND m.k = p."_key" AND m.h = p."_hash"`)[0]!.n;
    assert.equal(hashes, 120, "every row came back as it was");
    assert.equal(value(await s.store.catalog(PERSON)).tables.find((t) => t.name === "permits")!.parked, undefined);
    // Back for a while: it parks again once its time comes.
    assert.ok(rows(s, "SELECT park_at FROM _tables WHERE name = 'permits'")[0]!.park_at);
    await runJob(s, "park", { table: "permits" }, "park-again");
    assert.equal([...s.r2.objects.keys()].filter((k) => k.includes("/parked/")).length, files, "the same files serve again");
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
  });

  it("takes a new upload of a parked table's file and keeps it parked: new files, only the changed row recorded, and the old files go after the restore window", async () => {
    const s = await parked(90);
    const old = String(rows(s, "SELECT prefix FROM _parked")[0]!.prefix);
    const f2 = await upload(s, "permits.csv", permitsCsv(90, (r, i) => (i === 4 ? [r[0]!, r[1]!, "4.44", r[3]!] : r)));
    const load = await runJob(s, "load", { files: [f2], madeBy }, "load-2");
    const made = (load.result as LoadResult).tables[0]!;
    assert.deepEqual([made.version, made.rows, made.changes], [1, 90, { added: 0, changed: 1, removed: 0 }]);
    assert.match(made.notes.join(" "), /permits stays parked/);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
    const t = value(await s.store.catalog(PERSON)).tables.find((x) => x.name === "permits")!;
    assert.deepEqual([t.parked?.rows, t.count, t.version], [90, 90, 1]);
    // The files before are marked to go; the new ones serve.
    assert.deepEqual(
      rows(s, "SELECT prefix, superseded_at IS NULL AS serving FROM _parked ORDER BY at").map((r) => [String(r.prefix) === old, r.serving]),
      [
        [true, 0],
        [false, 1],
      ],
    );
    // The SHAPE after it changes one row, read out of the files: nothing comes back.
    const shape = await runJob(s, "shape", shapeParams(), "shape-2");
    assert.deepEqual(shape.result, { table: "permits_clean", version: 1, rows: 90, mode: "changed", added: 0, changed: 1, removed: 0 });
    assert.deepEqual(rows(s, `SELECT fee FROM permits_clean WHERE "_key" = 'BP-4'`), [{ fee: 4.44 }]);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
    s.clock.advance(PARKED_KEEP_MS + PARK_AFTER_MS);
    await s.store.alarm();
    await settle(s);
    const left = [...s.r2.objects.keys()].filter((k) => k.includes("/parked/"));
    assert.ok(left.length > 0 && left.every((k) => !k.startsWith(old)), `old files left: ${left.join(", ")}`);
  });

  it("brings parked sources back itself when a SHAPE must read every row", async () => {
    const s = await parked(60);
    const whole = await runJob(s, "shape", shapeParams({ whole: true }), "shape-whole");
    assert.deepEqual([(whole.result as { mode: string }).mode, (whole.result as { broughtBack?: string[] }).broughtBack], ["whole", ["permits"]]);
    assert.equal(rows(s, "SELECT count(*) AS n FROM permits_clean")[0]!.n, 60);
    // And parks it again later.
    assert.ok(rows(s, "SELECT park_at FROM _tables WHERE name = 'permits'")[0]!.park_at);
  });

  it("waits while someone reads it: a read moves its time to park", async () => {
    const { s } = await loadedAndShaped(30);
    s.clock.advance(PARK_AFTER_MS - 60_000);
    value(await s.store.rows(PERSON, { database: "store", table: "permits", offset: 0, limit: 10 }));
    s.clock.advance(61_000);
    await s.store.alarm();
    await settle(s);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits", "permits_clean"], "read a minute ago: not parked");
    s.clock.advance(PARK_AFTER_MS);
    await s.store.alarm();
    await settle(s);
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
  });

  it("keeps no files for good from a park that failed: they go once the restore window has passed", async () => {
    const { s } = await loadedAndShaped(30);
    const set = s.r2.objects.set.bind(s.r2.objects);
    s.r2.objects.set = (key, object) => {
      if (key.endsWith("/manifest.json")) throw new Error("The bucket is not answering.");
      return set(key, object);
    };
    s.clock.advance(PARK_AFTER_MS + 1_000);
    await s.store.alarm();
    await settle(s);
    s.r2.objects.set = set;
    assert.equal(rows(s, "SELECT state FROM _jobs WHERE kind = 'park'")[0]!.state, "failed");
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits", "permits_clean"], "the table stays");
    assert.equal([...s.r2.objects.keys()].filter((k) => k.includes("/parked/")).length, 1, "its first part was written");
    assert.ok(rows(s, "SELECT superseded_at FROM _parked")[0]!.superseded_at, "marked to go");
    s.clock.advance(PARKED_KEEP_MS + 1_000);
    await s.store.alarm();
    assert.deepEqual([...s.r2.objects.keys()].filter((k) => k.includes("/parked/")), []);
  });

  it("parks nothing while another job is open, and only the tables a SHAPE read", async () => {
    const { s } = await loadedAndShaped(20);
    const other = await upload(s, "other.csv", "Permit No,Owner\nBP-1,A\n");
    await runJob(s, "load", { files: [other], madeBy }, "load-other");
    s.clock.advance(PARK_AFTER_MS + 1_000);
    await s.store.alarm();
    await settle(s);
    assert.deepEqual(tablesNamed(s, "other%"), ["other"], "no SHAPE read it");
    assert.deepEqual(tablesNamed(s, "permits%"), ["permits_clean"]);
  });
});

describe("the cleanup steps, by the store's record of what changed", () => {
  /** The town sends its file again, and the SHAPE runs. */
  async function reload(s: Setup, n: number, change: (row: string[], i: number) => string[], key: string) {
    const f = await upload(s, "permits.csv", permitsCsv(n, change));
    await runJob(s, "load", { files: [f], madeBy }, `load-${key}`);
    return runJob(s, "shape", shapeParams(), `shape-${key}`);
  }
  const STATUSES = ["OPEN", "CLOSED", "FINAL"];
  const check = (over: Record<string, unknown> = {}) => ({ table: "permits_clean", into: "permit_flags", rules: [{ rule: "one_of", column: "status", values: STATUSES }], key: null, changed: null, words: null, signature: "[]", madeBy, ...over });
  const flagged = (s: Setup) => rows(s, "SELECT t.permit_no AS permit_no, f.value AS value FROM permit_flags f JOIN permits_clean t ON t.rowid = f.row_id WHERE f.state = 'open' ORDER BY 1");
  const newestChange = (s: Setup, before: number) => rows(s, "SELECT whole, added, changed, removed FROM _deltas WHERE tbl = 'permits_clean' AND change > ? ORDER BY change", before);
  const keysSince = (s: Setup, before: number) => rows(s, "SELECT keys FROM _delta_rows WHERE tbl = 'permits_clean' AND change > ?", before).flatMap((r) => JSON.parse(String(r.keys)) as string[]).sort();

  it("CHECK tests only the rows that changed since its last run, and tests no row when none did", async () => {
    const { s } = await loadedAndShaped(40);
    await runJob(s, "check", check(), "check-1");
    assert.deepEqual(flagged(s), []);
    // A write the store has no record of: a run that reads by its record does not look at this row.
    s.storage.sql.exec("UPDATE permits_clean SET status = 'UNSEEN' WHERE permit_no = 'BP-7'");
    await reload(s, 40, (r, i) => (i === 9 ? [r[0]!, r[1]!, r[2]!, "Bogus"] : r), "2");
    const second = await runJob(s, "check", check(), "check-2");
    assert.deepEqual(flagged(s), [{ permit_no: "BP-9", value: "BOGUS" }]);
    assert.ok(second.rowsWritten! < 30, `wrote ${second.rowsWritten}`);
    const idle = await runJob(s, "check", check(), "check-3");
    assert.deepEqual(flagged(s), [{ permit_no: "BP-9", value: "BOGUS" }]);
    assert.ok(idle.rowsWritten! < 12, `wrote ${idle.rowsWritten}`);
  });

  it("CHECK's unique rule finds the row that did not change when a changed row comes to repeat it", async () => {
    const { s } = await loadedAndShaped(40);
    const unique = check({ rules: [{ rule: "unique", columns: ["fee"] }] });
    await runJob(s, "check", unique, "check-1");
    assert.deepEqual(flagged(s), []);
    await reload(s, 40, (r, i) => (i === 9 ? [r[0]!, r[1]!, `${(3 * 7) % 500}.50`, r[3]!] : r), "2");
    await runJob(s, "check", unique, "check-2");
    assert.deepEqual(flagged(s).map((f) => f.permit_no), ["BP-3", "BP-9"]);
  });

  it("CLASSIFY records which rows it wrote, so the steps after it read only those", async () => {
    const { s } = await loadedAndShaped(40);
    const classify = (add: unknown[]) => ({ table: "permits_clean", column: "status", into: "status_class", answers: "answers_status", classes: ["Open", "Closed", "Final"], sure: 0.9, add, by: "model:test", changed: null, madeBy });
    await runJob(s, "classify", classify(["Open", "Closed", "Final"].map((answer) => ({ value: answer.toUpperCase(), answer, sure: 1 }))), "classify-1");
    await reload(s, 40, (r, i) => (i === 5 ? [r[0]!, r[1]!, r[2]!, "Open"] : i === 6 ? [r[0]!, r[1]!, r[2]!, "Closed"] : r), "2");
    const before = lastChange(s.storage.sql, "permits_clean");
    const done = await runJob(s, "classify", classify([]), "classify-2");
    assert.equal((done.result as { written: number }).written, 2);
    assert.deepEqual(newestChange(s, before), [{ whole: 0, added: 0, changed: 2, removed: 0 }]);
    assert.deepEqual(keysSince(s, before), ["BP-5", "BP-6"]);
    // The next run finds nothing to write, and records nothing.
    const after = lastChange(s.storage.sql, "permits_clean");
    assert.equal(((await runJob(s, "classify", classify([]), "classify-3")).result as { written: number }).written, 0);
    assert.deepEqual(newestChange(s, after), []);
  });

  it("MATCH reads only the changed rows' values, and every value once its reference table changed", async () => {
    const { s } = await loadedAndShaped(40);
    const owners = { into: "owners", sql: "SELECT DISTINCT owner AS name FROM permits_clean", goal: null, sources: "[]", madeBy };
    await runJob(s, "shape", owners, "owners-1");
    const match = (pass: string, over: Record<string, unknown> = {}) => ({ table: "permits_clean", column: "owner", to: "owners", toColumn: "name", take: "name", into: "owner_match", answers: "matches_owner", kind: "text", sure: 0.9, ask: 300, add: [], by: "rule", changed: null, madeBy, pass, ...over });
    const found = async (key: string) => ((await runJob(s, "match", match("candidates"), key)).result as { exact: number }).exact;
    assert.equal(await found("m-1"), 40, "the first run reads every value");
    await runJob(s, "match", match("apply", { complete: true }), "a-1");
    assert.equal(await found("m-2"), 0, "nothing changed");
    await reload(s, 40, (r, i) => (i === 5 ? [r[0]!, "Owner 7", r[2]!, r[3]!] : r), "2");
    assert.equal(await found("m-3"), 1, "the one row that changed");
    await runJob(s, "shape", owners, "owners-2");
    assert.equal(await found("m-4"), 39, "the reference table changed: every value, one fewer now");
  });

  it("MATCH reads its values again while a run left some for later", async () => {
    const { s } = await loadedAndShaped(40);
    await runJob(s, "shape", { into: "owners", sql: "SELECT DISTINCT owner AS name FROM permits_clean", goal: null, sources: "[]", madeBy }, "owners-1");
    const match = (pass: string, over: Record<string, unknown> = {}) => ({ table: "permits_clean", column: "owner", to: "owners", toColumn: "name", take: "name", into: "owner_match", answers: "matches_owner", kind: "text", sure: 0.9, ask: 300, add: [], by: "rule", changed: null, madeBy, pass, ...over });
    await runJob(s, "match", match("apply"), "a-1");
    assert.equal(((await runJob(s, "match", match("candidates"), "m-1")).result as { exact: number }).exact, 40);
  });

  for (const how of ["its keys", "ranges of rows"]) {
    it(`keeps a person's fix through a SHAPE that changes the row in place by ${how}`, async () => {
      const { s } = await loadedAndShaped(40);
      s.storage.sql.exec("UPDATE permits_clean SET owner = 'Fixed Owner' WHERE \"_key\" = 'BP-5'");
      s.storage.sql.exec(
        "INSERT INTO _fixes (id, tbl, key_columns, row_key, column_name, was, value, version, by_sub, at) VALUES ('fix_1', 'permits_clean', ?, ?, 'owner', 'Owner 5', 'Fixed Owner', 1, 'user:u-1', '2026-11-09T00:00:00.000Z')",
        JSON.stringify(["_key"]),
        JSON.stringify({ _key: "BP-5" }),
      );
      const f = await upload(s, "permits.csv", permitsCsv(40, (r, i) => (i === 5 ? [r[0]!, r[1]!, "99.50", r[3]!] : r)));
      await runJob(s, "load", { files: [f], madeBy }, "load-2");
      if (how === "ranges of rows") s.storage.sql.exec("UPDATE _deltas SET kept = 0 WHERE tbl = 'permits'");
      const shaped = await runJob(s, "shape", shapeParams(), "shape-2");
      assert.equal((shaped.result as { mode: string }).mode, "changed");
      assert.deepEqual(rows(s, "SELECT owner, fee FROM permits_clean WHERE \"_key\" = 'BP-5'"), [{ owner: "Fixed Owner", fee: 99.5 }]);
    });
  }

  it("records a person's fix as a change of that row, so the next step reads it", async () => {
    const { s } = await loadedAndShaped(40);
    await runJob(s, "check", check(), "check-1");
    await reload(s, 40, (r, i) => (i === 9 ? [r[0]!, r[1]!, r[2]!, "Bogus"] : r), "2");
    await runJob(s, "check", check(), "check-2");
    const page = value(await s.store.reviewRows(PERSON, { table: "permits_clean", offset: 0, limit: 50 }));
    const before = lastChange(s.storage.sql, "permits_clean");
    value(await s.store.reviewFix(PERSON, { table: "permits_clean", id: page.rows[0]!.id, column: "status", was: "BOGUS", value: "OPEN" }));
    assert.deepEqual(newestChange(s, before), [{ whole: 0, added: 0, changed: 1, removed: 0 }]);
    assert.deepEqual(keysSince(s, before), ["BP-9"]);
  });
});

describe("what a SELECT reads, row by row", () => {
  it("makes each row from one row when it groups, counts, windows, limits and joins sets nowhere", () => {
    assert.equal(rowLocal(CLEAN_SQL), true);
    assert.equal(rowLocal(`SELECT "_key", max(CAST("Fee" AS REAL), 0) AS fee, min(a, b, c) AS m FROM permits`), true);
    assert.equal(rowLocal(`SELECT "_key", "Max" AS max_fee FROM permits`), true);
    for (const sql of [
      `SELECT "Status", count(*) FROM permits GROUP BY "Status"`,
      `SELECT "_key", max("Fee") FROM permits`,
      `SELECT DISTINCT "_key" FROM permits`,
      `SELECT "_key" FROM permits LIMIT 10`,
      `SELECT "_key", row_number() OVER (ORDER BY "_key") FROM permits`,
      `SELECT "_key" FROM permits UNION SELECT "_key" FROM fees`,
      `SELECT "_key", rowid FROM permits`,
      `SELECT "_key", "_rowid_" FROM permits`,
      // The clock and chance make another row each run with no source row changing.
      `SELECT "_key", strftime('%Y', 'now') AS as_of FROM permits`,
      `SELECT "_key", CURRENT_TIMESTAMP AS at FROM permits`,
      `SELECT "_key", random() AS r FROM permits`,
    ]) {
      assert.equal(rowLocal(sql), false, sql);
    }
  });

  it("reads as tables only the names in a FROM or a JOIN, a subquery's included", () => {
    const sql = `SELECT p."_key", "Fees", (SELECT count(*) FROM owners AS o WHERE o.k = p.k) AS n FROM permits AS p, main.lookup WHERE p.x IN (SELECT k FROM codes) ORDER BY fees`;
    assert.deepEqual(Object.fromEntries(namedInSelect(sql)), {
      owners: { plain: 1, withSchema: 0 },
      permits: { plain: 1, withSchema: 0 },
      lookup: { plain: 0, withSchema: 1 },
      codes: { plain: 1, withSchema: 0 },
    });
  });

  it("counts the FROMs and JOINs that read a table, never a column or a name after a dot", () => {
    const sql = `SELECT p."_key", permits_count, f.permits FROM permits AS p JOIN fees AS f ON f."_key" = p."_key", other`;
    assert.deepEqual(["permits", "fees", "other", "p"].map((t) => tableRefs(sql, t)), [1, 1, 1, 0]);
    assert.equal(tableRefs(`SELECT * FROM permits AS a JOIN permits AS b ON a.x = b.y`, "permits"), 2);
    assert.equal(tableRefs(`SELECT * FROM main.permits`, "permits"), 0);
  });

  it("shadows the driver's name with a CTE of some of its rows, first in a WITH that has one", () => {
    assert.equal(shadowed(`SELECT * FROM permits`, "permits", "x = 1"), `WITH "permits" AS (SELECT * FROM main."permits" WHERE x = 1)\nSELECT * FROM permits`);
    assert.equal(shadowed(`with recursive t AS (SELECT 1) SELECT * FROM permits, t`, "permits", "x = 1"), `WITH RECURSIVE "permits" AS (SELECT * FROM main."permits" WHERE x = 1), t AS (SELECT 1) SELECT * FROM permits, t`);
  });
});

describe("Ready is a view over the cleaned table", () => {
  it("keeps no rows of its own, follows the cleaned table, and is made again when that table is made anew", async () => {
    const { s } = await loadedAndShaped(40);
    const sql = `SELECT "_key", permit_no AS "PermitNumber", fee AS "FeeAmount", status AS "Status" FROM permits_clean WHERE status <> 'FINAL'`;
    const view = await runJob(s, "shape", { into: "ready_permits", sql, goal: "permits for the target", sources: JSON.stringify([["permits_clean", ["_key"]]]), madeBy, as: "view" }, "ready-1");
    assert.deepEqual(view.result, { table: "ready_permits", version: 1, rows: 27, mode: "view", added: 0, changed: 0, removed: 0 });
    // A view's definition and its records: no copy of a row.
    assert.ok(view.rowsWritten! < 15, `wrote ${view.rowsWritten}`);
    assert.deepEqual(rows(s, "SELECT type FROM sqlite_master WHERE name = 'ready_permits'"), [{ type: "view" }]);
    const t = value(await s.store.catalog(PERSON)).tables.find((x) => x.name === "ready_permits")!;
    assert.deepEqual([t.kind, t.group, t.count, t.view], ["program", "Ready", 27, true]);
    // "Status" comes from upper(…), which CREATE TABLE … AS leaves untyped and a view's table_info
    // calls BLOB: its values are text, so the catalog says text.
    assert.deepEqual(t.columns.map((c) => [c.name, c.type]), [["_key", "text"], ["PermitNumber", "text"], ["FeeAmount", "real"], ["Status", "text"]]);
    // A page of it carries the words, not their lengths.
    const page = value(await s.store.rows(PERSON, { database: "store", table: "ready_permits", offset: 0, limit: 3 }));
    assert.deepEqual(page.rows.map((r) => r[page.columns.indexOf("Status")]), ["CLOSED", "OPEN", "CLOSED"]);
    // The cleaned table changes in place: the view shows it at once.
    // Permit 2 was "Final" (2 % 3 is 2): it opens again, so it is ready.
    const before = value(await s.store.catalog(PERSON)).tables.find((x) => x.name === "permits_clean")!;
    const f2 = await upload(s, "permits.csv", permitsCsv(40, (r, i) => (i === 2 ? [r[0]!, r[1]!, r[2]!, "Open"] : r)));
    await runJob(s, "load", { files: [f2], madeBy }, "load-2");
    await runJob(s, "shape", shapeParams(), "shape-2");
    assert.equal(rows(s, "SELECT count(*) AS n FROM ready_permits")[0]!.n, 28);
    // A view reads no changes, so it keeps no mark that would hold the cleaned table's keys back.
    assert.deepEqual(rows(s, "SELECT reader FROM _delta_reads WHERE reader = 'shape:ready_permits'"), []);
    // The catalog names the change, as the version stays: a reader keeps pages by both.
    const after = value(await s.store.catalog(PERSON)).tables.find((x) => x.name === "permits_clean")!;
    assert.equal(after.version, before.version);
    assert.ok((after.change ?? 0) > (before.change ?? 0), `change ${before.change} → ${after.change}`);
    assert.equal(after.view, undefined);
    // A change still open (a run by ranges between two chunks) is not the table's number yet: its
    // close gives the table a new one, so pages read while it ran are not kept as the change's.
    s.storage.sql.exec("INSERT INTO _deltas (change, tbl, version, whole, added, changed, removed, kept, job, at) VALUES (999, 'permits_clean', 1, 1, 0, 0, 0, 1, 'job_open', '2026-11-08T00:00:00.000Z')");
    assert.equal(value(await s.store.catalog(PERSON)).tables.find((x) => x.name === "permits_clean")!.change, after.change);
    s.storage.sql.exec("DELETE FROM _deltas WHERE change = 999");
    // The cleaned table made anew: the view is made again on it, not left on the version kept.
    await runJob(s, "shape", shapeParams({ whole: true }), "shape-whole");
    assert.equal(rows(s, "SELECT count(*) AS n FROM ready_permits")[0]!.n, 28);
    assert.doesNotMatch(String(rows(s, "SELECT sql FROM sqlite_master WHERE name = 'ready_permits'")[0]!.sql), /__v\d/);
  });

  it("refuses a LOAD's table, which the store parks once it is cleaned", async () => {
    const { s } = await loadedAndShaped(5);
    const job = value(await s.store.jobSubmit(RUN, { kind: "shape", params: { into: "ready_raw", sql: "SELECT * FROM permits", goal: null, sources: JSON.stringify([["permits", PERMIT_COLUMNS]]), madeBy, as: "view" }, requestKey: "raw-view" })).job;
    await settle(s);
    const ended = value(await s.store.job(RUN, job.id)).job;
    assert.equal(ended.state, "failed");
    assert.match(ended.error ?? "", /A view reads cleaned tables, and permits is a LOAD's table/);
  });
});
