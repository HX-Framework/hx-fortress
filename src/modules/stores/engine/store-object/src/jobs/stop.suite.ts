// A run's stop reaches its store jobs (jobs/runner.ts `stopRunJobs`), on stand-ins for the store's
// storage: an open job, queued, running or waiting for the daily write limit, ends as failed in the
// stop's words, with its tables in progress dropped and nothing more written; a chunk in flight
// finishes the commit it is in; a job that already ended stays as it is; and a job the stopped run
// asks for later is refused.

import { describe, it, host, stateOf, filesOf, type HostStorage } from "../../testing/suite/host.js";
import { countingHex, FakeClock } from "../../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import type { StoreDeps, StoreEnv } from "../core.js";
import { StoreHandler } from "../handler.js";
import type { StoreCaller, StoreResult } from "../types.js";
import type { JobHandler } from "./types.js";

const A = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ME: StoreCaller = { storeId: A, actor: "run:mr-1" };
const STOPPER: StoreCaller = { storeId: A, actor: "run:mr-1-stop" };
const WHY = "Run 3 of Load the permits was stopped.";

function setup(opts: { jobs?: JobHandler[]; env?: Partial<StoreEnv> } = {}) {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const logs: Record<string, unknown>[] = [];
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map((opts.jobs ?? []).map((j) => [j.kind, j])), log: (line) => logs.push(line) };
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

/** Runs the store's alarm until it sets none, as the platform fires it. */
async function runAlarms(store: StoreHandler, storage: HostStorage, most = 20): Promise<number> {
  let firings = 0;
  for (; firings < most && storage.alarm !== null; firings++) {
    storage.alarm = null;
    await store.alarm();
  }
  return firings;
}

/** Fires the store's alarm `times` times, as the platform would for its next chunks. */
async function fireChunks(store: StoreHandler, storage: HostStorage, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    storage.alarm = null;
    await store.alarm();
  }
}

/** A job of `chunks` chunks that each write 400 rows into its table in progress, with `madeBy.runId` in its params. */
const filling: JobHandler<{ chunks: number; madeBy?: unknown }, { at: number }, { rows: number }> = {
  kind: "fill",
  parse: (p) => p as { chunks: number; madeBy?: unknown },
  async run(ctx) {
    const at = (ctx.state?.at ?? 0) + 1;
    if (at === 1) ctx.tables.begin("filled");
    ctx.commit({ state: { at }, progress: { done: at, total: ctx.params.chunks } }, () => {
      if (at === 1) ctx.sql.exec("CREATE TABLE filled__new (n INTEGER)");
      ctx.sql.exec("INSERT INTO filled__new SELECT value FROM json_each(?)", JSON.stringify(Array.from({ length: 400 }, (_, i) => i)));
    });
    if (at >= ctx.params.chunks) {
      const handle = await ctx.tables.commit("filled", { madeBy: { runId: "mr-1", step: "s1" } });
      return { result: { rows: handle.rows } };
    }
    return { more: true };
  },
};

const run = (id: string) => ({ madeBy: { runId: id, step: "s1" } });
const submit = (store: StoreHandler, runId: string, key: string, chunks = 3) => store.jobSubmit(ME, { kind: "fill", params: { chunks, ...run(runId) }, requestKey: key });
const tableExists = (storage: HostStorage, name: string) => storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
const jobRow = (storage: HostStorage, id: string) => storage.sql.exec("SELECT state, error, rows_written FROM _jobs WHERE id = ?", id).one();
const history = (storage: HostStorage, id: string) => storage.sql.exec("SELECT by_sub, note FROM _history WHERE ref = ? ORDER BY at, id", id).toArray().map((r) => ({ by: String(r.by_sub), note: String(r.note) }));

