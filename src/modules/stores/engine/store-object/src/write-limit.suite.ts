// The daily write limit (write-limit.ts) on stand-ins for a store's storage: it counts the rows
// SQLite writes for the store per UTC day, keeps the count in one row of `_meta` per call, refuses
// writes of its data once the day's count reaches the limit (and nothing else), starts again the next
// UTC day, makes a job under way wait with what it did until 00:00 UTC or a raised limit, says before
// a job's first write what it is about to write, keeps what each job wrote, and keeps its counts
// across a restore. A store whose token names its organization counts toward that organization's
// budget (a stand-in here): it tells the budget what it wrote, and holds itself to the
// organization's count and limit.

import { describe, it, host, stateOf, filesOf, whereBilled, itRestores, type HostFiles, type HostStorage } from "../testing/suite/host.js";
import { countingHex, FakeBudget, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import { StoreError, type StoreDeps, type StoreEnv } from "./core.js";
import { StoreHandler } from "./handler.js";
import { KIND_ESTIMATES, linesIn } from "./jobs/estimates.js";
import type { StoreFiles } from "./store-files.js";
import type { JobHandler } from "./jobs/types.js";
import type { StoreCaller, StoreResult, StoreWrites } from "./types.js";
import { BUDGET_ASK_EVERY_MS, BUDGET_STATS_EVERY_MS, utcDay, WRITE_KEEP_WITHIN_MS, WRITE_LIMIT_DEFAULT, writeCountKey, writeLimitWords } from "./write-limit.js";

const A = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ME: StoreCaller = { storeId: A, actor: "run:r-1" };
const ADMIN: StoreCaller = { storeId: A, actor: "user:admin" };
/** A run's call whose token names the store's organization: the store counts toward its budget from then on. */
const IN_ORG: StoreCaller = { storeId: A, actor: "run:r-1", org: "org-1" };
const DAY = 86_400_000;

function setup(opts: { jobs?: JobHandler[]; env?: Partial<StoreEnv>; budget?: FakeBudget } = {}) {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const logs: Record<string, unknown>[] = [];
  const budget = opts.budget;
  const deps: StoreDeps = {
    now: clock.now,
    randomHex: countingHex,
    jobs: new Map((opts.jobs ?? []).map((j) => [j.kind, j])),
    log: (line) => logs.push(line),
    ...(budget ? { writeBudget: () => budget } : {}),
  };
  const make = () => new StoreHandler(state as never, { FILES: r2.asBucket(), ...opts.env }, deps);
  return { clock, storage, state, r2, logs, store: make(), make };
}

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function refusal<T>(result: StoreResult<T>): { status: number; code: string; error: string } {
  assert.equal(result.ok, false, "expected a refusal");
  return result as { status: number; code: string; error: string };
}

async function writes(store: StoreHandler): Promise<StoreWrites> {
  const stats = value(await store.stats(ME));
  assert.ok(stats.writes, "stats say today's writes");
  return stats.writes;
}

/** Rows of `_meta` holding a day's count, as SQLite keeps them. */
const kept = (storage: HostStorage) => storage.sql.exec<{ key: string; value: string }>("SELECT key, value FROM _meta WHERE key LIKE 'rows_written:%' ORDER BY key").toArray();

/** Runs the store's alarm until it sets none, as the platform fires it. */
async function runAlarms(store: StoreHandler, storage: HostStorage, most = 20): Promise<number> {
  let firings = 0;
  for (; firings < most && storage.alarm !== null; firings++) {
    storage.alarm = null;
    await store.alarm();
  }
  return firings;
}

/** Fires the store's alarms as the platform would, moving the clock to each, up to `until`. */
async function alarmsUntil(store: StoreHandler, storage: HostStorage, clock: FakeClock, until: number, most = 60): Promise<number> {
  let firings = 0;
  while (firings < most && storage.alarm !== null && storage.alarm <= until) {
    if (storage.alarm > clock.now()) clock.advance(storage.alarm - clock.now());
    storage.alarm = null;
    await store.alarm();
    firings++;
  }
  return firings;
}

describe("the count of rows written", () => {
  const KEEP = "INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = CAST(";

  it("adds up SQLite's own count of each statement, and keeps it in one row of the day once 1,000 rows wait", async () => {
    const { store, storage } = setup();
    value(await store.migrate(ME, { id: "0000_t", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, code TEXT)\n--> statement-breakpoint\nCREATE INDEX t_code ON t (code)" }));
    const before = (await writes(store)).rows;
    assert.ok(before > 0, "a migration writes the schema and its records");
    value(await store.exec(ME, { sql: "INSERT INTO t (code) SELECT 'c' || value FROM json_each('[1,2,3,4,5,6,7,8,9,10]')" }));
    const after = await writes(store);
    // Ten rows, their ten index entries (a cursor's count holds them, on the platform and in the
    // stand-in), and the store's own records of the call.
    whereBilled(() => assert.ok(after.rows - before >= 20 && after.rows - before < 30, `ten rows, their index entries and the call's own (${after.rows - before})`));
    assert.deepEqual([after.day, after.limit, after.shared], ["2026-11-07", WRITE_LIMIT_DEFAULT, false]);
    assert.deepEqual(kept(storage), [], "fewer than 1,000 rows wait in memory: keeping them would cost a row each call");
    const statementsBefore = storage.sql.statements.length;
    value(await store.exec(ME, { sql: "INSERT INTO t (code) SELECT 'b' || value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1200 }, (_, i) => i))] }));
    assert.equal(storage.sql.statements.slice(statementsBefore).filter((q) => q.startsWith(KEEP)).length, 1, "one statement keeps the count");
    assert.ok(store.core.meter.unkept <= 2, "only the keeping statement's own rows wait for the next keep");
    const rows = kept(storage);
    assert.equal(rows.length, 1, "one row of _meta for the day");
    assert.equal(rows[0]!.key, writeCountKey("2026-11-07"));
    // Every row written so far, and the keeping statement's own.
    const total = (await writes(store)).rows;
    assert.ok(Number(rows[0]!.value) >= after.rows + 1200 && Number(rows[0]!.value) <= total, `${rows[0]!.value} against ${total}`);
  });

  it("writes nothing to keep a count when a call wrote nothing", async () => {
    const { store, storage } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE t (a TEXT)" }));
    value(await store.exec(ME, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1100 }, (_, i) => i))] }));
    const count = kept(storage)[0]!.value;
    const statementsBefore = storage.sql.statements.length;
    value(await store.catalog(ME));
    value(await store.query(ME, { sql: "SELECT * FROM t LIMIT 3" }));
    assert.equal(kept(storage)[0]!.value, count, "reads keep nothing");
    assert.equal(storage.sql.statements.slice(statementsBefore).filter((q) => q.startsWith(KEEP)).length, 0);
  });

  it("keeps what waits in memory by an alarm 5 seconds after a call, before an idle object sleeps and forgets it", async () => {
    const { store, storage, clock, make } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE t (a TEXT)" }));
    const first = clock.now();
    value(await store.exec(ME, { sql: "INSERT INTO t VALUES ('x')" }));
    assert.deepEqual(kept(storage), [], "a few rows wait in memory");
    assert.equal(storage.alarm, first + WRITE_KEEP_WITHIN_MS, "an alarm keeps them within 5 seconds");
    // Calls in those seconds share the alarm.
    clock.advance(2_000);
    value(await store.exec(ME, { sql: "INSERT INTO t VALUES ('y')" }));
    assert.equal(storage.alarm, first + WRITE_KEEP_WITHIN_MS, "one alarm for the calls in those seconds");
    const waiting = (await writes(store)).rows;
    assert.ok(waiting > 0);
    clock.advance(3_000);
    assert.equal(await runAlarms(store, storage), 1, "the alarm keeps the count and sets no other");
    assert.equal(Number(kept(storage)[0]?.value), waiting, "every row the calls wrote is kept");
    // The object sleeps, and the next call wakes a new one with nothing in memory: the count stays.
    assert.equal((await writes(make())).rows, waiting);
  });

  it("keeps a day's count when the next UTC day begins, counts the new day from zero, and keeps 31 days", async () => {
    const { store, storage, clock } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE t (a TEXT)" }));
    for (let d = 0; d < 40; d++) {
      clock.advance(DAY);
      value(await store.exec(ME, { sql: "INSERT INTO t VALUES ('x')" }));
    }
    const today = await writes(store);
    assert.ok(today.rows > 0 && today.rows < 10, `today's count starts from zero (${today.rows})`);
    const days = kept(storage).map((r) => r.key.slice("rows_written:".length));
    assert.ok(days.length <= 32, `old days go (${days.length} kept)`);
    assert.equal(days.at(-1), utcDay(Date.parse(`${today.day}T00:00:00Z`) - DAY), "yesterday's rows count on yesterday");
    assert.ok(Number(kept(storage).at(-1)!.value) < 10, "a day holds its own rows only");
  });
});

describe("past the daily limit", () => {
  it("refuses SQL that writes, a migration and a new job, with words a run shows, and still reads and takes files", async () => {
    const counter: JobHandler<{ to: number }> = {
      kind: "count",
      parse: (p) => p as { to: number },
      async run() {
        return { result: { counted: 0 } };
      },
    };
    const hint = "Your support team can raise it.";
    const { store, r2 } = setup({ jobs: [counter as JobHandler], env: { STORE_DAILY_WRITE_LIMIT: "1000", STORE_WRITE_LIMIT_HINT: hint } });
    value(await store.exec(ME, { sql: "CREATE TABLE t (n INTEGER)" }));
    // One statement that starts under the limit runs whole, and takes the store past it.
    value(await store.exec(ME, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1500 }, (_, i) => i))] }));
    const w = await writes(store);
    assert.ok(w.rows >= 1500 && w.limit === 1000);

    const exec = refusal(await store.exec(ME, { sql: "INSERT INTO t VALUES (1)" }));
    assert.equal(exec.status, 429);
    assert.equal(exec.code, "write_limit_reached");
    assert.match(
      exec.error,
      /^This store has written 1,5\d\d rows today \(UTC\), and its limit is 1,000 rows a day\. It takes more writes after 00:00 UTC, or once its daily write limit is raised\. Your support team can raise it\.$/,
    );
    assert.equal(refusal(await store.migrate(ME, { id: "0001_u", sql: "CREATE TABLE u (a TEXT)" })).code, "write_limit_reached");
    assert.equal(refusal(await store.jobSubmit(ME, { kind: "count", params: { to: 1 }, requestKey: "k-new" })).code, "write_limit_reached");

    // Reads, and a person's upload, go on.
    assert.equal(value(await store.query(ME, { sql: "SELECT count(*) AS n FROM t" })).rows[0]![0], 1500);
    const file = value(await store.fileCreate(ME, { name: "town.csv", size: 4 }));
    const target = value(await store.filePartTarget(ME, file.file.id, 1));
    const part = await r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, "a,b\n");
    assert.equal(value(await store.fileComplete(ME, file.file.id, { parts: [{ n: 1, etag: part.etag }] })).file.state, "ready");
  });

  it("answers a replayed job submit with the job it made, past the limit too", async () => {
    const counter: JobHandler = { kind: "count", parse: (p) => p, run: async () => ({ result: null }) };
    const { store } = setup({ jobs: [counter], env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    const job = value(await store.jobSubmit(ME, { kind: "count", params: {}, requestKey: "run-1:s2" })).job;
    value(await store.exec(ME, { sql: "CREATE TABLE t (n INTEGER)" }));
    value(await store.exec(ME, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1200 }, (_, i) => i))] }));
    assert.equal(value(await store.jobSubmit(ME, { kind: "count", params: {}, requestKey: "run-1:s2" })).job.id, job.id);
  });

  it("takes writes again after 00:00 UTC", async () => {
    const { store, clock } = setup({ env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    value(await store.exec(ME, { sql: "CREATE TABLE t (n INTEGER)" }));
    value(await store.exec(ME, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1200 }, (_, i) => i))] }));
    assert.equal(refusal(await store.exec(ME, { sql: "INSERT INTO t VALUES (1)" })).code, "write_limit_reached");
    // The fake clock starts at 2026-11-07T12:00Z.
    clock.advance(12 * 60 * 60_000);
    value(await store.exec(ME, { sql: "INSERT INTO t VALUES (1)" }));
    assert.equal((await writes(store)).day, "2026-11-08");
  });

  it("refuses an app's writes, never its reads", async () => {
    const { store } = setup({ env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    value(await store.migrate(ME, { id: "0000_notes", sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)" }));
    value(await store.exec(ME, { sql: "INSERT INTO notes (body) SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1100 }, (_, i) => `n${i}`))] }));
    const app: StoreCaller = { storeId: A, actor: "app:notes/u-1" };
    assert.equal(value(await store.appQuery(app, { sql: "SELECT count(*) AS n FROM notes", method: "get" })).rows?.[0], 1100);
    const write = refusal(await store.appQuery(app, { sql: "INSERT INTO notes (body) VALUES (?)", params: ["late"], method: "run" }));
    assert.equal(write.code, "write_limit_reached");
    assert.equal(refusal(await store.appBatch(app, [{ sql: "UPDATE notes SET body = 'x' WHERE id = 1", method: "run" }])).code, "write_limit_reached");
  });

  it("holds a store written in bursts under 1,000 rows to its limit, though its object sleeps after each", async () => {
    const { store: first, storage, make } = setup({ env: { STORE_DAILY_WRITE_LIMIT: "2000" } });
    value(await first.exec(ME, { sql: "CREATE TABLE t (n INTEGER)" }));
    const burst = JSON.stringify(Array.from({ length: 900 }, (_, i) => i));
    let store = first;
    for (let i = 0; i < 3; i++) {
      value(await store.exec(ME, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [burst] }));
      // The alarm 5 seconds later keeps the count; then the object sleeps, and the next call wakes a new one.
      await runAlarms(store, storage);
      store = make();
    }
    assert.ok((await writes(store)).rows >= 2_700);
    assert.equal(refusal(await store.exec(ME, { sql: "INSERT INTO t VALUES (1)" })).code, "write_limit_reached");
  });
});

describe("a job that reaches the daily limit", () => {
  const NEXT_DAY = Date.parse("2026-11-08T00:00:00Z");
  /** A job of `chunks` chunks that each write 400 rows, and say where they stand in their state. */
  const filler: JobHandler<{ chunks: number }, { at: number }> = {
    kind: "fill",
    parse: (p) => p as { chunks: number },
    async run(ctx) {
      const at = (ctx.state?.at ?? 0) + 1;
      ctx.commit({ state: { at }, progress: { done: at, total: ctx.params.chunks } }, () => {
        ctx.sql.exec("CREATE TABLE IF NOT EXISTS filled (n INTEGER)");
        ctx.sql.exec("INSERT INTO filled SELECT value FROM json_each(?)", JSON.stringify(Array.from({ length: 400 }, (_, i) => i)));
      });
      return at >= ctx.params.chunks ? { result: { at } } : { more: true };
    },
  };
  const chunksOf = (storage: HostStorage, id: string) => Number(storage.sql.exec("SELECT chunks FROM _jobs WHERE id = ?", id).one().chunks);
  const filled = (storage: HostStorage) => Number(storage.sql.exec("SELECT count(*) AS n FROM filled").one().n);
  const waitNotes = (storage: HostStorage, id: string) => storage.sql.exec("SELECT note FROM _history WHERE ref = ? AND note LIKE '% waits %'", id).toArray().map((r) => String(r.note));

  /**
   * A store whose limit a job of `chunks` chunks has reached: three chunks of 400 take it past 1,000.
   * `shared`: the limit is its organization's budget's, which a test may raise.
   */
  async function atTheLimit(chunks: number, opts: { shared?: boolean } = {}) {
    const budget = opts.shared ? new FakeBudget(1_000) : undefined;
    const s = setup({ jobs: [filler as JobHandler], ...(budget ? { budget } : { env: { STORE_DAILY_WRITE_LIMIT: "1000" } }) });
    const job = value(await s.store.jobSubmit(budget ? IN_ORG : ME, { kind: "fill", params: { chunks }, requestKey: "run-2:s1" })).job;
    await alarmsUntil(s.store, s.storage, s.clock, s.clock.now() + 60_000);
    return { ...s, job, budget };
  }

  it("waits before its next chunk, keeps its place and what it wrote, says why in its answer and its history, and writes nothing more", async () => {
    const { store, storage, job, logs } = await atTheLimit(10);
    assert.equal(storage.alarm, NEXT_DAY, "its next chunk is at 00:00 UTC");
    const waiting = value(await store.job(ME, job.id)).job;
    assert.equal(waiting.state, "running", "it stays open");
    assert.equal(waiting.error, null, "it has not failed");
    assert.equal(waiting.waiting?.code, "write_limit_reached");
    assert.match(waiting.waiting?.error ?? "", /^This store has written 1,\d{3} rows today \(UTC\), and its limit is 1,000 rows a day/);
    assert.equal(waiting.waiting?.until, "2026-11-08T00:00:00.000Z");
    assert.equal(chunksOf(storage, job.id), 3, "the fourth chunk never runs");
    assert.equal(filled(storage), 1200);
    assert.deepEqual(JSON.parse(String(storage.sql.exec("SELECT run_state FROM _jobs WHERE id = ?", job.id).one().run_state)), { at: 3 }, "it keeps its place");
    assert.ok((waiting.rowsWritten ?? 0) >= 1200, `the job keeps what its chunks wrote (${waiting.rowsWritten})`);
    const [note, ...more] = waitNotes(storage, job.id);
    assert.equal(more.length, 0);
    assert.match(note ?? "", /^fill waits where it stopped: This store has written/);
    const told = logs.filter((l) => l.event === "waits");
    assert.equal(told.length, 1);
    assert.equal(told[0]!.job, job.id);
    assert.equal(told[0]!.dailyLimit, 1000);
    assert.equal(told[0]!.until, "2026-11-08T00:00:00.000Z");
  });

  it("looks again whenever the store's other alarms fire, and says it waits only once", async () => {
    const { store, storage, clock, job, make, logs } = await atTheLimit(10);
    // A person's upload's alarm, say: the object wakes, sees the limit, and goes back to 00:00 UTC.
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000);
      storage.alarm = null;
      await store.alarm();
      assert.equal(storage.alarm, NEXT_DAY);
    }
    // The object sleeps and a call wakes a new one: it looks at once, and goes back to waiting.
    clock.advance(60_000);
    const again = make();
    value(await again.catalog(ME));
    assert.equal(storage.alarm, clock.now(), "a new object looks at its open job");
    storage.alarm = null;
    await again.alarm();
    assert.equal(storage.alarm, NEXT_DAY);
    assert.equal(chunksOf(storage, job.id), 3, "still no chunk");
    assert.equal(waitNotes(storage, job.id).length, 1);
    assert.equal(logs.filter((l) => l.event === "waits").length, 1);
  });

  it("goes on where it stopped at 00:00 UTC, and writes every row once", async () => {
    const { store, storage, clock, job } = await atTheLimit(5);
    assert.equal(await alarmsUntil(store, storage, clock, NEXT_DAY - 1), 0, "nothing runs before 00:00 UTC");
    await alarmsUntil(store, storage, clock, NEXT_DAY + 60_000);
    const done = value(await store.job(ME, job.id)).job;
    assert.equal(done.state, "done", done.error ?? "");
    assert.equal(done.waiting, null);
    assert.deepEqual(done.result, { at: 5 }, "two chunks more, from where it stopped");
    assert.equal(chunksOf(storage, job.id), 5);
    assert.equal(filled(storage), 5 * 400, "no row written twice");
    assert.ok(done.updatedAt >= "2026-11-08T00:00:00.000Z");
    // It finished: nothing of its waiting is left behind.
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM _meta WHERE key LIKE 'job\\_waits:%' ESCAPE '\\'").one().n, 0);
  });

  it("goes on within a minute once its organization's limit is raised, with the chunk it stopped before", async () => {
    const { store, storage, clock, job, budget } = await atTheLimit(5, { shared: true });
    assert.equal(value(await store.job(ME, job.id)).job.waiting?.code, "write_limit_reached");
    assert.ok(storage.alarm !== null && storage.alarm <= clock.now() + BUDGET_ASK_EVERY_MS, "it looks again within a minute");
    budget!.limit = 50_000;
    await alarmsUntil(store, storage, clock, clock.now() + 2 * BUDGET_ASK_EVERY_MS);
    const done = value(await store.job(ME, job.id)).job;
    assert.equal(done.state, "done", done.error ?? "");
    assert.deepEqual(done.result, { at: 5 });
    assert.equal(filled(storage), 5 * 400);
    assert.ok(clock.now() < NEXT_DAY, "the same day");
  });

  it("keeps waiting for a raise that leaves its organization past its limit, and says whose limit it is", async () => {
    const { store, storage, clock, job, budget } = await atTheLimit(10, { shared: true });
    budget!.limit = 1_100;
    await alarmsUntil(store, storage, clock, clock.now() + 3 * BUDGET_ASK_EVERY_MS);
    assert.equal(chunksOf(storage, job.id), 3);
    assert.ok(storage.alarm !== null && storage.alarm <= clock.now() + BUDGET_ASK_EVERY_MS, "it still looks again each minute");
    const waiting = value(await store.job(ME, job.id)).job.waiting;
    assert.equal(waiting?.code, "write_limit_reached");
    assert.match(waiting?.error ?? "", /^This organization's stores have written [\d,]+ rows today \(UTC\), and their limit is 1,100 rows a day\./);
  });

  it("waits again on a day it reaches the limit again, and says so that day too", async () => {
    const { store, storage, clock, job } = await atTheLimit(9);
    await alarmsUntil(store, storage, clock, NEXT_DAY + 60_000);
    assert.equal(chunksOf(storage, job.id), 6, "three more on the next day");
    assert.equal(storage.alarm, NEXT_DAY + 86_400_000);
    assert.equal(waitNotes(storage, job.id).length, 2);
    await alarmsUntil(store, storage, clock, NEXT_DAY + 86_400_000 + 60_000);
    const done = value(await store.job(ME, job.id)).job;
    assert.equal(done.state, "done", done.error ?? "");
    assert.equal(filled(storage), 9 * 400);
  });

  it("keeps its tables in progress while it waits, and makes them when it goes on", async () => {
    type State = { at: number };
    const builder: JobHandler<unknown, State> = {
      kind: "build",
      parse: (p) => p,
      async run(ctx) {
        const at = (ctx.state?.at ?? 0) + 1;
        if (at === 3) {
          const made = await ctx.tables.commit("permits", { group: "From the town", madeBy: { runId: null, step: null } });
          return { result: made };
        }
        const fresh = at === 1 ? ctx.tables.begin("permits") : "permits__new";
        ctx.commit({ state: { at }, progress: { done: at, total: 3 } }, () => {
          if (at === 1) ctx.sql.exec(`CREATE TABLE ${fresh} (n INTEGER)`);
          ctx.sql.exec(`INSERT INTO ${fresh} SELECT value FROM json_each(?)`, JSON.stringify(Array.from({ length: 600 }, (_, i) => i)));
        });
        return { more: true };
      },
    };
    const { store, storage, clock } = setup({ jobs: [builder as JobHandler], env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    const job = value(await store.jobSubmit(ME, { kind: "build", params: {}, requestKey: "run-7:s1" })).job;
    await alarmsUntil(store, storage, clock, clock.now() + 60_000);
    assert.equal(value(await store.job(ME, job.id)).job.state, "running");
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM permits__new").one().n, 1200, "its table in progress stays");
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM _meta WHERE key = ?", `job_tables:${job.id}`).one().n, 1);
    await alarmsUntil(store, storage, clock, NEXT_DAY + 60_000);
    const done = value(await store.job(ME, job.id)).job;
    assert.equal(done.state, "done", done.error ?? "");
    const made = done.result as { table: string; version: number; rows: number };
    assert.deepEqual([made.table, made.version, made.rows], ["permits", 1, 1200]);
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'permits__new'").one().n, 0);
  });

  it("ends a chunk at its next commit once the day's writes reach the limit", async () => {
    const batches: JobHandler<unknown, { n: number }> = {
      kind: "batches",
      parse: (p) => p,
      async run(ctx) {
        let n = ctx.state?.n ?? 0;
        while (ctx.now() < ctx.deadline && n < 50) {
          n += 1;
          const state = { n };
          ctx.commit({ state, progress: { done: n, total: 50 } }, () => {
            ctx.sql.exec("CREATE TABLE IF NOT EXISTS batched (n INTEGER)");
            ctx.sql.exec("INSERT INTO batched SELECT value FROM json_each(?)", JSON.stringify(Array.from({ length: 400 }, (_, i) => i)));
          });
        }
        return n >= 50 ? { result: { n } } : { more: true };
      },
    };
    const { store, storage, clock } = setup({ jobs: [batches as JobHandler], env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    const job = value(await store.jobSubmit(ME, { kind: "batches", params: {}, requestKey: "run-8:s1" })).job;
    await alarmsUntil(store, storage, clock, clock.now() + 60_000);
    assert.equal(chunksOf(storage, job.id), 1, "one chunk, however many commits it could still have made in its 20 seconds");
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM batched").one().n, 1200, "the commit that reached the limit is its last");
  });

  it("answers a replay of its own key and refuses a new job, while it waits", async () => {
    const { store, job } = await atTheLimit(10);
    assert.equal(value(await store.jobSubmit(ME, { kind: "fill", params: { chunks: 10 }, requestKey: "run-2:s1" })).job.id, job.id);
    assert.equal(refusal(await store.jobSubmit(ME, { kind: "fill", params: { chunks: 2 }, requestKey: "run-3:s1" })).code, "write_limit_reached");
  });

  it("says in its answer only that it waits while the store is past its limit", async () => {
    const counter: JobHandler = { kind: "count", parse: (p) => p, run: async () => ({ result: null }) };
    const { store, storage, clock } = setup({ jobs: [counter], env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    const job = value(await store.jobSubmit(ME, { kind: "count", params: {}, requestKey: "k" })).job;
    assert.equal(job.waiting, null, "under its limit it does not wait");
    value(await store.exec(ME, { sql: "CREATE TABLE t (n INTEGER)" }));
    value(await store.exec(ME, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1200 }, (_, i) => i))] }));
    // Another writer took the store past its limit before this job's first chunk.
    assert.equal(value(await store.job(ME, job.id)).job.waiting?.code, "write_limit_reached", "a job in the queue waits too");
    await alarmsUntil(store, storage, clock, clock.now() + 60_000);
    assert.equal(value(await store.job(ME, job.id)).job.state, "queued");
    await alarmsUntil(store, storage, clock, NEXT_DAY + 60_000);
    const done = value(await store.job(ME, job.id)).job;
    assert.equal(done.state, "done");
    assert.equal(done.waiting, null, "a job that ended waits for nothing");
  });

  it("tells the ledger it is quiet until 00:00 UTC, and busy again once it goes on", async () => {
    const { store, storage, clock } = await atTheLimit(5);
    const stats = value(await store.stats(ME));
    assert.equal(stats.busy, false);
    assert.equal(stats.waitsUntil, NEXT_DAY);
    clock.advance(NEXT_DAY - clock.now());
    storage.alarm = null;
    await store.alarm();
    const going = value(await store.stats(ME));
    assert.equal(going.busy, true, "it goes on");
    assert.equal(going.waitsUntil, null);
    await alarmsUntil(store, storage, clock, clock.now() + 60_000);
    const ended = value(await store.stats(ME));
    assert.equal(ended.busy, false);
    assert.equal(ended.waitsUntil, null);
  });

  it("tells the ledger to look again within ten minutes while it waits on its organization's limit, which may be raised any time", async () => {
    const { store, clock } = await atTheLimit(5, { shared: true });
    const stats = value(await store.stats(ME));
    assert.equal(stats.busy, false);
    assert.equal(stats.waitsUntil, clock.now() + BUDGET_STATS_EVERY_MS);
  });
});

describe("a submit that names the call it is a later try of", () => {
  const KEY = "store_load:run-9:s1@";
  /** Writes 400 rows a chunk; a chunk of `failAt` fails its job at once. */
  const filler: JobHandler<{ chunks: number; failAt?: number; note?: string }, { at: number }> = {
    kind: "fill",
    parse: (p) => p as { chunks: number; failAt?: number },
    async run(ctx) {
      const at = (ctx.state?.at ?? 0) + 1;
      if (ctx.params.failAt === at) throw new StoreError(400, "bad_request", "This file cannot be read.");
      ctx.commit({ state: { at }, progress: { done: at, total: ctx.params.chunks } }, () => {
        ctx.sql.exec("CREATE TABLE IF NOT EXISTS filled (n INTEGER)");
        ctx.sql.exec("INSERT INTO filled SELECT value FROM json_each(?)", JSON.stringify(Array.from({ length: 400 }, (_, i) => i)));
      });
      return at >= ctx.params.chunks ? { result: { at } } : { more: true };
    },
  };
  const jobs = (storage: HostStorage) => Number(storage.sql.exec("SELECT count(*) AS n FROM _jobs").one().n);
  const NEXT_DAY = Date.parse("2026-11-08T00:00:00Z");

  it("answers the job of that call while it waits, past the limit too, and makes no second job", async () => {
    const { store, storage, clock } = setup({ jobs: [filler as JobHandler], env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    const params = { chunks: 10 };
    const job = value(await store.jobSubmit(ME, { kind: "fill", params, requestKey: KEY })).job;
    await alarmsUntil(store, storage, clock, clock.now() + 60_000);
    const body = { kind: "fill", params, requestKey: `${KEY}~finish1#toolu_a`, sameWorkAs: KEY };
    const answered = value(await store.jobSubmit(ME, body)).job;
    assert.equal(answered.id, job.id);
    assert.equal(answered.waiting?.code, "write_limit_reached");
    // The same call again: nothing was made under its key, so it answers the same way.
    assert.equal(value(await store.jobSubmit(ME, body)).job.id, job.id);
    assert.equal(jobs(storage), 1);
  });

  it("answers the job of that call once it ended, so a late try does not do the work again", async () => {
    const { store, storage, clock } = setup({ jobs: [filler as JobHandler] });
    const params = { chunks: 2 };
    const job = value(await store.jobSubmit(ME, { kind: "fill", params, requestKey: KEY })).job;
    await alarmsUntil(store, storage, clock, clock.now() + 60_000);
    assert.equal(value(await store.job(ME, job.id)).job.state, "done");
    assert.equal(value(await store.jobSubmit(ME, { kind: "fill", params, requestKey: `${KEY}~finish1#toolu_a`, sameWorkAs: KEY })).job.id, job.id);
    assert.equal(jobs(storage), 1);
  });

  it("goes on with a later try's job when the first one failed, and makes no third", async () => {
    const { store, storage, clock } = setup({ jobs: [filler as JobHandler], env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    const failing = { chunks: 10, failAt: 1 };
    const first = value(await store.jobSubmit(ME, { kind: "fill", params: failing, requestKey: KEY })).job;
    await alarmsUntil(store, storage, clock, clock.now() + 60_000);
    assert.equal(value(await store.job(ME, first.id)).job.state, "failed");
    // Try Again makes a job of its own, which reaches the limit and waits.
    const params = { chunks: 10 };
    const second = value(await store.jobSubmit(ME, { kind: "fill", params, requestKey: `${KEY}~try2`, sameWorkAs: KEY })).job;
    assert.notEqual(second.id, first.id);
    await alarmsUntil(store, storage, clock, clock.now() + 60_000);
    assert.equal(value(await store.job(ME, second.id)).job.waiting?.code, "write_limit_reached");
    // The next Try Again finds that job, not the failed one.
    const third = value(await store.jobSubmit(ME, { kind: "fill", params, requestKey: `${KEY}~try3`, sameWorkAs: KEY })).job;
    assert.equal(third.id, second.id);
    assert.equal(jobs(storage), 2);
    // After 00:00 UTC it has gone on by itself, and the next try still finds it.
    await alarmsUntil(store, storage, clock, NEXT_DAY + 60_000);
    assert.equal(value(await store.jobSubmit(ME, { kind: "fill", params, requestKey: `${KEY}~try4`, sameWorkAs: KEY })).job.id, second.id);
    assert.equal(jobs(storage), 2);
  });

  it("makes its own job for other work, under the limit, and holds it to the limit past it", async () => {
    const { store, storage, clock } = setup({ jobs: [filler as JobHandler], env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    const job = value(await store.jobSubmit(ME, { kind: "fill", params: { chunks: 10 }, requestKey: KEY })).job;
    // Before it writes anything, another call of the same step asks for something else.
    const other = value(await store.jobSubmit(ME, { kind: "fill", params: { chunks: 1 }, requestKey: `${KEY}~finish1#toolu_b`, sameWorkAs: KEY })).job;
    assert.notEqual(other.id, job.id);
    await alarmsUntil(store, storage, clock, clock.now() + 60_000);
    assert.equal(refusal(await store.jobSubmit(ME, { kind: "fill", params: { chunks: 2 }, requestKey: `${KEY}~finish1#toolu_c`, sameWorkAs: KEY })).code, "write_limit_reached");
    assert.equal(jobs(storage), 2);
  });

  it("finds a job only of the call it names", async () => {
    const { store, storage } = setup({ jobs: [filler as JobHandler] });
    const params = { chunks: 2 };
    value(await store.jobSubmit(ME, { kind: "fill", params, requestKey: `${KEY}x` }));
    value(await store.jobSubmit(ME, { kind: "fill", params, requestKey: "store_load:run-9:s1" }));
    const own = value(await store.jobSubmit(ME, { kind: "fill", params, requestKey: `${KEY}~try2`, sameWorkAs: KEY })).job;
    assert.equal(own.requestKey, `${KEY}~try2`);
    assert.equal(jobs(storage), 3);
  });

  it("with sameWorkOpen, answers a job still open, and does the work again once it ended", async () => {
    const { store, storage, clock } = setup({ jobs: [filler as JobHandler] });
    const params = { chunks: 2 };
    const base = "store_load:mcp:abc";
    const body = (n: number) => ({ kind: "fill", params, requestKey: `${base}~${n}`, sameWorkAs: base, sameWorkOpen: true });
    const job = value(await store.jobSubmit(ME, body(1))).job;
    assert.equal(value(await store.jobSubmit(ME, body(2))).job.id, job.id, "still open");
    await alarmsUntil(store, storage, clock, clock.now() + 60_000);
    assert.equal(value(await store.job(ME, job.id)).job.state, "done");
    assert.notEqual(value(await store.jobSubmit(ME, body(3))).job.id, job.id, "it ended: the same work is done again");
    assert.equal(jobs(storage), 2);
  });

  it("refuses a key that is not one", async () => {
    const { store } = setup({ jobs: [filler as JobHandler] });
    for (const sameWorkAs of ["", "x".repeat(301), 5, ["a"]]) {
      const r = refusal(await store.jobSubmit(ME, { kind: "fill", params: { chunks: 1 }, requestKey: "k", sameWorkAs }));
      assert.equal(r.code, "bad_request");
      assert.equal(r.error, "sameWorkAs takes a request key of 1 to 300 characters.");
    }
  });
});

describe("whose limit", () => {
  it("is the Worker's, and the default without one", async () => {
    assert.equal((await writes(setup().store)).limit, 2_000_000);
    const { store } = setup({ env: { STORE_DAILY_WRITE_LIMIT: "5000000" } });
    assert.deepEqual(await writes(store).then((w) => [w.limit, w.shared]), [5_000_000, false]);
  });

  it("takes any whole number of rows from the Worker, 0 to stop every write, and says in the log when its var is not one", async () => {
    assert.equal((await writes(setup({ env: { STORE_DAILY_WRITE_LIMIT: "10" } }).store)).limit, 10);
    assert.equal((await writes(setup({ env: { STORE_DAILY_WRITE_LIMIT: "250000000" } }).store)).limit, 250_000_000);
    assert.equal((await writes(setup({ env: { STORE_DAILY_WRITE_LIMIT: "" } }).store)).limit, WRITE_LIMIT_DEFAULT, "an empty var names no limit");
    const stopped = setup({ env: { STORE_DAILY_WRITE_LIMIT: " 0 " } }).store;
    assert.equal(refusal(await stopped.exec(ME, { sql: "CREATE TABLE t (n INTEGER)" })).code, "write_limit_reached");
    value(await stopped.catalog(ME));
    const typo = setup({ env: { STORE_DAILY_WRITE_LIMIT: "2,000,000" } });
    assert.equal((await writes(typo.store)).limit, WRITE_LIMIT_DEFAULT);
    await writes(typo.store);
    const told = typo.logs.filter((l) => l.at === "store.writes");
    assert.equal(told.length, 1, "once for the object");
    assert.equal(told[0]!.error, 'STORE_DAILY_WRITE_LIMIT is not a whole number of rows ("2,000,000"), so the store holds itself to 2,000,000 rows a day');
    assert.equal((await writes(setup({ env: { STORE_DAILY_WRITE_LIMIT: "lots" } }).store)).limit, WRITE_LIMIT_DEFAULT);
  });

  it("is its organization's once a caller's token names one, and keeps the first organization it heard", async () => {
    const budget = new FakeBudget(12_000_000);
    const { store, storage } = setup({ env: { STORE_DAILY_WRITE_LIMIT: "5000000" }, budget });
    const orgOf = () => storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'org'").toArray()[0]?.value ?? null;
    // No token has named its organization: the store holds itself alone to the Worker's limit.
    assert.deepEqual(await writes(store).then((w) => [w.limit, w.shared]), [5_000_000, false]);
    value(await store.exec(IN_ORG, { sql: "CREATE TABLE t (n INTEGER)" }));
    assert.equal(orgOf(), "org-1");
    assert.deepEqual(await writes(store).then((w) => [w.limit, w.shared]), [12_000_000, true]);
    value(await store.catalog({ ...IN_ORG, org: "org-2" }));
    value(await store.catalog({ ...IN_ORG, org: "not an id!" }));
    assert.equal(orgOf(), "org-1", "a store never moves to another organization");
  });

  it("holds a store to what its organization's other stores wrote", async () => {
    const budget = new FakeBudget(10_000);
    const { store, clock } = setup({ budget });
    value(await store.exec(IN_ORG, { sql: "CREATE TABLE t (n INTEGER)" }));
    budget.othersWrote(utcDay(clock.now()), 10_000);
    // It hears of them the next time it asks: an alarm asks once its answer is a minute old.
    value(await store.exec(IN_ORG, { sql: "INSERT INTO t VALUES (1)" }));
    clock.advance(BUDGET_ASK_EVERY_MS);
    await store.alarm();
    const r = refusal(await store.exec(IN_ORG, { sql: "INSERT INTO t VALUES (2)" }));
    assert.equal(r.code, "write_limit_reached");
    assert.match(r.error, /^This organization's stores have written [\d,]+ rows today \(UTC\), and their limit is 10,000 rows a day\./);
    // Reading and taking files go on.
    value(await store.catalog(IN_ORG));
  });

  it("asks its organization's budget before its first write since the object woke", async () => {
    const budget = new FakeBudget(10_000);
    const { store, make, clock } = setup({ budget });
    value(await store.exec(IN_ORG, { sql: "CREATE TABLE t (n INTEGER)" }));
    budget.othersWrote(utcDay(clock.now()), 10_000);
    // The platform starts the object again: it knows its organization, but nothing of its budget.
    const woke = make();
    assert.equal(refusal(await woke.exec(ME, { sql: "INSERT INTO t VALUES (1)" })).code, "write_limit_reached");
  });

  it("tells its organization's budget what it wrote: at once when 1,000 rows wait, and the rest by its alarm", async () => {
    const budget = new FakeBudget();
    const { store, storage, clock } = setup({ budget });
    const day = utcDay(clock.now());
    value(await store.exec(IN_ORG, { sql: "CREATE TABLE t (n INTEGER)" }));
    value(await store.exec(IN_ORG, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1200 }, (_, i) => i))] }));
    const told = () => budget.days.get(day) ?? 0;
    assert.ok(told() >= 1_200, `the call told it (${told()})`);
    const before = told();
    value(await store.exec(IN_ORG, { sql: "INSERT INTO t VALUES (1)" }));
    assert.equal(told(), before, "a few rows wait for the alarm");
    assert.ok(storage.alarm !== null && storage.alarm <= clock.now() + WRITE_KEEP_WITHIN_MS);
    await alarmsUntil(store, storage, clock, clock.now() + WRITE_KEEP_WITHIN_MS);
    assert.ok(told() > before, "the alarm told the rest");
    const kept = Number(storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = ?", writeCountKey(day)).one().value);
    assert.ok(told() >= kept - 2 && told() <= kept, `the budget heard what the store kept (${told()} of ${kept})`);
  });

  it("goes on writing while its budget is out of reach, and tells it later", async () => {
    const budget = new FakeBudget();
    const { store, storage, clock } = setup({ budget });
    const day = utcDay(clock.now());
    value(await store.exec(IN_ORG, { sql: "CREATE TABLE t (n INTEGER)" }));
    budget.unreachable = true;
    value(await store.exec(IN_ORG, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1200 }, (_, i) => i))] }));
    await alarmsUntil(store, storage, clock, clock.now() + WRITE_KEEP_WITHIN_MS);
    assert.equal(budget.days.get(day) ?? 0, 0, "it heard nothing");
    budget.unreachable = false;
    value(await store.exec(IN_ORG, { sql: "INSERT INTO t VALUES (1)" }));
    await alarmsUntil(store, storage, clock, clock.now() + WRITE_KEEP_WITHIN_MS);
    assert.ok((budget.days.get(day) ?? 0) >= 1_200, "it heard every row once it could be reached");
  });

  it("lets a raised organization limit take writes again the same day, once the store asks again", async () => {
    const budget = new FakeBudget(1_000);
    const { store, clock } = setup({ budget });
    value(await store.exec(IN_ORG, { sql: "CREATE TABLE t (n INTEGER)" }));
    value(await store.exec(IN_ORG, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1200 }, (_, i) => i))] }));
    assert.equal(refusal(await store.exec(IN_ORG, { sql: "INSERT INTO t VALUES (1)" })).code, "write_limit_reached");
    budget.limit = 50_000;
    // Within a minute of the budget's answer, the store holds itself to that answer.
    assert.equal(refusal(await store.exec(IN_ORG, { sql: "INSERT INTO t VALUES (1)" })).code, "write_limit_reached");
    // A write past the limit asks again once the answer is a minute old.
    clock.advance(BUDGET_ASK_EVERY_MS);
    value(await store.exec(IN_ORG, { sql: "INSERT INTO t VALUES (1)" }));
  });
});

