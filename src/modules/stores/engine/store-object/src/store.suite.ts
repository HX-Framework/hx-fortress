// A store's object on stand-ins for its storage and bucket: it keeps its own store id from the
// first call and refuses any other; reads its tables in the Data view's shapes; reads SQL without
// ever keeping a write; changes managed tables only; refuses a double-quoted name SQLite would
// read as text; applies a migration once, with drizzle's own record beside its own; takes files
// in parts; runs jobs in chunks, once per request key; keeps
// its history across a restore; and leaves only a mark when destroyed.

import { describe, it, host, stateOf, filesOf, itRestores } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import type { StoreDeps } from "./core.js";
import { StoreHandler } from "./handler.js";
import { JobParamsError, type JobHandler } from "./jobs/types.js";
import { STATS_TABLE_NAMES, type StoreCaller, type StoreResult } from "./types.js";

const A = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "sto_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ME: StoreCaller = { storeId: A, actor: "user:u-1" };

function setup(jobs: JobHandler[] = []) {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map(jobs.map((j) => [j.kind, j])) };
  const make = () => new StoreHandler(state as never, { FILES: r2.asBucket() }, deps);
  return { clock, storage, state, r2, store: make(), make };
}

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function refusal<T>(result: StoreResult<T>): { status: number; code: string } {
  assert.equal(result.ok, false, "expected a refusal");
  return result as { status: number; code: string };
}

/** A zip of stored files, with no checksums: its list of files is all the store reads of it here. */
function storedZip(files: readonly { name: string; text: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const list: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = enc.encode(file.text);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const e = new DataView(entry.buffer);
    e.setUint32(0, 0x02014b50, true);
    e.setUint16(4, 20, true);
    e.setUint16(6, 20, true);
    e.setUint32(20, data.length, true);
    e.setUint32(24, data.length, true);
    e.setUint16(28, name.length, true);
    e.setUint32(42, offset, true);
    entry.set(name, 46);
    parts.push(local, data);
    list.push(entry);
    offset += local.length + data.length;
  }
  const end = new Uint8Array(22);
  const d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, files.length, true);
  d.setUint16(10, files.length, true);
  d.setUint32(12, list.reduce((n, entry) => n + entry.length, 0), true);
  d.setUint32(16, offset, true);
  const all = [...parts, ...list, end];
  const out = new Uint8Array(all.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("a store's identity", () => {
  it("keeps the store id of its first call and refuses a call for any other store", async () => {
    const { store } = setup();
    value(await store.catalog(ME));
    assert.deepEqual(refusal(await store.catalog({ storeId: B, actor: "user:u-1" })), {
      ok: false,
      status: 403,
      code: "token_wrong_store",
      error: "This call is for another store.",
    });
    assert.equal(refusal(await store.query({ storeId: B, actor: "user:u-2" }, { sql: "SELECT 1" })).code, "token_wrong_store");
  });

  it("refuses a call that does not say whose it is", async () => {
    const { store } = setup();
    assert.equal(refusal(await store.catalog({ storeId: A, actor: "" })).code, "bad_request");
    assert.equal(refusal(await store.catalog({ storeId: "", actor: "user:u-1" })).code, "bad_request");
  });
});

describe("the catalog, rows, Used By and locate", () => {
  it("shows managed and program tables in the Data view's shapes, and the store's own tables as quiet", async () => {
    const { store } = setup();
    value(
      await store.migrate(ME, {
        id: "0001_parcels",
        sql: "CREATE TABLE parcels (id TEXT PRIMARY KEY, block TEXT, lot TEXT, status TEXT CHECK (status IN ('open', 'closed')));--> statement-breakpoint\nCREATE TABLE permits (id TEXT PRIMARY KEY, parcel_id TEXT REFERENCES parcels(id), name TEXT, fee REAL, created_at TEXT);",
      }),
    );
    value(await store.exec(ME, { sql: "INSERT INTO parcels VALUES ('p1', '12', '3', 'open'), ('p2', '12', '4', 'closed')" }));
    value(await store.exec(ME, { sql: "INSERT INTO permits VALUES ('a', 'p1', 'Deck', 120, '2026-01-02'), ('b', 'p1', 'Fence', 80, '2026-02-03'), ('c', 'p2', 'Shed', 40, '2026-03-04')" }));
    const catalog = value(await store.catalog(ME));
    assert.deepEqual(catalog.databases, [{ name: "store", engine: "sqlite" }]);
    const permits = catalog.tables.find((t) => t.name === "permits")!;
    assert.equal(permits.kind, "managed");
    assert.equal(permits.count, 3);
    assert.deepEqual(permits.key, ["id"]);
    assert.equal(permits.label, "name");
    assert.deepEqual(permits.columns.find((c) => c.name === "parcel_id")!.link, { database: "store", table: "parcels", column: "id", via: "foreign_key" });
    const status = catalog.tables.find((t) => t.name === "parcels")!.columns.find((c) => c.name === "status")!;
    assert.deepEqual(status.values, ["open", "closed"]);
    const meta = catalog.tables.find((t) => t.name === "_meta")!;
    assert.equal(meta.kind, "system");
    assert.equal(meta.quiet, true);
    assert.ok(catalog.tables.some((t) => t.name === "__drizzle_migrations" && t.kind === "system"));
    assert.ok(catalog.bytes > 0);

    const page = value(await store.rows(ME, { database: "store", table: "permits", offset: 0, limit: 2, sort: { column: "fee", direction: "desc" }, labels: [{ column: "parcel_id", database: "store", table: "parcels", key: "id", label: "lot" }] }));
    assert.deepEqual(page.columns, ["id", "parcel_id", "name", "fee", "created_at"]);
    assert.deepEqual(page.rows.map((r) => r[0]), ["a", "b"]);
    assert.equal(page.total, 3);
    assert.deepEqual(page.labels.parcel_id, { p1: "3" });
    const filtered = value(await store.rows(ME, { database: "store", table: "permits", offset: 0, limit: 10, filter: { column: "parcel_id", value: "p2" } }));
    assert.deepEqual(filtered.rows.map((r) => r[0]), ["c"]);
    // Several keys, the first first: by parcel, then by fee within it. `sorts` wins over the one
    // `sort` an older client sends.
    const byTwo = value(
      await store.rows(ME, {
        database: "store",
        table: "permits",
        offset: 0,
        limit: 10,
        sort: { column: "fee", direction: "desc" },
        sorts: [
          { column: "parcel_id", direction: "asc" },
          { column: "fee", direction: "asc" },
        ],
      }),
    );
    assert.deepEqual(byTwo.rows.map((r) => r[0]), ["b", "a", "c"]);
    assert.equal(refusal(await store.rows(ME, { database: "store", table: "permits", offset: 0, limit: 5, sorts: [{ column: "nope", direction: "asc" }] })).status, 400);

    const used = value(await store.usedBy(ME, { refs: [{ database: "store", table: "permits", column: "parcel_id", value: "p1" }] }));
    assert.deepEqual(used.refs, [{ database: "store", table: "permits", column: "parcel_id", count: 2 }]);
    const where = value(await store.locate(ME, { database: "store", table: "permits", column: "id", value: "a" }));
    assert.equal(where.offset, 2, "newest first: c, b, a");
    assert.equal(refusal(await store.rows(ME, { database: "other", table: "permits", offset: 0, limit: 5 })).status, 404);
    assert.equal(refusal(await store.rows(ME, { database: "store", table: "nope", offset: 0, limit: 5 })).status, 404);
  });

  it("keeps the catalog when a view's table is gone, sorts and locates a view's rows, and labels only from columns there", async () => {
    const { store } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE owners (id TEXT PRIMARY KEY, full_name TEXT); INSERT INTO owners VALUES ('o1', 'Ada'), ('o2', 'Grace')" }));
    value(await store.exec(ME, { sql: "CREATE TABLE lots (id TEXT PRIMARY KEY, owner_id TEXT); INSERT INTO lots VALUES ('l1', 'o1'), ('l2', 'o2')" }));
    value(await store.exec(ME, { sql: "CREATE VIEW owner_names AS SELECT full_name FROM owners; CREATE TABLE gone (x TEXT); CREATE VIEW broken AS SELECT x FROM gone" }));
    value(await store.exec(ME, { sql: "DROP TABLE gone" }));
    const names = value(await store.catalog(ME)).tables.map((t) => t.name);
    assert.ok(names.includes("owners") && names.includes("owner_names") && !names.includes("broken"));
    const sorted = value(await store.rows(ME, { database: "store", table: "owner_names", offset: 0, limit: 10, sort: { column: "full_name", direction: "desc" } }));
    assert.deepEqual(sorted.rows, [["Grace"], ["Ada"]]);
    assert.equal(value(await store.locate(ME, { database: "store", table: "owner_names", column: "full_name", value: "Grace" })).offset, 1);
    const labelled = value(await store.rows(ME, { database: "store", table: "lots", offset: 0, limit: 10, labels: [{ column: "owner_id", database: "store", table: "owners", key: "id", label: "name" }] }));
    assert.equal(labelled.labels.owner_id, undefined, "a label column that is not there labels nothing, never with its own name");
  });

  it("cuts a long cell for the wire and says which", async () => {
    const { store } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)" }));
    value(await store.exec(ME, { sql: "INSERT INTO notes (body) VALUES (?)", params: ["x".repeat(1_500)] }));
    const page = value(await store.rows(ME, { database: "store", table: "notes", offset: 0, limit: 10 }));
    assert.equal(page.rows[0]![1]!.length, 1_000);
    assert.deepEqual(page.cut, ["0:1"]);
    // The row's panel reads one row whole; a page of more rows is cut all the same.
    const whole = value(await store.rows(ME, { database: "store", table: "notes", offset: 0, limit: 1, whole: true }));
    assert.equal(whole.rows[0]![1]!.length, 1_500);
    assert.deepEqual(whole.cut, []);
    const many = value(await store.rows(ME, { database: "store", table: "notes", offset: 0, limit: 10, whole: true }));
    assert.deepEqual(many.cut, ["0:1"]);
  });
});

