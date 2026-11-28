// A table's profile as a page asks for it (profile.ts): the one profile, read on the store's own
// SQLite, with statements that only read. A made-up shop: its orders, written two ways, and the
// customers they point at, some of whose columns hold a person's numbers.

import { describe, it, host, stateOf, filesOf } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import type { ColumnProfile, TableProfile } from "../../store-readers/src/profile.js";
import type { StoreDeps } from "./core.js";
import { StoreHandler } from "./handler.js";
import type { StoreCaller, StoreResult } from "./types.js";

const A = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ME: StoreCaller = { storeId: A, actor: "user:u-1" };

function setup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map() };
  return { storage, store: new StoreHandler(state as never, { FILES: r2.asBucket() }, deps) };
}

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function refusal<T>(result: StoreResult<T>): { status: number; code: string; error: string } {
  assert.equal(result.ok, false, "expected a refusal");
  return result as { status: number; code: string; error: string };
}

const column = (profile: TableProfile, name: string): ColumnProfile => {
  const found = profile.columns.find((c) => c.name === name);
  if (!found) throw new Error(`no column ${name}`);
  return found;
};

/** A shop's customers and orders as managed tables, every value text, as a file's would be. */
async function shop(store: StoreHandler) {
  const customers = Array.from({ length: 30 }, (_, i) => `('C-${String(i + 1).padStart(3, "0")}', 'Customer ${i + 1}', '19${60 + i}-0${1 + (i % 9)}-1${i % 9}', '${101 + i}-${11 + i}-${1001 + i}')`);
  const orders = Array.from({ length: 60 }, (_, i) => {
    const n = i + 1;
    const customer = n <= 50 ? `C-${String(1 + (n % 30)).padStart(3, "0")}` : n <= 56 ? `C-9${n}` : "";
    const day = n % 3 === 0 ? `${1 + (n % 12)}/${1 + (n % 27)}/2025` : `2024-${String(1 + (n % 12)).padStart(2, "0")}-${String(1 + (n % 27)).padStart(2, "0")}`;
    const total = n % 4 === 0 ? `$${(n * 10).toFixed(2)}` : (n * 10).toFixed(2);
    return `('A-${String(n).padStart(4, "0")}', '${customer}', '${day}', '${total}', '${["Shipped", "shipped", "Open"][n % 3]}')`;
  });
  value(
    await store.migrate(ME, {
      id: "0001_shop",
      sql: [
        "CREATE TABLE customers (customer_id TEXT, name TEXT, birth_date TEXT, ssn TEXT);",
        "--> statement-breakpoint",
        "CREATE TABLE orders (order_no TEXT, customer_id TEXT, ordered TEXT, total TEXT, status TEXT);",
      ].join("\n"),
    }),
  );
  value(await store.exec(ME, { sql: `INSERT INTO customers VALUES ${customers.join(", ")}; INSERT INTO orders VALUES ${orders.join(", ")};` }));
}

describe("a table's profile", () => {
  it("says what each column holds: formats, money, a list's spellings, and the table a column points at, counted in rows", async () => {
    const { store } = setup();
    await shop(store);
    const profile = value(await store.profile(ME, { table: "orders" }));
    assert.equal(profile.table, "orders");
    assert.equal(profile.rows, 60);
    assert.equal(profile.rowsRead, 60);
    const ordered = column(profile, "ordered");
    assert.equal(ordered.reads, "date");
    assert.deepEqual(ordered.formats?.map((f) => [f.name, f.rows]), [
      ["year-month-day", 40],
      ["month/day/year", 20],
    ]);
    assert.deepEqual(ordered.fact, { kind: "formats", formats: 2, reads: "date" });
    assert.equal(ordered.bins?.by, "month");
    const total = column(profile, "total");
    assert.equal(total.reads, "money");
    assert.deepEqual(total.range, { low: 10, high: 600 });
    assert.equal(total.bins?.bars.reduce((sum, b) => sum + b.rows, 0), 60);
    const status = column(profile, "status");
    assert.deepEqual(status.fact, { kind: "spellings", values: 3, spellings: 2 });
    const link = column(profile, "customer_id").link;
    assert.equal(link?.table, "customers");
    assert.equal(link?.rows, 56);
    assert.equal(link?.found, 50);
    assert.equal(link?.missing, 6);
    assert.deepEqual(column(profile, "customer_id").fact, { kind: "unlinked", rows: 6, table: "customers" });
  });

  it("keeps a person's numbers back: counted, with no value of theirs anywhere in the answer", async () => {
    const { store } = setup();
    await shop(store);
    const profile = value(await store.profile(ME, { table: "customers" }));
    for (const name of ["birth_date", "ssn"]) {
      const c = column(profile, name);
      assert.equal(c.filled, 30);
      assert.ok(c.personal, `${name} is kept back`);
      assert.deepEqual(c.common, []);
      assert.equal(c.range, undefined);
      assert.equal(c.bins, undefined);
    }
    assert.ok(!JSON.stringify(profile).includes("1960-01-10"), "no birth date");
    assert.ok(!JSON.stringify(profile).includes("101-11-1001"), "no tax id");
  });

  it("reads only the columns asked for, and refuses a table or a column the store lacks in words", async () => {
    const { store } = setup();
    await shop(store);
    const two = value(await store.profile(ME, { table: "orders", columns: ["total", "status"] }));
    assert.deepEqual(two.columns.map((c) => c.name), ["total", "status"]);
    assert.equal(two.repeatedRows, null);
    const none = refusal(await store.profile(ME, { table: "returns" }));
    assert.equal(none.status, 404);
    assert.match(none.error, /no table "returns"/);
    const odd = refusal(await store.profile(ME, { table: "orders", columns: ["weight"] }));
    assert.equal(odd.status, 400);
    assert.match(odd.error, /no column "weight"/);
    assert.equal(refusal(await store.profile(ME, { table: "_meta" })).status, 404);
  });

  it("writes nothing", async () => {
    const { store, storage } = setup();
    await shop(store);
    const sql = storage.sql as unknown as { exec: (q: string, ...b: unknown[]) => { rowsWritten: number } };
    const exec = sql.exec;
    let wrote = 0;
    sql.exec = function (this: unknown, q: string, ...b: unknown[]) {
      const cursor = exec.call(this, q, ...b);
      wrote += cursor.rowsWritten;
      return cursor;
    };
    try {
      value(await store.profile(ME, { table: "orders" }));
    } finally {
      delete (sql as { exec?: unknown }).exec;
    }
    assert.equal(wrote, 0);
  });
});
