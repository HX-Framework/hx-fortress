// The job runner: makes a job once per request key, and runs one job at a time, a chunk per
// alarm, until it is done or fails (jobs/types.ts).
//
// A run that is stopped stops its jobs here (`stopRunJobs`): the store records the run, and each of
// its open jobs, queued, running or waiting for the limit, ends as failed at its next chunk
// boundary, in the words the stop gave. Its tables in progress are dropped, nothing more is written,
// and a chunk in flight finishes the commit it is in. A job that already ended stays as it is. A job
// a stopped run asks for later (a step's call still under way when the run stopped) is refused.
//
// The store's daily write limit (write-limit.ts) holds every job: a new job is refused once today's
// writes reach the limit, and a job under way waits. Its chunk stops at its next commit (its
// `deadline` ends), and no chunk runs while the store is past its limit: the job stays open with
// its cursor and its tables in progress, and its next chunk is at 00:00 UTC, or within a minute once
// its organization's limit is raised (it asks the organization's budget again each minute,
// write-limit.ts). It goes on where it stopped, so nothing it committed is written, or paid for, twice. Its answer says it waits (`waiting`), and its history
// says so each time it stops. Before a job's first
// write the store says what it is about to write (`estimate`): the job keeps the number, and a
// line in the platform's logs says it with its cost at $1 per million rows. A chunk runs its
// statements through a counter of its own (`CountedSql`), so the job's count holds its own rows
// and never those of a call that ran while the chunk waited on the bucket; each commit adds them
// to the job and keeps the day's count in the same transaction.
//
// A submit may name the call it is a later try of (`sameWorkAs`): a run's step's Try Again, or the
// agent that took the run over after the step stopped. The newest job of that call or its later
// tries that did not fail and does the same work answers it, so a job that waits is never joined
// by a second one doing its work.

import { StoreError, type StoreCore } from "../core.js";
import { abandonDeltas } from "../deltas.js";
import { holdStore, refuseWhileRestoring } from "../history.js";
import { CountedSql } from "../metered-sql.js";
import { dropJobTables, programTables } from "../program-tables.js";
import { LIVE_RUN_ID_RE } from "../live.js";
import { getMeta, setMeta } from "../schema.js";
import type { Job, JobEstimate, JobProgress, JobRefusal, JobSummary, StoreWrites } from "../types.js";
import {
  BUDGET_STATS_EVERY_MS,
  dayEndsAt,
  DOLLARS_PER_MILLION_ROWS_WRITTEN,
  keepWriteCount,
  refusePastWriteLimit,
  rowsText,
  storeWriteLimitWords,
  tellBudget,
  writeLimitLooksAgainAt,
  writeLimitWait,
  writesToday,
} from "../write-limit.js";
import { KIND_ESTIMATES } from "./estimates.js";
import { jobSummary } from "./summary.js";
import { SYSTEM_JOB_HANDLERS } from "./system.js";
import { madeByOf } from "../../../store-readers/src/jobs.js";
import { JOB_CHUNK_MS, JobParamsError, type JobContext, type JobEstimateView, type JobFiles, type JobHandler } from "./types.js";
import type { StoreSqlValue } from "../sql.js";

/**
 * The SQL jobs run through in this object: one for the object's life, as `core.sql` is, so a
 * handler that keeps something between chunks by its `ctx.sql` (LOAD's open file) finds it again.
 * One job runs at a time, so its rows are the difference across its chunk.
 */
const jobSqls = new WeakMap<StoreCore, CountedSql>();
function jobSqlOf(core: StoreCore): CountedSql {
  let sql = jobSqls.get(core);
  if (!sql) {
    sql = new CountedSql(core.meter);
    jobSqls.set(core, sql);
  }
  return sql;
}

/**
 * The store as a job's `ctx.tables` sees it: the same store, its statements counted as the job's
 * rows. What a step records besides its own rows (the keys it changed, a version's swap, the row
 * hashes a LOAD remembers) is written and billed like them.
 */
const jobCores = new WeakMap<StoreCore, StoreCore>();
function jobCoreOf(core: StoreCore): StoreCore {
  let counted = jobCores.get(core);
  if (!counted) {
    counted = Object.create(core, { sql: { value: jobSqlOf(core) } }) as StoreCore;
    jobCores.set(core, counted);
  }
  return counted;
}

