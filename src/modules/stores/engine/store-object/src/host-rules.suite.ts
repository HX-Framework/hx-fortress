// What a store asks of the host it runs on, tested on the host itself. The other suite files test
// a store on a host; this one tests the host under them: its SQL as a store calls it, the two
// rules every host holds, and each trait a host says it has (testing/suite/host.ts).
//
// Rule 1. A statement reaches only its own store's file. A person or an agent writes a store's
// SQL, so a statement may try to open another file: ATTACH, VACUUM INTO, an extension, or a
// PRAGMA that changes how the database works. A host refuses each one, however it is written.
//
// Rule 2. A statement that never ends is stopped, and the host still answers meanwhile. SQLite
// runs a statement to its end on the thread that asked, so a host runs each store apart from its
// own loop, and ends what runs there when a statement overstays.
//
// How a store on Cloudflare passes both rules. No test here runs on Cloudflare itself: the
// platform holds both for every Durable Object, and a store is one.
//
//   Rule 1. workerd gives SQLite an authorizer (`isAuthorized` in its src/workerd/util/sqlite.c++,
//   read on 2026-11-15). For ATTACH and DETACH it answers no: "We do not support attached
//   databases. It seems unlikely that we ever will." It also sets SQLite's limit of attached
//   databases to 0, and VACUUM INTO works by attaching its target. It runs a PRAGMA only from a
//   list (`ALLOWED_PRAGMAS`, and `table_list`, `table_info` and `table_xinfo`). It turns extension
//   loading on nowhere, and SQLite leaves `load_extension()` off until a program turns it on.
//
//   Rule 2. Each store is a Durable Object of its own, and the platform ends a request of an
//   object that uses more CPU time than its limit: 30 seconds unless the deployment sets another,
//   up to 5 minutes (Cloudflare's Limits page for Durable Objects). Another object, and the
//   Worker in front of them, answer meanwhile.
//
// The stand-ins of this repository's own test run hold rule 1 the way workerd does, with SQLite's
// authorizer, and rule 2 with a process for each store (testing/fakes.ts, testing/apart-process.ts).

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, filesOf, host, it, itWhere, stateOf, type HostStorage } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import type { StoreDeps } from "./core.js";
import { StoreHandler } from "./handler.js";
import type { StoreCaller, StoreResult } from "./types.js";

const STORE = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ME: StoreCaller = { storeId: STORE, actor: "user:u-1" };

/** A row's values, with bytes as numbers: a host hands bytes back as a buffer or as a view of one. */
function plain(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([name, v]) => [name, v instanceof ArrayBuffer ? [...new Uint8Array(v)] : ArrayBuffer.isView(v) ? [...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)] : v]),
  );
}

// ── A host's SQL, as a store calls it ────────────────────────────────────────

