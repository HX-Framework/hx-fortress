// A table's structure (structure.ts): its columns with their types, defaults and keys, its indexes
// with what made each, its foreign keys with what they do, the SQL that makes it again, what made
// it, and for a managed table the migrations whose SQL names it. A view, a program's table and the
// store's own tables answer too; a parked table, an old version and a name the store lacks do not.

import { describe, it, host, stateOf, filesOf } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import type { StoreDeps } from "./core.js";
import { StoreHandler } from "./handler.js";
import { indexParts, STRUCTURE_SQL_MAX } from "./structure.js";
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

function refusal<T>(result: StoreResult<T>): { status: number; code: string } {
  assert.equal(result.ok, false, "expected a refusal");
  return result as { status: number; code: string };
}

const OWNERS_AND_LOTS = [
  "CREATE TABLE owners (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT DEFAULT 'someone');",
  "--> statement-breakpoint",
  "CREATE TABLE lots (id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE, area REAL DEFAULT 0, made_at TEXT DEFAULT CURRENT_TIMESTAMP);",
  "--> statement-breakpoint",
  "CREATE INDEX lots_owner ON lots (owner_id);",
  "--> statement-breakpoint",
  "CREATE INDEX lots_made ON lots (lower(made_at), area DESC) WHERE area > 0;",
].join("\n");