describe("filters and the search", () => {
  // Numbers kept as numbers and as text, days as ISO writes them and as a town wrote one, yes and
  // no as 1 and 0 and as words, empty cells as NULL and as empty text, and the store's own columns.
  async function things() {
    const { store } = setup();
    value(
      await store.exec(ME, {
        sql: `CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER, price REAL, amount TEXT, issued TEXT, paid INTEGER, approved TEXT, note TEXT, _key TEXT, _hash TEXT);
          INSERT INTO things VALUES (1, 'Deck', 3, 120.5, '150.00', '2026-01-07', 1, 'Yes', 'front deck', 'k-deck', 'abc123');
          INSERT INTO things VALUES (2, 'Fence', 10, 80, '2,250.50', '2026-02-14T10:00:00Z', 0, 'No', NULL, 'k-fence', 'deadbeef');
          INSERT INTO things VALUES (3, 'Shed', NULL, 40.25, '', '2/14/2026', NULL, 'y', '', 'k-shed', 'ff00');
          INSERT INTO things VALUES (4, 'Pool 100%', 7, NULL, '-75.25', '2026-03-01 08:00', 1, 'N', 'under_ground', 'k-pool', 'aa');
          INSERT INTO things VALUES (5, NULL, 0, 0, 'about 5', NULL, 0, '', 'Deck stairs', 'k-x', 'DECK99');
          INSERT INTO things VALUES (6, 'deck rail', 2, 15, '10', '', 1, NULL, NULL, 'k-deck2', '00');
          CREATE TABLE counts (id INTEGER PRIMARY KEY, n INTEGER);
          INSERT INTO counts VALUES (1, 5), (2, 6);`,
      }),
    );
    const page = async (ask: Partial<Parameters<typeof store.rows>[1]>) => store.rows(ME, { database: "store", table: "things", offset: 0, limit: 50, ...ask });
    const ids = async (ask: Partial<Parameters<typeof store.rows>[1]>) => value(await page(ask)).rows.map((r) => Number(r[0]));
    return { store, page, ids };
  }

  it("keeps the rows each operator asks for", async () => {
    const { store, ids } = await things();
    const by = (column: string, op: string, v?: string) => ids({ filters: [{ column, op: op as never, ...(v === undefined ? {} : { value: v }) }] });
    // The cell's text, exactly: case counts, and a number reads as the page shows it.
    assert.deepEqual(await by("name", "is", "Deck"), [1]);
    assert.deepEqual(await by("qty", "is", "3"), [1]);
    assert.deepEqual(await by("price", "is", "120.5"), [1]);
    assert.deepEqual(await by("name", "is_not", "Deck"), [2, 3, 4, 5, 6], "an empty cell is not the value");
    // Words in any letter case, with % and _ as the characters they are.
    assert.deepEqual(await by("name", "contains", "deck"), [1, 6]);
    assert.deepEqual(await by("name", "contains", "0%"), [4]);
    assert.deepEqual(await by("note", "contains", "_"), [4]);
    assert.deepEqual(await by("note", "not_contains", "deck"), [2, 3, 4, 6], "an empty cell does not hold the words");
    assert.deepEqual(await by("name", "starts_with", "de"), [1, 6]);
    assert.deepEqual(await by("name", "ends_with", "RAIL"), [6]);
    // Numbers as numbers, kept as numbers or as text; text that is no plain number never matches.
    assert.deepEqual(await by("qty", "gt", "2"), [1, 2, 4]);
    assert.deepEqual(await by("qty", "gte", "2"), [1, 2, 4, 6]);
    assert.deepEqual(await by("price", "lt", "40.25"), [5, 6]);
    assert.deepEqual(await by("price", "lte", "40.25"), [3, 5, 6]);
    assert.deepEqual(await by("amount", "gt", "0"), [1, 6], "'2,250.50' and 'about 5' are no plain numbers");
    assert.deepEqual(await by("amount", "lte", " 10 "), [4, 6]);
    // A day as ISO writes it, with a time after it or not; a day written otherwise never matches.
    assert.deepEqual(await by("issued", "on", "2026-02-14"), [2]);
    assert.deepEqual(await by("issued", "before", "2026-02-14"), [1]);
    assert.deepEqual(await by("issued", "after", "2026-02-14"), [4]);
    // Yes and no, as 1 and 0 and as words.
    assert.deepEqual(await by("paid", "is_true"), [1, 4, 6]);
    assert.deepEqual(await by("paid", "is_false"), [2, 5]);
    assert.deepEqual(await by("approved", "is_true"), [1, 3]);
    assert.deepEqual(await by("approved", "is_false"), [2, 4]);
    // Empty: no value, or empty text.
    assert.deepEqual(await by("note", "empty"), [2, 3, 6]);
    assert.deepEqual(await by("note", "not_empty"), [1, 4, 5]);
    assert.deepEqual(await by("qty", "empty"), [3]);
    // A cell of only spaces, tabs or line breaks is empty too, as a column's profile counts it.
    value(await store.exec(ME, { sql: "UPDATE things SET note = ' ' || char(9) || ' ' WHERE id = 5" }));
    assert.deepEqual(await by("note", "empty"), [2, 3, 5, 6]);
    assert.deepEqual(await by("note", "not_empty"), [1, 4]);
  });

  it("searches the text columns, and never the store's own key and hash", async () => {
    const { store, ids } = await things();
    assert.deepEqual(await ids({ search: "DECK" }), [1, 5, 6]);
    assert.deepEqual(await ids({ search: "  100%  " }), [4], "the words trimmed, % as itself");
    assert.deepEqual(await ids({ search: "beef" }), [], "only _hash holds it");
    assert.deepEqual(await ids({ search: "k-" }), [], "only _key holds it");
    assert.deepEqual(await ids({ search: "120" }), [], "a REAL column is no text column");
    assert.deepEqual(await ids({ search: "   " }), [1, 2, 3, 4, 5, 6], "no words, no search");
    const none = value(await store.rows(ME, { database: "store", table: "counts", offset: 0, limit: 10, search: "5" }));
    assert.deepEqual(none.rows, [], "a table with no text column");
    assert.equal(none.total, 0);
  });

  it("finds long words, and searches every text column with filters beside it, past a statement's 100 bound values", async () => {
    const { store } = setup();
    // workerd's LIKE takes a pattern of at most 50 bytes, a statement at most 100 bound values, and
    // a table at most 100 columns: 98 text columns searched, with three filters, were 101 values.
    const long = "a permit for the rebuilding of the north wing's roof after the storm of 2019";
    const many = Array.from({ length: 98 }, (_, i) => `c${i} TEXT`).join(", ");
    value(
      await store.exec(ME, {
        sql: `CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
          INSERT INTO notes VALUES (1, 'Filed: ${long.replace(/'/g, "''")}. Approved.'), (2, 'A short one');
          CREATE TABLE wide (id INTEGER PRIMARY KEY, ${many});
          INSERT INTO wide (id, c0, c1, c97) VALUES (1, 'north', 'gate', 'it''s here'), (2, 'south', 'gate', NULL);`,
      }),
    );
    const ids = async (table: string, ask: Partial<Parameters<typeof store.rows>[1]>) =>
      value(await store.rows(ME, { database: "store", table, offset: 0, limit: 10, ...ask })).rows.map((r) => Number(r[0]));
    assert.deepEqual(await ids("notes", { filters: [{ column: "body", op: "contains", value: long.toUpperCase() }] }), [1]);
    assert.deepEqual(await ids("notes", { filters: [{ column: "body", op: "ends_with", value: `${long}. approved.` }] }), [1]);
    assert.deepEqual(await ids("notes", { search: long.slice(0, 120) }), [1]);
    assert.deepEqual(await ids("wide", { search: "IT'S" }), [1], "a quote in the words is a quote");
    const three = [
      { column: "c1", op: "contains" as const, value: "gat" },
      { column: "c1", op: "starts_with" as const, value: "g" },
      { column: "c0", op: "not_contains" as const, value: "east" },
    ];
    assert.deepEqual(await ids("wide", { search: "south", filters: three }), [2]);
  });

  it("keeps the rows that pass every filter and the search, in the sort's order, and counts them on the first page", async () => {
    const { page, ids } = await things();
    const both = [
      { column: "name", op: "contains" as const, value: "e" },
      { column: "qty", op: "gt" as const, value: "1" },
    ];
    assert.deepEqual(await ids({ filters: both, sorts: [{ column: "qty", direction: "desc" }] }), [2, 1, 6]);
    assert.deepEqual(await ids({ filters: both, search: "rail" }), [6]);
    const first = value(await page({ filters: [{ column: "name", op: "contains", value: "deck" }], limit: 1 }));
    assert.deepEqual([first.rows.map((r) => r[0]), first.total], [["1"], 2]);
    const second = value(await page({ filters: [{ column: "name", op: "contains", value: "deck" }], limit: 1, offset: 1 }));
    assert.deepEqual([second.rows.map((r) => r[0]), second.total], [["6"], null]);
  });

  it("still takes the one filter an older client sends, and reads the list before it", async () => {
    const { ids } = await things();
    assert.deepEqual(await ids({ filter: { column: "name", value: "Fence" } }), [2]);
    assert.deepEqual(await ids({ filter: { column: "note", value: null } }), [2, 3, 6], "null reads as empty");
    assert.deepEqual(await ids({ filter: { column: "name", value: "Deck" }, filters: [{ column: "name", op: "is", value: "Shed" }] }), [3]);
    assert.deepEqual(await ids({ filter: { column: "name", value: "Deck" }, filters: [] }), [1], "an empty list is no list");
  });

  it("refuses a filter it cannot read, before reading a row", async () => {
    const { page } = await things();
    const refused = async (ask: Partial<Parameters<typeof page>[0]>, words: string) => {
      const r = refusal(await page(ask)) as { status: number; code: string; error?: string };
      assert.deepEqual([r.status, r.code], [400, "bad_request"]);
      assert.equal((r as { error?: string }).error, words);
    };
    await refused({ filters: [{ column: "nope", op: "is", value: "x" }] }, 'This table has no column "nope".');
    await refused({ filters: [{ column: "name", op: "like" as never, value: "x" }] }, 'A filter has no operator "like".');
    await refused({ filters: [{ column: "name", op: "is" }] }, 'A filter on "name" needs a value.');
    await refused({ filters: [{ column: "name", op: "contains", value: "" }] }, 'A filter on "name" needs a value.');
    await refused({ filters: [{ column: "qty", op: "gt", value: "lots" }] }, '"lots" is not a number.');
    await refused({ filters: [{ column: "issued", op: "on", value: "2026-02-30" }] }, '"2026-02-30" is not a day: write it as 2026-11-18.');
    await refused({ filters: [{ column: "issued", op: "after", value: "14/2/2026" }] }, '"14/2/2026" is not a day: write it as 2026-11-18.');
    await refused({ filters: Array.from({ length: 13 }, () => ({ column: "name", op: "not_empty" as const })) }, "A page takes at most 12 filters.");
    await refused({ search: "x".repeat(201) }, "A search is at most 200 characters.");
  });
});