/** The jobs whose last chunk returned without committing: this object's memory is where a chunk counts that way. */
const chunkReturns = new WeakMap<StoreCore, Set<string>>();
function chunksReturned(core: StoreCore): Set<string> {
  let set = chunkReturns.get(core);
  if (!set) {
    set = new Set();
    chunkReturns.set(core, set);
  }
  return set;
}

/** A chunk that throws this many times in a row fails its job. */
export const JOB_TRIES = 3;

/** Who watches a run's jobs as they go (live.ts `LiveRuns`): told of each commit and each chunk's end. Neither throws. */
export interface JobWatchers {
  changed(runId: string): void;
  chunkEnded(runId: string): void;
}

/** The run a job's parameters name (`madeBy.runId`), or null. */
export function runOfParams(params: unknown): string | null {
  return madeByOf((params as { madeBy?: unknown } | null | undefined)?.madeBy)?.runId ?? null;
}

/** How soon the next chunk runs after one that wants more. */
const NEXT_CHUNK_MS = 50;

/** The `_meta` keys a job keeps while it is open: its chunk's tries in a row, and the UTC day it last said it waits. */
const waitsKey = (jobId: string) => `job_waits:${jobId}`;

/** A stopped run, as the store records it (`stopRunJobs`): why, in words a job's error shows, who said so, and when. */
interface StoppedRun {
  why: string;
  by: string;
  at: string;
}

const STOPPED_RUN_PREFIX = "job_run_stopped:";
/** The `_meta` key that records a stopped run. */
const stoppedRunKey = (runId: string) => `${STOPPED_RUN_PREFIX}${runId}`;
/** How long the record of a stopped run is kept: a step's call still under way when its run stopped ends long before. */
const STOPPED_RUN_KEPT_MS = 7 * 86_400_000;

/** The stop a run was given (`stopRunJobs`), or null for a run nobody stopped, and for no run at all. */
function stoppedRun(core: StoreCore, runId: string | null): StoppedRun | null {
  if (!runId) return null;
  const text = getMeta(core.sql, stoppedRunKey(runId));
  if (!text) return null;
  try {
    return JSON.parse(text) as StoppedRun;
  } catch {
    return null;
  }
}

interface JobRow {
  id: string;
  kind: string;
  request_key: string;
  state: Job["state"];
  params: string;
  progress: string | null;
  result: string | null;
  error: string | null;
  run_state: string | null;
  chunks: number;
  tries: number | null;
  by_sub: string;
  created_at: string;
  updated_at: string;
  estimate_rows: number | null;
  estimate_basis: string | null;
  rows_written: number | null;
}

const parse = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

const isOpen = (state: Job["state"]): boolean => state === "queued" || state === "running";

/** A job as its callers read it; an open one says whether it waits for the daily write limit, as the store stands now. */
export function jobWire(core: StoreCore, row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind,
    requestKey: row.request_key,
    state: row.state,
    progress: parse(row.progress) as JobProgress | null,
    result: parse(row.result),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    estimate: row.estimate_rows === null || row.estimate_rows === undefined ? null : { rows: Number(row.estimate_rows), basis: String(row.estimate_basis ?? "") },
    rowsWritten: Number(row.rows_written ?? 0),
    // Past the limit no chunk runs, so every open job waits.
    waiting: isOpen(row.state) ? writeLimitWait(core) : null,
  };
}

/** What the store already knows that an estimate reads: its ready files, their first bytes, and its tables' rows. */
function estimateView(core: StoreCore): JobEstimateView {
  const files = jobFiles(core);
  return {
    sample: (fileId, bytes) => files.read(fileId, 0, bytes),
    file(fileId) {
      const file = files.get(fileId);
      return file ? { name: file.name, size: file.size } : null;
    },
    tableRows(name) {
      // A count writes left unknown stays unknown here: a submit never reads a whole table.
      const row = core.sql.exec<{ rows: number | null }>("SELECT rows FROM _tables WHERE lower(name) = lower(?)", name).toArray()[0];
      return row && row.rows !== null ? Number(row.rows) : null;
    },
  };
}

