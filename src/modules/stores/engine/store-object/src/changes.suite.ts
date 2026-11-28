// What a run's statements changed, kept row by row (changes.ts), on stand-ins for a store's storage:
// a recorded batch keeps each row's values before and after and counts only the rows it changed; a
// trial changes nothing and keeps what it would change; a change made with `expect` is refused when
// its rows moved since its trial, and goes through when only what it writes differs (a time); an
// undo puts every row back, newest first, holding a row changed since or one a constraint now
// refuses; a row INSERT OR REPLACE or a table's ON CONFLICT REPLACE replaced, a foreign key's cascade,
// a moved rowid and bytes come back; a table's own trigger runs as it does outside a run and stays
// quiet while Undo puts its rows back; a table the change made goes; and a recorded batch refuses what
// it could not undo, however its SQL is written.

import { describe, it, host, stateOf, filesOf } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import type { StoreDeps } from "./core.js";
import { StoreHandler } from "./handler.js";
import { CHANGE_SAMPLE_ROWS, TRIAL_KEPT_MS } from "./changes.js";
import { checkHandler } from "./jobs/check.js";
import { classifyHandler } from "./jobs/classify.js";
import { loadHandler } from "./jobs/load.js";
import { profileHandler } from "./jobs/profile.js";
import { shapeHandler } from "./jobs/shape.js";
import type { JobHandler } from "./jobs/types.js";
import { programTables, settleRunChanges } from "./program-tables.js";
import type { ChangeSummary, ExecBody, ExecResult, StoreCaller, StoreResult } from "./types.js";
import type { CheckResult, ClassifyResult, LoadResult, ProfileResult, ShapeResult } from "../../store-readers/src/jobs.js";

const A = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ME: StoreCaller = { storeId: A, actor: "user:u-1" };
const RUN = { run: "run-1", step: "s2", key: "run-1:s2@" };

function setup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map() };
  const store = new StoreHandler(state as never, { FILES: r2.asBucket() }, deps);
  /** A managed table of fees, three permits, as a county sends them. */
  const fees = async () => {
    value(
      await store.exec(ME, {
        sql: [
          "CREATE TABLE fees (id INTEGER PRIMARY KEY, permit TEXT NOT NULL, fee TEXT)",
          "INSERT INTO fees (id, permit, fee) VALUES (1, 'BP-1', '$1,250.00'), (2, 'BP-2', '480'), (3, 'BP-3', '$90.5')",
        ].join(";\n"),
      }),
    );
  };
  const rows = (sql: string, ...params: unknown[]) => storage.sql.exec(sql, ...params).toArray() as Record<string, unknown>[];
  return { clock, storage, store, fees, rows };
}

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function refusal<T>(result: StoreResult<T>): { status: number; code: string; error: string } {
  assert.equal(result.ok, false, "expected a refusal");
  return result as { status: number; code: string; error: string };
}

const CLEAN = "UPDATE fees SET fee = replace(replace(fee, '$', ''), ',', '') WHERE fee GLOB '*[$,]*'";