describe("query", () => {
  it("reads, with a limit, and says when there was more", async () => {
    const { store } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE n (v INTEGER)" }));
    value(await store.exec(ME, { sql: "INSERT INTO n SELECT value FROM json_each(?)", params: [JSON.stringify([1, 2, 3, 4, 5])] }));
    const result = value(await store.query(ME, { sql: "SELECT v FROM n WHERE v > ? ORDER BY v", params: [1], limit: 3 }));
    assert.deepEqual(result.columns, ["v"]);
    assert.deepEqual(result.rows, [[2], [3], [4]]);
    assert.equal(result.truncated, true);
  });

  it("never writes: a writing statement is refused, and so is a second statement", async () => {
    const { store, storage } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE n (v INTEGER)" }));
    for (const sql of ["INSERT INTO n VALUES (1)", "DELETE FROM n", "DROP TABLE n", "CREATE TABLE m (a)", "WITH x AS (SELECT 1) DELETE FROM n"]) {
      assert.equal(refusal(await store.query(ME, { sql })).code, "read_only", sql);
    }
    assert.equal(refusal(await store.query(ME, { sql: "SELECT 1; DELETE FROM n" })).code, "bad_request");
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'n'").one().n, 1);
  });

  it("refuses a double-quoted name SQLite would read as text, and keeps a quoted name that is a column", async () => {
    const { store } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE permits (id TEXT, kind TEXT)" }));
    value(await store.exec(ME, { sql: "INSERT INTO permits VALUES ('BP-1', 'kind'), ('BP-2', 'Building')" }));
    const typo = refusal(await store.query(ME, { sql: 'SELECT "knid" FROM permits' }));
    assert.equal(typo.code, "bad_request");
    assert.match((typo as unknown as { error: string }).error, /"knid" is not a column/);
    assert.equal(refusal(await store.exec(ME, { sql: 'UPDATE permits SET kind = "Electrical"' })).code, "bad_request");
    assert.equal(refusal(await store.exec(ME, { sql: '-- a note\nINSERT INTO permits (id, kind) SELECT id, "kind2" FROM permits' })).code, "bad_request");
    // A quoted column beside the same word in single quotes, and a quote inside a text, are fine.
    assert.deepEqual(value(await store.query(ME, { sql: `SELECT "id" FROM permits WHERE "kind" = 'kind' AND 'say "id"' <> ''` })).rows, [["BP-1"]]);
    assert.equal(value(await store.exec(ME, { sql: `UPDATE permits SET "kind" = 'kind' WHERE "id" = 'BP-2'` })).changes, 1);
    // A table made with double-quoted names is still made: DDL names are never text.
    value(await store.exec(ME, { sql: 'CREATE TABLE "fees" ("id" TEXT, "cents" INTEGER)' }));
  });

  it("runs only the PRAGMAs that read the schema, and none that changes how the store works", async () => {
    const { store } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE t (a INTEGER CHECK (a < 100))" }));
    for (const sql of ["PRAGMA ignore_check_constraints = ON", "PRAGMA foreign_keys(0)", "/* x */ PRAGMA case_sensitive_like = 1"]) {
      assert.equal(refusal(await store.query(ME, { sql })).code, "read_only", sql);
    }
    assert.deepEqual(value(await store.query(ME, { sql: "PRAGMA table_info(t)" })).columns.includes("name"), true);
    assert.equal(refusal(await store.exec(ME, { sql: "/* x */ PRAGMA ignore_check_constraints = ON" })).code, "bad_request");
    assert.equal(refusal(await store.exec(ME, { sql: "VACUUM" })).code, "bad_request");
    // Nothing above reached the connection: the CHECK still holds.
    assert.equal(refusal(await store.exec(ME, { sql: "INSERT INTO t VALUES (500)" })).code, "sql_error");
  });

  it("reads drizzle's quoted names as names, and still refuses one that would be text", async () => {
    const { store } = setup();
    value(await store.migrate(ME, { id: "0000_items", sql: "CREATE TABLE `items` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `name` text, `status` text, `cents` integer)" }));
    value(await store.exec(ME, { sql: "CREATE TABLE audit (tbl TEXT); CREATE TRIGGER items_audit AFTER UPDATE ON items BEGIN INSERT INTO audit VALUES ('items'); END" }));
    // What drizzle's sqlite-proxy sends: every name in double quotes.
    value(await store.exec(ME, { sql: 'insert into "items" ("id", "name", "status") values (null, ?, ?)', params: ["a", "open"] }));
    value(await store.exec(ME, { sql: 'update "items" set "status" = ? where "items"."id" = ?', params: ["closed", 1] }));
    assert.deepEqual(value(await store.query(ME, { sql: 'select "name", "status" from "items"' })).rows, [["a", "closed"]]);
    assert.equal(refusal(await store.query(ME, { sql: 'SELECT id FROM items WHERE "stauts" IS NULL' })).code, "bad_request");
    assert.equal(refusal(await store.exec(ME, { sql: 'CREATE TABLE fees (cents INTEGER, CHECK ("cnets" >= 0))' })).code, "bad_request");
    // A name missing without quotes is SQLite's own error, not a guess about text.
    assert.equal(refusal(await store.query(ME, { sql: 'SELECT "name", nope FROM items' })).code, "sql_error");
  });

  it("answers SQLite's own words for a statement it cannot run", async () => {
    const { store } = setup();
    const r = refusal(await store.query(ME, { sql: "SELECT * FROM missing" }));
    assert.equal(r.code, "sql_error");
    assert.match((r as unknown as { error: string }).error, /no such table: missing/);
  });
});