describe("stopping a run's jobs", () => {
  it("ends a job that has run a chunk: failed in the stop's words, its table in progress dropped, and nothing more written", async () => {
    const { store, storage } = setup({ jobs: [filling as JobHandler] });
    const job = value(await submit(store, "mr-1", "k1")).job;
    storage.alarm = null;
    await store.alarm(); // the first chunk: the table in progress exists, the job is running
    assert.equal(tableExists(storage, "filled__new"), true);
    assert.equal(value(await store.job(ME, job.id)).job.state, "running");

    assert.equal(value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY })).stopped, 1);
    const before = jobRow(storage, job.id);
    await runAlarms(store, storage);
    assert.equal(storage.alarm, null, "with none open the store's alarm stops");

    const after = value(await store.job(ME, job.id)).job;
    assert.equal(after.state, "failed");
    assert.equal(after.error, WHY);
    assert.equal(after.waiting, null);
    // Its summary names the stop by a code, and never in the stop's words.
    const summary = value(await store.jobSummary(ME, job.id)).summary;
    assert.deepEqual([summary.state, summary.refusal, summary.waitsUntil, summary.rowsWritten], ["failed", "stopped", null, after.rowsWritten]);
    assert.ok(!JSON.stringify(summary).includes("Load the permits"));
    assert.equal(tableExists(storage, "filled__new"), false, "its table in progress is dropped");
    assert.equal(Number(storage.sql.exec("SELECT count(*) AS n FROM _meta WHERE key LIKE 'job_tables:%'").one().n), 0, "and its record");
    assert.equal(after.rowsWritten, Number(before.rows_written), "no chunk ran after the stop");
    assert.deepEqual(history(storage, job.id).at(-1), { by: "run:mr-1-stop", note: `fill stopped: ${WHY}` }, "the store's history says who stopped it");
  });

  it("says in a job's summary, by a code, that the store no longer runs its kind", async () => {
    const { store, storage, state, r2, clock } = setup({ jobs: [filling as JobHandler] });
    const job = value(await submit(store, "mr-1", "k1")).job;
    // The store starts again where no handler of the kind is left.
    const without = new StoreHandler(state as never, { FILES: r2.asBucket() }, { now: clock.now, randomHex: countingHex, jobs: new Map() });
    storage.alarm = null;
    await without.alarm();
    assert.equal(value(await without.job(ME, job.id)).job.state, "failed");
    const summary = value(await without.jobSummary(ME, job.id)).summary;
    assert.deepEqual([summary.kind, summary.state, summary.refusal], ["fill", "failed", "job_kind_unknown"]);
    // A summary of a job the store does not have is refused as the job is.
    assert.equal(refusal(await store.jobSummary(ME, "job_000000000000000000000000")).code, "not_found");
  });

  it("ends a job that has not run yet, which holds nothing", async () => {
    const { store, storage } = setup({ jobs: [filling as JobHandler] });
    const job = value(await submit(store, "mr-1", "k1")).job;
    assert.equal(job.state, "queued");
    assert.equal(value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY })).stopped, 1);
    await runAlarms(store, storage);
    const after = value(await store.job(ME, job.id)).job;
    assert.equal(after.state, "failed");
    assert.equal(after.error, WHY);
    assert.equal(after.rowsWritten, 0);
    assert.equal(tableExists(storage, "filled__new"), false);
  });

  it("ends a job that waits for the daily write limit, past the limit, without waiting for 00:00 UTC", async () => {
    const { store, storage, clock } = setup({ jobs: [filling as JobHandler], env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    const job = value(await submit(store, "mr-1", "k1", 10)).job;
    await fireChunks(store, storage, 4); // three chunks of 400 rows take it past 1,000, and the fourth waits
    const waits = value(await store.job(ME, job.id)).job;
    assert.equal(waits.waiting?.code, "write_limit_reached", "it waits");
    // Its summary says that it waits and until when, by a code and a time.
    const waiting = value(await store.jobSummary(ME, job.id)).summary;
    assert.deepEqual([waiting.state, waiting.refusal, waiting.waitsUntil], [waits.state, "write_limit_reached", "2026-11-08T00:00:00.000Z"]);
    assert.equal(tableExists(storage, "filled__new"), true, "with its table in progress");
    const wokeAtMidnight = storage.alarm;

    assert.equal(value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY })).stopped, 1, "a stop is taken past the limit");
    assert.ok((storage.alarm ?? Infinity) <= clock.now(), "the store wakes now, not at 00:00 UTC");
    assert.notEqual(storage.alarm, wokeAtMidnight);
    storage.alarm = null;
    await store.alarm();

    const after = value(await store.job(ME, job.id)).job;
    assert.equal(after.state, "failed");
    assert.equal(after.waiting, null);
    assert.equal(tableExists(storage, "filled__new"), false);
    assert.equal(Number(storage.sql.exec("SELECT count(*) AS n FROM _meta WHERE key LIKE 'job_waits:%'").one().n), 0, "its wait is gone");
    assert.match(history(storage, job.id).at(-1)!.note, /^fill stopped: /);
  });

  it("leaves a job that already ended alone, and says none was open", async () => {
    const { store, storage } = setup({ jobs: [filling as JobHandler] });
    const job = value(await submit(store, "mr-1", "k1", 1)).job;
    await runAlarms(store, storage);
    const done = value(await store.job(ME, job.id)).job;
    assert.equal(done.state, "done");
    const notes = history(storage, job.id).length;

    assert.equal(value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY })).stopped, 0);
    await runAlarms(store, storage);
    assert.equal(value(await store.job(ME, job.id)).job.state, "done");
    assert.equal(history(storage, job.id).length, notes, "nothing is added to its history");
  });

  it("leaves another run's job, and a job with no run, to go on", async () => {
    const { store, storage } = setup({ jobs: [filling as JobHandler] });
    const other = value(await submit(store, "mr-2", "k2", 2)).job;
    const noRun = value(await store.jobSubmit(ME, { kind: "fill", params: { chunks: 2 }, requestKey: "k3" })).job;
    assert.equal(value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY })).stopped, 0);
    await runAlarms(store, storage, 40);
    assert.equal(value(await store.job(ME, other.id)).job.state, "done");
    assert.equal(value(await store.job(ME, noRun.id)).job.state, "done");
  });

  it("ends a stopped run's job ahead of the jobs in front of it in the line", async () => {
    const { store, storage } = setup({ jobs: [filling as JobHandler], env: { STORE_DAILY_WRITE_LIMIT: "1000" } });
    // The job in front reaches the limit and waits; the stopped run's job, made after it and before
    // the limit was reached (past it, a new job is refused), is behind it in the line.
    const front = value(await submit(store, "mr-2", "k-front", 10)).job;
    const behind = value(await submit(store, "mr-1", "k-behind", 3)).job;
    await fireChunks(store, storage, 4);
    assert.equal(value(await store.job(ME, front.id)).job.waiting?.code, "write_limit_reached");
    assert.equal(value(await store.job(ME, behind.id)).job.state, "queued", "the job behind never ran");

    value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY }));
    await runAlarms(store, storage, 3);
    assert.equal(value(await store.job(ME, behind.id)).job.state, "failed", "the line does not hold a stop up");
    assert.equal(value(await store.job(ME, front.id)).job.waiting?.code, "write_limit_reached", "the job in front still waits");
  });

  it("lets a chunk in flight finish the commit it is in, and runs no other", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let commits = 0;
    let finished = false;
    const slow: JobHandler<{ madeBy: unknown }, { at: number }> = {
      kind: "slow",
      parse: (p) => p as { madeBy: unknown },
      async run(ctx) {
        ctx.tables.begin("slow");
        ctx.commit({ state: { at: 1 }, progress: { done: 1, total: 3 } }, () => {
          ctx.sql.exec("CREATE TABLE slow__new (n INTEGER)");
          ctx.sql.exec("INSERT INTO slow__new VALUES (1)");
          commits++;
        });
        await gate;
        // The stop lands here: this commit, which was under way, still lands, and it is the last.
        ctx.commit({ state: { at: 2 }, progress: { done: 2, total: 3 } }, () => {
          ctx.sql.exec("INSERT INTO slow__new VALUES (2)");
          commits++;
        });
        assert.equal(ctx.deadline, 0, "the chunk is over once its run is stopped");
        finished = true;
        return { more: true };
      },
    };
    const { store, storage } = setup({ jobs: [slow as JobHandler] });
    const job = value(await store.jobSubmit(ME, { kind: "slow", params: { madeBy: { runId: "mr-1", step: "s1" } }, requestKey: "k1" })).job;
    storage.alarm = null;
    const chunk = store.alarm();
    // The chunk has begun and waits on the bucket: the stop lands in between.
    await Promise.resolve();
    assert.equal(value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY })).stopped, 1);
    assert.equal(value(await store.job(ME, job.id)).job.state, "running", "a chunk in flight is not cut off");
    release();
    await chunk;
    await runAlarms(store, storage);

    assert.equal(finished, true);
    assert.equal(commits, 2, "the commit under way landed, and no other chunk ran");
    const after = value(await store.job(ME, job.id)).job;
    assert.equal(after.state, "failed");
    assert.equal(after.error, WHY);
    assert.ok(after.rowsWritten! >= 2, `both rows the chunk committed are counted (${after.rowsWritten})`);
    assert.equal(tableExists(storage, "slow__new"), false, "its table in progress is dropped");
  });

  it("ends a job as stopped when a chunk throws after the stop landed, without another try", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const throwing: JobHandler<{ madeBy: unknown }> = {
      kind: "throwing",
      parse: (p) => p as { madeBy: unknown },
      async run() {
        runs++;
        await gate;
        throw new Error("the bucket went away");
      },
    };
    const { store, storage } = setup({ jobs: [throwing as JobHandler] });
    const job = value(await store.jobSubmit(ME, { kind: "throwing", params: { madeBy: { runId: "mr-1", step: "s1" } }, requestKey: "k1" })).job;
    storage.alarm = null;
    const chunk = store.alarm();
    await Promise.resolve();
    value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY }));
    release();
    await chunk;
    await runAlarms(store, storage);
    assert.equal(runs, 1, "no second try");
    const after = value(await store.job(ME, job.id)).job;
    assert.equal(after.state, "failed");
    assert.equal(after.error, WHY);
  });

  it("lets a chunk that finished its work while the stop landed end done", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lastChunk: JobHandler<{ madeBy: unknown }> = {
      kind: "last",
      parse: (p) => p as { madeBy: unknown },
      async run() {
        await gate;
        return { result: "made" };
      },
    };
    const { store, storage } = setup({ jobs: [lastChunk as JobHandler] });
    const job = value(await store.jobSubmit(ME, { kind: "last", params: { madeBy: { runId: "mr-1", step: "s1" } }, requestKey: "k1" })).job;
    storage.alarm = null;
    const chunk = store.alarm();
    await Promise.resolve();
    value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY }));
    release();
    await chunk;
    await runAlarms(store, storage);
    assert.equal(value(await store.job(ME, job.id)).job.state, "done");
  });

  it("runs a kind's clean-up when it stops", async () => {
    let cleanups = 0;
    const cleaning: JobHandler<{ madeBy: unknown }> = {
      kind: "cleaning",
      parse: (p) => p as { madeBy: unknown },
      run: async () => ({ more: true }),
      async failed() {
        cleanups++;
      },
    };
    const { store, storage } = setup({ jobs: [cleaning as JobHandler] });
    value(await store.jobSubmit(ME, { kind: "cleaning", params: { madeBy: { runId: "mr-1", step: "s1" } }, requestKey: "k1" }));
    value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY }));
    await runAlarms(store, storage);
    assert.equal(cleanups, 1);
  });

  it("refuses a job the stopped run asks for later, and still answers one it already made", async () => {
    const { store, storage } = setup({ jobs: [filling as JobHandler] });
    const job = value(await submit(store, "mr-1", "k1", 1)).job;
    await runAlarms(store, storage);
    value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY }));

    const late = refusal(await submit(store, "mr-1", "k-late"));
    assert.deepEqual([late.status, late.code], [409, "run_stopped"]);
    assert.match(late.error, /^This run was stopped/);
    assert.equal(value(await submit(store, "mr-1", "k1", 1)).job.id, job.id, "the same key answers the same job");
    // A new job of another run is made as usual.
    assert.equal(value(await submit(store, "mr-2", "k-other", 1)).job.state, "queued");
  });

  it("refuses a late submit whose estimate was read while the stop landed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const estimating: JobHandler<{ madeBy: unknown }> = {
      kind: "estimating",
      parse: (p) => p as { madeBy: unknown },
      run: async () => ({ result: null }),
      async estimate() {
        await gate;
        return { rows: 10, basis: "a guess" };
      },
    };
    const { store } = setup({ jobs: [estimating as JobHandler] });
    const late = store.jobSubmit(ME, { kind: "estimating", params: { madeBy: { runId: "mr-1", step: "s1" } }, requestKey: "k1" });
    await Promise.resolve();
    value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY }));
    release();
    assert.equal(refusal(await late).code, "run_stopped");
  });

  it("wants a run and words", async () => {
    const { store } = setup();
    assert.equal(refusal(await store.jobsStop(STOPPER, { why: WHY })).code, "bad_request");
    assert.equal(refusal(await store.jobsStop(STOPPER, { runId: "mr 1", why: WHY })).code, "bad_request");
    assert.equal(refusal(await store.jobsStop(STOPPER, { runId: "mr-1", why: "  " })).code, "bad_request");
  });

  it("keeps a stopped run's record for a week, then lets it go", async () => {
    const { store, storage, clock } = setup();
    value(await store.jobsStop(STOPPER, { runId: "mr-1", why: WHY }));
    assert.ok(Number(storage.sql.exec("SELECT count(*) AS n FROM _meta WHERE key LIKE 'job_run_stopped:%'").one().n) === 1);
    clock.advance(8 * 86_400_000);
    value(await store.jobsStop(STOPPER, { runId: "mr-2", why: WHY }));
    const keys = storage.sql.exec("SELECT key FROM _meta WHERE key LIKE 'job_run_stopped:%'").toArray().map((r) => String(r.key));
    assert.deepEqual(keys, ["job_run_stopped:mr-2"]);
  });
});