describe("a run's change, kept row by row", () => {
  it("keeps each row it changed with its values before and after, and counts only those rows", async () => {
    const { store, fees, rows } = setup();
    await fees();
    const done: ExecResult = value(await store.exec(ME, { sql: CLEAN, record: RUN }));
    assert.equal(done.changes, 2, "the record's own rows are not the batch's");
    assert.ok(done.change);
    assert.equal(done.change.state, "kept");
    assert.equal(done.change.rows, 2);
    assert.deepEqual(done.change.tables, [{ name: "fees", inserted: 0, updated: 2, deleted: 0, made: false }]);
    const kept = rows("SELECT tbl, op, rid_before, rid_after, before, after FROM _change_rows WHERE change = ? ORDER BY seq", done.change.id);
    assert.equal(kept.length, 2);
    assert.deepEqual(JSON.parse(String(kept[0]!.before)), [{ id: 1, permit: "BP-1", fee: "$1,250.00" }]);
    assert.deepEqual(JSON.parse(String(kept[0]!.after)), [{ id: 1, permit: "BP-1", fee: "1250.00" }]);
    assert.deepEqual(
      rows("SELECT fee FROM fees ORDER BY id").map((r) => r.fee),
      ["1250.00", "480", "90.5"],
    );
    // The store's own triggers went with the batch.
    assert.deepEqual(rows("SELECT name FROM sqlite_master WHERE name LIKE '\\_chg\\_%' ESCAPE '\\'"), []);
    const history = rows("SELECT kind, note, ref FROM _history WHERE ref = ?", `change:${done.change.id}`);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.kind, "table");
    assert.match(String(history[0]!.note), /changed 2 rows of fees/);
  });

  it("tries a batch: what it would change is kept, and nothing in the table changes", async () => {
    const { store, fees, rows } = setup();
    await fees();
    const tried = value(await store.exec(ME, { trial: { sql: CLEAN, ...RUN } }));
    assert.equal(tried.changes, 0);
    assert.equal(tried.change?.state, "trial");
    assert.equal(tried.change?.rows, 2);
    assert.deepEqual(
      rows("SELECT fee FROM fees ORDER BY id").map((r) => r.fee),
      ["$1,250.00", "480", "$90.5"],
    );
    const kept = rows("SELECT op, before, after FROM _change_rows WHERE change = ? ORDER BY seq", tried.change!.id);
    assert.equal(kept.length, 2);
    assert.deepEqual(JSON.parse(String(kept[1]!.after)), [{ id: 3, permit: "BP-3", fee: "90.5" }]);
    assert.equal(rows("SELECT count(*) AS n FROM _history WHERE ref LIKE 'change:%'")[0]!.n, 0, "a trial is no event of the store's history");
  });

  it("refuses a trial whose SQL sits beside it, where a store before trials would run it", async () => {
    const { store, fees } = setup();
    await fees();
    const body = { sql: CLEAN, trial: { sql: CLEAN } } as ExecBody;
    assert.equal(refusal(await store.exec(ME, body)).code, "bad_request");
  });

  it("keeps the first rows of a large trial and counts every row", async () => {
    const { store, rows } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE n (id INTEGER PRIMARY KEY, v INTEGER)" }));
    value(await store.exec(ME, { sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 450) INSERT INTO n (v) SELECT x FROM c" }));
    const count = Number(rows("SELECT count(*) AS n FROM n")[0]!.n);
    assert.equal(count, 450);
    const tried = value(await store.exec(ME, { trial: { sql: "UPDATE n SET v = v + 1", ...RUN } }));
    assert.equal(tried.change?.rows, 450);
    assert.equal(rows("SELECT count(*) AS n FROM _change_rows WHERE change = ?", tried.change!.id)[0]!.n, CHANGE_SAMPLE_ROWS);
  });

  it("writes a change its trial showed, and refuses one whose rows moved since", async () => {
    const { store, fees, rows } = setup();
    await fees();
    value(await store.exec(ME, { trial: { sql: CLEAN, ...RUN } }));
    // Someone fixes BP-3 by hand between the trial and the yes.
    value(await store.exec(ME, { sql: "UPDATE fees SET fee = '90.50' WHERE id = 3" }));
    const moved = refusal(await store.exec(ME, { sql: CLEAN, record: { ...RUN, expect: true } }));
    assert.equal(moved.code, "change_moved");
    assert.equal(moved.status, 409);
    assert.deepEqual(
      rows("SELECT fee FROM fees ORDER BY id").map((r) => r.fee),
      ["$1,250.00", "480", "90.50"],
      "nothing was written",
    );
    assert.equal(rows("SELECT count(*) AS n FROM _changes WHERE state = 'kept'")[0]!.n, 0);
    // Tried again, the change matches and is written.
    value(await store.exec(ME, { trial: { sql: CLEAN, ...RUN } }));
    const done = value(await store.exec(ME, { sql: CLEAN, record: { ...RUN, expect: true } }));
    assert.equal(done.change?.rows, 1);
    assert.equal(rows("SELECT fee FROM fees WHERE id = 1")[0]!.fee, "1250.00");
  });

  it("matches its trial when only what it writes differs, such as the time", async () => {
    const { store, fees, clock } = setup();
    await fees();
    value(await store.exec(ME, { sql: "ALTER TABLE fees ADD COLUMN checked TEXT" }));
    const sql = "UPDATE fees SET checked = strftime('%Y-%m-%dT%H:%M:%f', 'now') || hex(randomblob(4)) WHERE fee GLOB '$*'";
    value(await store.exec(ME, { trial: { sql, ...RUN } }));
    clock.advance(5_000);
    const done = value(await store.exec(ME, { sql, record: { ...RUN, expect: true } }));
    assert.equal(done.change?.rows, 2);
  });

  it("counts a run's change toward the day's writes as the batch alone counts: its trial and its record are the store's own", async () => {
    const writes = async (store: ReturnType<typeof setup>["store"]) => value(await store.stats(ME)).writes!.rows;
    // The same batch run plainly, on a store of its own: what the day should count.
    const plain = setup();
    await plain.fees();
    const plainBefore = await writes(plain.store);
    value(await plain.store.exec(ME, { sql: CLEAN }));
    const plainRows = (await writes(plain.store)) - plainBefore;
    assert.ok(plainRows > 0);
    const run = setup();
    await run.fees();
    const before = await writes(run.store);
    value(await run.store.exec(ME, { trial: { sql: CLEAN, ...RUN } }));
    assert.equal(await writes(run.store), before, "a trial writes nothing the day counts");
    value(await run.store.exec(ME, { sql: CLEAN, record: { ...RUN, expect: true } }));
    assert.equal((await writes(run.store)) - before, plainRows);
  });

  it("refuses a change with no trial to match", async () => {
    const { store, fees } = setup();
    await fees();
    assert.equal(refusal(await store.exec(ME, { sql: CLEAN, record: { ...RUN, expect: true } })).code, "change_moved");
  });
});

describe("Undo of a run's change", () => {
  it("puts every row back, newest first, and holds a row changed since", async () => {
    const { store, fees, rows } = setup();
    await fees();
    const done = value(
      await store.exec(ME, {
        sql: [CLEAN, "DELETE FROM fees WHERE id = 2", "INSERT INTO fees (permit, fee) VALUES ('BP-4', '75')", "UPDATE fees SET fee = fee || '.00' WHERE id = 1"].join(";\n"),
        record: RUN,
      }),
    );
    // BP-1, which two statements changed, counts once.
    assert.deepEqual(done.change?.tables, [{ name: "fees", inserted: 1, updated: 2, deleted: 1, made: false }]);
    // BP-3 is changed by hand after the run: it stays as the person left it.
    value(await store.exec(ME, { sql: "UPDATE fees SET fee = '91' WHERE id = 3" }));
    const undone = value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    assert.equal(undone.change?.state, "undone");
    assert.equal(undone.change?.restored, 3);
    assert.equal(undone.change?.held, 1);
    assert.deepEqual(rows("SELECT id, permit, fee FROM fees ORDER BY id"), [
      { id: 1, permit: "BP-1", fee: "$1,250.00" },
      { id: 2, permit: "BP-2", fee: "480" },
      { id: 3, permit: "BP-3", fee: "91" },
    ]);
    // An undo asked again answers what it did, and does nothing more.
    const again = value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    // Named with another run, the change is none of that run's.
    assert.equal(refusal(await store.exec(ME, { undo: { change: done.change!.id, run: "run-2" } })).code, "change_not_found");
    assert.deepEqual(again.change, undone.change);
    assert.equal(rows("SELECT count(*) AS n FROM _history WHERE note LIKE 'Undid%'")[0]!.n, 1);
  });

  it("brings back a row INSERT OR REPLACE replaced", async () => {
    const { store, fees, rows } = setup();
    await fees();
    const done = value(await store.exec(ME, { sql: "INSERT OR REPLACE INTO fees (id, permit, fee) VALUES (2, 'BP-2', '500')", record: RUN }));
    // The row REPLACE took out and the one it put in its rowid are one row changed.
    assert.deepEqual(done.change?.tables, [{ name: "fees", inserted: 0, updated: 1, deleted: 0, made: false }]);
    value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    assert.deepEqual(rows("SELECT fee FROM fees WHERE id = 2"), [{ fee: "480" }]);
  });

  it("brings back the rows a foreign key's cascade deleted, and bytes as they were", async () => {
    const { store, rows } = setup();
    value(
      await store.exec(ME, {
        sql: [
          "CREATE TABLE permits (id INTEGER PRIMARY KEY, no TEXT, scan BLOB)",
          "CREATE TABLE inspections (id INTEGER PRIMARY KEY, permit_id INTEGER REFERENCES permits(id) ON DELETE CASCADE, result TEXT)",
          "INSERT INTO permits VALUES (1, 'BP-1', x'00ff10'), (2, 'BP-2', NULL)",
          "INSERT INTO inspections VALUES (10, 1, 'pass'), (11, 1, 'fail'), (12, 2, 'pass')",
        ].join(";\n"),
      }),
    );
    const done = value(await store.exec(ME, { sql: "DELETE FROM permits WHERE id = 1", record: RUN }));
    assert.equal(done.change?.rows, 3);
    assert.equal(rows("SELECT count(*) AS n FROM inspections")[0]!.n, 1);
    value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    assert.deepEqual(rows("SELECT id, hex(scan) AS scan FROM permits ORDER BY id"), [
      { id: 1, scan: "00FF10" },
      { id: 2, scan: "" },
    ]);
    assert.deepEqual(
      rows("SELECT id, permit_id, result FROM inspections ORDER BY id").map((r) => r.id),
      [10, 11, 12],
    );
  });

  it("removes a table the change made while it holds what the change left", async () => {
    const { store, fees, rows } = setup();
    await fees();
    const done = value(await store.exec(ME, { sql: "CREATE TABLE fee_review AS SELECT id, fee FROM fees WHERE fee GLOB '$*'", record: RUN }));
    assert.deepEqual(done.change?.tables, [{ name: "fee_review", inserted: 2, updated: 0, deleted: 0, made: true }]);
    value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    assert.deepEqual(rows("SELECT name FROM sqlite_master WHERE name = 'fee_review'"), []);
    assert.deepEqual(rows("SELECT name FROM _tables WHERE name = 'fee_review'"), []);
  });

  it("brings back a row a table's own ON CONFLICT REPLACE replaced", async () => {
    const { store, rows } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE codes (id INTEGER PRIMARY KEY, code TEXT UNIQUE ON CONFLICT REPLACE, words TEXT); INSERT INTO codes VALUES (1, 'RX', 'remodel'), (2, 'NB', 'new building')" }));
    const done = value(await store.exec(ME, { sql: "INSERT INTO codes (id, code, words) VALUES (3, 'RX', 'Remodel')", record: RUN }));
    assert.deepEqual(done.change?.tables, [{ name: "codes", inserted: 1, updated: 0, deleted: 1, made: false }]);
    value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    assert.deepEqual(rows("SELECT id, code, words FROM codes ORDER BY id"), [
      { id: 1, code: "RX", words: "remodel" },
      { id: 2, code: "NB", words: "new building" },
    ]);
  });

  it("runs a table's own trigger that writes its own table, and keeps it quiet while Undo puts the rows back", async () => {
    const { store, fees, rows } = setup();
    await fees();
    value(await store.exec(ME, { sql: "ALTER TABLE fees ADD COLUMN touched INTEGER NOT NULL DEFAULT 0; CREATE TRIGGER fees_touch AFTER UPDATE ON fees BEGIN UPDATE fees SET touched = touched + 1 WHERE id = NEW.id; END" }));
    const done = value(await store.exec(ME, { sql: CLEAN, record: RUN }));
    assert.deepEqual(rows("SELECT id, fee, touched FROM fees ORDER BY id"), [
      { id: 1, fee: "1250.00", touched: 1 },
      { id: 2, fee: "480", touched: 0 },
      { id: 3, fee: "90.5", touched: 1 },
    ]);
    // The trigger wrote each row again: each still counts once, with its values before the batch and after the trigger.
    assert.equal(done.change!.rows, 2);
    assert.deepEqual(done.change!.tables, [{ name: "fees", inserted: 0, updated: 2, deleted: 0, made: false }]);
    const kept = rows("SELECT op, before, after FROM _change_rows WHERE change = ? ORDER BY seq", done.change!.id);
    assert.equal(kept.length, 2);
    assert.deepEqual(JSON.parse(String(kept[0]!.before)), [{ id: 1, permit: "BP-1", fee: "$1,250.00", touched: 0 }]);
    assert.deepEqual(JSON.parse(String(kept[0]!.after)), [{ id: 1, permit: "BP-1", fee: "1250.00", touched: 1 }]);
    // A trial of the same batch counts the same rows.
    const tried = value(await store.exec(ME, { trial: { sql: "UPDATE fees SET fee = fee || ' '", ...RUN } }));
    assert.equal(tried.change!.rows, 3);
    const undone = value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    assert.equal(undone.change?.held, 0);
    assert.deepEqual(rows("SELECT id, fee, touched FROM fees ORDER BY id"), [
      { id: 1, fee: "$1,250.00", touched: 0 },
      { id: 2, fee: "480", touched: 0 },
      { id: 3, fee: "$90.5", touched: 0 },
    ]);
    // The trigger is there again, and fires as before.
    value(await store.exec(ME, { sql: "UPDATE fees SET fee = '480.00' WHERE id = 2" }));
    assert.deepEqual(rows("SELECT touched FROM fees WHERE id = 2"), [{ touched: 1 }]);
  });

  it("keeps the rows of a table with AUTOINCREMENT", async () => {
    const { store, rows } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT); INSERT INTO notes (body) VALUES ('a')" }));
    const done = value(await store.exec(ME, { sql: "INSERT INTO notes (body) VALUES ('b')", record: RUN }));
    assert.equal(done.change?.rows, 1);
    value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    assert.deepEqual(
      rows("SELECT body FROM notes ORDER BY id").map((r) => r.body),
      ["a"],
    );
  });

  it("names a row by its rowid where a column is called rowid", async () => {
    const { store, rows } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE legacy (rowid TEXT, name TEXT); INSERT INTO legacy VALUES ('7', 'a'), ('7', 'b')" }));
    const done = value(await store.exec(ME, { sql: "INSERT INTO legacy VALUES ('7', 'c')", record: RUN }));
    value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    assert.deepEqual(
      rows("SELECT name FROM legacy ORDER BY name").map((r) => r.name),
      ["a", "b"],
    );
  });

  it("puts back a row whose rowid the change moved", async () => {
    const { store, fees, rows } = setup();
    await fees();
    const done = value(await store.exec(ME, { sql: "UPDATE fees SET id = 30, fee = '90.50' WHERE id = 3", record: RUN }));
    value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    assert.deepEqual(rows("SELECT id, fee FROM fees ORDER BY id"), [
      { id: 1, fee: "$1,250.00" },
      { id: 2, fee: "480" },
      { id: 3, fee: "$90.5" },
    ]);
  });

  it("holds a row that a UNIQUE value taken since stands in the way of", async () => {
    const { store, rows } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE codes (id INTEGER PRIMARY KEY, code TEXT UNIQUE); INSERT INTO codes VALUES (1, 'RX'), (2, 'NB')" }));
    const done = value(await store.exec(ME, { sql: "DELETE FROM codes WHERE id = 1", record: RUN }));
    value(await store.exec(ME, { sql: "INSERT INTO codes VALUES (3, 'RX')" }));
    const undone = value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    assert.equal(undone.change?.restored, 0);
    assert.equal(undone.change?.held, 1);
    assert.deepEqual(rows("SELECT id, code FROM codes ORDER BY id"), [
      { id: 2, code: "NB" },
      { id: 3, code: "RX" },
    ]);
  });

  it("keeps no row of a table the change made, which Undo drops whole", async () => {
    const { store, fees, rows } = setup();
    await fees();
    const done = value(await store.exec(ME, { sql: "CREATE TABLE fee_copy (id INTEGER PRIMARY KEY, fee TEXT); INSERT INTO fee_copy SELECT id, fee FROM fees", record: RUN }));
    assert.deepEqual(done.change?.tables, [{ name: "fee_copy", inserted: 3, updated: 0, deleted: 0, made: true }]);
    assert.equal(rows("SELECT count(*) AS n FROM _change_rows WHERE change = ?", done.change!.id)[0]!.n, 0);
    value(await store.exec(ME, { undo: { change: done.change!.id, run: RUN.run } }));
    assert.deepEqual(rows("SELECT name FROM sqlite_master WHERE name = 'fee_copy'"), []);
  });

  it("refuses to undo a trial, and a change it does not keep", async () => {
    const { store, fees } = setup();
    await fees();
    const tried = value(await store.exec(ME, { trial: { sql: CLEAN, ...RUN } }));
    assert.equal(refusal(await store.exec(ME, { undo: { change: tried.change!.id } })).code, "change_trial");
    assert.equal(refusal(await store.exec(ME, { undo: { change: 999 } })).code, "change_not_found");
    assert.equal(refusal(await store.exec(ME, { undo: { change: "nine" } })).code, "bad_request");
  });
});