describe("exec and the schema rule", () => {
  async function withProgramTable(store: StoreHandler) {
    value(await store.catalog(ME));
    // A program table, made the way LOAD makes one.
    const tables = (await import("./program-tables.js")).programTables(store.core, { id: "job_1", by: "run:r-1" });
    const fresh = tables.begin("raw_permits");
    store.core.sql.exec(`CREATE TABLE ${fresh} (permit_no TEXT, _row INTEGER)`);
    store.core.sql.exec(`INSERT INTO ${fresh} VALUES ('P-1', 1), ('P-2', 2)`);
    return tables.commit("raw_permits", { group: "From the town", madeBy: { runId: "r-1", step: "c1" } });
  }

  it("changes managed tables and counts what changed", async () => {
    const { store } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE fees (code TEXT PRIMARY KEY, amount REAL); INSERT INTO fees VALUES ('A', 1), ('B', 2);" }));
    assert.equal(value(await store.exec(ME, { sql: "UPDATE fees SET amount = amount * 2" })).changes, 2);
    assert.deepEqual(value(await store.query(ME, { sql: "SELECT sum(amount) AS s FROM fees" })).rows, [[6]]);
  });

  it("refuses to write, alter, index or drop a program table or the store's own tables, and keeps nothing of the batch", async () => {
    const { store, storage } = setup();
    const { table, version, rows } = await withProgramTable(store);
    assert.deepEqual({ table, version, rows }, { table: "raw_permits", version: 1, rows: 2 });
    value(await store.exec(ME, { sql: "CREATE TABLE notes (a TEXT)" }));
    for (const sql of [
      "INSERT INTO raw_permits VALUES ('P-3', 3)",
      "UPDATE raw_permits SET permit_no = 'x'",
      "DELETE FROM raw_permits",
      "DROP TABLE raw_permits",
      "ALTER TABLE raw_permits ADD COLUMN y TEXT",
      "CREATE INDEX raw_idx ON raw_permits (permit_no)",
      "DELETE FROM _history",
      "UPDATE _meta SET value = 'x'",
      "CREATE TABLE _mine (a)",
      "CREATE VIEW v AS SELECT * FROM raw_permits",
      "CREATE TRIGGER t AFTER INSERT ON notes BEGIN DELETE FROM raw_permits; END",
      "CREATE TABLE keep__v2 (a)",
      "INSERT INTO notes VALUES ('kept?'); DELETE FROM raw_permits",
    ]) {
      assert.equal(refusal(await store.exec(ME, { sql })).code, "protected_table", sql);
    }
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM raw_permits").one().n, 2);
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM notes").one().n, 0, "the refused batch's first statement was rolled back");
    // Reading a program table into a managed one is fine.
    value(await store.exec(ME, { sql: "INSERT INTO notes SELECT permit_no FROM raw_permits" }));
  });

  it("keeps program tables versioned: a new version renames the old one and SQL reads the plain name", async () => {
    const { store } = setup();
    await withProgramTable(store);
    const tables = (await import("./program-tables.js")).programTables(store.core, { id: "job_2", by: "run:r-2" });
    const fresh = tables.begin("raw_permits");
    store.core.sql.exec(`CREATE TABLE ${fresh} (permit_no TEXT, _row INTEGER)`);
    store.core.sql.exec(`INSERT INTO ${fresh} VALUES ('P-9', 1)`);
    const { table: name, version, rows } = await tables.commit("raw_permits", { madeBy: { runId: "r-2", step: "c1" } });
    assert.deepEqual({ name, version, rows }, { name: "raw_permits", version: 2, rows: 1 });
    assert.deepEqual(value(await store.query(ME, { sql: "SELECT permit_no FROM raw_permits" })).rows, [["P-9"]]);
    assert.deepEqual(value(await store.query(ME, { sql: "SELECT count(*) FROM raw_permits__v1" })).rows, [[2]]);
    const catalog = value(await store.catalog(ME));
    const table = catalog.tables.find((t) => t.name === "raw_permits")!;
    assert.equal(table.kind, "program");
    assert.equal(table.version, 2);
    assert.equal(table.madeBy?.runId, "r-2");
    assert.ok(!catalog.tables.some((t) => t.name === "raw_permits__v1"), "old versions stay out of the catalog");
    assert.throws(() => tables.begin("notes__v1"));
  });

  it("versions a table whose name is longer than a LIKE pattern may be in workerd", async () => {
    // A file named "Alameda_County_Building_Permits_2019-2026.csv" loads into a table with a name
    // like this one. Its versions were found with LIKE, and with the underscores escaped the
    // pattern passed workerd's 50 bytes, so a second LOAD failed ("LIKE or GLOB pattern too complex").
    const { store } = setup();
    const { keptVersions, programTables } = await import("./program-tables.js");
    const long = "alameda_county_building_permits_2019_2026_csv";
    for (const [job, permit] of [
      ["job_1", "P-1"],
      ["job_2", "P-2"],
    ] as const) {
      const tables = programTables(store.core, { id: job, by: `run:${job}` });
      const fresh = tables.begin(long);
      store.core.sql.exec(`CREATE TABLE ${fresh} (permit_no TEXT, _row INTEGER)`);
      store.core.sql.exec(`INSERT INTO ${fresh} VALUES (?, 1)`, permit);
      await tables.commit(long, { madeBy: { runId: job, step: "c1" } });
    }
    assert.deepEqual(value(await store.query(ME, { sql: `SELECT permit_no FROM ${long}` })).rows, [["P-2"]]);
    assert.deepEqual(
      keptVersions(store.core, long).map((v) => v.version),
      [1],
    );
  });

  it("refuses renaming a protected table even when the batch renames it back, and emptying a system table by making it again", async () => {
    const { store, storage } = setup();
    await withProgramTable(store);
    const roundTrip = "ALTER TABLE raw_permits RENAME TO tmp1; DELETE FROM tmp1; INSERT INTO tmp1 VALUES ('FORGED', 9); ALTER TABLE tmp1 RENAME TO raw_permits;";
    assert.equal(refusal(await store.exec(ME, { sql: roundTrip })).code, "protected_table");
    const tablesSql = String(storage.sql.exec("SELECT sql FROM sqlite_master WHERE name = '_tables'").one().sql);
    assert.equal(refusal(await store.exec(ME, { sql: `ALTER TABLE _tables RENAME TO t_old; DROP TABLE t_old; ${tablesSql};` })).code, "protected_table");
    assert.equal(refusal(await store.migrate(ME, { id: "0000_x", sql: "ALTER TABLE __drizzle_migrations RENAME TO d" })).code, "protected_table");
    assert.deepEqual(value(await store.query(ME, { sql: "SELECT permit_no FROM raw_permits ORDER BY 1" })).rows, [["P-1"], ["P-2"]]);
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM _tables WHERE name = 'raw_permits'").one().n, 1);
  });

  it("refuses a view whose double-quoted name is no column, and stores a trigger's names as names", async () => {
    const { store, storage } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE users (id TEXT, name TEXT); CREATE TABLE log (a TEXT); INSERT INTO users VALUES ('u1', 'Ada')" }));
    const view = refusal(await store.exec(ME, { sql: 'CREATE VIEW active AS SELECT "id", "nmae" FROM users' }));
    assert.equal(view.code, "sql_error");
    assert.match((view as unknown as { error: string }).error, /no such column: nmae/);
    value(await store.exec(ME, { sql: 'CREATE VIEW people AS SELECT "id", "name" FROM users' }));
    assert.deepEqual(value(await store.query(ME, { sql: "SELECT * FROM people" })).rows, [["u1", "Ada"]]);
    // A trigger body is read when it fires: a name in it that is no column fails then, never writes its own text.
    value(await store.exec(ME, { sql: 'CREATE TRIGGER t AFTER INSERT ON users BEGIN INSERT INTO log ("a") VALUES ("b"); END' }));
    assert.equal(refusal(await store.exec(ME, { sql: "INSERT INTO users VALUES ('u2', 'Grace')" })).code, "sql_error");
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM log").one().n, 0);
  });

  it("makes a table from a query, and keeps program version names and a job's table in progress from exec", async () => {
    const { store } = setup();
    await withProgramTable(store);
    value(await store.exec(ME, { sql: "CREATE TABLE fees (code TEXT, amount REAL); INSERT INTO fees VALUES ('A', 1)" }));
    value(await store.exec(ME, { sql: "CREATE TABLE fee_summary AS SELECT count(*) AS n, sum(amount) AS total FROM fees" }));
    assert.deepEqual(value(await store.query(ME, { sql: "SELECT n, total FROM fee_summary" })).rows, [[1, 1]]);
    for (const sql of ["CREATE VIEW raw_permits__v1 AS SELECT 1 AS z", "CREATE VIEW fees__new AS SELECT 1 AS z", "CREATE INDEX fees__v3 ON fees (code)"]) {
      assert.equal(refusal(await store.exec(ME, { sql })).code, "protected_table", sql);
    }
    const tables = (await import("./program-tables.js")).programTables(store.core, { id: "job_9", by: "run:r-9" });
    const fresh = tables.begin("loaded");
    store.core.sql.exec(`CREATE TABLE ${fresh} (a TEXT)`);
    assert.equal(refusal(await store.exec(ME, { sql: "INSERT INTO loaded__new VALUES ('from-exec')" })).code, "protected_table");
    // A managed table made under the same name while the job ran is never taken over.
    value(await store.exec(ME, { sql: "CREATE TABLE loaded (a TEXT); INSERT INTO loaded VALUES ('mine')" }));
    await assert.rejects(() => tables.commit("loaded", { madeBy: { runId: "r-9", step: "c1" } }), /managed table/);
    assert.deepEqual(value(await store.query(ME, { sql: "SELECT a FROM loaded" })).rows, [["mine"]]);
  });
});

