// Live rows: a run's socket gets the run's frame at once (its jobs and the newest rows of the table
// it writes), again as a job is submitted and its chunks commit, at most every LIVE_EVERY_MS, and at
// each chunk's end; a socket of another run gets nothing; a socket whose token ended is closed with
// LIVE_TOKEN_ENDED; a store with no hibernation API takes no socket; a frame that fails harms no
// job; and a deleted store closes its sockets.

import { describe, it, fakeTimers, hasFakeTimers, host, itWhere, stateOf, filesOf, type HostState, type HostStorage } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import type { StoreDeps } from "./core.js";
import { StoreHandler } from "./handler.js";
import { LIVE_EVERY_MS, LIVE_ROWS, LIVE_TOKEN_ENDED, liveCallerOf, type LiveFrame, type LiveSocket } from "./live.js";
import { runOfParams } from "./jobs/runner.js";
import type { JobHandler } from "./jobs/types.js";
import type { StoreCaller, StoreResult } from "./types.js";

const A = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ME: StoreCaller = { storeId: A, actor: "user:u-1" };
const RUN = "mr-live-1";
const HOUR = 3_600_000;

class FakeSocket implements LiveSocket {
  sent: LiveFrame[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private attachment: unknown = null;
  send(message: string): void {
    this.sent.push(JSON.parse(message) as LiveFrame);
  }
  close(code?: number, reason?: string): void {
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
  }
  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

/** The store's state with the hibernation API's sockets, by tag. */
type LiveState = HostState & { readonly sockets: { ws: FakeSocket; tags: string[] }[] };
function liveState(storage: HostStorage): LiveState {
  const sockets: LiveState["sockets"] = [];
  return Object.assign(stateOf(storage), {
    sockets,
    acceptWebSocket(ws: FakeSocket, tags: string[] = []): void {
      sockets.push({ ws, tags });
    },
    getWebSockets(tag?: string): FakeSocket[] {
      return sockets.filter((s) => (tag === undefined || s.tags.includes(tag)) && !s.ws.closed).map((s) => s.ws);
    },
  });
}

/** A job that writes `rows` rows into `permits` (or `table`) for its run, `per` rows a commit, then commits the table. */
const fill: JobHandler<{ madeBy: { runId: string; step: string }; rows: number; per: number; table?: string }, { at: number }, unknown> = {
  kind: "fill",
  parse: (params) => params as never,
  async run(ctx) {
    const name = ctx.params.table ?? "permits";
    const fresh = ctx.state ? `${name}__new` : ctx.tables.begin(name);
    if (!ctx.state) ctx.sql.exec(`CREATE TABLE ${fresh} (permit_no TEXT, fee INTEGER)`);
    let at = ctx.state?.at ?? 0;
    // One commit per call: the test runs the chunks itself and moves the clock between them.
    const next = Math.min(ctx.params.rows, at + ctx.params.per);
    ctx.commit({ state: { at: next }, progress: { done: next, total: ctx.params.rows } }, () => {
      for (let i = at; i < next; i++) ctx.sql.exec(`INSERT INTO ${fresh} VALUES (?, ?)`, `BP-${1000 + i}`, i * 10);
    });
    at = next;
    if (at < ctx.params.rows) return { more: true };
    return { result: await ctx.tables.commit(name, { group: "Cleaned", madeBy: ctx.params.madeBy }) };
  },
};

/** A job whose table has a column named ROWID, as a town's file can, and a long text value. */
const shaped: JobHandler<{ madeBy: { runId: string; step: string } }, { at: number }, unknown> = {
  kind: "shaped",
  parse: (params) => params as never,
  async run(ctx) {
    const fresh = ctx.tables.begin("permits");
    ctx.sql.exec(`CREATE TABLE ${fresh} (ROWID TEXT, note TEXT)`);
    ctx.commit({ state: { at: 3 }, progress: { done: 3, total: 3 } }, () => {
      for (const id of ["R-01", "R-99", "R-07"]) ctx.sql.exec(`INSERT INTO ${fresh} VALUES (?, ?)`, id, "x".repeat(500));
    });
    return { result: await ctx.tables.commit("permits", { group: "Cleaned", madeBy: ctx.params.madeBy }) };
  },
};

/** A job that writes a row as LOAD does: the file's id, the row's place in it, its values, and its extra values as JSON. */
const loadLike: JobHandler<{ madeBy: { runId: string; step: string } }, { at: number }, unknown> = {
  kind: "load-like",
  parse: (params) => params as never,
  async run(ctx) {
    const fresh = ctx.tables.begin("permits");
    ctx.sql.exec(`CREATE TABLE ${fresh} (_file TEXT, _row INTEGER, permit_no TEXT, _extra TEXT)`);
    ctx.commit({ state: { at: 1 }, progress: { done: 1, total: 1 } }, () => {
      ctx.sql.exec(`INSERT INTO ${fresh} VALUES (?, ?, ?, ?)`, "fil_1", 2, "BP-1000", '{"Notes":"Deck"}');
    });
    return { result: await ctx.tables.commit("permits", { group: "Cleaned", madeBy: ctx.params.madeBy }) };
  },
};

/** A job that makes `ready`, a view of the `permits` a job before it made. */
const viewed: JobHandler<{ madeBy: { runId: string; step: string } }, unknown, unknown> = {
  kind: "viewed",
  parse: (params) => params as never,
  async run(ctx) {
    return { result: await ctx.tables.makeView("ready", "SELECT permit_no FROM permits", { group: "Ready", madeBy: ctx.params.madeBy }) };
  },
};

/** A job that removes the first row of `permits` in place, as a SHAPE's run by changed rows does. */
const trimmed: JobHandler<{ madeBy: { runId: string; step: string } }, unknown, unknown> = {
  kind: "trimmed",
  parse: (params) => params as never,
  async run(ctx) {
    const made = await ctx.tables.changed("permits", { madeBy: ctx.params.madeBy, note: "One row removed" }, () => {
      ctx.sql.exec("DELETE FROM permits WHERE permit_no = 'BP-1000'");
      return { removed: ["BP-1000"] };
    });
    return { result: made };
  },
};

function setup(o: { live?: boolean; log?: (line: Record<string, unknown>) => void } = {}) {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = o.live === false ? stateOf(storage) : liveState(storage);
  const deps: StoreDeps = {
    now: clock.now,
    randomHex: countingHex,
    ...(o.log ? { log: o.log } : {}),
    jobs: new Map([
      [fill.kind, fill as JobHandler],
      [loadLike.kind, loadLike as JobHandler],
      [shaped.kind, shaped as JobHandler],
      [viewed.kind, viewed as JobHandler],
      [trimmed.kind, trimmed as JobHandler],
    ]),
  };
  const store = new StoreHandler(state as never, { FILES: filesOf().asBucket() }, deps);
  return { clock, state, store };
}

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

const caller = (clockNow: number, runId = RUN) => ({ ...ME, runId, until: clockNow + HOUR });
const last = (ws: FakeSocket): LiveFrame => ws.sent.at(-1)!;

describe("a run's live socket", () => {
  it("is sent the run's frame at once: no job yet, no table", async () => {
    const { clock, store } = setup();
    const ws = new FakeSocket();
    value(await store.watchRun(caller(clock.now()), ws));
    assert.deepEqual(ws.sent, [{ runId: RUN, at: new Date(clock.now()).toISOString(), jobs: [], current: null, table: null }]);
  });

  it("is sent the newest rows of the table the run's job writes, as its chunks commit, and the table once it is made", async () => {
    const { clock, store } = setup();
    value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: RUN, step: "s2" }, rows: 120, per: 50 }, requestKey: "k-1" }));
    const ws = new FakeSocket();
    value(await store.watchRun(caller(clock.now()), ws));
    assert.equal(last(ws).jobs[0]!.state, "queued");