describe("a table's structure", () => {
  it("reads a managed table's columns, defaults, key, indexes, foreign keys, SQL and the migrations that name it", async () => {
    const { store } = setup();
    value(await store.migrate(ME, { id: "0001_owners_lots", sql: OWNERS_AND_LOTS }));
    value(await store.migrate(ME, { id: "0002_lot_note", sql: "ALTER TABLE lots ADD COLUMN note TEXT;" }));
    value(await store.migrate(ME, { id: "0003_other", sql: "CREATE TABLE other (x TEXT);" }));

    const lots = value(await store.structure(ME, { database: "store", table: "lots" }));
    assert.equal(lots.database, "store");
    assert.equal(lots.table, "lots");
    assert.equal(lots.view, undefined);
    assert.equal(lots.kind, "managed");
    assert.equal(lots.version, 1);
    assert.equal(lots.madeBy, null);
    assert.deepEqual(lots.key, ["id"]);
    assert.deepEqual(lots.columns, [
      { name: "id", type: "INTEGER", nullable: false, default: null, key: 1 },
      { name: "owner_id", type: "TEXT", nullable: false, default: null },
      { name: "area", type: "REAL", nullable: true, default: "0" },
      { name: "made_at", type: "TEXT", nullable: true, default: "CURRENT_TIMESTAMP" },
      { name: "note", type: "TEXT", nullable: true, default: null },
    ]);
    assert.deepEqual(
      lots.indexes.map((i) => [i.name, i.columns, i.unique, i.origin, i.where ?? null, !!i.sql]),
      [
        ["lots_made", ["lower(made_at)", "area"], false, "index", "area > 0", true],
        ["lots_owner", ["owner_id"], false, "index", null, true],
      ],
    );
    assert.deepEqual(lots.foreignKeys, [{ columns: ["owner_id"], table: "owners", to: ["id"], onUpdate: "no action", onDelete: "cascade" }]);
    assert.match(lots.sql, /^CREATE TABLE lots \(id INTEGER PRIMARY KEY/);
    assert.match(lots.sql, /\n\nCREATE INDEX lots_made ON lots \(lower\(made_at\), area DESC\) WHERE area > 0;\n\nCREATE INDEX lots_owner ON lots \(owner_id\);$/);
    assert.equal(lots.sqlCut, undefined);
    // 0003 names another table only.
    assert.deepEqual(
      lots.migrations?.map((m) => [m.id, m.appliedBy, m.sql.includes("lots")]),
      [
        ["0001_owners_lots", "user:u-1", true],
        ["0002_lot_note", "user:u-1", true],
      ],
    );
    assert.ok(lots.migrations?.every((m) => typeof m.appliedAt === "string" && !m.cut));

    const owners = value(await store.structure(ME, { database: "store", table: "owners" }));
    // SQLite makes an index for a key that is not a rowid, and one for a UNIQUE: no SQL of their own.
    assert.deepEqual(
      owners.indexes.map((i) => [i.columns, i.unique, i.origin, i.sql ?? null]),
      [
        [["id"], true, "key", null],
        [["email"], true, "unique", null],
      ],
    );
    assert.deepEqual(
      owners.columns.map((c) => [c.name, c.key ?? null, c.unique ?? false, c.nullable, c.default]),
      [
        ["id", 1, false, false, null],
        ["email", null, true, false, null],
        ["name", null, false, true, "'someone'"],
      ],
    );
    assert.deepEqual(owners.migrations?.map((m) => m.id), ["0001_owners_lots"]);
  });

  it("reads a view, a program's table with what made it, and the store's own tables", async () => {
    const { store, storage } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE owners (id TEXT PRIMARY KEY, name TEXT); CREATE VIEW owner_names AS SELECT name FROM owners" }));
    const view = value(await store.structure(ME, { database: "store", table: "owner_names" }));
    assert.equal(view.view, true);
    assert.deepEqual(view.columns.map((c) => c.name), ["name"]);
    assert.deepEqual(view.indexes, []);
    assert.deepEqual(view.foreignKeys, []);
    assert.match(view.sql, /^CREATE VIEW owner_names AS SELECT name FROM owners;$/);
    // A table exec made, not a migration: a managed table that no migration names.
    assert.deepEqual(value(await store.structure(ME, { database: "store", table: "owners" })).migrations, []);

    storage.sql.exec("CREATE TABLE permits (_key TEXT, permit TEXT, fee REAL)");
    storage.sql.exec(
      "INSERT INTO _tables (name, kind, version, made_run, made_step, made_job, made_at, created_at, updated_at) VALUES ('permits', 'program', 3, 'run_1', 'LOAD', 'job_1', '2026-11-18T10:00:00.000Z', 'now', 'now')",
    );
    const permits = value(await store.structure(ME, { database: "store", table: "permits" }));
    assert.equal(permits.kind, "program");
    assert.equal(permits.version, 3);
    assert.deepEqual(permits.madeBy, { runId: "run_1", step: "LOAD", job: "job_1", at: "2026-11-18T10:00:00.000Z" });
    assert.equal(permits.migrations, undefined, "a program's job made it: no migration says how");

    const files = value(await store.structure(ME, { database: "store", table: "_files" }));
    assert.equal(files.kind, "system");
    assert.ok(files.columns.some((c) => c.name === "id"));
  });

  it("refuses a parked table, a program's old version, a name it lacks and another database", async () => {
    const { store, storage } = setup();
    value(await store.catalog(ME));
    storage.sql.exec("INSERT INTO _tables (name, kind, version, created_at, updated_at, parked) VALUES ('permits', 'program', 2, 'now', 'now', 'pk_1')");
    assert.deepEqual(
      [refusal(await store.structure(ME, { database: "store", table: "permits" })).status, refusal(await store.structure(ME, { database: "store", table: "permits" })).code],
      [409, "table_parked"],
    );
    storage.sql.exec("CREATE TABLE permits__v1 (x TEXT)");
    assert.equal(refusal(await store.structure(ME, { database: "store", table: "permits__v1" })).status, 404);
    assert.equal(refusal(await store.structure(ME, { database: "store", table: "nothing" })).status, 404);
    value(await store.exec(ME, { sql: "CREATE TABLE notes (body TEXT)" }));
    assert.equal(refusal(await store.structure(ME, { database: "other", table: "notes" })).status, 404);
  });

  it("reads a table as wide as a store takes, with a long name and a long default", async () => {
    const { store } = setup();
    const name = `parcel_assessments_${"long_".repeat(12)}names`;
    const wide = Array.from({ length: 99 }, (_, i) => `c${i} TEXT`).join(", ");
    const words = "a default longer than any pattern a statement may hold ".repeat(3).trim();
    value(await store.exec(ME, { sql: `CREATE TABLE ${name} (id TEXT PRIMARY KEY DEFAULT '${words}', ${wide})` }));
    const read = value(await store.structure(ME, { database: "store", table: name }));
    assert.equal(read.columns.length, 100);
    assert.equal(read.columns[0]!.default, `'${words}'`);
    assert.equal(read.table, name);
  });

  it("cuts the SQL past the most it carries, and says so", async () => {
    const { store } = setup();
    const allowed = Array.from({ length: 2_500 }, (_, i) => `'value-${i}'`).join(", ");
    value(await store.migrate(ME, { id: "0001_kinds", sql: `CREATE TABLE kinds (kind TEXT CHECK (kind IN (${allowed})));` }));
    const read = value(await store.structure(ME, { database: "store", table: "kinds" }));
    assert.equal(read.sql.length, STRUCTURE_SQL_MAX);
    assert.equal(read.sqlCut, true);
    assert.equal(read.migrations?.[0]?.sql.length, STRUCTURE_SQL_MAX);
    assert.equal(read.migrations?.[0]?.cut, true);
  });
});

describe("an index's terms and its condition", () => {
  it("reads the terms between the outer parentheses, and the WHERE after them", () => {
    assert.deepEqual(indexParts("CREATE INDEX i ON t (a, lower(b), c COLLATE NOCASE DESC)"), { terms: ["a", "lower(b)", "c COLLATE NOCASE DESC"], where: null });
    assert.deepEqual(indexParts("CREATE UNIQUE INDEX \"on (x)\" ON \"t, u\" (\"a)b\", 'x,y') WHERE done = 0 AND kind = 'a)'"), {
      terms: ['"a)b"', "'x,y'"],
      where: "done = 0 AND kind = 'a)'",
    });
    assert.deepEqual(indexParts("CREATE INDEX i ON t (a) -- a note (here)\n"), { terms: ["a"], where: null });
    assert.deepEqual(indexParts(null), { terms: [], where: null });
  });
});