describe("migrate", () => {
  const SQL = "CREATE TABLE `owners` (`id` text PRIMARY KEY NOT NULL, `name` text);\n--> statement-breakpoint\nCREATE INDEX `owners_name` ON `owners` (`name`);";

  it("applies a migration once, records it in its own table and drizzle's, and answers the same id again as not applied", async () => {
    const { store, storage } = setup();
    const first = value(await store.migrate(ME, { id: "0000_owners", sql: SQL, when: 1_790_000_000_000 }));
    assert.equal(first.applied, true);
    assert.match(first.migration.checksum, /^[0-9a-f]{64}$/);
    assert.equal(first.migration.appliedBy, "user:u-1");
    const again = value(await store.migrate({ storeId: A, actor: "user:u-2" }, { id: "0000_owners", sql: SQL }));
    assert.equal(again.applied, false);
    assert.deepEqual(again.migration, first.migration);
    const drizzle = storage.sql.exec("SELECT hash, created_at FROM __drizzle_migrations").toArray();
    assert.deepEqual(drizzle, [{ hash: first.migration.checksum, created_at: 1_790_000_000_000 }]);
    assert.deepEqual(value(await store.migrations(ME)).migrations.map((m) => m.id), ["0000_owners"]);
    const history = value(await store.history(ME));
    assert.equal(history.events[0]!.kind, "migration");
  });

  it("refuses the same id with other SQL, and a migration that does not apply cleanly leaves nothing", async () => {
    const { store, storage } = setup();
    value(await store.migrate(ME, { id: "0000_owners", sql: SQL }));
    assert.equal(refusal(await store.migrate(ME, { id: "0000_owners", sql: SQL.replace("name", "full_name") })).code, "migration_conflict");
    const broken = "CREATE TABLE `pets` (`id` text PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO `nowhere` VALUES (1);";
    assert.equal(refusal(await store.migrate(ME, { id: "0001_pets", sql: broken })).code, "sql_error");
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'pets'").one().n, 0);
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM _migrations").one().n, 1);
  });

  it("runs drizzle-kit's table rebuild, its foreign-key pragmas included", async () => {
    const { store } = setup();
    value(await store.migrate(ME, { id: "0000_owners", sql: SQL }));
    value(await store.exec(ME, { sql: "INSERT INTO owners VALUES ('o1', 'Ada')" }));
    const rebuild = [
      "PRAGMA foreign_keys=OFF;",
      "CREATE TABLE `__new_owners` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL DEFAULT '');",
      "INSERT INTO `__new_owners`(\"id\", \"name\") SELECT \"id\", coalesce(\"name\", '') FROM `owners`;",
      "DROP TABLE `owners`;",
      "ALTER TABLE `__new_owners` RENAME TO `owners`;",
      "PRAGMA foreign_keys=ON;",
      "CREATE INDEX `owners_name` ON `owners` (`name`);",
    ].join("\n--> statement-breakpoint\n");
    assert.equal(value(await store.migrate(ME, { id: "0001_owners_name_required", sql: rebuild })).applied, true);
    assert.deepEqual(value(await store.query(ME, { sql: "SELECT id, name FROM owners" })).rows, [["o1", "Ada"]]);
    assert.equal(refusal(await store.migrate(ME, { id: "0002_bad", sql: "PRAGMA writable_schema = ON;" })).code, "bad_request");
  });

  it("refuses drizzle-kit's rebuild of a table another table's rows reference, which would cascade or orphan them", async () => {
    for (const action of ["ON DELETE cascade", "ON DELETE set null", ""]) {
      const { store, storage } = setup();
      value(await store.migrate(ME, { id: "0000", sql: `CREATE TABLE \`users\` (\`id\` integer PRIMARY KEY NOT NULL, \`name\` text);\n--> statement-breakpoint\nCREATE TABLE \`posts\` (\`id\` integer PRIMARY KEY NOT NULL, \`user_id\` integer REFERENCES \`users\`(\`id\`) ${action});` }));
      value(await store.exec(ME, { sql: "INSERT INTO users VALUES (1, 'a'); INSERT INTO posts VALUES (10, 1), (11, 1);" }));
      const rebuild = [
        "PRAGMA foreign_keys=OFF;",
        "CREATE TABLE `__new_users` (`id` integer PRIMARY KEY NOT NULL, `name` text NOT NULL DEFAULT '');",
        'INSERT INTO `__new_users`("id", "name") SELECT "id", "name" FROM `users`;',
        "DROP TABLE `users`;",
        "ALTER TABLE `__new_users` RENAME TO `users`;",
        "PRAGMA foreign_keys=ON;",
      ].join("\n--> statement-breakpoint\n");
      const r = refusal(await store.migrate(ME, { id: "0001", sql: rebuild }));
      assert.equal(r.code, "bad_request", action);
      assert.match((r as unknown as { error: string }).error, /Dropping users would delete or orphan the rows of posts/);
      assert.deepEqual(storage.sql.exec("SELECT id, user_id FROM posts ORDER BY id").toArray().map((p) => [p.id, p.user_id]), [[10, 1], [11, 1]], action);
      // With no rows referencing it, the same rebuild applies.
      value(await store.exec(ME, { sql: "DELETE FROM posts" }));
      assert.equal(value(await store.migrate(ME, { id: "0001", sql: rebuild })).applied, true, action);
    }
  });

  it("refuses drizzle-kit's rebuild that selects a column the old table lacks, which SQLite would fill with the column's name", async () => {
    const { store, storage } = setup();
    value(await store.migrate(ME, { id: "0000_owners", sql: SQL }));
    value(await store.exec(ME, { sql: "INSERT INTO owners VALUES ('o1', 'Ada'), ('o2', 'Grace')" }));
    // What drizzle-kit 0.31 generated for "make name required and add email" in one step.
    const combined = [
      "PRAGMA foreign_keys=OFF;",
      "CREATE TABLE `__new_owners` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL DEFAULT '', `email` text);",
      "INSERT INTO `__new_owners`(\"id\", \"name\", \"email\") SELECT \"id\", \"name\", \"email\" FROM `owners`;",
      "DROP TABLE `owners`;",
      "ALTER TABLE `__new_owners` RENAME TO `owners`;",
      "PRAGMA foreign_keys=ON;",
    ].join("\n--> statement-breakpoint\n");
    const r = refusal(await store.migrate(ME, { id: "0001_owners_email", sql: combined }));
    assert.equal(r.code, "bad_request");
    assert.match((r as unknown as { error: string }).error, /"email" is not a column of what this statement reads, so SQLite would take it as the text 'email'/);
    // Nothing of it stayed: the old table, its rows, no new table, one migration.
    assert.deepEqual(storage.sql.exec("SELECT name FROM pragma_table_info('owners')").toArray().map((c) => c.name), ["id", "name"]);
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = '__new_owners'").one().n, 0);
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM _migrations").one().n, 1);
  });
});