describe("a host's SQL, as a store calls it", () => {
  const seeded = (): HostStorage => {
    const storage = host().storage();
    storage.sql.exec("CREATE TABLE permits (permit_no TEXT PRIMARY KEY, fee INTEGER, plan BLOB)");
    storage.sql.exec("INSERT INTO permits VALUES ('BP-1', 120, NULL), ('BP-2', 80, NULL), ('BP-3', NULL, NULL)");
    return storage;
  };

  it("answers a statement's rows as objects by column, as arrays in the columns' order, and one by one", () => {
    const { sql } = seeded();
    const select = "SELECT permit_no, fee FROM permits ORDER BY permit_no";
    assert.deepEqual(sql.exec(select).toArray().map(plain), [
      { permit_no: "BP-1", fee: 120 },
      { permit_no: "BP-2", fee: 80 },
      { permit_no: "BP-3", fee: null },
    ]);
    const cursor = sql.exec(select);
    assert.deepEqual([...cursor.columnNames], ["permit_no", "fee"]);
    assert.deepEqual([...cursor.raw()], [["BP-1", 120], ["BP-2", 80], ["BP-3", null]]);
    assert.deepEqual([...sql.exec(select)].map((row) => row.permit_no), ["BP-1", "BP-2", "BP-3"]);
    // A cursor is read once: what `next` took, `toArray` does not hand back.
    const stepped = sql.exec(select);
    const first = stepped.next();
    assert.equal(first.done ? null : first.value.permit_no, "BP-1");
    assert.deepEqual(stepped.toArray().map((row) => row.permit_no), ["BP-2", "BP-3"]);
    assert.equal(stepped.next().done, true);
  });

  it("answers the one row of a statement that has one, and throws for none and for several", () => {
    const { sql } = seeded();
    assert.equal(sql.exec<{ n: number }>("SELECT count(*) AS n FROM permits").one().n, 3);
    assert.throws(() => sql.exec("SELECT * FROM permits WHERE permit_no = 'none'").one());
    assert.throws(() => sql.exec("SELECT * FROM permits").one());
  });

  it("binds text, numbers, NULL and bytes in order, and hands bytes back as bytes", () => {
    const { sql } = seeded();
    // A store binds bytes as an ArrayBuffer (app.ts `bindable`).
    sql.exec("INSERT INTO permits VALUES (?, ?, ?)", "BP-4", 12.5, new Uint8Array([1, 2, 3]).buffer);
    sql.exec("INSERT INTO permits VALUES (?, ?, ?)", "BP-5", null, null);
    assert.deepEqual(sql.exec("SELECT permit_no, fee, plan FROM permits WHERE permit_no >= ? ORDER BY 1", "BP-4").toArray().map(plain), [
      { permit_no: "BP-4", fee: 12.5, plan: [1, 2, 3] },
      { permit_no: "BP-5", fee: null, plan: null },
    ]);
  });

  it("says how many rows a statement wrote, and none for one that only read", () => {
    const { sql } = seeded();
    assert.equal(sql.exec("SELECT * FROM permits").rowsWritten, 0);
    assert.equal(sql.exec("UPDATE permits SET fee = 1 WHERE permit_no = 'none'").rowsWritten, 0);
    // Three rows at the least: a host that bills as Cloudflare does counts their index entries too.
    assert.ok(sql.exec("UPDATE permits SET fee = coalesce(fee, 0) + 1").rowsWritten >= 3);
    const one = sql.exec("INSERT INTO permits VALUES ('BP-9', 5, NULL) RETURNING permit_no");
    assert.deepEqual(one.toArray().map(plain), [{ permit_no: "BP-9" }]);
    assert.ok(one.rowsWritten >= 1);
  });

  it("refuses a transaction from SQL: a store asks its host for one", () => {
    const { sql } = seeded();
    for (const statement of ["BEGIN", "BEGIN IMMEDIATE", "begin transaction", "SAVEPOINT a", "RELEASE a", "COMMIT", "ROLLBACK", "  \n ROLLBACK TO a"]) {
      assert.throws(() => sql.exec(statement), statement);
    }
    assert.equal(sql.exec<{ n: number }>("SELECT count(*) AS n FROM permits").one().n, 3);
  });

  it("keeps a transaction's writes when it returns, drops them when it throws, and nests", () => {
    const storage = seeded();
    const count = () => storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM permits").one().n;
    assert.equal(
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO permits VALUES ('BP-4', 1, NULL)");
        return "kept";
      }),
      "kept",
    );
    assert.equal(count(), 4);
    assert.throws(
      () =>
        storage.transactionSync(() => {
          storage.sql.exec("INSERT INTO permits VALUES ('BP-5', 1, NULL)");
          throw new Error("no");
        }),
      /^Error: no$/,
    );
    assert.equal(count(), 4, "what it wrote before it threw is gone");
    // The inner one's writes go with its failure, and the outer one goes on with its own.
    storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO permits VALUES ('BP-6', 1, NULL)");
      assert.throws(() =>
        storage.transactionSync(() => {
          storage.sql.exec("INSERT INTO permits VALUES ('BP-7', 1, NULL)");
          throw new Error("inner");
        }),
      );
      storage.sql.exec("INSERT INTO permits VALUES ('BP-8', 1, NULL)");
    });
    assert.deepEqual(storage.sql.exec("SELECT permit_no FROM permits WHERE permit_no > 'BP-4' ORDER BY 1").toArray().map((row) => row.permit_no), ["BP-6", "BP-8"]);
  });

  it("runs the PRAGMAs a store itself runs", () => {
    const storage = seeded();
    const { sql } = storage;
    sql.exec("CREATE TABLE plans (id INTEGER PRIMARY KEY, permit_no TEXT REFERENCES permits(permit_no))");
    sql.exec("CREATE INDEX plans_permit ON plans (permit_no)");
    const names = (statement: string, ...bindings: unknown[]) => sql.exec(statement, ...bindings).toArray().map((row) => String(row.name ?? row.table ?? ""));
    assert.deepEqual(names("PRAGMA table_info(`permits`)"), ["permit_no", "fee", "plan"]);
    assert.deepEqual(names("PRAGMA table_xinfo(`permits`)"), ["permit_no", "fee", "plan"]);
    assert.deepEqual(names("SELECT name FROM pragma_table_info(?) ORDER BY cid", "permits"), ["permit_no", "fee", "plan"]);
    assert.ok(names("PRAGMA index_list(`plans`)").includes("plans_permit"));
    assert.ok(names("SELECT name FROM pragma_index_list(?)", "plans").includes("plans_permit"));
    assert.deepEqual(names("PRAGMA index_info(`plans_permit`)"), ["permit_no"]);
    assert.deepEqual(names("SELECT name FROM pragma_index_info(?)", "plans_permit"), ["permit_no"]);
    assert.ok(names("PRAGMA index_xinfo(`plans_permit`)").includes("permit_no"));
    assert.deepEqual(names("PRAGMA foreign_key_list(`plans`)"), ["permits"]);
    assert.deepEqual(sql.exec("PRAGMA foreign_key_check").toArray(), []);
    assert.ok(names("PRAGMA table_list").includes("permits"));
    // What an import and a migration set, inside their transaction, around rows that point at each other.
    storage.transactionSync(() => void sql.exec("PRAGMA defer_foreign_keys = ON"));
  });

  it("says its database's size, which grows with what it holds", () => {
    const { sql } = seeded();
    const before = sql.databaseSize;
    assert.ok(before > 0);
    sql.exec("CREATE TABLE notes (body TEXT)");
    for (let i = 0; i < 20; i++) sql.exec("INSERT INTO notes VALUES (?)", "x".repeat(10_000));
    assert.ok(sql.databaseSize > before);
  });

  it("keeps one alarm: set, read, moved and removed", async () => {
    const storage = host().storage();
    assert.equal(await storage.getAlarm(), null);
    await storage.setAlarm(1_000);
    assert.equal(await storage.getAlarm(), 1_000);
    assert.equal(storage.alarm, 1_000);
    await storage.setAlarm(500);
    assert.equal(await storage.getAlarm(), 500);
    await storage.deleteAlarm();
    assert.equal(await storage.getAlarm(), null);
    assert.equal(storage.alarm, null);
  });

  it("empties the database when it deletes all", async () => {
    const storage = seeded();
    await storage.deleteAll();
    assert.deepEqual(storage.sql.exec("SELECT name FROM sqlite_master").toArray(), []);
    storage.sql.exec("CREATE TABLE permits (id)");
  });
});

