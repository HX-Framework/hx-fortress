// Which keys a reload of a LOAD's table took (claims.ts), and how a whole load numbers the keys of the
// store's memory (deltas.ts `recordLoadDelta`) so that the next reload can start, on the stand-in for
// a store's storage.

import { describe, it, host } from "../../testing/suite/host.js";
import assert from "node:assert/strict";

import type { StoreCore } from "../core.js";
import { addDeltaKeys, appendAll, openDelta, recordLoadDelta } from "../deltas.js";
import { ensureSystemTables } from "../schema.js";
import type { SqlLike } from "../sql.js";
import { Claims, FREE_MAX, startClaims, takeKeys } from "./claims.js";

function setup() {
  const sql = host().storage().sql;
  ensureSystemTables(sql);
  // recordLoadDelta reads only the store's SQL and its clock.
  const core = { sql, nowIso: () => "2026-11-10T00:00:00.000Z" } as unknown as StoreCore;
  return { sql, core };
}

/** A LOAD's table `t` of `n` rows, keyed K-1 … K-n, and the store's memory of it, each key numbered by `number` (SQL over `x`, the row's place). */
function remembered(sql: SqlLike, n: number, number: string): void {
  sql.exec(`CREATE TABLE t ("_key" TEXT NOT NULL, "_hash" TEXT NOT NULL)`);
  sql.exec(`WITH RECURSIVE i(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM i WHERE x < ?) INSERT INTO t SELECT 'K-' || x, 'h' || x FROM i`, n);
  sql.exec(`INSERT INTO _row_hashes (tbl, k, h, n) SELECT 't', "_key", "_hash", ${number} FROM (SELECT *, CAST(substr("_key", 3) AS INTEGER) AS x FROM t)`);
}

const numbers = (sql: SqlLike) => sql.exec<{ c: number; m: number; d: number }>("SELECT count(*) AS c, max(n) AS m, count(DISTINCT n) AS d FROM _row_hashes WHERE tbl = 't'").one();

describe("the keys a reload took", () => {
  it("saves its bitset only as far as its greatest number, however far it grew", () => {
    const claims = new Claims({ bits: "", free: [], next: 100, probe: {} });
    claims.take(5);
    claims.take(99);
    // Growing doubles the bitset (64 bytes here); the state keeps the 13 bytes that hold 0 to 99.
    const saved = claims.state();
    assert.equal(atob(saved.bits).length, 13);
    const again = new Claims(saved);
    assert.deepEqual([again.has(5), again.has(99), again.has(6)], [true, true, false]);
  });

  it("gives a repeated key the first \"#n\" no earlier row of the file took, batches apart included", () => {
    const { sql } = setup();
    sql.exec("INSERT INTO _row_hashes (tbl, k, h, n) VALUES ('t', 'A', 'a1', 1), ('t', 'A#2', 'a2', 2), ('t', 'B', 'b', 3)");
    const start = startClaims(sql, "t")!;
    const claims = new Claims(start.claims);
    const first = takeKeys(sql, "t", claims, ["A", "B", "A"])!;
    assert.deepEqual(first.map((k) => [k.key, k.known?.n ?? null]), [["A", 1], ["B", 3], ["A#2", 2]]);
    // The next batch: a third "A" is new to the store, and takes "A#3".
    const second = takeKeys(sql, "t", new Claims(claims.state()), ["A"])!;
    assert.deepEqual(second.map((k) => [k.key, k.known]), [["A#3", null]]);
  });
});

describe("a whole load numbers the keys of the store's memory", () => {
  it("leaves a reload the first FREE_MAX ranges of free numbers when the keys are spread over more", () => {
    const { sql } = setup();
    // Every other number is free: more ranges of them than a reload's state keeps.
    remembered(sql, FREE_MAX + 2_000, "2 * x");
    const start = startClaims(sql, "t")!;
    assert.ok(start, "a reload starts");
    assert.equal(start.claims.free.length, FREE_MAX);
    assert.deepEqual([start.claims.free[0], start.claims.free.at(-1)], [[1, 1], [2 * FREE_MAX - 1, 2 * FREE_MAX - 1]]);
    assert.equal(start.claims.next, 2 * (FREE_MAX + 2_000) + 1);
  });

  it("numbers them again from 1 once more than half the numbers are free", () => {
    const { sql, core } = setup();
    // Two numbers in three are free: 300 keys numbered up to 900.
    remembered(sql, 300, "3 * x");
    recordLoadDelta(core, "t", { version: 1, job: null, rows: 300 });
    assert.deepEqual({ ...numbers(sql) }, { c: 300, m: 300, d: 300 });
  });

  it("leaves numbers a reload can start from as they are", () => {
    const { sql, core } = setup();
    // 300 keys, every tenth number free: 30 ranges.
    remembered(sql, 300, "x + x / 10");
    const before = sql.exec<{ k: string; n: number }>("SELECT k, n FROM _row_hashes WHERE tbl = 't' ORDER BY k").toArray().map((r) => ({ ...r }));
    recordLoadDelta(core, "t", { version: 1, job: null, rows: 300 });
    assert.deepEqual(sql.exec<{ k: string; n: number }>("SELECT k, n FROM _row_hashes WHERE tbl = 't' ORDER BY k").toArray().map((r) => ({ ...r })), before);
  });
});

describe("the keys a change records", () => {
  it("splits them into rows of the record by their length as well as their number", () => {
    const { sql, core } = setup();
    sql.exec(`CREATE TABLE t ("_key" TEXT NOT NULL, "_hash" TEXT NOT NULL)`);
    const change = openDelta(core, "t", 1, null);
    // Ten keys of 200,000 characters: two to a row keeps each row's JSON under 600,000 characters,
    // which is under 2 MB however many bytes a character takes.
    const keys = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(200_000));
    addDeltaKeys(sql, "t", change, { removed: keys });
    const parts = sql.exec<{ n: number; chars: number }>("SELECT json_array_length(keys) AS n, length(keys) AS chars FROM _delta_rows WHERE tbl = 't' ORDER BY part").toArray();
    assert.deepEqual(parts.map((p) => p.n), [2, 2, 2, 2, 2]);
    assert.ok(parts.every((p) => p.chars <= 600_000));
    // A long list of short keys still keeps KEYS_PER_PART to a row, in one list of 150,000.
    const many = Array.from({ length: 150_000 }, (_, i) => `K-${i}`);
    addDeltaKeys(sql, "t", change, { added: many });
    assert.deepEqual(sql.exec<{ n: number }>("SELECT count(*) AS n FROM _delta_rows WHERE tbl = 't' AND kind = 'added'").one().n, 30);
  });

  it("appends a list of any length: 150,000 keys, past where a spread overflows the call stack", () => {
    const list = ["a"];
    appendAll(list, Array.from({ length: 150_000 }, (_, i) => `K-${i}`));
    assert.deepEqual([list.length, list.at(-1)], [150_001, "K-149999"]);
  });
});