describe("files", () => {
  it("takes a file in parts, lists it, says where to read it, and deletes it", async () => {
    const { store, r2, clock, storage } = setup();
    const created = value(await store.fileCreate(ME, { name: "folder/permits 2025.csv", size: 11, contentType: "text/csv", batch: "b1" }));
    assert.equal(created.partBytes, 8 * 1024 * 1024);
    assert.equal(created.file.name, "folder_permits 2025.csv");
    assert.equal(created.file.state, "uploading");
    assert.equal(created.file.via, "page");
    const target = value(await store.filePartTarget(ME, created.file.id, 1));
    assert.equal(target.key, `stores/${A}/files/${created.file.id}/folder_permits 2025.csv`);
    const part = await r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, "id,fee\n1,2\n");
    assert.equal(refusal(await store.filePartTarget(ME, created.file.id, 2)).code, "bad_request");
    const done = value(await store.fileComplete(ME, created.file.id, { parts: [{ n: 1, etag: part.etag }] }));
    assert.equal(done.file.state, "ready");
    assert.deepEqual(value(await store.files(ME)).files.map((f) => f.name), ["folder_permits 2025.csv"]);
    assert.deepEqual(value(await store.fileTarget(ME, created.file.id)), { key: target.key, name: "folder_permits 2025.csv", contentType: "text/csv", size: 11 });
    assert.equal(r2.objects.get(target.key)!.customMetadata!.receivedBy, "user:u-1");
    const history = value(await store.history(ME)).events;
    assert.equal(history[0]!.note, "Received 1 file: folder_permits 2025.csv");
    value(await store.fileDelete(ME, created.file.id));
    assert.deepEqual(value(await store.files(ME)).files, []);
    assert.equal(refusal(await store.fileTarget(ME, created.file.id)).code, "file_not_found");
    // Deleted, not gone: the bytes stay 30 days, then the store's alarm takes them.
    assert.equal(r2.objects.has(target.key), true);
    clock.advance(30 * 24 * 60 * 60_000 + 1);
    storage.alarm = null;
    await store.alarm();
    assert.equal(r2.objects.has(target.key), false);
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM _files").one().n, 0);
  });

  it("keeps a content type a header can carry, and stops a file deleted while it arrives", async () => {
    const { store, r2 } = setup();
    const evil = value(await store.fileCreate(ME, { name: "a.txt", size: 2, contentType: "text/plain\r\nx-evil: 1" }));
    assert.equal(evil.file.contentType, "application/octet-stream");
    assert.equal(value(await store.fileCreate(ME, { name: "b.csv", size: 2, contentType: "text/csv; charset=utf-8" })).file.contentType, "text/csv; charset=utf-8");
    const t = value(await store.filePartTarget(ME, evil.file.id, 1));
    const part = await r2.resumeMultipartUpload(t.key, t.uploadId).uploadPart(1, "hi");
    // The delete lands while R2 puts the parts together.
    store.core.sql.exec("DELETE FROM _files WHERE id = ?", evil.file.id);
    assert.equal(refusal(await store.fileComplete(ME, evil.file.id, { parts: [{ n: 1, etag: part.etag }] })).code, "file_not_found");
    assert.equal(r2.objects.has(t.key), false, "no bytes are left without a record");
  });

  it("refuses parts that do not make the file, and a way of arriving the caller cannot use", async () => {
    const { store, r2 } = setup();
    const created = value(await store.fileCreate(ME, { name: "a.csv", size: 100, contentType: "text/csv" }));
    const target = value(await store.filePartTarget(ME, created.file.id, 1));
    const part = await r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, "short");
    assert.equal(refusal(await store.fileComplete(ME, created.file.id, { parts: [{ n: 1, etag: part.etag }] })).code, "bad_request");
    assert.equal(refusal(await store.fileCreate({ storeId: A, actor: "guest:clerk@elmfalls.example" }, { name: "b.csv", size: 1, via: "page" })).code, "bad_request");
    // Nothing arrives by email: an email may only carry a link to the upload page.
    assert.equal(refusal(await store.fileCreate({ storeId: A, actor: "guest:clerk@elmfalls.example" }, { name: "b.csv", size: 1, via: "email" })).code, "bad_request");
    assert.equal(value(await store.fileCreate({ storeId: A, actor: "guest:clerk@elmfalls.example" }, { name: "b.csv", size: 1 })).file.via, "link");
    assert.equal(value(await store.fileCreate({ storeId: A, actor: "run:r-1" }, { name: "c.csv", size: 0 })).file.via, "run");
  });

  it("takes a guest's file of any kind but a program, which it refuses by the name as a disk saves it", async () => {
    const { store } = setup();
    const guest: StoreCaller = { storeId: A, actor: "guest:clerk@elmfalls.example" };
    // A database backup, a PDF and a zip are no kind LOAD reads; the store keeps them as they came.
    for (const name of ["Parcels_scrubbed.bak", "data dictionary.pdf", "town export.zip", "setup.exe.zip", "PERMITS"]) {
      assert.equal(value(await store.fileCreate(guest, { name, size: 4 })).file.name, name);
    }
    for (const name of ["setup.exe", "SETUP.EXE", "install.msi", "run.bat", "tool.ps1", "app.dmg", "report.pdf.exe", "setup.exe.", "setup.exe ", "folder/setup.exe"]) {
      const refused = await store.fileCreate(guest, { name, size: 4 });
      assert.deepEqual([name, refusal(refused).status, refusal(refused).code], [name, 400, "bad_request"]);
      assert.match(refused.ok ? "" : refused.error, /is a program, and a guest's upload takes no programs\. It takes any other kind of file\.$/);
    }
    assert.deepEqual(value(await store.files(ME)).files.filter((f) => /\.(exe|msi|bat|ps1|dmg)[. ]*$/i.test(f.name)), [], "no refused file left a record");
    // The people who run the store upload what they choose, and so does a run.
    assert.equal(value(await store.fileCreate(ME, { name: "setup.exe", size: 4 })).file.name, "setup.exe");
    assert.equal(value(await store.fileCreate({ storeId: A, actor: "run:r-1" }, { name: "tool.sh", size: 4 })).file.name, "tool.sh");
  });

  it("reads a guest's zip once it is in, and refuses one with a program in it, the zip itself being fine", async () => {
    const { store, r2 } = setup();
    const guest: StoreCaller = { storeId: A, actor: "guest:clerk@elmfalls.example" };
    const upload = async (caller: StoreCaller, name: string, bytes: Uint8Array) => {
      const created = value(await store.fileCreate(caller, { name, size: bytes.byteLength }));
      const target = value(await store.filePartTarget(caller, created.file.id, 1));
      const part = await r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, bytes);
      return { key: target.key, done: await store.fileComplete(caller, created.file.id, { parts: [{ n: 1, etag: part.etag }] }) };
    };
    const tools = storedZip([
      { name: "permits.csv", text: "a,b\n" },
      { name: "installer/setup.exe", text: "MZ" },
      { name: "__MACOSX/installer/._setup.exe", text: "" },
    ]);
    const refused = await upload(guest, "town export.zip", tools);
    assert.deepEqual([refusal(refused.done).status, refusal(refused.done).code], [400, "bad_request"]);
    assert.equal(
      refused.done.ok ? "" : refused.done.error,
      "town export.zip has a program in it (installer/setup.exe), and a zip a guest uploads can't have a program in it. The zip itself is fine: take the program out and upload the zip again.",
    );
    assert.equal(r2.objects.has(refused.key), false, "its bytes are gone");
    assert.deepEqual(value(await store.files(ME)).files, [], "and so is its row");
    // A zip with no program in it stays, and so does a zip with one that the store's people upload.
    assert.equal(value((await upload(guest, "data.zip", storedZip([{ name: "permits.csv", text: "a,b\n" }, { name: "notes/readme.txt", text: "hi" }]))).done).file.state, "ready");
    assert.equal(value((await upload(ME, "tools.zip", tools)).done).file.state, "ready");
    // A file named like a zip that is none stays as it came.
    assert.equal(value((await upload(guest, "broken.zip", new TextEncoder().encode("not a zip at all"))).done).file.state, "ready");
    // Several programs are named, the fourth on as a count.
    const many = await upload(guest, "apps.zip", storedZip(["a.exe", "b.msi", "c.bat", "d.ps1", "e.sh"].map((name) => ({ name, text: "x" }))));
    assert.match(many.done.ok ? "" : many.done.error, /^apps\.zip has programs in it \(a\.exe, b\.msi, c\.bat and 2 more\), .* take the programs out and upload the zip again\.$/);
  });
});