// ── Rule 1 ───────────────────────────────────────────────────────────────────

/** A statement that reaches outside its store's file, as an attacker would write it. */
export interface ReachAttack {
  name: string;
  /** The statement, given another store's file and a file that does not exist yet. */
  statement(otherFile: string, newFile: string): string;
  /**
   * The statement is the second of two in one call. What a host does with a second statement is
   * its own: it may refuse the call, or run the first and leave the second out. It never runs it.
   */
  second?: true;
  /**
   * How a SQLite with no guard shows that the statement did what it set out to do, for the check of
   * these statements themselves (host-rules.test.ts): `attached`, the other file's rows can be
   * read; `file`, the new file exists; `runs`, the statement ran. Left out where a SQLite needs no
   * guard to refuse it.
   */
  works?: "attached" | "file" | "runs";
}

const quoted = (path: string): string => `'${path.replace(/'/g, "''")}'`;

export const REACH_ATTACKS: readonly ReachAttack[] = [
  { name: "ATTACH", works: "attached", statement: (other) => `ATTACH DATABASE ${quoted(other)} AS other` },
  { name: "ATTACH with no DATABASE word", works: "attached", statement: (other) => `ATTACH ${quoted(other)} AS other` },
  { name: "ATTACH in another letter case", works: "attached", statement: (other) => `aTtAcH dAtAbAsE ${quoted(other)} aS other` },
  { name: "ATTACH behind a comment", works: "attached", statement: (other) => `/* tidy up */ ATTACH DATABASE ${quoted(other)} AS other` },
  { name: "ATTACH behind a comment line and blank lines", works: "attached", statement: (other) => `-- tidy up\n\n\t ATTACH DATABASE ${quoted(other)} AS other` },
  { name: "ATTACH with a comment between its words", works: "attached", statement: (other) => `ATTACH/**/DATABASE/* x */${quoted(other)}/**/AS other` },
  { name: "ATTACH with the file's name put together by an expression", works: "attached", statement: (other) => `ATTACH DATABASE (${quoted(other.slice(0, 5))} || ${quoted(other.slice(5))}) AS other` },
  { name: "ATTACH as a second statement", second: true, statement: (other) => `SELECT 1; ATTACH DATABASE ${quoted(other)} AS other` },
  { name: "ATTACH as a second statement, behind a comment", second: true, statement: (other) => `SELECT 1; -- next\n/* and */ attach ${quoted(other)} as other` },
  { name: "DETACH", statement: () => "DETACH DATABASE main" },
  { name: "VACUUM INTO a new file", works: "file", statement: (_other, fresh) => `VACUUM INTO ${quoted(fresh)}` },
  { name: "VACUUM INTO, in another letter case and behind a comment", works: "file", statement: (_other, fresh) => `/* copy */ vacuum main into ${quoted(fresh)}` },
  { name: "an extension", statement: (_other, fresh) => `SELECT load_extension(${quoted(fresh)})` },
  { name: "an extension, with its entry point", statement: (_other, fresh) => `SELECT load_extension(${quoted(fresh)}, 'sqlite3_extension_init')` },
  { name: "PRAGMA writable_schema", works: "runs", statement: () => "PRAGMA writable_schema = 1" },
  { name: "PRAGMA writable_schema, in another letter case and behind a comment", works: "runs", statement: () => "/* x */ pragma WRITABLE_SCHEMA=ON" },
  { name: "PRAGMA journal_mode", works: "runs", statement: () => "PRAGMA main.journal_mode = OFF" },
  { name: "PRAGMA synchronous", works: "runs", statement: () => "PRAGMA synchronous = OFF" },
  { name: "PRAGMA query_only", works: "runs", statement: () => "PRAGMA query_only = 0" },
  { name: "PRAGMA locking_mode", works: "runs", statement: () => "PRAGMA locking_mode = NORMAL" },
  { name: "PRAGMA trusted_schema", works: "runs", statement: () => "PRAGMA trusted_schema = 1" },
  { name: "PRAGMA database_list, which names the file on the disk", works: "runs", statement: () => "PRAGMA database_list" },
  { name: "PRAGMA database_list read as a table, with no PRAGMA word", works: "runs", statement: () => "SELECT file FROM pragma_database_list" },
  { name: "PRAGMA database_list read as a table, inside a WITH", works: "runs", statement: () => "WITH d AS (SELECT * FROM pragma_database_list()) SELECT count(*) FROM d" },
];