describe("what a recorded batch refuses", () => {
  it("refuses to drop or alter a table, which no record could put back, however the SQL is written", async () => {
    const { store, fees, rows } = setup();
    await fees();
    assert.equal(refusal(await store.exec(ME, { sql: "DROP TABLE fees", record: RUN })).code, "change_unrecordable");
    assert.equal(refusal(await store.exec(ME, { sql: "ALTER TABLE fees ADD COLUMN x TEXT", record: RUN })).code, "change_unrecordable");
    assert.equal(refusal(await store.exec(ME, { trial: { sql: "/* tidy */ DROP TABLE fees", ...RUN } })).code, "change_unrecordable");
    assert.equal(refusal(await store.exec(ME, { sql: "DROP /* gone */ TABLE fees", record: RUN })).code, "change_unrecordable");
    assert.equal(refusal(await store.exec(ME, { sql: "ALTER/**/TABLE fees RENAME TO fees_old", record: RUN })).code, "change_unrecordable");
    assert.equal(rows("SELECT count(*) AS n FROM fees")[0]!.n, 3);
  });

  it("refuses a statement that writes a virtual table, whose rows no record keeps", async () => {
    const { store } = setup();
    const made = await store.exec(ME, { sql: "CREATE VIRTUAL TABLE notes USING fts5(body)" });
    // A host whose SQLite has no fts5 has no virtual table to write.
    if (!made.ok) return;
    assert.equal(refusal(await store.exec(ME, { sql: "INSERT INTO notes (body) VALUES ('roof')", record: RUN })).code, "change_unrecordable");
    assert.equal(refusal(await store.exec(ME, { trial: { sql: "WITH x AS (SELECT 1) DELETE FROM main.notes", ...RUN } })).code, "change_unrecordable");
  });

  it("refuses an object of the batch's own that takes a name the capture's triggers use", async () => {
    const { store, fees, rows } = setup();
    await fees();
    const sql = "CREATE TRIGGER _chg_x AFTER UPDATE ON fees BEGIN SELECT 1; END; UPDATE fees SET fee = '1' WHERE id = 1";
    assert.equal(refusal(await store.exec(ME, { sql, record: RUN })).code, "protected_table");
    assert.equal(refusal(await store.exec(ME, { trial: { sql, ...RUN } })).code, "protected_table");
    assert.deepEqual(rows("SELECT name FROM sqlite_master WHERE type = 'trigger'"), []);
  });

  it("refuses a table with no rowids, whose rows it could not name", async () => {
    const { store } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE codes (code TEXT PRIMARY KEY, words TEXT) WITHOUT ROWID; INSERT INTO codes VALUES ('RX', 'remodel')" }));
    assert.equal(refusal(await store.exec(ME, { sql: "UPDATE codes SET words = 'Remodel'", record: RUN })).code, "change_unrecordable");
  });

  it("still refuses the store's own tables and a program's", async () => {
    const { store } = setup();
    assert.equal(refusal(await store.exec(ME, { sql: "DELETE FROM _changes", record: RUN })).code, "protected_table");
    assert.equal(refusal(await store.exec(ME, { sql: "DELETE FROM _change_rows" })).code, "protected_table");
    // The record's triggers may write it; a statement of the batch's own may not, recorded or not.
    assert.equal(refusal(await store.exec(ME, { sql: "DELETE FROM _change_rows", record: RUN })).code, "protected_table");
  });

  it("lets a trial go after a day", async () => {
    const { store, fees, rows, clock } = setup();
    await fees();
    const tried = value(await store.exec(ME, { trial: { sql: CLEAN, ...RUN } }));
    clock.advance(TRIAL_KEPT_MS + 1_000);
    value(await store.exec(ME, { trial: { sql: CLEAN, ...RUN } }));
    assert.equal(rows("SELECT count(*) AS n FROM _changes WHERE id = ?", tried.change!.id)[0]!.n, 0);
    assert.equal(rows("SELECT count(*) AS n FROM _change_rows WHERE change = ?", tried.change!.id)[0]!.n, 0);
    // Its number is never taken again: a run names its changes by number.
    const next = value(await store.exec(ME, { trial: { sql: CLEAN, ...RUN } }));
    assert.ok(next.change!.id > tried.change!.id + 1);
  });
});