    await store.alarm();
    const first = last(ws);
    assert.equal(first.jobs[0]!.state, "running");
    assert.deepEqual(first.jobs[0]!.progress, { done: 50, total: 120 });
    assert.equal(first.table?.name, "permits");
    assert.equal(first.table?.writing, true);
    assert.equal(first.table?.count, 50);
    assert.deepEqual(first.table?.columns, ["permit_no", "fee"]);
    // Newest first.
    assert.deepEqual(first.table?.rows[0], ["BP-1049", 490]);

    clock.advance(LIVE_EVERY_MS);
    await store.alarm();
    clock.advance(LIVE_EVERY_MS);
    await store.alarm();
    const done = last(ws);
    assert.equal(done.jobs[0]!.state, "done");
    assert.deepEqual(done.table && { name: done.table.name, writing: done.table.writing, count: done.table.count }, { name: "permits", writing: false, count: 120 });
    assert.equal(done.table?.rows.length, LIVE_ROWS);
  });

  it("is sent at most one frame every LIVE_EVERY_MS while commits come faster, and one at each chunk's end", async () => {
    const { clock, store } = setup();
    value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: RUN, step: "s2" }, rows: 400, per: 50 }, requestKey: "k-2" }));
    const ws = new FakeSocket();
    value(await store.watchRun(caller(clock.now()), ws));
    const before = ws.sent.length;
    // Three chunks in the same instant: the first commit sends; every later commit is held, and each
    // chunk's end sends what it held, since a chunk's end moves its job on.
    await store.alarm();
    await store.alarm();
    await store.alarm();
    assert.equal(ws.sent.length - before, 4);
    assert.equal(last(ws).table?.count, 150);
    // Commits between two chunks' ends, in the same instant, send nothing until the next end.
    store.liveRuns.changed(RUN);
    store.liveRuns.changed(RUN);
    assert.equal(ws.sent.length - before, 4);
    store.liveRuns.chunkEnded(RUN);
    assert.equal(ws.sent.length - before, 5);
  });

  itWhere(hasFakeTimers(), "this test runner cannot put setTimeout in a test's hand")("sends what the wait held back at its end, without waiting for another commit", () =>
    fakeTimers(async (timers) => {
      const { clock, store } = setup();
      value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: RUN, step: "s2" }, rows: 400, per: 50 }, requestKey: "k-8" }));
      const ws = new FakeSocket();
      value(await store.watchRun(caller(clock.now()), ws));
      await store.alarm();
      const before = ws.sent.length;
      store.liveRuns.changed(RUN);
      store.liveRuns.changed(RUN);
      assert.equal(ws.sent.length, before, "the wait holds them back");
      clock.advance(LIVE_EVERY_MS);
      timers.tick(LIVE_EVERY_MS);
      assert.equal(ws.sent.length, before + 1, "one frame for both");
    }),
  );

  it("leaves out LOAD's file id and extra values, and keeps the row's place in its file", async () => {
    const { clock, store } = setup();
    value(await store.jobSubmit(ME, { kind: "load-like", params: { madeBy: { runId: RUN, step: "s1" } }, requestKey: "k-5" }));
    const ws = new FakeSocket();
    value(await store.watchRun(caller(clock.now()), ws));
    await store.alarm();
    assert.deepEqual(last(ws).table && { columns: last(ws).table!.columns, rows: last(ws).table!.rows }, { columns: ["_row", "permit_no"], rows: [[2, "BP-1000"]] });
  });

  it("stands on the newest table a run made when the run ends with a view, and counts a table changed in place", async () => {
    const { clock, store } = setup();
    value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: RUN, step: "s1" }, rows: 10, per: 10 }, requestKey: "k-a" }));
    await store.alarm();
    value(await store.jobSubmit(ME, { kind: "viewed", params: { madeBy: { runId: RUN, step: "s2" } }, requestKey: "k-b" }));
    await store.alarm();
    // A view has no rowid: a frame read from it could not be built, and the socket would be refused.
    const ws = new FakeSocket();
    value(await store.watchRun(caller(clock.now()), ws));
    assert.equal(last(ws).table?.name, "permits");
    value(await store.jobSubmit(ME, { kind: "trimmed", params: { madeBy: { runId: RUN, step: "s3" } }, requestKey: "k-c" }));
    clock.advance(LIVE_EVERY_MS);
    await store.alarm();
    // The first row went, so the top rowid is still 10; the table holds 9.
    const t = last(ws).table!;
    assert.deepEqual([t.name, t.writing, t.count], ["permits", false, 9]);
  });

  it("shows the table the job the store is on writes, and until it begins one, the newest the run made", async () => {
    const { clock, store } = setup();
    value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: RUN, step: "s2" }, rows: 10, per: 10 }, requestKey: "k-6" }));
    await store.alarm();
    value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: RUN, step: "s3" }, rows: 100, per: 50, table: "inspections" }, requestKey: "k-7" }));
    const ws = new FakeSocket();
    value(await store.watchRun(caller(clock.now()), ws));
    const shape = (f: LiveFrame) => f.table && { name: f.table.name, writing: f.table.writing, count: f.table.count };
    // The second job has begun no table yet: the frame stands on the table the run made, as made.
    assert.deepEqual(last(ws).jobs.map((j) => j.state), ["done", "queued"]);
    assert.equal(last(ws).current, last(ws).jobs[1]!.id);
    assert.deepEqual(shape(last(ws)), { name: "permits", writing: false, count: 10 });
    clock.advance(LIVE_EVERY_MS);
    await store.alarm();
    assert.deepEqual(shape(last(ws)), { name: "inspections", writing: true, count: 50 });
    clock.advance(LIVE_EVERY_MS);
    await store.alarm();
    assert.deepEqual(shape(last(ws)), { name: "inspections", writing: false, count: 100 });
    assert.equal(last(ws).current, null);
  });

  it("follows the job the store is running when the run has several open, as the store takes them in order", async () => {
    const { clock, store } = setup();
    const params = (table: string) => ({ madeBy: { runId: RUN, step: `s-${table}` }, rows: 100, per: 50, table });
    value(await store.jobSubmit(ME, { kind: "fill", params: params("a_tbl"), requestKey: "k-a" }));
    clock.advance(1);
    value(await store.jobSubmit(ME, { kind: "fill", params: params("b_tbl"), requestKey: "k-b" }));
    const ws = new FakeSocket();
    value(await store.watchRun(caller(clock.now()), ws));
    await store.alarm();
    const frame = last(ws);
    assert.deepEqual(frame.jobs.map((j) => j.state), ["running", "queued"]);
    assert.equal(frame.current, frame.jobs[0]!.id);
    assert.equal(frame.table?.name, "a_tbl");
    assert.equal(frame.table?.count, 50);
  });

  it("hears of a job submitted while another run's job holds the store", async () => {
    const { clock, store } = setup();
    value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: "mr-other", step: "s1" }, rows: 100, per: 50 }, requestKey: "k-9" }));
    const ws = new FakeSocket();
    value(await store.watchRun(caller(clock.now()), ws));
    assert.deepEqual(last(ws).jobs, []);
    value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: RUN, step: "s1" }, rows: 10, per: 10, table: "mine" }, requestKey: "k-10" }));
    assert.equal(ws.sent.length, 2);
    assert.deepEqual(last(ws).jobs.map((j) => j.state), ["queued"]);
  });

  it("orders by the real rowid and counts right when a town's file has a ROWID column, and cuts long text", async () => {
    const { clock, store } = setup();
    value(await store.jobSubmit(ME, { kind: "shaped", params: { madeBy: { runId: RUN, step: "s1" } }, requestKey: "k-11" }));
    const ws = new FakeSocket();
    value(await store.watchRun(caller(clock.now()), ws));
    await store.alarm();
    const t = last(ws).table!;
    assert.deepEqual(t.columns, ["ROWID", "note"]);
    assert.equal(t.count, 3);
    assert.deepEqual(t.rows.map((r) => r[0]), ["R-07", "R-99", "R-01"], "newest first, by when each row was written");
    assert.equal((t.rows[0]![1] as string).length, 120);
    assert.ok((t.rows[0]![1] as string).endsWith("…"));
  });

  it("finds a run's jobs through its index, not by reading every job", () => {
    const { store } = setup();
    const plan = store.core.sql
      .exec<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id FROM _jobs WHERE json_extract(params, '$.madeBy.runId') = ? ORDER BY created_at, id", RUN)
      .toArray()
      .map((row) => String(row.detail));
    assert.ok(plan.some((d) => d.includes("_jobs_run")), plan.join(" | "));
  });

  it("takes no socket when the frame cannot be built, and a frame that fails later harms no job", async () => {
    const lines: Record<string, unknown>[] = [];
    const { clock, state, store } = setup({ log: (line) => lines.push(line) });
    value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: RUN, step: "s2" }, rows: 10, per: 10 }, requestKey: "k-12" }));
    store.core.sql.exec("UPDATE _jobs SET progress = '{'");
    const refused = await store.watchRun(caller(clock.now()), new FakeSocket());
    assert.equal(refused.ok, false);
    assert.equal((state as LiveState).sockets.length, 0);

    store.core.sql.exec("UPDATE _jobs SET progress = NULL");
    const ws = new FakeSocket();
    value(await store.watchRun(caller(clock.now()), ws));
    ws.deserializeAttachment = () => {
      throw new Error("no attachment");
    };
    await store.alarm();
    const job = value(await store.job(ME, (await value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: RUN, step: "s2" }, rows: 10, per: 10 }, requestKey: "k-12" }))).job.id)).job;
    assert.equal(job.state, "done");
    assert.ok(lines.some((l) => l.event === "store_live_frame_failed"));
  });

  it("closes its sockets when the store is deleted", async () => {
    const { clock, store } = setup();
    const ws = new FakeSocket();
    value(await store.watchRun(caller(clock.now()), ws));
    value(await store.destroy(ME));
    assert.equal(ws.closed?.code, 1001);
  });

  it("sends nothing to another run's socket", async () => {
    const { clock, store } = setup();
    value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: RUN, step: "s2" }, rows: 10, per: 10 }, requestKey: "k-3" }));
    const other = new FakeSocket();
    value(await store.watchRun(caller(clock.now(), "mr-other"), other));
    await store.alarm();
    assert.equal(other.sent.length, 1);
    assert.deepEqual(other.sent[0]!.jobs, []);
  });

  it("closes a socket whose token ended instead of sending to it", async () => {
    const { clock, store } = setup();
    value(await store.jobSubmit(ME, { kind: "fill", params: { madeBy: { runId: RUN, step: "s2" }, rows: 10, per: 10 }, requestKey: "k-4" }));
    const ws = new FakeSocket();
    value(await store.watchRun({ ...ME, runId: RUN, until: clock.now() + 1_000 }, ws));
    clock.advance(2_000);
    await store.alarm();
    assert.equal(ws.sent.length, 1);
    assert.equal(ws.closed?.code, LIVE_TOKEN_ENDED);
  });

  it("is refused for another store, and where the platform has no sockets", async () => {
    const { clock, store } = setup();
    value(await store.catalog(ME));
    const wrong = await store.watchRun({ storeId: "sto_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", actor: "user:u-1", runId: RUN, until: clock.now() + HOUR }, new FakeSocket());
    assert.equal(wrong.ok, false);
    const bare = setup({ live: false });
    const none = await bare.store.watchRun(caller(bare.clock.now()), new FakeSocket());
    assert.equal(none.ok, false);
  });
});

describe("what the caller in front forwards", () => {
  it("reads the caller, the run and the token's end, and nothing else", () => {
    assert.deepEqual(liveCallerOf(JSON.stringify({ storeId: A, actor: "user:u-1", runId: RUN, until: 5 })), { storeId: A, actor: "user:u-1", runId: RUN, until: 5 });
    assert.equal(liveCallerOf(null), null);
    assert.equal(liveCallerOf("{"), null);
    assert.equal(liveCallerOf(JSON.stringify({ storeId: A, actor: "user:u-1", runId: "../x", until: 5 })), null);
    assert.equal(liveCallerOf(JSON.stringify({ storeId: A, actor: "", runId: RUN, until: 5 })), null);
  });

  it("finds a job's run in its parameters", () => {
    assert.equal(runOfParams({ madeBy: { runId: RUN, step: "s2" } }), RUN);
    assert.equal(runOfParams({ madeBy: null }), null);
    assert.equal(runOfParams(null), null);
  });
});