/** What a new job of this kind is about to write, from what the store knows; null when its kind cannot say. */
async function estimateOf(core: StoreCore, handler: JobHandler, params: unknown): Promise<JobEstimate | null> {
  const estimate = handler.estimate ?? KIND_ESTIMATES.get(handler.kind);
  if (!estimate) return null;
  try {
    const said = await estimate(params, estimateView(core));
    if (!said || !Number.isFinite(said.rows) || said.rows < 0) return null;
    return { rows: Math.round(said.rows), basis: String(said.basis).slice(0, 200) };
  } catch {
    // An estimate is a forecast: one that cannot be made leaves the job without one.
    return null;
  }
}

function jobRow(core: StoreCore, where: "id" | "request_key", value: string): JobRow | null {
  return (core.sql.exec<Record<string, StoreSqlValue>>(`SELECT * FROM _jobs WHERE ${where} = ?`, value).toArray()[0] as unknown as JobRow | undefined) ?? null;
}

export function readJob(core: StoreCore, jobId: string): Job {
  const row = jobRow(core, "id", jobId);
  if (!row) throw new StoreError(404, "not_found", "This store has no such job.");
  return jobWire(core, row);
}

/** A failed job's words when the store no longer runs its kind, and when its chunk stopped the store three times: a summary reads them back as codes. */
const kindGone = (kind: string): string => `This store no longer runs jobs of kind "${kind}".`;
const CHUNK_FAILED = "A chunk of this job stopped the store before it finished, three times in a row.";

/**
 * A job's summary (jobs/summary.ts): its state, step, times and counts, and no value of a row.
 * A failed job's code is `failed` unless the store knows more than the job's words say: its run
 * was stopped, its kind is gone, or its chunk stopped the store three times.
 */
export function readJobSummary(core: StoreCore, jobId: string): JobSummary {
  const row = jobRow(core, "id", jobId);
  if (!row) throw new StoreError(404, "not_found", "This store has no such job.");
  const params = parse(row.params);
  let refusal: JobRefusal | null = null;
  if (row.state === "failed") {
    const stop = stoppedRun(core, runOfParams(params));
    if (stop && row.error === stop.why.slice(0, 2000)) refusal = "stopped";
    else if (row.error === kindGone(row.kind)) refusal = "job_kind_unknown";
    else if (row.error === CHUNK_FAILED) refusal = "chunk_failed";
  }
  return jobSummary(jobWire(core, row), { params, state: parse(row.run_state) }, refusal);
}

/** Whether a job is queued or running: the store is busy, and its stats will change again. */
export function jobsOpen(core: StoreCore): boolean {
  return core.sql.exec("SELECT 1 FROM _jobs WHERE state IN ('queued', 'running') LIMIT 1").toArray().length > 0;
}

/**
 * When the ledger reads the store's numbers again, while every open job waits for the daily write
 * limit: the next 00:00 UTC, in epoch ms, when they go on by themselves, and until then they change
 * nothing. An organization's limit may be raised at any time, and nothing tells the ledger when the
 * jobs go on, so with one it is ten minutes at most. Null when no job is open, or the store is under
 * its limit.
 */
export function jobsWaitUntil(core: StoreCore): number | null {
  const writes = writesToday(core);
  if (writes.rows < writes.limit || !jobsOpen(core)) return null;
  const until = dayEndsAt(writes.day);
  return writes.shared ? Math.min(until, core.deps.now() + BUDGET_STATS_EVERY_MS) : until;
}

/** The request key a submit names in `sameWorkAs`, checked: 1 to 300 characters, or none. */
function sameWorkKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > 300) throw new StoreError(400, "bad_request", "sameWorkAs takes a request key of 1 to 300 characters.");
  return key;
}

/**
 * The job a new submit of `kind` with `params` goes on with: the newest made under `key`, or under
 * `key` followed by `~` (a later try's key), that did not fail (or, with `open`, that is still
 * open) and has the same kind and params. Null for none. The keys are read by the request key's
 * index: `key~` up to (not with) `key` and the character after `~`.
 */