/** A path under the machine's temporary folder that names no file. */
const noFile = (): string => join(tmpdir(), `store-suite-${countingHex(8)}.sqlite`);

describe("rule 1: a statement reaches only its own store's file", () => {
  const rule = host().reach;

  /** Runs a statement on the host as a store does, reading every row; answers whether the host refused it. */
  const refused = (storage: HostStorage, statement: string): boolean => {
    try {
      storage.sql.exec(statement).toArray();
      return false;
    } catch {
      return true;
    }
  };

  if (rule.held === "platform") {
    itWhere(false, `the platform under ${host().name} holds this rule: ${rule.how}`)("refuses every statement that reaches outside the store's file", () => undefined);
  } else {
    const other = rule.otherFile();
    /** The other store's rows, read from its file's bytes by a database apart from every store. */
    const otherRows = () => host().database(new Uint8Array(readFileSync(other))).prepare("SELECT secret FROM other_rows").all();
    const before = JSON.stringify(otherRows());

    for (const attack of REACH_ATTACKS) {
      it(`refuses ${attack.name}`, () => {
        const storage = host().storage();
        storage.sql.exec("CREATE TABLE mine (x)");
        storage.sql.exec("INSERT INTO mine VALUES (1)");
        const fresh = noFile();
        try {
          const statement = attack.statement(other, fresh);
          const wasRefused = refused(storage, statement);
          if (!attack.second) assert.ok(wasRefused, `the host ran: ${statement}`);
          // A refusal alone is no proof. Nothing of the other store can be read or changed from here,
          assert.ok(refused(storage, "SELECT * FROM other.other_rows"), "the other store's rows can be read");
          assert.ok(refused(storage, "INSERT INTO other.other_rows VALUES ('written from another store')"), "the other store's rows can be written");
          assert.ok(refused(storage, "DROP TABLE other.other_rows"), "the other store's table can be dropped");
          // its file holds what it held, no new file appeared,
          assert.equal(JSON.stringify(otherRows()), before);
          assert.equal(existsSync(fresh), false, "a file appeared outside the store");
          // and the store itself goes on as before.
          assert.deepEqual(storage.sql.exec("SELECT x FROM mine").toArray().map(plain), [{ x: 1 }]);
          storage.sql.exec("INSERT INTO mine VALUES (2)");
        } finally {
          rmSync(fresh, { force: true });
        }
      });
    }
  }

  // The store's own doors, on every host: a statement that reaches outside is refused as a
  // person's mistake (a 4xx), never run, and never answered as the store's own failure (a 500).
  describe("through a store's own calls", () => {
    const setup = () => {
      const clock = new FakeClock();
      const storage = host().storage();
      storage.now = clock.now;
      const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map() };
      const store = new StoreHandler(stateOf(storage), { FILES: filesOf().asBucket() }, deps);
      return { store, storage };
    };
    const other = rule.held === "host" ? rule.otherFile() : noFile();
    const doors: Array<{ name: string; send(store: StoreHandler, statement: string): Promise<StoreResult<unknown>> }> = [
      { name: "a query", send: (store, sql) => store.query(ME, { sql }) },
      { name: "an exec", send: (store, sql) => store.exec(ME, { sql }) },
      { name: "a migration", send: (store, sql) => store.migrate(ME, { id: `0001_${countingHex(4)}`, sql }) },
      { name: "an app's statement", send: (store, sql) => store.appQuery(ME, { sql, params: [], method: "all" }) },
      { name: "an app's batch", send: (store, sql) => store.appBatch(ME, [{ sql: "SELECT 1", params: [], method: "all" }, { sql, params: [], method: "run" }]) },
    ];
    for (const door of doors) {
      it(`${door.name} refuses each of them, and the store goes on`, async () => {
        const { store, storage } = setup();
        const made = await store.migrate(ME, { id: "0000_first", sql: "CREATE TABLE mine (x integer);" });
        assert.equal(made.ok, true);
        for (const attack of REACH_ATTACKS) {
          const fresh = noFile();
          try {
            const answer = await door.send(store, attack.statement(other, fresh));
            const said = answer.ok ? "it was taken" : `${answer.status} ${answer.code}: ${answer.error}`;
            assert.equal(answer.ok, false, `${attack.name}: ${said}`);
            assert.ok(!answer.ok && answer.status >= 400 && answer.status < 500, `${attack.name}: ${said}`);
            assert.equal(existsSync(fresh), false, `${attack.name}: a file appeared outside the store`);
          } finally {
            rmSync(fresh, { force: true });
          }
        }
        assert.throws(() => storage.sql.exec("SELECT * FROM other.other_rows").toArray());
        const write = await store.exec(ME, { sql: "INSERT INTO mine VALUES (1)" });
        assert.equal(write.ok, true, write.ok ? "" : write.error);
      });
    }
  });
});