describe("jobs", () => {
  const counter: JobHandler<{ to: number }, { at: number }, { counted: number }> = {
    kind: "count",
    parse(params) {
      const to = (params as { to?: unknown })?.to;
      if (typeof to !== "number" || to < 1) throw new JobParamsError("Count to a number above 0.");
      return { to };
    },
    async run(ctx) {
      const at = (ctx.state?.at ?? 0) + 1;
      ctx.commit({ state: { at }, progress: { done: at, total: ctx.params.to } }, () => {
        ctx.sql.exec("CREATE TABLE IF NOT EXISTS counted (n INTEGER)");
        ctx.sql.exec("INSERT INTO counted VALUES (?)", at);
      });
      return at >= ctx.params.to ? { result: { counted: at } } : { more: true };
    },
  };

  it("makes a job once per request key and runs it in chunks between alarms", async () => {
    const { store, storage } = setup([counter as JobHandler]);
    const job = value(await store.jobSubmit(ME, { kind: "count", params: { to: 3 }, requestKey: "run-1:c2" })).job;
    assert.equal(job.state, "queued");
    assert.deepEqual(value(await store.jobSubmit(ME, { kind: "count", params: { to: 99 }, requestKey: "run-1:c2" })).job.id, job.id, "a replay answers the same job");
    assert.ok(storage.alarm !== null);
    // As on the platform, a firing consumes the alarm; the store sets the next one itself.
    let firings = 0;
    for (; firings < 10 && storage.alarm !== null; firings++) {
      storage.alarm = null;
      await store.alarm();
    }
    assert.equal(firings, 3, "one chunk per alarm, and no alarm once the last job is done");
    assert.equal(storage.sql.exec("SELECT chunks FROM _jobs WHERE id = ?", job.id).one().chunks, 3);
    const done = value(await store.job(ME, job.id)).job;
    assert.equal(done.state, "done");
    assert.deepEqual(done.result, { counted: 3 });
    assert.deepEqual(done.progress, { done: 3, total: 3 });
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM counted").one().n, 3);
    assert.equal(refusal(await store.jobSubmit(ME, { kind: "count", params: { to: 0 }, requestKey: "k2" })).code, "bad_request");
    assert.equal(refusal(await store.jobSubmit(ME, { kind: "nope", params: {}, requestKey: "k3" })).code, "job_kind_unknown");
  });

  it("drops the table in progress of a job that failed, which exec could not", async () => {
    const loader: JobHandler = {
      kind: "load",
      parse: (p) => p,
      async run(ctx) {
        const fresh = ctx.tables.begin("permits");
        ctx.sql.exec(`CREATE TABLE IF NOT EXISTS ${fresh} (a TEXT)`);
        throw new Error("the file is not a CSV");
      },
    };
    const { store, clock, storage } = setup([loader]);
    value(await store.jobSubmit(ME, { kind: "load", params: {}, requestKey: "k" }));
    for (let i = 0; i < 4; i++) {
      storage.alarm = null;
      await store.alarm();
      clock.advance(10_000);
    }
    assert.equal(storage.sql.exec("SELECT state FROM _jobs").one().state, "failed");
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'permits__new'").one().n, 0);
  });

  it("goes on with an open job after the object starts again, and after a restore under way ends", async () => {
    const { store, storage, make } = setup([counter as JobHandler]);
    value(await store.jobSubmit(ME, { kind: "count", params: { to: 2 }, requestKey: "r-9:c1" }));
    // A start between chunks: the alarm is gone, the new object sets it again.
    storage.alarm = null;
    const again = make();
    value(await again.catalog(ME));
    assert.notEqual(storage.alarm, null);
    // While a restore is under way the job waits, and looks again a second later.
    store.core.sql.exec("INSERT INTO _meta (key, value) VALUES ('restoring', 'tok') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    storage.alarm = null;
    await again.alarm();
    assert.equal(storage.sql.exec("SELECT chunks FROM _jobs").one().chunks, 0);
    assert.notEqual(storage.alarm, null, "it looks again");
    store.core.sql.exec("DELETE FROM _meta WHERE key = 'restoring'");
    for (let i = 0; i < 5 && storage.alarm !== null; i++) {
      storage.alarm = null;
      await again.alarm();
    }
    assert.equal(storage.sql.exec("SELECT state FROM _jobs").one().state, "done");
  });

  it("fails a job whose chunk keeps throwing, and says why", async () => {
    const broken: JobHandler = {
      kind: "broken",
      parse: (p) => p,
      async run() {
        throw new Error("the file is not a CSV");
      },
    };
    const { store, clock } = setup([broken]);
    const job = value(await store.jobSubmit(ME, { kind: "broken", params: {}, requestKey: "k" })).job;
    for (let i = 0; i < 4; i++) {
      await store.alarm();
      clock.advance(10_000);
    }
    const failed = value(await store.job(ME, job.id)).job;
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "the file is not a CSV");
  });
});