describe("what a job is about to write, and what it wrote", () => {
  const loadLike: JobHandler = { kind: "load", parse: (p) => p, run: async () => ({ result: { tables: [] } }) };

  async function upload(store: StoreHandler, r2: HostFiles, name: string, body: string): Promise<string> {
    const f = value(await store.fileCreate(ME, { name, size: body.length }));
    const t = value(await store.filePartTarget(ME, f.file.id, 1));
    const p = await r2.resumeMultipartUpload(t.key, t.uploadId).uploadPart(1, body);
    value(await store.fileComplete(ME, f.file.id, { parts: [{ n: 1, etag: p.etag }] }));
    return f.file.id;
  }
  /** A CSV of `rows` rows of 64 bytes each, after a header line of 64. */
  const csvOf = (rows: number): string => `${"h".repeat(63)}\n${`${"x".repeat(63)}\n`.repeat(rows)}`;

  it("says it when the job is submitted, before its first write, with its cost, and keeps it on the job", async () => {
    const { store, r2, logs } = setup({ jobs: [loadLike] });
    // 20,000 rows: more than the 64 KB an estimate reads, so the lines it reads speak for the rest.
    const id = await upload(store, r2, "permits.csv", csvOf(20_000));
    const job = value(await store.jobSubmit(ME, { kind: "load", params: { files: [{ id, name: "permits.csv" }] }, requestKey: "run-3:s1" })).job;
    assert.deepEqual(job.estimate, { rows: 20_000, basis: "the lines in its file" });
    assert.equal(job.rowsWritten, 0);
    const line = logs.find((l) => l.event === "estimate");
    assert.ok(line, "a log line before the first write");
    assert.equal(line.at, "store.job");
    assert.equal(line.store, A);
    assert.equal(line.job, job.id);
    assert.equal(line.kind, "load");
    assert.equal(line.rows, 20_000);
    assert.equal(line.dollars, 0.02);
    assert.equal(line.dailyLimit, WRITE_LIMIT_DEFAULT);
    assert.equal(typeof line.writtenToday, "number");
  });

  it("counts every line of a small file, and a workbook by its size", async () => {
    const { store, r2 } = setup({ jobs: [loadLike] });
    const small = await upload(store, r2, "fees.csv", "No,Fee\nF-1,10\nF-2,20\nF-3,30");
    const book = await upload(store, r2, "parcels.xlsx", "z".repeat(600_000));
    const job = value(await store.jobSubmit(ME, { kind: "load", params: { files: [{ id: small, name: "fees.csv" }, { id: book, name: "parcels.xlsx" }] }, requestKey: "run-5:s1" })).job;
    // Three rows after the header, and 600 KB of workbook at about 60 bytes a row.
    assert.deepEqual(job.estimate, { rows: 10_003, basis: "the lines in 1 of its 2 files, and the others' sizes" });
  });

  it("counts lines as the delimited reader ends them: LF, CR LF, or a CR alone", async () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    assert.equal(linesIn(bytes("No,Fee\rF-1,10\rF-2,20"), true), 3, "an old Mac's CSV");
    assert.equal(linesIn(bytes("No,Fee\r\nF-1,10\r\n"), true), 2);
    assert.equal(linesIn(bytes("No,Fee\nF-1,10"), true), 2);
    assert.equal(linesIn(bytes("No,Fee\rF-1,"), false), 1, "a sample counts the line ends it holds");
    const { store, r2 } = setup({ jobs: [loadLike] });
    const mac = await upload(store, r2, "fees.csv", "No,Fee\rF-1,10\rF-2,20\r");
    const job = value(await store.jobSubmit(ME, { kind: "load", params: { files: [{ id: mac, name: "fees.csv" }] }, requestKey: "run-6:s1" })).job;
    assert.deepEqual(job.estimate, { rows: 2, basis: "the lines in its file" });
  });

  it("estimates a SHAPE from its largest source table", () => {
    const view = { file: () => null, tableRows: (name: string) => ({ permits: 2_000_000, fees: 300_000 })[name] ?? null, sample: async () => new Uint8Array(0) };
    const shape = KIND_ESTIMATES.get("shape")!;
    assert.deepEqual(shape({ sources: JSON.stringify([["fees", ["a"]], ["permits", ["b"]], ["gone", ["c"]]]) }, view), { rows: 2_000_000, basis: "its largest source table, permits" });
    assert.equal(shape({ sources: "not json" }, view), null);
    assert.equal(shape({ sources: JSON.stringify([["gone", []]]) }, view), null);
  });

  it("takes a handler's own estimate first, and keeps a job without one when its kind cannot say", async () => {
    const own: JobHandler = { kind: "pull", parse: (p) => p, run: async () => ({ result: null }), estimate: () => ({ rows: 812, basis: "the rows that changed" }) };
    const none: JobHandler = { kind: "profile", parse: (p) => p, run: async () => ({ result: null }) };
    const { store } = setup({ jobs: [own, none] });
    assert.deepEqual(value(await store.jobSubmit(ME, { kind: "pull", params: {}, requestKey: "a" })).job.estimate, { rows: 812, basis: "the rows that changed" });
    assert.equal(value(await store.jobSubmit(ME, { kind: "profile", params: {}, requestKey: "b" })).job.estimate, null);
  });

  it("counts what each chunk wrote, and says it in the job's history, with no dollar amount", async () => {
    const filler: JobHandler<{ chunks: number }, { at: number }> = {
      kind: "fill",
      parse: (p) => p as { chunks: number },
      estimate: () => ({ rows: 900, basis: "three chunks of 300" }),
      async run(ctx) {
        const at = (ctx.state?.at ?? 0) + 1;
        ctx.commit({ state: { at }, progress: { done: at, total: 3 } }, () => {
          ctx.sql.exec("CREATE TABLE IF NOT EXISTS filled (n INTEGER)");
          ctx.sql.exec("INSERT INTO filled SELECT value FROM json_each(?)", JSON.stringify(Array.from({ length: 300 }, (_, i) => i)));
        });
        return at >= ctx.params.chunks ? { result: { at } } : { more: true };
      },
    };
    const { store, storage } = setup({ jobs: [filler as JobHandler] });
    const job = value(await store.jobSubmit(ME, { kind: "fill", params: { chunks: 3 }, requestKey: "run-4:s1" })).job;
    await runAlarms(store, storage);
    const done = value(await store.job(ME, job.id)).job;
    assert.equal(done.state, "done");
    const wrote = done.rowsWritten ?? 0;
    // 900 rows, the table, and the job's progress at each commit.
    assert.ok(wrote >= 900 && wrote < 960, `rows written (${wrote})`);
    const note = String(storage.sql.exec("SELECT note FROM _history WHERE ref = ? ORDER BY at DESC LIMIT 1", job.id).one().note);
    assert.equal(note, `fill finished: wrote ${wrote} rows; about 900 were estimated`);
  });
});