// ── Rule 2 ───────────────────────────────────────────────────────────────────

/** A statement that never ends: it counts for ever, and holds nothing in memory while it does. */
export const NEVER_ENDS = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS n FROM c";
/** One that never ends and writes all the while: every row it writes is in one transaction that never commits. */
export const NEVER_ENDS_WRITING = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) INSERT INTO kept SELECT x FROM c";

describe("rule 2: a statement that never ends is stopped, and the host still answers", () => {
  const rule = host().runaway;
  if (rule.held === "platform") {
    itWhere(false, `the platform under ${host().name} holds this rule: ${rule.how}`)("stops a statement that never ends", () => undefined);
    return;
  }

  /** Two stores apart from the caller: one that will hold a statement that never ends, and one beside it. */
  const pair = async () => {
    const stuck = await rule.open();
    const beside = await rule.open();
    await stuck.exec("CREATE TABLE kept (n INTEGER)");
    await stuck.exec("INSERT INTO kept VALUES (1), (2), (3)");
    await beside.exec("CREATE TABLE notes (n INTEGER)");
    return { stuck, beside, close: () => Promise.all([stuck.close(), beside.close()]) };
  };

  /** One store that holds `statement`, which never ends: stopped by the host, with another store answering meanwhile. */
  const stopped = async (statement: string) => {
    const { stuck, beside, close } = await pair();
    try {
      let over: "answered" | "stopped" | null = null;
      const endless = stuck.exec(statement).then(
        () => (over = "answered"),
        () => (over = "stopped"),
      );
      // The caller's own loop is free: a store beside it answers, and takes a write.
      assert.deepEqual(await beside.exec("SELECT 41 + 1 AS n"), [{ n: 42 }]);
      await beside.exec("INSERT INTO notes VALUES (1)");
      assert.equal(over, null, "the statement was still running when the other store answered");
      // The host ends it. Nothing in the statement can refuse that.
      assert.equal(await endless, "stopped");
      // The store answers again, with its rows as its last commit left them.
      assert.deepEqual(await stuck.exec("SELECT count(*) AS n, sum(n) AS total FROM kept"), [{ n: 3, total: 6 }]);
      await stuck.exec("INSERT INTO kept VALUES (4)");
      assert.deepEqual(await stuck.exec("SELECT count(*) AS n FROM kept"), [{ n: 4 }]);
      assert.deepEqual(await beside.exec("SELECT count(*) AS n FROM notes"), [{ n: 1 }]);
    } finally {
      await close();
    }
  };

  /** A statement waits behind one that never ends: it is stopped with it or runs after the stop, and never hangs. */
  const stoppedWithOneWaiting = async () => {
    const { stuck, close } = await pair();
    try {
      const outcomes = await Promise.allSettled([stuck.exec(NEVER_ENDS), stuck.exec("SELECT 1 AS n")]);
      assert.equal(outcomes[0]!.status, "rejected");
      assert.ok(outcomes[1]!.status === "rejected" || JSON.stringify(outcomes[1]!.value) === '[{"n":1}]');
      assert.deepEqual(await stuck.exec("SELECT count(*) AS n FROM kept"), [{ n: 3 }]);
    } finally {
      await close();
    }
  };

  // Each case waits out the host's limit on the real clock, so the three run side by side: the
  // first test to start begins all of them, and each test then reports its own case.
  const cases = [() => stopped(NEVER_ENDS), () => stopped(NEVER_ENDS_WRITING), stoppedWithOneWaiting];
  let round: Promise<PromiseSettledResult<void>[]> | null = null;
  const outcomeOf = async (index: number): Promise<void> => {
    const outcome = (await (round ??= Promise.allSettled(cases.map((run) => run()))))[index]!;
    if (outcome.status === "rejected") throw outcome.reason;
  };

  it("stops one that only reads, answers for another store meanwhile, and the store answers again as it was", () => outcomeOf(0));
  it("stops one that writes all the while, answers for another store meanwhile, and the store answers again as it was", () => outcomeOf(1));
  it("stops what waited behind the statement too, and takes the next statement", () => outcomeOf(2));
});