// ── A run's change to its own tables (B10 part 2, program-tables.ts) ──────────

const RUN_CALLER: StoreCaller = { storeId: A, actor: "run:mrn-7" };
const IN_RUN = { runId: "mrn-7", step: "s1" };
const OUTSIDE = { runId: null, step: null };

/** A store whose jobs are LOAD, SHAPE, CLASSIFY and CHECK, with what a test of a run's change needs. */
function runSetup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const handlers = [loadHandler, shapeHandler, classifyHandler, checkHandler, profileHandler] as unknown as JobHandler[];
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map(handlers.map((h) => [h.kind, h])) };
  const r2 = filesOf();
  const store = new StoreHandler(stateOf(storage) as never, { FILES: r2.asBucket() }, deps);
  const rows = (sql: string, ...params: unknown[]) => storage.sql.exec(sql, ...params).toArray().map((r) => ({ ...r })) as Record<string, unknown>[];
  const tables = () => rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => String(r.name));
  const columns = (table: string) => rows("SELECT name FROM pragma_table_info(?) ORDER BY cid", table).map((r) => String(r.name));
  let keys = 0;
  /** Submits a job and runs the store's alarms until it ends. */
  const runJob = async <R>(kind: string, params: unknown): Promise<{ result: R; id: string }> => {
    const job = value(await store.jobSubmit(RUN_CALLER, { kind, params, requestKey: `${kind}:${++keys}` })).job;
    let ended = job;
    for (let i = 0; i < 200 && (ended.state === "queued" || ended.state === "running"); i++) {
      await store.alarm();
      clock.advance(5_000);
      ended = value(await store.job(RUN_CALLER, job.id)).job;
    }
    assert.equal(ended.state, "done", ended.error ?? "");
    return { result: ended.result as R, id: job.id };
  };
  /** Undo This Run as the api asks for it: each change the run keeps, newest first. */
  const undoRun = async (run: string): Promise<ChangeSummary[]> => {
    const out: ChangeSummary[] = [];
    for (const { id } of rows("SELECT id FROM _changes WHERE run = ? AND state = 'kept' ORDER BY id DESC", run)) {
      out.push(value(await store.exec(ME, { undo: { change: Number(id), run } })).change!);
    }
    return out;
  };
  /** A file put into the store as a page uploads it: one part. */
  const upload = async (name: string, text: string): Promise<{ id: string; name: string }> => {
    const bytes = new TextEncoder().encode(text);
    const created = value(await store.fileCreate(ME, { name, size: bytes.byteLength, contentType: "text/csv" }));
    const target = value(await store.filePartTarget(ME, created.file.id, 1));
    const part = await r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, bytes);
    value(await store.fileComplete(ME, created.file.id, { parts: [{ n: 1, etag: part.etag }] }));
    return { id: created.file.id, name: created.file.name };
  };
  /** The run's changes as the store keeps them. */
  const changesOf = (run: string) => rows("SELECT id, kind, job, state, rows, whole FROM _changes WHERE run = ? ORDER BY id", run);
  return { clock, storage, store, rows, tables, columns, runJob, undoRun, upload, changesOf };
}