describe("a restore", () => {
  itRestores("keeps today's count as it was when it was asked for", async () => {
    const { store, storage, clock, make } = setup({ env: { STORE_DAILY_WRITE_LIMIT: "2000" } });
    value(await store.migrate(ME, { id: "0000_t", sql: "CREATE TABLE t (n INTEGER)" }));
    clock.advance(1_000);
    const point = value(await store.migrate(ME, { id: "0001_u", sql: "CREATE TABLE u (n INTEGER)" })).migration.restorePoint;
    assert.ok(point);
    clock.advance(1_000);
    value(await store.exec(ME, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 2100 }, (_, i) => i))] }));
    const before = await writes(store);
    assert.ok(before.rows >= 2100);
    value(await store.restore(ADMIN, { at: point! }));
    store.restart();
    storage.restart();
    const again = make();
    const after = await writes(again);
    assert.ok(after.rows >= before.rows, `the restore gives no writes back (${after.rows} < ${before.rows})`);
    assert.equal(after.limit, 2_000);
    assert.equal(refusal(await again.exec(ME, { sql: "INSERT INTO t VALUES (1)" })).code, "write_limit_reached");
  });
});

describe("the refusal's words", () => {
  it("say the count, the limit and when writes come back, no dollar amount, and who may raise it only in the deployer's words", () => {
    const writes = { day: "2026-11-08", rows: 2_004_118, limit: 2_000_000, shared: false };
    assert.equal(
      writeLimitWords(writes),
      "This store has written 2,004,118 rows today (UTC), and its limit is 2,000,000 rows a day. It takes more writes after 00:00 UTC, or once its daily write limit is raised.",
    );
    assert.match(writeLimitWords(writes, "Ask the app's owner."), /is raised\. Ask the app's owner\.$/);
    assert.doesNotMatch(writeLimitWords(writes), /\$/);
    assert.equal(
      writeLimitWords({ ...writes, shared: true }, "Ask your support team."),
      "This organization's stores have written 2,004,118 rows today (UTC), and their limit is 2,000,000 rows a day. They take more writes after 00:00 UTC, or once the organization's daily write limit is raised. Ask your support team.",
    );
  });
});

/** A bucket whose reads wait until the test lets them go: other calls run meanwhile, as on the platform. */
function pausingBucket(r2: HostFiles): { bucket: StoreFiles; hold(): void; release(): void } {
  const bucket = r2.asBucket();
  const get = bucket.get.bind(bucket);
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  (bucket as { get: typeof bucket.get }).get = (async (...args: Parameters<typeof bucket.get>) => {
    if (gate) await gate;
    return get(...args);
  }) as typeof bucket.get;
  return {
    bucket,
    hold() {
      gate = new Promise<void>((resolve) => (open = resolve));
    },
    release() {
      gate = null;
      open();
    },
  };
}

async function uploadTo(store: StoreHandler, r2: HostFiles, name: string, body: string): Promise<string> {
  const f = value(await store.fileCreate(ME, { name, size: body.length }));
  const t = value(await store.filePartTarget(ME, f.file.id, 1));
  const p = await r2.resumeMultipartUpload(t.key, t.uploadId).uploadPart(1, body);
  value(await store.fileComplete(ME, f.file.id, { parts: [{ n: 1, etag: p.etag }] }));
  return f.file.id;
}

describe("calls that run while a job waits on its bucket", () => {
  it("never count toward the job: a job's rows are its own statements'", async () => {
    const r2 = filesOf();
    const paused = pausingBucket(r2);
    const reader: JobHandler<{ file: string }> = {
      kind: "read",
      parse: (p) => p as { file: string },
      async run(ctx) {
        await ctx.files.read(ctx.params.file, 0, 4);
        ctx.commit({ state: null as never, progress: { done: 1, total: 1 } }, () => {
          ctx.sql.exec("CREATE TABLE IF NOT EXISTS got (n INTEGER)");
          ctx.sql.exec("INSERT INTO got SELECT value FROM json_each('[1,2,3,4,5,6,7,8,9,10]')");
        });
        return { result: null };
      },
    };
    const clock = new FakeClock();
    const storage = host().storage();
    storage.now = clock.now;
    const store = new StoreHandler(stateOf(storage) as never, { FILES: paused.bucket }, { now: clock.now, randomHex: countingHex, jobs: new Map([["read", reader as JobHandler]]) });
    const file = await uploadTo(store, r2, "a.csv", "a,b\n1,2\n");
    value(await store.exec(ME, { sql: "CREATE TABLE other (n INTEGER)" }));
    const job = value(await store.jobSubmit(ME, { kind: "read", params: { file }, requestKey: "k" })).job;
    paused.hold();
    storage.alarm = null;
    const chunk = store.alarm();
    await new Promise((r) => setTimeout(r, 0));
    // While the chunk waits on its read, a person writes 500 rows of their own.
    value(await store.exec(ME, { sql: "INSERT INTO other SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 500 }, (_, i) => i))] }));
    paused.release();
    await chunk;
    const done = value(await store.job(ME, job.id)).job;
    assert.equal(done.state, "done");
    assert.ok((done.rowsWritten ?? 0) >= 10 && (done.rowsWritten ?? 0) < 20, `the job's own rows (${done.rowsWritten})`);
  });

  it("refuse a submit when the store was deleted, or began a restore, while its estimate read a file", async () => {
    const r2 = filesOf();
    const paused = pausingBucket(r2);
    const loadLike: JobHandler = { kind: "load", parse: (p) => p, run: async () => ({ result: null }) };
    const clock = new FakeClock();
    const storage = host().storage();
    storage.now = clock.now;
    const store = new StoreHandler(stateOf(storage) as never, { FILES: paused.bucket }, { now: clock.now, randomHex: countingHex, jobs: new Map([["load", loadLike]]) });
    const file = await uploadTo(store, r2, "permits.csv", "No\nBP-1\nBP-2\n");
    paused.hold();
    const submit = store.jobSubmit(ME, { kind: "load", params: { files: [{ id: file, name: "permits.csv" }] }, requestKey: "k" });
    await new Promise((r) => setTimeout(r, 0));
    // A restore readied while the estimate reads the file.
    store.core.sql.exec("INSERT INTO _meta (key, value) VALUES ('restoring', 'tok')");
    paused.release();
    const refused = refusal(await submit);
    assert.equal(refused.code, "store_restoring");
    assert.equal(storage.sql.exec("SELECT count(*) AS n FROM _jobs").one().n, 0, "no job was made");
  });
});

describe("what the review found", () => {
  it("lets an app's batch that starts under the limit finish, and refuses the next", async () => {
    const { store } = setup({ env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    value(await store.migrate(ME, { id: "0000_notes", sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)" }));
    value(await store.exec(ME, { sql: "INSERT INTO notes (body) SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 900 }, (_, i) => `n${i}`))] }));
    const app: StoreCaller = { storeId: A, actor: "app:notes/u-1" };
    const batch = [
      { sql: "INSERT INTO notes (body) SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 150 }, (_, i) => `m${i}`))], method: "run" },
      { sql: "INSERT INTO notes (body) VALUES (?)", params: ["last"], method: "run" },
    ];
    assert.equal(value(await store.appBatch(app, batch)).length, 2, "the whole batch, past the limit by its own rows");
    assert.equal(refusal(await store.appBatch(app, batch)).code, "write_limit_reached");
  });

  it("keeps the day's count with a job's commits, so a store that stops in the middle of a chunk still counts its rows", async () => {
    const stuck: JobHandler = {
      kind: "stuck",
      parse: (p) => p,
      async run(ctx) {
        ctx.commit({ state: null, progress: { done: 1, total: 2 } }, () => {
          ctx.sql.exec("CREATE TABLE IF NOT EXISTS big (n INTEGER)");
          ctx.sql.exec("INSERT INTO big SELECT value FROM json_each(?)", JSON.stringify(Array.from({ length: 1500 }, (_, i) => i)));
        });
        // The platform stops the object here: the alarm's end never comes.
        await new Promise(() => {});
        return { result: null };
      },
    };
    const { store, storage, make } = setup({ jobs: [stuck] });
    value(await store.jobSubmit(ME, { kind: "stuck", params: {}, requestKey: "k" }));
    storage.alarm = null;
    void store.alarm();
    await new Promise((r) => setTimeout(r, 0));
    const again = make();
    assert.ok((await writes(again)).rows >= 1500, "the committed rows are in the day's count after a restart");
  });

  it("keeps nothing of a deleted store's count but its mark", async () => {
    const { store, storage } = setup();
    value(await store.exec(ME, { sql: "CREATE TABLE t (n INTEGER)" }));
    value(await store.exec(ME, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 900 }, (_, i) => i))] }));
    value(await store.destroy(ADMIN));
    assert.deepEqual(kept(storage), []);
    assert.equal(store.core.meter.unkept, 0);
  });

  it("answers a migration already applied past the limit, and refuses a new one", async () => {
    const { store } = setup({ env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    value(await store.migrate(ME, { id: "0000_t", sql: "CREATE TABLE t (n INTEGER)" }));
    value(await store.exec(ME, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1100 }, (_, i) => i))] }));
    assert.equal(value(await store.migrate(ME, { id: "0000_t", sql: "CREATE TABLE t (n INTEGER)" })).applied, false);
    assert.equal(refusal(await store.migrate(ME, { id: "0001_u", sql: "CREATE TABLE u (n INTEGER)" })).code, "write_limit_reached");
  });

  it("keeps a job's count of tries while it waits at the limit, and clears it with the next chunk that runs", async () => {
    let throws = true;
    const flaky: JobHandler = {
      kind: "flaky",
      parse: (p) => p,
      async run(ctx) {
        if (throws) {
          throws = false;
          throw new Error("a passing failure");
        }
        ctx.commit({ state: null, progress: { done: 1, total: 1 } }, () => void ctx.sql.exec("SELECT 1"));
        return { more: true };
      },
    };
    const { store, storage, clock } = setup({ jobs: [flaky], env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    const job = value(await store.jobSubmit(ME, { kind: "flaky", params: {}, requestKey: "k" })).job;
    const marks = () => storage.sql.exec("SELECT tries FROM _jobs WHERE id = ?", job.id).one().tries;
    storage.alarm = null;
    await store.alarm();
    assert.equal(marks(), 1);
    value(await store.exec(ME, { sql: "CREATE TABLE t (n INTEGER)" }));
    value(await store.exec(ME, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1100 }, (_, i) => i))] }));
    clock.advance(10_000);
    storage.alarm = null;
    await store.alarm();
    const waiting = value(await store.job(ME, job.id)).job;
    assert.equal(waiting.state, "running");
    assert.equal(waiting.waiting?.code, "write_limit_reached");
    assert.equal(marks(), 1, "waiting is not a try");
    clock.t = Date.parse("2026-11-08T00:00:00Z");
    storage.alarm = null;
    await store.alarm();
    assert.equal(marks(), 0, "the chunk that ran clears it");
  });

  it("reads the first bytes of at most 8 files, and sizes the rest by the lines those held", async () => {
    const reads: string[] = [];
    const view = {
      file: (id: string) => ({ name: `${id}.csv`, size: 64_000 }),
      tableRows: () => null,
      sample: async (id: string) => (reads.push(id), new TextEncoder().encode(`${"y".repeat(63)}\n`.repeat(1000))),
    };
    const load = KIND_ESTIMATES.get("load")!;
    const files = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, name: `f${i}.csv` }));
    const said = await load({ files }, view);
    assert.equal(reads.length, 8);
    assert.equal(said?.basis, "the lines in 8 of its 20 files, and the others' sizes");
    // Every file holds 1,000 lines of 64 bytes, read or not.
    assert.ok(Math.abs((said?.rows ?? 0) - 20 * 1000) <= 20, `${said?.rows}`);
  });
});