function sameWorkJob(core: StoreCore, key: string, kind: string, params: string, open: boolean): JobRow | null {
  const row = core.sql
    .exec<Record<string, StoreSqlValue>>(
      `SELECT * FROM _jobs WHERE (request_key = ? OR (request_key >= ? AND request_key < ?)) AND ${open ? "state IN ('queued', 'running')" : "state <> 'failed'"}
       AND kind = ? AND params = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      key,
      `${key}~`,
      `${key}\u007f`,
      kind,
      params,
    )
    .toArray()[0];
  return (row as unknown as JobRow | undefined) ?? null;
}

/**
 * Makes a job, or answers the one its request key already made, whatever state it is in, or the
 * job of the call `sameWorkAs` names (or of a later try of it) that does the same work and did not
 * fail.
 */
export async function submitJob(core: StoreCore, actor: string, body: Record<string, unknown>): Promise<Job> {
  const requestKey = typeof body.requestKey === "string" ? body.requestKey.trim() : "";
  if (!requestKey || requestKey.length > 300) throw new StoreError(400, "bad_request", "A job needs a request key of 1 to 300 characters.");
  const existing = jobRow(core, "request_key", requestKey);
  if (existing) return jobWire(core, existing);
  const kind = typeof body.kind === "string" ? body.kind : "";
  const handler = core.deps.jobs.get(kind);
  if (!handler) throw new StoreError(400, "job_kind_unknown", `A store runs no job of kind "${kind}".`);
  const sameWorkAs = sameWorkKey(body.sameWorkAs);
  let params: unknown;
  try {
    params = handler.parse(body.params);
  } catch (error) {
    if (error instanceof JobParamsError) throw new StoreError(400, "bad_request", error.message);
    throw error;
  }
  // The same work an earlier try of this call does or did answers with that job: nothing new is
  // written, so the limit does not hold it, as it does not hold a replay.
  const same = sameWorkAs ? sameWorkJob(core, sameWorkAs, kind, JSON.stringify(params ?? null), body.sameWorkOpen === true) : null;
  if (same) return jobWire(core, same);
  // A replay above answers the job it made; only a new job is held to today's limit, the
  // organization's as its budget last answered.
  await tellBudget(core);
  refusePastWriteLimit(core);
  const estimate = await estimateOf(core, handler, params);
  // The estimate may read the bucket, and other calls run meanwhile: a delete or a restore that came
  // then refuses this submit as it would have before, and a submit of the same key answered first.
  if (getMeta(core.sql, "destroyed_at")) throw new StoreError(410, "store_destroyed", "This store was deleted.");
  refuseWhileRestoring(core);
  const meanwhile = jobRow(core, "request_key", requestKey);
  if (meanwhile) return jobWire(core, meanwhile);
  // A step's call still under way when its run was stopped makes no job: the run is over.
  if (stoppedRun(core, runOfParams(params))) throw new StoreError(409, "run_stopped", "This run was stopped, so the store makes no new job for it.");
  const now = core.nowIso();
  const id = core.newId("job");
  core.sql.exec(
    `INSERT INTO _jobs (id, kind, request_key, state, params, progress, result, error, run_state, chunks, by_sub, created_at, updated_at, estimate_rows, estimate_basis, rows_written)
     VALUES (?, ?, ?, 'queued', ?, NULL, NULL, NULL, NULL, 0, ?, ?, ?, ?, ?, 0) ON CONFLICT (request_key) DO NOTHING`,
    id,
    kind,
    requestKey,
    JSON.stringify(params ?? null),
    actor,
    now,
    now,
    estimate?.rows ?? null,
    estimate?.basis ?? null,
  );
  const writes = writesToday(core);
  core.deps.log?.({
    at: "store.job",
    event: "estimate",
    store: core.storeId,
    job: id,
    kind,
    by: actor,
    rows: estimate?.rows ?? null,
    dollars: estimate ? (estimate.rows / 1_000_000) * DOLLARS_PER_MILLION_ROWS_WRITTEN : null,
    basis: estimate?.basis ?? null,
    writtenToday: writes.rows,
    dailyLimit: writes.limit,
  });
  await core.wakeAt(core.deps.now());
  return jobWire(core, jobRow(core, "request_key", requestKey)!);
}

/**
 * Makes one of the store's own jobs (an export, an import), or answers the one its request key
 * already made. Only the store's own calls make these: the jobs route takes none of their kinds.
 * `holdFor` holds the store for the job from now on, in the same step that makes it.
 */
export async function submitSystemJob(core: StoreCore, actor: string, kind: string, params: unknown, requestKey: string, opts: { holdFor?: "import" } = {}): Promise<Job> {
  if (!requestKey || requestKey.length > 300) throw new StoreError(400, "bad_request", "A job needs a request key of 1 to 300 characters.");
  const existing = jobRow(core, "request_key", requestKey);
  if (existing) {
    if (existing.kind !== kind) throw new StoreError(409, "request_key_taken", "This request key already made another kind of job.");
    return jobWire(core, existing);
  }
  const handler = SYSTEM_JOB_HANDLERS.get(kind);
  if (!handler) throw new StoreError(400, "job_kind_unknown", `A store runs no job of kind "${kind}".`);
  let parsed: unknown;
  try {
    parsed = handler.parse(params);
  } catch (error) {
    if (error instanceof JobParamsError) throw new StoreError(400, "bad_request", error.message);
    throw error;
  }
  const now = core.nowIso();
  const id = core.newId("job");
  core.sql.exec(
    `INSERT INTO _jobs (id, kind, request_key, state, params, progress, result, error, run_state, chunks, by_sub, created_at, updated_at, rows_written)
     VALUES (?, ?, ?, 'queued', ?, NULL, NULL, NULL, NULL, 0, ?, ?, ?, 0) ON CONFLICT (request_key) DO NOTHING`,
    id,
    kind,
    requestKey,
    JSON.stringify(parsed ?? null),
    actor,
    now,
    now,
  );
  if (opts.holdFor) holdStore(core.sql, id, opts.holdFor);
  await core.wakeAt(core.deps.now());
  return jobWire(core, jobRow(core, "request_key", requestKey)!);
}

/**
 * Stops the open jobs a run started: records the run as stopped, which is what ends them, and wakes
 * the store. Each open job, queued, running or waiting for the daily write limit, ends as failed at
 * its next chunk boundary (`runChunkOf`), in `why`, with its tables in progress dropped: a chunk in
 * flight stops at its next commit. A job that already ended is left alone. Answers how many were open.
 */
export async function stopRunJobs(core: StoreCore, actor: string, body: Record<string, unknown>): Promise<{ stopped: number }> {
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  if (!LIVE_RUN_ID_RE.test(runId)) throw new StoreError(400, "bad_request", "A stop names the run whose jobs stop (runId).");
  const why = typeof body.why === "string" ? body.why.trim().slice(0, 1000) : "";
  if (!why) throw new StoreError(400, "bad_request", "A stop says who stopped the jobs, in words (why).");
  const now = core.deps.now();
  const open = core.sql.exec("SELECT id FROM _jobs WHERE json_extract(params, '$.madeBy.runId') = ? AND state IN ('queued', 'running')", runId).toArray().length;
  core.transaction(() => {
    setMeta(core.sql, stoppedRunKey(runId), JSON.stringify({ why, by: actor, at: new Date(now).toISOString() } satisfies StoppedRun));
    // A record kept for good would be a row for every run ever stopped on this store.
    core.sql.exec(
      "DELETE FROM _meta WHERE key >= ? AND key < ? AND json_extract(value, '$.at') < ?",
      STOPPED_RUN_PREFIX,
      `${STOPPED_RUN_PREFIX.slice(0, -1)};`,
      new Date(now - STOPPED_RUN_KEPT_MS).toISOString(),
    );
  });
  if (open > 0) await core.wakeAt(now);
  core.deps.log?.({ at: "store.job", event: "stop", store: core.storeId, run: runId, by: actor, why, open });
  return { stopped: open };
}

/** The handler a job's kind runs: a program step's, or one of the store's own. */
function handlerOf(core: StoreCore, kind: string): JobHandler | undefined {
  return core.deps.jobs.get(kind) ?? SYSTEM_JOB_HANDLERS.get(kind);
}

/** A finished job's history: what it wrote, beside what it was about to write. People read it, so it names no dollar amount. */
function finishedNote(row: JobRow, rows: number): string {
  const estimated = row.estimate_rows === null || row.estimate_rows === undefined ? "" : `; about ${rowsText(Number(row.estimate_rows))} were estimated`;
  return `${row.kind} finished: wrote ${rowsText(rows)} rows${estimated}`;
}

function jobFiles(core: StoreCore): JobFiles {
  return {
    get(fileId) {
      const row = core.sql.exec<Record<string, StoreSqlValue>>("SELECT id, name, size, content_type FROM _files WHERE id = ? AND state = 'ready' AND deleted_at IS NULL", fileId).toArray()[0];
      return row ? { id: String(row.id), name: String(row.name), size: Number(row.size), contentType: String(row.content_type) } : null;
    },
    async read(fileId, offset, length) {
      const row = core.sql.exec<{ r2_key: string }>("SELECT r2_key FROM _files WHERE id = ? AND state = 'ready' AND deleted_at IS NULL", fileId).toArray()[0];
      if (!row) throw new StoreError(404, "file_not_found", "This store has no such file.");
      if (length <= 0) return new Uint8Array(0);
      const object = await core.env.FILES.get(String(row.r2_key), { range: { offset, length } });
      if (!object) throw new StoreError(404, "file_not_found", "This file's bytes are gone from the store's bucket.");
      return new Uint8Array(await object.arrayBuffer());
    },
  };
}

/**
 * Past today's limit no chunk runs: the job waits with its cursor and its tables in progress until
 * the next 00:00 UTC, when its next chunk is due (a raised limit wakes it sooner). It says so in the
 * store's history and the platform's logs each time it stops, and again each UTC day it still
 * waits, never at each look the store's other alarms make. Answers when the job goes on.
 */
function waitForLimit(core: StoreCore, row: JobRow, writes: StoreWrites): number {
  const until = dayEndsAt(writes.day);
  // An organization's limit may be raised at any time: the job looks again within a minute.
  const next = writeLimitLooksAgainAt(core, writes);
  if (getMeta(core.sql, waitsKey(row.id)) !== writes.day) {
    const words = storeWriteLimitWords(core, writes);
    core.transaction(() => {
      setMeta(core.sql, waitsKey(row.id), writes.day);
      core.history({ kind: "job", by: row.by_sub, note: `${row.kind} waits where it stopped: ${words.slice(0, 300)}`, ref: row.id });
    });
    core.deps.log?.({
      at: "store.job",
      event: "waits",
      store: core.storeId,
      job: row.id,
      kind: row.kind,
      rowsWritten: Number(row.rows_written ?? 0),
      writtenToday: writes.rows,
      dailyLimit: writes.limit,
      until: new Date(until).toISOString(),
    });
  }
  return next;
}

/**
 * Runs one chunk of the oldest open job, if any, and says when to wake again: soon while a job is
 * still open, after a backoff when a chunk threw, at 00:00 UTC while the open jobs wait for the
 * daily write limit (within a minute when it is the organization's), and never once none is open. A job whose run was stopped goes first, and ends
 * (`runChunkOf`), wherever it stands in the line.
 */
export async function runJobChunk(core: StoreCore, watchers?: JobWatchers): Promise<number | null> {
  const row = core.sql
    .exec<Record<string, StoreSqlValue>>(
      `SELECT * FROM _jobs WHERE state IN ('queued', 'running')
       ORDER BY EXISTS (SELECT 1 FROM _meta WHERE key = '${STOPPED_RUN_PREFIX}' || json_extract(params, '$.madeBy.runId')) DESC, state = 'running' DESC, created_at, id LIMIT 1`,
    )
    .toArray()[0] as unknown as JobRow | undefined;
  if (!row) return null;
  // The run the job works for: its watchers hear each commit, and the chunk's end.
  const params = parse(row.params);
  const runId = runOfParams(params);
  try {
    return await runChunkOf(core, row, params, runId, watchers);
  } finally {
    if (runId) watchers?.chunkEnded(runId);
  }
}

async function runChunkOf(core: StoreCore, row: JobRow, params: unknown, runId: string | null, watchers: JobWatchers | undefined): Promise<number | null> {
  const handler = handlerOf(core, row.kind);
  let failCtx: JobContext<unknown, unknown> | null = null;
  /** Ends the job as failed. `stop`, when its run was stopped: its history says stopped, and who stopped it. */
  const fail = async (message: string, wrote = 0, stop: StoppedRun | null = null) => {
    core.transaction(() => {
      dropJobTables(core, row.id);
      // A change it opened and did not close reads as whole for good.
      abandonDeltas(core.sql, row.id);
      core.sql.exec("DELETE FROM _meta WHERE key = ?", waitsKey(row.id));
      core.sql.exec(
        "UPDATE _jobs SET state = 'failed', error = ?, run_state = NULL, key_hash = NULL, key_until = NULL, rows_written = coalesce(rows_written, 0) + ?, updated_at = ? WHERE id = ?",
        message.slice(0, 2000),
        wrote,
        core.nowIso(),
        row.id,
      );
      core.history({ kind: "job", by: stop ? stop.by : row.by_sub, note: `${row.kind} ${stop ? "stopped" : "failed"}: ${message.slice(0, 300)}`, ref: row.id });
    });
    if (stop) core.deps.log?.({ at: "store.job", event: "stopped", store: core.storeId, job: row.id, kind: row.kind, by: stop.by, rowsWritten: Number(row.rows_written ?? 0) + wrote });
    if (handler?.failed && failCtx) {
      await handler.failed(failCtx, message).catch((error) => console.error(JSON.stringify({ at: "store-job-failed", kind: row.kind, error: error instanceof Error ? error.message : String(error) })));
    }
  };
  if (!handler) {
    await fail(kindGone(row.kind));
    return nextChunkAt(core);
  }
  // What the handler's own statements write joins the job's count in the statements that already
  // record its progress and its end, so counting adds no row: `mark` is where it last stood.
  const jobSql = jobSqlOf(core);
  let committed = false;
  let mark = jobSql.rows;
  const sinceMark = () => jobSql.rows - mark;
  const storeId = core.storeId ?? "";
  const chunkEnd = core.deps.now() + JOB_CHUNK_MS;
  const ctx: JobContext<unknown, unknown> = {
    job: { id: row.id, kind: row.kind, requestKey: row.request_key, by: row.by_sub, storeId },
    params,
    state: parse(row.run_state),
    sql: jobSql,
    files: jobFiles(core),
    tables: programTables(jobCoreOf(core), { id: row.id, by: row.by_sub }),
    bucket: core.env.FILES,
    databaseSize: () => core.sql.databaseSize,
    // Once its run is stopped, or a commit takes today's writes to the limit, the chunk is over: a
    // handler that checks its deadline between commits stops at the next one, and the job ends, or
    // waits for the next UTC day. It reads no clock, so a chunk's own reads of the time are what
    // they were. A job that runs past the limit (`pastLimit`) has only its own time.
    get deadline() {
      if (stoppedRun(core, runId)) return 0;
      if (handler.pastLimit) return chunkEnd;
      const today = writesToday(core);
      return today.rows >= today.limit ? 0 : chunkEnd;
    },
    now: () => core.deps.now(),
    commit(update, write) {
      committed = true;
      core.transaction(() => {
        write?.();
        core.sql.exec(
          // A commit is progress: the tries count only chunks that got nowhere.
          "UPDATE _jobs SET run_state = ?, progress = ?, tries = 0, rows_written = coalesce(rows_written, 0) + ?, updated_at = ? WHERE id = ?",
          JSON.stringify(update.state ?? null),
          JSON.stringify(update.progress),
          sinceMark(),
          core.nowIso(),
          row.id,
        );
        mark = jobSql.rows;
        // The day's count is kept with the rows it counts once 1,000 wait, so a stop between commits
        // forgets at most 999 of them; it reads no clock.
        keepWriteCount(core);
      });
      if (runId) watchers?.changed(runId);
    },
  };
  failCtx = ctx;
  // A stopped run's job ends here, whatever the store's limit says: it never runs another chunk.
  const stopped = stoppedRun(core, runId);
  if (stopped) {
    await fail(stopped.why, 0, stopped);
    return nextChunkAt(core);
  }
  // Past today's limit no chunk runs, and the job waits for the next UTC day. An export writes only
  // its own few records, so it runs past the limit (`pastLimit`).
  const writes = writesToday(core);
  if (!handler.pastLimit && writes.rows >= writes.limit) return waitForLimit(core, row, writes);
  // Counted before the chunk runs, in a transaction of its own: a chunk that ends the object (its
  // memory, its time) never reaches the catch below, and would otherwise hold its job open for ever.
  // A chunk that returned without committing counts for nothing: this object remembers it, so the
  // common chunk writes no row for the count.
  const returned = chunksReturned(core);
  const tries = returned.delete(row.id) ? 0 : Number(row.tries ?? 0);
  if (tries >= JOB_TRIES) {
    await fail(CHUNK_FAILED);
    return nextChunkAt(core);
  }
  // `chunks` counts the chunks run, one per alarm that ran the handler, however often it commits.
  core.transaction(() => {
    core.sql.exec("UPDATE _jobs SET state = 'running', chunks = chunks + 1, tries = ?, updated_at = ? WHERE id = ?", tries + 1, core.nowIso(), row.id);
  });
  /** Rows the handler wrote after its last commit, counted where no statement records them already. */
  const addWritten = (rows: number) => {
    if (rows > 0) core.sql.exec("UPDATE _jobs SET rows_written = coalesce(rows_written, 0) + ? WHERE id = ?", rows, row.id);
  };
  try {
    const outcome = await handler.run(ctx);
    const rows = sinceMark();
    // The run was stopped while this chunk ran: what it committed stays counted, and the job ends
    // here unless the chunk finished its work. Its next chunk never runs.
    const stop = "result" in outcome ? null : stoppedRun(core, runId);
    if (stop) {
      await fail(stop.why, rows, stop);
      return nextChunkAt(core);
    }
    if ("wait" in outcome) {
      addWritten(rows);
      // Sleeping is not a chunk that got nowhere: a job fed from outside sleeps across many restarts
      // of its object, and each one's chunk would otherwise count towards its failing.
      core.sql.exec("UPDATE _jobs SET tries = 0 WHERE id = ?", row.id);
      core.sql.exec("DELETE FROM _meta WHERE key = ?", waitsKey(row.id));
      return outcome.wait;
    }
    if ("result" in outcome) {
      core.transaction(() => {
        dropJobTables(core, row.id);
        core.sql.exec(
          "UPDATE _jobs SET state = 'done', result = ?, error = NULL, run_state = NULL, key_hash = NULL, key_until = NULL, rows_written = coalesce(rows_written, 0) + ?, updated_at = ? WHERE id = ?",
          JSON.stringify(outcome.result ?? null),
          rows,
          core.nowIso(),
          row.id,
        );
        const total = Number(core.sql.exec<{ n: number }>("SELECT rows_written AS n FROM _jobs WHERE id = ?", row.id).one().n);
        core.history({ kind: "job", by: row.by_sub, note: finishedNote(row, total), ref: row.id });
      });
    } else addWritten(rows);
    if (!committed) returned.add(row.id);
    // The chunk ran: the next time it stops at the limit it says so again.
    core.sql.exec("DELETE FROM _meta WHERE key = ?", waitsKey(row.id));
    if ("more" in outcome && outcome.after && outcome.after > 0) return core.deps.now() + Math.min(outcome.after, 60_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stop = stoppedRun(core, runId);
    if (stop) {
      await fail(stop.why, sinceMark(), stop);
      return nextChunkAt(core);
    }
    if (tries + 1 >= JOB_TRIES || error instanceof StoreError) {
      await fail(message, sinceMark());
    } else {
      addWritten(sinceMark());
      // This chunk threw, whatever it committed first: it counts.
      core.sql.exec("UPDATE _jobs SET tries = ? WHERE id = ?", tries + 1, row.id);
      return core.deps.now() + 1_000 * 2 ** (tries + 1);
    }
  }
  return nextChunkAt(core);
}

/** Soon while a job is open; null once none is, so the store's alarm stops with its last job. */
function nextChunkAt(core: StoreCore): number | null {
  return jobsOpen(core) ? core.deps.now() + NEXT_CHUNK_MS : null;
}