/** A county's permits as a migration's table, and the SHAPE that cleans them. */
async function rawPermits(s: ReturnType<typeof runSetup>) {
  value(
    await s.store.exec(ME, {
      sql: "CREATE TABLE permits_raw (permit_no TEXT, type TEXT, fee TEXT); INSERT INTO permits_raw VALUES ('BP-1', ' bldg', '1,250'), ('BP-2', 'elec', '480'), ('BP-3', 'Fence ', '90')",
    }),
  );
}
const cleanShape = (madeBy: { runId: string | null; step: string | null }) => ({
  into: "permits_clean",
  sql: "SELECT permit_no, upper(trim(type)) AS type, CAST(replace(fee, ',', '') AS REAL) AS fee FROM permits_raw",
  goal: null,
  sources: "[]",
  madeBy,
});
const noTriggers = (s: ReturnType<typeof runSetup>) => assert.deepEqual(s.rows("SELECT name FROM sqlite_master WHERE type = 'trigger'"), [], "the store's triggers went with each commit");

describe("a run's change to its own tables, kept and undone", () => {
  it("keeps a new version with the version before, and Undo puts that version back", async () => {
    const s = runSetup();
    await rawPermits(s);
    const { id: first } = await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    assert.deepEqual(s.changesOf("mrn-7"), [], "outside a run nothing is kept");
    value(await s.store.exec(ME, { sql: "INSERT INTO permits_raw VALUES ('BP-4', 'demo', '75')" }));
    const { result: made, id: job } = await s.runJob<ShapeResult>("shape", cleanShape(IN_RUN));
    assert.deepEqual([made.version, made.rows], [2, 4]);
    assert.deepEqual(s.changesOf("mrn-7"), [{ id: 1, kind: "table", job, state: "kept", rows: 4, whole: 0 }]);
    assert.deepEqual(s.rows("SELECT count(*) AS n FROM permits_clean__v1"), [{ n: 3 }], "the version before stays as a table of its own");
    noTriggers(s);
    const [undone] = await s.undoRun("mrn-7");
    assert.equal(undone!.state, "undone");
    assert.deepEqual([undone!.restored, undone!.held], [3, 0]);
    assert.deepEqual(undone!.tables[0]!.version, { before: 1, after: 2, rowsBefore: 3, rows: 4 });
    assert.deepEqual(
      s.rows("SELECT permit_no, type FROM permits_clean ORDER BY permit_no"),
      [
        { permit_no: "BP-1", type: "BLDG" },
        { permit_no: "BP-2", type: "ELEC" },
        { permit_no: "BP-3", type: "FENCE" },
      ],
    );
    assert.deepEqual(s.rows("SELECT version, rows, made_job FROM _tables WHERE name = 'permits_clean'"), [{ version: 1, rows: 3, made_job: first }], "its record is the version before's");
    assert.ok(!s.tables().includes("permits_clean__v1"), "the version before is the table again");
    // Every step that reads the table reads all of it next.
    assert.deepEqual(s.rows("SELECT whole, by_sub FROM _deltas WHERE tbl = 'permits_clean' ORDER BY change DESC LIMIT 1"), [{ whole: 1, by_sub: "user:u-1" }]);
    assert.deepEqual(s.rows("SELECT note FROM _history WHERE note LIKE 'Undid%'").map((r) => r.note), ["Undid a run's change: permits_clean is back at version 1, 3 rows"]);
    // Undo This Run asked again does nothing more.
    assert.deepEqual(await s.undoRun("mrn-7"), []);
  });

  it("takes away a table the run made, with its record", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(IN_RUN));
    assert.deepEqual(s.rows("SELECT tables FROM _changes WHERE run = 'mrn-7'").map((r) => JSON.parse(String(r.tables))[0].made), [true]);
    const [undone] = await s.undoRun("mrn-7");
    assert.deepEqual([undone!.restored, undone!.held], [3, 0]);
    assert.ok(!s.tables().includes("permits_clean"));
    assert.deepEqual(s.rows("SELECT name FROM _tables WHERE name = 'permits_clean'"), []);
    assert.deepEqual(s.rows("SELECT name FROM _columns WHERE tbl = 'permits_clean'"), []);
  });

  it("holds a version a later change replaced, and leaves the table as it is", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    await s.runJob<ShapeResult>("shape", cleanShape(IN_RUN));
    value(await s.store.exec(ME, { sql: "INSERT INTO permits_raw VALUES ('BP-5', 'plmb', '60')" }));
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    const [undone] = await s.undoRun("mrn-7");
    assert.equal(undone!.restored, 0);
    assert.ok(undone!.held! > 0);
    assert.deepEqual(s.rows("SELECT version, rows FROM _tables WHERE name = 'permits_clean'"), [{ version: 3, rows: 4 }]);
  });

  it("puts back rows a LOAD and a SHAPE changed in place, and both forget what they had read", async () => {
    const s = runSetup();
    // "Permit No" names each row across loads (`_key`), so a changed fee is one row changed.
    const csv = (fee2: string, more = "") => `Permit No,Type,Fee\nBP-1,bldg,1250\nBP-2,elec,${fee2}\nBP-3,fence,90\nBP-4,demo,75\n${more}`;
    const shape = (madeBy: { runId: string | null; step: string | null }) => ({
      into: "permits_clean",
      sql: 'SELECT _key, "Permit No" AS permit_no, upper("Type") AS type, CAST("Fee" AS REAL) AS fee FROM permits',
      goal: null,
      sources: "[]",
      madeBy,
    });
    await s.runJob<LoadResult>("load", { files: [await s.upload("permits.csv", csv("480"))], madeBy: OUTSIDE });
    await s.runJob<ShapeResult>("shape", shape(OUTSIDE));
    // The run loads the file again with BP-2's fee changed and BP-5 new, and cleans it again: both in place.
    const { result: loaded } = await s.runJob<LoadResult>("load", { files: [await s.upload("permits.csv", csv("500", "BP-5,plmb,60\n"))], madeBy: IN_RUN });
    assert.deepEqual(loaded.tables.map((t) => [t.version, t.changes]), [[1, { added: 1, changed: 1, removed: 0 }]]);
    const { result: cleaned } = await s.runJob<ShapeResult>("shape", shape(IN_RUN));
    assert.deepEqual([cleaned.mode, cleaned.added, cleaned.changed, cleaned.removed], ["changed", 1, 1, 0]);
    noTriggers(s);
    const kept = s.rows("SELECT tables FROM _changes WHERE run = 'mrn-7' ORDER BY id").map((r) => JSON.parse(String(r.tables))[0]);
    assert.deepEqual(
      kept.map((t: { name: string; inserted: number; updated: number; deleted: number; program: { how: string } }) => [t.name, t.program.how, t.inserted, t.updated, t.deleted]),
      [
        ["permits", "rows", 1, 1, 0],
        ["permits_clean", "rows", 1, 1, 0],
      ],
    );
    const undone = await s.undoRun("mrn-7");
    assert.deepEqual(undone.map((c) => [c.restored, c.held]), [
      [2, 0],
      [2, 0],
    ]);
    assert.deepEqual(s.rows('SELECT "Permit No" AS permit, "Fee" AS fee FROM permits ORDER BY 1').map((r) => `${r.permit} ${r.fee}`), ["BP-1 1250", "BP-2 480", "BP-3 90", "BP-4 75"]);
    assert.deepEqual(s.rows("SELECT permit_no, fee FROM permits_clean ORDER BY permit_no").map((r) => `${r.permit_no} ${r.fee}`), ["BP-1 1250", "BP-2 480", "BP-3 90", "BP-4 75"]);
    // LOAD forgot the rows it took in, and SHAPE what it read: their next runs make both tables whole.
    assert.equal(s.rows("SELECT count(*) AS n FROM _row_hashes WHERE tbl = 'permits'")[0]!.n, 0);
    assert.equal(s.rows("SELECT count(*) AS n FROM _delta_reads WHERE reader = 'shape:permits_clean'")[0]!.n, 0);
    const { result: reloaded } = await s.runJob<LoadResult>("load", { files: [await s.upload("permits.csv", csv("500", "BP-5,plmb,60\n"))], madeBy: OUTSIDE });
    assert.deepEqual(reloaded.tables.map((t) => [t.version, t.rows, t.changes]), [[2, 5, null]]);
    const { result: remade } = await s.runJob<ShapeResult>("shape", shape(OUTSIDE));
    assert.deepEqual([remade.mode, remade.rows], ["whole", 5]);
  });

  it("drops the column a CLASSIFY added and the answers it made", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    const classify = (madeBy: { runId: string | null; step: string | null }, add: { value: string; answer: string | null; sure: number }[]) => ({
      table: "permits_clean",
      column: "type",
      into: "permit_type",
      answers: "answers_permit_type",
      classes: ["Building", "Electrical", "Fence"],
      sure: 0.9,
      add,
      by: "model:test",
      madeBy,
    });
    await s.runJob<ClassifyResult>("classify", classify(IN_RUN, [{ value: "BLDG", answer: "Building", sure: 0.98 }, { value: "ELEC", answer: "Electrical", sure: 0.97 }]));
    assert.deepEqual(s.columns("permits_clean"), ["permit_no", "type", "fee", "permit_type"]);
    const kept = s.rows("SELECT tables FROM _changes WHERE run = 'mrn-7' ORDER BY id").map((r) => JSON.parse(String(r.tables))[0]);
    assert.deepEqual(
      kept.map((t: { name: string; updated: number; made: boolean }) => [t.name, t.made, t.updated]),
      [
        ["answers_permit_type", true, 0],
        ["permits_clean", false, 2],
      ],
    );
    // A row written only in the column the change added keeps no row of its record: Undo drops the column.
    assert.equal(s.rows("SELECT count(*) AS n FROM _change_rows")[0]!.n, 0);
    await s.undoRun("mrn-7");
    assert.deepEqual(s.columns("permits_clean"), ["permit_no", "type", "fee"]);
    assert.ok(!s.tables().includes("answers_permit_type"));
    assert.deepEqual(s.rows("SELECT name FROM _columns WHERE tbl = 'permits_clean' AND name = 'permit_type'"), []);
  });

  it("puts back a CLASSIFY's answers and its column's values once the column was there", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    const classify = (madeBy: { runId: string | null; step: string | null }, add: { value: string; answer: string | null; sure: number }[]) => ({
      table: "permits_clean",
      column: "type",
      into: "permit_type",
      answers: "answers_permit_type",
      classes: ["Building", "Electrical", "Fence"],
      sure: 0.9,
      add,
      by: "model:test",
      madeBy,
    });
    await s.runJob<ClassifyResult>("classify", classify(OUTSIDE, [{ value: "BLDG", answer: "Building", sure: 0.98 }]));
    await s.runJob<ClassifyResult>("classify", classify(IN_RUN, [{ value: "ELEC", answer: "Electrical", sure: 0.97 }]));
    assert.deepEqual(s.rows("SELECT permit_no, permit_type FROM permits_clean ORDER BY permit_no").map((r) => r.permit_type), ["Building", "Electrical", null]);
    await s.undoRun("mrn-7");
    assert.deepEqual(s.rows("SELECT permit_no, permit_type FROM permits_clean ORDER BY permit_no").map((r) => r.permit_type), ["Building", null, null]);
    assert.deepEqual(s.rows("SELECT key FROM answers_permit_type ORDER BY key").map((r) => r.key), ["bldg"]);
    noTriggers(s);
  });

  it("puts back the flags a CHECK changed in place over its commits, and its next run reads every row", async () => {
    const s = runSetup();
    await rawPermits(s);
    value(await s.store.exec(ME, { sql: "UPDATE permits_raw SET fee = '' WHERE permit_no = 'BP-3'" }));
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    const check = (madeBy: { runId: string | null; step: string | null }) => ({
      table: "permits_clean",
      into: "permits_flags",
      rules: [{ rule: "range", column: "fee", min: 1 }],
      key: null,
      words: null,
      signature: "[]",
      madeBy,
    });
    await s.runJob<CheckResult>("check", check(OUTSIDE));
    assert.equal(s.rows("SELECT count(*) AS n FROM permits_flags WHERE state = 'open'")[0]!.n, 1);
    // BP-3's fee is set by hand: the run's CHECK closes its flag, in place.
    s.storage.sql.exec("UPDATE permits_clean SET fee = 90 WHERE permit_no = 'BP-3'");
    const { result: checked } = await s.runJob<CheckResult>("check", check(IN_RUN));
    assert.equal(checked.closed, 1);
    assert.equal(s.rows("SELECT count(*) AS n FROM permits_flags")[0]!.n, 0);
    const [undone] = await s.undoRun("mrn-7");
    assert.deepEqual([undone!.restored, undone!.held], [1, 0]);
    assert.equal(s.rows("SELECT count(*) AS n FROM permits_flags WHERE state = 'open'")[0]!.n, 1);
    assert.equal(s.rows("SELECT count(*) AS n FROM _delta_reads WHERE reader = 'check:permits_flags'")[0]!.n, 0);
  });

  it("counts a job's own rows the same in a run as outside one: the record is not the job's writing", async () => {
    const counted = async (madeBy: { runId: string | null; step: string | null }) => {
      const s = runSetup();
      await rawPermits(s);
      await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
      const { id } = await s.runJob<ShapeResult>("shape", cleanShape(madeBy));
      return Number(s.rows("SELECT rows_written AS n FROM _jobs WHERE id = ?", id)[0]!.n);
    };
    assert.equal(await counted(IN_RUN), await counted(OUTSIDE));
  });

  it("waits while a step's job is open in the store", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(IN_RUN));
    const change = Number(s.rows("SELECT id FROM _changes WHERE run = 'mrn-7'")[0]!.id);
    value(await s.store.jobSubmit(RUN_CALLER, { kind: "shape", params: cleanShape(OUTSIDE), requestKey: "queued" }));
    assert.equal(refusal(await s.store.exec(ME, { undo: { change, run: "mrn-7" } })).code, "store_busy");
  });

  it("puts back a table a job changed in place and then made whole, newest first", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    const core = s.store.core;
    const tables = programTables(core, { id: "job_fall", by: "run:mrn-9", run: "mrn-9", step: "s1" });
    // A commit writes the table in place; then the step falls back and makes it whole, with a column more.
    core.transaction(() => {
      tables.arm();
      tables.keepRows("permits_clean");
      core.sql.exec("UPDATE permits_clean SET fee = 1 WHERE permit_no = 'BP-1'");
      tables.disarm();
    });
    const fresh = tables.begin("permits_clean");
    core.sql.exec(`CREATE TABLE ${fresh} AS SELECT permit_no, type, fee, 'x' AS note FROM permits_raw`);
    await tables.commit("permits_clean", { madeBy: { runId: "mrn-9", step: "s1" } });
    // The job ends, as the runner ends it: nothing is left open.
    core.transaction(() => settleRunChanges(core, "job_fall"));
    const kept = s.rows("SELECT tables FROM _changes WHERE run = 'mrn-9' ORDER BY id").map((r) => JSON.parse(String(r.tables))[0].program.how);
    assert.deepEqual(kept, ["rows", "version"], "the change in place closed before the new version replaced its table");
    const undone = await s.undoRun("mrn-9");
    assert.deepEqual(undone.map((c) => c.held), [0, 0]);
    assert.deepEqual(s.columns("permits_clean"), ["permit_no", "type", "fee"]);
    assert.deepEqual(s.rows("SELECT permit_no, fee FROM permits_clean ORDER BY permit_no").map((r) => `${r.permit_no} ${r.fee}`), ["BP-1 1250", "BP-2 480", "BP-3 90"]);
  });

  it("keeps the rows a job's commits caught when the job ends before it records its change", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    const core = s.store.core;
    const tables = programTables(core, { id: "job_cut", by: "run:mrn-8", run: "mrn-8", step: "s3" });
    // Two commits of a job write the table in place under one open change; the job then stops.
    core.transaction(() => {
      tables.arm();
      tables.keepRows("permits_clean");
      core.sql.exec("UPDATE permits_clean SET fee = fee * 2 WHERE permit_no = 'BP-1'");
      tables.disarm();
    });
    core.transaction(() => {
      tables.arm();
      core.sql.exec("DELETE FROM permits_clean WHERE permit_no = 'BP-2'");
      tables.disarm();
    });
    noTriggers(s);
    core.transaction(() => settleRunChanges(core, "job_cut"));
    assert.deepEqual(s.changesOf("mrn-8").map((c) => [c.kind, c.rows]), [["table", 2]]);
    const [undone] = await s.undoRun("mrn-8");
    assert.deepEqual([undone!.restored, undone!.held], [2, 0]);
    assert.deepEqual(s.rows("SELECT permit_no, fee FROM permits_clean ORDER BY permit_no").map((r) => `${r.permit_no} ${r.fee}`), ["BP-1 1250", "BP-2 480", "BP-3 90"]);
  });

  it("keeps a column a later run wrote in when an earlier run is undone, and its settings as the later run left them", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    await s.runJob<ClassifyResult>("classify", classifyPermits(IN_RUN, [{ value: "BLDG", answer: "Building", sure: 0.98 }]));
    await s.runJob<ClassifyResult>("classify", classifyPermits(LATER_RUN, [{ value: "ELEC", answer: "Electrical", sure: 0.97 }]));
    const saved = s.rows("SELECT value FROM _meta WHERE key = 'answers:answers_permit_type'")[0]!.value;
    const undone = await s.undoRun("mrn-7");
    // The later run's change holds, so the column the earlier run added stays, with both runs' answers.
    assert.ok(undone.every((c) => (c.held ?? 0) > 0), JSON.stringify(undone));
    assert.deepEqual(s.rows("SELECT permit_type FROM permits_clean ORDER BY permit_no").map((r) => r.permit_type), ["Building", "Electrical", null]);
    assert.equal(s.rows("SELECT value FROM _meta WHERE key = 'answers:answers_permit_type'")[0]!.value, saved);
    noTriggers(s);
  });

  it("takes back two runs' changes to one table newest first, columns, answers and settings with them", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    await s.runJob<ClassifyResult>("classify", classifyPermits(IN_RUN, [{ value: "BLDG", answer: "Building", sure: 0.98 }]));
    const afterFirst = s.rows("SELECT value FROM _meta WHERE key = 'answers:answers_permit_type'")[0]!.value;
    await s.runJob<ClassifyResult>("classify", classifyPermits(LATER_RUN, [{ value: "ELEC", answer: "Electrical", sure: 0.97 }]));
    assert.deepEqual((await s.undoRun("mrn-8")).map((c) => c.held), [0, 0]);
    assert.deepEqual(s.rows("SELECT permit_type FROM permits_clean ORDER BY permit_no").map((r) => r.permit_type), ["Building", null, null]);
    assert.equal(s.rows("SELECT value FROM _meta WHERE key = 'answers:answers_permit_type'")[0]!.value, afterFirst);
    assert.deepEqual((await s.undoRun("mrn-7")).map((c) => c.held), [0, 0]);
    assert.deepEqual(s.columns("permits_clean"), ["permit_no", "type", "fee"]);
    assert.ok(!s.tables().includes("answers_permit_type"));
    assert.deepEqual(s.rows("SELECT key FROM _meta WHERE key = 'answers:answers_permit_type' OR key GLOB 'job_memory:*'"), []);
  });

  it("goes back through every version a run made of a table, to the one before its first", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    for (const permit of ["('BP-4', 'demo', '75')", "('BP-5', 'plmb', '60')", "('BP-6', 'roof', '310')"]) {
      value(await s.store.exec(ME, { sql: `INSERT INTO permits_raw VALUES ${permit}` }));
      await s.runJob<ShapeResult>("shape", cleanShape(IN_RUN));
    }
    assert.deepEqual(s.rows("SELECT version, rows FROM _tables WHERE name = 'permits_clean'"), [{ version: 4, rows: 6 }]);
    assert.deepEqual(s.tables().filter((t) => t.startsWith("permits_clean__")), ["permits_clean__v1", "permits_clean__v2", "permits_clean__v3"]);
    assert.deepEqual((await s.undoRun("mrn-7")).map((c) => c.held), [0, 0, 0]);
    assert.deepEqual(s.rows("SELECT version, rows FROM _tables WHERE name = 'permits_clean'"), [{ version: 1, rows: 3 }]);
    assert.deepEqual(s.rows("SELECT permit_no FROM permits_clean ORDER BY permit_no").map((r) => r.permit_no), ["BP-1", "BP-2", "BP-3"]);
    assert.deepEqual(s.tables().filter((t) => t.startsWith("permits_clean__")), []);
  });

  it("drops a run's versions once a later run's version replaces them, and says so when the earlier run is undone", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    await s.runJob<ShapeResult>("shape", cleanShape(IN_RUN));
    await s.runJob<ShapeResult>("shape", cleanShape(IN_RUN));
    await s.runJob<ShapeResult>("shape", cleanShape(LATER_RUN));
    // The later run keeps only the version it replaced.
    assert.deepEqual(s.tables().filter((t) => t.startsWith("permits_clean__")), ["permits_clean__v3"]);
    assert.deepEqual((await s.undoRun("mrn-8")).map((c) => c.held), [0]);
    assert.deepEqual(s.rows("SELECT version FROM _tables WHERE name = 'permits_clean'"), [{ version: 3 }]);
    const [newest, first] = s.rows("SELECT id FROM _changes WHERE run = 'mrn-7' ORDER BY id DESC").map((r) => Number(r.id));
    const gone = refusal(await s.store.exec(ME, { undo: { change: newest!, run: "mrn-7" } }));
    assert.equal(gone.code, "change_version_gone");
    assert.match(gone.error ?? "", /Restore to Here/);
    // The table stays as it is, and so does the run's other change.
    assert.deepEqual(s.rows("SELECT version FROM _tables WHERE name = 'permits_clean'"), [{ version: 3 }]);
    assert.deepEqual(s.rows("SELECT state FROM _changes WHERE id IN (?, ?) ORDER BY id", first!, newest!).map((r) => r.state), ["kept", "kept"]);
  });

  it("puts a view back with its SQL, so a later swap of another table makes the view put back", async () => {
    const s = runSetup();
    await rawPermits(s);
    const ready = (madeBy: { runId: string | null; step: string | null }, select: string) => ({ into: "permits_ready", sql: select, goal: null, sources: "[]", as: "view", madeBy });
    await s.runJob<ShapeResult>("shape", ready(OUTSIDE, "SELECT permit_no, fee FROM permits_raw"));
    await s.runJob<ShapeResult>("shape", ready(IN_RUN, "SELECT permit_no, type FROM permits_raw"));
    assert.deepEqual(s.columns("permits_ready"), ["permit_no", "type"]);
    await s.undoRun("mrn-7");
    assert.deepEqual(s.columns("permits_ready"), ["permit_no", "fee"]);
    // Any swap in the store makes its program views again from their SQL.
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    assert.deepEqual(s.columns("permits_ready"), ["permit_no", "fee"]);
  });

  it("puts back a CHECK's rules with its flags: a next run with the undone run's rules starts the flags again", async () => {
    const s = runSetup();
    await rawPermits(s);
    value(await s.store.exec(ME, { sql: "UPDATE permits_raw SET fee = '' WHERE permit_no = 'BP-3'" }));
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    const both = [{ rule: "range", column: "fee", min: 1 }, { rule: "range", column: "fee", max: 1000 }];
    const low = [{ rule: "range", column: "fee", min: 1 }];
    await s.runJob<CheckResult>("check", checkPermits(OUTSIDE, both));
    const flags = () => s.rows("SELECT row_id, rule FROM permits_flags WHERE state = 'open' ORDER BY row_id, rule").map((r) => `${r.row_id}:${r.rule}`);
    const rules = () => JSON.parse(String(s.rows("SELECT value FROM _meta WHERE key = 'check:permits_clean'")[0]!.value)).rules;
    assert.deepEqual(flags(), ["1:1", "3:0"]);
    const before = rules();
    assert.equal(before.length, 2);
    await s.runJob<CheckResult>("check", checkPermits(IN_RUN, low));
    assert.deepEqual(flags(), ["3:0"]);
    await s.undoRun("mrn-7");
    assert.deepEqual(flags(), ["1:1", "3:0"]);
    // A person's fix on the Tables tab is tested on the rules these flags were made with.
    assert.deepEqual(rules(), before);
    await s.runJob<CheckResult>("check", checkPermits(OUTSIDE, low));
    assert.deepEqual(flags(), ["3:0"]);
  });

  it("puts back a CLASSIFY's list with its answers: a next run with the undone run's list asks again about the answers it no longer holds", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    const answer = () => s.rows("SELECT answer FROM answers_permit_type WHERE key = 'elec'")[0]!.answer;
    const classes = () => JSON.parse(String(s.rows("SELECT value FROM _meta WHERE key = 'answers:answers_permit_type'")[0]!.value)).classes;
    await s.runJob<ClassifyResult>("classify", classifyPermits(OUTSIDE, [{ value: "ELEC", answer: "Electrical", sure: 0.97 }]));
    const shorter = ["Building", "Electric", "Fence"];
    await s.runJob<ClassifyResult>("classify", { ...classifyPermits(IN_RUN, [{ value: "ELEC", answer: "Electric", sure: 0.97 }]), classes: shorter });
    assert.equal(answer(), "Electric");
    await s.undoRun("mrn-7");
    assert.equal(answer(), "Electrical");
    assert.deepEqual(classes(), ["Building", "Electrical", "Fence"]);
    // The list changed again since the answers were made: the model's answer it no longer holds is asked again.
    await s.runJob<ClassifyResult>("classify", { ...classifyPermits(OUTSIDE, [{ value: "ELEC", answer: "Electric", sure: 0.97 }]), classes: shorter });
    assert.equal(answer(), "Electric");
  });

  it("puts back a PROFILE's read with its profile: a next run profiles the table again", async () => {
    const s = runSetup();
    await rawPermits(s);
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    const profile = (madeBy: { runId: string | null; step: string | null }) => ({ table: "permits_clean", into: "permits_clean_profile", madeBy });
    const permits = () => Number(s.rows("SELECT distinct_values AS n FROM permits_clean_profile WHERE column_name = 'permit_no'")[0]!.n);
    await s.runJob<ProfileResult>("profile", profile(OUTSIDE));
    assert.equal(permits(), 3);
    value(await s.store.exec(ME, { sql: "INSERT INTO permits_raw VALUES ('BP-4', 'demo', '75')" }));
    await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
    await s.runJob<ProfileResult>("profile", profile(IN_RUN));
    assert.equal(permits(), 4);
    await s.undoRun("mrn-7");
    assert.equal(permits(), 3);
    // The table has not changed since the run's PROFILE read it, and the profile put back is older than that.
    await s.runJob<ProfileResult>("profile", profile(OUTSIDE));
    assert.equal(permits(), 4);
  });

  it("counts a CHECK's own rows in place the same in a run as outside one", async () => {
    const counted = async (madeBy: { runId: string | null; step: string | null }) => {
      const s = runSetup();
      await rawPermits(s);
      value(await s.store.exec(ME, { sql: "UPDATE permits_raw SET fee = '' WHERE permit_no = 'BP-3'" }));
      await s.runJob<ShapeResult>("shape", cleanShape(OUTSIDE));
      const both = [{ rule: "range", column: "fee", min: 1 }, { rule: "range", column: "fee", max: 1000 }];
      await s.runJob<CheckResult>("check", checkPermits(OUTSIDE, both));
      s.storage.sql.exec("UPDATE permits_clean SET fee = 90 WHERE permit_no = 'BP-3'");
      const { id } = await s.runJob<CheckResult>("check", checkPermits(madeBy, both));
      return Number(s.rows("SELECT rows_written AS n FROM _jobs WHERE id = ?", id)[0]!.n);
    };
    assert.equal(await counted(IN_RUN), await counted(OUTSIDE));
  });
});

/** A later run than `IN_RUN`. */
const LATER_RUN = { runId: "mrn-8", step: "s1" };

/** The CLASSIFY of the clean permits' types into `permit_type`, with the model's answers `add`. */
const classifyPermits = (madeBy: { runId: string | null; step: string | null }, add: { value: string; answer: string | null; sure: number }[]) => ({
  table: "permits_clean",
  column: "type",
  into: "permit_type",
  answers: "answers_permit_type",
  classes: ["Building", "Electrical", "Fence"],
  sure: 0.9,
  add,
  by: "model:test",
  madeBy,
});

/** The CHECK of the clean permits' rows by `rules`, its flags in `permits_flags`. */
const checkPermits = (madeBy: { runId: string | null; step: string | null }, rules: unknown[]) => ({
  table: "permits_clean",
  into: "permits_flags",
  rules,
  key: null,
  words: null,
  signature: "[]",
  madeBy,
});