describe("restore", () => {
  itRestores("returns the database to a restore point, keeps the history after it, and keeps files as they are", async () => {
    const { store, storage, state, r2, clock, make } = setup();
    value(await store.migrate(ME, { id: "0000_a", sql: "CREATE TABLE a (v TEXT)" }));
    clock.advance(1_000);
    const point = value(await store.migrate(ME, { id: "0001_b", sql: "CREATE TABLE b (v TEXT)" })).migration.restorePoint;
    assert.ok(point, "a migration takes a restore point first");
    clock.advance(1_000);
    value(await store.exec(ME, { sql: "INSERT INTO b VALUES ('after')" }));
    const file = value(await store.fileCreate(ME, { name: "late.csv", size: 4 }));
    const t = value(await store.filePartTarget(ME, file.file.id, 1));
    const p = await r2.resumeMultipartUpload(t.key, t.uploadId).uploadPart(1, "late");
    value(await store.fileComplete(ME, file.file.id, { parts: [{ n: 1, etag: p.etag }] }));

    const restored = value(await store.restore({ storeId: A, actor: "user:admin" }, { at: point! }));
    assert.equal(restored.restoredTo, point);
    store.restart();
    assert.equal(state.aborted, "restore");
    storage.restart();
    const after = make();
    assert.deepEqual(value(await after.query(ME, { sql: "SELECT count(*) FROM sqlite_master WHERE name = 'b'" })).rows, [[0]], "back to before 0001_b");
    const events = value(await after.history(ME)).events;
    assert.equal(events[0]!.kind, "restore");
    assert.ok(events.some((e) => e.note === "Received late.csv"), "the history after the moment stays");
    assert.deepEqual(value(await after.files(ME)).files.map((f) => f.name), ["late.csv"], "files stay as they are");
  });

  itRestores("takes no writes while a restore is under way; a file deleted after the moment comes back, and one deleted before it stays deleted", async () => {
    const { store, storage, r2, clock, make } = setup();
    value(await store.migrate(ME, { id: "0000_a", sql: "CREATE TABLE a (v TEXT)" }));
    const send = async (name: string) => {
      const file = value(await store.fileCreate(ME, { name, size: 3 }));
      const t = value(await store.filePartTarget(ME, file.file.id, 1));
      const p = await r2.resumeMultipartUpload(t.key, t.uploadId).uploadPart(1, "old");
      value(await store.fileComplete(ME, file.file.id, { parts: [{ n: 1, etag: p.etag }] }));
      return { id: file.file.id, key: t.key };
    };
    const before = await send("deleted-before.csv");
    const file = await send("old.csv");
    const t = { key: file.key };
    value(await store.fileDelete(ME, before.id));
    clock.advance(1_000);
    const point = value(await store.migrate(ME, { id: "0001_b", sql: "CREATE TABLE b (v TEXT)" })).migration.restorePoint!;
    clock.advance(1_000);
    value(await store.fileDelete(ME, file.id));
    const restored = value(await store.restore({ storeId: A, actor: "user:admin" }, { at: point, keep: ["_users", "_sessions"] }));
    assert.deepEqual(restored.kept, ["_users", "_sessions"]);
    // The restart has not happened yet: nothing written now would survive it.
    const refused = refusal(await store.exec(ME, { sql: "INSERT INTO a VALUES ('lost?')" }));
    assert.equal(refused.code, "store_restoring");
    assert.equal(refused.status, 409);
    assert.deepEqual(value(await store.query(ME, { sql: "SELECT count(*) FROM a" })).rows, [[0]], "reads go on");
    storage.restart();
    const after = make();
    value(await after.exec(ME, { sql: "INSERT INTO a VALUES ('kept')" }));
    // The moment had old.csv: its rows may name it, and its bytes were kept, so it is back.
    assert.deepEqual(value(await after.files(ME)).files.map((f) => f.name), ["old.csv"], "a file deleted after the moment comes back; one deleted before stays deleted");
    assert.equal(r2.objects.has(t.key), true, "its bytes are kept for their 30 days");
    assert.equal(r2.objects.has(before.key), true, "the bytes of the file deleted before are kept for their 30 days too");
    assert.match(value(await after.history(ME)).events.find((e) => e.kind === "restore")!.note, /1 file deleted since came back/);
  });

  itRestores("leaves deleted a file that arrived after the moment, and undoing a restore finds a file deleted again", async () => {
    const { store, storage, r2, clock, make } = setup();
    value(await store.migrate(ME, { id: "0000_a", sql: "CREATE TABLE a (v TEXT)" }));
    const send = async (on: StoreHandler, name: string) => {
      const file = value(await on.fileCreate(ME, { name, size: 3 }));
      const t = value(await on.filePartTarget(ME, file.file.id, 1));
      const p = await r2.resumeMultipartUpload(t.key, t.uploadId).uploadPart(1, "old");
      value(await on.fileComplete(ME, file.file.id, { parts: [{ n: 1, etag: p.etag }] }));
      return file.file.id;
    };
    const was = await send(store, "was-there.csv");
    clock.advance(1_000);
    const point = value(await store.migrate(ME, { id: "0001_b", sql: "CREATE TABLE b (v TEXT)" })).migration.restorePoint!;
    clock.advance(1_000);
    const later = await send(store, "uploaded-then-deleted.csv");
    value(await store.fileDelete(ME, later));
    value(await store.fileDelete(ME, was));
    value(await store.restore({ storeId: A, actor: "user:admin" }, { at: point }));
    storage.restart();
    const after = make();
    assert.deepEqual(value(await after.files(ME)).files.map((f) => f.name), ["was-there.csv"], "only what the moment had comes back");
    assert.match(value(await after.history(ME)).events.find((e) => e.kind === "restore")!.note, /1 file deleted since came back/);
    // Undone: the store returns to a moment when was-there.csv was deleted, and it is deleted again.
    const undoPoint = value(await after.history(ME)).events.find((e) => e.kind === "restore")!.restorePoint!;
    clock.advance(1_000);
    value(await after.restore({ storeId: A, actor: "user:admin" }, { at: undoPoint }));
    storage.restart();
    const undone = make();
    assert.deepEqual(value(await undone.files(ME)).files.map((f) => f.name), [], "both are deleted again");
  });

  itRestores("keeps the note of when exports are next due across a restore", async () => {
    const { store, storage, make } = setup();
    const point = value(await store.migrate(ME, { id: "0000_a", sql: "CREATE TABLE a (v TEXT)" })).migration.restorePoint!;
    storage.sql.exec("INSERT INTO _meta (key, value) VALUES ('exports_sweep_at', '2026-12-01T00:00:00.000Z')");
    value(await store.restore({ storeId: A, actor: "user:admin" }, { at: point }));
    storage.restart();
    const after = make();
    await after.stats(ME);
    assert.equal(storage.sql.exec("SELECT value FROM _meta WHERE key = 'exports_sweep_at'").one().value, "2026-12-01T00:00:00.000Z");
  });

  it("takes keep only as the people tables a restore always keeps", async () => {
    const { store } = setup();
    const point = value(await store.migrate(ME, { id: "0000_a", sql: "CREATE TABLE a (v TEXT)" })).migration.restorePoint!;
    assert.equal(refusal(await store.restore(ME, { at: point, keep: ["a"] })).code, "bad_request");
    assert.equal(refusal(await store.restore(ME, { at: point, keep: "_users" })).code, "bad_request");
  });

  itRestores("applies nothing when the object starts again before its restore was set", async () => {
    const { store, storage, r2, make } = setup();
    value(await store.migrate(ME, { id: "0000_a", sql: "CREATE TABLE a (v TEXT)" }));
    const point = value(await store.migrate(ME, { id: "0001_b", sql: "CREATE TABLE b (v TEXT)" })).migration.restorePoint!;
    // The platform fails to set the restore: the mark and the carry go, the store takes writes.
    storage.onNextSessionRestoreBookmark = async () => {
      throw new Error("storage operation failed");
    };
    assert.equal(refusal(await store.restore(ME, { at: point })).code, "internal");
    value(await store.exec(ME, { sql: "INSERT INTO b VALUES ('fine')" }));
    assert.equal([...r2.objects.keys()].some((k) => k.endsWith("/restore.json")), false);
    // A start with a mark still there: the restore never happened, and no event says it did.
    store.core.sql.exec("INSERT INTO _meta (key, value) VALUES ('restoring', ?)", point);
    await r2.put(`stores/${A}/restore.json`, JSON.stringify({ storeId: A, bookmark: point, history: [{ id: "his_x", at: new Date().toISOString(), kind: "restore", by_sub: "user:admin", note: "Restored", restore_point: null, ref: point }] }));
    const again = make();
    const events = value(await again.history(ME)).events;
    assert.equal(events.some((e) => e.id === "his_x"), false);
    value(await again.exec(ME, { sql: "INSERT INTO b VALUES ('still fine')" }));
  });

  it("answers a storage error as one, not as a platform without earlier moments", async () => {
    const { store, storage } = setup();
    value(await store.migrate(ME, { id: "0000_a", sql: "CREATE TABLE a (v TEXT)" }));
    storage.getCurrentBookmark = async () => {
      throw new Error("Durable Object storage operation exceeded timeout");
    };
    assert.equal(refusal(await store.restore(ME, { at: new Date().toISOString() })).code, "internal");
  });

  it("keeps a restore's mark when the next start cannot read its carry, so a later start decides", async () => {
    const { store, storage, r2, make } = setup();
    value(await store.migrate(ME, { id: "0000_a", sql: "CREATE TABLE a (v TEXT)" }));
    store.core.sql.exec("INSERT INTO _meta (key, value) VALUES ('restoring', 'tok-1')");
    await r2.put(`stores/${A}/restore.json`, JSON.stringify({ storeId: A, token: "tok-1", bookmark: "bm-x", history: [{ id: "his_false", at: new Date().toISOString(), kind: "restore", by_sub: "user:admin", note: "Restored", restore_point: null, ref: "bm-x" }] }));
    const realGet = r2.get.bind(r2);
    r2.get = async () => {
      throw new Error("R2 is unreachable");
    };
    // This start fails: the call says so, and the mark stays.
    assert.equal(refusal(await make().catalog(ME)).code, "internal");
    assert.equal(storage.sql.exec("SELECT value FROM _meta WHERE key = 'restoring'").one().value, "tok-1");
    r2.get = realGet;
    const later = make();
    assert.equal(value(await later.history(ME)).events.some((e) => e.id === "his_false"), false, "no restore that never happened");
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM _meta WHERE key = 'restoring'").one().n, 0);
  });

  it("says plainly when the platform keeps no earlier moments", async () => {
    const { store, storage, clock } = setup();
    storage.pointInTime = false;
    value(await store.catalog(ME));
    clock.advance(60_000);
    assert.equal(refusal(await store.restore(ME, { at: new Date(clock.t - 30_000).toISOString() })).code, "restore_unavailable");
  });

  itRestores("says so too where bookmarks are counted but cannot be restored to, and takes writes after", async () => {
    const { store, storage } = setup();
    value(await store.migrate(ME, { id: "0000_a", sql: "CREATE TABLE a (v TEXT)" }));
    const point = value(await store.migrate(ME, { id: "0001_b", sql: "CREATE TABLE b (v TEXT)" })).migration.restorePoint!;
    storage.onNextSessionRestoreBookmark = async () => {
      throw new Error("This Durable Object's storage back-end does not implement point-in-time recovery.");
    };
    assert.equal(refusal(await store.restore(ME, { at: point })).code, "restore_unavailable");
    value(await store.exec(ME, { sql: "INSERT INTO b VALUES ('fine')" }));
  });
});

describe("stats and destroy", () => {
  it("counts tables, rows and files, and says when a job is still open", async () => {
    const { store } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE a (v); INSERT INTO a VALUES (1), (2);" }));
    const stats = value(await store.stats(ME));
    assert.equal(stats.tables, 1);
    assert.deepEqual(stats.tableNames, ["a"]);
    assert.equal(stats.rows, 2);
    assert.equal(stats.files, 0);
    assert.equal(stats.busy, false);
    assert.ok(stats.bytes > 0);
  });

  it("names its tables by name, in any case, and only the first ones", async () => {
    const { store } = setup();
    const names = Array.from({ length: STATS_TABLE_NAMES + 3 }, (_, i) => `t${String(i).padStart(3, "0")}`);
    value(await store.exec(ME, { sql: ["CREATE TABLE Zeta (v)", "CREATE TABLE alpha (v)", ...names.map((n) => `CREATE TABLE ${n} (v)`)].join("; ") }));
    const stats = value(await store.stats(ME));
    assert.equal(stats.tables, names.length + 2);
    assert.equal(stats.tableNames?.length, STATS_TABLE_NAMES);
    assert.deepEqual(stats.tableNames?.slice(0, 2), ["alpha", "t000"]);
    assert.ok(!stats.tableNames?.includes("Zeta"), "a name past the first ones is left out");
  });

  it("drops its files and storage, keeps a mark, and refuses every later call", async () => {
    const { store, r2, storage } = setup();
    const f = value(await store.fileCreate(ME, { name: "a.csv", size: 1 }));
    await r2.put(`stores/${A}/files/fil_x/b.csv`, "b");
    await r2.put(`stores/${B}/files/fil_y/c.csv`, "c");
    value(await store.exec(ME, { sql: "CREATE TABLE a (v)" }));
    value(await store.destroy(ME));
    assert.deepEqual([...r2.objects.keys()], [`stores/${B}/files/fil_y/c.csv`], "only this store's files go");
    assert.equal(r2.uploads.size, 0, "the upload in progress was stopped");
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'a'").one().n, 0);
    assert.equal(refusal(await store.catalog(ME)).code, "store_destroyed");
    assert.equal(refusal(await store.fileCreate(ME, { name: "x", size: 1 })).status, 410);
    void f;
  });
});