// ── What a host says of itself ───────────────────────────────────────────────

describe("what a host says of itself", () => {
  const traits = host().traits;
  const fresh = (): HostStorage => host().storage();

  it("counts a row and its index entry as the trait says: billed as Cloudflare bills, or as SQLite counts", () => {
    const { sql } = fresh();
    sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, code TEXT)");
    sql.exec("CREATE INDEX t_code ON t (code)");
    const wrote = sql.exec("INSERT INTO t (code) VALUES ('a'), ('b'), ('c')").rowsWritten;
    // Billed: three rows and their three entries in the index. Counted as SQLite does: the three rows.
    assert.equal(wrote, traits.billedWrites ? 6 : 3);
  });

  const where = (limit: keyof typeof traits.limits) => itWhere(traits.limits[limit], `${host().name} does not hold this limit`);
  const columns = (n: number) => Array.from({ length: n }, (_, i) => `c${i + 1}`).join(", ");
  const unions = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i}`).join(" UNION ALL ");
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

  where("column")("holds a table and a result to 100 columns", () => {
    const { sql } = fresh();
    sql.exec(`CREATE TABLE wide (${columns(100)})`);
    assert.throws(() => sql.exec(`CREATE TABLE wider (${columns(101)})`), /too many columns/);
    assert.throws(() => sql.exec(`SELECT ${Array.from({ length: 101 }, (_, i) => i).join(", ")}`).toArray(), /too many columns/);
  });

  where("length")("holds a value to 2,000,000 bytes", () => {
    const { sql } = fresh();
    assert.equal(sql.exec<{ n: number }>("SELECT length(?) AS n", "x".repeat(1_000_000)).one().n, 1_000_000);
    assert.throws(() => sql.exec("SELECT length(?) AS n", "x".repeat(2_000_001)).toArray(), /too big/);
  });

  where("variableNumber")("holds a statement to 100 bound values", () => {
    const { sql } = fresh();
    const values = (n: number) => Array.from({ length: n }, (_, i) => i);
    assert.equal(sql.exec<{ n: number }>(`SELECT 1 AS n WHERE 5 IN (${marks(100)})`, ...values(100)).one().n, 1);
    assert.throws(() => sql.exec(`SELECT 1 AS n WHERE 5 IN (${marks(101)})`, ...values(101)).toArray(), /too many SQL variables/);
  });

  where("sqlLength")("holds a statement to 100,000 bytes", () => {
    const { sql } = fresh();
    const padded = (bytes: number) => `SELECT 1 AS n /*${"x".repeat(bytes - 18)}*/`;
    assert.equal(padded(100_000).length, 100_000);
    assert.equal(sql.exec<{ n: number }>(padded(100_000)).one().n, 1);
    assert.throws(() => sql.exec(padded(100_001)).toArray(), /too long|too big/);
  });

  where("likePatternLength")("holds a LIKE or GLOB pattern to 50 bytes", () => {
    const { sql } = fresh();
    assert.equal(sql.exec<{ n: number }>("SELECT 'abc' LIKE ? AS n", `a${"%".repeat(49)}`).one().n, 1);
    assert.throws(() => sql.exec("SELECT 'abc' LIKE ? AS n", `a${"%".repeat(50)}`).toArray(), /pattern too complex/);
    assert.throws(() => sql.exec("SELECT 'abc' GLOB ? AS n", `a${"*".repeat(50)}`).toArray(), /pattern too complex/);
  });

  where("compoundSelect")("holds a chain of UNION, INTERSECT and EXCEPT to 5 SELECTs", () => {
    const { sql } = fresh();
    assert.equal(sql.exec(unions(5)).toArray().length, 5);
    assert.throws(() => sql.exec(unions(6)).toArray(), /too many terms in compound SELECT/);
  });

  itWhere(traits.bookmarks, `${host().name} keeps no bookmarks`)("goes back to a bookmark when it starts again, and answers the bookmark of the moment before", async () => {
    const storage = fresh();
    storage.sql.exec("CREATE TABLE t (x)");
    storage.sql.exec("INSERT INTO t VALUES (1)");
    const then = await storage.getCurrentBookmark();
    assert.ok(then && !/^[0-]+$/.test(then), "a bookmark that names a moment");
    storage.sql.exec("INSERT INTO t VALUES (2)");
    const undo = await storage.onNextSessionRestoreBookmark(then);
    assert.ok(undo && undo !== then);
    assert.equal(storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM t").one().n, 2, "nothing changes until the store starts again");
    storage.restart();
    assert.equal(storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM t").one().n, 1);
    await assert.rejects(() => storage.onNextSessionRestoreBookmark("no such bookmark"));
  });

  itWhere(!traits.bookmarks, `${host().name} keeps bookmarks`)("keeps no bookmark, and its stores say they have no moment to return to", async () => {
    const storage = fresh();
    const mark = await storage.getCurrentBookmark().catch(() => "");
    assert.match(mark, /^[0-]*$/, "a bookmark of zeros, or none");
    await assert.rejects(() => storage.getBookmarkForTime(Date.now()));
    await assert.rejects(() => storage.onNextSessionRestoreBookmark(mark));
    const clock = new FakeClock();
    storage.now = clock.now;
    const store = new StoreHandler(stateOf(storage), { FILES: filesOf().asBucket() }, { now: clock.now, randomHex: countingHex, jobs: new Map() });
    const answer = await store.restore(ME, { at: new Date(clock.now()).toISOString() });
    assert.equal(answer.ok ? "it was taken" : answer.code, "restore_unavailable");
  });
});
